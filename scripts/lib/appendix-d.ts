// Appendix D reproduced (SPEC Appendix D, §5.9 steps 5 and 6, §10 P2): every printed figure as a string,
// computed from the committed reference fixtures (tests/reference.test.ts, offline) or from a clone
// (`backfill --check-reference`), and the comparison table. One formatter per figure renders both the
// expected value (APPENDIX_D, written from Appendix D's numbers as data) and the computed one, so a
// difference is a difference in numbers, never in wording. D.3 and D.7 are at AI-finder list v2 with
// sanitised matching (rulings R1, R2; §0.4 rows 31, 32), and D.3's kev_pace_ratio uses the unrounded
// KEV_REFERENCE_26W (ruling R23).

import { matchCredit, matchVendor, type CompiledConfig, type LoadedConfig } from "../../lib/config";
import { addDays, daysBetween, inRange, isoWeekStart, newestCompleteWeek, windowEnding } from "../../lib/dates";
import type { CveFacts, KevCatalog } from "../../lib/feeds/types";
import { byCodeUnit, compareCveIds } from "../../lib/ids";
import { jsonText, sha256Hex } from "../../lib/json";
import { aiCredited, aiWeekly, baseRate, matchRecord } from "../../lib/metrics/ai-credit";
import { floodStats } from "../../lib/metrics/flood";
import { composeHeadline, kevLine, type HeadlineInput } from "../../lib/metrics/headline";
import { homeVendorKev } from "../../lib/metrics/home-vendors";
import { oldListedPace, REFERENCE, REFERENCE_JOIN_SHA256 } from "../../lib/metrics/reference";
import { liveFromAfter, seriesSlice, weeklySeries } from "../../lib/metrics/series";
import { mannWhitneyZ, newcombe80, pct, poissonCi80, round2, round4 } from "../../lib/metrics/stats";
import { afterLags, bandOf, gapWindow, joinKev, pacePhrase, shareDirection, speedDirection, windowStats, type JoinRow } from "../../lib/metrics/window";
import type { AiCreditRow, AiCreditsFile, DayRow, KevIndexRow, MetricsBlock, WindowStats } from "../../lib/schema/metrics";
import { ReferenceAiCreditsFile, ReferenceFloodDaysFile, ReferenceJoinFile } from "../../lib/schema/reference";
import { countWords } from "../../lib/text";
import { FINDER_FAMILIES, type FinderFamily } from "../../lib/vocab";

/** One row of the --check-reference table: Figure · expected · fixtures · clone · ok. */
export interface Figure {
  id: string;
  expected: string;
  fixtures: string | null;
  clone: string | null;
  ok: boolean;
}

export interface ReferenceSources {
  join: ReferenceJoinFile;
  floodDays: ReferenceFloodDaysFile;
  aiCredits: ReferenceAiCreditsFile;
  config: LoadedConfig;
  compiled: CompiledConfig;
}

// ── The reference's fixed facts (D.1) ──────────────────────────────────────────────────────────────

/** Appendix D's inputs: the CVE List commit, the kev-data commit whose catalog is 2026.11.06, the cutoff. */
export const REFERENCE_INPUTS = {
  cveListCommit: REFERENCE.flood.cve_list_commit,
  kevDataCommit: "e5b3a9b25050a8da26c96266c5bfe438ee0bdebc",
  kevCatalogVersion: "2026.11.06",
  kevDateReleased: "2026-11-06T19:44:45.1797Z",
  kevEntries: 1769,
  cutoff: "2026-11-06",
  editionDate: "2026-11-08",
} as const;

/** fixtures/reference/ file names, in the order the build writes them. */
export const REFERENCE_FILES = ["kev-cve-join.json", "flood-days.json", "ai-credits.json"] as const;
export type ReferenceFileName = (typeof REFERENCE_FILES)[number];

const D = REFERENCE_INPUTS.cutoff;
const E = REFERENCE_INPUTS.editionDate;
const JOIN_FROM = "2023-01-01";
const KEV_SINCE = "2025-01-01";
/** A DayRow hash for days rebuilt from flood-days.json, which keeps no ids (only Flood sums read them). */
const NO_IDS = "0".repeat(64);

// ── Formatting (the same for expected and computed values) ─────────────────────────────────────────

const f4 = (x: number): string => round4(x).toFixed(4);
const num = (x: number | null): string => (x === null ? "null" : String(x));
const familyList = (counts: Record<FinderFamily, number>, skipZero = false): string =>
  FINDER_FAMILIES.filter((f) => !skipZero || counts[f] > 0).map((f) => `${f} ${counts[f]}`).join(", ");

interface PeriodRow {
  days: number; kev: number; r: number; old: number; unjoined: number; at: number; atPct: number; ci: [number, number];
  nDay: number; late: number; after: number; median: number; medianCi: [number, number]; k7: number; p7: number; p7Ci: [number, number];
  negative: number;
}

function periodText(p: PeriodRow): string {
  return `days ${p.days} · KEV ${p.kev} · R ${p.r} · old ${p.old} · unjoined ${p.unjoined} · at disclosure ${p.at} (${p.atPct}%) ` +
    `${f4(p.ci[0])} to ${f4(p.ci[1])} · n-day ${p.nDay} · late ${p.late} · after ${p.after} · median ${p.median} ` +
    `(${p.medianCi[0]} to ${p.medianCi[1]}) · K7 ${p.k7} · P7 ${f4(p.p7)} (${f4(p.p7Ci[0])} to ${f4(p.p7Ci[1])}) · negative lags ${p.negative}`;
}

/** A period's row: windowStats() for the counts, shares and intervals; the late band and negative lags counted from the rows. */
function periodOf(rows: readonly JoinRow[], from: string, to: string): PeriodRow {
  const s = windowStats(rows, from, to);
  const sel = rows.filter((r) => inRange(r.date_added, from, to));
  return {
    days: daysBetween(from, to) + 1, kev: s.kev_added_n, r: s.cohort_n, old: s.old_listed_n, unjoined: s.unjoined_n,
    at: s.at_disclosure_n, atPct: pct(s.at_disclosure_n, s.cohort_n), ci: s.at_disclosure_ci80 ?? [NaN, NaN], nDay: s.n_day_n,
    late: sel.filter((r) => bandOf(r.lag_days) === "late").length, after: s.after_disclosure_n, median: s.after_disclosure_median_days ?? NaN,
    medianCi: s.after_disclosure_median_ci80 ?? [NaN, NaN], k7: s.k7_n, p7: s.p7 ?? NaN, p7Ci: s.p7_ci80 ?? [NaN, NaN],
    negative: sel.filter((r) => r.lag_days !== null && r.lag_days < 0).length,
  };
}

function lastPointText(s: WindowStats): string {
  return `window ${s.from} to ${s.to}: KEV ${s.kev_added_n}, R ${s.cohort_n}, at disclosure ${s.at_disclosure_n} ` +
    `(${pct(s.at_disclosure_n, s.cohort_n)}%, ${f4(s.at_disclosure_ci80![0])} to ${f4(s.at_disclosure_ci80![1])}), n-day ${s.n_day_n}, ` +
    `after ${s.after_disclosure_n}, median ${s.after_disclosure_median_days} (${s.after_disclosure_median_ci80![0]} to ${s.after_disclosure_median_ci80![1]}), K7 ${s.k7_n}`;
}

