// SPEC §7 "Brief components", ScoreboardSection. Mondays (week_in_review set): the week in review's text, the
// ScoreboardTable (Claim, Status, Zone, Reading "as of <date>"; words only: OPEN, HIT, MISS, VOID; SUPPORT,
// CHALLENGE, BETWEEN, NO READING) and StrongestAgainst (a panel "Strongest evidence against": the text or
// NONE_FOUND, refs, claim id). Every day: each entry "<entry id> · <claim_id> · <DIRECTION>", its summary, a
// report entry's reported_value, quote and link (a metric entry's summary already holds its reading formatted, so
// its raw stored value is not printed); with none, SCOREBOARD_NO_ENTRY from scoreboard.last, or "No Scoreboard
// entries yet." Nothing here is counted (§4.12: the week in review, the strongest evidence and the entries'
// summaries are not in the total).
import type { Brief, WeekInReview } from "@/lib/schema/brief";
import type { ScoreboardEntry } from "@/lib/schema/scoreboard";
import { shortDate } from "@/lib/format";
import { NONE_FOUND, SCOREBOARD_NO_ENTRY } from "@/lib/vocab";
import { Empty } from "@/components/layout/chrome";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { PlainText } from "@/components/ui/PlainText";
import { fillTemplate, upperWord } from "./brief-parts";
import { SourceRefs, type SourceIndex } from "./sources";

export interface ScoreboardSectionProps {
  brief: Brief;
  index: SourceIndex;
}

/** §7's line when no entry was ever made. */
const NO_ENTRIES_YET = "No Scoreboard entries yet.";

const TH = "border-b border-rule py-1.5 pr-3 text-left font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-muted";
const TD = "border-b border-dotted border-line py-2 pr-3 align-top";

/** The week's claims: Claim, Status, Zone, Reading "as of <date>". */
export function ScoreboardTable({ rows }: { rows: WeekInReview["table"] }) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full border-collapse text-[13px] leading-[1.45] text-soft">
        <caption className="sr-only">Thesis Scoreboard claims this week</caption>
        <thead>
          <tr>
            <th scope="col" className={TH}>Claim</th>
            <th scope="col" className={TH}>Status</th>
            <th scope="col" className={TH}>Zone</th>
            <th scope="col" className={TH}>Reading</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.claim_id}>
              <td className={TD}>
                <span className="font-mono text-[12px] text-fg"><PlainText text={r.claim_id} /></span>{" "}
                <PlainText text={r.text} />
              </td>
              <td className={`${TD} font-mono text-[12px] text-fg`}>{upperWord(r.status)}</td>
              <td className={`${TD} font-mono text-[12px] text-fg`}>{upperWord(r.zone)}</td>
              <td className={`${TD} tabular-nums`}>
                {r.reading_text ? (
                  <>
                    <PlainText text={r.reading_text} />
                    {r.reading_as_of ? <span className="text-muted"> as of {shortDate(r.reading_as_of)}</span> : null}
                  </>
                ) : <span className="text-muted">none</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The panel: the strongest evidence against the thesis this week, or NONE_FOUND, with refs and claim id. */
export function StrongestAgainst({ against, index }: { against: WeekInReview["strongest_against"]; index: SourceIndex }) {
  return (
    <div className="mt-4 border border-rule bg-panel px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg">Strongest evidence against</p>
      <p className="prose-serif mt-1.5 text-[16px] md:text-[17px]">
        {against.text === NONE_FOUND ? <span className="text-muted">{NONE_FOUND}</span> : <PlainText text={against.text} />}{" "}
        <SourceRefs ids={against.source_ids} index={index} />
      </p>
      {against.claim_id ? <p className="mt-1 font-mono text-[11px] text-muted"><PlainText text={against.claim_id} /></p> : null}
    </div>
  );
}

/**
 * One entry: "<entry id> · <claim_id> · <DIRECTION>", the summary, the reported value, the quote and the link. A
 * metric entry's `value` is the raw reading (0.3712); its summary already gives it formatted ("37% (80% range
 * 32% to 42%)", metricEntrySummary()), so it is not printed again.
 */
function Entry({ entry }: { entry: ScoreboardEntry }) {
  const value = entry.reported_value;
  return (
    <li className="border-l-2 border-rule pl-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-fg">
        {entry.id} · <PlainText text={entry.claim_id} /> · {upperWord(entry.direction)}
      </p>
      <p className="mt-1 text-[14px] leading-[1.5] text-soft">
        <PlainText text={entry.summary} />
        {value ? <> <span className="font-mono text-[12px] text-fg"><PlainText text={value} /></span></> : null}
      </p>
      {entry.quote ? <p className="mt-1 text-[14px] italic leading-[1.5] text-soft">“<PlainText text={entry.quote} />”</p> : null}
      {entry.source_url ? (
        <p className="mt-1 font-mono text-[11px] uppercase leading-[24px] tracking-[0.1em]"><ExternalLink href={entry.source_url}>Source</ExternalLink></p>
      ) : entry.metrics_ref ? (
        <p className="mt-1 font-mono text-[11px] text-muted">
          From <PlainText text={entry.metrics_ref.file} />, <PlainText text={entry.metrics_ref.path} />
        </p>
      ) : null}
    </li>
  );
}

export function ScoreboardSection({ brief, index }: ScoreboardSectionProps) {
  const wir = brief.week_in_review;
  const { entries, last } = brief.scoreboard;
  return (
    <div>
      {wir ? (
        <div className="mb-6">
          <p className="kicker">Week in review · {shortDate(wir.from)} to {shortDate(wir.to)}</p>
          <p className="prose-serif mt-2 [text-wrap:pretty]"><PlainText text={wir.text} /></p>
          <ScoreboardTable rows={wir.table} />
          <StrongestAgainst against={wir.strongest_against} index={index} />
        </div>
      ) : null}
      {entries.length ? (
        <ul className="flex flex-col gap-4">{entries.map((e) => <Entry key={e.id} entry={e} />)}</ul>
      ) : last ? (
        <p className="text-[14px] text-soft">
          <PlainText text={fillTemplate(SCOREBOARD_NO_ENTRY, { date: shortDate(last.date), claim: `${last.claim_id} ${last.claim_text}` })} />
        </p>
      ) : (
        <Empty>{NO_ENTRIES_YET}</Empty>
      )}
    </div>
  );
}
