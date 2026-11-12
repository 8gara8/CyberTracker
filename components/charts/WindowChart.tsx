// SPEC §7 "GapPanel and charts", chart B, The Window ("ROLLING 26 WEEKS"), three rows on the shared axis:
// row 1 the at-disclosure share, an ink line with its 80% band and the 2023–24 reference flat dashed muted, on a
// fixed 0 to 100% axis; row 2 the median days for the rest, likewise, its top niceMax of the band tops; row 3 the
// weekly KEV bars, 0.7 week wide, all as a muted outline with cohort R filled var(--ink-soft) in front. Rows 1
// and 2 name their 2023–24 value on the row's title line, by a dashed key, not inside the plot, where the
// noisy line and band crossed it. On a mid-week cutoff the line and band of rows 1 and 2 run on to the latest
// point, window.w26's own 26 weeks to the cutoff (§7 "Latest point"), so the end labels are the figures the
// headline and the aria-label print, and the weekly table's first row is that point. Hover titles end "(KEV
// dates are US dates)". Under row 3 the marker key, the caption GapPanel passes in, the weekly data table and
// §5.3's Gap data table by period. Rendered only with a non-null block. Owner: gap lane.
import type { ReactNode } from "react";
import { chartName } from "@/lib/page-text";
import { fmtDays, fmtInt, fmtPct, pct } from "@/lib/metrics/stats";
import type { Annotation } from "@/lib/schema/config";
import type { GapWindow, Series, WindowStats } from "@/lib/schema/metrics";
import { MIN_N } from "@/lib/vocab";
import { CHART_TITLES, KEV_US_DATES, N_TOO_SMALL, REF, WINDOW_ROWS, latestRowLabel, sourceOf, tableSummary, weekOf, windowLabel } from "./labels";
import {
  BandPath, Bars, ChartFigure, ChartSvg, DataTable, DirectLabel, HoverColumns, LinePath, LiveTick, MarkerKey, Markers, NTooSmall, RefLine,
  YGrid, YearTicks, placeMarkers, type PlacedMarker,
} from "./parts";
import {
  H, M, PLOT_H, STRIP_H, STRIP_VIEW_H, fmtShareTick, fmtTick, latestPoint, niceMax, shareCount, shareShown, ticks, weekScale, xWithLatest, yScale,
  type LatestPoint, type WeekScale,
} from "./scale";
import { WindowPeriods } from "./WindowPeriods";

export interface WindowChartProps {
  series: Series;
  window: GapWindow;
  /** The annotations whose panels include "window"; the chart drops those off its axis. */
  markers: Annotation[];
  /** The counted caption (chartCaptions().window), marked by GapPanel; shown under row 3 (added in P4). */
  caption?: ReactNode;
}

type Band = readonly [number, number] | null;

const bandText = (b: Band, f: (v: number) => string) => (b ? `${f(b[0])}–${f(b[1])}` : "");

/**
 * A row's title line: the row name, and on the right an optional label (row 3's "this week: R of all") or, for
 * rows 1 and 2, the 2023–24 key: a short dashed rule like the plot's reference line, then "2023–24 <value>".
 * ml-auto keeps it on the right when it wraps under a long row name at 375px.
 */
function RowTitle({ text, right, refKey }: { text: string; right?: string; refKey?: string }) {
  return (
    <p className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 text-[13px] text-soft">
      <span>{text}</span>
      {right ? <span className="ml-auto font-mono text-[12px] font-semibold text-fg">{right}</span> : null}
      {refKey ? (
        <span className="ml-auto font-mono text-[12px] font-semibold text-fg">
          <span aria-hidden="true" className="mr-1.5 inline-block w-4 border-t-[1.5px] border-dashed border-muted align-middle" />
          {refKey}
        </span>
      ) : null}
    </p>
  );
}

interface RowProps {
  series: Series;
  scale: WeekScale;
  placed: PlacedMarker[];
  letters: boolean;
  label?: string;
}

/** Rows 1 and 2 also take window.w26 and the latest point it draws (null: the line ends with the last week). */
interface LineRowProps extends RowProps {
  w26: WindowStats;
  latest: LatestPoint | null;
}

/** The 2023–24 share as rows 1's key, the hover titles and the aria-label print it. */
const refShareText = (ref: WindowStats) => (ref.cohort_n >= MIN_N ? `${pct(ref.at_disclosure_n, ref.cohort_n)}%` : N_TOO_SMALL);
/** The 2023–24 median as row 2's key and hover titles print it ("21 d"). */
const refDaysText = (ref: WindowStats) => (ref.after_disclosure_median_days === null ? N_TOO_SMALL : `${fmtDays(ref.after_disclosure_median_days)} d`);
/** window.w26's share as the headline prints it, pct(at_disclosure_n, cohort_n); null below MIN_N. */
const w26Share = (w: WindowStats) => (w.cohort_n >= MIN_N && w.at_disclosure_share !== null ? `${pct(w.at_disclosure_n, w.cohort_n)}%` : null);

