// Words and limits (SPEC §4.12): WORDS_OVER, WORDS_UNDER, QUOTE_MAX_25, BANNED_WORDS. wordFields() holds
// every budget of §4.12's word table in one table, as the fork base's words rule does. pageWords() is the
// page total (§4.5): the model fields marked "in the total" plus countWords(scriptText()) from
// lib/page-text.ts, which builds every counted script string the page shows. A draft has no S fields, so
// draftView() builds the provisional page view scriptText() reads: region rows from computeRegions() on the
// draft (§4.12), and each item's kicker vendor, CVE timeline and release line from this morning's inputs.
// Publish recomputes the count on the real Brief (COMPUTED_MISMATCH).

import type { LoadedConfig } from "../config";
import { matchVendor } from "../config";
import { KEV_ABSENCE_NOTE, AI_LINKED_ROLES, BANNED_WORDS, WITHHELD_MARK } from "../vocab";
import { isWithheld, TOP_STORY_COUNT } from "../items";
import { kevLineUnavailable, kevLines } from "../metrics/home-vendors";
import { fmtInt } from "../metrics/stats";
import { scriptText, type CardItem, type PageBrief, type ScriptOptions, type SummaryRow } from "../page-text";
import { BASELINE_REASON, computeRegions, regionItems } from "../regions";
import type { Brief } from "../schema/brief";
import type { VendorRef } from "../schema/common";
import type { AgentContext } from "../schema/context";
import type { DraftBrief } from "../schema/draft-brief";
import type { CveBlock, DraftItem, ReleaseBlock } from "../schema/item";
import type { Metrics } from "../schema/metrics";
import { countWords, gluedRatios } from "../text";
import { angleFigures, angleNumbers, figureList } from "./grounding";
import { draftFirstSeen } from "./items";
import { entriesOf, isBrief, proseFields, quotedFields, raisesOf } from "./shared";
import { defineRule, error, plural, type AnyBrief, type AnyItem, type CveLookup, type RegionsBase, type Rule, type ValidationIssue } from "./types";

// ── The word table ───────────────────────────────────────────────────────────────────────────────

/** One budgeted field (or sum of fields) of §4.12's word table. */
export interface WordField {
  /** formatPath() form of the field; `lead` for the Lead's sum, `items[i]` for a top story's summary + why_it_matters. */
  path: string;
  /** What the message calls it: the path, or "items[0].summary + why_it_matters". */
  label: string;
  /** Said after the count: " (all sentences together)" for the Lead, else "". */
  note: string;
  text: string | null;
  /** Fewest words, or null for none. */
  min: number | null;
  /** Most words, or null for none (headlines: 90 characters, which the schema checks). */
  max: number | null;
  /** Counted in pageWords(). */
  total: boolean;
  /** Exempt from `min`: a WITHHELD_MARK text a withholding wrote (§4.10). */
  withheld: boolean;
}

/** The Lead's budget, all sentences together (§4.12 Word budgets); dropUnverified() keeps the minimum when it removes a sentence. */
export const LEAD_WORDS = { min: 15, max: 90 } as const;

/** QUOTE_MAX_25's limit for a quoted field or a quoted span in prose. */
export const QUOTE_MAX = 25;

const isMark = (t: string | null | undefined): boolean => typeof t === "string" && t.trim() === WITHHELD_MARK;

/**
 * wordFields(brief): every budget of §4.12's word table, for a draft or a published Brief. Quoted
 * fields are QUOTE_MAX_25's (quotedFields()), not here. A withheld item (§4.10) has no budget and none of
 * its fields count in the total: its text is the composer's fixed placeholder, so it never fails a word
 * rule nor takes words from the page (§0.4 row 126). A WITHHELD_MARK text keeps its maximum but loses its
 * minimum.
 */
