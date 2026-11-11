// Grounding and numbers (SPEC §4.12): LEAD_GROUNDED, GAP_MATCH, METRICS_ONLY_NUMBERS, NUMBER_FORM. Our numbers
// come from numbersIn() (lib/text.ts). Against the metrics, matching is exact equality with metricNumbers()
// (the Gap panel's display strings, lib/metrics/headline.ts); against an item's text, its CVE block or a
// source's seen text, it is numberMatches()'s rounding rule. Units count: a percentage matches only a
// percentage. NUMBER_FORM fails a ratio written in a form numbersIn() cannot read ("9.9x").

import { gapTableDisplays, kevLines, metricNumbers, quotableRows, WINDOW_LENGTHS } from "../metrics/headline";
import type { Metrics } from "../schema/metrics";
import { gluedRatios, labelFigures, numberMatches, numbersBesideFigures, numbersIn, splitSentences, type LabelFigure, type NumberToken } from "../text";
import { METRIC_TERMS } from "../vocab";
import { citedItemsByPath } from "./cves";
import { isBrief, knownNamesFor, nameMatches, namesIn, proseFields, seenTextOfSource, type FieldText, type KnownName } from "./shared";
import { defineRule, error, list, type AnyItem, type Rule, type RuleInput, type ValidationIssue } from "./types";

// ── Number pools ─────────────────────────────────────────────────────────────────────────────────

/** A number to match against: its value and whether it is a percentage. */
export interface PoolNumber {
  value: number;
  percent: boolean;
}

/** §4.12's metricNumbers(metrics): every number the Gap panel shows (from the metrics file alone). */
export function metricPool(metrics: Metrics): PoolNumber[] {
  return metricNumbers(metrics).map((n) => ({ value: n.value, percent: n.percent }));
}

/** The numbers in the metrics' `headline.quoted` displays: what a Gap sentence (`gap: true`) may quote. */
export function quotedPool(metrics: Pick<Metrics, "headline">): PoolNumber[] {
  return metrics.headline.quoted.flatMap((q) => numbersIn(q.display)).map((n) => ({ value: n.value, percent: n.percent }));
}

/** Exact equality, units included: how our numbers match the metrics. */
export function exactIn(n: NumberToken, pool: readonly PoolNumber[]): boolean {
  return pool.some((p) => p.percent === n.percent && p.value === n.value);
}

/** numberMatches()' rounding rule, units included: how our numbers match items, CVE blocks and seen text. */
export function roundIn(n: NumberToken, pool: readonly PoolNumber[]): boolean {
  return pool.some((p) => p.percent === n.percent && numberMatches(n, p.value));
}

/** "37%", "1,384" for messages. */
const shown = (n: NumberToken) => n.raw;

/** An item's own text: its prose and quoted fields (§4.12 Shared definitions). */
export function itemTexts(it: AnyItem): string[] {
  const out: (string | null | undefined)[] = [
    it.headline, it.summary, it.why_it_matters, it.exposure?.text, it.incident?.impact, it.incident?.description,
    ...(it.ai_evidence ?? []).map((e) => e?.quote),
    ...(it.attribution ?? []).map((a) => a?.confidence_text),
  ];
  return out.filter((x): x is string => typeof x === "string" && x !== "");
}

/** An item's text, incident and attribution fields: where a Lead sentence's names must be found. */
export function itemNameTexts(it: AnyItem): string[] {
  const out: (string | null | undefined)[] = [
    ...itemTexts(it), it.ai_claimant, it.incident?.victim, it.incident?.claimed_by,
    ...(it.attribution ?? []).flatMap((a) => [a?.attributed_by, a?.actor_name_as_used, a?.sponsor_claimed]),
  ];
  return out.filter((x): x is string => typeof x === "string" && x !== "");
}

const fraction = (value: number): PoolNumber[] => [{ value, percent: false }, { value: Number((value * 100).toPrecision(12)), percent: true }];

/**
 * The numbers of an item's CVE blocks and release (§4.6): CVSS scores, EPSS scores and percentiles (as
 * fractions and as percentages), and the release's fixes, critical and exploited counts. Published mode
 * reads the frozen blocks; draft mode the context candidates for the item's CVEs and release, which carry
 * the same values publish freezes.
 */
