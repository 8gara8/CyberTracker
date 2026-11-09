// `npm run sources:check` (SPEC §8.10): checkFeeds() on fixtures/feeds through CT_FIXTURE_FEEDS, in a
// temp root, with the clock at the 2026-10-14 morning run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { loadConfig } from "../lib/config";
import { parseAnthropicCvd } from "../lib/feeds/anthropic-cvd";
import { parseEpssCsv } from "../lib/feeds/epss";
import { parseExchange } from "../lib/feeds/exchange";
import { parseNvdPage } from "../lib/feeds/nvd";
import { parseRss } from "../lib/feeds/rss";
import { blockedReason } from "../lib/sources";
import { BLOCKED_HOSTS } from "../lib/vocab";
import { fetchFeed } from "../lib/feeds/http";
import { checkFeeds, formatCheckTable, main, type CheckRow } from "../scripts/collect";
import { fixtureGit, type GitSource } from "../scripts/lib/git-source";
import { EPSS_FILLER_ROWS, fixtureCveIds, keepsHost, main as scrubMain, SAMPLE_LINK_HOST, SCRUB_ITEMS_MAX, scrubFeed, scrubOptionsFor, ScrubRefused } from "../fixtures/src/scrub-feed";

const ROOT = path.resolve(__dirname, "..");
const FEEDS = path.join(ROOT, "fixtures", "feeds");
const T0 = Date.parse("2026-10-13T20:37:00Z");
const cfg = loadConfig({ root: ROOT });
const fetched = cfg.sources.feeds.filter((f) => f.kind !== "search");

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};
function tempRoot(): string {
  const root = tmp("ct-check-");
  fs.cpSync(path.join(ROOT, "config"), path.join(root, "config"), { recursive: true });
  return root;
}
function feedsVariant(edit: (index: Record<string, { file?: string; status?: number; error?: string; content_type?: string }>) => void): string {
  const dir = tmp("ct-check-feeds-");
  fs.cpSync(FEEDS, dir, { recursive: true });
  const index = JSON.parse(fs.readFileSync(path.join(FEEDS, "index.json"), "utf8"));
  edit(index);
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index));
  return dir;
}

