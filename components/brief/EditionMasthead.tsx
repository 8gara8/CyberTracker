// STUB (SPEC §7 "Brief components", EditionMasthead). Owner: brief lane. Dateline "MORNING BRIEF · TAIPEI"
// (+ " · DATA-ONLY EDITION" or " · PARTIAL EDITION"); h1 longDate(date); mastheadLine(); gapHeadlineLine(brief,
// gapOk); editionNotice() (role="note").
import type { Brief } from "@/lib/schema/brief";

export interface EditionMastheadProps {
  brief: Brief;
  gapOk: boolean;
}

export function EditionMasthead({ brief }: EditionMastheadProps) {
  return <header>{brief.date}</header>;
}
