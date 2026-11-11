// SPEC §7 "GapPanel and charts", chart C, AI-credited ("WEEKLY RECORDS, LOWER BOUND"): weekly bars in var(--ai),
// stacked by family (OpenAI, Google and other solid; Anthropic on top at fill-opacity 0.4), the weeks from
// ai_credited.provisional_from hatched; the y top niceMax of the weekly totals; the direct label "13 wk: <total>
// · without Anthropic <ex_anthropic>". The family split is in the hover titles and the data table, and
// ledger_only_anthropic (ai_ledger_only_weekly) only in the table. The only chart that uses var(--ai). Chart C's
// text key is the first caption line, which GapPanel passes in already marked. Owner: gap lane.
import type { ReactNode } from "react";
import { chartName } from "@/lib/page-text";
import { fmtInt } from "@/lib/metrics/stats";
import type { Annotation } from "@/lib/schema/config";
import type { AiCredited, Series } from "@/lib/schema/metrics";
import { CHART_TITLES, FAMILY_NAMES, FAMILY_ORDER, SOURCE, aiLabel, tableSummary, weekOf } from "./labels";
import {
  ChartFigure, ChartSvg, DataTable, HatchDefs, HoverColumns, LiveTick, MarkerKey, Markers, StackBars, YGrid, YearTicks, hatchFill, placeMarkers,
} from "./parts";
import { H, M, PLOT_H, PLOT_RIGHT, fmtTick, niceMax, r2, ticks, weekScale, yScale } from "./scale";

export interface AiCreditedChartProps {
  series: Series;
  ai: AiCredited;
  /** The annotations whose panels include "ai"; the chart drops those off its axis. */
  markers: Annotation[];
  /** The counted lines under the chart (chartCaptions().ai and .aiInKev: the text key, the caption, the in-KEV list), marked by GapPanel (added in P4). */
  caption?: ReactNode;
}

const PROVISIONAL = "provisional";

export function AiCreditedChart({ series, ai, markers, caption }: AiCreditedChartProps) {
  const { weeks } = series;
  const fam = series.ai_weekly;
  const scale = weekScale(weeks);
  const totals = weeks.map((_, i) => fam.anthropic[i]! + fam.openai[i]! + fam.google[i]! + fam.other[i]!);
  const solid = weeks.map((_, i) => fam.openai[i]! + fam.google[i]! + fam.other[i]!);
  const top = niceMax(Math.max(0, ...totals));
  const y = yScale(top, PLOT_H);
  const bottom = M.t + PLOT_H;
  const width = scale.step * 0.7;
  const placed = placeMarkers(markers, weeks, scale);
  const provisional = weeks.findIndex((w) => w >= ai.provisional_from);
  const isProvisional = (i: number) => provisional >= 0 && i >= provisional;
  const zero = weeks.map(() => 0);

  const titles = weeks.map((w, i) => [
    `${weekOf(w)} · AI-credited: ${fmtInt(totals[i]!)}`,
    ...FAMILY_ORDER.map((f) => `${FAMILY_NAMES[f]}: ${fmtInt(fam[f][i]!)}`),
  ].join(" · ") + (isProvisional(i) ? ` (${PROVISIONAL})` : ""));
  const rows = weeks.map((w, i) => [
    weekOf(w), fmtInt(totals[i]!), fmtInt(fam.anthropic[i]!), fmtInt(fam.openai[i]!), fmtInt(fam.google[i]!), fmtInt(fam.other[i]!),
    fmtInt(series.ai_ledger_only_weekly[i]!), isProvisional(i) ? "yes" : "no", w < series.live_from ? SOURCE.backfill : SOURCE.live,
  ]).reverse();
  const head = ["Week", "AI-credited", "Anthropic", "OpenAI", "Google", "Other", "Anthropic ledger only, not in the total", "Provisional", "Source"];

  return (
    <ChartFigure id="ai" name={chartName("ai")} title={CHART_TITLES.ai}>
      <p className="mt-1 font-mono text-[12px] font-semibold text-fg">{`13 wk: ${fmtInt(ai.w13.total)} · without Anthropic ${fmtInt(ai.w13.ex_anthropic)}`}</p>
      <ChartSvg label={aiLabel(ai)} height={H}>
        <HatchDefs id="ai" />
        <YGrid ticks={ticks(top)} y={y} format={fmtTick} />
        <YearTicks weeks={weeks} scale={scale} top={M.t} bottom={bottom} />
        <Markers markers={placed} top={M.t} bottom={bottom} />
        <StackBars from={zero} values={solid} x={scale.x} y={y} width={width} fill="var(--ai)" />
        <StackBars from={solid} values={fam.anthropic} x={scale.x} y={y} width={width} fill="var(--ai)" fillOpacity={0.4} />
        {provisional >= 0
          ? <rect x={r2(scale.x(provisional) - scale.step / 2)} y={M.t} width={r2(PLOT_RIGHT - (scale.x(provisional) - scale.step / 2))} height={PLOT_H}
            fill={hatchFill("ai")} />
          : null}
        <LiveTick liveFrom={series.live_from} scale={scale} bottom={bottom} />
        <HoverColumns titles={titles} x={scale.x} step={scale.step} top={M.t} bottom={bottom} />
      </ChartSvg>
      <MarkerKey markers={placed} />
      {caption}
      <DataTable summary={tableSummary(chartName("ai"))} head={head} rows={rows} />
    </ChartFigure>
  );
}
