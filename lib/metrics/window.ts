// The Window (SPEC §5.3): the pure helpers that compare `window.w26` with the 2023 to 2024 reference.
// P2 adds joinKev() and windowStats() here. Directions use exact doubles, never stored values (§5).

import type { SpeedDirection, ShareDirection, WindowStats } from "../schema/metrics";
import { MIN_N } from "../vocab";
import { REFERENCE, REFERENCE_PACE_26W } from "./reference";
import { mannWhitneyZ, newcombe80, poissonCi80, round4, Z80 } from "./stats";

/** pacePhrase()'s multiples: 2 "twice", 3 "three times" … 10 "ten times" (0 and 1 unused). */
export const MULTIPLES = ["", "", "twice", "three times", "four times", "five times", "six times", "seven times", "eight times",
  "nine times", "ten times"] as const;

/**
 * `headline.at_disclosure_direction`: two-sample, `w` (w26) against the reference. `n_too_small` when
 * cohort_n < MIN_N; else the exact newcombe80 interval for the difference in at-disclosure shares:
 * lo > 0 → `higher`, hi < 0 → `lower`, else `no_clear_change` (a bound equal to zero does not exclude zero).
 */
export function shareDirection(w: Pick<WindowStats, "cohort_n" | "at_disclosure_n">): ShareDirection {
  if (w.cohort_n < MIN_N) return "n_too_small";
  const [lo, hi] = newcombe80(w.at_disclosure_n, w.cohort_n, REFERENCE.window.at_disclosure_n, REFERENCE.window.cohort_n);
  if (lo > 0) return "higher";
  if (hi < 0) return "lower";
  return "no_clear_change";
}

/**
 * `headline.after_disclosure_direction`: `n_too_small` when after_disclosure_n < MIN_N; else, with
 * z = mannWhitneyZ(afterLags, REFERENCE.after_lags): z < −Z80 → `faster` (shorter lags), z > Z80 →
 * `slower`, else `no_clear_change`. `afterLags` are w26's after-disclosure lags (2 ≤ lag ≤ 365), one per
 * row counted in `after_disclosure_n`. It compares whole distributions, so the median and the call can disagree.
 */
export function speedDirection(w: Pick<WindowStats, "after_disclosure_n">, afterLags: readonly number[]): SpeedDirection {
  if (w.after_disclosure_n < MIN_N) return "n_too_small";
  if (afterLags.length !== w.after_disclosure_n) {
    throw new Error(`speedDirection: ${afterLags.length} lags for after_disclosure_n ${w.after_disclosure_n}`);
  }
  const z = mannWhitneyZ(afterLags, REFERENCE.after_lags);
  if (z < -Z80) return "faster";
  if (z > Z80) return "slower";
  return "no_clear_change";
}

/**
 * The headline's pace words for n = w26.cohort_n against the 2023 to 2024 pace (70.21 per 26 weeks):
 * "in line with" when the Poisson 80% interval for n holds the reference pace; from twice the pace,
 * "twice" … "ten times", with "more than " unless n is an exact multiple; otherwise "N% above" or
 * "N% below" from the stored volume_ratio in basis points, capped at 99.
 */
export function pacePhrase(n: number): string {
  const [lo, hi] = poissonCi80(n);
  const ref = REFERENCE_PACE_26W;
  const r = n / ref;
  if (lo <= ref && ref <= hi) return "in line with";
  if (r >= 2) {
    const m = Math.floor(r);
    const word = MULTIPLES[Math.min(m, 10)]!;
    return (n * REFERENCE.days === m * REFERENCE.window.cohort_n * 182 ? "" : "more than ") + word;
  }
  const bp = Math.round(round4(r) * 1e4); // the stored volume_ratio in basis points
  if (r > 1) return `${Math.min(99, Math.floor((bp - 10000 + 50) / 100))}% above`;
  return `${Math.min(99, Math.floor((10000 - bp + 50) / 100))}% below`;
}
