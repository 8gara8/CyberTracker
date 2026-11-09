// The 2023 to 2024 reference (SPEC §5.3, Appendix D.2 to D.4), computed once in P2 from
// fixtures/reference/kev-cve-join.json (KEV catalog 2026.11.06 joined to CVE List V5) and the Flood
// fixtures, and frozen here. The morning run never recomputes it; tests/reference.test.ts (P2) recomputes
// it from the fixtures and fails on any difference. Changing it takes a PR, a §0.4 row and a dated note on
// the Methodology page.

import type { WindowStats } from "../schema/metrics";
import { round4, wilson80 } from "./stats";

export const REFERENCE = {
  from: "2023-01-01", to: "2024-12-31", days: 731,
  window: { kev_catalog_version: "2026.11.06", kev_added_n: 373, unjoined_n: 0, cohort_n: 282, old_listed_n: 91,
    at_disclosure_n: 104, n_day_n: 94, after_disclosure_n: 178, after_disclosure_median_days: 21,
    after_disclosure_median_ci80: [15, 36], k7_n: 163 },
  // The 178 after-disclosure lags of cohort R (2 ≤ lag ≤ 365), sorted; speedDirection compares against them.
  after_lags: [
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
    4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8, 9, 9, 9, 10,
    12, 12, 12, 12, 13, 13, 13, 14, 15, 15, 15, 15, 15, 17, 18, 19, 19, 19, 20, 20, 21, 21, 22, 22, 22,
    30, 34, 35, 36, 36, 36, 36, 37, 37, 39, 40, 41, 42, 47, 47, 48, 48, 48, 49, 55, 58, 59, 62, 64, 64,
    73, 88, 88, 88, 88, 88, 89, 90, 91, 91, 91, 93, 100, 100, 104, 105, 105, 107, 110, 119, 120, 120,
    124, 126, 139, 143, 149, 151, 154, 156, 156, 165, 169, 170, 172, 176, 180, 181, 185, 185, 188, 189,
    197, 207, 208, 211, 226, 232, 237, 245, 251, 259, 261, 265, 271, 273, 322, 323, 326, 348,
  ],
  flood: { cve_list_commit: "67c39b124fe4a56018212b4e6f62bd078058e76c",   // CVE List V5, 2026-11-07T17:28:47Z
    n: 68771, kernel_n: 4287, unscored_n: 7905 },
} as const;

// Paces for a window of the same length as the reference's 731 days, as exact doubles (§5.3, §5.4).
// Direction and threshold tests use these; the metrics file stores them rounded (§5 "Exact for tests").

/** Recently disclosed flaws (cohort R) per 26 weeks in 2023 to 2024: 282 × 182 / 731 (70.21 stored). */
export const REFERENCE_PACE_26W = (REFERENCE.window.cohort_n * 182) / REFERENCE.days;
/** All KEV additions per 26 weeks in 2023 to 2024: 373 × 182 / 731 (92.87). */
export const KEV_REFERENCE_26W = (REFERENCE.window.kev_added_n * 182) / REFERENCE.days;
/** Mean 13-week Flood count over 2023 to 2024: 68,771 × 91 / 731 (8,561.1 stored, §5.4). */
export const FLOOD_REFERENCE_W13 = (REFERENCE.flood.n * 91) / REFERENCE.days;
/** The same without Linux kernel records: (68,771 − 4,287) × 91 / 731 (8,027.4 stored). */
export const FLOOD_REFERENCE_W13_EX_KERNEL = ((REFERENCE.flood.n - REFERENCE.flood.kernel_n) * 91) / REFERENCE.days;

/** Old flaws newly listed (lag over 365 days) at the 2023 to 2024 pace for a window of `days` days (§5.3 data table). */
export function oldListedPace(days: number): number {
  return (REFERENCE.window.old_listed_n * days) / REFERENCE.days;
}

/**
 * `window.reference` (§4.7 WindowStats): the frozen counts, with its Wilson intervals computed from them
 * and stored at 4 dp, and the frozen median and its interval.
 */
export function referenceWindowStats(): WindowStats {
  const w = REFERENCE.window;
  const ci = (k: number, n: number): [number, number] => {
    const [lo, hi] = wilson80(k, n);
    return [round4(lo), round4(hi)];
  };
  return {
    from: REFERENCE.from,
    to: REFERENCE.to,
    kev_added_n: w.kev_added_n,
    unjoined_n: w.unjoined_n,
    cohort_n: w.cohort_n,
    old_listed_n: w.old_listed_n,
    at_disclosure_n: w.at_disclosure_n,
    at_disclosure_share: round4(w.at_disclosure_n / w.cohort_n),
    at_disclosure_ci80: ci(w.at_disclosure_n, w.cohort_n),
    n_day_n: w.n_day_n,
    after_disclosure_n: w.after_disclosure_n,
    after_disclosure_median_days: w.after_disclosure_median_days,
    after_disclosure_median_ci80: [w.after_disclosure_median_ci80[0], w.after_disclosure_median_ci80[1]],
    k7_n: w.k7_n,
    p7: round4(w.k7_n / w.cohort_n),
    p7_ci80: ci(w.k7_n, w.cohort_n),
  };
}
