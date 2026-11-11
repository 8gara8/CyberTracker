// The site's content loading (SPEC §6 "Content loading", §7 Site tests "Skipping"): lib/content.ts re-checks
// every file with validateAll(dir, { perFile: true }), skips a brief only for a SITE_BLOCKING_CODES code, keeps
// it with a build warning for any other error, and throws only for a missing folder. Each case changes one
// thing in a fresh temporary copy of fixtures/site-content/ (outside fixtures/, so it passes the sample claims
// explicitly). The helpers in lib/site-data.ts and components/brief/props.ts are checked on the sample.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ContentError, SITE_BLOCKING_CODES, contentLogLines, loadContent, loadMetrics, type Content } from "@/lib/content";
import { RULES } from "@/lib/rules";
import { SAFETY_CODES } from "@/lib/rules/safety";
import type { Brief } from "@/lib/schema/brief";
import { correctionsFor, indexBy, itemHistory, itemPageIds, neighbours } from "@/lib/site-data";
import { CANARY_TOKEN } from "@/lib/vocab";
import { BriefView } from "@/components/brief/BriefView";
import { briefPropsFor } from "@/components/brief/props";
import { fixtureConfig } from "@/fixtures/src/inputs";
import { EMPTY_CONTENT_DIR, SITE_CONTENT_DIR } from "@/fixtures/src/site";
import { REPO_ROOT } from "@/fixtures/src/world";

const SITE = path.join(REPO_ROOT, SITE_CONTENT_DIR);
const WED = "2026-10-14";
const WED_FILE = `briefs/${WED}.json`;
const config = fixtureConfig();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-content-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let copies = 0;

/** A fresh copy of the sample content folder, outside fixtures/. */
function copy(): string {
  const dir = path.join(tmp, `c${(copies += 1)}`);
  fs.cpSync(SITE, dir, { recursive: true });
  return dir;
}

function edit<T>(dir: string, file: string, fn: (v: T) => void): void {
  const p = path.join(dir, file);
  const v = JSON.parse(fs.readFileSync(p, "utf8")) as T;
  fn(v);
  fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
}

/** Loads a copy with the sample config, collecting the log lines. */
function load(dir: string): { content: Content; lines: string[] } {
  const lines: string[] = [];
  const content = loadContent(dir, { fresh: true, config, log: (l) => lines.push(l) });
  return { content, lines };
}

const dates = (c: Content) => c.briefs.map((b) => b.date);
const SAMPLE_DATES = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];

describe("loadContent on the sample", () => {
  it("loads every sample file with nothing skipped and no warning, briefs oldest first", () => {
    const lines: string[] = [];
    const c = loadContent(SITE, { fresh: true, log: (l) => lines.push(l) });
    expect(dates(c)).toEqual(SAMPLE_DATES);
    expect(c.skipped).toEqual([]);
    expect(c.warnings).toEqual([]);
    expect(c.gapFailed.size).toBe(0);
    expect(lines).toEqual([]);
    expect([...c.metricsFiles]).toEqual(SAMPLE_DATES.map((d) => `metrics/${d}.json`));
    expect(c.status.map((s) => s.date)).toEqual([...SAMPLE_DATES, "2026-10-16"]);
    expect(c.scoreboard).not.toBeNull();
    expect(c.corrections.corrections.map((x) => x.id)).toEqual(["C-0001", "C-0002"]);
  });

  it("caches per folder unless fresh", () => {
    const a = loadContent(SITE, { log: () => {} });
    expect(loadContent(SITE, { log: () => {} })).toBe(a);
    expect(loadContent(path.join(SITE, "."), { log: () => {} })).toBe(a);
    expect(loadContent(SITE, { fresh: true, log: () => {} })).not.toBe(a);
  });

  it("loads the empty folder as no briefs, the default corrections and no scoreboard", () => {
    const c = loadContent(path.join(REPO_ROOT, EMPTY_CONTENT_DIR), { fresh: true, log: () => {} });
    expect(c.briefs).toEqual([]);
    expect(c.skipped).toEqual([]);
    expect(c.corrections).toEqual({ schema_version: 1, corrections: [], disputes: [] });
  });

  it("parses metrics lazily: loadMetrics gives the named file once, null for a null or unknown file", () => {
    const c = loadContent(SITE, { fresh: true, log: () => {} });
    const m = loadMetrics(c, `metrics/${WED}.json`);
    expect(m?.date).toBe(WED);
    expect(loadMetrics(c, `metrics/${WED}.json`)).toBe(m);
    expect(loadMetrics(c, null)).toBeNull();
    expect(loadMetrics(c, "metrics/2026-01-01.json")).toBeNull();
  });
});

