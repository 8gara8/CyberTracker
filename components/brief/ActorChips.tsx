// STUB (SPEC §7 "Brief components", ActorChips). Owner: brief lane. Square tags linking each actor's first
// item; "· <nexus label>, per <attributed_by>" from the first matching attribution when nexus isn't unknown;
// cross_link adds a separate "<Europe | ME> ↗" link (aria-label).
import type { ActorSeen } from "@/lib/schema/brief";
import type { Item } from "@/lib/schema/item";

export interface ActorChipsProps {
  actors: ActorSeen[];
  /** The brief's items by id: each actor's first item and its attributions. */
  itemsById: Record<string, Item>;
}

export function ActorChips({ actors }: ActorChipsProps) {
  return <ul>{actors.map((a) => <li key={a.name}>{a.name}</li>)}</ul>;
}
