// STUB (SPEC §7 "GapPanel and charts", chart C, AI-credited: "WEEKLY RECORDS, LOWER BOUND"). Owner: gap lane.
// Stacked var(--ai) bars by family (Anthropic on top at fill-opacity 0.4), provisional weeks hatched, the
// text key. The only chart that uses var(--ai). Rendered only with a non-null block.
import type { Annotation } from "@/lib/schema/config";
import type { AiCredited, Series } from "@/lib/schema/metrics";

export interface AiCreditedChartProps {
  series: Series;
  ai: AiCredited;
  /** The annotations whose panels include "ai"; the chart drops those off its axis. */
  markers: Annotation[];
}

export function AiCreditedChart({ series }: AiCreditedChartProps) {
  return <figure><svg viewBox="0 0 400 108" role="img" aria-label="AI-credited" /><figcaption>{series.weeks.length}</figcaption></figure>;
}
