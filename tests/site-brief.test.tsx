// The brief page (SPEC §7 "BriefView and section order", "Brief components", "Site tests (P4)": Sample,
// Withholding, Levels, Plain text, Word count). Every fixtures/site-content/ brief renders through BriefView
// with renderToStaticMarkup (environment "node"), parsed with cheerio. The word count is checked two ways: the
// exact whole page (`data-words` summed equals computed.word_count) once the gap lane's GapPanel marks its
// strings, and, always, every `data-words` string outside #gap against the §4.12 model fields in the total and
// the scriptParts() outputs outside the Gap, as a multiset, so nothing is marked twice, missed or extra.

import fs from "node:fs";
import path from "node:path";
import { load, type CheerioAPI } from "cheerio";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { loadContent } from "@/lib/content";
import { isWithheld } from "@/lib/items";
import { cardKicker, cardKickerParts, chartCaptions, EMPTY_LINES, fixSideLines, gapFooter, gapNotices, gapSecondLine, regionSummary, scriptParts } from "@/lib/page-text";
import type { Brief } from "@/lib/schema/brief";
import type { Metrics } from "@/lib/schema/metrics";
import { countWords } from "@/lib/text";
import {
  BRIEF_END, EDITION_INFO, KIND_INFO, NONE_FOUND, REGION_LEVEL_INFO, REGION_LEVELS, SCOREBOARD_NO_ENTRY, SEVERITIES, SEVERITY_INFO,
  WITHHELD_HEADLINE,
} from "@/lib/vocab";
import { AIChip } from "@/components/ui/AIChip";
import { SeverityPips } from "@/components/ui/SeverityPips";
import { BriefView, type BriefViewProps } from "@/components/brief/BriefView";
import { EpssMovers } from "@/components/brief/EpssMovers";
import { briefPropsFor } from "@/components/brief/props";
import { editionDraft } from "@/fixtures/src/drafts";
import { SITE_CONTENT_DIR } from "@/fixtures/src/site";
import { REPO_ROOT } from "@/fixtures/src/world";

const content = loadContent(path.join(REPO_ROOT, SITE_CONTENT_DIR), { fresh: true, log: () => {} });
const briefs = content.briefs;
const MONDAY = "2026-10-12";
const PARTIAL = "2026-10-13";
const WED = "2026-10-14";
const DATA_ONLY = "2026-10-06";
const WITHHELD_ID = "inc-health-us-2026-10";

function propsFor(date: string): BriefViewProps {
  const props = briefPropsFor(content, date);
  if (!props) throw new Error(`no sample brief for ${date}`);
  return props;
}

const html = (el: ReactElement) => renderToStaticMarkup(el);
const page = (props: BriefViewProps): CheerioAPI => load(html(<BriefView {...props} />));
const clone = <T,>(v: T): T => structuredClone(v);

/** The texts of every [data-words] element, optionally outside #gap. */
function counted($: CheerioAPI, outsideGap = false): string[] {
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

/** True while components/brief/GapPanel.tsx is S0's stub (the gap lane replaces it at integration). */
const GAP_STUB = fs.readFileSync(path.join(REPO_ROOT, "components/brief/GapPanel.tsx"), "utf8").startsWith("// STUB");

describe("Sample: every brief renders through BriefView", () => {
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

describe("Withholding", () => {
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

describe("Levels", () => {
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

describe("Plain text", () => {
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

describe("Word count", () => {
  const fulls = briefs.filter((b) => b.edition !== "data_only");

  it("covers full and partial editions with items, a raise and a Lens", () => {
    expect(fulls.length).toBeGreaterThanOrEqual(3);
    expect(fulls.some((b) => b.regions.rows.some((r) => r.raised))).toBe(true);
  });

  it.each(briefs.map((b) => [b.date, b.edition] as const))("%s (%s): the marked strings outside #gap are exactly the model fields and script lines", (date) => {
    const props = propsFor(date);
    const $ = page(props);
    const expected = [...modelStrings(props.brief), ...scriptOutsideGap(props.brief, props.metrics, props.gapOk)];
    expect(sorted(counted($, true))).toEqual(sorted(expected));
    expect($("[data-words] [data-words]").length).toBe(0);
  });

  // §7 asks this of the full editions; the data-only ones add up too, so every edition is checked.
  it.each(briefs.map((b) => [b.date, b.edition] as const))("%s (%s): the words outside #gap are computed.word_count less the Gap's", (date) => {
    const props = propsFor(date);
    const outside = sum(counted(page(props), true));
    expect(outside).toBe(props.brief.computed.word_count - sum(gapParts(props.brief, props.metrics, props.gapOk)));
  });

  it.skipIf(GAP_STUB).each(briefs.map((b) => [b.date, b.edition] as const))("%s (%s): the whole page's data-words sum to computed.word_count", (date) => {
    const props = propsFor(date);
    expect(sum(counted(page(props)))).toBe(props.brief.computed.word_count);
  });

  it("counts NONE_FOUND as the stored counter-point, never a label", () => {
    const $ = page(propsFor(MONDAY));
    expect(counted($, true)).toContain(NONE_FOUND);
    expect($("#lead [data-words]").toArray().map((el) => $(el).text())).not.toContain("Counter-point: ");
  });
});
