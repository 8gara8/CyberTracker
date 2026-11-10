import { z } from "zod";
import { SHARE_DIRECTIONS, SPEED_DIRECTIONS } from "../vocab";
import {
  AiCreditRule, BlockStatus, CommitSha, ConfigId, Count, CreditField, CveId, FinderFamily, FinderKind, Fraction, Interval,
  IsoDate, IsoTimestamp, MetricPath, PublishedAt, Ransomware, Sha256,
} from "./common";

// The metrics file, the inputs manifest and the state files (SPEC §4.7). All S: computed by
// scripts/metrics.ts and scripts/backfill.ts from feeds alone. §5 defines each value.

export const ShareDirection = z.enum(SHARE_DIRECTIONS);
export const SpeedDirection = z.enum(SPEED_DIRECTIONS);
export const SERIES_WEEKS = 104;

export const Provenance = z.strictObject({
  kev_catalog_version: z.string().min(1).describe('e.g. "2026.11.06"'),
  kev_count: Count,
  kev_date_released: IsoTimestamp,
  cve_list_release: z.string().min(1).describe('Newest CVE List V5 hourly tag read, e.g. "cve_2026-11-06_2100Z"'),
  cve_list_commit: CommitSha,
  kev_data_commit: CommitSha.nullable().describe("null when the cisa.gov fallback was used"),
  epss_model_version: z.string().min(1).describe('e.g. "v2025.03.14"'),
  epss_date: IsoDate,
  ghsa_source: z.enum(["git", "rest"]),
  ghsa_commit: CommitSha.nullable(),
  config_versions: z.strictObject({ vendors: Count, ai_finders: Count, source_tiers: Count, regions: Count, actors: Count }),
  reference: z.strictObject({ from: z.literal("2023-01-01"), to: z.literal("2024-12-31") }),
  inputs_file: z.string().regex(/^metrics\/inputs\/\d{4}-\d{2}-\d{2}\.json$/, { error: 'Expected "metrics/inputs/YYYY-MM-DD.json"' }),
  inputs_sha256: Sha256,
});

export const MetricsBlock = z.strictObject({
  status: BlockStatus,
  as_of: IsoDate.nullable(),
  note: z.string().min(1).max(200).nullable().describe("Fixed templates only"),
});

export const GapHeadline = z.strictObject({
  text: z.string().min(1).describe("At most 70 words, from the §5.8 template"),
  second_line: z.string().min(1).describe("At most 40 words: the Flood and the AI-credited count"),
  at_disclosure_direction: ShareDirection,
  after_disclosure_direction: SpeedDirection,
  quoted: z.array(z.strictObject({ path: MetricPath, display: z.string().min(1) }))
    .describe('Every number in text and second_line, as shown, with its path, e.g. { path: "window.w26.at_disclosure_share", display: "37%" }'),
});

const FloodYearAgo = z.strictObject({ from: IsoDate, to: IsoDate, n: Count, kernel_n: Count, ex_kernel_n: Count });

export const Flood = z.strictObject({
  from: IsoDate,
  to: IsoDate,
  n: Count,
  kernel_n: Count,
  ex_kernel_n: Count,
  unscored_n: Count,
  year_ago: FloodYearAgo,
  yoy_pct: z.number().nullable(),
  yoy_ex_kernel_pct: z.number().nullable(),
  reference: z.strictObject({ w13_mean_n: z.number().min(0), w13_mean_ex_kernel_n: z.number().min(0) }),
  vs_reference_pct: z.number(),
  vs_reference_ex_kernel_pct: z.number(),
  vs_reference_ratio: z.number().min(0),
  vs_reference_ex_kernel_ratio: z.number().min(0),
  last_week: z.strictObject({ week_start: IsoDate, n: Count, kernel_n: Count, unscored_n: Count }),
});

/** One window of KEV additions joined to their CVE records (§5.3). */
export const WindowStats = z.strictObject({
  from: IsoDate,
  to: IsoDate,
  kev_added_n: Count,
  unjoined_n: Count,
  cohort_n: Count,
  old_listed_n: Count,
  at_disclosure_n: Count,
  at_disclosure_share: Fraction.nullable(),
  at_disclosure_ci80: Interval.nullable(),
  n_day_n: Count,
  after_disclosure_n: Count,
  after_disclosure_median_days: z.number().nullable(),
  after_disclosure_median_ci80: Interval.nullable(),
  k7_n: Count,
  p7: Fraction.nullable(),
  p7_ci80: Interval.nullable(),
});

