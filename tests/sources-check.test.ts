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
import { EPSS_FILLER_ROWS, fixtureCveIds, main as scrubMain, SCRUB_ITEMS_MAX, scrubFeed, ScrubRefused } from "../fixtures/src/scrub-feed";

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
  const NS = /^http:\/\/(?:purl\.org|www\.w3\.org|jvn\.jp\/rss|data-marking\.mitre\.org|jvndb\.jvn\.jp\/myjvn|www\.us-cert\.gov\/tlp)\//;
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
    expect(parsed.entries[0]!.url).toBe("https://www.example.org/ct-sample/0");
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
    expect(() => scrubFeed("rss", rss(`https://${blocked}/abc`), opts)).toThrow(ScrubRefused);
    expect(() => scrubFeed("rss", rss("javascript:void(0)"), opts)).toThrow(ScrubRefused);
    expect(() => scrubFeed("rss", rss("https://www.example.org/a", ' xmlns:media="http://search.yahoo.com/mrss/"'), opts)).toThrow(ScrubRefused);
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
