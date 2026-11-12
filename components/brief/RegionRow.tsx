// SPEC §7 "Brief components", RegionRow: a closed <details>, one line at 375px. The summary holds
// regionSummary(row).head ("TW ●●○○ ELEVATED ↑": code, region pips, level word, REGION_CHANGE glyph) and the
// stored reason, each counted; the pips and the glyph are aria-hidden inside the counted head, and their hidden
// words ("level 2 of 4", "up from BASELINE") follow it, outside. The reason shows once: truncated while closed,
// wrapped when open. Open: BASELINE_TOOLTIP on a baseline row (also the summary's title); "Yesterday: <WORD>";
// each fired rule "<rule_id> · <WORD>" linking /methodology#rule-<rule_id>, with its items (an item of an earlier
// edition by its stored headline, linking that edition's card); when raised,
// EDITOR_RAISED (its reason counted) and "Rules alone: <WORD>". GlobalRow: "GLOBAL · <n> items" linking
// #also-today, with no level.
import Link from "next/link";
import { Fragment } from "react";
import type { RegionRow as RegionRowData } from "@/lib/schema/brief";
import type { Item } from "@/lib/schema/item";
import { regionSummary } from "@/lib/page-text";
import { fmtInt } from "@/lib/metrics/stats";
import { BASELINE_TOOLTIP, EDITOR_RAISED, REGION_CHANGE, REGION_LEVEL_INFO } from "@/lib/vocab";
import { COUNTED, Counted } from "@/components/ui/Counted";
import { SeverityPips, levelWords } from "@/components/ui/SeverityPips";
import { ItemLinks, ItemRef, configAnchor, type EarlierItems } from "./brief-parts";

export interface RegionRowProps {
  row: RegionRowData;
  /** The brief's items by id, for the fired rules' item links. */
  itemsById: Record<string, Item>;
  /** BriefViewProps.earlierItems: the rules' items from earlier editions. */
  earlierItems: EarlierItems;
}

/** The change glyph's hidden words: "up from ELEVATED", "down from HIGH", "same as yesterday"; none for new. */
export function changeWords(row: Pick<RegionRowData, "change" | "previous_level">): string | null {
  const prev = row.previous_level ? REGION_LEVEL_INFO[row.previous_level].word : null;
  if (row.change === "up") return prev ? `up from ${prev}` : "up";
  if (row.change === "down") return prev ? `down from ${prev}` : "down";
  if (row.change === "same") return "same as yesterday";
  return null;
}

/** "Editor raised: {reason}" split around its placeholder, so only the stored reason is counted. */
const [RAISED_BEFORE, RAISED_AFTER] = EDITOR_RAISED.split("{reason}") as [string, string];

/** A list of item links: each item's headline (in this brief, or the earlier edition holding it), else its id. */
function Items({ ids, itemsById, earlierItems }: { ids: readonly string[]; itemsById: Record<string, Item>; earlierItems: EarlierItems }) {
  const unique = [...new Set(ids)];
  if (!unique.length) return null;
  return (
    <>
      {": "}
      {unique.map((id, i) => <Fragment key={id}>{i ? "; " : ""}<ItemRef id={id} itemsById={itemsById} earlierItems={earlierItems} /></Fragment>)}
    </>
  );
}

export function RegionRow({ row, itemsById, earlierItems }: RegionRowProps) {
  const summary = regionSummary(row);
  const glyph = REGION_CHANGE[row.change];
  const hidden = [levelWords("region", row.level), changeWords(row)].filter(Boolean).join(", ");
  const baseline = row.level === "baseline";
  return (
    <details className="group border-b border-dotted border-line">
      <summary
        className="flex min-h-[40px] cursor-pointer list-none items-center gap-2.5 py-1.5 [&::-webkit-details-marker]:hidden"
        title={baseline ? BASELINE_TOOLTIP : undefined}
      >
        <span className="shrink-0 font-mono text-[13px] uppercase tracking-[0.04em] text-fg tabular-nums">
          <span {...COUNTED}>
            {row.code}{" "}
            <SeverityPips scale="region" level={row.level} words={false} />
            {glyph ? <>{" "}<span aria-hidden="true">{glyph}</span></> : null}
          </span>
          {hidden ? <span className="sr-only"> {hidden}</span> : null}
        </span>
        <span className="min-w-0 flex-1 truncate text-[14px] text-soft group-open:overflow-visible group-open:whitespace-normal">
          <Counted text={summary.reason} />
        </span>
      </summary>
      <div className="pb-3 pl-1 text-[13px] leading-[24px] text-soft">
        {baseline ? <p className="italic text-muted">{BASELINE_TOOLTIP}</p> : null}
        <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
          Yesterday: {row.previous_level ? REGION_LEVEL_INFO[row.previous_level].word : "no edition"}
        </p>
        {row.fired.length ? (
          <ul className="mt-1 flex flex-col gap-1">
            {row.fired.map((f, i) => {
              const anchor = configAnchor(f.rule_id);
              const label = `${f.rule_id} · ${REGION_LEVEL_INFO[f.level].word}`;
              return (
                <li key={`${f.rule_id}-${i}`}>
                  {anchor ? <Link href={`/methodology#rule-${anchor}`} className="font-mono text-[12px]">{label}</Link> : <span className="font-mono text-[12px]">{label}</span>}
                  <Items ids={f.item_ids} itemsById={itemsById} earlierItems={earlierItems} />
                </li>
              );
            })}
          </ul>
        ) : null}
        {row.raised ? (
          <>
            <p className="mt-1">
              {RAISED_BEFORE}<Counted text={row.raised.reason} />{RAISED_AFTER}
              <ItemLinks ids={row.raised.item_ids} itemsById={itemsById} />
            </p>
            <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
              Rules alone: {REGION_LEVEL_INFO[row.computed_level].word}
            </p>
          </>
        ) : null}
      </div>
    </details>
  );
}

export interface GlobalRowProps {
  /** regions.global.item_count. */
  itemCount: number;
}

export function GlobalRow({ itemCount }: GlobalRowProps) {
  return (
    <p className="flex min-h-[40px] items-center font-mono text-[13px] uppercase tracking-[0.04em] text-fg">
      <a href="#also-today">GLOBAL · {fmtInt(itemCount)} {itemCount === 1 ? "item" : "items"}</a>
    </p>
  );
}
