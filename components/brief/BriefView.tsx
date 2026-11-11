// SPEC §7 "BriefView and section order". Inside <article>, in order: StaleBanner (when isLatest) and
// EditionMasthead (id="top"); §01 lead; §02 regions; §03 gap (GapPanel, the gap lane's); §04 top-stories
// (ItemCard × up to 3); §05 also-today (ItemRows under the HEADS; data-only adds EpssMovers); §06 actors; §07
// taiwan; §08 scoreboard; §09 elsewhere; the foot blocks corrections (omitted when empty) and sources; BRIEF_END
// and <nav aria-label="Other editions">. Numbers are fixed and an empty section shows its one line. The empty
// lines scriptParts() counts (no_items, no_rows, §06's) carry `data-words`; §09's lines and the data-only Lead
// line do not (§4.12, lib/page-text.ts EMPTY_LINES).
import Link from "next/link";
import { longDate } from "@/lib/format";
import { TOP_STORY_COUNT, rowsByHead } from "@/lib/items";
import { EMPTY_LINES } from "@/lib/page-text";
import { STALE_AFTER } from "@/lib/site";
import { indexBy } from "@/lib/site-data";
import { withheldOnlySources } from "@/lib/withhold-mask";
import { fmtInt } from "@/lib/metrics/stats";
import { BRIEF_END, EDITION_INFO, HEAD_INFO } from "@/lib/vocab";
import { Empty, Section } from "@/components/layout/chrome";
import { StaleBanner } from "@/components/layout/StaleBanner";
import { Counted } from "@/components/ui/Counted";
import { ActorChips } from "./ActorChips";
import { AngleLine } from "./AngleLine";
import { CorrectionsList } from "./CorrectionsList";
import { EditionMasthead } from "./EditionMasthead";
import { Elsewhere } from "./Elsewhere";
import { EpssMovers } from "./EpssMovers";
import { GapPanel } from "./GapPanel";
import { ItemCard } from "./ItemCard";
import { ItemRow } from "./ItemRow";
import { Lead } from "./Lead";
import { GlobalRow, RegionRow } from "./RegionRow";
import { ScoreboardSection } from "./ScoreboardSection";
import { TaiwanLens } from "./TaiwanLens";
import { FootBlock } from "./brief-parts";
import type { BriefViewProps } from "./props";
import { SourceList, sourceIndex } from "./sources";

export type { BriefViewProps } from "./props";

const plural = (n: number, one: string, many: string) => `${fmtInt(n)} ${n === 1 ? one : many}`;

