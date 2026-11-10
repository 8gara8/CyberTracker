// lib/metrics/stats.ts, reference.ts, home-vendors.ts and headline.ts (SPEC §5.2, §5.3, §5.7, §5.8),
// checked against Appendix D. The Gap headline and second line are rendered from a metrics object built by
// hand from Appendix D.2 and D.3's numbers and must equal D.3's text exactly. The AI-credited figures are D.3
// and D.7 at AI-finder list v2 with sanitised matching (rulings R1, R2; §0.4 rows 31, 32). No content/ and no network.
import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { HomeVendorKev, Metrics, VendorsFile, WindowStats, type Metrics as MetricsT } from "@/lib/schema";
import {
  AI_UNAVAILABLE, composeHeadline, FLOOD_UNAVAILABLE, footerLine, gapHeadline, gapTableDisplays, inKevLine, metricDisplays,
  metricNumbers, secondLine, WINDOW_UNAVAILABLE, type HeadlineInput,
} from "@/lib/metrics/headline";
import { homeVendorKev, kevLine, kevLines, type KevVendorEntry } from "@/lib/metrics/home-vendors";
import {
  FLOOD_REFERENCE_W13, FLOOD_REFERENCE_W13_EX_KERNEL, KEV_REFERENCE_26W, oldListedPace, REFERENCE, REFERENCE_PACE_26W,
  referenceWindowStats,
} from "@/lib/metrics/reference";
import {
  fmt1, fmt2, fmtDate, fmtDays, fmtInt, fmtPct, mannWhitneyZ, median, medianCi80, newcombe80, pct, plainDecimal, poissonCi80, round1,
  round2, round4, roundTo, wilson80, Z80,
} from "@/lib/metrics/stats";
import { shareDirection } from "@/lib/metrics/window";
import { countWords } from "@/lib/text";

const r4 = (iv: readonly [number, number]) => iv.map(round4);

// ── §5.2 statistics ──────────────────────────────────────────────────────────────────────────────

describe("stats: intervals and tests", () => {
  it("uses the 0.90 normal quantile", () => {
    expect(Z80).toBe(1.2815515655446004);
  });

  it("wilson80 gives Appendix D.2's intervals", () => {
    const rows: [number, number, [number, number]][] = [
      [104, 282, [0.3328, 0.4063]], [54, 141, [0.3321, 0.4365]], [50, 141, [0.3049, 0.4076]], [62, 189, [0.2859, 0.3731]],
      [81, 234, [0.3075, 0.387]], [58, 157, [0.3217, 0.4199]], [36, 94, [0.3213, 0.4487]],
      [163, 282, [0.54, 0.6151]], [85, 141, [0.5491, 0.6542]], [87, 157, [0.503, 0.6042]], [53, 94, [0.4977, 0.6277]],
    ];
    for (const [k, n, iv] of rows) expect(r4(wilson80(k, n)), `${k}/${n}`).toEqual(iv);
  });

  it("wilson80 clamps to [0, 1] and rejects bad counts", () => {
    expect(wilson80(0, 40)[0]).toBe(0);
    expect(round4(wilson80(40, 40)[1])).toBe(1); // the closed form gives 1 − 1e−16; stored, it is 1
    for (const [k, n] of [[0, 1], [1, 1], [0, 1000], [1000, 1000], [3, 7]]) {
      const [lo, hi] = wilson80(k!, n!);
      expect(lo >= 0 && hi <= 1 && lo <= hi).toBe(true);
    }
    expect(() => wilson80(1, 0)).toThrow();
    expect(() => wilson80(5, 4)).toThrow();
    expect(() => wilson80(1.5, 4)).toThrow();
  });

  it("newcombe80(58, 157, 104, 282) is -0.0601 to 0.0626 (D.3)", () => {
    expect(r4(newcombe80(58, 157, 104, 282))).toEqual([-0.0601, 0.0626]);
  });

  it("mannWhitneyZ equals the pair-count definition of U, with tie correction", () => {
    const xs = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
    const ys = [2, 7, 1, 8, 2, 8, 1, 8, 2, 8, 4, 5, 9];
    let u = 0;
    for (const x of xs) for (const y of ys) u += x > y ? 1 : x === y ? 0.5 : 0;
    const n1 = xs.length;
    const n2 = ys.length;
    const all = [...xs, ...ys];
    const counts = new Map<number, number>();
    for (const v of all) counts.set(v, (counts.get(v) ?? 0) + 1);
    const tie = [...counts.values()].reduce((s, t) => s + t ** 3 - t, 0);
    const N = n1 + n2;
    const z = (u - (n1 * n2) / 2) / Math.sqrt(((n1 * n2) / 12) * (N + 1 - tie / (N * (N - 1))));
    expect(mannWhitneyZ(xs, ys)).toBeCloseTo(z, 12);
    expect(mannWhitneyZ(ys, xs)).toBeCloseTo(-z, 12);
  });

  it("mannWhitneyZ is positive when xs tend to be larger, 0 for identical samples or all ties", () => {
    expect(mannWhitneyZ([10, 11, 12, 13], [1, 2, 3, 4])).toBeGreaterThan(0);
    expect(mannWhitneyZ([...REFERENCE.after_lags], [...REFERENCE.after_lags])).toBe(0);
    expect(mannWhitneyZ([5, 5, 5], [5, 5])).toBe(0);
    expect(() => mannWhitneyZ([], [1])).toThrow();
  });

  it("median sorts numerically and averages the middle pair", () => {
    expect(median([10, 9, 100])).toBe(10);
    expect(median([20, 21, 2, 100])).toBe(20.5);
    expect(() => median([])).toThrow();
  });

  it("medianCi80 is exact, ties kept, and needs four values", () => {
    expect(median([...REFERENCE.after_lags])).toBe(21);
    expect(medianCi80([...REFERENCE.after_lags])).toEqual([15, 36]); // D.2: 21 (15 to 36)
    // n = 10: P(B ≤ 2) = 56/1024 ≤ 0.10 and P(B ≤ 3) = 176/1024 > 0.10, so j = 3.
    expect(medianCi80([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])).toEqual([3, 8]);
    expect(medianCi80([1, 1, 1, 1, 1])).toEqual([1, 1]);
    expect(() => medianCi80([1, 2, 3])).toThrow();
  });

  it("poissonCi80 is Garwood's interval (D.3: 157 gives 141.2 to 174.3)", () => {
    const [lo, hi] = poissonCi80(157);
    expect(roundTo(lo, 1)).toBe(141.2);
    expect(roundTo(hi, 1)).toBe(174.3);
    const [lo0, hi0] = poissonCi80(0);
    expect(lo0).toBe(0);
    expect(hi0).toBeCloseTo(Math.log(10), 8); // P(X ≤ 0; λ) = e^−λ = 0.10
    const [lo1] = poissonCi80(1);
    expect(lo1).toBeCloseTo(-Math.log(0.9), 8); // P(X ≥ 1; λ) = 1 − e^−λ = 0.10
    expect(poissonCi80(5000)[0]).toBeLessThan(5000);
    expect(poissonCi80(5000)[1]).toBeGreaterThan(5000);
  });
});

