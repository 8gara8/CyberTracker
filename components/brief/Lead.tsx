// STUB (SPEC §7 "Brief components", Lead). Owner: brief lane. One paragraph, ink drop cap; each sentence a
// <span> (counted) plus a mono "↓" link to its first item (aria-label "Read: <headline>"), or #gap for
// gap: true with no items. BriefView shows EDITION_INFO.data_only instead in a data-only edition.
import type { Brief } from "@/lib/schema/brief";
import type { Item } from "@/lib/schema/item";

export interface LeadProps {
  lead: Brief["lead"];
  /** The brief's items, for each sentence's first-item link and its aria-label headline. */
  items: Item[];
}

export function Lead({ lead }: LeadProps) {
  return <p className="prose-serif">{lead.length}</p>;
}
