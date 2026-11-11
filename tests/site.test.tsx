// The site tests (SPEC §7 "Site tests (P4)"), as Europe's tests/site.test.tsx: Vitest in the node environment,
// pages and components rendered with renderToStaticMarkup from react-dom/server, the markup read with cheerio or
// plain string matching. The sample is fixtures/site-content/ (SAMPLE editions), the empty folder
// fixtures/empty-content/; both are written by fixtures/src/build.ts and never edited here (in-memory copies only).
// One describe block per §7 bullet: Sample, Empty, Plain text, Headers, Withholding, Levels, Accessibility,
// Charts, Methodology and Word count, then the routes, the item page and the page frame. Skipping lives in
// tests/content.test.ts and Stale in tests/stale.test.ts. Accessibility renders every sample page inside the real
// app/layout.tsx (next/font/google is mocked: its functions only exist under Next's compiler), so the skip link,
// the banners and the landmarks are the ones the build ships. The routes read CT_CONTENT_DIR through
// loadContent() (cached per folder), so each block that renders a route sets it in beforeAll.
// The 9px-at-375px check of the charts' 11-unit axis text is a screenshot item (§10 P4), not checked here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load, type CheerioAPI } from "cheerio";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import nextConfig, { contentSecurityPolicy, securityHeaders } from "@/next.config";
import RootLayout from "@/app/layout";
import HomePage, { generateMetadata as homeMetadata } from "@/app/page";
import ArchivePage from "@/app/archive/page";
import AboutPage from "@/app/about/page";
import MethodologyPage from "@/app/methodology/page";
import NotFound from "@/app/not-found";
import BriefPage, * as briefRoute from "@/app/brief/[date]/page";
import ItemRoute, * as itemRoute from "@/app/items/[id]/page";
import * as feedRoute from "@/app/feed.xml/route";
import { BriefView, type BriefViewProps } from "@/components/brief/BriefView";
import { EpssMovers } from "@/components/brief/EpssMovers";
import { FixSideStrip } from "@/components/brief/FixSideStrip";
import { GapPanel, type GapPanelProps } from "@/components/brief/GapPanel";
import { changeWords } from "@/components/brief/RegionRow";
import { briefPropsFor } from "@/components/brief/props";
import { AiCreditedChart } from "@/components/charts/AiCreditedChart";
import { FloodChart } from "@/components/charts/FloodChart";
import { WindowChart } from "@/components/charts/WindowChart";
import { CHANGE_CALL_LINE, KEV_US_DATES, N_TOO_SMALL, aiLabel, floodLabel, windowLabel } from "@/components/charts/labels";
import { fmtShareTick, fmtTick, niceMax, shareShown, weekScale, yScale } from "@/components/charts/scale";
import { Footer } from "@/components/layout/Footer";
import { Masthead } from "@/components/layout/Masthead";
import { SampleBanner } from "@/components/layout/SampleBanner";
import { StaleBanner } from "@/components/layout/StaleBanner";
import { TabBar } from "@/components/layout/TabBar";
import { ItemPage, itemPageTitle } from "@/components/pages/ItemPage";
import { FEED_SIZE, escapeXml, feedXml } from "@/components/pages/feed";
import { STYLE_SECTIONS } from "@/components/pages/methodology-data";
import { ABOUT_WHAT, DATA_CREDITS, howItIsMade, noEditionYet, sourcesDocUrl } from "@/components/pages/site-text";
import { AIChip } from "@/components/ui/AIChip";
import { SeverityPips } from "@/components/ui/SeverityPips";
import { loadConfig } from "@/lib/config";
import { loadContent, type Content } from "@/lib/content";
import { longDate, rfc822, shortDate } from "@/lib/format";
import { KEV_CATALOG_URL } from "@/lib/record-links";
import { isWithheld } from "@/lib/items";
import { section } from "@/lib/markdown";
import { round4, wilson80 } from "@/lib/metrics/stats";
import {
  EMPTY_LINES, briefDescription, cardKicker, cardKickerParts, chartCaptions, chartName, fixSideLines, gapFooter, gapNotices, gapSecondLine,
  regionSummary, scriptParts,
} from "@/lib/page-text";
import { Brief } from "@/lib/schema/brief";
import type { Annotation } from "@/lib/schema/config";
import { Metrics } from "@/lib/schema/metrics";
import type { Correction } from "@/lib/schema/misc";
import { SIBLINGS, issueFormUrl, siteUrl } from "@/lib/site";
import { correctionsFor, itemPageIds } from "@/lib/site-data";
import { countWords } from "@/lib/text";
import {
  ABOUT_LINE, AI_CREDIT_CAPTION, ANTHROPIC_LINE, BRIEF_END, EDITION_INFO, FIX_SIDE_CAPTION, KIND_INFO, NONE_FOUND, REGION_CHANGE,
  REGION_LEVEL_INFO, REGION_LEVELS, SCOREBOARD_NO_ENTRY, SEVERITIES, SEVERITY_INFO, WINDOW_LABEL, WITHHELD_HEADLINE, WITHHELD_TEXT,
} from "@/lib/vocab";
import { rewriteItem } from "@/lib/withhold-mask";
import { editionDraft } from "@/fixtures/src/drafts";
import { fixtureConfig } from "@/fixtures/src/inputs";
import { EMPTY_CONTENT_DIR, SITE_CONTENT_DIR } from "@/fixtures/src/site";
import { REPO_ROOT } from "@/fixtures/src/world";

// next/font/google's functions exist only under Next's compiler; the layout gets plain class names here.
vi.mock("next/font/google", () => {
  const font = (name: string) => () => ({ className: `font-${name}`, variable: `font-${name}-var`, style: { fontFamily: name } });
  return { Newsreader: font("newsreader"), IBM_Plex_Sans: font("plex-sans"), IBM_Plex_Mono: font("plex-mono") };
});

// ── Shared helpers ────────────────────────────────────────────────────────────────────────────────

const SITE = path.join(REPO_ROOT, SITE_CONTENT_DIR);
const content = loadContent(SITE, { fresh: true, log: () => {} });
const briefs = content.briefs;
const MONDAY = "2026-10-12";
const PARTIAL = "2026-10-13";
const WED = "2026-10-14";
const DATA_ONLY = "2026-10-06";
const WITHHELD_ID = "inc-health-us-2026-10";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const clone = <T,>(v: T): T => structuredClone(v);
const params = <T,>(v: T) => ({ params: Promise.resolve(v) });

const savedDir = process.env.CT_CONTENT_DIR;
afterAll(() => {
  if (savedDir === undefined) delete process.env.CT_CONTENT_DIR;
  else process.env.CT_CONTENT_DIR = savedDir;
});

// BriefView, read with cheerio.
function propsFor(date: string): BriefViewProps {
  const props = briefPropsFor(content, date);
  if (!props) throw new Error(`no sample brief for ${date}`);
  return props;
}

const page = (props: BriefViewProps): CheerioAPI => load(html(<BriefView {...props} />));

/** The texts of every [data-words] element, optionally outside #gap. */
function countedTexts($: CheerioAPI, outsideGap = false): string[] {
  return $("[data-words]").toArray().filter((el) => !outsideGap || $(el).closest("#gap").length === 0).map((el) => $(el).text());
}

const sum = (texts: readonly string[]) => texts.reduce((n, t) => n + countWords(t), 0);
const sorted = (xs: readonly string[]) => [...xs].sort();

/** §4.12's model fields in the total, one string per rendered element (each Lead sentence on its own). */
function modelStrings(b: Brief): string[] {
  const out: (string | null | undefined)[] = [...b.lead.map((s) => s.text)];
  if (b.angle) out.push(b.angle.text, b.angle.counterpoint);
  for (const it of b.items) {
    if (isWithheld(it)) continue;
    out.push(it.headline, it.summary, it.why_it_matters, it.incident?.impact, it.exposure?.text);
  }
  for (const r of b.regions.rows) out.push(r.raised?.reason);
  if (b.edition !== "data_only") out.push(b.taiwan_lens.analysis);
  for (const r of b.taiwan_lens.rows) out.push(r.text);
  out.push(b.taiwan_lens.japan.text);
  return out.filter((t): t is string => typeof t === "string" && t.length > 0);
}

/** The Gap panel's counted strings, as scriptParts() orders them (the gap lane marks these). */
function gapParts(b: Brief, metrics: Metrics | null, gapOk: boolean): string[] {
  if (!gapOk || metrics === null || b.gap.status === "missing") return [EMPTY_LINES.gap_missing];
  const c = chartCaptions(metrics);
  return [gapSecondLine(b), ...gapNotices(b, metrics), c.flood, c.window, ...c.ai, ...(c.aiInKev ?? []),
    ...fixSideLines(metrics.fix_side, b.date), ...gapFooter(metrics)].filter((p): p is string => typeof p === "string" && p.length > 0);
}

