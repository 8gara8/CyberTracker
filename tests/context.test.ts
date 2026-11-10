// The agent context (SPEC §4.15, §8.5; plan §2.5 L4): buildContext() on the fixture morning (collect and
// metrics in-process in a temporary root, tests/helpers/pipeline-world.ts), the trims in order on synthetic
// oversized inputs, ContextTooLarge, what is never trimmed, the CLI's bytes and the standing stories' last
// development (plan A15), and the withheld marks on recent items (a withhold binds later editions). Offline.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildContext, CONTEXT_LINE_MAX, CONTEXT_MAX_BYTES, CONTEXT_TRIMS, ContextTooLarge, type BuiltContext, type ContextInput,
} from "@/lib/context";
import { addDays, at } from "@/lib/dates";
import { printJson } from "@/lib/json-schema";
import { previewRegions, regionsPreviewRows } from "@/lib/regions";
import { readCorrections, readScoreboard, standingLast } from "@/lib/run-inputs";
import { Brief } from "@/lib/schema/brief";
import { AgentContext } from "@/lib/schema/context";
import type { Correction, CorrectionsFile, Dispute } from "@/lib/schema/misc";
import { BANNED_WORDS, WITHHELD_HEADLINE } from "@/lib/vocab";
import { main } from "@/scripts/build-context";
import { REPO } from "./helpers/harness";
import { buildPipelineWorld, type PipelineWorld } from "./helpers/pipeline-world";

const TEMPLATE = Brief.parse(JSON.parse(fs.readFileSync(path.join(REPO, "fixtures", "site-content", "briefs", "2026-10-14.json"), "utf8")));
const pad = (label: string, n: number) => `${label} ${"padding ".repeat(Math.ceil(n / 8))}`.slice(0, n);

let w: PipelineWorld;
let input: ContextInput;
let built: BuiltContext;

beforeAll(async () => {
  w = await buildPipelineWorld();
  input = {
    date: w.date, now: w.start, deadline: w.start + 30 * 60_000, pack: w.pack, candidates: w.candidates, metrics: w.metrics,
    config: w.config, history: w.history, corrections: null, scoreboard: null, regionsBase: w.regionsBase, recheck: null,
    standingLast: w.standingLast,
  };
  built = buildContext(input);
}, 120_000);

afterAll(() => w?.dispose());

/** A stored brief like the fixture's full edition, dated `date`, each headline `size` characters. */
function briefOn(date: string, size = 0): Brief {
  const b = structuredClone(TEMPLATE);
  b.date = date;
  if (size) b.items = b.items.map((it, k) => ({ ...it, headline: pad(`Item ${k} on ${date}`, size) }));
  return b;
}

