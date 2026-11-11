// SPEC §7 "Brief components", ItemRow: a closed <details id={item.id}>. The summary (at least 44px tall) holds
// the kicker and the h3 headline; open, the card's parts follow (CorrectionBanner, "Impact:", the summary with
// its refs, "Why it matters →", the script line, the chips, the Anthropic line, the footer links) with
// ItemDetails inline, so there is no nested <details>. A withheld item carries no `data-words` and, as on the
// card, shows no "Impact:" line and no ItemDetails.
import { isWithheld } from "@/lib/items";
import { CorrectionBanner } from "./CorrectionBanner";
import { ItemDetails } from "./ItemDetails";
import type { ItemCardProps } from "./ItemCard";
import { itemAnchor } from "./brief-parts";
import { CardBody, CardLinks, FOOTER_ROW, ImpactLine, Kicker, Text } from "./item-parts";
import { SourceRefs } from "./sources";

export type ItemRowProps = ItemCardProps;

export function ItemRow({ item, editionDate, edition, index, sourcesById, corrections, held, hasPage }: ItemRowProps) {
  const counted = !isWithheld(item);
  return (
    <details id={itemAnchor(item.id)} className="group border-b border-dotted border-line">
      <summary className="flex min-h-[44px] cursor-pointer list-none flex-col justify-center gap-0.5 py-2 [&::-webkit-details-marker]:hidden">
        <Kicker item={item} edition={edition} counted={counted} />
        <h3 className="flex items-baseline gap-2 text-[16px] font-semibold leading-[1.3] text-fg">
          <span aria-hidden="true" className="font-mono text-[11px] text-muted group-open:rotate-90">▸</span>
          <span><Text text={item.headline} counted={counted} /></span>
        </h3>
      </summary>
      <div className="pb-4 pl-5">
        <CorrectionBanner corrections={corrections} held={held} />
        {counted ? <ImpactLine item={item} counted={counted} /> : null}
        <CardBody item={item} editionDate={editionDate} index={index} counted={counted} />
        <div className={FOOTER_ROW}>
          {item.source_ids.length ? <span>sources <SourceRefs ids={item.source_ids} index={index} /></span> : null}
          <CardLinks item={item} editionDate={editionDate} hasPage={hasPage} />
        </div>
        {counted ? <ItemDetails item={item} editionDate={editionDate} index={index} sourcesById={sourcesById} /> : null}
      </div>
    </details>
  );
}