/**
 * D.6's per-date rows as text: "<date> <vendor id> <lags ascending>". The vendor is matchVendor()'s id for
 * the name (KEV writes "Soliton Systems K.K" where Appendix D prints "Soliton Systems"), and the lags of
 * one date are sorted, since Appendix D lists them in CVE-id order as text: the figure is which vendor was
 * listed when, at which lags, not how the name is spelt or in which order a day's entries are printed.
 */
export function d6Text(rows: readonly (readonly [string, string, readonly number[]])[], vendors: LoadedConfig["vendors"]): string {
  return rows.map(([date, name, lags]) => {
    const id = matchVendor({ vendors }, { kevVendorProject: name })?.id ?? `unmatched:${name}`;
    return `${date} ${id} ${[...lags].sort((a, b) => a - b).join(",")}`;
  }).join("; ");
}

/** Weeks of one direction, grouped by calendar year: "2025: 11 (2025-05-05 to 2025-12-01); …", or "none". */
function weekRuns(weeks: readonly string[]): string {
  const byYear = new Map<string, string[]>();
  for (const w of weeks) byYear.set(w.slice(0, 4), [...(byYear.get(w.slice(0, 4)) ?? []), w]);
  if (!byYear.size) return "none";
  return [...byYear].map(([y, ws]) => `${y}: ${ws.length} (${ws[0]} to ${ws.at(-1)})`).join("; ");
}

function hashOf(xs: readonly number[]): string {
  return `${xs.length} lags · sha256 ${sha256Hex(xs.join(",")).slice(0, 16)}`;
}

// ── Expected values, as Appendix D prints them ─────────────────────────────────────────────────────

const D2_PERIODS: readonly { id: string; from: string; to: string; printed: PeriodRow }[] = [
  { id: "2023-24 reference", from: "2023-01-01", to: "2024-12-31", printed: { days: 731, kev: 373, r: 282, old: 91, unjoined: 0, at: 104, atPct: 37, ci: [0.3328, 0.4063], nDay: 94, late: 84, after: 178, median: 21, medianCi: [15, 36], k7: 163, p7: 0.578, p7Ci: [0.54, 0.6151], negative: 15 } },
  { id: "2023", from: "2023-01-01", to: "2023-12-31", printed: { days: 365, kev: 187, r: 141, old: 46, unjoined: 0, at: 54, atPct: 38, ci: [0.3321, 0.4365], nDay: 49, late: 38, after: 87, median: 15, medianCi: [12, 36], k7: 85, p7: 0.6028, p7Ci: [0.5491, 0.6542], negative: 10 } },
  { id: "2024", from: "2024-01-01", to: "2024-12-31", printed: { days: 366, kev: 186, r: 141, old: 45, unjoined: 0, at: 50, atPct: 35, ci: [0.3049, 0.4076], nDay: 45, late: 46, after: 91, median: 34, medianCi: [19, 41], k7: 78, p7: 0.5532, p7Ci: [0.4992, 0.6059], negative: 5 } },
  { id: "2025", from: "2025-01-01", to: "2025-12-31", printed: { days: 365, kev: 245, r: 189, old: 56, unjoined: 0, at: 62, atPct: 33, ci: [0.2859, 0.3731], nDay: 64, late: 63, after: 127, median: 29, medianCi: [22, 35], k7: 97, p7: 0.5132, p7Ci: [0.4667, 0.5595], negative: 7 } },
  { id: "2026-01-01 to 2026-11-06", from: "2026-01-01", to: "2026-11-06", printed: { days: 310, kev: 285, r: 234, old: 51, unjoined: 0, at: 81, atPct: 35, ci: [0.3075, 0.387], nDay: 87, late: 66, after: 153, median: 20, medianCi: [15, 27], k7: 122, p7: 0.5214, p7Ci: [0.4795, 0.5629], negative: 4 } },
  { id: "w26 2026-05-09 to 2026-11-06", from: "2026-05-09", to: "2026-11-06", printed: { days: 182, kev: 179, r: 157, old: 22, unjoined: 0, at: 58, atPct: 37, ci: [0.3217, 0.4199], nDay: 62, late: 37, after: 99, median: 17, medianCi: [13, 22], k7: 87, p7: 0.5541, p7Ci: [0.503, 0.6042], negative: 4 } },
  { id: "w13 2026-08-08 to 2026-11-06", from: "2026-08-08", to: "2026-11-06", printed: { days: 91, kev: 107, r: 94, old: 13, unjoined: 0, at: 36, atPct: 38, ci: [0.3213, 0.4487], nDay: 35, late: 23, after: 58, median: 20.5, medianCi: [13, 30], k7: 53, p7: 0.5638, p7Ci: [0.4977, 0.6277], negative: 4 } },
];

const D3_TEXT = "37% of recently disclosed flaws on CISA's exploited list were already being exploited when disclosed (2023–24: 37%, no clear change). For the rest, CISA confirmed exploitation after a median 17 days (2023–24: 21, no clear change). 157 such flaws were listed in 26 weeks, more than twice the 2023–24 pace (all CISA listings: 1.9 times).";
const D3_SECOND = "Flood: 44,944 new CVE records in 13 weeks, 5.2 times the 2023–24 pace (5.0 times excluding the Linux kernel). AI-credited: 502 in 13 weeks, 224 excluding Anthropic (a lower bound).";
const D3_QUOTED = [
  ["window.w26.at_disclosure_share", "37%"], ["window.reference.at_disclosure_share", "37%"],
  ["window.w26.after_disclosure_median_days", "17"], ["window.reference.after_disclosure_median_days", "21"],
  ["window.w26.cohort_n", "157"], ["constant", "26"], ["window.kev_pace_ratio", "1.9"],
  ["flood.n", "44,944"], ["constant", "13"], ["flood.vs_reference_ratio", "5.2"], ["flood.vs_reference_ex_kernel_ratio", "5.0"],
  ["ai_credited.w13.total", "502"], ["constant", "13"], ["ai_credited.w13.ex_anthropic", "224"],
] as const;
const quotedText = (q: readonly (readonly [string, string])[]): string => q.map(([p, d]) => `${p}=${d}`).join(" | ");

/** Figures computed only from a clone (D.1's record counts, the D.6 fallback, raw versus sanitised AI credits). */
export const CLONE_ONLY = new Set([
  "D.1 KEV catalog", "D.1 CVE List records", "D.1 KEV join at the clone", "D.6 affected-vendor fallback", "D.7 raw versus sanitised",
]);

const NULL_FIGURE = "null";

/**
 * Every D.1 to D.7 figure as Appendix D prints it (D.3 and D.7 at AI-finder list v2, sanitised; D.1 with
 * the kev-data commit P2 found), keyed by figure id. `expectedFigures(config)` adds the one figure that
 * depends on the committed config: the AI-finder list's SHA-256.
 */
