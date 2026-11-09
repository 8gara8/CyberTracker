// scripts/backfill.ts and its clone reader (SPEC §5.9, §8.4; rulings R26 to R35) on the 50-record fixture
// clone: fixtures/cvelist-clone/ committed into a temp repo (tests/helpers/fixture-clone.ts) and fetched as
// file://, a small KEV catalog through fetchKev, free space through freeBytes. Each case runs in its own
// temp root with config/ copied and one git commit (runMetrics records HEAD). Offline throughout.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex, jsonText } from "@/lib/json";
import { parseKev } from "@/lib/feeds/kev";
import { InputsManifest, Metrics, STATE_FILES, STATE_SCHEMAS, type StateFiles } from "@/lib/schema/metrics";
import { CollectInputsFile, FeedIndexFile } from "@/lib/schema/pack";
import { DEFAULT_OUT, MIN_FREE_BYTES, parseBackfillArgs, PUBLISH_STATE_P3, runBackfill, type BackfillDeps, type BackfillOptions } from "@/scripts/backfill";
import { ensureClone, readClone } from "@/scripts/lib/cvelist-clone";
import type { GitSource } from "@/scripts/lib/git-source";
import { REFERENCE_INPUTS } from "@/scripts/lib/appendix-d";
import { FIXTURE_CLONE_DIR, FIXTURE_COMMIT_TIME, makeCloneRepo } from "./helpers/fixture-clone";

const REPO = path.resolve(__dirname, "..");
const GiB = 1024 ** 3;
/** 10:00 Taipei on 2026-11-09 (02:00 UTC): today's cutoff is 2026-11-07, outside --push's 04:00 to 06:00. */
const NOW = new Date("2026-11-09T02:00:00Z");
const C = "2026-11-06";
const KEV_COMMIT = "e".repeat(40);
const SLOW = 120_000;

/** Four real KEV entries: three join fixture records (lags -4, 3 and 0), one does not (its record is not in the fixture). */
const KEV_ROWS = [
  ["CVE-2022-41080", "Microsoft", "Exchange Server", "2023-01-10"],
  ["CVE-2026-118527", "Ivanti", "Connect Secure", "2026-10-30"],
  ["CVE-2026-119977", "WordPress", "WordPress", "2026-11-03"],
  ["CVE-2026-19868", "SonicWall", "SonicOS", "2026-11-06"],
] as const;
const KEV_BODY = Buffer.from(JSON.stringify({
  title: "SAMPLE catalog", catalogVersion: "2026.11.06", dateReleased: "2026-11-06T19:44:45.1797Z", count: KEV_ROWS.length,
  vulnerabilities: KEV_ROWS.map(([cveID, vendorProject, product, dateAdded]) => ({
    cveID, vendorProject, product, vulnerabilityName: `SAMPLE ${product} flaw`, dateAdded, shortDescription: "SAMPLE description.",
    requiredAction: "SAMPLE action.", dueDate: dateAdded, knownRansomwareCampaignUse: "Unknown", notes: "", cwes: [],
  })),
}));
const fetchKev: BackfillDeps["fetchKev"] = async (commit) => ({ catalog: parseKev(KEV_BODY).catalog, commit: commit ?? KEV_COMMIT, sha256: sha256Hex(KEV_BODY) });
const noGit: GitSource = { lsRemote: async () => null, syncGhsa: async () => null };

