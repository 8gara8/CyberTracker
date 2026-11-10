// The SPEC §4.10 masking, shared by a withhold and by the editions after it. A withhold binds later
// editions while its victim or attribution dispute is open or upheld (a spec gap, decided in the P3 build):
// bindingWithholds() lists those withholds from corrections.json, the context marks their items in
// recent_items, and applyDraft() and composeDataOnly() mask any item that re-reports one with
// maskWithheld(). An item re-reports a withheld item when it has the id of a withheld reference (an item
// keeps its id in every edition, so whatever the later copy cites), or when it cites a URL whose
// archive-index item_ids are all withheld references (a page an unwithheld item also cites, such as a
// vendor index, is not the withheld story's); a reference with a withheld item's id counts however old its
// brief, and the stored brief D counts when a full edition replaces it. rewriteItem(), markRegions() and
// dropActorItem() rewrite one brief in place. Pure, and imports no composer, so lib/apply.ts and
// lib/withhold.ts can both use it. Owner: lane L3.

import { longDate } from "./format";
import { orderItems } from "./items";
import { idProblem } from "./rules/ids";
import type { ActorSeen, Brief } from "./schema/brief";
import type { Source } from "./schema/common";
import type { DraftBrief } from "./schema/draft-brief";
import type { DraftItem, Item } from "./schema/item";
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

/** An item of a new edition that a composer withheld (ContentChanges.masked). */
export interface MaskedItem {
  item_id: string;
  correction_id: string;
  kind: WithholdKind;
  /**
   * "id": a withheld item's id (any later edition); "url": a cited URL only withheld items cited;
   * "carried": a same-day withheld item the draft left out, kept from the stored edition (carryWithheld()).
   */
  match: "id" | "url" | "carried";
  /**
   * "url": the re-report that took the withheld item's id (adoptWithheldIds()), by its id in the draft;
   * "carried": the draft item the kept item replaced (replaceReReports()), left out of the edition.
   */
  draft_id?: string;
}

/**
 * A stored brief as the withheld references read it: its date and the ids and `withheld` of its items. Publish
 * passes withheldBefore() (lib/run-inputs.ts), every stored brief before D with its withheld items only, so a
 * copy masked by URL under another id stays a withheld reference however old its brief (§0.4 row 128).
 */
export interface HeldBrief {
  date: string;
  items: readonly Pick<Item, "id" | "withheld">[];
}

/** Each name_removed correction with its dispute (intake's list first, then corrections.json's), or null. */
function withholdsOf(corrections: CorrectionsFile | null, disputes: readonly Dispute[] | null | undefined) {
  const stored = corrections?.disputes ?? [];
  return (corrections?.corrections ?? []).filter((c) => c.type === "name_removed").map((c) => {
    const id = c.dispute_id;
    const d = id === null ? null : disputes?.find((x) => x.id === id) ?? stored.find((x) => x.id === id) ?? null;
    const kind: WithholdKind = d && (d.kind === "victim" || d.kind === "attribution") ? d.kind : c.field === "attribution" ? "attribution" : "victim";
    const w: BindingWithhold = { item_id: c.item_id, edition_date: c.edition_date, kind, correction_id: c.id, since: c.date };
    return { w, binds: !d || d.status === "open" || d.status === "upheld" };
  });
}

/**
 * The binding withholds (see the file comment), in corrections.json order. `disputes` is the run's
 * updated list (intake's), whose statuses win; a dispute it lacks is looked up in corrections.json.
 */
export function bindingWithholds(corrections: CorrectionsFile | null, disputes?: readonly Dispute[] | null): BindingWithhold[] {
  return withholdsOf(corrections, disputes).filter((x) => x.binds).map((x) => x.w);
}

/**
 * The withholds that name edition `date` itself: every name_removed correction whose edition_date is the
 * date, whatever its dispute's status. A rejected dispute frees the editions after the one it named, never
 * that one: XREF_CORRECTION checks the brief a correction names, so a full edition replacing the
 * data-only one (or a forced rerun) must keep the item there, withheld (§4.10).
 */
export function withholdsOn(corrections: CorrectionsFile | null, date: string, disputes?: readonly Dispute[] | null): BindingWithhold[] {
  return withholdsOf(corrections, disputes).map((x) => x.w).filter((w) => w.edition_date === date);
}

