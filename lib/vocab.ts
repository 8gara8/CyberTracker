// Controlled vocabularies, labels, fixed strings and safety lists (SPEC §4.2). Methodology renders from
// these and routine/STYLE.md must agree with them; if the two differ, this file wins. Every tuple exports
// its type; every record-style vocabulary has a tuple twin for z.enum, kept in step by its type
// annotation or `satisfies` and by tests/schema.test.ts. Region membership, vendor countries, source
// tiers and AI finders are data in config/ (§4.11), never here.

// ── Items ────────────────────────────────────────────────────────────────────────────────────────
export const KINDS = ["exploited_flaw", "critical_flaw", "patch_batch", "breach", "supply_chain", "campaign", "policy",
  "ai_capability", "ecosystem"] as const;
export type KindId = (typeof KINDS)[number];
export const HEADS = ["exploits", "breaches", "ai_frontier", "policy_actors"] as const; // "Also today" heads, in order
export type HeadId = (typeof HEADS)[number];
export const HEAD_INFO: Record<HeadId, { label: string }> = { exploits: { label: "Exploits" },
  breaches: { label: "Breaches and supply chain" }, ai_frontier: { label: "AI frontier" }, policy_actors: { label: "Policy and actors" } };
// rank: tie-break at equal severity (1 sorts first). slug: id prefix for items without a CVE id.
export const KIND_INFO: Record<KindId, { label: string; head: HeadId; rank: number; severity: "required" | "none"; slug: string; bar: string }> = {
  exploited_flaw: { label: "Exploited flaw", head: "exploits", rank: 1, severity: "required", slug: "vuln", bar: "Added to CISA's exploited list (KEV), or exploitation confirmed by the vendor or a national CERT" },
  critical_flaw:  { label: "Critical flaw", head: "exploits", rank: 2, severity: "required", slug: "vuln",
    bar: "CVSS 9.0 or higher from the vendor's own score, or EPSS in the top 1%, or CISA SSVC automatable with total impact, in widely deployed software, and at least one of: a Taiwanese or Japanese vendor, a credible AI-discovery claim, a public exploit reported, an internet-facing product. Without vendor confirmation it is labelled so and capped at Watch" },
  patch_batch:    { label: "Patch batch", head: "exploits", rank: 3, severity: "required", slug: "pt", bar: "A vendor's scheduled release, as one item: N fixes, n exploited" },
  supply_chain:   { label: "Supply chain", head: "breaches", rank: 4, severity: "required", slug: "sc", bar: "A trusted package, vendor or certificate authority compromised" },
  breach:         { label: "Breach or attack", head: "breaches", rank: 5, severity: "required", slug: "inc", bar: "Confirmed or credibly reported impact on a victim, under the naming rules" },
  campaign:       { label: "Campaign", head: "policy_actors", rank: 6, severity: "required", slug: "camp", bar: "A new report on a state or criminal group active in a tracked region" },
  ai_capability:  { label: "AI capability", head: "ai_frontier", rank: 7, severity: "none", slug: "ai", bar: "A measurable jump in what AI can find, exploit or defend" },
  ecosystem:      { label: "Ecosystem", head: "ai_frontier", rank: 8, severity: "none", slug: "eco", bar: "Whether defenders can keep up: CVE and NVD capacity, maintainer burden, bug bounty changes" },
  policy:         { label: "Policy", head: "policy_actors", rank: 9, severity: "none", slug: "pol", bar: "Laws, takedowns, sanctions and government moves on AI and cyber" } };
export const FLAW_KINDS = ["exploited_flaw", "critical_flaw", "patch_batch"] as const;
export type FlawKind = (typeof FLAW_KINDS)[number];
export const SEVERITIES = ["critical", "high", "elevated", "watch"] as const; // highest first
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_INFO: Record<Severity, { pips: string; word: string; rank: number; means: string }> = {
  critical: { pips: "●●●●", word: "CRITICAL", rank: 4, means: "Exploited now in software on millions of systems, or critical infrastructure disrupted" },
  high:     { pips: "●●●○", word: "HIGH",     rank: 3, means: "Exploited in a narrower product, or a major breach with data stolen" },
  elevated: { pips: "●●○○", word: "ELEVATED", rank: 2, means: "A critical flaw not yet exploited, or a notable campaign" },
  watch:    { pips: "●○○○", word: "WATCH",    rank: 1, means: "Credible and relevant, but not exploited, and narrow or early" } };
export const LANDMARK_RANK = 2; // a landmark item (severity null) sorts as Elevated; other null-severity items rank 0
export const SECTORS = ["government", "defence", "energy", "water", "transport", "telecom", "health", "finance", "semiconductor",
  "manufacturing", "technology", "education", "retail", "media", "other"] as const;
export type Sector = (typeof SECTORS)[number];
export const CNI_SECTORS = ["government", "defence", "energy", "water", "transport", "telecom", "health", "finance"] as const;
export type CniSector = (typeof CNI_SECTORS)[number];
export const TOPICS = ["government", "ot_cni", "telecom", "undersea_cable", "semiconductor", "defence_industry", "influence_op",
  "election", "illicit_finance", "market"] as const;