describe("buildContext on the fixture morning", () => {
  it("X1 parses as AgentContext, from the pack, candidates, metrics, config and regions base", () => {
    const c = built.context;
    expect(AgentContext.parse(JSON.parse(built.text))).toEqual(c);
    expect(built.text).toBe(`${printJson(c)}\n`);
    expect(built.trimmed).toEqual([]);
    expect(Buffer.byteLength(built.text)).toBeLessThan(CONTEXT_MAX_BYTES);
    expect(c).toMatchObject({
      date: "2026-10-14", weekly: false, deadline: "2026-10-14T05:07:00+08:00", data_cutoff_utc: w.pack.data_cutoff_utc,
      window: w.pack.window, budgets: { max_items: 10, typical_items: [5, 8], deep_reads: 15, page_fetches: 40, words: { target: 1100, max: 1300 } },
      pack: { md: "packs/2026-10-14.md", json: "packs/2026-10-14.json", degraded: false, failed_feeds: [] },
      yesterday: null, recent_items: [], corrections: { flagged: [], reports: [] },
    });
    expect(c.candidates).toEqual(w.candidates.kept);
    expect(c.candidates).toHaveLength(40);
    expect(c.cut).toEqual(w.candidates.cut);
    expect(c.metrics.gap_headline).toBe(w.metrics.headline.text);
    expect(c.metrics.stale).toEqual([]);
    expect(c.regions_preview).toEqual(regionsPreviewRows(previewRegions(w.regionsBase)));
    expect(c.config.banned_words).toEqual([...BANNED_WORDS]);
    expect(c.config.home_vendors.tw.length).toBeGreaterThan(0);
    expect(c.scoreboard).toEqual(w.config.claims.claims.map(() => expect.anything()));
    expect(c.watch_searches.map((s) => s.id)).toEqual(w.config.sources.feeds.filter((f) => f.kind === "search").map((f) => f.id));
    // Every number the headline quotes is quotable with its display string, then the table and the Lens counts.
    for (const q of w.metrics.headline.quoted) expect(c.metrics.quotable).toContainEqual(expect.objectContaining({ key: q.path, display: q.display }));
    expect(c.metrics.quotable).toContainEqual({ key: "window.w26.at_disclosure_share", label: "share already exploited at disclosure, 26 weeks", display: "40%", as_of: w.metrics.data_cutoff_utc });
    expect(c.metrics.quotable).toContainEqual({ key: "home_vendors.tw.d30_n", label: "KEV additions for Taiwanese vendors, 30 days", display: "1", as_of: w.metrics.data_cutoff_utc });
    expect(c.metrics.home_vendor_kev).toEqual({ tw: { d30_n: 1, d90_n: 1 }, jp: { d30_n: 0, d90_n: 0 } });
  });

  it("X1 names only the partial-edition feeds that are stale or failed, never a news feed", () => {
    const feeds = w.pack.feeds.map((f) => (f.id === "kev" ? { ...f, stale: true } : f.id === "epss" ? { ...f, ok: false, error: "timeout" } : f));
    const c = buildContext({ ...input, pack: { ...w.pack, feeds } }).context;
    expect(c.metrics.stale).toEqual(["kev", "epss"]);
    expect(c.pack.failed_feeds).toEqual(["epss"]);
    expect(w.pack.feeds.filter((f) => !f.ok).map((f) => f.id)).toEqual(["krebs", "gtig"]);
  });

  it("X1 carries yesterday's edition and 14 days of items, newest first, and active watch windows' searches", () => {
    const history = [briefOn(addDays(w.date, -1)), briefOn(addDays(w.date, -14)), briefOn(addDays(w.date, -15))];
    const win = { id: "ct-sample-window", title: "Sample election week", start: addDays(w.date, -1), end: addDays(w.date, 1), regions: ["TW" as const], search_terms: ["sample election", "選舉 資安", "サンプル 選挙"], note: null };
    const windows = { ...w.config.watchWindows, windows: [win] } as unknown as typeof w.config.watchWindows;
    const c = buildContext({ ...input, history, config: { ...w.config, watchWindows: windows } }).context;
    expect(c.yesterday).toEqual({ date: addDays(w.date, -1), edition: "full", lead: TEMPLATE.lead.map((l) => l.text), item_ids: TEMPLATE.items.map((it) => it.id) });
    expect([...new Set(c.recent_items.map((r) => r.date))]).toEqual([addDays(w.date, -1), addDays(w.date, -14)]);
    const first = TEMPLATE.items[0]!;
    expect(c.recent_items[0]).toEqual({
      date: addDays(w.date, -1), id: first.id, kind: first.kind, headline: first.headline, severity: first.severity,
      source_urls: first.source_ids.map((id) => TEMPLATE.sources.find((s) => s.id === id)!.url),
    });
    expect(c.watch_windows).toEqual([{ id: win.id, title: win.title, start: win.start, end: win.end, search_terms: win.search_terms }]);
    expect(c.watch_searches.slice(-3)).toEqual([
      { id: "w-ct-sample-window-1", name: win.title, query: "sample election", language: "en", region: "TW" },
      { id: "w-ct-sample-window-2", name: win.title, query: "選舉 資安", language: "zh-Hant-TW", region: "TW" },
      { id: "w-ct-sample-window-3", name: win.title, query: "サンプル 選挙", language: "ja", region: "TW" },
    ]);
  });

  it("X2 prints no line longer than 1,000 characters, and refuses a string that would make one", () => {
    expect(Math.max(...built.text.split("\n").map((l) => l.length))).toBeLessThanOrEqual(CONTEXT_LINE_MAX);
    const long = briefOn(addDays(w.date, -2), CONTEXT_LINE_MAX + 50);
    expect(() => buildContext({ ...input, history: [long] })).toThrow(/longer than 1000 characters/);
  });
});

