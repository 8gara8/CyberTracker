// SPEC §7 "Brief components", ItemCard: <article id={item.id}>; CorrectionBanner when corrected; the kicker
// (cardKicker(): pips, AIChip, region codes, vendor as text); "Impact:" for incidents; the h3 headline; the
// summary with SourceRefs; "Why it matters →"; releaseLine() or cveTimeline(); the chips; ANTHROPIC_LINE; then
// the footer: "sources [1][3]", a "details" <details> holding ItemDetails, "Timeline →" when the item has a page,
// "Report an error". A withheld item (§4.10) renders as stored and carries no `data-words` (§0.4 row 126).
import type { Edition, Source } from "@/lib/schema/common";
import type { Item } from "@/lib/schema/item";
import type { Correction } from "@/lib/schema/misc";
import { isWithheld } from "@/lib/items";
import { CorrectionBanner } from "./CorrectionBanner";
import { ItemDetails } from "./ItemDetails";
import { itemAnchor } from "./brief-parts";
import { CardBody, CardLinks, FOOTER_ROW, ImpactLine, Kicker, Text } from "./item-parts";
import { SourceRefs, type SourceIndex } from "./sources";

export interface ItemCardProps {
  item: Item;
  /** The brief's date (cveTimeline() and releaseLine() print years only when they differ). */
  editionDate: string;
  edition: Edition;
  index: SourceIndex;
  /** The brief's sources by id. */
  sourcesById: Record<string, Source>;
  /** correctionsFor(content, item.id, editionDate). */
  corrections: Correction[];
  /** True when the item has an /items/<id> page. */
  hasPage: boolean;
}

export function ItemCard({ item, editionDate, edition, index, sourcesById, corrections, hasPage }: ItemCardProps) {
  const counted = !isWithheld(item);
  return (
    <article id={itemAnchor(item.id)} className="border-t border-line pt-4 pb-5 first:border-t-0 first:pt-0">
      <CorrectionBanner corrections={corrections} />
      <Kicker item={item} edition={edition} counted={counted} />
      <ImpactLine item={item} counted={counted} />
      <h3 className="display mt-1.5 text-[22px] leading-[1.2] text-fg [text-wrap:balance] md:text-[24px]">
        <Text text={item.headline} counted={counted} />
      </h3>
      <CardBody item={item} editionDate={editionDate} index={index} counted={counted} />
      <div className={FOOTER_ROW}>
        {item.source_ids.length ? (
          <span>sources <SourceRefs ids={item.source_ids} index={index} /></span>
        ) : null}
        <span aria-hidden="true">·</span>
        <details className="group open:basis-full">
          <summary className="inline-flex min-h-[24px] cursor-pointer items-center underline decoration-line underline-offset-2" aria-label={`Details: ${item.headline}`}>
            details
          </summary>
          <div className="normal-case tracking-normal font-sans">
            <ItemDetails item={item} editionDate={editionDate} index={index} sourcesById={sourcesById} />
          </div>
        </details>
        <CardLinks item={item} editionDate={editionDate} hasPage={hasPage} />
      </div>
    </article>
  );
}
