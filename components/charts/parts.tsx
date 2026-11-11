// SPEC §7 "GapPanel and charts", Chart conventions: the server SVG parts the three Gap charts share. No
// library and no client JS: hover is a transparent <rect> per week with a <title>, and every chart has its
// data in a <details> table. Gridlines var(--border) dashed 1 3; lines 1.5 with non-scaling strokes; axis text
// 11 units mono muted; direct labels 12 units, 600, ink, with a dot (r 2.5); markers muted dashed 2 2 with a
// letter key; hatching a 45° muted <pattern> whose id is prefixed with the chart id. No rx anywhere, and nothing
// here is marked as counted (§7 "Script-written page text"). Owner: gap lane; only components/charts/ and the
// gap lane's GapPanel use these, so their props are the gap lane's to change.
import type { ReactNode } from "react";
import { shortDate } from "@/lib/format";
import type { Annotation } from "@/lib/schema/config";
import { CHART_LETTERS } from "./labels";
import { M, PLOT_RIGHT, W, letter, r2, runs, type WeekScale } from "./scale";

const AXIS_FONT = 11;
const LABEL_FONT = 12;
const MONO = "var(--font-mono)";
/** A halo in the panel colour behind label text, so a label stays legible where it crosses a mark. */
const HALO = { stroke: "var(--bg)", strokeWidth: 3, strokeLinejoin: "round" as const, paintOrder: "stroke" };

// ── Figure, svg and table ────────────────────────────────────────────────────────────────────────

export type ChartId = keyof typeof CHART_LETTERS;

export interface ChartFigureProps {
  /** The chart's id, a fixed string ("flood", "window", "ai"): the figure is `chart-<id>` and pattern ids are prefixed with it. */
  id: ChartId;
  /** The chart's name (chartName(): "The Flood"). */
  name: string;
  /** The title above the plot ("NEW CVE RECORDS, 13-WEEK TOTAL"). */
  title: string;
  /** The svg rows, then the marker key, the caption lines and the data tables. */
  children: ReactNode;
}

/** A chart: its figcaption ("A · The Flood", then the title), then its content, at most 560px wide. */
export function ChartFigure({ id, name, title, children }: ChartFigureProps) {
  return (
    <figure id={`chart-${id}`} className="mt-7 max-w-[560px]">
      <figcaption className="mb-1 flex flex-wrap items-baseline gap-x-3">
        <span className="font-sans text-[14px] font-semibold text-fg">{CHART_LETTERS[id]} · {name}</span>
        <span className="kicker">{title}</span>
      </figcaption>
      {children}
    </figure>
  );
}

export interface ChartSvgProps {
  /** chartLabel(): the svg's aria-label. Without one the svg is decorative (aria-hidden), as chart B's rows 2 and 3 are. */
  label?: string;
  /** viewBox height (108, or 60 for the Window's bar strip). */
  height: number;
  children: ReactNode;
}

/** `<svg viewBox="0 0 400 H" className="block w-full" role="img" aria-label={chartLabel()}>` (§7). */
export function ChartSvg({ label, height, children }: ChartSvgProps) {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return <svg viewBox={`0 0 ${W} ${height}`} className="block w-full" {...a11y}>{children}</svg>;
}

export interface DataTableProps {
  /** "Data table: <chart name>". */
  summary: string;
  head: string[];
  /** Newest week first; the first cell of each row is its row header. */
  rows: string[][];
  /** Let the row headers wrap (the Gap data table's long row names); week rows stay on one line. */
  wrap?: boolean;
}

/** Cell styles set once on the table (descendant variants), so a 104-row table carries no per-cell classes. */
const TABLE = "tabular w-full border-collapse text-[12px] text-soft [&_td]:py-0.5 [&_td]:pr-3 [&_td]:align-top [&_td]:whitespace-nowrap "
  + "[&_tbody_th]:py-0.5 [&_tbody_th]:pr-3 [&_tbody_th]:text-left [&_tbody_th]:align-top [&_tbody_th]:font-normal "
  + "[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:border-b [&_thead_th]:border-line [&_thead_th]:bg-bg [&_thead_th]:py-1 "
  + "[&_thead_th]:pr-3 [&_thead_th]:text-left [&_thead_th]:align-bottom [&_thead_th]:font-semibold [&_thead_th]:text-fg";

