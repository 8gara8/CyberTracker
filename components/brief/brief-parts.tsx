// Small pieces the brief components share (SPEC §7 "Brief components"; owner: brief lane). Ids in `id` and `#`
// hrefs are only item and source ids that match their §4.3 patterns (§7 "Untrusted text" item 2); content goes
// through PlainText or Counted; templates are filled with a function, so a `$` in content stays as written.
import Link from "next/link";
import type { ReactNode } from "react";
import { ID_PATTERNS, ITEM_ID_MAX } from "@/lib/schema/common";
import type { Item } from "@/lib/schema/item";
import { PlainText } from "@/components/ui/PlainText";

/** The item id when it is a valid item id (usable in `id` and `#` hrefs), else undefined. */
export function itemAnchor(id: string): string | undefined {
  return id.length <= ITEM_ID_MAX && ID_PATTERNS.item.test(id) ? id : undefined;
}

/** A config id (a region rule's id) when it matches its pattern, for /methodology#rule-<id>; else undefined. */
export function configAnchor(id: string): string | undefined {
  return ID_PATTERNS.config.test(id) ? id : undefined;
}

/** A vocabulary id as the page's words show it: "no_reading" → "NO READING". */
export function upperWord(id: string): string {
  return id.replace(/_/g, " ").toUpperCase();
}

/** Fills `{name}` placeholders in a fixed template (lib/vocab.ts) with text; unknown names stay as written. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (whole, name: string) => (name in values ? values[name]! : whole));
}

/** The siblings' Aside: a mono label with an arrow ("Why it matters →", "Angle →"), then the text. */
export function Aside({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`grid grid-cols-[auto_1fr] items-baseline gap-2.5 ${className ?? ""}`}>
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg">{label} →</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A mono "↓" link to an item on this page, named by its headline (§7 Lead, Accessibility). */
export function ReadLink({ item }: { item: Pick<Item, "id" | "headline"> }) {
  const id = itemAnchor(item.id);
  if (!id) return null;
  return (
    <a href={`#${id}`} aria-label={`Read: ${item.headline}`} title={item.headline} className="ml-0.5 font-mono text-[12px] text-fg no-underline hover:underline">↓</a>
  );
}

/** "↓" links to the items of `ids` that are in this brief, in order, once each. */
export function ItemLinks({ ids, itemsById }: { ids: readonly string[]; itemsById: Record<string, Item> }) {
  const items = [...new Set(ids)].map((id) => itemsById[id]).filter((x): x is Item => x !== undefined);
  if (!items.length) return null;
  return <span className="whitespace-nowrap">{items.map((it) => <ReadLink key={it.id} item={it} />)}</span>;
}

/** Item id → the newest earlier loaded edition holding it and that copy's stored headline (BriefViewProps.earlierItems). */
export type EarlierItems = Record<string, { date: string; headline: string }>;

/**
 * An item's headline as a link to its card or row on this page, or, for an item of an earlier edition, to its
 * card there (/brief/<date>#<id>); an item no loaded brief holds is its id in mono.
 */
export function ItemRef({ id, itemsById, earlierItems }: { id: string; itemsById: Record<string, Item>; earlierItems?: EarlierItems }) {
  const item = itemsById[id];
  const anchor = itemAnchor(id);
  if (item && anchor) return <a href={`#${anchor}`}><PlainText text={item.headline} /></a>;
  const earlier = earlierItems?.[id];
  if (earlier && anchor) return <Link href={`/brief/${earlier.date}#${anchor}`}><PlainText text={earlier.headline} /></Link>;
  return <span className="font-mono text-[12px]"><PlainText text={id} /></span>;
}

/** A foot block (§7 "BriefView and section order"): a plain rule and a mono label, no §NN. */
export function FootBlock({ id, label, children }: { id?: string; label: string; children: ReactNode }) {
  return (
    <section id={id} className="mt-9 border-t border-line pt-2">
      <h2 className="kicker mb-3">{label}</h2>
      {children}
    </section>
  );
}
