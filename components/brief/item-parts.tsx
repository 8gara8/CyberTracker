// The parts ItemCard and ItemRow share (SPEC §7 "Brief components"; owner: brief lane): the kicker, the
// "Impact:" line, the summary, "Why it matters", the script line, the chips, the Anthropic line and the links.
// `counted` is false for a withheld item (§4.10): its card is the composer's placeholder and counts no words
// (§0.4 row 126), so nothing in it carries `data-words`.
import Link from "next/link";
import { Fragment } from "react";
import type { Edition } from "@/lib/schema/common";
import type { Item } from "@/lib/schema/item";
import { cardKickerParts, cveTimeline, releaseLine } from "@/lib/page-text";
import { issueFormUrl } from "@/lib/site";
import { ANTHROPIC_LINE, NOT_VENDOR_CONFIRMED, PUBLIC_EXPLOIT_LABEL, SELF_REPORTED_CHIP } from "@/lib/vocab";
import { AIChip } from "@/components/ui/AIChip";
import { COUNTED, Counted } from "@/components/ui/Counted";
import { PlainText } from "@/components/ui/PlainText";
import { SeverityPips, levelWords } from "@/components/ui/SeverityPips";
import { Tag } from "@/components/ui/Tag";
import { Aside, itemAnchor } from "./brief-parts";
import { SourceRefs, type SourceIndex } from "./sources";

/** A counted string, or the same text plain when the card counts no words (a withheld item). */
export function Text({ text, counted }: { text: string; counted: boolean }) {
  return counted ? <Counted text={text} /> : <PlainText text={text} />;
}

/**
 * The kicker row (§7 ItemCard, Appendix A.3): the level chip, the AI chip, the region codes and the vendor as
 * text ("QNAP (TW)", never a flag). Its text is cardKicker(item) exactly and carries `data-words`; the level's
 * hidden words sit just after it, outside the counted string. A withheld item never assessed (a data-only item
 * a full edition keeps) shows neither its level nor its AI chip, since "UNRATED" and "AI: unassessed" mean a
 * data-only edition (as the chat, §8.8); its kicker is the region codes and the vendor.
 */
export function Kicker({ item, edition, counted }: { item: Item; edition: Edition; counted: boolean }) {
  const parts = cardKickerParts(item);
  const unread = Boolean(item.withheld) && item.ai_role === "unassessed" && edition !== "data_only";
  const hidden = unread ? null : levelWords("severity", item.severity);
  const chunks = [
    unread ? null : <SeverityPips key="level" scale="severity" level={item.severity} landmark={item.landmark} kind={item.kind} words={false} />,
    parts.ai.length > 0 && !unread ? <AIChip key="ai" role={item.ai_role} confidence={item.ai_confidence} claimant={item.ai_claimant} /> : null,
    ...parts.regions.map((r) => <Fragment key={`region-${r}`}>{r}</Fragment>),
    parts.vendor ? <PlainText key="vendor" text={parts.vendor} /> : null,
  ].filter((c) => c !== null);
  return (
    <span className="block font-mono text-[13px] uppercase leading-[1.9] tracking-[0.04em] text-soft tabular-nums">
      <span {...(counted ? COUNTED : {})}>
        {chunks.map((c, i) => <Fragment key={i}>{i ? " · " : null}{c}</Fragment>)}
      </span>
      {hidden ? <span className="sr-only"> {hidden}</span> : null}
    </span>
  );
}

/** The card's script line: releaseLine() for a patch batch, else the first CVE block's cveTimeline(), else null. */
export function scriptLine(item: Item, editionDate: string): string | null {
  if (item.release) return releaseLine(item.release, editionDate);
  const cve = item.cves[0];
  return cve ? cveTimeline(cve, editionDate) : null;
}

export interface CardBodyProps {
  item: Item;
  editionDate: string;
  index: SourceIndex;
  counted: boolean;
}

/** "Impact: <incident.impact>": incident cards lead with it (§7 ItemCard). */
export function ImpactLine({ item, counted }: Pick<CardBodyProps, "item" | "counted">) {
  if (!item.incident) return null;
  return (
    <p className="mt-1.5 text-[14px] text-fg">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">Impact: </span>
      <Text text={item.incident.impact} counted={counted} />
    </p>
  );
}

/** The summary with its source refs, "Why it matters", the script line, the chips and the Anthropic line. */
export function CardBody({ item, editionDate, index, counted }: CardBodyProps) {
  const line = scriptLine(item, editionDate);
  const first = item.cves[0];
  const chips = [
    item.claim_type === "self_reported" ? SELF_REPORTED_CHIP : null,
    item.kind === "critical_flaw" && first && !first.vendor_confirmed ? NOT_VENDOR_CONFIRMED : null,
    item.public_exploit ? PUBLIC_EXPLOIT_LABEL[item.public_exploit] : null,
  ].filter((c): c is string => c !== null);
  return (
    <>
      <p className="prose-serif mt-2 [text-wrap:pretty]">
        <Text text={item.summary} counted={counted} /> <SourceRefs ids={item.source_ids} index={index} />
      </p>
      {item.why_it_matters ? (
        <Aside label="Why it matters" className="mt-2">
          <p className="prose-serif text-soft"><Text text={item.why_it_matters} counted={counted} /></p>
        </Aside>
      ) : null}
      {line ? (
        <p className="mt-2 font-mono text-[13px] leading-[1.6] text-soft tabular-nums [overflow-wrap:anywhere]">
          {counted ? <span {...COUNTED}>{line}</span> : line}
        </p>
      ) : null}
      {chips.length ? <p className="mt-2 flex flex-wrap gap-1.5">{chips.map((c) => <Tag key={c}>{c}</Tag>)}</p> : null}
      {item.anthropic_disclosure ? <p className="mt-2 text-[13px] italic text-muted">{ANTHROPIC_LINE}</p> : null}
    </>
  );
}

/** "Timeline →" (when the item has a page) and "Report an error": the links after "sources" and "details". */
export function CardLinks({ item, editionDate, hasPage }: { item: Item; editionDate: string; hasPage: boolean }) {
  const id = itemAnchor(item.id);
  return (
    <>
      {hasPage && id ? <><span aria-hidden="true">·</span><Link href={`/items/${id}`}>Timeline →</Link></> : null}
      <span aria-hidden="true">·</span>
      {/* The repo's own issue form, built by issueFormUrl() from run.json and the item id: a site link, not a
          content URL, so it is not passed through safeHref() (which blocks github.com paths outside tier1_paths). */}
      <a href={issueFormUrl({ id: item.id, date: editionDate })} rel="noopener noreferrer">Report an error</a>
    </>
  );
}

/** The footer row's classes: mono 11px, the links at least 24px tall (§7 Accessibility). */
export const FOOTER_ROW = "mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[11px] uppercase leading-[24px] tracking-[0.1em] text-muted";
