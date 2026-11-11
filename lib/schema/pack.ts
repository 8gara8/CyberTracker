import { z } from "zod";
import {
  CommitSha, ConfigId, Count, Coverage, CveId, ID_PATTERNS, IsoDate, IsoTimestamp, Language, PublishedAt, PublisherId, RegionCode, Sha256,
  Tier, TimeWindow,
} from "./common";
import { Candidate } from "./context";
import { FeedStatus } from "./status";

// The daily source pack, `packs/D.json` (SPEC §4.14), written by scripts/collect.ts. Every string from
// outside the project has been through sanitize() (lib/sanitize.ts) before it lands here.

export const PACK_ITEMS_MAX = 200;
export const PACK_RECORDS_MAX = 400;

export const PackFlag = z.enum(["injection_like"]);
export const PackRecordSource = z.enum(["kev", "cvelist", "epss", "ghsa", "nvd", "twcert-tvn", "jpcert", "myjvn", "anthropic-cvd", "exchange-tw"]);

export const PackFeed = z.strictObject({
  id: ConfigId,
  kind: z.string().min(1),
  ok: z.boolean(),
  stale: z.boolean(),
  newest: z.string().min(1).nullable(),
  items_total: Count,
  items_kept: Count,
  error: z.string().min(1).nullable(),
  sha256: Sha256.nullable(),
});

export const PackItem = z.strictObject({
  id: z.string().regex(ID_PATTERNS.packItem, { error: 'Expected a pack item id like "p0001"' }),
  feed_id: ConfigId,
  outlet: z.string().min(1),
  publisher: PublisherId,
  tier: Tier,
  language: Language,
  region: RegionCode,
  coverage: z.array(Coverage).min(1),
  title: z.string().max(200).describe("Sanitised, in the original language"),
  snippet: z.string().max(300).describe("Sanitised"),
  url: z.string().min(1).describe("The item's own link, normalised"),
  published_at: IsoTimestamp.describe("UTC"),
  cve_ids: z.array(CveId).describe("Found in title or snippet"),
  alert: z.boolean().describe("URL matches an alert_patterns entry of a region whose agencies include its publisher"),
  flags: z.array(PackFlag),
  score: z.number(),
});

export const PackRecord = z.strictObject({
  id: z.string().regex(ID_PATTERNS.packRecord, { error: 'Expected a pack record id like "r0001"' }),
  source: PackRecordSource,
  record_id: z.string().min(1).describe("CVE, GHSA, JVNDB or TVN id, or a notice number"),
  url: z.string().min(1).describe("Canonical record page"),
  advisory_urls: z.array(z.string().min(1)).describe("Never exploit-tagged or blocked hosts"),
  title: z.string().max(200),
  text: z.string().max(1000),
  date: IsoDate.describe("Event date (KEV dateAdded is a US date)"),
  vendor: z.string().min(1).nullable(),
  product: z.string().min(1).nullable(),
  cve_ids: z.array(CveId),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  flags: z.array(PackFlag),
});

/** packs/D.json (gitignored). */
export const Pack = z.strictObject({
  schema_version: z.literal(1),
  date: IsoDate.describe("Taipei edition date"),
  window: TimeWindow.describe("(D - 1)T04:30:00+08:00 to DT04:30:00+08:00"),
  generated_at: IsoTimestamp,
  data_cutoff_utc: IsoDate,
  degraded: z.boolean(),
  feeds: z.array(PackFeed),
  items: z.array(PackItem).max(PACK_ITEMS_MAX).describe("News and agency headlines, sorted by score"),
  records: z.array(PackRecord).max(PACK_RECORDS_MAX).describe("Structured records relevant today"),
  injection_flags: Count,
});

// ── Collect's other outputs (SPEC §8.3 Outputs) ─────────────────────────────────────────────────
// cache/feeds/index.json and cache/feeds/inputs.json (gitignored), packs/D.candidates.json and
// logs/D.candidates.json. Each is written with jsonText(value, Schema) and parsed by its readers.