export function wordFields(b: AnyBrief): WordField[] {
  const out: WordField[] = [];
  const add = (path: string, text: string | null | undefined, total: boolean, max: number | null, min: number | null = null,
    opts: { label?: string; note?: string; withheld?: boolean } = {}) => {
    out.push({
      path, label: opts.label ?? path, note: opts.note ?? "", text: text ?? null, min, max, total, withheld: opts.withheld ?? isMark(text),
    });
  };

  const lead = b.lead ?? [];
  add("lead", lead.map((s) => s.text).join(" "), true, LEAD_WORDS.max, LEAD_WORDS.min,
    { note: " (all sentences together)", withheld: lead.some((s) => isMark(s.text)) });

  if (b.angle) {
    add("angle.text", b.angle.text, true, 30);
    add("angle.counterpoint", b.angle.counterpoint, true, 30);
  }

  (b.items ?? []).forEach((it, i) => {
    if (isWithheld(it)) return;
    const p = `items[${i}]`;
    add(`${p}.headline`, it.headline, true, null);
    if (i < TOP_STORY_COUNT) {
      add(`${p}.summary`, it.summary, true, 55);
      add(`${p}.why_it_matters`, it.why_it_matters, true, 25);
      const both = [it.summary, it.why_it_matters].filter((t): t is string => typeof t === "string").join(" ");
      add(p, both, false, 70, 15, { label: `${p}.summary + why_it_matters` });
    } else {
      add(`${p}.summary`, it.summary, true, 25);
      add(`${p}.why_it_matters`, it.why_it_matters, true, 25);
    }
    add(`${p}.incident.impact`, it.incident?.impact, true, 12);
    add(`${p}.exposure.text`, it.exposure?.text, true, 20);
  });

  for (const r of raisesOf(b)) add(`${r.path}.reason`, r.reason, true, 20);

  const lens = b.taiwan_lens;
  if (lens) {
    // A blank analysis is TAIWAN_LENS_REQUIRED's, so the minimum applies only to text that is there.
    add("taiwan_lens.analysis", lens.analysis, true, 120, lens.analysis.trim() === "" ? null : 1);
    (lens.rows ?? []).forEach((r, i) => add(`taiwan_lens.rows[${i}].text`, r.text, true, 30));
    add("taiwan_lens.japan.text", lens.japan?.text, true, 40);
  }

  if (b.week_in_review) {
    add("week_in_review.text", b.week_in_review.text, false, 150);
    add("week_in_review.strongest_against.text", b.week_in_review.strongest_against?.text, false, 50);
  }
  for (const e of entriesOf(b)) add(`${e.path}.summary`, e.summary, false, 40);
  (b.corrections ?? []).forEach((c, i) => add(`corrections[${i}].reason`, c.reason, false, 40));
  return out;
}

/** The countWords() sum of the model fields marked "in the total" (§4.5). */
export function modelWords(b: AnyBrief): number {
  return wordFields(b).reduce((sum, f) => sum + (f.total ? countWords(f.text) : 0), 0);
}

// ── The provisional page view of a draft ─────────────────────────────────────────────────────────

/** What draftView() reads besides the draft: RuleInput's fields of the same names. */
export interface DraftViewInputs {
  metrics: Metrics | null;
  config: Pick<LoadedConfig, "vendors">;
  context: AgentContext | null;
  cveList: CveLookup | null;
  regionsBase: RegionsBase | null;
}

/** The CVE block fields cveTimeline() reads. */
type TimelineCve = Pick<CveBlock, "date_published" | "kev" | "exploitation_evidence" | "patch">;
/** The release fields releaseLine() reads. */
type LineRelease = Pick<ReleaseBlock, "date" | "fixes_n" | "exploited_n" | "critical_n">;

const vendorRef = (v: { id: string; name: string; country: VendorRef["country"] }): VendorRef => ({ id: v.id, name: v.name, country: v.country });

const earliest = (dates: readonly string[]): string | null => (dates.length ? [...dates].sort()[0]! : null);

/**
 * The provisional Brief view of a draft that scriptText() reads (§4.12 word table, last line). Region
 * rows come from computeRegions() on the draft's items and raises with `regionsBase` (else the context's
 * regions_preview); `first_seen` is draftFirstSeen() (lib/rules/items.ts): the base's first_seen map,
 * as publish gives it, else the draft's date. Each item's vendor, first CVE block and release are rebuilt the way publish builds them
 * (§4.6), from the CVE List, the KEV index rows in `regionsBase`, the context's candidates and the item's
 * own `flaw_evidence`. The Gap and the Lens KEV lines come from `metrics`. `published_at`, `late` and
 * `reading_minutes` are placeholders: the count depends only on their presence, except "(late)", which a
 * late publish adds. Feeds stale or failed in the context (`metrics.stale`, `pack.failed_feeds`) make
 * the edition partial.
 */
