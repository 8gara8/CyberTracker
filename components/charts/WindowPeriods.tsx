// SPEC §5.3 "Data table" (Gap panel, "details"): the Window by period, one column each for 26 weeks, 13 weeks and
// the 2023 to 2024 reference, headed with their dates, then §5.3's line on how a change is called. Every number
// is gapTableDisplays()'s display string (lib/metrics/headline.ts), the same strings the validator reads
// (metricNumbers(), §4.12), looked up by key; a display that function leaves out (a share, median or interval
// below MIN_N) shows "n too small". Not counted (§7). Owner: gap lane; rendered under chart B.
import { gapTableDisplays } from "@/lib/metrics/headline";
import { chartName } from "@/lib/page-text";
import type { GapWindow } from "@/lib/schema/metrics";
import { CHANGE_CALL_LINE, N_TOO_SMALL, PERIOD_ROWS, REF, dateRange, tableSummary } from "./labels";
import { DataTable } from "./parts";

const COLUMNS = [["w26", "26 weeks"], ["w13", "13 weeks"], ["reference", REF]] as const;

export function WindowPeriods({ window: win }: { window: GapWindow }) {
  const shown = new Map(gapTableDisplays(win).map((d) => [d.key, d.display]));
  const get = (key: string) => shown.get(key) ?? null;
  const cell = (col: (typeof COLUMNS)[number][0], row: keyof typeof PERIOD_ROWS): string => {
    const p = `window.${col}`;
    const interval = (key: string) => {
      const lo = get(`${p}.${key}.0`);
      const hi = get(`${p}.${key}.1`);
      return lo && hi ? ` (80% interval ${lo}–${hi})` : "";
    };
    const withShare = (count: string, share: string) => {
      const s = get(`${p}.${share}`);
      return `${get(`${p}.${count}`)!}${s ? ` · ${s}` : ` · share ${N_TOO_SMALL}`}`;
    };
    switch (row) {
      case "kev": {
        const pace = col === "w26" ? get("window.kev_pace_ratio") : null;
        return `${get(`${p}.kev_added_n`)!}${pace ? ` (pace vs ${REF}: ${pace}×)` : ""}`;
      }
      case "unjoined": return get(`${p}.unjoined_n`)!;
      case "cohort": return get(`${p}.cohort_n`)!;
      case "atDisclosure": return withShare("at_disclosure_n", "at_disclosure_share") + interval("at_disclosure_ci80");
      case "nDay": return withShare("n_day_n", "n_day_share");
      case "late": return get(`${p}.late_listed_n`)!;
      case "median": {
        const m = get(`${p}.after_disclosure_median_days`);
        return m ? `${m}${interval("after_disclosure_median_ci80")}` : N_TOO_SMALL;
      }
      case "p7": return withShare("k7_n", "p7") + interval("p7_ci80");
      case "old": {
        const pace = col === "reference" ? null : get(`window.reference.old_listed_pace_${col === "w26" ? "26w" : "13w"}`);
        return `${get(`${p}.old_listed_n`)!}${pace ? ` (${REF} pace: ${pace})` : ""}`;
      }
    }
  };
  const head = ["Measure", ...COLUMNS.map(([col, name]) => `${name}, ${dateRange(win[col].from, win[col].to)}`)];
  const rows = (Object.keys(PERIOD_ROWS) as (keyof typeof PERIOD_ROWS)[]).map((row) => [PERIOD_ROWS[row], ...COLUMNS.map(([col]) => cell(col, row))]);
  return (
    <>
      <DataTable summary={tableSummary(`${chartName("window")} by period`)} head={head} rows={rows} wrap />
      <p className="mt-1 max-w-[72ch] text-[12px] text-muted">{CHANGE_CALL_LINE}</p>
    </>
  );
}
