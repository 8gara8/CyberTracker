// SPEC §7 "Brief components", Lead: one paragraph with an ink drop cap. Each sentence is a counted <span> (a §4.12
// model field in the total), then a mono "↓" link to its first item on this page (aria-label "Read:
// <headline>"), or to #gap for a Gap sentence with no items. BriefView shows EDITION_INFO.data_only instead in
// a data-only edition.
import { Fragment } from "react";
import type { Brief } from "@/lib/schema/brief";
import type { Item } from "@/lib/schema/item";
import { indexBy } from "@/lib/site-data";
import { Counted } from "@/components/ui/Counted";
import { ReadLink } from "./brief-parts";

export interface LeadProps {
  lead: Brief["lead"];
  /** The brief's items, for each sentence's first-item link and its aria-label headline. */
  items: Item[];
}

/** The "↓" link to #gap, for a Gap sentence that names no item. */
function GapLink() {
  return (
    <a href="#gap" aria-label="Read: The Gap" title="The Gap" className="ml-0.5 font-mono text-[12px] text-fg no-underline hover:underline">↓</a>
  );
}

export function Lead({ lead, items }: LeadProps) {
  const byId = indexBy(items);
  return (
    <p className="prose-serif dropcap [text-wrap:pretty]">
      {lead.map((s, i) => {
        const first = s.item_ids.map((id) => byId[id]).find((x): x is Item => x !== undefined);
        return (
          <Fragment key={i}>
            {i ? " " : ""}
            <Counted text={s.text} />
            {first ? <ReadLink item={first} /> : s.gap && s.item_ids.length === 0 ? <GapLink /> : null}
          </Fragment>
        );
      })}
    </p>
  );
}
