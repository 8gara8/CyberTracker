// content/state/series.json and metrics.series (SPEC §5.9, §4.7): one point per ISO week from 2023-01-02.
// Pure. P2 WP3 fills these stubs (S0 contract).

import type { AiCreditsFile, DayRow, Series, SeriesFile } from "../schema/metrics";
import type { JoinRow } from "./window";

/** The first Monday of the series. */
export const SERIES_FROM = "2023-01-02";

export interface SeriesSources {
  days: ReadonlyMap<string, DayRow>;
  rows: readonly JoinRow[];
  credits: AiCreditsFile;
  /** Taipei dates of data-only editions. */
  dataOnlyDates: readonly string[];
}

/** series.json from SERIES_FROM to the newest complete week (the backfill). */
export function weeklySeries(src: SeriesSources, cutoff: string, liveFrom: string): SeriesFile {
  throw new Error("not implemented: weeklySeries");
}

/** A morning's series: new complete weeks appended (stopping at a missing day), Flood weeks frozen, Window, KEV and every AI week recomputed. */
export function extendSeries(prev: SeriesFile, src: SeriesSources, cutoff: string): SeriesFile {
  throw new Error("not implemented: extendSeries");
}

/** metrics.series: the last `weeks` (default 104) of series.json; throws if fewer, or if a count there is null. */
export function seriesSlice(file: SeriesFile, weeks?: number): Series {
  throw new Error("not implemented: seriesSlice");
}

/** live_from for a build to `cutoff`: addDays(isoWeekStart(cutoff), 7). */
export function liveFromAfter(cutoff: string): string {
  throw new Error("not implemented: liveFromAfter");
}