const temps: string[] = [];
let savedContent: string | undefined;
beforeEach(() => {
  savedContent = process.env.CT_CONTENT_DIR;
});
afterEach(() => {
  if (savedContent === undefined) delete process.env.CT_CONTENT_DIR;
  else process.env.CT_CONTENT_DIR = savedContent;
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const write = (file: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};
const read = (file: string) => fs.readFileSync(file, "utf8");
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=ct-test", "-c", "user.email=ct-test@example.invalid", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

interface Root {
  root: string;
  url: string;
  sha: string;
  lines: string[];
  deps: Partial<BackfillDeps>;
}

/** A temp root: config/, a .gitignore for cache/ and logs/, content/ via CT_CONTENT_DIR, one commit; and the fixture clone repo. */
function makeRoot(o: { reference?: boolean } = {}): Root {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-backfill-"));
  temps.push(root);
  fs.cpSync(path.join(REPO, "config"), path.join(root, "config"), { recursive: true });
  if (o.reference) fs.cpSync(path.join(REPO, "fixtures", "reference"), path.join(root, "fixtures", "reference"), { recursive: true });
  write(path.join(root, ".gitignore"), "/cache/\n/logs/\n/src/\n");
  fs.mkdirSync(path.join(root, "content"), { recursive: true });
  process.env.CT_CONTENT_DIR = path.join(root, "content");
  sh(root, "init", "-q", "-b", "main");
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "--no-gpg-sign", "-m", "root");
  const { url, sha } = makeCloneRepo(path.join(root, "src"));
  const lines: string[] = [];
  const deps: Partial<BackfillDeps> = { cloneUrl: url, git: noGit, fetchKev, freeBytes: () => 11 * GiB, now: () => NOW, workers: 2, print: (l) => lines.push(l) };
  return { root, url, sha, lines, deps };
}

function opts(r: Root, over: Partial<BackfillOptions> = {}): BackfillOptions {
  return { root: r.root, cutoff: C, commit: r.sha, kevCommit: null, mode: "build", fixtures: false, checkReference: false, out: DEFAULT_OUT, push: false, ...over };
}

/** collect's cache for edition date E, with every feed failed (the backfill's metrics then use the state alone). */
function writeCache(root: string, editionDate: string, cutoff: string, cvelistCommit: string | null = null): void {
  const inputs = CollectInputsFile.parse({
    schema_version: 1, date: editionDate, data_cutoff_utc: cutoff, generated_at: `${cutoff}T20:40:00Z`, run_utc_day: cutoff,
    record_window: { start: `${cutoff}T00:00:00Z`, end: `${cutoff}T00:00:00Z` },
    commits: { cvelist: cvelistCommit, kev_data: null, ghsa: null },
    cvelist: { zips: [], days: [], newest_hourly_tag: null, delta_log_newest: null, by_id: { fetched: [], not_found: [], over_cap: 0 } },
    kev: null, epss: null, ghsa: null, anthropic_cvd: null,
  });
  write(path.join(root, "cache", "feeds", "inputs.json"), jsonText(inputs, CollectInputsFile));
  write(path.join(root, "cache", "feeds", "index.json"), jsonText(FeedIndexFile.parse({ schema_version: 1, date: editionDate, generated_at: `${cutoff}T20:42:00Z`, feeds: [] }), FeedIndexFile));
}

function stateTexts(dir: string): Record<string, string> {
  return Object.fromEntries(STATE_FILES.map((n) => [n, read(path.join(dir, "state", n))]));
}
function stateOf(dir: string): StateFiles {
  return Object.fromEntries(STATE_FILES.map((n) => [n, STATE_SCHEMAS[n].parse(JSON.parse(read(path.join(dir, "state", n))))])) as unknown as StateFiles;
}
function copyState(from: string, to: string): void {
  fs.mkdirSync(path.join(to, "state"), { recursive: true });
  for (const n of STATE_FILES) fs.copyFileSync(path.join(from, "state", n), path.join(to, "state", n));
}

describe("the clone reader", () => {
  it("reads the 50 records the same with 1 and 4 workers, sorted by CVE id (R35)", async () => {
    const one = await readClone(FIXTURE_CLONE_DIR, 1);
    const four = await readClone(FIXTURE_CLONE_DIR, 4);
    expect(four).toEqual(one);
    expect(one.files).toBe(50);
    expect(one.unreadable).toEqual([]);
    expect(one.facts.filter((f) => f.state === "REJECTED").map((f) => f.cve_id)).toEqual(["CVE-2023-0039", "CVE-2026-98165", "CVE-2026-107492", "CVE-2026-113670", "CVE-2026-121803"]);
    const byId = new Map(one.facts.map((f) => [f.cve_id, f]));
    expect(byId.get("CVE-2022-38369")!.date_published).toBe("2022-09-05");
    expect(byId.get("CVE-2026-101165")!.scored).toBe(true); // CISA-ADP score only
    expect(byId.get("CVE-2024-7824")!.scored).toBe(false); // CVSS 2.0 only
    expect(byId.get("CVE-2026-100080")!.assigner).toBe("Linux");
    expect(byId.get("CVE-2026-100144")!.credits).toContainEqual({ field: "adp.credits", value: "SAMPLE Researcher using XBOW" });
  });

  it("fetches a commit from file:// in place, then reuses the clean clone at that commit (R26)", async () => {
    const r = makeRoot();
    const dir = path.join(r.root, "cache", "cvelistV5");
    const first = await ensureClone(dir, r.url, r.sha);
    expect(first).toMatchObject({ commit: r.sha, committedAt: FIXTURE_COMMIT_TIME, reused: false });
    expect(first.bytes).toBeGreaterThan(0);
    const again = await ensureClone(dir, r.url, r.sha);
    expect(again.reused).toBe(true);
    write(path.join(dir, "cves", "stray.txt"), "left over");
    const cleaned = await ensureClone(dir, r.url, r.sha);
    expect(cleaned.reused).toBe(false);
    expect(fs.existsSync(path.join(dir, "cves", "stray.txt"))).toBe(false);
    await expect(ensureClone(dir, r.url, "abc1234")).rejects.toThrow(/full commit SHA/);
  }, SLOW);
});

describe("the clone stays inside cache/cvelistV5 (B12)", () => {
  /** The enclosing repo's state that a clone command run against it would change. */
  const outer = (root: string) => ({
    head: sh(root, "rev-parse", "HEAD"), branch: sh(root, "symbolic-ref", "HEAD"), remotes: sh(root, "remote"),
    shallow: fs.existsSync(path.join(root, ".git", "shallow")), status: sh(root, "status", "--porcelain"),
  });

  it("removes a broken .git and clones fresh, never running git against the enclosing repo", async () => {
    const r = makeRoot();
    const dir = path.join(r.root, "cache", "cvelistV5");
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true }); // an interrupted rm -rf: .git without HEAD
    write(path.join(dir, "cves", "left-over.txt"), "partial copy");
    write(path.join(r.root, "config", "run.json"), `${fs.readFileSync(path.join(r.root, "config", "run.json"), "utf8")}\n`); // an uncommitted edit
    const before = outer(r.root);
    expect(before.status).toBe("M config/run.json");
    const info = await ensureClone(dir, r.url, r.sha);
    expect(info).toMatchObject({ commit: r.sha, reused: false });
    expect(outer(r.root)).toEqual(before);
    expect(sh(dir, "rev-parse", "--show-toplevel")).toBe(fs.realpathSync(dir));
    expect(fs.existsSync(path.join(dir, "cves", "left-over.txt"))).toBe(false);
  }, SLOW);

  it("ignores GIT_DIR and GIT_WORK_TREE in the environment", async () => {
    const r = makeRoot();
    const dir = path.join(r.root, "cache", "cvelistV5");
    const before = outer(r.root);
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(r.root, ".git");
    process.env.GIT_WORK_TREE = r.root;
    try {
      const info = await ensureClone(dir, r.url, r.sha);
      expect(info.commit).toBe(r.sha);
      expect((await ensureClone(dir, r.url, r.sha)).reused).toBe(true);
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.tree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = saved.tree;
    }
    expect(outer(r.root)).toEqual(before);
    expect(sh(dir, "rev-parse", "--show-toplevel")).toBe(fs.realpathSync(dir));
  }, SLOW);

  it("removes nothing that is not <repo>/cache/cvelistV5", async () => {
    const r = makeRoot();
    const elsewhere = path.join(r.root, "cache", "other");
    fs.mkdirSync(path.join(elsewhere, ".git"), { recursive: true });
    write(path.join(elsewhere, "keep.txt"), "not a clone");
    const before = outer(r.root);
    await expect(ensureClone(elsewhere, r.url, r.sha)).rejects.toThrow(/not a clone of its own.*cache\/cvelistV5/);
    expect(fs.readFileSync(path.join(elsewhere, "keep.txt"), "utf8")).toBe("not a clone");
    expect(outer(r.root)).toEqual(before);
  }, SLOW);
});