export function blockNumbers(input: Pick<RuleInput, "mode" | "context">, it: AnyItem): PoolNumber[] {
  const out: PoolNumber[] = [];
  const count = (n: number | null | undefined) => {
    if (typeof n === "number") out.push({ value: n, percent: false });
  };
  if (input.mode === "published" && "cves" in it) {
    for (const b of it.cves ?? []) {
      count(b.cvss?.score);
      if (b.epss) out.push(...fraction(b.epss.score), ...fraction(b.epss.percentile));
    }
    if (it.release) {
      count(it.release.fixes_n);
      count(it.release.critical_n);
      count(it.release.exploited_n);
    }
    return out;
  }
  const cves = new Set((it.cve_ids ?? []).map((c) => String(c).toUpperCase()));
  for (const c of input.context?.candidates ?? []) {
    const mine = c.cve_ids.some((id) => cves.has(id)) || (it.release_id !== null && c.release?.release_id === it.release_id);
    if (!mine) continue;
    count(c.cvss?.score);
    if (c.epss) out.push(...fraction(c.epss.score), ...fraction(c.epss.percentile));
    if (c.release && c.release.release_id === it.release_id) {
      count(c.release.total);
      count(c.release.critical);
      count(c.release.exploited);
    }
  }
  return out;
}

/** The numbers in some texts, as a pool. */
function textPool(texts: readonly string[], opts: { words?: boolean } = {}): PoolNumber[] {
  return texts.flatMap((t) => numbersIn(t, opts)).map((n) => ({ value: n.value, percent: n.percent }));
}

/** Numbers of a text, one per written form. */
function distinctNumbers(text: string): NumberToken[] {
  return distinctTokens(numbersIn(text));
}

