// STUB (SPEC §7 "GapPanel and charts", Chart conventions). Owner: gap lane. The shared geometry: viewBox 0 0
// 400 H, margins { l: 40, r: 56, t: 8, b: 16 }, plot 304 x 84 (H 108; the Window bar strip 36, H 60); week i
// at x = l + (i + 0.5) x 304 / weeks.length; a date goes to its ISO week, floor((dayIndex(date) -
// dayIndex(weeks[0])) / 7); y ticks topped by niceMax (the next 1, 2 or 5 x 10^n).

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