export function draftView(draft: DraftBrief, inputs: DraftViewInputs): PageBrief {
  const { metrics, context, cveList, regionsBase, config } = inputs;
  const kevRows = new Map((regionsBase?.kevIndex.entries ?? []).map((row) => [row[0], row] as const));
  const candidates = context?.candidates ?? [];
  const candidateFor = (cve: string) => candidates.find((c) => c.cve_ids.includes(cve));

  const cveBlock = (item: DraftItem, cve: string): { block: TimelineCve; vendor: VendorRef | null } | null => {
    const rec = cveList?.get(cve);
    const row = kevRows.get(cve);
    const cand = candidateFor(cve);
    const published = rec?.date_published ?? row?.[4] ?? null;
    if (!published) return null;
    const added = row?.[1] ?? cand?.kev?.date_added ?? rec?.kev_date_added ?? null;
    const exploited = item.flaw_evidence.filter((f) => f.cve_id === cve && f.kind === "exploited");
    const patched = earliest(item.flaw_evidence.filter((f) => f.cve_id === cve && f.kind === "patched").map((f) => f.date));
    const block: TimelineCve = {
      date_published: published,
      kev: added ? { date_added: added, due_date: cand?.kev?.due_date ?? added, ransomware: "unknown", catalog_version: "provisional" } : null,
      exploitation_evidence: exploited.map((f) => ({ date: f.date, basis: f.basis as CveBlock["exploitation_evidence"][number]["basis"], source_url: "" })),
      patch: patched ? { date: patched, basis: "vendor_advisory", source_url: "" } : null,
    };
    const kevVendor = row?.[2] ?? null;
    const matched = matchVendor(config, { kevVendorProject: kevVendor, affectedVendors: rec?.vendors ?? [] });
    const name = kevVendor ?? rec?.vendors[0] ?? cand?.vendor ?? null;
    const vendor = matched ? vendorRef(matched) : name ? { id: null, name: name.slice(0, 80), country: null } : null;
    return { block, vendor };
  };

  const releaseOf = (item: DraftItem): { release: LineRelease; vendor: VendorRef | null } | null => {
    if (item.release_id === null) return null;
    const r = candidates.find((c) => c.release?.release_id === item.release_id)?.release;
    if (!r) return null;
    const date = earliest(item.flaw_evidence.filter((f) => f.kind === "patched").map((f) => f.date)) ?? draft.date;
    const byId = config.vendors.vendors.find((v) => v.id === r.vendor) ?? matchVendor(config, { affectedVendors: [r.vendor] });
    return {
      release: { date, fixes_n: r.total, critical_n: r.critical, exploited_n: r.exploited },
      vendor: byId ? vendorRef(byId) : { id: null, name: r.vendor.slice(0, 80), country: null },
    };
  };

  const items: CardItem[] = draft.items.map((it) => {
    const blocks = it.cve_ids.map((cve) => cveBlock(it, cve)).filter((x): x is NonNullable<typeof x> => x !== null);
    const rel = it.kind === "patch_batch" ? releaseOf(it) : null;
    return {
      kind: it.kind, severity: it.severity, landmark: it.landmark, ai_role: it.ai_role, ai_confidence: it.ai_confidence,
      ai_claimant: it.ai_claimant, regions: it.regions,
      vendor: blocks[0]?.vendor ?? rel?.vendor ?? null,
      // Only the fields the timeline reads are real; the view never leaves this file.
      cves: blocks.map((b) => b.block as CveBlock),
      release: (rel?.release ?? null) as ReleaseBlock | null,
    };
  });

  const linked = draft.items.filter((it) => (AI_LINKED_ROLES as readonly string[]).includes(it.ai_role)
    || (it.ai_role_secondary !== null && (AI_LINKED_ROLES as readonly string[]).includes(it.ai_role_secondary))).length;
  const stale = [...new Set([...(context?.metrics.stale ?? []), ...(context?.pack.failed_feeds ?? [])])];

  return {
    date: draft.date,
    edition: stale.length ? "partial" : "full",
    published_at: draft.generated_at,
    late: false,
    lead: draft.lead,
    computed: { reading_minutes: 1, ai_linked: { linked, total: draft.items.length } },
    gap: metrics
      ? { headline: metrics.headline.text, second_line: metrics.headline.second_line, status: "ok", as_of: metrics.data_cutoff_utc }
      : { headline: "", second_line: "", status: "missing", as_of: null },
    regions: { rows: draftRegionRows(draft, inputs) },
    items,
    actors_seen: draft.items.flatMap((it) => it.attribution.map((a) => a.actor_name_as_used)),
    taiwan_lens: {
      kev_lines: metrics ? kevLines(metrics)
        : { tw: { d30_n: 0, d90_n: 0, text: kevLineUnavailable("tw") }, jp: { d30_n: 0, d90_n: 0, text: kevLineUnavailable("jp") } },
      kev_note: KEV_ABSENCE_NOTE,
    },
    feeds_stale: stale.map((name) => ({ name, stale_since: null })),
  };
}

