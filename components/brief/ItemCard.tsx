// STUB (SPEC §7 "Brief components", ItemCard). Owner: items lane. <article id={item.id}>: CorrectionBanner when
// corrected; cardKicker() (pips, AIChip, regions, vendor); "Impact:" for incidents; h3 headline; summary with
// SourceRefs; "WHY IT MATTERS →"; releaseLine() or cveTimeline(); chips; ANTHROPIC_LINE; footer sources,
// "details" <details> with ItemDetails, "Timeline →" when hasPage, "Report an error" (issueFormUrl(item)).
import type { Edition, Source } from "@/lib/schema/common";
import type { Item } from "@/lib/schema/item";
import type { Correction } from "@/lib/schema/misc";
import type { SourceIndex } from "./sources";

export interface ItemCardProps {
  item: Item;
  /** The brief's date (cveTimeline() and releaseLine() print years only when they differ). */
  editionDate: string;
  edition: Edition;
  index: SourceIndex;
  /** The brief's sources by id. */
  sourcesById: Record<string, Source>;
  /** correctionsFor(content, item.id, editionDate). */
  corrections: Correction[];
  /** True when the item has an /items/<id> page. */
  hasPage: boolean;
}

export function ItemCard({ item }: ItemCardProps) {
  return <article id={item.id}><h3>{item.headline}</h3></article>;
}
