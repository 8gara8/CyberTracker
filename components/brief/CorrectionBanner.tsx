// SPEC §7 "Brief components", CorrectionBanner (ItemCard, ItemRow and the item page use it). role="note", a left
// rule and the panel; one line per correction, oldest first: "<TYPE> <shortDate(date)> · <field>: now
// '<after>'. <reason>" with the source as a link; NAME REMOVED reads "NAME REMOVED <date> · while a dispute about
// a named party is reviewed." While a withhold binds the correction's item (heldCorrection()), any other line
// reads "<TYPE> <date> · [withheld]", with no field, after, reason or link, so a correction written before the
// withhold (or a restore before a new dispute) never prints the disputed name. Labels only: nothing here is
// counted (corrections reasons are not in the total).
import type { Correction } from "@/lib/schema/misc";
import { WITHHELD_MARK, type CorrectionType } from "@/lib/vocab";
import { shortDate } from "@/lib/format";
import { heldCorrection } from "@/lib/site-data";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { PlainText } from "@/components/ui/PlainText";

export interface CorrectionBannerProps {
  /** Oldest first (correctionsFor()); renders nothing when empty. */
  corrections: Correction[];
  /** heldItemIds(content): the items a withhold binds. */
  held: ReadonlySet<string>;
}

/** The banner's and the corrections list's type words. */
export const CORRECTION_WORD: Record<CorrectionType, string> = {
  correction: "CORRECTED",
  clarification: "CLARIFIED",
  update: "UPDATED",
  name_removed: "NAME REMOVED",
};

/** §7's fixed NAME REMOVED line after the date. */
const NAME_REMOVED_LINE = "while a dispute about a named party is reviewed.";

export function CorrectionBanner({ corrections, held }: CorrectionBannerProps) {
  if (!corrections.length) return null;
  return (
    <div role="note" className="mb-3 border-l-2 border-rule bg-panel px-3 py-2 text-[13px] leading-[1.5] text-soft">
      <ul className="flex flex-col gap-1">
        {corrections.map((c) => (
          <li key={c.id}>
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-fg">
              {CORRECTION_WORD[c.type]} {shortDate(c.date)}
            </span>
            {" · "}
            {c.type === "name_removed" ? (
              NAME_REMOVED_LINE
            ) : heldCorrection(c, held) ? (
              WITHHELD_MARK
            ) : (
              <>
                <span className="font-mono text-[12px]"><PlainText text={c.field} /></span>: now &apos;<PlainText text={c.after} />&apos;.{" "}
                <PlainText text={c.reason} />
                {c.source_url ? <>{" "}<ExternalLink href={c.source_url}>Source</ExternalLink></> : null}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
