// Snapshot soft gates (SPEC §4.12): SNAP_NUMBER, SNAP_NAME, SNAP_QUOTE, SNAP_MISSING. Warnings, draft scope:
// they check our numbers, names and quotes against what the run saw of the cited pages (evidence.texts:
// pack titles and snippets, record texts, page snapshots), so a bot-blocked or paywalled page can never sink
// an edition. lib/apply.ts's dropUnverified() reads their paths: `items[N]...`, `angle...` and
// `scoreboard_entries[N]...`. An item none of whose sources has seen text gets SNAP_MISSING alone (its
// numbers, names and quotes could not be checked), which drops only a Critical item.

import { NONE_FOUND } from "../vocab";
import { numbersIn, type NumberToken } from "../text";
import { blockNumbers, exactIn, metricPool, roundIn, type PoolNumber } from "./grounding";
import { entriesOf, knownNamesFor, nameMatches, namesIn, proseFields, seenTextOfSource, type KnownName } from "./shared";
import { defineRule, list, warning, type AnyItem, type Rule, type RuleInput, type ValidationIssue } from "./types";

export const SNAP_HINT = "Fix it by correcting the text, citing a tier 1 or 2 source whose page supports it, or removing the claim; an item still unverified after the repair round is dropped.";

/** True when the run saw some text of a cited source (§4.12 "Seen text of a source"). */
export function hasSeenText(input: Pick<RuleInput, "evidence" | "derived">, sourceId: string): boolean {
  return seenTextOfSource(input, sourceId).trim() !== "";
}

/**
 * Folds a quote or a page for SNAP_QUOTE (§4.12): NFKC, case folded, every quotation mark removed (straight,
 * curly, guillemets, corner brackets, and the apostrophe, which is the same character), whitespace runs as
 * one space.
 */