/** The Window, one of the Gap's three panels (SPEC's `Window`; renamed so it never shadows the DOM type). */
export const GapWindow = z.strictObject({
  w26: WindowStats,
  w13: WindowStats,
  reference: WindowStats,
  reference_pace_26w: z.number().min(0),
  volume_ratio: z.number().min(0),
  kev_pace_ratio: z.number().min(0),
});

export const FamilyCounts = z.strictObject({ anthropic: Count, openai: Count, google: Count, other: Count });

export const AiCredited = z.strictObject({
  finders_version: Count,
  from: IsoDate,
  to: IsoDate,
  w13: z.strictObject({
    total: Count,
    by_family: FamilyCounts,
    ex_anthropic: Count,
    ledger_only_anthropic: Count,
  }),
  provisional_from: IsoDate,
  in_kev: z.strictObject({
    since: z.literal("2025-01-01"),
    n: Count,
    entries: z.array(z.strictObject({
      cve_id: CveId,
      finder_id: ConfigId,
      family: FinderFamily,
      kev_date_added: IsoDate,
      matched: z.string().min(1).max(120),
    })),
  }),
});

/** For the rival claim on AI-found flaws reaching KEV (§4.9, §5.5). */
export const BaseRate = z.strictObject({
  since: z.literal("2025-01-01"),
  to_published: IsoDate,
  to: IsoDate,
  follow_up_days: z.literal(90),
  ai_credited_n: Count,
  ai_credited_in_kev_n: Count,
  ai_rate: Fraction.nullable(),
  all_n: Count,
  all_in_kev_n: Count,
  all_rate: Fraction.nullable(),
  expected: z.number().min(0),
  ratio: z.number().min(0).nullable(),
  ratio_ci80: Interval.nullable(),
});

export const FixSide = z.strictObject({
  anthropic_cvd: z.strictObject({
    status: BlockStatus,
    revision: z.string().min(1),
    as_of: IsoDate,
    fetched_at: IsoTimestamp,
    found_n: Count.nullable(),
    disclosed_n: Count.nullable(),
    patched_n: Count.nullable(),
    source_url: z.string().min(1),
  }).nullable(),
  ghsa_unfixed: z.strictObject({
    share: Fraction.nullable().describe("n_unfixed / n_total, round4; null when n_total < MIN_N"),
    n_unfixed: Count,
    n_total: Count,
    from: IsoDate,
    to: IsoDate,
    as_of: IsoDate,
  }).nullable(),
});

export const KevSummary = z.strictObject({
  catalog_version: z.string().min(1),
  catalog_count: Count,
  date_released: IsoTimestamp,
  new_since_last_edition: z.strictObject({
    since_catalog_version: z.string().min(1).nullable(),
    cve_ids: z.array(CveId).describe("KEV order, newest last"),
  }),
});

export const HomeVendorRow = z.strictObject({ cve_id: CveId, vendor_id: ConfigId, date_added: IsoDate });

/** KEV additions whose vendor's country is TW (or JP). */
export const HomeVendorKev = z.strictObject({
  to: IsoDate,
  d30_from: IsoDate,
  d30_n: Count,
  d90_from: IsoDate,
  d90_n: Count,
  cve_ids_90: z.array(HomeVendorRow),
});

export const EpssMover = z.strictObject({
  cve_id: CveId,
  score: Fraction,
  delta_7d: z.number().min(-1).max(1),
  percentile: Fraction,
});

const SERIES_ALIGNED = [
  "flood_n13", "flood_n13_kernel", "flood_n13_year_ago", "window_at_disclosure_share", "window_at_disclosure_ci80",
  "window_after_median", "window_after_median_ci80", "window_cohort_n", "kev_recent_weekly", "kev_weekly", "ai_ledger_only_weekly",
] as const;

