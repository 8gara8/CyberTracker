// Statistics and display helpers (SPEC §5.2). Pure: no clock, no time zone, no network, no random source.
// Intervals are closed-form or exact (no bootstrap, no sampling). Counts are integers; shares, intervals,
// medians and ratios are IEEE doubles computed from the counts, and every direction or threshold test
// compares those exact values. Files store them with roundTo(); the page, the chat edition and the
// validator render every number with the display helpers below, so all three show the same string.

import { isValidDate } from "../dates";
import { dayMonth, shortDate } from "../format";
import type { Interval } from "../schema/common";

/** The standard normal quantile at 0.90: the z of every two-sided 80% interval here. */
export const Z80 = 1.2815515655446004;

// ── Intervals and tests ──────────────────────────────────────────────────────────────────────────

function assertCount(x: number, what: string): void {
  if (!Number.isInteger(x) || x < 0) throw new RangeError(`${what} must be a non-negative integer, got ${x}`);
}

/** The 80% Wilson score interval for k successes in n trials (n ≥ 1), clamped to [0, 1]. */
export function wilson80(k: number, n: number): Interval {
  assertCount(k, "wilson80 k");
  assertCount(n, "wilson80 n");
  if (n < 1 || k > n) throw new RangeError(`wilson80 needs 0 ≤ k ≤ n and n ≥ 1, got k=${k}, n=${n}`);
  const p = k / n;
  const z2 = Z80 * Z80;
  const den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den;
  const half = (Z80 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Newcombe's hybrid score interval (method 10) at 80% for d = p1 − p2, from the two Wilson intervals
 * [l1, u1] and [l2, u2]: [d − sqrt((p1 − l1)² + (u2 − p2)²), d + sqrt((u1 − p1)² + (p2 − l2)²)].
 */
export function newcombe80(k1: number, n1: number, k2: number, n2: number): Interval {
  const [l1, u1] = wilson80(k1, n1);
  const [l2, u2] = wilson80(k2, n2);
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const d = p1 - p2;
  return [d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2), d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)];
}

/**
 * The Mann-Whitney z: tie-corrected normal approximation, no continuity correction, positive when `xs`
 * tend to be larger. 1-based ranks on the pooled ascending sort, ties sharing their mean rank;
 * U = (sum of xs' ranks) − n1(n1 + 1)/2; z = (U − n1·n2/2) / sqrt(n1·n2/12 · ((N + 1) − Σ(t³ − t)/(N(N − 1)))).
 * Returns 0 when every value is tied (no variance, so no evidence of a difference).
 */
export function mannWhitneyZ(xs: readonly number[], ys: readonly number[]): number {
  const n1 = xs.length;
  const n2 = ys.length;
  if (n1 < 1 || n2 < 1) throw new RangeError(`mannWhitneyZ needs two non-empty samples, got ${n1} and ${n2}`);
  const pooled = [...xs.map((v) => ({ v, x: true })), ...ys.map((v) => ({ v, x: false }))];
  for (const p of pooled) if (!Number.isFinite(p.v)) throw new RangeError(`mannWhitneyZ got a non-finite value: ${p.v}`);
  pooled.sort((a, b) => a.v - b.v);
  const N = n1 + n2;
  let rankSum = 0;
  let tieSum = 0;
  for (let i = 0; i < N;) {
    let j = i;
    while (j + 1 < N && pooled[j + 1]!.v === pooled[i]!.v) j += 1;
    const t = j - i + 1;
    const rank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k += 1) if (pooled[k]!.x) rankSum += rank;
    tieSum += t ** 3 - t;
    i = j + 1;
  }
  const u = rankSum - (n1 * (n1 + 1)) / 2;
  const variance = ((n1 * n2) / 12) * (N + 1 - tieSum / (N * (N - 1)));
  if (!(variance > 0)) return 0;
  return (u - (n1 * n2) / 2) / Math.sqrt(variance);
}

function sortedCopy(xs: readonly number[], what: string): number[] {
  if (xs.length === 0) throw new RangeError(`${what} needs at least one value`);
  for (const x of xs) if (!Number.isFinite(x)) throw new RangeError(`${what} got a non-finite value: ${x}`);
  return [...xs].sort((a, b) => a - b);
}