describe("the trims (§8.5)", () => {
  /** Old recent items, candidates 31 to 40 and match_terms beyond 5, each sized in bytes. */
  function oversized(o: { old: number; tail: number; terms: number; head?: number }): ContextInput {
    const history = [briefOn(addDays(w.date, -3))];
    const perBrief = TEMPLATE.items.length * 900;
    for (let k = 0; k * perBrief < o.old; k++) history.push(briefOn(addDays(w.date, -8 - (k % 6)), 900));
    const reasons = (rank: number, bytes: number) => Array.from({ length: Math.ceil(bytes / 900) }, (_, j) => pad(`reason ${rank}.${j}`, 880));
    const kept = w.candidates.kept.map((c) => (c.rank > 30 && o.tail ? { ...c, reasons: [...c.reasons, ...reasons(c.rank, o.tail / 10)] }
      : c.rank === 1 && o.head ? { ...c, reasons: [...c.reasons, ...reasons(1, o.head)] } : c));
    const stories = w.config.standingStories.stories.map((s, k) => ({
      ...s, match_terms: [...s.match_terms, ...Array.from({ length: Math.ceil(o.terms / 4 / 900) }, (_, j) => pad(`term ${k}.${j}`, 880))],
    }));
    return {
      ...input, history, candidates: { ...w.candidates, kept },
      config: { ...w.config, standingStories: { ...w.config.standingStories, stories } },
      recheck: {
        flagged: [{ date: addDays(w.date, -2), item_id: TEMPLATE.items[0]!.id, check: "kev_changed", before: "not listed", after: "listed", evidence_url: null }],
        reports: [{ item_id: TEMPLATE.items[1]!.id, type: "fact", evidence_url: null }],
      },
    };
  }

  it("X3 trims in order while over 250 KB, logging CONTEXT_TRIMMED <what> for each", () => {
    const big = oversized({ old: 40_000, tail: 50_000, terms: 230_000 });
    const log: string[] = [];
    const r = buildContext(big, (l) => log.push(l));
    const lines = CONTEXT_TRIMS.map((t) => `CONTEXT_TRIMMED ${t}`);
    expect(lines).toEqual([
      "CONTEXT_TRIMMED recent_items older than 7 days",
      "CONTEXT_TRIMMED candidates ranked 31 to 40",
      "CONTEXT_TRIMMED standing_stories match_terms beyond 5",
    ]);
    expect(r.trimmed).toEqual(lines);
    expect(log).toEqual(lines);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(CONTEXT_MAX_BYTES);
    expect(r.text).toBe(`${printJson(r.context)}\n`);
    expect([...new Set(r.context.recent_items.map((x) => x.date))]).toEqual([addDays(w.date, -3)]);
    expect(r.context.candidates.map((c) => c.rank)).toEqual(Array.from({ length: 30 }, (_, k) => k + 1));
    expect(r.context.cut).toEqual({ count: w.candidates.cut.count + 10, by_reason: { ...w.candidates.cut.by_reason, context_trimmed: 10 } });
    r.context.standing_stories.forEach((s, k) => expect(s.match_terms).toEqual(big.config.standingStories.stories[k]!.match_terms.slice(0, 5)));
  });

  it("X3 stops trimming once under the limit", () => {
    const r = buildContext(oversized({ old: 220_000, tail: 0, terms: 0 }));
    expect(r.trimmed).toEqual(["CONTEXT_TRIMMED recent_items older than 7 days"]);
    expect(r.context.candidates).toHaveLength(40);
    expect(r.context.cut).toEqual(w.candidates.cut);
  });

  it("X4 throws ContextTooLarge when still over 250 KB after every trim", () => {
    const log: string[] = [];
    let err: unknown;
    try {
      buildContext(oversized({ old: 10_000, tail: 10_000, terms: 10_000, head: 300_000 }), (l) => log.push(l));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContextTooLarge);
    expect((err as ContextTooLarge).bytes).toBeGreaterThan(CONTEXT_MAX_BYTES);
    expect((err as Error).message).toMatch(/over the 256000-byte limit/);
    expect(log).toHaveLength(3);
  });

  it("X5 never trims the metrics, the corrections or the first 30 candidates", () => {
    const big = oversized({ old: 40_000, tail: 50_000, terms: 230_000 });
    const r = buildContext(big);
    expect(r.trimmed).toHaveLength(3);
    expect(r.context.metrics).toEqual(built.context.metrics);
    expect(r.context.corrections).toEqual(big.recheck);
    expect(r.context.candidates).toEqual(big.candidates.kept.slice(0, 30));
  });
});

