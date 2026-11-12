// Small helpers the pages share for turning content into lookups (SPEC §6 "Content loading"): the
// siblings' indexBy() and neighbours(), plus the item pages, an item's history, its corrections and the items
// a withhold binds.

import type { Content } from "./content";
import type { Source } from "./schema/common";
import type { Item } from "./schema/item";
import type { Correction } from "./schema/misc";
import { normalizeUrl } from "./urls";
import { bindingWithholds, withheldRefs } from "./withhold-mask";

/** id → record. */
export function indexBy<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  return Object.fromEntries(items.map((x) => [x.id, x]));
}

/** The editions before and after `date` among the loaded briefs (oldest first), or null at either end. */
export function neighbours(content: Pick<Content, "briefs">, date: string): { prev: string | null; next: string | null } {
  const dates = content.briefs.map((b) => b.date);
  const i = dates.indexOf(date);
  return { prev: i > 0 ? dates[i - 1]! : null, next: i >= 0 && i < dates.length - 1 ? dates[i + 1]! : null };
}

const pageIdsCache = new WeakMap<Content, Set<string>>();

/**
 * The ids that get an item page, `/items/<id>` (§6): an id in two or more loaded briefs, or one citing a
 * source whose normalised URL (normalizeUrl(), §4.1) is the `source_url` of a report entry in that brief's
 * `scoreboard.entries`. Cached per Content.
 */
export function itemPageIds(content: Content): Set<string> {
  const hit = pageIdsCache.get(content);
  if (hit) return hit;
  const editions = new Map<string, number>();
  const out = new Set<string>();
  for (const b of content.briefs) {
    const reportUrls = new Set(b.scoreboard.entries
      .filter((e) => e.origin === "report" && e.source_url !== null)
      .map((e) => normalizeUrl(e.source_url!)));
    const urlById = new Map(b.sources.map((s) => [s.id, normalizeUrl(s.url)]));
    for (const it of new Map(b.items.map((x) => [x.id, x])).values()) {
      editions.set(it.id, (editions.get(it.id) ?? 0) + 1);
      if (reportUrls.size && it.source_ids.some((sid) => reportUrls.has(urlById.get(sid) ?? ""))) out.add(it.id);
    }
  }
  for (const [id, n] of editions) if (n >= 2) out.add(id);
  pageIdsCache.set(content, out);
  return out;
}

/** One edition's copy of an item, with the sources it cites in that brief (in the brief's source order). */
export interface ItemEdition {
  date: string;
  edition: Content["briefs"][number]["edition"];
  item: Item;
  sources: Source[];
}

/** Every loaded edition holding item `id`, oldest first; [] when none does. */
export function itemHistory(content: Pick<Content, "briefs">, id: string): ItemEdition[] {
  const out: ItemEdition[] = [];
  for (const b of content.briefs) {
    const item = b.items.find((x) => x.id === id);
    if (!item) continue;
    const cited = new Set(item.source_ids);
    out.push({ date: b.date, edition: b.edition, item, sources: b.sources.filter((s) => cited.has(s.id)) });
  }
  return out;
}

const byDateThenId = (a: Correction, b: Correction) =>
  a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * The corrections to item `itemId` as shown in the `editionDate` edition, oldest first (date, then id): every
 * correction in corrections.json targeting that item in that edition, and, when that edition's copy of the
 * item is withheld, the correction its `withheld.correction_id` names, whatever item it targets (a withhold
 * made on an earlier edition binds later copies, a copy masked by URL under its own id among them, §4.10, so
 * their banner can say why).
 */
export function correctionsFor(content: Pick<Content, "briefs" | "corrections">, itemId: string, editionDate: string): Correction[] {
  const withheldBy = content.briefs.find((b) => b.date === editionDate)?.items.find((x) => x.id === itemId)?.withheld?.correction_id ?? null;
  // The named correction whatever its item_id: a copy masked by URL keeps its own id (§4.10).
  return content.corrections.corrections
    .filter((c) => c.id === withheldBy || (c.item_id === itemId && c.edition_date === editionDate))
    .sort(byDateThenId);
}

/**
 * The item ids a binding withhold covers (§4.10): each binding withhold's item (bindingWithholds() of
 * corrections.json, as the validator reads it) and every loaded copy whose `withheld` names one (a copy
 * masked by URL under another id). While an id is here the site prints its corrections other than
 * name_removed by type word and date only (heldCorrection()); once the dispute is rejected or withdrawn
 * and nothing binds, they print in full again, so a restoring `update` shows.
 *
 * It fails closed: a loaded copy whose `withheld` names no name_removed correction the site loaded (corrections.json
 * skipped, or that correction left out or missing) stays held, since the site cannot tell whether its withhold binds.
 */
export function heldItemIds(content: Pick<Content, "briefs" | "corrections">): Set<string> {
  const refs = withheldRefs(bindingWithholds(content.corrections), content.briefs);
  const held = new Set([...refs.keys()].map((ref) => ref.slice(11)));
  const known = new Set(content.corrections.corrections.filter((c) => c.type === "name_removed").map((c) => c.id));
  for (const b of content.briefs) for (const it of b.items) if (it.withheld && !known.has(it.withheld.correction_id)) held.add(it.id);
  return held;
}

/** True when a withhold binds the correction's item and it is not a name_removed line: only its type word and date show. */
export function heldCorrection(c: Pick<Correction, "type" | "item_id">, held: ReadonlySet<string>): boolean {
  return c.type !== "name_removed" && held.has(c.item_id);
}
