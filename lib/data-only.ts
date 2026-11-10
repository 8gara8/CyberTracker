// The data-only edition (SPEC §4.5 "Data-only edition", §8.2 stage 4, §8.7 publishDataOnly): the brief the
// run publishes from the feeds alone, before the agent runs. Pure: every input is passed in. The headline
// and summary templates are fixtures/src/site.ts's text exactly (plan §1 L3), and the brief is built the
// way site.ts's dataOnly() builds the sample's data-only editions, with lib/apply.ts's helpers. Owner:
// lane L3.

import {
  actorsSeenOf, computedOf, cveBlockOf, cveRecordPage, emptyComputed, findersVersionOf, freezeItems, freezeSource, gapOf,
  lensScriptOf, updateArchiveIndex, updateScoreboard,
  type ComposeCommon, type ContentChanges, type CveBlockInputs, type CveFacts,
} from "./apply";
import { parseCveRecord } from "./feeds/cvelist";
import { shortDate } from "./format";
import { computeRegions, regionItems } from "./regions";
import { lateOf } from "./rules/computed";
import type { CveLookup } from "./rules/types";
import { Brief } from "./schema/brief";
import type { DraftSource } from "./schema/common";
import type { DraftItem } from "./schema/item";
import type { InputsManifest, KevIndexRow } from "./schema/metrics";
import { TAIWAN_LENS_ROWS } from "./vocab";

/** At most this many new KEV entries become items (§4.5). */
export const DATA_ONLY_MAX_ITEMS = 10;

/** `CISA lists ${cve} in ${vendorProject} ${product} as exploited`, cut to 90 characters. */
export function dataOnlyHeadline(cve: string, vendorProject: string, product: string): string {
  return `CISA lists ${cve} in ${vendorProject} ${product} as exploited`.slice(0, 90);
}

/** site.ts's data-only summary text exactly; `added` and `published` are dates (YYYY-MM-DD). */
export function dataOnlySummary(cve: string, vendorProject: string, product: string, added: string, published: string): string {
  return `CISA added ${cve}, a flaw in ${vendorProject} ${product}, to its list of exploited flaws on ${shortDate(added)} (US date). The CVE record was published on ${shortDate(published)}.`;
}

export interface DataOnlyInput extends ComposeCommon {
  /** datePublished from the record, else the KEV row's. */
  cveList: CveLookup | null;
  /** cvss, ssvc, KEV due date and catalog version, EPSS, GHSA ids (plan A5). */
  facts: CveFacts;
  /** metrics/inputs/D.json (plan A5). */
  inputs: InputsManifest | null;
  /** SHA-256 of metrics/D.json as committed: gap.metrics_sha256 (plan A5). */
  metricsSha256: string;
}

/**
 * The new KEV entries a data-only edition shows (§4.5): the metrics' kev.new_since_last_edition ids with
 * their KEV index rows, newest first (date added, then catalog position, later first), only those whose
 * CVE record facts are known (a publication date and an assigner from the record, the CVE List or the
 * row), at most DATA_ONLY_MAX_ITEMS.
 */
export function dataOnlyRows(i: Pick<DataOnlyInput, "metrics" | "kevIndex" | "facts" | "cveList">): KevIndexRow[] {
  const ids = new Set((i.metrics.kev?.new_since_last_edition.cve_ids ?? []).map((id) => id.toUpperCase()));
  const rows = i.kevIndex.entries.map((row, pos) => ({ row, pos })).filter(({ row }) => ids.has(row[0]));
  const known = (row: KevIndexRow) => {
    const raw = i.facts.record(row[0]);
    const rec = raw === null || raw === undefined ? null : parseCveRecord(raw);
    if (rec?.date_published && rec.assigner) return true;
    const info = i.cveList?.get(row[0]);
    if (info?.date_published && info.assigner) return true;
    return row[4] !== null && row[5] !== null;
  };
  return rows
    .sort((a, b) => (a.row[1] !== b.row[1] ? (a.row[1] < b.row[1] ? 1 : -1) : b.pos - a.pos))
    .map(({ row }) => row)
    .filter(known)
    .slice(0, DATA_ONLY_MAX_ITEMS);
}

