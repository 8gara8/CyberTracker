// SPEC §7 "GapPanel and charts", Chart conventions: the shared geometry of the three Gap charts. viewBox 0 0
// 400 H, margins { l: 40, r: 56, t: 8, b: 16 }, plot 304 x 84 (H 108; the Window bar strip 36, H 60); week i
// at x = l + (i + 0.5) x 304 / weeks.length; a date goes to its ISO week, floor((dayIndex(date) -
// dayIndex(weeks[0])) / 7); three y ticks topped by niceMax (the next 1, 2 or 5 x 10^n). Pure; the axis
// text helpers (fmtTick, shareShown) follow §5.2's display rules. Owner: gap lane.
import { MIN_N } from "@/lib/vocab";
import { fmtInt, fmtPct, pct } from "@/lib/metrics/stats";

/** The viewBox width, the margins and the plot sizes (§7). */
export const W = 400;
export const M = { l: 40, r: 56, t: 8, b: 16 } as const;
export const PLOT_W = W - M.l - M.r; // 304
/** A line chart's plot height and viewBox height. */
export const PLOT_H = 84;
export const H = M.t + PLOT_H + M.b; // 108
/** The Window's bar strip (row 3): plot 36 high, viewBox 60. */
export const STRIP_H = 36;
export const STRIP_VIEW_H = M.t + STRIP_H + M.b; // 60
/** The right end of the plot, where direct labels start. */
export const PLOT_RIGHT = M.l + PLOT_W; // 344

/** Days since 1970-01-01 of a "YYYY-MM-DD" date (UTC calendar days). */
export function dayIndex(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

/** The next 1, 2 or 5 x 10^n at or above `v` (1 for 0 or less). */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export interface WeekScale {
  /** The x of week i's centre. */
  x(i: number): number;
  /** The week index a date falls in, or null when it is off the axis. */
  weekOf(date: string): number | null;
  /** The width of one week. */
  step: number;
}

/** The shared x-axis over `weeks` (ISO-week Mondays, oldest first). */
export function weekScale(weeks: readonly string[], left = 40, width = 304): WeekScale {
  const step = width / Math.max(weeks.length, 1);
  const first = weeks.length ? dayIndex(weeks[0]!) : 0;
  return {
    step,
    x: (i: number) => left + (i + 0.5) * step,
    weekOf: (date: string) => {
      if (!weeks.length) return null;
      const i = Math.floor((dayIndex(date) - first) / 7);
      return i >= 0 && i < weeks.length ? i : null;
    },
  };
}

/** A y scale from 0 to `top` over a plot `height` high starting at `plotTop`. */
export function yScale(top: number, height: number, plotTop: number = M.t): (v: number) => number {
  return (v: number) => plotTop + height * (1 - v / top);
}

/** The three y ticks: 0, half the top and the top (§7). */
export function ticks(top: number): number[] {
  return [0, top / 2, top];
}

/**
 * A tick value: fmtInt (§5.2) when whole, else its one decimal. Ticks are 0 and halves of 1, 2 or 5 x 10^n
 * (and those over 1,000), so a tick is whole or ends in .5 and nothing is rounded.
 */
function oneDecimal(v: number): string {
  if (Number.isInteger(v)) return fmtInt(v);
  const tenths = Math.round(v * 10);
  return `${fmtInt(Math.trunc(tenths / 10))}.${Math.abs(tenths % 10)}`;
}

/** An axis count: as written up to 999, over 999 in thousands with a "k" ("12k", "2.5k"; §7). */
export function fmtTick(v: number): string {
  return v > 999 ? `${oneDecimal(v / 1000)}k` : oneDecimal(v);
}

/** A share tick on the fixed 0 to 100% axis. */
export function fmtShareTick(v: number): string {
  return `${oneDecimal(v * 100)}%`;
}

/**
 * The count behind a stored weekly share: the series keeps the share (round4 of k/n) and n, not k, so k is
 * recovered as round(share x n), exact while n < 10,000 (the rounding moves k/n by at most 0.00005).
 */
export function shareCount(share: number, n: number): number {
  return Math.round(share * n);
}

/**
 * A weekly share as the page shows it (§5.2): pct(k, n) from the recovered count, never fmtPct of the
 * stored share, except past the exactness bound above. Null when the share is null or n is below MIN_N.
 */
export function shareShown(share: number | null, n: number): string | null {
  if (share === null || n < MIN_N) return null;
  return n < 10_000 ? `${pct(shareCount(share, n), n)}%` : fmtPct(share);
}

/** Runs of consecutive indices where `ok(i)` holds: the segments a null breaks (§7 "Nulls break lines"). */
export function runs(length: number, ok: (i: number) => boolean): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < length; i++) {
    if (ok(i)) cur.push(i);
    else if (cur.length) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** "a", "b", … "z", then "aa", "ab": a marker's letter key by its place in date order. */
export function letter(i: number): string {
  const a = "a".charCodeAt(0);
  return i < 26 ? String.fromCharCode(a + i) : letter(Math.floor(i / 26) - 1) + String.fromCharCode(a + (i % 26));
}

/** Rounds an SVG coordinate to two decimals, so the markup stays short and stable. */
export function r2(v: number): number {
  return Math.round(v * 100) / 100;
}
