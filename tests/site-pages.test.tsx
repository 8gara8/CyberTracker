// The pages lane's site tests (SPEC §7 "Site tests (P4)", the cases its routes and frame own): the empty
// states of /, /archive and /feed.xml; the security headers; the plain-text greps; Methodology's STYLE
// sections, anchors and rule rows; withholding on the item page; the archive's kickers; the feed's titles
// and guids; the item page's timeline order and record links; and TabBar's aria-current on each route.
// Pages render with renderToStaticMarkup in the node environment; async pages are awaited first. The
// pages read CT_CONTENT_DIR through loadContent(), which caches per folder, so each block sets it.
// BriefView belongs to the brief lane, so nothing here asserts on its markup.

import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import nextConfig, { contentSecurityPolicy, securityHeaders } from "@/next.config";
import HomePage, { generateMetadata as homeMetadata } from "@/app/page";
import ArchivePage from "@/app/archive/page";
import AboutPage from "@/app/about/page";
import MethodologyPage from "@/app/methodology/page";
import NotFound from "@/app/not-found";
import BriefPage, * as briefRoute from "@/app/brief/[date]/page";
import ItemRoute, * as itemRoute from "@/app/items/[id]/page";
import * as feedRoute from "@/app/feed.xml/route";
import { Footer } from "@/components/layout/Footer";
import { Masthead } from "@/components/layout/Masthead";
import { SampleBanner } from "@/components/layout/SampleBanner";
import { StaleBanner } from "@/components/layout/StaleBanner";
import { TabBar } from "@/components/layout/TabBar";
import { ItemPage, itemPageTitle } from "@/components/pages/ItemPage";
import { FEED_SIZE, escapeXml, feedXml } from "@/components/pages/feed";
import { STYLE_SECTIONS } from "@/components/pages/methodology-data";
import { KEV_CATALOG_URL } from "@/components/pages/records";
import { ABOUT_WHAT, DATA_CREDITS, howItIsMade, noEditionYet, sourcesDocUrl } from "@/components/pages/site-text";
import { loadConfig } from "@/lib/config";
import { loadContent, type Content } from "@/lib/content";
import { longDate, rfc822 } from "@/lib/format";
import { section } from "@/lib/markdown";
import { briefDescription } from "@/lib/page-text";
import type { Brief } from "@/lib/schema/brief";
import type { Correction } from "@/lib/schema/misc";
import { SIBLINGS, issueFormUrl, siteUrl } from "@/lib/site";
import { ABOUT_LINE, ANTHROPIC_LINE, WITHHELD_HEADLINE, WITHHELD_TEXT } from "@/lib/vocab";
import { EMPTY_CONTENT_DIR, SITE_CONTENT_DIR } from "@/fixtures/src/site";
import { REPO_ROOT } from "@/fixtures/src/world";

const html = (el: ReactElement) => renderToStaticMarkup(el);

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

const params = <T,>(v: T) => ({ params: Promise.resolve(v) });

const savedDir = process.env.CT_CONTENT_DIR;
afterAll(() => {
  if (savedDir === undefined) delete process.env.CT_CONTENT_DIR;
  else process.env.CT_CONTENT_DIR = savedDir;
});

/** A deep copy of the sample content, for in-memory cases (the cached Content is never changed). */
function sampleCopy(): Content {
  const c = loadContent(SITE_CONTENT_DIR);
  return { ...c, briefs: structuredClone(c.briefs), corrections: structuredClone(c.corrections) };
}

const briefOf = (c: Pick<Content, "briefs">, date: string) => c.briefs.find((b) => b.date === date)!;

// ── Empty ─────────────────────────────────────────────────────────────────────────────────────────

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

// ── Headers ───────────────────────────────────────────────────────────────────────────────────────

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

// ── Plain text ────────────────────────────────────────────────────────────────────────────────────

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

// ── The sample ────────────────────────────────────────────────────────────────────────────────────

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

// ── Methodology ───────────────────────────────────────────────────────────────────────────────────

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
});

// ── Withholding and the item page ─────────────────────────────────────────────────────────────────

describe("item page", () => {
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

// ── Page frame ────────────────────────────────────────────────────────────────────────────────────

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
