// lib/metrics/index.ts computeMetrics() (SPEC §5.10; rulings R5, R13, R16 to R21, R28), on synthetic
// StateFiles and MetricsFeeds built in memory with the production builders. Ids are synthetic, credit
// strings name no person ("SAMPLE Researcher"), and the only URLs are on example.com.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { addDays, dataCutoffFor } from "@/lib/dates";
import type { CveFacts, CvdDashboard, EpssDay, GhsaAdvisory, KevCatalog, KevEntry } from "@/lib/feeds/types";
import { jsonText, sha256Hex } from "@/lib/json";
import { aiFindersOf, AI_NOTES, buildCredits, prefilterSha256, type CreditRecord } from "@/lib/metrics/ai-credit";
import { WINDOW_UNAVAILABLE } from "@/lib/metrics/headline";
import { CATCH_UP_DAYS, computeMetrics, type MetricsInputs } from "@/lib/metrics/index";
import { buildKevIndex, indexEntries, indexFacts } from "@/lib/metrics/kev-index";
import { BLOCK_NOTES, NOTE_MAX } from "@/lib/metrics/notes";
import { dayMap } from "@/lib/metrics/flood";
import { liveFromAfter, weeklySeries } from "@/lib/metrics/series";
import { joinKev, type JoinFacts } from "@/lib/metrics/window";
import {
  AnthropicCvdFile, InputsManifest, Metrics, STATE_FILES, STATE_SCHEMAS,
  type DayRow, type Metrics as MetricsT, type StateFiles,
} from "@/lib/schema/metrics";
import type { CollectInputsFile } from "@/lib/schema/pack";
import { manifestIssues } from "@/lib/validate";
import type { FeedRead, MetricsFeeds } from "@/scripts/lib/feed-cache";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = loadConfig({ root, fresh: true });
const run = aiFindersOf(config, config.compiled);
const SHA40 = (c: string) => c.repeat(40);
const sha = (s: string) => sha256Hex(s);

// ── The synthetic world for an edition date D (cutoff C = D − 2; the state was written at C − 1) ──

const LAGS = [0, 1, -3, 4, 9, 20, 45, 120, 400, 2] as const;

function kevEntry(cveID: string, dateAdded: string, vendorProject = "Example"): KevEntry {
  return {
    cveID, vendorProject, product: "Example Product", vulnerabilityName: "Example flaw", dateAdded, shortDescription: "SAMPLE description.",
    requiredAction: "Apply updates.", dueDate: addDays(dateAdded, 21), knownRansomwareCampaignUse: "Unknown", forensicTriage: null, notes: "", cwes: [],
  };
}
const catalogOf = (version: string, released: string, entries: KevEntry[]): KevCatalog =>
  ({ catalogVersion: version, dateReleased: released, count: entries.length, vulnerabilities: entries });
const facts = (cve_id: string, date_published: string | null, o: Partial<CveFacts> = {}): CveFacts =>
  ({ cve_id, state: "PUBLISHED", date_published, assigner: "example", scored: true, credits: [], affected: [], ...o });
const read = (id: string, o: Partial<FeedRead> = {}): FeedRead =>
  ({ id, status: "ok", as_of: "2026-11-07T20:00:00Z", version: `v-${id}`, sha256: sha(id), records: 1, fetched_at: "2026-11-07T20:40:00Z", ...o });
const versionOf = (c: string) => `${c.slice(0, 4)}.${c.slice(5, 7)}.${c.slice(8)}`;

interface World { inputs: MetricsInputs; cutoff: string; newIds: string[]; rejoinId: string; zipDay: CveFacts[] }

/** Options: drop KEV, fail day C, push the state's newest day back, store an older list version, or build frozen state at C. */
interface WorldOptions { kevFailed?: boolean; dayFailed?: boolean; daysBack?: number; staleList?: boolean; frozen?: boolean; previous?: MetricsT | null; prefilter?: boolean }

