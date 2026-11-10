// content/state/series.json and metrics.series (SPEC §5.9, §4.7): one point per ISO week from 2023-01-02.
// Pure. Flood fields are frozen once written; the Window and KEV fields of every week are recomputed from
// the KEV join on every run (a re-joined row changes past weeks); the AI fields of every week are
// rewritten on every run (ruling R5). The series stops at the last week whose 13-week days are all in
// days.json (ruling R18), and metrics.series is its last 104 weeks.

import { addDays, inRange, isoWeekStart, newestCompleteWeek } from "../dates";
import { byCodeUnit } from "../ids";
import { SERIES_WEEKS, type AiCreditsFile, type DayRow, type Series, type SeriesFile } from "../schema/metrics";
import { aiWeekly } from "./ai-credit";
import { DAYS_FROM } from "./flood";
import { bandOf, windowStats, type JoinRow } from "./window";

/** The first Monday of the series. */
export const SERIES_FROM = "2023-01-02";

export interface SeriesSources {
  days: ReadonlyMap<string, DayRow>;
  rows: readonly JoinRow[];
  credits: AiCreditsFile;
  /** Taipei dates of data-only editions. */
  dataOnlyDates: readonly string[];
}

/** The fields a week's rolling windows cover (§5.9): 13 weeks for the Flood, 26 for the Window. */
const FLOOD_BACK = -84;
const WINDOW_BACK = -175;

/** The Flood fields of the week starting `m`: null when its 13 weeks start before 2023-01-01. Throws on a missing day. */
function floodPoint(m: string, days: ReadonlyMap<string, DayRow>): { n: number | null; kernel: number | null } {
  const from = addDays(m, FLOOD_BACK);
  if (from < DAYS_FROM) return { n: null, kernel: null };
  let n = 0;
  let kernel = 0;
  for (let d = from, to = addDays(m, 6); d <= to; d = addDays(d, 1)) {
    const r = days.get(d);
    if (!r) throw new Error(`floodPoint: ${d} is missing`);
    n += r[1];
    kernel += r[2];
  }
  return { n, kernel };
}

/** True when every day the week starting `m` needs (its 13 weeks, from 2023-01-01) is in `days`. */
function weekComplete(m: string, days: ReadonlyMap<string, DayRow>): boolean {
  const from = addDays(m, FLOOD_BACK) < DAYS_FROM ? DAYS_FROM : addDays(m, FLOOD_BACK);
  for (let d = from, to = addDays(m, 6); d <= to; d = addDays(d, 1)) if (!days.has(d)) return false;
  return true;
}

type WindowFields = Pick<Series,
  "window_at_disclosure_share" | "window_at_disclosure_ci80" | "window_after_median" | "window_after_median_ci80" |
  "kev_recent_weekly" | "kev_weekly"> & { window_cohort_n: (number | null)[] };

/** The Window and KEV fields for each Monday: windowStats() over its 26 weeks (null before 2023-06-26), and that week's listings. */
function windowFields(weeks: readonly string[], rows: readonly JoinRow[]): WindowFields {
  const out: WindowFields = {
    window_at_disclosure_share: [], window_at_disclosure_ci80: [], window_after_median: [], window_after_median_ci80: [],
    window_cohort_n: [], kev_recent_weekly: [], kev_weekly: [],
  };
  for (const m of weeks) {
    const end = addDays(m, 6);
    const from = addDays(m, WINDOW_BACK);
    if (from < DAYS_FROM) {
      out.window_at_disclosure_share.push(null);
      out.window_at_disclosure_ci80.push(null);
      out.window_after_median.push(null);
      out.window_after_median_ci80.push(null);
      out.window_cohort_n.push(null);
    } else {
      const s = windowStats(rows, from, end);
      out.window_at_disclosure_share.push(s.at_disclosure_share);
      out.window_at_disclosure_ci80.push(s.at_disclosure_ci80);
      out.window_after_median.push(s.after_disclosure_median_days);
      out.window_after_median_ci80.push(s.after_disclosure_median_ci80);
      out.window_cohort_n.push(s.cohort_n);
    }
    let all = 0;
    let recent = 0;
    for (const r of rows) {
      if (!inRange(r.date_added, m, end)) continue;
      all++;
      const band = bandOf(r.lag_days);
      if (band !== "unjoined" && band !== "old") recent++;
    }
    out.kev_weekly.push(all);
    out.kev_recent_weekly.push(recent);
  }
  return out;
}

