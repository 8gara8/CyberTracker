// scripts/metrics.ts runMetrics() and scripts/lib/feed-cache.ts loadFeedCache() (SPEC §8.4; rulings R28,
// R30, R31, R33) in temporary repos. The cache holds WP1's fixture feeds for the 2026-10-14 morning
// (fixtures/feeds/, the zips and catalog from feedOutputs()); the state is built at cutoff − 1 with the
// production builders, on synthetic day counts. Offline: git runs only on the temporary repo.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { addDays, taipeiTimestamp } from "@/lib/dates";
import { parseKev } from "@/lib/feeds/kev";
import { endOfDayAsset, hourlyAsset } from "@/lib/feeds/github";
import { jsonText, sha256Hex } from "@/lib/json";
import { aiFindersOf, buildCredits } from "@/lib/metrics/ai-credit";
import { dayMap } from "@/lib/metrics/flood";
import { buildKevIndex, indexEntries, indexFacts } from "@/lib/metrics/kev-index";
import { liveFromAfter, weeklySeries } from "@/lib/metrics/series";
import { joinKev } from "@/lib/metrics/window";
import { InputsManifest, Metrics, STATE_FILES, STATE_SCHEMAS, type DayRow, type StateFiles } from "@/lib/schema/metrics";
import { CollectInputsFile, FeedIndexFile, type FeedIndexEntry } from "@/lib/schema/pack";
import { feedOutputs, FEED_WORLD, KEV_CATALOG_PATH, EOD_ZIP_PATH, HOURLY_ZIP_PATH } from "@/fixtures/src/feeds";
import { firstDifference, REPRODUCED, runMetrics, STATE_MISSING } from "@/scripts/metrics";
import { loadFeedCache, NoFeedsError } from "@/scripts/lib/feed-cache";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FEEDS = path.join(REPO, "fixtures", "feeds");
const D = FEED_WORLD.date;
const C = FEED_WORLD.cutoff;
const S = addDays(C, -1);
const T = FEED_WORLD.runUtcDay;
/** 04:45 Taipei on D (20:45 UTC the day before): a live morning, so reconstructed is false. */
const NOW = new Date(`${T}T20:45:00Z`);
/** D's two new KEV entries, in CVE order (compareCveIds sorts 96951 before 104935). */
const NEW_IDS = ["CVE-2026-96951", "CVE-2026-104935"];

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const write = (file: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};
const exists = (file: string) => fs.existsSync(file);
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

const outputs = feedOutputs();
const bytesOf = (p: string): Buffer => {
  const o = outputs.find((x) => x.path === p)!;
  return "bytes" in o ? o.bytes : Buffer.from(o.text);
};

/** The state at S: the catalog without D's two new entries (every row unjoined), synthetic days, empty credits. */
function buildState(): StateFiles {
  const config = loadConfig({ root: REPO, fresh: true });
  const run = aiFindersOf(config, config.compiled);
  const catalog = parseKev(bytesOf(KEV_CATALOG_PATH)).catalog;
  const before = { ...catalog, catalogVersion: "2026.10.10", vulnerabilities: catalog.vulnerabilities.filter((v) => !NEW_IDS.includes(v.cveID)) };
  before.count = before.vulnerabilities.length;
  const index = buildKevIndex(before, new Map(), S);
  const days: DayRow[] = [];
  for (let d = "2023-01-01"; d <= S; d = addDays(d, 1)) days.push([d, 90 + (Number(d.slice(8)) % 5), 9, 4, sha256Hex(`synthetic ${d}`)]);
  const credits = buildCredits({ records: [], ghsa: [] }, run, S);
  return {
    "kev-index.json": index,
    "days.json": { schema_version: 1, updated_at: S, days },
    "ai-credits.json": credits.credits,
    "credit-candidates.json": credits.candidates,
    "anthropic-cvd.json": { schema_version: 1, updated_at: S, revision: null, as_of: null, fetched_at: null, source_url: null, found_n: null, disclosed_n: null, patched_n: null, ledger_ids: [] },
    "series.json": weeklySeries({ days: dayMap(days), rows: joinKev(indexEntries(index), indexFacts(index)), credits: credits.credits, dataOnlyDates: [] }, S, liveFromAfter(S)),
  };
}
const STATE = buildState();

