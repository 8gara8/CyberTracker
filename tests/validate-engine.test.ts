// The validator engine (SPEC §4.12, §8.6): schema issue messages, overlap skipping, scope, † and metrics
// filtering, the Archived briefs downgrade, validateAll()'s cross-file checks on small hand-built
// folders, the shared walkers, and the CLI's usage errors and exit codes. The rules are stand-ins built
// with defineRule(); the real rules and the full fixtures are tested elsewhere. Sample text is invented
// and marked SAMPLE.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCheckedConfig, type LoadedConfig } from "@/lib/config";
import { addDays } from "@/lib/dates";
import { RULES, RULE_GROUPS, ruleCodes } from "@/lib/rules";
import {
  allStrings, derive, finderNames, isDataOnly, itemIdFields, knownNames, nameMatches, proseFields, publishersOfItem, quotedFields,
  sourceIdFields, titleFields,
} from "@/lib/rules/shared";
import { defineRule, error, warning, type Rule, type RuleInput } from "@/lib/rules/types";
import { AgentContext } from "@/lib/schema/context";
import { Brief } from "@/lib/schema/brief";
import { DraftBrief } from "@/lib/schema/draft-brief";
import type { Source } from "@/lib/schema/common";
import type { Item } from "@/lib/schema/item";
import { InputsManifest, Metrics } from "@/lib/schema/metrics";
import { ArchiveIndex, CorrectionsFile, type Correction } from "@/lib/schema/misc";
import { Pack } from "@/lib/schema/pack";
import { ScoreboardFile } from "@/lib/schema/scoreboard";
import { RunRecord, StatusFile } from "@/lib/schema/status";
import {
  ARCHIVE_WARNING_CODES, RegionsInputFile, SAFETY_CODES, cveLookupFromDir, cveRecordInfo, formatPath, manifestIssues, packDatesOf,
  runRules, schemaIssues, unparsableIssue, validateAll, validateDraft, validatePublished, type DraftInputs,
} from "@/lib/validate";
import { KEV_ABSENCE_NOTE, NONE_FOUND, RUN_STAGES, TAIWAN_LENS_ROWS, TAIWAN_NO_NEWS } from "@/lib/vocab";
import { main as cliMain } from "@/scripts/validate";

const D1 = "2026-11-08";
const D2 = "2026-11-09";
const at = (d: string, t: string) => `${d}T${t}+08:00`;
const cutoff = (d: string) => addDays(d, -2);

