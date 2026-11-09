// Shared definitions for the rules (SPEC §4.12 "Shared definitions"): the field walkers (prose, quoted,
// titles, source ids, item ids, every string), derive() for both modes, the publishers of an item with
// syndicated copies folded, seen text, known names, and the edition helpers. Pure: the config and the
// inputs come in through RuleInput. Generic over the draft and published shapes; where they differ (a
// Brief keeps the draft's raises as `regions.rows[].raised` and its Scoreboard entries as
// `scoreboard.entries`) the walkers read the right one and give its own path.

import type { LoadedConfig } from "../config";
import { orderItems } from "../items";
import type { Brief } from "../schema/brief";
import type { Tier } from "../schema/common";
import type { Finder } from "../schema/config";
import { publisherFor } from "../sources";
import { jaccard } from "../text";
import { normalizeUrl } from "../urls";
import type { Edition } from "../vocab";
import type {
  AnyBrief, AnyItem, AnySource, Derived, ItemPublishers, PublisherGroup, PublisherView, RuleInput, RuleMode,
} from "./types";

export { isMonday } from "../dates";

// ── Shapes and editions ──────────────────────────────────────────────────────────────────────────

/** True for a published Brief (it has the S fields a draft never has). */
export function isBrief(b: AnyBrief): b is Brief {
  return typeof b === "object" && b !== null && "edition" in b && "computed" in b;
}

/** What kind of brief the rules are judging: "draft" in draft mode, else the brief's `edition`. */
export type EditionKind = "draft" | Edition;

export function editionKind(input: Pick<RuleInput, "draft" | "mode">): EditionKind {
  if (input.mode === "draft" || !isBrief(input.draft)) return "draft";
  return input.draft.edition;
}

/** A data-only edition (§4.5): composed by lib/data-only.ts; only † rules run on it. */
export function isDataOnly(input: Pick<RuleInput, "draft" | "mode">): boolean {
  return editionKind(input) === "data_only";
}

/** A full or partial edition, or a draft (which becomes one): the editorial rules apply (TOP3_WHY, AI_UNASSESSED). */
export function isFullOrPartial(input: Pick<RuleInput, "draft" | "mode">): boolean {
  return !isDataOnly(input);
}

// ── Field walkers ────────────────────────────────────────────────────────────────────────────────

/** One text field: its path (formatPath() form), the field's name with indices dropped, and its item. */
export interface FieldText {
  /** `items[2].summary`, `lead[0].text`, `regions.rows[1].raised.reason`. */
  path: string;
  /** The path with every index written `[]`: `items[].summary`, `lead[].text`. */
  field: string;
  text: string;
  /** The index in `items` for an item field, else null. */
  item: number | null;
}

const fieldOf = (path: string) => path.replace(/\[\d+\]/g, "[]");

function pushText(out: FieldText[], path: string, text: unknown, item: number | null = null): void {
  if (typeof text === "string") out.push({ path, field: fieldOf(path), text, item });
}

/** A region raise as the rules read it: the draft's `region_raises[i]`, or a Brief's `regions.rows[i].raised`. */
export interface RaiseView {
  path: string;
  region: string;
  reason: string;
  trigger_class: string;
  item_ids: string[];
}

export function raisesOf(b: AnyBrief): RaiseView[] {
  if (isBrief(b)) {
    const rows = b.regions?.rows ?? [];
    return rows.flatMap((r, i) => (r.raised ? [{
      path: `regions.rows[${i}].raised`, region: r.code, reason: r.raised.reason, trigger_class: r.raised.trigger_class, item_ids: r.raised.item_ids,
    }] : []));
  }
  return (b.region_raises ?? []).map((r, i) => ({
    path: `region_raises[${i}]`, region: r.region, reason: r.reason, trigger_class: r.trigger_class, item_ids: r.item_ids,
  }));
}

/** A Scoreboard entry as the rules read it: the draft's `scoreboard_entries[i]`, or a Brief's `scoreboard.entries[i]`. */
export interface EntryView {
  path: string;
  claim_id: string;
  summary: string;
  quote: string | null;
  /** Draft entries cite a source id; a Brief's entries carry `source_url` instead. */
  quote_source_id: string | null;
  source_url: string | null;
  claim_type: string | null;
}