/** The median: numeric ascending sort; n odd → s[(n−1)/2], n even → (s[n/2−1] + s[n/2]) / 2. */
export function median(xs: readonly number[]): number {
  const s = sortedCopy(xs, "median");
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/**
 * The exact 80% interval for the median: [x(j), x(n+1−j)], 1-based on the ascending sort (ties kept),
 * with j the largest j ≥ 1 such that P(Binomial(n, 1/2) ≤ j − 1) ≤ 0.10. The CDF is exact: BigInt
 * binomial coefficients over 2^n. Needs n ≥ 4 (below that no j qualifies); callers ask only from MIN_N up.
 */
export function medianCi80(xs: readonly number[]): Interval {
  const s = sortedCopy(xs, "medianCi80");
  const n = s.length;
  const total = 1n << BigInt(n);
  let coef = 1n; // C(n, i)
  let cdf = 0n; // Σ C(n, 0..i)
  let j = 0;
  for (let i = 0; i <= n; i += 1) {
    if (i > 0) coef = (coef * BigInt(n - i + 1)) / BigInt(i);
    cdf += coef;
    if (cdf * 10n <= total) j = i + 1; // P(B ≤ i) ≤ 0.10, so j − 1 = i qualifies
    else break;
  }
  if (j < 1) throw new RangeError(`medianCi80 needs at least 4 values, got ${n}`);
  return [s[j - 1]!, s[n - j]!];
}

/** P(X ≤ k) for X ~ Poisson(λ), summed in log space so a large λ cannot underflow e^−λ. */
function poissonCdf(k: number, lambda: number): number {
  if (k < 0) return 0;
  if (lambda <= 0) return 1;
  const logL = Math.log(lambda);
  let logFact = 0;
  let sum = 0;
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) logFact += Math.log(i);
    sum += Math.exp(-lambda + i * logL - logFact);
  }
  return Math.min(1, sum);
}

/** Bisection on [lo, hi] for a decreasing f with one sign change, to a width below 1e−9. */
function bisectDecreasing(f: (x: number) => number, lo0: number, hi0: number): number {
  let lo = lo0;
  let hi = hi0;
  for (let round = 0; hi - lo >= 1e-9 && round < 400; round += 1) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Garwood's exact 80% interval for a Poisson count k: lower is the λ with P(X ≥ k; λ) = 0.10 (0 when
 * k = 0), upper the λ with P(X ≤ k; λ) = 0.10, each by bisection on [0, 10k + 10] to a width below 1e−9.
 */
export function poissonCi80(k: number): Interval {
  assertCount(k, "poissonCi80 k");
  const top = 10 * k + 10;
  // P(X ≥ k; λ) = 1 − P(X ≤ k − 1; λ) rises with λ, so P(X ≤ k − 1; λ) − 0.90 falls.
  const lower = k === 0 ? 0 : bisectDecreasing((l) => poissonCdf(k - 1, l) - 0.9, 0, top);
  const upper = bisectDecreasing((l) => poissonCdf(k, l) - 0.1, 0, top);
  return [lower, upper];
}

// ── Stored values ────────────────────────────────────────────────────────────────────────────────

/** x.toString() of a finite a ≥ 0 written out of exponent form ("1.5e+21" → "1500000000000000000000"). */
export function plainDecimal(a: number): string {
  const [mant = "", exp = "0"] = a.toString().split("e");
  const [int = "", frac = ""] = mant.split(".");
  const digits = int + frac;
  const point = int.length + Number(exp);
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * A stored value: half away from zero, decided on x.toString()'s shortest decimal string, so binary
 * floating point cannot move a half (2.5 → 3, −2.5 → −3, 0.145 at 2 dp → 0.15) and no digit is rounded
 * before the one that decides. Never toFixed, Math.round or Math.floor(x * 100 + 0.5).
 */
export function roundTo(x: number, dp: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`roundTo needs a finite number, got ${x}`);
  if (!Number.isInteger(dp) || dp < 0) throw new RangeError(`roundTo needs whole decimal places, got ${dp}`);
  const [i = "0", f = ""] = plainDecimal(Math.abs(x)).split(".");
  const p = f.padEnd(dp + 1, "0");
  let units = BigInt(i + p.slice(0, dp));
  if (p.charCodeAt(dp) - 48 >= 5) units += 1n; // the first dropped digit decides
  const r = Number(units) / 10 ** dp;
  return x < 0 && r !== 0 ? -r : r;
}

