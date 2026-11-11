// The data contract (SPEC §4.2 to §4.15): every top-level schema accepts a minimal valid object and
// rejects an unknown key; the constraints the spec states as schema facts (not rule codes) hold; and each
// record-style vocabulary matches its tuple twin. Sample values are invented and labelled SAMPLE.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { addDays } from "@/lib/dates";
import * as S from "@/lib/schema";
import * as V from "@/lib/vocab";

const D = "2026-11-08";
const CUTOFF = "2026-11-06";
const T = "2026-11-08T04:50:12+08:00";
const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);

const draftSource = (i: number) => ({
  id: `s${i}`, title: "SAMPLE title", title_en: null, language: "en", outlet: "SAMPLE outlet",
  url: `https://example.org/sample/${i}`, source_type: "press", published_at: D,
});
const source = (i: number) => ({
  ...draftSource(i), publisher: "host:example.org", publisher_name: "example.org", tier: 3, state_label: null, seen_as: "pack",
});
const draftItem = {
  id: "pol-sample-2026-11", kind: "policy", headline: "SAMPLE headline", summary: "SAMPLE summary.", why_it_matters: null,
  severity: null, landmark: false, ai_role: "none", ai_role_secondary: null, ai_confidence: null, ai_claimant: null,
  ai_evidence: [], claim_type: "independent", regions: ["GLOBAL"], topics: [], attribution: [], incident: null, cve_ids: [],
  release_id: null, flaw_evidence: [], exploit_reported_in_sources: null, exposure: null, standing_story: null, source_ids: ["s1"],
};
const item = {
  ...draftItem, actor_nexus: null, first_seen: D, vendor: null, cves: [], release: null, public_exploit: null,
  anthropic_disclosure: false, withheld: null,
};
const draftLens = {
  analysis: V.TAIWAN_NO_NEWS, item_ids: [], source_ids: [],
  rows: V.TAIWAN_LENS_ROWS.map((row) => ({ row, text: null, item_ids: [], source_ids: [] })),
  japan: { text: null, item_ids: [], source_ids: [] },
};
const draftAngle = {
  text: "SAMPLE: 37% at disclosure.", source_id: null, metric_path: "window.w26.at_disclosure_share", as_of: CUTOFF,
  counterpoint: V.NONE_FOUND, counterpoint_source_ids: [], claim_id: null,
};
const lead = [{ text: "SAMPLE lead sentence.", item_ids: [], gap: true }];
const draft = {
  schema_version: 1, date: D, generated_at: T, lead, angle: draftAngle, region_raises: [], items: [draftItem],
  taiwan_lens: draftLens, scoreboard_entries: [], week_in_review: null, corrections: [], elsewhere: [], sources: [draftSource(1)],
};
const regionRow = (code: string) => ({
  code, level: "baseline", computed_level: "baseline", previous_level: null, change: "new", rule_id: null,
  reason: V.BASELINE_TOOLTIP, item_ids: [], fired: [], raised: null,
});
const kevLine = { d30_n: 0, d90_n: 1, text: "SAMPLE KEV line." };
const brief = {
  schema_version: 1, date: D, edition: "full", generated_at: T, published_at: T, data_only_published_at: null, late: false,
  data_cutoff_utc: CUTOFF, lead, angle: { ...draftAngle, claim_text: null },
  regions: { rows: V.LEVELLED_REGIONS.map(regionRow), global: { item_count: 1 }, signals: [] },
  gap: { headline: "SAMPLE", second_line: "SAMPLE", status: "missing", metrics_file: null, metrics_sha256: null, as_of: null },
  items: [item], actors_seen: [],
  taiwan_lens: { ...draftLens, kev_lines: { tw: kevLine, jp: kevLine }, kev_note: V.KEV_ABSENCE_NOTE, watch_windows: [] },
  scoreboard: { entries: [], last: null }, week_in_review: null, corrections: [], elsewhere: [], epss_movers: [], feeds_stale: [],
  sources: [source(1)],
  computed: { word_count: 10, reading_minutes: 1, item_count: 1, ai_linked: { linked: 0, total: 1 }, source_count: 1, publisher_count: 1 },
};

