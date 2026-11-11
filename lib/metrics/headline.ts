// The Gap headline (SPEC §5.8): gapHeadline() writes `headline.text`, secondLine() writes
// `headline.second_line`, and both record every number they print in `headline.quoted`; nothing else
// composes these sentences. Also here: footerLine(), the in-KEV line, the Taiwan Lens KEV line
// (re-exported from home-vendors.ts) and the display strings metricNumbers() reads (§4.12). Every number
// goes through a §5.2 helper; the reference figures are rendered from REFERENCE, never typed.

import { daysBetween } from "../dates";
import { shortDate } from "../format";
import type { AiCredited, GapHeadline, Metrics, WindowStats } from "../schema/metrics";
import { numbersIn, type NumberToken } from "../text";
import { MIN_N } from "../vocab";
import { kevLines } from "./home-vendors";
import { oldListedPace, REFERENCE } from "./reference";
import { fmt1, fmtDate, fmtDays, fmtInt, fmtPct, pct, roundTo } from "./stats";
import { pacePhrase } from "./window";

export { kevLine, kevLines, kevLineUnavailable } from "./home-vendors";

/** One `headline.quoted` entry: a metrics path (or "constant" for the window lengths 26 and 13) and the exact string shown. */
export type Quoted = GapHeadline["quoted"][number];
/** A sentence or line with the numbers it printed, in order. */
export interface Rendered {
  text: string;
  quoted: Quoted[];
}

/**
 * What the headline reads: the metrics file's blocks and values, with the two directions already set
 * (computeMetrics sets them in step 4, before the headline in step 6, §5.10; a stale Window keeps the
 * newest earlier file's directions, since the lags behind speedDirection are not in the file).
 */
export type HeadlineInput = Pick<Metrics, "date" | "blocks" | "window" | "flood" | "ai_credited"> & {
  headline: Pick<GapHeadline, "at_disclosure_direction" | "after_disclosure_direction">;
};

/** The whole headline when the Window failed with no earlier value. */
export const WINDOW_UNAVAILABLE = "The Window is not available today because CISA's list could not be read.";
/** The second line's clauses when a block failed with no earlier value. */
export const FLOOD_UNAVAILABLE = "Flood: not available today.";
export const AI_UNAVAILABLE = "AI-credited: not available today.";

/** "2023–24", with the en dash the spec writes. A range, not a number (numbersIn removes it). */
const REF_PERIOD = "2023–24";

const SHARE_WORDS = { higher: "higher", lower: "lower", no_clear_change: "no clear change" } as const;
const SPEED_WORDS = { faster: "faster", slower: "slower", no_clear_change: "no clear change" } as const;

/** Builds a sentence and its quoted numbers in one pass, so the two can never disagree. */
class Line {
  private parts: string[] = [];
  readonly quoted: Quoted[] = [];
  text(s: string): this {
    this.parts.push(s);
    return this;
  }
  num(path: string, display: string): this {
    this.parts.push(display);
    this.quoted.push({ path, display });
    return this;
  }
  done(): Rendered {
    return { text: this.parts.join(""), quoted: this.quoted };
  }
}

function join(lines: readonly Rendered[]): Rendered {
  return { text: lines.map((l) => l.text).join(" "), quoted: lines.flatMap((l) => l.quoted) };
}

function shareWord(d: GapHeadline["at_disclosure_direction"]): string {
  if (d === "n_too_small") throw new Error("gapHeadline: at_disclosure_direction is n_too_small but cohort_n is at least MIN_N");
  return SHARE_WORDS[d];
}

function speedWord(d: GapHeadline["after_disclosure_direction"]): string {
  if (d === "n_too_small") throw new Error("gapHeadline: after_disclosure_direction is n_too_small but after_disclosure_n is at least MIN_N");
  return SPEED_WORDS[d];
}

