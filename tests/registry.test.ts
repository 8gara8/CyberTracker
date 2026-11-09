// The committed registry (config/sources.yaml) against the fixture world: every URL collect builds for
// the 2026-10-14 morning is in fixtures/feeds/index.json and nothing else is, index-degraded.json fails
// what it says it fails, git-refs.json answers for the three repos, and the URL helpers work on the
// registry's own URLs (feeds plan §9, moved here from tests/config.test.ts by the build plan).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packWindow } from "../lib/collect";
import { loadConfig } from "../lib/config";
import { addDays } from "../lib/dates";
import { cvdPayloadUrl } from "../lib/feeds/anthropic-cvd";
import { epssUrlFor } from "../lib/feeds/epss";
import { cveRecordRawUrl, endOfDayAsset, hourlyAsset, rawAtCommit, REPOS } from "../lib/feeds/github";
import { nvdUrls } from "../lib/feeds/nvd";
import type { FetchedFeed } from "../lib/schema/registry";
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

  it("holds nothing else except the per-id records the no-state run asks for, all answered 404", () => {
    const extra = Object.keys(index).filter((u) => !world.has(u));
    expect(extra.length).toBeGreaterThan(0);
    for (const u of extra) {
      expect(u.startsWith(`https://raw.githubusercontent.com/${REPOS.cvelist}/${cveMain}/cves/`), u).toBe(true);
      expect(index[u]!.status).toBe(404);
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
    expect(failing.length).toBe(11);
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

describe("the URL helpers on the committed registry", () => {
  it("epssUrlFor turns the current-file URL into a dated one", () => {
    expect(epssUrlFor(one("epss").url, "2026-10-13")).toBe("https://epss.empiricalsecurity.com/epss_scores-2026-10-13.csv.gz");
  });

  it("rawAtCommit pins the KEV mirror and deltaLog.json to a commit", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(rawAtCommit(one("kev").url, sha)).toBe(`https://raw.githubusercontent.com/cisagov/kev-data/${sha}/known_exploited_vulnerabilities.json`);
    expect(rawAtCommit(one("cvelist").url, sha)).toBe(`https://raw.githubusercontent.com/CVEProject/cvelistV5/${sha}/cves/deltaLog.json`);
  });

  it("every fetched entry's URL is https", () => {
    for (const f of fetched) {
      expect(f.url, f.id).toMatch(/^https:\/\//);
      if (f.fallback_url) expect(f.fallback_url, f.id).toMatch(/^https:\/\//);
    }
  });
});