function indexEntry(id: string, kind: string, o: Partial<FeedIndexEntry> = {}): FeedIndexEntry {
  return {
    id, kind, status: "ok", label: "OK", error_class: null, url_used: `https://example.com/ct-sample/${id}`, fallback_used: false,
    newest: `${T}T20:00:00Z`, items: 0, records: 1, version: null, sha256: sha256Hex(id), fetched_at: `${T}T20:40:00Z`, note: null, ...o,
  };
}

/** Writes collect's cache for D: inputs.json, index.json and every body the metrics read. */
function writeCache(root: string): void {
  const cache = path.join(root, "cache");
  const eod = endOfDayAsset(C).asset;
  const hourly = hourlyAsset(T, "2000").asset;
  const kevBody = bytesOf(KEV_CATALOG_PATH);
  const catalog = parseKev(kevBody).catalog;
  write(path.join(cache, "feeds", "kev.json"), kevBody);
  write(path.join(cache, "cvelist", "zips", eod), bytesOf(EOD_ZIP_PATH));
  write(path.join(cache, "cvelist", "zips", hourly), bytesOf(HOURLY_ZIP_PATH));
  const byId = fs.readdirSync(path.join(FEEDS, "cvelist", "by-id")).filter((n) => n.endsWith(".json")).sort();
  for (const n of byId) write(path.join(cache, "cvelist", "records", n), fs.readFileSync(path.join(FEEDS, "cvelist", "by-id", n)));
  const epss = { e: T, e1: C, e7: addDays(T, -7) } as const;
  for (const date of Object.values(epss)) {
    const name = `epss_scores-${date}.csv.gz`;
    write(path.join(cache, "epss", name), fs.readFileSync(path.join(FEEDS, "epss", name)));
  }
  fs.cpSync(path.join(FEEDS, "ghsa", "repo", "advisories"), path.join(cache, "ghsa", "advisories"), { recursive: true });
  write(path.join(cache, "feeds", "anthropic-cvd.html"), fs.readFileSync(path.join(FEEDS, "anthropic-cvd", "page.html")));
  write(path.join(cache, "feeds", "anthropic-cvd.payload.json"), fs.readFileSync(path.join(FEEDS, "anthropic-cvd", "payload.json")));

  const inputs = CollectInputsFile.parse({
    schema_version: 1, date: D, data_cutoff_utc: C, generated_at: `${T}T20:40:00Z`, run_utc_day: T,
    record_window: { start: `${C}T20:00:00Z`, end: `${T}T20:00:00Z` },
    commits: { cvelist: "a".repeat(40), kev_data: "b".repeat(40), ghsa: "c".repeat(40) },
    cvelist: {
      zips: [
        { tag: FEED_WORLD.eodTag, asset: eod, kind: "end_of_day", utc_day: C, sha256: sha256Hex(bytesOf(EOD_ZIP_PATH)), records: 18 },
        { tag: FEED_WORLD.hourlyTag, asset: hourly, kind: "hourly", utc_day: T, sha256: sha256Hex(bytesOf(HOURLY_ZIP_PATH)), records: 30 },
      ],
      days: [{ date: C, zips: [eod, hourly], ok: true }],
      newest_hourly_tag: FEED_WORLD.hourlyTag, delta_log_newest: `${T}T20:00:00Z`,
      by_id: { fetched: byId.map((n) => n.replace(/\.json$/, "")), not_found: [], over_cap: 0 },
    },
    kev: { catalog_version: catalog.catalogVersion, date_released: catalog.dateReleased, count: catalog.count, url_used: "https://example.com/ct-sample/kev", sha256: sha256Hex(kevBody), fallback_used: false },
    epss: { source: "csv", model_version: "v2026.06.15", files: Object.entries(epss).map(([role, date]) => ({ role, date, sha256: sha256Hex(date) })) },
    ghsa: { commit: "c".repeat(40), head_date: T, months: ["2026/10"], tree_sha256: sha256Hex("tree"), advisories: 5 },
    anthropic_cvd: { revision: "37", as_of: "2026-10-13", sha256: sha256Hex("cvd"), fetched_at: `${T}T20:41:00Z`, changed: true },
  });
  const index = FeedIndexFile.parse({
    schema_version: 1, date: D, generated_at: `${T}T20:42:00Z`,
    feeds: [
      indexEntry("kev", "kev"), indexEntry("cvelist", "cvelist"), indexEntry("epss", "epss"), indexEntry("ghsa", "ghsa"),
      // collect records the payload's hash when it read the payload (scripts/lib/feeds.ts readCvd).
      indexEntry("anthropic-cvd", "anthropic-cvd", { sha256: sha256Hex(fs.readFileSync(path.join(FEEDS, "anthropic-cvd", "payload.json"))) }),
    ],
  });
  write(path.join(cache, "feeds", "inputs.json"), jsonText(inputs, CollectInputsFile));
  write(path.join(cache, "feeds", "index.json"), jsonText(index, FeedIndexFile));
}

