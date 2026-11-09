// AI role (SPEC §4.12): AI_EVIDENCE_REQUIRED, AI_CONFIRMED_NONPRESS, SELF_REPORTED_WORDING,
// ANTHROPIC_DISCLOSURE_LINE. mentionsAnthropic() is the one definition of the Anthropic disclosure:
// lib/apply.ts sets each item's `anthropic_disclosure` with it at publish (P3), and the rule checks a
// published brief against it. A withheld item (§4.10) keeps the wording and flag it was published with,
// since the withhold rewrite replaces its text.

import { AI_LINKED_ROLES } from "../vocab";
import { isBrief } from "./shared";
import { defineRule, error, list, type AnyItem, type Rule, type ValidationIssue } from "./types";

const LINKED: readonly string[] = AI_LINKED_ROLES;
const isLinked = (role: unknown): boolean => typeof role === "string" && LINKED.includes(role);
const EVIDENCE_MAX = 3;

/** True for an item a name_removed correction rewrote (published briefs only). */
function isWithheld(it: AnyItem): boolean {
  return "withheld" in it && it.withheld !== null && it.withheld !== undefined;
}

// ── AI_EVIDENCE_REQUIRED ─────────────────────────────────────────────────────────────────────────

/**
 * AI_EVIDENCE_REQUIRED: an AI-linked `ai_role` has 1 to 3 evidence entries and a confidence; `none` (and
 * `unassessed`, which §4.6 treats alike) has no evidence, confidence, claimant or secondary role; a
 * secondary role is AI-linked and differs from the main one; `claimed` names its claimant.
 */
const aiEvidenceRequired = defineRule({
  code: "AI_EVIDENCE_REQUIRED",
  scope: "brief",
  check: ({ draft }) => {
    const out: ValidationIssue[] = [];
    ((draft.items ?? []) as AnyItem[]).forEach((it, i) => {
      if (!it) return;
      const p = `items[${i}]`;
      const who = `${p} (${it.id})`;
      const evidence = it.ai_evidence ?? [];
      if (isLinked(it.ai_role)) {
        if (evidence.length === 0) {
          out.push(error("AI_EVIDENCE_REQUIRED", `${p}.ai_evidence`,
            `${who} has ai_role "${it.ai_role}" but no ai_evidence. Quote 1 to 3 sources that say AI played that role, or set ai_role to "none".`));
        }
        if (it.ai_confidence === null || it.ai_confidence === undefined) {
          out.push(error("AI_EVIDENCE_REQUIRED", `${p}.ai_confidence`,
            `${who} has ai_role "${it.ai_role}" but ai_confidence is null. Set "confirmed", "claimed" or "reported" from what the evidence shows.`));
        }
      } else if (it.ai_role === "none" || it.ai_role === "unassessed") {
        const extra = [
          evidence.length ? `${evidence.length} ai_evidence ${evidence.length === 1 ? "entry" : "entries"}` : null,
          it.ai_confidence ? `ai_confidence "${it.ai_confidence}"` : null,
          it.ai_claimant ? `ai_claimant "${it.ai_claimant}"` : null,
          it.ai_role_secondary ? `ai_role_secondary "${it.ai_role_secondary}"` : null,
        ].filter((x): x is string => x !== null);
        if (extra.length) {
          out.push(error("AI_EVIDENCE_REQUIRED", `${p}.ai_role`,
            `${who} has ai_role "${it.ai_role}" but also ${list(extra)}. With no AI role, ai_evidence is [], and ai_confidence, ai_claimant and ai_role_secondary are null; or set the AI-linked role the evidence shows.`));
        }
      }
      const sec = it.ai_role_secondary;
      if (sec !== null && sec !== undefined && it.ai_role !== "none" && it.ai_role !== "unassessed") {
        if (sec === it.ai_role) {
          out.push(error("AI_EVIDENCE_REQUIRED", `${p}.ai_role_secondary`,
            `${who} has ai_role_secondary "${sec}", the same as ai_role. Use a different AI-linked role, or null.`));
        } else if (!isLinked(sec)) {
          out.push(error("AI_EVIDENCE_REQUIRED", `${p}.ai_role_secondary`,
            `${who} has ai_role_secondary "${sec}", which is not an AI-linked role (${list(LINKED)}). Use one of those, or null.`));
        }
      }
      if (it.ai_confidence === "claimed" && !it.ai_claimant) {
        out.push(error("AI_EVIDENCE_REQUIRED", `${p}.ai_claimant`,
          `${who} has ai_confidence "claimed" but no ai_claimant. Name who makes the claim (at most 60 characters), e.g. the AI lab.`));
      }
      if (evidence.length > EVIDENCE_MAX) {
        out.push(error("AI_EVIDENCE_REQUIRED", `${p}.ai_evidence`,
          `${who} has ${evidence.length} ai_evidence entries; the limit is ${EVIDENCE_MAX}. Keep the ${EVIDENCE_MAX} strongest and remove at least ${evidence.length - EVIDENCE_MAX}.`));
      }
    });
    return out;
  },
});