describe("the default build", () => {
  it("writes the state and E's metrics from the clone and the catalog", async () => {
    const r = makeRoot();
    writeCache(r.root, "2026-11-08", C);
    expect(await runBackfill(opts(r), r.deps)).toBe(0);
    const out = path.join(r.root, DEFAULT_OUT);
    const s = stateOf(out);
    const days = s["days.json"].days;
    expect(days[0]![0]).toBe("2023-01-01");
    expect(days.at(-1)![0]).toBe(C);
    expect(days).toHaveLength(1406);
    expect(days.find((d) => d[0] === "2023-05-13")).toEqual(["2023-05-13", 0, 0, 0, sha256Hex("")]);
    expect(days.find((d) => d[0] === C)!.slice(0, 3)).toEqual([C, 6, 2]);
    const matches = s["ai-credits.json"].matches;
    expect(matches.map((m) => m[0]).sort()).toEqual(["CVE-2025-27888", "CVE-2025-6965", "CVE-2026-100144", "CVE-2026-2763", "CVE-2026-6385", "CVE-2026-91928", "CVE-2026-93302"].sort());
    expect(matches.find((m) => m[0] === "CVE-2026-100144")!.slice(5, 8)).toEqual(["adp.credits", "XBOW", "pattern"]);
    expect(matches.find((m) => m[0] === "CVE-2026-93302")![7]).toBe("lab_context");
    expect(matches.every((m) => m[8] === C)).toBe(true);
    const entry = (id: string) => s["kev-index.json"].entries.find((e) => e[0] === id)!;
    expect(entry("CVE-2026-118527").slice(0, 2)).toEqual(["CVE-2026-118527", "2026-10-30"]);
    expect(entry("CVE-2026-118527")[4]).toBe("2026-11-03"); // listed 4 days before it was published: a negative lag
    expect(entry("CVE-2026-119977")[4]).toBe("2026-10-31");
    expect(entry("CVE-2022-41080")[4]).toBeNull(); // its record is not in the fixture clone: unjoined
    expect(s["series.json"].live_from).toBe("2026-11-09");
    expect(s["anthropic-cvd.json"].ledger_ids).toEqual([]);
    const m = Metrics.parse(JSON.parse(read(path.join(out, "metrics", "2026-11-08.json"))));
    expect(m.reconstructed).toBe(true);
    InputsManifest.parse(JSON.parse(read(path.join(out, "metrics", "inputs", "2026-11-08.json"))));
    expect(fs.readdirSync(path.join(out, "metrics")).sort()).toEqual(["2026-11-08.json", "inputs"]);
    expect(r.lines.find((l) => l.startsWith("Clone "))).toMatch(new RegExp(`^Clone ${r.sha.slice(0, 7)} \\(2026-11-07 17:28:47 UTC\\): \\d\\d:\\d\\d, \\d+\\.\\d GB on disk\\.$`));
    expect(r.lines.find((l) => l.startsWith("Read "))).toMatch(/^Read 50 records in \d\d:\d\d with 2 workers: 45 published, 5 rejected, \d+ credit strings\.$/);
    expect(r.lines).toContain(`KEV commit ${KEV_COMMIT} (the default catalog).`);
    expect(r.lines).toContain("KEV 2026.11.06 at eeeeeee: 4 entries; 3 of 4 from 2023-01-01 joined.");
    expect(r.lines.find((l) => l.startsWith("State to "))).toBe(`State to ${C}: 1406 days, 7 AI matches, 200 weeks; live_from 2026-11-09.`);
  }, SLOW);

  it("writes byte-identical state and metrics on a rerun, also into a folder holding another cutoff's state (R31)", async () => {
    const r = makeRoot();
    writeCache(r.root, "2026-11-06", "2026-11-04");
    expect(await runBackfill(opts(r, { cutoff: "2026-11-04", out: "out/c" }), r.deps)).toBe(0);
    writeCache(r.root, "2026-11-08", C);
    expect(await runBackfill(opts(r, { out: "out/a" }), r.deps)).toBe(0);
    expect(await runBackfill(opts(r, { out: "out/b" }), { ...r.deps, workers: 4 })).toBe(0);
    expect(await runBackfill(opts(r, { out: "out/c" }), r.deps)).toBe(0);
    const [a, b, c] = ["a", "b", "c"].map((x) => path.join(r.root, "out", x)) as [string, string, string];
    expect(stateTexts(b)).toEqual(stateTexts(a));
    expect(stateTexts(c)).toEqual(stateTexts(a));
    for (const f of ["metrics/2026-11-08.json", "metrics/inputs/2026-11-08.json"]) expect(read(path.join(b, f))).toBe(read(path.join(a, f)));
  }, SLOW);

  it("empties the default staging folder first, and skips E's metrics when content/ has them (R30)", async () => {
    const r = makeRoot();
    writeCache(r.root, "2026-11-08", C);
    const staged = path.join(r.root, DEFAULT_OUT);
    write(path.join(staged, "stray.txt"), "left from an earlier run");
    write(path.join(r.root, "content", "metrics", "2026-11-08.json"), "{}\n");
    expect(await runBackfill(opts(r), r.deps)).toBe(0);
    expect(fs.existsSync(path.join(staged, "stray.txt"))).toBe(false);
    expect(fs.existsSync(path.join(staged, "metrics"))).toBe(false);
    expect(r.lines).toContain("metrics/2026-11-08.json exists");
  }, SLOW);

  it("refuses without collect's cache for E, before cloning", async () => {
    const r = makeRoot();
    expect(await runBackfill(opts(r), r.deps)).toBe(1);
    expect(r.lines).toEqual(["No feeds for 2026-11-08 in cache/: run npm run collect -- --date 2026-11-08 first."]);
    expect(fs.existsSync(path.join(r.root, "cache", "cvelistV5"))).toBe(false);
  }, SLOW);

  it("refuses a commit made before the cutoff day ended (an incomplete day)", async () => {
    const r = makeRoot();
    writeCache(r.root, "2026-11-09", "2026-11-07");
    expect(await runBackfill(opts(r, { cutoff: "2026-11-07" }), r.deps)).toBe(1);
    expect(r.lines.at(-1)).toMatch(/was committed at 2026-11-07T17:28:47Z, before the cutoff day 2026-11-07 ended \(2026-11-08T00:00:00Z\)/);
    expect(fs.existsSync(path.join(r.root, DEFAULT_OUT))).toBe(false);
  }, SLOW);

  it("needs at least 10 GiB free: 9 GiB is refused before any clone, 11 GiB passes", async () => {
    const r = makeRoot();
    writeCache(r.root, "2026-11-08", C);
    expect(await runBackfill(opts(r), { ...r.deps, freeBytes: () => 9 * GiB })).toBe(1);
    expect(r.lines.at(-1)).toMatch(/^The clone needs at least 10 GiB free; 9\.0 GiB are free/);
    expect(fs.existsSync(path.join(r.root, "cache", "cvelistV5", ".git"))).toBe(false);
    expect(MIN_FREE_BYTES).toBe(10 * GiB);
    expect(await runBackfill(opts(r), { ...r.deps, freeBytes: () => 11 * GiB })).toBe(0);
  }, SLOW);
});