/** The Mondays of the data-only editions, inside `weeks`, ascending. */
function dataOnlyWeeks(weeks: readonly string[], dates: readonly string[], prev: readonly string[] = []): string[] {
  const inSeries = new Set(weeks);
  return [...new Set([...prev, ...dates.map(isoWeekStart)])].filter((w) => inSeries.has(w)).sort(byCodeUnit);
}

/** Every Monday from `from` to `to`, both included. */
function mondays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addDays(m, 7)) out.push(m);
  return out;
}

/** Assembles the file: the frozen Flood columns as given, everything else recomputed for `weeks`. */
function assemble(
  weeks: string[],
  flood: { n13: (number | null)[]; kernel: (number | null)[]; yearAgo: (number | null)[] },
  src: SeriesSources,
  cutoff: string,
  liveFrom: string,
  prevDataOnly: readonly string[] = [],
): SeriesFile {
  const win = windowFields(weeks, src.rows);
  const ai = aiWeekly(src.credits, weeks);
  return {
    schema_version: 1,
    updated_at: cutoff,
    weeks,
    live_from: liveFrom,
    flood_n13: flood.n13,
    flood_n13_kernel: flood.kernel,
    flood_n13_year_ago: flood.yearAgo,
    window_at_disclosure_share: win.window_at_disclosure_share,
    window_at_disclosure_ci80: win.window_at_disclosure_ci80,
    window_after_median: win.window_after_median,
    window_after_median_ci80: win.window_after_median_ci80,
    window_cohort_n: win.window_cohort_n,
    kev_recent_weekly: win.kev_recent_weekly,
    kev_weekly: win.kev_weekly,
    ai_weekly: ai.ai_weekly,
    ai_ledger_only_weekly: ai.ai_ledger_only_weekly,
    data_only_weeks: dataOnlyWeeks(weeks, src.dataOnlyDates, prevDataOnly),
  };
}

/** Appends Flood points for the Mondays in `add` to the columns, stopping at the first incomplete week; returns the weeks added. */
function appendFlood(
  cols: { weeks: string[]; n13: (number | null)[]; kernel: (number | null)[]; yearAgo: (number | null)[] },
  add: readonly string[],
  days: ReadonlyMap<string, DayRow>,
): void {
  const at = new Map(cols.weeks.map((w, i) => [w, i]));
  for (const m of add) {
    if (!weekComplete(m, days)) return;
    const p = floodPoint(m, days);
    const back = at.get(addDays(m, -364));
    cols.weeks.push(m);
    cols.n13.push(p.n);
    cols.kernel.push(p.kernel);
    cols.yearAgo.push(back === undefined ? null : cols.n13[back] ?? null);
    at.set(m, cols.weeks.length - 1);
  }
}

/**
 * series.json from SERIES_FROM to the newest complete week of `cutoff` (the backfill and tests), stopping
 * early at the first week whose 13-week days are not all in `days`. `liveFrom` is the caller's
 * (liveFromAfter(cutoff) for a build, ruling R19).
 */
export function weeklySeries(src: SeriesSources, cutoff: string, liveFrom: string): SeriesFile {
  const cols = { weeks: [] as string[], n13: [] as (number | null)[], kernel: [] as (number | null)[], yearAgo: [] as (number | null)[] };
  appendFlood(cols, mondays(SERIES_FROM, newestCompleteWeek(cutoff)), src.days);
  return assemble(cols.weeks, cols, src, cutoff, liveFrom);
}

/**
 * A morning's series (§5.9): every existing week keeps its Flood fields (frozen, the year-ago value
 * included); each newly complete week up to newestCompleteWeek(cutoff) is appended in order, stopping at
 * the first whose 13-week days are not all present (ruling R18); the Window and KEV fields of every week
 * are recomputed from `rows`, and every AI week is rewritten (ruling R5). live_from is kept.
 */
