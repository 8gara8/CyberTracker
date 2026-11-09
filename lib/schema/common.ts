import { z } from "zod";
import { isValidDate } from "../dates";
import {
  ACTOR_NEXUS, AI_CONFIDENCE, AI_CREDIT_RULES, AI_ROLES, ATTRIBUTION_BASIS, ATTRIBUTION_CONFIDENCE, BLOCK_STATUS, CLAIM_STATUS,
  CLAIM_TYPES, CLAIM_ZONES, COUNTRY_CODE_IDS, COVERAGE, CVSS_SCORERS, CVSS_VERSIONS, DISCOVERY_CREDIT, DISPUTE_KINDS, EDITIONS,
  EXPLOITATION_BASIS, FINDER_FAMILIES, FINDER_KINDS, INCIDENT_STATUS, KINDS, LEVELLED_REGIONS, PUBLISHER_KINDS, RECHECK_FLAGS,
  REGION_LEVELS, REGION_RULE_TYPES, REGIONS, SECTORS, SEEN_AS, SEVERITIES, SOURCE_TYPES, TAIWAN_LENS_ROWS, TOPICS,
} from "../vocab";

// Shared building blocks (SPEC §4.3). Every object is strict: unknown keys are errors, and absent values
// are null or [], never missing (§4.1). Constraints with their own rule code (§4.12: word budgets, item
// and source id formats, cross-references) stay in lib/rules so the agent gets the targeted message;
// what is left here is shape: types, enums, character limits, ranges and fixed formats.

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Every id and code format of §4.3 and the files of §4.7 to §4.15, for the rules and loaders. */
export const ID_PATTERNS = {
  item: /^(?:cve-\d{4}-\d{4,}|(?:vuln|pt|inc|sc|camp|pol|ai|eco)-[a-z0-9]+(?:-[a-z0-9]+)*)$/, // and at most 64 chars
  source: /^s[1-9][0-9]*$/,
  claim: /^SB-\d{2}$/,
  scoreboardEntry: /^SE-\d{4}$/,
  correction: /^C-\d{4}$/,
  dispute: /^D-\d{4}$/,
  signal: /^sig-\d{8}-\d+$/,
  config: /^[a-z0-9][a-z0-9-]*$/,
  release: /^rel-[a-z0-9-]+-\d{4}-\d{2}(?:-\d{2})?$/,
  cve: /^CVE-\d{4}-\d{4,}$/,
  ghsa: /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/,
  packItem: /^p\d{4,}$/,
  packRecord: /^r\d{4,}$/,
  runId: /^\d{8}-\d{6}$/,
  errorCode: /^E_[A-Z_]+$/,
  commit: /^[0-9a-f]{40}$/,
  sha256: /^[0-9a-f]{64}$/,
  /** A publisher id ("reuters"), an implicit vendor publisher ("vendor:qnap") or an unlisted host ("host:example.org"). */
  publisher: /^(?:vendor:[a-z0-9][a-z0-9-]*|host:[a-z0-9.-]+|[a-z0-9][a-z0-9-]*)$/,
  /** config/ domain entries: a lower-case host, optionally with a path prefix; no scheme, no `www.` (§4.11). */
  domain: /^(?!www\.)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}(?:\/[a-z0-9._~%/-]*)?$/,
  /** A dotted path into the metrics file, e.g. "window.w26.at_disclosure_share". */
  metricPath: /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/,
  /** "HH:MM", 00:00 to 23:59. */
  clock: /^(?:[01]\d|2[0-3]):[0-5]\d$/,
} as const;

export const ITEM_ID_MAX = 64;

const pattern = (re: RegExp, example: string) =>
  z.string().regex(re, { error: `Expected a value like ${example} (pattern ${re.source})` });

export const IsoDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Expected a date as YYYY-MM-DD", abort: true })
  .refine(isValidDate, { error: "Not a real calendar date" });

/**
 * A timestamp TIMESTAMP_RE accepts that names a real instant: a real calendar date, hour ≤ 23, minute and
 * second ≤ 59, and an offset within ±14:00. Date.parse alone rolls 2026-02-30 and 24:00 over instead.
 */
function isRealTimestamp(s: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(s);
  if (!m || !isValidDate(m[1]!)) return false;
  const [h, min, sec, oh, om] = [m[2], m[3], m[4], m[5], m[6]].map((x) => Number(x ?? "0")) as [number, number, number, number, number];
  return h <= 23 && min <= 59 && sec <= 59 && om <= 59 && oh * 60 + om <= 14 * 60 && !Number.isNaN(Date.parse(s));
}

