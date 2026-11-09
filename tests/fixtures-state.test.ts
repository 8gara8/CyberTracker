// fixtures/state/ (SPEC §10 P2 item 2; ruling R51; fixtures plan §3.4 and §6.1): content/state/ as the
// edition before the 2026-10-14 fixture morning left it, built by fixtures/src/state.ts with the production
// builders. Then the P3 contract case: that state, collect() on fixtures/feeds/ at 04:37 Taipei and
// runMetrics() give the morning tests/daily.test.ts will check stage by stage. Offline: the feeds come from
// CT_FIXTURE_FEEDS and git runs only on a temporary repo.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { addDays, isoWeekStart, newestCompleteWeek } from "@/lib/dates";
import { parseKev } from "@/lib/feeds/kev";
import { compareCveIds } from "@/lib/ids";
import { jsonText, sha256Hex } from "@/lib/json";
import { aiFindersOf, prefilterSha256 } from "@/lib/metrics/ai-credit";
import { DAYS_FROM } from "@/lib/metrics/flood";
import { liveFromAfter } from "@/lib/metrics/series";
import { InputsManifest, Metrics, STATE_FILES, STATE_SCHEMAS, type StateFileName, type StateFiles } from "@/lib/schema/metrics";
import { CandidatesFile, CollectInputsFile, FeedIndexFile, Pack } from "@/lib/schema/pack";
import { ReferenceAiCreditsFile, ReferenceFloodDaysFile } from "@/lib/schema/reference";
import { validateAll } from "@/lib/validate";
import { FEED_WORLD, KEV_CATALOG_PATH, fixtureKevCatalog } from "@/fixtures/src/feeds";
import { STATE_DIR, STATE_WORLD, fixtureState, placeholderIdsSha256, stateOutputs, statePath } from "@/fixtures/src/state";
import { EDITIONS } from "@/fixtures/src/world";
import { collect } from "@/scripts/collect";
import { runMetrics } from "@/scripts/metrics";

const ROOT = path.join(__dirname, "..");
const FEEDS = path.join(ROOT, "fixtures", "feeds");
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
const readRef = (name: string) => readJson(path.join(ROOT, "fixtures", "reference", name));
const config = loadConfig({ root: ROOT });
/** D's two new KEV entries (world.ts lists them in code-unit order; KEV order puts 96951 first). */
const NEW_IDS = [...EDITIONS.weekday.kev.newIds].sort(compareCveIds);