/** A temporary repo: config/ copied, content/state/ at S, the cache for D, one commit. */
function repo(o: { state?: boolean; cache?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-metrics-"));
  temps.push(root);
  fs.cpSync(path.join(REPO, "config"), path.join(root, "config"), { recursive: true });
  write(path.join(root, ".gitignore"), "/cache/\n/logs/\n");
  if (o.state !== false) for (const name of STATE_FILES) write(path.join(root, "content", "state", name), jsonText(STATE[name], STATE_SCHEMAS[name]));
  if (o.cache !== false) writeCache(root);
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.name", "CyberTracker test");
  sh(root, "config", "user.email", "test@example.com");
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "state", "--date", "2026-10-13T00:00:00Z");
  return root;
}

/** Rewrites one row of collect's cache/feeds/index.json. */
function editIndex(root: string, id: string, o: Partial<FeedIndexEntry>): void {
  const file = path.join(root, "cache", "feeds", "index.json");
  const index = FeedIndexFile.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  write(file, jsonText({ ...index, feeds: index.feeds.map((f) => (f.id === id ? { ...f, ...o } : f)) }, FeedIndexFile));
}

/** Rewrites collect's cache/feeds/inputs.json. */
function editInputs(root: string, edit: (i: CollectInputsFile) => CollectInputsFile): void {
  const file = path.join(root, "cache", "feeds", "inputs.json");
  write(file, jsonText(edit(CollectInputsFile.parse(JSON.parse(fs.readFileSync(file, "utf8")))), CollectInputsFile));
}

const readMetrics = (dir: string) => Metrics.parse(JSON.parse(fs.readFileSync(path.join(dir, "metrics", `${D}.json`), "utf8")));

