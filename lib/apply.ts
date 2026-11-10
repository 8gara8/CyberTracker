// Draft to Brief (SPEC §4.5, §4.12). P1 holds only the soft pass's dropUnverified(); P3 adds applyDraft(),
// which adds every S and C field. Pure: no filesystem, clock or git, and the input draft is never changed.
// Step S0 wrote applyDraft()'s types (plan §2.4, amendments A5 and A6); lane L3 wrote the bodies, ported
// from fixtures/src/site.ts (freezeSource, recordBlock, kevBlock, releaseBlock, freezeItems, actorsSeen,
// regionsFor, gapOf, lensScript, computedOf), so a brief built here equals the sample content's. The
// helpers below the types are exported for lib/data-only.ts and lib/withhold.ts.

import { matchVendor, type LoadedConfig } from "./config";
import { addDays, utcDateOf } from "./dates";
import { parseCveRecord } from "./feeds/cvelist";
import { ghsaRecordUrl } from "./feeds/ghsa";
import type { CveRecord } from "./feeds/types";
import { actorNexusOf, publicExploitOf } from "./items";
import { creditTexts, matchRecord } from "./metrics/ai-credit";
import { kevLines } from "./metrics/headline";
import { fmt1, fmt2, fmtDays, fmtInt, fmtPct } from "./metrics/stats";
import { computeRegions, regionItems } from "./regions";
import { mentionsAnthropic } from "./rules/ai";
import { READING_WORDS_PER_MINUTE, aiLinkedOf, lateOf, manifestFacts, vendorConfirmedByOf } from "./rules/computed";
import type { CveLookup, RegionsBase } from "./rules/types";
import { pageWords } from "./rules/words";
import { sanitize } from "./sanitize";
import { publisherFor } from "./sources";
import { Brief, type ActorSeen, type FeedStale, type GapRef, type TaiwanLens } from "./schema/brief";
import { ID_PATTERNS, type Ransomware, type Source, type VendorRef } from "./schema/common";
import type { Vendor } from "./schema/config";
import type { AgentContext, Candidate } from "./schema/context";
import type { DraftAngle, DraftBrief, DraftCorrection } from "./schema/draft-brief";
import type { CveBlock, DraftItem, Item, ReleaseBlock } from "./schema/item";
import type { InputsManifest, KevIndexFile, KevIndexRow, Metrics } from "./schema/metrics";
import type { ArchiveIndex, ArchiveUrl, Correction, CorrectionsFile, Dispute, Evidence } from "./schema/misc";
import type { Claim, ClaimState, ScoreboardEntry, ScoreboardFile } from "./schema/scoreboard";
import type { Recheck } from "./schema/status";
import { normalizeUrl } from "./urls";
import { KEV_ABSENCE_NOTE, type ClaimMetricPath, type RecheckFlag } from "./vocab";
import { bindingWithholds, maskWithheld, type MaskedItem } from "./withhold-mask";

/** The issue fields dropUnverified() reads; lib/rules/types.ts's ValidationIssue fits. */
export interface SoftIssue {
  code: string;
  path: string;
}

/** A draft after the soft pass: the Angle may have been dropped (§4.5 stores it as null). */
export type GatedDraft = Omit<DraftBrief, "angle"> & { angle: DraftAngle | null };

/**
 * A draft the composer cannot freeze into an edition because a fact §4.6 needs has no source: a release
 * with no date or page, or a CVE with no publication date or assigner. Validation makes these rare (a
 * patch batch whose sources are all press and whose release lists no CVE the morning fetched is the one
 * known path); publish reports one as PublishError("compose"), never as an uncaught throw.
 */
export class ComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeError";
  }
}

/** The soft-gate codes (§4.12 "Snapshot soft gates"). */
export const SNAP_CODES = ["SNAP_NUMBER", "SNAP_NAME", "SNAP_QUOTE", "SNAP_MISSING"] as const;
export type SnapCode = (typeof SNAP_CODES)[number];
const SNAP_SET: ReadonlySet<string> = new Set(SNAP_CODES);
/** Codes that drop any item; SNAP_MISSING drops only a Critical one. */
const UNVERIFIED: ReadonlySet<string> = new Set(["SNAP_NUMBER", "SNAP_NAME", "SNAP_QUOTE"]);

/** What dropUnverified() removed, for logs/D.dropped.json and the run log only (§4.12 "Recorded"). */
export interface DropReport {
  items: { index: number; id: string; headline: string; codes: string[] }[];
  angle: { text: string; codes: string[] } | null;
  scoreboard_entries: { index: number; claim_id: string; codes: string[] }[];
}