describe("fixtures/state/", () => {
  it("holds exactly the six state files, each parsing with its schema and equal to what fixtureState() builds", () => {
    expect(fs.readdirSync(path.join(ROOT, STATE_DIR)).sort()).toEqual([...STATE_FILES].sort());
    const built = fixtureState();
    for (const name of STATE_FILES) {
      const text = fs.readFileSync(path.join(ROOT, statePath(name)), "utf8");
      const parsed = STATE_SCHEMAS[name].parse(JSON.parse(text));
      expect(jsonText(parsed, STATE_SCHEMAS[name]), name).toBe(text);
      expect(jsonText(built[name], STATE_SCHEMAS[name]), name).toBe(text);
    }
    expect(stateOutputs().map((o) => o.path)).toEqual(STATE_FILES.map(statePath));
  });

  it("passes validateAll() on a folder holding only state/", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-state-only-"));
    try {
      fs.cpSync(path.join(ROOT, STATE_DIR), path.join(tmp, "state"), { recursive: true });
      const r = validateAll(tmp, { config });
      expect([...r.errors, ...r.warnings]).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is dated the previous edition's cutoff, 2026-10-11", () => {
    expect(STATE_WORLD.cutoff).toBe(addDays(FEED_WORLD.cutoff, -1));
    const s = fixtureState();
    for (const name of STATE_FILES) expect(s[name].updated_at, name).toBe(STATE_WORLD.cutoff);
  });

  it("days.json runs from 2023-01-01 to 2026-10-11 with no gap: the reference counts, with placeholder id hashes", () => {
    const days = fixtureState()["days.json"].days;
    expect(days[0]![0]).toBe(DAYS_FROM);
    expect(days.at(-1)![0]).toBe(STATE_WORLD.cutoff);
    days.forEach((d, i) => {
      if (i > 0) expect(d[0], `after ${days[i - 1]![0]}`).toBe(addDays(days[i - 1]![0], 1));
      expect(d[4]).toBe(placeholderIdsSha256(d[0]));
    });
    const ref = ReferenceFloodDaysFile.parse(readRef("flood-days.json")).days.filter((d) => d[0] <= STATE_WORLD.cutoff);
    expect(days.map((d) => d.slice(0, 4))).toEqual(ref);
    expect(placeholderIdsSha256("2026-10-11")).toBe(sha256Hex("fixture 2026-10-11"));
  });

  it("kev-index.json is catalog 2026.10.08; the fixture catalog minus the index is exactly the morning's two new ids", () => {
    const index = fixtureState()["kev-index.json"];
    expect(index.catalog_version).toBe(STATE_WORLD.kevAsOf.version);
    expect(index.catalog_version).toBe(EDITIONS.weekday.kev.since);
    expect(index.entries.every((r) => r[1] <= STATE_WORLD.kevAsOf.lastDateAdded)).toBe(true);
    const served = parseKev(fs.readFileSync(path.join(ROOT, KEV_CATALOG_PATH))).catalog;
    expect(served).toEqual(parseKev(Buffer.from(jsonText(fixtureKevCatalog()))).catalog);
    const known = new Set(index.entries.map((r) => r[0]));
    expect(served.vulnerabilities.map((v) => v.cveID).filter((id) => !known.has(id)).sort(compareCveIds)).toEqual(NEW_IDS);
    expect(index.entries.some((r) => r[1] < "2024-01-01")).toBe(true);
  });

  it("leaves the re-join id unjoined, with its record in fixtures/feeds/cvelist/by-id/", () => {
    const rows = fixtureState()["kev-index.json"].entries;
    const unjoined = rows.filter((r) => r[4] === null).map((r) => r[0]);
    expect(unjoined).toEqual([STATE_WORLD.rejoinId]);
    expect(rows.find((r) => r[0] === STATE_WORLD.rejoinId)![5]).toBeNull();
    expect(fs.existsSync(path.join(FEEDS, "cvelist", "by-id", `${STATE_WORLD.rejoinId}.json`))).toBe(true);
  });

  it("series.json covers 2023-01-02 to the week of 2026-10-05, live from 2026-10-12", () => {
    const s = fixtureState()["series.json"];
    expect(s.weeks[0]).toBe("2023-01-02");
    expect(s.weeks.at(-1)).toBe(newestCompleteWeek(STATE_WORLD.cutoff));
    expect(s.weeks.at(-1)).toBe("2026-10-05");
    expect(s.live_from).toBe(liveFromAfter(STATE_WORLD.cutoff));
    expect(s.live_from).toBe(addDays(isoWeekStart(STATE_WORLD.cutoff), 7));
  });

  it("carries the committed finder list's version and hashes, so the morning sees no list change", () => {
    const s = fixtureState();
    const run = aiFindersOf(config, config.compiled);
    expect(s["ai-credits.json"]).toMatchObject({ finders_version: run.version, finders_sha256: run.sha256 });
    expect(run.sha256).toBe(sha256Hex(fs.readFileSync(path.join(ROOT, "config", "ai-finders.json"))));
    expect(s["credit-candidates.json"].prefilter_sha256).toBe(prefilterSha256(config.aiFinders.prefilter));
  });

  it("holds only matched tool names as credit text, and every reference match to the cutoff except the lab_context ones", () => {
    const s = fixtureState();
    const ref = ReferenceAiCreditsFile.parse(readRef("ai-credits.json")).matches.filter((m) => m[1] <= STATE_WORLD.cutoff);
    const toolNames = new Set(ref.map((m) => m[6]));
    for (const c of s["credit-candidates.json"].candidates) expect(toolNames.has(c[3]), c[3]).toBe(true);
    expect(s["credit-candidates.json"].candidates.map((c) => c[0]).sort()).toEqual(ref.map((m) => m[0]).sort());
    const expected = ref.filter((m) => m[4] !== "lab_context").map((m) => m[0]).sort();
    expect(s["ai-credits.json"].matches.map((m) => m[0]).sort()).toEqual(expected);
    expect(s["ai-credits.json"].matches.every((m) => m[8] === STATE_WORLD.cutoff && m[7] !== "cvd_ledger")).toBe(true);
  });

  it("starts the anthropic-cvd file empty, so the morning reads the fixture dashboard as a new revision", () => {
    expect(fixtureState()["anthropic-cvd.json"]).toEqual({
      schema_version: 1, updated_at: STATE_WORLD.cutoff, revision: null, as_of: null, fetched_at: null, source_url: null,
      found_n: null, disclosed_n: null, patched_n: null, ledger_ids: [],
    });
  });

  it("hands out deep copies", () => {
    const a = fixtureState();
    a["days.json"].days.pop();
    a["kev-index.json"].entries[0]![4] = null;
    const b = fixtureState();
    expect(b["days.json"].days.at(-1)![0]).toBe(STATE_WORLD.cutoff);
    expect(b["kev-index.json"].entries[0]![4]).not.toBeNull();
  });
});

// ── The P3 contract case ─────────────────────────────────────────────────────────────────────────

