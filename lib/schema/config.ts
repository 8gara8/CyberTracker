import { z } from "zod";
import { ANNOTATION_KINDS, GAP_PANELS, INCIDENT_STATUS, LEVELLED_REGIONS, SECTORS, SEVERITIES } from "../vocab";
import {
  Clock, ConfigId, Count, CountryCode, Domain, FinderFamily, FinderKind, IsoDate, LevelledRegion, PublisherId,
  PublisherKind, RegionCode, RegionRuleType, SiblingTracker, TaiwanLensRowId, Tier, TopicId, uniqueArray, words,
} from "./common";

// The config files of SPEC §4.11 (claims.json is in scoreboard.ts, sources.yaml in registry.ts). Config
// is data changed only by PRs that JL merges; the run never writes it. A file that fails here fails
// CONFIG_SCHEMA. Cross-file checks (CONFIG_DUP, CONFIG_REF, CONFIG_REGEX) are validateConfig()'s, in
// lib/config.ts.

const versioned = { schema_version: z.literal(1), version: Count, updated: IsoDate };

// ── vendors.json ─────────────────────────────────────────────────────────────────────────────────

export const Vendor = z.strictObject({
  id: ConfigId,
  name: z.string().min(1).max(40).describe("The display name"),
  country: CountryCode.nullable().describe("Headquarters of the parent brand; null for community projects"),
  widely_deployed: z.boolean(),
  aliases: z.array(z.string().min(1)).describe("Other names used by KEV vendorProject or CVE affected[].vendor"),
  cna: z.array(z.string().min(1)).describe("CNA short names this vendor operates, exactly as in assignerShortName"),
  domains: z.array(Domain).describe("The vendor's own advisory and release domains"),
  note: z.string().min(1).max(120).nullable(),
});

export const VendorsFile = z.strictObject({ ...versioned, vendors: z.array(Vendor) });

// ── ai-finders.json ──────────────────────────────────────────────────────────────────────────────

export const FinderField = z.enum(["cna.credits", "adp.credits", "ghsa.credits"]);

export const Finder = z.strictObject({
  id: ConfigId,
  name: z.string().min(1).max(60).describe("As shown on Methodology"),
  family: FinderFamily,
  kind: FinderKind,
  patterns: z.array(z.string().min(1)).describe('Regexes, flags "iu"'),
  patterns_case_sensitive: z.array(z.string().min(1)).describe('Regexes, flags "u"'),
  lab_names: z.array(z.string().min(1)).describe('Regexes, flags "iu"; count only when lab_context also matches the same text'),
  examples: z.strictObject({ match: z.array(z.string().min(1)), no_match: z.array(z.string().min(1)) }),
  note: z.string().min(1).max(160).nullable(),
});

export const AiFindersFile = z.strictObject({
  ...versioned,
  fields: uniqueArray(FinderField, "fields").min(1).describe("Where to look, in priority order"),
  prefilter: z.string().min(1).describe('Regex, flags "iu", on the raw credit text'),
  strip: z.array(z.string().min(1)).describe('Regexes, flags "gu": replaced by a space before matching'),
  lab_context: z.string().min(1).describe('Regex, flags "u" (case as written)'),
  finders: z.array(Finder).min(1).describe("Match order: the first finder that matches wins"),
});

// ── source-tiers.json ────────────────────────────────────────────────────────────────────────────

export const Publisher = z.strictObject({
  id: ConfigId,
  name: z.string().min(1).max(60),
  tier: Tier,
  kind: PublisherKind,
  country: CountryCode.nullable(),
  domains: z.array(Domain),
  state_label: z.string().min(1).nullable().describe('e.g. "PRC state source"; shown beside every citation'),
  sole_newsroom_for_critical: z.boolean().describe("false: cannot be the only newsroom behind a critical item"),
});

export const SourceTiersFile = z.strictObject({
  ...versioned,
  publishers: z.array(Publisher),
  github: z.strictObject({ tier1_paths: z.array(z.string().min(1)).describe("Regexes on the github.com URL path") }),
});

// ── regions.json ─────────────────────────────────────────────────────────────────────────────────

