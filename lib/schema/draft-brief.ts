import { z } from "zod";
import { NONE_FOUND, TAIWAN_NO_NEWS } from "../vocab";
import {
  ClaimType, DraftSource, IsoDate, IsoTimestamp, LevelledRegion, MetricPath, RegionRuleType, TaiwanLensRowId, refs, words,
} from "./common";
import { DraftItem } from "./item";

// The agent's output, `drafts/YYYY-MM-DD.json` (SPEC §4.4), rendered to
// routine/schema/draft-brief.schema.json. Only M fields: a key for an S or C field fails SCHEMA
// ("Unknown key"). Counts, orders, word budgets and cross-references have their own rule codes (§4.12)
// and stay in lib/rules; descriptions state them for the agent.

/** A Lead sentence that cited a withheld item reads exactly WITHHELD_MARK ("[withheld]") in the archive (§4.10). */
export const LeadSentence = z.strictObject({
  text: z.string().min(1)
    .regex(/(?:[.?!]["'”’)\]]*|^\[withheld\])$/u, { error: "A Lead sentence ends in . ? or ! (a closing quote or bracket may follow)" })
    .describe("One sentence ending in . ? or !; no URL. All Lead sentences together: 15 to 90 words"),
  item_ids: refs("Items this sentence draws on; at least 1 unless gap is true. With none, the sentence is a Gap sentence (gap true), as every sentence is on a day with no items"),
  gap: z.boolean().describe("true when it quotes Gap numbers or cites no item; each number must match the metrics' headline.quoted"),
});

const exactlyOneBasis = (a: { source_id: string | null; metric_path: string | null }) =>
  (a.source_id === null) !== (a.metric_path === null);
const exactlyOneBasisError = { error: "Exactly one of source_id and metric_path is non-null", path: ["source_id"] };

const angleFields = {
  text: words(`At most 30 words, holding exactly one number. With a metric_path, the figures its quotable label prints ("26 weeks", "within 7 days", "80% interval") are not counted; name the window and date, not a denominator`),
  source_id: z.string().nullable().describe("The source of the number; exactly one of source_id and metric_path is non-null"),
  metric_path: MetricPath.nullable().describe('A dotted path into the metrics file, e.g. "window.w26.at_disclosure_share"; the number in text equals its display string'),
  as_of: IsoDate.describe("The source's date, or data_cutoff_utc for a metric"),
  counterpoint: words(`At most 30 words: the strongest evidence against over-reading the number, or exactly "${NONE_FOUND}"`),
  counterpoint_source_ids: refs(`At least 1, or [] with "${NONE_FOUND}"`),
  claim_id: z.string().nullable().describe("An open claim in the context's scoreboard, or null"),
};

/** A sourced, dated number, the strongest counter-point, and the claim it bears on. */
export const DraftAngle = z.strictObject(angleFields).refine(exactlyOneBasis, exactlyOneBasisError);

/** The one editorial override of a region level (§5.11): publish raises exactly one step, never lowers. */
export const RegionRaise = z.strictObject({
  region: LevelledRegion,
  reason: words("At most 20 words; rendered as \"Editor raised: {reason}\""),
  trigger_class: RegionRuleType.describe("The rule type whose spirit the event meets"),
  item_ids: refs("At least 1 item in this brief that carries the region"),
});

export const DraftLensRow = z.strictObject({
  row: TaiwanLensRowId,
  text: words("At most 30 words, or null for nothing new; non-null text needs at least 1 item or source").nullable(),
  item_ids: refs("Items in this brief"),
  source_ids: refs("Extra sources"),
});

export const DraftLensBlock = z.strictObject({
  text: words("At most 40 words, or null for nothing new").nullable(),
  item_ids: refs("Items in this brief"),
  source_ids: refs("Extra sources"),
});

export const DraftTaiwanLens = z.strictObject({
  analysis: words(`1 to 120 words; links to items rather than repeating them; its first sentence is the chat edition's Taiwan line. Exactly "${TAIWAN_NO_NEWS}" when nothing new qualifies`),
  item_ids: refs("Items in this brief"),
  source_ids: refs("Extra sources the analysis cites"),
  rows: z.array(DraftLensRow).describe("Exactly 6, one per row id in order: gov_infra, home_vendors, chips_defence, cables_telecom, influence_ops, china_axis"),
  japan: DraftLensBlock.describe("The Japan sub-block"),
});

/** Only for claims judged by report (§4.9). */
export const DraftScoreboardEntry = z.strictObject({
  claim_id: z.string().describe('A claim with judged_by "report"'),
  summary: words("At most 40 words: what was reported, by whom, when"),
  quote: words("At most 25 words, verbatim from the quote source"),
  quote_source_id: z.string().describe("A tier 1 or 2 source"),
  reported_value: z.string().min(1).max(40).nullable().describe('At most 40 characters, e.g. "3 incidents"; null when the report has no number'),
  claim_type: ClaimType.describe("self_reported always enters as neutral"),
  meets: z.enum(["support", "challenge"]).nullable().describe("Which preset event threshold the report meets"),
});

/** Mondays only: the seven editions dated Monday to Sunday before this date. */
export const DraftWeekInReview = z.strictObject({
  text: words("At most 150 words"),
  strongest_against: z.strictObject({
    text: words(`At most 50 words, or exactly "${NONE_FOUND}"`),
    claim_id: z.string().nullable(),
    source_ids: refs(`At least 1 tier 1 or 2 source; [] only with "${NONE_FOUND}"`),
  }),
});

/** One per flagged item that needs a public correction (§4.10). */
export const DraftCorrection = z.strictObject({
  item_id: z.string().describe("An item in the context's corrections.flagged"),
  edition_date: IsoDate.describe("The archived brief that holds it"),
  type: z.enum(["correction", "clarification", "update"]).describe("name_removed is script-only"),
  field: z.string().min(1).max(60).describe('At most 60 characters: dotted path inside the item, e.g. "headline", "cves.0.kev"'),
  after: z.string().min(1).max(300).describe("At most 300 characters: the corrected text or value"),
  reason: words("At most 40 words"),
  source_id: z.string().nullable().describe("The source that shows the correction is right"),
});

export const ElsewhereLink = z.strictObject({
  title: z.string().min(1).max(120).describe("At most 120 characters, English"),
  source_id: z.string().describe("A tier 1 or 2 source"),
});

export const DraftBrief = z.strictObject({
  schema_version: z.literal(1),
  date: IsoDate.describe("The edition date from the context"),
  generated_at: IsoTimestamp.describe("When you finished; within the context's window end and deadline"),
  lead: z.array(LeadSentence).min(1).max(5).describe("1 to 5 sentences, at most 90 words in all; write it last"),
  angle: DraftAngle,
  region_raises: z.array(RegionRaise).describe("0 to 4, at most one per region"),
  items: z.array(DraftItem).describe("0 to 10, in display order; the first three are the top stories"),
  taiwan_lens: DraftTaiwanLens,
  scoreboard_entries: z.array(DraftScoreboardEntry).describe("Report-judged claims only"),
  week_in_review: DraftWeekInReview.nullable().describe("Non-null exactly when date is a Monday"),
  corrections: z.array(DraftCorrection).describe("Only for items in the context's corrections.flagged"),
  elsewhere: z.array(ElsewhereLink).describe("0 to 6"),
  sources: z.array(DraftSource).describe("Every URL the draft cites, ids s1 to sN in order"),
});

/** Angle = DraftAngle + the claim's text frozen at publish (C), or null. */
export const Angle = z.strictObject({ ...angleFields, claim_text: z.string().min(1).nullable() })
  .refine(exactlyOneBasis, exactlyOneBasisError);

export type LeadSentence = z.infer<typeof LeadSentence>;
export type DraftAngle = z.infer<typeof DraftAngle>;
export type Angle = z.infer<typeof Angle>;
export type RegionRaise = z.infer<typeof RegionRaise>;
export type DraftLensRow = z.infer<typeof DraftLensRow>;
export type DraftLensBlock = z.infer<typeof DraftLensBlock>;
export type DraftTaiwanLens = z.infer<typeof DraftTaiwanLens>;
export type DraftScoreboardEntry = z.infer<typeof DraftScoreboardEntry>;
export type DraftWeekInReview = z.infer<typeof DraftWeekInReview>;
export type DraftCorrection = z.infer<typeof DraftCorrection>;
export type ElsewhereLink = z.infer<typeof ElsewhereLink>;
export type DraftBrief = z.infer<typeof DraftBrief>;
