// Withholding an item on a reader dispute (SPEC §4.10): one name_removed correction per request (trigger
// reader_report, the dispute id), the brief rewritten, "[withheld]" marks in later stored briefs. Victim
// and attribution disputes withhold at once. Pure: every input is passed in. Ported from fixtures/src/
// site.ts's withhold() and extended to attribution disputes (plan §1 L3). Owner: lane L3.

import {
  computedOf, correctionId, markCorrected, nextCorrectionNumber, sortCorrections, sortDisputes, type ContentChanges,
} from "./apply";
import type { LoadedConfig } from "./config";
import { longDate } from "./format";
import { Brief, type ActorSeen } from "./schema/brief";
import type { Item } from "./schema/item";
import type { Metrics } from "./schema/metrics";
import type { ArchiveIndex, Correction, CorrectionsFile, Dispute } from "./schema/misc";
import { WITHHELD_HEADLINE, WITHHELD_MARK, WITHHELD_TEXT } from "./vocab";

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

/**
 * The item's own rewrite (§4.10): headline WITHHELD_HEADLINE, summary WITHHELD_TEXT, why_it_matters null,
 * and incident.victim null (victim) or attribution [] and actor_nexus null (attribution); `withheld` set
 * unless an earlier withhold set it. Then every Lead sentence and Taiwan Lens text that lists the item
 * becomes WITHHELD_MARK, and so does the title of each source only this item cites.
 */
function rewriteItem(b: Brief, it: Item, r: WithholdRequest, correction: string): void {
  it.headline = WITHHELD_HEADLINE;
  it.summary = WITHHELD_TEXT.replace("{date}", longDate(r.since));
  it.why_it_matters = null;
  if (r.kind === "victim") {
    if (it.incident) it.incident.victim = null;
  } else {
    it.attribution = [];
    it.actor_nexus = null;
  }
  it.withheld ??= { correction_id: correction, since: r.since };

  for (const l of b.lead) if (l.item_ids.includes(it.id)) l.text = WITHHELD_MARK;
  const lens = b.taiwan_lens;
  if (lens.item_ids.includes(it.id)) lens.analysis = WITHHELD_MARK;
  for (const row of lens.rows) if (row.item_ids.includes(it.id)) row.text = WITHHELD_MARK;
  if (lens.japan.item_ids.includes(it.id)) lens.japan.text = WITHHELD_MARK;

  const others = new Set(b.items.filter((x) => x.id !== it.id).flatMap((x) => [
    ...x.source_ids, ...x.flaw_evidence.map((f) => f.source_id), ...(x.incident?.status_source_ids ?? []),
  ]));
  const elsewhere = new Set([
    ...b.elsewhere.map((e) => e.source_id), ...(b.angle?.source_id ? [b.angle.source_id] : []), ...(b.angle?.counterpoint_source_ids ?? []),
    ...(b.week_in_review?.strongest_against.source_ids ?? []), ...lens.source_ids, ...lens.rows.flatMap((row) => row.source_ids), ...lens.japan.source_ids,
  ]);
  for (const s of b.sources) {
    if (!it.source_ids.includes(s.id) || others.has(s.id) || elsewhere.has(s.id)) continue;
    s.title = WITHHELD_MARK;
    if (s.title_en !== null) s.title_en = WITHHELD_MARK;
  }
}

/** Region row and raise reasons that list the item become WITHHELD_MARK (a reason embeds its headline, §5.11). */
function markRegions(b: Brief, itemId: string): boolean {
  let changed = false;
  for (const row of b.regions.rows) {
    if (row.item_ids.includes(itemId) && row.reason !== WITHHELD_MARK) {
      row.reason = WITHHELD_MARK;
      changed = true;
    }
    if (row.raised?.item_ids.includes(itemId) && row.raised.reason !== WITHHELD_MARK) {
      row.raised.reason = WITHHELD_MARK;
      changed = true;
    }
  }
  return changed;
}

/** actors_seen after an attribution withhold: the item leaves its chips, empty chips go, nexus re-agreed. */
function dropActorItem(actors: readonly ActorSeen[], items: readonly Item[], itemId: string): ActorSeen[] {
  return actors.flatMap((a) => {
    if (!a.item_ids.includes(itemId)) return [a];
    const ids = a.item_ids.filter((x) => x !== itemId);
    if (ids.length === 0) return [];
    const nexuses = new Set(ids.map((x) => items.find((it) => it.id === x)?.actor_nexus ?? "unknown"));
    return [{ ...a, item_ids: ids, nexus: nexuses.size === 1 ? [...nexuses][0]! : "unknown" }];
  });
}

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