export const RegionDef = z.strictObject({
  code: LevelledRegion,
  countries: uniqueArray(CountryCode, "countries"),
  agencies: z.array(PublisherId).describe("Publisher ids whose emergency alerts count (agency_alert)"),
  alert_patterns: z.array(z.string().min(1)).describe('Regexes, flags "iu", on the alert URL'),
  certs: z.array(PublisherId).describe("Publisher ids whose exploitation notices count (national_cert_exploitation)"),
  home_vendor_country: CountryCode.nullable().describe("TW and JP only"),
}).refine((r) => r.home_vendor_country === null || r.code === "TW" || r.code === "JP", {
  error: "home_vendor_country is set only for TW and JP", path: ["home_vendor_country"],
});

const HOME_ONLY_RULES: readonly string[] = ["home_vendor_kev", "national_cert_exploitation"];

export const RegionRule = z.strictObject({
  id: ConfigId,
  type: RegionRuleType,
  level: z.enum(["elevated", "high", "critical"]),
  regions: uniqueArray(LevelledRegion, "regions").min(1),
  params: z.strictObject({
    lookback_hours: z.int().min(24).refine((h) => h % 24 === 0, { error: "lookback_hours is a multiple of 24" }),
    min_publishers: z.int().min(1).nullable(),
    sectors: z.array(z.enum(SECTORS)).nullable(),
    statuses: z.array(z.enum(INCIDENT_STATUS)).nullable(),
    min_severity: z.enum(SEVERITIES).nullable(),
    max_lag_days: z.int().min(0).nullable(),
  }),
  reason: z.string().min(1).max(120).describe("Template: {headline}, {publisher}, {title}, {vendor}, {cve}, {country}, {sector}"),
  label: z.string().min(1).max(60).describe("For Methodology"),
}).refine((r) => !HOME_ONLY_RULES.includes(r.type) || (r.level === "elevated" && r.regions.every((c) => c === "TW" || c === "JP")), {
  error: "home_vendor_kev and national_cert_exploitation rules are elevated only, for TW and JP only", path: ["level"],
});

export const RegionsFile = z.strictObject({
  ...versioned,
  review_due: IsoDate,
  regions: z.array(RegionDef).refine((r) => r.length === LEVELLED_REGIONS.length && r.every((d, i) => d.code === LEVELLED_REGIONS[i]), {
    error: `regions must be exactly ${LEVELLED_REGIONS.join(", ")}, in that order`,
  }),
  rules: z.array(RegionRule),
  editor_raise: z.strictObject({ max_steps: z.literal(1), max_per_region: z.literal(1) }),
});

// ── annotations.json ─────────────────────────────────────────────────────────────────────────────

export const Annotation = z.strictObject({
  id: ConfigId,
  date: IsoDate.describe("UTC date"),
  end_date: IsoDate.nullable().describe("UTC date; for a span"),
  label: z.string().min(1).max(40),
  detail: z.string().min(1).max(120),
  panels: uniqueArray(z.enum(GAP_PANELS), "panels").min(1),
  kind: z.enum(ANNOTATION_KINDS),
  source_url: z.string().min(1).nullable().describe("Required unless kind is data_change and the CVE List itself shows it"),
}).refine((a) => a.end_date === null || a.end_date >= a.date, { error: "end_date is before date", path: ["end_date"] })
  .refine((a) => a.source_url !== null || a.kind === "data_change", { error: "source_url is required unless kind is data_change", path: ["source_url"] });

export const AnnotationsFile = z.strictObject({ schema_version: z.literal(1), annotations: z.array(Annotation) });

// ── actors.json ──────────────────────────────────────────────────────────────────────────────────

/** An actor never carries a nexus: that comes only from the items' attribution (§4.6, §4.11). */
export const Actor = z.strictObject({
  id: ConfigId,
  name: z.string().min(1).max(40).describe("The canonical chip name"),
  aliases: z.array(z.strictObject({ name: z.string().min(1), by: z.string().min(1), source_url: z.string().min(1) }))
    .describe("Each alias cites a published mapping"),
  mitre_id: z.string().regex(/^G\d{4}$/, { error: "Expected a MITRE ATT&CK group id like G0007" }).nullable(),
  related_tracker: SiblingTracker.nullable(),
  note: z.string().min(1).max(120).nullable(),
});

export const ActorsFile = z.strictObject({ ...versioned, actors: z.array(Actor) });

// ── watch-windows.json ───────────────────────────────────────────────────────────────────────────

