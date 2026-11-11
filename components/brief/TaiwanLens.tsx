// STUB (SPEC §7 "Brief components", TaiwanLens). Owner: brief lane. Analysis with refs and item links
// (TAIWAN_NO_NEWS verbatim on a quiet day); active watch windows; the six TAIWAN_LENS_ROWS (home_vendors adds
// lensKevLines()); "JAPAN". Data-only: the analysis reads EMPTY_LINES.not_data_only; script lines still show.
import type { Edition } from "@/lib/schema/common";
import type { TaiwanLens as TaiwanLensData } from "@/lib/schema/brief";
import type { Item } from "@/lib/schema/item";
import type { SourceIndex } from "./sources";

export interface TaiwanLensProps {
  lens: TaiwanLensData;
  edition: Edition;
  /** The brief's date: which watch windows are active. */
  editionDate: string;
  index: SourceIndex;
  itemsById: Record<string, Item>;
}

export function TaiwanLens({ lens }: TaiwanLensProps) {
  return <div>{lens.rows.length}</div>;
}