describe("loadFeedCache", () => {
  it("reads every metrics feed from collect's cache", () => {
    const root = repo();
    const f = loadFeedCache(root, D);
    expect(f.kev.catalog?.catalogVersion).toBe(FEED_WORLD.kev.version);
    expect(f.cvelist.days).toHaveLength(1);
    expect(f.cvelist.days[0]!.ok).toBe(true);
    expect(f.cvelist.days[0]!.records.filter((r) => r.date_published === C).length).toBeGreaterThan(0);
    expect(f.cvelist.byId.get(FEED_WORLD.rejoinId)).not.toBeNull();
    expect(f.epss.e && f.epss.e1 && f.epss.e7).toBeTruthy();
    expect(f.ghsa.advisories.length).toBe(5);
    expect(f.anthropicCvd.dashboard?.revision).toBe("37");
    expect(f.cvelist.read.version).toBe(`${"a".repeat(40)} ${FEED_WORLD.eodTag} ${FEED_WORLD.hourlyTag}`);
    expect(f.epss.read.version).toBe(`e=${T} e1=${C} e7=${addDays(T, -7)}`);
  });

  it("uses the cached dashboard payload only when its hash is the one collect recorded, else the page alone (B3)", () => {
    const root = repo();
    const f = loadFeedCache(root, D);
    expect(f.anthropicCvd.dashboard).toMatchObject({ revision: "37", found_n: 5710 });
    // Today's payload fetch failed: collect parsed the page alone and recorded the page's hash, while an
    // earlier run's payload (another revision) is still on disk.
    const page = fs.readFileSync(path.join(root, "cache", "feeds", "anthropic-cvd.html"));
    editIndex(root, "anthropic-cvd", { sha256: sha256Hex(page) });
    const stale = JSON.parse(fs.readFileSync(path.join(FEEDS, "anthropic-cvd", "payload.json"), "utf8")) as Record<string, unknown>;
    write(path.join(root, "cache", "feeds", "anthropic-cvd.payload.json"), JSON.stringify({ ...stale, revision: 36, total_verified: 5000 }));
    const g = loadFeedCache(root, D);
    expect(g.anthropicCvd.dashboard).toMatchObject({ revision: "37", found_n: null });
    expect(g.anthropicCvd.read).toMatchObject({ version: "37", sha256: sha256Hex(page) });
  });

  it("names the kev-data commit as the KEV version only for a mirror read; a cisa.gov read is its catalogVersion (B11)", () => {
    const root = repo();
    expect(loadFeedCache(root, D).kev.read.version).toBe("b".repeat(40));
    editInputs(root, (i) => ({ ...i, kev: { ...i.kev!, fallback_used: true, url_used: "https://www.cisa.gov/ct-sample/kev" } }));
    expect(loadFeedCache(root, D).kev.read.version).toBe(FEED_WORLD.kev.version);
    editInputs(root, (i) => ({ ...i, commits: { ...i.commits, kev_data: null }, kev: { ...i.kev!, fallback_used: false } }));
    expect(loadFeedCache(root, D).kev.read.version).toBe(FEED_WORLD.kev.version);
  });

  it("throws NoFeedsError without inputs.json or for another date, and fails a feed whose body is missing", () => {
    const root = repo();
    fs.rmSync(path.join(root, "cache", "feeds", "kev.json"));
    const f = loadFeedCache(root, D);
    expect(f.kev).toMatchObject({ catalog: null, read: { status: "failed", sha256: null } });
    expect(() => loadFeedCache(root, "2026-10-15")).toThrow(NoFeedsError);
    fs.rmSync(path.join(root, "cache", "feeds", "inputs.json"));
    expect(() => loadFeedCache(root, D)).toThrow(NoFeedsError);
  });
});