describe("stats: stored values (roundTo)", () => {
  it("passes §5.2's cases", () => {
    expect(roundTo(-2.55, 1)).toBe(-2.6);
    expect(round4(2.23605)).toBe(2.2361);
    expect(roundTo(1.2344999996, 3)).toBe(1.234);
    expect(roundTo(0.000049999999, 4)).toBe(0);
    expect(roundTo(1.5e21, 0)).toBe(1.5e21);
  });

  it("rounds half away from zero on the shortest decimal string", () => {
    expect(roundTo(2.5, 0)).toBe(3);
    expect(roundTo(-2.5, 0)).toBe(-3);
    expect(roundTo(0.145, 2)).toBe(0.15);
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(round2(REFERENCE_PACE_26W)).toBe(70.21);
    expect(round1(266.0855)).toBe(266.1);
    expect(Object.is(roundTo(-0.00001, 2), 0)).toBe(true);
  });

  it("writes numbers out of exponent form", () => {
    expect(plainDecimal(1e-7)).toBe("0.0000001");
    expect(plainDecimal(1.5e21)).toBe("1500000000000000000000");
    expect(plainDecimal(12.5)).toBe("12.5");
  });
});

describe("stats: display helpers", () => {
  it("pct uses the two counts", () => {
    expect(pct(58, 157)).toBe(37);
    expect(pct(104, 282)).toBe(37);
    expect(pct(1, 8)).toBe(13); // 12.5 rounds up
    expect(() => pct(1, 0)).toThrow();
  });

  it("fmtPct rounds in basis points first", () => {
    expect(fmtPct(0.285)).toBe("29%");
    expect(fmtPct(0.145)).toBe("15%");
    expect(fmtPct(0.3217)).toBe("32%");
    expect(fmtPct(0.4199)).toBe("42%");
    expect(fmtPct(0)).toBe("0%");
  });

  it("fmtInt, fmt1 and fmtDays", () => {
    expect(fmtInt(44944)).toBe("44,944");
    expect(fmtInt(0)).toBe("0");
    expect(() => fmtInt(1.5)).toThrow();
    expect(fmt1(5.2498)).toBe("5.2");
    expect(fmt1(5.0004)).toBe("5.0");
    expect(fmt1(1.25)).toBe("1.3");
    expect(fmt1(1.9275)).toBe("1.9");
    expect(fmt1(0)).toBe("0.0");
    expect(fmt1(12.96)).toBe("13.0");
    expect(fmtDays(17)).toBe("17");
    expect(fmtDays(20.5)).toBe("20.5");
  });

  it("fmt2 rounds once with roundTo, never toFixed, and always shows two decimals", () => {
    expect(fmt2(0.145)).toBe("0.15"); // (0.145).toFixed(2) is "0.14"
    expect(fmt2(1.005)).toBe("1.01"); // (1.005).toFixed(2) is "1.00"
    expect(fmt2(0.14496)).toBe("0.14");
    expect(fmt2(0.94512)).toBe("0.95");
    expect(fmt2(1)).toBe("1.00");
    expect(fmt2(0.1)).toBe("0.10");
    expect(fmt2(0)).toBe("0.00");
    expect(fmt2(-0.145)).toBe("-0.15");
    expect(fmt2(-0.001)).toBe("0.00");
  });

  it("fmtDate shows the year only when it is not the edition's", () => {
    expect(fmtDate("2026-11-06", "2026-11-08")).toBe("6 Nov");
    expect(fmtDate("2025-12-30", "2026-01-01")).toBe("30 Dec 2025");
    expect(fmtDate("2026-09-21", "2026-11-08")).toBe("21 Sep");
    expect(() => fmtDate("2026-11-06", "nope")).toThrow();
  });
});