/** The draft's region rows: computeRegions() on its items and raises (§4.12), else the context's preview, else baseline. */
function draftRegionRows(draft: DraftBrief, inputs: Pick<DraftViewInputs, "context" | "regionsBase">): SummaryRow[] {
  const { context, regionsBase } = inputs;
  if (regionsBase) {
    const items = regionItems(draft.items.map((it) => ({ ...it, first_seen: draftFirstSeen({ date: draft.date, regionsBase }, it.id) })), draft.sources, regionsBase.config);
    return computeRegions({ ...regionsBase, items, raises: draft.region_raises }).rows;
  }
  const preview = context?.regions_preview ?? [];
  return (["US", "EU", "TW", "JP"] as const).map((code) => {
    const p = preview.find((r) => r.region === code);
    return { code, level: p?.level ?? "baseline", change: "new", reason: p?.basis ?? BASELINE_REASON };
  });
}

// ── The page total ───────────────────────────────────────────────────────────────────────────────

export interface PageWordCount {
  /** The model fields "in the total" (modelWords()). */
  model: number;
  /** countWords(scriptText(view, metrics)). */
  script: number;
  total: number;
}

/** pageWords()'s parts. A Brief is its own view; a draft needs `inputs` for draftView(). */
export function pageWordCount(brief: Brief, metrics: Metrics | null, opts?: ScriptOptions): PageWordCount;
export function pageWordCount(brief: DraftBrief, metrics: Metrics | null, inputs: Omit<DraftViewInputs, "metrics">): PageWordCount;
export function pageWordCount(brief: AnyBrief, metrics: Metrics | null, extra?: ScriptOptions | Omit<DraftViewInputs, "metrics">): PageWordCount {
  let view: PageBrief;
  let opts: ScriptOptions = {};
  if (isBrief(brief)) {
    view = brief;
    opts = (extra as ScriptOptions | undefined) ?? {};
  } else {
    if (!extra || !("config" in extra)) throw new Error("pageWords() of a draft needs the draft inputs (config, context, cveList, regionsBase)");
    view = draftView(brief, { ...extra, metrics });
  }
  const model = modelWords(brief);
  const script = countWords(scriptText(view, metrics, opts));
  return { model, script, total: model + script };
}

/**
 * pageWords(brief, metrics) (§4.5): the countWords() sum of the model fields "in the total" plus
 * countWords(scriptText(brief, metrics)), stored as `computed.word_count`. Pass the metrics file the
 * brief's Gap shows. A draft's count is provisional (draftView()).
 */
export function pageWords(brief: Brief, metrics: Metrics | null, opts?: ScriptOptions): number;
export function pageWords(brief: DraftBrief, metrics: Metrics | null, inputs: Omit<DraftViewInputs, "metrics">): number;
export function pageWords(brief: AnyBrief, metrics: Metrics | null, extra?: ScriptOptions | Omit<DraftViewInputs, "metrics">): number {
  return (pageWordCount as (b: AnyBrief, m: Metrics | null, e?: unknown) => PageWordCount)(brief, metrics, extra).total;
}