/** H1, either form (§5.8). */
function h1(w: WindowStats, m: HeadlineInput): Rendered {
  if (w.cohort_n < MIN_N) {
    return new Line()
      .text("Too few recently disclosed flaws reached CISA's exploited list in the ").num("constant", "26")
      .text(` weeks to ${fmtDate(w.to, m.date)} to compare with ${REF_PERIOD} (n=`).num("window.w26.cohort_n", fmtInt(w.cohort_n)).text(").")
      .done();
  }
  const ref = REFERENCE.window;
  return new Line()
    .num("window.w26.at_disclosure_share", `${pct(w.at_disclosure_n, w.cohort_n)}%`)
    .text(` of recently disclosed flaws on CISA's exploited list were already being exploited when disclosed (${REF_PERIOD}: `)
    .num("window.reference.at_disclosure_share", `${pct(ref.at_disclosure_n, ref.cohort_n)}%`)
    .text(`, ${shareWord(m.headline.at_disclosure_direction)}).`)
    .done();
}

/** H2, only after H1's first form (§5.8). */
function h2(w: WindowStats, m: HeadlineInput): Rendered | null {
  if (w.cohort_n < MIN_N) return null;
  if (w.after_disclosure_n < MIN_N || w.after_disclosure_median_days === null) {
    if (w.after_disclosure_n >= MIN_N) throw new Error("gapHeadline: after_disclosure_median_days is null but after_disclosure_n is at least MIN_N");
    return new Line()
      .text("Too few of the rest were confirmed to give a median (n=").num("window.w26.after_disclosure_n", fmtInt(w.after_disclosure_n)).text(").")
      .done();
  }
  return new Line()
    .text("For the rest, CISA confirmed exploitation after a median ")
    .num("window.w26.after_disclosure_median_days", fmtDays(w.after_disclosure_median_days))
    .text(` days (${REF_PERIOD}: `)
    .num("window.reference.after_disclosure_median_days", fmtDays(REFERENCE.window.after_disclosure_median_days))
    .text(`, ${speedWord(m.headline.after_disclosure_direction)}).`)
    .done();
}

/** H3, always (§5.8). A pace percentage ("12% above") is quoted with the path window.volume_ratio. */
function h3(w: WindowStats, kevPaceRatio: number): Rendered {
  const line = new Line()
    .num("window.w26.cohort_n", fmtInt(w.cohort_n)).text(" such flaws were listed in ").num("constant", "26").text(" weeks, ");
  const phrase = pacePhrase(w.cohort_n);
  const percent = /^(\d+)% (above|below)$/.exec(phrase);
  if (percent) line.num("window.volume_ratio", `${percent[1]}%`).text(` ${percent[2]}`);
  else line.text(phrase);
  return line
    .text(` the ${REF_PERIOD} pace (all CISA listings: `).num("window.kev_pace_ratio", fmt1(kevPaceRatio)).text(" times).")
    .done();
}

/**
 * `headline.text` (§5.8): up to three sentences from `window.w26` and the reference. A stale Window shows
 * the newest earlier values (the file's `window`) and ends " (Data to {fmtDate(as_of)} UTC; CISA's list
 * was not read today.)"; a null Window gives WINDOW_UNAVAILABLE.
 */
export function gapHeadline(m: HeadlineInput): Rendered {
  const win = m.window;
  if (!win) return { text: WINDOW_UNAVAILABLE, quoted: [] };
  const w = win.w26;
  const parts = [h1(w, m), h2(w, m), h3(w, win.kev_pace_ratio)].filter((p): p is Rendered => p !== null);
  const out = join(parts);
  if (m.blocks.window.status === "stale") {
    const asOf = m.blocks.window.as_of ?? w.to;
    out.text += ` (Data to ${fmtDate(asOf, m.date)} UTC; CISA's list was not read today.)`;
  }
  return out;
}

function staleLead(name: string, block: { status: string; as_of: string | null }, fallbackAsOf: string, date: string): string {
  return block.status === "stale" ? `${name}, as of ${fmtDate(block.as_of ?? fallbackAsOf, date)}:` : `${name}:`;
}