// ── AI_CONFIRMED_NONPRESS ────────────────────────────────────────────────────────────────────────

/** The source types that can confirm an AI role (§4.12 AI_CONFIRMED_NONPRESS). */
export const CONFIRMING_SOURCE_TYPES: readonly string[] = ["cve_record", "vendor_advisory", "government", "victim"];

/**
 * AI_CONFIRMED_NONPRESS: `ai_confidence: "confirmed"` needs an ai_evidence entry not from the claimant
 * whose source is a CVE record, a vendor advisory, a government page or the victim's own statement.
 */
const aiConfirmedNonpress = defineRule({
  code: "AI_CONFIRMED_NONPRESS",
  scope: "brief",
  check: ({ draft, derived }) => {
    const out: ValidationIssue[] = [];
    ((draft.items ?? []) as AnyItem[]).forEach((it, i) => {
      if (!it || it.ai_confidence !== "confirmed") return;
      const ok = (it.ai_evidence ?? []).some((e) => {
        const s = e && !e.from_claimant ? derived.sourcesById.get(e.source_id) : undefined;
        return s !== undefined && CONFIRMING_SOURCE_TYPES.includes(s.source_type);
      });
      if (ok) return;
      out.push(error("AI_CONFIRMED_NONPRESS", `items[${i}].ai_confidence`,
        `items[${i}] (${it.id}) has ai_confidence "confirmed", but no ai_evidence entry comes from a ${list(CONFIRMING_SOURCE_TYPES)} source that is not the claimant. Press reports and the claimant's own write-up can't confirm an AI role.`,
        'Quote a CVE record, the vendor\'s advisory, a government page or the victim, or lower ai_confidence to "reported" (press) or "claimed" (the claimant says so).'));
    });
    return out;
  },
});

// ── SELF_REPORTED_WORDING ────────────────────────────────────────────────────────────────────────

/** The attribution verbs a self-reported claim's headline or summary must use (§4.12). */
export const ATTRIBUTING_WORDS = ["says", "said", "claims", "claimed", "reports", "reported", "according to"] as const;
const ATTRIBUTING_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${ATTRIBUTING_WORDS.join("|").replace(/ /g, "\\s+")})(?![\\p{L}\\p{N}])`, "iu");

/** True when the text attributes a claim with one of ATTRIBUTING_WORDS. */
export function attributesClaim(text: string | null | undefined): boolean {
  return typeof text === "string" && ATTRIBUTING_RE.test(text);
}

/**
 * SELF_REPORTED_WORDING: a `self_reported` item's headline or summary attributes the claim (says, said,
 * claims, claimed, reports, reported, according to), and its AI confidence is never `confirmed`.
 */
const selfReportedWording = defineRule({
  code: "SELF_REPORTED_WORDING",
  scope: "brief",
  check: ({ draft }) => {
    const out: ValidationIssue[] = [];
    ((draft.items ?? []) as AnyItem[]).forEach((it, i) => {
      if (!it || it.claim_type !== "self_reported") return;
      if (isWithheld(it)) return; // §4.10 replaced its headline and summary
      if (!attributesClaim(it.headline) && !attributesClaim(it.summary)) {
        out.push(error("SELF_REPORTED_WORDING", `items[${i}].headline`,
          `items[${i}] (${it.id}) is self_reported, but neither its headline nor its summary says who makes the claim (${list(ATTRIBUTING_WORDS.map((w) => `"${w}"`))}).`,
          'Attribute it in the headline or summary, e.g. "Anthropic says ...", or change claim_type if someone else has checked it.'));
      }
      if (it.ai_confidence === "confirmed") {
        out.push(error("SELF_REPORTED_WORDING", `items[${i}].ai_confidence`,
          `items[${i}] (${it.id}) is self_reported, so its AI role can't be "confirmed". Set ai_confidence to "claimed", or cite an independent confirmation and change claim_type.`));
      }
    });
    return out;
  },
});

// ── ANTHROPIC_DISCLOSURE_LINE ────────────────────────────────────────────────────────────────────

const ANTHROPIC_RE = /(?<![\p{L}\p{N}_])(?:anthropic|claude|mythos|glasswing)(?![\p{L}\p{N}_])/giu;

/** The publisher id of Anthropic's own pages (source-tiers.json). */
export const ANTHROPIC_PUBLISHER = "anthropic";

/** The item fields mentionsAnthropic() reads: a DraftItem, or an Item with its CVE blocks. */
export type AnthropicItem = Pick<AnyItem,
  "headline" | "summary" | "why_it_matters" | "exposure" | "incident" | "ai_evidence" | "attribution" | "ai_claimant" | "source_ids"