// ── §5.3 reference ───────────────────────────────────────────────────────────────────────────────

describe("REFERENCE", () => {
  const w = REFERENCE.window;
  const lags: readonly number[] = REFERENCE.after_lags;

  it("adds up (Appendix D.2)", () => {
    expect(REFERENCE.days).toBe(731);
    expect(w.kev_added_n).toBe(w.cohort_n + w.old_listed_n + w.unjoined_n);
    expect(w.after_disclosure_n).toBe(w.cohort_n - w.at_disclosure_n);
    expect(w.cohort_n - w.at_disclosure_n - w.n_day_n).toBe(84); // late
  });

  it("holds the 178 sorted after-disclosure lags, agreeing with the counts", () => {
    expect(lags).toHaveLength(w.after_disclosure_n);
    expect(lags.every((x, i) => i === 0 || lags[i - 1]! <= x)).toBe(true);
    expect(lags.every((x) => Number.isInteger(x) && x >= 2 && x <= 365)).toBe(true);
    expect(lags.filter((x) => x <= 30)).toHaveLength(w.n_day_n);
    expect(w.at_disclosure_n + lags.filter((x) => x <= 7).length).toBe(w.k7_n);
    expect(median(lags)).toBe(w.after_disclosure_median_days);
    expect(medianCi80(lags)).toEqual([...w.after_disclosure_median_ci80]);
  });

  it("gives the 26-week and 13-week paces of §5.3 and §5.4", () => {
    expect(round2(REFERENCE_PACE_26W)).toBe(70.21);
    expect(round2(KEV_REFERENCE_26W)).toBe(92.87);
    expect(round1(FLOOD_REFERENCE_W13)).toBe(8561.1);
    expect(round1(FLOOD_REFERENCE_W13_EX_KERNEL)).toBe(8027.4);
    expect(round4(157 / REFERENCE_PACE_26W)).toBe(2.2361); // D.3 volume_ratio
    expect(round4(179 / KEV_REFERENCE_26W)).toBe(1.9275); // D.3 kev_pace_ratio
    expect(round2(oldListedPace(182))).toBe(22.66); // D.3: shown 23
  });

  it("referenceWindowStats() is window.reference: D.2's first row", () => {
    const ref = referenceWindowStats();
    expect(WindowStats.parse(ref)).toEqual(ref);
    expect(ref).toMatchObject({
      from: "2023-01-01", to: "2024-12-31", kev_added_n: 373, cohort_n: 282, at_disclosure_share: 0.3688,
      at_disclosure_ci80: [0.3328, 0.4063], after_disclosure_median_days: 21, after_disclosure_median_ci80: [15, 36], p7: 0.578,
      p7_ci80: [0.54, 0.6151],
    });
  });
});

// ── §5.7 home vendors ────────────────────────────────────────────────────────────────────────────

