// The SPEC §4.10 masking, shared by a withhold and by the editions after it. A withhold binds later
// editions while its victim or attribution dispute is open or upheld (a spec gap, decided in the P3 build):
// bindingWithholds() lists those withholds from corrections.json, the context marks their items in
// recent_items, and applyDraft() and composeDataOnly() mask any item that re-reports one with
// maskWithheld(). An item re-reports a withheld item when it has the id of a withheld reference (an item
// keeps its id in every edition, so whatever the later copy cites), or when it cites a URL whose
// archive-index item_ids are all withheld references (a page an unwithheld item also cites, such as a
// vendor index, is not the withheld story's). rewriteItem(), markRegions() and
// dropActorItem() rewrite one brief in place. Pure, and imports no composer, so lib/apply.ts and
// lib/withhold.ts can both use it. Owner: lane L3.

import { longDate } from "./format";
import type { ActorSeen, Brief } from "./schema/brief";
import type { Item } from "./schema/item";
import type { ArchiveIndex, CorrectionsFile, Dispute } from "./schema/misc";
import { normalizeUrl } from "./urls";
import { WITHHELD_HEADLINE, WITHHELD_MARK, WITHHELD_TEXT } from "./vocab";

/** The dispute kinds that withhold an item at once (§4.10). */
export type WithholdKind = "victim" | "attribution";

/**
 * A withhold that binds later editions: a name_removed correction whose dispute is open or upheld. A
 * correction whose dispute is missing binds too (the safe side); its kind then comes from the field.
 */
export interface BindingWithhold {
  item_id: string;
  /** The archived brief the correction names. */
  edition_date: string;
  kind: WithholdKind;
  correction_id: string;
  /** The correction's date: the day the item was first withheld (WITHHELD_TEXT's date). */
  since: string;
}

/** An item of a new edition that applyDraft() masked under a binding withhold (ContentChanges.masked). */
export interface MaskedItem {
  item_id: string;
  correction_id: string;
  kind: WithholdKind;
  /** "id": a withheld item's id (any later edition); "url": a cited URL only withheld items cited. */
  match: "id" | "url";
}

/**
 * The binding withholds (see the file comment), in corrections.json order. `disputes` is the run's
 * updated list (intake's), whose statuses win; a dispute it lacks is looked up in corrections.json.
 */
export function bindingWithholds(corrections: CorrectionsFile | null, disputes?: readonly Dispute[] | null): BindingWithhold[] {
  const stored = corrections?.disputes ?? [];
  const out: BindingWithhold[] = [];
  for (const c of corrections?.corrections ?? []) {
    if (c.type !== "name_removed") continue;
    const id = c.dispute_id;
    const d = id === null ? null : disputes?.find((x) => x.id === id) ?? stored.find((x) => x.id === id) ?? null;
    if (d && d.status !== "open" && d.status !== "upheld") continue;
    const kind: WithholdKind = d && (d.kind === "victim" || d.kind === "attribution") ? d.kind : c.field === "attribution" ? "attribution" : "victim";
    out.push({ item_id: c.item_id, edition_date: c.edition_date, kind, correction_id: c.id, since: c.date });
  }
  return out;
}

/** "YYYY-MM-DD/<item id>", the archive index's item reference (§4.10). */
export const itemRef = (date: string, itemId: string): string => `${date}/${itemId}`;

/**
 * The item references the binding withholds cover: each withhold's own item on its edition date, and
 * every item of the given briefs whose `withheld` names a binding correction (a later brief the withhold
 * rewrote, or an item an earlier edition masked).
 */
export function withheldRefs(binding: readonly BindingWithhold[], briefs: readonly Pick<Brief, "date" | "items">[]): Map<string, BindingWithhold[]> {
  const out = new Map<string, BindingWithhold[]>();
  const add = (ref: string, w: BindingWithhold) => {
    const list = out.get(ref) ?? [];
    if (!list.includes(w)) list.push(w);
    out.set(ref, list);
  };
  const byCorrection = new Map(binding.map((w) => [w.correction_id, w] as const));
  for (const w of binding) add(itemRef(w.edition_date, w.item_id), w);
  for (const b of briefs) {
    for (const it of b.items) {
      const w = it.withheld ? byCorrection.get(it.withheld.correction_id) : undefined;
      if (w) add(itemRef(b.date, it.id), w);
    }
  }
  return out;
}

/**
 * The item's own rewrite (§4.10): headline WITHHELD_HEADLINE, summary WITHHELD_TEXT, why_it_matters null,
 * and incident.victim null (victim) or attribution [] and actor_nexus null (attribution); `withheld` set
 * unless an earlier withhold set it. Then every Lead sentence and Taiwan Lens text that lists the item
 * becomes WITHHELD_MARK, and so does the title of each source only this item cites.
 */