let saved: string | undefined;
beforeAll(() => {
  saved = process.env.CT_FIXTURE_FEEDS;
  process.env.CT_FIXTURE_FEEDS = FEEDS;
});
afterAll(() => {
  if (saved === undefined) delete process.env.CT_FIXTURE_FEEDS;
  else process.env.CT_FIXTURE_FEEDS = saved;
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("checkFeeds on the fixture feeds", () => {
  let rows: CheckRow[];
  let exitCode: 0 | 1;
  let root: string;
  beforeAll(async () => {
    root = tempRoot();
    ({ rows, exitCode } = await checkFeeds({ now: T0, root }));
  });

  it("has one row per registry entry, in registry order, with search rows SKIP", () => {
    expect(rows.map((r) => r.id)).toEqual(cfg.sources.feeds.map((f) => f.id));
    for (const r of rows.filter((x) => x.kind === "search")) expect(r).toMatchObject({ status: "SKIP", items: 0, newest: null, fresh: "-", error: null });
  });

  it("labels the fixture's failures, stale feeds and fresh feeds", () => {
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get("krebs")).toMatchObject({ status: "FAIL", error: "timeout", fresh: "-" });
    expect(by.get("gtig")).toMatchObject({ status: "FAIL", error: "http_503" });
    expect(by.get("unit42")).toMatchObject({ status: "STALE", fresh: "no (64 d)", error: null });
    expect(by.get("google-security")).toMatchObject({ status: "NODATE", newest: null, fresh: "-" });
    expect(by.get("kev")).toMatchObject({ status: "OK", items: 111, newest: "2026-10-13T17:02:11Z", fresh: "yes", priority: 1 });
    expect(by.get("nvd")).toMatchObject({ status: "OK", items: 2, fresh: "-" });
    expect(by.get("bleepingcomputer")).toMatchObject({ status: "OK", items: 40, fresh: "yes" });
    expect(exitCode).toBe(0);
  });

  it("keeps the raw bodies in its own cache, cache/check/feeds/, for scrub-feed.ts and writes no pack", () => {
    expect(fs.existsSync(path.join(root, "cache", "check", "feeds", "therecord.xml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "cache", "feeds"))).toBe(false);
    expect(fs.existsSync(path.join(root, "packs"))).toBe(false);
    expect(fs.existsSync(path.join(root, "content"))).toBe(false);
  });

  it("prints the table and the summary line over fetched entries", () => {
    const text = formatCheckTable(rows);
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("id\tkind\tstatus\titems\tnewest\tfresh\tpriority\terror");
    expect(lines.length).toBe(rows.length + 2);
    expect(lines.find((l) => l.startsWith("krebs\t"))).toBe("krebs\trss\tFAIL\t0\t-\t-\t2\ttimeout");
    const ok = rows.filter((r) => r.status === "OK").length;
    expect(lines.at(-1)).toBe(`${ok} of ${fetched.length} entries ok; 0 priority-1 problems.`);
    expect(ok).toBe(fetched.length - 4);
  });
});

describe("checkFeeds reads in two waves and keeps its own cache (B1, B2)", () => {
  // The light reads: every registry URL of these kinds (NVD's carries its query).
  const LIGHT = new Set(["rss", "nvd", "myjvn", "exchange", "anthropic-cvd", "kev"]);
  const lightUrls = fetched
    .filter((f) => LIGHT.has(f.kind))
    .flatMap((f) => { const e = f as { url: string; fallback_url: string | null }; return [e.url, e.fallback_url]; })
    .filter((u): u is string => typeof u === "string");
  const isLight = (u: string) => lightUrls.some((p) => u === p || u.startsWith(`${p}?`));
  const isHeavy = (u: string) => u === "ghsa-sync" || /(?:deltaLog\.json|\.zip|\.csv\.gz)$/.test(u);

  it("requests every light feed before the deltaLog, the EPSS files or the GHSA sync, and keeps registry order (B1)", async () => {
    const order: string[] = [];
    const base = fixtureGit(FEEDS);
    const git: GitSource = { ...base, syncGhsa: async (dir, months) => { order.push("ghsa-sync"); return base.syncGhsa(dir, months); } };
    const fetch: typeof fetchFeed = (url, opts) => { order.push(url); return fetchFeed(url, opts); };
    const { rows } = await checkFeeds({ now: T0, root: tempRoot(), deps: { fetch, git } });
    const firstHeavy = order.findIndex(isHeavy);
    const lastLight = order.reduce((at, u, i) => (isLight(u) ? i : at), -1);
    expect(order.filter(isHeavy)).toEqual(expect.arrayContaining(["ghsa-sync", "https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/deltaLog.json"]));
    expect(order.some((u) => /\.csv\.gz$/.test(u))).toBe(true);
    expect(order.filter(isLight).length).toBeGreaterThan(30);
    expect(lastLight).toBeLessThan(firstHeavy);
    expect(rows.map((r) => r.id)).toEqual(cfg.sources.feeds.map((f) => f.id));
  });

  it("writes under cache/check/ and never into collect's cache (B2)", async () => {
    const root = tempRoot();
    const mine = (rel: string, text: string) => {
      const file = path.join(root, "cache", ...rel.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    mine("feeds/kev.json", "collect's catalog");
    mine("feeds/inputs.json", "collect's inputs");
    mine("ghsa/advisories/keep.json", "collect's checkout");
    mine("epss/epss_scores-2026-10-13.csv.gz", "collect's scores");
    await checkFeeds({ now: T0, root });
    expect(fs.readFileSync(path.join(root, "cache", "feeds", "kev.json"), "utf8")).toBe("collect's catalog");
    expect(fs.readdirSync(path.join(root, "cache", "feeds")).sort()).toEqual(["inputs.json", "kev.json"]);
    expect(fs.readdirSync(path.join(root, "cache", "ghsa"))).toEqual(["advisories"]);
    expect(fs.readdirSync(path.join(root, "cache", "ghsa", "advisories"))).toEqual(["keep.json"]);
    expect(fs.readdirSync(path.join(root, "cache", "epss"))).toEqual(["epss_scores-2026-10-13.csv.gz"]);
    expect(fs.readFileSync(path.join(root, "cache", "epss", "epss_scores-2026-10-13.csv.gz"), "utf8")).toBe("collect's scores");
    expect(fs.readdirSync(path.join(root, "cache")).sort()).toEqual(["check", "epss", "feeds", "ghsa"]);
    const check = path.join(root, "cache", "check");
    expect(JSON.parse(fs.readFileSync(path.join(check, "feeds", "kev.json"), "utf8"))).toHaveProperty("catalogVersion");
    expect(fs.existsSync(path.join(check, "feeds", "cvelist.deltaLog.json"))).toBe(true);
    expect(fs.existsSync(path.join(check, "ghsa"))).toBe(true);
    expect(fs.readdirSync(path.join(check, "epss")).some((f) => f.endsWith(".csv.gz"))).toBe(true);
  });
});

describe("checkFeeds exit codes and options", () => {
  it("exits 1 when a priority-1 entry is STALE", async () => {
    process.env.CT_FIXTURE_FEEDS = feedsVariant((idx) => {
      idx["https://therecord.media/feed"] = { file: "rss/stale.xml", content_type: "application/rss+xml" };
    });
    try {
      const r = await checkFeeds({ now: T0, root: tempRoot() });
      expect(r.rows.find((x) => x.id === "therecord")).toMatchObject({ status: "STALE", priority: 1 });
      expect(r.exitCode).toBe(1);
      expect(formatCheckTable(r.rows).trimEnd().split("\n").at(-1)).toMatch(/; 1 priority-1 problems\.$/);
    } finally {
      process.env.CT_FIXTURE_FEEDS = FEEDS;
    }
  });

  it("exits 1 when a priority-1 entry fails, and 0 when only lower priorities do", async () => {
    process.env.CT_FIXTURE_FEEDS = feedsVariant((idx) => {
      idx["https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json"] = { status: 503 };
      idx["https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"] = { error: "timeout" };
    });
    try {
      const r = await checkFeeds({ now: T0, root: tempRoot() });
      expect(r.rows.find((x) => x.id === "kev")).toMatchObject({ status: "FAIL", error: "timeout" });
      expect(r.exitCode).toBe(1);
    } finally {
      process.env.CT_FIXTURE_FEEDS = FEEDS;
    }
  });

  it("--id checks one entry, and an unknown id is an error", async () => {
    const r = await checkFeeds({ id: "jpcert", now: T0, root: tempRoot() });
    expect(r.rows).toEqual([{ id: "jpcert", kind: "rss", status: "OK", items: 4, newest: "2026-10-13T18:00:00Z", fresh: "yes", priority: 1, error: null }]);
    await expect(checkFeeds({ id: "no-such-feed", now: T0, root: tempRoot() })).rejects.toThrow(/no registry entry/);
  });

  it("the command line prints JSON with --json and exits 2 for an unknown --id", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
    const code = await main(["--check-feeds", "--id", "jpcert", "--json"], { io, root: tempRoot(), env: process.env });
    const rows = JSON.parse(out.join("\n")) as CheckRow[];
    expect(rows.map((r) => r.id)).toEqual(["jpcert"]);
    // The command line reads the real clock, so the fixture's 2026-10-13 feed is OK or STALE by then.
    expect(code).toBe(rows[0]!.status === "OK" ? 0 : 1);
    expect(await main(["--check-feeds", "--id", "no-such-feed"], { io, root: tempRoot(), env: process.env })).toBe(2);
    expect(err.join("\n")).toContain("no registry entry");
  });
});

// ── fixtures/src/scrub-feed.ts: what sources:check leaves in cache/check/feeds/, scrubbed into a fixture ─

describe("scrub-feed", () => {
  const opts = { sourceTiers: cfg.sourceTiers, keywords: cfg.sources.keywords };
  const links = (text: string) => text.replace(/&amp;/g, "&").match(/https?:\/\/[^\s"'<>\\)\]]+/g) ?? [];
  const NS = /^http:\/\/(?:purl\.org\/|www\.w3\.org\/|jvn\.jp\/rss\/|data-marking\.mitre\.org\/|jvndb\.jvn\.jp\/myjvn\/|www\.us-cert\.gov\/tlp\/|wellformedweb\.org\/CommentAPI\/|search\.yahoo\.com\/mrss\/|www\.itunes\.com\/dtds\/podcast-1\.0\.dtd|news\.web\.nhk\/rss\/rss2\.0\/modules\/nhknews\/|ogp\.me\/ns)/;
  const safe = (text: string) => {
    for (const u of links(text)) {
      if (u.startsWith("http://")) expect(u).toMatch(NS);
      else expect(blockedReason(u, cfg.sourceTiers), u).toBeNull();
    }
  };

  it("an RSS body from sources:check: six items, invented titles, links rewritten, dates and structure kept", async () => {
    const root = tempRoot();
    await checkFeeds({ id: "bleepingcomputer", now: T0, root });
    const body = fs.readFileSync(path.join(root, "cache", "check", "feeds", "bleepingcomputer.xml"));
    const before = await parseRss(body);
    const out = scrubFeed("rss", body, opts);
    const after = await parseRss(out);
    expect(after.total).toBe(SCRUB_ITEMS_MAX);
    expect(after.entries.map((e) => e.published_at)).toEqual(before.entries.slice(0, SCRUB_ITEMS_MAX).map((e) => e.published_at));
    for (const e of after.entries) {
      expect(e.title).toMatch(/^SAMPLE title \d+/);
      expect(e.url).toMatch(/^https:\/\/[a-z0-9.-]+\/ct-sample\/[a-z0-9-]+$/);
    }
    expect(new Set(after.entries.map((e) => e.url)).size).toBe(SCRUB_ITEMS_MAX);
    safe(out.toString("utf8"));
  });

  it("keeps keywords and CVE ids, removes people and addresses, upgrades links, and keeps RDF's item list in step", async () => {
    const rdf = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns="http://purl.org/rss/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel rdf:about="http://www.example.org/feed.rdf"><title>Example feed</title><link>http://www.example.org/</link>
<description>Channel text</description><dc:creator>Jane Example (jane@example.org)</dc:creator>
<items><rdf:Seq>${Array.from({ length: 8 }, (_, i) => `<rdf:li rdf:resource="https://www.example.org/news/${i}.html"/>`).join("")}</rdf:Seq></items></channel>
${Array.from({ length: 8 }, (_, i) => `<item rdf:about="https://www.example.org/news/${i}.html"><title>Ransomware hits a hospital, CVE-2026-104935 exploited (${i})</title>
<link>https://www.example.org/news/${i}.html?utm_source=rss&amp;utm_medium=feed#top</link><description><![CDATA[<p>Story by Jane Example. Contact jane@example.org</p>]]></description>
<dc:creator>Jane Example</dc:creator><dc:date>2026-10-13T1${i}:00:00+09:00</dc:date></item>`).join("\n")}
</rdf:RDF>`;
    const out = scrubFeed("rdf", Buffer.from(rdf), opts).toString("utf8");
    expect(out).not.toMatch(/Jane|jane@|Story by|hospital/);
    expect(out.match(/<item /g)!.length).toBe(SCRUB_ITEMS_MAX);
    expect(out.match(/<rdf:li /g)!.length).toBe(SCRUB_ITEMS_MAX);
    const parsed = await parseRss(Buffer.from(out));
    expect(parsed.entries[0]!.title).toBe("SAMPLE title 2 ransomware CVE-2026-104935");
    // www.example.org is neither a registry host nor a listed publisher (C5): the link moves to www.example.com,
    // and a path that is no id becomes a counter slug.
    expect(parsed.entries[0]!.url).toBe("https://www.example.com/ct-sample/item-2");
    expect(parsed.entries[0]!.published_at).toBe("2026-10-13T01:00:00.000Z");
    const about = [...out.matchAll(/<item rdf:about="([^"]+)"/g)].map((m) => m[1]);
    const li = [...out.matchAll(/<rdf:li rdf:resource="([^"]+)"/g)].map((m) => m[1]);
    expect(li).toEqual(about);
    expect(out).toContain('xmlns="http://purl.org/rss/1.0/"');
    safe(out);
  });

  it("refuses a capture that would keep a blocked host, another scheme or an unknown namespace", () => {
    const blocked = BLOCKED_HOSTS.find((b) => b.reason === "shortener")!.pattern;
    const rss = (link: string, ns = "") => Buffer.from(`<?xml version="1.0"?><rss version="2.0"${ns}><channel><title>x</title><item><title>t</title><link>${link}</link><pubDate>Tue, 13 Oct 2026 10:00:00 +0000</pubDate></item></channel></rss>`);
    // A link on a blocked host is never kept there: it moves to www.example.com (C5). One the tool cannot
    // rewrite (a namespace value) is refused.
    expect(scrubFeed("rss", rss(`https://${blocked}/abc`), opts).toString("utf8")).toContain("<link>https://www.example.com/ct-sample/item-1</link>");
    expect(() => scrubFeed("rss", rss("https://www.example.org/a", ` xmlns:x="https://${blocked}/ns"`), opts)).toThrow(ScrubRefused);
    expect(() => scrubFeed("rss", rss("javascript:void(0)"), opts)).toThrow(ScrubRefused);
    expect(() => scrubFeed("rss", rss("https://www.example.org/a", ' xmlns:x="http://www.example.net/ns/"'), opts)).toThrow(ScrubRefused);
    expect(() => scrubFeed("rss", rss("https://www.example.org/a"), opts)).not.toThrow();
  });

  it("EPSS keeps the fixture CVEs' rows and 40 filler rows, with the model line", () => {
    const gz = fs.readFileSync(path.join(FEEDS, "epss", "epss_scores-2026-10-13.csv.gz"));
    const before = parseEpssCsv(gz).day;
    const keep = new Set(["CVE-2023-34362", "CVE-2024-21762", "CVE-2026-104935"]);
    const out = scrubFeed("epss", gz, { ...opts, keepCves: keep });
    const after = parseEpssCsv(out).day;
    expect(after.model_version).toBe(before.model_version);
    expect(after.score_date).toBe(before.score_date);
    for (const id of keep) if (before.scores.has(id)) expect(after.scores.get(id)).toEqual(before.scores.get(id));
    expect(after.scores.size).toBe([...keep].filter((id) => before.scores.has(id)).length + Math.min(EPSS_FILLER_ROWS, before.scores.size - keep.size));
    expect(gunzipSync(out).toString("utf8").split("\n")[0]).toMatch(/^#model_version:/);
    expect(fixtureCveIds(FEEDS).has("CVE-2026-104935")).toBe(true);
  });

  it("NVD: six vulnerabilities at most, references dropped, NIST's scores kept, other addresses replaced", () => {
    const body = fs.readFileSync(path.join(FEEDS, "nvd", "page-1.json"));
    const out = scrubFeed("nvd", body, opts);
    const json = JSON.parse(out.toString("utf8"));
    expect(parseNvdPage(out).scores).toEqual(parseNvdPage(body).scores);
    for (const v of json.vulnerabilities) {
      expect(v.cve.references).toEqual([]);
      expect(v.cve.sourceIdentifier).toBe("sample@example.com");
      for (const d of v.cve.descriptions) expect(d.value).toMatch(/^SAMPLE /);
    }
    expect(json.totalResults).toBe(json.vulnerabilities.length);
    safe(out.toString("utf8"));
  });

  it("the exchange keeps its notices' cyber terms, dates and codes, and invents the rest", () => {
    const body = fs.readFileSync(path.join(FEEDS, "exchange-tw", "twse.json"));
    const out = scrubFeed("exchange", body, opts);
    const before = parseExchange(body, "twse").entries;
    const after = parseExchange(out, "twse").entries;
    expect(after.map((n) => [n.company_code, n.spoken_at])).toEqual(before.slice(0, SCRUB_ITEMS_MAX).map((n) => [n.company_code, n.spoken_at]));
    expect(after.every((n) => n.company.startsWith("SAMPLE"))).toBe(true);
    expect(after.some((n) => /資安|網路攻擊|駭客|勒索/.test(`${n.subject} ${n.text}`))).toBe(true);
  });

  it("the dashboard page and payload keep the revision, the date and the ids", () => {
    const page = fs.readFileSync(path.join(FEEDS, "anthropic-cvd", "page.html"));
    const payload = fs.readFileSync(path.join(FEEDS, "anthropic-cvd", "payload.json"));
    const before = parseAnthropicCvd(page, "text/html", payload);
    const p2 = scrubFeed("anthropic-cvd", page, opts);
    const j2 = scrubFeed("anthropic-cvd", payload, opts);
    const after = parseAnthropicCvd(p2, "text/html", j2);
    expect({ revision: after.revision, as_of: after.as_of }).toEqual({ revision: before.revision, as_of: before.as_of });
    expect(after.ledger_ids.every((id) => before.ledger_ids.includes(id))).toBe(true);
    safe(p2.toString("utf8"));
    safe(j2.toString("utf8"));
  });

  // ── Kobol's captures of 2026-11-09 (C4, C5): what the tool refused or let through, now fixed ──────────

  const full = scrubOptionsFor(cfg);
  const rssWith = (items: string, ns = "") => Buffer.from(`<?xml version="1.0"?><rss version="2.0"${ns}><channel><title>x</title>
<link>https://www.bleepingcomputer.com/</link><docs>http://www.rssboard.org/rss-specification</docs>${items}</channel></rss>`);

  it("replaces authors and names under any namespace prefix: dc:, a10:, atom:, itunes:, managingEditor (C4)", async () => {
    const ns = ' xmlns:a10="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"';
    const body = rssWith(`<managingEditor>editor@realcorp.invalid (Kenji Realperson)</managingEditor><itunes:author>Kenji Realperson</itunes:author>
<item><title>t</title><link>https://www.bleepingcomputer.com/news/security/a/</link><pubDate>Tue, 13 Oct 2026 10:00:00 +0000</pubDate>
<a10:author><a10:name>Jane Q. Realperson</a10:name><a10:email>jane@realcorp.invalid</a10:email><a10:uri>https://www.example.com/u/jane-realperson</a10:uri></a10:author>
<a10:contributor><a10:name>Bob Realperson</a10:name></a10:contributor><dc:creator><![CDATA[Jane Realperson]]></dc:creator><dc:creator></dc:creator>
<atom:name xmlns:atom="http://www.w3.org/2005/Atom">Jane Realperson</atom:name></item>`, ns);
    const out = scrubFeed("rss", body, full).toString("utf8");
    expect(out).not.toMatch(/Realperson|realperson|realcorp/);
    expect(out).toContain("<a10:name>SAMPLE Author</a10:name><a10:email>sample@example.com</a10:email>");
    expect(out).toContain("<a10:contributor><a10:name>SAMPLE Author</a10:name></a10:contributor>");
    expect(out).toContain("<dc:creator>SAMPLE Author</dc:creator><dc:creator></dc:creator>");
    expect(out).toContain("<itunes:author>SAMPLE Author</itunes:author>");
    expect(out).toContain("<managingEditor>SAMPLE Author</managingEditor>");
    expect(out).toMatch(/<atom:name xmlns:atom="http:\/\/www\.w3\.org\/2005\/Atom">SAMPLE Author<\/atom:name>/);
    expect((await parseRss(Buffer.from(out))).total).toBe(1);
  });

  it("a JSON string that held an e-mail address is invented whole; a bare address keeps its form (C4)", () => {
    const body = Buffer.from(JSON.stringify({ vulnerabilities: [{ cve: {
      id: "CVE-2026-104935", sourceIdentifier: "jane.r@realcorp.invalid", published: "2026-11-07T21:17:00.150",
      descriptions: [{ lang: "en", value: "Reported by Jane Q. Realperson (jane.r@realcorp.invalid), phone 02-1234-5678, of Example Lab." }],
      metrics: { cvssMetricV31: [{ source: "nvd@nist.gov", type: "Primary", cvssData: { version: "3.1", vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", baseScore: 9.8 } }] },
    } }] }));
    const out = scrubFeed("nvd", body, full).toString("utf8");
    expect(out).not.toMatch(/Realperson|realcorp|1234-5678|Example Lab/);
    const cve = JSON.parse(out).vulnerabilities[0].cve;
    expect(cve.sourceIdentifier).toBe("sample@example.com");
    expect(cve.descriptions[0].value).toMatch(/^SAMPLE value \d+$/);
    expect(cve.metrics.cvssMetricV31[0].source).toBe("nvd@nist.gov");
  });

  it("keeps vectorString and NVD's status and role words as written, whatever their length (C5)", () => {
    const v40 = "CVSS:4.0/AV:N/AC:L/AT:N/PR:H/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/E:P/CR:X/IR:X/AR:X/MAV:X/MAC:X/MAT:X/MPR:X/MUI:X/MVC:X/MVI:X/MVA:X/MSC:X/MSI:X/MSA:X/S:X/AU:X/R:X/V:X/RE:X/U:Clear";
    expect(v40.length).toBeGreaterThan(120);
    const body = Buffer.from(JSON.stringify({ vulnerabilities: [{ cve: {
      id: "CVE-2026-104935", vulnStatus: "Awaiting Analysis",
      metrics: {
        cvssMetricV40: [{ source: "nvd@nist.gov", type: "Secondary", cvssData: { version: "4.0", vectorString: v40, baseSeverity: "HIGH" } }],
        cvssMetricV2: [{ source: "nvd@nist.gov", type: "Primary", cvssData: { version: "2.0", vectorString: "AV:N/AC:L/Au:M/C:C/I:C/A:C" } }],
        other: [{ content: { role: "CISA Coordinator", note: "Free text by Jane Realperson" } }],
      },
    } }] }));
    const cve = JSON.parse(scrubFeed("nvd", body, full).toString("utf8")).vulnerabilities[0].cve;
    expect(cve.vulnStatus).toBe("Awaiting Analysis");
    expect(cve.metrics.cvssMetricV40[0].cvssData.vectorString).toBe(v40);
    expect(cve.metrics.cvssMetricV2[0].cvssData.vectorString).toBe("AV:N/AC:L/Au:M/C:C/I:C/A:C");
    expect(cve.metrics.other[0].content.role).toBe("CISA Coordinator");
    expect(cve.metrics.other[0].content.note).toMatch(/^SAMPLE note \d+$/);
  });

  it("credits in JSON name no person: GitHub logins, OSV names and CVE credit values become SAMPLE Researcher (C4)", () => {
    const body = Buffer.from(JSON.stringify({ ledger: [{ ghsa_id: "GHSA-2f8c-wq4h-r7jm", credits: [
      { type: "reporter", user: { login: "maria-realperson", html_url: "https://github.com/maria-realperson" } },
      { name: "Realperson", type: "FINDER" }, { lang: "en", value: "Jane Realperson", type: "finder" }, "kenji-realperson",
    ] }] }));
    const out = scrubFeed("anthropic-cvd", body, full).toString("utf8");
    expect(out).not.toMatch(/realperson/i);
    const c = JSON.parse(out).ledger[0].credits;
    expect(c).toEqual([
      { type: "reporter", user: { login: "SAMPLE Researcher", html_url: "https://www.example.com/ct-sample/item-1" } },
      { name: "SAMPLE Researcher", type: "FINDER" }, { lang: "en", value: "SAMPLE Researcher", type: "finder" }, "SAMPLE Researcher",
    ]);
  });

  it("accepts the four namespaces Kobol's captures declared, and keeps them as written (C5)", async () => {
    const ns = ' xmlns:wfw="http://wellformedweb.org/CommentAPI/" xmlns:media="http://search.yahoo.com/mrss/"'
      + ' xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:nhknews="http://news.web.nhk/rss/rss2.0/modules/nhknews/"';
    const body = rssWith(`<item><title>t</title><link>https://www.bleepingcomputer.com/news/security/a/</link><pubDate>Tue, 13 Oct 2026 10:00:00 +0000</pubDate>
<wfw:commentRss>https://www.bleepingcomputer.com/news/security/a/feed/</wfw:commentRss><media:content url="https://www.bleepingcomputer.com/images/a.jpg"/></item>`, ns);
    const out = scrubFeed("rss", body, full).toString("utf8");
    for (const u of ["http://wellformedweb.org/CommentAPI/", "http://search.yahoo.com/mrss/", "http://www.itunes.com/dtds/podcast-1.0.dtd", "http://news.web.nhk/rss/rss2.0/modules/nhknews/"]) {
      expect(out).toContain(`"${u}"`);
      expect(u, u).toMatch(NS);
    }
    expect(out).toContain('<media:content url="https://www.bleepingcomputer.com/ct-sample/img-1"/>');
    expect((await parseRss(Buffer.from(out))).total).toBe(1);
  });

  it("replaces text attributes (an Atom link's title, a category's term) and keeps the Open Graph namespace (Kobol session 2)", async () => {
    const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:og="http://ogp.me/ns#"><title>Example blog</title><updated>2026-10-27T07:00:00Z</updated>
<entry><title>A real post title</title><link rel="alternate" type="text/html" href="https://googleprojectzero.blogspot.com/2026/10/real-post.html" title="A real post title"/>
<category scheme="http://www.blogger.com/atom/ns#" term="Jane Realperson"/><published>2026-10-27T07:00:00Z</published><updated>2026-10-27T07:00:00Z</updated></entry>
</feed>`;
    const out = scrubFeed("atom", Buffer.from(atom), full).toString("utf8");
    expect(out).not.toMatch(/real post|Realperson/i);
    expect(out).toContain('title="SAMPLE"');
    expect(out).toContain('term="SAMPLE"');
    expect(out).toContain('xmlns:og="http://ogp.me/ns#"');
    const parsed = await parseRss(Buffer.from(out));
    expect(parsed.total).toBe(1);
    expect(parsed.entries[0]!.published_at).toBe("2026-10-27T07:00:00.000Z");
  });

  it("rewrites the dashboard's GitHub advisory links to www.example.com instead of refusing its own output (C5)", () => {
    const page = Buffer.from(`<!doctype html><html><body><p>Revision 40</p><p>Last updated 2026-11-02 19:30 UTC</p>
<a href="https://github.com/advisories/GHSA-2f8c-wq4h-r7jm">GHSA-2f8c-wq4h-r7jm</a><a href="https://www.cve.org/CVERecord?id=CVE-2026-104935">CVE-2026-104935</a></body></html>`);
    const p2 = scrubFeed("anthropic-cvd", page, full).toString("utf8");
    expect(p2).toContain('href="https://www.example.com/ct-sample/ghsa-2f8c-wq4h-r7jm"');
    expect(p2).not.toContain("github.com");
    const payload = Buffer.from(JSON.stringify({ revision: 40, ghsa_records: [{ id: "GHSA-2f8c-wq4h-r7jm", url: "https://github.com/advisories/GHSA-2f8c-wq4h-r7jm" }] }));
    const j2 = JSON.parse(scrubFeed("anthropic-cvd", payload, full).toString("utf8"));
    expect(j2.ghsa_records[0]).toEqual({ id: "GHSA-2f8c-wq4h-r7jm", url: "https://www.example.com/ct-sample/ghsa-2f8c-wq4h-r7jm" });
  });

  it("keeps a link's host only for a registry host or a listed publisher, and a slug only when it is an id (C5)", () => {
    const urls = [
      "https://www.bleepingcomputer.com/news/security/jane-realperson-interview/", // registry host, a name in the path
      "https://www.jpcert.or.jp/at/2026/at260033.html", // registry host, a JPCERT id
      "https://jvndb.jvn.jp/ja/contents/2026/JVNDB-2026-012345.html",
      "https://www.twcert.org.tw/tw/TVN-202611001.html",
      "https://www.cve.org/CVERecord/CVE-2026-104935",
      "https://ithome.superfeedr.com/", // a hub: not a publisher
      "https://cwe.mitre.org/data/definitions/79.html",
      "https://www.example.org/u/dana-realperson",
      "https://www.bleepingcomputer.com/images/jane-realperson.png",
      "HTTP://www.bleepingcomputer.com/news/security/Upper-Case/",
    ];
    // Two captures of five items each (the tool keeps six); each file numbers its own counter slugs.
    const scrubbed = [urls.slice(0, 5), urls.slice(5)].map((part) => scrubFeed("rss", rssWith(part.map((u, i) =>
      `<item><title>t${i}</title><link>${u}</link><pubDate>Tue, 13 Oct 2026 10:00:00 +0000</pubDate></item>`).join("")), full).toString("utf8"));
    const links = scrubbed.flatMap((out) => [...out.matchAll(/<link>([^<]+)<\/link>/g)].map((m) => m[1]));
    expect(links).toEqual([
      "https://www.bleepingcomputer.com/ct-sample/home",
      "https://www.bleepingcomputer.com/ct-sample/item-2",
      "https://www.jpcert.or.jp/ct-sample/at260033",
      "https://jvndb.jvn.jp/ct-sample/jvndb-2026-012345",
      "https://www.twcert.org.tw/ct-sample/tvn-202611001",
      "https://www.cve.org/ct-sample/cve-2026-104935",
      "https://www.bleepingcomputer.com/ct-sample/home",
      "https://www.example.com/ct-sample/home",
      "https://www.example.com/ct-sample/item-2",
      "https://www.example.com/ct-sample/item-3",
      "https://www.bleepingcomputer.com/ct-sample/img-1",
      "https://www.bleepingcomputer.com/ct-sample/item-4",
    ]);
    // The channel docs link (rssboard.org) moved too, and no path text but the ids survived.
    for (const out of scrubbed) {
      expect(out).toContain("<docs>https://www.example.com/ct-sample/item-1</docs>");
      expect(out).not.toMatch(/realperson|interview|definitions|upper-case|superfeedr|rssboard|mitre/i);
    }
    // keepsHost(): registry hosts and listed publishers keep their host; blocked and unlisted ones never do.
    const keep = keepsHost(full);
    const kept = (h: string) => keep(`https://${h}/ct-sample/x`, h);
    expect(["jvndb.jvn.jp", "www.twcert.org.tw", "www.cve.org", "feeds.feedburner.com", "cloudblog.withgoogle.com"].filter(kept)).toHaveLength(5);
    expect(["cwe.mitre.org", "www.example.org", "github.com", "raw.githubusercontent.com", SAMPLE_LINK_HOST].filter(kept)).toEqual([]);
  });

  it("the command line writes on success, writes nothing when it refuses, and exits 2 on usage", async () => {
    const dir = tmp("ct-scrub-");
    const io = { out: () => {}, err: () => {} };
    const from = path.join(FEEDS, "rss", "zoneless.rdf");
    expect(scrubMain(["rdf", from, path.join(dir, "ok.rdf")], io, ROOT)).toBe(0);
    expect((await parseRss(fs.readFileSync(path.join(dir, "ok.rdf")))).total).toBeGreaterThan(0);
    const bad = path.join(dir, "bad.xml");
    fs.writeFileSync(bad, `<rss version="2.0"><channel><item><title>t</title><link>javascript:void(0)</link></item></channel></rss>`);
    expect(scrubMain(["rss", bad, path.join(dir, "bad.out.xml")], io, ROOT)).toBe(1);
    expect(fs.existsSync(path.join(dir, "bad.out.xml"))).toBe(false);
    expect(scrubMain(["html", from, path.join(dir, "x")], io, ROOT)).toBe(2);
    expect(scrubMain(["rss", from], io, ROOT)).toBe(2);
    expect(scrubMain(["epss", from, path.join(dir, "x"), "--keep"], io, ROOT)).toBe(2);
  });
});
