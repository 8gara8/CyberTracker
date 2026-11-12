// The committed registry (config/sources.yaml) against the fixture world: every URL collect builds for
// the 2026-10-14 morning is in fixtures/feeds/index.json and nothing else is, index-degraded.json fails
// what it says it fails, git-refs.json answers for the three repos, and the URL helpers work on the
// registry's own URLs (feeds plan §9, moved here from tests/config.test.ts by the build plan).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { packWindow } from "../lib/collect";
import { loadConfig } from "../lib/config";
import { addDays } from "../lib/dates";
import { cvdPayloadUrl } from "../lib/feeds/anthropic-cvd";
import { epssUrlFor } from "../lib/feeds/epss";
import { cveRecordRawUrl, endOfDayAsset, hourlyAsset, rawAtCommit, REPOS } from "../lib/feeds/github";
import { nvdUrls } from "../lib/feeds/nvd";
import { FetchedFeed } from "../lib/schema/registry";
import { publisherFor } from "../lib/sources";
import { FEED_WORLD } from "../fixtures/src/feeds";

const ROOT = path.resolve(__dirname, "..");
const FEEDS = path.join(ROOT, "fixtures", "feeds");
const cfg = loadConfig({ root: ROOT });
const fetched = cfg.sources.feeds.filter((f): f is FetchedFeed => f.kind !== "search");
const one = (kind: FetchedFeed["kind"]) => fetched.find((f) => f.kind === kind)!;

type Entry = { file?: string; status?: number; content_type?: string; error?: string };
const readIndex = (name: string) => JSON.parse(fs.readFileSync(path.join(FEEDS, name), "utf8")) as Record<string, Entry>;
const index = readIndex("index.json");
const degraded = readIndex("index-degraded.json");
const refs = JSON.parse(fs.readFileSync(path.join(FEEDS, "git-refs.json"), "utf8")) as {
  repos: Record<string, Record<string, string> | null>;
  ghsa: { commit: string; head_date: string } | null;
};
const SHA = /^[0-9a-f]{40}$/;
const cveMain = refs.repos[REPOS.cvelist]!["refs/heads/main"]!;
const kevDevelop = refs.repos[REPOS.kev]!["refs/heads/develop"]!;

/** Every URL collect builds for FEED_WORLD (the registry's URLs, the fallback, SHA-pinned raw URLs, assets, per-id records, EPSS days, the NVD page). */
function worldUrls(): Map<string, string> {
  const out = new Map<string, string>();
  const add = (url: string, why: string) => out.set(url, why);
  const kev = one("kev");
  add(rawAtCommit(kev.url, kevDevelop), "kev at the develop commit");
  add(kev.url, "kev on the branch (ls-remote failed)");
  add(kev.fallback_url!, "kev fallback");
  const cve = one("cvelist");
  add(rawAtCommit(cve.url, cveMain), "deltaLog at the main commit");
  add(cve.url, "deltaLog on the branch");
  add(endOfDayAsset(FEED_WORLD.cutoff).url, "end-of-day zip");
  add(hourlyAsset(FEED_WORLD.runUtcDay, FEED_WORLD.hourlyTag.slice(-5, -1)).url, "hourly zip");
  for (const f of fs.readdirSync(path.join(FEEDS, "cvelist", "by-id"))) add(cveRecordRawUrl(cveMain, f.replace(/\.json$/, "")), "per-id record");
  const epss = one("epss");
  add(epss.url, "EPSS current");
  for (const d of [FEED_WORLD.runUtcDay, addDays(FEED_WORLD.runUtcDay, -1), addDays(FEED_WORLD.runUtcDay, -7)]) add(epssUrlFor(epss.url, d), `EPSS ${d}`);
  add(nvdUrls(one("nvd").url, packWindow(FEED_WORLD.date, cfg.run.pack))[0]!, "NVD page 1");
  const cvd = one("anthropic-cvd");
  add(cvd.url, "dashboard page");
  add(cvdPayloadUrl(cvd.url), "dashboard payload");
  for (const f of fetched.filter((x) => x.kind === "rss" || x.kind === "exchange" || x.kind === "myjvn")) add(f.url, f.id);
  return out;
}

