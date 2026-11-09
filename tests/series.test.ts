// lib/metrics/series.ts (SPEC §5.9, §4.7 series.json; rulings R5, R17, R18, R19): weeklySeries(),
// extendSeries(), seriesUpTo(), seriesSlice() and liveFromAfter(), on synthetic days, KEV rows and credits.
import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { dayMap } from "@/lib/metrics/flood";
import { extendSeries, liveFromAfter, seriesSlice, seriesUpTo, SERIES_FROM, weeklySeries, type SeriesSources } from "@/lib/metrics/series";
import { windowStats, type JoinRow } from "@/lib/metrics/window";
import { AiCreditsFile, Series, SeriesFile, type AiCreditRow, type DayRow } from "@/lib/schema/metrics";

const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const CUTOFF = "2026-11-06"; // a Friday; the newest complete week starts 2026-10-26

function synthDays(from: string, to: string, n = 10, kernel = 2): DayRow[] {
  const out: DayRow[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push([d, n, kernel, 1, EMPTY]);
  return out;
}

/** One KEV row every third day from 2023-01-01, lags cycling through every band (a deterministic pattern). */
function synthRows(to: string): JoinRow[] {
  const lags = [0, 1, -2, 5, 20, 100, 400, null, 1, 3];
  const out: JoinRow[] = [];
  let i = 0;
  for (let d = "2023-01-01"; d <= to; d = addDays(d, 3), i++) {
    const lag = lags[i % lags.length]!;
    out.push({ cve_id: `CVE-2023-${10000 + i}`, date_added: d, vendor_project: "Example", date_published: lag === null ? null : addDays(d, -lag), lag_days: lag });
  }
  return out;
}

function credits(matches: AiCreditRow[]): AiCreditsFile {
  return AiCreditsFile.parse({ schema_version: 1, updated_at: CUTOFF, finders_version: 1, finders_sha256: "0".repeat(64), matches });
}
const credit = (id: string, date: string, family: AiCreditRow[3], rule: AiCreditRow[7] = "pattern"): AiCreditRow =>
  [id, date, "example-finder", family, "ai_system", rule === "cvd_ledger" ? "cvd_ledger" : "cna.credits", "SAMPLE AI finder", rule, date];

function sources(o: Partial<SeriesSources> = {}): SeriesSources {
  return { days: dayMap(synthDays("2023-01-01", CUTOFF)), rows: synthRows(CUTOFF), credits: credits([]), dataOnlyDates: [], ...o };
}

describe("weeklySeries (backfill build)", () => {
  const file = weeklySeries(sources(), CUTOFF, liveFromAfter(CUTOFF));

  it("runs from 2023-01-02 to the newest complete week, aligned, and parses as SeriesFile", () => {
    expect(SeriesFile.parse(file)).toEqual(file);
    expect(file.weeks[0]).toBe(SERIES_FROM);
    expect(file.weeks.at(-1)).toBe("2026-10-26");
    expect(file.weeks.length).toBe(200);
    expect(file.live_from).toBe("2026-11-09");
    expect(file.updated_at).toBe(CUTOFF);
  });

  it("starts the Flood at 2023-03-27 and the Window at 2023-06-26 (nulls before, R17)", () => {
    const firstFlood = file.flood_n13.findIndex((x) => x !== null);
    expect(file.weeks[firstFlood]).toBe("2023-03-27");
    expect(file.flood_n13.slice(0, firstFlood).every((x) => x === null)).toBe(true);
    expect(file.flood_n13_kernel[firstFlood]).toBe(91 * 2);
    expect(file.flood_n13[firstFlood]).toBe(91 * 10);
    const firstWindow = file.window_cohort_n.findIndex((x) => x !== null);
    expect(file.weeks[firstWindow]).toBe("2023-06-26");
    expect(file.window_at_disclosure_share.slice(0, firstWindow).every((x) => x === null)).toBe(true);
  });

  it("takes each week's Window from windowStats() over its 26 weeks, and KEV counts from that week's listings", () => {
    const rows = synthRows(CUTOFF);
    const k = file.weeks.indexOf("2025-03-03");
    const s = windowStats(rows, addDays("2025-03-03", -175), "2025-03-09");
    expect(file.window_cohort_n[k]).toBe(s.cohort_n);
    expect(file.window_at_disclosure_share[k]).toBe(s.at_disclosure_share);
    expect(file.window_after_median[k]).toBe(s.after_disclosure_median_days);
    const inWeek = rows.filter((r) => r.date_added >= "2025-03-03" && r.date_added <= "2025-03-09");
    expect(file.kev_weekly[k]).toBe(inWeek.length);
    expect(file.kev_recent_weekly[k]).toBe(inWeek.filter((r) => r.lag_days !== null && r.lag_days <= 365).length);
  });

  it("gives the year-ago value from 52 weeks earlier, null in the first year", () => {
    const k = file.weeks.indexOf("2024-03-25");
    expect(file.flood_n13_year_ago[k]).toBe(file.flood_n13[file.weeks.indexOf("2023-03-27")]);
    expect(file.flood_n13_year_ago[file.weeks.indexOf("2024-03-18")]).toBeNull();
  });

  it("stops at the first week whose 13-week days are not all present (R18)", () => {
    const days = dayMap(synthDays("2023-01-01", CUTOFF).filter((d) => d[0] !== "2025-06-04"));
    const cut = weeklySeries(sources({ days }), CUTOFF, liveFromAfter(CUTOFF));
    expect(cut.weeks.at(-1)).toBe(addDays("2025-06-02", -7));
    expect(SeriesFile.parse(cut)).toEqual(cut);
  });

  it("counts AI credits by family and the ledger apart, and lists data-only weeks", () => {
    const f = weeklySeries(
      sources({
        credits: credits([credit("CVE-2026-1001", "2026-10-27", "anthropic"), credit("CVE-2026-1002", "2026-10-29", "google"), credit("CVE-2026-1003", "2026-10-28", "anthropic", "cvd_ledger"), credit("CVE-2030-1004", "2030-01-01", "other")]),
        dataOnlyDates: ["2026-10-28", "2026-10-29", "2026-11-12", "2020-01-01"],
      }),
      CUTOFF,
      liveFromAfter(CUTOFF),
    );
    const k = f.weeks.length - 1;
    expect(f.ai_weekly.anthropic[k]).toBe(1);
    expect(f.ai_weekly.google[k]).toBe(1);
    expect(f.ai_ledger_only_weekly[k]).toBe(1);
    expect(f.ai_weekly.other.every((x) => x === 0)).toBe(true);
    expect(f.data_only_weeks).toEqual(["2026-10-26"]);
  });
});

describe("extendSeries (a morning)", () => {
  const cutoff0 = "2026-10-30";
  const prev = weeklySeries(sources(), cutoff0, liveFromAfter(cutoff0));

  it("appends the newly complete week and keeps live_from", () => {
    expect(prev.weeks.at(-1)).toBe("2026-10-19");
    const next = extendSeries(prev, sources(), CUTOFF);
    expect(next.weeks.at(-1)).toBe("2026-10-26");
    expect(next.weeks.length).toBe(prev.weeks.length + 1);
    expect(next.live_from).toBe(prev.live_from);
    expect(next).toEqual({ ...weeklySeries(sources(), CUTOFF, prev.live_from) });
  });

  it("freezes the Flood fields of existing weeks, while the Window moves after a re-join", () => {
    const changedDays = dayMap(synthDays("2023-01-01", CUTOFF, 50, 5));
    // The first row listed in October 2026 that is old or unjoined now joins at disclosure.
    const before = synthRows(CUTOFF).find((r) => r.date_added >= "2026-10-01" && (r.lag_days === null || r.lag_days > 365))!;
    const rows = synthRows(CUTOFF).map((r) => (r.cve_id === before.cve_id ? { ...r, date_published: r.date_added, lag_days: 0 } : r));
    const next = extendSeries(prev, sources({ days: changedDays, rows }), CUTOFF);
    const n = prev.weeks.length;
    expect(next.flood_n13.slice(0, n)).toEqual(prev.flood_n13);
    expect(next.flood_n13_kernel.slice(0, n)).toEqual(prev.flood_n13_kernel);
    expect(next.flood_n13_year_ago.slice(0, n)).toEqual(prev.flood_n13_year_ago);
    // The appended week counts from the days as they are now.
    expect(next.flood_n13.at(-1)).toBe(91 * 50);
    // The re-joined row enters cohort R: the 26-week counts of the weeks that cover it move.
    expect(before.date_added <= "2026-10-25").toBe(true);
    const k = prev.weeks.indexOf("2026-10-19");
    expect(next.window_cohort_n[k]).toBe(prev.window_cohort_n[k]! + 1);
    expect(next.window_cohort_n[prev.weeks.indexOf("2026-03-30")]).toBe(prev.window_cohort_n[prev.weeks.indexOf("2026-03-30")]);
  });

  it("rewrites every AI week (R5)", () => {
    const withCredit = extendSeries(prev, sources({ credits: credits([credit("CVE-2024-1001", "2024-05-07", "openai")]) }), CUTOFF);
    const k = withCredit.weeks.indexOf("2024-05-06");
    expect(withCredit.ai_weekly.openai[k]).toBe(1);
    const removed = extendSeries(withCredit, sources(), CUTOFF);
    expect(removed.ai_weekly.openai[k]).toBe(0);
  });

  it("does not append when a needed day is missing, and keeps the union of data-only weeks", () => {
    const withDataOnly = { ...prev, data_only_weeks: ["2026-10-12"] };
    const days = dayMap(synthDays("2023-01-01", CUTOFF).filter((d) => d[0] !== "2026-10-28"));
    const next = extendSeries(withDataOnly, sources({ days, dataOnlyDates: ["2026-10-21"] }), CUTOFF);
    expect(next.weeks).toEqual(prev.weeks);
    expect(next.data_only_weeks).toEqual(["2026-10-12", "2026-10-19"]);
  });

  it("starts from 2023-01-02 when the previous file has no weeks", () => {
    const empty = { ...prev, weeks: [], flood_n13: [], flood_n13_kernel: [], flood_n13_year_ago: [], window_at_disclosure_share: [], window_at_disclosure_ci80: [], window_after_median: [],
      window_after_median_ci80: [], window_cohort_n: [], kev_recent_weekly: [], kev_weekly: [], ai_weekly: { anthropic: [], openai: [], google: [], other: [] }, ai_ledger_only_weekly: [], data_only_weeks: [] };
    expect(extendSeries(empty, sources(), CUTOFF)).toEqual(weeklySeries(sources(), CUTOFF, prev.live_from));
  });
});

describe("seriesUpTo and seriesSlice", () => {
  const file = weeklySeries(sources({ dataOnlyDates: ["2024-01-03", "2025-01-08", "2026-10-27"] }), CUTOFF, liveFromAfter(CUTOFF));

  it("seriesUpTo cuts every array to the weeks on or before the given Monday", () => {
    const cut = seriesUpTo(file, "2025-01-06");
    expect(SeriesFile.parse(cut)).toEqual(cut);
    expect(cut.weeks.at(-1)).toBe("2025-01-06");
    expect(cut.data_only_weeks).toEqual(["2024-01-01", "2025-01-06"]);
    expect(seriesUpTo(file, "2030-01-07")).toBe(file);
  });

  it("seriesSlice gives the last 104 weeks, which parse as Series", () => {
    const s = seriesSlice(file);
    expect(Series.parse(s)).toEqual(s);
    expect(s.weeks.length).toBe(104);
    expect(s.weeks[0]).toBe(file.weeks[200 - 104]);
    expect(s.weeks.at(-1)).toBe("2026-10-26");
    expect(s.data_only_weeks).toEqual(["2025-01-06", "2026-10-26"]);
    expect(s.live_from).toBe(file.live_from);
  });

  it("seriesSlice throws with fewer than 104 weeks or a null count inside the slice", () => {
    expect(() => seriesSlice(seriesUpTo(file, "2024-12-16"))).toThrow(/104 are needed/);
    const holed = { ...file, window_cohort_n: file.window_cohort_n.map((x, i) => (i === 150 ? null : x)) };
    expect(() => seriesSlice(holed)).toThrow(/window_cohort_n is null in week/);
    expect(() => seriesSlice(file, 195)).toThrow(/flood_n13 is null in week 2023-02-06/);
  });
});

describe("liveFromAfter (R19)", () => {
  it("is the Monday after the cutoff's ISO week", () => {
    expect(liveFromAfter("2026-11-06")).toBe("2026-11-09");
    expect(liveFromAfter("2026-11-09")).toBe("2026-11-16");
    expect(liveFromAfter("2026-11-08")).toBe("2026-11-09");
  });
});