const vendor = (id: string, name: string, country: string | null, aliases: string[] = []) =>
  ({ id, name, country, widely_deployed: true, aliases, cna: [], domains: [], note: null });

const VENDORS = VendorsFile.parse({
  schema_version: 1, version: 1, updated: "2026-11-07",
  vendors: [
    vendor("zyxel", "Zyxel", "TW", ["Zyxel Networks"]), vendor("asus", "ASUS", "TW", ["ASUSTeK Computer"]),
    vendor("trend-micro", "Trend Micro", "JP"), vendor("microsoft", "Microsoft", "US"), vendor("linux", "Linux", null),
  ],
});

describe("homeVendorKev and the Taiwan Lens KEV lines (§5.7, D.3)", () => {
  const cutoff = "2026-11-06";
  const entries: KevVendorEntry[] = [
    { cve_id: "CVE-2026-7273", date_added: "2026-09-21", vendor_project: "Zyxel" }, // D.3: TW d90
    { cve_id: "CVE-2026-90001", date_added: "2026-05-21", vendor_project: "Trend Micro" }, // JP, before d90
    { cve_id: "CVE-2026-90002", date_added: "2026-11-07", vendor_project: "ASUSTeK Computer" }, // after the cutoff
    { cve_id: "CVE-2026-90003", date_added: "2026-10-30", vendor_project: "Microsoft" }, // not a home vendor
    { cve_id: "CVE-2026-90004", date_added: "2026-10-31", vendor_project: "n/a", affected_vendors: ["Unknown Co"] }, // no match
  ];

  it("counts D.3: TW 0 in 30 days and 1 in 90; JP 0 and 0", () => {
    const hv = homeVendorKev(entries, { vendors: VENDORS }, cutoff);
    expect(hv.tw).toEqual({
      to: cutoff, d30_from: "2026-10-08", d30_n: 0, d90_from: "2026-08-09", d90_n: 1,
      cve_ids_90: [{ cve_id: "CVE-2026-7273", vendor_id: "zyxel", date_added: "2026-09-21" }],
    });
    expect(hv.jp).toEqual({ to: cutoff, d30_from: "2026-10-08", d30_n: 0, d90_from: "2026-08-09", d90_n: 0, cve_ids_90: [] });
    expect(HomeVendorKev.parse(hv.tw)).toEqual(hv.tw);
  });

  it("uses matchVendor()'s affected-vendor fallback and sorts by date, then CVE number", () => {
    const more: KevVendorEntry[] = [
      { cve_id: "CVE-2026-1000", date_added: "2026-10-20", vendor_project: "n/a", affected_vendors: [null, "ZyXEL Networks"] },
      { cve_id: "CVE-2026-999", date_added: "2026-10-20", vendor_project: "ASUS" },
      { cve_id: "CVE-2026-500", date_added: "2026-10-01", vendor_project: "Trend Micro" },
    ];
    const hv = homeVendorKev([...entries, ...more], { vendors: VENDORS }, cutoff);
    expect(hv.tw.cve_ids_90.map((r) => r.cve_id)).toEqual(["CVE-2026-7273", "CVE-2026-999", "CVE-2026-1000"]);
    expect(hv.tw.d30_n).toBe(2);
    expect(hv.jp.d30_n).toBe(0);
    expect(hv.jp.d90_n).toBe(1);
  });

  it("renders D.3's lines exactly", () => {
    const hv = homeVendorKev(entries, { vendors: VENDORS }, cutoff);
    expect(kevLine("tw", hv.tw, "2026-11-08")).toBe("KEV additions for Taiwanese vendors: 0 in 30 days, 1 in 90, to 6 Nov (US date).");
    expect(kevLine("jp", hv.jp, "2026-11-08")).toBe("KEV additions for Japanese vendors: 0 in 30 days, 0 in 90, to 6 Nov (US date).");
    expect(kevLine("tw", { ...hv.tw, to: "2025-12-30" }, "2026-01-01")).toContain("to 30 Dec 2025 (US date).");
  });

  it("kevLines() gives the brief's kev_lines, with a fallback when the block has no value", () => {
    const hv = homeVendorKev(entries, { vendors: VENDORS }, cutoff);
    expect(kevLines({ date: "2026-11-08", home_vendors: hv }).tw).toEqual({
      d30_n: 0, d90_n: 1, text: "KEV additions for Taiwanese vendors: 0 in 30 days, 1 in 90, to 6 Nov (US date).",
    });
    expect(kevLines({ date: "2026-11-08", home_vendors: null }).jp).toEqual({
      d30_n: 0, d90_n: 0, text: "KEV additions for Japanese vendors: not available today.",
    });
  });
});

