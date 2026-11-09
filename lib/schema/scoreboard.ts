import { z } from "zod";
import { CLAIM_JUDGES, CLAIM_METRIC_PATHS, CLAIM_ORIGINS, ENTRY_DIRECTIONS, ENTRY_ORIGINS } from "../vocab";
import {
  ClaimId, ClaimStatus, ClaimType, ClaimZone, Count, Fraction, IsoDate, MetricPath, ScoreboardEntryId, words,
} from "./common";

// The Scoreboard (SPEC §4.9): claims and thresholds fixed in advance in config/claims.json (changed only
// by PR), readings and entries in content/scoreboard.json (written by publish).

export const ClaimOrigin = z.enum(CLAIM_ORIGINS);
export const ClaimJudge = z.enum(CLAIM_JUDGES);
export const EntryOrigin = z.enum(ENTRY_ORIGINS);
export const EntryDirection = z.enum(ENTRY_DIRECTIONS);
export const ClaimMetricPath = z.enum(CLAIM_METRIC_PATHS);

export const Threshold = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("value"),
    op: z.enum([">=", "<=", ">", "<"]),
    value: z.number(),
    bound: z.enum(["value", "ci80_lo", "ci80_hi"]),
  }),
  z.strictObject({
    kind: z.literal("event"),
    text: z.string().min(1).max(160),
  }),
]);

export const Claim = z.strictObject({
  id: ClaimId,
  origin: ClaimOrigin,
  text: z.string().min(1).max(200).describe("A testable restatement"),
  restates: z.strictObject({
    quote: words("At most 25 words, verbatim"),
    source_title: z.string().min(1),
    source_url: z.string().min(1),
    date: IsoDate,
  }).nullable(),
  stated_probability: Fraction.nullable().describe("Only when the original states one, as a fraction; never invented"),
  judged_by: ClaimJudge,
  metric_path: ClaimMetricPath.nullable().describe('Non-null exactly when judged_by is "script"'),
  data_source: z.string().min(1).max(120),
  support: Threshold,
  challenge: Threshold,
  opened: IsoDate,
  deadline: IsoDate,
  resolution: z.strictObject({
    status: z.enum(["hit", "miss", "void"]),
    date: IsoDate,
    note: z.string().min(1).max(200),
    source_url: z.string().min(1).nullable(),
  }).nullable().describe("Set only by PR; overrides the computed status"),
}).refine((c) => (c.metric_path !== null) === (c.judged_by === "script"), {
  error: 'metric_path is non-null exactly when judged_by is "script"', path: ["metric_path"],
}).refine((c) => c.opened <= c.deadline, { error: "deadline is before opened", path: ["deadline"] });

/** config/claims.json: P1 lands version 0 with no claims; the P5 PR seeds version 1. */
export const ClaimsFile = z.strictObject({
  schema_version: z.literal(1),
  version: Count,
  claims: z.array(Claim),
});

export const ClaimState = z.strictObject({
  id: ClaimId,
  text: z.string().min(1).describe("Frozen copy of the claim text"),
  status: ClaimStatus,
  zone: ClaimZone,
  reading: z.number().nullable().describe("The metric value, or the bound the threshold names"),
  reading_text: z.string().min(1).max(80).nullable(),
  reading_as_of: IsoDate.nullable(),
  last_entry_id: ScoreboardEntryId.nullable(),
});

export const ScoreboardEntry = z.strictObject({
  id: ScoreboardEntryId,
  date: IsoDate.describe("Edition date"),
  claim_id: ClaimId,
  origin: EntryOrigin,
  direction: EntryDirection,
  summary: words("At most 40 words; metric entries use a template"),
  value: z.number().nullable().describe("Metric entries"),
  reported_value: z.string().min(1).max(40).nullable().describe("Report entries"),
  quote: words("Report entries: at most 25 words").nullable(),
  claim_type: ClaimType.nullable().describe("Report entries"),
  source_url: z.string().min(1).nullable().describe("Report entries: the quote's source"),
  metrics_ref: z.strictObject({ file: z.string().min(1), path: MetricPath }).nullable().describe("Metric entries"),
});

/** content/scoreboard.json. */
export const ScoreboardFile = z.strictObject({
  schema_version: z.literal(1),
  as_of: IsoDate.describe("Edition date of the last update"),
  claims_version: Count,
  claims: z.array(ClaimState).describe("One per claim, claims.json order"),
  entries: z.array(ScoreboardEntry).describe("Oldest first, never edited"),
});

export type ClaimOrigin = z.infer<typeof ClaimOrigin>;
export type ClaimJudge = z.infer<typeof ClaimJudge>;
export type EntryOrigin = z.infer<typeof EntryOrigin>;
export type EntryDirection = z.infer<typeof EntryDirection>;
export type ClaimMetricPath = z.infer<typeof ClaimMetricPath>;
export type Threshold = z.infer<typeof Threshold>;
export type Claim = z.infer<typeof Claim>;
export type ClaimsFile = z.infer<typeof ClaimsFile>;
export type ClaimState = z.infer<typeof ClaimState>;
export type ScoreboardEntry = z.infer<typeof ScoreboardEntry>;
export type ScoreboardFile = z.infer<typeof ScoreboardFile>;