describe("--catch-up and --credits", () => {
  it("--catch-up counts only the days days.json lacks and extends the series; existing rows stay as they are", async () => {
    const r = makeRoot();
    writeCache(r.root, "2026-11-06", "2026-11-04");
    expect(await runBackfill(opts(r, { cutoff: "2026-11-04", out: "out/early" }), r.deps)).toBe(0);
    writeCache(r.root, "2026-11-08", C);
    expect(await runBackfill(opts(r, { out: "out/full" }), r.deps)).toBe(0);
    const content = path.join(r.root, "content");
    copyState(path.join(r.root, "out", "early"), content);
    const before = stateOf(content);
    const tampered = before["days.json"].days.map((d) => (d[0] === "2026-11-01" ? ([d[0], 999, d[2], d[3], d[4]] as typeof d) : d));
    write(path.join(content, "state", "days.json"), jsonText({ ...before["days.json"], days: tampered }, STATE_SCHEMAS["days.json"]));

    expect(await runBackfill(opts(r, { mode: "catch-up" }), r.deps)).toBe(0);
    const after = stateOf(path.join(r.root, DEFAULT_OUT));
    const full = stateOf(path.join(r.root, "out", "full"));
    const days = after["days.json"].days;
    expect(days.slice(0, tampered.length)).toEqual(tampered);
    expect(days.slice(tampered.length).map((d) => d[0])).toEqual(["2026-11-05", C]);
    expect(days.slice(tampered.length)).toEqual(full["days.json"].days.slice(-2));
    expect(after["ai-credits.json"].matches.map((m) => m[0])).toEqual(full["ai-credits.json"].matches.map((m) => m[0]));
    expect(after["ai-credits.json"].matches.find((m) => m[0] === "CVE-2026-100144")![8]).toBe(C);
    expect(after["ai-credits.json"].matches.find((m) => m[0] === "CVE-2026-93302")![8]).toBe("2026-11-04");
    expect(after["kev-index.json"]).toEqual(full["kev-index.json"]); // no brief yet: re-joined from the newest catalog
    expect(after["series.json"].weeks).toEqual(full["series.json"].weeks);
    expect(fs.existsSync(path.join(r.root, DEFAULT_OUT, "metrics"))).toBe(false);
    expect(r.lines.find((l) => l.startsWith("Catch-up to "))).toMatch(/^Catch-up to 2026-11-06: 2 days added \(2026-11-05 to 2026-11-06\)/);
  }, SLOW);

  it("--catch-up rematches the credits of a day it fills behind the newest counted day (round 1)", async () => {
    const r = makeRoot();
    writeCache(r.root, "2026-11-08", C);
    expect(await runBackfill(opts(r, { out: "out/full" }), r.deps)).toBe(0);
    const content = path.join(r.root, "content");
    copyState(path.join(r.root, "out", "full"), content);
    const full = stateOf(content);
    // A morning that missed a day missed the credits of the records published on it: take one AI-credited
    // record's day out of days.json and its rows out of both credit files, as such a morning leaves them.
    const hit = full["ai-credits.json"].matches.find((m) => m[7] === "pattern" && m[1] < C)!;
    const day = hit[1];
    const sameDay = new Set(full["ai-credits.json"].matches.filter((m) => m[1] === day).map((m) => m[0]));
    write(path.join(content, "state", "days.json"), jsonText({ ...full["days.json"], days: full["days.json"].days.filter((d) => d[0] !== day) }, STATE_SCHEMAS["days.json"]));
    write(path.join(content, "state", "ai-credits.json"), jsonText({ ...full["ai-credits.json"], matches: full["ai-credits.json"].matches.filter((m) => !sameDay.has(m[0])) }, STATE_SCHEMAS["ai-credits.json"]));
    write(path.join(content, "state", "credit-candidates.json"), jsonText({ ...full["credit-candidates.json"], candidates: full["credit-candidates.json"].candidates.filter((c) => c[1] !== day) }, STATE_SCHEMAS["credit-candidates.json"]));

    expect(await runBackfill(opts(r, { mode: "catch-up" }), r.deps)).toBe(0);
    const after = stateOf(path.join(r.root, DEFAULT_OUT));
    expect(after["days.json"].days).toEqual(full["days.json"].days);
    expect(after["credit-candidates.json"].candidates).toEqual(full["credit-candidates.json"].candidates);
    expect(after["ai-credits.json"].matches.map((m) => m.slice(0, 8))).toEqual(full["ai-credits.json"].matches.map((m) => m.slice(0, 8)));
    expect(after["ai-credits.json"].matches.find((m) => m[0] === hit[0])![8]).toBe(C);
    expect(after["series.json"].ai_weekly).toEqual(full["series.json"].ai_weekly);
    expect(r.lines.find((l) => l.startsWith("Catch-up to "))).toMatch(new RegExp(`^Catch-up to ${C}: 1 days added \\(${day}\\), \\d+ records to ${C} rematched`));
  }, SLOW);

  it("--catch-up rematches every record to the cutoff: a credit the mornings missed on a counted day comes back (round 1)", async () => {
    const r = makeRoot();
    writeCache(r.root, "2026-11-08", C);
    expect(await runBackfill(opts(r, { out: "out/full" }), r.deps)).toBe(0);
    const content = path.join(r.root, "content");
    copyState(path.join(r.root, "out", "full"), content);
    const full = stateOf(content);
    // Mornings in catch-up mode match no credits: a record published before the newest counted day that
    // gained its credit then has no rows, while its day stays counted.
    const hit = full["ai-credits.json"].matches.find((m) => m[7] === "pattern" && m[1] < C)!;
    write(path.join(content, "state", "ai-credits.json"), jsonText({ ...full["ai-credits.json"], matches: full["ai-credits.json"].matches.filter((m) => m[0] !== hit[0]) }, STATE_SCHEMAS["ai-credits.json"]));
    write(path.join(content, "state", "credit-candidates.json"), jsonText({ ...full["credit-candidates.json"], candidates: full["credit-candidates.json"].candidates.filter((c) => c[0] !== hit[0]) }, STATE_SCHEMAS["credit-candidates.json"]));

    expect(await runBackfill(opts(r, { mode: "catch-up" }), r.deps)).toBe(0);
    const after = stateOf(path.join(r.root, DEFAULT_OUT));
    expect(after["days.json"].days).toEqual(full["days.json"].days);
    expect(after["credit-candidates.json"].candidates).toEqual(full["credit-candidates.json"].candidates);
    expect(after["ai-credits.json"].matches.map((m) => m.slice(0, 8))).toEqual(full["ai-credits.json"].matches.map((m) => m.slice(0, 8)));
    expect(after["series.json"].ai_weekly).toEqual(full["series.json"].ai_weekly);
    expect(r.lines.find((l) => l.startsWith("Catch-up to "))).toMatch(new RegExp(`^Catch-up to ${C}: 0 days added \\(none\\), \\d+ records to ${C} rematched`));
  }, SLOW);

  it("--catch-up applies the dashboard ledger with the clone's publication dates, as the build and --credits do (B14)", async () => {
    const r = makeRoot();
    writeCache(r.root, "2026-11-06", "2026-11-04");
    expect(await runBackfill(opts(r, { cutoff: "2026-11-04", out: "out/early" }), r.deps)).toBe(0);
    const content = path.join(r.root, "content");
    copyState(path.join(r.root, "out", "early"), content);
    const early = stateOf(content);
    expect(early["ai-credits.json"].matches.filter((m) => m[7] === "cvd_ledger")).toEqual([]);
    // A later dashboard revision lists three records without AI credit text: one published on 27 October, in a
    // week the series already holds, and two on 4 and 6 November, in a week not yet complete.
    const cvd = { ...early["anthropic-cvd.json"], ledger_ids: ["CVE-2026-100164", "CVE-2026-62662", "CVE-2026-100080", "GHSA-7q8r-9v2w-c3f4"] };
    write(path.join(content, "state", "anthropic-cvd.json"), jsonText(cvd, STATE_SCHEMAS["anthropic-cvd.json"]));
    writeCache(r.root, "2026-11-08", C);
    expect(await runBackfill(opts(r, { mode: "catch-up" }), r.deps)).toBe(0);
    const after = stateOf(path.join(r.root, DEFAULT_OUT));
    const ledger = after["ai-credits.json"].matches.filter((m) => m[7] === "cvd_ledger").map((m) => [m[0], m[1], m[5], m[8]]);
    expect(ledger).toEqual(expect.arrayContaining([
      ["CVE-2026-100164", "2026-10-27", "cvd_ledger", C], ["CVE-2026-62662", "2026-11-04", "cvd_ledger", C], ["CVE-2026-100080", "2026-11-06", "cvd_ledger", C],
    ]));
    expect(ledger).toHaveLength(3);
    const s = after["series.json"];
    expect(s.weeks.at(-1)).toBe("2026-10-26");
    expect(s.ai_ledger_only_weekly.at(-1)).toBe(1);
    expect(s.ai_ledger_only_weekly.reduce((a, b) => a + b, 0)).toBe(1);
  }, SLOW);

  it("--catch-up without --commit uses the CVE List commit collect read for E, and says so (B16)", async () => {
    const r = makeRoot();
    writeCache(r.root, "2026-11-06", "2026-11-04");
    expect(await runBackfill(opts(r, { cutoff: "2026-11-04", out: "out/early" }), r.deps)).toBe(0);
    copyState(path.join(r.root, "out", "early"), path.join(r.root, "content"));
    // ls-remote answers nothing here (noGit), so only collect's cache can name the commit.
    writeCache(r.root, "2026-11-08", C, r.sha);
    r.lines.length = 0;
    expect(await runBackfill(opts(r, { mode: "catch-up", commit: null }), r.deps)).toBe(0);
    expect(r.lines).toContain(`CVE List commit ${r.sha} (collect's cache for 2026-11-08).`);
    // collect's cache for another edition date is not used.
    writeCache(r.root, "2026-11-07", "2026-11-05", r.sha);
    r.lines.length = 0;
    expect(await runBackfill(opts(r, { mode: "catch-up", commit: null }), r.deps)).toBe(1);
    expect(r.lines).toContain("git ls-remote could not read the tip of CVEProject/cvelistV5 main.");
  }, SLOW);

  it("--credits rebuilds both credit files and keeps each match's first_matched", async () => {
    const r = makeRoot();
    writeCache(r.root, "2026-11-08", C);
    expect(await runBackfill(opts(r, { out: "out/full" }), r.deps)).toBe(0);
    const content = path.join(r.root, "content");
    copyState(path.join(r.root, "out", "full"), content);
    const full = stateOf(content);
    const older = full["ai-credits.json"].matches.map((m) => (m[0] === "CVE-2025-27888" ? ([...m.slice(0, 8), "2025-03-21"] as typeof m) : m));
    write(path.join(content, "state", "ai-credits.json"), jsonText({ ...full["ai-credits.json"], matches: older }, STATE_SCHEMAS["ai-credits.json"]));
    write(path.join(content, "state", "credit-candidates.json"), jsonText({ ...full["credit-candidates.json"], candidates: [] }, STATE_SCHEMAS["credit-candidates.json"]));

    expect(await runBackfill(opts(r, { mode: "credits" }), r.deps)).toBe(0);
    const after = stateOf(path.join(r.root, DEFAULT_OUT));
    expect(after["ai-credits.json"].matches).toEqual(older);
    expect(after["credit-candidates.json"]).toEqual(full["credit-candidates.json"]);
    expect(after["days.json"]).toEqual(full["days.json"]);
    expect(after["series.json"]).toEqual(full["series.json"]);
  }, SLOW);

  it("--push keeps its guards: refused from 04:00 to 06:00 Taipei; otherwise the state is built and publishState() waits for P3 (R34)", async () => {
    const r = makeRoot();
    writeCache(r.root, "2026-11-08", C);
    expect(await runBackfill(opts(r, { out: "out/full" }), r.deps)).toBe(0);
    copyState(path.join(r.root, "out", "full"), path.join(r.root, "content"));
    write(path.join(r.root, ".gitignore"), "/cache/\n/logs/\n/src/\n/out/\n");
    sh(r.root, "add", "-A");
    sh(r.root, "commit", "-q", "--no-gpg-sign", "-m", "state");

    const early = new Date("2026-11-08T20:30:00Z"); // 04:30 Taipei on 2026-11-09
    expect(await runBackfill(opts(r, { mode: "catch-up", push: true }), { ...r.deps, now: () => early })).toBe(1);
    expect(r.lines.at(-1)).toMatch(/^--push is refused from 04:00 to 06:00 Taipei \(now 04:30\)/);

    expect(await runBackfill(opts(r, { mode: "catch-up", push: true }), r.deps)).toBe(1);
    expect(r.lines.at(-1)).toBe(PUBLISH_STATE_P3);
    expect(fs.existsSync(path.join(r.root, DEFAULT_OUT, "state", "days.json"))).toBe(true);
    expect(fs.existsSync(path.join(r.root, "logs", ".lock"))).toBe(false);

    write(path.join(r.root, "content", "state", "days.json"), "{}\n");
    expect(await runBackfill(opts(r, { mode: "catch-up", push: true }), r.deps)).toBe(1);
    expect(r.lines.at(-1)).toMatch(/^--push needs a clean checkout/);
  }, SLOW);
});