/** Tokens, one per written form. */
export function distinctTokens(tokens: readonly NumberToken[]): NumberToken[] {
  const seen = new Set<string>();
  return tokens.filter((n) => {
    const k = `${n.raw}|${n.approx}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The Gap's window lengths as figures ("26 weeks", "13 weeks"): what a metric Angle may print when no metrics file is read. */
const GAP_WINDOW_FIGURES: readonly LabelFigure[] = WINDOW_LENGTHS.flatMap((w) => labelFigures(w));

/**
 * The figures a metric Angle may print beside its number (§4.12, §0.4 row 145): those the labels of its
 * `metric_path`'s quotable rows print (quotableRows(); "26 weeks", "7 days", "2 to 30 days", "80%
 * interval"), in label order, each as many times as one label prints it (once, for every label today):
 * numbersBesideFigures() leaves out that many written occurrences and counts any later one. With no
 * metrics file, the Gap's window lengths, 26 weeks and 13 weeks, once each. A sourced Angle, or a path
 * with no quotable row, has none.
 */
export function angleFigures(angle: { metric_path?: string | null }, metrics: Metrics | null): LabelFigure[] {
  if (!angle.metric_path) return [];
  if (!metrics) return [...GAP_WINDOW_FIGURES];
  return rowFigures(angle.metric_path, quotableRows(metrics));
}

/**
 * angleFigures() on given rows: the figures the labels of the rows keyed `metricPath` print, in label
 * order, each as many times as one of those labels prints it (the most of any one row, not the sum, so two
 * rows that each print "26 weeks" give it once).
 */
export function rowFigures(metricPath: string, rows: readonly { readonly key: string; readonly label: string }[]): LabelFigure[] {
  const most = new Map<string, LabelFigure[]>();
  for (const r of rows) {
    if (r.key !== metricPath) continue;
    const here = new Map<string, LabelFigure[]>();
    for (const f of labelFigures(r.label)) here.set(f.text, [...(here.get(f.text) ?? []), f]);
    for (const [text, fs] of here) if ((most.get(text)?.length ?? 0) < fs.length) most.set(text, fs);
  }
  return [...most.values()].flat();
}

/** "26 weeks, 7 days": figures for a message, each named once. */
export const figureList = (figures: readonly LabelFigure[]): string => [...new Set(figures.map((f) => f.text))].join(", ");

/**
 * The numbers the Angle's text holds (§4.12, §0.4 row 145): numbersIn(), except that with a
 * `metric_path` the figures its quotable label prints (angleFigures()), written as figures, label the
 * number rather than add one (numbersBesideFigures()). WORDS_OVER and WORDS_UNDER count these,
 * LEAD_GROUNDED checks them against the path and SNAP_NUMBER against the metrics, so with
 * `window.w26.p7` "55% listed within 7 days in 26 weeks" is one number and "55% in 13 weeks" two.
 */
export function angleNumbers(angle: { text: string; metric_path?: string | null }, metrics: Metrics | null): NumberToken[] {
  return numbersBesideFigures(angle.text, angleFigures(angle, metrics));
}

/** The value at a dotted metrics path (`window.w26.at_disclosure_share`, `window.w26.at_disclosure_ci80.0`), or undefined. */
export function valueAt(metrics: unknown, path: string): unknown {
  let v: unknown = metrics;
  for (const key of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

/** The display strings the Gap shows for one metrics path: `headline.quoted` and the data table. */
export function displaysFor(metrics: Metrics, path: string): string[] {
  const out = metrics.headline.quoted.filter((q) => q.path === path).map((q) => q.display);
  if (metrics.window) out.push(...gapTableDisplays(metrics.window).filter((d) => d.key === path).map((d) => d.display));
  return [...new Set(out)];
}

// ── LEAD_GROUNDED ────────────────────────────────────────────────────────────────────────────────

const GAP_DAY_HINT = ' When a Gap sentence names the day, it names it by its dates ("13 to 14 Oct"), never as a length of hours.';

/** The number is written as a length of hours ("24 hours", "the 24-hour window", "12 hrs"). */
function hoursLength(text: string, n: NumberToken): boolean {
  const raw = n.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}.,])${raw}(?:\\s+|[-\\u2010\\u2011\\u2013])(?:hours?|hrs?)(?![\\p{L}\\p{N}])`, "iu").test(text.normalize("NFKC"));
}

/**
 * LEAD_GROUNDED (the Angle's source text draft only): each Lead sentence cites real items, or is a Gap
 * sentence; a Gap sentence quotes only `headline.quoted` numbers; every other number matches the cited
 * items' text or CVE blocks, or the metrics exactly; every known name is in the cited items' text,
 * incident or attribution fields (a name the Gap's own headline or second line uses counts as grounded).
 * The Angle's number equals its `metric_path` as the Gap shows it, or (draft) is in its source's seen text.
 */
const leadGrounded = defineRule({
  code: "LEAD_GROUNDED",
  scope: "brief",
  needsMetrics: true,
  check: (input) => {
    const { draft, derived } = input;
    const metrics = input.metrics!;
    const out: ValidationIssue[] = [];
    const metricNums = metricPool(metrics);
    const quoted = quotedPool(metrics);
    const known = knownNamesFor(input);
    const gapText = `${metrics.headline.text}\n${metrics.headline.second_line}`;
    const grounded = (k: KnownName) => nameMatches(gapText, k);

    (draft.lead ?? []).forEach((s, i) => {
      if (!s || typeof s.text !== "string") return;
      const p = `lead[${i}]`;
      const ids = s.item_ids ?? [];
      const cited: AnyItem[] = [];
      ids.forEach((id, k) => {
        const it = derived.itemsById.get(id);
        if (it) cited.push(it);
        else out.push(error("LEAD_GROUNDED", `${p}.item_ids[${k}]`, `${p} cites ${id}, which is not an item in this brief. Cite the item the sentence draws on, or remove the id.`));
      });
      if (ids.length === 0 && !s.gap) {
        out.push(error("LEAD_GROUNDED", `${p}.item_ids`,
          `${p} cites no item and is not a Gap sentence (gap: false). List the items it draws on in item_ids, or set gap: true if it quotes only Gap numbers.`));
      }

      // Numbers.
      const itemNums = [...textPool(cited.flatMap(itemTexts)), ...cited.flatMap((it) => blockNumbers(input, it))];
      for (const n of distinctNumbers(s.text)) {
        if (s.gap) {
          if (!exactIn(n, quoted)) {
            out.push(error("LEAD_GROUNDED", `${p}.text`,
              `${p} is a Gap sentence (gap: true) but holds ${shown(n)}, which is not one of the Gap's quoted numbers (${list(metrics.headline.quoted.map((q) => q.display))}).`,
              `Copy the number exactly as metrics.quotable shows it, or set gap: false and cite the item it comes from.${hoursLength(s.text, n) ? GAP_DAY_HINT : ""}`));
          }
          continue;
        }
        if (exactIn(n, metricNums) || roundIn(n, itemNums)) continue;
        out.push(error("LEAD_GROUNDED", `${p}.text`,
          ids.length
            ? `${p} holds ${shown(n)}, which matches no number in the text or CVE blocks of the items it cites (${list(ids)}) and no metric number exactly.`
            : `${p} holds ${shown(n)}, which is not a metric number, and the sentence cites no item.`,
          "Use the number as the item states it, cite the item that gives it, or copy a metric exactly as metrics.quotable shows it."));
      }

      // Names.
      const texts = cited.flatMap(itemNameTexts).join("\n");
      for (const k of namesIn(s.text, known)) {
        if (grounded(k)) continue;
        if (ids.length === 0) {
          out.push(error("LEAD_GROUNDED", `${p}.text`, `${p} names ${k.name} but cites no item. Cite the item that names ${k.name} in item_ids, or remove the name.`));
        } else if (!nameMatches(texts, k)) {
          out.push(error("LEAD_GROUNDED", `${p}.text`,
            `${p} names ${k.name}, which none of the items it cites (${list(ids)}) names in its text, incident or attribution fields.`,
            `Cite the item that names ${k.name}, or remove the name from the sentence.`));
        }
      }
    });

    // The Angle.
    const a = draft.angle;
    if (a && typeof a.text === "string") {
      const nums = distinctTokens(angleNumbers(a, metrics));
      if (a.metric_path) {
        const displays = displaysFor(metrics, a.metric_path);
        const raw = valueAt(metrics, a.metric_path);
        const figures = angleFigures(a, metrics);
        if (!displays.length && typeof raw !== "number") {
          out.push(error("LEAD_GROUNDED", "angle.metric_path",
            `angle.metric_path "${a.metric_path}" names no number in metrics/${metrics.date}.json. Use a path the Gap shows (metrics.quotable lists them), or cite a source instead.`));
        } else {
          const pool = displays.length ? textPool(displays) : typeof raw === "number" ? fraction(raw) : [];
          for (const n of nums) {
            const ok = displays.length ? exactIn(n, pool) : roundIn(n, pool);
            if (!ok) {
              out.push(error("LEAD_GROUNDED", "angle.text",
                `angle.text holds ${shown(n)}, but angle.metric_path "${a.metric_path}" is ${displays.length ? list(displays) : String(raw)} as the Gap shows it.`,
                `Write the number exactly as metrics.quotable shows it for that path, or fix metric_path.${figures.length ? ` The figures its label prints (${figureList(figures)}) may stand beside it as the label writes them, each at most once; no other number may.` : ""}`));
            }
          }
        }
      } else if (a.source_id && input.mode === "draft") {
        const seen = seenTextOfSource(input, a.source_id);
        if (seen !== "") { // nothing seen: SNAP_MISSING's
          const pool = textPool([seen], { words: true });
          for (const n of nums) {
            if (roundIn(n, pool)) continue;
            out.push(error("LEAD_GROUNDED", "angle.text",
              `angle.text holds ${shown(n)}, which is not in the text seen at its source ${a.source_id}.`,
              "Use the number as the source states it, or cite the source that gives it."));
          }
        }
      }
    }
    return out;
  },
});

// ── GAP_MATCH ────────────────────────────────────────────────────────────────────────────────────

const SCRIPT_COPIED = "The model never writes these fields: publish (lib/apply.ts) or the data-only composer copies them from the same-date metrics. Rebuild the brief; never edit them by hand.";

/**
 * GAP_MATCH † (brief; validateAll adds the missing-file case): a published brief's `gap` block and
 * `taiwan_lens.kev_lines` equal what the same-date metrics file gives: status "ok", that file, its
 * headline and second line, its data cutoff; kevLines(metrics) for TW and JP. A draft has neither field.
 */
const gapMatch = defineRule({
  code: "GAP_MATCH",
  scope: "brief",
  dataOnly: true,
  needsMetrics: true,
  check: (input) => {
    const b = input.draft;
    if (!isBrief(b)) return [];
    const m = input.metrics!;
    const out: ValidationIssue[] = [];
    const want = {
      status: "ok",
      metrics_file: `metrics/${m.date}.json`,
      headline: m.headline.text,
      second_line: m.headline.second_line,
      as_of: m.data_cutoff_utc,
    } as const;
    const gap = b.gap as Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(want)) {
      const got = gap?.[key];
      if (got === value) continue;
      const from = key === "headline" ? "headline.text" : key === "second_line" ? "headline.second_line" : key === "as_of" ? "data_cutoff_utc" : null;
      out.push(error("GAP_MATCH", `gap.${key}`,
        from
          ? `gap.${key} differs from metrics/${m.date}.json ${from}${typeof got === "string" && typeof value === "string" && got.length + value.length < 160 ? ` ("${got}" against "${value}")` : ""}.`
          : `gap.${key} is ${JSON.stringify(got ?? null)}, but metrics/${m.date}.json exists, so it must be ${JSON.stringify(value)}.`,
        SCRIPT_COPIED));
    }
    const lines = kevLines(m);
    const have = (b.taiwan_lens as { kev_lines?: Record<string, Record<string, unknown>> } | undefined)?.kev_lines;
    for (const key of ["tw", "jp"] as const) {
      for (const field of ["d30_n", "d90_n", "text"] as const) {
        const got = have?.[key]?.[field];
        const value = lines[key][field];
        if (got === value) continue;
        out.push(error("GAP_MATCH", `taiwan_lens.kev_lines.${key}.${field}`,
          `taiwan_lens.kev_lines.${key}.${field} is ${JSON.stringify(got ?? null)}, but kevLines(metrics/${m.date}.json) gives ${JSON.stringify(value)}.`,
          SCRIPT_COPIED));
      }
    }
    return out;
  },
});

