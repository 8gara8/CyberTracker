// The Window (SPEC §5.3): the pure helpers that compare `window.w26` with the 2023 to 2024 reference.
// P2 adds the KEV join, windowStats() and gapWindow(). Directions use exact doubles, never stored values (§5).

import { daysBetween, inRange, windowEnding } from "../dates";
import type { KevEntry } from "../feeds/types";
import { compareCveIds } from "../ids";
import type { GapWindow, SpeedDirection, ShareDirection, WindowRow, WindowStats } from "../schema/metrics";
import { MIN_N } from "../vocab";
import { KEV_REFERENCE_26W, REFERENCE, REFERENCE_PACE_26W, referenceWindowStats } from "./reference";
import { mannWhitneyZ, median, medianCi80, newcombe80, poissonCi80, round4, roundTo, wilson80, Z80 } from "./stats";

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

// ── The KEV join and the Window's stats (§5.3) ──────────────────────────────────────────────────────

/** What the join needs from a CVE record: from CveFacts or a kev-index row. */
export interface JoinFacts {
  state: string;
  date_published: string | null;
  assigner: string | null;
}

/** One KEV entry joined to its CVE record; lag_days null when unjoined. */
export interface JoinRow {
  cve_id: string;
  date_added: string;
  vendor_project: string;
  date_published: string | null;
  lag_days: number | null;
}

/** ≤ 1 day, 2 to 30, 31 to 365, over 365, or no lag. */
export type Band = "at_disclosure" | "n_day" | "late" | "old" | "unjoined";

/** KEV additions from this date on are joined (§5.3). */
export const JOIN_FROM = "2023-01-01";

/** The join's lag bands (§5.3): at disclosure ≤ 1 day (negatives included), n-day 2 to 30, late 31 to 365. */
const AT_DISCLOSURE_MAX = 1;
const N_DAY_MAX = 30;
const COHORT_MAX = 365;
const K7_MAX = 7;

const byAddedThenId = (a: JoinRow, b: JoinRow): number =>
  a.date_added < b.date_added ? -1 : a.date_added > b.date_added ? 1 : compareCveIds(a.cve_id, b.cve_id);

/**
 * One row per entry with dateAdded ≥ JOIN_FROM, sorted by date_added, then CVE id (compareCveIds). A row
 * is unjoined (date_published and lag_days null) when its record is missing, not PUBLISHED, or has no
 * publication date. lag_days = daysBetween(date_published, date_added): the record's UTC date to KEV's US
 * date, compared as plain calendar dates. A CVE id listed twice keeps its earliest dateAdded.
 */
export function joinKev(
  catalog: readonly Pick<KevEntry, "cveID" | "dateAdded" | "vendorProject">[],
  records: ReadonlyMap<string, JoinFacts>,
): JoinRow[] {
  const rows: JoinRow[] = [];
  for (const e of catalog) {
    if (e.dateAdded < JOIN_FROM) continue;
    const f = records.get(e.cveID);
    const published = f && f.state === "PUBLISHED" && f.date_published !== null ? f.date_published : null;
    rows.push({
      cve_id: e.cveID,
      date_added: e.dateAdded,
      vendor_project: e.vendorProject,
      date_published: published,
      lag_days: published === null ? null : daysBetween(published, e.dateAdded),
    });
  }
  rows.sort(byAddedThenId);
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.cve_id) ? false : (seen.add(r.cve_id), true)));
}

/** The band of a lag: ≤ 1 at_disclosure, 2 to 30 n_day, 31 to 365 late, over 365 old, null unjoined. */
export function bandOf(lag: number | null): Band {
  if (lag === null) return "unjoined";
  if (lag <= AT_DISCLOSURE_MAX) return "at_disclosure";
  if (lag <= N_DAY_MAX) return "n_day";
  if (lag <= COHORT_MAX) return "late";
  return "old";
}

/** Rows with date_added in [from, to] (plain calendar compare; KEV's US dates are never converted). */
function rowsIn(rows: readonly JoinRow[], from: string, to: string): JoinRow[] {
  return rows.filter((r) => inRange(r.date_added, from, to));
}