export function BriefView({ brief, metrics, gapOk, annotations, correctionsByItem, heldItems, itemPages, isLatest, prevDate, nextDate }: BriefViewProps) {
  const dataOnly = brief.edition === "data_only";
  const index = sourceIndex(brief.sources);
  const sourcesById = indexBy(brief.sources);
  const itemsById = indexBy(brief.items);
  const top = brief.items.slice(0, TOP_STORY_COUNT);
  const heads = rowsByHead(brief.items);
  const cardProps = (item: (typeof brief.items)[number]) => ({
    item,
    editionDate: brief.date,
    edition: brief.edition,
    index,
    sourcesById,
    corrections: correctionsByItem[item.id] ?? [],
    held: heldItems,
    hasPage: itemPages.has(item.id),
  });

  return (
    <article>
      <div id="top">
        {isLatest ? <StaleBanner lastDate={brief.date} lastPublishedAt={brief.published_at} staleAfter={STALE_AFTER} /> : null}
        <EditionMasthead brief={brief} gapOk={gapOk} />
      </div>

      <Section id="lead" number={1} title="The Lead">
        {dataOnly ? (
          <Empty>{EDITION_INFO.data_only}</Empty>
        ) : (
          <>
            <Lead lead={brief.lead} items={brief.items} />
            {brief.angle ? <AngleLine angle={brief.angle} index={index} /> : null}
          </>
        )}
      </Section>

      <Section id="regions" number={2} title="Regions">
        <div className="border-t border-dotted border-line">
          {brief.regions.rows.map((row) => <RegionRow key={row.code} row={row} itemsById={itemsById} />)}
          <GlobalRow itemCount={brief.regions.global.item_count} />
        </div>
      </Section>

      <GapPanel gap={brief.gap} metrics={metrics} gapOk={gapOk} annotations={annotations} editionDate={brief.date} />

      <Section id="top-stories" number={4} title="Top stories">
        {top.length ? top.map((item) => <ItemCard key={item.id} {...cardProps(item)} />) : <Empty><Counted text={EMPTY_LINES.no_items} /></Empty>}
      </Section>

      <Section id="also-today" number={5} title="Also today">
        {heads.length ? (
          heads.map((g) => (
            <div key={g.head} className="mb-5 last:mb-0">
              <h3 className="kicker mb-1 text-fg">{HEAD_INFO[g.head].label}</h3>
              <div className="border-t border-dotted border-line">
                {g.items.map((item) => <ItemRow key={item.id} {...cardProps(item)} />)}
              </div>
            </div>
          ))
        ) : (
          <Empty><Counted text={EMPTY_LINES.no_rows} /></Empty>
        )}
        {dataOnly ? <EpssMovers movers={brief.epss_movers} /> : null}
      </Section>

      <Section id="actors" number={6} title="Actors seen today">
        {dataOnly ? (
          <Empty><Counted text={EMPTY_LINES.not_data_only} /></Empty>
        ) : brief.actors_seen.length ? (
          <ActorChips actors={brief.actors_seen} itemsById={itemsById} />
        ) : (
          <Empty><Counted text={EMPTY_LINES.no_actors} /></Empty>
        )}
      </Section>

      <Section id="taiwan" number={7} title="Taiwan Lens">
        <TaiwanLens lens={brief.taiwan_lens} edition={brief.edition} editionDate={brief.date} index={index} itemsById={itemsById} />
      </Section>

      <Section id="scoreboard" number={8} title={brief.week_in_review ? "Thesis Scoreboard · Week in review" : "Thesis Scoreboard"}>
        <ScoreboardSection brief={brief} index={index} />
      </Section>

      <Section id="elsewhere" number={9} title="Elsewhere">
        {dataOnly ? (
          <Empty>{EMPTY_LINES.not_data_only}</Empty>
        ) : brief.elsewhere.length ? (
          <Elsewhere links={brief.elsewhere} sourcesById={sourcesById} />
        ) : (
          <Empty>{EMPTY_LINES.no_elsewhere}</Empty>
        )}
      </Section>

      {brief.corrections.length ? (
        <FootBlock id="corrections" label="Corrections">
          <CorrectionsList corrections={brief.corrections} held={heldItems} />
        </FootBlock>
      ) : null}

      {brief.sources.length ? (
        <div className="mt-9 border-t border-line pt-2">
          <details id="sources">
            <summary className="kicker flex min-h-[40px] cursor-pointer items-center">
              Sources ({fmtInt(brief.sources.length)}) · {plural(brief.computed.publisher_count, "publisher", "publishers")}
            </summary>
            <SourceList sources={brief.sources} withheld={new Set(withheldOnlySources(brief).keys())} />
          </details>
        </div>
      ) : (
        <FootBlock id="sources" label="Sources">
          <p className="text-[13px] text-muted">No sources.</p>
        </FootBlock>
      )}

      <p className="mt-10 font-display text-[19px] italic text-soft">{BRIEF_END}</p>

      <nav aria-label="Other editions" className="mt-6 flex flex-wrap justify-between gap-3 border-t border-rule pt-3 font-mono text-[12px] uppercase tracking-[0.08em]">
        {prevDate ? <Link href={`/brief/${prevDate}`} className="inline-flex min-h-[40px] items-center">← {longDate(prevDate)}</Link> : <span />}
        {nextDate ? <Link href={`/brief/${nextDate}`} className="inline-flex min-h-[40px] items-center">{longDate(nextDate)} →</Link> : null}
      </nav>
    </article>
  );
}
