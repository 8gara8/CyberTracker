// STUB (SPEC §7 "GapPanel and charts", chart A, The Flood: "NEW CVE RECORDS, 13-WEEK TOTAL"). Owner: gap lane.
// flood_n13 solid ink, flood_n13_year_ago dashed muted, flood_n13_kernel hatched from 0; niceMax of all
// three; direct labels; a <title> per week; markers; the data table. Rendered only with a non-null block.
import type { Annotation } from "@/lib/schema/config";
import type { Flood, Series } from "@/lib/schema/metrics";

export interface FloodChartProps {
  series: Series;
  flood: Flood;
  /** The annotations whose panels include "flood"; the chart drops those off its axis. */
  markers: Annotation[];
}

export function FloodChart({ series }: FloodChartProps) {
  return <figure><svg viewBox="0 0 400 108" role="img" aria-label="The Flood" /><figcaption>{series.weeks.length}</figcaption></figure>;
}
