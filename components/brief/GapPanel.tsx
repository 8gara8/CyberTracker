// SPEC §7 "GapPanel and charts": the Gap, the one dark surface on a paper page (<section id="gap" class="night">,
// Appendix A.2), edge to edge below 640px. Top to bottom: "§03 THE GAP" with "DATA TO <shortDate(data_cutoff_utc)>
// UTC" on the right; gap.second_line; gapNotices() (role="note"); the three charts, each with its
// chartCaptions() entry under it (a null block shows only that entry, "<Chart name> is not available today.");
// the FixSideStrip; gapFooter(). With metrics null, status "missing" or gapOk false: the header and
// EMPTY_LINES.gap_missing only. Every lib/page-text.ts output here is one counted string, marked once with
// data-words, exactly the Gap part of scriptParts() (§4.12), so the page counts what the validator counts; the
// header and everything components/charts/ draws are never marked. Owner: gap lane.
import type { ReactNode } from "react";
import { shortDate } from "@/lib/format";
import { EMPTY_LINES, chartCaptions, gapFooter, gapNotices, gapSecondLine } from "@/lib/page-text";
import type { GapRef } from "@/lib/schema/brief";
import type { Annotation } from "@/lib/schema/config";
import type { Metrics } from "@/lib/schema/metrics";
import type { GapPanel as Panel } from "@/lib/vocab";
import { AiCreditedChart } from "../charts/AiCreditedChart";
import { FloodChart } from "../charts/FloodChart";
import { WindowChart } from "../charts/WindowChart";
import { COUNTED } from "../ui/Counted";
import { PlainText } from "../ui/PlainText";
import { FixSideStrip } from "./FixSideStrip";

export interface GapPanelProps {
  gap: GapRef;
  metrics: Metrics | null;
  gapOk: boolean;
  /** Every annotation; each chart gets those whose panels include it. */
  annotations: Annotation[];
  /** The brief's date: gapNotices() and fixSideLines() print dates against it (added in P4, see the notes). */
  editionDate: string;
}

/** The Gap's fixed section number (§7 "BriefView and section order": "§03" is always the Gap). */
const GAP_SECTION = 3;

/** One counted line: an element whose text is exactly `text` (through PlainText), marked data-words. */
function Line({ text, className, note = false }: { text: string; className?: string; note?: boolean }) {
  return <p {...COUNTED} role={note ? "note" : undefined} className={className}><PlainText text={text} /></p>;
}

/** A chart's caption lines, under its marker key. */
function Captions({ lines, first }: { lines: readonly string[]; first?: string }) {
  return (
    <>
      {lines.map((l, i) => <Line key={i} text={l} className={i === 0 && first ? first : "mt-2 max-w-[72ch] text-[13px] text-soft"} />)}
    </>
  );
}

/** The header: the siblings' section rule and label, with the data cutoff on the right when the Gap is shown. */
function Header({ right }: { right: ReactNode }) {
  return (
    <h2 className="mb-4 flex items-baseline gap-3 border-t border-rule pt-2">
      <span className="font-mono text-[10px] tracking-[0.14em] text-muted">§{String(GAP_SECTION).padStart(2, "0")}</span>
      <span className="font-sans text-[11px] font-semibold uppercase tracking-[0.22em] text-fg">The Gap</span>
      {right ? <span className="kicker ml-auto text-right">{right}</span> : null}
    </h2>
  );
}

export function GapPanel({ gap, metrics, gapOk, annotations, editionDate }: GapPanelProps) {
  const shown = gapOk && metrics !== null && gap.status !== "missing";
  return (
    <section id="gap" className="night mt-9 -mx-4 px-4 pt-4 pb-6 sm:mx-0 sm:px-6">
      <Header right={shown ? `DATA TO ${shortDate(metrics.data_cutoff_utc)} UTC` : null} />
      {shown
        ? <GapBody gap={gap} metrics={metrics} annotations={annotations} editionDate={editionDate} />
        : <Line text={EMPTY_LINES.gap_missing} className="text-[14px] text-soft" />}
    </section>
  );
}

function GapBody({ gap, metrics, annotations, editionDate }: { gap: GapRef; metrics: Metrics; annotations: Annotation[]; editionDate: string }) {
  const second = gapSecondLine({ gap });
  const notices = gapNotices({ date: editionDate, gap }, metrics);
  const captions = chartCaptions(metrics);
  const footer = gapFooter(metrics);
  const panel = (p: Panel) => annotations.filter((a) => a.panels.includes(p));
  const unavailable = (lines: readonly string[]) => <div className="mt-7"><Captions lines={lines} /></div>;
  return (
    <>
      {second ? <Line text={second} className="max-w-[72ch] text-[15px] text-fg" /> : null}
      {notices.map((n, i) => <Line key={i} note text={n} className="mt-2 max-w-[72ch] border-l-2 border-line pl-3 text-[13px] text-soft" />)}
      {metrics.flood
        ? <FloodChart series={metrics.series} flood={metrics.flood} markers={panel("flood")} caption={<Captions lines={[captions.flood]} />} />
        : unavailable([captions.flood])}
      {metrics.window
        ? <WindowChart series={metrics.series} window={metrics.window} markers={panel("window")} caption={<Captions lines={[captions.window]} />} />
        : unavailable([captions.window])}
      {metrics.ai_credited
        ? (
          <AiCreditedChart
            series={metrics.series}
            ai={metrics.ai_credited}
            markers={panel("ai")}
            caption={(
              <>
                <Captions lines={captions.ai} first="mt-2 max-w-[72ch] font-mono text-[12px] text-soft" />
                {captions.aiInKev
                  ? (
                    <div className="mt-2 max-w-[72ch] text-[13px] text-soft">
                      <Line text={captions.aiInKev[0]!} />
                      {captions.aiInKev.length > 1
                        ? <ul className="mt-1 font-mono text-[12px]">{captions.aiInKev.slice(1).map((e, i) => <li key={i} {...COUNTED}><PlainText text={e} /></li>)}</ul>
                        : null}
                    </div>
                  )
                  : null}
              </>
            )}
          />
        )
        : unavailable(captions.ai)}
      <FixSideStrip fixSide={metrics.fix_side} editionDate={editionDate} />
      <div className="mt-6 border-t border-line pt-2">
        {footer.map((l, i) => <Line key={i} text={l} className="font-mono text-[11px] leading-[1.6] text-muted [overflow-wrap:anywhere]" />)}
      </div>
    </>
  );
}