export const APPENDIX_D: Readonly<Record<string, string>> = Object.freeze({
  // D.1 Inputs
  "D.1 heads": `cve_list_commit ${REFERENCE_INPUTS.cveListCommit} · cutoff ${D} (all three files)`,
  "D.1 KEV catalog version": `${REFERENCE_INPUTS.kevCatalogVersion} at ${REFERENCE_INPUTS.kevDataCommit}`,
  "D.1 rows": "kev-cve-join 903 · flood-days 1406 · ai-credits 791",
  "D.1 flood-days span": "2023-01-01 to 2026-11-06, every calendar day",
  "D.1 KEV additions joined": "903 from 2023-01-01 to 2026-11-06: 903 joined, 0 unjoined",
  "D.1 AI-finder list version": "2",
  "D.1 KEV catalog": `${REFERENCE_INPUTS.kevCatalogVersion} · ${REFERENCE_INPUTS.kevDateReleased} · ${REFERENCE_INPUTS.kevEntries} entries · no repeated cveID`,
  "D.1 CVE List records": "420941 records · 401800 PUBLISHED · 19141 REJECTED · 0 other · 119879 credit strings",
  "D.1 KEV join at the clone": "903 from 2023-01-01: 903 joined, 0 unjoined",
  // The frozen reference (lib/metrics/reference.ts) against the fixtures
  "REFERENCE.window": windowObjText(REFERENCE.window),
  "REFERENCE.after_lags": hashOf(REFERENCE.after_lags),
  "REFERENCE.flood": `${REFERENCE.flood.cve_list_commit} · n ${REFERENCE.flood.n} · kernel_n ${REFERENCE.flood.kernel_n} · unscored_n ${REFERENCE.flood.unscored_n}`,
  "REFERENCE_JOIN_SHA256": REFERENCE_JOIN_SHA256,
  // D.2 The Window by period
  ...Object.fromEntries(D2_PERIODS.map((p) => [`D.2 ${p.id}`, periodText(p.printed)])),
  "D.2 identities": "R = at disclosure + n-day + late; after = n-day + late; KEV = R + old + unjoined: 7 of 7 rows",
  // D.3 Edition 2026-11-08: the Gap
  "D.3 reference share": "104 / 282 = 0.368794 (shown 37%)",
  "D.3 at_disclosure_direction": "no_clear_change (newcombe80(58, 157, 104, 282) -0.0601 to 0.0626)",
  "D.3 after_disclosure_direction": "no_clear_change (mannWhitneyZ of 99 w26 lags against 178 reference lags -1.2028)",
  "D.3 reference_pace_26w": "70.21",
  "D.3 volume_ratio": "2.2361 (157 / 70.21) · Poisson 80% for 157: 141.2 to 174.3 · more than twice",
  "D.3 kev_pace_ratio": "1.9275 (179 × 731 / (373 × 182)) · shown 1.9",
  "D.3 old flaws newly listed, 26 weeks": "22 (2023-24 pace for 182 days: 22.66, shown 23)",
  "D.3 flood": "n 44944 · kernel_n 4804 · ex_kernel_n 40140 · unscored_n 3121",
  "D.3 flood.year_ago": "2025-08-09 to 2025-11-07 · n 12275 · kernel_n 1574 · ex_kernel_n 10701 · yoy_pct 266.1 · yoy_ex_kernel_pct 275.1",
  "D.3 flood.reference": "w13_mean_n 8561.1 · w13_mean_ex_kernel_n 8027.4 · vs_reference_pct 425.0 · vs_reference_ex_kernel_pct 400.0 · vs_reference_ratio 5.2498 · vs_reference_ex_kernel_ratio 5.0004",
  "D.3 flood.last_week": "week of 2026-10-26 · n 3426 · kernel_n 129 · unscored_n 106",
  "D.3 ai_credited.w13": "total 502 · anthropic 278, openai 41, google 1, other 182 · ex_anthropic 224 · ledger_only_anthropic 0",
  "D.3 ai_credited.provisional_from": "2026-10-05",
  "D.3 home_vendors": "tw: d30_n 0, d90_n 1 (CVE-2026-7273 zyxel 2026-09-21) · jp: d30_n 0, d90_n 0",
  "D.3 headline.text": D3_TEXT,
  "D.3 headline words": "55",
  "D.3 headline.second_line": D3_SECOND,
  "D.3 headline.quoted": quotedText(D3_QUOTED),
  "D.3 Taiwan Lens line": "KEV additions for Taiwanese vendors: 0 in 30 days, 1 in 90, to 6 Nov (US date).",
  "D.3 Japan Lens line": "KEV additions for Japanese vendors: 0 in 30 days, 0 in 90, to 6 Nov (US date).",
  // D.4 The Flood
  "D.4 2023-24 reference": "n 68771 · kernel 4287 · ex-kernel 64484 · unscored 7905",
  "D.4 by year": "2023: 28847 (kernel 0); 2024: 39924 (kernel 4287); 2025: 48150 (kernel 5674); 2026 to 6 Nov: 92457 (kernel 8244)",
  "D.4 by month, 2026": "January 4302; August 12258; September 14929; October 17051",
  "D.4 series.flood_n13": "first (week of 2024-11-04) 9333 · last (week of 2026-10-26) 44140",
  // D.5 The weekly Window series
  "D.5 weeks": "104 weeks, 2024-11-04 to 2026-10-26",
  "D.5 rolling at-disclosure share": "0.262 to 0.391",
  "D.5 rolling cohort R": "75 to 158",
  "D.5 rolling median": "16 to 45 days",
  "D.5 share direction by week": "lower 14 · no_clear_change 90 · higher 0",
  "D.5 speed direction by week": "slower 3 · no_clear_change 101 · faster 0",
  "D.5 last point": "week of 2026-10-26, window 2026-05-04 to 2026-11-01: KEV 179, R 158, at disclosure 60 (38%, 0.3317 to 0.4302), n-day 61, after 98, median 17 (14 to 22), K7 88",
  "D.5 in-sample check": "79 windows ending 2023-07-02 to 2024-12-29 · share higher 14 · speed faster 8 · speed slower 4",
  "D.5 pair changes": "14",
  "D.5 lower share weeks": "2025: 11 (2025-05-05 to 2025-12-01); 2026: 3 (2026-08-24 to 2026-09-07)",
  "D.5 slower weeks": "2026: 3 (2026-03-16 to 2026-03-30)",
  "D.5 first weeks": "Flood 2023-03-27 · Window 2023-06-26",
  // D.6 Taiwan and Japan vendors on KEV
  "D.6 TW entries 2025-01-01 to 2026-11-06": "18 entries on 13 dates",
  "D.6 TW published at most 365 days before listing": "9 entries on 7 dates",
  "D.6 JP entries 2025-01-01 to 2026-11-06": "7 entries on 6 dates",
  "D.6 JP published at most 365 days before listing": "4 entries on 4 dates",
  // As printed (tests/helpers/d6.ts), each name through matchVendor() to its config id, a day's lags ascending.
  "D.6 TW dates": "2025-02-11 zyxel 7,7; 2025-03-19 edimax 15; 2025-05-07 geovision 173,324; 2025-05-15 draytek 139; 2025-06-02 asus 630,1488; " +
    "2025-06-25 d-link 521; 2025-08-05 d-link 980,1798,1798; 2025-12-08 d-link 1198; 2025-12-17 asus 0; 2025-12-22 digiever 322; " +
    "2026-02-17 teamt5 554; 2026-04-24 d-link 395; 2026-09-21 zyxel 97",
  "D.6 JP dates": "2025-03-03 hitachi 700,700; 2025-08-18 trend-micro 13; 2025-10-14 sky 3049; 2025-10-22 motex 2; 2026-02-24 soliton 11; " +
    "2026-05-21 trend-micro 0",
  "D.6 affected-vendor fallback": "adds 0 TW and 0 JP entries",
  // D.7 AI-credited (list v2, sanitised)
  "D.7 matched to the cutoff": "791: anthropic 389, openai 43, google 18, other 341",
  "D.7 by publication year": "2023: 0; 2024: 0; 2025: 32 (google 17, other 15); 2026: 759 (anthropic 389, openai 43, google 1, other 326)",
  "D.7 w13 by finder": "anthropic-claude 270, aisle 177, openai-codex 41, anthropic-claude-code 8, depthfirst 2, aixcc 1, generic-ai-assisted 1, google-big-sleep 1, xbow 1",
  "D.7 w13 by rule and field": "pattern 496, lab_context 6 · cna.credits 502",
  "D.7 to the cutoff by finder": "anthropic-claude 381, aisle 308, openai-codex 43, google-big-sleep 18, depthfirst 15, anthropic-claude-code 8, xbow 7, generic-ai-assisted 5, aixcc 3, zeropath 3 · pattern 785, lab_context 6 · cna.credits 791",
  "D.7 series.ai_weekly totals": "37, 24, 34, 12, 18, 15, 52, 62, 91, 47, 16, 72, 43",
  "D.7 series.ai_weekly anthropic": "31, 9, 3, 1, 8, 13, 31, 47, 73, 19, 7, 49, 3",
  "D.7 series.ai_weekly openai": "0, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 35",
  "D.7 series.ai_weekly google": "0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0",
  "D.7 series.ai_weekly other": "6, 12, 29, 11, 9, 2, 21, 15, 18, 28, 9, 22, 5",
  "D.7 series.ai_ledger_only_weekly": "0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0",
  "D.7 ai_credited.in_kev": "1: CVE-2026-111497 openai-codex openai \"Codex Security\" KEV 2026-10-27",
  "D.7 base_rate": "since 2025-01-01 · to_published 2026-08-08 · to 2026-11-06 · follow_up_days 90 · ai_credited_n 289 · ai_credited_in_kev_n 0 · ai_rate 0.0000 · all_n 95725 · all_in_kev_n 281 · all_rate 0.0029 · expected 0.7329 · ratio null · ratio_ci80 null",
  "D.7 pooled 2025-01-01 to 2026-11-06": "791 AI-credited records, 1 on KEV · 140607 records, 404 on KEV (any lag)",
  "D.7 raw versus sanitised": "sanitised 791 · raw 792 · differ: CVE-2026-59774",
});

