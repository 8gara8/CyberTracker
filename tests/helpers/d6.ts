// SPEC Appendix D.6: KEV additions for Taiwanese and Japanese vendors from 2025-01-01 to 2026-11-06, as
// [date added (US date), KEV vendorProject, lags in days of each entry added that day]. The replay of the
// home-vendor rule (tests/regions.test.ts) reads these, and the Appendix D check (scripts/lib/appendix-d.ts,
// tests/reference.test.ts) compares the rows it derives from the reference join with them.

/** Taiwan: 18 entries on 13 dates. */
export const D6_TW: readonly (readonly [string, string, readonly number[]])[] = [
  ["2025-02-11", "Zyxel", [7, 7]], ["2025-03-19", "Edimax", [15]], ["2025-05-07", "GeoVision", [173, 324]], ["2025-05-15", "DrayTek", [139]],
  ["2025-06-02", "ASUS", [1488, 630]], ["2025-06-25", "D-Link", [521]], ["2025-08-05", "D-Link", [1798, 1798, 980]], ["2025-12-08", "D-Link", [1198]],
  ["2025-12-17", "ASUS", [0]], ["2025-12-22", "Digiever", [322]], ["2026-02-17", "TeamT5", [554]], ["2026-04-24", "D-Link", [395]],
  ["2026-09-21", "Zyxel", [97]],
];

/** Japan: 7 entries on 6 dates. */
export const D6_JP: readonly (readonly [string, string, readonly number[]])[] = [
  ["2025-03-03", "Hitachi Vantara", [700, 700]], ["2025-08-18", "Trend Micro", [13]], ["2025-10-14", "SKYSEA", [3049]], ["2025-10-22", "Motex", [2]],
  ["2026-02-24", "Soliton Systems", [11]], ["2026-05-21", "Trend Micro", [0]],
];
