// The shapes every feed parser returns (SPEC §8.3, §4.13), shared by lib/feeds/*, collect, rank, the
// metrics and the backfill. Types only, plus FeedParseError. Field names of KEV and CVE List entries are as
// their publishers write them; every other shape is ours. Every string here is raw feed data: collect
// sanitises what it stores, and nothing in a feed is ever an instruction.

import type { FeedStatus } from "../schema/status";
import type { FetchErrorClass } from "./http";

/** A feed's state in a run: the same four values as lib/schema/status.ts FeedStatus. */
export type FeedState = FeedStatus;
/** The `sources:check` label (§8.10); NODATE and STALE both map to the `stale` state. */
export type CheckLabel = "OK" | "STALE" | "NODATE" | "FAIL" | "SKIP";

/** The one error a parser throws for bad content; anything else a parser throws is a bug. */
export class FeedParseError extends Error {
  constructor(readonly errorClass: Extract<FetchErrorClass, "parse" | "schema" | "empty">, message: string) {
    super(message);
    this.name = "FeedParseError";
  }
}

/** §8.3 "each returns { newest, items | records, version, sha256 }". `sha256` is of the raw body; `total` counts what was read. */
export interface Parsed<T> {
  newest: string | null;
  entries: T[];
  version: string | null;
  sha256: string;
  total: number;
}

// ── KEV (field names as CISA writes them) ────────────────────────────────────────────────────────

export interface KevEntry {
  cveID: string;
  vendorProject: string;
  product: string;
  vulnerabilityName: string;
  dateAdded: string;
  shortDescription: string;
  requiredAction: string;
  dueDate: string;
  knownRansomwareCampaignUse: string;
  forensicTriage: string | null;
  notes: string;
  cwes: string[];
}

export interface KevCatalog {
  catalogVersion: string;
  dateReleased: string;
  count: number;
  vulnerabilities: KevEntry[];
}

// ── CVE List V5 ──────────────────────────────────────────────────────────────────────────────────

export interface DeltaRef {
  cveId: string;
  cveOrgLink: string;
  githubLink: string;
  dateUpdated: string;
}

export interface DeltaLogEntry {
  fetchTime: string;
  numberOfChanges: number;
  new: DeltaRef[];
  updated: DeltaRef[];
  error: DeltaRef[];
}

/** One credit string, raw: the CNA's array in order, then each ADP entry's. */
export interface CreditString {
  field: "cna.credits" | "adp.credits";
  value: string;
}

/** The lean projection of a CVE record: the clone reader, delta zips, by-id records, the Flood, credits and the join. */
export interface CveFacts {
  /** cveMetadata.cveId. */
  cve_id: string;
  /** "PUBLISHED", "REJECTED" and the like, as written. */
  state: string;
  /** utcDateOf(cveMetadata.datePublished); null when absent or unparsable. */
  date_published: string | null;
  /** cveMetadata.assignerShortName as written ("Linux" is the kernel). */
  assigner: string | null;
  /** §5.4: a numeric baseScore under v4.0, v3.1 or v3.0 in cna.metrics or a CISA-ADP adp[].metrics. */
  scored: boolean;
  credits: CreditString[];
  affected: { vendor: string | null; product: string | null }[];
}

/** The full projection for the pack and rank. cveFacts(raw) equals the CveFacts part of parseCveRecord(raw). */
export interface CveRecord extends CveFacts {
  /** ISO instants; a zone-less time is read as UTC. */
  published_at: string | null;
  updated_at: string | null;
  date_updated: string | null;
  /** Raw; collect sanitises. */
  title: string | null;
  description: string | null;
  /** §4.6 precedence. */
  cvss: { score: number; version: "4.0" | "3.1" | "3.0"; vector: string; scorer: "cna" | "cisa_adp" } | null;
  cna_severity: string | null;
  /** Lower-cased values. */
  ssvc: { exploitation: string; automatable: string; technical_impact: string; date: string } | null;
  kev_marker: string | null;
  references: { url: string; tags: string[]; from: "cna" | "adp" }[];
  exploit_reference: boolean;
}

// ── EPSS ─────────────────────────────────────────────────────────────────────────────────────────

export interface EpssScore {
  epss: number;
  percentile: number;
}

export interface EpssDay {
  model_version: string;
  score_date: string;
  scores: ReadonlyMap<string, EpssScore>;
}

// ── GitHub advisories (OSV, git export) ──────────────────────────────────────────────────────────

/** `fixed`: some affected[].ranges[].events[] entry has a `fixed` key (ghsaIsFixed()). */
export interface GhsaAdvisory {
  id: string;
  aliases: string[];
  cve_ids: string[];
  published_at: string;
  /** UTC date of published_at. */
  published: string;
  modified: string;
  withdrawn: string | null;
  severity: string | null;
  reviewed: boolean;
  fixed: boolean;
  summary: string | null;
  packages: { ecosystem: string; name: string }[];
}

// ── Text feeds and notes ─────────────────────────────────────────────────────────────────────────

export interface RawItem {
  title: string;
  url: string;
  published_at: string | null;
  snippet: string;
}

export interface CertNote {
  id: string;
  title: string;
  url: string;
  text: string;
  published_at: string | null;
  cve_ids: string[];
  alert: boolean;
}

export interface JvnNote {
  id: string;
  title: string;
  link: string;
  description: string;
  cve_ids: string[];
  cvss: { score: number; version: string } | null;
  issued: string | null;
  modified: string | null;
}

/** The Anthropic disclosure dashboard; the shape is confirmed by the Kobol capture. */
export interface CvdDashboard {
  revision: string;
  as_of: string;
  found_n: number | null;
  disclosed_n: number | null;
  patched_n: number | null;
  ledger_ids: string[];
}

export interface ExchangeNotice {
  company_code: string;
  company: string;
  subject: string;
  text: string;
  /** +08:00 instant. */
  spoken_at: string;
  url: string;
}
