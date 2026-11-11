// SPEC §7 "BriefView and section order": BriefViewProps and briefPropsFor(content, date), which `/` and
// `/brief/[date]` spread into <BriefView>. Owner: P4 foundation (S0); lanes read it and none edits it.
//
// gapOk: loadContent() records in `content.gapFailed` every loaded brief whose per-file validateAll() result
// has a GAP_MATCH issue (its gap block or Lens KEV lines differ from the same-date metrics, or there is no
// valid same-date metrics file); gapOk is false for those dates (§6 item 3).
import type { Content } from "@/lib/content";
import { loadMetrics } from "@/lib/content";
import { loadConfig } from "@/lib/config";
import type { Brief } from "@/lib/schema/brief";
import type { Annotation } from "@/lib/schema/config";
import type { Metrics } from "@/lib/schema/metrics";
import type { Correction } from "@/lib/schema/misc";
import { correctionsFor, heldItemIds, itemHistory, itemPageIds, neighbours } from "@/lib/site-data";
import type { EarlierItems } from "./brief-parts";

export interface BriefViewProps {
  brief: Brief;
  /** loadMetrics(content, brief.gap.metrics_file): the file the Gap shows. */
  metrics: Metrics | null;
  /** False when the brief failed GAP_MATCH: the Gap is treated as missing. */
  gapOk: boolean;
  /** config/annotations.json, every annotation (GapPanel picks each chart's by panel). */
  annotations: Annotation[];
  /** item id → correctionsFor(content, item.id, brief.date), for every item in the brief ([] when none). */
  correctionsByItem: Record<string, Correction[]>;
  /** heldItemIds(content): the items a withhold binds, whose corrections show by type word and date only. */
  heldItems: Set<string>;
  /** itemPageIds(content): the ids with an /items/<id> page. */
  itemPages: Set<string>;
  /** The dates of the loaded briefs: the corrections list links only an edition the site has. */
  editionDates: Set<string>;
  /**
   * For each item a region row's rules or raise list that this brief lacks (rules look back over several days):
   * the newest loaded brief before it holding the item, and that copy's stored headline (WITHHELD_HEADLINE for a
   * withheld item, §4.10), so the row links /brief/<date>#<id> by headline; an item no loaded brief holds is absent.
   */
  earlierItems: EarlierItems;
  /** True for the newest loaded brief: BriefView then shows StaleBanner. */
  isLatest: boolean;
  prevDate: string | null;
  nextDate: string | null;
}

function earlierItemsFor(content: Content, brief: Brief): EarlierItems {
  const own = new Set(brief.items.map((it) => it.id));
  const ids = new Set(brief.regions.rows.flatMap((r) => [...r.fired.flatMap((f) => f.item_ids), ...(r.raised?.item_ids ?? [])]));
  const out: EarlierItems = {};
  for (const id of ids) {
    if (own.has(id)) continue;
    const copy = itemHistory(content, id).filter((h) => h.date < brief.date).at(-1);
    if (copy) out[id] = { date: copy.date, headline: copy.item.headline };
  }
  return out;
}

/** Everything BriefView needs for one date, or null when no loaded brief has it. */
export function briefPropsFor(content: Content, date: string): BriefViewProps | null {
  const brief = content.briefs.find((b) => b.date === date);
  if (!brief) return null;
  const { prev, next } = neighbours(content, date);
  return {
    brief,
    metrics: loadMetrics(content, brief.gap.metrics_file),
    gapOk: !content.gapFailed.has(date),
    annotations: loadConfig().annotations.annotations,
    correctionsByItem: Object.fromEntries(brief.items.map((it) => [it.id, correctionsFor(content, it.id, brief.date)])),
    heldItems: heldItemIds(content),
    itemPages: itemPageIds(content),
    editionDates: new Set(content.briefs.map((b) => b.date)),
    earlierItems: earlierItemsFor(content, brief),
    isLatest: content.briefs.at(-1)?.date === date,
    prevDate: prev,
    nextDate: next,
  };
}
