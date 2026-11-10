// Withholding an item on a reader dispute (SPEC §4.10): one name_removed correction per request (trigger
// reader_report, the dispute id), the brief rewritten, "[withheld]" marks in later stored briefs. Victim
// and attribution disputes withhold at once. Pure: every input is passed in. Ported from fixtures/src/
// site.ts's withhold() and extended to attribution disputes (plan §1 L3); the masking itself is in
// lib/withhold-mask.ts, which also binds the editions after a withhold. Owner: lane L3.

import {
  computedOf, correctionId, markCorrected, nextCorrectionNumber, sortCorrections, sortDisputes, type ContentChanges,
} from "./apply";
import type { LoadedConfig } from "./config";
import { Brief } from "./schema/brief";
import type { Metrics } from "./schema/metrics";
import type { ArchiveIndex, Correction, CorrectionsFile, Dispute } from "./schema/misc";
import { dropActorItem, markRegions, rewriteItem } from "./withhold-mask";

/** One item to withhold: what intake (scripts/recheck.ts) and dropPendingEditions() hand to publish. */
export interface WithholdRequest {
  item_id: string;
  edition_date: string;
  kind: "victim" | "attribution";
  dispute_id: string;
  /** The run's edition date D. */
  since: string;
}

export interface WithholdInput {
  date: string;
  config: LoadedConfig;
  /** Every stored brief dated on or after the earliest request's edition_date (later briefs carry region reasons). */
  briefs: readonly Brief[];
  corrections: CorrectionsFile | null;
  /** The updated list; requests' disputes get correction_id. */
  disputes: readonly Dispute[];
  archiveIndex: ArchiveIndex | null;
  /** computed is recounted per brief. */
  metricsFor: (date: string) => Metrics | null;
  requests: readonly WithholdRequest[];
}

/** The name_removed correction's fixed texts per dispute kind (§4.10). */
export const WITHHOLD_TEXTS: Readonly<Record<WithholdRequest["kind"], { field: string; after: string; reason: string }>> = {
  victim: {
    field: "incident.victim",
    after: "withheld while a dispute about a named party is reviewed",
    reason: "A reader disputed the naming of the victim, so the item is withheld while the dispute is reviewed.",
  },
  attribution: {
    field: "attribution",
    after: "withheld while a dispute about the attribution is reviewed",
    reason: "A reader disputed the attribution to an actor or country, so the item is withheld while the dispute is reviewed.",
  },
};

/** What a name_removed correction stores as `before` (§4.10). */
export const NAME_REMOVED_BEFORE = "[name removed]";

/** The metrics date a brief's Gap names (its word count is counted against that file, §4.12). */
const gapDate = (b: Brief) => (b.gap.metrics_file ? /(\d{4}-\d{2}-\d{2})\.json$/.exec(b.gap.metrics_file)?.[1] ?? null : null);

/**
 * §4.10's rewrite: for each request in order, a name_removed correction C-NNNN (date `since`, trigger
 * reader_report, the dispute id, which the dispute gets as correction_id); every given brief holding the
 * item rewritten (rewriteItem()); region and raise reasons listing it marked in every given brief; then
 * actors_seen (attribution) and computed recounted. A request whose item no given brief holds at its
 * edition_date is skipped. Returns brief null, the rewritten briefs in date order, corrections.json and
 * the archive index with `corrected` recomputed.
 */
export function composeWithholds(i: WithholdInput): ContentChanges {
  const briefs = structuredClone([...i.briefs]).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) as Brief[];
  const disputes = structuredClone([...i.disputes]) as Dispute[];
  const corrections: Correction[] = [...(i.corrections?.corrections ?? [])];
  let next = nextCorrectionNumber(corrections);
  const touched = new Set<string>();

  for (const r of i.requests) {
    const target = briefs.find((b) => b.date === r.edition_date);
    if (!target?.items.some((it) => it.id === r.item_id)) continue;
    const text = WITHHOLD_TEXTS[r.kind];
    const id = correctionId(next++);
    corrections.push({
      id, date: r.since, item_id: r.item_id, edition_date: r.edition_date, type: "name_removed", field: text.field,
      before: NAME_REMOVED_BEFORE, after: text.after, reason: text.reason, source_url: null, trigger: "reader_report", dispute_id: r.dispute_id,
    });
    const dispute = disputes.find((d) => d.id === r.dispute_id);
    if (dispute) dispute.correction_id = id;
    for (const b of briefs) {
      const it = b.items.find((x) => x.id === r.item_id);
      if (it) {
        rewriteItem(b, it, r, id);
        if (r.kind === "attribution") b.actors_seen = dropActorItem(b.actors_seen, b.items, it.id);
        touched.add(b.date);
      }
      if (markRegions(b, r.item_id)) touched.add(b.date);
    }
  }

  const rewritten = briefs.filter((b) => touched.has(b.date)).map((b) => {
    const gd = gapDate(b);
    b.computed = computedOf(b, gd ? i.metricsFor(gd) : null);
    return Brief.parse(b);
  });
  const all = sortCorrections(corrections);
  const prev = i.archiveIndex ?? {
    schema_version: 1 as const,
    editions: [...i.briefs].sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((b) => ({ date: b.date, edition: b.edition, published_at: b.published_at, item_count: b.items.length, corrected: false })),
    urls: {},
  };
  const changed = all.length !== (i.corrections?.corrections.length ?? 0);
  return {
    brief: null,
    rewritten,
    scoreboard: null,
    corrections: changed ? { schema_version: 1, corrections: all, disputes: sortDisputes(disputes) } : null,
    archiveIndex: { ...structuredClone(prev), editions: markCorrected(prev.editions, all) },
    flagCorrections: [],
  };
}