const weeks = Array.from({ length: S.SERIES_WEEKS }, (_, i) => addDays("2024-11-04", 7 * i));
const zeros = (n: number) => Array.from({ length: n }, () => 0);
const nulls = (n: number) => Array.from({ length: n }, () => null);
const seriesOf = (w: string[]) => ({
  weeks: w, live_from: w[w.length - 1] ?? "2024-11-04", flood_n13: zeros(w.length), flood_n13_kernel: zeros(w.length),
  flood_n13_year_ago: nulls(w.length), window_at_disclosure_share: nulls(w.length), window_at_disclosure_ci80: nulls(w.length),
  window_after_median: nulls(w.length), window_after_median_ci80: nulls(w.length), window_cohort_n: zeros(w.length),
  kev_recent_weekly: zeros(w.length), kev_weekly: zeros(w.length),
  ai_weekly: { anthropic: zeros(w.length), openai: zeros(w.length), google: zeros(w.length), other: zeros(w.length) },
  ai_ledger_only_weekly: zeros(w.length), data_only_weeks: [],
});
const block = { status: "failed", as_of: null, note: null };
const metrics = {
  schema_version: 1, date: D, generated_at: T, data_cutoff_utc: CUTOFF, reconstructed: false, code_commit: COMMIT,
  provenance: {
    kev_catalog_version: "2026.11.06", kev_count: 1500, kev_date_released: "2026-11-06T15:00:00Z",
    cve_list_release: "cve_2026-11-06_2100Z", cve_list_commit: COMMIT, kev_data_commit: null, epss_model_version: "v2025.03.14",
    epss_date: CUTOFF, ghsa_source: "git", ghsa_commit: COMMIT,
    config_versions: { vendors: 1, ai_finders: 1, source_tiers: 1, regions: 1, actors: 1 },
    reference: { from: "2023-01-01", to: "2024-12-31" }, inputs_file: `metrics/inputs/${D}.json`, inputs_sha256: SHA,
  },
  blocks: { flood: block, window: block, ai_credited: block, fix_side: block, kev: block, home_vendors: block },
  headline: { text: "SAMPLE", second_line: "SAMPLE", at_disclosure_direction: "n_too_small", after_disclosure_direction: "n_too_small", quoted: [] },
  flood: null, window: null, ai_credited: null, base_rate: null, fix_side: { anthropic_cvd: null, ghsa_unfixed: null }, kev: null,
  home_vendors: null, epss_movers: [], series: seriesOf(weeks),
};
const state = { schema_version: 1, updated_at: CUTOFF };
const stage = (id: string) => ({ id, status: "skipped", started_at: null, ended_at: null, note: null });
const run = {
  run_id: "20261108-043712", trigger: "schedule", attempt: 1, started_at: T, finished_at: null, outcome: null, edition: null,
  error_code: null, code_commit: COMMIT, data_cutoff_utc: CUTOFF, data_only_published_at: null, full_published_at: null, late: false,
  stages: V.RUN_STAGES.map(stage), feeds: [],
  budgets: { agent_seconds: 0, web_fetches: 0, web_searches: 0, repair_rounds: 0, tokens_in: null, tokens_out: null, usage: null, safety_stops: 0 },
  candidates: null, validation: null, soft_gates: null, deploy: { triggered: false, ready_at: null, shows_date: null, shows_edition: null },
  recheck: null, links: null,
};
const claim = {
  id: "SB-01", origin: "rival", text: "SAMPLE claim.", restates: null, stated_probability: null, judged_by: "script",
  metric_path: "base_rate.ratio", data_source: "SAMPLE data source",
  support: { kind: "value", op: "<=", value: 1, bound: "ci80_hi" }, challenge: { kind: "value", op: ">=", value: 2, bound: "ci80_lo" },
  opened: D, deadline: "2027-12-31", resolution: null,
};
const regionDef = (code: string) => ({
  code, countries: [code === "EU" ? "FR" : code], agencies: [], alert_patterns: [], certs: [],
  home_vendor_country: code === "TW" || code === "JP" ? code : null,
});
const rule = {
  id: "agency-alert", type: "agency_alert", level: "high", regions: ["US", "EU", "TW", "JP"],
  params: { lookback_hours: 168, min_publishers: null, sectors: null, statuses: null, min_severity: null, max_lag_days: null },
  reason: "{publisher} emergency alert: {title}", label: "National agency emergency alert",
};
const fetched = {
  id: "sample-feed", name: "SAMPLE feed", kind: "rss", url: "https://example.org/feed", fallback_url: null, language: "en",
  region: "GLOBAL", coverage: ["exploits"], priority: 2, fresh_days: 2, must_match: false, date_zone: null,
};
const search = { id: "q-sample", name: "SAMPLE search", kind: "search", query: "SAMPLE query", language: "ja", region: "JP", coverage: ["japan"], priority: 2 };
const feedIndexEntry = {
  id: "sample-feed", kind: "rss", status: "ok", label: "OK", error_class: null, url_used: "https://example.org/feed", fallback_used: false,
  newest: T, items: 3, records: 0, version: null, sha256: SHA, fetched_at: T, note: null,
};
const zipRead = {
  tag: "cve_2026-11-06_at_end_of_day", asset: "SAMPLE.zip", kind: "end_of_day", utc_day: CUTOFF, sha256: SHA, records: 2,
};
const collectInputs = {
  schema_version: 1, date: D, data_cutoff_utc: CUTOFF, generated_at: T, run_utc_day: "2026-11-07",
  record_window: { start: "2026-11-06T20:00:00Z", end: "2026-11-07T20:00:00Z" },
  commits: { cvelist: COMMIT, kev_data: COMMIT, ghsa: null },
  cvelist: {
    zips: [zipRead], days: [{ date: CUTOFF, zips: ["SAMPLE.zip", "SAMPLE-2.zip"], ok: true }], newest_hourly_tag: "cve_2026-11-07_2000Z",
    delta_log_newest: null, by_id: { fetched: [], not_found: [], over_cap: 0 },
  },
  kev: { catalog_version: "2026.11.06", date_released: "2026-11-06T15:00:00Z", count: 1500, url_used: "https://example.org/kev.json", sha256: SHA, fallback_used: false },
  epss: { source: "csv", model_version: "v2025.03.14", files: [{ role: "e", date: CUTOFF, sha256: SHA }] },
  ghsa: null,
  anthropic_cvd: null,
};
const refHead = { schema_version: 1, cve_list_commit: COMMIT, cutoff: CUTOFF };
const runFile = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "run.json"), "utf8")) as unknown;

