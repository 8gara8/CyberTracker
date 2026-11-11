// Victims and attribution (SPEC §4.12): VICTIM_STATUS, VICTIM_CLAIMED_UNNAMED, ATTRIBUTION_NAMED,
// ATTRIBUTION_CONFIDENCE. All brief scope. Published mode reads each source's frozen tier (a stored tier 2
// source counts as the newsroom, §4.12 "Archived briefs") and only each item's own names; an item a
// dispute withheld (§4.10) is skipped where the withholding rewrote the text these rules read.

import { TOP_STORY_COUNT, hasLowConfidenceMarker } from "../items";
import type { Attribution } from "../schema/common";
import { splitSentences } from "../text";
import {
  ACTOR_NEXUS_INFO, ATTRIBUTION_CUES, NEXUS_TERMS, SEVERITY_INFO, UNNAMED_CLAIM, type ActorNexus,
} from "../vocab";
import { knownNamesFor, nameMatches, proseFields, raisesOf, type FieldText } from "./shared";
import { defineRule, error, list, type AnyItem, type Rule, type RuleInput, type ValidationIssue } from "./types";

const items = (input: Pick<RuleInput, "draft">): AnyItem[] => (input.draft.items ?? []) as AnyItem[];
const isWithheld = (it: AnyItem): boolean => "withheld" in it && it.withheld != null;

/** "s3 [BleepingComputer, tier 2]" for messages. */
function described(input: Pick<RuleInput, "derived">, id: string): string {
  const v = input.derived.publisherBySourceId.get(id);
  return v ? `${id} [${v.publisher_name}, tier ${v.tier}]` : id;
}

