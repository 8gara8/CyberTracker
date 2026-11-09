// The Flood (SPEC §5.4) and content/state/days.json: new CVE records per UTC day, the kernel's share and
// the unscored count. Pure. A record counts once, on the UTC date of its datePublished, if it is PUBLISHED
// when the day is counted; kernel: assignerShortName exactly "Linux"; unscored: no CVSS v4.0, v3.1 or v3.0
// base score from the CNA or CISA ADP (CveFacts.scored).

import { addDays, daysBetween, inRange, newestCompleteWeek, windowEnding } from "../dates";
import type { CveFacts } from "../feeds/types";
import { byCodeUnit } from "../ids";
import { sha256Hex } from "../json";
import type { DayRow, Flood } from "../schema/metrics";
import { MIN_N } from "../vocab";
import { FLOOD_REFERENCE_W13, FLOOD_REFERENCE_W13_EX_KERNEL } from "./reference";
import { round4, roundTo } from "./stats";

/** The first UTC day days.json holds (§4.7). */
export const DAYS_FROM = "2023-01-01";
/** The kernel's assigner short name, case as written (§5.4). */
export const KERNEL_ASSIGNER = "Linux";

type DayFacts = Pick<CveFacts, "cve_id" | "state" | "date_published" | "assigner" | "scored">;

/** SHA-256 of the ids in code-unit order joined by "\n" (ruling R16); sha256("") for none. */
export function idsSha256(ids: readonly string[]): string {
  return sha256Hex([...ids].sort(byCodeUnit).join("\n"));
}

/** One copy per CVE id, the last one winning (a later zip holds the newer copy). */
function lastCopies<T extends { cve_id: string }>(records: Iterable<T>): T[] {
  const out = new Map<string, T>();
  for (const r of records) out.set(r.cve_id, r);
  return [...out.values()];
}

function rowOf(day: string, recs: readonly DayFacts[]): DayRow {
  let kernel = 0;
  let unscored = 0;
  for (const r of recs) {
    if (r.assigner === KERNEL_ASSIGNER) kernel++;
    if (!r.scored) unscored++;
  }
  return [day, recs.length, kernel, unscored, idsSha256(recs.map((r) => r.cve_id))];
}

const counts = (r: DayFacts): boolean => r.state === "PUBLISHED" && r.date_published !== null;

/** The days.json row for `day`: PUBLISHED records with date_published === day (the last copy of an id counts). */
export function countDay(day: string, records: Iterable<DayFacts>): DayRow {
  return rowOf(day, lastCopies(records).filter((r) => counts(r) && r.date_published === day));
}

/** The ids countDay() counted for `day`, in code-unit order (the manifest's `new_days`). */
export function dayIds(day: string, records: Iterable<DayFacts>): string[] {
  return lastCopies(records).filter((r) => counts(r) && r.date_published === day).map((r) => r.cve_id).sort(byCodeUnit);
}

/** Every calendar day in [from, to], zero days included ([d, 0, 0, 0, sha256("")]), from records grouped once. */
export function countDays(from: string, to: string, records: readonly DayFacts[]): DayRow[] {
  const byDay = new Map<string, DayFacts[]>();
  for (const r of lastCopies(records)) {
    if (!counts(r) || !inRange(r.date_published!, from, to)) continue;
    const list = byDay.get(r.date_published!);
    if (list) list.push(r);
    else byDay.set(r.date_published!, [r]);
  }
  const out: DayRow[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(rowOf(d, byDay.get(d) ?? []));
  return out;
}

/**
 * More missed days than this and the morning run counts none (§8.4): the backfill's --catch-up fills them.
 * It is also the length of the catch-up range below, the only days collect plans and the metrics count.
 */
export const CATCH_UP_DAYS = 25;

/** The catch-up range (§5.4, §8.3): the CATCH_UP_DAYS UTC days ending at the cutoff, none before DAYS_FROM. */
export function catchUpRange(cutoff: string, length: number = CATCH_UP_DAYS): { from: string; to: string } {
  const from = addDays(cutoff, -(length - 1));
  return { from: from < DAYS_FROM ? DAYS_FROM : from, to: cutoff };
}

/** True when the newest counted day is more than CATCH_UP_DAYS before the cutoff (or nothing is counted): the morning counts no day. */
export function inCatchUp(newest: string | null, cutoff: string, length: number = CATCH_UP_DAYS): boolean {
  return newest === null || daysBetween(newest, cutoff) > length;
}

/** The days in [from, to] that `days` lacks, oldest first. */
export function missingDays(days: ReadonlyMap<string, DayRow>, from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!days.has(d)) out.push(d);
  return out;
}