const seriesFields = {
  weeks: z.array(IsoDate).describe("ISO-week Mondays, oldest first; the last is the newest complete week"),
  live_from: IsoDate.describe("First week computed by daily runs; earlier weeks came from the backfill"),
  flood_n13: z.array(Count),
  flood_n13_kernel: z.array(Count),
  flood_n13_year_ago: z.array(Count.nullable()),
  window_at_disclosure_share: z.array(Fraction.nullable()),
  window_at_disclosure_ci80: z.array(Interval.nullable()),
  window_after_median: z.array(z.number().nullable()),
  window_after_median_ci80: z.array(Interval.nullable()),
  window_cohort_n: z.array(Count),
  kev_recent_weekly: z.array(Count),
  kev_weekly: z.array(Count),
  ai_weekly: z.strictObject({ anthropic: z.array(Count), openai: z.array(Count), google: z.array(Count), other: z.array(Count) }),
  ai_ledger_only_weekly: z.array(Count),
  data_only_weeks: z.array(IsoDate).describe("For reference only; no series depends on editions"),
};

/**
 * state/series.json reaches back to 2023-01-02, before the first full Flood window (week 2023-03-27) and
 * the first full Window (week 2023-06-26): there those three counts are null (§5.9). The 104 weeks of a
 * metrics file never reach that far, so `Series` keeps them non-null and seriesSlice() throws on a null.
 */
const seriesFileFields = {
  ...seriesFields,
  flood_n13: z.array(Count.nullable()),
  flood_n13_kernel: z.array(Count.nullable()),
  window_cohort_n: z.array(Count.nullable()),
};

type SeriesShape = z.infer<z.ZodObject<typeof seriesFields>> | z.infer<z.ZodObject<typeof seriesFileFields>>;
type Problem = { message: string; path: (string | number)[] };

/** Every per-week array has one value per entry of `weeks`, and the weeks ascend (Series and SeriesFile alike). */
function alignmentProblems(s: SeriesShape): Problem[] {
  const out: Problem[] = [];
  const n = s.weeks.length;
  for (const key of SERIES_ALIGNED) {
    if (s[key].length !== n) out.push({ message: `${key} has ${s[key].length} values for ${n} weeks`, path: [key] });
  }
  for (const fam of ["anthropic", "openai", "google", "other"] as const) {
    if (s.ai_weekly[fam].length !== n) out.push({ message: `ai_weekly.${fam} has ${s.ai_weekly[fam].length} values for ${n} weeks`, path: ["ai_weekly", fam] });
  }
  const i = s.weeks.findIndex((w, j) => j > 0 && w <= s.weeks[j - 1]!);
  if (i > 0) out.push({ message: "weeks must ascend with no repeats", path: ["weeks", i] });
  return out;
}

/** Weekly points on the shared two-year axis: exactly 104 weeks in a metrics file. */
export const Series = z.strictObject(seriesFields).superRefine((s, ctx) => {
  const problems = alignmentProblems(s);
  if (s.weeks.length !== SERIES_WEEKS) problems.unshift({ message: `weeks has ${s.weeks.length} entries; a metrics file carries ${SERIES_WEEKS}`, path: ["weeks"] });
  for (const p of problems) ctx.addIssue({ code: "custom", ...p });
});

/** content/metrics/D.json. */
export const Metrics = z.strictObject({
  schema_version: z.literal(1),
  date: IsoDate,
  generated_at: IsoTimestamp,
  data_cutoff_utc: IsoDate.describe("Edition date minus 2 days"),
  reconstructed: z.boolean(),
  code_commit: CommitSha,
  provenance: Provenance,
  blocks: z.strictObject({
    flood: MetricsBlock, window: MetricsBlock, ai_credited: MetricsBlock, fix_side: MetricsBlock, kev: MetricsBlock, home_vendors: MetricsBlock,
  }),
  headline: GapHeadline,
  flood: Flood.nullable(),
  window: GapWindow.nullable(),
  ai_credited: AiCredited.nullable(),
  base_rate: BaseRate.nullable(),
  fix_side: FixSide,
  kev: KevSummary.nullable(),
  home_vendors: z.strictObject({ tw: HomeVendorKev, jp: HomeVendorKev }).nullable(),
  epss_movers: z.array(EpssMover).max(5),
  series: Series,
});