function world(date: string, o: WorldOptions = {}): World {
  const C = dataCutoffFor(date);
  const S = o.frozen ? C : addDays(C, -1);
  const lastDay = o.daysBack ? addDays(C, -o.daysBack) : S;

  // KEV: one entry every three days from 2023-01-02, lags cycling through every band; every seventh is ASUS (TW).
  const old: KevEntry[] = [];
  const known = new Map<string, JoinFacts>();
  let i = 0;
  for (let d = "2023-01-02"; d <= addDays(C, -2); d = addDays(d, 3), i++) {
    const id = `CVE-${d.slice(0, 4)}-${10000 + i}`;
    old.push(kevEntry(id, d, i % 7 === 0 ? "ASUS" : "Example"));
    known.set(id, { state: "PUBLISHED", date_published: addDays(d, -LAGS[i % LAGS.length]!), assigner: "example" });
  }
  const rejoinId = "CVE-2026-90003";
  old.push(kevEntry(rejoinId, addDays(C, -7)));
  const newIds = ["CVE-2026-90001", "CVE-2026-90002"];
  const fresh = [kevEntry(newIds[0]!, addDays(C, -1), "ASUS"), kevEntry(newIds[1]!, C)];
  const today = catalogOf(versionOf(C), `${C}T17:00:00Z`, [...old, ...fresh]);
  const before = catalogOf(versionOf(addDays(C, -2)), `${addDays(C, -2)}T17:00:00Z`, old);
  const byId = new Map<string, CveFacts | null>([
    [newIds[0]!, facts(newIds[0]!, addDays(C, -1))],
    [newIds[1]!, facts(newIds[1]!, addDays(C, -2))],
    [rejoinId, facts(rejoinId, addDays(C, -3))],
    ["CVE-2026-90004", null],
  ]);
  const index = o.frozen
    ? buildKevIndex(today, new Map([...known, ...[...byId].filter(([, f]) => f).map(([id, f]) => [id, f!] as const)]), S)
    : buildKevIndex(before, known, S);

  // Days: synthetic counts from 2023-01-01 to the state's newest day.
  const days: DayRow[] = [];
  for (let d = "2023-01-01"; d <= lastDay; d = addDays(d, 1)) days.push([d, 100 + (Number(d.slice(8)) % 7), 10, 5, sha(`synthetic ${d}`)]);

  // Credits: AI-credited records every five days from 2025-06-01, plus five KEV ids from 2025 (in_kev).
  const credit = (n: number) => ["SAMPLE Researcher using Claude (Anthropic)", "Big Sleep", "SAMPLE Researcher with Codex Security", "AISLE Research"][n % 4]!;
  const aiRecords: CreditRecord[] = [];
  let k = 0;
  for (let d = "2025-06-01"; d <= S; d = addDays(d, 5), k++) aiRecords.push({ cve_id: `CVE-2025-${70000 + k}`, state: "PUBLISHED", date_published: d, credits: [{ field: "cna.credits", value: credit(k) }] });
  for (const e of old.filter((x) => x.dateAdded >= "2025-02-01").slice(0, 5)) {
    aiRecords.push({ cve_id: e.cveID, state: "PUBLISHED", date_published: known.get(e.cveID)!.date_published, credits: [{ field: "adp.credits", value: "Big Sleep" }] });
  }
  const creditState = buildCredits({ records: aiRecords, ghsa: [] }, run, S);
  if (o.staleList) creditState.credits = { ...creditState.credits, finders_version: run.version - 1 };
  if (o.prefilter) creditState.candidates = { ...creditState.candidates, prefilter_sha256: prefilterSha256("an older prefilter") };

  const cvdEmpty = AnthropicCvdFile.parse({ schema_version: 1, updated_at: S, revision: null, as_of: null, fetched_at: null, source_url: null, found_n: null, disclosed_n: null, patched_n: null, ledger_ids: [] });
  const dashboard: CvdDashboard = { revision: "41", as_of: addDays(C, -1), found_n: 6009, disclosed_n: 5087, patched_n: 629, ledger_ids: ["CVE-2026-91005", "GHSA-2222-3333-4444"] };
  byId.set("CVE-2026-91005", facts("CVE-2026-91005", addDays(C, -20)));

  const series = weeklySeries({ days: dayMap(days), rows: joinKev(indexEntries(index), indexFacts(index)), credits: creditState.credits, dataOnlyDates: [] }, S, liveFromAfter(S));
  const state: StateFiles = {
    "kev-index.json": index, "days.json": { schema_version: 1, updated_at: S, days },
    "ai-credits.json": creditState.credits, "credit-candidates.json": creditState.candidates,
    "anthropic-cvd.json": cvdEmpty, "series.json": series,
  };

  // Day C's zip records: kernel, an AI credit, a rejected record, and one published after the cutoff.
  const zipDay = [
    facts("CVE-2026-91001", C, { assigner: "Linux" }),
    facts("CVE-2026-91002", C, { scored: false, credits: [{ field: "cna.credits", value: "SAMPLE Researcher using Claude (Anthropic)" }] }),
    facts("CVE-2026-91003", C, { state: "REJECTED" }),
    facts("CVE-2026-91004", addDays(C, 1), { credits: [{ field: "cna.credits", value: "Big Sleep" }] }),
  ];
  const ghsa: GhsaAdvisory[] = [];
  for (let n = 0; n < 40; n++) {
    const published = addDays(C, -40 - n * 2);
    ghsa.push({
      id: `GHSA-2222-${String(3000 + n)}-4444`, aliases: [], cve_ids: [], published_at: `${published}T12:00:00Z`, published, modified: `${published}T12:00:00Z`,
      withdrawn: null, severity: "HIGH", reviewed: true, fixed: n % 5 !== 0, summary: null, packages: [{ ecosystem: "npm", name: "example" }],
    });
  }
  const epssDay = (score_date: string, bump: number): EpssDay => ({
    model_version: "v2025.03.14", score_date,
    scores: new Map(Array.from({ length: 8 }, (_, n) => [`CVE-2026-${80000 + n}`, { epss: Math.min(0.99, 0.1 + n * 0.05 + bump * n * 0.01), percentile: 0.9 }])),
  });
  const runDay = addDays(C, 1);
  const inputs: CollectInputsFile = {
    schema_version: 1, date, data_cutoff_utc: C, generated_at: `${runDay}T20:40:00Z`, run_utc_day: runDay,
    record_window: { start: `${C}T20:00:00Z`, end: `${runDay}T20:00:00Z` },
    commits: { cvelist: SHA40("a"), kev_data: SHA40("b"), ghsa: SHA40("c") },
    cvelist: {
      zips: [
        { tag: `cve_${C}_at_end_of_day`, asset: `${C}_delta_CVEs_at_end_of_day.zip`, kind: "end_of_day", utc_day: C, sha256: sha("zip1"), records: 4 },
        { tag: `cve_${runDay}_2000Z`, asset: `${runDay}_delta_CVEs_at_2000Z.zip`, kind: "hourly", utc_day: runDay, sha256: sha("zip2"), records: 1 },
      ],
      days: [{ date: C, zips: [`${C}_delta_CVEs_at_end_of_day.zip`, `${runDay}_delta_CVEs_at_2000Z.zip`], ok: !o.dayFailed }],
      newest_hourly_tag: `cve_${runDay}_2000Z`, delta_log_newest: `${runDay}T20:00:00Z`,
      by_id: { fetched: [...byId.keys()].filter((id) => byId.get(id)), not_found: ["CVE-2026-90004"], over_cap: 0 },
    },
    kev: o.kevFailed ? null : { catalog_version: today.catalogVersion, date_released: today.dateReleased, count: today.count, url_used: "https://example.com/ct-sample/kev", sha256: sha("kev"), fallback_used: false },
    epss: { source: "csv", model_version: "v2025.03.14", files: [{ role: "e", date: runDay, sha256: sha("e") }, { role: "e7", date: addDays(runDay, -7), sha256: sha("e7") }] },
    ghsa: { commit: SHA40("c"), head_date: runDay, months: [], tree_sha256: sha("tree"), advisories: ghsa.length },
    anthropic_cvd: { revision: "41", as_of: addDays(C, -1), sha256: sha("cvd"), fetched_at: `${runDay}T20:41:00Z`, changed: true },
  };
  const feeds: MetricsFeeds = {
    inputs,
    index: { schema_version: 1, date, generated_at: inputs.generated_at, feeds: [] },
    kev: o.kevFailed ? { read: read("kev", { status: "failed", sha256: null, as_of: null, version: null, records: 0 }), catalog: null } : { read: read("kev"), catalog: today },
    cvelist: { read: read("cvelist"), days: [{ date: C, ok: !o.dayFailed, records: o.dayFailed ? [] : zipDay }], zipRecords: o.dayFailed ? [] : zipDay, byId },
    epss: { read: read("epss"), e: epssDay(runDay, 1), e1: null, e7: epssDay(addDays(runDay, -7), 0) },
    ghsa: { read: read("ghsa"), advisories: ghsa, headDate: runDay },
    anthropicCvd: { read: read("anthropic-cvd", { fetched_at: `${runDay}T20:41:00Z` }), dashboard, sourceUrl: "https://example.com/ct-sample/cvd-dashboard" },
  };
  return {
    cutoff: C, newIds, rejoinId, zipDay,
    inputs: {
      date, generatedAt: `${runDay}T20:45:00Z`, codeCommit: SHA40("d"), reconstructed: false, frozenState: !!o.frozen, config, compiled: config.compiled,
      state, feeds, history: { previous: o.previous ?? null, kevBaseline: index, dataOnlyDates: [] },
    },
  };
}

