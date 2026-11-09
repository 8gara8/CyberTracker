// Script-set fields (SPEC §4.12): COMPUTED_MISMATCH † (brief, all). A published brief's script-only fields
// must equal what code computes. On every brief: the counts and `word_count` (pageWords(), lib/rules/words.ts,
// against the metrics file the Gap shows), `reading_minutes`, `ai_linked`, each item's `actor_nexus`
// (actorNexusOf()) and `public_exploit` (publicExploitOf()), each CVE block's `vendor_confirmed`, the frozen
// publisher fields' internal consistency, and (validateAll() only) the CVE block fields the same-date inputs
// manifest also lists. Only on the brief validateAll(dir, { publishing: D, config }) names: the config-derived
// fields (each source's `tier`, `publisher`, `publisher_name`, `state_label`; each CVE block's
// `vendor_confirmed_by`; `late`) against the config publish froze them from (§4.12 "Archived briefs").
// `first_seen` across briefs is XREF_FIRST_SEEN's (lib/validate.ts); here only a first_seen after the brief's
// own date, on a brief validated alone. A draft has no script fields, so draft mode checks nothing.

import { cnaConfirms, type LoadedConfig } from "../config";
import { at } from "../dates";
import { actorNexusOf, publicExploitOf } from "../items";
import type { Brief } from "../schema/brief";
import type { CveBlock, Item } from "../schema/item";
import type { InputsManifest, Metrics } from "../schema/metrics";
import { publisherFor, urlOnAnyDomain } from "../sources";
import { AI_LINKED_ROLES } from "../vocab";
import { isBrief } from "./shared";
import { defineRule, error, type Rule, type RuleInput, type ValidationIssue } from "./types";
import { pageWords } from "./words";

/** §4.5: reading_minutes is ceil(word_count / 238). */
export const READING_WORDS_PER_MINUTE = 238;

const HINT = "Script-set fields are never edited by hand: rebuild the brief with lib/apply.ts from the draft and the run's inputs.";

const show = (v: unknown) => (v === null || v === undefined ? "null" : typeof v === "string" ? `"${v}"` : JSON.stringify(v));

function mismatch(path: string, stored: unknown, expected: unknown, why: string): ValidationIssue {
  return error("COMPUTED_MISMATCH", path, `${path} is ${show(stored)} but code computes ${show(expected)} (${why}).`, HINT);
}

const linkedRole = (r: string | null | undefined) => typeof r === "string" && (AI_LINKED_ROLES as readonly string[]).includes(r);

/** computed.ai_linked (§4.5): items whose ai_role or ai_role_secondary is in AI_LINKED_ROLES, of all items. */
export function aiLinkedOf(items: readonly Pick<Item, "ai_role" | "ai_role_secondary">[]): { linked: number; total: number } {
  return { linked: items.filter((it) => linkedRole(it.ai_role) || linkedRole(it.ai_role_secondary)).length, total: items.length };
}

/** `late` (§4.5): published_at after `schedule.stale_after` (08:00 Taipei) on the brief's date. */
export function lateOf(b: Pick<Brief, "date" | "published_at">, config: Pick<LoadedConfig, "run">): boolean {
  return Date.parse(b.published_at) > at(b.date, config.run.schedule.stale_after);
}

/**
 * The metrics file a brief's page counts against (§4.12 word table: the file its Gap shows): null for a
 * missing Gap; the same-date file when the Gap names it; undefined (cannot be checked here) when it names
 * an earlier file, or names the same-date file but none was given.
 */
export function gapMetricsFor(b: Pick<Brief, "date" | "gap">, metrics: Metrics | null): Metrics | null | undefined {
  if (b.gap.metrics_file === null) return null;
  if (b.gap.metrics_file === `metrics/${b.date}.json`) return metrics ?? undefined;
  return undefined;
}

/**
 * A CVE block's `vendor_confirmed_by` as publish computes it from the current config (§4.6): `vendor_cna`
 * when the assigner is in the block vendor's `cna` list; else `vendor_advisory` when one of the item's
 * flaw_evidence entries for the CVE cites one of its sources on the vendor's `domains`; else null, where
 * a stored `ghsa_reviewed` is accepted when the block lists a GHSA id (the review status itself comes from
 * the GHSA feed, which the brief doesn't hold).
 */
