// SPEC §7 "Brief components", EditionMasthead: the dateline "MORNING BRIEF · TAIPEI" (+ " · DATA-ONLY EDITION" or
// " · PARTIAL EDITION"); the one h1, longDate(date); mastheadLine(); gapHeadlineLine(brief, gapOk) (Newsreader
// 19px, at most 72ch; shown here only, and not when the Gap is missing or failed GAP_MATCH); editionNotice()
// (role="note"). The three page-text lines are counted (`data-words`); the dateline and the date are not. No
// <header> element: the page's one banner landmark is the site masthead (§7 Accessibility).
import type { Brief } from "@/lib/schema/brief";
import { longDate } from "@/lib/format";
import { editionNotice, gapHeadlineLine, mastheadLine } from "@/lib/page-text";
import { Counted } from "@/components/ui/Counted";
import { Dateline } from "@/components/layout/chrome";

export interface EditionMastheadProps {
  brief: Brief;
  gapOk: boolean;
}

/** The dateline's words (CSS shows them upper case). */
const EDITION_DATELINE: Record<Brief["edition"], string> = {
  full: "Morning brief · Taipei",
  partial: "Morning brief · Taipei · Partial edition",
  data_only: "Morning brief · Taipei · Data-only edition",
};

export function EditionMasthead({ brief, gapOk }: EditionMastheadProps) {
  const headline = gapHeadlineLine(brief, gapOk);
  const notice = editionNotice(brief);
  return (
    <div className="mb-2">
      <Dateline>{EDITION_DATELINE[brief.edition]}</Dateline>
      <h1 className="brief-h1 mt-2">{longDate(brief.date)}</h1>
      <p className="mt-2 font-mono text-[12px] tracking-[0.04em] text-muted tabular-nums">
        <Counted text={mastheadLine(brief)} />
      </p>
      {headline ? (
        <p className="mt-4 max-w-[72ch] font-display text-[19px] leading-[1.4] text-fg [text-wrap:pretty]">
          <Counted text={headline} />
        </p>
      ) : null}
      {notice ? (
        <p role="note" className="mt-3 max-w-[72ch] border-l-2 border-rule bg-[var(--badge-mix)] px-3 py-2 text-[14px] leading-[1.5] text-fg">
          <Counted text={notice} />
        </p>
      ) : null}
    </div>
  );
}