describe("Skipping (SPEC §7 Site tests)", () => {
  it("a brief with an unknown key is skipped with SCHEMA; the rest are present", () => {
    const dir = copy();
    edit<Record<string, unknown>>(dir, WED_FILE, (b) => { b.unexpected_key = 1; });
    const { content, lines } = load(dir);
    expect(content.skipped).toEqual([{ file: WED_FILE, codes: ["SCHEMA"] }]);
    expect(dates(content)).toEqual(SAMPLE_DATES.filter((d) => d !== WED));
    expect(lines[0]).toBe(`content: skipped ${WED_FILE} (SCHEMA)`);
  });

  it("a missing folder throws ContentError", () => {
    expect(() => loadContent(path.join(tmp, "no-such-folder"), { fresh: true, log: () => {} })).toThrow(ContentError);
    const file = path.join(tmp, "a-file");
    fs.writeFileSync(file, "{}");
    expect(() => loadContent(file, { fresh: true, log: () => {} })).toThrow(ContentError);
  });

  // An AWS-key-shaped string joined at run time, so this file holds none.
  const secret = ["AK", "IA"].join("") + "ABCDEFGHIJKLMNOP";

  const cases: { code: string; planted: string; change: (b: Brief) => void }[] = [
    { code: "CANARY", planted: CANARY_TOKEN, change: (b) => { b.items[0]!.summary += ` ${CANARY_TOKEN}`; } },
    { code: "NO_LIVE_IOC", planted: "login-update.example.com", change: (b) => { b.items[0]!.summary += " Phishing used login-update.example.com."; } },
    { code: "NO_EXPLOIT_LINK", planted: "bit.ly", change: (b) => { b.sources[0]!.url = "https://bit.ly/"; } },
    { code: "SECRET_LIKE", planted: secret, change: (b) => { b.items[0]!.summary += ` ${secret}`; } },
  ];

  for (const c of cases) {
    it(`${c.code} skips the brief; the log names the file and code, never the text`, () => {
      const dir = copy();
      edit<Brief>(dir, WED_FILE, c.change);
      const { content, lines } = load(dir);
      expect(content.skipped).toEqual([{ file: WED_FILE, codes: [c.code] }]);
      expect(dates(content)).toEqual(SAMPLE_DATES.filter((d) => d !== WED));
      expect(lines).toContain(`content: skipped ${WED_FILE} (${c.code})`);
      for (const line of lines) expect(line).not.toContain(c.planted);
      // The logged codes are SITE_BLOCKING_CODES only; the brief's other issues (a changed word count) are not listed.
      expect(content.warnings.some((w) => w.file === WED_FILE)).toBe(false);
    });
  }

  it("NO_LIVE_IOC and NO_EXPLOIT_LINK skip a brief although validateAll() reports them as warnings on an archived brief", () => {
    // The newest brief is archived too (validateAll() without `publishing`), so these codes reach the site as warnings.
    for (const c of cases.filter((x) => x.code === "NO_LIVE_IOC" || x.code === "NO_EXPLOIT_LINK")) {
      const dir = copy();
      edit<Brief>(dir, WED_FILE, c.change);
      expect(load(dir).content.skipped.map((s) => s.codes)).toEqual([[c.code]]);
    }
  });

  it("a Gap number changed in the Lead (LEAD_GROUNDED, word count unchanged) leaves the brief shown with one warning", () => {
    const dir = copy();
    edit<Brief>(dir, WED_FILE, (b) => {
      const s = b.lead.find((x) => x.gap)!;
      expect(s.text).toContain("37%");
      s.text = s.text.replace("37%", "38%");
    });
    const { content, lines } = load(dir);
    expect(content.skipped).toEqual([]);
    expect(dates(content)).toEqual(SAMPLE_DATES);
    expect(content.warnings).toEqual([{ file: WED_FILE, codes: ["LEAD_GROUNDED"] }]);
    expect(lines).toEqual([`content: warning ${WED_FILE} (LEAD_GROUNDED)`]);
    expect(content.briefs.find((b) => b.date === WED)!.lead.find((x) => x.gap)!.text).toContain("38%");
  });

  it("a correction whose text fails a safety code is dropped from corrections.json too, not only from the brief listing it", () => {
    const dir = copy();
    const planted = " Phishing used login-update.example.com.";
    edit<{ corrections: { id: string; after: string }[] }>(dir, "corrections.json", (f) => { f.corrections.find((c) => c.id === "C-0002")!.after += planted; });
    edit<Brief>(dir, "briefs/2026-10-13.json", (b) => { b.corrections.find((c) => c.id === "C-0002")!.after += planted; });
    const { content, lines } = load(dir);
    expect(content.skipped).toEqual([
      { file: "briefs/2026-10-13.json", codes: ["NO_LIVE_IOC"] },
      { file: "corrections.json C-0002", codes: ["NO_LIVE_IOC"] },
    ]);
    expect(lines).toContain("content: skipped corrections.json C-0002 (NO_LIVE_IOC)");
    for (const line of lines) expect(line).not.toContain("login-update");
    expect(content.corrections.corrections.map((c) => c.id)).toEqual(["C-0001"]);
    expect(correctionsFor(content, "pol-jp-active-cyber-defence-2026-10", "2026-10-12")).toEqual([]);
    expect(renderToStaticMarkup(createElement(BriefView, briefPropsFor(content, "2026-10-12")!))).not.toContain("login-update");
  });

  it("SITE_BLOCKING_CODES holds every SAFETY_CODES code, and every entry but FILE_NAME is a † rule (§4.12)", () => {
    for (const code of SAFETY_CODES) expect(SITE_BLOCKING_CODES).toContain(code);
    // The † rows of the §4.12 table, read from SPEC.md, and the rules the validator runs on data-only editions.
    const spec = fs.readFileSync(path.join(REPO_ROOT, "SPEC.md"), "utf8");
    const dagger = new Set([...spec.matchAll(/^\| ([A-Z_]+) † \|/gmu)].map((m) => m[1]!));
    expect(dagger.size).toBeGreaterThan(10);
    const dataOnlyRules = new Set(RULES.filter((r) => r.dataOnly).flatMap((r) => r.codes));
    for (const code of SITE_BLOCKING_CODES) {
      if (code === "FILE_NAME") continue;
      expect(dagger, code).toContain(code);
      if (code !== "SCHEMA") expect(dataOnlyRules, code).toContain(code);
    }
  });
});

