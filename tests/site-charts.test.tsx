// The Gap panel and its charts (SPEC §7 "GapPanel and charts", Site tests "Charts"; §5.2 display helpers;
// Appendix A.2's .night scope). Server-rendered with renderToStaticMarkup, as Europe's tests/site.test.tsx. The
// sample's metrics (fixtures/site-content/metrics/) carry an all-null Window series; `drawn()` fills a copy's
// series with fixed values (a null week included) so lines, bands, bars and labels have something to draw.
// The 9px-at-375px check of the 11-unit axis text is a Kobol screenshot item (§10 P4), not checked here.

import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiCreditedChart } from "@/components/charts/AiCreditedChart";
import { FloodChart } from "@/components/charts/FloodChart";
import { WindowChart } from "@/components/charts/WindowChart";
import { CHANGE_CALL_LINE, KEV_US_DATES, N_TOO_SMALL, aiLabel, floodLabel, windowLabel } from "@/components/charts/labels";
import { fmtShareTick, fmtTick, niceMax, shareShown, weekScale, yScale } from "@/components/charts/scale";
import { FixSideStrip } from "@/components/brief/FixSideStrip";
import { GapPanel, type GapPanelProps } from "@/components/brief/GapPanel";
import { shortDate } from "@/lib/format";
import { round4, wilson80 } from "@/lib/metrics/stats";
import {
  EMPTY_LINES, chartCaptions, chartName, fixSideLines, gapFooter, gapNotices, gapSecondLine, scriptParts,
} from "@/lib/page-text";
import { Brief } from "@/lib/schema/brief";
import type { Annotation } from "@/lib/schema/config";
import { Metrics } from "@/lib/schema/metrics";
import { AI_CREDIT_CAPTION, FIX_SIDE_CAPTION, WINDOW_LABEL } from "@/lib/vocab";
import { SITE_CONTENT_DIR } from "@/fixtures/src/site";
import { REPO_ROOT } from "@/fixtures/src/world";

const SITE = path.join(REPO_ROOT, SITE_CONTENT_DIR);
const WED = "2026-10-14";

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(SITE, file), "utf8"));
const sampleMetrics = (date = WED): Metrics => Metrics.parse(readJson(`metrics/${date}.json`));
const sampleBrief = (date = WED): Brief => Brief.parse(readJson(`briefs/${date}.json`));

/** A copy of the sample metrics with a drawn series: rising totals, a year-ago line from week 52, one null Window week (50). */
function drawn(base: Metrics = sampleMetrics()): Metrics {
  const m = structuredClone(base);
  const s = m.series;
  const ci = wilson80(56, 150).map(round4) as [number, number];
  s.flood_n13 = s.weeks.map((_, i) => 9000 + i * 350);
  s.flood_n13_kernel = s.weeks.map((_, i) => 1000 + i * 30);
  s.flood_n13_year_ago = s.weeks.map((_, i) => (i < 52 ? null : 8000 + i * 10));
  s.window_cohort_n = s.weeks.map((_, i) => (i === 50 ? 20 : 150));
  s.window_at_disclosure_share = s.weeks.map((_, i) => (i === 50 ? null : round4(56 / 150)));
  s.window_at_disclosure_ci80 = s.weeks.map((_, i) => (i === 50 ? null : ci));
  s.window_after_median = s.weeks.map((_, i) => (i === 50 ? null : i % 2 ? 17 : 20.5));
  s.window_after_median_ci80 = s.weeks.map((_, i) => (i === 50 ? null : [13, 31] as [number, number]));
  s.kev_weekly = s.weeks.map((_, i) => i % 7);
  s.kev_recent_weekly = s.weeks.map((_, i) => Math.floor((i % 7) / 2));
  s.ai_weekly = {
    anthropic: s.weeks.map((_, i) => i % 5), openai: s.weeks.map((_, i) => i % 3), google: s.weeks.map(() => 0), other: s.weeks.map(() => 1),
  };
  s.ai_ledger_only_weekly = s.weeks.map((_, i) => (i === 103 ? 2 : 0));
  s.live_from = s.weeks[100]!;
  m.ai_credited!.provisional_from = s.weeks[100]!;
  return Metrics.parse(m);
}

