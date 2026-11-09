import { z } from "zod";
import { FEED_STATUS, RUN_OUTCOMES, RUN_STAGES, RUN_TRIGGERS, STAGE_STATUS } from "../vocab";
import {
  CommitSha, ConfigId, Count, CorrectionId, Edition, ID_PATTERNS, IsoDate, IsoTimestamp, PublishedAt, RecheckFlag,
} from "./common";

// The status file, `content/status/D.json` (SPEC §4.8): one record per run for the date, oldest first.
// Notes come from fixed templates in scripts/lib/status.ts, never raw error text.

export const RunStage = z.enum(RUN_STAGES);
export const StageStatus = z.enum(STAGE_STATUS);
export const FeedStatus = z.enum(FEED_STATUS);
export const RunOutcome = z.enum(RUN_OUTCOMES);
export const RunTrigger = z.enum(RUN_TRIGGERS);

export const StageRecord = z.strictObject({
  id: RunStage,
  status: StageStatus,
  started_at: IsoTimestamp.nullable(),
  ended_at: IsoTimestamp.nullable(),
  note: z.string().min(1).max(200).nullable(),
});

export const FeedRecord = z.strictObject({
  id: ConfigId,
  status: FeedStatus,
  newest: PublishedAt,
  checked_at: IsoTimestamp,
  stale_since: IsoDate.nullable().describe("First edition date the feed was stale or failed, carried from earlier status files"),
  records: Count.nullable(),
  note: z.string().min(1).max(200).nullable(),
});

export const Recheck = z.strictObject({
  from: IsoDate,
  to: IsoDate,
  items_checked: Count,
  flagged: z.array(z.strictObject({
    item_id: z.string().min(1),
    edition_date: IsoDate,
    flag: RecheckFlag,
    detail: z.string().min(1).max(120),
    correction_id: CorrectionId.nullable(),
  })),
});

export const LinkCheck = z.strictObject({
  checked_at: IsoTimestamp,
  checked: Count,
  ok: Count,
  unknown: Count,
  broken: z.array(z.strictObject({
    url: z.string().min(1),
    item_id: z.string().min(1),
    edition_date: IsoDate,
    result: z.enum(["broken", "changed"]),
    http: z.int().nullable(),
  })),
});

export const RunRecord = z.strictObject({
  run_id: z.string().regex(ID_PATTERNS.runId, { error: 'Expected "YYYYMMDD-HHMMSS", the Taipei start time' }),
  trigger: RunTrigger,
  attempt: z.int().min(1),
  started_at: IsoTimestamp,
  finished_at: IsoTimestamp.nullable(),
  outcome: RunOutcome.nullable(),
  edition: Edition.nullable(),
  error_code: z.string().regex(ID_PATTERNS.errorCode, { error: "Expected an error code like E_AUTH" }).nullable(),
  code_commit: CommitSha,
  data_cutoff_utc: IsoDate.nullable(),
  data_only_published_at: IsoTimestamp.nullable(),
  full_published_at: IsoTimestamp.nullable(),
  late: z.boolean(),
  stages: z.array(StageRecord).refine((s) => s.length === RUN_STAGES.length && s.every((r, i) => r.id === RUN_STAGES[i]), {
    error: `stages must be exactly ${RUN_STAGES.join(", ")}, in that order`,
  }),
  feeds: z.array(FeedRecord).describe("One per feed in config/sources.yaml, registry order"),
  budgets: z.strictObject({
    agent_seconds: Count,
    web_fetches: Count,
    web_searches: Count,
    repair_rounds: Count,
    tokens_in: Count.nullable(),
    tokens_out: Count.nullable(),
    usage: z.strictObject({ window: z.string().min(1), utilization: z.number().min(0) }).nullable(),
    safety_stops: Count,
  }),
  candidates: z.strictObject({ ranked: Count, kept: Count, deep_read: Count }).nullable(),
  validation: z.strictObject({ errors: Count, warnings: Count, codes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)) }).nullable()
    .describe("Rule codes only, no messages"),
  soft_gates: z.strictObject({ checked: Count, dropped: Count, by_code: z.record(z.string(), Count) }).nullable(),
  deploy: z.strictObject({
    triggered: z.boolean(),
    ready_at: IsoTimestamp.nullable(),
    shows_date: IsoDate.nullable(),
    shows_edition: Edition.nullable(),
  }),
  recheck: Recheck.nullable(),
  links: LinkCheck.nullable(),
});

/** content/status/D.json. */
export const StatusFile = z.strictObject({
  schema_version: z.literal(1),
  date: IsoDate,
  runs: z.array(RunRecord).describe("Oldest first"),
});

export type RunStage = z.infer<typeof RunStage>;
export type StageStatus = z.infer<typeof StageStatus>;
export type FeedStatus = z.infer<typeof FeedStatus>;
export type RunOutcome = z.infer<typeof RunOutcome>;
export type RunTrigger = z.infer<typeof RunTrigger>;
export type StageRecord = z.infer<typeof StageRecord>;
export type FeedRecord = z.infer<typeof FeedRecord>;
export type Recheck = z.infer<typeof Recheck>;
export type LinkCheck = z.infer<typeof LinkCheck>;
export type RunRecord = z.infer<typeof RunRecord>;
export type StatusFile = z.infer<typeof StatusFile>;