/** A closed <details> with the chart's numbers as a table (§7): the first column is each row's header. */
export function DataTable({ summary, head, rows, wrap = false }: DataTableProps) {
  return (
    <details className="mt-2">
      <summary className="kicker cursor-pointer py-2">{summary}</summary>
      <div className="max-h-72 overflow-auto">
        <table className={`${TABLE} ${wrap ? "[&_tbody_th]:min-w-[16ch]" : "[&_tbody_th]:whitespace-nowrap"}`}>
          <thead><tr>{head.map((h, j) => <th key={j} scope="col">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => <tr key={i}>{r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>))}</tr>)}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ── Axes ─────────────────────────────────────────────────────────────────────────────────────────

/** Gridlines at the y ticks, var(--border) dashed 1 3, with the tick values to the left in mono muted. */
export function YGrid({ ticks, y, format }: { ticks: number[]; y: (v: number) => number; format: (v: number) => string }) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={M.l} x2={PLOT_RIGHT} y1={r2(y(t))} y2={r2(y(t))} stroke="var(--border)" strokeWidth={1} strokeDasharray="1 3" vectorEffect="non-scaling-stroke" />
          <text x={M.l - 4} y={r2(y(t) + 3.5)} textAnchor="end" fontSize={AXIS_FONT} fontFamily={MONO} fill="var(--muted)">{format(t)}</text>
        </g>
      ))}
    </g>
  );
}

/** The weeks holding each 1 January on the axis: year labels go only there (§7). */
export function yearWeeks(weeks: readonly string[], scale: WeekScale): { year: string; i: number }[] {
  if (!weeks.length) return [];
  const out: { year: string; i: number }[] = [];
  for (let y = Number(weeks[0]!.slice(0, 4)); y <= Number(weeks.at(-1)!.slice(0, 4)) + 1; y++) {
    const i = scale.weekOf(`${y}-01-01`);
    if (i !== null) out.push({ year: String(y), i });
  }
  return out;
}

/** Year labels at each year's first week, with a faint vertical gridline, under the plot (§7). */
export function YearTicks({ weeks, scale, top, bottom }: { weeks: readonly string[]; scale: WeekScale; top: number; bottom: number }) {
  return (
    <g>
      {yearWeeks(weeks, scale).map(({ year, i }) => {
        const x = r2(scale.x(i) - scale.step / 2);
        return (
          <g key={year}>
            <line x1={x} x2={x} y1={top} y2={bottom} stroke="var(--border)" strokeWidth={1} strokeDasharray="1 3" vectorEffect="non-scaling-stroke" />
            <text x={x} y={bottom + 12} textAnchor="middle" fontSize={AXIS_FONT} fontFamily={MONO} fill="var(--muted)">{year}</text>
          </g>
        );
      })}
    </g>
  );
}

/** A thin tick on the axis at series.live_from (§5.1): later weeks are live, earlier ones reconstructed. Nothing when off the axis or at its start. */
export function LiveTick({ liveFrom, scale, bottom }: { liveFrom: string; scale: WeekScale; bottom: number }) {
  const i = scale.weekOf(liveFrom);
  if (i === null || i === 0) return null;
  const x = r2(scale.x(i) - scale.step / 2);
  return <line x1={x} x2={x} y1={bottom} y2={bottom + 4} stroke="var(--muted)" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
}

// ── Marks ────────────────────────────────────────────────────────────────────────────────────────

/** "M x,y L x,y …" through the given weeks. */
function polyline(idx: readonly number[], x: (i: number) => number, yOf: (i: number) => number): string {
  return idx.map((i, k) => `${k === 0 ? "M" : "L"}${r2(x(i))},${r2(yOf(i))}`).join("");
}

/** A line broken at every null (§7 "Nulls break lines"); a lone point between nulls is a small dot. */
export function LinePath({ values, x, y, stroke, dash }: {
  values: readonly (number | null)[]; x: (i: number) => number; y: (v: number) => number; stroke: string; dash?: string;
}) {
  const segs = runs(values.length, (i) => values[i] !== null);
  return (
    <g>
      {segs.map((seg) => (seg.length === 1
        ? <circle key={seg[0]} cx={r2(x(seg[0]!))} cy={r2(y(values[seg[0]!]!))} r={1.25} fill={stroke} />
        : <path key={seg[0]} d={polyline(seg, x, (i) => y(values[i]!))} fill="none" stroke={stroke} strokeWidth={1.5}
          strokeDasharray={dash} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />))}
    </g>
  );
}

/** The 80% band (fill-opacity 0.18), drawn only over runs of weeks where both bounds exist (§7). */
export function BandPath({ bands, x, y }: { bands: readonly (readonly [number, number] | null)[]; x: (i: number) => number; y: (v: number) => number }) {
  const segs = runs(bands.length, (i) => bands[i] != null).filter((s) => s.length > 1);
  if (!segs.length) return null;
  return (
    <g>
      {segs.map((seg) => (
        <path key={seg[0]} d={`${polyline(seg, x, (i) => y(bands[i]![1]))}${polyline([...seg].reverse(), x, (i) => y(bands[i]![0])).replace(/^M/, "L")}Z`}
          fill="var(--ink)" fillOpacity={0.18} stroke="none" />
      ))}
    </g>
  );
}

