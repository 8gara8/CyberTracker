import { z } from "zod";
import { LEVELLED_REGIONS, REGION_CHANGES, REGION_SIGNAL_TYPES } from "../vocab";
import {
  ActorNexus, ClaimId, ClaimStatus, ClaimZone, ConfigId, Count, CveId, Edition, IsoDate, IsoTimestamp, LevelledRegion,
  PublishedAt, PublisherId, RegionLevel, RegionRuleType, ScoreboardEntryId, Sha256, SignalId, SiblingTracker, Source,
} from "./common";
import { Angle, DraftTaiwanLens, DraftWeekInReview, ElsewhereLink, LeadSentence } from "./draft-brief";
import { Item } from "./item";
import { EpssMover } from "./metrics";
import { Correction } from "./misc";
import { ScoreboardEntry } from "./scoreboard";

// A published brief, `content/briefs/D.json` (SPEC §4.5): the DraftBrief plus every S and C field, in
// the spec's key order. The draft's region_raises live on as regions.rows[].raised and its
// scoreboard_entries as scoreboard.entries, so a Brief has neither key.

export const RegionChange = z.enum(REGION_CHANGES);
export const RegionSignalType = z.enum(REGION_SIGNAL_TYPES);

export const RegionRow = z.strictObject({
  code: LevelledRegion,
  level: RegionLevel.describe("Shown: computed_level, or one step higher when raised"),
  computed_level: RegionLevel,
  previous_level: RegionLevel.nullable(),
  change: RegionChange,
  rule_id: ConfigId.nullable().describe("The highest firing rule (config/regions.json); null at baseline"),
  reason: z.string().max(160),
  item_ids: z.array(z.string()),
  fired: z.array(z.strictObject({
    rule_id: ConfigId,
    level: RegionLevel,
    item_ids: z.array(z.string()),
    signal_ids: z.array(SignalId),
  })),
  raised: z.strictObject({
    from: RegionLevel,
    to: RegionLevel,
    reason: z.string().min(1),
    trigger_class: RegionRuleType,
    item_ids: z.array(z.string()),
  }).nullable(),
});

export const RegionSignal = z.strictObject({
  id: SignalId,
  type: RegionSignalType,
  region: LevelledRegion,
  date: IsoDate.describe("The publisher's date, or the KEV dateAdded (US date)"),
  publisher: PublisherId.describe('Publisher id (source-tiers.json), or "cisa-kev"'),
  url: z.string().min(1),
  title: z.string().min(1).max(200),
  cve_ids: z.array(CveId),
});

export const Regions = z.strictObject({
  rows: z.array(RegionRow).refine((rows) => rows.length === LEVELLED_REGIONS.length && rows.every((r, i) => r.code === LEVELLED_REGIONS[i]), {
    error: `rows must be exactly ${LEVELLED_REGIONS.join(", ")}, in that order`,
  }),
  global: z.strictObject({ item_count: Count }),
  signals: z.array(RegionSignal),
});

export const GapRef = z.strictObject({
  headline: z.string().describe("The metrics' headline.text"),
  second_line: z.string().describe("The metrics' headline.second_line"),
  status: z.enum(["ok", "stale", "missing"]),
  metrics_file: z.string().regex(/^metrics\/\d{4}-\d{2}-\d{2}\.json$/, { error: 'Expected "metrics/YYYY-MM-DD.json"' }).nullable(),
  metrics_sha256: Sha256.nullable(),
  as_of: IsoDate.nullable(),
});

export const ActorSeen = z.strictObject({
  name: z.string().min(1),
  actor_id: ConfigId.nullable(),
  nexus: ActorNexus,
  item_ids: z.array(z.string()),
  cross_link: z.strictObject({ tracker: SiblingTracker, url: z.string().min(1) }).nullable(),
});

export const KevLine = z.strictObject({ d30_n: Count, d90_n: Count, text: z.string().min(1) });

export const TaiwanLens = DraftTaiwanLens.extend({
  kev_lines: z.strictObject({ tw: KevLine, jp: KevLine }),
  kev_note: z.string().min(1).describe("KEV_ABSENCE_NOTE, verbatim"),
  watch_windows: z.array(z.strictObject({ id: ConfigId, title: z.string().min(1).max(80), start: IsoDate, end: IsoDate })),
});

export const BriefScoreboard = z.strictObject({
  entries: z.array(ScoreboardEntry).describe("Entries created by this edition, copied from scoreboard.json"),
  last: z.strictObject({ entry_id: ScoreboardEntryId, date: IsoDate, claim_id: ClaimId, claim_text: z.string().min(1) }).nullable(),
});

export const WeekInReview = DraftWeekInReview.extend({
  from: IsoDate,
  to: IsoDate,
  table: z.array(z.strictObject({
    claim_id: ClaimId,
    text: z.string().min(1),
    status: ClaimStatus,
    zone: ClaimZone,
    reading_text: z.string().min(1).nullable(),
    reading_as_of: IsoDate.nullable(),
  })),
});

export const FeedStale = z.strictObject({
  id: ConfigId,
  name: z.string().min(1),
  status: z.enum(["stale", "failed"]),
  newest: PublishedAt,
  stale_since: IsoDate.nullable(),
});

export const Computed = z.strictObject({
  word_count: Count,
  reading_minutes: Count,
  item_count: Count,
  ai_linked: z.strictObject({ linked: Count, total: Count }),
  source_count: Count,
  publisher_count: Count,
});

/** content/briefs/D.json. */
export const Brief = z.strictObject({
  schema_version: z.literal(1),
  date: IsoDate,
  edition: Edition,
  generated_at: IsoTimestamp,
  published_at: IsoTimestamp,
  data_only_published_at: IsoTimestamp.nullable(),
  late: z.boolean(),
  data_cutoff_utc: IsoDate,
  lead: z.array(LeadSentence).max(5).describe("[] in a data-only brief"),
  angle: Angle.nullable(),
  regions: Regions,
  gap: GapRef,
  items: z.array(Item),
  actors_seen: z.array(ActorSeen),
  taiwan_lens: TaiwanLens,
  scoreboard: BriefScoreboard,
  week_in_review: WeekInReview.nullable(),
  corrections: z.array(Correction),
  elsewhere: z.array(ElsewhereLink),
  epss_movers: z.array(EpssMover),
  feeds_stale: z.array(FeedStale),
  sources: z.array(Source),
  computed: Computed,
});

export type RegionChange = z.infer<typeof RegionChange>;
export type RegionSignalType = z.infer<typeof RegionSignalType>;
export type RegionRow = z.infer<typeof RegionRow>;
export type RegionSignal = z.infer<typeof RegionSignal>;
export type Regions = z.infer<typeof Regions>;
export type GapRef = z.infer<typeof GapRef>;
export type ActorSeen = z.infer<typeof ActorSeen>;
export type KevLine = z.infer<typeof KevLine>;
export type TaiwanLens = z.infer<typeof TaiwanLens>;
export type BriefScoreboard = z.infer<typeof BriefScoreboard>;
export type WeekInReview = z.infer<typeof WeekInReview>;
export type FeedStale = z.infer<typeof FeedStale>;
export type Computed = z.infer<typeof Computed>;
export type Brief = z.infer<typeof Brief>;