const TOP_LEVEL: [string, z.ZodType, unknown][] = [
  ["DraftBrief", S.DraftBrief, draft],
  ["Brief", S.Brief, brief],
  ["Metrics", S.Metrics, metrics],
  ["InputsManifest", S.InputsManifest, {
    schema_version: 1, date: D, data_cutoff_utc: CUTOFF, generated_at: T, code_commit: COMMIT, feeds: [],
    window: { w26: [], w13: [], reference_sha256: SHA }, kev_new: [], flood: { days: [], new_days: [] }, ai_credited: [],
    home_vendors: { tw: [], jp: [] },
  }],
  ["KevIndexFile", S.KevIndexFile, { ...state, catalog_version: "2026.11.06", entries: [["CVE-2026-0001", "2026-11-05", "SAMPLE", "SAMPLE", null, null, "unknown"]] }],
  ["DaysFile", S.DaysFile, { ...state, days: [["2023-01-01", 50, 3, 10, SHA]] }],
  ["AiCreditsFile", S.AiCreditsFile, { ...state, finders_version: 1, finders_sha256: SHA, matches: [] }],
  ["CreditCandidatesFile", S.CreditCandidatesFile, { ...state, prefilter_sha256: SHA, candidates: [] }],
  ["AnthropicCvdFile", S.AnthropicCvdFile, {
    ...state, revision: null, as_of: null, fetched_at: null, source_url: null, found_n: null, disclosed_n: null, patched_n: null, ledger_ids: [],
  }],
  ["SeriesFile", S.SeriesFile, { ...state, ...seriesOf(weeks.slice(0, 3)) }],
  ["StatusFile", S.StatusFile, { schema_version: 1, date: D, runs: [run] }],
  ["ClaimsFile", S.ClaimsFile, { schema_version: 1, version: 0, claims: [] }],
  ["ScoreboardFile", S.ScoreboardFile, { schema_version: 1, as_of: D, claims_version: 0, claims: [], entries: [] }],
  ["CorrectionsFile", S.CorrectionsFile, { schema_version: 1, corrections: [], disputes: [] }],
  ["ArchiveIndex", S.ArchiveIndex, { schema_version: 1, editions: [], urls: {} }],
  ["Evidence", S.Evidence, { urls: [], fetched: [], texts: {}, seen_as: {} }],
  ["VendorsFile", S.VendorsFile, { schema_version: 1, version: 1, updated: D, vendors: [] }],
  ["AiFindersFile", S.AiFindersFile, {
    schema_version: 1, version: 1, updated: D, fields: ["cna.credits"], prefilter: "\\bSAMPLE\\b", strip: [], lab_context: "\\btool\\b",
    finders: [{ id: "sample-finder", name: "SAMPLE finder", family: "other", kind: "ai_system", patterns: ["\\bSAMPLE\\b"],
      patterns_case_sensitive: [], lab_names: [], examples: { match: ["SAMPLE"], no_match: ["other"] }, note: null }],
  }],
  ["SourceTiersFile", S.SourceTiersFile, { schema_version: 1, version: 1, updated: D, publishers: [], github: { tier1_paths: [] } }],
  ["RegionsFile", S.RegionsFile, {
    schema_version: 1, version: 1, updated: D, review_due: "2026-12-02", regions: V.LEVELLED_REGIONS.map(regionDef), rules: [rule],
    editor_raise: { max_steps: 1, max_per_region: 1 },
  }],
  ["AnnotationsFile", S.AnnotationsFile, { schema_version: 1, annotations: [] }],
  ["ActorsFile", S.ActorsFile, { schema_version: 1, version: 1, updated: D, actors: [] }],
  ["WatchWindowsFile", S.WatchWindowsFile, { schema_version: 1, windows: [] }],
  ["StandingStoriesFile", S.StandingStoriesFile, { schema_version: 1, stories: [] }],
  ["RunFile", S.RunFile, runFile],
  ["SourcesFile", S.SourcesFile, { schema_version: 1, keywords: Array.from({ length: 40 }, (_, i) => `sample${i}`), feeds: [fetched, search] }],
  ["Pack", S.Pack, {
    schema_version: 1, date: D, window: { start: "2026-11-07T04:30:00+08:00", end: "2026-11-08T04:30:00+08:00" }, generated_at: T,
    data_cutoff_utc: CUTOFF, degraded: true, feeds: [], items: [], records: [], injection_flags: 0,
  }],
  ["AgentContext", S.AgentContext, {
    date: D, window: { start: "2026-11-07T04:30:00+08:00", end: "2026-11-08T04:30:00+08:00" }, weekly: false,
    deadline: "2026-11-08T05:10:00+08:00", data_cutoff_utc: CUTOFF,
    budgets: { max_items: 10, typical_items: [5, 8], deep_reads: 15, page_fetches: 40, words: { target: 1100, max: 1300 } },
    candidates: [], cut: { count: 0, by_reason: {} },
    metrics: { gap_headline: "SAMPLE", quotable: [], home_vendor_kev: { tw: { d30_n: 0, d90_n: 1 }, jp: { d30_n: 0, d90_n: 0 } }, stale: [] },
    regions_preview: [], standing_stories: [], watch_windows: [], watch_searches: [], recent_items: [], yesterday: null, scoreboard: [],
    corrections: { flagged: [], reports: [] },
    config: { tiers: { t1: [], t2: [], not_sole_newsroom: [], state_labelled: [], cve_record: [] }, home_vendors: { tw: [], jp: [] }, actors: [], ai_finders: [], banned_words: [...V.BANNED_WORDS] },
    pack: { md: `packs/${D}.md`, json: `packs/${D}.json`, degraded: false, failed_feeds: [] },
  }],
  ["FeedIndexFile", S.FeedIndexFile, { schema_version: 1, date: D, generated_at: T, feeds: [feedIndexEntry] }],
  ["CollectInputsFile", S.CollectInputsFile, collectInputs],
  ["CandidatesFile", S.CandidatesFile, { schema_version: 1, date: D, kept: [], cut: { count: 0, by_reason: { below_cap: 0, merged: 0, bundled: 0 } } }],
  ["CandidateLogFile", S.CandidateLogFile, {
    schema_version: 1, date: D, ranked: 1, kept: [], cut: [{ id: "cve-2026-0001", score: 10, reason: "below_cap", pack_ids: ["r0001"], cve_ids: ["CVE-2026-0001"] }],
    log: [{ code: "MERGED", detail: "SAMPLE detail" }],
  }],
  ["ReferenceJoinFile", S.ReferenceJoinFile, {
    ...refHead, kev_catalog_version: "2026.11.06", kev_data_commit: COMMIT, rows: [["CVE-2026-0001", "2026-11-05", "SAMPLE", null]],
  }],
  ["ReferenceFloodDaysFile", S.ReferenceFloodDaysFile, { ...refHead, days: [["2023-01-01", 50, 3, 10]] }],
  ["ReferenceAiCreditsFile", S.ReferenceAiCreditsFile, {
    ...refHead, finders_version: 2, finders_sha256: SHA, matches: [["CVE-2026-0001", "2026-11-05", "sample-finder", "other", "pattern", "cna.credits", "SAMPLE"]],
  }],
];