// ── §5.8 the Gap headline, from a metrics object built by hand from Appendix D ───────────────────

const D3_TEXT = "37% of recently disclosed flaws on CISA's exploited list were already being exploited when disclosed (2023–24: 37%, no clear change). For the rest, CISA confirmed exploitation after a median 17 days (2023–24: 21, no clear change). 157 such flaws were listed in 26 weeks, more than twice the 2023–24 pace (all CISA listings: 1.9 times).";
const D3_SECOND = "Flood: 44,944 new CVE records in 13 weeks, 5.2 times the 2023–24 pace (5.0 times excluding the Linux kernel). AI-credited: 502 in 13 weeks, 224 excluding Anthropic (a lower bound).";
const D3_QUOTED = [
  ["window.w26.at_disclosure_share", "37%"], ["window.reference.at_disclosure_share", "37%"],
  ["window.w26.after_disclosure_median_days", "17"], ["window.reference.after_disclosure_median_days", "21"],
  ["window.w26.cohort_n", "157"], ["constant", "26"], ["window.kev_pace_ratio", "1.9"],
  ["flood.n", "44,944"], ["constant", "13"], ["flood.vs_reference_ratio", "5.2"], ["flood.vs_reference_ex_kernel_ratio", "5.0"],
  ["ai_credited.w13.total", "502"], ["constant", "13"], ["ai_credited.w13.ex_anthropic", "224"],
].map(([path, display]) => ({ path, display }));

const W26: WindowStats = {
  from: "2026-05-09", to: "2026-11-06", kev_added_n: 179, unjoined_n: 0, cohort_n: 157, old_listed_n: 22, at_disclosure_n: 58,
  at_disclosure_share: round4(58 / 157), at_disclosure_ci80: [0.3217, 0.4199], n_day_n: 62, after_disclosure_n: 99,
  after_disclosure_median_days: 17, after_disclosure_median_ci80: [13, 22], k7_n: 87, p7: 0.5541, p7_ci80: [0.503, 0.6042],
};
const W13: WindowStats = {
  from: "2026-08-08", to: "2026-11-06", kev_added_n: 107, unjoined_n: 0, cohort_n: 94, old_listed_n: 13, at_disclosure_n: 36,
  at_disclosure_share: 0.383, at_disclosure_ci80: [0.3213, 0.4487], n_day_n: 35, after_disclosure_n: 58,
  after_disclosure_median_days: 20.5, after_disclosure_median_ci80: [13, 30], k7_n: 53, p7: 0.5638, p7_ci80: [0.4977, 0.6277],
};

function weeks(): string[] {
  const out: string[] = [];
  for (let d = "2024-11-04"; d <= "2026-10-26"; d = addDays(d, 7)) out.push(d);
  return out;
}