function windowObjText(w: { kev_added_n: number; unjoined_n: number; cohort_n: number; old_listed_n: number; at_disclosure_n: number;
  n_day_n: number; after_disclosure_n: number; after_disclosure_median_days: number | null; after_disclosure_median_ci80: readonly [number, number] | readonly number[] | null; k7_n: number }): string {
  const ci = w.after_disclosure_median_ci80;
  return `kev_added_n ${w.kev_added_n} · unjoined_n ${w.unjoined_n} · cohort_n ${w.cohort_n} · old_listed_n ${w.old_listed_n} · ` +
    `at_disclosure_n ${w.at_disclosure_n} · n_day_n ${w.n_day_n} · after_disclosure_n ${w.after_disclosure_n} · ` +
    `median ${num(w.after_disclosure_median_days)} (${ci ? `${ci[0]} to ${ci[1]}` : NULL_FIGURE}) · k7_n ${w.k7_n}`;
}

/** APPENDIX_D plus the figure that depends on the committed config: the SHA-256 of config/ai-finders.json. */
export function expectedFigures(config: Pick<LoadedConfig, "sha256">): Record<string, string> {
  return { ...APPENDIX_D, "D.1 AI-finder list sha256": config.sha256.aiFinders };
}

// ── The reference files, from a build's state (backfill --fixtures, --check-reference) ─────────────

export interface ReferenceBuild {
  cveListCommit: string;
  kevCatalogVersion: string;
  kevDataCommit: string;
  cutoff: string;
  /** days.json rows 2023-01-01 to the cutoff. */
  days: readonly DayRow[];
  /** The KEV join (joinKev over the catalog and the clone's records). */
  joinRows: readonly JoinRow[];
  /** ai-credits.json as the build wrote it. */
  credits: AiCreditsFile;
}

/** The three fixtures/reference/ files (§5.9 step 5): ids, dates, counts, vendor names and matched tool names only. */
export function referenceFiles(b: ReferenceBuild): { join: ReferenceJoinFile; floodDays: ReferenceFloodDaysFile; aiCredits: ReferenceAiCreditsFile } {
  const head = { schema_version: 1 as const, cve_list_commit: b.cveListCommit, cutoff: b.cutoff };
  return {
    join: {
      ...head, kev_catalog_version: b.kevCatalogVersion, kev_data_commit: b.kevDataCommit,
      rows: b.joinRows.filter((r) => r.date_added <= b.cutoff).map((r) => [r.cve_id, r.date_added, r.vendor_project, r.date_published]),
    },
    floodDays: { ...head, days: b.days.filter((d) => d[0] <= b.cutoff).map((d) => [d[0], d[1], d[2], d[3]]) },
    aiCredits: {
      ...head, finders_version: b.credits.finders_version, finders_sha256: b.credits.finders_sha256,
      matches: b.credits.matches.filter((m) => m[1] <= b.cutoff && m[7] !== "cvd_ledger").map((m) => [m[0], m[1], m[2], m[3], m[7], m[5], m[6]]),
    },
  };
}

/** The files' texts, exactly as the build writes them (jsonText through their schemas). */
export function referenceTexts(f: ReturnType<typeof referenceFiles>): Record<ReferenceFileName, string> {
  return {
    "kev-cve-join.json": jsonText(f.join, ReferenceJoinFile),
    "flood-days.json": jsonText(f.floodDays, ReferenceFloodDaysFile),
    "ai-credits.json": jsonText(f.aiCredits, ReferenceAiCreditsFile),
  };
}

// ── Figures from the reference fixtures ────────────────────────────────────────────────────────────

/** The join file's rows as JoinRows (lag_days recomputed). */
export function joinRowsOf(join: ReferenceJoinFile): JoinRow[] {
  return join.rows.map(([cve_id, date_added, vendor_project, date_published]) => ({
    cve_id, date_added, vendor_project, date_published, lag_days: date_published === null ? null : daysBetween(date_published, date_added),
  }));
}