export function entriesOf(b: AnyBrief): EntryView[] {
  if (isBrief(b)) {
    return (b.scoreboard?.entries ?? []).map((e, i) => ({
      path: `scoreboard.entries[${i}]`, claim_id: e.claim_id, summary: e.summary, quote: e.quote, quote_source_id: null,
      source_url: e.source_url, claim_type: e.claim_type,
    }));
  }
  return (b.scoreboard_entries ?? []).map((e, i) => ({
    path: `scoreboard_entries[${i}]`, claim_id: e.claim_id, summary: e.summary, quote: e.quote, quote_source_id: e.quote_source_id,
    source_url: null, claim_type: e.claim_type,
  }));
}

/**
 * Prose fields (§4.12): `lead[].text`, `angle.text`, `angle.counterpoint`; each item's `headline`,
 * `summary`, `why_it_matters`, `exposure.text`, `incident.impact`, `incident.description`; the raises'
 * `reason`; `taiwan_lens.analysis`, `.rows[].text`, `.japan.text`; `week_in_review.text`,
 * `.strongest_against.text`; the Scoreboard entries' `summary`; `corrections[].reason`, `.after`. Null
 * fields are left out.
 */
export function proseFields(b: AnyBrief): FieldText[] {
  const out: FieldText[] = [];
  (b.lead ?? []).forEach((s, i) => pushText(out, `lead[${i}].text`, s?.text));
  if (b.angle) {
    pushText(out, "angle.text", b.angle.text);
    pushText(out, "angle.counterpoint", b.angle.counterpoint);
  }
  (b.items ?? []).forEach((it, i) => {
    if (!it) return;
    const p = `items[${i}]`;
    pushText(out, `${p}.headline`, it.headline, i);
    pushText(out, `${p}.summary`, it.summary, i);
    pushText(out, `${p}.why_it_matters`, it.why_it_matters, i);
    pushText(out, `${p}.exposure.text`, it.exposure?.text, i);
    pushText(out, `${p}.incident.impact`, it.incident?.impact, i);
    pushText(out, `${p}.incident.description`, it.incident?.description, i);
  });
  for (const r of raisesOf(b)) pushText(out, `${r.path}.reason`, r.reason);
  const lens = b.taiwan_lens;
  if (lens) {
    pushText(out, "taiwan_lens.analysis", lens.analysis);
    (lens.rows ?? []).forEach((r, i) => pushText(out, `taiwan_lens.rows[${i}].text`, r?.text));
    pushText(out, "taiwan_lens.japan.text", lens.japan?.text);
  }
  if (b.week_in_review) {
    pushText(out, "week_in_review.text", b.week_in_review.text);
    pushText(out, "week_in_review.strongest_against.text", b.week_in_review.strongest_against?.text);
  }
  for (const e of entriesOf(b)) pushText(out, `${e.path}.summary`, e.summary);
  (b.corrections ?? []).forEach((c, i) => {
    pushText(out, `corrections[${i}].reason`, c?.reason);
    pushText(out, `corrections[${i}].after`, c?.after);
  });
  return out;
}

/** Quoted fields (§4.12): `items[].ai_evidence[].quote`, the Scoreboard entries' `quote`, `items[].attribution[].confidence_text`. Nulls left out. */
export function quotedFields(b: AnyBrief): FieldText[] {
  const out: FieldText[] = [];
  (b.items ?? []).forEach((it, i) => {
    (it?.ai_evidence ?? []).forEach((e, j) => pushText(out, `items[${i}].ai_evidence[${j}].quote`, e?.quote, i));
    (it?.attribution ?? []).forEach((a, j) => pushText(out, `items[${i}].attribution[${j}].confidence_text`, a?.confidence_text, i));
  });
  for (const e of entriesOf(b)) pushText(out, `${e.path}.quote`, e.quote);
  return out;
}