/** The 2026-11-08 metrics file, by hand from Appendix D.1 to D.3 and D.7 (headline filled by composeHeadline). */
function d3Metrics(): MetricsT {
  const ws = weeks();
  const zeros = ws.map(() => 0);
  const nulls = ws.map(() => null);
  const ok = { status: "ok" as const, as_of: "2026-11-06", note: null };
  const m: MetricsT = {
    schema_version: 1, date: "2026-11-08", generated_at: "2026-11-08T04:41:12+08:00", data_cutoff_utc: "2026-11-06", reconstructed: true,
    code_commit: "0".repeat(40),
    provenance: {
      kev_catalog_version: "2026.11.06", kev_count: 1769, kev_date_released: "2026-11-06T19:44:45.1797Z",
      cve_list_release: "cve_2026-11-06_2100Z", cve_list_commit: REFERENCE.flood.cve_list_commit, kev_data_commit: null,
      epss_model_version: "v2025.03.14", epss_date: "2026-11-06", ghsa_source: "git", ghsa_commit: null,
      config_versions: { vendors: 1, ai_finders: 2, source_tiers: 1, regions: 1, actors: 1 },
      reference: { from: "2023-01-01", to: "2024-12-31" }, inputs_file: "metrics/inputs/2026-11-08.json", inputs_sha256: "0".repeat(64),
    },
    blocks: { flood: ok, window: ok, ai_credited: ok, fix_side: ok, kev: ok, home_vendors: ok },
    headline: { text: "x", second_line: "x", at_disclosure_direction: "no_clear_change", after_disclosure_direction: "no_clear_change", quoted: [] },
    flood: {
      from: "2026-08-08", to: "2026-11-06", n: 44944, kernel_n: 4804, ex_kernel_n: 40140, unscored_n: 3121,
      year_ago: { from: "2025-08-09", to: "2025-11-07", n: 12275, kernel_n: 1574, ex_kernel_n: 10701 },
      yoy_pct: 266.1, yoy_ex_kernel_pct: 275.1, reference: { w13_mean_n: 8561.1, w13_mean_ex_kernel_n: 8027.4 },
      vs_reference_pct: 425.0, vs_reference_ex_kernel_pct: 400.0, vs_reference_ratio: 5.2498, vs_reference_ex_kernel_ratio: 5.0004,
      last_week: { week_start: "2026-10-26", n: 3426, kernel_n: 129, unscored_n: 106 },
    },
    window: { w26: W26, w13: W13, reference: referenceWindowStats(), reference_pace_26w: 70.21, volume_ratio: 2.2361, kev_pace_ratio: 1.9275 },
    ai_credited: {
      finders_version: 2, from: "2026-08-08", to: "2026-11-06",
      w13: { total: 502, by_family: { anthropic: 278, openai: 41, google: 1, other: 182 }, ex_anthropic: 224, ledger_only_anthropic: 0 },
      provisional_from: "2026-10-05",
      in_kev: { since: "2025-01-01", n: 1, entries: [{ cve_id: "CVE-2026-111497", finder_id: "openai-codex", family: "openai", kev_date_added: "2026-10-27", matched: "Codex Security" }] },
    },
    base_rate: {
      since: "2025-01-01", to_published: "2026-08-08", to: "2026-11-06", follow_up_days: 90, ai_credited_n: 289, ai_credited_in_kev_n: 0,
      ai_rate: 0, all_n: 95725, all_in_kev_n: 281, all_rate: 0.0029, expected: 0.7329, ratio: null, ratio_ci80: null,
    },
    fix_side: { anthropic_cvd: null, ghsa_unfixed: null },
    kev: { catalog_version: "2026.11.06", catalog_count: 1769, date_released: "2026-11-06T19:44:45.1797Z", new_since_last_edition: { since_catalog_version: "2026.11.05", cve_ids: [] } },
    home_vendors: {
      tw: { to: "2026-11-06", d30_from: "2026-10-08", d30_n: 0, d90_from: "2026-08-09", d90_n: 1, cve_ids_90: [{ cve_id: "CVE-2026-7273", vendor_id: "zyxel", date_added: "2026-09-21" }] },
      jp: { to: "2026-11-06", d30_from: "2026-10-08", d30_n: 0, d90_from: "2026-08-09", d90_n: 0, cve_ids_90: [] },
    },
    epss_movers: [],
    series: {
      weeks: ws, live_from: "2026-11-02", flood_n13: zeros, flood_n13_kernel: zeros, flood_n13_year_ago: nulls,
      window_at_disclosure_share: nulls, window_at_disclosure_ci80: nulls, window_after_median: nulls, window_after_median_ci80: nulls,
      window_cohort_n: zeros, kev_recent_weekly: zeros, kev_weekly: zeros,
      ai_weekly: { anthropic: zeros, openai: zeros, google: zeros, other: zeros }, ai_ledger_only_weekly: zeros, data_only_weeks: [],
    },
  };
  m.headline = composeHeadline(m);
  return m;
}

/** A copy with some fields replaced, for the headline variants. */
function variant(patch: (m: MetricsT) => void): MetricsT {
  const m = structuredClone(d3Metrics());
  patch(m);
  return m;
}