export function foldQuote(text: string): string {
  return text.normalize("NFKC").toLowerCase()
    .replace(/["'“”„‟‘’‚‛«»‹›「」『』〝〞〟]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** True when `quote` is in `seen` after folding (an empty quote never is). */
export function quoteInText(quote: string, seen: string): boolean {
  const q = foldQuote(quote);
  return q !== "" && foldQuote(seen).includes(q);
}

/** The known source ids of an item, in order, unknown ids (SOURCE_REF's) left out. */
function knownSources(input: Pick<RuleInput, "derived">, ids: readonly string[] | null | undefined): string[] {
  return [...new Set(ids ?? [])].filter((id) => input.derived.sourcesById.has(id));
}

const tier12 = (input: Pick<RuleInput, "derived">, ids: readonly string[]) =>
  ids.filter((id) => (input.derived.tierBySourceId.get(id) ?? 3) <= 2);

/** One number per written form. */
function distinctNumbers(text: string): NumberToken[] {
  const seen = new Set<string>();
  return numbersIn(text).filter((n) => {
    const k = `${n.raw}|${n.approx}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const pool = (texts: readonly string[]): PoolNumber[] =>
  texts.flatMap((t) => numbersIn(t, { words: true })).map((n) => ({ value: n.value, percent: n.percent }));

const ids = (xs: readonly string[]) => (xs.length ? list(xs) : "none");

/**
 * SNAP_NUMBER, SNAP_NAME, SNAP_QUOTE and SNAP_MISSING (draft scope, warnings):
 * - SNAP_MISSING: none of an item's sources (or the Angle's source) has seen text;
 * - SNAP_NUMBER: a number in an item's headline, summary or why_it_matters, or in the Angle's text or
 *   counterpoint, matching no number in the seen text of its tier 1 and 2 sources, its CVE block or release
 *   (blockNumbers()) or the metrics (exact, metricNumbers());
 * - SNAP_NAME: a known name in an item's prose fields found (through any of its forms) in none of its tier 1
 *   or 2 sources' seen text;
 * - SNAP_QUOTE: a quoted field (ai_evidence quote, attribution confidence_text, Scoreboard entry quote) not in
 *   the seen text of its own source after foldQuote().
 */
const snapshotGates = defineRule({
  code: ["SNAP_NUMBER", "SNAP_NAME", "SNAP_QUOTE", "SNAP_MISSING"],
  severity: "warning",
  scope: "draft",
  check: (input) => {
    const { draft, derived, metrics, config } = input;
    const out: ValidationIssue[] = [];
    const metricNums = metrics ? metricPool(metrics, config) : [];
    const names = knownNamesFor(input);
    const seen = (id: string) => seenTextOfSource(input, id);
    const items = (draft.items ?? []) as AnyItem[];
    const missing = new Set<number>();

    // SNAP_MISSING first: such an item gets no other gate.
    items.forEach((it, i) => {
      if (!it) return;
      const own = knownSources(input, it.source_ids);
      if (own.length && !own.some((id) => hasSeenText(input, id))) {
        missing.add(i);
        out.push(warning("SNAP_MISSING", `items[${i}].source_ids`,
          `items[${i}] (${it.id}): none of its sources (${ids(own)}) has seen text (no snapshot: blocked, paywalled or not HTML), so its numbers, names and quotes could not be checked.${it.severity === "critical" ? " A Critical item is dropped unless one of its sources can be read." : ""}`,
          "Cite a page the run could read (one that was fetched, or a pack item or record) beside these sources."));
      }
    });

    // SNAP_NUMBER on the items.
    items.forEach((it, i) => {
      if (!it || missing.has(i)) return;
      const t12 = tier12(input, knownSources(input, it.source_ids));
      const texts = pool(t12.map(seen));
      const blocks = blockNumbers(input, it);
      for (const field of ["headline", "summary", "why_it_matters"] as const) {
        const text = it[field];
        if (typeof text !== "string") continue;
        const bad = distinctNumbers(text).filter((n) => !roundIn(n, texts) && !roundIn(n, blocks) && !exactIn(n, metricNums));
        if (!bad.length) continue;
        out.push(warning("SNAP_NUMBER", `items[${i}].${field}`,
          `items[${i}].${field} holds ${list(bad.map((n) => n.raw))}, which no page seen for this item's tier 1 or 2 sources (${ids(t12)}), its CVE block or the metrics shows. A number found only in tier 3 text doesn't count.`,
          SNAP_HINT));
      }
    });

    // SNAP_NUMBER and SNAP_MISSING on the Angle.
    const angle = draft.angle;
    if (angle) {
      const own = knownSources(input, [...(angle.source_id ? [angle.source_id] : []), ...(angle.counterpoint_source_ids ?? [])]);
      const main = angle.source_id && derived.sourcesById.has(angle.source_id) ? angle.source_id : null;
      if (main && !hasSeenText(input, main)) {
        out.push(warning("SNAP_MISSING", "angle.source_id",
          `The Angle's source ${main} has no seen text (no snapshot: blocked, paywalled or not HTML), so its number could not be checked; the Angle is dropped unless it can be.`,
          "Cite a source page the run could read, or use a metric_path."));
      } else {
        const texts = pool(tier12(input, own).map(seen));
        for (const field of ["text", "counterpoint"] as const) {
          const text = angle[field];
          if (typeof text !== "string" || text === NONE_FOUND) continue;
          const bad = distinctNumbers(text).filter((n) => !roundIn(n, texts) && !exactIn(n, metricNums));
          if (!bad.length) continue;
          out.push(warning("SNAP_NUMBER", `angle.${field}`,
            `angle.${field} holds ${list(bad.map((n) => n.raw))}, which no page seen for the Angle's tier 1 or 2 sources (${ids(tier12(input, own))}) or the metrics shows.`,
            SNAP_HINT));
        }
      }
    }

    // SNAP_NAME on the items' prose fields.
    const proseByItem = new Map<number, { path: string; text: string }[]>();
    for (const f of proseFields(draft)) {
      if (f.item === null) continue;
      proseByItem.set(f.item, [...(proseByItem.get(f.item) ?? []), f]);
    }
    items.forEach((it, i) => {
      if (!it || missing.has(i)) return;
      const t12 = tier12(input, knownSources(input, it.source_ids));
      const texts = t12.map(seen).filter((t) => t.trim() !== "");
      for (const f of proseByItem.get(i) ?? []) {
        const unseen = new Map<string, KnownName>();
        for (const n of namesIn(f.text, names)) {
          if (!texts.some((t) => nameMatches(t, n))) unseen.set(n.name, n);
        }
        if (!unseen.size) continue;
        out.push(warning("SNAP_NAME", f.path,
          `${f.path} names ${list([...unseen.keys()])}, which the seen text of none of this item's tier 1 or 2 sources (${ids(t12)}) contains, under any of its names.`,
          SNAP_HINT));
      }
    });

    // SNAP_QUOTE on the quoted fields.
    const quote = (path: string, text: string | null | undefined, sourceId: string | null | undefined) => {
      if (typeof text !== "string" || text.trim() === "" || typeof sourceId !== "string" || !derived.sourcesById.has(sourceId)) return;
      if (quoteInText(text, seen(sourceId))) return;
      const has = hasSeenText(input, sourceId);
      out.push(warning("SNAP_QUOTE", path,
        has
          ? `${path} is not in the text seen at ${sourceId} (${derived.sourcesById.get(sourceId)!.url}), even ignoring case, spacing and quotation marks. Copy it verbatim from that page, or cite the page it comes from.`
          : `${path} quotes ${sourceId}, whose page has no seen text, so the quote could not be checked. Quote a page the run could read, or remove the quote.`,
        SNAP_HINT));
    };
    items.forEach((it, i) => {
      if (!it || missing.has(i)) return;
      (it.ai_evidence ?? []).forEach((e, j) => quote(`items[${i}].ai_evidence[${j}].quote`, e?.quote, e?.source_id));
      (it.attribution ?? []).forEach((a, j) => quote(`items[${i}].attribution[${j}].confidence_text`, a?.confidence_text, a?.source_id));
    });
    for (const e of entriesOf(draft)) quote(`${e.path}.quote`, e.quote, e.quote_source_id);
    return out;
  },
});

export const snapshotRules: Rule[] = [snapshotGates];