export function rewriteItem(b: Brief, it: Item, w: { kind: WithholdKind; since: string }, correction: string): void {
  it.headline = WITHHELD_HEADLINE;
  it.summary = WITHHELD_TEXT.replace("{date}", longDate(w.since));
  it.why_it_matters = null;
  if (w.kind === "victim") {
    if (it.incident) it.incident.victim = null;
  } else {
    it.attribution = [];
    it.actor_nexus = null;
  }
  it.withheld ??= { correction_id: correction, since: w.since };

  for (const l of b.lead) if (l.item_ids.includes(it.id)) l.text = WITHHELD_MARK;
  const lens = b.taiwan_lens;
  if (lens.item_ids.includes(it.id)) lens.analysis = WITHHELD_MARK;
  for (const row of lens.rows) if (row.item_ids.includes(it.id)) row.text = WITHHELD_MARK;
  if (lens.japan.item_ids.includes(it.id)) lens.japan.text = WITHHELD_MARK;

  const others = new Set(b.items.filter((x) => x.id !== it.id).flatMap((x) => [
    ...x.source_ids, ...x.flaw_evidence.map((f) => f.source_id), ...(x.incident?.status_source_ids ?? []),
  ]));
  const elsewhere = new Set([
    ...b.elsewhere.map((e) => e.source_id), ...(b.angle?.source_id ? [b.angle.source_id] : []), ...(b.angle?.counterpoint_source_ids ?? []),
    ...(b.week_in_review?.strongest_against.source_ids ?? []), ...lens.source_ids, ...lens.rows.flatMap((row) => row.source_ids), ...lens.japan.source_ids,
  ]);
  for (const s of b.sources) {
    if (!it.source_ids.includes(s.id) || others.has(s.id) || elsewhere.has(s.id)) continue;
    s.title = WITHHELD_MARK;
    if (s.title_en !== null) s.title_en = WITHHELD_MARK;
  }
}

/** Region row and raise reasons that list the item become WITHHELD_MARK (a reason embeds its headline, §5.11). */
export function markRegions(b: Brief, itemId: string): boolean {
  let changed = false;
  for (const row of b.regions.rows) {
    if (row.item_ids.includes(itemId) && row.reason !== WITHHELD_MARK) {
      row.reason = WITHHELD_MARK;
      changed = true;
    }
    if (row.raised?.item_ids.includes(itemId) && row.raised.reason !== WITHHELD_MARK) {
      row.raised.reason = WITHHELD_MARK;
      changed = true;
    }
  }
  return changed;
}

/** actors_seen after an attribution withhold: the item leaves its chips, empty chips go, nexus re-agreed. */
export function dropActorItem(actors: readonly ActorSeen[], items: readonly Item[], itemId: string): ActorSeen[] {
  return actors.flatMap((a) => {
    if (!a.item_ids.includes(itemId)) return [a];
    const ids = a.item_ids.filter((x) => x !== itemId);
    if (ids.length === 0) return [];
    const nexuses = new Set(ids.map((x) => items.find((it) => it.id === x)?.actor_nexus ?? "unknown"));
    return [{ ...a, item_ids: ids, nexus: nexuses.size === 1 ? [...nexuses][0]! : "unknown" }];
  });
}

export interface MaskInput {
  binding: readonly BindingWithhold[];
  /** As synced: before this edition's URLs are added. */
  archiveIndex: ArchiveIndex | null;
  /** The stored briefs before the edition (their withheld items' references). */
  history: readonly Pick<Brief, "date" | "items">[];
}

/**
 * Masks in place every item of `b` that re-reports a withheld item (see the file comment): rewriteItem(),
 * then the attribution chips (dropActorItem()) and the region reasons (markRegions()), once per binding
 * withhold it matches. Returns what it masked, in item order. Region levels are not recomputed, as a
 * withhold of an archived brief leaves them.
 */
export function maskWithheld(b: Brief, i: MaskInput): MaskedItem[] {
  if (i.binding.length === 0) return [];
  const refs = withheldRefs(i.binding, i.history);
  // An item keeps its id in every edition it appears in (§0.4 row 100): the id of a withheld reference
  // dated on or before this edition is the withheld item, whatever the later copy cites.
  const byId = new Map<string, BindingWithhold[]>();
  for (const [ref, ws] of refs) {
    if (ref.slice(0, 10) > b.date) continue;
    const list = byId.get(ref.slice(11)) ?? [];
    for (const w of ws) if (!list.includes(w)) list.push(w);
    byId.set(ref.slice(11), list);
  }
  const urlOf = new Map(b.sources.map((s) => [s.id, normalizeUrl(s.url)] as const));
  const out: MaskedItem[] = [];
  for (const it of b.items) {
    const hits = new Map<string, { w: BindingWithhold; match: MaskedItem["match"] }>();
    for (const w of byId.get(it.id) ?? []) if (!hits.has(w.correction_id)) hits.set(w.correction_id, { w, match: "id" });
    for (const sid of it.source_ids) {
      const url = urlOf.get(sid);
      // A page every stored citer of which is withheld is the story's own; one an unwithheld item also
      // cites (a vendor index, a CVE record two stories share) says nothing about this item.
      const cited = (url && i.archiveIndex?.urls[url]?.item_ids) || [];
      if (cited.length === 0 || !cited.every((ref) => refs.has(ref))) continue;
      for (const ref of cited) {
        for (const w of refs.get(ref) ?? []) if (!hits.has(w.correction_id)) hits.set(w.correction_id, { w, match: "url" });
      }
    }
    for (const { w, match } of hits.values()) {
      rewriteItem(b, it, w, w.correction_id);
      if (w.kind === "attribution") b.actors_seen = dropActorItem(b.actors_seen, b.items, it.id);
      markRegions(b, it.id);
      out.push({ item_id: it.id, correction_id: w.correction_id, kind: w.kind, match });
    }
  }
  return out;
}
