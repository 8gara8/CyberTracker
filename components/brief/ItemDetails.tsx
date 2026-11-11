// STUB (SPEC §7 "Brief components", ItemDetails). Owner: items lane. A <dl> of every §4.6 field the item has,
// each dated and linked: per CVE block, the release block, AI role and evidence, attributions, incident,
// exposure, topics, standing story.
import type { Source } from "@/lib/schema/common";
import type { Item } from "@/lib/schema/item";
import type { SourceIndex } from "./sources";

export interface ItemDetailsProps {
  item: Item;
  editionDate: string;
  index: SourceIndex;
  sourcesById: Record<string, Source>;
}

export function ItemDetails({ item }: ItemDetailsProps) {
  return <dl><dt>Item</dt><dd>{item.id}</dd></dl>;
}