export function vendorConfirmedByOf(
  b: Pick<Brief, "sources">, item: Pick<Item, "flaw_evidence" | "source_ids">, block: Pick<CveBlock, "cve_id" | "vendor" | "assigner">,
  config: Pick<LoadedConfig, "vendors">,
): "vendor_cna" | "vendor_advisory" | null {
  const vendor = block.vendor.id ? config.vendors.vendors.find((v) => v.id === block.vendor.id) ?? null : null;
  if (!vendor) return null;
  if (cnaConfirms(vendor, block.assigner)) return "vendor_cna";
  for (const f of item.flaw_evidence) {
    if (f.cve_id !== block.cve_id || !item.source_ids.includes(f.source_id)) continue;
    const s = b.sources.find((x) => x.id === f.source_id);
    if (s && urlOnAnyDomain(s.url, vendor.domains)) return "vendor_advisory";
  }
  return null;
}

/** The CVE block fields an inputs manifest lists for one CVE (§4.7), each with where it was read. */
interface ManifestFacts {
  kev_date_added: { value: string; from: string }[];
  date_published: { value: string; from: string }[];
  vendor_id: { value: string; from: string }[];
  ai_credit: InputsManifest["ai_credited"];
}

/** What a manifest says about one CVE: window rows, AI-credit matches and home-vendor rows. */
export function manifestFacts(m: InputsManifest, cve: string): ManifestFacts {
  const out: ManifestFacts = { kev_date_added: [], date_published: [], vendor_id: [], ai_credit: [] };
  for (const w of ["w26", "w13"] as const) {
    for (const r of m.window[w]) {
      if (r.cve_id !== cve) continue;
      out.kev_date_added.push({ value: r.kev_date_added, from: `window.${w}` });
      if (r.date_published !== null) out.date_published.push({ value: r.date_published, from: `window.${w}` });
    }
  }
  for (const c of ["tw", "jp"] as const) {
    for (const r of m.home_vendors[c]) {
      if (r.cve_id !== cve) continue;
      out.kev_date_added.push({ value: r.date_added, from: `home_vendors.${c}` });
      out.vendor_id.push({ value: r.vendor_id, from: `home_vendors.${c}` });
    }
  }
  for (const r of m.ai_credited) {
    if (r.id !== cve) continue;
    out.ai_credit.push(r);
    out.date_published.push({ value: r.published, from: "ai_credited" });
  }
  return out;
}

const sameCredit = (a: NonNullable<CveBlock["ai_credit"]>, r: InputsManifest["ai_credited"][number]) =>
  a.finder_id === r.finder_id && a.family === r.family && a.kind === r.kind && a.field === r.field && a.matched === r.matched && a.rule === r.rule;

/** The issues from comparing one CVE block with what the manifest lists for its CVE. */
function manifestIssues(path: string, block: CveBlock, m: InputsManifest): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const f = manifestFacts(m, block.cve_id);
  const firstDiff = (xs: { value: string; from: string }[], stored: string | null) => xs.find((x) => x.value !== stored);
  const kev = firstDiff(f.kev_date_added, block.kev?.date_added ?? null);
  if (kev) out.push(mismatch(`${path}.kev${block.kev ? ".date_added" : ""}`, block.kev?.date_added ?? null, kev.value, `the inputs manifest's ${kev.from} row for ${block.cve_id}`));
  const pub = firstDiff(f.date_published, block.date_published);
  if (pub) out.push(mismatch(`${path}.date_published`, block.date_published, pub.value, `the inputs manifest's ${pub.from} row for ${block.cve_id}`));
  const vid = firstDiff(f.vendor_id, block.vendor.id);
  if (vid) out.push(mismatch(`${path}.vendor.id`, block.vendor.id, vid.value, `the inputs manifest's ${vid.from} row for ${block.cve_id}`));
  if (f.ai_credit.length) {
    const a = block.ai_credit;
    if (!a || !f.ai_credit.some((r) => sameCredit(a, r))) {
      const r = f.ai_credit[0]!;
      out.push(mismatch(`${path}.ai_credit`, a ? `${a.finder_id}: ${a.matched}` : null, `${r.finder_id}: ${r.matched}`, `the inputs manifest's ai_credited match for ${block.cve_id}`));
    }
  }
  return out;
}