/** Titles (§4.12): `sources[].title`, `sources[].title_en`, `elsewhere[].title`. Nulls left out. */
export function titleFields(b: AnyBrief): FieldText[] {
  const out: FieldText[] = [];
  (b.sources ?? []).forEach((s, i) => {
    pushText(out, `sources[${i}].title`, s?.title);
    pushText(out, `sources[${i}].title_en`, s?.title_en);
  });
  (b.elsewhere ?? []).forEach((e, i) => pushText(out, `elsewhere[${i}].title`, e?.title));
  return out;
}

/** Prose, quoted and title fields together: what NO_LIVE_IOC reads. */
export function textFields(b: AnyBrief): FieldText[] {
  return [...proseFields(b), ...quotedFields(b), ...titleFields(b)];
}

/** One cited source id: the path of the id itself, the field, and the item it belongs to. */
export interface SourceRef {
  /** `items[0].source_ids[1]`, `angle.source_id`, `elsewhere[2].source_id`. */
  path: string;
  field: string;
  id: string;
  item: number | null;
}

function pushIds(out: SourceRef[], path: string, ids: unknown, item: number | null = null): void {
  if (!Array.isArray(ids)) return;
  ids.forEach((id, k) => {
    if (typeof id === "string") out.push({ path: `${path}[${k}]`, field: `${fieldOf(path)}[]`, id, item });
  });
}

function pushId(out: SourceRef[], path: string, id: unknown, item: number | null = null): void {
  if (typeof id === "string") out.push({ path, field: fieldOf(path), id, item });
}

/**
 * Every source-id field SOURCE_REF checks (§4.12): `items[].source_ids`, `.ai_evidence[].source_id`,
 * `.attribution[].source_id`, `.incident.status_source_ids`, `.flaw_evidence[].source_id`,
 * `.exposure.source_id`; `angle.source_id`, `angle.counterpoint_source_ids`; `taiwan_lens.source_ids`,
 * `.rows[].source_ids`, `.japan.source_ids`; `scoreboard_entries[].quote_source_id` (drafts: a Brief's
 * entries carry `source_url`); `week_in_review.strongest_against.source_ids`; `corrections[].source_id`
 * (drafts: a Brief's corrections carry `source_url`); `elsewhere[].source_id`.
 */
export function sourceIdFields(b: AnyBrief): SourceRef[] {
  const out: SourceRef[] = [];
  (b.items ?? []).forEach((it, i) => {
    if (!it) return;
    const p = `items[${i}]`;
    pushIds(out, `${p}.source_ids`, it.source_ids, i);
    (it.ai_evidence ?? []).forEach((e, j) => pushId(out, `${p}.ai_evidence[${j}].source_id`, e?.source_id, i));
    (it.attribution ?? []).forEach((a, j) => pushId(out, `${p}.attribution[${j}].source_id`, a?.source_id, i));
    pushIds(out, `${p}.incident.status_source_ids`, it.incident?.status_source_ids, i);
    (it.flaw_evidence ?? []).forEach((f, j) => pushId(out, `${p}.flaw_evidence[${j}].source_id`, f?.source_id, i));
    pushId(out, `${p}.exposure.source_id`, it.exposure?.source_id, i);
  });
  if (b.angle) {
    pushId(out, "angle.source_id", b.angle.source_id);
    pushIds(out, "angle.counterpoint_source_ids", b.angle.counterpoint_source_ids);
  }
  const lens = b.taiwan_lens;
  if (lens) {
    pushIds(out, "taiwan_lens.source_ids", lens.source_ids);
    (lens.rows ?? []).forEach((r, i) => pushIds(out, `taiwan_lens.rows[${i}].source_ids`, r?.source_ids));
    pushIds(out, "taiwan_lens.japan.source_ids", lens.japan?.source_ids);
  }
  for (const e of entriesOf(b)) pushId(out, `${e.path}.quote_source_id`, e.quote_source_id);
  pushIds(out, "week_in_review.strongest_against.source_ids", b.week_in_review?.strongest_against?.source_ids);
  if (!isBrief(b)) (b.corrections ?? []).forEach((c, i) => pushId(out, `corrections[${i}].source_id`, c?.source_id));
  (b.elsewhere ?? []).forEach((e, i) => pushId(out, `elsewhere[${i}].source_id`, e?.source_id));
  return out;
}

