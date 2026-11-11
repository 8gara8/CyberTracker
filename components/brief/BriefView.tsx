// STUB (SPEC §7 "BriefView and section order"). Owner: brief lane. Inside <article>, in order: StaleBanner
// (when isLatest) and EditionMasthead (id="top"), §01 lead, §02 regions, §03 gap (GapPanel), §04
// top-stories (ItemCard x up to 3), §05 also-today (ItemRows under HEADS; data-only adds EpssMovers), §06
// actors, §07 taiwan, §08 scoreboard, §09 elsewhere, foot corrections and sources, BRIEF_END and
// <nav aria-label="Other editions">. Props: BriefViewProps (components/brief/props.ts, S0).
import { longDate } from "@/lib/format";
import type { BriefViewProps } from "./props";

export type { BriefViewProps } from "./props";

export function BriefView({ brief }: BriefViewProps) {
  return (
    <article>
      <h1 className="brief-h1">{longDate(brief.date)}</h1>
    </article>
  );
}