describe("the Gap headline (§5.8, Appendix D.3)", () => {
  it("the hand-built 2026-11-08 metrics are a valid metrics file", () => {
    const m = d3Metrics();
    expect(Metrics.parse(m)).toEqual(m);
    expect(shareDirection(m.window!.w26)).toBe("no_clear_change"); // D.3
  });

  it("renders D.3's headline and second line exactly, with every number quoted in order", () => {
    const m = d3Metrics();
    expect(m.headline.text).toBe(D3_TEXT);
    expect(m.headline.second_line).toBe(D3_SECOND);
    expect(m.headline.quoted).toEqual(D3_QUOTED);
    expect(countWords(m.headline.text)).toBe(55);
    expect(m.headline.at_disclosure_direction).toBe("no_clear_change");
    expect(m.headline.after_disclosure_direction).toBe("no_clear_change");
  });

  it("gives the list-v1 second line, sanitised (450 in 13 weeks, 172 excluding Anthropic; §0.4 row 31)", () => {
    const m = variant((x) => {
      x.ai_credited!.finders_version = 1;
      x.ai_credited!.w13 = { total: 450, by_family: { anthropic: 278, openai: 41, google: 1, other: 130 }, ex_anthropic: 172, ledger_only_anthropic: 0 };
    });
    expect(secondLine(m).text).toBe(
      "Flood: 44,944 new CVE records in 13 weeks, 5.2 times the 2023–24 pace (5.0 times excluding the Linux kernel). AI-credited: 450 in 13 weeks, 172 excluding Anthropic (a lower bound).",
    );
  });

  it("uses the direction words and the too-few forms", () => {
    const higher = variant((x) => { x.headline.at_disclosure_direction = "higher"; x.headline.after_disclosure_direction = "faster"; });
    expect(gapHeadline(higher).text).toContain("(2023–24: 37%, higher).");
    expect(gapHeadline(higher).text).toContain("(2023–24: 21, faster).");

    const fewAfter = variant((x) => {
      Object.assign(x.window!.w26, { after_disclosure_n: 29, n_day_n: 20, after_disclosure_median_days: null, after_disclosure_median_ci80: null });
      x.headline.after_disclosure_direction = "n_too_small";
    });
    const t = gapHeadline(fewAfter);
    expect(t.text).toContain("Too few of the rest were confirmed to give a median (n=29).");
    expect(t.quoted).toContainEqual({ path: "window.w26.after_disclosure_n", display: "29" });

    const fewCohort = variant((x) => {
      Object.assign(x.window!.w26, { cohort_n: 25, at_disclosure_n: 9, at_disclosure_share: null, at_disclosure_ci80: null });
      x.headline.at_disclosure_direction = "n_too_small";
    });
    const f = gapHeadline(fewCohort);
    expect(f.text).toBe(
      "Too few recently disclosed flaws reached CISA's exploited list in the 26 weeks to 6 Nov to compare with 2023–24 (n=25). 25 such flaws were listed in 26 weeks, 64% below the 2023–24 pace (all CISA listings: 1.9 times).",
    );
    expect(f.quoted).toEqual([
      { path: "constant", display: "26" }, { path: "window.w26.cohort_n", display: "25" }, { path: "window.w26.cohort_n", display: "25" },
      { path: "constant", display: "26" }, { path: "window.volume_ratio", display: "64%" }, { path: "window.kev_pace_ratio", display: "1.9" },
    ]);
  });

  it("quotes a pace percentage with window.volume_ratio and leaves words unquoted", () => {
    const above = variant((x) => { Object.assign(x.window!.w26, { cohort_n: 85, at_disclosure_n: 30, after_disclosure_n: 55 }); });
    const t = gapHeadline(above);
    expect(t.text).toContain("85 such flaws were listed in 26 weeks, 21% above the 2023–24 pace");
    expect(t.quoted).toContainEqual({ path: "window.volume_ratio", display: "21%" });
    const inLine = variant((x) => { Object.assign(x.window!.w26, { cohort_n: 70, at_disclosure_n: 30, after_disclosure_n: 40 }); });
    expect(gapHeadline(inLine).text).toContain("70 such flaws were listed in 26 weeks, in line with the 2023–24 pace");
    expect(gapHeadline(inLine).quoted.some((q) => q.path === "window.volume_ratio")).toBe(false);
  });

  it("marks a stale Window and replaces a failed one", () => {
    const stale = variant((x) => { x.blocks.window = { status: "stale", as_of: "2026-11-04", note: null }; });
    expect(gapHeadline(stale).text).toBe(`${D3_TEXT} (Data to 4 Nov UTC; CISA's list was not read today.)`);
    const failed = variant((x) => { x.window = null; x.blocks.window = { status: "failed", as_of: null, note: null }; });
    expect(gapHeadline(failed)).toEqual({ text: WINDOW_UNAVAILABLE, quoted: [] });
  });

  it("stays within 70 words in every variant; the longest is 68", () => {
    let longest = 0;
    for (const cohort of [25, 70, 85, 157, 250, 1234]) {
      for (const stale of [false, true]) {
        for (const after of [10, 99]) {
          const m = variant((x) => {
            Object.assign(x.window!.w26, {
              cohort_n: cohort, at_disclosure_n: Math.floor(cohort / 3), after_disclosure_n: Math.min(after, cohort),
              after_disclosure_median_days: after >= 30 && cohort >= 30 ? 17 : null,
            });
            x.headline.at_disclosure_direction = cohort >= 30 ? "no_clear_change" : "n_too_small";
            x.headline.after_disclosure_direction = Math.min(after, cohort) >= 30 ? "no_clear_change" : "n_too_small";
            if (stale) x.blocks.window = { status: "stale", as_of: "2025-12-30", note: null };
            x.date = stale ? "2026-01-01" : x.date;
          });
          longest = Math.max(longest, countWords(gapHeadline(m).text));
        }
      }
    }
    expect(longest).toBeLessThanOrEqual(70);
    expect(longest).toBe(68);
  });

  it("second line: stale and failed clauses, at most 40 words", () => {
    const stale = variant((x) => {
      x.date = "2026-01-01";
      x.blocks.flood = { status: "stale", as_of: "2025-12-30", note: null };
      x.blocks.ai_credited = { status: "stale", as_of: "2025-12-29", note: null };
    });
    const s = secondLine(stale).text;
    expect(s).toBe(
      "Flood, as of 30 Dec 2025: 44,944 new CVE records in 13 weeks, 5.2 times the 2023–24 pace (5.0 times excluding the Linux kernel). AI-credited, as of 29 Dec 2025: 502 in 13 weeks, 224 excluding Anthropic (a lower bound).",
    );
    expect(countWords(s)).toBe(40);
    const failed = variant((x) => { x.flood = null; x.ai_credited = null; });
    expect(secondLine(failed)).toEqual({ text: `${FLOOD_UNAVAILABLE} ${AI_UNAVAILABLE}`, quoted: [] });
  });

  it("composeHeadline quotes the headline's numbers before the second line's", () => {
    const m = d3Metrics();
    const input: HeadlineInput = { ...m, headline: { at_disclosure_direction: "lower", after_disclosure_direction: "slower" } };
    const h = composeHeadline(input);
    expect(h.at_disclosure_direction).toBe("lower");
    expect(h.quoted.map((q) => q.path).indexOf("flood.n")).toBe(7);
  });
});

