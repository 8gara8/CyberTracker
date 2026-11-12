// SPEC §7 "GapPanel and charts", chart A, The Flood ("NEW CVE RECORDS, 13-WEEK TOTAL"): flood_n13 solid ink,
// flood_n13_year_ago dashed (4 3) muted, flood_n13_kernel hatched from 0, the y top niceMax of all three;
// direct labels for the latest total and "a year earlier"; a <title> per week; the annotations' markers; the
// data table. On a mid-week cutoff the lines run on to the latest point, the block's own 13 weeks to the cutoff
// (§7 "Latest point"), so the end label is the figure the Gap's second line and the aria-label print, and the
// table's first row is that point. Rendered only with a non-null block (GapPanel shows the caption's "not
// available" line instead). Owner: gap lane. Nothing here is counted: GapPanel passes the caption in, already
// marked.
import type { ReactNode } from "react";
import { chartName } from "@/lib/page-text";
import { fmtInt } from "@/lib/metrics/stats";
import type { Annotation } from "@/lib/schema/config";
import type { Flood, Series } from "@/lib/schema/metrics";
import { CHART_TITLES, NOT_AVAILABLE, YEAR_EARLIER, floodLabel, latestRowLabel, sourceOf, tableSummary, weekOf } from "./labels";
import {
  AreaPath, ChartFigure, ChartSvg, DataTable, DirectLabel, HatchDefs, HoverColumns, LinePath, LiveTick, MarkerKey, Markers, YGrid,
  YearTicks, hatchFill, placeMarkers, sideOf,
} from "./parts";
import { H, M, PLOT_H, fmtTick, latestPoint, niceMax, ticks, weekScale, xWithLatest, yScale } from "./scale";

export interface FloodChartProps {
  series: Series;
  flood: Flood;
  /** The annotations whose panels include "flood"; the chart drops those off its axis. */
  markers: Annotation[];
  /** The counted caption lines (chartCaptions().flood), marked by GapPanel; shown under the marker key (added in P4). */
  caption?: ReactNode;
}

const nonNull = (v: number | null): v is number => v !== null;

export function FloodChart({ series, flood, markers, caption }: FloodChartProps) {
  const { weeks } = series;
  const scale = weekScale(weeks);
  const latest = latestPoint(weeks, scale, flood.to);
  const x = xWithLatest(scale, weeks.length, latest);
  const lastWeek = weeks.length - 1;
  // The latest point extends each line; the year-ago line only where it has a last week to run on from.
  const total = latest ? [...series.flood_n13, flood.n] : series.flood_n13;
  const kernel = latest ? [...series.flood_n13_kernel, flood.kernel_n] : series.flood_n13_kernel;
  const ago = latest
    ? [...series.flood_n13_year_ago, lastWeek >= 0 && series.flood_n13_year_ago[lastWeek] != null ? flood.year_ago.n : null]
    : series.flood_n13_year_ago;
  const top = niceMax(Math.max(0, ...total, ...kernel, ...ago.filter(nonNull)));
  const y = yScale(top, PLOT_H);
  const bottom = M.t + PLOT_H;
  const placed = placeMarkers(markers, weeks, scale);
  const last = total.length - 1;
  const lastTotal = last >= 0 ? total[last]! : null;
  const lastAgo = last >= 0 ? ago[last] ?? null : null;

  const agoText = (v: number | null) => (v === null ? NOT_AVAILABLE : fmtInt(v));
  const titles = weeks.map((w, i) =>
    `${weekOf(w)} · 13-week CVE records: ${fmtInt(total[i]!)} · Linux kernel: ${fmtInt(kernel[i]!)} · ${YEAR_EARLIER}: ${agoText(ago[i] ?? null)}`);
  const rows = weeks.map((w, i) => [weekOf(w), fmtInt(total[i]!), fmtInt(kernel[i]!), agoText(ago[i] ?? null), sourceOf(w, series.live_from)]).reverse();
  if (latest) rows.unshift([latestRowLabel(flood.to), fmtInt(flood.n), fmtInt(flood.kernel_n), agoText(ago[last] ?? null), sourceOf(latest.week, series.live_from)]);

  return (
    <ChartFigure id="flood" name={chartName("flood")} title={CHART_TITLES.flood}>
      <ChartSvg label={floodLabel(flood)} height={H}>
        <HatchDefs id="flood" />
        <YGrid ticks={ticks(top)} y={y} format={fmtTick} />
        <YearTicks weeks={weeks} scale={scale} top={M.t} bottom={bottom} />
        <Markers markers={placed} top={M.t} bottom={bottom} />
        <AreaPath values={kernel} x={x} y={y} fill={hatchFill("flood")} />
        <LinePath values={ago} x={x} y={y} stroke="var(--muted)" dash="4 3" />
        <LinePath values={total} x={x} y={y} stroke="var(--ink)" />
        <LiveTick liveFrom={series.live_from} scale={scale} bottom={bottom} />
        {lastAgo !== null
          ? <DirectLabel x={x(last)} y={y(lastAgo)} text={YEAR_EARLIER} anchor="end"
            dy={sideOf(y(lastAgo), lastTotal === null ? null : y(lastTotal), M.t, PLOT_H)} />
          : null}
        {lastTotal !== null ? <DirectLabel x={x(last)} y={y(lastTotal)} text={fmtInt(lastTotal)} /> : null}
        <HoverColumns titles={titles} x={scale.x} step={scale.step} top={M.t} bottom={bottom} />
      </ChartSvg>
      <MarkerKey markers={placed} />
      {caption}
      <DataTable summary={tableSummary(chartName("flood"))} head={["Week", "13-week CVE records", "Linux kernel", "A year earlier", "Source"]} rows={rows} />
    </ChartFigure>
  );
}