/** COMPUTED_MISMATCH on one published brief (see the file comment). */
export function computedIssues(b: Brief, input: Pick<RuleInput, "metrics" | "config" | "crossFile">): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const publishing = input.crossFile?.publishing === true;
  const c = b.computed;

  // computed.*
  const gm = gapMetricsFor(b, input.metrics);
  const words = gm === undefined ? null : pageWords(b, gm);
  if (words !== null && c.word_count !== words) out.push(mismatch("computed.word_count", c.word_count, words, "pageWords(): the counted written fields plus the script-written page text"));
  const minutes = Math.ceil((words ?? c.word_count) / READING_WORDS_PER_MINUTE);
  if (c.reading_minutes !== minutes) out.push(mismatch("computed.reading_minutes", c.reading_minutes, minutes, `ceil(${words ?? c.word_count} / ${READING_WORDS_PER_MINUTE})`));
  if (c.item_count !== b.items.length) out.push(mismatch("computed.item_count", c.item_count, b.items.length, "the number of items"));
  if (c.source_count !== b.sources.length) out.push(mismatch("computed.source_count", c.source_count, b.sources.length, "the number of sources"));
  const publishers = new Set(b.sources.map((s) => s.publisher)).size;
  if (c.publisher_count !== publishers) out.push(mismatch("computed.publisher_count", c.publisher_count, publishers, "distinct publishers among the sources"));
  const linked = aiLinkedOf(b.items);
  if (c.ai_linked.linked !== linked.linked) out.push(mismatch("computed.ai_linked.linked", c.ai_linked.linked, linked.linked, "items whose ai_role or ai_role_secondary is AI-linked"));
  if (c.ai_linked.total !== linked.total) out.push(mismatch("computed.ai_linked.total", c.ai_linked.total, linked.total, "the number of items"));
  if (publishing) {
    const late = lateOf(b, input.config);
    if (b.late !== late) out.push(mismatch("late", b.late, late, `published_at ${b.published_at} against ${input.config.run.schedule.stale_after} Taipei on ${b.date}`));
  }

  // Items and their CVE blocks.
  b.items.forEach((it, i) => {
    const p = `items[${i}]`;
    const nexus = actorNexusOf(it.attribution);
    if (it.actor_nexus !== nexus) out.push(mismatch(`${p}.actor_nexus`, it.actor_nexus, nexus, "the nexus every qualifying attribution entry agrees on"));
    const exploit = publicExploitOf(it);
    if (it.public_exploit !== exploit) out.push(mismatch(`${p}.public_exploit`, it.public_exploit, exploit, "exploit_reported_in_sources and the CVE blocks' exploit_reference"));
    if (!input.crossFile && it.first_seen > b.date) out.push(mismatch(`${p}.first_seen`, it.first_seen, b.date, "an item is first seen on or before the edition that holds it"));
    it.cves.forEach((block, k) => {
      const bp = `${p}.cves[${k}]`;
      if (block.vendor_confirmed !== (block.vendor_confirmed_by !== null)) {
        out.push(mismatch(`${bp}.vendor_confirmed`, block.vendor_confirmed, block.vendor_confirmed_by !== null, "vendor_confirmed_by is not null"));
      }
      if (publishing) {
        const expected = vendorConfirmedByOf(b, it, block, input.config);
        const ghsaOk = expected === null && block.vendor_confirmed_by === "ghsa_reviewed" && block.ghsa_ids.length > 0;
        if (block.vendor_confirmed_by !== expected && !ghsaOk) {
          out.push(mismatch(`${bp}.vendor_confirmed_by`, block.vendor_confirmed_by, expected, "the vendor's cna list and domains in vendors.json, and the item's flaw_evidence"));
        }
      }
      if (input.crossFile?.inputs) out.push(...manifestIssues(bp, block, input.crossFile.inputs));
    });
  });

  // Sources: frozen publisher fields agree with each other; on the brief being published, with the config.
  const firstByPublisher = new Map<string, { i: number; s: Brief["sources"][number] }>();
  b.sources.forEach((s, i) => {
    const first = firstByPublisher.get(s.publisher);
    if (!first) {
      firstByPublisher.set(s.publisher, { i, s });
    } else {
      for (const k of ["publisher_name", "tier", "state_label"] as const) {
        if (s[k] !== first.s[k]) out.push(mismatch(`sources[${i}].${k}`, s[k], first.s[k], `${first.s.id} has the same publisher ${s.publisher}`));
      }
    }
    if (!publishing) return;
    const v = publisherFor(s.url, s.source_type, input.config);
    const diffs = (["tier", "publisher", "publisher_name", "state_label"] as const).filter((k) => s[k] !== v[k]);
    for (const k of diffs) out.push(mismatch(`sources[${i}].${k}`, s[k], v[k], `publisherFor() on ${s.url} with the current source-tiers.json and vendors.json`));
  });
  return out;
}

/** COMPUTED_MISMATCH † (brief, all): see the file comment. */
const computedMismatch = defineRule({
  code: "COMPUTED_MISMATCH",
  scope: "brief",
  dataOnly: true,
  check: (input) => (input.mode === "published" && isBrief(input.draft) ? computedIssues(input.draft, input) : []),
});

export const computedRules: Rule[] = [computedMismatch];
