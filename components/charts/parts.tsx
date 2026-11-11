// STUB (SPEC §7 "GapPanel and charts", Chart conventions). Owner: gap lane. Server SVG parts, no library and no
// client JS: ChartFigure, DataTable, YGrid, YearTicks, LinePath, BandPath, RefLine, Bars, HatchDefs, Markers,
// MarkerKey, HoverColumns, DirectLabel. Only components/charts/ and the gap lane's GapPanel use these, so
// their props are the gap lane's to change.
import type { ReactNode } from "react";

export interface ChartFigureProps {
  /** The chart's id, a fixed string ("flood", "window", "ai"): pattern ids are prefixed with it. */
  id: string;
  /** The title above the plot ("NEW CVE RECORDS, 13-WEEK TOTAL"). */
  title: string;
  /** chartLabel(): the svg's aria-label. */
  label: string;
  /** viewBox height. */
  height: number;
  children: ReactNode;
  /** Under the svg: the marker key, caption lines and the data table. */
  after?: ReactNode;
}

export function ChartFigure({ title, label, height, children, after }: ChartFigureProps) {
  return (
    <figure className="max-w-[560px]">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 400 ${height}`} className="block w-full" role="img" aria-label={label}>{children}</svg>
      {after}
    </figure>
  );
}

export interface DataTableProps {
  /** "Data table: <chart name>". */
  summary: string;
  head: string[];
  /** Newest week first. */
  rows: string[][];
}

export function DataTable({ summary, head, rows }: DataTableProps) {
  return (
    <details>
      <summary>{summary}</summary>
      <table><thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>
    </details>
  );
}

export function YGrid(_props: { ticks: number[]; y: (v: number) => number; format?: (v: number) => string }) { return null; }
export function YearTicks(_props: { weeks: readonly string[]; x: (i: number) => number; top: number; bottom: number }) { return null; }
export function LinePath(_props: { points: (number | null)[]; x: (i: number) => number; y: (v: number) => number; dash?: string; className?: string }) { return null; }
export function BandPath(_props: { bands: ([number, number] | null)[]; x: (i: number) => number; y: (v: number) => number }) { return null; }
export function RefLine(_props: { value: number; y: (v: number) => number; left: number; right: number }) { return null; }
export function Bars(_props: { values: number[]; x: (i: number) => number; y: (v: number) => number; width: number; className?: string }) { return null; }
export function HatchDefs(_props: { id: string }) { return null; }
export function Markers(_props: { markers: { key: string; x: number; x2: number | null }[]; top: number; bottom: number }) { return null; }
export function MarkerKey(_props: { markers: { key: string; date: string; label: string; detail: string }[] }) { return null; }
export function HoverColumns(_props: { titles: string[]; x: (i: number) => number; step: number; top: number; bottom: number }) { return null; }
export function DirectLabel(_props: { x: number; y: number; text: string }) { return null; }