export const WatchWindow = z.strictObject({
  id: ConfigId,
  title: z.string().min(1).max(80),
  start: IsoDate.describe("Inclusive Taipei date"),
  end: IsoDate.describe("Inclusive Taipei date"),
  regions: z.array(RegionCode),
  lens_row: TaiwanLensRowId.nullable(),
  search_terms: z.array(z.string().min(1)).describe("Added to the agent's searches while active; any language"),
  note: z.string().min(1).max(160).nullable(),
}).refine((w) => w.start <= w.end, { error: "end is before start", path: ["end"] });

export const WatchWindowsFile = z.strictObject({ schema_version: z.literal(1), windows: z.array(WatchWindow) });

// ── standing-stories.json ────────────────────────────────────────────────────────────────────────

export const StandingStory = z.strictObject({
  id: ConfigId,
  title: z.string().min(1).max(80),
  summary: words("At most 40 words: background the agent may assume"),
  regions: z.array(RegionCode),
  topics: z.array(TopicId),
  actors: z.array(ConfigId).describe("actors.json ids"),
  match_terms: z.array(z.string().min(1)),
  seed_last_development: IsoDate.nullable(),
  seed_source_url: z.string().min(1).nullable(),
});

export const StandingStoriesFile = z.strictObject({ schema_version: z.literal(1), stories: z.array(StandingStory) });

// ── run.json ─────────────────────────────────────────────────────────────────────────────────────

export const RunFile = z.strictObject({
  schema_version: z.literal(1),
  site: z.strictObject({ name: z.string().min(1), tagline: z.string().min(1), url: z.url({ protocol: /^https$/ }) }),
  repos: z.strictObject({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, { error: 'Expected "owner/name"' }), branch: z.literal("main") }),
  siblings: z.strictObject({ europe: z.url({ protocol: /^https$/ }), me: z.url({ protocol: /^https$/ }) }),
  schedule: z.strictObject({
    timezone: z.literal("Asia/Taipei"),
    start: Clock,
    data_only_target: Clock,
    full_target: Clock,
    retry_cutoff: Clock,
    hard_stop: Clock,
    stale_after: Clock,
    publish_until: Clock,
  }),
  budgets: z.strictObject({
    agent_minutes: z.int().min(1),
    web_fetches: Count,
    repair_rounds: Count,
    candidates_max: z.int().min(1),
    deep_read_max: Count,
    items_max: z.int().min(1),
    publish_reserve_minutes: Count,
    attempts_max: z.int().min(1),
    deploy_wait_minutes: Count,
    typical_items: z.tuple([Count, Count]).refine(([lo, hi]) => lo <= hi, { error: "typical_items is [lo, hi] with lo ≤ hi" }),
    words_target: z.int().min(1),
    words_max: z.int().min(1),
  }),
  pack: z.strictObject({ window_end: Clock, window_hours: z.int().min(1), lookback_hours: Count }),
  releases: z.array(z.strictObject({ vendor_id: ConfigId, min_records: z.int().min(1) })),
  paths: z.strictObject({
    content_dir: z.string().min(1),
    cache: z.string().min(1),
    packs: z.string().min(1),
    drafts: z.string().min(1),
    logs: z.string().min(1),
    needs_review: z.string().min(1),
  }),
  user_agent: z.string().min(1),
  task_name: z.string().min(1),
});

export type Vendor = z.infer<typeof Vendor>;
export type VendorsFile = z.infer<typeof VendorsFile>;
export type FinderField = z.infer<typeof FinderField>;
export type Finder = z.infer<typeof Finder>;
export type AiFindersFile = z.infer<typeof AiFindersFile>;
export type Publisher = z.infer<typeof Publisher>;
export type SourceTiersFile = z.infer<typeof SourceTiersFile>;
export type RegionDef = z.infer<typeof RegionDef>;
export type RegionRule = z.infer<typeof RegionRule>;
export type RegionsFile = z.infer<typeof RegionsFile>;
export type Annotation = z.infer<typeof Annotation>;
export type AnnotationsFile = z.infer<typeof AnnotationsFile>;
export type Actor = z.infer<typeof Actor>;
export type ActorsFile = z.infer<typeof ActorsFile>;
export type WatchWindow = z.infer<typeof WatchWindow>;
export type WatchWindowsFile = z.infer<typeof WatchWindowsFile>;
export type StandingStory = z.infer<typeof StandingStory>;
export type StandingStoriesFile = z.infer<typeof StandingStoriesFile>;
export type RunFile = z.infer<typeof RunFile>;
