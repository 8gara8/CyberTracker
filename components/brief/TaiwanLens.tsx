// SPEC §7 "Brief components", TaiwanLens: the analysis (counted) with its source refs and item links
// (TAIWAN_NO_NEWS verbatim on a quiet day); the active watch windows "Watch: <title>, <start> to <end>"; the
// six TAIWAN_LENS_ROWS in fixed order, each its label then its text (counted) or NO_NEWS_ROW, home_vendors
// adding the three lensKevLines() (counted); then "Japan" with its text (counted) or NO_NEWS_ROW. Data-only:
// the analysis reads EMPTY_LINES.not_data_only (counted, as scriptParts() has it); the script lines still show.
import type { Edition } from "@/lib/schema/common";
import type { TaiwanLens as TaiwanLensData } from "@/lib/schema/brief";
import type { Item } from "@/lib/schema/item";
import { shortDate } from "@/lib/format";
import { EMPTY_LINES, lensKevLines } from "@/lib/page-text";
import { NO_NEWS_ROW, TAIWAN_LENS_ROWS, TAIWAN_LENS_ROW_INFO } from "@/lib/vocab";
import { COUNTED, Counted } from "@/components/ui/Counted";
import { PlainText } from "@/components/ui/PlainText";
import { ItemLinks } from "./brief-parts";
import { SourceRefs, type SourceIndex } from "./sources";

export interface TaiwanLensProps {
  lens: TaiwanLensData;
  edition: Edition;
  /** The brief's date: which watch windows are active. */
  editionDate: string;
  index: SourceIndex;
  itemsById: Record<string, Item>;
}

/** A row's or Japan's text with its refs and item links, or NO_NEWS_ROW (not counted). */
function RowText({ text, itemIds, sourceIds, index, itemsById }: {
  text: string | null; itemIds: readonly string[]; sourceIds: readonly string[]; index: SourceIndex; itemsById: Record<string, Item>;
}) {
  if (text === null) return <span className="text-muted">{NO_NEWS_ROW}</span>;
  return (
    <>
      <Counted text={text} /> <SourceRefs ids={sourceIds} index={index} /><ItemLinks ids={itemIds} itemsById={itemsById} />
    </>
  );
}

const LABEL = "font-mono text-[10px] uppercase tracking-[0.14em] text-muted pt-1 sm:pt-[3px]";

export function TaiwanLens({ lens, edition, editionDate, index, itemsById }: TaiwanLensProps) {
  const dataOnly = edition === "data_only";
  const windows = lens.watch_windows.filter((w) => w.start <= editionDate && editionDate <= w.end);
  const byRow = new Map(lens.rows.map((r) => [r.row, r]));
  const kev = lensKevLines(lens);
  return (
    <div>
      <p className="prose-serif [text-wrap:pretty]">
        {dataOnly ? (
          <span {...COUNTED} className="text-muted">{EMPTY_LINES.not_data_only}</span>
        ) : (
          <>
            <Counted text={lens.analysis} /> <SourceRefs ids={lens.source_ids} index={index} /><ItemLinks ids={lens.item_ids} itemsById={itemsById} />
          </>
        )}
      </p>
      {windows.length ? (
        <ul className="mt-3 flex flex-col gap-1">
          {windows.map((w) => (
            <li key={w.id} className="border-l-2 border-rule pl-2 font-mono text-[12px] text-fg">
              Watch: <PlainText text={w.title} />, {shortDate(w.start)} to {shortDate(w.end)}
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-1 border-t border-dotted border-line pt-2 sm:grid-cols-[14rem_minmax(0,1fr)]">
        {TAIWAN_LENS_ROWS.map((id) => {
          const row = byRow.get(id);
          return (
            <div key={id} className="contents">
              <dt className={LABEL}>{TAIWAN_LENS_ROW_INFO[id].label}</dt>
              <dd className="pb-2 text-[14px] leading-[24px] text-soft">
                <RowText text={row?.text ?? null} itemIds={row?.item_ids ?? []} sourceIds={row?.source_ids ?? []} index={index} itemsById={itemsById} />
                {id === "home_vendors" ? (
                  <span className="mt-1 block font-mono text-[12px] leading-[1.6] text-soft tabular-nums">
                    {kev.map((line, i) => <Counted key={i} text={line} className="block" />)}
                  </span>
                ) : null}
              </dd>
            </div>
          );
        })}
        <div className="contents">
          <dt className={LABEL}>Japan</dt>
          <dd className="pb-2 text-[14px] leading-[24px] text-soft">
            <RowText text={lens.japan.text} itemIds={lens.japan.item_ids} sourceIds={lens.japan.source_ids} index={index} itemsById={itemsById} />
          </dd>
        </div>
      </dl>
    </div>
  );
}