describe("fixtures/feeds/index.json", () => {
  const world = worldUrls();

  it("holds every URL collect builds for the 2026-10-14 morning", () => {
    for (const [url, why] of world) expect(index[url], `${why}: ${url}`).toBeDefined();
  });

  it("holds nothing else except the per-id records the no-state run asks for (all answered 404) and the pipeline draft's pages", () => {
    const extra = Object.keys(index).filter((u) => !world.has(u));
    const pages = extra.filter((u) => index[u]!.file?.startsWith("pages/"));
    const records = extra.filter((u) => !pages.includes(u));
    expect(records.length).toBeGreaterThan(0);
    for (const u of records) {
      expect(u.startsWith(`https://raw.githubusercontent.com/${REPOS.cvelist}/${cveMain}/cves/`), u).toBe(true);
      expect(index[u]!.status).toBe(404);
    }
    // P3: the sample pages the pipeline draft cites (fixtures/agent/drafts/2026-10-14.json) and the two
    // cve.org record pages of the 2026-10-14 data-only edition, served as HTML so snapshots and the link
    // check find them.
    const draft = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "agent", "drafts", "2026-10-14.json"), "utf8")) as {
      sources: { url: string }[];
    };
    const cited = new Set(draft.sources.map((s) => s.url));
    expect(pages.length).toBeGreaterThan(0);
    for (const u of pages) {
      expect(index[u]!.content_type, u).toBe("text/html; charset=utf-8");
      expect(cited.has(u) || /^https:\/\/www\.cve\.org\/CVERecord\?id=CVE-\d{4}-\d{4,}$/.test(u), u).toBe(true);
    }
  });

  it("every entry is https and is a file, an HTTP status or an error class, and each file exists inside fixtures/feeds", () => {
    for (const [url, e] of Object.entries(index)) {
      expect(url).toMatch(/^https:\/\//);
      const kinds = [e.file !== undefined, e.error !== undefined, e.status !== undefined && e.file === undefined].filter(Boolean).length;
      expect(kinds, url).toBe(1);
      if (e.file) {
        const p = path.resolve(FEEDS, e.file);
        expect(p.startsWith(`${FEEDS}${path.sep}`), url).toBe(true);
        expect(fs.existsSync(p), e.file).toBe(true);
        expect(e.content_type, url).toBeTruthy();
      }
      if (e.error) expect(["timeout", "dns", "tls", "network"]).toContain(e.error);
    }
  });

  it("includes a timeout, a 503 and a 404, and keeps the main world under the degraded line", () => {
    const values = Object.values(index);
    expect(values.some((e) => e.error === "timeout")).toBe(true);
    expect(values.some((e) => e.status === 503)).toBe(true);
    expect(values.some((e) => e.status === 404)).toBe(true);
    const rss = fetched.filter((f) => f.kind === "rss");
    const failing = rss.filter((f) => index[f.url]!.error !== undefined || (index[f.url]!.status ?? 200) >= 300);
    expect(failing.length / rss.length).toBeLessThan(0.4);
    for (const u of [rawAtCommit(one("kev").url, kevDevelop), one("kev").fallback_url!]) expect(index[u]!.file).toBe("kev/known_exploited_vulnerabilities.json");
  });
});

describe("fixtures/feeds/index-degraded.json", () => {
  it("has the same URLs as index.json", () => {
    expect(Object.keys(degraded).sort()).toEqual(Object.keys(index).sort());
  });

  it("fails KEV on every URL and at least 40% of the rss entries", () => {
    const kev = one("kev");
    for (const u of [rawAtCommit(kev.url, kevDevelop), kev.url, kev.fallback_url!]) {
      const e = degraded[u]!;
      expect(e.file, u).toBeUndefined();
      expect(e.error !== undefined || (e.status ?? 200) >= 300, u).toBe(true);
    }
    const rss = fetched.filter((f) => f.kind === "rss");
    const failing = rss.filter((f) => {
      const e = degraded[f.url]!;
      return e.error !== undefined || (e.status ?? 200) >= 300 || e.file === "rss/garbage.xml";
    });
    expect(failing.length).toBe(12);
    expect(failing.length / rss.length).toBeGreaterThanOrEqual(0.4);
  });
});