describe("runMetrics", () => {
  it("stages metrics, the manifest and the changed state under cache/staged/D/, emptied first", async () => {
    const root = repo();
    const staged = path.join(root, "cache", "staged", D);
    write(path.join(staged, "stray.txt"), "left from an earlier run");
    const r = await runMetrics({ date: D, root, now: NOW });
    expect(r.code).toBe(0);
    expect(r.firstLine).toMatch(new RegExp(`^Metrics ${D}: data to ${C} UTC · ok: window, flood, ai_credited, fix_side, kev, home_vendors, epss · stale: none · failed: none\\.$`));
    expect(exists(path.join(staged, "stray.txt"))).toBe(false);
    expect(r.wrote).toEqual(expect.arrayContaining([`metrics/${D}.json`, `metrics/inputs/${D}.json`, "state/days.json", "state/kev-index.json"]));
    const m = readMetrics(staged);
    expect(m).toMatchObject({ generated_at: taipeiTimestamp(NOW), reconstructed: false, code_commit: sh(root, "rev-parse", "HEAD") });
    expect(m.kev?.new_since_last_edition.cve_ids).toEqual(NEW_IDS);
    const days = STATE_SCHEMAS["days.json"].parse(JSON.parse(fs.readFileSync(path.join(staged, "state", "days.json"), "utf8")));
    expect(days.days.at(-1)![0]).toBe(C);
    const idx = STATE_SCHEMAS["kev-index.json"].parse(JSON.parse(fs.readFileSync(path.join(staged, "state", "kev-index.json"), "utf8")));
    expect(idx.entries.find((e) => e[0] === FEED_WORLD.rejoinId)![4]).not.toBeNull();
    InputsManifest.parse(JSON.parse(fs.readFileSync(path.join(staged, "metrics", "inputs", `${D}.json`), "utf8")));
    expect(exists(path.join(root, "content", "metrics"))).toBe(false);
  });

  it("writes byte-identical files on a rerun with the same clock (R31)", async () => {
    const root = repo();
    const a = await runMetrics({ date: D, root, now: NOW });
    const first = a.wrote.map((f) => fs.readFileSync(path.join(root, "cache", "staged", D, f), "utf8"));
    const b = await runMetrics({ date: D, root, now: NOW });
    expect(b.wrote).toEqual(a.wrote);
    expect(b.wrote.map((f) => fs.readFileSync(path.join(root, "cache", "staged", D, f), "utf8"))).toEqual(first);
    const c = await runMetrics({ date: D, root, now: new Date(NOW.getTime() + 60_000) });
    const later = readMetrics(path.join(root, "cache", "staged", D));
    const diff = firstDifference(JSON.parse(first[0]!), later);
    expect(diff).toBe("generated_at");
    expect(c.code).toBe(0);
  });

  it("prints metrics/D.json exists and writes nothing when content/metrics/D.json exists (R30)", async () => {
    const root = repo();
    write(path.join(root, "content", "metrics", `${D}.json`), "{}\n");
    const r = await runMetrics({ date: D, root, now: NOW });
    expect(r).toEqual({ code: 0, firstLine: `metrics/${D}.json exists`, lines: [`metrics/${D}.json exists`], wrote: [] });
    expect(exists(path.join(root, "cache", "staged", D))).toBe(false);
  });

  it("exits 1 when state/ is missing", async () => {
    const root = repo({ state: false });
    const r = await runMetrics({ date: D, root, now: NOW });
    expect(r.code).toBe(1);
    expect(r.firstLine).toBe(STATE_MISSING);
  });

  it("with --out content writes the named files and deletes nothing", async () => {
    const root = repo();
    write(path.join(root, "content", "metrics", "keep.txt"), "keep");
    write(path.join(root, "content", "state", "keep.txt"), "keep");
    write(path.join(root, "content", "briefs", "2026-10-13.json"), "{}\n");
    const r = await runMetrics({ date: D, root, out: "content", now: NOW });
    expect(r.code).toBe(0);
    for (const f of ["metrics/keep.txt", "state/keep.txt", "briefs/2026-10-13.json", ...STATE_FILES.map((n) => `state/${n}`)]) {
      expect(exists(path.join(root, "content", f))).toBe(true);
    }
    expect(readMetrics(path.join(root, "content")).date).toBe(D);
    expect(exists(path.join(root, "cache", "staged", D))).toBe(false);
  });

  it("writes nothing once the deadline has passed", async () => {
    const root = repo();
    const r = await runMetrics({ date: D, root, now: NOW, deadline: Date.now() - 1 });
    expect(r.code).toBe(1);
    expect(r.wrote).toEqual([]);
    expect(exists(path.join(root, "cache", "staged", D))).toBe(false);
    const c = await runMetrics({ date: D, root, out: "content", now: NOW, deadline: Date.now() - 1 });
    expect(c.code).toBe(1);
    expect(exists(path.join(root, "content", "metrics"))).toBe(false);
  });

  it("without collect's cache counts every feed failed, except inside a build (frozenState) where it exits 1", async () => {
    const root = repo({ cache: false });
    const r = await runMetrics({ date: D, root, now: NOW });
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => l.endsWith("Every feed counts as failed."))).toBe(true);
    expect(r.firstLine).toContain("failed: window, flood, ai_credited, fix_side, kev, home_vendors, epss.");
    const f = await runMetrics({ date: D, root, now: NOW, frozenState: true, stateDir: "content/state", out: "content" });
    expect(f).toMatchObject({ code: 1, firstLine: `No feeds for ${D} in cache/: run npm run collect -- --date ${D} first.` });
  });

  it("marks a past date reconstructed", async () => {
    const root = repo();
    const r = await runMetrics({ date: D, root, now: new Date("2026-10-20T00:00:00Z") });
    expect(r.code).toBe(0);
    expect(readMetrics(path.join(root, "cache", "staged", D)).reconstructed).toBe(true);
  });
});