describe("the fixture morning: fixtures/state/, then collect() and runMetrics() for 2026-10-14", () => {
  const D = FEED_WORLD.date;
  const C = FEED_WORLD.cutoff;
  /** The run starts at 04:37 Taipei (20:37 UTC the day before). */
  const START = Date.parse(`${D}T04:37:00+08:00`);
  const saved: Record<string, string | undefined> = {};
  let root = "";
  let out = "";
  let lines: string[] = [];
  let code = -1;

  const sh = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=ct-test", "-c", "user.email=ct-test@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

  beforeAll(async () => {
    for (const k of ["CT_FIXTURE_FEEDS", "CT_CONTENT_DIR"]) saved[k] = process.env[k];
    delete process.env.CT_CONTENT_DIR;
    process.env.CT_FIXTURE_FEEDS = FEEDS;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-morning-"));
    fs.cpSync(path.join(ROOT, "config"), path.join(root, "config"), { recursive: true });
    fs.cpSync(path.join(ROOT, STATE_DIR), path.join(root, "content", "state"), { recursive: true });
    fs.writeFileSync(path.join(root, ".gitignore"), "/cache/\n/packs/\n/logs/\n/out/\n");
    sh(root, "init", "-q", "-b", "main");
    sh(root, "add", "-A");
    sh(root, "commit", "-q", "-m", "fixture state", "--date", "2026-10-13T12:00:00Z");

    let clock = START;
    await collect({ date: D, deadline: START + 300_000, root, deps: { now: () => clock } });
    clock += 4 * 60_000;
    out = path.join(root, "out");
    const r = await runMetrics({ date: D, root, out, now: new Date(clock) });
    lines = r.lines;
    code = r.code;
  }, 120_000);

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const metrics = () => Metrics.parse(readJson(path.join(out, "metrics", `${D}.json`)));
  const state = <N extends StateFileName>(name: N): StateFiles[N] => STATE_SCHEMAS[name].parse(readJson(path.join(out, "state", name))) as StateFiles[N];

  it("collect writes its pack, candidates, feed index and inputs for D, all parsing", () => {
    Pack.parse(readJson(path.join(root, "packs", `${D}.json`)));
    CandidatesFile.parse(readJson(path.join(root, "packs", `${D}.candidates.json`)));
    const index = FeedIndexFile.parse(readJson(path.join(root, "cache", "feeds", "index.json")));
    const inputs = CollectInputsFile.parse(readJson(path.join(root, "cache", "feeds", "inputs.json")));
    expect(index.date).toBe(D);
    expect(inputs).toMatchObject({ date: D, data_cutoff_utc: C, run_utc_day: FEED_WORLD.runUtcDay });
    expect(inputs.cvelist.zips.map((z) => z.tag)).toEqual([FEED_WORLD.eodTag, FEED_WORLD.hourlyTag]);
    expect(inputs.kev?.catalog_version).toBe(FEED_WORLD.kev.version);
    expect(fs.existsSync(path.join(root, "content", "metrics"))).toBe(false);
  });

  it("runMetrics exits 0 with the window, flood, AI-credited, KEV and home-vendor blocks ok", () => {
    expect(code, lines.join("\n")).toBe(0);
    const m = metrics();
    expect(m).toMatchObject({ date: D, data_cutoff_utc: C, reconstructed: false, code_commit: sh(root, "rev-parse", "HEAD") });
    for (const block of ["window", "flood", "ai_credited", "kev", "home_vendors"] as const) expect(m.blocks[block].status, block).toBe("ok");
    expect(lines[0]).toMatch(new RegExp(`^Metrics ${D}: data to ${C} UTC · ok: window, flood, ai_credited, `));
    InputsManifest.parse(readJson(path.join(out, "metrics", "inputs", `${D}.json`)));
  });

  it("finds exactly the two new KEV entries since catalog 2026.10.08", () => {
    expect(metrics().kev?.new_since_last_edition).toEqual({ since_catalog_version: STATE_WORLD.kevAsOf.version, cve_ids: NEW_IDS });
    const index = state("kev-index.json");
    expect(index.catalog_version).toBe(FEED_WORLD.kev.version);
    expect(index.entries.length).toBe(fixtureState()["kev-index.json"].entries.length + NEW_IDS.length);
  });

  it("days.json gains exactly UTC day 2026-10-12, and leaves the earlier days alone", () => {
    const before = fixtureState()["days.json"].days;
    const after = state("days.json").days;
    expect(after.slice(0, -1)).toEqual(before);
    expect(after.at(-1)![0]).toBe(C);
    expect(after.at(-1)![1]).toBeGreaterThan(0);
  });

  it("re-joins the unjoined KEV row from its by-id record", () => {
    const row = state("kev-index.json").entries.find((r) => r[0] === STATE_WORLD.rejoinId)!;
    expect(row[4]).not.toBeNull();
    expect(row[5]).not.toBeNull();
  });

  it("passes validateAll() over the fixture state with the staged metrics, manifest and state laid over it", () => {
    const content = path.join(root, "content");
    fs.cpSync(out, content, { recursive: true });
    const r = validateAll(content, { config });
    expect([...r.errors, ...r.warnings]).toEqual([]);
  });
});
