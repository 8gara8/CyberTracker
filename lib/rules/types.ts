// The validator's framework types (SPEC §4.12), copied from the Europe fork's lib/rules/types.ts and
// adapted: ValidationIssue, RuleInput, error(), warning(), and the Rule record each rule module exports
// (its codes, severity, scope and † flag). Every rule is a pure function of a RuleInput; the engine
// (lib/validate.ts) chooses which rules run and filters what they return.

import type { LoadedConfig } from "../config";
import type { RegionsInput } from "../regions";
import type { PublisherKind, Tier } from "../schema/common";
import type { AgentContext } from "../schema/context";
import type { Brief } from "../schema/brief";
import type { DraftBrief } from "../schema/draft-brief";
import type { InputsManifest, Metrics } from "../schema/metrics";
import type { Evidence } from "../schema/misc";

export type { Evidence } from "../schema/misc";

// ── Issues ───────────────────────────────────────────────────────────────────────────────────────

export type IssueSeverity = "error" | "warning";

/**
 * One finding. `path` is formatPath()'s form (`items[3].summary`, `angle.text`, `(root)`, `(file)`), so
 * lib/apply.ts's dropUnverified() can read it. Messages say how to fix the problem: the value found, the
 * rule and the edit ("lead has 97 words; the limit is 90. Cut at least 7."). lib/config.ts's ConfigIssue
 * is this type.
 */
export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  path: string;
  message: string;
  hint: string | null;
}

export function error(code: string, path: string, message: string, hint: string | null = null): ValidationIssue {
  return { code, severity: "error", path, message, hint };
}

export function warning(code: string, path: string, message: string, hint: string | null = null): ValidationIssue {
  return { code, severity: "warning", path, message, hint };
}

// ── What the rules read ──────────────────────────────────────────────────────────────────────────

/** A draft (draft mode) or a published brief (published mode). Narrow with `isBrief()` (shared.ts). */
export type AnyBrief = DraftBrief | Brief;
export type AnyItem = DraftBrief["items"][number] | Brief["items"][number];
export type AnySource = DraftBrief["sources"][number] | Brief["sources"][number];

export type RuleMode = "draft" | "published";

/**
 * One CVE List V5 record as collect fetched it (cache/cvelist/records/<id>.json; fixtures/cvelist/records/),
 * reduced to what CVE_PUBLISHED and the CVE rules read. Built by lib/validate.ts's cveRecordInfo().
 */
export interface CveRecordInfo {
  /** cveMetadata.cveId, upper case. */
  cve_id: string;
  /** cveMetadata.state: only PUBLISHED passes CVE_PUBLISHED. */
  state: "PUBLISHED" | "REJECTED" | "RESERVED";
  /** cveMetadata.datePublished and dateUpdated as UTC dates, or null when absent. */
  date_published: string | null;
  date_updated: string | null;
  /** cveMetadata.assignerShortName (the CNA short name, e.g. "qnap"), or null. */
  assigner: string | null;
  /** The CNA container's affected[].vendor and .product, in order, deduplicated. */
  vendors: string[];
  products: string[];
  /** The CNA title, else the first English description cut to 200 characters, else null. */
  title: string | null;
  /** True when the CNA or an ADP container has a reference tagged "exploit". The URL is never kept. */
  exploit_reference: boolean;
  /** The CISA ADP container's KEV marker (`metrics[].other` of type "kev": `content.dateAdded`), a US date, or null. */
  kev_date_added: string | null;
  /** Credit text from the CNA, then the ADP containers, in order, deduplicated. */
  credits: string[];
}

/**
 * The CVE List as collect fetched it this morning: an upper-case CVE id (`get()` upper-cases its argument)
 * to its record, or undefined when the record was not fetched (an unknown id fails CVE_PUBLISHED). A
 * `Map<string, CveRecordInfo>` keyed by upper-case id fits; lib/validate.ts's cveLookupFromDir() reads a
 * records folder lazily.
 */
export interface CveLookup {
  get(cveId: string): CveRecordInfo | undefined;
}

/** §5.11's RegionsInput without today's items and raises: what REGION_RAISE recomputes the levels from. */
export type RegionsBase = Omit<RegionsInput, "items" | "raises">;

/**
 * A source's publisher as the rules read it (§4.12 "Tier lookup", "Archived briefs"). Draft mode:
 * publisherFor() on the current config. Published mode: the brief's frozen `tier`, `publisher`,
 * `publisher_name` and `state_label`; `kind` and `sole_newsroom_for_critical` are not frozen, so they are
 * null and the draft-only checks that need them (SOURCE_TIER's source_type fit, SOURCE_CRITICAL_TWO's
 * sole-newsroom test, VICTIM_STATUS's newsroom kind) don't run.
 */
export interface PublisherView {
  tier: Tier;
  publisher: string;
  publisher_name: string;
  state_label: string | null;
  kind: PublisherKind | null;
  sole_newsroom_for_critical: boolean | null;
}

/** One publisher after folding (§4.12 "Publishers of an item"): syndicated copies count once. */
export interface PublisherGroup {
  /** Distinct publisher ids folded into this group, in the order the item cites them. */
  publishers: string[];
  /** The item's tier 1 and 2 source ids in the group. */
  source_ids: string[];
  /** The best (lowest) tier among them. */
  tier: Tier;
}