const roundedCi = ([lo, hi]: readonly [number, number]): [number, number] => [round4(lo), round4(hi)];

/**
 * §4.7 WindowStats over rows with date_added in [from, to], by §5.3's bands. Shares and their Wilson
 * bounds are computed from the counts and stored with round4; they are null when cohort_n < MIN_N. The
 * median of the after-disclosure lags is stored as computed (an integer or a .5) with its exact interval,
 * both null when after_disclosure_n < MIN_N.
 */
export function windowStats(rows: readonly JoinRow[], from: string, to: string): WindowStats {
  const sel = rowsIn(rows, from, to);
  let unjoined = 0, cohort = 0, old = 0, at = 0, nDay = 0, k7 = 0;
  const after: number[] = [];
  for (const r of sel) {
    const band = bandOf(r.lag_days);
    if (band === "unjoined") { unjoined++; continue; }
    if (band === "old") { old++; continue; }
    cohort++;
    if (band === "at_disclosure") at++;
    else after.push(r.lag_days!);
    if (band === "n_day") nDay++;
    if (r.lag_days! <= K7_MAX) k7++;
  }
  const shares = cohort >= MIN_N;
  const medians = after.length >= MIN_N;
  return {
    from,
    to,
    kev_added_n: sel.length,
    unjoined_n: unjoined,
    cohort_n: cohort,
    old_listed_n: old,
    at_disclosure_n: at,
    at_disclosure_share: shares ? round4(at / cohort) : null,
    at_disclosure_ci80: shares ? roundedCi(wilson80(at, cohort)) : null,
    n_day_n: nDay,
    after_disclosure_n: after.length,
    after_disclosure_median_days: medians ? median(after) : null,
    after_disclosure_median_ci80: medians ? medianCi80(after) : null,
    k7_n: k7,
    p7: shares ? round4(k7 / cohort) : null,
    p7_ci80: shares ? roundedCi(wilson80(k7, cohort)) : null,
  };
}

/** The after-disclosure lags (2 to 365) of rows with date_added in [from, to], ascending: speedDirection()'s input. */
export function afterLags(rows: readonly JoinRow[], from: string, to: string): number[] {
  return rowsIn(rows, from, to)
    .filter((r) => r.lag_days !== null && r.lag_days > AT_DISCLOSURE_MAX && r.lag_days <= COHORT_MAX)
    .map((r) => r.lag_days!)
    .sort((a, b) => a - b);
}

/** The inputs manifest's WindowRow[] for [from, to], in row order (date_added, then CVE id). */
export function windowManifestRows(rows: readonly JoinRow[], from: string, to: string): WindowRow[] {
  return rowsIn(rows, from, to).map((r) => ({
    cve_id: r.cve_id,
    kev_date_added: r.date_added,
    date_published: r.date_published,
    lag_days: r.lag_days,
    band: bandOf(r.lag_days),
  }));
}

/**
 * metrics.window for a cutoff (§4.7, §5.3): w26 = windowEnding(cutoff, 182), w13 = windowEnding(cutoff, 91),
 * the frozen reference, reference_pace_26w at 2 dp, and volume_ratio and kev_pace_ratio at 4 dp from the
 * exact paces (KEV_REFERENCE_26W unrounded, ruling R23). Also returns w26's after lags for speedDirection().
 */
export function gapWindow(rows: readonly JoinRow[], cutoff: string): { window: GapWindow; w26AfterLags: number[] } {
  const w26 = windowEnding(cutoff, 182);
  const w13 = windowEnding(cutoff, 91);
  const s26 = windowStats(rows, w26.from, w26.to);
  return {
    window: {
      w26: s26,
      w13: windowStats(rows, w13.from, w13.to),
      reference: referenceWindowStats(),
      reference_pace_26w: roundTo(REFERENCE_PACE_26W, 2),
      volume_ratio: round4(s26.cohort_n / REFERENCE_PACE_26W),
      kev_pace_ratio: round4(s26.kev_added_n / KEV_REFERENCE_26W),
    },
    w26AfterLags: afterLags(rows, w26.from, w26.to),
  };
}