/** `headline.second_line` (§5.8): the Flood clause, then the AI-credited clause, each with its own fallback. */
export function secondLine(m: Pick<Metrics, "date" | "blocks" | "flood" | "ai_credited">): Rendered {
  const parts: Rendered[] = [];
  const f = m.flood;
  if (!f) parts.push({ text: FLOOD_UNAVAILABLE, quoted: [] });
  else {
    parts.push(new Line()
      .text(`${staleLead("Flood", m.blocks.flood, f.to, m.date)} `).num("flood.n", fmtInt(f.n)).text(" new CVE records in ").num("constant", "13")
      .text(" weeks, ").num("flood.vs_reference_ratio", fmt1(f.vs_reference_ratio)).text(` times the ${REF_PERIOD} pace (`)
      .num("flood.vs_reference_ex_kernel_ratio", fmt1(f.vs_reference_ex_kernel_ratio)).text(" times excluding the Linux kernel).")
      .done());
  }
  const a = m.ai_credited;
  if (!a) parts.push({ text: AI_UNAVAILABLE, quoted: [] });
  else {
    parts.push(new Line()
      .text(`${staleLead("AI-credited", m.blocks.ai_credited, a.to, m.date)} `).num("ai_credited.w13.total", fmtInt(a.w13.total)).text(" in ")
      .num("constant", "13").text(" weeks, ").num("ai_credited.w13.ex_anthropic", fmtInt(a.w13.ex_anthropic))
      .text(" excluding Anthropic (a lower bound).")
      .done());
  }
  return join(parts);
}

/**
 * The metrics file's `headline` (§4.7): text and second line with every number they print in
 * `quoted`, in order (text first), and the two directions as given.
 */
export function composeHeadline(m: HeadlineInput): GapHeadline {
  const text = gapHeadline(m);
  const second = secondLine(m);
  return {
    text: text.text,
    second_line: second.text,
    at_disclosure_direction: m.headline.at_disclosure_direction,
    after_disclosure_direction: m.headline.after_disclosure_direction,
    quoted: [...text.quoted, ...second.quoted],
  };
}

/**
 * The Gap footer (§5.8; rendered through gapFooter() in lib/page-text.ts, not stored): "data to 6 Nov 2026
 * UTC · KEV catalog 2026.11.06 · CVE List cve_2026-11-06_2100Z · AI-finder list v1". The AI-finder
 * version is the AI block's own, else the run's config version when that block is null.
 */
export function footerLine(m: Pick<Metrics, "data_cutoff_utc" | "provenance" | "ai_credited">): string {
  const finders = m.ai_credited?.finders_version ?? m.provenance.config_versions.ai_finders;
  return [
    `data to ${shortDate(m.data_cutoff_utc)} UTC`,
    `KEV catalog ${m.provenance.kev_catalog_version}`,
    `CVE List ${m.provenance.cve_list_release}`,
    `AI-finder list v${finders}`,
  ].join(" · ");
}

/**
 * The in-KEV line under chart C (§5.5, §7): the head "AI-credited and now on CISA's list: {n} since 1 Jan
 * 2025", then one line per entry "{CVE id}: {matched} ({finder id}), listed {fmtDate(kev_date_added)}
 * (US date)", in the file's order. The finder is named by its id, which the metrics file freezes (as
 * Appendix D.7 shows it), so a rename in config/ai-finders.json never changes an archived page, its word
 * count or the numbers the validator reads from it; the page (chartCaptions()) and metricDisplays() both
 * render this one form.
 */
export function inKevLine(ai: Pick<AiCredited, "in_kev">, editionDate: string): { head: string; entries: string[] } {
  return {
    head: `AI-credited and now on CISA's list: ${fmtInt(ai.in_kev.n)} since ${shortDate(ai.in_kev.since)}`,
    entries: ai.in_kev.entries.map((e) =>
      `${e.cve_id}: ${e.matched} (${e.finder_id}), listed ${fmtDate(e.kev_date_added, editionDate)} (US date)`),
  };
}

// ── Display strings (§4.12 metricNumbers) ────────────────────────────────────────────────────────

/** One number the Gap shows: the metrics path it comes from, what it is, and the exact string shown. */
export interface GapDisplay {
  key: string;
  label: string;
  display: string;
}

/** The Gap's two window lengths as its labels write them; the headline prints them as constants (`headline.quoted` path "constant"). */
export const WINDOW_LENGTHS = ["26 weeks", "13 weeks"] as const;

const WINDOW_COLUMNS = [
  ["w26", WINDOW_LENGTHS[0]],
  ["w13", WINDOW_LENGTHS[1]],
  ["reference", REF_PERIOD],
] as const;