/** A feed's state in a run: lib/schema/status.ts FeedStatus. */
export const FeedState = FeedStatus;
/** The sources:check label (§8.10). */
export const CheckLabel = z.enum(["OK", "STALE", "NODATE", "FAIL", "SKIP"]);

/** One registry entry's outcome in a run. */
export const FeedIndexEntry = z.strictObject({
  id: ConfigId,
  kind: z.string().min(1),
  status: FeedStatus,
  label: CheckLabel,
  error_class: z.string().min(1).nullable(),
  url_used: z.string().min(1).nullable(),
  fallback_used: z.boolean(),
  newest: PublishedAt,
  items: Count,
  records: Count,
  version: z.string().min(1).nullable(),
  sha256: Sha256.nullable(),
  fetched_at: IsoTimestamp.nullable(),
  note: z.string().min(1).max(200).nullable().describe("A fixed template, never raw error text"),
});

/** cache/feeds/index.json: one row per registry entry, in registry order (`search` rows `skipped`). */
export const FeedIndexFile = z.strictObject({
  schema_version: z.literal(1),
  date: IsoDate,
  generated_at: IsoTimestamp,
  feeds: z.array(FeedIndexEntry),
});

/** One CVE List delta zip read. */
export const ZipRead = z.strictObject({
  tag: z.string().regex(/^cve_\d{4}-\d{2}-\d{2}_(?:at_end_of_day|\d{4}Z)$/, { error: 'Expected a tag like "cve_2026-10-12_at_end_of_day" or "cve_2026-10-13_2000Z"' }),
  asset: z.string().min(1),
  kind: z.enum(["end_of_day", "hourly"]),
  utc_day: IsoDate,
  sha256: Sha256,
  records: Count,
});

/**
 * One UTC day counted from the zips: [X's end-of-day asset, X + 1's end-of-day asset or an hourly asset (T's newest, or
 * T − 1's newest standing in for its end-of-day zip, §8.3)]. A day whose own end-of-day zip had a stand-in is never ok.
 */
export const DayRead = z.strictObject({
  date: IsoDate,
  zips: z.tuple([z.string().min(1), z.string().min(1)]),
  ok: z.boolean(),
});

/** cache/feeds/inputs.json: what collect read, handed to the metrics and the backfill (commits, zip tags, EPSS dates). */
export const CollectInputsFile = z.strictObject({
  schema_version: z.literal(1),
  date: IsoDate,
  data_cutoff_utc: IsoDate,
  generated_at: IsoTimestamp,
  run_utc_day: IsoDate,
  record_window: TimeWindow.describe('The pack window with both ends floored to the hour, as "Z" instants'),
  commits: z.strictObject({ cvelist: CommitSha.nullable(), kev_data: CommitSha.nullable(), ghsa: CommitSha.nullable() }),
  cvelist: z.strictObject({
    zips: z.array(ZipRead),
    days: z.array(DayRead),
    newest_hourly_tag: z.string().nullable(),
    delta_log_newest: IsoTimestamp.nullable(),
    by_id: z.strictObject({ fetched: z.array(CveId), not_found: z.array(CveId), over_cap: Count }),
  }),
  kev: z.strictObject({
    catalog_version: z.string().min(1),
    date_released: IsoTimestamp,
    count: Count,
    url_used: z.string().min(1),
    sha256: Sha256,
    fallback_used: z.boolean(),
  }).nullable(),
  epss: z.strictObject({
    source: z.enum(["csv", "api"]),
    model_version: z.string().min(1).nullable(),
    files: z.array(z.strictObject({ role: z.enum(["e", "e1", "e7"]), date: IsoDate, sha256: Sha256 })),
  }).nullable(),
  ghsa: z.strictObject({
    commit: CommitSha.nullable(),
    head_date: IsoDate.nullable(),
    months: z.array(z.string().regex(/^\d{4}\/\d{2}$/, { error: 'Expected a month as "YYYY/MM"' })),
    tree_sha256: Sha256.describe('SHA-256 of the sorted "<path> <blob oid>\\n" lines of the checked-out advisories'),
    advisories: Count,
  }).nullable(),
  anthropic_cvd: z.strictObject({
    revision: z.string().min(1),
    as_of: IsoDate,
    sha256: Sha256,
    fetched_at: IsoTimestamp,
    changed: z.boolean(),
  }).nullable(),
});