/** An item's publishers: its tier 1 and 2 sources (`source_ids` only), unfolded and folded. */
export interface ItemPublishers {
  /** Distinct `publisher` values: the count before syndicated copies are folded (SOURCE_SYNDICATED). */
  distinct: string[];
  /** Same publisher or titles with Jaccard ≥ 0.8 folded into one: the count §4.12 uses. */
  groups: PublisherGroup[];
}

/** Values computed once per validation and shared by the rules (shared.ts derive()). */
export interface Derived {
  /** The first source with each id. */
  sourcesById: Map<string, AnySource>;
  publisherBySourceId: Map<string, PublisherView>;
  tierBySourceId: Map<string, Tier>;
  /** The first item with each id. */
  itemsById: Map<string, AnyItem>;
  /** By item id (the first item with that id). */
  publishersByItem: Map<string, ItemPublishers>;
  /** Aligned with `items` (so duplicate ids keep their own). */
  publishersByIndex: ItemPublishers[];
  /** The items in display order (orderItems(), §4.6); the agent's order when a best-effort run can't sort them. */
  order: AnyItem[];
}

/**
 * What only validateAll() knows, for the cross-file parts of the "brief, all" rules (GAP_MATCH,
 * COMPUTED_MISMATCH). Null in validateDraft() and in a direct validatePublished() call.
 */
export interface CrossFile {
  /** True for the brief `validateAll(dir, { publishing: D })` names: COMPUTED_MISMATCH then also checks its config-derived fields. */
  publishing: boolean;
  /** metrics/inputs/D.json for the brief's date, when present and valid. */
  inputs: InputsManifest | null;
  /** Every stored brief that parses, oldest first (this one included). */
  briefs: readonly Brief[];
}

/** SPEC §4.12's RuleInput, plus `crossFile` for validateAll(). */
export interface RuleInput {
  /** A DraftBrief in draft mode; a Brief in published mode. */
  draft: AnyBrief;
  mode: RuleMode;
  /** Draft: context.date (the run's Taipei date); published: the brief's own date. */
  date: string;
  /** From a YYYY-MM-DD.json file name, when there is one. */
  fileDate: string | null;
  /** metrics/D.json for the same date: committed, else staged (§8.4). Null skips the rules that need it (METRICS_MISSING). */
  metrics: Metrics | null;
  /** config/ as loaded and checked by lib/config.ts (§4.11). */
  config: LoadedConfig;
  derived: Derived;
  // Draft mode only; null in published mode:
  /** The copy in memory, never drafts/context.json. */
  context: AgentContext | null;
  /** logs/D.evidence.json or fixtures/evidence/<name>.json; null when there is none (SOURCE_UNSEEN only warns). */
  evidence: Evidence | null;
  /** The CVE List as collect fetched it this morning. */
  cveList: CveLookup | null;
  /** signals, history, kevIndex and config (§5.11). */
  regionsBase: RegionsBase | null;
  /** Normalised pack URL → its date: an item's published_at (a UTC timestamp), else a record's date. */
  packDates: Record<string, string> | null;
  /** validateAll() only; null otherwise. */
  crossFile: CrossFile | null;
}

// ── Rules ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a rule runs (§4.12 "Scope"). `draft`: only in validateDraft(). `brief`: in validateDraft() and
 * validatePublished() (a rule whose table scope reads "brief; X draft" is `brief` and skips its draft-only
 * part when `mode` is "published"). `all`: only when validateAll() calls validatePublished() (crossFile set).
 */
export type RuleScope = "draft" | "brief" | "all";

export interface Rule {
  /** Every code the rule reports; the first names it. */
  codes: readonly [string, ...string[]];
  /** Its usual severity (E or W in the rule table); a rule may still report the other where the table says so. */
  severity: IssueSeverity;
  scope: RuleScope;
  /** † in the rule table: it also runs on data-only editions, which run only these. */
  dataOnly: boolean;
  /** Skipped, with one METRICS_MISSING warning from the engine, when `metrics` is null. */
  needsMetrics: boolean;
  check: (input: RuleInput) => ValidationIssue[];
}

export interface RuleSpec {
  code: string | readonly [string, ...string[]];
  severity?: IssueSeverity;
  scope: RuleScope;
  dataOnly?: boolean;
  needsMetrics?: boolean;
  check: (input: RuleInput) => ValidationIssue[];
}

/** Builds a Rule: `defineRule({ code: "ITEM_CAP", scope: "brief", dataOnly: true, check })`. Defaults: error, not †, metrics optional. */
export function defineRule(spec: RuleSpec): Rule {
  const codes = (typeof spec.code === "string" ? [spec.code] : [...spec.code]) as [string, ...string[]];
  return {
    codes,
    severity: spec.severity ?? "error",
    scope: spec.scope,
    dataOnly: spec.dataOnly ?? false,
    needsMetrics: spec.needsMetrics ?? false,
    check: spec.check,
  };
}

/** "a, b, c" for messages. */
export function list(items: readonly string[]): string {
  return items.join(", ");
}

/** "1 word", "2 words". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}