/**
 * Every display string of the Gap data table (§5.3), column by column (26 weeks, 13 weeks, 2023–24):
 * counts with fmtInt, shares with pct() from the counts, interval bounds with fmtPct or fmtDays, the
 * 26-week KEV pace with fmt1, and the 2023–24 pace of old flaws for each window's length. Shares,
 * medians and intervals below MIN_N are not shown, so they are not listed. Each key names one row
 * (§0.4 row 145): a row with no field of its own in the metrics file has a key of its own
 * (`window.<col>.late_listed_n`, `window.<col>.n_day_share`, `window.reference.old_listed_pace_26w` and
 * `_13w`), so a path never stands for another row's number. Every label names its window or 2023–24.
 */
export function gapTableDisplays(win: NonNullable<Metrics["window"]>): GapDisplay[] {
  const out: GapDisplay[] = [];
  const add = (key: string, label: string, display: string) => out.push({ key, label, display });
  for (const [col, name] of WINDOW_COLUMNS) {
    const w = win[col];
    const p = `window.${col}`;
    add(`${p}.kev_added_n`, `KEV additions, ${name}`, fmtInt(w.kev_added_n));
    if (col === "w26") add("window.kev_pace_ratio", `KEV additions, pace vs ${REF_PERIOD}, ${name}`, fmt1(win.kev_pace_ratio));
    add(`${p}.unjoined_n`, `not joined to a CVE record, ${name}`, fmtInt(w.unjoined_n));
    add(`${p}.cohort_n`, `recently disclosed flaws on CISA's list, ${name}`, fmtInt(w.cohort_n));
    add(`${p}.at_disclosure_n`, `already exploited at disclosure, ${name}`, fmtInt(w.at_disclosure_n));
    if (w.cohort_n >= MIN_N) {
      add(`${p}.at_disclosure_share`, `share already exploited at disclosure, ${name}`, `${pct(w.at_disclosure_n, w.cohort_n)}%`);
      if (w.at_disclosure_ci80) {
        add(`${p}.at_disclosure_ci80.0`, `80% interval low, at disclosure, ${name}`, fmtPct(w.at_disclosure_ci80[0]));
        add(`${p}.at_disclosure_ci80.1`, `80% interval high, at disclosure, ${name}`, fmtPct(w.at_disclosure_ci80[1]));
      }
    }
    add(`${p}.n_day_n`, `n-day race (listed 2 to 30 days after), ${name}`, fmtInt(w.n_day_n));
    if (w.cohort_n >= MIN_N) add(`${p}.n_day_share`, `n-day race share (listed 2 to 30 days after), ${name}`, `${pct(w.n_day_n, w.cohort_n)}%`);
    add(`${p}.late_listed_n`, `listed 31 to 365 days after, ${name}`, fmtInt(w.cohort_n - w.at_disclosure_n - w.n_day_n));
    if (w.after_disclosure_median_days !== null) {
      add(`${p}.after_disclosure_median_days`, `median days to listing for the rest, ${name}`, fmtDays(w.after_disclosure_median_days));
      if (w.after_disclosure_median_ci80) {
        add(`${p}.after_disclosure_median_ci80.0`, `80% interval low, median days, ${name}`, fmtDays(w.after_disclosure_median_ci80[0]));
        add(`${p}.after_disclosure_median_ci80.1`, `80% interval high, median days, ${name}`, fmtDays(w.after_disclosure_median_ci80[1]));
      }
    }
    add(`${p}.k7_n`, `listed within 7 days, ${name}`, fmtInt(w.k7_n));
    if (w.cohort_n >= MIN_N) {
      add(`${p}.p7`, `share listed within 7 days, ${name}`, `${pct(w.k7_n, w.cohort_n)}%`);
      if (w.p7_ci80) {
        add(`${p}.p7_ci80.0`, `80% interval low, listed within 7 days, ${name}`, fmtPct(w.p7_ci80[0]));
        add(`${p}.p7_ci80.1`, `80% interval high, listed within 7 days, ${name}`, fmtPct(w.p7_ci80[1]));
      }
    }
    add(`${p}.old_listed_n`, `old flaws newly listed (more than 365 days), ${name}`, fmtInt(w.old_listed_n));
    if (col !== "reference") {
      const days = daysBetween(w.from, w.to) + 1;
      add(`window.reference.old_listed_pace_${col === "w26" ? "26w" : "13w"}`, `${REF_PERIOD} pace of old flaws newly listed, ${name}`,
        fmtInt(roundTo(oldListedPace(days), 0)));
    }
  }
  return out;
}

// ── Quotable rows (§4.15 metrics.quotable) ───────────────────────────────────────────────────────