/** One model-written item reference: the Lead's, the Taiwan Lens's and the raises' `item_ids` (dropUnverified()'s lists). */
export interface ItemRef {
  path: string;
  field: string;
  id: string;
}

export function itemIdFields(b: AnyBrief): ItemRef[] {
  const out: ItemRef[] = [];
  const push = (path: string, ids: unknown) => {
    if (!Array.isArray(ids)) return;
    ids.forEach((id, k) => {
      if (typeof id === "string") out.push({ path: `${path}[${k}]`, field: `${fieldOf(path)}[]`, id });
    });
  };
  (b.lead ?? []).forEach((s, i) => push(`lead[${i}].item_ids`, s?.item_ids));
  const lens = b.taiwan_lens;
  if (lens) {
    push("taiwan_lens.item_ids", lens.item_ids);
    (lens.rows ?? []).forEach((r, i) => push(`taiwan_lens.rows[${i}].item_ids`, r?.item_ids));
    push("taiwan_lens.japan.item_ids", lens.japan?.item_ids);
  }
  for (const r of raisesOf(b)) push(`${r.path}.item_ids`, r.item_ids);
  return out;
}

/** Every string anywhere in `value`, with its path: what CANARY and SECRET_LIKE read ("any string"). Object keys are not included. */
export function allStrings(value: unknown, base = ""): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (v: unknown, p: string) => {
    if (typeof v === "string") out.push({ path: p || "(root)", text: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
  };
  walk(value, base);
  return out;
}

// ── Sources and publishers ───────────────────────────────────────────────────────────────────────

/** A source's title as the folding compares it: `title_en` when present, else `title`. */
export function titleOf(s: Pick<AnySource, "title" | "title_en">): string {
  return s.title_en ?? s.title;
}

/**
 * A source's publisher (§4.12 "Tier lookup", "Archived briefs"). Draft mode: publisherFor() on the
 * current config. Published mode: the frozen fields, with `kind` and `sole_newsroom_for_critical` null; a
 * malformed brief source without them (it fails SCHEMA) falls back to publisherFor().
 */
export function publisherView(s: AnySource, mode: RuleMode, config: Pick<LoadedConfig, "sourceTiers" | "vendors">): PublisherView {
  if (mode === "published" && "publisher" in s && typeof s.publisher === "string" && (s.tier === 1 || s.tier === 2 || s.tier === 3)) {
    return {
      tier: s.tier, publisher: s.publisher, publisher_name: s.publisher_name, state_label: s.state_label ?? null,
      kind: null, sole_newsroom_for_critical: null,
    };
  }
  const p = publisherFor(String(s.url ?? ""), s.source_type, { sourceTiers: config.sourceTiers, vendors: config.vendors });
  return { ...p };
}

/**
 * The publishers of an item (§4.12): the distinct `publisher` values of the tier 1 and 2 sources in its
 * `source_ids`, then syndicated copies folded into one: the same publisher, or titles whose word sets have
 * Jaccard similarity ≥ 0.8. The same union-find as lib/regions.ts's publisherCount().
 */
export function publishersOfItem(
  item: Pick<AnyItem, "source_ids">,
  sourcesById: ReadonlyMap<string, AnySource>,
  publisherBySourceId: ReadonlyMap<string, PublisherView>,
): ItemPublishers {
  const list: { id: string; source: AnySource; view: PublisherView }[] = [];
  for (const id of new Set(item.source_ids ?? [])) {
    const source = sourcesById.get(id);
    const view = publisherBySourceId.get(id);
    if (source && view && view.tier <= 2) list.push({ id, source, view });
  }
  const parent = list.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]!;
      const b = list[j]!;
      if (a.view.publisher === b.view.publisher || jaccard(titleOf(a.source), titleOf(b.source)) >= 0.8) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, PublisherGroup>();
  list.forEach((x, i) => {
    const root = find(i);
    const g = groups.get(root) ?? { publishers: [], source_ids: [], tier: x.view.tier };
    if (!g.publishers.includes(x.view.publisher)) g.publishers.push(x.view.publisher);
    g.source_ids.push(x.id);
    if (x.view.tier < g.tier) g.tier = x.view.tier;
    groups.set(root, g);
  });
  return { distinct: [...new Set(list.map((x) => x.view.publisher))], groups: [...groups.values()] };
}