const D = "2026-11-08";
const parsed = (r: ReturnType<typeof computeMetrics>) => ({ metrics: Metrics.parse(r.metrics), manifest: InputsManifest.parse(r.manifest) });
const statuses = (m: MetricsT) => Object.fromEntries(Object.entries(m.blocks).map(([k, b]) => [k, b.status]));

describe("computeMetrics: every block ok", () => {
  const w = world(D);
  const r = computeMetrics(w.inputs);

  it("parses, passes manifestIssues() and hashes the manifest into the provenance", () => {
    const { metrics, manifest } = parsed(r);
    expect(manifestIssues(metrics, manifest)).toEqual([]);
    expect(metrics.provenance.inputs_sha256).toBe(sha256Hex(jsonText(manifest, InputsManifest)));
    expect(metrics.provenance.inputs_file).toBe(`metrics/inputs/${D}.json`);
    expect(metrics).toMatchObject({ date: D, data_cutoff_utc: w.cutoff, generated_at: w.inputs.generatedAt, code_commit: SHA40("d"), reconstructed: false });
  });

  it("sets every block ok with as_of the cutoff, and the first line says so", () => {
    expect(statuses(r.metrics)).toEqual({ flood: "ok", window: "ok", ai_credited: "ok", fix_side: "ok", kev: "ok", home_vendors: "ok" });
    for (const b of Object.values(r.metrics.blocks)) expect(b.as_of).toBe(w.cutoff);
    expect(r.firstLine).toBe(`Metrics ${D}: data to ${w.cutoff} UTC · ok: window, flood, ai_credited, fix_side, kev, home_vendors, epss · stale: none · failed: none.`);
    expect(r.catchUpLine).toBeNull();
  });

  it("counts day C once from its zip records and lists its ids in new_days", () => {
    const days = r.state["days.json"]!;
    expect(days.updated_at).toBe(w.cutoff);
    expect(days.days.at(-1)).toEqual([w.cutoff, 2, 1, 1, sha256Hex(["CVE-2026-91001", "CVE-2026-91002"].join("\n"))]);
    expect(days.days.length).toBe(w.inputs.state["days.json"].days.length + 1);
    expect(r.manifest.flood.new_days).toEqual([{ date: w.cutoff, ids: ["CVE-2026-91001", "CVE-2026-91002"] }]);
  });

  it("adds the new KEV entries, re-joins the row whose record appeared, and lists the new ids", () => {
    const idx = r.state["kev-index.json"]!;
    expect(idx.catalog_version).toBe(versionOf(w.cutoff));
    const row = idx.entries.find((e) => e[0] === w.rejoinId)!;
    expect(row[4]).toBe(addDays(w.cutoff, -3));
    expect(r.metrics.kev?.new_since_last_edition).toEqual({ since_catalog_version: versionOf(addDays(w.cutoff, -2)), cve_ids: w.newIds });
    expect(r.manifest.kev_new).toEqual(w.newIds);
    const rejoined = r.manifest.window.w26.find((x) => x.cve_id === w.rejoinId)!;
    expect(rejoined).toMatchObject({ lag_days: -4, band: "at_disclosure" });
    expect(r.log).toContain(`Re-joined: ${w.rejoinId}.`);
  });

  it("updates credits from the zips (the after-cutoff record stays out) and applies the ledger", () => {
    const matches = r.state["ai-credits.json"]!.matches;
    const ai = matches.find((m) => m[0] === "CVE-2026-91002")!;
    expect([ai[3], ai[7], ai[8]]).toEqual(["anthropic", "pattern", w.cutoff]);
    expect(matches.some((m) => m[0] === "CVE-2026-91004")).toBe(false);
    const ledger = matches.find((m) => m[0] === "CVE-2026-91005")!;
    expect([ledger[1], ledger[5], ledger[7]]).toEqual([addDays(w.cutoff, -20), "cvd_ledger", "cvd_ledger"]);
    expect(r.state["anthropic-cvd.json"]).toMatchObject({ revision: "41", source_url: "https://example.com/ct-sample/cvd-dashboard" });
    expect(r.metrics.ai_credited!.w13.ledger_only_anthropic).toBe(1);
    expect(r.metrics.ai_credited!.in_kev.n).toBeGreaterThan(0);
    expect(r.metrics.base_rate).not.toBeNull();
  });

  it("fills window, flood, home vendors, fix side, EPSS movers and the 104-week series", () => {
    const m = r.metrics;
    expect(m.window!.w26.cohort_n).toBeGreaterThanOrEqual(30);
    expect(m.headline.at_disclosure_direction).not.toBe("n_too_small");
    expect(m.flood!.to).toBe(w.cutoff);
    expect(m.home_vendors!.tw.d90_n).toBeGreaterThan(0);
    expect(m.home_vendors!.tw.cve_ids_90.some((x) => x.cve_id === w.newIds[0])).toBe(true);
    expect(m.fix_side.anthropic_cvd).toMatchObject({ revision: "41", status: "ok" });
    expect(m.fix_side.ghsa_unfixed).toMatchObject({ n_total: 40, n_unfixed: 8 });
    expect(m.epss_movers.length).toBe(5);
    expect(m.series.weeks.length).toBe(104);
    expect(m.series.weeks.at(-1)).toBe("2026-10-26");
    expect(m.provenance).toMatchObject({ kev_catalog_version: versionOf(w.cutoff), cve_list_release: "cve_2026-11-07_2000Z", cve_list_commit: SHA40("a"), kev_data_commit: SHA40("b"),
      epss_model_version: "v2025.03.14", epss_date: "2026-11-07", ghsa_source: "git", ghsa_commit: SHA40("c") });
  });

  it("writes the 40-zero placeholder, not the fallback's null, for a mirror read whose commit ls-remote missed (B11)", () => {
    const v = world(D);
    v.inputs.feeds.inputs = { ...v.inputs.feeds.inputs, commits: { ...v.inputs.feeds.inputs.commits, kev_data: null } };
    const p = computeMetrics(v.inputs);
    expect(p.metrics.provenance.kev_data_commit).toBe("0".repeat(40));
    expect(p.log).toContain("Provenance: kev_data_commit is unknown today and in every earlier file; written as a placeholder.");
    v.inputs.feeds.inputs = { ...v.inputs.feeds.inputs, kev: { ...v.inputs.feeds.inputs.kev!, fallback_used: true } };
    expect(computeMetrics(v.inputs).metrics.provenance.kev_data_commit).toBeNull();
  });

  it("lists the metrics feeds read, sorted by id", () => {
    expect(r.manifest.feeds.map((f) => f.id)).toEqual(["anthropic-cvd", "cvelist", "epss", "ghsa", "kev"]);
  });

  it("returns only the state files whose text changed", () => {
    for (const name of STATE_FILES) {
      const next = r.state[name];
      if (next) expect(jsonText(next, STATE_SCHEMAS[name])).not.toBe(jsonText(w.inputs.state[name], STATE_SCHEMAS[name]));
    }
    expect(Object.keys(r.state).sort()).toEqual(["ai-credits.json", "anthropic-cvd.json", "credit-candidates.json", "days.json", "kev-index.json", "series.json"]);
  });

  it("keeps every block note within 200 characters", () => {
    for (const n of [BLOCK_NOTES.kevNotRead, BLOCK_NOTES.daysMissing(25, "2026-10-12"), BLOCK_NOTES.catchUp("2026-10-11"), AI_NOTES.recomputed(12), AI_NOTES.prefilterChanged]) {
      expect(n.length).toBeLessThanOrEqual(NOTE_MAX);
    }
  });
});