export const IsoTimestamp = z.string()
  .regex(TIMESTAMP_RE, { error: "Expected an ISO 8601 timestamp with an offset, e.g. 2026-11-08T04:50:12+08:00", abort: true })
  .refine(isRealTimestamp, { error: "Not a real timestamp" });

/** A source date: a timestamp when the source gives a time, a bare date when it gives only the day, else null. */
export const PublishedAt = z.union([IsoTimestamp, IsoDate]).nullable()
  .describe("ISO 8601 timestamp with offset when the source gives a time, YYYY-MM-DD when it gives only the day, else null. Never invent a time");

export const CountryCode = z.enum(COUNTRY_CODE_IDS).describe("ISO 3166-1 alpha-2, upper case");
export const Language = z.string()
  .regex(/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2})?$/, { error: "Expected a language tag such as en, ja, zh-Hant or zh-Hant-TW" });
export const CveId = pattern(ID_PATTERNS.cve, "CVE-2026-104935 (upper case)");
export const GhsaId = pattern(ID_PATTERNS.ghsa, "GHSA-xxxx-xxxx-xxxx");
export const ConfigId = pattern(ID_PATTERNS.config, "qnap or salt-typhoon (lower-case letters, digits, hyphens)");
export const ClaimId = pattern(ID_PATTERNS.claim, "SB-01");
export const ScoreboardEntryId = pattern(ID_PATTERNS.scoreboardEntry, "SE-0001");
export const CorrectionId = pattern(ID_PATTERNS.correction, "C-0001");
export const DisputeId = pattern(ID_PATTERNS.dispute, "D-0001");
export const SignalId = pattern(ID_PATTERNS.signal, "sig-20261108-1");
export const ReleaseId = pattern(ID_PATTERNS.release, "rel-microsoft-2026-11");
export const PublisherId = pattern(ID_PATTERNS.publisher, "reuters, vendor:qnap or host:example.org");
export const CommitSha = pattern(ID_PATTERNS.commit, "a 40-character lower-case hex SHA");
export const Sha256 = pattern(ID_PATTERNS.sha256, "a 64-character lower-case hex SHA-256");
export const Domain = pattern(ID_PATTERNS.domain, "qnap.com or microsoft.com/en-us/security/blog");
export const MetricPath = pattern(ID_PATTERNS.metricPath, "window.w26.at_disclosure_share");
export const Clock = pattern(ID_PATTERNS.clock, "04:30");

/** A count: a non-negative integer (§4.1). */
export const Count = z.int().min(0);
/** A share or interval bound: a fraction in [0, 1] (§4.1). */
export const Fraction = z.number().min(0).max(1);
/** [lo, hi] with lo ≤ hi. */
export const Interval = z.tuple([z.number(), z.number()])
  .refine(([lo, hi]) => lo <= hi, { error: "An interval is [lo, hi] with lo ≤ hi" });
export const TimeWindow = z.strictObject({ start: IsoTimestamp, end: IsoTimestamp });

/** A string array with no repeats. */
export const uniqueArray = <T extends z.ZodType>(item: T, what: string) =>
  z.array(item).refine((a) => new Set(a).size === a.length, { error: `${what} must not repeat` });

/** A free-text field whose budget is in words: the rules enforce it (WORDS_OVER, WORDS_UNDER, QUOTE_MAX_25). */
export const words = (budget: string) => z.string().describe(budget);
/** Ids that other rules resolve (SOURCE_REF, LEAD_GROUNDED, TAIWAN_LENS_REQUIRED and the like). */
export const refs = (help: string) => z.array(z.string()).describe(help);