/**
 * Labels for the paths `headline.quoted` uses (§5.8); a path not listed is its own label. Each names its
 * window ("…, 26 weeks", "…, 13 weeks") or 2023–24, as the data table's labels do (§0.4 row 145).
 */
export const QUOTED_LABELS: Readonly<Record<string, string>> = {
  constant: "weeks in the window",
  "window.w26.at_disclosure_share": "share already exploited at disclosure, 26 weeks",
  "window.reference.at_disclosure_share": "share already exploited at disclosure, 2023–24",
  "window.w26.after_disclosure_median_days": "median days to listing for the rest, 26 weeks",
  "window.reference.after_disclosure_median_days": "median days to listing for the rest, 2023–24",
  "window.w26.after_disclosure_n": "flaws listed after disclosure, 26 weeks",
  "window.w26.cohort_n": "recently disclosed flaws on CISA's list, 26 weeks",
  "window.kev_pace_ratio": "KEV additions, pace vs 2023–24, 26 weeks",
  "window.volume_ratio": "recently disclosed flaws listed, pace vs 2023–24, 26 weeks",
  "flood.n": "new CVE records, 13 weeks",
  "flood.vs_reference_ratio": "new CVE records, pace vs 2023–24, 13 weeks",
  "flood.vs_reference_ex_kernel_ratio": "new CVE records excluding the Linux kernel, pace vs 2023–24, 13 weeks",
  "ai_credited.w13.total": "AI-credited records, 13 weeks",
  "ai_credited.w13.ex_anthropic": "AI-credited records excluding Anthropic, 13 weeks",
};

/** One row of `metrics.quotable` before its `as_of`: a metrics path (or "constant"), what it is, and the exact string shown. */
export type QuotableRow = GapDisplay;

/**
 * The rows of `metrics.quotable` (§4.15), without `as_of`: every number the Gap headline and second line
 * quote (`headline.quoted`, labelled by QUOTED_LABELS), then every Gap data table display
 * (gapTableDisplays()), then the Taiwan Lens KEV counts, each with its exact display string. A key and
 * display pair is listed once (the first label wins), and an empty display is left out. lib/context.ts
 * and fixtures/src/inputs.ts both build the context's list from it.
 */
export function quotableRows(m: Pick<Metrics, "date" | "headline" | "window" | "home_vendors">): QuotableRow[] {
  const out: QuotableRow[] = [];
  const seen = new Set<string>();
  const add = (key: string, label: string, display: string) => {
    const k = `${key}\0${display}`;
    if (seen.has(k) || display.trim() === "") return;
    seen.add(k);
    out.push({ key, label, display });
  };
  for (const q of m.headline.quoted) add(q.path, QUOTED_LABELS[q.path] ?? q.path, q.display);
  if (m.window) for (const d of gapTableDisplays(m.window)) add(d.key, d.label, d.display);
  const lines = kevLines(m);
  for (const key of ["tw", "jp"] as const) {
    const word = key === "tw" ? "Taiwanese" : "Japanese";
    add(`home_vendors.${key}.d30_n`, `KEV additions for ${word} vendors, 30 days`, String(lines[key].d30_n));
    add(`home_vendors.${key}.d90_n`, `KEV additions for ${word} vendors, 90 days`, String(lines[key].d90_n));
  }
  return out;
}

/**
 * The strings metricNumbers() parses (§5.8, §4.12): `headline.quoted[].display`, every display string
 * of the Gap data table, the in-KEV line and the Taiwan Lens KEV lines, all from the §5.2 helpers.
 */
export function metricDisplays(metrics: Metrics): string[] {
  const out = metrics.headline.quoted.map((q) => q.display);
  if (metrics.window) out.push(...gapTableDisplays(metrics.window).map((d) => d.display));
  if (metrics.ai_credited) {
    const line = inKevLine(metrics.ai_credited, metrics.date);
    out.push(line.head, ...line.entries);
  }
  const lens = kevLines(metrics);
  out.push(lens.tw.text, lens.jp.text);
  return out;
}

/** §4.12's metricNumbers(metrics): the numbers in metricDisplays(), read with numbersIn(). Matching against them is exact. */
export function metricNumbers(metrics: Metrics): NumberToken[] {
  return metricDisplays(metrics).flatMap((s) => numbersIn(s));
}