let config: LoadedConfig;
let tmp: string;
beforeAll(() => {
  config = loadCheckedConfig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-validate-engine-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let dirN = 0;
function freshDir(files: Record<string, unknown> = {}): string {
  const dir = path.join(tmp, `c${(dirN += 1)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
  }
  return dir;
}

// ── Builders ─────────────────────────────────────────────────────────────────────────────────────

function draftSource(n: number) {
  return {
    id: `s${n}`, title: `SAMPLE source ${n}`, title_en: null, language: "en", outlet: "SAMPLE outlet",
    url: `https://example.org/sample/source-${n}`, source_type: "other" as const, published_at: D1,
  };
}

function draftItem(id: string, over: Record<string, unknown> = {}) {
  return {
    id, kind: "policy", headline: "SAMPLE policy item", summary: "SAMPLE summary of the event.", why_it_matters: null, severity: null,
    landmark: false, ai_role: "none", ai_role_secondary: null, ai_confidence: null, ai_claimant: null, ai_evidence: [],
    claim_type: "independent", regions: ["GLOBAL"], topics: [], attribution: [], incident: null, cve_ids: [], release_id: null,
    flaw_evidence: [], exploit_reported_in_sources: null, exposure: null, standing_story: null, source_ids: ["s1"], ...over,
  };
}

function rawDraft(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1, date: D2, generated_at: at(D2, "05:01:00"),
    lead: [{ text: "SAMPLE: A quiet morning on the exploit front.", item_ids: [], gap: false }],
    angle: { text: "SAMPLE angle with 1 number.", source_id: "s1", metric_path: null, as_of: D1, counterpoint: NONE_FOUND, counterpoint_source_ids: [], claim_id: null },
    region_raises: [], items: [draftItem("pol-sample-rule")],
    taiwan_lens: {
      analysis: TAIWAN_NO_NEWS, item_ids: [], source_ids: [],
      rows: TAIWAN_LENS_ROWS.map((row) => ({ row, text: null, item_ids: [], source_ids: [] })), japan: { text: null, item_ids: [], source_ids: [] },
    },
    scoreboard_entries: [], week_in_review: null, corrections: [], elsewhere: [], sources: [draftSource(1), draftSource(2)],
    ...over,
  };
}

function context(date = D2): AgentContext {
  return AgentContext.parse({
    date, window: { start: at(addDays(date, -1), "04:30:00"), end: at(date, "04:30:00") }, weekly: false, deadline: at(date, "05:20:00"),
    data_cutoff_utc: cutoff(date),
    budgets: { max_items: 10, typical_items: [5, 8], deep_reads: 15, page_fetches: 40, words: { target: 1100, max: 1300 } },
    candidates: [], cut: { count: 0, by_reason: {} },
    metrics: { gap_headline: "SAMPLE headline.", quotable: [], home_vendor_kev: { tw: { d30_n: 0, d90_n: 0 }, jp: { d30_n: 0, d90_n: 0 } }, stale: [] },
    regions_preview: [], standing_stories: [], watch_windows: [], watch_searches: [], recent_items: [], yesterday: null, scoreboard: [],
    corrections: { flagged: [], reports: [] },
    config: { tiers: { t1: [], t2: [], not_sole_newsroom: [], state_labelled: [] }, home_vendors: { tw: [], jp: [] }, actors: [], ai_finders: [], banned_words: [] },
    pack: { md: `packs/${date}.md`, json: `packs/${date}.json`, degraded: false, failed_feeds: [] },
  });
}

function inputs(rules: Rule[], over: Partial<DraftInputs> = {}): DraftInputs {
  return { context: context(), evidence: null, metrics: null, config, cveList: null, regionsBase: null, packDates: null, rules, ...over };
}

function mondays(lastMonday: string): string[] {
  return Array.from({ length: 104 }, (_, i) => addDays(lastMonday, -7 * (103 - i)));
}

function metricsFile(date: string): Metrics {
  const weeks = mondays("2026-10-26");
  const zeros = weeks.map(() => 0);
  const nulls = weeks.map(() => null);
  const failed = { status: "failed" as const, as_of: null, note: null };
  return Metrics.parse({
    schema_version: 1, date, generated_at: at(date, "04:41:00"), data_cutoff_utc: cutoff(date), reconstructed: false, code_commit: "0".repeat(40),
    provenance: {
      kev_catalog_version: "2026.11.06", kev_count: 0, kev_date_released: at(cutoff(date), "03:00:00"), cve_list_release: "cve_sample",
      cve_list_commit: "0".repeat(40), kev_data_commit: null, epss_model_version: "v-sample", epss_date: cutoff(date), ghsa_source: "git",
      ghsa_commit: null, config_versions: { vendors: 1, ai_finders: 1, source_tiers: 1, regions: 1, actors: 1 },
      reference: { from: "2023-01-01", to: "2024-12-31" }, inputs_file: `metrics/inputs/${date}.json`, inputs_sha256: "0".repeat(64),
    },
    blocks: { flood: failed, window: failed, ai_credited: failed, fix_side: failed, kev: failed, home_vendors: failed },
    headline: { text: "SAMPLE headline.", second_line: "SAMPLE second line.", at_disclosure_direction: "n_too_small", after_disclosure_direction: "n_too_small", quoted: [] },
    flood: null, window: null, ai_credited: null, base_rate: null, fix_side: { anthropic_cvd: null, ghsa_unfixed: null }, kev: null, home_vendors: null,
    epss_movers: [],
    series: {
      weeks, live_from: "2026-11-02", flood_n13: zeros, flood_n13_kernel: zeros, flood_n13_year_ago: nulls,
      window_at_disclosure_share: nulls, window_at_disclosure_ci80: nulls, window_after_median: nulls, window_after_median_ci80: nulls,
      window_cohort_n: zeros, kev_recent_weekly: zeros, kev_weekly: zeros,
      ai_weekly: { anthropic: zeros, openai: zeros, google: zeros, other: zeros }, ai_ledger_only_weekly: zeros, data_only_weeks: [],
    },
  });
}

function inputsFile(date: string): InputsManifest {
  return InputsManifest.parse({
    schema_version: 1, date, data_cutoff_utc: cutoff(date), generated_at: at(date, "04:41:00"), code_commit: "0".repeat(40), feeds: [],
    window: { w26: [], w13: [], reference_sha256: "0".repeat(64) }, kev_new: [], flood: { days: [], new_days: [] }, ai_credited: [],
    home_vendors: { tw: [], jp: [] },
  });
}

function source(n: number, over: Partial<Source> = {}): Source {
  return {
    id: `s${n}`, title: `SAMPLE source ${n}`, title_en: null, language: "en", outlet: "SAMPLE outlet",
    url: `https://example.org/sample/source-${n}`, source_type: "other", published_at: D1, publisher: "host:example.org",
    publisher_name: "example.org", tier: 3, state_label: null, seen_as: "pack", ...over,
  };
}

function item(date: string, id: string, over: Partial<Item> = {}): Item {
  return {
    ...(draftItem(id) as unknown as Omit<Item, "actor_nexus" | "first_seen" | "vendor" | "cves" | "release" | "public_exploit" | "anthropic_disclosure" | "withheld">),
    actor_nexus: null, first_seen: date, vendor: null, cves: [], release: null, public_exploit: null, anthropic_disclosure: false, withheld: null,
    ...over,
  } as Item;
}

const region = (code: "US" | "EU" | "TW" | "JP") => ({
  code, level: "baseline", computed_level: "baseline", previous_level: null, change: "new", rule_id: null, reason: "No rule fired.",
  item_ids: [], fired: [], raised: null,
});

function brief(date: string, over: Partial<Brief> = {}): Brief {
  return Brief.parse({
    schema_version: 1, date, edition: "data_only", generated_at: at(date, "04:44:30"), published_at: at(date, "04:44:52"),
    data_only_published_at: at(date, "04:44:52"), late: false, data_cutoff_utc: cutoff(date), lead: [], angle: null,
    regions: { rows: [region("US"), region("EU"), region("TW"), region("JP")], global: { item_count: 0 }, signals: [] },
    gap: { headline: "SAMPLE headline.", second_line: "SAMPLE second line.", status: "ok", metrics_file: `metrics/${date}.json`, metrics_sha256: "0".repeat(64), as_of: cutoff(date) },
    items: [], actors_seen: [],
    taiwan_lens: {
      analysis: "", item_ids: [], source_ids: [], rows: TAIWAN_LENS_ROWS.map((row) => ({ row, text: null, item_ids: [], source_ids: [] })),
      japan: { text: null, item_ids: [], source_ids: [] },
      kev_lines: { tw: { d30_n: 0, d90_n: 0, text: "SAMPLE TW line." }, jp: { d30_n: 0, d90_n: 0, text: "SAMPLE JP line." } },
      kev_note: KEV_ABSENCE_NOTE, watch_windows: [],
    },
    scoreboard: { entries: [], last: null }, week_in_review: null, corrections: [], elsewhere: [], epss_movers: [], feeds_stale: [], sources: [source(1)],
    computed: { word_count: 0, reading_minutes: 0, item_count: 0, ai_linked: { linked: 0, total: 0 }, source_count: 1, publisher_count: 1 },
    ...over,
  });
}

function statusFile(date: string, b: Pick<Brief, "edition" | "published_at"> | null): StatusFile {
  const record = RunRecord.parse({
    run_id: `${date.replaceAll("-", "")}-043712`, trigger: "schedule", attempt: 1, started_at: at(date, "04:37:12"), finished_at: at(date, "05:20:00"),
    outcome: b ? (b.edition === "data_only" ? "published_data_only" : "published_full") : "failed", edition: b?.edition ?? null,
    error_code: b ? null : "E_AGENT", code_commit: "0".repeat(40), data_cutoff_utc: cutoff(date),
    data_only_published_at: b?.edition === "data_only" ? b.published_at : null, full_published_at: b && b.edition !== "data_only" ? b.published_at : null,
    late: false, stages: RUN_STAGES.map((id) => ({ id, status: "ok", started_at: null, ended_at: null, note: null })), feeds: [],
    budgets: { agent_seconds: 0, web_fetches: 0, web_searches: 0, repair_rounds: 0, tokens_in: null, tokens_out: null, usage: null, safety_stops: 0 },
    candidates: null, validation: null, soft_gates: null, deploy: { triggered: false, ready_at: null, shows_date: null, shows_edition: null },
    recheck: null, links: null,
  });
  return StatusFile.parse({ schema_version: 1, date, runs: [record] });
}

function archiveFor(briefs: Brief[]): ArchiveIndex {
  return ArchiveIndex.parse({
    schema_version: 1,
    editions: [...briefs].sort((a, b) => b.date.localeCompare(a.date))
      .map((b) => ({ date: b.date, edition: b.edition, published_at: b.published_at, item_count: b.items.length, corrected: false })),
    urls: {},
  });
}

function correction(n: number, over: Partial<Correction> = {}): Correction {
  return {
    id: `C-${String(n).padStart(4, "0")}`, date: D2, item_id: "pol-sample-rule", edition_date: D1, type: "correction", field: "headline",
    before: "SAMPLE before", after: "SAMPLE after", reason: "SAMPLE: the source corrected itself.", source_url: null, trigger: "recheck",
    dispute_id: null, ...over,
  };
}

/** A consistent content folder: one brief per date with its metrics, inputs and status, plus the three top files. */
function content(briefs: Brief[], over: Record<string, unknown> = {}): Record<string, unknown> {
  const files: Record<string, unknown> = {
    "README.md": "SAMPLE content folder.\n",
    "archive-index.json": archiveFor(briefs),
    "corrections.json": CorrectionsFile.parse({ schema_version: 1, corrections: [], disputes: [] }),
    "scoreboard.json": ScoreboardFile.parse({ schema_version: 1, as_of: D2, claims_version: 0, claims: [], entries: [] }),
  };
  for (const b of briefs) {
    files[`briefs/${b.date}.json`] = b;
    files[`metrics/${b.date}.json`] = metricsFile(b.date);
    files[`metrics/inputs/${b.date}.json`] = inputsFile(b.date);
    files[`status/${b.date}.json`] = statusFile(b.date, b);
  }
  return { ...files, ...over };
}

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

// ── Schema issues ────────────────────────────────────────────────────────────────────────────────

describe("schema issues (SCHEMA)", () => {
  it("formats paths the way dropUnverified() reads them", () => {
    expect(formatPath(["items", 3, "summary"])).toBe("items[3].summary");
    expect(formatPath(["taiwan_lens", "rows", 0, "text"])).toBe("taiwan_lens.rows[0].text");
    expect(formatPath([])).toBe("(root)");
  });

  it("the hand-built draft is valid", () => {
    expect(DraftBrief.safeParse(rawDraft()).success).toBe(true);
  });

  it("gives one Unknown key issue per unknown key, telling the writer to remove it", () => {
    const raw = rawDraft();
    (raw.sources as Record<string, unknown>[])[0]!.tier = 1;
    (raw.items as Record<string, unknown>[])[0]!.cves = [];
    const r = DraftBrief.safeParse(raw);
    const issues = schemaIssues(r.error!, raw);
    expect(issues.map((i) => [i.path, i.message])).toEqual([
      ["items[0].cves", 'Unknown key "cves"; remove it.'],
      ["sources[0].tier", 'Unknown key "tier"; remove it.'],
    ]);
    expect(issues.every((i) => i.code === "SCHEMA" && i.severity === "error")).toBe(true);
  });

  it("says Missing key for an absent key, nullable and literal keys included, and keeps other messages", () => {
    const raw = rawDraft();
    delete raw.week_in_review;
    delete raw.schema_version;
    (raw.items as Record<string, unknown>[])[0]!.severity = "bogus";
    const r = DraftBrief.safeParse(raw);
    const issues = schemaIssues(r.error!, raw);
    const by = Object.fromEntries(issues.map((i) => [i.path, i.message]));
    expect(by.week_in_review).toMatch(/^Missing key/);
    expect(by.schema_version).toBe("Missing key (expected 1).");
    expect(by["items[0].severity"]).not.toMatch(/^Missing key/);
    expect(issues).toHaveLength(r.error!.issues.length);
  });

  it("an unparsable file is one SCHEMA issue at (file) asking for a full rewrite", () => {
    let err: unknown;
    try {
      JSON.parse("{ not json");
    } catch (e) {
      err = e;
    }
    const i = unparsableIssue("drafts/2026-11-09.json", err);
    expect(i.code).toBe("SCHEMA");
    expect(i.path).toBe("(file)");
    expect(i.message).toMatch(/^drafts\/2026-11-09\.json is not valid JSON \(.+\); rewrite the whole file as valid JSON\.$/);
  });
});

// ── Running the rules ────────────────────────────────────────────────────────────────────────────

const emit = (code: string, ...paths: string[]): Rule =>
  defineRule({ code, scope: "brief", dataOnly: true, check: () => paths.map((p) => error(code, p, `SAMPLE ${code} at ${p}`)) });

describe("runRules", () => {
  it("runs every rule on a valid draft and returns its issues as they are", () => {
    const r = validateDraft(rawDraft(), inputs([emit("TEST_A", "items[0].summary"), emit("TEST_B", "lead[0].text")]));
    expect(codes(r.errors)).toEqual(["TEST_A", "TEST_B"]);
    expect(r.errors[0]!.hint).toBeNull();
    expect(r.draft).not.toBeNull();
  });

  it("with schema errors, drops rule issues overlapping a schema error's path, but not an unknown key's", () => {
    const raw = rawDraft({ items: [draftItem("pol-a", { severity: "bogus" }), draftItem("pol-b")] });
    (raw.sources as Record<string, unknown>[])[0]!.tier = 1;
    const rule = emit("TEST_A", "items[0].severity", "items[0]", "items", "items[1].summary", "sources[0]", "sources[0].tier");
    const r = validateDraft(raw, inputs([rule]));
    expect(r.draft).toBeNull();
    const ruleIssues = r.errors.filter((i) => i.code === "TEST_A");
    expect(ruleIssues.map((i) => i.path)).toEqual(["items[1].summary", "sources[0]", "sources[0].tier"]);
    expect(ruleIssues.every((i) => /schema errors/.test(i.hint ?? ""))).toBe(true);
    expect(r.errors.filter((i) => i.code === "SCHEMA").map((i) => i.path).sort()).toEqual(["items[0].severity", "sources[0].tier"]);
  });

  it("a rule that throws is skipped in a best-effort run and surfaces on a valid one", () => {
    const boom = defineRule({ code: "TEST_BOOM", scope: "brief", check: () => { throw new Error("SAMPLE failure"); } });
    const broken = rawDraft({ items: [draftItem("pol-a", { severity: "bogus" })] });
    expect(codes(validateDraft(broken, inputs([boom, emit("TEST_A", "lead[0].text")])).errors)).toContain("TEST_A");
    expect(() => validateDraft(rawDraft(), inputs([boom]))).toThrow("SAMPLE failure");
  });

  it("runs no rule on input that is not an object", () => {
    const r = validateDraft([1, 2], inputs([emit("TEST_A", "lead")]));
    expect(codes(r.errors)).toEqual(["SCHEMA"]);
  });

  it("honours scope: draft rules only in validateDraft, all rules only through validateAll", () => {
    const seen: string[] = [];
    const spy = (scope: Rule["scope"]) => defineRule({ code: `TEST_${scope.toUpperCase()}`, scope, dataOnly: true, check: (i) => { seen.push(`${scope}:${i.mode}:${i.crossFile ? "x" : "-"}`); return []; } });
    const rules = [spy("draft"), spy("brief"), spy("all")];
    validateDraft(rawDraft(), inputs(rules));
    validatePublished(brief(D1), { metrics: null, config, rules });
    validateAll(freshDir(content([brief(D1)])), { rules, config });
    expect(seen).toEqual(["draft:draft:-", "brief:draft:-", "brief:published:-", "brief:published:x", "all:published:x"]);
  });

  it("runs only † rules on a data-only edition, every rule on a full one", () => {
    const plain = defineRule({ code: "TEST_PLAIN", scope: "brief", check: () => [error("TEST_PLAIN", "lead", "SAMPLE")] });
    const dagger = defineRule({ code: "TEST_DAGGER", scope: "brief", dataOnly: true, check: () => [error("TEST_DAGGER", "lead", "SAMPLE")] });
    const m = metricsFile(D1);
    expect(codes(validatePublished(brief(D1), { metrics: m, config, rules: [plain, dagger] }).errors)).toEqual(["TEST_DAGGER"]);
    const full = brief(D1, { edition: "full" });
    expect(codes(validatePublished(full, { metrics: m, config, rules: [plain, dagger] }).errors)).toEqual(["TEST_PLAIN", "TEST_DAGGER"]);
    expect(isDataOnly({ draft: brief(D1), mode: "published" })).toBe(true);
    expect(isDataOnly({ draft: DraftBrief.parse(rawDraft()), mode: "draft" })).toBe(false);
  });

  it("skips the rules that need metrics when there are none, with one METRICS_MISSING warning", () => {
    const needs = (code: string) => defineRule({ code, scope: "brief", needsMetrics: true, check: () => [error(code, "lead", "SAMPLE")] });
    const r = validateDraft(rawDraft(), inputs([needs("TEST_M1"), needs("TEST_M2"), emit("TEST_A", "lead")]));
    expect(codes(r.errors)).toEqual(["TEST_A"]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ code: "METRICS_MISSING", severity: "warning", path: "(metrics)" });
    expect(r.warnings[0]!.message).toContain("TEST_M1, TEST_M2");
    const withMetrics = validateDraft(rawDraft(), inputs([needs("TEST_M1")], { metrics: metricsFile(D2) }));
    expect(codes(withMetrics.errors)).toEqual(["TEST_M1"]);
    expect(withMetrics.warnings).toEqual([]);
  });

  it("gives the rules the draft's inputs and a derived view", () => {
    let got: RuleInput | null = null;
    const probe = defineRule({ code: "TEST_PROBE", scope: "draft", check: (i) => { got = i; return [warning("TEST_PROBE", "lead", "SAMPLE")]; } });
    const r = validateDraft(rawDraft(), inputs([probe], { fileDate: D2, packDates: { "https://example.org/x": D1 } }));
    expect(r.ok).toBe(true);
    expect(codes(r.warnings)).toEqual(["TEST_PROBE"]);
    const i = got as unknown as RuleInput;
    expect(i.mode).toBe("draft");
    expect(i.date).toBe(D2);
    expect(i.fileDate).toBe(D2);
    expect(i.packDates).toEqual({ "https://example.org/x": D1 });
    expect([...i.derived.sourcesById.keys()]).toEqual(["s1", "s2"]);
    expect(i.derived.tierBySourceId.get("s1")).toBe(3);
    expect(i.derived.itemsById.has("pol-sample-rule")).toBe(true);
  });

  it("runRules on its own takes the same input without derived", () => {
    const issues = runRules({
      draft: brief(D1), mode: "published", date: D1, fileDate: null, metrics: null, config, context: null, evidence: null, cveList: null,
      regionsBase: null, packDates: null, crossFile: null,
    }, [], [emit("TEST_A", "lead")]);
    expect(codes(issues)).toEqual(["TEST_A"]);
  });
});