describe("fixtures/feeds/git-refs.json", () => {
  it("answers ls-remote for the three repos with fixture SHAs and the world's tags", () => {
    expect(Object.keys(refs.repos).sort()).toEqual([REPOS.cvelist, REPOS.ghsa, REPOS.kev].sort());
    for (const r of Object.values(refs.repos)) for (const sha of Object.values(r!)) expect(sha).toMatch(SHA);
    const cveRefs = Object.keys(refs.repos[REPOS.cvelist]!);
    expect(cveRefs).toEqual(expect.arrayContaining([`refs/tags/${FEED_WORLD.eodTag}`, `refs/tags/${FEED_WORLD.hourlyTag}`, "refs/tags/cve_2026-10-13_1900Z"]));
    expect(refs.ghsa).toEqual({ commit: refs.repos[REPOS.ghsa]!["refs/heads/main"], head_date: FEED_WORLD.runUtcDay });
    expect(fs.existsSync(path.join(FEEDS, "ghsa", "repo", "advisories", "github-reviewed", "2026", "10"))).toBe(true);
  });

  it("the registry's ghsa entry is the repo the git source reads", () => {
    expect(one("ghsa").url).toBe(`https://github.com/${REPOS.ghsa}.git`);
  });
});

// Kobol, 2026-11-09 (the curl read and P2 session 1's sources:check): the feed paths that answer, and the
// source-tiers domains that place them (version 2).
describe("the registry as Kobol's reads finalised it", () => {
  const byId = (id: string) => fetched.find((f) => f.id === id)!;
  const tierOf = (url: string) => {
    const p = publisherFor(url, "press", cfg);
    return [p.tier, p.publisher];
  };

  it("reads the feed paths that answered", () => {
    expect(byId("gtig")).toMatchObject({ name: "Google Threat Intelligence blog", url: "https://cloudblog.withgoogle.com/topics/threat-intelligence/rss/" });
    // Session 2 (2026-11-10): the feedburner feed stopped at 2026-04-23; the blog moved to blog.google/security.
    expect(byId("google-security")).toMatchObject({ name: "Google Security Blog", url: "https://blog.google/security/rss/" });
    expect(byId("bsi")).toMatchObject({
      name: "BSI press and events", url: "https://www.bsi.bund.de/SiteGlobals/Functions/RSSFeed/RSSNewsfeed/RSSNewsfeed_Presse_Veranstaltungen.xml",
    });
    expect(byId("cert-eu").fresh_days).toBe(30);
  });

  it("splits CISA into its joint advisories (about monthly) and its alerts, both priority 1", () => {
    const adv = byId("cisa-advisories");
    const alerts = byId("cisa-alerts");
    expect(adv).toMatchObject({ kind: "rss", url: "https://www.cisa.gov/cybersecurity-advisories/cybersecurity-advisories.xml", priority: 1, fresh_days: 60 });
    expect(alerts).toMatchObject({
      name: "CISA alerts", kind: "rss", url: "https://www.cisa.gov/cybersecurity-advisories/alerts.xml", fallback_url: null, priority: 1, fresh_days: 7,
      must_match: false, date_zone: null,
    });
    expect([alerts.language, alerts.region, alerts.coverage]).toEqual([adv.language, adv.region, adv.coverage]);
    expect(fetched.map((f) => f.id).indexOf("cisa-alerts")).toBe(fetched.map((f) => f.id).indexOf("cisa-advisories") + 1);
    expect(cfg.sources.feeds).toHaveLength(48);
    expect(fetched.filter((f) => f.kind === "rss")).toHaveLength(28);
  });

  it("source-tiers from version 2 places the new paths with their publishers; TDnet's www host matches its parent domain", () => {
    // Version 3 (P5, row 184) only adds verizon-dbir, so version 2's paths still hold.
    expect([cfg.sourceTiers.version, cfg.sourceTiers.updated]).toEqual([3, "2026-11-12"]);
    expect(tierOf("https://www.verizon.com/business/resources/reports/dbir/")).toEqual([1, "verizon-dbir"]);
    expect(tierOf("https://www.verizon.com/about/news/")[0]).toBe(3);
    expect(tierOf(byId("gtig").url)).toEqual([1, "mandiant"]);
    expect(tierOf(byId("google-security").url)).toEqual([1, "google-security"]);
    expect(tierOf("https://feeds.feedburner.com/googleonlinesecurityblog/")).toEqual([1, "google-security"]);
    expect(tierOf("https://blog.google/security/a-post/")).toEqual([1, "google-security"]);
    expect(tierOf("https://blog.google/threat-analysis-group/a-post/")).toEqual([1, "google-tag"]);
    expect(tierOf(byId("bsi").url)).toEqual([1, "bsi"]);
    expect(tierOf(byId("cisa-alerts").url)).toEqual([1, "cisa"]);
    expect(tierOf("https://acs.gov.tw/")).toEqual([1, "moda-acs"]);
    expect(tierOf("https://moda.gov.tw/ACS/")).toEqual([1, "moda-acs"]);
    expect(tierOf("https://www.release.tdnet.info/inbs/I_main_00.html")).toEqual([1, "tdnet"]);
    // Only the threat-intelligence path of Google's cloud blog is Mandiant's; other paths and feedburner feeds stay tier 3.
    expect(tierOf("https://cloudblog.withgoogle.com/products/ct-sample/")[0]).toBe(3);
    expect(tierOf("https://feeds.feedburner.com/ct-sample")[0]).toBe(3);
  });
});