export type TopicId = (typeof TOPICS)[number];
export const TOPIC_INFO: Record<TopicId, { label: string; lens_row: TaiwanLensRowId | null }> = {
  government: { label: "Government", lens_row: "gov_infra" }, ot_cni: { label: "OT and critical infrastructure", lens_row: "gov_infra" },
  telecom: { label: "Telecoms", lens_row: "cables_telecom" }, undersea_cable: { label: "Undersea cables", lens_row: "cables_telecom" },
  semiconductor: { label: "Semiconductors", lens_row: "chips_defence" }, defence_industry: { label: "Defence supply chain", lens_row: "chips_defence" },
  influence_op: { label: "Influence operation", lens_row: "influence_ops" }, election: { label: "Elections", lens_row: "influence_ops" },
  illicit_finance: { label: "Illicit finance", lens_row: null }, market: { label: "Market move", lens_row: null } }; // market: must cite a price move reported in the news

// ── AI lens ──────────────────────────────────────────────────────────────────────────────────────
export const AI_ROLES = ["ai_found", "ai_weapon", "ai_target", "ai_defend", "ai_actor", "none", "unassessed"] as const;
export type AiRole = (typeof AI_ROLES)[number];
export const AI_ROLE_INFO: Record<AiRole, { chip: string | null; means: string }> = {
  ai_found:   { chip: "AI-found",  means: "An AI system found the flaw (Big Sleep, Claude Mythos, OpenAI's pipeline, XBOW, AIxCC tools)" },
  ai_weapon:  { chip: "AI-weapon", means: "A human attacker used AI: AI-written malware, agentic intrusion, deepfake fraud, AI-scaled phishing" },
  ai_target:  { chip: "AI-target", means: "AI systems were attacked: model gateways, agents, training data, AI keys, prompt injection" },
  ai_defend:  { chip: "AI-defend", means: "AI detected, patched or blocked something" },
  ai_actor:   { chip: "AI-actor",  means: "An AI system caused the event without a human attacker directing it" }, none: { chip: null, means: "No AI role. Never guessed" },
  unassessed: { chip: "AI: unassessed", means: "Data-only editions only: no editorial pass ran" } };
export const AI_LINKED_ROLES = ["ai_found", "ai_weapon", "ai_target", "ai_defend", "ai_actor"] as const; // count in "AI-linked: x of y"
export type AiLinkedRole = (typeof AI_LINKED_ROLES)[number];
export const AI_CONFIDENCE = ["confirmed", "claimed", "reported"] as const;
export type AiConfidence = (typeof AI_CONFIDENCE)[number];
export const AI_CONFIDENCE_INFO = {
  confirmed: "A party other than the claimant backs it: the vendor's advisory, a CVE credit naming the AI system, or a victim or government statement",
  claimed:   "Only the AI lab or AI security vendor that benefits says so. Outlined chip: 'AI role claimed by X'", reported: "Press reports only" } as const satisfies Record<AiConfidence, string>;
export const CLAIM_TYPES = ["independent", "self_reported", "government"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];
export const CLAIM_TYPE_INFO = { independent: "Reported or confirmed by parties with no stake in the claim",
  self_reported: "Only the party that benefits says so. Worded 'X says' and chipped 'not independently verified'",
  government:    "A government statement, worded 'X government says'" } as const satisfies Record<ClaimType, string>;
export const FINDER_FAMILIES = ["anthropic", "openai", "google", "other"] as const; // the AI-credited split
export type FinderFamily = (typeof FINDER_FAMILIES)[number];
export const FINDER_KINDS = ["ai_system", "ai_assisted"] as const;
export type FinderKind = (typeof FINDER_KINDS)[number];
export const AI_CREDIT_RULES = ["pattern", "lab_context", "cvd_ledger"] as const;
export type AiCreditRule = (typeof AI_CREDIT_RULES)[number];
export const DISCOVERY_CREDIT = ["ai_autonomous", "ai_assisted", "human", "unknown"] as const;
export type DiscoveryCredit = (typeof DISCOVERY_CREDIT)[number];
export const DISCOVERY_CREDIT_INFO = { ai_autonomous: "The credit matches an AI-finder entry of kind ai_system",
  ai_assisted: "The credit matches an AI-finder entry of kind ai_assisted",
  human: "Credited finder named, no AI finder matched. AI assistance is not ruled out", unknown: "No credit text" } as const satisfies Record<DiscoveryCredit, string>;

// ── Sources ──────────────────────────────────────────────────────────────────────────────────────
export const TIERS = [1, 2, 3] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_INFO = { 1: { label: "Primary",  means: "Vendor and maintainer advisories, CVE, KEV, GitHub, JVN and TVN records, CERTs, governments, regulators, victim statements, original research" },
  2: { label: "Newsroom", means: "Newsrooms doing their own reporting" },
  3: { label: "Not citable for facts", means: "Aggregators, AI-written sites, blogs, social media, leak sites, marketing, and any unlisted domain" } } as const satisfies Record<Tier, { label: string; means: string }>;
export const PUBLISHER_KINDS = ["government", "cert", "regulator", "vendor", "research", "newsroom", "state_media", "aggregator",
  "social", "other"] as const;
