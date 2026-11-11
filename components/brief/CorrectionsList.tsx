// SPEC §7 "Brief components", CorrectionsList: the foot block's lines (BriefView omits the block when
// brief.corrections is empty): "<id> · <longDate(edition_date)> edition · <item id> (linked to
// /brief/<edition_date>#<item id> when the site has that edition, else plain) · <TYPE> · <reason>". While a withhold binds the item, a line other than
// NAME REMOVED shows WITHHELD_MARK for its reason (heldCorrection()). Not counted.
import Link from "next/link";
import type { Correction } from "@/lib/schema/misc";
import { longDate } from "@/lib/format";
import { heldCorrection } from "@/lib/site-data";
import { WITHHELD_MARK } from "@/lib/vocab";
import { PlainText } from "@/components/ui/PlainText";
import { CORRECTION_WORD } from "./CorrectionBanner";
import { itemAnchor } from "./brief-parts";

export interface CorrectionsListProps {
  corrections: Correction[];
  /** heldItemIds(content): the items a withhold binds. */
  held: ReadonlySet<string>;
  /** The loaded briefs' dates: an edition the site skipped is not linked (it would be a 404). */
  editionDates: ReadonlySet<string>;
}

export function CorrectionsList({ corrections, held, editionDates }: CorrectionsListProps) {
  return (
    <ol className="flex flex-col gap-1.5 text-[13px] leading-[1.5] text-soft">
      {corrections.map((c) => {
        const anchor = itemAnchor(c.item_id);
        return (
          <li key={c.id}>
            <span className="font-mono text-[12px] text-fg">{c.id}</span>
            {" · "}{longDate(c.edition_date)} edition{" · "}
            {anchor && editionDates.has(c.edition_date) ? (
              <Link href={`/brief/${c.edition_date}#${anchor}`} className="font-mono text-[12px]">{anchor}</Link>
            ) : (
              <span className="font-mono text-[12px]">{anchor ?? <PlainText text={c.item_id} />}</span>
            )}
            {" · "}<span className="font-mono text-[11px] uppercase tracking-[0.1em] text-fg">{CORRECTION_WORD[c.type]}</span>
            {" · "}{heldCorrection(c, held) ? WITHHELD_MARK : <PlainText text={c.reason} />}
          </li>
        );
      })}
    </ol>
  );
}