/** days.json rows by date. */
export function dayMap(rows: readonly DayRow[]): Map<string, DayRow> {
  return new Map(rows.map((r) => [r[0], r]));
}

function sums(days: ReadonlyMap<string, DayRow>, from: string, to: string): { n: number; kernel_n: number; unscored_n: number } {
  let n = 0, kernel = 0, unscored = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const r = days.get(d);
    if (!r) continue;
    n += r[1];
    kernel += r[2];
    unscored += r[3];
  }
  return { n, kernel_n: kernel, unscored_n: unscored };
}

/** The year-ago window of a window: both ends shifted −364 days (52 weeks, same weekdays, §5.1). */
export function yearAgo(w: { from: string; to: string }): { from: string; to: string } {
  return { from: addDays(w.from, -364), to: addDays(w.to, -364) };
}

/**
 * metrics.flood from days.json (§5.4): w13 = windowEnding(cutoff, 91), its year-ago window and the newest
 * complete ISO week. When any of their days is absent, `flood` is null and `missing` lists those dates
 * (the block goes stale, never a silent undercount). yoy percentages are null below MIN_N in the year-ago
 * denominator; percentages are stored at 1 dp and ratios at 4 dp from the exact reference paces.
 */
export function floodStats(days: ReadonlyMap<string, DayRow>, cutoff: string): { flood: Flood | null; missing: string[] } {
  const w = windowEnding(cutoff, 91);
  const ya = yearAgo(w);
  const weekStart = newestCompleteWeek(cutoff);
  const weekEnd = addDays(weekStart, 6);
  const missing = [...new Set([...missingDays(days, ya.from, ya.to), ...missingDays(days, w.from, w.to), ...missingDays(days, weekStart, weekEnd)])].sort(byCodeUnit);
  if (missing.length) return { flood: null, missing };

  const cur = sums(days, w.from, w.to);
  const old = sums(days, ya.from, ya.to);
  const week = sums(days, weekStart, weekEnd);
  const ex = cur.n - cur.kernel_n;
  const oldEx = old.n - old.kernel_n;
  const pct = (x: number) => roundTo((x - 1) * 100, 1);
  return {
    flood: {
      from: w.from,
      to: w.to,
      n: cur.n,
      kernel_n: cur.kernel_n,
      ex_kernel_n: ex,
      unscored_n: cur.unscored_n,
      year_ago: { from: ya.from, to: ya.to, n: old.n, kernel_n: old.kernel_n, ex_kernel_n: oldEx },
      yoy_pct: old.n >= MIN_N ? pct(cur.n / old.n) : null,
      yoy_ex_kernel_pct: oldEx >= MIN_N ? pct(ex / oldEx) : null,
      reference: { w13_mean_n: roundTo(FLOOD_REFERENCE_W13, 1), w13_mean_ex_kernel_n: roundTo(FLOOD_REFERENCE_W13_EX_KERNEL, 1) },
      vs_reference_pct: pct(cur.n / FLOOD_REFERENCE_W13),
      vs_reference_ex_kernel_pct: pct(ex / FLOOD_REFERENCE_W13_EX_KERNEL),
      vs_reference_ratio: round4(cur.n / FLOOD_REFERENCE_W13),
      vs_reference_ex_kernel_ratio: round4(ex / FLOOD_REFERENCE_W13_EX_KERNEL),
      last_week: { week_start: weekStart, n: week.n, kernel_n: week.kernel_n, unscored_n: week.unscored_n },
    },
    missing: [],
  };
}
