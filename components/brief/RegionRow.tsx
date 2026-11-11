// STUB (SPEC §7 "Brief components", RegionRow). Owner: brief lane. A closed <details>, one line at 375px:
// regionSummary(row).head and reason (counted), hidden change words; open: full reason, BASELINE_TOOLTIP,
// "Yesterday: <WORD>", fired rules linking /methodology#rule-<rule_id> with item links, EDITOR_RAISED and
// "Rules alone: <WORD>". GlobalRow: "GLOBAL · <regions.global.item_count> items" linking #also-today.
import type { RegionRow as RegionRowData } from "@/lib/schema/brief";
import type { Item } from "@/lib/schema/item";

export interface RegionRowProps {
  row: RegionRowData;
  /** The brief's items by id, for the fired rules' item links. */
  itemsById: Record<string, Item>;
}

export function RegionRow({ row }: RegionRowProps) {
  return <details><summary>{row.code}</summary></details>;
}

export interface GlobalRowProps {
  /** regions.global.item_count. */
  itemCount: number;
}

export function GlobalRow({ itemCount }: GlobalRowProps) {
  return <p>GLOBAL · {itemCount} items</p>;
}