/** The reference matches as ai-credits.json rows (kind from the committed config; first_matched the cutoff). */
export function creditsOf(src: Pick<ReferenceSources, "aiCredits" | "config">): AiCreditsFile {
  const kinds = new Map(src.config.aiFinders.finders.map((f) => [f.id, f.kind]));
  const a = src.aiCredits;
  return {
    schema_version: 1, updated_at: a.cutoff, finders_version: a.finders_version, finders_sha256: a.finders_sha256,
    matches: a.matches.map(([id, published, finder, family, rule, field, matched]): AiCreditRow => {
      const kind = kinds.get(finder);
      if (!kind) throw new Error(`fixtures/reference/ai-credits.json: finder ${finder} is not in config/ai-finders.json`);
      return [id, published, finder, family, kind, field, matched, rule, a.cutoff];
    }),
  };
}

/** KEV index rows from the join (product and assigner are not in the fixture; nothing here reads them). */
function kevRowsOf(rows: readonly JoinRow[]): KevIndexRow[] {
  return rows.map((r) => [r.cve_id, r.date_added, r.vendor_project, "", r.date_published, null, "unknown"]);
}

function daysOf(f: ReferenceFloodDaysFile): DayRow[] {
  return f.days.map(([d, n, k, u]) => [d, n, k, u, NO_IDS]);
}

const OK_BLOCK: MetricsBlock = { status: "ok", as_of: D, note: null };

function d1Figures(src: ReferenceSources): Record<string, string> {
  const { join, floodDays, aiCredits } = src;
  const heads = [join, floodDays, aiCredits].map((f) => `cve_list_commit ${f.cve_list_commit} · cutoff ${f.cutoff}`);
  const out: Record<string, string> = {};
  out["D.1 heads"] = new Set(heads).size === 1 ? `${heads[0]} (all three files)` : `files disagree: ${heads.join(" / ")}`;
  out["D.1 KEV catalog version"] = `${join.kev_catalog_version} at ${join.kev_data_commit}`;
  out["D.1 rows"] = `kev-cve-join ${join.rows.length} · flood-days ${floodDays.days.length} · ai-credits ${aiCredits.matches.length}`;
  const days = floodDays.days.map((d) => d[0]);
  let gapless = days.length > 0;
  for (let i = 1; i < days.length; i++) if (addDays(days[i - 1]!, 1) !== days[i]) gapless = false;
  out["D.1 flood-days span"] = `${days[0]} to ${days.at(-1)}, ${gapless ? "every calendar day" : "with gaps or repeats"}`;
  const rows = join.rows.filter((r) => inRange(r[1], JOIN_FROM, join.cutoff));
  const joined = rows.filter((r) => r[3] !== null).length;
  out["D.1 KEV additions joined"] = `${rows.length} from ${JOIN_FROM} to ${join.cutoff}: ${joined} joined, ${rows.length - joined} unjoined`;
  out["D.1 AI-finder list version"] = String(aiCredits.finders_version);
  out["D.1 AI-finder list sha256"] = aiCredits.finders_sha256;
  return out;
}

function referenceChecks(src: ReferenceSources, rows: readonly JoinRow[], days: ReadonlyMap<string, DayRow>): Record<string, string> {
  const s = windowStats(rows, REFERENCE.from, REFERENCE.to);
  let n = 0, kernel = 0, unscored = 0;
  for (const [d, r] of days) if (inRange(d, REFERENCE.from, REFERENCE.to)) { n += r[1]; kernel += r[2]; unscored += r[3]; }
  return {
    "REFERENCE.window": windowObjText(s),
    "REFERENCE.after_lags": hashOf(afterLags(rows, REFERENCE.from, REFERENCE.to)),
    "REFERENCE.flood": `${src.floodDays.cve_list_commit} · n ${n} · kernel_n ${kernel} · unscored_n ${unscored}`,
    "REFERENCE_JOIN_SHA256": sha256Hex(jsonText(src.join, ReferenceJoinFile)),
  };
}

function d2Figures(rows: readonly JoinRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  let hold = 0;
  for (const p of D2_PERIODS) {
    const r = periodOf(rows, p.from, p.to);
    out[`D.2 ${p.id}`] = periodText(r);
    if (r.r === r.at + r.nDay + r.late && r.after === r.nDay + r.late && r.kev === r.r + r.old + r.unjoined) hold++;
  }
  out["D.2 identities"] = `R = at disclosure + n-day + late; after = n-day + late; KEV = R + old + unjoined: ${hold} of ${D2_PERIODS.length} rows`;
  return out;
}