// ── Rules ────────────────────────────────────────────────────────────────────────────────────────

/** The fix for a field over its budget: "Cut at least 7." */
const cut = (n: number) => `Cut at least ${n}.`;
const add = (n: number) => `Add at least ${n}.`;

const RATIO_HINT = ' Write a ratio as the Gap does, "1.9 times", never "1.9x": a number glued to x is not read as a number.';

function fieldIssues(b: AnyBrief, metrics: Metrics | null): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const f of wordFields(b)) {
    if (f.text === null) continue;
    const n = countWords(f.text);
    if (f.max !== null && n > f.max) {
      out.push(error("WORDS_OVER", f.path, `${f.label} has ${plural(n, "word")}${f.note}; the limit is ${f.max}. ${cut(n - f.max)}`));
    }
    if (f.min !== null && !f.withheld && n < f.min) {
      out.push(error("WORDS_UNDER", f.path, `${f.label} has ${plural(n, "word")}${f.note}; the minimum is ${f.min}. ${add(f.min - n)}`));
    }
  }
  const angle = b.angle;
  if (angle && !isMark(angle.text)) {
    const nums = angleNumbers(angle, metrics);
    const figures = angleFigures(angle, metrics);
    const notCounted = `Dates, years, CVE ids and version strings are not counted as numbers${
      !figures.length ? "."
        : metrics ? `, nor the figures the metric's label prints (${figureList(figures)}) the first time each is written.`
          : `, nor the Gap's window lengths (${figureList(figures)}) the first time each is written.`}`;
    // Only WORDS_OVER says a figure written again counts: WORDS_UNDER's Angle holds no number at all.
    const once = !figures.length ? "" : metrics ? " Write each label figure once: written again, it counts." : " Write each window length once: written again, it counts.";
    if (nums.length === 0) {
      out.push(error("WORDS_UNDER", "angle.text", "angle.text holds no number; the Angle states exactly one sourced number. Add the one number its source or metric gives.",
        `${notCounted}${gluedRatios(angle.text).length ? RATIO_HINT : ""}`));
    } else if (nums.length > 1) {
      out.push(error("WORDS_OVER", "angle.text",
        `angle.text holds ${nums.length} numbers (${nums.map((x) => x.raw).join(", ")}); the Angle states exactly one. Keep one and cut the other${nums.length > 2 ? "s" : ""}.`,
        `${notCounted}${once}`));
    }
  }
  return out;
}

/**
 * WORDS_OVER and WORDS_UNDER on each field of the word table (§4.12), and the Angle's one number, read by
 * angleNumbers() with the metrics when the run has them (a metric Angle's label figures are not counted).
 */
const wordBudgets = defineRule({
  code: ["WORDS_OVER", "WORDS_UNDER"],
  scope: "brief",
  check: ({ draft, metrics }) => fieldIssues(draft, metrics ?? null),
});

/**
 * WORDS_OVER on the page total: pageWords() above `budgets.words_max` (1,300). Needs the metrics the Gap
 * shows. The cap is in run.json, which can change after publish, so published mode checks it only on the
 * brief `validateAll(dir, { publishing: D })` names (§4.12 "Archived briefs"); an archived brief keeps the
 * per-field budgets, which are the spec's own.
 */
const pageTotal = defineRule({
  code: "WORDS_OVER",
  scope: "brief",
  needsMetrics: true,
  check: (input) => {
    const { draft, metrics, config, mode, crossFile } = input;
    if (mode === "published" && !crossFile?.publishing) return [];
    const max = config.run.budgets.words_max;
    const count = isBrief(draft) ? pageWordCount(draft, metrics) : pageWordCount(draft, metrics, input);
    if (count.total <= max) return [];
    const provisional = isBrief(draft) ? "" : " (provisional: publish recounts it with the CVE blocks and region rows it builds)";
    return [error("WORDS_OVER", "(root)",
      `The page has ${fmtInt(count.total)} counted words${provisional}: ${fmtInt(count.model)} in the written fields and ${fmtInt(count.script)} in script-written lines; the cap is ${fmtInt(max)}. ${cut(count.total - max)}`,
      "Cut the written fields: the longest summaries, why_it_matters lines, the Taiwan Lens analysis and rows, or drop the weakest Also-today item.")];
  },
});

// QUOTE_MAX_25 ────────────────────────────────────────────────────────────────────────────────────

/** Quoted spans in prose (§4.12): between “ and ”, or between straight double quotes. */
const SPAN_RES = [/“([^”]*)”/gu, /"([^"]*)"/gu];

/** The quoted spans in a prose text, in order. */
export function quotedSpans(text: string): string[] {
  const out: string[] = [];
  for (const re of SPAN_RES) for (const m of text.matchAll(re)) out.push(m[1]!);
  return out;
}

/** QUOTE_MAX_25: a quoted field over 25 words or blank (confidence_text may be null); a quoted span in prose over 25 words. */
const quoteMax = defineRule({
  code: "QUOTE_MAX_25",
  scope: "brief",
  check: ({ draft }) => {
    const out: ValidationIssue[] = [];
    for (const f of quotedFields(draft)) {
      const n = countWords(f.text);
      if (f.text.trim() === "") {
        out.push(error("QUOTE_MAX_25", f.path, `${f.path} is blank; quote the source's own words, at most ${QUOTE_MAX}.`,
          f.field.endsWith("confidence_text") ? "Use null only with confidence_level unstated." : null));
      } else if (n > QUOTE_MAX) {
        out.push(error("QUOTE_MAX_25", f.path, `${f.path} quotes ${plural(n, "word")}; the limit is ${QUOTE_MAX}. ${cut(n - QUOTE_MAX)}`,
          "Keep a verbatim stretch of the source: cut from either end, never inside it."));
      }
    }
    for (const f of proseFields(draft)) {
      for (const span of quotedSpans(f.text)) {
        const n = countWords(span);
        if (n > QUOTE_MAX) {
          const head = span.trim().split(/\s+/).slice(0, 6).join(" ");
          out.push(error("QUOTE_MAX_25", f.path, `${f.path} has a quotation of ${plural(n, "word")} ("${head} …"); the limit is ${QUOTE_MAX}. ${cut(n - QUOTE_MAX)}`,
            "Quote a shorter verbatim stretch, or paraphrase without quotation marks."));
        }
      }
    }
    return out;
  },
});