describe("computeMetrics: KEV not read", () => {
  const previous = computeMetrics(world("2026-11-07").inputs).metrics;

  it("carries the previous Window, KEV and home vendors as stale, with no new ids and the directions kept", () => {
    const w = world(D, { kevFailed: true, previous });
    const r = computeMetrics(w.inputs);
    const { metrics, manifest } = parsed(r);
    expect(statuses(metrics)).toMatchObject({ window: "stale", kev: "stale", home_vendors: "stale", flood: "ok" });
    expect(metrics.blocks.window).toEqual({ status: "stale", as_of: previous.data_cutoff_utc, note: BLOCK_NOTES.kevNotRead });
    expect(metrics.window).toEqual(previous.window);
    expect(metrics.headline.at_disclosure_direction).toBe(previous.headline.at_disclosure_direction);
    expect(metrics.headline.after_disclosure_direction).toBe(previous.headline.after_disclosure_direction);
    expect(metrics.headline.text.endsWith("(Data to 5 Nov UTC; CISA's list was not read today.)")).toBe(true);
    expect(metrics.kev).toEqual({ ...previous.kev!, new_since_last_edition: { ...previous.kev!.new_since_last_edition, cve_ids: [] } });
    expect(manifest.kev_new).toEqual([]);
    expect(manifest.window.w26).toEqual([]);
    expect(r.state["kev-index.json"]).toBeUndefined();
    expect(manifestIssues(metrics, manifest)).toEqual([]);
    expect(r.firstLine).toContain(`stale: window (as of ${previous.data_cutoff_utc}), kev (as of ${previous.data_cutoff_utc}), home_vendors (as of ${previous.data_cutoff_utc})`);
  });

  it("fails them with no earlier file: nulls, the unavailable headline, n_too_small", () => {
    const w = world(D, { kevFailed: true });
    const r = computeMetrics(w.inputs);
    const { metrics } = parsed(r);
    expect(statuses(metrics)).toMatchObject({ window: "failed", kev: "failed", home_vendors: "failed" });
    expect([metrics.window, metrics.kev, metrics.home_vendors]).toEqual([null, null, null]);
    expect(metrics.headline.text).toBe(WINDOW_UNAVAILABLE);
    expect(metrics.headline).toMatchObject({ at_disclosure_direction: "n_too_small", after_disclosure_direction: "n_too_small" });
    expect(r.firstLine).toContain("failed: window, kev, home_vendors.");
    expect(metrics.provenance.kev_catalog_version).toBe(w.inputs.state["kev-index.json"].catalog_version);
  });
});

