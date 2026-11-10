// Draft to Brief (SPEC §4.5, §4.12). P1 holds only the soft pass's dropUnverified(); P3 adds applyDraft(),
// which adds every S and C field. Pure: the input draft is never changed. Step S0 wrote applyDraft()'s
// types and a stub (plan §2.4, amendments A5 and A6); lane L3 replaces the stub bodies.

import type { LoadedConfig } from "./config";
import type { CveLookup, RegionsBase } from "./rules/types";
import type { Brief, FeedStale } from "./schema/brief";
import type { Ransomware, Source } from "./schema/common";
import type { AgentContext, Candidate } from "./schema/context";
import type { DraftAngle, DraftBrief } from "./schema/draft-brief";
import type { DraftItem, ReleaseBlock } from "./schema/item";
import type { InputsManifest, KevIndexFile, Metrics } from "./schema/metrics";
import type { ArchiveIndex, CorrectionsFile, Dispute, Evidence } from "./schema/misc";
import type { ScoreboardFile } from "./schema/scoreboard";
import type { Recheck } from "./schema/status";
import type { RecheckFlag } from "./vocab";

/** The issue fields dropUnverified() reads; lib/rules/types.ts's ValidationIssue fits. */
export interface SoftIssue {
  code: string;
  path: string;
}

/** A draft after the soft pass: the Angle may have been dropped (§4.5 stores it as null). */
export type GatedDraft = Omit<DraftBrief, "angle"> & { angle: DraftAngle | null };

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
  kev(cveId: string): { dateAdded: string; dueDate: string; ransomware: Ransomware; catalogVersion: string } | null;
  epss(cveId: string): { score: number; percentile: number; date: string } | null;
  /** Reviewed advisories naming the CVE, at most 5. */
  ghsaIds(cveId: string): string[];
}

/** What every composer reads (applyDraft, composeDataOnly). */
export interface ComposeCommon {
  date: string;
  config: LoadedConfig;
  /** metrics/D.json (committed or staged). */
  metrics: Metrics;
  /** kevIndexFor(). */
  kevIndex: KevIndexFile;
  /** readHistory(content, D, 30), newest first (first_seen, regions). */
  history: readonly Brief[];
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

/** The brief for D with every S and C field; brief.late = lateOf(); Brief.parse()d. */
export function applyDraft(i: ApplyInput): ContentChanges {
  throw new Error("P3 stub: applyDraft (lane L3)");
}

/**
 * A patch batch's ReleaseBlock (plan A6, spec gap G24): source_url and title from the item's first cited
 * source whose publisher is the release's vendor (tier 1); date that source's published_at as a UTC date,
 * else the newest UTC publication date of the bundle's records; with no such source, title
 * "<vendor name> security updates, YYYY-MM" and source_url the first bundled record's record_url. The
 * counts come from the candidate's release (total, critical, exploited). Null when the item has no release.
 */
export function releaseBlockOf(item: DraftItem, release: Candidate["release"], sources: readonly Source[], config: LoadedConfig): ReleaseBlock | null {
  throw new Error("P3 stub: releaseBlockOf (lane L3)");
}
