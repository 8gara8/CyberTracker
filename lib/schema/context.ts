import { z } from "zod";
import {
  ClaimStatus, ConfigId, Count, CountryCode, CveId, CvssScorer, DisputeKind, Edition, Fraction, IsoDate, IsoTimestamp, KindId,
  Language, LevelledRegion, MetricPath, Ransomware, RecheckFlag, RegionCode, RegionLevel, ReleaseId, Severity, SiblingTracker,
  TimeWindow,
} from "./common";
import { ClaimJudge } from "./scoreboard";

// The agent's context, `drafts/context.json` (SPEC §4.15): built in memory by buildContext()
// (lib/context.ts) for each attempt. The validator uses only the copy in memory, never the file the agent
// can write. Untrusted strings carry the pack's <untrusted> wrapper.

/** One ranked candidate (§5.12); lib/rank.ts builds them, collect wraps each title. */
export const Candidate = z.strictObject({
  rank: z.int().min(1).describe("1-based position in the kept list"),
  score: z.number(),
  id: z.string().min(1).describe("The item id to use if it becomes an item, or a pack id"),
  kind: KindId.describe("Proposed; the agent may change it"),
  reasons: z.array(z.string().min(1)).describe('e.g. ["new KEV", "TW vendor", "CVSS 9.8 (cna, 3.1)"]'),
  title: z.string().describe("Untrusted, wrapped"),
  cve_ids: z.array(CveId),
  vendor: z.string().min(1).nullable(),
  vendor_country: CountryCode.nullable(),
  product: z.string().min(1).nullable(),
  cvss: z.strictObject({ score: z.number().min(0).max(10), version: z.string().min(1), scorer: CvssScorer }).nullable(),
  epss: z.strictObject({ score: Fraction, percentile: Fraction, change_24h: z.number().min(-1).max(1).nullable(), date: IsoDate }).nullable(),
  kev: z.strictObject({ date_added: IsoDate, due_date: IsoDate, ransomware: Ransomware }).nullable(),
  ssvc: z.strictObject({ exploitation: z.string().min(1), automatable: z.string().min(1), technical_impact: z.string().min(1) }).nullable(),
  ai_credit_match: z.strictObject({ family: z.string().min(1), matched: z.string().min(1), field: z.string().min(1), rule: z.string().min(1) }).nullable(),
  exploit_reference: z.boolean().describe("The CVE record has a reference tagged exploit"),
  release: z.strictObject({
    release_id: ReleaseId,
    vendor: z.string().min(1),
    total: Count,
    critical: Count.nullable(),
    exploited: Count,
    exploited_cve_ids: z.array(CveId),
  }).nullable().describe("Patch-batch bundles only"),
  record_url: z.string().min(1).nullable(),
  advisory_urls: z.array(z.string().min(1)),
  pack_ids: z.array(z.string().min(1)).describe("Pack items and records merged into this candidate"),
  deep_read: z.boolean().describe("Among the ones to read closely"),
});

const HomeKevCounts = z.strictObject({ d30_n: Count, d90_n: Count });