describe("footerLine and inKevLine (§5.8, §5.5)", () => {
  it("renders the footer with the year always shown", () => {
    expect(footerLine(d3Metrics())).toBe("data to 6 Nov 2026 UTC · KEV catalog 2026.11.06 · CVE List cve_2026-11-06_2100Z · AI-finder list v2");
    expect(footerLine(variant((x) => { x.ai_credited = null; x.provenance.config_versions.ai_finders = 3; }))).toMatch(/AI-finder list v3$/);
  });

  it("renders the in-KEV line with the finder's id, as the metrics file freezes it (D.7)", () => {
    const m = d3Metrics();
    expect(inKevLine(m.ai_credited!, m.date)).toEqual({
      head: "AI-credited and now on CISA's list: 1 since 1 Jan 2025",
      entries: ["CVE-2026-111497: Codex Security (openai-codex), listed 27 Oct (US date)"],
    });
    // The page's caption and the validator's display strings are the same line.
    expect(metricDisplays(m)).toContain("CVE-2026-111497: Codex Security (openai-codex), listed 27 Oct (US date)");
  });
});

describe("metricDisplays and metricNumbers (§4.12, §5.8)", () => {
  it("lists the data table's strings, column by column", () => {
    const rows = gapTableDisplays(d3Metrics().window!);
    const shown = (key: string) => rows.filter((r) => r.key === key).map((r) => r.display);
    expect(shown("window.w26.kev_added_n")).toEqual(["179"]);
    expect(shown("window.kev_pace_ratio")).toEqual(["1.9"]);
    expect(shown("window.w26.at_disclosure_share")).toEqual(["37%"]);
    expect(shown("window.w26.at_disclosure_ci80.0")).toEqual(["32%"]);
    expect(shown("window.w26.at_disclosure_ci80.1")).toEqual(["42%"]);
    expect(shown("window.w13.after_disclosure_median_days")).toEqual(["20.5"]);
    expect(shown("window.w26.p7")).toEqual(["55%"]);
    expect(shown("window.reference.old_listed_n")).toEqual(["23", "11", "91"]); // 26-week pace, 13-week pace, the reference's own
    expect(rows.find((r) => r.label === "listed 31 to 365 days after, 26 weeks")?.display).toBe("37");
  });

  it("holds the quoted displays, the table, the in-KEV line and the Lens KEV lines", () => {
    const m = d3Metrics();
    const all = metricDisplays(m);
    for (const s of ["37%", "157", "1.9", "44,944", "5.2", "5.0", "502", "224", "AI-credited and now on CISA's list: 1 since 1 Jan 2025",
      "KEV additions for Taiwanese vendors: 0 in 30 days, 1 in 90, to 6 Nov (US date)."]) expect(all).toContain(s);
    const values = metricNumbers(m).map((n) => `${n.value}${n.percent ? "%" : ""}`);
    for (const v of ["37%", "157", "1.9", "44944", "20.5", "23", "30", "90", "1"]) expect(values).toContain(v);
    expect(values).not.toContain("2023");
    expect(values).not.toContain("111497");
  });
});