/** The issue messages of a failed parse, or [] when it passed. */
function problems(schema: z.ZodType, value: unknown): string[] {
  const r = schema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}
const fails = (schema: z.ZodType, value: unknown) => expect(problems(schema, value)).not.toEqual([]);

describe("top-level schemas", () => {
  it.each(TOP_LEVEL)("%s accepts a minimal valid object", (_name, schema, value) => {
    expect(problems(schema, value)).toEqual([]);
  });

  it.each(TOP_LEVEL)("%s rejects an unknown key", (_name, schema, value) => {
    const r = schema.safeParse({ ...(value as object), sample_unknown: 1 });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.code)).toContain("unrecognized_keys");
  });

  it("writes keys in the spec's order whatever order they arrive in", () => {
    const reversed = Object.fromEntries(Object.entries(brief).reverse());
    expect(Object.keys(S.Brief.parse(reversed))).toEqual(Object.keys(S.Brief.shape));
    expect(Object.keys(S.Brief.shape).slice(0, 4)).toEqual(["schema_version", "date", "edition", "generated_at"]);
  });
});

describe("DraftBrief holds only model fields (§4.4)", () => {
  it("rejects a tier on a source and a cves block on an item as unknown keys", () => {
    const withTier = { ...draft, sources: [{ ...draftSource(1), tier: 1 }] };
    const withCves = { ...draft, items: [{ ...draftItem, cves: [] }] };
    for (const d of [withTier, withCves]) {
      const r = S.DraftBrief.safeParse(d);
      expect(r.error?.issues.map((i) => i.code)).toEqual(["unrecognized_keys"]);
    }
  });

  it("rejects actor_nexus, a script field, on a draft item", () => {
    fails(S.DraftBrief, { ...draft, items: [{ ...draftItem, actor_nexus: null }] });
  });

  it("leaves rule-coded checks to the rules: bad ids, empty source_ids, too many items", () => {
    const d = { ...draft, items: Array.from({ length: 11 }, () => ({ ...draftItem, id: "Not An Id", source_ids: [] })), sources: [{ ...draftSource(1), id: "x9" }] };
    expect(problems(S.DraftBrief, d)).toEqual([]);
  });
});

