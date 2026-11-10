// Item helpers (SPEC §4.6): the display order, the Also-today heads, and the two S fields computed from
// an item alone (actor_nexus, public_exploit). Generic over the draft and published item shapes. Pure.

import type { Attribution } from "./schema/common";
import type { CveBlock, DraftItem } from "./schema/item";
import {
  FLAW_KINDS, HEADS, KIND_INFO, LANDMARK_RANK, LOW_CONFIDENCE_MARKERS, SEVERITY_INFO,
  type ActorNexus, type HeadId, type KindId, type Severity,
} from "./vocab";

/** items[0..2] are the top stories; the rest are Also-today rows (§4.6). */
export const TOP_STORY_COUNT = 3;

type Rankable = Pick<DraftItem, "kind" | "severity" | "landmark">;

/**
 * The severity rank that orders items (§4.12 "Display order"): SEVERITY_INFO rank (critical 4 to watch
 * 1); a severity-less landmark item LANDMARK_RANK (2, as Elevated); any other severity-less item 0.
 */
export function itemRank(item: Rankable): number {
  if (item.severity) return SEVERITY_INFO[item.severity].rank;
  return item.landmark ? LANDMARK_RANK : 0;
}

/** Higher severity rank first, then lower KIND_INFO rank (exploited flaws before breaches); 0 on a tie. */
export function compareItems(a: Rankable, b: Rankable): number {
  return itemRank(b) - itemRank(a) || KIND_INFO[a.kind].rank - KIND_INFO[b.kind].rank;
}

/** The Also-today head an item's kind sits under. */
export function itemHead(item: Pick<DraftItem, "kind">): HeadId {
  return KIND_INFO[item.kind].head;
}

/**
 * orderItems() (§4.6, §4.12): all items sorted by compareItems(), the agent's order breaking ties (a
 * stable sort); the first `top` (TOP_STORY_COUNT) are the top stories; the rest are grouped by head in
 * HEADS order, keeping that sorted order inside each head. A draft's `items` must equal this (ITEM_ORDER).
 */
export function orderItems<T extends Rankable>(items: readonly T[], top: number = TOP_STORY_COUNT): T[] {
  const sorted = items.map((item, i) => ({ item, i })).sort((a, b) => compareItems(a.item, b.item) || a.i - b.i).map((x) => x.item);
  const rows = sorted.slice(top);
  return [...sorted.slice(0, top), ...HEADS.flatMap((head) => rows.filter((item) => itemHead(item) === head))];
}

/** True for an item a withhold masked (§4.10): its `withheld` is set. A draft item never is. */
export function isWithheld(item: object | null | undefined): boolean {
  return !!item && "withheld" in item && (item as { withheld?: unknown }).withheld != null;
}

/**
 * The display order of a brief's items (§4.12 "Display order"): a withheld item keeps its slot, whatever
 * its rank (a withhold rewrites an archived item in place, a re-report masked by id or URL keeps the slot
 * its draft gave it, and a composer puts a kept same-day item after every item that is not withheld), and
 * the other items fill the other slots in orderItems() order, as many top stories as the first
 * TOP_STORY_COUNT slots leave them. With no withheld item (every draft) it is orderItems().
 */
export function displayOrder<T extends Rankable>(items: readonly T[]): T[] {
  const open = items.map((item, i) => ({ item, i })).filter((x) => !isWithheld(x.item));
  if (open.length === items.length) return orderItems(items);
  const ordered = orderItems(open.map((x) => x.item), open.filter((x) => x.i < TOP_STORY_COUNT).length);
  const out = [...items];
  open.forEach((x, k) => {
    out[x.i] = ordered[k]!;
  });
  return out;
}

/**
 * The first item out of display order (displayOrder()), for ITEM_ORDER's message: its index now, where
 * it belongs, and its id when it has one. Null when `items` is in display order.
 */
export function firstOutOfOrder<T extends Rankable & { id?: string }>(items: readonly T[]): { index: number; expected_index: number; id: string | null } | null {
  const ordered = displayOrder(items);
  for (let i = 0; i < items.length; i += 1) {
    if (ordered[i] !== items[i]) {
      return { index: i, expected_index: ordered.indexOf(items[i]!), id: items[i]!.id ?? null };
    }
  }
  return null;
}

/** The Also-today rows (items after the top stories) grouped by head in HEADS order; empty heads left out. */
export function rowsByHead<T extends Pick<DraftItem, "kind">>(items: readonly T[]): { head: HeadId; items: T[] }[] {
  const rows = items.slice(TOP_STORY_COUNT);
  return HEADS.map((head) => ({ head, items: rows.filter((item) => itemHead(item) === head) })).filter((g) => g.items.length > 0);
}

/** True for exploited_flaw, critical_flaw and patch_batch. */
export function isFlawKind(kind: KindId): boolean {
  return (FLAW_KINDS as readonly string[]).includes(kind);
}

/** True when a severity is set and its rank is at least `min`'s. */
export function severityAtLeast(severity: Severity | null, min: Severity): boolean {
  return severity !== null && SEVERITY_INFO[severity].rank >= SEVERITY_INFO[min].rank;
}

const LOW_CONFIDENCE_RES = LOW_CONFIDENCE_MARKERS.map(
  (m) => new RegExp(`(?<![\\p{L}\\p{N}])${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[ -]/g, "[\\s-]")}(?![\\p{L}\\p{N}])`, "iu"),
);

/** True when attribution confidence words hold a LOW_CONFIDENCE_MARKERS entry (case-insensitive, whole words; a hyphen and a space alike). */
export function hasLowConfidenceMarker(text: string | null): boolean {
  return text !== null && LOW_CONFIDENCE_RES.some((re) => re.test(text));
}

/**
 * An attribution entry counts toward actor_nexus (§4.6) when its confidence_level is high or moderate,
 * or unstated with basis government, and its confidence_text holds no LOW_CONFIDENCE_MARKERS entry.
 */
export function qualifyingAttribution(entry: Pick<Attribution, "confidence_level" | "basis" | "confidence_text">): boolean {
  const level = entry.confidence_level === "high" || entry.confidence_level === "moderate"
    || (entry.confidence_level === "unstated" && entry.basis === "government");
  return level && !hasLowConfidenceMarker(entry.confidence_text);
}

/**
 * actor_nexus (§4.6): null when `attribution` is []; else the nexus every qualifying entry agrees on;
 * else "unknown" (no qualifying entry, or they disagree). Never from actors.json, never inferred.
 */
export function actorNexusOf(attribution: readonly Pick<Attribution, "confidence_level" | "basis" | "confidence_text" | "nexus">[]): ActorNexus | null {
  if (attribution.length === 0) return null;
  const nexuses = new Set(attribution.filter(qualifyingAttribution).map((a) => a.nexus));
  return nexuses.size === 1 ? [...nexuses][0]! : "unknown";
}

/**
 * public_exploit (§4.6): flaw kinds only; "yes" when exploit_reported_in_sources is true or any CVE block
 * has exploit_reference true, else "no"; null for every other kind.
 */
export function publicExploitOf(item: Pick<DraftItem, "kind" | "exploit_reported_in_sources"> & { cves: readonly Pick<CveBlock, "exploit_reference">[] }): "yes" | "no" | null {
  if (!isFlawKind(item.kind)) return null;
  return item.exploit_reported_in_sources === true || item.cves.some((c) => c.exploit_reference) ? "yes" : "no";
}