describe("computeMetrics: a KEV catalog older than kev-index.json (B4)", () => {
  const previous = computeMetrics(world("2026-11-07").inputs).metrics;
  const older = (w: World) => {
    const idx = w.inputs.state["kev-index.json"];
    // One day before the index's catalog: the mirror answered behind what the index already holds.
    const version = versionOf(addDays(`${idx.catalog_version.replaceAll(".", "-")}`, -1));
    w.inputs.feeds.kev.catalog = { ...w.inputs.feeds.kev.catalog!, catalogVersion: version };
    return { version, indexVersion: idx.catalog_version };
  };

  it("never moves the index back: Window, KEV and home vendors carry as stale with today's reason", () => {
    const w = world(D, { previous });
    const v = older(w);
    const r = computeMetrics(w.inputs);
    const { metrics, manifest } = parsed(r);
    expect(r.state["kev-index.json"]).toBeUndefined();
    const note = BLOCK_NOTES.kevOlder(v.version, v.indexVersion);
    expect(note.length).toBeLessThanOrEqual(NOTE_MAX);
    for (const k of ["window", "kev", "home_vendors"] as const) expect(metrics.blocks[k]).toEqual({ status: "stale", as_of: previous.data_cutoff_utc, note });
    expect(metrics.kev!.new_since_last_edition.cve_ids).toEqual([]);
    expect(manifest.kev_new).toEqual([]);
    expect(metrics.provenance.kev_catalog_version).toBe(previous.provenance.kev_catalog_version);
    expect(r.log).toContain(`KEV catalog ${v.version} is older than kev-index ${v.indexVersion}: the index is not moved back.`);
    expect(manifestIssues(metrics, manifest)).toEqual([]);
  });

  it("does the same inside a build (frozenState) instead of refusing", () => {
    const w = world(D, { frozen: true });
    const v = older(w);
    const r = computeMetrics(w.inputs);
    expect(r.state).toEqual({});
    expect(statuses(r.metrics)).toMatchObject({ window: "failed", kev: "failed", home_vendors: "failed" });
    expect(r.metrics.blocks.kev.note).toBe(BLOCK_NOTES.kevOlder(v.version, v.indexVersion));
  });
});