describe("schema-level constraints", () => {
  it("dates are real calendar dates and timestamps carry an offset", () => {
    fails(S.IsoDate, "2026-02-30");
    fails(S.IsoTimestamp, "2026-11-08T04:50:12");
    // Impossible instants that Date.parse rolls over rather than rejects.
    for (const bad of ["2026-02-30T04:00:00+08:00", "2026-11-08T24:00:00+08:00", "2026-11-08T04:50:12+15:00", "2026-11-08T04:50:12-14:30"]) {
      fails(S.IsoTimestamp, bad);
      fails(S.PublishedAt, bad);
    }
    for (const ok of ["2026-11-08T04:50:12+08:00", "2026-11-08T04:50Z", "2026-11-08T23:59:59.999Z", "2024-02-29T00:00:00-12:00", "2026-11-08T04:50:12+14:00"]) {
      expect(problems(S.IsoTimestamp, ok), ok).toEqual([]);
    }
    expect(problems(S.PublishedAt, "2026-11-08")).toEqual([]);
    expect(problems(S.PublishedAt, null)).toEqual([]);
  });

  it("language tags, CVE ids and country codes follow §4.3", () => {
    for (const ok of ["en", "ja", "zh-Hant", "zh-Hant-TW", "zh-Hans-CN"]) expect(problems(S.Language, ok)).toEqual([]);
    for (const bad of ["EN", "zh_TW", "english"]) fails(S.Language, bad);
    fails(S.CveId, "cve-2026-0001");
    fails(S.CveId, "CVE-2026-001");
    fails(S.CountryCode, "UK");
    expect(problems(S.CountryCode, "TW")).toEqual([]);
  });

  it("an interval has lo ≤ hi", () => {
    expect(problems(S.Interval, [0.3, 0.4])).toEqual([]);
    fails(S.Interval, [0.4, 0.3]);
  });

  it("an item's regions are unique and in REGIONS order; topics at most 3, unique; headline at most 90 characters", () => {
    fails(S.DraftItem, { ...draftItem, regions: [] });
    fails(S.DraftItem, { ...draftItem, regions: ["TW", "US"] });
    fails(S.DraftItem, { ...draftItem, regions: ["US", "US"] });
    expect(problems(S.DraftItem, { ...draftItem, regions: ["US", "TW", "GLOBAL"] })).toEqual([]);
    fails(S.DraftItem, { ...draftItem, topics: ["telecom", "telecom"] });
    fails(S.DraftItem, { ...draftItem, topics: ["telecom", "election", "market", "government"] });
    fails(S.DraftItem, { ...draftItem, headline: "x".repeat(91) });
    fails(S.DraftItem, { ...draftItem, cve_ids: ["CVE-2026-0001", "CVE-2026-0001"] });
  });

  it("a Lead sentence ends in . ? or !", () => {
    fails(S.LeadSentence, { text: "No full stop", item_ids: [], gap: true });
    expect(problems(S.LeadSentence, { text: "Ends with a quote.”", item_ids: [], gap: true })).toEqual([]);
    expect(problems(S.LeadSentence, { text: V.WITHHELD_MARK, item_ids: ["inc-retail-nl-2026-10"], gap: false })).toEqual([]);
  });

  it("the Angle has exactly one of source_id and metric_path", () => {
    fails(S.DraftAngle, { ...draftAngle, source_id: "s1" });
    fails(S.DraftAngle, { ...draftAngle, metric_path: null });
    expect(problems(S.DraftAngle, { ...draftAngle, source_id: "s1", metric_path: null })).toEqual([]);
  });

  it("a brief's region rows are exactly US, EU, TW, JP in order", () => {
    fails(S.Brief, { ...brief, regions: { ...brief.regions, rows: brief.regions.rows.slice().reverse() } });
    fails(S.Brief, { ...brief, regions: { ...brief.regions, rows: brief.regions.rows.slice(0, 3) } });
  });

  it("a run record has one stage per RUN_STAGES id, in order", () => {
    fails(S.RunRecord, { ...run, stages: run.stages.slice(1) });
    fails(S.RunRecord, { ...run, error_code: "auth failed" });
  });

  it("a metrics file carries 104 aligned weeks; the state series any number, aligned and ascending", () => {
    fails(S.Metrics, { ...metrics, series: seriesOf(weeks.slice(1)) });
    fails(S.Metrics, { ...metrics, series: { ...seriesOf(weeks), kev_weekly: zeros(103) } });
    fails(S.SeriesFile, { ...state, ...seriesOf(weeks.slice(0, 3)), ai_ledger_only_weekly: zeros(2) });
    fails(S.SeriesFile, { ...state, ...seriesOf([weeks[1]!, weeks[0]!]) });
  });

  it("state files (P2): days.json rows carry ids_sha256; series.json counts may be null, a metrics file's may not", () => {
    fails(S.DaysFile, { ...state, days: [["2023-01-01", 50, 3, 10]] });
    fails(S.DaysFile, { ...state, days: [["2023-01-01", 50, 3, 10, "not a hash"]] });
    const early = { ...seriesOf(weeks.slice(0, 3)), flood_n13: [null, null, 5], flood_n13_kernel: [null, null, 1], window_cohort_n: [null, null, null] };
    expect(problems(S.SeriesFile, { ...state, ...early })).toEqual([]);
    fails(S.SeriesFile, { ...state, ...early, window_cohort_n: [null, null] });
    fails(S.Metrics, { ...metrics, series: { ...seriesOf(weeks), flood_n13: [null, ...zeros(103)] } });
    fails(S.Metrics, { ...metrics, series: { ...seriesOf(weeks), window_cohort_n: [...zeros(103), null] } });
  });

  it("state files (P2): a credit candidate is never a ledger row; the GitHub share is null below MIN_N", () => {
    const candidates = (field: string) => ({ ...state, prefilter_sha256: SHA, candidates: [["CVE-2026-0001", CUTOFF, field, "SAMPLE text"]] });
    for (const f of ["cna.credits", "adp.credits", "ghsa.credits"]) expect(problems(S.CreditCandidatesFile, candidates(f))).toEqual([]);
    fails(S.CreditCandidatesFile, candidates("cvd_ledger"));
    const ghsa = { share: null, n_unfixed: 3, n_total: 20, from: "2026-07-09", to: "2026-10-07", as_of: CUTOFF };
    expect(problems(S.FixSide, { anthropic_cvd: null, ghsa_unfixed: ghsa })).toEqual([]);
    expect(problems(S.FixSide, { anthropic_cvd: null, ghsa_unfixed: { ...ghsa, share: 0.15 } })).toEqual([]);
    fails(S.FixSide, { anthropic_cvd: null, ghsa_unfixed: { ...ghsa, share: 1.5 } });
  });

  it("state files (P2): STATE_SCHEMAS covers exactly the six STATE_FILES", () => {
    expect(Object.keys(S.STATE_SCHEMAS)).toEqual([...S.STATE_FILES]);
    expect(S.STATE_FILES).toEqual(["kev-index.json", "days.json", "ai-credits.json", "credit-candidates.json", "anthropic-cvd.json", "series.json"]);
    for (const f of S.STATE_FILES) expect(S.isStateFileName(f)).toBe(true);
    for (const f of ["kev.json", "state/days.json", "days.json.bak", ""]) expect(S.isStateFileName(f)).toBe(false);
    const byName = Object.fromEntries(TOP_LEVEL.map(([n, , v]) => [n, v]));
    expect(problems(S.STATE_SCHEMAS["days.json"], byName.DaysFile)).toEqual([]);
    expect(problems(S.STATE_SCHEMAS["series.json"], byName.SeriesFile)).toEqual([]);
  });

  it("collect outputs (P2): zip tags, cut reasons, GHSA months and the two-zip day", () => {
    expect(problems(S.ZipRead, { ...zipRead, tag: "cve_2026-11-07_2000Z", kind: "hourly" })).toEqual([]);
    for (const tag of ["cve_2026-11-07_20Z", "cve_2026-11-07", "2026-11-07_at_end_of_day"]) fails(S.ZipRead, { ...zipRead, tag });
    const cut = { id: "x", score: 1, pack_ids: [], cve_ids: [] };
    for (const reason of ["below_cap", "merged:cve-2026-0001", "bundled:rel-microsoft-2026-10"]) expect(problems(S.CutEntry, { ...cut, reason })).toEqual([]);
    for (const reason of ["merged:", "bundled:pt-microsoft-2026-10", "dropped", "below_cap "]) fails(S.CutEntry, { ...cut, reason });
    fails(S.DayRead, { date: CUTOFF, zips: ["SAMPLE.zip"], ok: true });
    const ghsa = { commit: null, head_date: null, months: ["2026/07"], tree_sha256: SHA, advisories: 0 };
    expect(problems(S.CollectInputsFile, { ...collectInputs, ghsa })).toEqual([]);
    fails(S.CollectInputsFile, { ...collectInputs, ghsa: { ...ghsa, months: ["2026-07"] } });
    fails(S.FeedIndexEntry, { ...feedIndexEntry, label: "ok" });
    expect(S.FeedState.options).toEqual([...V.FEED_STATUS]);
  });

  it("config: regions in order, home-only rules, whole-day lookbacks, home vendor country only for TW and JP", () => {
    const regions = (TOP_LEVEL.find(([n]) => n === "RegionsFile")![2]) as Record<string, unknown>;
    fails(S.RegionsFile, { ...regions, regions: V.LEVELLED_REGIONS.map(regionDef).reverse() });
    fails(S.RegionRule, { ...rule, type: "home_vendor_kev", level: "elevated" });
    expect(problems(S.RegionRule, { ...rule, type: "home_vendor_kev", level: "elevated", regions: ["TW", "JP"] })).toEqual([]);
    fails(S.RegionRule, { ...rule, type: "home_vendor_kev", level: "high", regions: ["TW"] });
    fails(S.RegionRule, { ...rule, params: { ...rule.params, lookback_hours: 36 } });
    fails(S.RegionDef, { ...regionDef("US"), home_vendor_country: "US" });
  });

  it("config: domains are bare lower-case hosts with an optional path", () => {
    for (const ok of ["qnap.com", "microsoft.com/en-us/security/blog", "mops.twse.com.tw"]) expect(problems(S.Domain, ok)).toEqual([]);
    for (const bad of ["https://qnap.com", "www.qnap.com", "QNAP.com", "qnap"]) fails(S.Domain, bad);
  });

  it("claims: metric_path exactly when script-judged; thresholds are value or event", () => {
    expect(problems(S.Claim, claim)).toEqual([]);
    fails(S.Claim, { ...claim, metric_path: null });
    fails(S.Claim, { ...claim, judged_by: "report" });
    fails(S.Claim, { ...claim, metric_path: "flood.n" });
    fails(S.Claim, { ...claim, support: { kind: "event", text: "SAMPLE", op: "<=" } });
  });

  it("annotations and watch windows: dates in order, a source unless a data change", () => {
    const a = { id: "sample", date: "2026-07-19", end_date: "2026-07-20", label: "SAMPLE", detail: "SAMPLE", panels: ["flood"], kind: "data_change", source_url: null };
    expect(problems(S.Annotation, a)).toEqual([]);
    fails(S.Annotation, { ...a, kind: "policy" });
    fails(S.Annotation, { ...a, end_date: "2026-07-18" });
    const w = { id: "sample", title: "SAMPLE", start: D, end: "2026-12-05", regions: ["TW"], lens_row: "influence_ops", search_terms: [], note: null };
    expect(problems(S.WatchWindow, w)).toEqual([]);
    fails(S.WatchWindow, { ...w, end: "2026-11-01" });
  });

  it("registry: every key written out; search entries take a query, never a URL", () => {
    const { fallback_url: _f, ...noFallback } = fetched;
    const { must_match: _m, ...noMustMatch } = fetched;
    const { date_zone: _z, ...noDateZone } = fetched;
    fails(S.FeedEntry, noFallback);
    fails(S.FeedEntry, noMustMatch);
    fails(S.FeedEntry, noDateZone);
    fails(S.FeedEntry, { ...fetched, url: "http://example.org/feed" });
    fails(S.FeedEntry, { ...search, url: "https://example.org/" });
    fails(S.SourcesFile, { schema_version: 1, keywords: ["only one"], feeds: [] });
  });
});