/** scriptParts() without the Gap's parts: what BriefView itself marks. */
function scriptOutsideGap(b: Brief, metrics: Metrics | null, gapOk: boolean): string[] {
  const rest = [...scriptParts(b, metrics, { gapOk })];
  for (const g of gapParts(b, metrics, gapOk)) {
    const i = rest.indexOf(g);
    if (i < 0) throw new Error(`gap part not in scriptParts: ${g}`);
    rest.splice(i, 1);
  }
  return rest;
}

// The Gap panel and its charts: the sample's metrics, and a copy with drawn series.

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

const count = (s: string, needle: string | RegExp) => (typeof needle === "string" ? s.split(needle).length - 1 : (s.match(needle) ?? []).length);
const decode = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
  .replace(/&amp;/g, "&");
/** The text of every element marked data-words, in page order (no marked element nests another, §7). */
const countedMarkup = (s: string) => [...s.matchAll(/<(p|li|span)\b[^>]*\bdata-words=""[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => decode(m[2]!));
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

// The routes and the page frame, read from their markup.

/** The visible text of rendered markup: inline tags dropped, block tags made spaces, entities decoded, spaces folded. */
function text(markup: string): string {
  return markup
    .replace(/<\/?(?:a|span|code|time|b|strong|em|i|abbr)(?:\s[^>]*)?>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The hrefs of every <a>, in order, entities decoded. */
const hrefs = (markup: string) => [...markup.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

/** The <li> elements of the first <ol>, as text. */
function listItems(markup: string): string[] {
  const ol = /<ol[^>]*>([\s\S]*?)<\/ol>/.exec(markup)?.[1] ?? "";
  return [...ol.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]!));
}

/** A deep copy of the sample content, for in-memory cases (the cached Content is never changed). */
function sampleCopy(): Content {
  const c = loadContent(SITE_CONTENT_DIR);
  return { ...c, briefs: structuredClone(c.briefs), corrections: structuredClone(c.corrections) };
}

const briefOf = (c: Pick<Content, "briefs">, date: string) => c.briefs.find((b) => b.date === date)!;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ct-site-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
let folders = 0;

/**
 * A copy of the sample folder outside fixtures/, changed by `change` (edit() rewrites one JSON file in place),
 * loaded once with the sample config and the log silenced, so the routes' loadContent() finds it cached; then
 * CT_CONTENT_DIR names it. The routes' own tests set CT_CONTENT_DIR again in their beforeAll.
 */
function sampleFolder(change: (edit: <T>(file: string, fn: (v: T) => void) => void, dir: string) => void): string {
  const dir = path.join(TMP, `c${(folders += 1)}`);
  fs.cpSync(SITE, dir, { recursive: true });
  change((file, fn) => {
    const p = path.join(dir, file);
    const v = JSON.parse(fs.readFileSync(p, "utf8"));
    fn(v);
    fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
  }, dir);
  loadContent(dir, { config: fixtureConfig(), log: () => {} });
  process.env.CT_CONTENT_DIR = dir;
  return dir;
}

// ── Sample ────────────────────────────────────────────────────────────────────────────────────────

describe("Sample", () => {
  describe("every brief renders through BriefView", () => {
    it.each(briefs.map((b) => [b.date, b.edition] as const))("%s (%s)", (date) => {
      const props = propsFor(date);
      const out = html(<BriefView {...props} />);
      const $ = load(out);
      const b = props.brief;
      if (b.items.length) expect(out).toContain(`id="${b.items[0]!.id}"`);
      if (b.sources.length) expect(out).toContain('id="src-s1"');
      expect($("article").first().text()).toContain(BRIEF_END);
      expect($('nav[aria-label="Other editions"]').length).toBe(1);
      expect($("h1").length).toBe(1);
    });

    it("the sample covers items, sources, every edition and a Monday", () => {
      expect(briefs.filter((b) => b.items.length && b.sources.length).length).toBeGreaterThanOrEqual(3);
      expect(new Set(briefs.map((b) => b.edition))).toEqual(new Set(["full", "partial", "data_only"]));
    });

    it("keeps the section order and ids, with the fixed §NN numbers and titles", () => {
      const ORDER = ["top", "lead", "regions", "gap", "top-stories", "also-today", "actors", "taiwan", "scoreboard", "elsewhere", "corrections", "sources"];
      const TITLES: [string, number, string][] = [["lead", 1, "The Lead"], ["regions", 2, "Regions"], ["top-stories", 4, "Top stories"],
        ["also-today", 5, "Also today"], ["actors", 6, "Actors seen today"], ["taiwan", 7, "Taiwan Lens"], ["scoreboard", 8, "Thesis Scoreboard"],
        ["elsewhere", 9, "Elsewhere"]];
      for (const b of briefs) {
        const $ = page(propsFor(b.date));
        const ids = $("[id]").toArray().map((el) => $(el).attr("id")!).filter((id) => ORDER.includes(id));
        const expected = ORDER.filter((id) => id !== "corrections" || b.corrections.length > 0);
        expect(ids, b.date).toEqual(expected);
        for (const [id, n, title] of TITLES) {
          const h2 = $(`section#${id} > h2`);
          expect(h2.text(), `${b.date} ${id}`).toContain(`§0${n}`);
          expect(h2.text()).toContain(title);
        }
        expect($("section#scoreboard > h2").text().includes("Week in review")).toBe(b.week_in_review !== null);
        expect($("#sources").is("details") || $("#sources").text().includes("No sources.")).toBe(true);
      }
    });

    it("puts items[0..2] in cards and the rest in closed rows under their heads, with no nested <details>", () => {
      const props = propsFor(WED);
      const $ = page(props);
      const ids = props.brief.items.map((i) => i.id);
      expect($("#top-stories article[id]").toArray().map((el) => $(el).attr("id"))).toEqual(ids.slice(0, 3));
      const rows = $("#also-today details[id]").toArray();
      expect(rows.map((el) => $(el).attr("id")).sort()).toEqual(ids.slice(3).sort());
      for (const el of rows) {
        expect($(el).attr("open")).toBeUndefined();
        expect($(el).find("details").length).toBe(0);
        expect($(el).find("dl").length).toBe(1);
        expect($(el).children("summary").find("h3").length).toBe(1);
      }
      for (const el of $("#top-stories article[id]").toArray()) expect($(el).find("details > div > dl").length).toBe(1);
      expect($("#also-today h3.kicker").length).toBeGreaterThan(0);
    });

    it("shows the empty lines, the data-only lines and the foot blocks", () => {
      const quiet = page(propsFor("2026-10-11"));
      expect(quiet("#top-stories").text()).toContain(EMPTY_LINES.no_items);
      expect(quiet("#also-today").text()).toContain(EMPTY_LINES.no_rows);
      expect(quiet("#elsewhere").text()).toContain(EMPTY_LINES.no_elsewhere);
      expect(quiet("#sources").text()).toContain("No sources.");
      expect(quiet("#corrections").length).toBe(0);
      const d = page(propsFor(DATA_ONLY));
      expect(d("#actors").text()).toContain(EMPTY_LINES.not_data_only);
      expect(d("#elsewhere").text()).toContain(EMPTY_LINES.not_data_only);
      expect(d("#taiwan").text()).toContain(EMPTY_LINES.not_data_only);
      const p = page(propsFor(PARTIAL));
      expect(p("#corrections li").length).toBe(2);
      expect(p('#corrections a[href="/brief/2026-10-12#inc-health-us-2026-10"]').length).toBe(1);
      expect(p("#sources > summary").text()).toMatch(/^Sources \(1\) · 1 publisher$/);
    });

    it("has Monday's week in review with \"Strongest evidence against\"", () => {
      const $ = page(propsFor(MONDAY));
      const text = $("#scoreboard").text();
      expect(text).toContain("Strongest evidence against");
      expect($("#scoreboard table th").toArray().map((el) => $(el).text())).toEqual(["Claim", "Status", "Zone", "Reading"]);
      expect($("#scoreboard table tbody tr").first().text()).toContain("OPEN");
      expect($("#scoreboard table tbody tr").first().text()).toContain("NO READING");
      expect(text).toContain(SCOREBOARD_NO_ENTRY.replace("{date}", "6 Oct 2026").split("{claim}")[0]);
      expect($('#scoreboard a[href="#src-s7"]').length).toBe(1);
    });

    it("shows EDITION_INFO.data_only and \"AI: unassessed\" in the data-only edition", () => {
      const $ = page(propsFor(DATA_ONLY));
      expect($("#lead").text()).toContain(EDITION_INFO.data_only);
      expect($("#top-stories").text()).toContain("AI: unassessed");
      expect($("#top").text()).toContain("Data-only edition");
    });

    it("names the partial edition's stale feeds in the masthead notice", () => {
      const props = propsFor(PARTIAL);
      expect(props.brief.feeds_stale.length).toBeGreaterThan(0);
      const $ = page(props);
      const note = $('#top [role="note"]').text();
      for (const f of props.brief.feeds_stale) expect(note).toContain(f.name);
      expect($("#top").text()).toContain("Partial edition");
    });

    it("shows each Scoreboard entry, and \"No Scoreboard entries yet.\" with none ever made", () => {
      expect(page(propsFor(WED))("#scoreboard").text()).toContain("SE-0002 · SB-02 · NEUTRAL");
      const props = clone(propsFor(MONDAY));
      props.brief.scoreboard = { entries: [], last: null };
      props.brief.week_in_review = null;
      expect(page(props)("#scoreboard > div").text()).toBe("No Scoreboard entries yet.");
    });

    it("links the kicker, region and fired-rule parts to this page and the methodology", () => {
      const $ = page(propsFor(WED));
      expect($('#regions a[href="/methodology#rule-campaign-target"]').length).toBe(1);
      expect($('#regions a[href="#also-today"]').text()).toMatch(/^GLOBAL · \d+ items?$/);
      // The US row's rules fired on an item from another edition: shown as its id, not linked.
      expect($("#regions").text()).toContain(WITHHELD_ID);
      expect($(`#regions a[href="#${WITHHELD_ID}"]`).length).toBe(0);
      expect($("#regions").text()).toContain("Editor raised: ");
      expect($("#regions").text()).toContain("Rules alone: HIGH");
      for (const a of $('a:contains("↓")').toArray()) expect($(a).attr("aria-label")).toMatch(/^Read: /);
    });

    it("renders EPSS movers in a data-only edition only", () => {
      const props = clone(propsFor(DATA_ONLY));
      props.brief.epss_movers = [{ cve_id: "CVE-2026-88779", score: 0.41234, delta_7d: 0.12, percentile: 0.98 }];
      const $ = page(props);
      const row = $("#also-today table tbody tr").first();
      expect(row.find("td").toArray().map((el) => $(el).text())).toEqual(["CVE-2026-88779", "0.41", "+0.12", "98%"]);
      const full = clone(propsFor(WED));
      full.brief.epss_movers = props.brief.epss_movers;
      expect(page(full)("#also-today table").length).toBe(0);
      expect(load(html(<EpssMovers movers={[{ cve_id: "CVE-2026-1", score: 0.1, delta_7d: -0.05, percentile: 0.5 }]} />))("td").eq(2).text()).toBe("-0.05");
    });
  });
});

// ── Empty ─────────────────────────────────────────────────────────────────────────────────────────

describe("Empty", () => {
  describe("empty content", () => {
    beforeAll(() => {
      process.env.CT_CONTENT_DIR = EMPTY_CONTENT_DIR;
    });

    it("/ shows the no-edition line and no edition metadata", async () => {
      const out = text(html(await HomePage()));
      expect(out).toContain("Today");
      expect(out).toContain(noEditionYet());
      expect(await homeMetadata()).toEqual({});
    });

    it("/archive shows No editions yet.", () => {
      const out = html(ArchivePage());
      expect(text(out)).toContain("No editions yet.");
      expect(out).not.toContain("<ol");
      expect(text(out)).not.toContain("newest first");
    });

    it("/feed.xml is a valid channel with no items", async () => {
      const res = feedRoute.GET();
      expect(res.headers.get("Content-Type")).toBe("application/rss+xml; charset=utf-8");
      const xml = await res.text();
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">')).toBe(true);
      expect(xml).toContain(`<link>${siteUrl()}</link>`);
      expect(xml).toContain("<language>en</language>");
      expect(xml).not.toContain("<item>");
      expect(xml.trimEnd().endsWith("</channel>\n</rss>")).toBe(true);
    });

    it("the dynamic routes have no static params and Methodology its empty texts", () => {
      expect(briefRoute.generateStaticParams()).toEqual([]);
      expect(itemRoute.generateStaticParams()).toEqual([]);
      const out = text(html(MethodologyPage()));
      expect(out).toContain("No corrections so far. Corrections are listed here openly, never made silently.");
      expect(out).toContain("No metrics file yet.");
      expect(out).toContain("No status files yet.");
    });
  });
});

// ── Plain text ────────────────────────────────────────────────────────────────────────────────────

describe("Plain text", () => {
  describe("on a brief", () => {
    function hostile(): BriefViewProps {
      const props = clone(propsFor(WED));
      const it0 = props.brief.items[0]!;
      it0.headline = "<img src=x>";
      it0.summary = "A lure pointed to login-update[.]example[.]com before it was taken down.";
      props.brief.sources[0]!.url = "javascript:void(0)";
      return props;
    }

    it("escapes a headline \"<img src=x>\"", () => {
      const out = html(<BriefView {...hostile()} />);
      expect(out).toContain("&lt;img src=x&gt;");
      expect(out).not.toMatch(/<img/i);
    });

    it("gives a source URL \"javascript:void(0)\" no href", () => {
      const out = html(<BriefView {...hostile()} />);
      const $ = load(out);
      expect($("#src-s1").length).toBe(1);
      expect($("#src-s1 a").length).toBe(0);
      expect(out).not.toContain("javascript:");
    });

    it("renders \"login-update[.]example[.]com\" in a summary in <code>, unlinked", () => {
      const $ = page(hostile());
      const code = $("code").filter((_, el) => $(el).text() === "login-update[.]example[.]com");
      expect(code.length).toBeGreaterThan(0);
      for (const el of code.toArray()) expect($(el).closest("a").length).toBe(0);
    });

    it("puts content ids only in item and source anchors", () => {
      const FIXED = new Set(["top", "lead", "regions", "gap", "top-stories", "also-today", "actors", "taiwan", "scoreboard", "elsewhere", "corrections", "sources"]);
      for (const b of briefs) {
        const $ = page(propsFor(b.date));
        const ids = $("[id]").toArray().filter((el) => $(el).closest("#gap").length === 0 || $(el).attr("id") === "gap").map((el) => $(el).attr("id")!);
        const allowed = new Set([...FIXED, ...b.items.map((i) => i.id), ...b.sources.map((s) => `src-${s.id}`)]);
        for (const id of ids) expect(allowed.has(id), `${b.date} ${id}`).toBe(true);
      }
    });

    it("uses no text-accent or border-accent anywhere in components/", () => {
      const files = fs.readdirSync(path.join(REPO_ROOT, "components"), { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile() && /\.(tsx?|css)$/.test(d.name)).map((d) => path.join(d.parentPath, d.name));
      expect(files.length).toBeGreaterThan(10);
      for (const f of files) expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/\b(?:text|border|bg)-accent\b/);
    });
  });

  describe("plain text greps", () => {
    const CODE_DIRS = ["app", "components", "lib"];
    const files = CODE_DIRS.flatMap((d) =>
      (fs.readdirSync(path.join(REPO_ROOT, d), { recursive: true }) as string[])
        .filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f))
        .map((f) => path.join(d, f).split(path.sep).join("/")),
    ).sort();
    const body = (f: string) => fs.readFileSync(path.join(REPO_ROOT, f), "utf8");

    it("scans the site code", () => {
      expect(files).toContain("app/methodology/page.tsx");
      expect(files).toContain("components/layout/TabBar.tsx");
      expect(files).toContain("lib/markdown.ts");
    });

    it("finds no dangerouslySetInnerHTML or innerHTML in app/, components/ or lib/", () => {
      const hits = files.filter((f) => /dangerouslySetInnerHTML|innerHTML/.test(body(f)));
      expect(hits).toEqual([]);
    });

    it("lib/markdown and components/Markdown are imported only by app/methodology/page.tsx", () => {
      const importers = (re: RegExp) => files.filter((f) => re.test(body(f)));
      // A value import of lib/markdown: only the page. components/Markdown.tsx may import its types only.
      expect(importers(/^import\s+(?!type\b)[^;]*from\s+"(?:@\/lib\/markdown|(?:\.\.\/)+lib\/markdown|\.\/markdown)"/m)).toEqual(["app/methodology/page.tsx"]);
      expect(importers(/from\s+"(?:@\/lib\/markdown|(?:\.\.\/)+lib\/markdown|\.\/markdown)"/).filter((f) => f !== "app/methodology/page.tsx")).toEqual(["components/Markdown.tsx"]);
      expect(importers(/from\s+"(?:@\/components\/Markdown|(?:\.\.\/)+Markdown|\.\/Markdown)"/)).toEqual(["app/methodology/page.tsx"]);
    });
  });
});

// ── Headers ───────────────────────────────────────────────────────────────────────────────────────

describe("Headers", () => {
  describe("security headers", () => {
    const FIVE = ["Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Permissions-Policy"];

    it("headers() gives the five headers for /:path*", async () => {
      const rules = await nextConfig.headers!();
      expect(rules).toHaveLength(1);
      expect(rules[0]!.source).toBe("/:path*");
      expect(rules[0]!.headers.map((h) => h.key)).toEqual(FIVE);
    });

    it("the production CSP has no 'unsafe-eval', and has object-src 'none' and frame-ancestors 'none'", () => {
      const csp = contentSecurityPolicy("production");
      expect(csp).not.toContain("'unsafe-eval'");
      expect(csp.split("; ")).toEqual(expect.arrayContaining(["object-src 'none'", "frame-ancestors 'none'"]));
      expect(securityHeaders("production").find((h) => h.key === "Content-Security-Policy")!.value).toBe(csp);
      expect(contentSecurityPolicy("development")).toContain("'unsafe-eval'");
    });
  });
});

// ── Withholding ───────────────────────────────────────────────────────────────────────────────────

describe("Withholding", () => {
  describe("on its brief", () => {
    const original = editionDraft("monday").items.find((i) => i.id === WITHHELD_ID)!.headline;

    it("shows WITHHELD_HEADLINE on its brief and no edition's original headline", () => {
      expect(original).not.toBe(WITHHELD_HEADLINE);
      const $ = page(propsFor(MONDAY));
      expect($(`#${WITHHELD_ID} h3`).text()).toBe(WITHHELD_HEADLINE);
      for (const b of briefs) expect(html(<BriefView {...propsFor(b.date)} />), b.date).not.toContain(original);
    });

    it("marks no word in the withheld card and keeps its NAME REMOVED banner", () => {
      const $ = page(propsFor(MONDAY));
      const card = $(`#${WITHHELD_ID}`);
      expect(card.find("[data-words]").length).toBe(0);
      expect(card.find('[role="note"]').text()).toContain("NAME REMOVED 13 Oct 2026 · while a dispute about a named party is reviewed.");
    });
  });

  describe("its corrections, sources and details", () => {
    const NAME = "Mercy General Health System";
    /** A correction to the withheld item written before (or after) the withhold, naming the disputed party. */
    const named = (over: Partial<Correction> = {}): Correction => ({
      id: "C-0003", date: "2026-10-12", item_id: WITHHELD_ID, edition_date: MONDAY, type: "correction", field: "incident.victim",
      before: "a US hospital operator", after: NAME, reason: `SAMPLE. ${NAME}'s own 8-K gives its full name.`,
      source_url: "https://www.sec.gov/ct-sample/mercy-general-8-k", trigger: "editor", dispute_id: null, ...over,
    });
    /** A sample copy with `extra` added to corrections.json and listed by the 13 Oct brief. */
    const withCorrections = (...extra: Correction[]): Content => {
      const c = sampleCopy();
      c.corrections.corrections.push(...extra);
      briefOf(c, PARTIAL).corrections.push(...structuredClone(extra));
      return c;
    };
    const leaks = (markup: string) => markup.includes("Mercy") || markup.includes("mercy-general");

    it("while a withhold binds the item, its other corrections show only their type word and date: card, foot, item page, Methodology", () => {
      const c = withCorrections(named());
      const monday = html(<BriefView {...briefPropsFor(c, MONDAY)!} />);
      const partial = html(<BriefView {...briefPropsFor(c, PARTIAL)!} />);
      const item = html(<ItemPage content={c} id={WITHHELD_ID} />);
      expect(leaks(monday), "12 Oct").toBe(false);
      expect(leaks(partial), "13 Oct").toBe(false);
      expect(leaks(item), "item page").toBe(false);
      expect(text(load(monday)(`#${WITHHELD_ID} [role="note"]`).html()!)).toContain("CORRECTED 12 Oct 2026 · [withheld]");
      expect(load(partial)("#corrections li").last().text()).toMatch(/C-0003 · .* · CORRECTED · \[withheld\]$/);
      expect(text(item)).toContain("CORRECTED 12 Oct 2026 · [withheld]");
      expect(text(item)).toContain("NAME REMOVED 13 Oct 2026 · while a dispute about a named party is reviewed.");

      sampleFolder((edit) => {
        edit<{ corrections: Correction[] }>("corrections.json", (f) => { f.corrections.push(named()); });
        edit<Brief>(`briefs/${PARTIAL}.json`, (b) => { b.corrections.push(named()); });
      });
      const method = html(MethodologyPage());
      expect(leaks(method), "methodology").toBe(false);
      expect(text(method)).toContain(`C-0003 · 12 Oct 2026 · ${WITHHELD_ID} · CORRECTED · [withheld]`);
    });

    it("a restore after a rejected dispute stays hidden when a new dispute withholds again, and shows once nothing binds", () => {
      const restore = named({ id: "C-0003", date: "2026-10-14", type: "update", reason: `SAMPLE. The dispute was rejected: ${NAME} confirmed the breach in its 8-K.` });
      const again: Correction = { ...structuredClone(content.corrections.corrections[0]!), id: "C-0004", date: "2026-10-15", dispute_id: "D-0002" };
      const c = withCorrections(restore, again);
      c.corrections.disputes[0]!.status = "rejected";
      c.corrections.disputes.push({ ...structuredClone(c.corrections.disputes[0]!), id: "D-0002", issue_number: 4, status: "open", correction_id: "C-0004" });
      const card = () => load(html(<BriefView {...briefPropsFor(c, MONDAY)!} />))(`#${WITHHELD_ID}`).html()!;
      expect(leaks(card())).toBe(false);
      expect(leaks(html(<ItemPage content={c} id={WITHHELD_ID} />))).toBe(false);
      expect(text(card())).toContain("UPDATED 14 Oct 2026 · [withheld]");
      // The second dispute rejected too: nothing binds, so the restore prints in full again (§4.10).
      c.corrections.disputes[1]!.status = "rejected";
      expect(text(card())).toContain(`UPDATED 14 Oct 2026 · incident.victim: now '${NAME}'.`);
      expect(html(<ItemPage content={c} id={WITHHELD_ID} />)).toContain(NAME);
    });

    it("a source only withheld items cite shows its number and [withheld] as plain text: no outlet, no link", () => {
      const c = sampleCopy();
      const s1 = briefOf(c, MONDAY).sources.find((s) => s.id === "s1")!;
      Object.assign(s1, { source_type: "victim", outlet: "Acme Health", url: "https://www.acmehealth.example/notice-of-data-incident" });
      const out = html(<BriefView {...briefPropsFor(c, MONDAY)!} />);
      const $ = load(out);
      expect(out).not.toContain("Acme Health");
      expect(out).not.toContain("acmehealth");
      expect(out).not.toContain("therecord.media/ct-sample/us-hospital-operator-breach");
      for (const id of ["s1", "s2"]) {
        expect($(`#src-${id}`).length, id).toBe(1);
        expect($(`#src-${id} a`).length, id).toBe(0);
        expect($(`#src-${id}`).text(), id).toContain("[withheld]");
      }
      expect($("#src-s1").text()).toMatch(/^\[01\]/);
      // Sources other items cite keep their outlet and link.
      expect($("#src-s3 a").length).toBe(1);
    });

    it("a withheld card and row show no Impact line and no details list", () => {
      const $ = page(propsFor(MONDAY));
      const card = $(`#${WITHHELD_ID}`);
      expect(card.text()).not.toContain("Patient records copied");
      expect(card.text()).not.toContain("Impact:");
      expect(card.find("dl").length).toBe(0);
      // The same item in a row: three top stories before it.
      const props = clone(propsFor(MONDAY));
      const [held, ...rest] = props.brief.items;
      props.brief.items = [...rest, { ...structuredClone(rest[0]!), id: rest[0]!.id.replace(/-2026-10$/, "-b-2026-10") }, held!];
      const row = page(props)(`details#${WITHHELD_ID}`);
      expect(row.length).toBe(1);
      expect(row.text()).not.toContain("Patient records copied");
      expect(row.find("dl").length).toBe(0);
    });
  });

  describe("on the item page", () => {
    it("a withheld item shows only WITHHELD_HEADLINE and WITHHELD_TEXT, never an edition's original headline", () => {
      const content = sampleCopy();
      const held = briefOf(content, "2026-10-12").items.find((i) => i.id === "inc-health-us-2026-10")!;
      expect(held.withheld).not.toBeNull();
      // An earlier, unwithheld copy of the item, as an edition before the dispute would hold it.
      const sun = briefOf(content, "2026-10-11");
      const src = { ...structuredClone(briefOf(content, "2026-10-14").sources[0]!), id: "s90", title: "ORIGINAL SOURCE TITLE" };
      sun.sources.push(src);
      sun.items.push({
        ...structuredClone(held),
        withheld: null,
        headline: "ORIGINAL HEADLINE names the hospital group",
        summary: "ORIGINAL SUMMARY of the breach.",
        source_ids: ["s90"],
      } as typeof held);

      const out = html(<ItemPage content={content} id="inc-health-us-2026-10" />);
      const t = text(out);
      expect([...out.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => text(m[1]!))).toEqual([WITHHELD_HEADLINE]);
      expect(t).toContain(WITHHELD_TEXT.replace("{date}", longDate(held.withheld!.since)));
      expect(t).not.toContain("ORIGINAL");
      for (const b of content.briefs) for (const it of b.items) if (it.id === held.id && it.headline !== WITHHELD_HEADLINE) expect(t).not.toContain(it.headline);
      expect(hrefs(out)).toEqual(expect.arrayContaining(["/brief/2026-10-11#inc-health-us-2026-10", "/brief/2026-10-12#inc-health-us-2026-10"]));
      expect(out).not.toContain('id="timeline"');
      expect(out).not.toContain('id="records"');
      expect(out).not.toContain('id="sources"');
      expect(itemPageTitle(content, "inc-health-us-2026-10")).toBe(WITHHELD_HEADLINE);
    });
  });
});

// ── Levels ────────────────────────────────────────────────────────────────────────────────────────

describe("Levels", () => {
  describe("pips, words and chips", () => {
    it("renders pips (aria-hidden), the word and hidden words for every level", () => {
      for (const s of SEVERITIES) {
        const $ = load(html(<SeverityPips scale="severity" level={s} />));
        const info = SEVERITY_INFO[s];
        expect($('.pips[aria-hidden="true"]').text()).toBe(info.pips);
        expect($.root().text()).toContain(info.word);
        expect($(".sr-only").text()).toBe(` ${info.word.charAt(0)}${info.word.slice(1).toLowerCase()}, ${info.rank} of 4`);
      }
      for (const r of REGION_LEVELS) {
        const $ = load(html(<SeverityPips scale="region" level={r} />));
        const info = REGION_LEVEL_INFO[r];
        expect($('.pips[aria-hidden="true"]').text()).toBe(info.pips);
        expect($.root().text()).toContain(info.word);
        expect($(".sr-only").text()).toBe(` level ${info.rank} of 4`);
      }
      expect(load(html(<SeverityPips scale="severity" level={null} kind="policy" />)).root().text()).toBe(KIND_INFO.policy.label.toUpperCase());
      expect(load(html(<SeverityPips scale="severity" level={null} kind="policy" landmark />)).root().text()).toBe(`LANDMARK · ${KIND_INFO.policy.label.toUpperCase()}`);
    });

    it("shows UNRATED only in a data-only edition", () => {
      let seen = 0;
      for (const b of briefs) {
        const has = html(<BriefView {...propsFor(b.date)} />).includes("UNRATED");
        if (has) seen += 1;
        if (b.edition !== "data_only") expect(has, b.date).toBe(false);
      }
      expect(seen).toBeGreaterThan(0);
    });

    it("gives every kicker cardKicker()'s text and every region row regionSummary()'s head, with hidden words outside", () => {
      for (const b of briefs) {
        const $ = page(propsFor(b.date));
        for (const it of b.items) {
          const kicker = $(`[id="${it.id}"]`).find("span.block.font-mono").first();
          const p = cardKickerParts(it);
          expect([p.level, ...p.ai, ...p.regions, p.vendor].filter(Boolean).join(" · ")).toBe(cardKicker(it));
          if (isWithheld(it)) continue;
          expect(kicker.children("[data-words]").text(), it.id).toBe(cardKicker(it));
        }
        const heads = $("#regions summary > span:first-child > [data-words]").toArray().map((el) => $(el).text());
        expect(heads).toEqual(b.regions.rows.map((r) => regionSummary(r).head));
        for (const el of $("#regions summary").toArray()) expect($(el).find(".sr-only").text()).toMatch(/^ level [1-4] of 4/);
      }
    });

    it("colours only AI chips violet: confirmed filled, claimed an outline with its claimant, unassessed grey", () => {
      const confirmed = html(<AIChip role="ai_found" confidence="confirmed" claimant={null} />);
      expect(confirmed).toContain("bg-[var(--ai)]");
      const claimed = load(html(<AIChip role="ai_found" confidence="claimed" claimant="Example Lab" />));
      expect(claimed.html()).not.toContain("bg-[var(--ai)]");
      expect(claimed.html()).toContain("border-[var(--ai)]");
      expect(claimed.root().text()).toContain("AI role claimed by Example Lab");
      const unassessed = html(<AIChip role="unassessed" confidence={null} claimant={null} />);
      expect(unassessed).not.toContain("var(--ai)");
      expect(load(unassessed).root().text()).toBe("AI: unassessed");
      expect(html(<AIChip role="none" confidence={null} claimant={null} />)).toBe("");
      for (const b of briefs) {
        const $ = page(propsFor(b.date));
        for (const el of $('[class*="var(--ai)"]').toArray()) expect($(el).text(), b.date).toMatch(/^AI/);
      }
    });
  });
});

// ── Accessibility ─────────────────────────────────────────────────────────────────────────────────

describe("Accessibility", () => {
  // Every sample page the build makes: /, every /brief/<date>, /archive, every /items/<id>, /methodology,
  // /about and the 404 page. Listed from the sample itself (the routes' static params equal these; "Routes"
  // checks that), so the list is known when the tests are collected.
  const ROUTES = [
    "/",
    ...briefs.map((b) => `/brief/${b.date}`),
    "/archive",
    ...[...itemPageIds(content)].sort().map((id) => `/items/${id}`),
    "/methodology",
    "/about",
    "/no-such-page",
  ];
  const isBrief = (route: string) => route === "/" || route.startsWith("/brief/");
  const briefAt = (route: string) => (route === "/" ? briefs.at(-1)! : briefs.find((b) => `/brief/${b.date}` === route)!);

  beforeAll(() => {
    process.env.CT_CONTENT_DIR = SITE_CONTENT_DIR;
  });

  /** The page a route renders, as the build renders it (async pages awaited). */
  async function routeElement(route: string): Promise<ReactElement> {
    if (route === "/") return HomePage();
    if (route === "/archive") return ArchivePage();
    if (route === "/methodology") return MethodologyPage();
    if (route === "/about") return AboutPage();
    const date = /^\/brief\/(.+)$/.exec(route)?.[1];
    if (date) return BriefPage(params({ date }));
    const id = /^\/items\/(.+)$/.exec(route)?.[1];
    if (id) return ItemRoute(params({ id }));
    return NotFound();
  }

  /** A page inside the real RootLayout, with usePathname() reading `route` as it does at build time. */
  function inLayout(route: string, children: ReactNode): CheerioAPI {
    return load(html(<PathnameContext.Provider value={route}><RootLayout>{children}</RootLayout></PathnameContext.Provider>));
  }

  const rendered = new Map<string, Promise<CheerioAPI>>();
  const pageAt = (route: string) => {
    if (!rendered.has(route)) rendered.set(route, routeElement(route).then((el) => inLayout(route, el)));
    return rendered.get(route)!;
  };

  /** Elements a keyboard reaches, in document order. */
  const FOCUSABLE = "a[href], area[href], button:not([disabled]), input:not([type=hidden]), select, textarea, iframe, summary, [tabindex]:not([tabindex='-1']), [contenteditable]";
  const LEVEL_WORDS = /\b[1-4] of 4\b/;

  it("covers every sample page: the briefs, the item pages and the fixed routes", () => {
    expect(ROUTES.filter((r) => r.startsWith("/brief/"))).toHaveLength(briefs.length);
    expect(ROUTES.filter((r) => r.startsWith("/items/")).length).toBeGreaterThan(0);
    expect(ROUTES.length).toBe(briefs.length + itemPageIds(content).size + 5);
  });

  it.each(ROUTES)("%s: <html lang=\"en\">, exactly one h1, and headings in order with no gaps", async (route) => {
    const $ = await pageAt(route);
    expect($("html").attr("lang")).toBe("en");
    expect($("h1").length).toBe(1);
    const levels = $("h1, h2, h3, h4, h5, h6").toArray().map((el) => Number(el.tagName.slice(1)));
    expect(levels[0]).toBe(1);
    levels.forEach((level, i) => {
      if (i > 0) expect(level, `heading ${i + 1} (h${level}) after h${levels[i - 1]}`).toBeLessThanOrEqual(levels[i - 1]! + 1);
    });
  });

  it.each(ROUTES)("%s: the landmarks: <header> with both tab navs, <main id=\"main\">, <footer>, and \"Other editions\" on a brief", async (route) => {
    const $ = await pageAt(route);
    expect($("header").length).toBe(1);
    expect($("main").length).toBe(1);
    expect($("main").attr("id")).toBe("main");
    expect($("footer").length).toBe(1);
    expect($('header nav[aria-label="Trackers"]').length).toBe(1);
    expect($('header nav[aria-label="Main"]').length).toBe(1);
    expect($("main header, main footer, header main, footer main, header footer, footer header").length).toBe(0);
    const navs = $("nav").toArray().map((el) => $(el).attr("aria-label"));
    expect(navs).toEqual(isBrief(route) ? ["Trackers", "Main", "Other editions"] : ["Trackers", "Main"]);
    if (isBrief(route)) expect($('main nav[aria-label="Other editions"]').length).toBe(1);
    // The tab bars mark where the reader is: Cyber in the family bar, the route's tab (none on an item or the 404).
    expect($('nav[aria-label="Trackers"] a[aria-current="true"]').text()).toBe("Cyber");
    const tab = isBrief(route) ? "Today" : ({ "/archive": "Archive", "/methodology": "Method", "/about": "About" } as Record<string, string>)[route];
    expect($('nav[aria-label="Main"] a[aria-current="page"]').toArray().map((el) => $(el).text())).toEqual(tab ? [tab] : []);
  });

  it.each(ROUTES)("%s: the skip link \"Skip to the brief\" is the first focusable element and #main exists", async (route) => {
    const $ = await pageAt(route);
    const first = $(FOCUSABLE).first();
    expect(first.is("a")).toBe(true);
    expect(first.attr("href")).toBe("#main");
    expect(first.text()).toBe("Skip to the brief");
    expect($("body").children().first().is(first)).toBe(true);
    expect($("#main").length).toBe(1);
    // The sample is a fixtures/ folder: its banner follows the skip link, never before it.
    expect($('[role="note"]').first().text()).toContain("Preview data, not the published brief");
  });

  it.each(ROUTES)("%s: every ↓ and ↗ link has an aria-label", async (route) => {
    const $ = await pageAt(route);
    for (const el of $("a").toArray()) {
      if (/[↓↗]/.test($(el).text())) expect($(el).attr("aria-label")?.trim(), $(el).text()).toBeTruthy();
    }
  });

  it.each(ROUTES)("%s: pips are aria-hidden and hidden level words follow each", async (route) => {
    const $ = await pageAt(route);
    // In document order, each .pips is aria-hidden and the next .sr-only after it, before the next .pips, holds
    // the level words ("High, 3 of 4", "level 2 of 4").
    let pending: string | null = null;
    for (const el of $("*").toArray()) {
      const node = $(el);
      if (node.hasClass("pips")) {
        expect(node.attr("aria-hidden"), node.text()).toBe("true");
        expect(pending, "a .pips with no hidden words before the next").toBeNull();
        pending = node.text();
      } else if (pending !== null && node.hasClass("sr-only")) {
        expect(node.text(), `hidden words after ${pending}`).toMatch(LEVEL_WORDS);
        pending = null;
      }
    }
    expect(pending, "the last .pips has no hidden words").toBeNull();
  });

  it.each(ROUTES.filter(isBrief))("%s: each region row's change glyph is aria-hidden, with its hidden words", async (route) => {
    const $ = await pageAt(route);
    const b = briefAt(route);
    const rows = $("#regions details > summary").toArray();
    expect(rows).toHaveLength(b.regions.rows.length);
    b.regions.rows.forEach((row, i) => {
      const summary = $(rows[i]!);
      const glyph = REGION_CHANGE[row.change];
      const glyphs = summary.find("*").toArray().filter((el) => $(el).children().length === 0 && /^[↑↓=]$/.test($(el).text()));
      expect(glyphs.map((el) => $(el).text()), row.code).toEqual(glyph ? [glyph] : []);
      for (const el of glyphs) expect($(el).attr("aria-hidden")).toBe("true");
      const words = summary.find(".sr-only").text();
      const change = changeWords(row);
      if (change) expect(words, row.code).toContain(change);
      expect(words).toMatch(LEVEL_WORDS);
    });
  });

  it.each(ROUTES.filter(isBrief))("%s: the h1 is the edition date; sections are h2, item headlines and Also-today heads h3", async (route) => {
    const $ = await pageAt(route);
    const b = briefAt(route);
    expect($("h1").text()).toBe(longDate(b.date));
    for (const id of ["lead", "regions", "gap", "top-stories", "also-today", "actors", "taiwan", "scoreboard", "elsewhere"]) {
      expect($(`section#${id} > h2`).length, id).toBe(1);
    }
    for (const item of b.items) expect($(`[id="${item.id}"] h3`).length, item.id).toBe(1);
    expect($("#also-today h3").length).toBe(b.items.slice(3).length + new Set(b.items.slice(3).map((i) => KIND_INFO[i.kind].head)).size);
  });

  it.each(ROUTES)("%s: links stay in the tab: no target attribute; content and repo links carry rel=\"noopener noreferrer\"", async (route) => {
    const $ = await pageAt(route);
    expect($("a[target]").length).toBe(0);
    const siblings = new Set(Object.values(SIBLINGS));
    for (const el of $('a[href^="http"]').toArray()) {
      const href = $(el).attr("href")!;
      // The siblings' sites are run.json links, plain <a> as in the siblings' TabBar.
      if (siblings.has(href)) continue;
      expect($(el).attr("rel"), href).toBe("noopener noreferrer");
    }
  });

  it("a cross-linked actor's \"↗\" link carries an aria-label naming the tracker and the actor", () => {
    const props = clone(briefPropsFor(content, WED)!);
    expect(props.brief.actors_seen.length).toBeGreaterThan(0);
    const actor = props.brief.actors_seen[0]!;
    actor.cross_link = { tracker: "europe", url: SIBLINGS.europe };
    const $ = inLayout(`/brief/${WED}`, <BriefView {...props} />);
    const links = $("a").toArray().filter((el) => $(el).text().includes("↗"));
    expect(links).toHaveLength(1);
    expect($(links[0]!).attr("aria-label")).toBe(`Europe tracker: ${actor.name}`);
    expect($(links[0]!).attr("href")).toBe(SIBLINGS.europe);
  });

  it("the Lead's ↓ links read \"Read: <headline>\" (or \"Read: The Gap\")", async () => {
    let seen = 0;
    for (const route of ROUTES.filter(isBrief)) {
      const $ = await pageAt(route);
      for (const el of $("#lead a").toArray().filter((a) => $(a).text().includes("↓"))) {
        expect($(el).attr("aria-label")).toMatch(/^Read: \S/);
        seen += 1;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

// ── Charts ────────────────────────────────────────────────────────────────────────────────────────

describe("Charts", () => {
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

  describe("the three charts", () => {
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
        expect(countedMarkup(h)).toEqual([EMPTY_LINES.gap_missing]);
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
      expect(countedMarkup(h)).toEqual(expected);
      const parts = scriptParts(brief, metrics);
      const at = parts.indexOf(expected[0]!);
      expect(parts.slice(at, at + expected.length)).toEqual(expected);
      expect(countedMarkup(h)).toContain(WINDOW_LABEL + c.window.slice(WINDOW_LABEL.length));
      expect(countedMarkup(h)).toContain(AI_CREDIT_CAPTION);
      expect(countedMarkup(h)).toContain(FIX_SIDE_CAPTION);
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
      const words = countedMarkup(h);
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
        expect(countedMarkup(h)).toContain(line);
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
      expect(countedMarkup(none)).toEqual([FIX_SIDE_CAPTION]);
      expect(none).not.toContain("<a ");
      const small = html(<FixSideStrip editionDate={WED} fixSide={{
        anthropic_cvd: null, ghsa_unfixed: { share: null, n_unfixed: 3, n_total: 12, from: "2026-06-16", to: "2026-09-14", as_of: "2026-10-13" },
      }} />);
      expect(countedMarkup(small)).toEqual([FIX_SIDE_CAPTION]);
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
      expect(countedMarkup(h)[0]).toBe("Anthropic disclosure dashboard (one lab, open source only, self-reported), revision 41, 1 Oct: 5 disclosed. Not updated since 1 Oct.");
    });
  });
});

// ── Methodology ───────────────────────────────────────────────────────────────────────────────────

describe("Methodology", () => {
  describe("methodology", () => {
    beforeAll(() => {
      process.env.CT_CONTENT_DIR = SITE_CONTENT_DIR;
    });
    const style = fs.readFileSync(path.join(REPO_ROOT, "routine", "STYLE.md"), "utf8");

    it("each STYLE_SECTIONS number resolves to its title with a body over 100 characters", () => {
      const out = html(MethodologyPage());
      const h2s = [...out.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => text(m[1]!));
      for (const [key, n] of Object.entries(STYLE_SECTIONS)) {
        const s = section(style, n);
        expect(s, `STYLE.md section ${n} (${key})`).not.toBeNull();
        expect(s!.body.trim().length, `section ${n} body`).toBeGreaterThan(100);
        expect(h2s.some((h) => h.includes(s!.title)), `h2 "${s!.title}"`).toBe(true);
      }
      expect(Object.keys(STYLE_SECTIONS).sort()).toEqual(["corrections", "gap", "naming", "sources"]);
    });

    it("has every anchor of the table, and a row id rule-<id> for every regions.json rule", () => {
      const out = html(MethodologyPage());
      for (const id of ["severity", "ai-roles", "regions", "gap", "ai-finders", "sources", "naming", "feeds", "corrections"]) {
        expect(out, id).toContain(`<section id="${id}"`);
      }
      const rules = loadConfig().regions.rules;
      expect(rules.length).toBeGreaterThan(0);
      for (const r of rules) expect(out).toContain(`<tr id="rule-${r.id}">`);
    });

    it("the feeds table has a row per sources.yaml feed, from the last status files", () => {
      const out = html(MethodologyPage());
      const feeds = /<section id="feeds"[\s\S]*?<\/section>/.exec(out)![0];
      const rows = [...feeds.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].flatMap((m) => [...m[1]!.matchAll(/<tr[^>]*>/g)]);
      expect(rows).toHaveLength(loadConfig().sources.feeds.length);
      const days = Math.min(14, loadContent().status.length);
      expect(text(feeds)).toContain(`of ${days} days ok`);
    });

    it("lists every correction newest first, linking the edition's item", () => {
      const out = html(MethodologyPage());
      const block = /<section id="corrections"[\s\S]*?<\/section>/.exec(out)![0];
      const lines = listItems(block.slice(block.indexOf("Every correction")));
      expect(lines.map((l) => l.split(" · ")[1])).toEqual(["C-0002", "C-0001"]);
      expect(lines[1]).toContain("12 Oct 2026 · inc-health-us-2026-10 · NAME REMOVED");
      expect(hrefs(block)).toEqual(expect.arrayContaining(["/brief/2026-10-12#inc-health-us-2026-10"]));
    });

    it("defines the AI roles by their chip words, with no doubled colon after \"AI: unassessed\"", () => {
      const t = text(html(MethodologyPage()));
      expect(t).toContain("AI: unassessed · ");
      expect(t).not.toContain("AI: unassessed:");
    });
  });
});

// ── Word count ────────────────────────────────────────────────────────────────────────────────────

describe("Word count", () => {
  describe("data-words on every sample edition", () => {
    const fulls = briefs.filter((b) => b.edition !== "data_only");

    it("covers full and partial editions with items, a raise and a Lens", () => {
      expect(fulls.length).toBeGreaterThanOrEqual(3);
      expect(fulls.some((b) => b.regions.rows.some((r) => r.raised))).toBe(true);
    });

    it.each(briefs.map((b) => [b.date, b.edition] as const))("%s (%s): the marked strings outside #gap are exactly the model fields and script lines", (date) => {
      const props = propsFor(date);
      const $ = page(props);
      const expected = [...modelStrings(props.brief), ...scriptOutsideGap(props.brief, props.metrics, props.gapOk)];
      expect(sorted(countedTexts($, true))).toEqual(sorted(expected));
      expect($("[data-words] [data-words]").length).toBe(0);
    });

    // §7 asks this of the full editions; the data-only ones add up too, so every edition is checked.
    it.each(briefs.map((b) => [b.date, b.edition] as const))("%s (%s): the words outside #gap are computed.word_count less the Gap's", (date) => {
      const props = propsFor(date);
      const outside = sum(countedTexts(page(props), true));
      expect(outside).toBe(props.brief.computed.word_count - sum(gapParts(props.brief, props.metrics, props.gapOk)));
    });

    it.each(briefs.map((b) => [b.date, b.edition] as const))("%s (%s): the whole page's data-words sum to computed.word_count", (date) => {
      const props = propsFor(date);
      expect(sum(countedTexts(page(props)))).toBe(props.brief.computed.word_count);
    });

    it("counts NONE_FOUND as the stored counter-point, never a label", () => {
      const $ = page(propsFor(MONDAY));
      expect(countedTexts($, true)).toContain(NONE_FOUND);
      expect($("#lead [data-words]").toArray().map((el) => $(el).text())).not.toContain("Counter-point: ");
    });
  });
});

// ── Routes, the item page and the page frame ──────────────────────────────────────────────────────

describe("Routes", () => {
  describe("sample routes", () => {
    beforeAll(() => {
      process.env.CT_CONTENT_DIR = SITE_CONTENT_DIR;
    });

    it("/ and /brief/[date] carry the edition metadata; an unknown date is not found", async () => {
      const content = loadContent();
      const newest = content.briefs.at(-1)!;
      const home = await homeMetadata();
      expect(home.other).toEqual({ "ct-edition": `${newest.date} ${newest.edition} ${newest.published_at}` });
      expect(home.description).toBe(briefDescription(newest));

      expect(briefRoute.dynamicParams).toBe(false);
      expect(briefRoute.generateStaticParams()).toEqual(content.briefs.map((b) => ({ date: b.date })));
      const wed = briefOf(content, "2026-10-14");
      const meta = await briefRoute.generateMetadata(params({ date: wed.date }));
      expect(meta.title).toBe("Wednesday 14 October 2026");
      expect(meta.other).toEqual({ "ct-edition": `2026-10-14 full ${wed.published_at}` });
      expect(meta.description).toBe(briefDescription(wed));
      expect(meta.openGraph).toMatchObject({ title: "CyberTracker, Wednesday 14 October 2026", description: briefDescription(wed), type: "article" });
      expect(html(await BriefPage(params({ date: wed.date })))).toContain("Wednesday 14 October 2026");
      await expect(BriefPage(params({ date: "2026-10-05" }))).rejects.toThrow();
    });

    it("/archive lists every loaded edition newest first with its kicker and top story", () => {
      const out = html(ArchivePage());
      expect(text(out)).toContain("10 editions, newest first.");
      const rows = listItems(out);
      expect(rows).toHaveLength(10);
      const links = hrefs(out);
      expect(links).toEqual(loadContent().briefs.map((b) => `/brief/${b.date}`).reverse());
      const kickers = [...out.matchAll(/<p class="kicker[^"]*">([^<]*)<\/p>/g)].map((m) => m[1]);
      expect(kickers).toEqual([
        "DATA-ONLY · 4 ITEMS",
        "8 ITEMS · AI-LINKED 3 OF 8",
        "PARTIAL · 1 ITEM · AI-LINKED 0 OF 1",
        "3 ITEMS · AI-LINKED 0 OF 3 · CORRECTED",
        "0 ITEMS · AI-LINKED 0 OF 0",
        "DATA-ONLY · 0 ITEMS",
        "DATA-ONLY · 5 ITEMS",
        "DATA-ONLY · 0 ITEMS",
        "DATA-ONLY · 0 ITEMS",
        "DATA-ONLY · 1 ITEM",
      ]);
      expect(rows[1]).toContain("Attackers exploit an Ivanti Connect Secure flaw that lets them run commands");
      expect(rows[3]).toContain(WITHHELD_HEADLINE);
      expect(rows[4]).toContain("No item cleared the bar.");
      expect(rows[5]).toContain("Data-only edition");
    });

    it("/feed.xml: titles, links, guids, pubDates and descriptions, newest first", async () => {
      const res = feedRoute.GET();
      expect(feedRoute.dynamic).toBe("force-static");
      expect(res.headers.get("Content-Type")).toBe("application/rss+xml; charset=utf-8");
      const xml = await res.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]!);
      const briefs = [...loadContent().briefs].reverse();
      expect(items).toHaveLength(briefs.length);
      const tag = (s: string, t: string) => new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(s)?.[1];
      const titles = items.map((s) => tag(s, "title"));
      expect(titles[0]).toBe(`Thursday 15 October 2026: ${escapeXml(briefs[0]!.items[0]!.headline)} (data-only edition)`);
      expect(titles[1]).toBe("Wednesday 14 October 2026: Attackers exploit an Ivanti Connect Secure flaw that lets them run commands");
      expect(titles[3]).toBe(`Monday 12 October 2026: ${WITHHELD_HEADLINE}`);
      expect(titles[4]).toBe("Sunday 11 October 2026: No item cleared the bar");
      expect(titles[5]).toBe("Saturday 10 October 2026: No item cleared the bar (data-only edition)");
      items.forEach((s, i) => {
        const b = briefs[i]!;
        const url = `${siteUrl()}/brief/${b.date}`;
        expect(tag(s, "link")).toBe(url);
        expect(s).toContain(`<guid isPermaLink="true">${url}</guid>`);
        expect(tag(s, "pubDate")).toBe(rfc822(b.published_at));
        expect(tag(s, "description")).toBe(escapeXml(briefDescription(b)));
      });
    });

    it("feedXml() escapes every value and keeps the 30 newest briefs", () => {
      const base = briefOf(loadContent(), "2026-10-14");
      const odd = { ...structuredClone(base), items: [{ ...structuredClone(base.items[0]!), headline: 'AT&T <b>"x"</b>\u0007 says' }] } as Brief;
      const xml = feedXml([odd], "https://example.org");
      expect(xml).toContain("<title>Wednesday 14 October 2026: AT&amp;T &lt;b&gt;&quot;x&quot;&lt;/b&gt; says</title>");
      expect(xml).not.toContain("\u0007");
      const day = (i: number) => new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
      const many = Array.from({ length: FEED_SIZE + 2 }, (_, i) => ({ ...structuredClone(base), date: day(i), published_at: `${day(i)}T05:10:00+08:00` }) as Brief);
      const guids = [...feedXml(many, "https://example.org").matchAll(/<guid isPermaLink="true">([^<]*)<\/guid>/g)].map((m) => m[1]);
      expect(guids).toHaveLength(FEED_SIZE);
      expect(guids[0]).toBe("https://example.org/brief/2026-09-01");
      expect(guids.at(-1)).toBe("https://example.org/brief/2026-08-03");
    });

    it("/items/[id] renders the sample's item page and refuses other ids", async () => {
      expect(itemRoute.dynamicParams).toBe(false);
      expect(itemRoute.generateStaticParams()).toEqual([{ id: "cve-2026-108917" }]);
      const out = html(await ItemRoute(params({ id: "cve-2026-108917" })));
      expect(text(out)).toContain("ITEM · Critical flaw");
      expect(text(out)).toContain("First seen 13 Oct 2026 · in 2 editions");
      expect(listItems(out)).toEqual([
        "12 Oct 2026 · CVE-2026-108917 published",
        expect.stringMatching(/^13 Oct 2026 · partial edition: .*Unpatched Edimax router flaw rated 10 will get no fix$/),
        expect.stringMatching(/^14 Oct 2026 · full edition: .*Unpatched Edimax router flaw rated 10 will get no fix$/),
      ]);
      expect(hrefs(out)).toEqual(expect.arrayContaining([
        "/brief/2026-10-13#cve-2026-108917",
        "/brief/2026-10-14#cve-2026-108917",
        "https://www.cve.org/CVERecord?id=CVE-2026-108917",
        "https://nvd.nist.gov/vuln/detail/CVE-2026-108917",
      ]));
      // Not on KEV: no catalog link.
      expect(out).not.toContain(KEV_CATALOG_URL);
      const meta = await itemRoute.generateMetadata(params({ id: "cve-2026-108917" }));
      expect(meta.title).toBe("Unpatched Edimax router flaw rated 10 will get no fix");
      await expect(ItemRoute(params({ id: "cve-2026-104935" }))).rejects.toThrow();
    });

    it("/about: ABOUT_LINE verbatim with its link, the lines, the credits and the siblings", () => {
      const out = html(AboutPage());
      const t = text(out);
      expect(t).toContain(ABOUT_LINE);
      expect(out).toContain(`<a href="${issueFormUrl().replace(/&/g, "&amp;")}" rel="noopener noreferrer">here</a>`);
      expect(t).toContain(ANTHROPIC_LINE);
      expect(t).toContain(ABOUT_WHAT);
      expect(ABOUT_WHAT.split(/\s+/).length).toBeLessThanOrEqual(80);
      expect(howItIsMade().map((s) => s.step)).toEqual(["Collect", "Draft", "Validate", "Publish"]);
      expect(t).toContain(DATA_CREDITS.join(" · "));
      expect(DATA_CREDITS.join(" · ")).toBe("CISA Known Exploited Vulnerabilities catalog · CVE List (CVE.org) · FIRST EPSS · GitHub Advisory Database");
      expect(hrefs(out)).toEqual(expect.arrayContaining([sourcesDocUrl(), SIBLINGS.me, SIBLINGS.europe]));
      expect(t).toContain("the audit trail");
      expect(t).toContain("never reads free text");
    });

    it("the 404 page links the archive", () => {
      const out = html(NotFound());
      expect(text(out)).toContain("Not found");
      expect(hrefs(out)).toEqual(["/archive"]);
    });
  });

  describe("item page", () => {

    it("orders same-date events: edition, CVE steps, exploitation, correction", () => {
      const content = sampleCopy();
      const wed = briefOf(content, "2026-10-14");
      const item = wed.items.find((i) => i.id === "cve-2026-104935")!;
      const cve = item.cves[0]!;
      const D = "2026-10-14";
      cve.date_published = D;
      cve.advisory_date = D;
      if (cve.patch) cve.patch.date = D;
      cve.kev!.date_added = D;
      cve.kev!.due_date = D;
      cve.exploitation_evidence = cve.exploitation_evidence.map((e) => ({ ...e, date: D }));
      const correction = { ...structuredClone(content.corrections.corrections[1]!), id: "C-0099", date: D, edition_date: D, item_id: item.id } as Correction;
      content.corrections.corrections.push(correction);

      const lines = listItems(html(<ItemPage content={content} id={item.id} />));
      const id = cve.cve_id;
      const expected = [
        /full edition: /,
        new RegExp(`${id} published$`),
        new RegExp(`${id}: vendor advisory$`),
        ...(cve.patch ? [new RegExp(`${id}: fix available$`)] : []),
        new RegExp(`${id} added to CISA's list \\(US date\\)$`),
        new RegExp(`${id}: US deadline \\(US date\\)$`),
        ...cve.exploitation_evidence.map(() => new RegExp(`${id} exploited \\(`)),
        /C-0099 · CLARIFIED · /,
      ];
      expect(lines).toHaveLength(expected.length);
      lines.forEach((l, i) => {
        expect(l.startsWith("14 Oct 2026 · ")).toBe(true);
        expect(l).toMatch(expected[i]!);
      });
    });

    it("links cve.org, CISA's KEV catalog search, NVD and the GitHub advisory", () => {
      const content = sampleCopy();
      const item = briefOf(content, "2026-10-14").items.find((i) => i.id === "cve-2026-104935")!;
      const cve = item.cves[0]!;
      expect(cve.kev).not.toBeNull();
      cve.ghsa_ids = ["GHSA-2c3v-4f5g-6h7j"];
      const out = html(<ItemPage content={content} id={item.id} />);
      const records = /<section id="records"[\s\S]*?<\/section>/.exec(out)![0];
      expect(hrefs(records)).toEqual([
        `https://www.cve.org/CVERecord?id=${cve.cve_id}`,
        `${KEV_CATALOG_URL}?search_api_fulltext=${cve.cve_id}`,
        `https://nvd.nist.gov/vuln/detail/${cve.cve_id}`,
        "https://github.com/advisories/GHSA-2c3v-4f5g-6h7j",
      ]);
      expect(text(records)).toContain("CVE record · CISA KEV catalog · NVD");
      expect(text(records)).toContain("GHSA-2c3v-4f5g-6h7j: GitHub advisory");
      expect(records).toContain('rel="noopener noreferrer"');
    });
  });

  describe("page frame", () => {
    const ROUTES: [string, string | null][] = [
      ["/", "Today"],
      ["/brief/2026-10-14", "Today"],
      ["/archive", "Archive"],
      ["/methodology", "Method"],
      ["/methodology/", "Method"],
      ["/about", "About"],
      ["/items/cve-2026-108917", null],
    ];
    const current = (markup: string) => [...markup.matchAll(/<a [^>]*aria-current="page"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);

    it.each(ROUTES)("TabBar main marks the active tab on %s", (route, tab) => {
      const want = tab ? [tab] : [];
      expect(current(html(<TabBar variant="main" pathname={route} />))).toEqual(want);
      // The same through usePathname(), as the page renders it.
      expect(current(html(<PathnameContext.Provider value={route}><TabBar variant="main" /></PathnameContext.Provider>))).toEqual(want);
    });

    it("TabBar family links the siblings and marks Cyber aria-current=true", () => {
      const out = html(<TabBar variant="family" siblings={SIBLINGS} />);
      expect(out).toContain('<nav aria-label="Trackers"');
      expect(hrefs(out)).toEqual([SIBLINGS.me, SIBLINGS.europe, "/"]);
      expect([...out.matchAll(/<a [^>]*aria-current="true"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1])).toEqual(["Cyber"]);
      expect(out).not.toContain('aria-current="page"');
    });

    it("Masthead holds both tab bars; Footer the audit trail, RSS and the error form", () => {
      const head = html(<Masthead />);
      expect(head.startsWith("<header")).toBe(true);
      expect(head).toContain('<nav aria-label="Trackers"');
      expect(head).toContain('<nav aria-label="Main"');
      expect(text(head)).toContain("Cyber Tracker");
      const foot = html(<Footer />);
      expect(foot.startsWith("<footer")).toBe(true);
      expect(hrefs(foot)).toEqual(expect.arrayContaining(["/feed.xml", "/methodology", "/methodology#corrections", "/about", issueFormUrl()]));
      expect(foot).not.toContain("<nav");
    });

    it("StaleBanner renders nothing on the server, even when stale; SampleBanner names the folder", () => {
      expect(html(<StaleBanner lastDate="2026-10-01" lastPublishedAt="2026-10-01T05:10:00+08:00" staleAfter="08:00" />)).toBe("");
      const sample = html(<SampleBanner dir="fixtures/site-content" />);
      expect(sample).toContain('role="note"');
      expect(text(sample)).toContain("fixtures/site-content");
    });
  });
});