export function extendSeries(prev: SeriesFile, src: SeriesSources, cutoff: string): SeriesFile {
  const cols = { weeks: [...prev.weeks], n13: [...prev.flood_n13], kernel: [...prev.flood_n13_kernel], yearAgo: [...prev.flood_n13_year_ago] };
  const last = cols.weeks.at(-1);
  appendFlood(cols, mondays(last ? addDays(last, 7) : SERIES_FROM, newestCompleteWeek(cutoff)), src.days);
  return assemble(cols.weeks, cols, src, cutoff, prev.live_from, prev.data_only_weeks);
}

/** The file cut to its weeks on or before `lastWeek` (a rerun for an earlier date never shows later weeks). */
export function seriesUpTo(file: SeriesFile, lastWeek: string): SeriesFile {
  const n = file.weeks.filter((w) => w <= lastWeek).length;
  if (n === file.weeks.length) return file;
  const cut = <T>(xs: readonly T[]): T[] => xs.slice(0, n);
  return {
    ...file,
    weeks: cut(file.weeks),
    flood_n13: cut(file.flood_n13), flood_n13_kernel: cut(file.flood_n13_kernel), flood_n13_year_ago: cut(file.flood_n13_year_ago),
    window_at_disclosure_share: cut(file.window_at_disclosure_share), window_at_disclosure_ci80: cut(file.window_at_disclosure_ci80),
    window_after_median: cut(file.window_after_median), window_after_median_ci80: cut(file.window_after_median_ci80),
    window_cohort_n: cut(file.window_cohort_n), kev_recent_weekly: cut(file.kev_recent_weekly), kev_weekly: cut(file.kev_weekly),
    ai_weekly: { anthropic: cut(file.ai_weekly.anthropic), openai: cut(file.ai_weekly.openai), google: cut(file.ai_weekly.google), other: cut(file.ai_weekly.other) },
    ai_ledger_only_weekly: cut(file.ai_ledger_only_weekly),
    data_only_weeks: file.data_only_weeks.filter((w) => w <= lastWeek),
  };
}

function nonNull(xs: readonly (number | null)[], name: string, weeks: readonly string[]): number[] {
  return xs.map((x, i) => {
    if (x === null) throw new Error(`seriesSlice: ${name} is null in week ${weeks[i]}`);
    return x;
  });
}

/** metrics.series: the last `weeks` (default 104) of series.json; throws if fewer, or if a Flood or Window count there is null. */
export function seriesSlice(file: SeriesFile, weeks: number = SERIES_WEEKS): Series {
  const n = file.weeks.length;
  if (n < weeks) throw new Error(`seriesSlice: series.json has ${n} weeks; ${weeks} are needed`);
  const s = <T>(xs: readonly T[]): T[] => xs.slice(n - weeks);
  const w = s(file.weeks);
  return {
    weeks: w,
    live_from: file.live_from,
    flood_n13: nonNull(s(file.flood_n13), "flood_n13", w),
    flood_n13_kernel: nonNull(s(file.flood_n13_kernel), "flood_n13_kernel", w),
    flood_n13_year_ago: s(file.flood_n13_year_ago),
    window_at_disclosure_share: s(file.window_at_disclosure_share),
    window_at_disclosure_ci80: s(file.window_at_disclosure_ci80),
    window_after_median: s(file.window_after_median),
    window_after_median_ci80: s(file.window_after_median_ci80),
    window_cohort_n: nonNull(s(file.window_cohort_n), "window_cohort_n", w),
    kev_recent_weekly: s(file.kev_recent_weekly),
    kev_weekly: s(file.kev_weekly),
    ai_weekly: { anthropic: s(file.ai_weekly.anthropic), openai: s(file.ai_weekly.openai), google: s(file.ai_weekly.google), other: s(file.ai_weekly.other) },
    ai_ledger_only_weekly: s(file.ai_ledger_only_weekly),
    data_only_weeks: file.data_only_weeks.filter((d) => d >= w[0]!),
  };
}

/** live_from for a build to `cutoff` (ruling R19): addDays(isoWeekStart(cutoff), 7). */
export function liveFromAfter(cutoff: string): string {
  return addDays(isoWeekStart(cutoff), 7);
}