describe("computeMetrics: CVE List days", () => {
  it("leaves a day whose zips failed uncounted: Flood and AI-credited stale with the note", () => {
    const previous = computeMetrics(world("2026-11-07").inputs).metrics;
    const w = world(D, { dayFailed: true, previous });
    const r = computeMetrics(w.inputs);
    const { metrics, manifest } = parsed(r);
    expect(statuses(metrics)).toMatchObject({ flood: "stale", ai_credited: "stale", window: "ok", kev: "ok" });
    expect(metrics.blocks.flood).toEqual({ status: "stale", as_of: previous.data_cutoff_utc, note: BLOCK_NOTES.daysMissing(1, w.cutoff) });
    expect(metrics.flood).toEqual(previous.flood);
    expect(metrics.ai_credited).toEqual(previous.ai_credited);
    expect(r.state["days.json"]).toBeUndefined();
    expect(manifest.flood.new_days).toEqual([]);
    expect(metrics.headline.second_line.startsWith("Flood, as of 5 Nov:")).toBe(true);
    expect(manifestIssues(metrics, manifest)).toEqual([]);
  });

  it(`counts no day after more than ${CATCH_UP_DAYS} missed days and prints the catch-up line`, () => {
    const w = world(D, { daysBack: 26 });
    const r = computeMetrics(w.inputs);
    const { metrics } = parsed(r);
    const newest = addDays(w.cutoff, -26);
    expect(r.catchUpLine).toBe(`Flood counts stop at ${newest}: run npm run backfill -- --catch-up --push.`);
    expect(statuses(metrics)).toMatchObject({ flood: "failed", ai_credited: "failed" });
    expect(metrics.blocks.flood.note).toBe(BLOCK_NOTES.catchUp(newest));
    expect(r.state["days.json"]).toBeUndefined();
    expect(r.state["ai-credits.json"]).toBeUndefined();
    expect(r.manifest.flood.new_days).toEqual([]);
  });

  it(`still counts at exactly ${CATCH_UP_DAYS} missed days`, () => {
    const w = world(D, { daysBack: 25 });
    w.inputs.feeds.cvelist.days = [{ date: addDays(w.cutoff, -24), ok: true, records: [] }];
    const r = computeMetrics(w.inputs);
    expect(r.catchUpLine).toBeNull();
    expect(r.manifest.flood.new_days).toEqual([{ date: addDays(w.cutoff, -24), ids: [] }]);
    expect(r.state["days.json"]!.days.at(-1)).toEqual([addDays(w.cutoff, -24), 0, 0, 0, sha256Hex("")]);
  });
});