/** 4 dp: shares, interval bounds and every displayed ratio. */
export const round4 = (x: number): number => roundTo(x, 4);
/** 2 dp: `reference_pace_26w`. */
export const round2 = (x: number): number => roundTo(x, 2);
/** 1 dp: every `_pct` and `w13_mean_n`. */
export const round1 = (x: number): number => roundTo(x, 1);

// ── Display ──────────────────────────────────────────────────────────────────────────────────────
// Shares and ratios are rounded in basis points first, so a value never rounds twice. A displayed share
// always uses pct(k, n) from the two counts, never fmtPct of the stored share.

/** A share in basis points, from its stored (4 dp) value. */
function basisPoints(x: number): number {
  return Math.round(round4(x) * 1e4);
}

/** Integer percent from a count and its denominator: floor((200k + n) / (2n)). pct(58, 157) is 37. */
export function pct(k: number, n: number): number {
  assertCount(k, "pct k");
  assertCount(n, "pct n");
  if (n < 1) throw new RangeError("pct needs a denominator of at least 1");
  return Math.floor((200 * k + n) / (2 * n));
}

/** A fraction (an interval bound) as a percent: 0.3217 → "32%", 0.285 → "29%", 0.145 → "15%". */
export function fmtPct(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`fmtPct needs a finite number, got ${x}`);
  const sign = x < 0 ? "-" : "";
  const value = Math.floor((basisPoints(Math.abs(x)) + 50) / 100);
  return `${value === 0 ? "" : sign}${value}%`;
}

const INT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** A count with thousands separators: 44944 → "44,944". */
export function fmtInt(n: number): string {
  if (!Number.isInteger(n)) throw new RangeError(`fmtInt needs an integer, got ${n}`);
  return INT_FORMAT.format(n);
}

/** A ratio to one decimal, always with the decimal: 5.2498 → "5.2", 5.0004 → "5.0", 1.25 → "1.3". */
export function fmt1(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`fmt1 needs a finite number, got ${x}`);
  const tenths = Math.floor((basisPoints(Math.abs(x)) + 500) / 1000);
  const sign = x < 0 && tenths !== 0 ? "-" : "";
  return `${sign}${Math.trunc(tenths / 10)}.${tenths % 10}`;
}

/**
 * A value to two decimals, always both shown, rounded once with roundTo() from the value as stored (EPSS
 * scores and 7-day moves, which carry 5 decimals): 0.145 → "0.15", 1.005 → "1.01", 1 → "1.00". The chat
 * edition's EPSS line and the site's EPSS movers both use it (§8.8).
 */
export function fmt2(x: number): string {
  const r = roundTo(x, 2);
  const [int = "0", frac = ""] = plainDecimal(Math.abs(r)).split(".");
  return `${r < 0 ? "-" : ""}${int}.${frac.padEnd(2, "0").slice(0, 2)}`;
}

/** A median in days: the integer, or one decimal when it ends in .5 ("17", "20.5"). */
export function fmtDays(m: number): string {
  if (!Number.isFinite(m)) throw new RangeError(`fmtDays needs a finite number, got ${m}`);
  return Number.isInteger(m) ? String(m) : String(roundTo(m, 1));
}

/**
 * An ISO date: the day without a leading zero and the short month, plus the year when it is not the
 * edition's year ("2026-11-06" → "6 Nov" in a 2026 edition, "30 Dec 2025" in a 2026 edition). For the
 * year always shown (the footer), use shortDate() from lib/format.ts.
 */
export function fmtDate(date: string, editionDate: string): string {
  if (!isValidDate(editionDate)) throw new RangeError(`fmtDate needs a valid edition date, got ${editionDate}`);
  return date.slice(0, 4) === editionDate.slice(0, 4) ? dayMonth(date) : shortDate(date);
}