function d3Figures(src: ReferenceSources, rows: readonly JoinRow[], days: ReadonlyMap<string, DayRow>, credits: AiCreditsFile, kevRows: readonly KevIndexRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  const ref = windowStats(rows, REFERENCE.from, REFERENCE.to);
  out["D.3 reference share"] = `${ref.at_disclosure_n} / ${ref.cohort_n} = ${(ref.at_disclosure_n / ref.cohort_n).toFixed(6)} (shown ${pct(ref.at_disclosure_n, ref.cohort_n)}%)`;
  const { window, w26AfterLags } = gapWindow(rows, D);
  const w26 = window.w26;
  const [lo, hi] = newcombe80(w26.at_disclosure_n, w26.cohort_n, REFERENCE.window.at_disclosure_n, REFERENCE.window.cohort_n);
  const share = shareDirection(w26);
  const speed = speedDirection(w26, w26AfterLags);
  out["D.3 at_disclosure_direction"] = `${share} (newcombe80(${w26.at_disclosure_n}, ${w26.cohort_n}, ${REFERENCE.window.at_disclosure_n}, ${REFERENCE.window.cohort_n}) ${f4(lo)} to ${f4(hi)})`;
  out["D.3 after_disclosure_direction"] = `${speed} (mannWhitneyZ of ${w26AfterLags.length} w26 lags against ${REFERENCE.after_lags.length} reference lags ${f4(mannWhitneyZ(w26AfterLags, REFERENCE.after_lags))})`;
  out["D.3 reference_pace_26w"] = window.reference_pace_26w.toFixed(2);
  const [plo, phi] = poissonCi80(w26.cohort_n);
  out["D.3 volume_ratio"] = `${f4(window.volume_ratio)} (${w26.cohort_n} / ${window.reference_pace_26w.toFixed(2)}) · Poisson 80% for ${w26.cohort_n}: ${plo.toFixed(1)} to ${phi.toFixed(1)} · ${pacePhrase(w26.cohort_n)}`;
  out["D.3 kev_pace_ratio"] = `${f4(window.kev_pace_ratio)} (${w26.kev_added_n} × ${REFERENCE.days} / (${REFERENCE.window.kev_added_n} × 182)) · shown ${window.kev_pace_ratio.toFixed(1)}`;
  const pace = oldListedPace(182);
  out["D.3 old flaws newly listed, 26 weeks"] = `${w26.old_listed_n} (2023-24 pace for 182 days: ${round2(pace).toFixed(2)}, shown ${Math.round(pace)})`;

  const { flood } = floodStats(days, D);
  if (flood) {
    out["D.3 flood"] = `n ${flood.n} · kernel_n ${flood.kernel_n} · ex_kernel_n ${flood.ex_kernel_n} · unscored_n ${flood.unscored_n}`;
    const ya = flood.year_ago;
    out["D.3 flood.year_ago"] = `${ya.from} to ${ya.to} · n ${ya.n} · kernel_n ${ya.kernel_n} · ex_kernel_n ${ya.ex_kernel_n} · yoy_pct ${flood.yoy_pct?.toFixed(1) ?? NULL_FIGURE} · yoy_ex_kernel_pct ${flood.yoy_ex_kernel_pct?.toFixed(1) ?? NULL_FIGURE}`;
    out["D.3 flood.reference"] = `w13_mean_n ${flood.reference.w13_mean_n.toFixed(1)} · w13_mean_ex_kernel_n ${flood.reference.w13_mean_ex_kernel_n.toFixed(1)} · ` +
      `vs_reference_pct ${flood.vs_reference_pct.toFixed(1)} · vs_reference_ex_kernel_pct ${flood.vs_reference_ex_kernel_pct.toFixed(1)} · ` +
      `vs_reference_ratio ${f4(flood.vs_reference_ratio)} · vs_reference_ex_kernel_ratio ${f4(flood.vs_reference_ex_kernel_ratio)}`;
    const lw = flood.last_week;
    out["D.3 flood.last_week"] = `week of ${lw.week_start} · n ${lw.n} · kernel_n ${lw.kernel_n} · unscored_n ${lw.unscored_n}`;
  } else {
    out["D.3 flood"] = "missing days";
  }
  const ai = aiCredited({ credits, kevIndex: kevRows, cutoff: D, findersVersion: src.aiCredits.finders_version });
  out["D.3 ai_credited.w13"] = `total ${ai.w13.total} · ${familyList(ai.w13.by_family)} · ex_anthropic ${ai.w13.ex_anthropic} · ledger_only_anthropic ${ai.w13.ledger_only_anthropic}`;
  out["D.3 ai_credited.provisional_from"] = ai.provisional_from;

  const hv = homeVendorKev(rows.map((r) => ({ cve_id: r.cve_id, date_added: r.date_added, vendor_project: r.vendor_project })), { vendors: src.config.vendors }, D);
  const hvText = (k: "tw" | "jp") => {
    const v = hv[k];
    const list = v.cve_ids_90.map((x) => `${x.cve_id} ${x.vendor_id} ${x.date_added}`).join(", ");
    return `${k}: d30_n ${v.d30_n}, d90_n ${v.d90_n}${list ? ` (${list})` : ""}`;
  };
  out["D.3 home_vendors"] = `${hvText("tw")} · ${hvText("jp")}`;
  out["D.3 Taiwan Lens line"] = kevLine("tw", hv.tw, E);
  out["D.3 Japan Lens line"] = kevLine("jp", hv.jp, E);

  if (flood) {
    const input: HeadlineInput = {
      date: E,
      blocks: { flood: OK_BLOCK, window: OK_BLOCK, ai_credited: OK_BLOCK, fix_side: OK_BLOCK, kev: OK_BLOCK, home_vendors: OK_BLOCK },
      window, flood, ai_credited: ai,
      headline: { at_disclosure_direction: share, after_disclosure_direction: speed },
    };
    const h = composeHeadline(input);
    out["D.3 headline.text"] = h.text;
    out["D.3 headline words"] = String(countWords(h.text));
    out["D.3 headline.second_line"] = h.second_line;
    out["D.3 headline.quoted"] = quotedText(h.quoted.map((q) => [q.path, q.display] as const));
  }
  return out;
}

function d4Figures(days: ReadonlyMap<string, DayRow>, series: ReturnType<typeof seriesSlice>): Record<string, string> {
  const sum = (from: string, to: string) => {
    let n = 0, k = 0, u = 0;
    for (const [d, r] of days) if (inRange(d, from, to)) { n += r[1]; k += r[2]; u += r[3]; }
    return { n, k, u };
  };
  const ref = sum(REFERENCE.from, REFERENCE.to);
  const y = (yr: string, to = `${yr}-12-31`) => sum(`${yr}-01-01`, to);
  const [y23, y24, y25, y26] = [y("2023"), y("2024"), y("2025"), y("2026", D)];
  const month = (m: string) => sum(`2026-${m}-01`, addDays(`2026-${String(Number(m) + 1).padStart(2, "0")}-01`, -1)).n;
  return {
    "D.4 2023-24 reference": `n ${ref.n} · kernel ${ref.k} · ex-kernel ${ref.n - ref.k} · unscored ${ref.u}`,
    "D.4 by year": `2023: ${y23!.n} (kernel ${y23!.k}); 2024: ${y24!.n} (kernel ${y24!.k}); 2025: ${y25!.n} (kernel ${y25!.k}); 2026 to 6 Nov: ${y26!.n} (kernel ${y26!.k})`,
    "D.4 by month, 2026": `January ${month("01")}; August ${month("08")}; September ${month("09")}; October ${month("10")}`,
    "D.4 series.flood_n13": `first (week of ${series.weeks[0]}) ${series.flood_n13[0]} · last (week of ${series.weeks.at(-1)}) ${series.flood_n13.at(-1)}`,
  };
}

function d5Figures(rows: readonly JoinRow[], file: ReturnType<typeof weeklySeries>, series: ReturnType<typeof seriesSlice>): Record<string, string> {
  const nn = (xs: readonly (number | null)[]) => xs.filter((x): x is number => x !== null);
  const range = (xs: number[], fmt: (x: number) => string) => `${fmt(Math.min(...xs))} to ${fmt(Math.max(...xs))}`;
  const directions = (m: string) => {
    const from = addDays(m, -175);
    const to = addDays(m, 6);
    const s = windowStats(rows, from, to);
    return { share: shareDirection(s), speed: speedDirection(s, afterLags(rows, from, to)), stats: s };
  };
  const dirs = series.weeks.map(directions);
  const count = <T extends string>(xs: readonly T[], keys: readonly T[]) => keys.map((k) => `${k} ${xs.filter((x) => x === k).length}`).join(" · ");
  let changes = 0;
  for (let i = 1; i < dirs.length; i++) if (dirs[i]!.share !== dirs[i - 1]!.share || dirs[i]!.speed !== dirs[i - 1]!.speed) changes++;
  const inSample = file.weeks.filter((m) => addDays(m, 6) >= "2023-07-02" && addDays(m, 6) <= "2024-12-29").map(directions);
  const inSampleEnds = file.weeks.filter((m) => addDays(m, 6) >= "2023-07-02" && addDays(m, 6) <= "2024-12-29").map((m) => addDays(m, 6));
  const last = dirs.at(-1)!;
  const firstNonNull = (xs: readonly (number | null)[]) => file.weeks[xs.findIndex((x) => x !== null)] ?? "none";
  return {
    "D.5 weeks": `${series.weeks.length} weeks, ${series.weeks[0]} to ${series.weeks.at(-1)}`,
    "D.5 rolling at-disclosure share": range(nn(series.window_at_disclosure_share), (x) => round4(x).toFixed(3)),
    "D.5 rolling cohort R": range(series.window_cohort_n, String),
    "D.5 rolling median": `${range(nn(series.window_after_median), String)} days`,
    "D.5 share direction by week": count(dirs.map((d) => d.share), ["lower", "no_clear_change", "higher"]),
    "D.5 speed direction by week": count(dirs.map((d) => d.speed), ["slower", "no_clear_change", "faster"]),
    "D.5 last point": `week of ${series.weeks.at(-1)}, ${lastPointText(last.stats)}`,
    "D.5 in-sample check": `${inSample.length} windows ending ${inSampleEnds[0]} to ${inSampleEnds.at(-1)} · share higher ${inSample.filter((d) => d.share === "higher").length} · ` +
      `speed faster ${inSample.filter((d) => d.speed === "faster").length} · speed slower ${inSample.filter((d) => d.speed === "slower").length}`,
    "D.5 pair changes": String(changes),
    "D.5 lower share weeks": weekRuns(series.weeks.filter((_, i) => dirs[i]!.share === "lower")),
    "D.5 slower weeks": weekRuns(series.weeks.filter((_, i) => dirs[i]!.speed === "slower")),
    "D.5 first weeks": `Flood ${firstNonNull(file.flood_n13)} · Window ${firstNonNull(file.window_cohort_n)}`,
  };
}