// ── Inputs manifest ──────────────────────────────────────────────────────────────────────────────

export const WindowRow = z.strictObject({
  cve_id: CveId,
  kev_date_added: IsoDate,
  date_published: IsoDate.nullable(),
  lag_days: z.int().nullable(),
  band: z.enum(["at_disclosure", "n_day", "late", "old", "unjoined"]),
});

/** content/metrics/inputs/D.json: enough to audit every figure. */
export const InputsManifest = z.strictObject({
  schema_version: z.literal(1),
  date: IsoDate,
  data_cutoff_utc: IsoDate,
  generated_at: IsoTimestamp,
  code_commit: CommitSha,
  feeds: z.array(z.strictObject({
    id: ConfigId,
    as_of: PublishedAt,
    version: z.string().min(1).nullable(),
    sha256: Sha256,
    records: Count,
  })),
  window: z.strictObject({ w26: z.array(WindowRow), w13: z.array(WindowRow), reference_sha256: Sha256 }),
  kev_new: z.array(CveId),
  flood: z.strictObject({
    days: z.array(z.strictObject({ date: IsoDate, n: Count, kernel_n: Count, unscored_n: Count, ids_sha256: Sha256 })),
    new_days: z.array(z.strictObject({ date: IsoDate, ids: z.array(CveId) })),
  }),
  ai_credited: z.array(z.strictObject({
    id: z.string().min(1).describe("CVE or GHSA id"),
    published: IsoDate,
    finder_id: ConfigId,
    family: FinderFamily,
    kind: FinderKind,
    field: CreditField,
    matched: z.string().min(1).max(120),
    rule: AiCreditRule,
  })),
  home_vendors: z.strictObject({ tw: z.array(HomeVendorRow), jp: z.array(HomeVendorRow) }),
});

// ── State files (content/state/) ─────────────────────────────────────────────────────────────────
// Each has schema_version 1 and updated_at: the data_cutoff_utc it was written for, never the clock.
// Rows are tuples in the column order §4.7 gives. The row keys (`entries`, `days`, `matches`,
// `candidates`) are this file's choice; §4.7 names only the columns.

const stateHead = { schema_version: z.literal(1), updated_at: IsoDate };

/** [cve_id, date_added, vendor_project, product, date_published | null, assigner | null, ransomware] */
export const KevIndexRow = z.tuple([CveId, IsoDate, z.string(), z.string(), IsoDate.nullable(), z.string().min(1).nullable(), Ransomware]);
/** state/kev-index.json: every KEV entry. */
export const KevIndexFile = z.strictObject({ ...stateHead, catalog_version: z.string().min(1), entries: z.array(KevIndexRow) });

/**
 * [date, n, kernel_n, unscored_n, ids_sha256]. ids_sha256: SHA-256 of the day's counted CVE ids in
 * code-unit order joined by "\n" (sha256 of "" for a day with none), so the manifest can name any day's ids.
 */
export const DayRow = z.tuple([IsoDate, Count, Count, Count, Sha256]);
/** state/days.json: every UTC day since 2023-01-01, counted once. */
export const DaysFile = z.strictObject({ ...stateHead, days: z.array(DayRow) });

/** [id, date_published, finder_id, family, kind, field, matched, rule, first_matched] */
export const AiCreditRow = z.tuple([
  z.string().min(1), IsoDate, ConfigId, FinderFamily, FinderKind, CreditField, z.string().min(1).max(120), AiCreditRule, IsoDate,
]);
/** state/ai-credits.json: every AI-credit match. */
export const AiCreditsFile = z.strictObject({
  ...stateHead, finders_version: Count, finders_sha256: Sha256, matches: z.array(AiCreditRow),
});

/** [id, date_published, field, text]: the three credit fields only (a ledger id is never a candidate). */
export const CreditCandidateRow = z.tuple([z.string().min(1), IsoDate, z.enum(["cna.credits", "adp.credits", "ghsa.credits"]), z.string()]);
/** state/credit-candidates.json: every credit string that passes the ai-finders prefilter. */
export const CreditCandidatesFile = z.strictObject({
  ...stateHead, prefilter_sha256: Sha256, candidates: z.array(CreditCandidateRow),
});