describe("other files and the Gap", () => {
  it("a brief whose same-date metrics file fails its schema is shown with GAP_MATCH: gapFailed, gapOk false, no metrics", () => {
    const dir = copy();
    edit<Record<string, unknown>>(dir, `metrics/${WED}.json`, (m) => { m.unexpected_key = 1; });
    const { content } = load(dir);
    expect(content.skipped).toEqual([{ file: `metrics/${WED}.json`, codes: ["SCHEMA"] }]);
    expect(dates(content)).toEqual(SAMPLE_DATES);
    expect(content.metricsFiles.has(`metrics/${WED}.json`)).toBe(false);
    expect([...content.gapFailed]).toEqual([WED]);
    expect(content.warnings.find((w) => w.file === WED_FILE)?.codes).toContain("GAP_MATCH");
    const props = briefPropsFor(content, WED)!;
    expect(props.gapOk).toBe(false);
    expect(props.metrics).toBeNull();
    expect(briefPropsFor(content, "2026-10-13")!.gapOk).toBe(true);
  });

  it("an invalid corrections.json is skipped and read as the empty file; an invalid scoreboard.json as null", () => {
    const dir = copy();
    edit<Record<string, unknown>>(dir, "corrections.json", (c) => { c.unexpected_key = 1; });
    edit<Record<string, unknown>>(dir, "scoreboard.json", (s) => { s.unexpected_key = 1; });
    const { content } = load(dir);
    expect(content.skipped).toEqual([{ file: "corrections.json", codes: ["SCHEMA"] }, { file: "scoreboard.json", codes: ["SCHEMA"] }]);
    expect(content.corrections).toEqual({ schema_version: 1, corrections: [], disputes: [] });
    expect(content.scoreboard).toBeNull();
    expect(dates(content)).toEqual(SAMPLE_DATES);
  });

  it("an unparsable corrections.json, scoreboard.json or status file is skipped with SCHEMA, never a warning", () => {
    const dir = copy();
    for (const f of ["corrections.json", "scoreboard.json", "status/2026-10-16.json"]) fs.writeFileSync(path.join(dir, f), "");
    const { content, lines } = load(dir);
    expect(content.skipped).toEqual([
      { file: "corrections.json", codes: ["SCHEMA"] },
      { file: "scoreboard.json", codes: ["SCHEMA"] },
      { file: "status/2026-10-16.json", codes: ["SCHEMA"] },
    ]);
    expect(content.warnings).toEqual([]);
    expect(lines).toContain("content: skipped corrections.json (SCHEMA)");
    expect(content.status.map((s) => s.date)).toEqual(SAMPLE_DATES);
    expect(content.corrections).toEqual({ schema_version: 1, corrections: [], disputes: [] });
    expect(content.scoreboard).toBeNull();
  });

  it("without opts.log the lines go to console.warn once per folder per process", () => {
    const dir = copy();
    edit<Record<string, unknown>>(dir, WED_FILE, (b) => { b.unexpected_key = 1; });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      loadContent(dir, { fresh: true, config });
      loadContent(dir, { fresh: true, config });
      expect(warn.mock.calls).toEqual([[`content: skipped ${WED_FILE} (SCHEMA)`]]);
    } finally {
      warn.mockRestore();
    }
  });

  it("contentLogLines lists skipped files, then warnings", () => {
    expect(contentLogLines({ skipped: [{ file: "briefs/a.json", codes: ["SCHEMA", "CANARY"] }], warnings: [{ file: "briefs/b.json", codes: ["LEAD_GROUNDED"] }] }))
      .toEqual(["content: skipped briefs/a.json (SCHEMA, CANARY)", "content: warning briefs/b.json (LEAD_GROUNDED)"]);
  });
});