/** drafts/context.json. */
export const AgentContext = z.strictObject({
  date: IsoDate.describe("Taipei edition date"),
  window: TimeWindow.describe("As the pack's"),
  weekly: z.boolean().describe("isMonday(date): week_in_review required"),
  deadline: IsoTimestamp.describe("By which the draft must be written"),
  data_cutoff_utc: IsoDate,
  budgets: z.strictObject({
    max_items: Count,
    typical_items: z.tuple([Count, Count]),
    deep_reads: Count,
    page_fetches: Count,
    words: z.strictObject({ target: Count, max: Count }),
  }),
  candidates: z.array(Candidate).describe("Ranked; the first deep_reads have deep_read true"),
  cut: z.strictObject({ count: Count, by_reason: z.record(z.string(), Count) }),
  metrics: z.strictObject({
    gap_headline: z.string().describe("The metrics' headline.text, verbatim"),
    quotable: z.array(z.strictObject({ key: MetricPath, label: z.string().min(1), display: z.string().min(1), as_of: IsoDate }))
      .describe("The only metric numbers prose may use"),
    home_vendor_kev: z.strictObject({ tw: HomeKevCounts, jp: HomeKevCounts }),
    stale: z.array(z.string().min(1)).describe("Feeds whose figures are shown with an older date"),
  }),
  regions_preview: z.array(z.strictObject({
    region: LevelledRegion,
    level: RegionLevel,
    fired_rule: z.string().min(1).nullable(),
    basis: z.string().min(1).nullable(),
  })),
  standing_stories: z.array(z.strictObject({
    id: ConfigId,
    title: z.string().min(1),
    match_terms: z.array(z.string().min(1)),
    last_development: IsoDate.nullable(),
    last_item_id: z.string().min(1).nullable(),
  })),
  watch_windows: z.array(z.strictObject({
    id: ConfigId,
    title: z.string().min(1),
    start: IsoDate,
    end: IsoDate,
    search_terms: z.array(z.string().min(1)),
  })).describe("Only windows active on this date"),
  watch_searches: z.array(z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    query: z.string().min(1),
    language: Language,
    region: RegionCode,
  })).describe("Registry search entries plus active watch windows' terms"),
  recent_items: z.array(z.strictObject({
    date: IsoDate,
    id: z.string().min(1),
    kind: KindId,
    headline: z.string().min(1),
    severity: Severity.nullable(),
    source_urls: z.array(z.string().min(1)),
    withheld: z.literal(true).optional()
      .describe("Present on an item withheld while a reader dispute is open or upheld (SPEC §4.10): do not report it or its sources again"),
    dispute_kind: z.enum(["victim", "attribution"]).optional().describe("With withheld: what the reader disputed"),
  }).refine((r) => (r.withheld === undefined) === (r.dispute_kind === undefined), {
    error: "withheld and dispute_kind come together", path: ["dispute_kind"],
  })).describe("Last 14 days of editions, newest first, and any item of today's data-only edition withheld this morning"),
  yesterday: z.strictObject({
    date: IsoDate,
    edition: Edition,
    lead: z.array(z.string()),
    item_ids: z.array(z.string().min(1)),
  }).nullable(),
  scoreboard: z.array(z.strictObject({
    id: z.string().min(1),
    text: z.string().min(1),
    judged_by: ClaimJudge,
    metric_path: z.string().min(1).nullable(),
    support: z.string().min(1).describe("The threshold as one line of text"),
    challenge: z.string().min(1).describe("The threshold as one line of text"),
    deadline: IsoDate,
    status: ClaimStatus,
    reading: z.string().min(1).nullable(),
    reading_as_of: IsoDate.nullable(),
  })),
  corrections: z.strictObject({
    flagged: z.array(z.strictObject({
      date: IsoDate,
      item_id: z.string().min(1),
      check: RecheckFlag,
      before: z.string(),
      after: z.string(),
      evidence_url: z.string().min(1).nullable(),
    })).describe("From the 14-day re-check"),
    reports: z.array(z.strictObject({
      item_id: z.string().min(1),
      type: DisputeKind,
      evidence_url: z.string().min(1).nullable(),
    })).describe("Reader issue forms: item id, type and evidence link only"),
  }),
  config: z.strictObject({
    tiers: z.strictObject({
      t1: z.array(z.string().min(1)),
      t2: z.array(z.string().min(1)),
      not_sole_newsroom: z.array(z.string().min(1)),
      state_labelled: z.array(z.string().min(1)),
      /** The domains of the record publishers (CVE, NVD, GitHub advisories, JVN, TVN): a page on one is source_type "cve_record". */
      cve_record: z.array(z.string().min(1)),
    }),
    home_vendors: z.strictObject({ tw: z.array(z.string().min(1)), jp: z.array(z.string().min(1)) }),
    actors: z.array(z.strictObject({ name: z.string().min(1), aliases: z.array(z.string().min(1)), related_tracker: SiblingTracker.nullable() })),
    ai_finders: z.array(z.strictObject({ family: z.string().min(1), names: z.array(z.string().min(1)) })),
    banned_words: z.array(z.string().min(1)),
  }),
  pack: z.strictObject({
    md: z.string().min(1).describe("Path"),
    json: z.string().min(1).describe("Path"),
    degraded: z.boolean(),
    failed_feeds: z.array(z.string().min(1)),
  }),
});

export type Candidate = z.infer<typeof Candidate>;
export type AgentContext = z.infer<typeof AgentContext>;