const ITEM_PATH_RE = /^items(?:\[(\d+)\]|\.(\d+))(?=$|[.[])/;
const ENTRY_PATH_RE = /^scoreboard_entries(?:\[(\d+)\]|\.(\d+))(?=$|[.[])/;
const ANGLE_PATH_RE = /^angle(?=$|[.[])/;

function indexAt(re: RegExp, path: string): number | null {
  const m = re.exec(path);
  return m ? Number(m[1] ?? m[2]) : null;
}

function addCode(map: Map<number, Set<string>>, index: number, code: string): void {
  const set = map.get(index) ?? new Set<string>();
  set.add(code);
  map.set(index, set);
}

/**
 * The soft pass's drop (§4.12 "Snapshot soft gates", step 3), given the draft and the issues of its last
 * validation (only SNAP_* codes are read; paths as lib/validate.ts formats them, `items[3].summary`):
 * - removes every item carrying SNAP_NUMBER, SNAP_NAME or SNAP_QUOTE, and every Critical item carrying
 *   SNAP_MISSING (never a non-critical one);
 * - sets `angle` to null when any SNAP_* code is on an `angle` path;
 * - removes a scoreboard entry whose quote carries SNAP_QUOTE (an unverified quote is never published);
 * - deletes the dropped item ids from every `item_ids` list: the Lead, the Taiwan Lens and its rows and
 *   Japan block, and `region_raises`. Lists left empty stay empty: the hard rules run again and what the
 *   drop broke goes to the next repair round.
 * Sources are kept (an orphan is only SOURCE_ORPHAN's warning), so source ids keep their numbering.
 */
export function dropUnverified(draft: DraftBrief | GatedDraft, issues: readonly SoftIssue[]): { draft: GatedDraft; report: DropReport } {
  const itemCodes = new Map<number, Set<string>>();
  const entryCodes = new Map<number, Set<string>>();
  const angleCodes = new Set<string>();
  for (const issue of issues) {
    if (!SNAP_SET.has(issue.code)) continue;
    const item = indexAt(ITEM_PATH_RE, issue.path);
    if (item !== null) addCode(itemCodes, item, issue.code);
    else if (ANGLE_PATH_RE.test(issue.path)) angleCodes.add(issue.code);
    else if (issue.code === "SNAP_QUOTE") {
      const entry = indexAt(ENTRY_PATH_RE, issue.path);
      if (entry !== null) addCode(entryCodes, entry, issue.code);
    }
  }

  const out = structuredClone(draft) as GatedDraft;
  const report: DropReport = { items: [], angle: null, scoreboard_entries: [] };

  const dropIndex = new Set<number>();
  draft.items.forEach((item, i) => {
    const codes = [...(itemCodes.get(i) ?? [])];
    const drop = codes.some((c) => UNVERIFIED.has(c)) || (codes.includes("SNAP_MISSING") && item.severity === "critical");
    if (!drop) return;
    dropIndex.add(i);
    report.items.push({ index: i, id: item.id, headline: item.headline, codes: codes.sort() });
  });
  out.items = out.items.filter((_, i) => !dropIndex.has(i));

  if (draft.angle && angleCodes.size > 0) {
    report.angle = { text: draft.angle.text, codes: [...angleCodes].sort() };
    out.angle = null;
  }

  const entryDrop = new Set<number>();
  draft.scoreboard_entries.forEach((entry, i) => {
    const codes = entryCodes.get(i);
    if (!codes) return;
    entryDrop.add(i);
    report.scoreboard_entries.push({ index: i, claim_id: entry.claim_id, codes: [...codes].sort() });
  });
  out.scoreboard_entries = out.scoreboard_entries.filter((_, i) => !entryDrop.has(i));

  // An id survives when any remaining item still carries it (ID_DUPLICATE is the hard rule's business).
  const remaining = new Set(out.items.map((item) => item.id));
  const gone = new Set(report.items.map((d) => d.id).filter((id) => !remaining.has(id)));
  if (gone.size > 0) {
    const keep = (ids: string[]) => ids.filter((id) => !gone.has(id));
    for (const s of out.lead) s.item_ids = keep(s.item_ids);
    out.taiwan_lens.item_ids = keep(out.taiwan_lens.item_ids);
    for (const row of out.taiwan_lens.rows) row.item_ids = keep(row.item_ids);
    out.taiwan_lens.japan.item_ids = keep(out.taiwan_lens.japan.item_ids);
    for (const r of out.region_raises) r.item_ids = keep(r.item_ids);
  }
  return { draft: out, report };
}


// ── applyDraft() (§4.4, §4.5, §8.7 step 4; plan §2.4, A5, A6) ───────────────────────────────────

/** Normalised URL → its snapshot's text hash and fetch time (archive-index.json sha256 when first cited). */
export type SnapshotHashes = Readonly<Record<string, { sha256: string; fetched_at: string }>>;

/**
 * The facts a frozen CVE block needs beyond CveRecordInfo (plan A5), from the run's feed cache: the raw
 * CVE JSON 5 record (CNA and ADP containers: cvss, ssvc), the KEV catalog row, the EPSS score and the
 * reviewed GHSA advisories. scripts/lib/cve-facts.ts cveFactsFor() builds it (lane L2).
 */
export interface CveFacts {
  /** The raw CVE JSON 5 record: CNA and ADP containers (cvss, ssvc). */
  record(cveId: string): unknown | null;
  /**
   * The KEV catalog entry. `vulnerabilityName` (optional, added by L3): the catalog's name, the block
   * title's first choice (§4.6); without it the title is the CNA title, else the description.
   */
  kev(cveId: string): { dateAdded: string; dueDate: string; ransomware: Ransomware; catalogVersion: string; vulnerabilityName?: string | null } | null;
  epss(cveId: string): { score: number; percentile: number; date: string } | null;
  /** Reviewed advisories naming the CVE, at most 5. */
  ghsaIds(cveId: string): string[];
  /**
   * The reviewed, not withdrawn advisories naming the CVE, oldest `published` (UTC date) first, each with
   * whether it lists a fixed version (optional, as vulnerabilityName is): §4.6's fallbacks for
   * advisory_date and patch (basis ghsa_fixed_version). Without it neither fallback applies.
   */
  ghsaAdvisories?(cveId: string): { id: string; published: string; fixed: boolean }[];
}

/** What every composer reads (applyDraft, composeDataOnly). */
export interface ComposeCommon {
  date: string;
  config: LoadedConfig;
  /** metrics/D.json (committed or staged). */
  metrics: Metrics;
  /** kevIndexFor(). */
  kevIndex: KevIndexFile;
  /** readHistory(content, D, 30), newest first (regions, corrections; first_seen when `firstSeen` is absent). */
  history: readonly Brief[];
  /**
   * firstSeenBefore(content, D): item id → its earliest stored brief before D, over every brief, so an item
   * first seen more than 30 days ago keeps its date (XREF_FIRST_SEEN). Publish always passes it; without
   * it first_seen comes from `history`.
   */
  firstSeen?: ReadonlyMap<string, string>;
  regionsBase: RegionsBase;
  /** As synced. */
  archiveIndex: ArchiveIndex | null;
  scoreboard: ScoreboardFile | null;
  corrections: CorrectionsFile | null;
  feedsStale: readonly FeedStale[];
  /** +08:00 */
  publishedAt: string;
  generatedAt: string;
}

/** The files a composer changes; publish writes each through its schema. */
export interface ContentChanges {
  /** briefs/D.json */
  brief: Brief | null;
  /** Archived briefs a withhold rewrote. */
  rewritten: Brief[];
  /** null: unchanged. */
  scoreboard: ScoreboardFile | null;
  /** null: unchanged. */
  corrections: CorrectionsFile | null;
  archiveIndex: ArchiveIndex;
  /** Re-check flags a draft correction answered: publish fills RunRecord.recheck.flagged[].correction_id. */
  flagCorrections: { item_id: string; edition_date: string; flag: RecheckFlag; correction_id: string }[];
  /** applyDraft() only: the draft items it withheld because they re-report a withheld item (lib/withhold-mask.ts). */
  masked?: MaskedItem[];
}

export interface ApplyInput extends ComposeCommon {
  edition: "full" | "partial";
  draft: GatedDraft;
  context: AgentContext;
  /** seen_as per source (§8.12). */
  evidence: Evidence;
  /** Frozen CVE blocks. */
  cveList: CveLookup;
  /** archive-index sha256 when first cited. */
  snapshots: SnapshotHashes;
  /** Carried from the stored brief. */
  dataOnlyPublishedAt: string | null;
  disputes: readonly Dispute[] | null;
  recheck: Recheck | null;
  /** cvss, ssvc, KEV due date and catalog version, EPSS, GHSA ids (A5). */
  facts: CveFacts;
  /** metrics/inputs/D.json: a CVE's row gives ai_credit, kev.date_added, date_published and vendor.id (A5). */
  inputs: InputsManifest | null;
  /** SHA-256 of metrics/D.json as committed: gap.metrics_sha256 (A5). */
  metricsSha256: string;
}

/**
 * The brief for D with every S and C field (§8.7 step 4); brief.late = lateOf(); Brief.parse()d. Also
 * returns scoreboard.json (always: each publish sets the zones and as_of, §4.9), corrections.json (null
 * unless the draft adds a correction), the archive index and the re-check flags the corrections answer.
 * Archived briefs are never touched here: a withhold is composeWithholds()'s job. But a withhold binds the
 * editions after it: a draft item that re-reports an item withheld under an open or upheld victim or
 * attribution dispute (its id on that item's edition date, or a cited URL whose archive-index item_ids
 * hold it) is masked as §4.10 masks the archived item, and listed in `masked` (lib/withhold-mask.ts).
 */
export function applyDraft(i: ApplyInput): ContentChanges {
  const c = i.config;
  const m = i.metrics;
  const d = structuredClone(i.draft) as GatedDraft;
  const sources = d.sources.map((s) => freezeSource(s, seenAsOf(i.evidence, s.url), c));
  const cveInputs: CveBlockInputs = {
    config: c, facts: i.facts, cveList: i.cveList, kevIndex: i.kevIndex, inputs: i.inputs,
    findersVersion: findersVersionOf(m, c), capturedAt: i.publishedAt,
  };
  const releases = new Map<string, NonNullable<Candidate["release"]>>();
  for (const cand of i.context.candidates) if (cand.release && !releases.has(cand.release.release_id)) releases.set(cand.release.release_id, cand.release);
  const items = freezeItems(d.items, sources, {
    config: c, date: i.date, history: i.history, firstSeen: i.firstSeen,
    blocks: (it) => it.cve_ids.map((cve) => cveBlockOf(cve, it, sources, cveInputs)),
    release: (it) => releaseBlockOf(it, it.release_id ? releases.get(it.release_id) ?? null : null, sources, c, i.cveList),
  });
  const board = updateScoreboard({ date: i.date, config: c, metrics: m, scoreboard: i.scoreboard, reports: d.scoreboard_entries, sources: d.sources });
  const corr = composeCorrections(i, d.corrections, d.sources);

  const { region_raises: raises, scoreboard_entries: _entries, ...rest } = d;
  const b: Brief = {
    ...rest,
    edition: i.edition,
    published_at: i.publishedAt,
    data_only_published_at: i.dataOnlyPublishedAt,
    late: false,
    data_cutoff_utc: m.data_cutoff_utc,
    angle: d.angle ? { ...d.angle, claim_text: claimTextOf(c, d.angle.claim_id) } : null,
    regions: computeRegions({ ...i.regionsBase, items: regionItems(items, sources, i.regionsBase.config), raises }),
    gap: gapOf(m, i.metricsSha256),
    items,
    actors_seen: actorsSeenOf(items, c),
    taiwan_lens: { ...d.taiwan_lens, ...lensScriptOf(m, i.date, c) },
    scoreboard: board.brief,
    week_in_review: d.week_in_review
      ? { ...d.week_in_review, from: addDays(i.date, -7), to: addDays(i.date, -1), table: weekTable(board.file.claims) }
      : null,
    corrections: corr.listed,
    epss_movers: [],
    feeds_stale: [...i.feedsStale],
    sources,
    computed: emptyComputed(),
  };
  const masked = maskWithheld(b, { binding: bindingWithholds(i.corrections, i.disputes), archiveIndex: i.archiveIndex, history: i.history });
  b.late = lateOf(b, c);
  b.computed = computedOf(b, m);
  const brief = Brief.parse(b);
  return {
    brief,
    rewritten: [],
    scoreboard: board.file,
    corrections: corr.file,
    archiveIndex: updateArchiveIndex(i.archiveIndex, brief, i.snapshots, corr.all),
    flagCorrections: corr.flags,
    masked,
  };
}

// ── Sources ──────────────────────────────────────────────────────────────────────────────────────

/** A source as publish freezes it (§4.3): publisherFor() on the run's config, and how the run saw the URL. */
export function freezeSource(s: DraftBrief["sources"][number], seenAs: Source["seen_as"], config: LoadedConfig): Source {
  const p = publisherFor(s.url, s.source_type, config);
  return { ...s, publisher: p.publisher, publisher_name: p.publisher_name, tier: p.tier, state_label: p.state_label, seen_as: seenAs };
}

/** §8.12: the evidence's seen_as for the normalised URL, else "pack". */
export function seenAsOf(evidence: Pick<Evidence, "seen_as"> | null, url: string): Source["seen_as"] {
  return evidence?.seen_as[normalizeUrl(url)] ?? "pack";
}

// ── CVE blocks (§4.6; plan A5) ───────────────────────────────────────────────────────────────────

/** The KEV catalog entry page of a CVE: a kev_listed evidence URL (§4.6). */
export const kevEntryUrl = (cve: string): string => `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=${cve}`;

/** A CVE record's page on cve.org: a data-only item's source (§4.5) and A6's fallback release URL. */
export const cveRecordPage = (cve: string): string => `https://www.cve.org/CVERecord?id=${cve}`;

/** A matched vendor as a VendorRef, else the unmatched name (id and country null, §4.6). */
export function vendorRefOf(v: Vendor | null, fallback: string): VendorRef {
  return v ? { id: v.id, name: v.name.slice(0, 80), country: v.country } : { id: null, name: fallback.slice(0, 80), country: null };
}

/** A CVE block before vendor_confirmed_by, which needs the item's frozen sources. */
export type BareCveBlock = Omit<CveBlock, "vendor_confirmed" | "vendor_confirmed_by">;

/** What cveBlockOf() reads besides the item. */
export interface CveBlockInputs {
  config: LoadedConfig;
  facts: CveFacts;
  /** The CVE List as collect fetched it: used when `facts` holds no raw record. */
  cveList: CveLookup | null;
  /** The KEV index: vendorProject and product, and the record's date and assigner when no record exists. */
  kevIndex: Pick<KevIndexFile, "entries">;
  /** metrics/inputs/D.json (A5): its rows win for kev.date_added, date_published, vendor.id and ai_credit. */
  inputs: InputsManifest | null;
  /** ai_credit.finders_version: the metrics' ai_credited.finders_version, else the config's. */
  findersVersion: number;
  /** When publish builds the block: captured_at, and the cut for record updates and SSVC decisions. */
  capturedAt: string;
}

/** ai_credit.finders_version: the list the metrics matched with, else the run's config. */
export function findersVersionOf(m: Pick<Metrics, "ai_credited"> | null, config: LoadedConfig): number {
  return m?.ai_credited?.finders_version ?? config.aiFinders.version;
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const nonNull = <T>(x: T | null | undefined): x is T => x !== null && x !== undefined;

function uniqStrings(xs: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const x of xs) {
    const t = typeof x === "string" ? x.trim() : "";
    if (t !== "" && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The timestamp of the CISA-ADP SSVC decision parseCveRecord() reads (its first complete one), or null. */
function ssvcTimestamp(raw: unknown): string | null {
  for (const a of arr(obj(obj(raw).containers).adp)) {
    if (obj(obj(a).providerMetadata).shortName !== "CISA-ADP") continue;
    for (const mm of arr(obj(a).metrics)) {
      const other = obj(obj(mm).other);
      if (other.type !== "ssvc") continue;
      const ts = obj(other.content).timestamp;
      if (typeof ts === "string") return ts;
    }
  }
  return null;
}

const SSVC_EXPLOITATION = ["none", "poc", "active"] as const;
const SSVC_AUTOMATABLE = ["yes", "no"] as const;
const SSVC_IMPACT = ["partial", "total"] as const;
const oneOf = <T extends string>(xs: readonly T[], v: string): v is T => (xs as readonly string[]).includes(v);

/** At or before `cut` (two instants); an unreadable instant counts as before. */
const notAfter = (instant: string | null, cut: string) => instant === null || !(Date.parse(instant) > Date.parse(cut));

function ssvcOf(rec: CveRecord | null, raw: unknown, capturedAt: string): CveBlock["ssvc"] {
  const s = rec?.ssvc;
  if (!s || !notAfter(ssvcTimestamp(raw), capturedAt)) return null;
  const { exploitation: e, automatable: a, technical_impact: t } = s;
  if (!oneOf(SSVC_EXPLOITATION, e) || !oneOf(SSVC_AUTOMATABLE, a) || !oneOf(SSVC_IMPACT, t)) return null;
  return { exploitation: e, automatable: a, technical_impact: t, date: s.date };
}

/** Sanitised and cut to `max` (§4.14); `fallback` when nothing is left. */
function cleanText(text: string | null | undefined, max: number, fallback: string): string {
  const t = text ? sanitize(text, { max }) : "";
  return t !== "" ? t : sanitize(fallback, { max }) || "CVE record";
}

/**
 * One CVE block (§4.6), from the raw record in `facts` (else the CVE List entry, else the KEV index row
 * alone), the KEV catalog, EPSS and GHSA facts, the manifest rows (A5) and the item's checked flaw
 * evidence. Throws ComposeError when no source gives the record's publication date and assigner.
 */
export function cveBlockOf(
  cve: string, item: Pick<DraftItem, "flaw_evidence">, sources: readonly Pick<Source, "id" | "url">[], x: CveBlockInputs,
): BareCveBlock {
  const id = cve.toUpperCase();
  const raw = x.facts.record(id);
  const rec = raw === null || raw === undefined ? null : parseCveRecord(raw);
  const info = rec ? null : x.cveList?.get(id) ?? null;
  const row: KevIndexRow | null = x.kevIndex.entries.find((r) => r[0] === id) ?? null;
  const kev = x.facts.kev(id);
  const mf = x.inputs ? manifestFacts(x.inputs, id) : null;

  const datePublished = mf?.date_published[0]?.value ?? rec?.date_published ?? info?.date_published ?? row?.[4] ?? null;
  const assigner = rec?.assigner ?? info?.assigner ?? row?.[5] ?? null;
  if (!datePublished || !assigner) throw new ComposeError(`No CVE record facts for ${id}: its publication date or assigner is unknown`);
  const updated = rec
    ? (rec.date_updated && notAfter(rec.updated_at, x.capturedAt) ? rec.date_updated : null)
    : info?.date_updated ?? null;

  const vendors = rec ? uniqStrings(rec.affected.map((a) => a.vendor)) : info?.vendors ?? [];
  const products = rec ? uniqStrings(rec.affected.map((a) => a.product)) : info?.products ?? [];
  const vendorProject = row?.[2] ?? vendors[0] ?? "";
  const matched = matchVendor(x.config, { kevVendorProject: row?.[2], affectedVendors: vendors });
  const manifestVendor = mf?.vendor_id[0]?.value;
  const vendor = manifestVendor ? x.config.vendors.vendors.find((v) => v.id === manifestVendor) ?? matched : matched;
  const product = (row?.[3] ?? products[0] ?? "").slice(0, 120);

  const credits = uniqStrings(
    (rec ? creditTexts(rec, null).map((t) => t.text) : (info?.credits ?? []).map((t) => sanitize(t))).map((t) => sanitize(t, { max: 200 })),
  ).slice(0, 10);
  const manifestCredit = mf?.ai_credit[0] ?? null;
  const hit = manifestCredit
    ? { finder_id: manifestCredit.finder_id, family: manifestCredit.family, kind: manifestCredit.kind, field: manifestCredit.field, matched: manifestCredit.matched, rule: manifestCredit.rule }
    : rec
      ? matchRecord(rec, null, x.config.compiled.aiFinders)
      : info
        ? matchRecord({ cve_id: id, state: info.state, date_published: info.date_published, credits: info.credits.map((value) => ({ field: "cna.credits" as const, value })) }, null, x.config.compiled.aiFinders)
        : null;
  const aiCredit: CveBlock["ai_credit"] = hit
    ? { finder_id: hit.finder_id, family: hit.family, kind: hit.kind, field: hit.field, matched: manifestCredit ? hit.matched : hit.matched.slice(0, 120), rule: hit.rule, finders_version: x.findersVersion }
    : null;

  const sourceUrl = (sid: string) => sources.find((s) => s.id === sid)?.url ?? null;
  const patched = item.flaw_evidence.filter((f) => f.cve_id.toUpperCase() === id && f.kind === "patched" && sourceUrl(f.source_id) !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const exploited = item.flaw_evidence.filter((f) => f.cve_id.toUpperCase() === id && f.kind === "exploited" && sourceUrl(f.source_id) !== null);
  const kevBlock: CveBlock["kev"] = kev
    ? { date_added: mf?.kev_date_added[0]?.value ?? kev.dateAdded, due_date: kev.dueDate, ransomware: kev.ransomware, catalog_version: kev.catalogVersion }
    : null;
  const evidence: CveBlock["exploitation_evidence"] = [
    ...(kevBlock ? [{ date: kevBlock.date_added, basis: "kev_listed" as const, source_url: kevEntryUrl(id) }] : []),
    ...exploited.map((f) => ({ date: f.date, basis: f.basis as CveBlock["exploitation_evidence"][number]["basis"], source_url: sourceUrl(f.source_id)! })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const first = patched[0];
  // §4.6's fallbacks: a reviewed GHSA's published date, and a patch when one lists a fixed version.
  const advisories = (x.facts.ghsaAdvisories?.(id) ?? []).filter((a) => ID_PATTERNS.ghsa.test(a.id));
  const fixedGhsa = advisories.find((a) => a.fixed) ?? null;
  const patch: CveBlock["patch"] = first && first.basis === "vendor_advisory"
    ? { date: first.date, basis: "vendor_advisory", source_url: sourceUrl(first.source_id)! }
    : fixedGhsa ? { date: fixedGhsa.published, basis: "ghsa_fixed_version", source_url: ghsaRecordUrl(fixedGhsa.id) } : null;
  const epss = x.facts.epss(id);
  const cvss = rec?.cvss && rec.cvss.vector !== "" ? { score: rec.cvss.score, version: rec.cvss.version, vector: rec.cvss.vector, scorer: rec.cvss.scorer } : null;

  return {
    cve_id: id,
    date_published: datePublished,
    date_updated: updated ?? datePublished,
    assigner,
    vendor: vendorRefOf(vendor, vendorProject),
    product,
    title: cleanText(kev?.vulnerabilityName ?? rec?.title ?? rec?.description ?? info?.title, 200, `${vendorProject} ${product} vulnerability`),
    cvss,
    epss: epss ? { score: epss.score, percentile: epss.percentile, date: epss.date } : null,
    ssvc: ssvcOf(rec, raw, x.capturedAt),
    kev: kevBlock,
    credits,
    ai_credit: aiCredit,
    discovery_credit: aiCredit ? (aiCredit.kind === "ai_system" ? "ai_autonomous" : "ai_assisted") : credits.length ? "human" : "unknown",
    advisory_date: first?.date ?? advisories[0]?.published ?? null,
    patch,
    exploitation_evidence: evidence,
    exploit_reference: rec?.exploit_reference ?? info?.exploit_reference ?? false,
    ghsa_ids: [...x.facts.ghsaIds(id)].slice(0, 5),
    captured_at: x.capturedAt,
  };
}

/** vendor_confirmed and vendor_confirmed_by (§4.6): the vendor's CNA or domain, else a reviewed GHSA advisory. */
export function confirmBlock(b: BareCveBlock, item: Pick<Item, "flaw_evidence" | "source_ids">, sources: readonly Source[], config: LoadedConfig): CveBlock {
  const by = vendorConfirmedByOf({ sources: [...sources] }, item, b, config) ?? (b.ghsa_ids.length > 0 ? "ghsa_reviewed" : null);
  return { ...b, vendor_confirmed: by !== null, vendor_confirmed_by: by };
}

// ── Release blocks (§4.6, §5.12; plan A6) ────────────────────────────────────────────────────────

/**
 * A patch batch's ReleaseBlock (plan A6, spec gap G24): source_url and title from the item's first cited
 * source whose publisher is the release's vendor (tier 1); date that source's published_at as a UTC date,
 * else the newest UTC publication date of the bundle's records; with no such source, title
 * "<vendor name> security updates, YYYY-MM" and source_url the first bundled record's record_url. The
 * counts come from the candidate's release (total, critical, exploited). Null when the item has no release.
 * `records` (optional, added by L3) gives the bundle's publication dates; applyDraft passes the CVE List.
 * The bundle is the release's exploited CVEs, else the item's. Throws ComposeError when no date or page can be found.
 */
export function releaseBlockOf(
  item: DraftItem, release: Candidate["release"], sources: readonly Source[], config: LoadedConfig, records: CveLookup | null = null,
): ReleaseBlock | null {
  if (!item.release_id || !release || release.release_id !== item.release_id) return null;
  const v = matchVendor(config, { kevVendorProject: release.vendor });
  const vendor = vendorRefOf(v, release.vendor);
  const publisher = v ? `vendor:${v.id}` : null;
  const src = publisher
    ? item.source_ids.map((sid) => sources.find((s) => s.id === sid)).find((s) => s !== undefined && s.publisher === publisher && s.tier === 1) ?? null
    : null;
  const bundle = release.exploited_cve_ids.length > 0 ? release.exploited_cve_ids : item.cve_ids;
  const newestRecord = bundle.map((cve) => records?.get(cve)?.date_published ?? null).filter(nonNull).sort().at(-1) ?? null;
  const date = src?.published_at ? utcDateOf(src.published_at) : newestRecord;
  if (!date) throw new ComposeError(`No release date for ${release.release_id}: no vendor source with a date and no bundled record`);
  if (!src && bundle.length === 0) throw new ComposeError(`No release page for ${release.release_id}: no vendor source and no bundled record`);
  return {
    release_id: release.release_id,
    vendor,
    date,
    title: src ? cleanText(src.title_en ?? src.title, 200, `${vendor.name} security updates, ${date.slice(0, 7)}`) : `${vendor.name} security updates, ${date.slice(0, 7)}`.slice(0, 200),
    fixes_n: release.total,
    critical_n: release.critical,
    exploited_n: release.exploited,
    exploited_cve_ids: [...release.exploited_cve_ids],
    counted_from: "cve_list",
    source_url: src ? src.url : cveRecordPage(bundle[0]!),
  };
}

// ── Items ────────────────────────────────────────────────────────────────────────────────────────

/** Item id → the earliest date of an earlier brief holding it (history in any order). */
export function firstSeenOf(history: readonly Pick<Brief, "date" | "items">[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of history) {
    for (const it of b.items) {
      const seen = out.get(it.id);
      if (seen === undefined || b.date < seen) out.set(it.id, b.date);
    }
  }
  return out;
}

export interface FreezeInputs {
  config: LoadedConfig;
  date: string;
  /** Earlier briefs (first_seen when `firstSeen` is absent). */
  history: readonly Pick<Brief, "date" | "items">[];
  /** ComposeCommon.firstSeen: item id → its earliest earlier brief over every stored brief. */
  firstSeen?: ReadonlyMap<string, string>;
  blocks: (it: DraftItem) => BareCveBlock[];
  release: (it: DraftItem) => ReleaseBlock | null;
}

/** Frozen items (§4.6): the draft item plus every S field. */
export function freezeItems(draftItems: readonly DraftItem[], sources: readonly Source[], x: FreezeInputs): Item[] {
  const firstSeen = x.firstSeen ?? firstSeenOf(x.history.filter((b) => b.date < x.date));
  const bySource = new Map(sources.map((s) => [s.id, { publisher: s.publisher }]));
  return draftItems.map((it) => {
    const cves = x.blocks(it).map((b) => confirmBlock(b, it, sources, x.config));
    const release = x.release(it);
    const frozen: Item = {
      ...it,
      actor_nexus: actorNexusOf(it.attribution),
      first_seen: firstSeen.get(it.id) ?? x.date,
      vendor: cves[0]?.vendor ?? release?.vendor ?? null,
      cves,
      release,
      public_exploit: publicExploitOf({ ...it, cves }),
      anthropic_disclosure: false,
      withheld: null,
    };
    frozen.anthropic_disclosure = mentionsAnthropic(frozen, bySource);
    return frozen;
  });
}

/** One chip per actor named in the items (§4.5 ActorSeen), first-named order. */
export function actorsSeenOf(items: readonly Pick<Item, "id" | "attribution" | "actor_nexus">[], config: LoadedConfig): ActorSeen[] {
  const out: ActorSeen[] = [];
  for (const it of items) {
    for (const a of it.attribution) {
      if (!a.actor_name_as_used) continue;
      const key = a.actor_name_as_used.toLowerCase();
      const actor = config.actors.actors.find((x) => x.name.toLowerCase() === key || x.aliases.some((al) => al.name.toLowerCase() === key)) ?? null;
      const name = actor?.name ?? a.actor_name_as_used;
      let seen = out.find((x) => x.name === name);
      if (!seen) {
        const url = actor?.related_tracker ? config.run.siblings[actor.related_tracker] : null;
        seen = {
          name, actor_id: actor?.id ?? null, nexus: it.actor_nexus ?? "unknown", item_ids: [],
          cross_link: actor?.related_tracker && url ? { tracker: actor.related_tracker, url } : null,
        };
        out.push(seen);
      }
      if (!seen.item_ids.includes(it.id)) seen.item_ids.push(it.id);
      if (seen.nexus !== (it.actor_nexus ?? "unknown")) seen.nexus = "unknown";
    }
  }
  return out;
}

const claimTextOf = (config: LoadedConfig, id: string | null): string | null => (id ? config.claims.claims.find((c) => c.id === id)?.text ?? null : null);

// ── Gap, Lens and computed ───────────────────────────────────────────────────────────────────────

/** The Gap reference (§4.5 GapRef) for the same-date metrics file. */
export function gapOf(m: Metrics, metricsSha256: string): GapRef {
  return {
    headline: m.headline.text, second_line: m.headline.second_line, status: "ok", metrics_file: `metrics/${m.date}.json`,
    metrics_sha256: metricsSha256, as_of: m.data_cutoff_utc,
  };
}

/** The Taiwan Lens script fields (§4.5): the KEV lines, KEV_ABSENCE_NOTE and the watch windows active on `date`. */
export function lensScriptOf(m: Metrics, date: string, config: LoadedConfig): Pick<TaiwanLens, "kev_lines" | "kev_note" | "watch_windows"> {
  const lines = kevLines(m);
  const pick = (k: "tw" | "jp") => ({ d30_n: lines[k].d30_n, d90_n: lines[k].d90_n, text: lines[k].text });
  return {
    kev_lines: { tw: pick("tw"), jp: pick("jp") },
    kev_note: KEV_ABSENCE_NOTE,
    watch_windows: config.watchWindows.windows.filter((w) => w.start <= date && date <= w.end).map((w) => ({ id: w.id, title: w.title, start: w.start, end: w.end })),
  };
}

export const emptyComputed = (): Brief["computed"] => ({
  word_count: 0, reading_minutes: 0, item_count: 0, ai_linked: { linked: 0, total: 0 }, source_count: 0, publisher_count: 0,
});

/** computed (§4.5): pageWords() against the metrics the Gap shows, and the counts. */
export function computedOf(b: Brief, m: Metrics | null): Brief["computed"] {
  const words = pageWords(b, m);
  return {
    word_count: words, reading_minutes: Math.ceil(words / READING_WORDS_PER_MINUTE), item_count: b.items.length,
    ai_linked: aiLinkedOf(b.items), source_count: b.sources.length, publisher_count: new Set(b.sources.map((s) => s.publisher)).size,
  };
}

// ── Scoreboard (§4.9) ────────────────────────────────────────────────────────────────────────────

/** The 80% interval beside a claim metric that has one (CI80_METRIC_PATHS, §4.2). */
const CI80_OF: Partial<Record<ClaimMetricPath, string>> = {
  "window.w26.at_disclosure_share": "window.w26.at_disclosure_ci80",
  "window.w26.after_disclosure_median_days": "window.w26.after_disclosure_median_ci80",
  "base_rate.ratio": "base_rate.ratio_ci80",
};

/** Each claim metric in words, for metric entry summaries. */
export const CLAIM_METRIC_LABELS: Readonly<Record<ClaimMetricPath, string>> = {
  "window.w26.at_disclosure_share": "the 26-week share of listed flaws exploited at disclosure",
  "window.w26.after_disclosure_median_days": "the 26-week median days from disclosure to CISA's listing",
  "window.w26.cohort_n": "the 26-week count of recently disclosed flaws on CISA's list",
  "window.volume_ratio": "the pace of CISA listings of recent flaws against 2023 to 2024",
  "window.kev_pace_ratio": "the pace of all CISA listings against 2023 to 2024",
  "flood.vs_reference_pct": "the 13-week count of new CVE records against 2023 to 2024",
  "flood.yoy_pct": "the 13-week count of new CVE records against a year earlier",
  "flood.yoy_ex_kernel_pct": "the 13-week count of new CVE records outside the Linux kernel against a year earlier",
  "ai_credited.w13.total": "the 13-week count of AI-credited flaws",
  "ai_credited.w13.ex_anthropic": "the 13-week count of AI-credited flaws excluding Anthropic",
  "ai_credited.in_kev.n": "the count of AI-credited flaws on CISA's list",
  "base_rate.ratio": "the base-rate ratio",
  "fix_side.ghsa_unfixed.share": "the share of reviewed GitHub advisories with no fixed version",
};

const signed = (x: number, text: string) => `${x > 0 ? "+" : ""}${text}`;

/** One value of a claim metric as the Scoreboard shows it. */
function fmtClaimValue(path: ClaimMetricPath, v: number): string {
  if (path.endsWith("_share") || path.endsWith(".share")) return fmtPct(v);
  if (path.endsWith("_days")) return fmtDays(v);
  if (path.endsWith("_pct")) return signed(v, `${fmtDays(v)}%`);
  if (path === "base_rate.ratio") return fmt2(v);
  if (path.endsWith("_ratio")) return `${fmt1(v)} times`;
  return Number.isInteger(v) ? fmtInt(v) : fmt1(v);
}

function pathValue(root: unknown, path: string): unknown {
  let v: unknown = root;
  for (const key of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface ClaimReading {
  value: number | null;
  lo: number | null;
  hi: number | null;
  /** ≤ 80 characters, e.g. "37% (80% range 32% to 42%)"; null without a value. */
  text: string | null;
}

/** A claim metric's reading in a metrics file: the value at its path and, where one exists, its 80% interval. */
export function claimReading(m: Metrics | null, path: ClaimMetricPath): ClaimReading {
  const value = m ? finite(pathValue(m, path)) : null;
  const ciPath = CI80_OF[path];
  const ci = m && ciPath ? pathValue(m, ciPath) : null;
  const lo = Array.isArray(ci) ? finite(ci[0]) : null;
  const hi = Array.isArray(ci) ? finite(ci[1]) : null;
  if (value === null) return { value: null, lo: null, hi: null, text: null };
  const range = lo !== null && hi !== null ? ` (80% range ${fmtClaimValue(path, lo)} to ${fmtClaimValue(path, hi)})` : "";
  return { value, lo, hi, text: `${fmtClaimValue(path, value)}${range}`.slice(0, 80) };
}

/** Whether a value threshold holds for a reading (§4.9 Zones); event thresholds never hold here. */
function holds(th: Claim["support"], r: ClaimReading): boolean {
  if (th.kind !== "value") return false;
  const x = th.bound === "value" ? r.value : th.bound === "ci80_lo" ? r.lo : r.hi;
  if (x === null) return false;
  switch (th.op) {
    case ">=": return x >= th.value;
    case "<=": return x <= th.value;
    case ">": return x > th.value;
    case "<": return x < th.value;
  }
}

/** §4.9 Zones: support, challenge, between, or no_reading when the reading is null (report claims too). */
export function claimZone(claim: Pick<Claim, "support" | "challenge">, r: ClaimReading): ClaimState["zone"] {
  if (r.value === null) return "no_reading";
  if (holds(claim.support, r)) return "support";
  if (holds(claim.challenge, r)) return "challenge";
  return "between";
}

/** §4.9 Status: a resolution, else open until the deadline, then hit or miss. */
export function claimStatus(claim: Claim, zone: ClaimState["zone"], entries: readonly ScoreboardEntry[], date: string): ClaimState["status"] {
  if (claim.resolution) return claim.resolution.status;
  if (date <= claim.deadline) return "open";
  if (claim.judged_by === "script") return zone === "support" ? "hit" : "miss";
  return entries.some((e) => e.claim_id === claim.id && e.direction === "support" && e.date <= claim.deadline) ? "hit" : "miss";
}

const ZONE_WORDS: Readonly<Record<ClaimState["zone"], string>> = {
  support: "the support zone", challenge: "the challenge zone", between: "between the thresholds", no_reading: "no reading",
};

/** The metric entry template (§4.9): the first reading, or a zone change. */
export function metricEntrySummary(path: ClaimMetricPath, r: ClaimReading, prev: ClaimState["zone"] | null, zone: ClaimState["zone"]): string {
  const label = CLAIM_METRIC_LABELS[path];
  if (prev === null) return r.text === null ? `First reading: ${label} has no value yet.` : `First reading: ${label} is ${r.text}.`;
  const now = r.text === null ? "it has no value" : `it is ${r.text}`;
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} moved from ${ZONE_WORDS[prev]} to ${ZONE_WORDS[zone]}: ${now}.`;
}

const entryNumber = (id: string) => Number(/^SE-(\d+)$/.exec(id)?.[1] ?? 0);
const seId = (n: number) => `SE-${String(n).padStart(4, "0")}`;

export interface ScoreboardUpdate {
  file: ScoreboardFile;
  brief: Brief["scoreboard"];
}

/**
 * Each publish's Scoreboard step (§4.9): the zones read from today's metrics; a metric entry on a claim's
 * first reading and on each zone change against the stored state; a report entry per draft entry (a
 * rerun of the same date replaces that date's report entries); the claim states in claim id order; as_of
 * the edition date. The brief lists the entries dated D and the newest entry dated before D.
 */
export function updateScoreboard(o: {
  date: string; config: LoadedConfig; metrics: Metrics | null; scoreboard: ScoreboardFile | null;
  reports: readonly DraftBrief["scoreboard_entries"][number][]; sources: readonly Pick<Source, "id" | "url">[];
}): ScoreboardUpdate {
  const prev = o.scoreboard;
  const kept = (prev?.entries ?? []).filter((e) => !(e.date === o.date && e.origin === "report"));
  const prevState = new Map((prev?.claims ?? []).map((s) => [s.id, s]));
  let next = kept.reduce((n, e) => Math.max(n, entryNumber(e.id)), 0) + 1;
  const claims = [...o.config.claims.claims].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const readings = new Map<string, { reading: ClaimReading; zone: ClaimState["zone"] }>();
  const created: ScoreboardEntry[] = [];
  for (const claim of claims) {
    if (claim.judged_by !== "script" || !claim.metric_path) {
      readings.set(claim.id, { reading: { value: null, lo: null, hi: null, text: null }, zone: "no_reading" });
      continue;
    }
    const reading = claimReading(o.metrics, claim.metric_path);
    const zone = claimZone(claim, reading);
    readings.set(claim.id, { reading, zone });
    const first = !kept.some((e) => e.claim_id === claim.id);
    const before = prevState.get(claim.id)?.zone ?? null;
    if (!first && (before === null || before === zone)) continue;
    created.push({
      id: seId(next++), date: o.date, claim_id: claim.id, origin: "metric",
      direction: zone === "support" || zone === "challenge" ? zone : "neutral",
      summary: metricEntrySummary(claim.metric_path, reading, first ? null : before, zone),
      value: reading.value, reported_value: null, quote: null, claim_type: null, source_url: null,
      metrics_ref: { file: `metrics/${o.metrics?.date ?? o.date}.json`, path: claim.metric_path },
    });
  }
  for (const e of o.reports) {
    created.push({
      id: seId(next++), date: o.date, claim_id: e.claim_id, origin: "report",
      direction: e.claim_type === "self_reported" || e.meets === null ? "neutral" : e.meets,
      summary: e.summary, value: null, reported_value: e.reported_value, quote: e.quote, claim_type: e.claim_type,
      source_url: o.sources.find((s) => s.id === e.quote_source_id)?.url ?? null, metrics_ref: null,
    });
  }
  const entries = [...kept, ...created];
  const states: ClaimState[] = claims.map((claim) => {
    const { reading, zone } = readings.get(claim.id)!;
    return {
      id: claim.id, text: claim.text, status: claimStatus(claim, zone, entries, o.date), zone,
      reading: reading.value, reading_text: reading.text, reading_as_of: reading.value === null ? null : o.metrics?.data_cutoff_utc ?? null,
      last_entry_id: [...entries].reverse().find((e) => e.claim_id === claim.id)?.id ?? null,
    };
  });
  const last = [...entries].reverse().find((e) => e.date < o.date) ?? null;
  const lastText = last ? claimTextOf(o.config, last.claim_id) ?? prevState.get(last.claim_id)?.text ?? last.claim_id : null;
  return {
    file: { schema_version: 1, as_of: o.date, claims_version: o.config.claims.version, claims: states, entries },
    brief: {
      entries: entries.filter((e) => e.date === o.date),
      last: last ? { entry_id: last.id, date: last.date, claim_id: last.claim_id, claim_text: lastText! } : null,
    },
  };
}

/** The Week in review table (§4.5): one row per claim state. */
export function weekTable(claims: readonly ClaimState[]): NonNullable<Brief["week_in_review"]>["table"] {
  return claims.map((c) => ({ claim_id: c.id, text: c.text, status: c.status, zone: c.zone, reading_text: c.reading_text, reading_as_of: c.reading_as_of }));
}

// ── Corrections (§4.10, §8.9) ────────────────────────────────────────────────────────────────────

const correctionNumber = (id: string) => Number(/^C-(\d+)$/.exec(id)?.[1] ?? 0);
export const correctionId = (n: number): string => `C-${String(n).padStart(4, "0")}`;
/** The next free C-NNNN number after `corrections`. */
export const nextCorrectionNumber = (corrections: readonly Pick<Correction, "id">[]): number =>
  corrections.reduce((n, c) => Math.max(n, correctionNumber(c.id)), 0) + 1;

/** Corrections by date, then id (§4.10; XREF_CORRECTION's order). */
export function sortCorrections(cs: readonly Correction[]): Correction[] {
  return [...cs].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : correctionNumber(a.id) - correctionNumber(b.id)));
}

export function sortDisputes(ds: readonly Dispute[]): Dispute[] {
  return [...ds].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Copies of the disputes, each with no correction_id given the first stored correction that names it
 * (dispute_id). Intake's list is read before the run's withhold commit, so a dispute withheld this morning
 * still has correction_id null there; without this a draft correction on the item would answer the
 * withhold's dispute, and the edition would write the dispute back unlinked.
 */
export function linkDisputes(disputes: readonly Dispute[], corrections: readonly Pick<Correction, "id" | "dispute_id">[]): Dispute[] {
  return disputes.map((d) => {
    const c = d.correction_id === null ? corrections.find((x) => x.dispute_id === d.id) : undefined;
    return c ? { ...structuredClone(d), correction_id: c.id } : structuredClone(d);
  });
}

/** The archived value at a correction's dotted `field` (e.g. "cves.0.kev"), as text, cut to 300 characters. */
export function beforeText(value: unknown): string {
  const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  return text.slice(0, 300);
}

interface CorrectionsResult {
  /** Brief.corrections: every correction dated D, id order. */
  listed: Correction[];
  /** corrections.json after the draft's corrections; null when none was added. */
  file: CorrectionsFile | null;
  /** Every correction after this publish (archive-index `corrected`). */
  all: Correction[];
  flags: ContentChanges["flagCorrections"];
}

/**
 * The draft's corrections as records (§4.10): ids C-NNNN after the highest, `date` D, `before` copied
 * from the archived item in the history (else the context's flagged `before`), `source_url` from the
 * cited source. A correction on an item with an open dispute not yet answered (no correction_id, and no
 * stored correction naming it: linkDisputes()) gets its `dispute_id` and trigger reader_report, and the
 * dispute becomes upheld (§8.9 step 5); else the trigger is recheck. A draft correction already stored for
 * D (a rerun) is not added twice.
 */
function composeCorrections(i: ApplyInput, drafted: readonly DraftCorrection[], draftSources: readonly Pick<Source, "id" | "url">[]): CorrectionsResult {
  const existing = i.corrections?.corrections ?? [];
  const disputes = linkDisputes(i.disputes ?? i.corrections?.disputes ?? [], existing);
  let next = nextCorrectionNumber(existing);
  const created: Correction[] = [];
  const answered: Correction[] = [];
  for (const dc of drafted) {
    const same = (c: Correction) => c.date === i.date && c.item_id === dc.item_id && c.edition_date === dc.edition_date && c.type === dc.type && c.field === dc.field && c.after === dc.after;
    const stored = existing.find(same) ?? created.find(same);
    if (stored) {
      answered.push(stored);
      continue;
    }
    const archived = i.history.find((b) => b.date === dc.edition_date)?.items.find((it) => it.id === dc.item_id);
    let value: unknown = archived ? pathValue(archived, dc.field) : undefined;
    if (value === undefined) value = i.context.corrections.flagged.find((f) => f.item_id === dc.item_id && f.date === dc.edition_date)?.before;
    const id = correctionId(next++);
    const dispute = disputes.find((x) => x.status === "open" && x.correction_id === null && x.item_id === dc.item_id && (x.edition_date === null || x.edition_date === dc.edition_date));
    if (dispute) {
      dispute.status = "upheld";
      dispute.resolved_on = i.date;
      dispute.correction_id = id;
    }
    const c: Correction = {
      id, date: i.date, item_id: dc.item_id, edition_date: dc.edition_date, type: dc.type, field: dc.field,
      before: beforeText(value), after: dc.after, reason: dc.reason,
      source_url: dc.source_id ? draftSources.find((s) => s.id === dc.source_id)?.url ?? null : null,
      trigger: dispute ? "reader_report" : "recheck", dispute_id: dispute?.id ?? null,
    };
    created.push(c);
    answered.push(c);
  }
  const all = sortCorrections([...existing, ...created]);
  const flags: ContentChanges["flagCorrections"] = [];
  for (const f of i.recheck?.flagged ?? []) {
    if (f.correction_id !== null) continue;
    const c = answered.find((x) => x.item_id === f.item_id && x.edition_date === f.edition_date);
    if (c) flags.push({ item_id: f.item_id, edition_date: f.edition_date, flag: f.flag, correction_id: c.id });
  }
  return {
    listed: all.filter((c) => c.date === i.date).sort((a, b) => correctionNumber(a.id) - correctionNumber(b.id)),
    file: created.length > 0 ? { schema_version: 1, corrections: all, disputes: sortDisputes(disputes) } : null,
    all,
    flags,
  };
}

// ── Archive index (§4.10) ────────────────────────────────────────────────────────────────────────

/** The newest item references a URL entry keeps (§4.10). */
export const ARCHIVE_ITEM_IDS_MAX = 20;

/** An edition's row: newest first; `corrected` when any correction names it. */
export function withEdition(editions: readonly ArchiveIndex["editions"][number][], b: Pick<Brief, "date" | "edition" | "published_at" | "items">): ArchiveIndex["editions"] {
  return [...editions.filter((e) => e.date !== b.date), { date: b.date, edition: b.edition, published_at: b.published_at, item_count: b.items.length, corrected: false }]
    .sort((a, b2) => (a.date < b2.date ? 1 : a.date > b2.date ? -1 : 0));
}

/** Sets every edition's `corrected` from the corrections (§4.10). */
export function markCorrected(editions: readonly ArchiveIndex["editions"][number][], corrections: readonly Pick<Correction, "edition_date">[]): ArchiveIndex["editions"] {
  const dates = new Set(corrections.map((c) => c.edition_date));
  return editions.map((e) => ({ ...e, corrected: dates.has(e.date) }));
}

/**
 * archive-index.json after D's brief (§4.10): D's earlier item references dropped (a rerun or the full
 * edition replacing the data-only one) and URLs first cited on D that the brief no longer cites removed;
 * each cited URL then lists `D/<item id>` for every item citing it (newest last, at most 20), a new URL
 * with first_cited D and its snapshot's sha256 and fetch time (null without a snapshot); D's edition row
 * replaced; `corrected` recomputed for every edition.
 */
export function updateArchiveIndex(prev: ArchiveIndex | null, brief: Brief, snapshots: SnapshotHashes, corrections: readonly Pick<Correction, "edition_date">[]): ArchiveIndex {
  const date = brief.date;
  const prefix = `${date}/`;
  const cited = new Set(brief.sources.map((s) => normalizeUrl(s.url)));
  const urls: Record<string, ArchiveUrl> = {};
  for (const [u, e] of Object.entries(prev?.urls ?? {})) {
    if (e.first_cited === date && !cited.has(u)) continue;
    urls[u] = { ...structuredClone(e), item_ids: e.item_ids.filter((x) => !x.startsWith(prefix)) };
  }
  for (const s of brief.sources) {
    const u = normalizeUrl(s.url);
    const snap = snapshots[u] ?? null;
    const entry = urls[u] ??= { first_cited: date, item_ids: [], sha256: snap?.sha256 ?? null, hashed_at: snap?.fetched_at ?? null, last_check: null };
    if (entry.first_cited === date && snap) {
      entry.sha256 = snap.sha256;
      entry.hashed_at = snap.fetched_at;
    }
    for (const it of brief.items) {
      const ref = `${date}/${it.id}`;
      if (it.source_ids.includes(s.id) && !entry.item_ids.includes(ref)) entry.item_ids.push(ref);
    }
    entry.item_ids = entry.item_ids.slice(-ARCHIVE_ITEM_IDS_MAX);
  }
  return { schema_version: 1, editions: markCorrected(withEdition(prev?.editions ?? [], brief), corrections), urls };
}