// ── METRICS_ONLY_NUMBERS ─────────────────────────────────────────────────────────────────────────

const termRes: readonly { term: string; re: RegExp }[] = METRIC_TERMS.map((term) => {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['’]");
  // "the Flood", "the Window", "the Gap" are the panel's names: capitalised, so "the gap between" passes.
  const re = term.startsWith("the ")
    ? new RegExp(`(?<![\\p{L}\\p{N}])[Tt]he ${esc.slice(4)}(?![\\p{L}\\p{N}])`, "u")
    : new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "iu");
  return { term, re };
});

/** The METRIC_TERMS a sentence uses, in list order. */
export function metricTermsIn(sentence: string): string[] {
  return termRes.filter((t) => t.re.test(sentence)).map((t) => t.term);
}

/** The fields METRICS_ONLY_NUMBERS reads, each with the items whose CVE blocks its numbers may come from. */
function metricFields(input: Pick<RuleInput, "draft" | "derived">): { field: FieldText; items: AnyItem[] }[] {
  const { draft } = input;
  const items = (draft.items ?? []) as AnyItem[];
  const cited = citedItemsByPath(draft);
  const out: { field: FieldText; items: AnyItem[] }[] = [];
  for (const f of proseFields(draft)) {
    if (f.item !== null) {
      const it = items[f.item];
      out.push({ field: f, items: it ? [it] : [] });
    } else if (f.path.startsWith("taiwan_lens.")) {
      out.push({ field: f, items: cited.get(f.path) ?? [] });
    } else if (f.path.startsWith("week_in_review.")) {
      out.push({ field: f, items: [] });
    }
  }
  return out;
}