describe("runMetrics --recompute (R33)", () => {
  async function committed(): Promise<string> {
    const root = repo();
    const r = await runMetrics({ date: D, root, out: "content", now: NOW });
    expect(r.code).toBe(0);
    sh(root, "add", "-A");
    sh(root, "commit", "-q", "-m", `Edition ${D}`, "--date", "2026-10-14T00:00:00Z");
    return root;
  }

  it("reproduces the committed file from the parent commit's state and prints Reproduced.", async () => {
    const root = await committed();
    const r = await runMetrics({ date: D, root, recompute: true });
    expect(r).toMatchObject({ code: 0, firstLine: REPRODUCED });
    const out = path.join(root, "logs", "recompute", D);
    expect(fs.readFileSync(path.join(out, "metrics", `${D}.json`), "utf8")).toBe(fs.readFileSync(path.join(root, "content", "metrics", `${D}.json`), "utf8"));
    expect(sh(root, "status", "--porcelain")).toBe("");
  });

  it("names the first differing path when the committed file was changed", async () => {
    const root = await committed();
    const file = path.join(root, "content", "metrics", `${D}.json`);
    const m = readMetrics(path.join(root, "content"));
    fs.writeFileSync(file, jsonText({ ...m, flood: { ...m.flood!, n: m.flood!.n + 1 } }, Metrics));
    const r = await runMetrics({ date: D, root, recompute: true });
    expect(r.code).toBe(1);
    expect(r.firstLine).toBe("Not reproduced: the first difference is at flood.n.");
    expect(r.lines).toContain("Every feed hash matches the committed manifest.");
  });

  it("names the feeds whose hashes differ when an input changed", async () => {
    const root = await committed();
    const e7 = path.join(root, "cache", "epss", `epss_scores-${addDays(T, -7)}.csv.gz`);
    fs.copyFileSync(path.join(FEEDS, "epss", `epss_scores-${T}.csv.gz`), e7);
    const r = await runMetrics({ date: D, root, recompute: true });
    expect(r.code).toBe(1);
    expect(r.firstLine).toMatch(/^Not reproduced: the first difference is at /);
    expect(r.lines).toContain("Feeds whose hashes differ: epss.");
  });

  it("exits 1 when there is no committed file", async () => {
    const root = repo();
    expect(await runMetrics({ date: D, root, recompute: true })).toMatchObject({ code: 1, firstLine: `metrics/${D}.json does not exist: nothing to recompute.` });
  });
});

describe("firstDifference", () => {
  it("returns the first differing JSON path, or null", () => {
    expect(firstDifference({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toBeNull();
    expect(firstDifference({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] })).toBe("b[1]");
    expect(firstDifference({ a: { c: 1 } }, { a: {} })).toBe("a.c");
  });
});
