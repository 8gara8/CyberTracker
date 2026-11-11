// STUB (SPEC §7 "Brief components", ItemRow). Owner: items lane. A closed <details id={item.id}>; summary (44px
// min) the kicker and headline (h3); open, the card parts with ItemDetails inline (no nested <details>).
import type { ItemCardProps } from "./ItemCard";

export type ItemRowProps = ItemCardProps;

export function ItemRow({ item }: ItemRowProps) {
  return <details id={item.id}><summary>{item.headline}</summary></details>;
}