/** An area from 0 up to the values, filled with a pattern (chart A's hatched kernel band). */
export function AreaPath({ values, x, y, fill }: { values: readonly number[]; x: (i: number) => number; y: (v: number) => number; fill: string }) {
  if (values.length < 2) return null;
  const idx = values.map((_, i) => i);
  const base = r2(y(0));
  return <path d={`${polyline(idx, x, (i) => y(values[i]!))}L${r2(x(idx.at(-1)!))},${base}L${r2(x(0))},${base}Z`} fill={fill} stroke="none" />;
}

/** A flat reference line across the plot, dashed 4 3 and muted (chart B's 2023–24 value). */
export function RefLine({ value, y }: { value: number; y: (v: number) => number }) {
  const yy = r2(y(value));
  return <line x1={M.l} x2={PLOT_RIGHT} y1={yy} y2={yy} stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />;
}

/** Square bars (never rx) from 0 up to each value, `width` wide around each week's centre; zero draws nothing. */
export function Bars({ values, x, y, width, fill, stroke }: {
  values: readonly number[]; x: (i: number) => number; y: (v: number) => number; width: number; fill: string; stroke?: string;
}) {
  const base = y(0);
  const line = stroke ? { stroke, strokeWidth: 1, vectorEffect: "non-scaling-stroke" as const } : {};
  return (
    <g>
      {values.map((v, i) => (v > 0
        ? <rect key={i} x={r2(x(i) - width / 2)} y={r2(y(v))} width={r2(width)} height={r2(base - y(v))} fill={fill} {...line} />
        : null))}
    </g>
  );
}

/** Stacked square bars: `from[i]` to `from[i] + values[i]` (chart C's Anthropic on top of the solid families). */
export function StackBars({ from, values, x, y, width, fill, fillOpacity }: {
  from: readonly number[]; values: readonly number[]; x: (i: number) => number; y: (v: number) => number; width: number; fill: string; fillOpacity?: number;
}) {
  return (
    <g fill={fill} fillOpacity={fillOpacity}>
      {values.map((v, i) => (v > 0
        ? <rect key={i} x={r2(x(i) - width / 2)} y={r2(y(from[i]! + v))} width={r2(width)} height={r2(y(from[i]!) - y(from[i]! + v))} />
        : null))}
    </g>
  );
}

/** The chart's hatch: a 45° muted <pattern>, id "<chart id>-hatch" (§7 "Hatching means caveated"). */
export function HatchDefs({ id }: { id: ChartId }) {
  return (
    <defs>
      <pattern id={`${id}-hatch`} patternUnits="userSpaceOnUse" width={4} height={4} patternTransform="rotate(45)">
        <line x1={0} y1={0} x2={0} y2={4} stroke="var(--muted)" strokeWidth={1.2} />
      </pattern>
    </defs>
  );
}

export const hatchFill = (id: ChartId) => `url(#${id}-hatch)`;

// ── Markers ──────────────────────────────────────────────────────────────────────────────────────

/** A marker on the axis: its letter key, the x of its date's week, and x2 for a span to its end_date. */
export interface PlacedMarker {
  key: string;
  date: string;
  endDate: string | null;
  label: string;
  detail: string;
  x: number;
  x2: number | null;
}

/**
 * The chart's markers (§7): each annotation whose date falls on the axis (the caller passes the chart's panel's
 * annotations), lettered a, b, c… by date. A span's end clamps to the axis's last week; an annotation dated
 * off the axis is not drawn.
 */
export function placeMarkers(annotations: readonly Annotation[], weeks: readonly string[], scale: WeekScale): PlacedMarker[] {
  const on = annotations
    .map((a) => ({ a, i: scale.weekOf(a.date) }))
    .filter((m): m is { a: Annotation; i: number } => m.i !== null)
    .sort((p, q) => (p.a.date < q.a.date ? -1 : p.a.date > q.a.date ? 1 : p.a.id < q.a.id ? -1 : p.a.id > q.a.id ? 1 : 0));
  return on.map(({ a, i }, k) => {
    let x2: number | null = null;
    if (a.end_date) {
      const j = scale.weekOf(a.end_date) ?? weeks.length - 1;
      x2 = r2(scale.x(j) + scale.step / 2);
    }
    return {
      key: letter(k), date: a.date, endDate: a.end_date, label: a.label, detail: a.detail,
      x: r2(a.end_date ? scale.x(i) - scale.step / 2 : scale.x(i)), x2,
    };
  });
}