const ann = (over: Partial<Annotation> & Pick<Annotation, "id" | "date">): Annotation => ({
  end_date: null, label: `Label ${over.id}`, detail: `Detail ${over.id}`, panels: ["flood", "window", "ai"], kind: "data_change", source_url: null, ...over,
});

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const count = (s: string, needle: string | RegExp) => (typeof needle === "string" ? s.split(needle).length - 1 : (s.match(needle) ?? []).length);
const decode = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
  .replace(/&amp;/g, "&");
/** The text of every element marked data-words, in page order (no marked element nests another, §7). */
const counted = (s: string) => [...s.matchAll(/<(p|li|span)\b[^>]*\bdata-words=""[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => decode(m[2]!));
/** The markup of one chart's figure inside a rendered panel. */
const figure = (s: string, id: string) => s.match(new RegExp(`<figure id="chart-${id}"[\\s\\S]*?</figure>`))?.[0] ?? "";

const charts = (m: Metrics, markers: Annotation[] = []) => ({
  flood: html(<FloodChart series={m.series} flood={m.flood!} markers={markers} />),
  window: html(<WindowChart series={m.series} window={m.window!} markers={markers} />),
  ai: html(<AiCreditedChart series={m.series} ai={m.ai_credited!} markers={markers} />),
});

function panel(over: Partial<GapPanelProps> = {}): string {
  const brief = sampleBrief();
  return html(<GapPanel gap={brief.gap} metrics={sampleMetrics()} gapOk annotations={[]} editionDate={brief.date} {...over} />);
}

describe("chart scale and display helpers", () => {
  it("niceMax is the next 1, 2 or 5 x 10^n, and 1 for nothing", () => {
    expect([0, -3, 0.4, 1, 7, 10, 11, 45_599, 91, 250].map(niceMax)).toEqual([1, 1, 0.5, 1, 10, 10, 20, 50_000, 100, 500]);
  });

  it("one shared x-axis: week i at l + (i + 0.5) x 304 / weeks, a date in its ISO week, off-axis dates null", () => {
    const weeks = ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"];
    const s = weekScale(weeks);
    expect(s.step).toBe(76);
    expect(s.x(0)).toBe(78);
    expect(s.x(3)).toBe(306);
    expect(s.weekOf("2026-10-05")).toBe(0);
    expect(s.weekOf("2026-10-18")).toBe(1);
    expect(s.weekOf("2026-11-01")).toBe(3);
    expect(s.weekOf("2026-10-04")).toBeNull();
    expect(s.weekOf("2026-11-02")).toBeNull();
    expect(yScale(100, 84)(50)).toBe(50);
  });

  it("counts over 999 read 12k; share ticks are percents", () => {
    expect([0, 0.5, 5, 999, 1000, 2500, 25_000, 12_000].map(fmtTick)).toEqual(["0", "0.5", "5", "999", "1k", "2.5k", "25k", "12k"]);
    expect([0, 0.5, 1].map(fmtShareTick)).toEqual(["0%", "50%", "100%"]);
  });

  it("a weekly share shows pct(k, n) from the recovered count, nothing below MIN_N or when null", () => {
    expect(shareShown(0.3694, 157)).toBe("37%");
    expect(shareShown(0.285, 200)).toBe("29%");
    expect(shareShown(null, 157)).toBeNull();
    expect(shareShown(0.5, 20)).toBeNull();
  });
});

describe("charts (§7 Site tests: Charts)", () => {
  const m = drawn();
  const c = charts(m);

  it("each renders <svg role=\"img\"> with its chartLabel(), a <table> and a <title> per week", () => {
    const weeks = m.series.weeks.length;
    expect(c.flood).toContain(`role="img" aria-label="${floodLabel(m.flood!)}"`);
    expect(c.window).toContain(`role="img" aria-label="${windowLabel(m.window!).replace(/'/g, "&#x27;")}"`);
    expect(c.ai).toContain(`role="img" aria-label="${aiLabel(m.ai_credited!).replace(/'/g, "&#x27;")}"`);
    for (const h of Object.values(c)) {
      expect(h).toMatch(/<svg viewBox="0 0 400 \d+" class="block w-full" role="img"/);
      expect(h).toContain("<table");
    }
    expect(count(c.flood, "<title>")).toBe(weeks);
    expect(count(c.ai, "<title>")).toBe(weeks);
    expect(count(c.window, "<title>")).toBe(3 * weeks); // one per week in each of the three rows
    expect(c.window).toContain('viewBox="0 0 400 60"'); // the bar strip
  });

  it("the chartLabel() sentences follow §7's templates", () => {
    const s = sampleMetrics("2026-10-15");
    expect(floodLabel(s.flood!)).toBe("The Flood: 44,944 new CVE records in the 13 weeks to 13 Oct 2026, 4,804 of them Linux kernel; a year earlier 12,275.");
    expect(windowLabel(s.window!)).toBe("The Window over 26 weeks to 13 Oct 2026: 37% already exploited at disclosure (2023–24: 37%); for the rest, "
      + "a median 17 days to CISA listing (2023–24: 21 days); 157 recent flaws listed.");
    expect(aiLabel(s.ai_credited!)).toBe("AI-credited records, a lower bound: 502 in 13 weeks, 224 without Anthropic; 0 AI-credited flaws on CISA's list since 1 Jan 2025.");
  });

  it("an all-null series shows \"n too small\" and no band", () => {
    const sample = sampleMetrics();
    expect(sample.series.window_at_disclosure_share.every((v) => v === null)).toBe(true);
    const w = charts(sample).window;
    expect(count(w, `>${N_TOO_SMALL}</text>`)).toBe(2); // rows 1 and 2
    expect(w).not.toContain('fill-opacity="0.18"');
    // Drawn, the band is there and the latest values are labelled.
    expect(c.window).toContain('fill-opacity="0.18"');
    expect(c.window).toContain(">37%</text>");
    expect(c.window).toContain(">17 d</text>");
    expect(c.window).toContain(">2023–24 37%</text>");
    expect(c.window).toContain(">2023–24 21 d</text>");
    expect(c.window).not.toContain(`>${N_TOO_SMALL}</text>`);
  });

  it("nulls break lines: one null week splits the share line and its band in two", () => {
    const row1 = c.window.split("<svg")[1]!;
    expect(count(row1, /<path d="M[^"]*" fill="none" stroke="var\(--ink\)"/g)).toBe(2);
    expect(count(row1, /fill-opacity="0.18"/g)).toBe(2);
    // The year-ago line starts at week 52: one segment, and "a year earlier" labels its end.
    expect(count(c.flood, /stroke="var\(--muted\)" stroke-width="1.5" stroke-dasharray="4 3"/g)).toBe(1);
    expect(c.flood).toContain(">a year earlier</text>");
  });

  it("markers: lettered by date on the axis, a dashed 2 2 line or a shaded span, a mono key; off-axis ones are not drawn", () => {
    const markers = [
      ann({ id: "late", date: "2026-06-10" }),
      ann({ id: "early", date: "2026-04-15", label: "NVD stops scoring most CVEs" }),
      ann({ id: "span", date: "2026-07-19", end_date: "2026-07-20" }),
      ann({ id: "before", date: "2023-01-01" }),
      ann({ id: "after", date: "2027-03-01" }),
    ];
    const f = charts(drawn(), markers).flood;
    expect(count(f, 'stroke-dasharray="2 2"')).toBe(2);
    expect(count(f, 'fill-opacity="0.16"')).toBe(1);
    expect(f).toContain("a · 15 Apr 2026 · NVD stops scoring most CVEs");
    expect(f).toContain("b · 10 Jun 2026 · Label late");
    expect(f).toContain("c · 19 Jul 2026 to 20 Jul 2026 · Label span");
    expect(f).toContain('title="Detail early"');
    expect(f).not.toContain("Label before");
    expect(f).not.toContain("Label after");
    expect(count(f, /<li /g)).toBe(3);
    // Only off-axis markers: nothing drawn and no key.
    const off = charts(drawn(), markers.slice(3)).flood;
    expect(off).not.toContain('stroke-dasharray="2 2"');
    expect(off).not.toContain("<ul");
  });

  it("no rx= anywhere, no client script, and var(--ai) only in chart C", () => {
    for (const h of Object.values(c)) {
      expect(h).not.toContain("rx=");
      expect(h).not.toContain("<script");
    }
    expect(c.flood).not.toContain("var(--ai)");
    expect(c.window).not.toContain("var(--ai)");
    expect(c.ai).toContain('fill="var(--ai)"');
    expect(c.ai).toContain('fill-opacity="0.4"'); // Anthropic on top, light
    const dir = path.join(REPO_ROOT, "components/charts");
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      expect(src, f).not.toMatch(/use client|\brx[=:]/);
      if (f !== "AiCreditedChart.tsx") expect(src, f).not.toContain("var(--ai)");
    }
  });

  it("nothing in components/charts/ is marked data-words", () => {
    for (const h of Object.values(c)) expect(h).not.toContain("data-words");
    const dir = path.join(REPO_ROOT, "components/charts");
    for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, f), "utf8"), f).not.toMatch(/data-words|COUNTED|Counted/);
  });

  it("axis text is 11 units mono muted; direct labels 12 units, 600, ink", () => {
    for (const h of Object.values(c)) {
      const sizes = [...h.matchAll(/<text [^>]*font-size="(\d+)"/g)].map((x) => Number(x[1]));
      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.min(...sizes)).toBe(11);
      for (const t of h.matchAll(/<text [^>]*>/g)) {
        if (t[0].includes('font-size="11"')) expect(t[0]).toMatch(/font-family="var\(--font-mono\)" fill="var\(--muted\)"/);
        else expect(t[0]).toMatch(/font-size="12" font-weight="600" font-family="var\(--font-mono\)" fill="var\(--ink\)"/);
      }
    }
    expect(c.flood).toContain(">50k</text>"); // niceMax(45,050) with counts over 999 as k
    expect(c.flood).toContain(">25k</text>");
    expect(c.flood).toContain(">2025</text>");
    expect(c.flood).toContain(">2026</text>");
  });

  it("hover titles give every value; the KEV rows add \"(KEV dates are US dates)\"", () => {
    expect(c.flood).toContain("<title>Week of 5 Oct 2026 · 13-week CVE records: 45,050 · Linux kernel: 4,090 · a year earlier: 9,030</title>");
    expect(c.flood).toContain("<title>Week of 14 Oct 2024 · 13-week CVE records: 9,000 · Linux kernel: 1,000 · a year earlier: not available</title>");
    const titles = [...c.window.matchAll(/<title>(.*?)<\/title>/g)].map((x) => decode(x[1]!));
    expect(titles.every((t) => t.endsWith(KEV_US_DATES))).toBe(true);
    expect(titles).toContain("Week of 5 Oct 2026 · already exploited at disclosure, 26 weeks: 37% of 150 (80% interval 32%–43%) · 2023–24: 37% (KEV dates are US dates)");
    expect(titles).toContain("Week of 5 Oct 2026 · listed by CISA: 5 · of them recent flaws: 2 (KEV dates are US dates)");
    expect(c.ai).toContain("<title>Week of 5 Oct 2026 · AI-credited: 5 · OpenAI: 1 · Google: 0 · other: 1 · Anthropic: 3 (provisional)</title>");
    expect(c.ai).not.toContain(KEV_US_DATES);
    expect(c.flood).not.toContain(KEV_US_DATES);
  });

  it("data tables: \"Data table: <chart name>\", newest week first, bounds and n, Source by series.live_from", () => {
    for (const [id, h] of Object.entries(c)) expect(h).toContain(`<summary class="kicker cursor-pointer py-2">Data table: ${chartName(id as "flood")}</summary>`);
    const firstRow = (h: string) => decode(h.match(/<tbody><tr>([\s\S]*?)<\/tr>/)![1]!.replace(/<\/t[dh]>/g, "|"));
    expect(firstRow(c.flood)).toBe("Week of 5 Oct 2026|45,050|4,090|9,030|live|");
    expect(firstRow(c.window)).toBe("Week of 5 Oct 2026|37%|32%–43%|150|17|13–31|94|5|2|live|");
    expect(firstRow(c.ai)).toBe("Week of 5 Oct 2026|5|3|1|0|1|2|yes|live|");
    expect(c.ai).toContain("Anthropic ledger only, not in the total");
    expect(c.flood).toContain("<th scope=\"row\">Week of 14 Oct 2024</th><td>9,000</td><td>1,000</td><td>not available</td><td>backfill</td>");
    // The null week reads "n too small" in the table too.
    expect(c.window).toContain(`<th scope="row">Week of 29 Sep 2025</th><td>${N_TOO_SMALL}</td><td></td><td>20</td><td>${N_TOO_SMALL}</td>`);
  });

  it("the live_from tick and the provisional hatch: chart-prefixed pattern ids", () => {
    expect(c.flood).toContain('<pattern id="flood-hatch"');
    expect(c.flood).toContain('fill="url(#flood-hatch)"');
    expect(c.ai).toContain('<pattern id="ai-hatch"');
    expect(c.ai).toContain('fill="url(#ai-hatch)"');
    expect(c.window).not.toContain("<pattern");
    // live_from is week 100: a 4-unit tick under the plot at its left edge.
    const x = 40 + 100 * (304 / 104);
    expect(c.flood).toContain(`<line x1="${Math.round(x * 100) / 100}" x2="${Math.round(x * 100) / 100}" y1="92" y2="96"`);
    // Off the axis (the sample's live_from is after its last week): no tick, no hatch.
    const sample = sampleMetrics();
    expect(charts(sample).flood).not.toContain('y1="92" y2="96"');
  });

  it("chart B: the 2023–24 reference lines, bars 0.7 week wide with cohort R in front, this week's label, the Gap data table", () => {
    expect(count(c.window, 'stroke-dasharray="4 3"')).toBe(2);
    const strip = c.window.split("<svg")[3]!;
    const width = Math.round(0.7 * (304 / 104) * 100) / 100;
    expect(strip).toContain(`width="${width}"`);
    expect(strip.indexOf('fill="none" stroke="var(--muted)"')).toBeLessThan(strip.indexOf('fill="var(--ink-soft)"'));
    expect(c.window).toContain("this week: 2 of 5");
    expect(c.window).toContain("Data table: The Window by period");
    expect(c.window).toContain("179 (pace vs 2023–24: 1.9×)");
    expect(c.window).toContain("22 (2023–24 pace: 23)");
    expect(c.window).toContain("58 · 37% (80% interval 32%–42%)");
    expect(c.window).toContain(`26 weeks, ${shortDate(m.window!.w26.from)} to ${shortDate(m.window!.w26.to)}`);
    expect(c.window).toContain("2023–24, 1 Jan 2023 to 31 Dec 2024");
    expect(decode(c.window)).toContain(CHANGE_CALL_LINE);
  });

  it("chart C: the direct label, stacked bars and only the AI series in violet", () => {
    expect(c.ai).toContain(">13 wk: 502 · without Anthropic 224</p>");
    expect(count(c.ai, 'fill="var(--ai)"')).toBeGreaterThan(0);
    expect(c.ai).not.toContain("var(--ink)\""); // no ink line in chart C
  });
});