/** D.6's [date, vendorProject, lags] rows for a country, KEV additions 2025-01-01 to the cutoff, matched on vendorProject. */
export function homeVendorRows(rows: readonly JoinRow[], vendors: LoadedConfig["vendors"], country: "TW" | "JP"): [string, string, number[]][] {
  const out: [string, string, number[]][] = [];
  for (const r of rows) {
    if (!inRange(r.date_added, KEV_SINCE, D)) continue;
    if (matchVendor({ vendors }, { kevVendorProject: r.vendor_project })?.country !== country) continue;
    const last = out.at(-1);
    if (last && last[0] === r.date_added && last[1] === r.vendor_project) last[2].push(r.lag_days ?? NaN);
    else out.push([r.date_added, r.vendor_project, [r.lag_days ?? NaN]]);
  }
  return out;
}

function d6Figures(src: ReferenceSources, rows: readonly JoinRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, country] of [["TW", "TW"], ["JP", "JP"]] as const) {
    const days = homeVendorRows(rows, src.config.vendors, country);
    const entries = days.reduce((s, d) => s + d[2].length, 0);
    const recent = days.map((d) => [d[0], d[1], d[2].filter((l) => l <= 365)] as const).filter((d) => d[2].length > 0);
    const recentEntries = recent.reduce((s, d) => s + d[2].length, 0);
    const dates = (xs: readonly (readonly [string, ...unknown[]])[]) => new Set(xs.map((x) => x[0])).size;
    out[`D.6 ${key} entries 2025-01-01 to 2026-11-06`] = `${entries} entries on ${dates(days)} dates`;
    out[`D.6 ${key} published at most 365 days before listing`] = `${recentEntries} entries on ${dates(recent)} dates`;
    out[`D.6 ${key} dates`] = d6Text(days, src.config.vendors);
  }
  return out;
}

function d7Figures(src: ReferenceSources, rows: readonly JoinRow[], days: ReadonlyMap<string, DayRow>, credits: AiCreditsFile, kevRows: readonly KevIndexRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  const matches = credits.matches.filter((m) => m[7] !== "cvd_ledger" && inRange(m[1], JOIN_FROM, D));
  const zero = (): Record<FinderFamily, number> => ({ anthropic: 0, openai: 0, google: 0, other: 0 });
  const fam = zero();
  for (const m of matches) fam[m[3]]++;
  out["D.7 matched to the cutoff"] = `${matches.length}: ${familyList(fam)}`;
  const years = ["2023", "2024", "2025", "2026"].map((y) => {
    const c = zero();
    const ms = matches.filter((m) => m[1].startsWith(y));
    for (const m of ms) c[m[3]]++;
    return ms.length ? `${y}: ${ms.length} (${familyList(c, true)})` : `${y}: 0`;
  });
  out["D.7 by publication year"] = years.join("; ");

  const finders = (ms: readonly AiCreditRow[]) => {
    const by = new Map<string, number>();
    for (const m of ms) by.set(m[2], (by.get(m[2]) ?? 0) + 1);
    return [...by].sort((a, b) => b[1] - a[1] || byCodeUnit(a[0], b[0])).map(([id, n]) => `${id} ${n}`).join(", ");
  };
  const rules = (ms: readonly AiCreditRow[]) => {
    const r = ["pattern", "lab_context"].map((k) => `${k} ${ms.filter((m) => m[7] === k).length}`).join(", ");
    const fields = [...new Set(ms.map((m) => m[5]))].sort(byCodeUnit).map((fl) => `${fl} ${ms.filter((m) => m[5] === fl).length}`).join(", ");
    return `${r} · ${fields}`;
  };
  const w = windowEnding(D, 91);
  const w13 = matches.filter((m) => inRange(m[1], w.from, w.to));
  out["D.7 w13 by finder"] = finders(w13);
  out["D.7 w13 by rule and field"] = rules(w13);
  out["D.7 to the cutoff by finder"] = `${finders(matches)} · ${rules(matches)}`;

  const mondays: string[] = [];
  for (let m = isoWeekStart(w.from); m <= newestCompleteWeek(D); m = addDays(m, 7)) mondays.push(m);
  const weekly = aiWeekly(credits, mondays);
  out["D.7 series.ai_weekly totals"] = mondays.map((_, i) => FINDER_FAMILIES.reduce((s, f) => s + weekly.ai_weekly[f][i]!, 0)).join(", ");
  for (const f of FINDER_FAMILIES) out[`D.7 series.ai_weekly ${f}`] = weekly.ai_weekly[f].join(", ");
  out["D.7 series.ai_ledger_only_weekly"] = weekly.ai_ledger_only_weekly.join(", ");

  const ai = aiCredited({ credits, kevIndex: kevRows, cutoff: D, findersVersion: src.aiCredits.finders_version });
  out["D.7 ai_credited.in_kev"] = `${ai.in_kev.n}: ${ai.in_kev.entries.map((e) => `${e.cve_id} ${e.finder_id} ${e.family} "${e.matched}" KEV ${e.kev_date_added}`).join("; ")}`;
  const b = baseRate({ credits, days: [...days.values()], kevIndex: kevRows, cutoff: D });
  out["D.7 base_rate"] = `since ${b.since} · to_published ${b.to_published} · to ${b.to} · follow_up_days ${b.follow_up_days} · ` +
    `ai_credited_n ${b.ai_credited_n} · ai_credited_in_kev_n ${b.ai_credited_in_kev_n} · ai_rate ${b.ai_rate === null ? NULL_FIGURE : f4(b.ai_rate)} · ` +
    `all_n ${b.all_n} · all_in_kev_n ${b.all_in_kev_n} · all_rate ${b.all_rate === null ? NULL_FIGURE : f4(b.all_rate)} · expected ${f4(b.expected)} · ` +
    `ratio ${b.ratio === null ? NULL_FIGURE : f4(b.ratio)} · ratio_ci80 ${b.ratio_ci80 === null ? NULL_FIGURE : `${f4(b.ratio_ci80[0])} to ${f4(b.ratio_ci80[1])}`}`;

  const span = (d: string | null) => d !== null && inRange(d, KEV_SINCE, D);
  const onKev = new Set(rows.filter((r) => r.date_added <= D).map((r) => r.cve_id));
  const pooledAi = matches.filter((m) => span(m[1]));
  let all = 0;
  for (const [d, r] of days) if (span(d)) all += r[1];
  const allKev = new Set(rows.filter((r) => r.date_added <= D && span(r.date_published)).map((r) => r.cve_id)).size;
  out["D.7 pooled 2025-01-01 to 2026-11-06"] = `${pooledAi.length} AI-credited records, ${pooledAi.filter((m) => onKev.has(m[0])).length} on KEV · ${all} records, ${allKev} on KEV (any lag)`;
  return out;
}

