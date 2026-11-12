// The archive's lines (SPEC §6 Route details, `/archive`). Owner: pages lane.
import type { Content } from "@/lib/content";
import { fmtInt } from "@/lib/metrics/stats";
import type { Brief } from "@/lib/schema/brief";
import { correctionsFor } from "@/lib/site-data";

/** "10 editions, newest first." ("1 edition, newest first."). */
export function editionsLine(n: number): string {
  return `${fmtInt(n)} ${n === 1 ? "edition" : "editions"}, newest first.`;
}

/** True when correctionsFor() finds a correction to any item of the edition. */
export function editionCorrected(content: Pick<Content, "briefs" | "corrections">, brief: Pick<Brief, "date" | "items">): boolean {
  return brief.items.some((it) => correctionsFor(content, it.id, brief.date).length > 0);
}

/**
 * The edition's kicker: DATA-ONLY or PARTIAL when not full, "N ITEMS", "AI-LINKED X OF Y" except in a
 * data-only edition, CORRECTED when any item has a correction; joined with " · ".
 */
export function archiveKicker(content: Pick<Content, "briefs" | "corrections">, brief: Brief): string {
  const parts: string[] = [];
  if (brief.edition === "data_only") parts.push("DATA-ONLY");
  else if (brief.edition === "partial") parts.push("PARTIAL");
  const n = brief.computed.item_count;
  parts.push(`${fmtInt(n)} ${n === 1 ? "ITEM" : "ITEMS"}`);
  if (brief.edition !== "data_only") parts.push(`AI-LINKED ${fmtInt(brief.computed.ai_linked.linked)} OF ${fmtInt(brief.computed.ai_linked.total)}`);
  if (editionCorrected(content, brief)) parts.push("CORRECTED");
  return parts.join(" · ");
}

/** The line in place of a top story for an edition with no items. */
export function topStoryFallback(brief: Pick<Brief, "edition">): string {
  return brief.edition === "data_only" ? "Data-only edition" : "No item cleared the bar.";
}
