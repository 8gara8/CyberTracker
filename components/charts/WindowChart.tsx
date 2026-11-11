// STUB (SPEC §7 "GapPanel and charts", chart B, The Window: "ROLLING 26 WEEKS", three rows). Owner: gap lane.
// Row 1 the at-disclosure share with its 80% band and the 2023-24 reference; row 2 the median days with its
// band; row 3 the weekly KEV bars (recent cohort filled in front of all). Rendered only with a non-null block.
import type { Annotation } from "@/lib/schema/config";
import type { GapWindow, Series } from "@/lib/schema/metrics";

export interface WindowChartProps {
  series: Series;
  window: GapWindow;
  /** The annotations whose panels include "window"; the chart drops those off its axis. */
  markers: Annotation[];
}

export function WindowChart({ series }: WindowChartProps) {
  return <figure><svg viewBox="0 0 400 108" role="img" aria-label="The Window" /><figcaption>{series.weeks.length}</figcaption></figure>;
}