/** Every figure the reference fixtures give (all of APPENDIX_D but CLONE_ONLY), by figure id. */
export function appendixFigures(src: ReferenceSources): Record<string, string> {
  const rows = joinRowsOf(src.join);
  const dayRows = daysOf(src.floodDays);
  const days = new Map(dayRows.map((d) => [d[0], d]));
  const credits = creditsOf(src);
  const kevRows = kevRowsOf(rows);
  const file = weeklySeries({ days, rows, credits, dataOnlyDates: [] }, D, liveFromAfter(D));
  const series = seriesSlice(file);
  return {
    ...d1Figures(src),
    ...referenceChecks(src, rows, days),
    ...d2Figures(rows),
    ...d3Figures(src, rows, days, credits, kevRows),
    ...d4Figures(days, series),
    ...d5Figures(rows, file, series),
    ...d6Figures(src, rows),
    ...d7Figures(src, rows, days, credits, kevRows),
  };
}

// ── Figures only a clone gives ─────────────────────────────────────────────────────────────────────

/** §5.5's loop on raw (unsanitised) credit strings: the comparison R1 asks for. */
function rawMatch(f: CveFacts, cfg: CompiledConfig["aiFinders"]): boolean {
  for (const field of cfg.fields) {
    for (const c of f.credits) if (c.field === field && matchCredit(c.value, cfg)) return true;
  }
  return false;
}

/**
 * The clone-only figures: D.1's record counts and catalog, the join at the clone, the D.6 affected-vendor
 * fallback (KEV additions 2025-01-01 to the cutoff that matchVendor() places in TW or JP only through the
 * record's affected[].vendor), and raw versus sanitised AI-credit matching to the cutoff.
 */
export function cloneFigures(facts: readonly CveFacts[], catalog: KevCatalog, cfg: { config: LoadedConfig; compiled: CompiledConfig }): Record<string, string> {
  const out: Record<string, string> = {};
  const states = new Map<string, number>();
  let credits = 0;
  for (const f of facts) {
    states.set(f.state, (states.get(f.state) ?? 0) + 1);
    credits += f.credits.length;
  }
  const pub = states.get("PUBLISHED") ?? 0;
  const rej = states.get("REJECTED") ?? 0;
  out["D.1 CVE List records"] = `${facts.length} records · ${pub} PUBLISHED · ${rej} REJECTED · ${facts.length - pub - rej} other · ${credits} credit strings`;
  const repeated = catalog.vulnerabilities.length - new Set(catalog.vulnerabilities.map((v) => v.cveID)).size;
  out["D.1 KEV catalog"] = `${catalog.catalogVersion} · ${catalog.dateReleased} · ${catalog.count} entries · ${repeated ? `${repeated} repeated cveID` : "no repeated cveID"}`;

  const byId = new Map(facts.map((f) => [f.cve_id, f]));
  const rows = joinKev(catalog.vulnerabilities, byId).filter((r) => r.date_added <= D);
  const joined = rows.filter((r) => bandOf(r.lag_days) !== "unjoined").length;
  out["D.1 KEV join at the clone"] = `${rows.length} from ${JOIN_FROM}: ${joined} joined, ${rows.length - joined} unjoined`;

  const added = { TW: 0, JP: 0 };
  for (const r of rows) {
    if (!inRange(r.date_added, KEV_SINCE, D)) continue;
    const direct = matchVendor({ vendors: cfg.config.vendors }, { kevVendorProject: r.vendor_project });
    if (direct) continue;
    const viaAffected = matchVendor({ vendors: cfg.config.vendors }, { kevVendorProject: r.vendor_project, affectedVendors: byId.get(r.cve_id)?.affected.map((a) => a.vendor) ?? [] });
    if (viaAffected?.country === "TW" || viaAffected?.country === "JP") added[viaAffected.country]++;
  }
  out["D.6 affected-vendor fallback"] = `adds ${added.TW} TW and ${added.JP} JP entries`;

  const ai = cfg.compiled.aiFinders;
  const counted = facts.filter((f) => f.state === "PUBLISHED" && f.date_published !== null && f.date_published <= D);
  const raw = new Set(counted.filter((f) => rawMatch(f, ai)).map((f) => f.cve_id));
  const sanitisedIds = new Set(counted.filter((f) => matchRecord(f, null, ai) !== null).map((f) => f.cve_id));
  const differ = [...new Set([...raw].filter((x) => !sanitisedIds.has(x)).concat([...sanitisedIds].filter((x) => !raw.has(x))))].sort(compareCveIds);
  out["D.7 raw versus sanitised"] = `sanitised ${sanitisedIds.size} · raw ${raw.size} · differ: ${differ.length ? differ.join(", ") : "none"}`;
  return out;
}

// ── The table ──────────────────────────────────────────────────────────────────────────────────────

/**
 * One row per expected figure, then one per computed figure no expected value names (always a failure).
 * A row is ok when every computed value present equals the expected one; a figure neither source computed
 * is ok only if it is clone-only and no clone was read ("not checked").
 */
export function compareFigures(expected: Record<string, string>, fixtures: Record<string, string>, clone: Record<string, string> | null): Figure[] {
  const out: Figure[] = [];
  for (const [id, want] of Object.entries(expected)) {
    const fx = fixtures[id] ?? null;
    const cl = clone ? clone[id] ?? null : null;
    const present = [fx, cl].filter((v): v is string => v !== null);
    const checked = present.length > 0;
    const ok = checked ? present.every((v) => v === want) : CLONE_ONLY.has(id) && clone === null;
    out.push({ id, expected: want, fixtures: fx, clone: cl, ok });
  }
  const extra = [...new Set([...Object.keys(fixtures), ...Object.keys(clone ?? {})])].filter((id) => !(id in expected)).sort(byCodeUnit);
  for (const id of extra) out.push({ id, expected: "(no expected value)", fixtures: fixtures[id] ?? null, clone: clone?.[id] ?? null, ok: false });
  return out;
}

/** The table as text: one "Figure · expected · fixtures · clone · ok" line per row, a value equal to the expected one shown as "=". */
export function formatFigures(rows: readonly Figure[]): string[] {
  const cell = (v: string | null, want: string) => (v === null ? "-" : v === want ? "=" : v);
  return [
    "Figure · expected · fixtures · clone · ok",
    ...rows.map((r) => `${r.id} · ${r.expected} · ${cell(r.fixtures, r.expected)} · ${cell(r.clone, r.expected)} · ${r.fixtures === null && r.clone === null ? (r.ok ? "not checked" : "MISSING") : r.ok ? "ok" : "DIFFERS"}`),
  ];
}