/** The first words of a sentence, for messages. */
function snippet(sentence: string, max = 70): string {
  const s = sentence.trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// ── VICTIM_STATUS ────────────────────────────────────────────────────────────────────────────────

/** The source types that can confirm an incident (§4.12 VICTIM_STATUS), at tier 1. */
export const CONFIRMING_SOURCE_TYPES: readonly string[] = ["victim", "regulator_filing", "government"];

/** A word starting "ransom" (ransom, ransoms, ransomed, ransomware), any case. */
const RANSOM_RE = /(?<![\p{L}\p{N}])ransom/iu;
const CODES = "USD|EUR|GBP|JPY|TWD|NTD|CNY|RMB|HKD|KRW|BTC|XMR";
/** A currency amount: a symbol or code before a number ("$5m", "US$1.2 million", "NT$300,000", "€2 million", "USD 5m"), or a number then a currency word or code ("2 million dollars", "40 bitcoin"). */
const CURRENCY_RE = new RegExp([
  String.raw`(?:(?:US|NT|HK|NZ|A|C|S)?\$|[€£¥₩₹]|(?<![\p{L}\p{N}])(?:${CODES})\s?)\s?\d`,
  String.raw`\d[\d,.]*\s?(?:thousand|million|billion|bn|m|k)?\s?(?:dollars?|euros?|pounds?|yen|yuan|renminbi|won|rupees?|bitcoins?|${CODES})(?![\p{L}\p{N}])`,
].join("|"), "iu");
/** The attribution VICTIM_STATUS accepts for a ransom amount (§4.12: says, said, according to; "say" for a plural subject). */
const ATTRIBUTED_RE = /(?<![\p{L}\p{N}])(?:says|said|say|according to)(?![\p{L}\p{N}])/iu;

/** True when a sentence names a ransom with a currency amount but doesn't attribute it (says, said, say, according to). */
export function unattributedRansom(sentence: string): boolean {
  return RANSOM_RE.test(sentence) && CURRENCY_RE.test(sentence) && !ATTRIBUTED_RE.test(sentence);
}

/**
 * VICTIM_STATUS (brief): a breach item with a null incident; a confirmed incident with no tier 1 victim,
 * regulator_filing or government source among `status_source_ids`; a reported incident with no tier 2
 * newsroom among them (draft mode: tier 2 and kind newsroom; published mode: a stored tier 2 source); a
 * prose sentence naming a ransom with a currency amount without attributing it. Unknown source ids are
 * SOURCE_REF's and are left out.
 */
const victimStatus = defineRule({
  code: "VICTIM_STATUS",
  scope: "brief",
  check: (input) => {
    const { derived, mode } = input;
    const out: ValidationIssue[] = [];
    items(input).forEach((it, i) => {
      if (!it) return;
      const p = `items[${i}]`;
      if (it.kind === "breach" && it.incident == null) {
        out.push(error("VICTIM_STATUS", `${p}.incident`,
          `${p} (${it.id}) is a breach but incident is null. Fill incident: victim (or null), description, sector, country, impact, disruption, status and status_source_ids.`));
        return;
      }
      const inc = it.incident;
      if (!inc || !Array.isArray(inc.status_source_ids)) return;
      const known = [...new Set(inc.status_source_ids)].filter((id) => derived.sourcesById.has(id));
      if (known.length === 0) return;
      const cited = known.map((id) => described(input, id)).join(", ");
      if (inc.status === "confirmed") {
        const ok = known.some((id) => derived.tierBySourceId.get(id) === 1
          && CONFIRMING_SOURCE_TYPES.includes(derived.sourcesById.get(id)!.source_type));
        if (!ok) {
          out.push(error("VICTIM_STATUS", `${p}.incident.status_source_ids`,
            `${p} (${it.id}) has incident.status "confirmed" but its status sources (${cited}) include no tier 1 victim statement, regulator filing (an SEC 8-K, a MOPS notice, a TDnet disclosure) or government or CERT notice. Cite one in status_source_ids, or set status to "reported" (a tier 2 newsroom reports it) or "claimed".`));
        }
      } else if (inc.status === "reported") {
        const ok = known.some((id) => {
          const v = derived.publisherBySourceId.get(id);
          return v !== undefined && v.tier === 2 && (mode === "published" || v.kind === "newsroom");
        });
        if (!ok) {
          out.push(error("VICTIM_STATUS", `${p}.incident.status_source_ids`,
            `${p} (${it.id}) has incident.status "reported" but its status sources (${cited}) include no tier 2 newsroom reporting the impact as fact. Cite one in status_source_ids, or set status to "claimed" if only the attacker says so.`));
        }
      }
    });
    for (const f of proseFields(input.draft)) {
      if (f.item !== null && isWithheld(items(input)[f.item]!)) continue;
      for (const s of splitSentences(f.text)) {
        if (!unattributedRansom(s)) continue;
        out.push(error("VICTIM_STATUS", f.path,
          `${f.path}: "${snippet(s)}" gives a ransom amount without saying who reports it. Attribute it in the same sentence ("…, the company said", "according to …"), or remove the amount.`));
      }
    }
    return out;
  },
});

// ── VICTIM_CLAIMED_UNNAMED ───────────────────────────────────────────────────────────────────────

/** UNNAMED_CLAIM filled in: "{description}, claimed by {group}, unverified". */
export function unnamedClaimText(description: string, group: string): string {
  return UNNAMED_CLAIM.replace("{description}", description).replace("{group}", group);
}

/** True when a summary carries the UNNAMED_CLAIM wording: "claimed by", the group, and "unverified". */
export function hasUnnamedClaimWording(summary: string, group: string): boolean {
  const lower = summary.toLowerCase();
  return lower.includes("claimed by") && lower.includes("unverified") && summary.includes(group);
}

/**
 * VICTIM_CLAIMED_UNNAMED (brief): a claimed incident (only an attacker's claim) with a non-null victim or
 * no `claimed_by`; one among the top stories (`items[0..2]`) or above `watch` (orchestrator ruling 2:
 * INCIDENT_STATUS_INFO.claimed, "at most Watch"); a summary without the UNNAMED_CLAIM wording.
 */
const victimClaimedUnnamed = defineRule({
  code: "VICTIM_CLAIMED_UNNAMED",
  scope: "brief",
  check: (input) => {
    const out: ValidationIssue[] = [];
    items(input).forEach((it, i) => {
      const inc = it?.incident;
      if (!inc || inc.status !== "claimed") return;
      const p = `items[${i}]`;
      if (inc.victim !== null && inc.victim !== undefined) {
        out.push(error("VICTIM_CLAIMED_UNNAMED", `${p}.incident.victim`,
          `${p} (${it.id}) is only an attacker's claim but names the victim ("${inc.victim}"). Set incident.victim to null and describe the victim in incident.description (e.g. "a Japanese logistics company").`,
          "A claimed victim is never named anywhere in the brief: headline, summary, Lead or Lens."));
      }
      // A withheld item's slot is free (lib/items.ts displayOrder()): the placeholder in it gives the claim no prominence.
      if (i < TOP_STORY_COUNT && !isWithheld(it)) {
        out.push(error("VICTIM_CLAIMED_UNNAMED", p,
          `${p} (${it.id}) is only an attacker's claim but is top story ${i + 1}. A claimed incident is never a top story: move it below the top three (at most Watch) or drop it.`));
      }
      if (it.severity && SEVERITY_INFO[it.severity].rank > SEVERITY_INFO.watch.rank) {
        out.push(error("VICTIM_CLAIMED_UNNAMED", `${p}.severity`,
          `${p} (${it.id}) is only an attacker's claim but has severity "${it.severity}". A claimed incident is at most "watch": set severity to "watch", or cite a tier 2 newsroom reporting the impact as fact and set status to "reported".`));
      }
      const group = inc.claimed_by;
      if (typeof group !== "string" || group.trim() === "") {
        out.push(error("VICTIM_CLAIMED_UNNAMED", `${p}.incident.claimed_by`,
          `${p} (${it.id}) is a claimed incident with no claimed_by. Set incident.claimed_by to the group making the claim.`));
        return;
      }
      if (isWithheld(it) || typeof it.summary !== "string") return;
      if (!hasUnnamedClaimWording(it.summary, group)) {
        out.push(error("VICTIM_CLAIMED_UNNAMED", `${p}.summary`,
          `${p} (${it.id}) is a claimed incident, but its summary lacks the unnamed-claim wording ("claimed by", ${group}, "unverified"). Write it as "${unnamedClaimText(inc.description ?? "the victim", group)}".`));
      }
    });
    return out;
  },
});

// ── ATTRIBUTION_NAMED ────────────────────────────────────────────────────────────────────────────

/** A nexus a sentence points to: a country nexus, or "state" for the generic state words (any state nexus). */
export type NexusMention = Exclude<ActorNexus, "hacktivist" | "criminal" | "unknown"> | "state";

/** The nexus values the generic state words ("state-sponsored", "nation-state") cover. */
export const STATE_NEXUS: readonly ActorNexus[] = ["prc", "russia", "dprk", "iran", "other_state"];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A phrase on word boundaries, any case, a hyphen and a space alike. */
const phraseRe = (s: string, flags = "iu") => new RegExp(`(?<![\\p{L}\\p{N}])${escape(s).replace(/[ -]/g, "[\\s-]")}(?![\\p{L}\\p{N}])`, flags);

const NEXUS_RES = NEXUS_TERMS.map((t) => ({ term: t.term, nexus: (t.nexus ?? "state") as NexusMention, re: phraseRe(t.term) }));

/** The nexus words in a sentence (NEXUS_TERMS, any case), with the nexus each points to. */
export function nexusMentions(sentence: string): { term: string; nexus: NexusMention }[] {
  return NEXUS_RES.filter((t) => t.re.test(sentence)).map(({ term, nexus }) => ({ term, nexus }));
}

/** ATTRIBUTION_CUES as words: "APT" in capitals (with any digits); the others any case, with an s, es, ed, er, ers or ing ending. */
const CUE_RES = ATTRIBUTION_CUES.map((c) => ({
  cue: c,
  re: c === "APT"
    ? /(?<![\p{L}\p{N}])APTs?\d*(?![\p{L}])/u
    : new RegExp(`(?<![\\p{L}\\p{N}])${escape(c)}(?:s|es|ed|er|ers|ing)?(?![\\p{L}\\p{N}])`, "iu"),
}));

/** The attribution cues in a sentence: ATTRIBUTION_CUES words, then any of `actorNames` (case-sensitive). */
export function attributionCues(sentence: string, actorNames: readonly { name: string; forms: string[] }[] = []): string[] {
  return [
    ...CUE_RES.filter((c) => c.re.test(sentence)).map((c) => c.cue),
    ...actorNames.filter((n) => nameMatches(sentence, n)).map((n) => n.name),
  ];
}

/** True when the sentence reads "<government> attributes" or "<government> says" (§4.12, basis government). */
export function governmentWording(sentence: string, attributedBy: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(attributedBy)}\\s+(?:attributes|says)(?![\\p{L}\\p{N}])`, "u").test(sentence);
}

const nexusLabel = (n: NexusMention) => (n === "state" ? "a state" : ACTOR_NEXUS_INFO[n]);
const entryFits = (e: Pick<Attribution, "nexus">, n: NexusMention) => (n === "state" ? STATE_NEXUS.includes(e.nexus) : e.nexus === n);

type Entry = Pick<Attribution, "attributed_by" | "basis" | "nexus">;

/**
 * The attribution entries a prose field may lean on (§4.12 ATTRIBUTION_NAMED): an item field, its own item's;
 * a Lead sentence, a Taiwan Lens text or a raise reason, those of the items its `item_ids` cite; any other
 * field (the Angle, the week in review, Scoreboard summaries, corrections), every entry in the brief.
 */
function entriesFor(input: RuleInput, f: FieldText, raiseIds: ReadonlyMap<string, string[]>): Entry[] {
  const all = items(input);
  const ofIds = (ids: unknown): Entry[] => (Array.isArray(ids) ? ids : [])
    .flatMap((id) => (typeof id === "string" ? input.derived.itemsById.get(id)?.attribution ?? [] : []));
  if (f.item !== null) return all[f.item]?.attribution ?? [];
  const lead = /^lead\[(\d+)\]\.text$/.exec(f.path);
  if (lead) return ofIds(input.draft.lead?.[Number(lead[1])]?.item_ids);
  const lens = input.draft.taiwan_lens;
  if (f.path === "taiwan_lens.analysis") return ofIds(lens?.item_ids);
  const row = /^taiwan_lens\.rows\[(\d+)\]\.text$/.exec(f.path);
  if (row) return ofIds(lens?.rows?.[Number(row[1])]?.item_ids);
  if (f.path === "taiwan_lens.japan.text") return ofIds(lens?.japan?.item_ids);
  const raise = raiseIds.get(f.path);
  if (raise) return ofIds(raise);
  return all.flatMap((it) => it?.attribution ?? []);
}

/**
 * ATTRIBUTION_NAMED (brief): a prose sentence with a NEXUS_TERMS word and an attribution cue (an
 * ATTRIBUTION_CUES word or a known actor name) must name, in that sentence, the `attributed_by` of an
 * attribution entry with that nexus; an entry with basis `government` must read "<government> attributes"
 * or "<government> says".
 */
const attributionNamed = defineRule({
  code: "ATTRIBUTION_NAMED",
  scope: "brief",
  check: (input) => {
    const out: ValidationIssue[] = [];
    const all = items(input);
    const actorNames = knownNamesFor(input).filter((n) => n.source === "actor" || n.source === "actor_as_used");
    const raiseIds = new Map(raisesOf(input.draft).map((r) => [`${r.path}.reason`, r.item_ids]));
    for (const f of proseFields(input.draft)) {
      if (f.item !== null && all[f.item] && isWithheld(all[f.item]!)) continue;
      let entries: Entry[] | null = null;
      for (const sentence of splitSentences(f.text)) {
        const mentions = nexusMentions(sentence);
        if (!mentions.length) continue;
        const cues = attributionCues(sentence, actorNames);
        if (!cues.length) continue;
        entries ??= entriesFor(input, f, raiseIds);
        const problems: string[] = [];
        for (const nexus of [...new Set(mentions.map((m) => m.nexus))]) {
          const all = [...new Set(mentions.filter((m) => m.nexus === nexus).map((m) => m.term))];
          const terms = all.filter((t) => !all.some((u) => u !== t && u.includes(t)));
          const fitting = entries.filter((e) => entryFits(e, nexus));
          const named = fitting.filter((e) => nameMatches(sentence, { forms: [e.attributed_by] }));
          const why = `ties an actor to ${nexusLabel(nexus)} (${list(terms)}, with "${cues[0]}")`;
          if (fitting.length === 0) {
            problems.push(`${why}, but no attribution entry ${f.item !== null ? "on this item" : "on an item it cites"} has nexus ${nexus === "state" ? "of a state" : `"${nexus}"`}. Add the attribution entry (who attributes it, basis, confidence) and name the attributor in this sentence, or drop the country`);
          } else if (named.length === 0) {
            const who = [...new Set(fitting.map((e) => e.attributed_by))];
            problems.push(`${why} but doesn't name who attributes it (${list(who)}). Name the attributor in the same sentence, e.g. "${who[0]} says …"`);
          } else if (named.every((e) => e.basis === "government" && !governmentWording(sentence, e.attributed_by))) {
            const g = named[0]!.attributed_by;
            problems.push(`${why} on a government's word, which must read "${g} attributes" or "${g} says"`);
          }
        }
        if (problems.length) {
          out.push(error("ATTRIBUTION_NAMED", f.path, `${f.path}: "${snippet(sentence)}" ${problems.join("; and it ")}.`,
            "Never state a country or state link as fact: say who makes the attribution, in the same sentence."));
        }
      }
    }
    return out;
  },
});