/** state/anthropic-cvd.json: the last dashboard revision read, its figures and the ledger ids. Nulls before the first read. */
export const AnthropicCvdFile = z.strictObject({
  ...stateHead,
  revision: z.string().min(1).nullable(),
  as_of: IsoDate.nullable(),
  fetched_at: IsoTimestamp.nullable(),
  source_url: z.string().min(1).nullable(),
  found_n: Count.nullable(),
  disclosed_n: Count.nullable(),
  patched_n: Count.nullable(),
  ledger_ids: z.array(z.string().min(1)).describe("CVE and GHSA ids in the dashboard payload"),
});

/** state/series.json: the Series fields for every ISO week from 2023-01-02 (Flood and Window counts null before their first full window). */
export const SeriesFile = z.strictObject({ ...stateHead, ...seriesFileFields }).superRefine((s, ctx) => {
  for (const p of alignmentProblems(s)) ctx.addIssue({ code: "custom", ...p });
});

/** The six files of content/state/, in §4.7's order. */
export const STATE_FILES = ["kev-index.json", "days.json", "ai-credits.json", "credit-candidates.json", "anthropic-cvd.json", "series.json"] as const;
export type StateFileName = (typeof STATE_FILES)[number];

/** Each state file's schema, by file name (the validator, the metrics and the backfill read and write through these). */
export const STATE_SCHEMAS = {
  "kev-index.json": KevIndexFile,
  "days.json": DaysFile,
  "ai-credits.json": AiCreditsFile,
  "credit-candidates.json": CreditCandidatesFile,
  "anthropic-cvd.json": AnthropicCvdFile,
  "series.json": SeriesFile,
} as const satisfies Record<StateFileName, z.ZodType>;

/** True when `name` is one of the six state file names. */
export function isStateFileName(name: string): name is StateFileName {
  return (STATE_FILES as readonly string[]).includes(name);
}

export type ShareDirection = z.infer<typeof ShareDirection>;
export type SpeedDirection = z.infer<typeof SpeedDirection>;
export type Provenance = z.infer<typeof Provenance>;
export type MetricsBlock = z.infer<typeof MetricsBlock>;
export type GapHeadline = z.infer<typeof GapHeadline>;
export type Flood = z.infer<typeof Flood>;
export type WindowStats = z.infer<typeof WindowStats>;
export type GapWindow = z.infer<typeof GapWindow>;
export type FamilyCounts = z.infer<typeof FamilyCounts>;
export type AiCredited = z.infer<typeof AiCredited>;
export type BaseRate = z.infer<typeof BaseRate>;
export type FixSide = z.infer<typeof FixSide>;
export type KevSummary = z.infer<typeof KevSummary>;
export type HomeVendorRow = z.infer<typeof HomeVendorRow>;
export type HomeVendorKev = z.infer<typeof HomeVendorKev>;
export type EpssMover = z.infer<typeof EpssMover>;
export type Series = z.infer<typeof Series>;
export type Metrics = z.infer<typeof Metrics>;
export type WindowRow = z.infer<typeof WindowRow>;
export type InputsManifest = z.infer<typeof InputsManifest>;
export type KevIndexRow = z.infer<typeof KevIndexRow>;
export type KevIndexFile = z.infer<typeof KevIndexFile>;
export type DayRow = z.infer<typeof DayRow>;
export type DaysFile = z.infer<typeof DaysFile>;
export type AiCreditRow = z.infer<typeof AiCreditRow>;
export type AiCreditsFile = z.infer<typeof AiCreditsFile>;
export type CreditCandidateRow = z.infer<typeof CreditCandidateRow>;
export type CreditCandidatesFile = z.infer<typeof CreditCandidatesFile>;
export type AnthropicCvdFile = z.infer<typeof AnthropicCvdFile>;
export type SeriesFile = z.infer<typeof SeriesFile>;

/** The six state files as read or written in one run. */
export interface StateFiles {
  "kev-index.json": KevIndexFile;
  "days.json": DaysFile;
  "ai-credits.json": AiCreditsFile;
  "credit-candidates.json": CreditCandidatesFile;
  "anthropic-cvd.json": AnthropicCvdFile;
  "series.json": SeriesFile;
}
