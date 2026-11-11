// STUB (SPEC §7 "GapPanel and charts"). Owner: gap lane. <section id="gap" className="night ...">: "§03 THE
// GAP", "DATA TO <shortDate(data_cutoff_utc)> UTC"; gap.second_line; gapNotices(); the three charts;
// FixSideStrip; gapFooter(). With metrics null, status missing or gapOk false: the header and
// EMPTY_LINES.gap_missing only. A null block: its chartCaptions() entry.
import type { GapRef } from "@/lib/schema/brief";
import type { Annotation } from "@/lib/schema/config";
import type { Metrics } from "@/lib/schema/metrics";

export interface GapPanelProps {
  gap: GapRef;
  metrics: Metrics | null;
  gapOk: boolean;
  /** Every annotation; each chart gets those whose panels include it. */
  annotations: Annotation[];
  /** The brief's date: gapNotices() and fixSideLines() print dates against it (added in P4, see the notes). */
  editionDate: string;
}

export function GapPanel({ gap }: GapPanelProps) {
  return <section id="gap" className="night"><p>{gap.status}</p></section>;
}