/** One candidate ranking cut: below the cap, merged into another candidate, or bundled into a release. */
export const CutEntry = z.strictObject({
  id: z.string().min(1),
  score: z.number(),
  reason: z.string().regex(/^(?:below_cap|merged:\S+|bundled:rel-\S+)$/, { error: 'Expected "below_cap", "merged:<id>" or "bundled:rel-<id>"' }),
  pack_ids: z.array(z.string()),
  cve_ids: z.array(CveId),
});

export const RankLogEntry = z.strictObject({
  code: z.enum(["CAP_KEV_OVERFLOW", "KEV_INDEX_MISSING", "KEV_ASOF_DRY_RUN", "CVE_FETCH_CAP", "MERGED", "BUNDLED"]),
  detail: z.string().max(300),
});

/**
 * What buildPack()'s size caps cut (§4.14 Caps), each as the pack held it (strings already sanitised), in
 * id order: the items with their feed, score and title, the records with their source and record id.
 * `over`: still over a cap with only KEV and referenced records left, so the pack was written as it was.
 */
export const PackSizeCut = z.strictObject({
  over: z.boolean(),
  items: z.array(z.strictObject({
    id: z.string().regex(ID_PATTERNS.packItem, { error: 'Expected a pack item id like "p0001"' }),
    feed_id: ConfigId,
    score: z.number(),
    title: z.string().max(200),
  })),
  records: z.array(z.strictObject({
    id: z.string().regex(ID_PATTERNS.packRecord, { error: 'Expected a pack record id like "r0001"' }),
    source: PackRecordSource,
    record_id: z.string().min(1),
  })),
});

/** packs/D.candidates.json (§8.3). */
export const CandidatesFile = z.strictObject({
  schema_version: z.literal(1),
  date: IsoDate,
  kept: z.array(Candidate),
  cut: z.strictObject({ count: Count, by_reason: z.strictObject({ below_cap: Count, merged: Count, bundled: Count }) }),
});

/** logs/D.candidates.json: the full ranking log, and what the pack's size caps cut. */
export const CandidateLogFile = z.strictObject({
  schema_version: z.literal(1),
  date: IsoDate,
  ranked: Count,
  kept: z.array(z.string()),
  cut: z.array(CutEntry),
  log: z.array(RankLogEntry),
  size_cut: PackSizeCut,
});

export type PackFlag = z.infer<typeof PackFlag>;
export type PackRecordSource = z.infer<typeof PackRecordSource>;
export type PackFeed = z.infer<typeof PackFeed>;
export type PackItem = z.infer<typeof PackItem>;
export type PackRecord = z.infer<typeof PackRecord>;
export type Pack = z.infer<typeof Pack>;
export type FeedState = z.infer<typeof FeedState>;
export type CheckLabel = z.infer<typeof CheckLabel>;
export type FeedIndexEntry = z.infer<typeof FeedIndexEntry>;
export type FeedIndexFile = z.infer<typeof FeedIndexFile>;
export type ZipRead = z.infer<typeof ZipRead>;
export type DayRead = z.infer<typeof DayRead>;
export type CollectInputsFile = z.infer<typeof CollectInputsFile>;
export type CutEntry = z.infer<typeof CutEntry>;
export type RankLogEntry = z.infer<typeof RankLogEntry>;
export type PackSizeCut = z.infer<typeof PackSizeCut>;
export type CandidatesFile = z.infer<typeof CandidatesFile>;
export type CandidateLogFile = z.infer<typeof CandidateLogFile>;