describe("scripts/build-context.ts", () => {
  const quiet = () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return () => {
      out.mockRestore();
      err.mockRestore();
    };
  };

  it("X6 writes exactly BuiltContext.text, with the deadline now + 30 min by default", async () => {
    const restore = quiet();
    try {
      expect(await main(["--date", w.date], { now: () => w.start, root: w.root })).toBe(0);
      const expected = buildContext({ ...input, corrections: readCorrections(w.paths.content), scoreboard: readScoreboard(w.paths.content) }).text;
      expect(fs.readFileSync(w.paths.contextCopy, "utf8")).toBe(expected);
      expect(expected).toBe(built.text);
      const out = path.join(w.root, "logs", "ctx.json");
      expect(await main(["--date", w.date, "--deadline", "05:20", "--out", "logs/ctx.json"], { now: () => w.start, root: w.root })).toBe(0);
      expect(fs.readFileSync(out, "utf8")).toBe(buildContext({ ...input, deadline: at(w.date, "05:20") }).text);
    } finally {
      restore();
    }
  });

  it("X6 reads logs/D.recheck.json when present: the shown flags and the reports", async () => {
    const restore = quiet();
    const shown = [{ date: addDays(w.date, -3), item_id: "cve-2026-104935", check: "cvss_changed", before: "9.1", after: "9.8", evidence_url: null }];
    const reports = [{ item_id: "cve-2026-104935", type: "fact", evidence_url: "https://example.org/ct-sample/evidence" }];
    try {
      fs.mkdirSync(path.dirname(w.paths.recheck), { recursive: true });
      fs.writeFileSync(w.paths.recheck, JSON.stringify({ intake: null, flagged: null, shown, reports }));
      expect(await main(["--date", w.date, "--out", "logs/ctx-recheck.json"], { now: () => w.start, root: w.root })).toBe(0);
      const c = AgentContext.parse(JSON.parse(fs.readFileSync(path.join(w.root, "logs", "ctx-recheck.json"), "utf8")));
      expect(c.corrections).toEqual({ flagged: shown, reports });
    } finally {
      fs.rmSync(w.paths.recheck, { force: true });
      restore();
    }
  });

  it("X6 exits 2 on bad usage and 1 when an input is missing", async () => {
    const restore = quiet();
    try {
      expect(await main(["--date", w.date, "--deadline", "5:7"], { now: () => w.start, root: w.root })).toBe(2);
      expect(await main(["--date", "2026-13-01"], { now: () => w.start, root: w.root })).toBe(2);
      expect(await main(["--bogus"], { now: () => w.start, root: w.root })).toBe(2);
      expect(await main(["--date", addDays(w.date, 1)], { now: () => w.start, root: w.root })).toBe(1);
    } finally {
      restore();
    }
  });
});