describe("--check-reference", () => {
  it("passes on the committed fixtures offline, and catches one altered count", async () => {
    const r = makeRoot({ reference: true });
    expect(await runBackfill(opts(r, { commit: null, checkReference: true }), r.deps)).toBe(0);
    expect(r.lines[0]).toBe("Figure · expected · fixtures · clone · ok");
    expect(r.lines.at(-1)).toMatch(/^Appendix D: all \d+ figures ok\.$/);
    expect(r.lines.filter((l) => l.endsWith("· not checked"))).toHaveLength(5);

    const file = path.join(r.root, "fixtures", "reference", "flood-days.json");
    const flood = JSON.parse(read(file)) as { days: [string, number, number, number][] };
    flood.days = flood.days.map((d) => (d[0] === "2024-06-03" ? [d[0], d[1] + 1, d[2], d[3]] : d));
    write(file, `${JSON.stringify(flood, null, 2)}\n`);
    r.lines.length = 0;
    expect(await runBackfill(opts(r, { commit: null, checkReference: true }), r.deps)).toBe(1);
    expect(r.lines.find((l) => l.startsWith("REFERENCE.flood "))).toMatch(/· n 68772 .*· DIFFERS$/);
    expect(r.lines.at(-1)).toMatch(/^Appendix D: \d+ of \d+ figures differ\.$/);
  });
});