/** The values every rule shares (RuleInput.derived), computed once per validation. */
export function derive(b: AnyBrief, mode: RuleMode, config: Pick<LoadedConfig, "sourceTiers" | "vendors">): Derived {
  const sourcesById = new Map<string, AnySource>();
  const publisherBySourceId = new Map<string, PublisherView>();
  const tierBySourceId = new Map<string, Tier>();
  for (const s of b.sources ?? []) {
    if (!s || typeof s.id !== "string" || sourcesById.has(s.id)) continue;
    sourcesById.set(s.id, s);
    const view = publisherView(s, mode, config);
    publisherBySourceId.set(s.id, view);
    tierBySourceId.set(s.id, view.tier);
  }
  const items = (b.items ?? []) as AnyItem[];
  const itemsById = new Map<string, AnyItem>();
  for (const it of items) if (it && typeof it.id === "string" && !itemsById.has(it.id)) itemsById.set(it.id, it);
  const publishersByIndex = items.map((it) => publishersOfItem(it, sourcesById, publisherBySourceId));
  const publishersByItem = new Map<string, ItemPublishers>();
  items.forEach((it, i) => {
    if (it && typeof it.id === "string" && !publishersByItem.has(it.id)) publishersByItem.set(it.id, publishersByIndex[i]!);
  });
  return { sourcesById, publisherBySourceId, tierBySourceId, itemsById, publishersByItem, publishersByIndex, order: displayOrder(items) };
}

/** orderItems(), or the agent's order when an item has no known kind or severity (a best-effort run). */
function displayOrder(items: readonly AnyItem[]): AnyItem[] {
  try {
    return orderItems(items);
  } catch {
    return [...items];
  }
}

/** The sources an item's `source_ids` resolve to, in order, unknown ids left out. */
export function sourcesOfItem(item: Pick<AnyItem, "source_ids">, d: Pick<Derived, "sourcesById">): AnySource[] {
  return [...new Set(item.source_ids ?? [])].flatMap((id) => {
    const s = d.sourcesById.get(id);
    return s ? [s] : [];
  });
}

// ── Seen text ────────────────────────────────────────────────────────────────────────────────────

/**
 * The seen text of a URL (§4.12): `evidence.texts[normalizeUrl(url)]`, or "" (also with no evidence). An own
 * string property only, so a source url such as "constructor" never reads Object.prototype.
 */
export function seenText(input: Pick<RuleInput, "evidence">, url: string): string {
  const texts = input.evidence?.texts;
  const key = normalizeUrl(url);
  if (!texts || !Object.hasOwn(texts, key)) return "";
  const text: unknown = texts[key];
  return typeof text === "string" ? text : "";
}

/** The seen text of a cited source, by id; "" when the id is unknown or nothing was seen. */
export function seenTextOfSource(input: Pick<RuleInput, "evidence" | "derived">, sourceId: string): string {
  const s = input.derived.sourcesById.get(sourceId);
  return s ? seenText(input, s.url) : "";
}

/** True when the evidence lists the URL (`evidence.urls`, normalised); false with no evidence. */
export function inEvidence(input: Pick<RuleInput, "evidence">, url: string): boolean {
  if (!input.evidence) return false;
  const want = normalizeUrl(url);
  return input.evidence.urls.some((u) => normalizeUrl(u) === want);
}

// ── Known names ──────────────────────────────────────────────────────────────────────────────────

export type KnownNameSource = "actor" | "vendor" | "finder" | "victim" | "claimant" | "attributor" | "actor_as_used";

/** One name the grounding and naming rules look for. `forms` are the name and its aliases: a match on any counts. */
export interface KnownName {
  name: string;
  forms: string[];
  source: KnownNameSource;
  /** The config id (actors.json, vendors.json, ai-finders.json), or null for an item's own name. */
  id: string | null;
}

const GENERIC_FINDER_RE = /^Other\b/;

