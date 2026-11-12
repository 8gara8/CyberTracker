// SPEC §7 "GapPanel and charts", FixSideStrip; §5.6. Text only, each figure dated: fixSideLines(fixSide,
// editionDate) as lib/page-text.ts writes them (the Anthropic dashboard line when anthropic_cvd is set, the
// GitHub line when ghsa_unfixed is set with at least MIN_N advisories, FIX_SIDE_CAPTION always). Each line is a
// counted string, marked once; the dashboard line's opening words link to the dashboard (source_url) through
// ExternalLink, inside the marked element, so its text is still exactly the line. Owner: gap lane.
import { fixSideLines } from "@/lib/page-text";
import type { FixSide } from "@/lib/schema/metrics";
import { COUNTED } from "../ui/Counted";
import { ExternalLink } from "../ui/ExternalLink";
import { PlainText } from "../ui/PlainText";

export interface FixSideStripProps {
  fixSide: FixSide;
  editionDate: string;
}

/** The dashboard line cut at its first " (": the link text ("Anthropic disclosure dashboard") and the rest. */
function linkParts(line: string): { head: string; rest: string } {
  const cut = line.indexOf(" (");
  return cut > 0 ? { head: line.slice(0, cut), rest: line.slice(cut) } : { head: line, rest: "" };
}

export function FixSideStrip({ fixSide, editionDate }: FixSideStripProps) {
  const lines = fixSideLines(fixSide, editionDate);
  const cvd = fixSide.anthropic_cvd;
  const last = lines.length - 1;
  return (
    <div className="mt-7 max-w-[72ch] border-t border-line pt-3">
      <p className="kicker mb-1">Fix-side</p>
      {lines.map((line, i) => {
        const cls = i === last ? "mt-1 text-[13px] leading-[24px] text-muted" : "mt-1 text-[14px] leading-[24px] text-soft";
        if (i === 0 && cvd) {
          const { head, rest } = linkParts(line);
          return (
            <p key={i} {...COUNTED} className={cls}>
              <ExternalLink href={cvd.source_url}><PlainText text={head} /></ExternalLink><PlainText text={rest} />
            </p>
          );
        }
        return <p key={i} {...COUNTED} className={cls}><PlainText text={line} /></p>;
      })}
    </div>
  );
}