describe("flags", () => {
  const today = "2026-11-09";
  async function usage(argv: string[]): Promise<number> {
    const r = { root: REPO, lines: [] as string[] };
    let o: BackfillOptions;
    try {
      o = parseBackfillArgs(argv, r.root, today);
    } catch {
      return 2;
    }
    return runBackfill(o, { git: noGit, fetchKev, freeBytes: () => 0, now: () => NOW, workers: 1, print: (l) => r.lines.push(l) });
  }

  it.each([
    [["--catch-up", "--credits"]],
    [["--push"]],
    [["--push", "--catch-up", "--out", "elsewhere"]],
    [["--fixtures", "--catch-up"]],
    [["--check-reference", "--credits"]],
    [["--fixtures", "--push", "--catch-up"]],
    [["--fixtures"]],
    [["--fixtures", "--commit", REFERENCE_INPUTS.cveListCommit, "--kev-commit", KEV_COMMIT, "--cutoff", "2026-11-05"]],
    [["--fixtures", "--commit", REFERENCE_INPUTS.cveListCommit, "--cutoff", "2026-11-06"]],
    [["--check-reference", "--commit", "67c39b1"]],
    [["--commit", "abc1234"]],
    [["--kev-commit", "e5b3a9b"]],
    [["--cutoff", "2022-12-31"]],
    [["--cutoff", "2026-11-08"]],
    [["--cutoff", "2026-02-30"]],
    [["--bogus"]],
    [["stray"]],
  ])("%j is a usage error (exit 2)", async (argv) => {
    expect(await usage(argv)).toBe(2);
  });

  it("expands 67c39b1 to the reference commit and defaults the cutoff to today's", () => {
    const o = parseBackfillArgs(["--commit", "67c39b1"], REPO, today);
    expect(o).toMatchObject({ commit: REFERENCE_INPUTS.cveListCommit, cutoff: "2026-11-07", mode: "build", out: DEFAULT_OUT });
  });

  it("--check-reference at the reference commit checks Appendix D's cutoff, and refuses any other before the clone (B15)", async () => {
    const at = ["--check-reference", "--commit", "67c39b1", "--kev-commit", KEV_COMMIT];
    expect(parseBackfillArgs(at, REPO, today).cutoff).toBe(REFERENCE_INPUTS.cutoff);
    expect(parseBackfillArgs([...at, "--fixtures"], REPO, today).cutoff).toBe(REFERENCE_INPUTS.cutoff);
    // Without the reference commit the check is offline, and the cutoff stays today's default.
    expect(parseBackfillArgs(["--check-reference"], REPO, today).cutoff).toBe("2026-11-07");
    expect(parseBackfillArgs([...at.slice(0, 1), "--cutoff", "2026-11-05"], REPO, today).cutoff).toBe("2026-11-05");

    const calls: string[] = [];
    const lines: string[] = [];
    const spyGit: GitSource = { ...noGit, lsRemote: async (repo, refs) => (calls.push(`ls-remote ${repo}`), noGit.lsRemote(repo, refs)) };
    const deps: Partial<BackfillDeps> = {
      git: spyGit, fetchKev: async (c) => (calls.push("fetchKev"), fetchKev(c)), freeBytes: (dir) => (calls.push(`freeBytes ${dir}`), 0),
      now: () => NOW, workers: 1, print: (l) => lines.push(l),
    };
    for (const cutoff of ["2026-11-05", "2026-11-07"]) {
      lines.length = 0;
      expect(await runBackfill(parseBackfillArgs([...at, "--cutoff", cutoff], REPO, today), deps)).toBe(2);
      expect(lines[0].split("\n")[0]).toBe(`--check-reference at ${REFERENCE_INPUTS.cveListCommit.slice(0, 7)} checks Appendix D's cutoff ${REFERENCE_INPUTS.cutoff}: ` +
        `leave out --cutoff or give --cutoff ${REFERENCE_INPUTS.cutoff}.`);
    }
    expect(calls).toEqual([]);
    // Appendix D's own cutoff passes the flag checks and goes on to the clone (refused here for want of disk space).
    lines.length = 0;
    expect(await runBackfill(parseBackfillArgs(at, REPO, today), deps)).toBe(1);
    expect(lines.at(-1)).toMatch(/^The clone needs at least 10 GiB free/);
  });

  it("the CLI prints the usage line on stderr and exits 2", () => {
    let code = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), path.join(REPO, "scripts", "backfill.ts"), "--catch-up", "--credits"], { cwd: REPO, encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      code = (e as { status: number }).status;
      stderr = String((e as { stderr: string }).stderr);
    }
    expect(code).toBe(2);
    expect(stderr).toMatch(/^Usage: npm run backfill -- /m);
  }, SLOW);
});