// ── ATTRIBUTION_CONFIDENCE ───────────────────────────────────────────────────────────────────────

/**
 * ATTRIBUTION_CONFIDENCE (brief): an entry that doesn't qualify under §4.6 (`confidence_level` low, a
 * LOW_CONFIDENCE_MARKERS entry in `confidence_text`, or `unstated` with a basis other than `government`)
 * with a sponsor or a nexus other than unknown; a nexus other than unknown with
 * a null `sponsor_claimed`; a `confidence_level` other than unstated with a null `confidence_text`.
 */
const attributionConfidence = defineRule({
  code: "ATTRIBUTION_CONFIDENCE",
  scope: "brief",
  check: (input) => {
    const out: ValidationIssue[] = [];
    items(input).forEach((it, i) => {
      (it?.attribution ?? []).forEach((a, j) => {
        if (!a) return;
        const p = `items[${i}].attribution[${j}]`;
        const marker = typeof a.confidence_text === "string" && hasLowConfidenceMarker(a.confidence_text);
        // §4.6's qualifying entry: an unstated confidence names a sponsor only when a government states it.
        const unstatedNonGov = a.confidence_level === "unstated" && a.basis !== "government";
        const low = a.confidence_level === "low" || marker || unstatedNonGov;
        const why = a.confidence_level === "low" ? 'confidence_level is "low"'
          : marker ? `confidence_text "${a.confidence_text}" marks it low confidence`
          : `confidence_level is "unstated" and basis is "${a.basis}" (only a government may name a sponsor without a stated confidence)`;
        if (low) {
          if (a.sponsor_claimed !== null) {
            out.push(error("ATTRIBUTION_CONFIDENCE", `${p}.sponsor_claimed`,
              `${p} (${a.attributed_by}): ${why}, so no sponsor may be named, but sponsor_claimed is "${a.sponsor_claimed}". Set sponsor_claimed to null and nexus to "unknown".`,
              "A sponsor or country is named only at high or moderate confidence, or from a government that states none."));
          }
          if (a.nexus !== "unknown") {
            out.push(error("ATTRIBUTION_CONFIDENCE", `${p}.nexus`,
              `${p} (${a.attributed_by}): ${why}, so nexus must be "unknown", not "${a.nexus}". Set nexus to "unknown" and keep any country out of the prose.`));
          }
        } else if (a.nexus !== "unknown" && a.sponsor_claimed === null) {
          out.push(error("ATTRIBUTION_CONFIDENCE", `${p}.sponsor_claimed`,
            `${p} (${a.attributed_by}) has nexus "${a.nexus}" but sponsor_claimed is null. Copy the sponsor or country the attributor states into sponsor_claimed, or set nexus to "unknown" if it states none.`));
        }
        if (a.confidence_level !== "unstated" && a.confidence_text === null) {
          out.push(error("ATTRIBUTION_CONFIDENCE", `${p}.confidence_text`,
            `${p} (${a.attributed_by}) has confidence_level "${a.confidence_level}" but confidence_text is null. Quote the attributor's own confidence words (e.g. "moderate confidence"), or set confidence_level to "unstated" if it gives none.`));
        }
      });
    });
    return out;
  },
});

export const namingRules: Rule[] = [victimStatus, victimClaimedUnnamed, attributionNamed, attributionConfidence];