describe("computeMetrics: AI-finder list changes", () => {
  it("recomputes every credit after a version bump and says so in the block note", () => {
    const w = world(D, { staleList: true });
    const r = computeMetrics(w.inputs);
    const { metrics, manifest } = parsed(r);
    expect(metrics.blocks.ai_credited).toEqual({ status: "ok", as_of: w.cutoff, note: AI_NOTES.recomputed(run.version) });
    expect(r.state["ai-credits.json"]!.finders_version).toBe(run.version);
    expect(r.log).toContain(AI_NOTES.recomputed(run.version));
    expect(manifestIssues(metrics, manifest)).toEqual([]);
  });

  it("keeps the AI block stale after a prefilter change and leaves the credit files alone", () => {
    const previous = computeMetrics(world("2026-11-07").inputs).metrics;
    const r = computeMetrics(world(D, { prefilter: true, previous }).inputs);
    expect(r.metrics.blocks.ai_credited).toMatchObject({ status: "stale", note: AI_NOTES.prefilterChanged });
    expect(r.state["ai-credits.json"]).toBeUndefined();
    expect(r.state["credit-candidates.json"]).toBeUndefined();
  });
});

describe("computeMetrics: frozenState (inside a backfill build, R28)", () => {
  it("reads the built state, writes none and lists no new ids", () => {
    const w = world(D, { frozen: true });
    const r = computeMetrics(w.inputs);
    const { metrics, manifest } = parsed(r);
    expect(r.state).toEqual({});
    expect(statuses(metrics)).toEqual({ flood: "ok", window: "ok", ai_credited: "ok", fix_side: "ok", kev: "ok", home_vendors: "ok" });
    expect(metrics.kev!.new_since_last_edition.cve_ids).toEqual([]);
    expect(manifest.kev_new).toEqual([]);
    expect(manifest.flood.new_days).toEqual([]);
    expect(manifestIssues(metrics, manifest)).toEqual([]);
    expect(r.catchUpLine).toBeNull();
  });

  it("refuses a cached catalog that differs from the built index", () => {
    const w = world(D, { frozen: true });
    w.inputs.feeds.kev.catalog = { ...w.inputs.feeds.kev.catalog!, catalogVersion: "2026.11.07" };
    expect(() => computeMetrics(w.inputs)).toThrow(/catalog/);
  });
});