// Vocabulary enums (§4.2).
export const KindId = z.enum(KINDS);
export const Severity = z.enum(SEVERITIES);
export const Sector = z.enum(SECTORS);
export const TopicId = z.enum(TOPICS);
export const AiRole = z.enum(AI_ROLES);
export const AiConfidence = z.enum(AI_CONFIDENCE);
export const ClaimType = z.enum(CLAIM_TYPES);
export const FinderFamily = z.enum(FINDER_FAMILIES);
export const FinderKind = z.enum(FINDER_KINDS);
export const AiCreditRule = z.enum(AI_CREDIT_RULES);
export const DiscoveryCredit = z.enum(DISCOVERY_CREDIT);
export const Tier = z.literal([1, 2, 3]);
export const PublisherKind = z.enum(PUBLISHER_KINDS);
export const SourceType = z.enum(SOURCE_TYPES);
export const SeenAs = z.enum(SEEN_AS);
export const Coverage = z.enum(COVERAGE);
export const LevelledRegion = z.enum(LEVELLED_REGIONS);
export const RegionCode = z.enum(REGIONS);
export const RegionLevel = z.enum(REGION_LEVELS);
export const RegionRuleType = z.enum(REGION_RULE_TYPES);
export const ActorNexus = z.enum(ACTOR_NEXUS);
export const AttributionBasis = z.enum(ATTRIBUTION_BASIS);
export const AttributionConfidence = z.enum(ATTRIBUTION_CONFIDENCE);
export const IncidentStatus = z.enum(INCIDENT_STATUS);
export const CvssVersion = z.enum(CVSS_VERSIONS);
export const CvssScorer = z.enum(CVSS_SCORERS);
export const ExploitationBasis = z.enum(EXPLOITATION_BASIS);
export const Edition = z.enum(EDITIONS);
export const BlockStatus = z.enum(BLOCK_STATUS);
export const RecheckFlag = z.enum(RECHECK_FLAGS);
export const DisputeKind = z.enum(DISPUTE_KINDS);
export const ClaimStatus = z.enum(CLAIM_STATUS);
export const ClaimZone = z.enum(CLAIM_ZONES);
export const TaiwanLensRowId = z.enum(TAIWAN_LENS_ROWS);
/** The regions an item carries: at least one, no repeats, in REGIONS order. */
export const ItemRegions = z.array(RegionCode).min(1, { error: "An item carries at least one region" })
  .refine((a) => a.every((r, i) => i === 0 || REGIONS.indexOf(a[i - 1]!) < REGIONS.indexOf(r)), {
    error: `Regions must be unique and in this order: ${REGIONS.join(", ")}`,
  });
/** A sibling tracker that covers an actor (actors.json related_tracker, ActorSeen.cross_link). */
export const SiblingTracker = z.enum(["europe", "me"]);
/** Where an AI credit matched (§4.6 AiCredit.field). */
export const CreditField = z.enum(["cna.credits", "adp.credits", "ghsa.credits", "cvd_ledger"]);
/** KEV's knownRansomwareCampaignUse, lower-cased. */
export const Ransomware = z.enum(["known", "unknown"]);

export const VendorRef = z.strictObject({
  id: ConfigId.nullable().describe("vendors.json id; null when no vendor matched"),
  name: z.string().max(80).describe("Display name; for an unmatched vendor, the KEV vendorProject or the CNA's first affected vendor"),
  country: CountryCode.nullable(),
});

/** M: one per URL the brief cites. */
export const DraftSource = z.strictObject({
  id: z.string().describe("s1, s2, s3 ... in array order, no gaps"),
  title: z.string().min(1).max(200).describe("At most 200 characters, in the page's own language"),
  title_en: z.string().min(1).max(200).nullable().describe("English title, at most 200 characters; null when title is English"),
  language: Language,
  outlet: z.string().min(1).max(80).describe('At most 80 characters, e.g. "BleepingComputer", "JPCERT/CC", "中央社"'),
  url: z.string().min(1).describe("https URL from the pack, a page you fetched or a search result. Never news.google.com, an archive or a redirect wrapper"),
  source_type: SourceType,
  published_at: PublishedAt,
});

/** S: publish adds publisher, tier, state label and how the run saw the URL (§4.3). */
export const Source = DraftSource.extend({
  publisher: PublisherId,
  publisher_name: z.string().min(1).max(60),
  tier: Tier,
  state_label: z.string().min(1).nullable(),
  seen_as: SeenAs,
});

export const AiEvidence = z.strictObject({
  source_id: z.string().describe("A source in the item's source_ids"),
  quote: words("At most 25 words, verbatim from that source"),
  from_claimant: z.boolean().describe("true when the source is the AI lab or AI security vendor making the claim"),
});

export const Attribution = z.strictObject({
  attributed_by: z.string().min(1).max(80).describe('At most 80 characters, e.g. "Mandiant", "US Department of Justice"'),
  basis: AttributionBasis,
  actor_name_as_used: z.string().min(1).max(80).describe('The attributor\'s own name for the actor, e.g. "UNC5807"'),
  sponsor_claimed: z.string().min(1).max(60).nullable().describe("The sponsor or country as stated; null if none stated"),
  nexus: ActorNexus.describe('"unknown" whenever sponsor_claimed is null'),
  confidence_text: z.string().max(80).nullable().describe("The attributor's own confidence words, verbatim; null only with unstated"),
  confidence_level: AttributionConfidence,
  date: IsoDate,
  source_id: z.string(),
});