describe("standing stories (plan A15)", () => {
  it("X7 a story tagged 20 days before D gets that date and item; an untagged story gets its seed", () => {
    const content = fs.mkdtempSync(path.join(os.tmpdir(), "ct-standing-"));
    try {
      const tagged = briefOn(addDays(w.date, -20));
      tagged.items[1] = { ...tagged.items[1]!, standing_story: "salt-typhoon" };
      fs.mkdirSync(path.join(content, "briefs"));
      fs.writeFileSync(path.join(content, "briefs", `${tagged.date}.json`), JSON.stringify(tagged));
      const last = standingLast(content, w.date);
      expect(last).toEqual({ "salt-typhoon": { date: addDays(w.date, -20), item_id: tagged.items[1]!.id } });

      const seed = "2026-09-01";
      const stories = w.config.standingStories.stories.map((s) => (s.id === "volt-typhoon" ? { ...s, seed_last_development: seed } : s));
      const c = buildContext({ ...input, standingLast: last, config: { ...w.config, standingStories: { ...w.config.standingStories, stories } } }).context;
      const by = new Map(c.standing_stories.map((s) => [s.id, s] as const));
      expect(by.get("salt-typhoon")).toMatchObject({ last_development: addDays(w.date, -20), last_item_id: tagged.items[1]!.id });
      expect(by.get("volt-typhoon")).toMatchObject({ last_development: seed, last_item_id: null });
      expect(by.get("dprk-it-workers")).toMatchObject({ last_development: null, last_item_id: null });
      // Twenty days back is outside recent_items, which the context builds from 14 days of briefs only.
      expect(c.recent_items).toEqual([]);
    } finally {
      fs.rmSync(content, { recursive: true, force: true });
    }
  });
});