/** The axis furniture every row shares: year ticks, markers and the live_from tick. */
function Axis({ series, scale, placed, letters, bottom }: Omit<RowProps, "label"> & { bottom: number }) {
  return (
    <>
      <YearTicks weeks={series.weeks} scale={scale} top={M.t} bottom={bottom} />
      <Markers markers={placed} top={M.t} bottom={bottom} letters={letters} />
      <LiveTick liveFrom={series.live_from} scale={scale} bottom={bottom} />
    </>
  );
}

/** Row 1: the share already exploited at disclosure, fixed 0 to 100%. */
function ShareRow({ series, scale, placed, letters, label, window: win, w26, latest }: LineRowProps & { window: GapWindow }) {
  const n = series.window_cohort_n;
  const weeks = series.weeks.length;
  const x = xWithLatest(scale, weeks, latest);
  const latestShare = w26Share(w26) === null ? null : w26.at_disclosure_share;
  const share = latest ? [...series.window_at_disclosure_share, latestShare] : series.window_at_disclosure_share;
  const bands = latest ? [...series.window_at_disclosure_ci80, latestShare === null ? null : w26.at_disclosure_ci80] : series.window_at_disclosure_ci80;
  const y = yScale(1, PLOT_H);
  const bottom = M.t + PLOT_H;
  const last = share.length - 1;
  const refShare = win.reference.at_disclosure_share;
  const refText = refShareText(win.reference);
  const text = last < 0 ? null : latest ? w26Share(w26) : shareShown(share[last] ?? null, n[last]!);
  const titles = series.weeks.map((w, i) => {
    const shown = shareShown(share[i] ?? null, n[i]!);
    const ci = series.window_at_disclosure_ci80[i] ?? null;
    const value = shown ? `${shown} of ${fmtInt(n[i]!)}${ci ? ` (80% interval ${bandText(ci, fmtPct)})` : ""}` : `${N_TOO_SMALL} (${fmtInt(n[i]!)} recent flaws)`;
    return `${weekOf(w)} · already exploited at disclosure, 26 weeks: ${value} · ${REF}: ${refText} ${KEV_US_DATES}`;
  });
  return (
    <ChartSvg label={label} height={H}>
      <YGrid ticks={ticks(1)} y={y} format={fmtShareTick} />
      <Axis series={series} scale={scale} placed={placed} letters={letters} bottom={bottom} />
      <BandPath bands={bands} x={x} y={y} />
      {refShare !== null ? <RefLine value={refShare} y={y} /> : null}
      <LinePath values={share} x={x} y={y} stroke="var(--ink)" />
      {text !== null ? <DirectLabel x={x(last)} y={y(share[last]!)} text={text} /> : <NTooSmall text={N_TOO_SMALL} plotTop={M.t} plotH={PLOT_H} avoid={refShare === null ? null : y(refShare)} />}
      <HoverColumns titles={titles} x={scale.x} step={scale.step} top={M.t} bottom={bottom} />
    </ChartSvg>
  );
}

/** Row 2: the median days to CISA listing for the rest, top niceMax of the band tops (and the values drawn). */
function MedianRow({ series, scale, placed, letters, window: win, w26, latest }: LineRowProps & { window: GapWindow }) {
  const weeks = series.weeks.length;
  const x = xWithLatest(scale, weeks, latest);
  const med = latest ? [...series.window_after_median, w26.after_disclosure_median_days] : series.window_after_median;
  const bands = latest
    ? [...series.window_after_median_ci80, w26.after_disclosure_median_days === null ? null : w26.after_disclosure_median_ci80]
    : series.window_after_median_ci80;
  const refDays = win.reference.after_disclosure_median_days;
  const tops = [...bands.flatMap((b) => (b ? [b[1]] : [])), ...med.filter((v): v is number => v !== null), refDays ?? 0];
  const top = niceMax(Math.max(0, ...tops));
  const y = yScale(top, PLOT_H);
  const bottom = M.t + PLOT_H;
  const last = med.length - 1;
  const latestDays = last >= 0 ? med[last] ?? null : null;
  const refText = refDaysText(win.reference);
  const titles = series.weeks.map((w, i) => {
    const m = med[i] ?? null;
    const ci = bands[i] ?? null;
    const value = m === null ? N_TOO_SMALL : `${fmtDays(m)} days${ci ? ` (80% interval ${bandText(ci, fmtDays)})` : ""}`;
    return `${weekOf(w)} · median days to CISA listing for the rest, 26 weeks: ${value} · ${REF}: ${refText} ${KEV_US_DATES}`;
  });
  return (
    <ChartSvg height={H}>
      <YGrid ticks={ticks(top)} y={y} format={fmtTick} />
      <Axis series={series} scale={scale} placed={placed} letters={letters} bottom={bottom} />
      <BandPath bands={bands} x={x} y={y} />
      {refDays !== null ? <RefLine value={refDays} y={y} /> : null}
      <LinePath values={med} x={x} y={y} stroke="var(--ink)" />
      {latestDays !== null ? <DirectLabel x={x(last)} y={y(latestDays)} text={`${fmtDays(latestDays)} d`} />
        : <NTooSmall text={N_TOO_SMALL} plotTop={M.t} plotH={PLOT_H} avoid={refDays === null ? null : y(refDays)} />}
      <HoverColumns titles={titles} x={scale.x} step={scale.step} top={M.t} bottom={bottom} />
    </ChartSvg>
  );
}