describe("vocabularies (§4.2)", () => {
  const twins: [string, readonly (string | number)[], object][] = [
    ["HEAD_INFO", V.HEADS, V.HEAD_INFO], ["KIND_INFO", V.KINDS, V.KIND_INFO], ["SEVERITY_INFO", V.SEVERITIES, V.SEVERITY_INFO],
    ["TOPIC_INFO", V.TOPICS, V.TOPIC_INFO], ["AI_ROLE_INFO", V.AI_ROLES, V.AI_ROLE_INFO],
    ["AI_CONFIDENCE_INFO", V.AI_CONFIDENCE, V.AI_CONFIDENCE_INFO], ["CLAIM_TYPE_INFO", V.CLAIM_TYPES, V.CLAIM_TYPE_INFO],
    ["DISCOVERY_CREDIT_INFO", V.DISCOVERY_CREDIT, V.DISCOVERY_CREDIT_INFO], ["TIER_INFO", V.TIERS, V.TIER_INFO],
    ["SOURCE_TYPE_INFO", V.SOURCE_TYPES, V.SOURCE_TYPE_INFO], ["REGION_INFO", V.REGIONS, V.REGION_INFO],
    ["REGION_LEVEL_INFO", V.REGION_LEVELS, V.REGION_LEVEL_INFO], ["REGION_CHANGE", V.REGION_CHANGES, V.REGION_CHANGE],
    ["ACTOR_NEXUS_INFO", V.ACTOR_NEXUS, V.ACTOR_NEXUS_INFO], ["ATTRIBUTION_BASIS_INFO", V.ATTRIBUTION_BASIS, V.ATTRIBUTION_BASIS_INFO],
    ["INCIDENT_STATUS_INFO", V.INCIDENT_STATUS, V.INCIDENT_STATUS_INFO],
    ["EXPLOITATION_BASIS_INFO", V.EXPLOITATION_BASIS, V.EXPLOITATION_BASIS_INFO], ["EDITION_INFO", V.EDITIONS, V.EDITION_INFO],
    ["TAIWAN_LENS_ROW_INFO", V.TAIWAN_LENS_ROWS, V.TAIWAN_LENS_ROW_INFO], ["DISPUTE_FORM_OPTIONS", V.DISPUTE_KINDS, V.DISPUTE_FORM_OPTIONS],
    ["COUNTRY_CODES", V.COUNTRY_CODE_IDS, V.COUNTRY_CODES],
  ];

  it.each(twins)("%s has exactly the keys of its tuple twin", (_name, tuple, record) => {
    expect(Object.keys(record).sort()).toEqual(tuple.map(String).sort());
  });

  it("KIND_INFO slugs and heads agree with the item id pattern and HEADS; ranks are 1 to 9", () => {
    for (const k of V.KINDS) {
      const info = V.KIND_INFO[k];
      expect(S.ID_PATTERNS.item.test(`${info.slug}-sample`)).toBe(true);
      expect(V.HEADS).toContain(info.head);
    }
    expect(V.KINDS.map((k) => V.KIND_INFO[k].rank).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("every TOPIC_INFO lens row is a Taiwan Lens row", () => {
    for (const t of V.TOPICS) {
      const row = V.TOPIC_INFO[t].lens_row;
      if (row !== null) expect(V.TAIWAN_LENS_ROWS).toContain(row);
    }
  });

  it("COUNTRY_CODES holds the 249 ISO 3166-1 alpha-2 codes, each two upper-case letters", () => {
    expect(V.COUNTRY_CODE_IDS).toHaveLength(249);
    expect(V.COUNTRY_CODE_IDS.every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
    expect(V.COUNTRY_CODES.TW).toBe("Taiwan");
  });

  it("the listed regions, levels and rules agree", () => {
    expect(V.REGIONS).toEqual([...V.LEVELLED_REGIONS, "GLOBAL"]);
    expect(V.AI_LINKED_ROLES.every((r) => (V.AI_ROLES as readonly string[]).includes(r))).toBe(true);
    expect(V.CNI_SECTORS.every((s) => (V.SECTORS as readonly string[]).includes(s))).toBe(true);
    expect(V.FLAW_KINDS.every((k) => (V.KINDS as readonly string[]).includes(k))).toBe(true);
  });

  it("pattern lists are named where they need to be and never stateful (no g or y flag)", () => {
    for (const re of [...V.PAYLOAD_PATTERNS.map((p) => p.re), ...V.INJECTION_PATTERNS]) {
      expect(re.global || re.sticky).toBe(false);
    }
    expect(V.PAYLOAD_PATTERNS.every((p) => p.name.length > 0)).toBe(true);
    expect(new Set(V.IOC_TLDS).size).toBe(V.IOC_TLDS.length);
    expect(V.NEXUS_TERMS.find((t) => t.term === "China-nexus")?.nexus).toBe("prc");
    expect(V.NEXUS_TERMS.find((t) => t.term === "state-sponsored")?.nexus).toBeNull();
  });

  it("INJECTION_PATTERNS flag the planted page and item but not the advisory's own text", () => {
    const dir = path.join(__dirname, "..", "fixtures", "injection");
    const planted = (file: string) => fs.readFileSync(path.join(dir, file), "utf8");
    const hit = (text: string) => V.INJECTION_PATTERNS.some((re) => re.test(text));
    expect(hit(planted("page.html"))).toBe(true);
    expect(hit(planted("item.xml"))).toBe(true);
    expect(hit("Example Networks has fixed a flaw in the web console. Update to 4.2.7 or later.")).toBe(false);
  });

  it("no vocabulary string holds an em-dash", () => {
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object" && !(v instanceof RegExp)) Object.values(v).forEach(walk);
    };
    Object.values(V).forEach(walk);
    expect(strings.length).toBeGreaterThan(500);
    expect(strings.filter((s) => s.includes(String.fromCharCode(0x2014)))).toEqual([]);
  });
});