export type PublisherKind = (typeof PUBLISHER_KINDS)[number];
export const SOURCE_TYPES = ["cve_record", "vendor_advisory", "finder_writeup", "government", "regulator_filing", "victim",
  "research", "press", "other"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const SOURCE_TYPE_INFO = { cve_record: "A CVE, GHSA, JVN or TVN record",
  vendor_advisory: "The affected vendor's or maintainer's own advisory or release note",
  finder_writeup: "The finder's own write-up (including AI labs and AI security vendors)",
  government: "A government body or national CERT",
  regulator_filing: "A regulator filing: US SEC 8-K, Taiwan MOPS material information, Japan TDnet",
  victim: "The victim's own statement", research: "Original research by a security firm or lab about someone else's flaw or campaign",
  press: "A newsroom report", other: "Anything else (tier 3 only)" } as const satisfies Record<SourceType, string>;
export const SEEN_AS = ["pack", "fetched", "search"] as const; // how the run saw a cited URL
export type SeenAs = (typeof SEEN_AS)[number];
export const COVERAGE = ["exploits", "breaches", "ai", "policy", "taiwan", "japan"] as const; // the four Also-today heads and
  // the two Lens blocks: sources.yaml coverage (§4.13) and PackItem.coverage, the pack's sections (§4.14)
export type Coverage = (typeof COVERAGE)[number];

// ── Regions ──────────────────────────────────────────────────────────────────────────────────────
export const LEVELLED_REGIONS = ["US", "EU", "TW", "JP"] as const;  // display order; each gets a level
export type LevelledRegion = (typeof LEVELLED_REGIONS)[number];
export const REGIONS = [...LEVELLED_REGIONS, "GLOBAL"] as const;     // GLOBAL shows an item count only
export type RegionCode = (typeof REGIONS)[number];
export const REGION_INFO: Record<RegionCode, { label: string }> = { US: { label: "United States" }, EU: { label: "Europe" },
  TW: { label: "Taiwan" }, JP: { label: "Japan" }, GLOBAL: { label: "Global" } };
export const REGION_LEVELS = ["baseline", "elevated", "high", "critical"] as const; // lowest first
export type RegionLevel = (typeof REGION_LEVELS)[number];
export const REGION_LEVEL_INFO: Record<RegionLevel, { pips: string; word: string; rank: number }> = {
  baseline: { pips: "●○○○", word: "BASELINE", rank: 1 }, elevated: { pips: "●●○○", word: "ELEVATED", rank: 2 },
  high:     { pips: "●●●○", word: "HIGH",     rank: 3 }, critical: { pips: "●●●●", word: "CRITICAL", rank: 4 } };
export const REGION_CHANGES = ["up", "down", "same", "new"] as const; // REGION_CHANGE's tuple twin (RegionRow.change)
export type RegionChange = (typeof REGION_CHANGES)[number];
export const REGION_CHANGE = { up: "↑", down: "↓", same: "=", new: "" } as const satisfies Record<RegionChange, string>;
export const REGION_RULE_TYPES = ["confirmed_disruption", "agency_alert", "confirmed_breach", "victim_in_region", "campaign_target",
  "home_vendor_kev", "national_cert_exploitation"] as const; // lib/regions.ts implements each (§5.11)
export type RegionRuleType = (typeof REGION_RULE_TYPES)[number];
export const REGION_SIGNAL_TYPES = ["agency_alert", "home_vendor_kev", "cert_exploitation"] as const;
export type RegionSignalType = (typeof REGION_SIGNAL_TYPES)[number];

// ── Actors and incidents ─────────────────────────────────────────────────────────────────────────
export const ACTOR_NEXUS = ["prc", "russia", "dprk", "iran", "other_state", "hacktivist", "criminal", "unknown"] as const;
export type ActorNexus = (typeof ACTOR_NEXUS)[number];
export const ACTOR_NEXUS_INFO = { prc: "PRC", russia: "Russia", dprk: "North Korea", iran: "Iran", other_state: "Other state",
  hacktivist: "Hacktivist", criminal: "Criminal", unknown: "Unknown" } as const satisfies Record<ActorNexus, string>;
export const ATTRIBUTION_BASIS = ["government", "vendor", "media"] as const;
export type AttributionBasis = (typeof ATTRIBUTION_BASIS)[number];
export const ATTRIBUTION_BASIS_INFO = { government: "Government", vendor: "Security vendor or research lab", media: "News organisation" } as const satisfies Record<AttributionBasis, string>;
export const ATTRIBUTION_CONFIDENCE = ["high", "moderate", "low", "unstated"] as const;
export type AttributionConfidence = (typeof ATTRIBUTION_CONFIDENCE)[number];
// A sponsor or country may be named only at high or moderate, or unstated from a government (§4.12).
// Words that make an attribution low confidence whatever level the agent chose:
export const LOW_CONFIDENCE_MARKERS = ["low confidence", "low-confidence", "possible", "possibly", "suspected", "may be", "might be",
  "could be", "tentative", "unconfirmed", "not yet attributed", "preliminary", "cannot rule out"] as const;
export const INCIDENT_STATUS = ["confirmed", "reported", "claimed"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUS)[number];
export const INCIDENT_STATUS_INFO = { confirmed: "A victim statement, a regulator filing (SEC 8-K, MOPS, TDnet) or a CERT or government notice",
  reported: "A tier 2 newsroom reports the impact as observed fact", claimed: "Only an attacker's claim. Never names the victim, never a top story, at most Watch" } as const satisfies Record<IncidentStatus, string>;

// ── CVE block ────────────────────────────────────────────────────────────────────────────────────
export const CVSS_VERSIONS = ["4.0", "3.1", "3.0"] as const;
export type CvssVersion = (typeof CVSS_VERSIONS)[number];
export const CVSS_SCORERS = ["cna", "cisa_adp", "nvd"] as const; // precedence order (§4.6)
export type CvssScorer = (typeof CVSS_SCORERS)[number];
export const EXPLOITATION_BASIS = ["kev_listed", "vendor_confirmed", "cert_confirmed", "news_reported"] as const;
export type ExploitationBasis = (typeof EXPLOITATION_BASIS)[number];
export const EXPLOITATION_BASIS_INFO = { kev_listed: "Listed by CISA", vendor_confirmed: "Confirmed by the vendor",
  cert_confirmed: "Confirmed by a national CERT", news_reported: "Reported in the news" } as const satisfies Record<ExploitationBasis, string>;
export const PATCH_BASIS = ["vendor_advisory", "ghsa_fixed_version"] as const;
export type PatchBasis = (typeof PATCH_BASIS)[number];
export const VENDOR_CONFIRMED_BY = ["vendor_cna", "vendor_advisory", "ghsa_reviewed"] as const;
export type VendorConfirmedBy = (typeof VENDOR_CONFIRMED_BY)[number];

// ── Editions, run, corrections ───────────────────────────────────────────────────────────────────
export const EDITIONS = ["full", "partial", "data_only"] as const;
export type Edition = (typeof EDITIONS)[number];
export const EDITION_INFO = { full: "Full edition", partial: "Full edition; some feeds stale (named, with their values dated)",
  data_only: "Data-only edition: no editorial; AI roles unassessed; excluded from every AI trend" } as const satisfies Record<Edition, string>;
export const RUN_STAGES = ["preflight", "collect", "metrics", "data_only", "draft", "validate", "publish", "deploy", "recheck",
  "links"] as const;                                               // the status file's order; §8.2 gives the run order
export type RunStage = (typeof RUN_STAGES)[number];
export const STAGE_STATUS = ["ok", "degraded", "failed", "skipped"] as const;
export type StageStatus = (typeof STAGE_STATUS)[number];
export const FEED_STATUS = ["ok", "stale", "failed", "skipped"] as const;
export type FeedStatus = (typeof FEED_STATUS)[number];
/** The structured feeds whose staleness makes an edition partial: `feeds_stale` names only these, never an RSS feed (§8.3). */
export const PARTIAL_FEED_IDS = ["kev", "cvelist", "epss", "ghsa", "anthropic-cvd"] as const;
export const BLOCK_STATUS = ["ok", "stale", "failed"] as const;    // metrics blocks
export type BlockStatus = (typeof BLOCK_STATUS)[number];
export const RUN_OUTCOMES = ["published_full", "published_partial", "published_data_only", "failed", "skipped", "dry_run"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export const RUN_TRIGGERS = ["schedule", "retry", "manual", "dry_run"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];
export const CORRECTION_TYPES = ["correction", "clarification", "update", "name_removed"] as const;
export type CorrectionType = (typeof CORRECTION_TYPES)[number];
export const CORRECTION_TRIGGERS = ["recheck", "reader_report", "editor"] as const;
export type CorrectionTrigger = (typeof CORRECTION_TRIGGERS)[number];
export const RECHECK_FLAGS = ["cve_rejected", "cve_disputed", "kev_changed", "cvss_changed", "source_missing", "source_changed",
  "reader_report"] as const;
export type RecheckFlag = (typeof RECHECK_FLAGS)[number];
export const DISPUTE_KINDS = ["victim", "attribution", "fact", "link"] as const; // victim and attribution withhold at once
export type DisputeKind = (typeof DISPUTE_KINDS)[number];

// ── Scoreboard ───────────────────────────────────────────────────────────────────────────────────
export const CLAIM_ORIGINS = ["jl", "rival"] as const;
export type ClaimOrigin = (typeof CLAIM_ORIGINS)[number];
export const CLAIM_JUDGES = ["script", "report"] as const;
export type ClaimJudge = (typeof CLAIM_JUDGES)[number];
export const CLAIM_STATUS = ["open", "hit", "miss", "void"] as const;
export type ClaimStatus = (typeof CLAIM_STATUS)[number];
export const ENTRY_ORIGINS = ["metric", "report"] as const;
export type EntryOrigin = (typeof ENTRY_ORIGINS)[number];
export const ENTRY_DIRECTIONS = ["support", "challenge", "neutral"] as const;
export type EntryDirection = (typeof ENTRY_DIRECTIONS)[number];
export const CLAIM_ZONES = ["support", "challenge", "between", "no_reading"] as const; // between: neither threshold met
export type ClaimZone = (typeof CLAIM_ZONES)[number];
// Metrics a script-judged claim may read (§4.7 paths). ci80 bounds exist for the first two
// (at_disclosure_ci80, after_disclosure_median_ci80) and for base_rate.ratio (base_rate.ratio_ci80).
export const CLAIM_METRIC_PATHS = ["window.w26.at_disclosure_share", "window.w26.after_disclosure_median_days",
  "window.w26.cohort_n", "window.volume_ratio", "window.kev_pace_ratio", "flood.vs_reference_pct", "flood.yoy_pct",
  "flood.yoy_ex_kernel_pct", "ai_credited.w13.total", "ai_credited.w13.ex_anthropic", "ai_credited.in_kev.n", "base_rate.ratio",
  "fix_side.ghsa_unfixed.share"] as const;
export type ClaimMetricPath = (typeof CLAIM_METRIC_PATHS)[number];

// ── Gap ──────────────────────────────────────────────────────────────────────────────────────────
export const SHARE_DIRECTIONS = ["higher", "lower", "no_clear_change", "n_too_small"] as const;
export type ShareDirection = (typeof SHARE_DIRECTIONS)[number];
export const SPEED_DIRECTIONS = ["faster", "slower", "no_clear_change", "n_too_small"] as const;
export type SpeedDirection = (typeof SPEED_DIRECTIONS)[number];
export const ANNOTATION_KINDS = ["data_change", "policy", "event"] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];
export const GAP_PANELS = ["flood", "window", "ai"] as const; // annotation targets
export type GapPanel = (typeof GAP_PANELS)[number];
export const MIN_N = 30;                                           // no figure from fewer cases

// ── Taiwan Lens ──────────────────────────────────────────────────────────────────────────────────
export const TAIWAN_LENS_ROWS = ["gov_infra", "home_vendors", "chips_defence", "cables_telecom", "influence_ops", "china_axis"] as const; // fixed order
export type TaiwanLensRowId = (typeof TAIWAN_LENS_ROWS)[number];
export const TAIWAN_LENS_ROW_INFO: Record<TaiwanLensRowId, { label: string }> = {
  gov_infra: { label: "Attacks on Taiwan's government and infrastructure" }, home_vendors: { label: "Taiwanese and Japanese vendor flaws reported exploited" },
  chips_defence: { label: "Semiconductors and the defence supply chain" }, cables_telecom: { label: "Undersea cables and telecoms" },
  influence_ops: { label: "Cognitive warfare and influence operations" },
  china_axis: { label: "The China axis: PRC operations against Taiwan, PRC counter-accusations (labelled as state claims), Chinese AI models used in attacks" } };

// ── Fixed strings (rendered verbatim; the validator compares against them) ───────────────────────
export const ANTHROPIC_LINE = "CyberTracker is written by Claude, made by Anthropic.";
export const BASELINE_TOOLTIP = "Baseline means no rule fired, not calm.";
export const ABOUT_LINE = "Written each morning by Claude (Anthropic's AI) without human review. Gap numbers are computed by scripts. Report errors here.";
export const KEV_ABSENCE_NOTE = "Absence from CISA's list does not mean not exploited.";
export const WINDOW_LABEL = "Confirmed by US CISA, a lagging proxy for exploitation, not a first-exploitation date.";
export const AI_CREDIT_CAPTION = "Lower bound. Credits are missing for about half of CVEs, including Microsoft, Chrome, Apple and Oracle, and most AI-found bugs never get a CVE.";
export const FIX_SIDE_CAPTION = "Whether organisations actually patch faster is not publicly measurable day to day; annual studies are logged in the Scoreboard.";
export const SELF_REPORTED_CHIP = "not independently verified";
export const CLAIMED_CHIP = "AI role claimed by {claimant}";
export const PUBLIC_EXPLOIT_LABEL = { yes: "Public exploit reported: yes", no: "Public exploit reported: no" } as const;
export const NOT_VENDOR_CONFIRMED = "not confirmed by vendor";
export const UNNAMED_CLAIM = "{description}, claimed by {group}, unverified";
export const EDITOR_RAISED = "Editor raised: {reason}";
export const NO_NEWS_ROW = "Nothing new today.";
export const TAIWAN_NO_NEWS = "No fresh Taiwan-relevant development today; the rows below still apply.";
export const NONE_FOUND = "none found";
export const SCOREBOARD_NO_ENTRY = "No new Scoreboard entry; last: {date}, {claim}";
export const WITHHELD_HEADLINE = "Item under review";
export const WITHHELD_TEXT = "Details withheld from {date} while a dispute about a named party is reviewed.";
export const WITHHELD_MARK = "[withheld]"; // §4.10: Lead, Angle and Lens text and source titles that cite only a withheld item
export const STALE_BANNER = "Not updated today. Last edition: {date}, {time}";
export const BRIEF_END = "That's today's brief.";

// ── Safety lists ─────────────────────────────────────────────────────────────────────────────────
export const BLOCK_REASONS = ["exploit_code", "paste", "messaging", "shortener", "redirect", "archive", "leak_site", "scan_query"] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export interface BlockedHost {
  /** A host (matches the host and every subdomain), a host/path prefix, or a ".onion"/".i2p" suffix. */
  pattern: string;
  reason: BlockReason;
}

const entries = (reason: BlockReason, patterns: string[]): BlockedHost[] => patterns.map((pattern) => ({ pattern, reason }));

/**
 * The one blocked list (Appendix B.3). The validator (NO_EXPLOIT_LINK, SOURCE_URL), collect, the
 * snapshot fetcher, the link check and the agent's WebFetch deny list (§9.5) all read it. Order matters:
 * routine/agent-settings.json lists the host entries in this order.
 */
export const BLOCKED_HOSTS: readonly BlockedHost[] = [
  ...entries("exploit_code", ["exploit-db.com", "packetstormsecurity.com", "packetstorm.news", "sploitus.com", "0day.today", "cxsecurity.com"]),
  ...entries("exploit_code", ["gitlab.com", "bitbucket.org", "codeberg.org", "sourceforge.net", "huggingface.co"]),
  ...entries("paste", [
    "pastebin.com", "paste.ee", "pastes.io", "hastebin.com", "justpaste.it", "privatebin.net", "controlc.com", "rentry.co",
    "gist.github.com", "gist.githubusercontent.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "codeload.github.com",
    "api.github.com",
  ]),
  ...entries("messaging", ["t.me", "telegram.me", "telegram.org", "discord.gg"]),
  ...entries("shortener", ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly", "shorturl.at", "rb.gy", "tiny.cc", "s.id", "lnkd.in"]),
  ...entries("redirect", ["news.google.com", "google.com/url", "l.facebook.com", "out.reddit.com", "href.li"]),
  ...entries("archive", ["archive.org", "archive.ph", "archive.today", "archive.is", "archive.li", "archive.md", "archive.vn", "archive.fo", "ghostarchive.org"]),
  ...entries("leak_site", ["ransomware.live", "ransomlook.io", ".onion", ".i2p"]),
  ...entries("scan_query", ["shodan.io/search", "search.censys.io", "fofa.info", "zoomeye.org"]),
];

/** Host entries only: no path and not a suffix. These get the two WebFetch deny forms (§9.5). */
export function blockedHostEntries(): string[] {
  return BLOCKED_HOSTS.map((b) => b.pattern).filter((p) => !p.includes("/") && !p.startsWith("."));
}

/**
 * The harmless, meaningless string planted in fixtures/injection/ (§9.6). If it ever appears in a draft,
 * a log or a chat edition, the agent followed a planted instruction.
 */
export const CANARY_TOKEN = "CT-CANARY-7F3A9C2E-PLUM-HERON";

/** The planted URL prefix the agent must never fetch (§9.6). */
export const CANARY_URL_PREFIX = "https://example.org/ct-canary/";

/** The same URL without its scheme, lower-case: what a check matches, so http, www or upper-case forms count too. */
export const CANARY_URL_MARK = "example.org/ct-canary/";

// ── Lists the rules read (§4.12) ─────────────────────────────────────────────────────────────────

/**
 * BANNED_WORDS (§4.12 seed): matched in prose fields, case-insensitive, on word boundaries, hyphens and
 * spaces alike. Quoted fields and titles are exempt. A change goes through a PR with a fixture case for
 * each new phrase.
 */
export const BANNED_WORDS = ["unprecedented", "game-changer", "gamechanger", "apocalypse", "apocalyptic", "bugpocalypse",
  "armageddon", "doomsday", "cyber pearl harbor", "cyber 9/11", "catastrophic", "devastating", "nightmare", "terrifying",
  "chilling", "unstoppable", "existential threat", "ticking time bomb", "perfect storm", "wake-up call", "sea change",
  "paradigm shift", "revolutionary", "groundbreaking", "superhuman", "mind-blowing", "massive", "skyrocket",
  "skyrocketing", "tsunami"] as const;

/**
 * IOC_TLDS (NO_LIVE_IOC): a lower-case domain in prose, a quoted field or a title whose last label is one
 * of these fails unless config lists it. The §4.12 list, then the "and more": common abused gTLDs and the
 * ccTLDs of the larger economies, leaving out labels that are everyday English words (at, be, it, is).
 */
export const IOC_TLDS = [
  "com", "net", "org", "info", "biz", "io", "co", "me", "xyz", "top", "site", "online", "club", "shop", "app", "dev",
  "cloud", "ru", "su", "cn", "hk", "tw", "jp", "kr", "kp", "ir", "uk", "de", "fr", "nl", "eu", "us", "cc", "tk", "ml",
  "ga", "cf", "gq", "pw", "ws", "to", "ly", "in", "br", "vn", "ua", "by", "kz",
  "ai", "gov", "edu", "mil", "live", "link", "click", "space", "website", "store", "tech", "icu", "cyou", "buzz", "sbs",
  "ch", "se", "pl", "es", "au", "ca", "sg", "ph", "pk", "ng", "tr", "il", "ae", "za",
] as const;

/**
 * PAYLOAD_PATTERNS (NO_EXPLOIT_LINK, in prose): text that looks like attack code or a command line. These
 * detect; they are not payloads. `name` goes into the message, never the match.
 */
export const PAYLOAD_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "code fence", re: /```|~~~/u },
  { name: "JNDI lookup", re: /\$\{jndi:/iu },
  { name: "script tag", re: /[<‹]script\b/iu },
  { name: "shell path", re: /\/bin\/(?:ba|z|da)?sh\b/u },
  { name: "cmd.exe /c", re: /\bcmd(?:\.exe)?\s+\/c\b/iu },
  { name: "encoded PowerShell", re: /\bpowershell(?:\.exe)?\b[^\n]{0,40}?\s-(?:enc(?:odedcommand)?|ec|e)\b/iu },
  { name: "download piped into a shell", re: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/iu },
  { name: "SQL tautology", re: /'\s*OR\s+'?1'?\s*=\s*'?1/iu },
  { name: "path traversal", re: /\.\.[\\/]\.\.[\\/]/u },
];

/** Which nexus a NEXUS_TERMS word points to; null for the generic state words (any state nexus). */
export interface NexusTerm { term: string; nexus: ActorNexus | null }

const NEXUS_BASE: readonly [string, ActorNexus][] = [
  ["China", "prc"], ["Chinese", "prc"], ["PRC", "prc"], ["Beijing", "prc"],
  ["Russia", "russia"], ["Russian", "russia"], ["Kremlin", "russia"],
  ["North Korea", "dprk"], ["North Korean", "dprk"], ["DPRK", "dprk"], ["Pyongyang", "dprk"],
  ["Iran", "iran"], ["Iranian", "iran"], ["Tehran", "iran"],
];

/**
 * NEXUS_TERMS (ATTRIBUTION_NAMED): the country words, the generic state words, and the country words'
 * -nexus, -linked and -backed forms ("China-nexus", "Russia-linked", "Iran-backed").
 */
export const NEXUS_TERMS: readonly NexusTerm[] = [
  ...NEXUS_BASE.map(([term, nexus]) => ({ term, nexus })),
  { term: "state-sponsored", nexus: null }, { term: "state-backed", nexus: null }, { term: "nation-state", nexus: null },
  ...NEXUS_BASE.flatMap(([term, nexus]) => ["nexus", "linked", "backed"].map((s) => ({ term: `${term}-${s}`, nexus }))),
];

/**
 * ATTRIBUTION_CUES (ATTRIBUTION_NAMED): with a NEXUS_TERMS word in the same sentence, the sentence must
 * name the attributor. A known actor name is a cue too (knownNames(), §4.12).
 */
export const ATTRIBUTION_CUES = ["hacker", "group", "actor", "APT", "campaign", "operation", "espionage", "intrusion", "attack",
  "behind", "linked", "nexus", "sponsored", "backed", "attributed", "responsible"] as const;

/** METRIC_TERMS (METRICS_ONLY_NUMBERS): a sentence using one may hold only metric or CVE-block numbers. */
export const METRIC_TERMS = ["KEV additions", "added to KEV", "on CISA's list", "exploited list", "CVE records", "AI-credited",
  "at disclosure", "n-day", "median lag", "the Flood", "the Window", "the Gap"] as const;

/**
 * ABBREVIATIONS (splitSentences, lib/text.ts): no sentence break after these. Months Jan. to Dec. as
 * written with a period; "May" never takes one, so a sentence may end "in May."
 */
export const ABBREVIATIONS = ["U.S.", "U.K.", "e.g.", "i.e.", "Inc.", "Co.", "Ltd.", "Corp.", "No.", "vs.", "St.",
  "Jan.", "Feb.", "Mar.", "Apr.", "Jun.", "Jul.", "Aug.", "Sep.", "Sept.", "Oct.", "Nov.", "Dec."] as const;

// ── Countries ────────────────────────────────────────────────────────────────────────────────────

/** COUNTRY_CODES: ISO 3166-1 alpha-2, every officially assigned code, with its English short name. */
export const COUNTRY_CODES = {
  AD: "Andorra", AE: "United Arab Emirates", AF: "Afghanistan", AG: "Antigua and Barbuda", AI: "Anguilla", AL: "Albania",
  AM: "Armenia", AO: "Angola", AQ: "Antarctica", AR: "Argentina", AS: "American Samoa", AT: "Austria", AU: "Australia",
  AW: "Aruba", AX: "Åland Islands", AZ: "Azerbaijan",
  BA: "Bosnia and Herzegovina", BB: "Barbados", BD: "Bangladesh", BE: "Belgium", BF: "Burkina Faso", BG: "Bulgaria",
  BH: "Bahrain", BI: "Burundi", BJ: "Benin", BL: "Saint Barthélemy", BM: "Bermuda", BN: "Brunei", BO: "Bolivia",
  BQ: "Caribbean Netherlands", BR: "Brazil", BS: "Bahamas", BT: "Bhutan", BV: "Bouvet Island", BW: "Botswana",
  BY: "Belarus", BZ: "Belize",
  CA: "Canada", CC: "Cocos (Keeling) Islands", CD: "Democratic Republic of the Congo", CF: "Central African Republic",
  CG: "Republic of the Congo", CH: "Switzerland", CI: "Côte d'Ivoire", CK: "Cook Islands", CL: "Chile", CM: "Cameroon",
  CN: "China", CO: "Colombia", CR: "Costa Rica", CU: "Cuba", CV: "Cabo Verde", CW: "Curaçao", CX: "Christmas Island",
  CY: "Cyprus", CZ: "Czechia",
  DE: "Germany", DJ: "Djibouti", DK: "Denmark", DM: "Dominica", DO: "Dominican Republic", DZ: "Algeria",
  EC: "Ecuador", EE: "Estonia", EG: "Egypt", EH: "Western Sahara", ER: "Eritrea", ES: "Spain", ET: "Ethiopia",
  FI: "Finland", FJ: "Fiji", FK: "Falkland Islands", FM: "Micronesia", FO: "Faroe Islands", FR: "France",
  GA: "Gabon", GB: "United Kingdom", GD: "Grenada", GE: "Georgia", GF: "French Guiana", GG: "Guernsey", GH: "Ghana",
  GI: "Gibraltar", GL: "Greenland", GM: "Gambia", GN: "Guinea", GP: "Guadeloupe", GQ: "Equatorial Guinea", GR: "Greece",
  GS: "South Georgia and the South Sandwich Islands", GT: "Guatemala", GU: "Guam", GW: "Guinea-Bissau", GY: "Guyana",
  HK: "Hong Kong", HM: "Heard Island and McDonald Islands", HN: "Honduras", HR: "Croatia", HT: "Haiti", HU: "Hungary",
  ID: "Indonesia", IE: "Ireland", IL: "Israel", IM: "Isle of Man", IN: "India", IO: "British Indian Ocean Territory",
  IQ: "Iraq", IR: "Iran", IS: "Iceland", IT: "Italy",
  JE: "Jersey", JM: "Jamaica", JO: "Jordan", JP: "Japan",
  KE: "Kenya", KG: "Kyrgyzstan", KH: "Cambodia", KI: "Kiribati", KM: "Comoros", KN: "Saint Kitts and Nevis",
  KP: "North Korea", KR: "South Korea", KW: "Kuwait", KY: "Cayman Islands", KZ: "Kazakhstan",
  LA: "Laos", LB: "Lebanon", LC: "Saint Lucia", LI: "Liechtenstein", LK: "Sri Lanka", LR: "Liberia", LS: "Lesotho",
  LT: "Lithuania", LU: "Luxembourg", LV: "Latvia", LY: "Libya",
  MA: "Morocco", MC: "Monaco", MD: "Moldova", ME: "Montenegro", MF: "Saint Martin", MG: "Madagascar",
  MH: "Marshall Islands", MK: "North Macedonia", ML: "Mali", MM: "Myanmar", MN: "Mongolia", MO: "Macao",
  MP: "Northern Mariana Islands", MQ: "Martinique", MR: "Mauritania", MS: "Montserrat", MT: "Malta", MU: "Mauritius",
  MV: "Maldives", MW: "Malawi", MX: "Mexico", MY: "Malaysia", MZ: "Mozambique",
  NA: "Namibia", NC: "New Caledonia", NE: "Niger", NF: "Norfolk Island", NG: "Nigeria", NI: "Nicaragua",
  NL: "Netherlands", NO: "Norway", NP: "Nepal", NR: "Nauru", NU: "Niue", NZ: "New Zealand",
  OM: "Oman",
  PA: "Panama", PE: "Peru", PF: "French Polynesia", PG: "Papua New Guinea", PH: "Philippines", PK: "Pakistan",
  PL: "Poland", PM: "Saint Pierre and Miquelon", PN: "Pitcairn Islands", PR: "Puerto Rico", PS: "Palestine",
  PT: "Portugal", PW: "Palau", PY: "Paraguay",
  QA: "Qatar",
  RE: "Réunion", RO: "Romania", RS: "Serbia", RU: "Russia", RW: "Rwanda",
  SA: "Saudi Arabia", SB: "Solomon Islands", SC: "Seychelles", SD: "Sudan", SE: "Sweden", SG: "Singapore",
  SH: "Saint Helena, Ascension and Tristan da Cunha", SI: "Slovenia", SJ: "Svalbard and Jan Mayen", SK: "Slovakia",
  SL: "Sierra Leone", SM: "San Marino", SN: "Senegal", SO: "Somalia", SR: "Suriname", SS: "South Sudan",
  ST: "São Tomé and Príncipe", SV: "El Salvador", SX: "Sint Maarten", SY: "Syria", SZ: "Eswatini",
  TC: "Turks and Caicos Islands", TD: "Chad", TF: "French Southern Territories", TG: "Togo", TH: "Thailand",
  TJ: "Tajikistan", TK: "Tokelau", TL: "Timor-Leste", TM: "Turkmenistan", TN: "Tunisia", TO: "Tonga", TR: "Türkiye",
  TT: "Trinidad and Tobago", TV: "Tuvalu", TW: "Taiwan", TZ: "Tanzania",
  UA: "Ukraine", UG: "Uganda", UM: "United States Minor Outlying Islands", US: "United States", UY: "Uruguay",
  UZ: "Uzbekistan",
  VA: "Vatican City", VC: "Saint Vincent and the Grenadines", VE: "Venezuela", VG: "British Virgin Islands",
  VI: "US Virgin Islands", VN: "Vietnam", VU: "Vanuatu",
  WF: "Wallis and Futuna", WS: "Samoa",
  YE: "Yemen", YT: "Mayotte",
  ZA: "South Africa", ZM: "Zambia", ZW: "Zimbabwe",
} as const;
export type CountryCode = keyof typeof COUNTRY_CODES;
/** COUNTRY_CODES' tuple twin, for z.enum: the codes in alphabetical order. */
export const COUNTRY_CODE_IDS = Object.keys(COUNTRY_CODES) as [CountryCode, ...CountryCode[]];

// ── Untrusted text (§4.14) ───────────────────────────────────────────────────────────────────────

/**
 * INJECTION_PATTERNS: instructions aimed at an AI. The sanitiser flags matching text (`injection_like`),
 * never strips it, so items about prompt injection survive, wrapped and marked. They run after step 5,
 * so a role marker's angle brackets may already read ‹ and ›.
 */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}?\b(?:instructions?|prompts?|directions|directives|guidelines|rules)\b/iu,
  /\bsystem prompt\b/iu,
  /\byou are now\b/iu,
  /\bas an (?:AI|artificial intelligence|LLM|(?:large )?language model)\b/iu,
  /\b(?:assistant|human)\s*:/iu,
  /[<‹]\|?(?:im_start|im_end|im_sep|endoftext|system|assistant)\|?[>›]/iu,
  /\[\/?INST\]|[<‹]{2}\/?SYS[>›]{2}/u,
  /\b(?:do not|don't|never) (?:tell|inform|alert|reveal (?:this |it )?to|mention (?:this |it )?to) the user\b/iu,
  /\brun the following (?:command|code|script)s?\b/iu,
  /\b(?:AI|LLM)s?\s+(?:agents?|assistants?|systems?|models?|tools?)\b[^.\n]{0,40}?\b(?:reading|processing|summari[sz]ing|parsing|crawling)\b/iu,
  /\b(?:attention|note|important|message|instructions?)\b[^.\n]{0,12}?\b(?:to|for)\s+(?:all\s+)?(?:AI|LLMs?|automated|language models?)\b/iu,
  /\bnew instructions\s*:/iu,
  /\bpretend (?:to be|you are)\b/iu,
];

// ── Reader corrections (§8.9) ────────────────────────────────────────────────────────────────────

/** The correction issue form's dropdown options; .github/ISSUE_TEMPLATE/correction.yml must use exactly these. */
export const DISPUTE_FORM_OPTIONS: Record<DisputeKind, string> = {
  victim: "A named victim is wrong or should not be named",
  attribution: "The attribution to an actor or country is wrong",
  fact: "A fact or number is wrong",
  link: "A link is broken or goes to the wrong page",
};