/** "YYYY-MM-DD/<item id>", the archive index's item reference (§4.10). */
export const itemRef = (date: string, itemId: string): string => `${date}/${itemId}`;

/**
 * The item references the binding withholds cover: each withhold's own item on its edition date, and
 * every item of the given briefs whose `withheld` names a binding correction (a later brief the withhold
 * rewrote, or an item an earlier edition masked).
 */
export function withheldRefs(binding: readonly BindingWithhold[], briefs: readonly HeldBrief[]): Map<string, BindingWithhold[]> {
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
 * becomes WITHHELD_MARK, and so does the title of each source no item but withheld ones (this one among
 * them) cites, and nothing else in the brief (Elsewhere, the Angle, the Lens, the Week in review) cites.
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

  // A source that only withheld items cite is masked too: two withheld items sharing a page (two withholds on one
  // day, a re-report masked by URL beside the item kept or masked by id) must not leave its title for each other.
  const others = new Set(b.items.filter((x) => x.id !== it.id && !x.withheld).flatMap((x) => [
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
  /** withholdsOn() the edition's date: their own items are masked by id whatever the dispute's status. */
  sameDay?: readonly BindingWithhold[];
  /** As synced: before this edition's URLs are added. */
  archiveIndex: ArchiveIndex | null;
  /**
   * The stored briefs before the edition, and the stored brief of the edition's own date when a full edition
   * replaces it (their withheld items' references: a forced rerun must see the items its first publish masked).
   * Every stored brief, not only the last days: a copy masked under another id is a reference by its own id.
   */
  history: readonly HeldBrief[];
}

/**
 * Masks in place every item of `b` that re-reports a withheld item (see the file comment): rewriteItem(),
 * then the attribution chips (dropActorItem()) and the region reasons (markRegions()), once per binding
 * withhold it matches. Returns what it masked, in item order. Region levels are not recomputed, as a
 * withhold of an archived brief leaves them.
 */
export function maskWithheld(b: Brief, i: MaskInput): MaskedItem[] {
  if (i.binding.length === 0 && !i.sameDay?.length) return [];
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
  // A binding withhold's references by item id, so an archive reference to any copy of a withheld item counts,
  // however old the brief holding it (the history is only the last days).
  const heldIds = new Map([...byId].map(([id, ws]) => [id, [...ws]] as const));
  const heldRef = (ref: string): readonly BindingWithhold[] | undefined => refs.get(ref) ?? heldIds.get(ref.slice(11));
  for (const w of i.sameDay ?? []) {
    const list = byId.get(w.item_id) ?? [];
    if (!list.some((x) => x.correction_id === w.correction_id)) list.push(w);
    byId.set(w.item_id, list);
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
      if (cited.length === 0 || !cited.every((ref) => heldRef(ref))) continue;
      for (const ref of cited) {
        for (const w of heldRef(ref) ?? []) if (!hits.has(w.correction_id)) hits.set(w.correction_id, { w, match: "url" });
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

// ── The same-day withhold (§4.10) ────────────────────────────────────────────────────────────────
// A withhold made this morning names the stored brief D (the data-only edition, or the full one a forced
// run replaces). The full edition replaces that brief, so the item must stay in it, withheld, or the
// correction no longer resolves (XREF_UNRESOLVED). applyDraft() first lets a draft item that re-reports the
// item under another id take its id (adoptWithheldIds()), else keeps the stored, masked item
// (carryWithheld()); maskWithheld() then masks it by id.

/** The draft fields adoptWithheldIds() reads and renames in. */
export type AdoptDraft = Pick<DraftBrief, "items" | "lead" | "taiwan_lens" | "region_raises" | "sources">;

export interface AdoptInput {
  /** withholdsOn() the edition's date. */
  sameDay: readonly BindingWithhold[];
  binding: readonly BindingWithhold[];
  /** The stored brief D as synced, or null. */
  stored: Pick<Brief, "items"> | null;
  /** As synced: it holds the stored brief D's references. */
  archiveIndex: ArchiveIndex | null;
  /** As MaskInput.history. */
  history: readonly HeldBrief[];
  /** Item id → its earliest stored brief before D (an id an earlier edition used is never renamed). */
  firstSeen: ReadonlyMap<string, string>;
}

/** A draft item that took a same-day withheld item's id. */
export interface AdoptedId {
  item_id: string;
  draft_id: string;
  correction_id: string;
}

/** A new draft item left out because the kept same-day withheld item it re-reports takes its slot (replaceReReports()). */
export interface ReplacedItem {
  /** The same-day withheld item kept in the slot. */
  item_id: string;
  /** The draft item it replaces. */
  draft_id: string;
  correction_id: string;
}

/**
 * The re-report test adoptWithheldIds() and replaceReReports() share: a draft item re-reports the withheld
 * item `own` ("YYYY-MM-DD/<id>") when it cites a page whose archive-index references hold `own` and are all
 * withheld (as maskWithheld() reads them: a reference to any copy of a withheld item counts, by its id).
 * `ids` holds every withheld reference's item id (a draft item with one is masked by id, never renamed).
 */
function reReportTest(d: AdoptDraft, o: AdoptInput): { reReports: (it: DraftItem, own: string) => boolean; ids: ReadonlySet<string> } {
  const all = [...o.binding, ...o.sameDay.filter((w) => !o.binding.some((x) => x.correction_id === w.correction_id))];
  const refs = withheldRefs(all, o.history);
  const ids = new Set([...refs.keys()].map((ref) => ref.slice(11)));
  const urlOf = new Map(d.sources.map((s) => [s.id, normalizeUrl(s.url)] as const));
  const reReports = (it: DraftItem, own: string) => it.source_ids.some((sid) => {
    const cited = o.archiveIndex?.urls[urlOf.get(sid) ?? ""]?.item_ids ?? [];
    return cited.includes(own) && cited.every((ref) => refs.has(ref) || ids.has(ref.slice(11)));
  });
  return { reReports, ids };
}

/** Every item_ids list of the draft (the Lead, the Taiwan Lens and its rows and Japan block, the raises) names `to` for `from`, once. */
function renameIn(d: AdoptDraft, from: string, to: string): void {
  const swap = (ids: string[]) => [...new Set(ids.map((x) => (x === from ? to : x)))];
  for (const l of d.lead) l.item_ids = swap(l.item_ids);
  d.taiwan_lens.item_ids = swap(d.taiwan_lens.item_ids);
  for (const row of d.taiwan_lens.rows) row.item_ids = swap(row.item_ids);
  d.taiwan_lens.japan.item_ids = swap(d.taiwan_lens.japan.item_ids);
  for (const r of d.region_raises) r.item_ids = swap(r.item_ids);
}

/**
 * For each same-day withhold whose item the draft lacks by id, the first draft item that re-reports it by
 * URL (reReportTest()) takes the withheld item's id, in every item_ids list of the draft too, so the story
 * appears once and the correction resolves. Only a new item (no earlier edition holds its id) of the stored
 * item's kind whose fields fit that id (ID_FORMAT) is renamed. Changes the draft in place; returns the renames.
 */
export function adoptWithheldIds(d: AdoptDraft, o: AdoptInput): AdoptedId[] {
  const out: AdoptedId[] = [];
  if (o.sameDay.length === 0) return out;
  const { reReports } = reReportTest(d, o);
  const renamed = new Set<string>();
  for (const w of o.sameDay) {
    if (d.items.some((it) => it.id === w.item_id)) continue;
    const held = o.stored?.items.find((it) => it.id === w.item_id);
    if (!held) continue;
    const own = itemRef(w.edition_date, w.item_id);
    const y = d.items.find((it) => !renamed.has(it.id) && it.kind === held.kind && !o.firstSeen.has(it.id)
      && idProblem({ ...it, id: w.item_id }) === null && reReports(it, own));
    if (!y) continue;
    const from = y.id;
    y.id = w.item_id;
    renameIn(d, from, w.item_id);
    renamed.add(w.item_id);
    out.push({ item_id: w.item_id, draft_id: from, correction_id: w.correction_id });
  }
  return out;
}

/**
 * After adoptWithheldIds(): for each same-day withhold whose item the draft still lacks by id and brief D
 * holds, the first new draft item (no earlier edition holds its id, and it has no withheld reference's id)
 * that re-reports it by URL but could not take its id (another kind, or an id that does not fit) is left
 * out, and the stored item will take its slot (carryWithheld()), so the story shows once (§0.4 row 127).
 * The draft's item_ids lists name the kept item for it; the draft item itself stays for carryWithheld() to
 * replace (its slot and sources). Changes the draft in place; returns the replacements.
 */
export function replaceReReports(d: AdoptDraft, o: AdoptInput): ReplacedItem[] {
  const out: ReplacedItem[] = [];
  if (o.sameDay.length === 0) return out;
  const { reReports, ids } = reReportTest(d, o);
  const sameDayIds = new Set(o.sameDay.map((w) => w.item_id));
  for (const w of o.sameDay) {
    if (d.items.some((it) => it.id === w.item_id) || out.some((r) => r.item_id === w.item_id)) continue;
    if (!o.stored?.items.some((it) => it.id === w.item_id)) continue;
    const own = itemRef(w.edition_date, w.item_id);
    const y = d.items.find((it) => !out.some((r) => r.draft_id === it.id) && !sameDayIds.has(it.id) && !ids.has(it.id)
      && !o.firstSeen.has(it.id) && reReports(it, own));
    if (!y) continue;
    renameIn(d, y.id, w.item_id);
    out.push({ item_id: w.item_id, draft_id: y.id, correction_id: w.correction_id });
  }
  return out;
}

/**
 * For each same-day withhold whose item the frozen items still lack, the stored brief's copy (already
 * masked) is kept: in the slot of the draft item replaceReReports() named for it, which it replaces and
 * whose source ids it adds to its own, else after every frozen item (displayOrder() leaves a withheld
 * item's slot free). Its stored sources are this brief's own where the URL is the same, else appended under
 * the next ids with their frozen fields, and every source id the item names follows. `sources` grows in
 * place; returns the items and the ids kept. The region levels then count the kept item as the stored
 * edition did, and maskWithheld() masks it again by id in the new brief.
 */
export function carryWithheld(items: readonly Item[], sources: Source[], o: {
  sameDay: readonly BindingWithhold[];
  stored: Pick<Brief, "items" | "sources"> | null;
  replaced?: readonly Pick<ReplacedItem, "item_id" | "draft_id">[];
}): { items: Item[]; kept: string[] } {
  const out = [...items];
  const extra: Item[] = [];
  const kept: string[] = [];
  for (const w of o.sameDay) {
    if (out.some((it) => it.id === w.item_id) || extra.some((it) => it.id === w.item_id)) continue;
    const held = o.stored?.items.find((it) => it.id === w.item_id);
    if (!held || !o.stored) continue;
    const storedSources = o.stored.sources;
    const ids = new Map<string, string>();
    const idOf = (sid: string): string => {
      const known = ids.get(sid);
      if (known) return known;
      const src = storedSources.find((s) => s.id === sid);
      let id = sid;
      if (src) {
        const same = sources.find((s) => normalizeUrl(s.url) === normalizeUrl(src.url));
        id = same?.id ?? `s${sources.length + 1}`;
        if (!same) sources.push({ ...structuredClone(src), id });
      }
      ids.set(sid, id);
      return id;
    };
    const it = structuredClone(held);
    it.source_ids = it.source_ids.map(idOf);
    it.ai_evidence = it.ai_evidence.map((e) => ({ ...e, source_id: idOf(e.source_id) }));
    it.attribution = it.attribution.map((a) => ({ ...a, source_id: idOf(a.source_id) }));
    if (it.incident) it.incident.status_source_ids = it.incident.status_source_ids.map(idOf);
    it.flaw_evidence = it.flaw_evidence.map((f) => ({ ...f, source_id: idOf(f.source_id) }));
    if (it.exposure) it.exposure = { ...it.exposure, source_id: idOf(it.exposure.source_id) };
    kept.push(it.id);
    const r = o.replaced?.find((x) => x.item_id === w.item_id);
    const slot = r ? out.findIndex((x) => x.id === r.draft_id) : -1;
    if (slot < 0) {
      extra.push(it);
      continue;
    }
    // The re-report's pages are the story's too: the kept item cites them, so their titles are masked with it and
    // the archive index names it for them (a later item citing one is masked by URL).
    it.source_ids = [...new Set([...it.source_ids, ...out[slot]!.source_ids])];
    out[slot] = it;
  }
  if (kept.length === 0) return { items: out, kept };
  // After every item of the draft: a kept item's slot is free (lib/items.ts displayOrder()), so it never takes a
  // top story's slot from a draft item, which keeps the budgets the draft was validated with (§4.12).
  return { items: [...out, ...orderItems(extra)], kept };
}