describe("the URL helpers on the committed registry", () => {
  it("epssUrlFor turns the current-file URL into a dated one", () => {
    expect(epssUrlFor(one("epss").url, "2026-10-13")).toBe("https://epss.empiricalsecurity.com/epss_scores-2026-10-13.csv.gz");
  });

  it("rawAtCommit pins the KEV mirror and deltaLog.json to a commit", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(rawAtCommit(one("kev").url, sha)).toBe(`https://raw.githubusercontent.com/cisagov/kev-data/${sha}/known_exploited_vulnerabilities.json`);
    expect(rawAtCommit(one("cvelist").url, sha)).toBe(`https://raw.githubusercontent.com/CVEProject/cvelistV5/${sha}/cves/deltaLog.json`);
  });

  it("every fetched entry writes date_zone out: +08:00 for ithome-security (Kobol 2026-11-09), null for every other", () => {
    const raw = parseYaml(fs.readFileSync(path.join(ROOT, "config", "sources.yaml"), "utf8")) as { feeds: Record<string, unknown>[] };
    for (const f of raw.feeds) {
      if (f.kind === "search") expect(Object.keys(f), String(f.id)).not.toContain("date_zone");
      else expect(Object.keys(f), String(f.id)).toContain("date_zone");
    }
    expect(fetched.filter((f) => f.date_zone !== null).map((f) => [f.id, f.date_zone])).toEqual([["ithome-security", "+08:00"]]);
  });

  it("the schema needs date_zone on a fetched entry and takes only an offset like +08:00 or null", () => {
    const base = structuredClone(fetched.find((f) => f.id === "ithome-security")!) as Record<string, unknown>;
    expect(FetchedFeed.safeParse(base).success).toBe(true);
    for (const zone of ["+09:00", "-05:00", "+05:30", null]) expect(FetchedFeed.safeParse({ ...base, date_zone: zone }).success, String(zone)).toBe(true);
    for (const zone of ["Z", "+8:00", "+0800", "08:00", "Asia/Taipei", "+25:00", ""]) expect(FetchedFeed.safeParse({ ...base, date_zone: zone }).success, zone).toBe(false);
    const { date_zone: _left, ...without } = base;
    expect(FetchedFeed.safeParse(without).success).toBe(false);
  });

  it("every fetched entry's URL is https", () => {
    for (const f of fetched) {
      expect(f.url, f.id).toMatch(/^https:\/\//);
      if (f.fallback_url) expect(f.fallback_url, f.id).toMatch(/^https:\/\//);
    }
  });
});