// ── The registry ─────────────────────────────────────────────────────────────────────────────────

describe("the registry", () => {
  it("lists the twelve group files in the rule table's order", () => {
    expect(RULE_GROUPS.map((g) => g.group)).toEqual([
      "meta", "ids", "items", "words", "sources", "cves", "grounding", "ai", "naming", "safety", "computed", "snapshots",
    ]);
    expect(RULES).toEqual(RULE_GROUPS.flatMap((g) => g.rules));
    for (const g of RULE_GROUPS) expect(fs.existsSync(path.join(__dirname, "..", "lib", "rules", `${g.group}.ts`))).toBe(true);
  });

  it("every registered rule is well formed", () => {
    for (const r of RULES) {
      expect(r.codes.length).toBeGreaterThan(0);
      for (const c of r.codes) expect(c).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(["draft", "brief", "all"]).toContain(r.scope);
    }
    expect(new Set(ruleCodes()).size).toBe(ruleCodes().length);
  });

  it("exports the safety codes; the list-reading ones downgrade on archives", () => {
    expect([...SAFETY_CODES]).toEqual(["NO_LIVE_IOC", "NO_EXPLOIT_LINK", "SECRET_LIKE"]);
    expect(ARCHIVE_WARNING_CODES).toEqual(["NO_LIVE_IOC", "NO_EXPLOIT_LINK", "SOURCE_URL"]);
  });
});