describe("computeMetrics: determinism", () => {
  /** A deterministic Fisher-Yates shuffle (LCG). */
  function shuffle<T>(xs: readonly T[], seed: number): T[] {
    const out = [...xs];
    let s = seed;
    for (let j = out.length - 1; j > 0; j--) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const k = s % (j + 1);
      [out[j], out[k]] = [out[k]!, out[j]!];
    }
    return out;
  }

  it("gives byte-identical files from shuffled catalog, records and maps", () => {
    const a = computeMetrics(world(D).inputs);
    const w = world(D);
    const f = w.inputs.feeds;
    f.kev.catalog = { ...f.kev.catalog!, vulnerabilities: shuffle(f.kev.catalog!.vulnerabilities, 7) };
    f.cvelist.zipRecords = shuffle(f.cvelist.zipRecords, 11);
    f.cvelist.days = f.cvelist.days.map((d) => ({ ...d, records: shuffle(d.records, 13) }));
    f.cvelist.byId = new Map(shuffle([...f.cvelist.byId], 17));
    f.ghsa.advisories = shuffle(f.ghsa.advisories, 19);
    const s = w.inputs.state;
    s["kev-index.json"] = { ...s["kev-index.json"], entries: shuffle(s["kev-index.json"].entries, 23) };
    const b = computeMetrics(w.inputs);
    expect(jsonText(b.metrics, Metrics)).toBe(jsonText(a.metrics, Metrics));
    expect(jsonText(b.manifest, InputsManifest)).toBe(jsonText(a.manifest, InputsManifest));
    for (const name of STATE_FILES) {
      if (a.state[name]) expect(jsonText(b.state[name], STATE_SCHEMAS[name])).toBe(jsonText(a.state[name], STATE_SCHEMAS[name]));
    }
  });

  it("is a pure function of its inputs: two calls agree", () => {
    const w = world(D);
    expect(jsonText(computeMetrics(w.inputs).metrics, Metrics)).toBe(jsonText(computeMetrics(w.inputs).metrics, Metrics));
  });
});