describe("withheld recent items (a withhold binds later editions, §4.10)", () => {
  const ITEM = TEMPLATE.items[4]!.id;
  const CAMPAIGN = TEMPLATE.items[2]!.id;
  const FLAW = TEMPLATE.items[3]!.id;
  const d1 = () => addDays(w.date, -1);
  const d2 = () => addDays(w.date, -2);
  const dispute = (id: string, item: string, date: string, kind: Dispute["kind"], status: Dispute["status"], correction: string): Dispute => ({
    id, received: `${date}T21:00:00+08:00`, issue_number: Number(id.slice(2)), item_id: item, edition_date: date, kind, evidence_url: null,
    status, resolved_on: status === "open" ? null : d1(), correction_id: correction,
  });
  const removed = (id: string, item: string, date: string, field: string, disputeId: string): Correction => ({
    id, date: addDays(date, 1), item_id: item, edition_date: date, type: "name_removed", field, before: "[name removed]",
    after: "withheld while a dispute is reviewed", reason: "SAMPLE.", source_url: null, trigger: "reader_report", dispute_id: disputeId,
  });

  /** d2 holds ITEM (victim, open), CAMPAIGN (attribution, upheld) and FLAW (victim, rejected); d1 repeats ITEM with `withheld` set. */
  function world(): { history: Brief[]; corrections: CorrectionsFile } {
    const older = briefOn(d2());
    older.items = older.items.map((it) => (it.id === ITEM ? { ...it, headline: "SAMPLE original headline naming a party", withheld: { correction_id: "C-0001", since: d1() } } : it));
    const newer = briefOn(d1());
    newer.items = newer.items.map((it) => (it.id === ITEM ? { ...it, headline: WITHHELD_HEADLINE, withheld: { correction_id: "C-0001", since: d1() } } : it));
    return {
      history: [newer, older],
      corrections: {
        schema_version: 1,
        corrections: [
          removed("C-0001", ITEM, d2(), "incident.victim", "D-0001"),
          removed("C-0002", CAMPAIGN, d2(), "attribution", "D-0002"),
          removed("C-0003", FLAW, d2(), "incident.victim", "D-0003"),
        ],
        disputes: [
          dispute("D-0001", ITEM, d2(), "victim", "open", "C-0001"),
          dispute("D-0002", CAMPAIGN, d2(), "attribution", "upheld", "C-0002"),
          dispute("D-0003", FLAW, d2(), "victim", "rejected", "C-0003"),
        ],
      },
    };
  }
  const entry = (c: AgentContext, date: string, id: string) => c.recent_items.find((r) => r.date === date && r.id === id)!;

  it("X8 marks each item an open or upheld victim or attribution dispute withholds, with the withheld headline and never the stored text", () => {
    const { history, corrections } = world();
    const r = buildContext({ ...input, history, corrections });
    const c = r.context;
    expect(entry(c, d2(), ITEM)).toMatchObject({ headline: WITHHELD_HEADLINE, withheld: true, dispute_kind: "victim" });
    expect(entry(c, d1(), ITEM)).toMatchObject({ headline: WITHHELD_HEADLINE, withheld: true, dispute_kind: "victim" });
    expect(entry(c, d2(), CAMPAIGN)).toMatchObject({ headline: WITHHELD_HEADLINE, withheld: true, dispute_kind: "attribution" });
    // A rejected dispute no longer binds: the item reads as stored, with no marks; so does every other item.
    const tpl = (id: string) => TEMPLATE.items.find((it) => it.id === id)!;
    expect(entry(c, d2(), FLAW)).toEqual({
      date: d2(), id: FLAW, kind: tpl(FLAW).kind, headline: tpl(FLAW).headline, severity: tpl(FLAW).severity,
      source_urls: tpl(FLAW).source_ids.map((id) => TEMPLATE.sources.find((s) => s.id === id)!.url),
    });
    const marked = c.recent_items.filter((x) => x.withheld).map((x) => `${x.date}/${x.id}`);
    expect(marked.sort()).toEqual([`${d1()}/${ITEM}`, `${d2()}/${CAMPAIGN}`, `${d2()}/${ITEM}`].sort());
    for (const x of c.recent_items) if (!x.withheld) expect(Object.keys(x)).not.toContain("dispute_kind");
    // The marked item keeps its source URLs (the agent must leave them out too); the stored headline is never printed.
    expect(entry(c, d2(), ITEM).source_urls.length).toBeGreaterThan(0);
    expect(r.text).not.toContain("SAMPLE original headline naming a party");
    expect(AgentContext.parse(JSON.parse(r.text))).toEqual(c);
  });

  it("X8 the run's dispute statuses (intake's list) win over corrections.json's", () => {
    const { history, corrections } = world();
    const disputes = corrections.disputes.map((d) => (d.id === "D-0001" ? { ...d, status: "withdrawn" as const } : d.id === "D-0003" ? { ...d, status: "open" as const } : d));
    const c = buildContext({ ...input, history, corrections, disputes }).context;
    expect(entry(c, d2(), ITEM).withheld).toBeUndefined();
    expect(entry(c, d2(), ITEM).headline).toBe("SAMPLE original headline naming a party");
    expect(entry(c, d2(), FLAW)).toMatchObject({ headline: WITHHELD_HEADLINE, withheld: true, dispute_kind: "victim" });
    // With no corrections file nothing is marked.
    expect(buildContext({ ...input, history, corrections: null }).context.recent_items.filter((x) => x.withheld)).toEqual([]);
  });

  it("X8 the schema takes withheld and dispute_kind only together", () => {
    const { history, corrections } = world();
    const c = buildContext({ ...input, history, corrections }).context;
    const k = c.recent_items.findIndex((x) => x.withheld);
    const broken = structuredClone(c);
    delete broken.recent_items[k]!.dispute_kind;
    expect(AgentContext.safeParse(broken).success).toBe(false);
    const other = structuredClone(c);
    other.recent_items[c.recent_items.findIndex((x) => !x.withheld)]!.dispute_kind = "victim";
    expect(AgentContext.safeParse(other).success).toBe(false);
  });
});