/** Row 3: the weekly KEV bars, all CISA listed (muted outline) with cohort R (filled var(--ink-soft)) in front. */
function KevRow({ series, scale, placed, letters }: RowProps) {
  const all = series.kev_weekly;
  const recent = series.kev_recent_weekly;
  const top = niceMax(Math.max(0, ...all));
  const y = yScale(top, STRIP_H);
  const bottom = M.t + STRIP_H;
  const width = scale.step * 0.7;
  const titles = series.weeks.map((w, i) =>
    `${weekOf(w)} · listed by CISA: ${fmtInt(all[i]!)} · of them recent flaws: ${fmtInt(recent[i]!)} ${KEV_US_DATES}`);
  return (
    <ChartSvg height={STRIP_VIEW_H}>
      <YGrid ticks={ticks(top)} y={y} format={fmtTick} />
      <Axis series={series} scale={scale} placed={placed} letters={letters} bottom={bottom} />
      <Bars values={all} x={scale.x} y={y} width={width} fill="none" stroke="var(--muted)" />
      <Bars values={recent} x={scale.x} y={y} width={width} fill="var(--ink-soft)" />
      <HoverColumns titles={titles} x={scale.x} step={scale.step} top={M.t} bottom={bottom} />
    </ChartSvg>
  );
}

export function WindowChart({ series, window: win, markers, caption }: WindowChartProps) {
  const { weeks } = series;
  const scale = weekScale(weeks);
  const placed = placeMarkers(markers, weeks, scale);
  const w26 = win.w26;
  const latest = latestPoint(weeks, scale, w26.to);
  const last = weeks.length - 1;
  const thisWeek = last >= 0 ? `this week: ${fmtInt(series.kev_recent_weekly[last]!)} of ${fmtInt(series.kev_weekly[last]!)}` : undefined;
  const share = series.window_at_disclosure_share;
  const n = series.window_cohort_n;
  const rows = weeks.map((w, i) => {
    const s = shareShown(share[i] ?? null, n[i]!);
    const k = s !== null && share[i] != null ? shareCount(share[i]!, n[i]!) : null;
    const m = series.window_after_median[i] ?? null;
    return [
      weekOf(w),
      s ?? N_TOO_SMALL,
      s ? bandText(series.window_at_disclosure_ci80[i] ?? null, fmtPct) : "",
      fmtInt(n[i]!),
      m === null ? N_TOO_SMALL : fmtDays(m),
      m === null ? "" : bandText(series.window_after_median_ci80[i] ?? null, fmtDays),
      k === null ? "" : fmtInt(n[i]! - k),
      fmtInt(series.kev_weekly[i]!),
      fmtInt(series.kev_recent_weekly[i]!),
      sourceOf(w, series.live_from),
    ];
  }).reverse();
  if (latest) {
    // The latest point's row: window.w26 to the cutoff; the weekly KEV columns are blank (it is no week of its own).
    const s = w26Share(w26);
    const m = w26.after_disclosure_median_days;
    rows.unshift([
      latestRowLabel(w26.to),
      s ?? N_TOO_SMALL,
      s ? bandText(w26.at_disclosure_ci80, fmtPct) : "",
      fmtInt(w26.cohort_n),
      m === null ? N_TOO_SMALL : fmtDays(m),
      m === null ? "" : bandText(w26.after_disclosure_median_ci80, fmtDays),
      s === null ? "" : fmtInt(w26.cohort_n - w26.at_disclosure_n),
      "",
      "",
      sourceOf(latest.week, series.live_from),
    ]);
  }
  const ref = win.reference;
  const shareKey = ref.at_disclosure_share !== null ? `${REF} ${refShareText(ref)}` : undefined;
  const daysKey = ref.after_disclosure_median_days !== null ? `${REF} ${refDaysText(ref)}` : undefined;
  const head = [
    "Week", "Already exploited at disclosure", "80% interval", "Recent flaws, 26 weeks (n)", "Median days, the rest", "80% interval",
    "Listed after disclosure (n)", "Listed by CISA this week", "Recent flaws listed this week", "Source",
  ];
  return (
    <ChartFigure id="window" name={chartName("window")} title={CHART_TITLES.window}>
      <RowTitle text={WINDOW_ROWS.share} refKey={shareKey} />
      <ShareRow series={series} scale={scale} placed={placed} letters label={windowLabel(win)} window={win} w26={w26} latest={latest} />
      <RowTitle text={WINDOW_ROWS.median} refKey={daysKey} />
      <MedianRow series={series} scale={scale} placed={placed} letters={false} window={win} w26={w26} latest={latest} />
      <RowTitle text={WINDOW_ROWS.kev} right={thisWeek} />
      <KevRow series={series} scale={scale} placed={placed} letters={false} />
      <MarkerKey markers={placed} />
      {caption}
      <DataTable summary={tableSummary(chartName("window"))} head={head} rows={rows} />
      <WindowPeriods window={win} />
    </ChartFigure>
  );
}