/**
 * METRICS_ONLY_NUMBERS: a sentence in an item field, the Taiwan Lens, the Japan block or the week in
 * review that uses a METRIC_TERMS term holds only numbers from metricNumbers(metrics) (exactly) or from
 * the CVE blocks of its item (the items a Lens block cites). The Lead and the Angle are LEAD_GROUNDED's.
 */
const metricsOnlyNumbers = defineRule({
  code: "METRICS_ONLY_NUMBERS",
  scope: "brief",
  needsMetrics: true,
  check: (input) => {
    const metricNums = metricPool(input.metrics!);
    const out: ValidationIssue[] = [];
    for (const { field, items } of metricFields(input)) {
      const blocks = items.flatMap((it) => blockNumbers(input, it));
      for (const sentence of splitSentences(field.text)) {
        const terms = metricTermsIn(sentence);
        if (!terms.length) continue;
        for (const n of distinctNumbers(sentence)) {
          if (exactIn(n, metricNums) || roundIn(n, blocks)) continue;
          out.push(error("METRICS_ONLY_NUMBERS", field.path,
            `${field.path}: the sentence "${sentence}" uses "${terms[0]}" and holds ${shown(n)}, which is not a metric number${items.length ? " or a number in the CVE block of the item it is about" : ""}.`,
            "A sentence about KEV, the Flood, the Window or AI credits may quote only metrics.quotable, exactly. Copy the metric, or rewrite the sentence without the metric term."));
        }
      }
    }
    return out;
  },
});

// ── NUMBER_FORM ──────────────────────────────────────────────────────────────────────────────────

/**
 * NUMBER_FORM (draft, §0.4 row 145): a prose field writes a ratio glued to x ("9.9x"), which numbersIn() does
 * not read, so LEAD_GROUNDED, METRICS_ONLY_NUMBERS and the Angle's count would let a wrong one through.
 * Quoted fields and titles, the sources' own words, are not read. One error per ratio as written, per field.
 */
const numberForm = defineRule({
  code: "NUMBER_FORM",
  scope: "draft",
  check: ({ draft }) => proseFields(draft).flatMap((f) => [...new Set(gluedRatios(f.text))].map((g) =>
    error("NUMBER_FORM", f.path, `${f.path} writes the ratio "${g}", glued to x, which the validator does not read as a number, so it cannot check it.`,
      `Write a ratio as the Gap does, "${g.slice(0, -1)} times", never "${g}", even where a source writes it that way.`))),
});

export const groundingRules: Rule[] = [leadGrounded, gapMatch, metricsOnlyNumbers, numberForm];