> & { cves?: readonly { ai_credit: { family: string } | null }[] };

/** A source's id and publisher: a Brief's frozen `publisher`, or publisherFor()'s for a draft source. */
export interface PublisherOfSource {
  id: string;
  publisher: string;
}

/**
 * Why an item mentions Anthropic (§4.12 ANTHROPIC_DISCLOSURE_LINE), as short reasons; [] when it doesn't.
 * Anthropic, Claude, Mythos or Glasswing as whole words, any case, in a prose or quoted field of the item
 * or its `ai_claimant`, `incident` or `attribution` fields; a cited source whose publisher is `anthropic`;
 * a CVE block whose `ai_credit.family` is `anthropic`.
 */
export function anthropicReasons(item: AnthropicItem, sources: readonly PublisherOfSource[] | ReadonlyMap<string, { publisher: string }>): string[] {
  const out: string[] = [];
  const fields: [string, string | null | undefined][] = [
    ["headline", item.headline], ["summary", item.summary], ["why_it_matters", item.why_it_matters], ["exposure.text", item.exposure?.text],
    ["ai_claimant", item.ai_claimant],
    ["incident.victim", item.incident?.victim], ["incident.description", item.incident?.description], ["incident.impact", item.incident?.impact],
    ["incident.claimed_by", item.incident?.claimed_by],
    ...(item.ai_evidence ?? []).map((e, j): [string, string | undefined] => [`ai_evidence[${j}].quote`, e?.quote]),
    ...(item.attribution ?? []).flatMap((a, j): [string, string | null | undefined][] => [
      [`attribution[${j}].attributed_by`, a?.attributed_by], [`attribution[${j}].actor_name_as_used`, a?.actor_name_as_used],
      [`attribution[${j}].sponsor_claimed`, a?.sponsor_claimed], [`attribution[${j}].confidence_text`, a?.confidence_text],
    ]),
  ];
  for (const [name, text] of fields) {
    const hit = typeof text === "string" ? text.match(ANTHROPIC_RE) : null;
    if (hit) out.push(`${name} says "${hit[0]}"`);
  }
  const publisher = (id: string) => (sources instanceof Map ? sources.get(id)?.publisher : (sources as readonly PublisherOfSource[]).find((s) => s.id === id)?.publisher);
  const cited = [...new Set([
    ...(item.source_ids ?? []), ...(item.ai_evidence ?? []).map((e) => e?.source_id), ...(item.attribution ?? []).map((a) => a?.source_id),
    ...(item.incident?.status_source_ids ?? []), item.exposure?.source_id,
  ].filter((x): x is string => typeof x === "string"))];
  for (const id of cited) if (publisher(id) === ANTHROPIC_PUBLISHER) out.push(`it cites ${id}, an Anthropic page`);
  (item.cves ?? []).forEach((c, k) => {
    if (c?.ai_credit?.family === "anthropic") out.push(`cves[${k}] is credited to an Anthropic finder`);
  });
  return out;
}

/** §4.12's mentionsAnthropic(item): the item names Anthropic, cites an Anthropic page or carries an Anthropic AI credit. */
export function mentionsAnthropic(item: AnthropicItem, sources: readonly PublisherOfSource[] | ReadonlyMap<string, { publisher: string }>): boolean {
  return anthropicReasons(item, sources).length > 0;
}

/**
 * ANTHROPIC_DISCLOSURE_LINE: a published item's `anthropic_disclosure` equals mentionsAnthropic(item),
 * reading each source's frozen publisher. A draft has no such field; a withheld item keeps its flag.
 */
const anthropicDisclosureLine = defineRule({
  code: "ANTHROPIC_DISCLOSURE_LINE",
  scope: "brief",
  check: ({ draft, derived }) => {
    if (!isBrief(draft)) return [];
    const out: ValidationIssue[] = [];
    draft.items.forEach((it, i) => {
      if (!it || isWithheld(it)) return;
      const reasons = anthropicReasons(it, derived.publisherBySourceId);
      const want = reasons.length > 0;
      if (it.anthropic_disclosure === want) return;
      out.push(error("ANTHROPIC_DISCLOSURE_LINE", `items[${i}].anthropic_disclosure`,
        want
          ? `items[${i}] (${it.id}) has anthropic_disclosure false, but ${list(reasons)}, so the card must show the disclosure line.`
          : `items[${i}] (${it.id}) has anthropic_disclosure true, but nothing in the item names Anthropic, Claude, Mythos or Glasswing, cites an Anthropic page or carries an Anthropic AI credit.`,
        "Publish sets the flag with mentionsAnthropic() (lib/apply.ts); rebuild the brief rather than editing it."));
    });
    return out;
  },
});

export const aiRules: Rule[] = [aiEvidenceRequired, aiConfirmedNonpress, selfReportedWording, anthropicDisclosureLine];