/** Each marker as a muted dashed (2 2) line, or a shaded span to its end_date; the letter atop the plot when `letters`. */
export function Markers({ markers, top, bottom, letters = true }: { markers: readonly PlacedMarker[]; top: number; bottom: number; letters?: boolean }) {
  if (!markers.length) return null;
  return (
    <g>
      {markers.map((m) => (
        <g key={m.key}>
          {m.x2 !== null
            ? <rect x={m.x} y={top} width={r2(Math.max(m.x2 - m.x, 1))} height={r2(bottom - top)} fill="var(--muted)" fillOpacity={0.16} />
            : <line x1={m.x} x2={m.x} y1={top} y2={bottom} stroke="var(--muted)" strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />}
          {letters
            ? <text x={r2(m.x + 2)} y={top + 9} fontSize={AXIS_FONT} fontFamily={MONO} fill="var(--muted)" {...HALO}>{m.key}</text>
            : null}
        </g>
      ))}
    </g>
  );
}

/** The mono key under a chart: "a · 15 Apr 2026 · NVD stops scoring most CVEs", with `detail` as the title. */
export function MarkerKey({ markers }: { markers: readonly PlacedMarker[] }) {
  if (!markers.length) return null;
  return (
    <ul className="mt-1 font-mono text-[11px] leading-[1.6] text-muted">
      {markers.map((m) => (
        <li key={m.key} title={m.detail}>
          {[m.key, m.endDate ? `${shortDate(m.date)} to ${shortDate(m.endDate)}` : shortDate(m.date), m.label].join(" · ")}
        </li>
      ))}
    </ul>
  );
}

// ── Hover and labels ─────────────────────────────────────────────────────────────────────────────

/** A transparent <rect> per week over the plot, its <title> giving that week's values (§7 "Hover"). Drawn last, on top. */
export function HoverColumns({ titles, x, step, top, bottom }: { titles: readonly string[]; x: (i: number) => number; step: number; top: number; bottom: number }) {
  return (
    <g fill="transparent">
      {titles.map((t, i) => (
        <rect key={i} x={r2(x(i) - step / 2)} y={top} width={r2(step)} height={r2(bottom - top)}>
          <title>{t}</title>
        </rect>
      ))}
    </g>
  );
}

/**
 * A direct label (§7): 12 units, 600, ink, mono, with a dot (r 2.5) at the line's end. `anchor` "start" puts the
 * text in the right margin after the dot; "end" puts it inside the plot, ending just left of the dot, `dy` above
 * or below it. Without `dot` the text alone (a null latest value's "n too small").
 */
export function DirectLabel({ x, y, text, anchor = "start", dy = 0, dot = true }: {
  x: number; y: number; text: string; anchor?: "start" | "end"; dy?: number; dot?: boolean;
}) {
  const tx = anchor === "start" ? x + 6 : x - 5;
  return (
    <g>
      {dot ? <circle cx={r2(x)} cy={r2(y)} r={2.5} fill="var(--ink)" /> : null}
      <text x={r2(tx)} y={r2(y + 4 + dy)} textAnchor={anchor} fontSize={LABEL_FONT} fontWeight={600} fontFamily={MONO}
        fill="var(--ink)" {...HALO}>{text}</text>
    </g>
  );
}

/**
 * Where a null latest value's "n too small" goes: right-aligned to the svg's edge, at the top of the plot, or at
 * its bottom when the line to `avoid` (the reference) is in the plot's upper half.
 */
export function NTooSmall({ text, plotTop, plotH, avoid = null }: { text: string; plotTop: number; plotH: number; avoid?: number | null }) {
  const y = avoid !== null && avoid < plotTop + plotH / 2 ? plotTop + plotH - 8 : plotTop + 6;
  return <DirectLabel x={W - 2 + 5} y={y} text={text} anchor="end" dot={false} />;
}

/**
 * The dy that keeps a second label (anchored end, inside the plot) off the main line: below its own line when
 * the main line ends above it, else above; moved to the other side when it would leave the plot.
 */
export function sideOf(own: number, main: number | null, plotTop: number, plotH: number): number {
  const above = -10;
  const below = 10;
  let dy = main !== null && main < own ? below : above;
  if (own + 4 + dy < plotTop + 10) dy = below;
  if (own + 4 + dy > plotTop + plotH - 1) dy = above;
  return dy;
}

