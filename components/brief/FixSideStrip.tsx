// STUB (SPEC §7 "GapPanel and charts", FixSideStrip; §5.6). Owner: gap lane. Text, each figure dated:
// fixSideLines(fixSide, editionDate) (the Anthropic dashboard line with its link when anthropic_cvd is set,
// the GitHub line, FIX_SIDE_CAPTION).
import type { FixSide } from "@/lib/schema/metrics";

export interface FixSideStripProps {
  fixSide: FixSide;
  editionDate: string;
}

export function FixSideStrip({ fixSide }: FixSideStripProps) {
  return <div>{fixSide.anthropic_cvd ? 1 : 0}</div>;
}