// ── validateAll ──────────────────────────────────────────────────────────────────────────────────

describe("validateAll", () => {
  it("passes an empty folder, a missing one and one holding only README.md", () => {
    for (const dir of [freshDir(), path.join(tmp, "no-such-folder"), freshDir({ "README.md": "SAMPLE\n" })]) {
      const r = validateAll(dir, { config, perFile: true });
      expect(r).toMatchObject({ ok: true, errors: [], warnings: [] });
    }
  });

  it("passes a consistent folder", () => {
    const b1 = brief(D1);
    const b2 = brief(D2, { edition: "full", published_at: at(D2, "05:12:00") });
    const r = validateAll(freshDir(content([b1, b2])), { config, rules: [] });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("reports a stray file (FILE_UNEXPECTED) and ignores .DS_Store", () => {
    const dir = freshDir({ "notes.txt": "SAMPLE", "briefs/extra/x.json": {}, ".DS_Store": "", "state/other.json": {} });
    const r = validateAll(dir, { config, perFile: true });
    expect(r.ok).toBe(false);
    expect(r.errors.map((i) => i.path)).toEqual(["briefs/extra/x.json: (file)", "notes.txt: (file)", "state/other.json: (file)"]);
    expect(new Set(codes(r.errors))).toEqual(new Set(["FILE_UNEXPECTED"]));
    expect(r.files.map((f) => f.file)).toEqual(["briefs/extra/x.json", "notes.txt", "state/other.json"]);
    expect(r.files[0]!.errors[0]!.path).toBe("(file)");
  });

  it("reports files named after Object.prototype members as stray, never as known files", () => {
    const dir = freshDir({ "constructor": {}, "toString": {}, "state/toString": {}, "state/constructor": {}, "state/__proto__": {} });
    const r = validateAll(dir, { config, perFile: true });
    expect(r.errors.map((i) => i.path)).toEqual(["constructor: (file)", "state/__proto__: (file)", "state/constructor: (file)", "state/toString: (file)", "toString: (file)"]);
    expect(new Set(codes(r.errors))).toEqual(new Set(["FILE_UNEXPECTED"]));
  });

  it("checks dated names (FILE_NAME), file dates (DATE_MISMATCH) and unparsable files (SCHEMA)", () => {
    const dir = freshDir({ "briefs/latest.json": {}, "metrics/2026-02-30.json": {}, "status/2026-11-08.json": statusFile(D2, null), "metrics/inputs/2026-11-08.json": "{ nope" });
    const r = validateAll(dir, { config });
    expect(r.errors.map((i) => `${i.code} ${i.path}`)).toEqual([
      "FILE_NAME briefs/latest.json: (file)",
      "FILE_NAME metrics/2026-02-30.json: (file)",
      "SCHEMA metrics/inputs/2026-11-08.json: (file)",
      "DATE_MISMATCH status/2026-11-08.json: date",
    ]);
  });

  it("a brief without its metrics and status files: XREF_UNRESOLVED and GAP_MATCH", () => {
    const b = brief(D1);
    const files = content([b]);
    delete files[`metrics/${D1}.json`];
    delete files[`status/${D1}.json`];
    const r = validateAll(freshDir(files), { config, rules: [] });
    expect(r.errors.map((i) => `${i.code} ${i.path}`)).toEqual([
      `GAP_MATCH briefs/${D1}.json: gap`,
      `XREF_UNRESOLVED briefs/${D1}.json: (root)`,
      `XREF_UNRESOLVED briefs/${D1}.json: (root)`,
    ]);
  });

  it("downgrades list-based safety errors on every brief but the one being published", () => {
    const rule = defineRule({
      code: ["NO_EXPLOIT_LINK", "SECRET_LIKE"], scope: "brief", dataOnly: true,
      check: () => [error("NO_EXPLOIT_LINK", "sources[0].url", "SAMPLE blocked host"), error("SECRET_LIKE", "lead", "SAMPLE pattern")],
    });
    const dir = freshDir(content([brief(D1), brief(D2)]));
    const publishing = validateAll(dir, { config, rules: [rule], publishing: D2, perFile: true });
    const of = (file: string) => publishing.files.find((f) => f.file === file)!;
    expect(codes(of(`briefs/${D1}.json`).errors)).toEqual(["SECRET_LIKE"]);
    expect(codes(of(`briefs/${D1}.json`).warnings)).toEqual(["NO_EXPLOIT_LINK"]);
    expect(codes(of(`briefs/${D2}.json`).errors)).toEqual(["NO_EXPLOIT_LINK", "SECRET_LIKE"]);
    const ci = validateAll(dir, { config, rules: [rule] });
    expect(codes(ci.errors)).toEqual(["SECRET_LIKE", "SECRET_LIKE"]);
    expect(codes(ci.warnings)).toEqual(["NO_EXPLOIT_LINK", "NO_EXPLOIT_LINK"]);
  });

  it("passes the publishing flag, the inputs manifest and every brief to the rules", () => {
    const seen: string[] = [];
    const probe = defineRule({
      code: "TEST_PROBE", scope: "all", dataOnly: true,
      check: (i) => { seen.push(`${i.date} ${i.crossFile!.publishing} ${i.crossFile!.inputs?.date} ${i.crossFile!.briefs.length}`); return []; },
    });
    validateAll(freshDir(content([brief(D1), brief(D2)])), { config, rules: [probe], publishing: D2 });
    expect(seen).toEqual([`${D1} false ${D1} 2`, `${D2} true ${D2} 2`]);
  });

  it("XREF_FIRST_SEEN and XREF_KIND across briefs", () => {
    const b1 = brief(D1, { items: [item(D1, "pol-sample-rule")], computed: { word_count: 0, reading_minutes: 0, item_count: 1, ai_linked: { linked: 0, total: 1 }, source_count: 1, publisher_count: 1 } });
    const b2 = brief(D2, { items: [item(D2, "pol-sample-rule", { kind: "ecosystem" })] });
    const r = validateAll(freshDir(content([b1, b2])), { config, rules: [] });
    expect(r.errors.map((i) => `${i.code} ${i.path}`)).toEqual([
      `XREF_FIRST_SEEN briefs/${D2}.json: items[0].first_seen`,
      `XREF_KIND briefs/${D2}.json: items[0].kind`,
    ]);
  });

  it("XREF_STATUS: the status file's final edition and publish time against the brief", () => {
    const b = brief(D1);
    const r = validateAll(freshDir(content([b], { [`status/${D1}.json`]: statusFile(D1, { edition: "full", published_at: at(D1, "05:00:00") }) })), { config, rules: [] });
    expect(r.errors.map((i) => `${i.code} ${i.path}`)).toEqual([
      `XREF_STATUS status/${D1}.json: runs[0].edition`,
      `XREF_STATUS status/${D1}.json: runs`,
    ]);
    const noBrief = validateAll(freshDir({ [`status/${D2}.json`]: statusFile(D2, { edition: "data_only", published_at: at(D2, "04:44:52") }) }), { config });
    expect(codes(noBrief.errors)).toEqual(["XREF_STATUS"]);
    const failedRun = validateAll(freshDir({ [`status/${D2}.json`]: statusFile(D2, null) }), { config });
    expect(failedRun.ok).toBe(true);
  });

  it("XREF_ARCHIVE and FILE_ORDER on archive-index.json", () => {
    const b1 = brief(D1);
    const b2 = brief(D2);
    const wrong = archiveFor([b1, b2]);
    wrong.editions.reverse();
    wrong.editions[0]!.edition = "full";
    const r = validateAll(freshDir(content([b1, b2], { "archive-index.json": wrong })), { config, rules: [] });
    expect(r.errors.map((i) => `${i.code} ${i.path}`)).toEqual([
      "XREF_ARCHIVE archive-index.json: editions[0]",
      "FILE_ORDER archive-index.json: editions[1]",
    ]);
    const files = content([b1]);
    delete files["archive-index.json"];
    expect(codes(validateAll(freshDir(files), { config, rules: [] }).errors)).toEqual(["XREF_ARCHIVE"]);
    const missing = archiveFor([b1]);
    expect(codes(validateAll(freshDir(content([b1, b2], { "archive-index.json": missing })), { config, rules: [] }).errors)).toEqual(["XREF_ARCHIVE"]);
  });

  it("corrections: unknown targets, ids, order and withholds", () => {
    const b1 = brief(D1, { items: [item(D1, "pol-sample-rule")], computed: { word_count: 0, reading_minutes: 0, item_count: 1, ai_linked: { linked: 0, total: 1 }, source_count: 1, publisher_count: 1 } });
    const cf = (corrections: Correction[]) => content([b1], { "corrections.json": CorrectionsFile.parse({ schema_version: 1, corrections, disputes: [] }) });
    const clean = validateAll(freshDir(cf([correction(1), correction(2)])), { config, rules: [] });
    expect(clean.errors).toEqual([]);
    const bad = validateAll(freshDir(cf([
      correction(1, { item_id: "pol-other" }),
      correction(3, { edition_date: "2026-10-01" }),
      correction(2, { date: D1, type: "name_removed", before: "[name removed]" }),
    ])), { config, rules: [] });
    expect(bad.errors.map((i) => `${i.code} ${i.path}`)).toEqual([
      "XREF_UNRESOLVED corrections.json: corrections[0].item_id",
      "XREF_UNRESOLVED corrections.json: corrections[1].edition_date",
      "XREF_CORRECTION corrections.json: corrections[2]",
      "FILE_ORDER corrections.json: corrections[2]",
    ]);
    const gap = validateAll(freshDir(cf([correction(1), correction(3)])), { config, rules: [] });
    expect(gap.errors.map((i) => `${i.code} ${i.path}`)).toEqual(["XREF_CORRECTION corrections.json: corrections"]);
  });

  it("claim ids must be in config/claims.json (XREF_UNRESOLVED) and the Scoreboard sorted (FILE_ORDER)", () => {
    const sb = ScoreboardFile.parse({
      schema_version: 1, as_of: D2, claims_version: 1, entries: [],
      claims: ["SB-02", "SB-01"].map((id) => ({ id, text: "SAMPLE claim", status: "open", zone: "no_reading", reading: null, reading_text: null, reading_as_of: null, last_entry_id: null })),
    });
    const r = validateAll(freshDir(content([brief(D1)], { "scoreboard.json": sb })), { config: { ...config, claims: { ...config.claims, claims: [] } }, rules: [] });
    expect(r.errors.map((i) => `${i.code} ${i.path}`)).toEqual([
      "XREF_UNRESOLVED scoreboard.json: claims[0].id",
      "XREF_UNRESOLVED scoreboard.json: claims[1].id",
      "FILE_ORDER scoreboard.json: claims[1]",
    ]);
  });

  it("MANIFEST_MISMATCH: a metrics file needs its manifest, and its counts must match it", () => {
    const files = content([brief(D1)]);
    delete files[`metrics/inputs/${D1}.json`];
    expect(validateAll(freshDir(files), { config, rules: [] }).errors.map((i) => `${i.code} ${i.path}`))
      .toEqual([`MANIFEST_MISMATCH metrics/${D1}.json: provenance.inputs_file`]);
    const m = metricsFile(D1);
    m.blocks.kev = { status: "ok", as_of: cutoff(D1), note: null };
    m.kev = { catalog_version: "2026.11.06", catalog_count: 2, date_released: at(cutoff(D1), "03:00:00"), new_since_last_edition: { since_catalog_version: null, cve_ids: ["CVE-2099-0001", "CVE-2099-0002"] } };
    const inp = inputsFile(D1);
    expect(manifestIssues(m, inp).map((i) => i.path)).toEqual(["kev.new_since_last_edition.cve_ids"]);
    inp.kev_new = ["CVE-2099-0002", "CVE-2099-0001"];
    expect(manifestIssues(m, inp)).toEqual([]);
  });
});

// ── Readers ──────────────────────────────────────────────────────────────────────────────────────

const SAMPLE_RECORD = {
  dataType: "CVE_RECORD", dataVersion: "5.1",
  cveMetadata: { cveId: "CVE-2099-0001", state: "PUBLISHED", assignerShortName: "sample-cna", datePublished: "2099-01-02T03:04:05.000Z", dateUpdated: "2099-01-03T00:00:00.000Z" },
  containers: {
    cna: {
      title: "SAMPLE flaw in a sample product",
      descriptions: [{ lang: "en", value: "SAMPLE description." }],
      affected: [{ vendor: "SAMPLE Vendor", product: "SAMPLE Product" }, { vendor: "SAMPLE Vendor", product: "SAMPLE Other" }],
      references: [{ url: "https://example.org/sample/advisory", tags: ["vendor-advisory"] }],
      credits: [{ lang: "en", type: "finder", value: "SAMPLE researcher" }],
    },
    adp: [{
      providerMetadata: { shortName: "CISA-ADP" },
      metrics: [{ other: { type: "kev", content: { dateAdded: "2099-01-04", reference: "https://example.org/sample/kev" } } }],
      references: [{ url: "https://example.org/sample/writeup", tags: ["exploit"] }],
    }],
  },
};

describe("readers", () => {
  it("cveRecordInfo reads a CVE JSON 5 record and a rejected one", () => {
    expect(cveRecordInfo(SAMPLE_RECORD)).toEqual({
      cve_id: "CVE-2099-0001", state: "PUBLISHED", date_published: "2099-01-02", date_updated: "2099-01-03", assigner: "sample-cna",
      vendors: ["SAMPLE Vendor"], products: ["SAMPLE Product", "SAMPLE Other"], title: "SAMPLE flaw in a sample product",
      exploit_reference: true, kev_date_added: "2099-01-04", credits: ["SAMPLE researcher"],
    });
    const rejected = cveRecordInfo({ cveMetadata: { cveId: "CVE-2099-0002", state: "REJECTED" }, containers: { cna: { rejectedReasons: [] } } });
    expect(rejected).toMatchObject({ cve_id: "CVE-2099-0002", state: "REJECTED", title: null, vendors: [], exploit_reference: false });
    expect(cveRecordInfo({ not: "a record" })).toBeNull();
  });

  it("cveRecordInfo takes UTC dates of offset timestamps across midnight, and null for unreadable ones", () => {
    const withDates = (datePublished: unknown, dateUpdated: unknown) =>
      cveRecordInfo({ ...SAMPLE_RECORD, cveMetadata: { ...SAMPLE_RECORD.cveMetadata, datePublished, dateUpdated } });
    expect(withDates("2026-11-07T05:00:00+08:00", "2026-11-06T20:30:00-05:00")).toMatchObject({
      date_published: "2026-11-06", date_updated: "2026-11-07",
    });
    expect(withDates("2026-11-07T05:00:00.123Z", "2026-11-07T23:59:59")).toMatchObject({
      date_published: "2026-11-07", date_updated: "2026-11-07",
    });
    expect(withDates("2026-11-07", "not a date")).toMatchObject({ date_published: "2026-11-07", date_updated: null });
    expect(withDates("2026-02-30T01:00:00Z", 42)).toMatchObject({ date_published: null, date_updated: null });
  });

  it("cveLookupFromDir reads records lazily, any case, and misses unknown ids", () => {
    const dir = freshDir({ "CVE-2099-0001.json": SAMPLE_RECORD, "CVE-2099-0003.json": "{ broken" });
    const lookup = cveLookupFromDir(dir);
    expect(lookup.get("cve-2099-0001")?.state).toBe("PUBLISHED");
    expect(lookup.get("CVE-2099-0003")).toBeUndefined();
    expect(lookup.get("CVE-2099-9999")).toBeUndefined();
    expect(lookup.get("../CVE-2099-0001")).toBeUndefined();
    expect(() => cveLookupFromDir(path.join(tmp, "no-records"))).toThrow();
  });

  it("packDatesOf keys normalised URLs; RegionsInputFile drops a stray config", () => {
    const pack = Pack.parse({
      schema_version: 1, date: D2, window: { start: at(D1, "04:30:00"), end: at(D2, "04:30:00") }, generated_at: at(D2, "04:35:00"),
      data_cutoff_utc: cutoff(D2), degraded: false, feeds: [], items: [], records: [], injection_flags: 0,
    });
    expect(packDatesOf(pack)).toEqual({});
    const dates = packDatesOf({
      items: [{ url: "https://www.example.org/sample/a/?utm_source=x", published_at: "2026-11-08T01:00:00Z" }] as Pack["items"],
      records: [{ url: "https://example.org/sample/a", date: "2026-11-07" }, { url: "https://example.org/sample/b", date: "2026-11-07" }] as Pack["records"],
    });
    expect(dates).toEqual({ "https://example.org/sample/a": "2026-11-08T01:00:00Z", "https://example.org/sample/b": "2026-11-07" });
    const parsed = RegionsInputFile.parse({ date: D2, history: [], signals: [], kevIndex: { entries: [] }, config: { ignored: true } });
    expect(parsed).toEqual({ date: D2, history: [], signals: [], kevIndex: { entries: [] } });
  });
});

// ── Shared definitions ───────────────────────────────────────────────────────────────────────────

describe("shared definitions", () => {
  const withEverything = () => DraftBrief.parse(rawDraft({
    items: [draftItem("inc-sample-breach", {
      kind: "breach", severity: "watch", summary: "SAMPLE summary, claimed by SAMPLE Group, unverified.",
      incident: { victim: null, description: "a SAMPLE retailer", sector: "retail", country: "TW", impact: "SAMPLE impact", disruption: false, status: "claimed", claimed_by: "SAMPLE Group", status_source_ids: ["s2"] },
      attribution: [{ attributed_by: "SAMPLE Lab", basis: "vendor", actor_name_as_used: "SAMPLE-77", sponsor_claimed: null, nexus: "unknown", confidence_text: "SAMPLE words", confidence_level: "unstated", date: D1, source_id: "s1" }],
      exposure: { text: "SAMPLE exposure", source_id: "s2" },
    })],
    region_raises: [{ region: "TW", reason: "SAMPLE raise", trigger_class: "victim_in_region", item_ids: ["inc-sample-breach"] }],
    elsewhere: [{ title: "SAMPLE elsewhere", source_id: "s2" }],
  }));

  it("walks prose, quoted and title fields with paths dropUnverified() reads", () => {
    const d = withEverything();
    expect(proseFields(d).map((f) => f.path)).toEqual([
      "lead[0].text", "angle.text", "angle.counterpoint", "items[0].headline", "items[0].summary", "items[0].exposure.text",
      "items[0].incident.impact", "items[0].incident.description", "region_raises[0].reason", "taiwan_lens.analysis",
    ]);
    expect(proseFields(d).find((f) => f.path === "items[0].summary")).toMatchObject({ field: "items[].summary", item: 0 });
    expect(quotedFields(d).map((f) => f.path)).toEqual(["items[0].attribution[0].confidence_text"]);
    expect(titleFields(d).map((f) => f.path)).toEqual(["sources[0].title", "sources[1].title", "elsewhere[0].title"]);
  });

  it("walks every source-id field and item reference", () => {
    const d = withEverything();
    expect(sourceIdFields(d).map((r) => `${r.path}=${r.id}`)).toEqual([
      "items[0].source_ids[0]=s1", "items[0].attribution[0].source_id=s1", "items[0].incident.status_source_ids[0]=s2",
      "items[0].exposure.source_id=s2", "angle.source_id=s1", "elsewhere[0].source_id=s2",
    ]);
    expect(itemIdFields(d).map((r) => r.path)).toEqual(["region_raises[0].item_ids[0]"]);
    const strings = allStrings({ a: ["x", { b: "y" }], c: 1 });
    expect(strings).toEqual([{ path: "a[0]", text: "x" }, { path: "a[1].b", text: "y" }]);
  });

  it("reads a Brief's raises and Scoreboard entries from their own places", () => {
    const b = brief(D1);
    b.regions.rows[2]!.raised = { from: "baseline", to: "elevated", reason: "SAMPLE raise", trigger_class: "campaign_target", item_ids: ["x"] };
    expect(proseFields(b).map((f) => f.path)).toContain("regions.rows[2].raised.reason");
    expect(itemIdFields(b).map((r) => r.path)).toEqual(["regions.rows[2].raised.item_ids[0]"]);
  });

  it("folds publishers: same publisher, or titles with Jaccard ≥ 0.8", () => {
    const sources = new Map([
      ["s1", { ...draftSource(1), title: "SAMPLE vendor patches router flaw under attack" }],
      ["s2", { ...draftSource(2), title: "SAMPLE vendor patches router flaw under attack now" }],
      ["s3", { ...draftSource(3), title: "SAMPLE unrelated story" }],
    ]);
    const views = new Map([
      ["s1", { tier: 2 as const, publisher: "wire-a", publisher_name: "A", state_label: null, kind: null, sole_newsroom_for_critical: null }],
      ["s2", { tier: 2 as const, publisher: "paper-b", publisher_name: "B", state_label: null, kind: null, sole_newsroom_for_critical: null }],
      ["s3", { tier: 1 as const, publisher: "agency-c", publisher_name: "C", state_label: null, kind: null, sole_newsroom_for_critical: null }],
    ]);
    const p = publishersOfItem({ source_ids: ["s1", "s2", "s3", "s1"] }, sources, views);
    expect(p.distinct).toEqual(["wire-a", "paper-b", "agency-c"]);
    expect(p.groups).toEqual([
      { publishers: ["wire-a", "paper-b"], source_ids: ["s1", "s2"], tier: 2 },
      { publishers: ["agency-c"], source_ids: ["s3"], tier: 1 },
    ]);
  });

  it("derive() reads frozen fields in published mode and publisherFor() in draft mode", () => {
    const b = brief(D1, { sources: [source(1, { url: "https://www.cisa.gov/ct-sample/x", publisher: "host:frozen.example", publisher_name: "Frozen", tier: 2 })] });
    expect(derive(b, "published", config).publisherBySourceId.get("s1")).toMatchObject({ publisher: "host:frozen.example", tier: 2, kind: null });
    expect(derive(b, "draft", config).publisherBySourceId.get("s1")!.publisher).not.toBe("host:frozen.example");
  });

  it("known names: finder names split, case-sensitive word-boundary matches through any form", () => {
    expect(finderNames({ name: "Anthropic: Claude, Claude Mythos, Project Glasswing" })).toEqual(["Anthropic", "Claude", "Claude Mythos", "Project Glasswing"]);
    expect(finderNames({ name: "OpenAI: ChatGPT used by a researcher" })).toEqual(["OpenAI", "ChatGPT"]);
    expect(finderNames({ name: "DARPA AIxCC systems (Team Atlanta, Buttercup, RoboDuck)" })).toEqual(["DARPA AIxCC", "Team Atlanta", "Buttercup", "RoboDuck"]);
    expect(finderNames({ name: "Other credits that say AI or an LLM was used" })).toEqual([]);
    const names = knownNames(config, withEverything().items);
    const actor = names.find((n) => n.source === "actor" && n.forms.length > 1)!;
    expect(nameMatches(`SAMPLE: ${actor.forms[1]} struck again.`, actor)).toBe(true);
    expect(nameMatches(`SAMPLE: ${actor.forms[1]!.toLowerCase()} struck again.`, actor)).toBe(actor.forms[1] === actor.forms[1]!.toLowerCase());
    expect(nameMatches("SAMPLE: Claude-like", { forms: ["Claude"] })).toBe(true);
    expect(nameMatches("SAMPLE: Claudes", { forms: ["Claude"] })).toBe(false);
    expect(names.filter((n) => n.id === null).map((n) => `${n.source}:${n.name}`)).toEqual([
      "claimant:SAMPLE Group", "attributor:SAMPLE Lab", "actor_as_used:SAMPLE-77",
    ]);
  });
});

// ── The CLI ──────────────────────────────────────────────────────────────────────────────────────

function cli(...argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = cliMain(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("scripts/validate.ts", () => {
  /** A draft and every input file it needs, in a temporary folder, named for 2099 so no default path exists. */
  function draftFiles(date = "2099-01-05") {
    const dir = freshDir({
      [`${date}.json`]: rawDraft({ date }),
      "context.json": context(date),
      "evidence.json": { urls: [], fetched: [], texts: {}, seen_as: {} },
      "metrics.json": metricsFile(date),
      "records/CVE-2099-0001.json": SAMPLE_RECORD,
      "regions.json": { date, history: [], signals: [], kevIndex: { entries: [] } },
      "pack.json": {
        schema_version: 1, date, window: { start: at(addDays(date, -1), "04:30:00"), end: at(date, "04:30:00") }, generated_at: at(date, "04:35:00"),
        data_cutoff_utc: cutoff(date), degraded: false, feeds: [], items: [], records: [], injection_flags: 0,
      },
    });
    const f = (name: string) => path.join(dir, name);
    const flags = ["--context", f("context.json"), "--evidence", f("evidence.json"), "--metrics", f("metrics.json"), "--cve-cache", f("records"),
      "--regions-input", f("regions.json"), "--pack", f("pack.json")];
    return { dir, file: f(`${date}.json`), f, flags };
  }

  it("usage errors exit 2 with the usage text", () => {
    for (const argv of [[], ["--bogus"], ["a.json", "b.json"], ["--all", "a", "b"], ["--all", "--context", "x.json"], ["--all", "--published"]]) {
      const r = cli(...argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err).toContain("Usage:");
    }
    const { file, f } = draftFiles();
    const pub = cli(file, "--published", "--context", f("context.json"));
    expect(pub.code).toBe(2);
    expect(pub.err).toContain("--published reads only --metrics");
  });

  it("a missing or unreadable input is a usage error naming its flag; drafts/context.json is refused", () => {
    const { file, flags, f } = draftFiles();
    const noPack = cli(file, ...flags.slice(0, -2));
    expect(noPack.code).toBe(2);
    expect(noPack.err).toContain("Missing input for --pack");
    const badEvidence = cli(file, ...flags.map((x) => (x === f("evidence.json") ? f("metrics.json") : x)));
    expect(badEvidence.code).toBe(2);
    expect(badEvidence.err).toContain("--evidence:");
    const agentCopy = cli(file, ...flags.map((x) => (x === f("context.json") ? "drafts/context.json" : x)));
    expect(agentCopy.code).toBe(2);
    expect(agentCopy.err).toContain("drafts/context.json");
    expect(cli(path.join(tmp, "missing.json")).code).toBe(2);
  });

  it("validates a draft with every input and prints the issue lines and the summary", () => {
    const { file, flags } = draftFiles();
    const r = cli(file, ...flags);
    expect(r.code).not.toBe(2);
    const lines = r.out.split("\n");
    expect(lines.at(-1)).toMatch(new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: \\d+ errors?, \\d+ warnings?\\.$`));
    for (const l of lines.slice(0, -1)) expect(l).toMatch(/^(ERROR|WARN) [A-Z][A-Z0-9_]* \S.*: /);
    const json = cli(file, ...flags, "--json");
    const parsed = JSON.parse(json.out) as { ok: boolean; errors: unknown[]; warnings: unknown[] };
    expect(typeof parsed.ok).toBe("boolean");
    expect(json.code).toBe(parsed.ok ? 0 : 1);
  });

  it("an unparsable draft is one SCHEMA error, exit 1", () => {
    const dir = freshDir({ "2099-01-05.json": "{ not json" });
    const r = cli(path.join(dir, "2099-01-05.json"), "--json");
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out) as { ok: boolean; errors: { code: string; path: string }[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.map((e) => `${e.code} ${e.path}`)).toEqual(["SCHEMA (file)"]);
  });

  it("--published validates a brief with its metrics", () => {
    const dir = freshDir({ [`${D1}.json`]: brief(D1), "m.json": metricsFile(D1) });
    const r = cli(path.join(dir, `${D1}.json`), "--published", "--metrics", path.join(dir, "m.json"));
    expect(r.code).not.toBe(2);
    expect(r.out.split("\n").at(-1)).toMatch(/: \d+ errors?, \d+ warnings?\.$/);
  });

  it("--all: 0 on an empty folder, 1 on a stray file", () => {
    const empty = cli("--all", freshDir());
    expect(empty.code).toBe(0);
    expect(empty.out).toMatch(/: 0 errors, 0 warnings\.$/);
    const stray = cli("--all", freshDir({ "stray.txt": "SAMPLE" }));
    expect(stray.code).toBe(1);
    expect(stray.out.split("\n")[0]).toMatch(/^ERROR FILE_UNEXPECTED stray\.txt: \(file\): /);
    const json = cli("--all", freshDir({ "stray.txt": "SAMPLE" }), "--json");
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, warnings: [] });
  });
});