/**
 * The data-only brief (§4.5): one exploited_flaw item per new KEV CVE, each citing its cve.org record
 * page; lead [], angle null, regions with no raises, the Gap, the Lens script lines, the Scoreboard step
 * (§4.9: every publish sets the zones, so scoreboard.json is returned), the corrections dated D listed,
 * epss_movers from the metrics. brief.edition "data_only", data_only_published_at = publishedAt.
 */
export function composeDataOnly(i: DataOnlyInput): ContentChanges {
  const c = i.config;
  const m = i.metrics;
  const cveInputs: CveBlockInputs = {
    config: c, facts: i.facts, cveList: i.cveList, kevIndex: i.kevIndex, inputs: i.inputs,
    findersVersion: findersVersionOf(m, c), capturedAt: i.publishedAt,
  };
  const rows = dataOnlyRows(i);
  const blocks = rows.map((row) => cveBlockOf(row[0], { flaw_evidence: [] }, [], cveInputs));
  const draftSources: DraftSource[] = rows.map((row, k) => ({
    id: `s${k + 1}`, title: row[0], title_en: null, language: "en", outlet: "CVE Program", url: cveRecordPage(row[0]),
    source_type: "cve_record", published_at: blocks[k]!.date_published,
  }));
  const sources = draftSources.map((s) => freezeSource(s, "pack", c));
  const draftItems: DraftItem[] = rows.map(([cve, , vendorProject, product], k) => {
    const block = blocks[k]!;
    const country = block.vendor.country;
    return {
      id: cve.toLowerCase(), kind: "exploited_flaw",
      headline: dataOnlyHeadline(cve, vendorProject, product),
      summary: dataOnlySummary(cve, vendorProject, product, block.kev?.date_added ?? rows[k]![1], block.date_published),
      why_it_matters: null, severity: null, landmark: false, ai_role: "unassessed", ai_role_secondary: null, ai_confidence: null,
      ai_claimant: null, ai_evidence: [], claim_type: "government",
      regions: country === "TW" || country === "JP" ? [country] : ["GLOBAL"],
      topics: [], attribution: [], incident: null, cve_ids: [cve], release_id: null, flaw_evidence: [],
      exploit_reported_in_sources: null, exposure: null, standing_story: null, source_ids: [`s${k + 1}`],
    };
  });
  const items = freezeItems(draftItems, sources, {
    config: c, date: i.date, history: i.history, blocks: (it) => [blocks[draftItems.indexOf(it)]!], release: () => null,
  });
  const board = updateScoreboard({ date: i.date, config: c, metrics: m, scoreboard: i.scoreboard, reports: [], sources: [] });
  const corrections = i.corrections?.corrections ?? [];

  const b: Brief = {
    schema_version: 1,
    date: i.date,
    edition: "data_only",
    generated_at: i.generatedAt,
    published_at: i.publishedAt,
    data_only_published_at: i.publishedAt,
    late: false,
    data_cutoff_utc: m.data_cutoff_utc,
    lead: [],
    angle: null,
    regions: computeRegions({ ...i.regionsBase, items: regionItems(items, sources, i.regionsBase.config), raises: [] }),
    gap: gapOf(m, i.metricsSha256),
    items,
    actors_seen: actorsSeenOf(items, c),
    taiwan_lens: {
      analysis: "", item_ids: [], source_ids: [],
      rows: TAIWAN_LENS_ROWS.map((row) => ({ row, text: null, item_ids: [], source_ids: [] })),
      japan: { text: null, item_ids: [], source_ids: [] },
      ...lensScriptOf(m, i.date, c),
    },
    scoreboard: board.brief,
    week_in_review: null,
    corrections: corrections.filter((x) => x.date === i.date),
    elsewhere: [],
    epss_movers: [...m.epss_movers],
    feeds_stale: [...i.feedsStale],
    sources,
    computed: emptyComputed(),
  };
  b.late = lateOf(b, c);
  b.computed = computedOf(b, m);
  const brief = Brief.parse(b);
  return {
    brief,
    rewritten: [],
    scoreboard: board.file,
    corrections: null,
    archiveIndex: updateArchiveIndex(i.archiveIndex, brief, {}, corrections),
    flagCorrections: [],
  };
}
