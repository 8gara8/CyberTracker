// SPEC §7 "Brief components", ActorChips: one square tag per actor, linking its first item on this page; when the
// nexus isn't "unknown", "· <nexus label>, per <attributed_by>" from the first matching attribution (a
// qualifying one with that nexus, the actor's own name first), so a sponsor never shows without its attributor;
// cross_link adds a separate "<Europe | ME> ↗" link. That link's URL is the sibling's from run.json (SIBLINGS,
// as TabBar uses), the value publish stored in cross_link.url, so it is a site link with an aria-label.
import type { ActorSeen } from "@/lib/schema/brief";
import type { Attribution } from "@/lib/schema/common";
import type { Item } from "@/lib/schema/item";
import { qualifyingAttribution } from "@/lib/items";
import { SIBLINGS } from "@/lib/site";
import { ACTOR_NEXUS_INFO } from "@/lib/vocab";
import { PlainText } from "@/components/ui/PlainText";
import { itemAnchor } from "./brief-parts";

export interface ActorChipsProps {
  actors: ActorSeen[];
  /** The brief's items by id: each actor's first item and its attributions. */
  itemsById: Record<string, Item>;
}

const SIBLING_LABEL = { europe: "Europe", me: "ME" } as const;

/** The attribution the nexus line names: a qualifying entry with the actor's nexus, the actor's own name first. */
export function nexusAttribution(actor: ActorSeen, itemsById: Record<string, Item>): Attribution | null {
  if (actor.nexus === "unknown") return null;
  const entries = actor.item_ids.flatMap((id) => itemsById[id]?.attribution ?? [])
    .filter((a) => a.nexus === actor.nexus && qualifyingAttribution(a));
  const name = actor.name.toLowerCase();
  return entries.find((a) => a.actor_name_as_used.toLowerCase() === name) ?? entries[0] ?? null;
}

const TAG = "inline-flex min-h-[24px] items-center gap-1.5 border border-rule px-2 py-[3px] font-mono text-[12px] uppercase leading-none tracking-[0.08em] text-fg";

export function ActorChips({ actors, itemsById }: ActorChipsProps) {
  return (
    <ul className="flex flex-col gap-2">
      {actors.map((actor) => {
        const first = actor.item_ids.map((id) => itemsById[id]).find((x): x is Item => x !== undefined);
        const anchor = first ? itemAnchor(first.id) : undefined;
        const attribution = nexusAttribution(actor, itemsById);
        const sibling = actor.cross_link ? SIBLINGS[actor.cross_link.tracker] : null;
        const name = <PlainText text={actor.name} />;
        return (
          <li key={actor.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[14px] text-soft">
            {anchor ? <a href={`#${anchor}`} className={`${TAG} no-underline hover:underline`}>{name}</a> : <span className={TAG}>{name}</span>}
            {attribution ? (
              <span>
                · {ACTOR_NEXUS_INFO[actor.nexus]}, per <PlainText text={attribution.attributed_by} />
              </span>
            ) : null}
            {actor.cross_link && sibling ? (
              <a
                href={sibling}
                rel="noopener noreferrer"
                aria-label={`${SIBLING_LABEL[actor.cross_link.tracker]} tracker: ${actor.name}`}
                className="font-mono text-[12px] uppercase tracking-[0.08em]"
              >
                {SIBLING_LABEL[actor.cross_link.tracker]} ↗
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