export const Incident = z.strictObject({
  victim: z.string().min(1).max(80).nullable().describe("Only when status is confirmed or reported; never an individual"),
  description: z.string().min(1).max(60).describe('Always present, e.g. "a Taiwanese electronics maker"; shown when victim is null'),
  sector: Sector,
  country: CountryCode.nullable().describe("The victim's country"),
  impact: words("At most 12 words; incident cards lead with it"),
  disruption: z.boolean().describe("Services disrupted, not only data stolen"),
  status: IncidentStatus,
  claimed_by: z.string().min(1).max(60).nullable().describe("Required when status is claimed"),
  status_source_ids: z.array(z.string()).min(1).describe("At least 1: the sources that establish the status"),
});

export const FlawEvidence = z.strictObject({
  cve_id: CveId.describe("One of the item's cve_ids"),
  kind: z.enum(["exploited", "patched"]),
  basis: z.enum(["vendor_confirmed", "cert_confirmed", "news_reported", "vendor_advisory"])
    .describe("exploited: vendor_confirmed, cert_confirmed or news_reported; patched: vendor_advisory"),
  date: IsoDate.describe("Date of the statement"),
  source_id: z.string().describe("vendor_*: on the vendor's own domain; cert_confirmed: a CERT; news_reported: a tier 2 newsroom"),
});

export const Exposure = z.strictObject({
  text: words('At most 20 words, e.g. "about 12,000 exposed instances, as reported by Shadowserver"'),
  source_id: z.string(),
});

export type IsoDate = z.infer<typeof IsoDate>;
export type IsoTimestamp = z.infer<typeof IsoTimestamp>;
export type PublishedAt = z.infer<typeof PublishedAt>;
export type Language = z.infer<typeof Language>;
export type CveId = z.infer<typeof CveId>;
export type Interval = z.infer<typeof Interval>;
export type TimeWindow = z.infer<typeof TimeWindow>;
export type VendorRef = z.infer<typeof VendorRef>;
export type DraftSource = z.infer<typeof DraftSource>;
export type Source = z.infer<typeof Source>;
export type AiEvidence = z.infer<typeof AiEvidence>;
export type Attribution = z.infer<typeof Attribution>;
export type Incident = z.infer<typeof Incident>;
export type FlawEvidence = z.infer<typeof FlawEvidence>;
export type Exposure = z.infer<typeof Exposure>;
export type CreditField = z.infer<typeof CreditField>;
export type SiblingTracker = z.infer<typeof SiblingTracker>;
export type Ransomware = z.infer<typeof Ransomware>;
// The vocabulary enums' types, the same as lib/vocab.ts's, so one import from lib/schema serves as both.
export type CountryCode = z.infer<typeof CountryCode>;
export type KindId = z.infer<typeof KindId>;
export type Severity = z.infer<typeof Severity>;
export type Sector = z.infer<typeof Sector>;
export type TopicId = z.infer<typeof TopicId>;
export type AiRole = z.infer<typeof AiRole>;
export type AiConfidence = z.infer<typeof AiConfidence>;
export type ClaimType = z.infer<typeof ClaimType>;
export type FinderFamily = z.infer<typeof FinderFamily>;
export type FinderKind = z.infer<typeof FinderKind>;
export type AiCreditRule = z.infer<typeof AiCreditRule>;
export type DiscoveryCredit = z.infer<typeof DiscoveryCredit>;
export type Tier = z.infer<typeof Tier>;
export type PublisherKind = z.infer<typeof PublisherKind>;
export type SourceType = z.infer<typeof SourceType>;
export type SeenAs = z.infer<typeof SeenAs>;
export type Coverage = z.infer<typeof Coverage>;
export type LevelledRegion = z.infer<typeof LevelledRegion>;
export type RegionCode = z.infer<typeof RegionCode>;
export type RegionLevel = z.infer<typeof RegionLevel>;
export type RegionRuleType = z.infer<typeof RegionRuleType>;
export type ActorNexus = z.infer<typeof ActorNexus>;
export type AttributionBasis = z.infer<typeof AttributionBasis>;
export type AttributionConfidence = z.infer<typeof AttributionConfidence>;
export type IncidentStatus = z.infer<typeof IncidentStatus>;
export type CvssVersion = z.infer<typeof CvssVersion>;
export type CvssScorer = z.infer<typeof CvssScorer>;
export type ExploitationBasis = z.infer<typeof ExploitationBasis>;
export type Edition = z.infer<typeof Edition>;
export type BlockStatus = z.infer<typeof BlockStatus>;
export type RecheckFlag = z.infer<typeof RecheckFlag>;
export type DisputeKind = z.infer<typeof DisputeKind>;
export type ClaimStatus = z.infer<typeof ClaimStatus>;
export type ClaimZone = z.infer<typeof ClaimZone>;
export type TaiwanLensRowId = z.infer<typeof TaiwanLensRowId>;
