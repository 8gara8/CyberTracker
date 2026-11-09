import { z } from "zod";
import { TOPICS } from "../vocab";
import {
  ActorNexus, AiConfidence, AiCreditRule, AiEvidence, AiRole, Attribution, ClaimType, ConfigId, Count, CorrectionId, CreditField,
  CveId, CvssScorer, CvssVersion, DiscoveryCredit, ExploitationBasis, Exposure, FinderFamily, FinderKind, FlawEvidence, Fraction,
  GhsaId, Incident, IsoDate, IsoTimestamp, ItemRegions, KindId, Ransomware, ReleaseId, Severity, TopicId, VendorRef, refs,
  uniqueArray, words,
} from "./common";

// An item and its CVE block (SPEC §4.6). DraftItem holds the M fields only, so a draft that writes an S
// field (actor_nexus, cves, tier, ...) fails SCHEMA with "Unknown key" (§4.4). Item adds the S fields in
// the spec's key order.

export const AiCredit = z.strictObject({
  finder_id: ConfigId.describe('ai-finders.json id, e.g. "anthropic-claude", "google-big-sleep", "xbow"'),
  family: FinderFamily,
  kind: FinderKind,
  field: CreditField,
  matched: z.string().min(1).max(120).describe("The matched substring only"),
  rule: AiCreditRule,
  finders_version: Count,
});

/** All S: built by publish from the run's feed cache as of data_cutoff_utc plus the checked flaw_evidence. */
export const CveBlock = z.strictObject({
  cve_id: CveId,
  date_published: IsoDate,
  date_updated: IsoDate,
  assigner: z.string().min(1).describe('The CNA short name, e.g. "qnap", "Linux", "mitre"'),
  vendor: VendorRef,
  product: z.string().max(120),
  title: z.string().min(1).max(200),
  cvss: z.strictObject({ score: z.number().min(0).max(10), version: CvssVersion, vector: z.string().min(1), scorer: CvssScorer }).nullable(),
  epss: z.strictObject({ score: Fraction, percentile: Fraction, date: IsoDate }).nullable(),
  ssvc: z.strictObject({
    exploitation: z.enum(["none", "poc", "active"]),
    automatable: z.enum(["yes", "no"]),
    technical_impact: z.enum(["partial", "total"]),
    date: IsoDate,
  }).nullable(),
  kev: z.strictObject({
    date_added: IsoDate.describe("US date"),
    due_date: IsoDate.describe("US date"),
    ransomware: Ransomware,
    catalog_version: z.string().min(1),
  }).nullable(),
  credits: z.array(z.string().min(1).max(200)).max(10),
  ai_credit: AiCredit.nullable(),
  discovery_credit: DiscoveryCredit,
  advisory_date: IsoDate.nullable(),
  patch: z.strictObject({ date: IsoDate, basis: z.enum(["vendor_advisory", "ghsa_fixed_version"]), source_url: z.string().min(1) }).nullable(),
  exploitation_evidence: z.array(z.strictObject({ date: IsoDate, basis: ExploitationBasis, source_url: z.string().min(1) })),
  exploit_reference: z.boolean().describe("The CVE record has a reference tagged exploit; the URL is never stored"),
  vendor_confirmed: z.boolean(),
  vendor_confirmed_by: z.enum(["vendor_cna", "vendor_advisory", "ghsa_reviewed"]).nullable(),
  ghsa_ids: z.array(GhsaId).max(5),
  captured_at: IsoTimestamp,
});

/** Patch batches; all S, from the release candidate (§5.12). */
export const ReleaseBlock = z.strictObject({
  release_id: ReleaseId,
  vendor: VendorRef,
  date: IsoDate.describe("Release date as the vendor states it"),
  title: z.string().min(1).max(200),
  fixes_n: Count,
  critical_n: Count.nullable(),
  exploited_n: Count,
  exploited_cve_ids: z.array(CveId),
  counted_from: z.enum(["vendor_api", "cve_list"]),
  source_url: z.string().min(1),
});

// M fields, in Item's key order. actor_nexus (S) sits between attribution and incident in Item.
const itemHead = {
  id: z.string().describe("cve-YYYY-NNNNN (the first CVE id, lower case) for a flaw item with a CVE; else the kind's slug prefix, e.g. pt-microsoft-2026-11, inc-retail-nl-2026-10. Never names a victim. At most 64 characters"),
  kind: KindId,
  headline: z.string().min(1).max(90).describe("At most 90 characters, plain text, no URL"),
  summary: words("Top stories (items 0 to 2): at most 55 words; Also-today rows: at most 25 words"),
  why_it_matters: words("One strategic sentence of at most 25 words; required for the top three in a full edition; summary + why_it_matters at most 70 words").nullable(),
  severity: Severity.nullable().describe("Required for kinds whose severity is required; null for policy, ai_capability and ecosystem"),
  landmark: z.boolean().describe("Only on a kind without severity; sorts as Elevated"),
  ai_role: AiRole.describe("none unless a source says otherwise; never guessed. unassessed is for data-only editions only"),
  ai_role_secondary: AiRole.nullable().describe("An AI-linked role different from ai_role"),
  ai_confidence: AiConfidence.nullable().describe("null exactly when ai_role is none or unassessed"),
  ai_claimant: z.string().min(1).max(60).nullable().describe("Required when ai_confidence is claimed"),
  ai_evidence: z.array(AiEvidence).describe("1 to 3 when ai_role is AI-linked; [] otherwise"),
  claim_type: ClaimType,
  regions: ItemRegions.describe("At least 1, no repeats, in the order US, EU, TW, JP, GLOBAL"),
  topics: uniqueArray(TopicId, "topics").max(3).describe(`0 to 3 of ${TOPICS.join(", ")}`),
  attribution: z.array(Attribution).max(4).describe("0 to 4, one per attributor"),
};
const itemTail = {
  incident: Incident.nullable().describe("Required for breach; allowed for supply_chain and campaign; else null"),
  cve_ids: uniqueArray(CveId, "cve_ids").max(20).describe("0 to 20, upper case; at least 1 when id starts cve-, and then id is cve_ids[0] lower-cased"),
  release_id: ReleaseId.nullable().describe("Required for patch_batch: the release candidate's release_id; else null"),
  flaw_evidence: z.array(FlawEvidence).max(10),
  exploit_reported_in_sources: z.boolean().nullable().describe("true when a cited source reports a public exploit or proof of concept; false when one says none is known; null when sources are silent. Never a link"),
  exposure: Exposure.nullable().describe("Only when a public source gives an exposure figure"),
  standing_story: ConfigId.nullable().describe("An id from the context's standing_stories"),
  source_ids: refs("At least 1, from this brief's sources, at least 1 of tier 1 or 2; a critical item needs two publishers, one of tier 1"),
};

export const DraftItem = z.strictObject({ ...itemHead, ...itemTail });

export const Item = z.strictObject({
  ...itemHead,
  actor_nexus: ActorNexus.nullable(),
  ...itemTail,
  first_seen: IsoDate,
  vendor: VendorRef.nullable(),
  cves: z.array(CveBlock),
  release: ReleaseBlock.nullable(),
  public_exploit: z.enum(["yes", "no"]).nullable(),
  anthropic_disclosure: z.boolean(),
  withheld: z.strictObject({ correction_id: CorrectionId, since: IsoDate }).nullable(),
});

export type AiCredit = z.infer<typeof AiCredit>;
export type CveBlock = z.infer<typeof CveBlock>;
export type ReleaseBlock = z.infer<typeof ReleaseBlock>;
export type DraftItem = z.infer<typeof DraftItem>;
export type Item = z.infer<typeof Item>;