describe("lib/site-data.ts and briefPropsFor on the sample", () => {
  const c = loadContent(SITE, { fresh: true, log: () => {} });

  it("indexBy and neighbours", () => {
    expect(Object.keys(indexBy([{ id: "a" }, { id: "b" }]))).toEqual(["a", "b"]);
    expect(neighbours(c, "2026-10-06")).toEqual({ prev: null, next: "2026-10-07" });
    expect(neighbours(c, WED)).toEqual({ prev: "2026-10-13", next: "2026-10-15" });
    expect(neighbours(c, "2026-10-15")).toEqual({ prev: WED, next: null });
    expect(neighbours(c, "2026-01-01")).toEqual({ prev: null, next: null });
  });

  it("itemPageIds: ids in two or more editions, or citing a Scoreboard report's source", () => {
    const ids = itemPageIds(c);
    expect(itemPageIds(c)).toBe(ids);
    // cve-2026-108917 is in the 13 and 14 October editions.
    expect(ids.has("cve-2026-108917")).toBe(true);
    for (const id of ids) {
      const n = c.briefs.filter((b) => b.items.some((x) => x.id === id)).length;
      if (n >= 2) continue;
      const b = c.briefs.find((x) => x.items.some((i) => i.id === id))!;
      const reports = b.scoreboard.entries.filter((e) => e.origin === "report").map((e) => e.source_url);
      expect(reports.length, id).toBeGreaterThan(0);
    }
  });

  it("itemHistory: oldest first, with only the sources each copy cites", () => {
    const h = itemHistory(c, "cve-2026-108917");
    expect(h.map((e) => e.date)).toEqual(["2026-10-13", WED]);
    for (const e of h) expect(e.sources.map((s) => s.id).sort()).toEqual([...new Set(e.item.source_ids)].sort());
    expect(itemHistory(c, "no-such-item")).toEqual([]);
  });

  it("correctionsFor: the edition's corrections to the item", () => {
    expect(correctionsFor(c, "inc-health-us-2026-10", "2026-10-12").map((x) => x.id)).toEqual(["C-0001"]);
    expect(correctionsFor(c, "pol-jp-active-cyber-defence-2026-10", "2026-10-12").map((x) => x.id)).toEqual(["C-0002"]);
    expect(correctionsFor(c, "inc-health-us-2026-10", WED)).toEqual([]);
  });

  it("briefPropsFor: the props BriefView gets", () => {
    const p = briefPropsFor(c, "2026-10-12")!;
    expect(p.brief.date).toBe("2026-10-12");
    expect(p.metrics?.date).toBe("2026-10-12");
    expect(p.gapOk).toBe(true);
    expect(p.isLatest).toBe(false);
    expect([p.prevDate, p.nextDate]).toEqual(["2026-10-11", "2026-10-13"]);
    expect(p.correctionsByItem["inc-health-us-2026-10"]!.map((x) => x.id)).toEqual(["C-0001"]);
    expect(Object.keys(p.correctionsByItem).sort()).toEqual(p.brief.items.map((i) => i.id).sort());
    expect(briefPropsFor(c, "2026-10-15")!.isLatest).toBe(true);
    expect(briefPropsFor(c, "2026-01-01")).toBeNull();
  });
});