/**
 * The names a finder entry stands for, read from its display name (ai-finders.json `name` is
 * "Org: Product, Product" or "Name (Member, Member)"): "Anthropic: Claude, Claude Mythos, Project
 * Glasswing" gives Anthropic, Claude, Claude Mythos and Project Glasswing; "OpenAI: ChatGPT used by a
 * researcher" gives OpenAI and ChatGPT; "DARPA AIxCC systems (Team Atlanta, Buttercup, RoboDuck)" gives
 * DARPA AIxCC, Team Atlanta, Buttercup and RoboDuck; the catch-all "Other credits ..." gives none.
 */
export function finderNames(finder: Pick<Finder, "name">): string[] {
  const name = finder.name.trim();
  if (GENERIC_FINDER_RE.test(name)) return [];
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.replace(/\s+used by a researcher$/i, "").replace(/\s+systems?$/i, "").trim();
    if (t && !out.includes(t)) out.push(t);
  };
  const colon = name.indexOf(": ");
  const head = colon >= 0 ? name.slice(0, colon) : null;
  const rest = colon >= 0 ? name.slice(colon + 2) : name;
  if (head) add(head);
  const paren = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(rest);
  if (paren) {
    add(paren[1]!);
    for (const part of paren[2]!.split(",")) add(part);
  } else {
    for (const part of rest.split(",")) add(part);
  }
  return out;
}

/** Each item's own names: `incident.victim`, `incident.claimed_by`, `attribution[].attributed_by`, `.actor_name_as_used`. */
export function itemNames(items: readonly AnyItem[]): KnownName[] {
  const out: KnownName[] = [];
  const add = (name: string | null | undefined, source: KnownNameSource) => {
    if (typeof name === "string" && name.trim()) out.push({ name, forms: [name], source, id: null });
  };
  for (const it of items) {
    if (!it) continue;
    add(it.incident?.victim, "victim");
    add(it.incident?.claimed_by, "claimant");
    for (const a of it.attribution ?? []) {
      add(a?.attributed_by, "attributor");
      add(a?.actor_name_as_used, "actor_as_used");
    }
  }
  return out;
}

/**
 * knownNames(config, items) (§4.12): actor names with their aliases, vendor names with their aliases,
 * finder names (finderNames()), and each item's own names (itemNames()). Matching is case-sensitive on
 * word boundaries (nameMatches()); an actor or vendor matches through any of its forms.
 */
export function knownNames(config: Pick<LoadedConfig, "actors" | "vendors" | "aiFinders">, items: readonly AnyItem[]): KnownName[] {
  const out: KnownName[] = [];
  for (const a of config.actors.actors) out.push({ name: a.name, forms: [a.name, ...a.aliases.map((x) => x.name)], source: "actor", id: a.id });
  for (const v of config.vendors.vendors) out.push({ name: v.name, forms: [v.name, ...v.aliases], source: "vendor", id: v.id });
  for (const f of config.aiFinders.finders) {
    for (const n of finderNames(f)) out.push({ name: n, forms: [n], source: "finder", id: f.id });
  }
  return [...out, ...itemNames(items)];
}

/**
 * The known names a rule uses: draft mode, knownNames(config, items); published mode, only each item's
 * own names (§4.12 "Archived briefs": the config names can change after publish).
 */
export function knownNamesFor(input: Pick<RuleInput, "mode" | "config" | "draft">): KnownName[] {
  const items = (input.draft.items ?? []) as AnyItem[];
  return input.mode === "draft" ? knownNames(input.config, items) : itemNames(items);
}

const formRes = new Map<string, RegExp>();

function formRe(form: string): RegExp {
  let re = formRes.get(form);
  if (!re) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u");
    formRes.set(form, re);
  }
  return re;
}

/** True when any form of `name` occurs in `text`: case-sensitive, on word boundaries (letters, digits and _ are word characters). */
export function nameMatches(text: string, name: Pick<KnownName, "forms">): boolean {
  return name.forms.some((f) => f.trim() !== "" && formRe(f).test(text));
}

/** The known names that occur in `text`. */
export function namesIn(text: string, names: readonly KnownName[]): KnownName[] {
  return names.filter((n) => nameMatches(text, n));
}
