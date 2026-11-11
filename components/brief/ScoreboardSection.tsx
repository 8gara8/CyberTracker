// STUB (SPEC §7 "Brief components", ScoreboardSection). Owner: brief lane. Mondays: week_in_review.text,
// ScoreboardTable, StrongestAgainst ("STRONGEST EVIDENCE AGAINST"); every day, each entry or
// SCOREBOARD_NO_ENTRY from scoreboard.last, or "No Scoreboard entries yet."
import type { Brief } from "@/lib/schema/brief";
import type { SourceIndex } from "./sources";

export interface ScoreboardSectionProps {
  brief: Brief;
  index: SourceIndex;
}

export function ScoreboardSection({ brief }: ScoreboardSectionProps) {
  return <div>{brief.scoreboard.entries.length}</div>;
}