// BANNED_WORDS ────────────────────────────────────────────────────────────────────────────────────

const bannedRes = new Map<string, RegExp>();

/** The regex for one BANNED_WORDS entry: case-insensitive, on word boundaries, hyphens and spaces alike. */
export function bannedWordRe(entry: string): RegExp {
  let re = bannedRes.get(entry);
  if (!re) {
    const parts = entry.trim().split(/[\s\-‐‑]+/u).map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
    re = new RegExp(`(?<![\\p{L}\\p{N}])${parts.join("[\\s\\-‐‑]+")}(?![\\p{L}\\p{N}])`, "iu");
    bannedRes.set(entry, re);
  }
  return re;
}

/** The BANNED_WORDS entries a text holds, as written in the list. */
export function bannedWordsIn(text: string, list: readonly string[] = BANNED_WORDS): string[] {
  return list.filter((w) => bannedWordRe(w).test(text));
}

/** BANNED_WORDS (draft only: the list can change after publish): a prose field holds a banned word. Quoted fields and titles are exempt. */
const bannedWords = defineRule({
  code: "BANNED_WORDS",
  scope: "draft",
  check: ({ draft }) => proseFields(draft).flatMap((f) => bannedWordsIn(f.text).map((w) => {
    const found = bannedWordRe(w).exec(f.text)![0];
    return error("BANNED_WORDS", f.path, `${f.path} uses "${found}", a banned word (BANNED_WORDS). Replace it with a plain, measured word or the figure itself.`,
      "Banned words apply to our prose only; a source's words inside a quoted field are exempt.");
  })),
});

export const wordRules: Rule[] = [wordBudgets, pageTotal, quoteMax, bannedWords];