describe("GapPanel", () => {
  const brief = sampleBrief();

  it("is the night scope: <section id=\"gap\" class=\"night ...\"> with §03 THE GAP and DATA TO <cutoff> UTC", () => {
    const h = panel();
    expect(h.startsWith('<section id="gap" class="night ')).toBe(true);
    expect(h).toContain("-mx-4 px-4");
    expect(h).toContain("sm:px-6");
    expect(h).toContain(">§03</span>");
    expect(h).toContain(">The Gap</span>");
    expect(h).toContain(">DATA TO 12 Oct 2026 UTC</span>");
    expect(count(h, "<h2")).toBe(1);
    expect(count(h, /class="night/g)).toBe(1);
  });

  it("with metrics null, status missing or gapOk false: the header and \"The Gap is not available for this edition.\" only", () => {
    for (const over of [{ metrics: null }, { gap: { ...brief.gap, status: "missing" as const } }, { gapOk: false }]) {
      const h = panel(over);
      expect(h).toContain(">The Gap</span>");
      expect(counted(h)).toEqual([EMPTY_LINES.gap_missing]);
      expect(h).not.toContain("<svg");
      expect(h).not.toContain("DATA TO");
      expect(h).not.toContain(brief.gap.second_line.slice(0, 20));
    }
    // The validator counts the same line (scriptParts with gapOk false).
    expect(scriptParts(brief, sampleMetrics(), { gapOk: false })).toContain(EMPTY_LINES.gap_missing);
  });

  it("marks exactly the Gap part of scriptParts(), in page order, each line once", () => {
    const metrics = sampleMetrics();
    const h = panel();
    const c = chartCaptions(metrics);
    const expected = [
      gapSecondLine(brief)!, ...gapNotices(brief, metrics), c.flood, c.window, ...c.ai, ...(c.aiInKev ?? []),
      ...fixSideLines(metrics.fix_side, brief.date), ...gapFooter(metrics),
    ];
    expect(counted(h)).toEqual(expected);
    const parts = scriptParts(brief, metrics);
    const at = parts.indexOf(expected[0]!);
    expect(parts.slice(at, at + expected.length)).toEqual(expected);
    expect(counted(h)).toContain(WINDOW_LABEL + c.window.slice(WINDOW_LABEL.length));
    expect(counted(h)).toContain(AI_CREDIT_CAPTION);
    expect(counted(h)).toContain(FIX_SIDE_CAPTION);
    // The charts themselves carry no mark.
    for (const id of ["flood", "window", "ai"]) {
      const f = figure(h, id);
      expect(f).not.toBe("");
      expect(f.replace(/<p data-words=""[\s\S]*?<\/p>|<li data-words=""[\s\S]*?<\/li>/g, "")).not.toContain("data-words");
    }
    expect(h).not.toContain(EMPTY_LINES.gap_missing);
  });

  it("stale notices are role=\"note\" and counted; the fix-side strip links the dashboard inside its counted line", () => {
    const metrics = drawn();
    metrics.blocks.flood = { status: "stale", as_of: "2026-10-10", note: "UTC days not yet counted from the CVE List: 11 Oct 2026." };
    metrics.fix_side = {
      anthropic_cvd: {
        status: "ok", revision: "40", as_of: "2026-10-02", fetched_at: "2026-10-14T01:43:47+08:00", found_n: 6009, disclosed_n: 5087, patched_n: 629,
        source_url: "https://red.anthropic.com/2026/cvd/",
      },
      ghsa_unfixed: { share: 0.0274, n_unfixed: 81, n_total: 2952, from: "2026-06-16", to: "2026-09-14", as_of: "2026-10-13" },
    };
    const gap = { ...brief.gap, status: "stale" as const, as_of: "2026-10-11" };
    const h = panel({ metrics, gap });
    const notices = gapNotices({ date: brief.date, gap }, metrics);
    expect(notices).toEqual([
      "Gap figures are from 11 Oct; today's could not be computed.",
      "Flood data from 10 Oct: UTC days not yet counted from the CVE List: 11 Oct 2026.",
    ]);
    for (const n of notices) expect(h).toContain(`<p data-words="" role="note"`);
    expect(count(h, 'role="note"')).toBe(2);
    const lines = fixSideLines(metrics.fix_side, brief.date);
    expect(lines).toHaveLength(3);
    const words = counted(h);
    for (const l of [...notices, ...lines]) expect(words).toContain(l);
    expect(h).toContain('<a href="https://red.anthropic.com/2026/cvd/" rel="noopener noreferrer">Anthropic disclosure dashboard</a>');
    // The reconstructed-weeks footer line: live_from is after the first week.
    expect(words.at(-1)).toBe("Weeks before 14 Sep 2026: reconstructed from current records.");
  });

  it("a null block shows its \"<Chart name> is not available today.\" instead of the chart", () => {
    for (const [key, id, line] of [
      ["flood", "flood", "The Flood is not available today."],
      ["window", "window", "The Window is not available today."],
      ["ai_credited", "ai", "AI-credited is not available today."],
    ] as const) {
      const metrics = sampleMetrics();
      metrics[key] = null;
      const h = panel({ metrics });
      expect(figure(h, id)).toBe("");
      expect(counted(h)).toContain(line);
      expect(count(h, "<figure")).toBe(2);
      if (id === "ai") expect(h).not.toContain("AI-credited and now on CISA");
    }
  });

  it("var(--ai) appears only inside chart C's figure; no rx= in the panel", () => {
    const h = panel({ metrics: drawn() });
    expect(h).not.toContain("rx=");
    expect(h.replace(figure(h, "ai"), "")).not.toContain("var(--ai)");
    expect(figure(h, "ai")).toContain("var(--ai)");
  });

  it("each chart gets the annotations of its own panel", () => {
    const annotations = [
      ann({ id: "flood-only", date: "2026-04-15", panels: ["flood"] }),
      ann({ id: "window-only", date: "2026-06-10", panels: ["window"] }),
      ann({ id: "ai-only", date: "2026-07-01", panels: ["ai"] }),
    ];
    const h = panel({ annotations });
    expect(figure(h, "flood")).toContain("Label flood-only");
    expect(figure(h, "flood")).not.toContain("Label window-only");
    expect(figure(h, "window")).toContain("Label window-only");
    expect(figure(h, "window")).not.toContain("Label ai-only");
    expect(figure(h, "ai")).toContain("Label ai-only");
  });
});

describe("FixSideStrip", () => {
  it("shows FIX_SIDE_CAPTION alone when neither figure is set, and leaves out a GitHub share below MIN_N", () => {
    const none = html(<FixSideStrip fixSide={{ anthropic_cvd: null, ghsa_unfixed: null }} editionDate={WED} />);
    expect(counted(none)).toEqual([FIX_SIDE_CAPTION]);
    expect(none).not.toContain("<a ");
    const small = html(<FixSideStrip editionDate={WED} fixSide={{
      anthropic_cvd: null, ghsa_unfixed: { share: null, n_unfixed: 3, n_total: 12, from: "2026-06-16", to: "2026-09-14", as_of: "2026-10-13" },
    }} />);
    expect(counted(small)).toEqual([FIX_SIDE_CAPTION]);
  });

  it("an unsafe dashboard URL renders as text, never a link", () => {
    const h = html(<FixSideStrip editionDate={WED} fixSide={{
      anthropic_cvd: {
        status: "stale", revision: "41", as_of: "2026-10-01", fetched_at: "2026-10-14T01:43:47+08:00", found_n: null, disclosed_n: 5, patched_n: null,
        source_url: "javascript:void(0)",
      },
      ghsa_unfixed: null,
    }} />);
    expect(h).not.toContain("href=");
    expect(counted(h)[0]).toBe("Anthropic disclosure dashboard (one lab, open source only, self-reported), revision 41, 1 Oct: 5 disclosed. Not updated since 1 Oct.");
  });
});
