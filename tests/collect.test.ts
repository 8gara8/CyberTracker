// Collect (SPEC §8.3, feeds plan §9): the pure helpers in lib/collect.ts, then scripts/collect.ts end to
// end on fixtures/feeds (CT_FIXTURE_FEEDS) in a temp root, and the command line's exit codes.
// WP4's matchRecord() is a stub in this lane, so every run passes the same rule as an aiMatch fake.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPack, capItems, capRecords, cveIdsIn, cvePackRecords, dedupe, emptyPack, emptyPackMd, epssJumps, epssPackRecords, feedState, freshColumn, kevPackRecords,
  injectionCount, inWindow, isDegraded, keywordHits, MD_LINE_MAX, PACK_MD_MAX_BYTES, packScore, packWindow, provisionalRecords,
  notePackRecords, PER_ID_MAX, perIdPlan, recordWindow, remapIds, RECORD_ID_PATTERNS, safeLink, safeRecordId, skippedOutcome, toItemDrafts, toPackItems, zipPlan, zipsReach, zipsShortNote, type FeedOutcome, type ItemContext, type ItemDraft,
  dayReads, hourlyZip, ITEM_CAPS, pinnedItemIds, pinnedRecordIds, wantsStandIn, zipsAsRead, cvdPackRecord, exchangePackRecords, packEvidence, recordKeepOrder, RECORDS_MAX,
} from "../lib/collect";
import { endOfDayAsset, hourlyAsset, REPOS } from "../lib/feeds/github";
import { loadConfig, matchCredit } from "../lib/config";
import { addDays } from "../lib/dates";
import { parseEpssCsv } from "../lib/feeds/epss";
import { fetchFeed } from "../lib/feeds/http";
import { parseRss } from "../lib/feeds/rss";
import type { CveRecord, KevEntry, RawItem } from "../lib/feeds/types";
import { readZip } from "../lib/feeds/zip";
import { sha256Hex } from "../lib/json";
import { rankCandidates, recordKeepIds, RELEASE_PACK_IDS_MAX, type AiHit, type RankInput } from "../lib/rank";
import { collectSignals, givesRegionSignal, itemGivesRegionSignal, previewRegions, regionsConfig } from "../lib/regions";
import { sanitize } from "../lib/sanitize";
import { normalizeUrl } from "../lib/urls";
import { CANARY_URL_MARK } from "../lib/vocab";
import { matchRecord } from "../lib/metrics/ai-credit";
import { CandidateLogFile, CandidatesFile, CollectInputsFile, FeedIndexFile, Pack, PackSizeCut, type FeedIndexEntry, type PackItem, type PackRecord } from "../lib/schema/pack";
import type { FetchedFeed } from "../lib/schema/registry";
import { fixtureKevRows, FEED_WORLD } from "../fixtures/src/feeds";
import { storedZip } from "../fixtures/src/zip-writer";
import { collect, CollectTimeout, FixtureGuardError, fixtureGuard, main } from "../scripts/collect";
import { fixtureGit, type GitSource } from "../scripts/lib/git-source";

const ROOT = path.resolve(__dirname, "..");
const FEEDS = path.join(ROOT, "fixtures", "feeds");
const DATE = FEED_WORLD.date;
/** 04:37 Taipei on 2026-10-14 (20:37 UTC on 2026-10-13), when the morning task's collect runs. */
const T0 = Date.parse("2026-10-13T20:37:00Z");
const GENERATED_AT = "2026-10-14T04:37:00+08:00";
const NEW_KEV = ["CVE-2026-104935", "CVE-2026-96951"];
const cfg = loadConfig({ root: ROOT });
const feedById = (id: string) => cfg.sources.feeds.find((f) => f.id === id) as FetchedFeed;

const aiMatch = (rec: CveRecord): AiHit | null => {
  for (const f of cfg.compiled.aiFinders.fields) {
    for (const c of rec.credits) {
      if (c.field !== f) continue;
      const h = matchCredit(sanitize(c.value), cfg.compiled.aiFinders);
      if (h) return { ...h, field: f };
    }
  }
  return null;
};

const tmpDirs: string[] = [];
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** content/state as the 2026-10-12 cutoff left it: the KEV index at catalog 2026.10.08 (the re-join id unjoined) and days to 2026-10-11. */
function writeState(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const entries = fixtureKevRows().filter((r) => r[1] <= "2026-10-08").map((r) => (r[0] === FEED_WORLD.rejoinId ? [r[0], r[1], r[2], r[3], null, null, r[6]] : r));
  fs.writeFileSync(path.join(dir, "kev-index.json"), `${JSON.stringify({ schema_version: 1, updated_at: "2026-10-11", catalog_version: "2026.10.08", entries })}\n`);
  const days: unknown[] = [];
  for (let t = Date.parse("2026-09-01T00:00:00Z"); t <= Date.parse("2026-10-11T00:00:00Z"); t += 86_400_000) {
    days.push([new Date(t).toISOString().slice(0, 10), 0, 0, 0, sha256Hex("")]);
  }
  fs.writeFileSync(path.join(dir, "days.json"), `${JSON.stringify({ schema_version: 1, updated_at: "2026-10-11", days })}\n`);
}

function tempRoot(withState = true): string {
  const root = tmp("ct-collect-");
  fs.cpSync(path.join(ROOT, "config"), path.join(root, "config"), { recursive: true });
  if (withState) writeState(path.join(root, "content", "state"));
  return root;
}

type FixtureEntry = { file?: string; status?: number; content_type?: string; error?: string };

/** A copy of fixtures/feeds whose index is `from` (index.json by default), edited. */
function feedsVariant(edit: (index: Record<string, FixtureEntry>) => void = () => {}, from = "index.json"): string {
  const dir = tmp("ct-feeds-");
  fs.cpSync(FEEDS, dir, { recursive: true });
  const index = JSON.parse(fs.readFileSync(path.join(FEEDS, from), "utf8")) as Record<string, FixtureEntry>;
  edit(index);
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2));
  return dir;
}

let savedFeeds: string | undefined;
beforeAll(() => {
  savedFeeds = process.env.CT_FIXTURE_FEEDS;
});
afterAll(() => {
  if (savedFeeds === undefined) delete process.env.CT_FIXTURE_FEEDS;
  else process.env.CT_FIXTURE_FEEDS = savedFeeds;
});

function run(root: string, o: { feeds?: string; now?: number | (() => number); deadline?: number; date?: string; log?: string[]; urls?: string[] } = {}) {
  process.env.CT_FIXTURE_FEEDS = o.feeds ?? FEEDS;
  const now = typeof o.now === "function" ? o.now : () => (o.now as number | undefined) ?? T0;
  const fetch: typeof fetchFeed = (url, opts) => {
    o.urls?.push(url);
    return fetchFeed(url, opts);
  };
  return collect({ date: o.date ?? DATE, deadline: o.deadline ?? now() + 300_000, root, deps: { now, aiMatch, fetch, log: (l) => o.log?.push(l) } });
}

/** WP4's matchRecord() is a stub in this lane; the command-line run needs the real one. */
const wp4Ready = (() => {
  try {
    matchRecord({ credits: [] } as unknown as Parameters<typeof matchRecord>[0], null, cfg.compiled.aiFinders);
    return true;
  } catch {
    return false;
  }
})();

/** Every file under `root` except config/ and content/, relative, sorted. */
function written(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(root, p));
    }
  };
  for (const top of fs.existsSync(root) ? fs.readdirSync(root) : []) if (top !== "config" && top !== "content") walk(path.join(root, top));
  return out.sort();
}

const OUTPUTS = [
  "cache/feeds/index.json", "cache/feeds/inputs.json", `packs/${DATE}.json`, `packs/${DATE}.md`, `packs/${DATE}.candidates.json`,
  `logs/${DATE}.candidates.json`, `logs/${DATE}.collect.log`,
];
const readOut = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

// ── Windows and the zips (R37) ───────────────────────────────────────────────────────────────────

describe("windows", () => {
  const w = packWindow(DATE, cfg.run.pack);
  it("the pack window runs 04:30 to 04:30 Taipei, and the record window floors both ends to the hour", () => {
    expect(w).toEqual({ start: "2026-10-13T04:30:00+08:00", end: "2026-10-14T04:30:00+08:00" });
    expect(recordWindow(w)).toEqual({ start: "2026-10-12T20:00:00Z", end: "2026-10-13T20:00:00Z" });
  });

  it("a record published at 20:15 UTC on D − 1 lands in the next edition's record window, not D's", () => {
    const at = Date.parse("2026-10-13T20:15:00Z");
    const inside = (x: { start: string; end: string }) => Date.parse(x.start) <= at && at < Date.parse(x.end);
    expect(inside(recordWindow(w))).toBe(false);
    expect(inside(recordWindow(packWindow("2026-10-15", cfg.run.pack)))).toBe(true);
    // In the pack window of D it would have fallen between the editions without the floor.
    expect(inside(w)).toBe(true);
  });

  it("inWindow keeps the lookback for items and drops the window's end", () => {
    expect(inWindow("2026-10-12T09:00:00Z", w, 12)).toBe(true);
    expect(inWindow("2026-10-12T08:29:59Z", w, 12)).toBe(false);
    expect(inWindow("2026-10-13T20:30:00Z", w, 12)).toBe(false);
    expect(inWindow(null, w, 12)).toBe(false);
  });
});

describe("zipPlan", () => {
  const rw = recordWindow(packWindow(DATE, cfg.run.pack));
  const assets = (p: ReturnType<typeof zipPlan>) => p.zips.map((z) => z.asset);

  it("the morning run reads the cutoff's end-of-day zip and T's newest hourly zip", () => {
    const p = zipPlan({ date: DATE, recordWindow: rw, runUtcDay: "2026-10-13", hourlyTag: FEED_WORLD.hourlyTag, knownDays: null });
    expect(assets(p)).toEqual(["2026-10-12_delta_CVEs_at_end_of_day.zip", "2026-10-13_delta_CVEs_at_2000Z.zip"]);
    expect(p.zips.map((z) => z.kind)).toEqual(["end_of_day", "hourly"]);
  });

  it("an afternoon run (T = D) reads D − 1's end-of-day zip, then D's newest hourly zip", () => {
    const p = zipPlan({ date: DATE, recordWindow: rw, runUtcDay: "2026-10-14", hourlyTag: "cve_2026-10-14_0600Z", knownDays: null });
    expect(assets(p)).toEqual([
      "2026-10-12_delta_CVEs_at_end_of_day.zip", "2026-10-13_delta_CVEs_at_end_of_day.zip", "2026-10-14_delta_CVEs_at_0600Z.zip",
    ]);
  });

  /** Every UTC day from `from` to `to`, minus `holes`. */
  const history = (from: string, to: string, holes: string[] = []) => {
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) if (!holes.includes(d)) out.push(d);
    return out;
  };

  it("days missing from days.json add their zips, oldest first, up to the cutoff", () => {
    const known = history("2026-09-01", "2026-10-09");
    const p = zipPlan({ date: DATE, recordWindow: rw, runUtcDay: "2026-10-13", hourlyTag: FEED_WORLD.hourlyTag, knownDays: known });
    expect(p.missing).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
    expect(p.days.map((d) => d.date)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
    expect(assets(p)[0]).toBe("2026-10-10_delta_CVEs_at_end_of_day.zip");
  });

  it("plans a gap behind the newest counted day again, while it is inside the 25-day catch-up range (B5)", () => {
    const known = history("2026-09-01", "2026-10-11", ["2026-09-17", "2026-09-18", "2026-10-08"]);
    const p = zipPlan({ date: DATE, recordWindow: rw, runUtcDay: "2026-10-13", hourlyTag: FEED_WORLD.hourlyTag, knownDays: known });
    // The range is the 25 days ending at the cutoff (2026-09-18 to 2026-10-12); 2026-09-17 is older than it.
    expect(p.missing).toEqual(["2026-09-18", "2026-10-08", "2026-10-12"]);
    expect(p.days.map((d) => d.date)).toEqual(p.missing);
    expect(assets(p)).toEqual(expect.arrayContaining(["2026-10-08_delta_CVEs_at_end_of_day.zip", "2026-10-09_delta_CVEs_at_end_of_day.zip"]));
    expect(assets(p)).not.toContain("2026-09-17_delta_CVEs_at_end_of_day.zip");
  });

  it("names the hour the zips read reach when they end before the record window (B9)", () => {
    const p = zipPlan({ date: DATE, recordWindow: rw, runUtcDay: "2026-10-13", hourlyTag: "cve_2026-10-13_1900Z", knownDays: null });
    expect(zipsReach(p.zips)).toBe("2026-10-13T19:00:00Z");
    expect(zipsShortNote(zipsReach(p.zips), rw)).toBe("Stale: the CVE List zips read end at 19:00 UTC on 2026-10-13, before the record window ends at 20:00 UTC on 2026-10-13.");
    const full = zipPlan({ date: DATE, recordWindow: rw, runUtcDay: "2026-10-13", hourlyTag: FEED_WORLD.hourlyTag, knownDays: null });
    expect(zipsShortNote(zipsReach(full.zips), rw)).toBeNull();
    // No hourly zip at all (a guessed tag on the wrong UTC day): the end-of-day zip of 12 Oct reaches 13 Oct, 00:00 UTC.
    const none = zipPlan({ date: DATE, recordWindow: rw, runUtcDay: "2026-10-13", hourlyTag: null, knownDays: null });
    expect(zipsReach(none.zips)).toBe("2026-10-13T00:00:00Z");
    expect(zipsShortNote(zipsReach(none.zips), rw)).toMatch(/^Stale: the CVE List zips read end at 00:00 UTC on 2026-10-13, /);
    expect(zipsShortNote(null, rw)).toBeNull();
    const ok = { ...skippedOutcome(), skipped: false, ok: true, newest: "2026-10-13T19:58:00Z" };
    expect(feedState("cvelist", { ...ok, staleNote: zipsShortNote(zipsReach(p.zips), rw) }, { fresh_days: 2 }, Date.parse(rw.end))).toMatchObject({ state: "stale", label: "STALE" });
    expect(feedState("cvelist", ok, { fresh_days: 2 }, Date.parse(rw.end)).state).toBe("ok");
  });

  it("only T − 1's end-of-day zip answering 404 gets a stand-in, X's hourly zip at its newest tag (A1)", () => {
    const eod13 = { ...endOfDayAsset("2026-10-13"), kind: "end_of_day" as const, utc_day: "2026-10-13" };
    const eod12 = { ...endOfDayAsset("2026-10-12"), kind: "end_of_day" as const, utc_day: "2026-10-12" };
    expect(wantsStandIn(eod13, "2026-10-14", "http_404")).toBe(true);
    // Another error is a failure as before; an older end-of-day zip (a catch-up day) has no stand-in.
    expect(wantsStandIn(eod13, "2026-10-14", "http_503")).toBe(false);
    expect(wantsStandIn(eod13, "2026-10-14", "timeout")).toBe(false);
    expect(wantsStandIn(eod12, "2026-10-14", "http_404")).toBe(false);
    expect(wantsStandIn(eod13, "2026-10-15", "http_404")).toBe(false);
    const hourly = hourlyZip("2026-10-13", "cve_2026-10-13_2300Z")!;
    expect(wantsStandIn(hourly, "2026-10-14", "http_404")).toBe(false);
    expect(hourly).toEqual({ ...hourlyAsset("2026-10-13", "2300"), kind: "hourly", utc_day: "2026-10-13" });
    expect(hourlyZip("2026-10-13", "cve_2026-10-14_0000Z")).toBeNull();
    expect(hourlyZip("2026-10-13", "cve_2026-10-13_at_end_of_day")).toBeNull();
    expect(hourlyZip("2026-10-13", null)).toBeNull();
  });

  it("a day whose own zip an hourly zip stood in for is never ok; one whose X + 1 zip it stood in for is (A1)", () => {
    const sub = hourlyZip("2026-10-12", "cve_2026-10-12_2300Z")!;
    const standIns = new Map([[endOfDayAsset("2026-10-12").asset, sub]]);
    const days: { date: string; zips: [string, string] }[] = [
      { date: "2026-10-11", zips: [endOfDayAsset("2026-10-11").asset, endOfDayAsset("2026-10-12").asset] },
      { date: "2026-10-12", zips: [endOfDayAsset("2026-10-12").asset, hourlyAsset("2026-10-13", "2000").asset] },
    ];
    expect(dayReads(days, standIns, () => true)).toEqual([
      { date: "2026-10-11", zips: [endOfDayAsset("2026-10-11").asset, sub.asset], ok: true },
      { date: "2026-10-12", zips: [endOfDayAsset("2026-10-12").asset, hourlyAsset("2026-10-13", "2000").asset], ok: false },
    ]);
    expect(dayReads(days, new Map(), (a) => a !== endOfDayAsset("2026-10-11").asset).map((d) => d.ok)).toEqual([false, true]);
    const plan = zipPlan({ date: DATE, recordWindow: rw, runUtcDay: "2026-10-13", hourlyTag: FEED_WORLD.hourlyTag, knownDays: null });
    expect(zipsAsRead(plan.zips, standIns).map((z) => z.asset)).toEqual([sub.asset, "2026-10-13_delta_CVEs_at_2000Z.zip"]);
  });

  it("the zips read reach only as far as they cover without a gap: a stand-in ending at 23:00 stops there (A1)", () => {
    const sub = hourlyZip("2026-10-12", "cve_2026-10-12_2300Z")!;
    const t = hourlyZip("2026-10-13", FEED_WORLD.hourlyTag)!;
    expect(zipsReach([sub, t])).toBe("2026-10-12T23:00:00Z");
    expect(zipsShortNote(zipsReach([sub, t]), rw)).toBe("Stale: the CVE List zips read end at 23:00 UTC on 2026-10-12, before the record window ends at 20:00 UTC on 2026-10-13.");
    // An afternoon-style run (T = D): D − 1's stand-in at 23:00 reaches past the record window's end (20:00).
    const d1 = hourlyZip("2026-10-13", "cve_2026-10-13_2300Z")!;
    const eod12 = { ...endOfDayAsset("2026-10-12"), kind: "end_of_day" as const, utc_day: "2026-10-12" };
    expect(zipsReach([eod12, d1, hourlyZip("2026-10-14", "cve_2026-10-14_0000Z")!])).toBe("2026-10-13T23:00:00Z");
    expect(zipsShortNote(zipsReach([eod12, d1]), rw)).toBeNull();
  });

  it("plans no missed day after more than 25, when the metrics count none (a backfill --catch-up fills them)", () => {
    const far = zipPlan({ date: DATE, recordWindow: rw, runUtcDay: "2026-10-13", hourlyTag: FEED_WORLD.hourlyTag, knownDays: history("2026-01-01", "2026-09-16") });
    expect(far.missing).toEqual([]);
    expect(far.days).toEqual([]);
    expect(assets(far)).toEqual(["2026-10-12_delta_CVEs_at_end_of_day.zip", "2026-10-13_delta_CVEs_at_2000Z.zip"]);
    const edge = zipPlan({ date: DATE, recordWindow: rw, runUtcDay: "2026-10-13", hourlyTag: FEED_WORLD.hourlyTag, knownDays: history("2026-01-01", "2026-09-17") });
    expect(edge.missing.length).toBe(25);
    expect(edge.missing[0]).toBe("2026-09-18");
  });
});

// ── Items ────────────────────────────────────────────────────────────────────────────────────────

const window = packWindow(DATE, cfg.run.pack);
const itemCtx: ItemContext = {
  window, lookbackHours: cfg.run.pack.lookback_hours, keywords: cfg.sources.keywords,
  publishers: { sourceTiers: cfg.sourceTiers, vendors: cfg.vendors }, regions: regionsConfig(cfg),
};
const raw = (title: string, url: string, at = "2026-10-13T10:00:00Z", snippet = ""): RawItem => ({ title, url, published_at: at, snippet });
/** Referenced CVE records that alone nearly fill the 150 KB Markdown cap. */
const REF_RECORDS = 125;

/** buildPack()'s audit (row 146): exactly the items and records the pack lost, as the input held them, in id order, and schema-valid. */
function expectAudit(built: ReturnType<typeof buildPack>, items: readonly PackItem[], records: readonly PackRecord[]): void {
  const leftIds = new Set([...built.pack.items.map((i) => i.id), ...built.pack.records.map((r) => r.id)]);
  expect(PackSizeCut.parse(built.sizeCut)).toEqual(built.sizeCut);
  expect(built.sizeCut.items).toEqual(items.filter((i) => !leftIds.has(i.id)).sort((a, b) => (a.id < b.id ? -1 : 1)).map((i) => ({ id: i.id, feed_id: i.feed_id, score: i.score, title: i.title })));
  expect(built.sizeCut.records).toEqual(records.filter((r) => !leftIds.has(r.id)).sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => ({ id: r.id, source: r.source, record_id: r.record_id })));
}

describe("scores and keywords", () => {
  it("packScore is 10 × (4 − priority) + 3 × keyword hits (at most 5) + recency 0 to 5 + 4 for tier 1", () => {
    const end = { title: "x", snippet: "", published_at: "2026-10-13T20:29:59Z" };
    expect(packScore(end, 1, 3, [], window, 12)).toBe(35);
    expect(packScore(end, 1, 1, [], window, 12)).toBe(39);
    expect(packScore({ ...end, published_at: "2026-10-12T08:30:00Z" }, 3, 2, [], window, 12)).toBe(10);
    const kw = ["ransomware", "zero-day", "漏洞", "脆弱性", "攻撃", "breach"];
    expect(packScore({ ...end, title: "ransomware zero-day 漏洞 脆弱性 攻撃 breach" }, 2, 2, kw, window, 12)).toBe(20 + 15 + 5);
    // Half way through the 36-hour span: recency 2.5.
    expect(packScore({ ...end, published_at: "2026-10-13T02:30:00Z" }, 2, 2, [], window, 12)).toBe(22.5);
  });

  it("keywordHits counts case-insensitive substrings in English, Chinese and Japanese", () => {
    expect(keywordHits("SAMPLE Ransomware hits a Zero-Day", ["ransomware", "zero-day", "breach"])).toBe(2);
    expect(keywordHits("SAMPLE 駭客利用漏洞發動勒索軟體攻擊", ["漏洞", "勒索", "ransomware"])).toBe(2);
    expect(keywordHits("SAMPLE 不正アクセスで情報漏えい", ["不正アクセス", "情報漏えい", "脆弱性"])).toBe(2);
    expect(keywordHits("SAMPLE weather", cfg.sources.keywords)).toBe(0);
  });

  it("cveIdsIn finds ids in any case, once each, in first-seen order", () => {
    expect(cveIdsIn("cve-2026-104935 and CVE-2026-96951, then CVE-2026-104935 again; CVE-26-1 is not one")).toEqual(["CVE-2026-104935", "CVE-2026-96951"]);
  });

  it("an agency's alert URL marks the item; a newsroom quoting the same URL does not", () => {
    const alertUrl = "https://www.cert.ssi.gouv.fr/alerte/CERTFR-2026-ALE-012/";
    const agency = toItemDrafts(feedById("cert-fr"), [raw("SAMPLE alerte de sécurité", alertUrl)], itemCtx).drafts;
    expect(agency[0]!.alert).toBe(true);
    const news = toItemDrafts(feedById("therecord"), [raw("SAMPLE France warns of attacks", "https://therecord.media/ct-sample/france-alert", "2026-10-13T10:00:00Z", `See ${alertUrl}`)], itemCtx).drafts;
    expect(news[0]!.alert).toBe(false);
    const bulletin = toItemDrafts(feedById("cert-fr"), [raw("SAMPLE bulletin", "https://www.cert.ssi.gouv.fr/actualite/CERTFR-2026-ACT-040/")], itemCtx).drafts;
    expect(bulletin[0]!.alert).toBe(false);
  });

  it("items take their publisher and tier from the link, not the feed", () => {
    const d = toItemDrafts(feedById("thehackernews"), [raw("SAMPLE a vendor advisory", "https://www.cisa.gov/ct-sample/advisory")], itemCtx).drafts;
    expect(d[0]!.outlet).toBe(feedById("thehackernews").name);
    expect(d[0]!.publisher).not.toBe(feedById("thehackernews").name);
  });
});

// ── Records the caps keep whole (review of row 146) ───────────────────────────────────────────────

/** A TVN note in the fixture window, as notePackRecords() drafts it. */
function tvnNote(id: string, title: string, text: string): ReturnType<typeof notePackRecords>[number] {
  return notePackRecords("twcert-tvn", [{ id, title, url: `https://www.twcert.org.tw/tw/cp-132-${id.slice(-5)}-1.html`, text, published_at: "2026-10-13T09:00:00+08:00", cve_ids: [], alert: false }], window)[0]!;
}

/** The levelled regions' level and rule, from the signals the written pack gives (as both editions read them). */
function levels(pack: Pick<Pack, "items" | "records">): Record<string, [string, string | null]> {
  const rc = regionsConfig(cfg);
  const r = previewRegions({ date: DATE, history: [], signals: collectSignals(pack, null, { entries: [] }, rc, DATE), kevIndex: { entries: [] }, config: rc });
  return Object.fromEntries(r.rows.map((x) => [x.code, [x.level, x.rule_id]]));
}

/**
 * collect's steps 7 to 11 (scripts/collect.ts), pure, on a morning of 5 new KEV ids with no record, `tw` Arcadyan (TW) records,
 * 90 news items and the extra record drafts: `on` with the pinned records as collect passes them (pinnedRecordIds() of the
 * provisional records for capRecords(), of the final ones for buildPack()), `off` with none, as row 146 left them.
 */
function pinMorning(o: { tw: number; notes: ReturnType<typeof notePackRecords>; items?: number; kev?: number }) {
  const at = (n: number) => `2026-10-13T${String(10 + Math.floor(n / 60) % 9).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00Z`;
  const records: CveRecord[] = Array.from({ length: o.tw }, (_, i) => ({
    cve_id: `CVE-2026-${900000 + i}`, state: "PUBLISHED", date_published: "2026-10-13", assigner: "example", scored: false, credits: [],
    affected: [{ vendor: "Arcadyan", product: "SAMPLE Router" }], published_at: at(i), updated_at: at(i), date_updated: "2026-10-13",
    title: `SAMPLE router flaw ${i}`, description: `SAMPLE ${"router ".repeat(130)}`, cvss: null, cna_severity: null, ssvc: null,
    kev_marker: null, references: [], exploit_reference: false,
  }));
  const newKevIds = Array.from({ length: o.kev ?? 5 }, (_, i) => `CVE-2026-${700000 + i}`);
  const catalog = {
    catalogVersion: "2026.10.13", dateReleased: "2026-10-13T17:02:11Z", count: newKevIds.length,
    vulnerabilities: newKevIds.map((id): KevEntry => ({
      cveID: id, vendorProject: "Example Corp", product: "Example Server", vulnerabilityName: `SAMPLE KEV ${id}`, dateAdded: "2026-10-13",
      shortDescription: o.kev ? `SAMPLE ${"kev ".repeat(200)}` : "SAMPLE.", requiredAction: "Apply updates.", dueDate: "2026-11-03", knownRansomwareCampaignUse: "Unknown", forensicTriage: null, notes: "", cwes: [],
    })),
  };
  const draft0 = toItemDrafts(feedById("therecord"), [raw("SAMPLE base item", "https://therecord.media/ct-sample/base")], itemCtx).drafts[0]!;
  const coverages: ItemDraft["coverage"][] = [["exploits"], ["breaches"], ["ai"], ["policy"], ["taiwan"], ["japan"]];
  const feedsFor = ["therecord", "securityweek", "bleepingcomputer", "thehackernews", "techcrunch-security", "msft-security", "unit42", "volexity", "project-zero", "openai-news"];
  const items = toPackItems(capItems(Array.from({ length: o.items ?? 90 }, (_, i) => ({
    ...draft0, feed_id: feedsFor[i % 10]!, key: `k${i}`, url: `https://therecord.media/ct-sample/pin-${i}`, title: `SAMPLE story ${i} on a breach ${"t".repeat(150)}`,
    snippet: `SAMPLE ${"s".repeat(280)}`, coverage: [...coverages[i % 6]!], score: 30 + (i % 19) + (i % 7) / 10,
  }))).kept);
  const rc = regionsConfig(cfg);
  const rankBase: Omit<RankInput, "pack"> = {
    date: DATE, window, recordWindow: recordWindow(window), catalog, newKevIds, records, epss: { e: null, e1: null, e7: null }, ghsa: [],
    earlierReleaseIds: [], config: { loaded: cfg, compiled: cfg.compiled, watchWindows: [] }, kevSource: "kev-index", aiMatch,
  };
  const keep = recordKeepIds(rankBase);
  const provisional = provisionalRecords([
    ...kevPackRecords(catalog.vulnerabilities, new Set(newKevIds), cfg.sourceTiers),
    ...cvePackRecords(records, (r) => keep.has(r.cve_id), cfg.sourceTiers),
    ...o.notes,
  ]);
  const ranked = rankCandidates({ ...rankBase, pack: { items, records: provisional } });
  const referenced = new Set(ranked.kept.flatMap((c) => [c.id, ...c.pack_ids]).filter((id) => /^r\d{4,}$/.test(id)));
  const steps = (pin: boolean) => {
    const capR = capRecords(provisional, referenced, RECORDS_MAX, pin ? pinnedRecordIds(provisional, rc, DATE) : new Set());
    const kept = remapIds(ranked.kept, ranked.cut, ranked.log, capR.idMap).kept;
    const referencedFinal = new Set(kept.flatMap((c) => [c.id, ...c.pack_ids]));
    const built = buildPack({ date: DATE, window, generatedAt: GENERATED_AT, cutoff: "2026-10-12", degraded: false, feeds: [], items, records: capR.kept, injectionFlags: 0 }, cfg.sources, {
      referenced: referencedFinal, ...(pin ? { pinned: pinnedRecordIds(capR.kept, rc, DATE) } : {}),
    });
    return { provisional, ranked, referenced, capR, kept, built };
  };
  return { items, on: steps(true), off: steps(false) };
}

describe("items", () => {
  it("the size caps never cut a referenced or KEV record, cut records from the end of capRecords' order before any item, and recount (B7, row 146)", () => {
    const rec = (i: number, source: "kev" | "cvelist" | "myjvn", date: string, flagged = 0) => ({
      key: `${source}:${i}`, source, record_id: source === "myjvn" ? `JVNDB-2026-${String(100000 + i)}` : `CVE-2026-${String(10000 + i)}`,
      url: source === "myjvn" ? `https://jvndb.jvn.jp/ja/contents/2026/JVNDB-2026-${100000 + i}.html` : `https://www.cve.org/CVERecord?id=CVE-2026-${10000 + i}`,
      advisory_urls: [], title: `SAMPLE ${"t".repeat(150)}`, text: `SAMPLE ${"x".repeat(500)}`, date, vendor: null, product: null,
      cve_ids: source === "myjvn" ? [] : [`CVE-2026-${10000 + i}`], facts: {}, flags: flagged ? ["injection_like" as const] : [], flagged,
    });
    // A Patch Tuesday morning: 120 referenced CVE records dated D - 2, and 200 MyJVN notes, half dated D - 1, half D - 3.
    const drafts = [
      ...Array.from({ length: 3 }, (_, i) => rec(i, "kev", "2026-10-13")),
      ...Array.from({ length: 120 }, (_, i) => rec(100 + i, "cvelist", "2026-10-12")),
      ...Array.from({ length: 200 }, (_, i) => rec(1000 + i, "myjvn", i % 2 ? "2026-10-13" : "2026-10-11", i === 0 || i === 1 ? 1 : 0)),
    ];
    const provisional = provisionalRecords(drafts);
    const refProvisional = new Set(provisional.filter((r) => r.source === "cvelist").map((r) => r.id));
    const capped = capRecords(provisional, refProvisional);
    const base = toItemDrafts(feedById("therecord"), [raw("SAMPLE base item", "https://therecord.media/ct-sample/base")], itemCtx).drafts[0]!;
    const items = toPackItems(capItems(Array.from({ length: 60 }, (_, i) => ({
      ...base, feed_id: i % 2 ? "therecord" : "krebs", key: `k${i}`, url: `https://therecord.media/ct-sample/item-${i}`, snippet: "s".repeat(290), score: 50 - i / 10,
    }))).kept);
    // A kept candidate points at every CVE record and at the 20 best items.
    const referenced = new Set([...capped.kept.filter((r) => r.source === "cvelist").map((r) => r.id), ...items.slice(0, 20).map((i) => i.id)]);
    const flaggedOf = new Map(drafts.map((d) => [`${d.source}:${d.record_id}`, d.flagged]));
    const recount = (its: readonly PackItem[], recs: readonly PackRecord[]) => ({
      feeds: ["therecord", "krebs", "myjvn"].map((id) => ({
        id, kind: id === "myjvn" ? "myjvn" : "rss", ok: true, stale: false, newest: null, items_total: 0, sha256: null, error: null,
        items_kept: id === "myjvn" ? recs.filter((r) => r.source === "myjvn").length : its.filter((i) => i.feed_id === id).length,
      })),
      injectionFlags: recs.reduce((n, r) => n + (flaggedOf.get(`${r.source}:${r.record_id}`) ?? 0), 0),
    });
    const built = buildPack({ date: DATE, window, generatedAt: GENERATED_AT, cutoff: "2026-10-12", degraded: false, items, records: capped.kept, ...recount(items, capped.kept) }, cfg.sources, { referenced, recount });
    const left = built.pack.records;
    expect(Buffer.byteLength(built.md)).toBeLessThanOrEqual(PACK_MD_MAX_BYTES);
    expect(built.sizeCut.over).toBe(false);
    expect(built.sizeCut.records.length).toBeGreaterThan(100);
    // Every referenced record and every KEV record stays; only MyJVN notes go, the oldest first.
    expect(left.filter((r) => r.source === "cvelist").length).toBe(120);
    expect(left.filter((r) => r.source === "kev").length).toBe(3);
    const notes = left.filter((r) => r.source === "myjvn");
    expect(notes.length).toBe(200 - built.sizeCut.records.length);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((r) => r.date === "2026-10-13")).toBe(true);
    // The unreferenced records went before any item (row 146): every item, referenced or not, stays.
    expect(built.sizeCut.items.length).toBe(0);
    expect(built.pack.items.map((i) => i.id)).toEqual(items.map((i) => i.id));
    // feeds[] and injection_flags describe what is left: of the two flagged notes, the one dated D - 3 is gone.
    const kept = new Map(built.pack.feeds.map((f) => [f.id, f.items_kept]));
    expect(kept.get("myjvn")).toBe(notes.length);
    expect((kept.get("therecord") ?? 0) + (kept.get("krebs") ?? 0)).toBe(60);
    expect(built.pack.injection_flags).toBe(notes.filter((r) => (flaggedOf.get(`myjvn:${r.record_id}`) ?? 0) > 0).length);
    expect(built.pack.injection_flags).toBe(1);
    expectAudit(built, items, capped.kept);
    expect(built.sizeCut.records.every((r) => r.source === "myjvn")).toBe(true);
  });

  it("the size caps cut unreferenced records, then unreferenced items, then referenced items lowest score first, never a KEV or referenced record (row 146)", () => {
    const rec = (i: number, source: "kev" | "cvelist" | "myjvn") => ({
      key: `${source}:${i}`, source, record_id: source === "myjvn" ? `JVNDB-2026-${String(100000 + i)}` : `CVE-2026-${String(10000 + i)}`,
      url: source === "myjvn" ? `https://jvndb.jvn.jp/ja/contents/2026/JVNDB-2026-${100000 + i}.html` : `https://www.cve.org/CVERecord?id=CVE-2026-${10000 + i}`,
      advisory_urls: [], title: `SAMPLE ${"t".repeat(150)}`, text: `SAMPLE ${"x".repeat(900)}`, date: "2026-10-13", vendor: null, product: null,
      cve_ids: source === "myjvn" ? [] : [`CVE-2026-${10000 + i}`], facts: {}, flags: [], flagged: 0,
    });
    const base = toItemDrafts(feedById("therecord"), [raw("SAMPLE base item", "https://therecord.media/ct-sample/base")], itemCtx).drafts[0]!;
    const items = toPackItems(capItems(Array.from({ length: 40 }, (_, i) => ({
      ...base, key: `k${i}`, url: `https://therecord.media/ct-sample/item-${i}`, snippet: "s".repeat(290), score: 50 - i / 10,
    }))).kept);
    // Every other item is referenced, so unreferenced items score above referenced ones: the group, not the score, comes first.
    const refItems = items.filter((_, i) => i % 2 === 1);
    /** 3 KEV records, `n` referenced CVE records and 40 unreferenced MyJVN notes, with the 40 items. */
    const build = (n: number) => {
      const drafts = [
        ...Array.from({ length: 3 }, (_, i) => rec(i, "kev")),
        ...Array.from({ length: n }, (_, i) => rec(100 + i, "cvelist")),
        ...Array.from({ length: 40 }, (_, i) => rec(1000 + i, "myjvn")),
      ];
      const capped = capRecords(provisionalRecords(drafts), new Set());
      const referenced = new Set([...capped.kept.filter((r) => r.source === "cvelist").map((r) => r.id), ...refItems.map((i) => i.id)]);
      const built = buildPack({ date: DATE, window, generatedAt: GENERATED_AT, cutoff: "2026-10-12", degraded: false, feeds: [], items, records: capped.kept, injectionFlags: 0 }, cfg.sources, { referenced });
      expect(Buffer.byteLength(built.md)).toBeLessThanOrEqual(PACK_MD_MAX_BYTES);
      expect(built.sizeCut.over).toBe(false);
      expect(built.pack.records.filter((r) => r.source === "kev")).toHaveLength(3);
      expect(built.pack.records.filter((r) => r.source === "cvelist")).toHaveLength(n);
      expectAudit(built, items, capped.kept);
      return { built, referenced };
    };
    // 80 referenced records: some of the notes make room, and every item stays.
    const light = build(80);
    expect(light.built.sizeCut.records.length).toBeGreaterThan(0);
    expect(light.built.sizeCut.records.length).toBeLessThan(40);
    expect(light.built.sizeCut.items.length).toBe(0);
    // 125: every note goes, then every unreferenced item, then the lowest-scored referenced items, so what is left is the best of them.
    const { built, referenced } = build(REF_RECORDS);
    expect(built.pack.records.filter((r) => r.source === "myjvn")).toHaveLength(0);
    const leftItems = built.pack.items.map((i) => i.id);
    expect(leftItems.every((id) => referenced.has(id))).toBe(true);
    expect(leftItems.length).toBeGreaterThan(0);
    expect(leftItems.length).toBeLessThan(refItems.length);
    expect(leftItems).toEqual(refItems.slice(0, leftItems.length).map((i) => i.id));
    expect(built.sizeCut.items.length).toBe(items.length - leftItems.length);
    expect(built.sizeCut.records.length).toBe(40);
    expect(built.sizeCut.items.every((i) => i.feed_id === "therecord" && i.title === "SAMPLE base item")).toBe(true);
  });

  it("a Patch Tuesday morning like Kobol's 2026-11-11 keeps its news under the 150 KB cap, with the release's pack_ids bounded and its counts whole (row 146)", () => {
    // 390 Microsoft fixes (1 newly on KEV, 30 critical, 359 high; about 190 KB of Markdown together, as on Kobol), 9 other new KEV
    // entries with no CVE List record, 250 Arcadyan (TW) records a test keeps but the candidate cap leaves out, and 90 news items.
    // Before row 146 the release referenced all 390 fixes, the 400-record cap kept them over the Arcadyan records, and the size caps
    // cut every news item and stopped over the cap.
    const at = (n: number) => `2026-10-13T${String(10 + Math.floor(n / 60) % 9).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00Z`;
    const cve = (n: number, over: Partial<CveRecord>): CveRecord => ({
      cve_id: `CVE-2026-${600000 + n}`, state: "PUBLISHED", date_published: "2026-10-13", assigner: "microsoft", scored: true, credits: [],
      affected: [{ vendor: "Microsoft", product: "Windows" }], published_at: at(n), updated_at: at(n), date_updated: "2026-10-13",
      title: `SAMPLE Windows flaw ${n}`, description: `SAMPLE ${"windows ".repeat(40)}`, cvss: { score: 7.5, version: "3.1", vector: "CVSS:3.1/AV:N", scorer: "cna" },
      cna_severity: "HIGH", ssvc: null, kev_marker: null, references: [], exploit_reference: false, ...over,
    });
    const exploited = cve(0, { cvss: { score: 8.8, version: "3.1", vector: "CVSS:3.1/AV:N", scorer: "cna" } });
    const critical = Array.from({ length: 30 }, (_, i) => cve(1 + i, { cna_severity: "CRITICAL", cvss: { score: 9 + (i % 10) / 10, version: "3.1", vector: "CVSS:3.1/AV:N", scorer: "cna" } }));
    const high = Array.from({ length: 359 }, (_, i) => cve(31 + i, {}));
    const tw = Array.from({ length: 250 }, (_, i) => cve(1000 + i, {
      assigner: "example", affected: [{ vendor: "Arcadyan", product: "SAMPLE Router" }], cvss: null, cna_severity: null, title: `SAMPLE router flaw ${i}`,
      description: `SAMPLE ${"router ".repeat(130)}`,
    }));
    const records = [exploited, ...critical, ...high, ...tw];
    const kev = (id: string): KevEntry => ({
      cveID: id, vendorProject: "Example Corp", product: "Example Server", vulnerabilityName: `SAMPLE KEV ${id}`, dateAdded: "2026-10-13",
      shortDescription: "SAMPLE.", requiredAction: "Apply updates.", dueDate: "2026-11-03", knownRansomwareCampaignUse: "Unknown", forensicTriage: null, notes: "", cwes: [],
    });
    const newKevIds = [exploited.cve_id, ...Array.from({ length: 9 }, (_, i) => `CVE-2026-${700000 + i}`)];
    const catalog = { catalogVersion: "2026.10.13", dateReleased: "2026-10-13T17:02:11Z", count: 10, vulnerabilities: newKevIds.map(kev) };
    const feedsFor = ["therecord", "securityweek", "krebs", "thehackernews", "techcrunch-security"];
    const coverages: ItemDraft["coverage"][] = [["exploits"], ["breaches"], ["ai"], ["policy"]];
    const draft0 = toItemDrafts(feedById("therecord"), [raw("SAMPLE base item", "https://therecord.media/ct-sample/base")], itemCtx).drafts[0]!;
    const items = toPackItems(capItems(Array.from({ length: 90 }, (_, i) => ({
      ...draft0, feed_id: feedsFor[i % 5]!, key: `k${i}`, url: `https://therecord.media/ct-sample/pt-${i}`, title: `SAMPLE story ${i} on a breach`,
      snippet: `SAMPLE ${"s".repeat(280)}`, coverage: [...coverages[i % 4]!], score: 30 + (i % 19),
    }))).kept);
    expect(items).toHaveLength(90);

    // collect's steps 7 to 11 (scripts/collect.ts), pure.
    const rankBase: Omit<RankInput, "pack"> = {
      date: DATE, window, recordWindow: recordWindow(window), catalog, newKevIds, records, epss: { e: null, e1: null, e7: null }, ghsa: [],
      earlierReleaseIds: [], config: { loaded: cfg, compiled: cfg.compiled, watchWindows: [] }, kevSource: "kev-index", aiMatch,
    };
    const keep = recordKeepIds(rankBase);
    const provisional = provisionalRecords([
      ...kevPackRecords(catalog.vulnerabilities, new Set(newKevIds), cfg.sourceTiers),
      ...cvePackRecords(records, (r) => keep.has(r.cve_id), cfg.sourceTiers),
    ]);
    const ranked = rankCandidates({ ...rankBase, pack: { items, records: provisional } });
    const capR = capRecords(provisional, new Set(ranked.kept.flatMap((c) => [c.id, ...c.pack_ids]).filter((id) => /^r\d{4,}$/.test(id))));
    expect(capR.cut).toBe(0);
    const kept = remapIds(ranked.kept, ranked.cut, ranked.log, capR.idMap).kept;
    const referenced = new Set(kept.flatMap((c) => [c.id, ...c.pack_ids]));
    const built = buildPack({ date: DATE, window, generatedAt: GENERATED_AT, cutoff: "2026-10-12", degraded: false, feeds: [], items, records: capR.kept, injectionFlags: 0 }, cfg.sources, { referenced });

    // The release: its counts cover all 390 fixes; its pack_ids name at most 20 records, every one still in the pack.
    const pt = kept.find((c) => c.kind === "patch_batch")!;
    expect(pt.release).toEqual({ release_id: "rel-microsoft-2026-10", vendor: "Microsoft", total: 390, critical: 30, exploited: 1, exploited_cve_ids: [exploited.cve_id] });
    expect(pt.pack_ids).toHaveLength(RELEASE_PACK_IDS_MAX);
    const inPack = new Set([...built.pack.items.map((i) => i.id), ...built.pack.records.map((r) => r.id)]);
    for (const id of pt.pack_ids) expect(inPack.has(id)).toBe(true);
    // The 359 high fixes no test keeps never reach the pack.
    const recordIds = new Set(capR.kept.map((r) => r.record_id));
    for (const r of high) expect(recordIds.has(r.cve_id)).toBe(false);

    // Under the cap, with every news item kept: only unreferenced records went, never a KEV or referenced one.
    expect(Buffer.byteLength(built.md)).toBeLessThanOrEqual(PACK_MD_MAX_BYTES);
    expect(built.sizeCut.over).toBe(false);
    expect(built.sizeCut.items).toEqual([]);
    expect(built.pack.items).toHaveLength(90);
    expect(built.sizeCut.records.length).toBeGreaterThan(100);
    for (const r of built.sizeCut.records) {
      expect(r.source).toBe("cvelist");
      expect(referenced.has(r.id)).toBe(false);
    }
    expect(built.pack.records.filter((r) => r.source === "kev")).toHaveLength(10);
    for (const id of referenced) if (/^[pr]\d{4,}$/.test(id)) expect(inPack.has(id), id).toBe(true);
    expectAudit(built, items, capR.kept);
  });

  it("a TVN note reporting exploitation that ranks below the candidate cap survives a mildly over-cap morning, and Taiwan keeps its level (review of row 146)", () => {
    // The review's case: 5 new KEV ids, 120 Arcadyan (TW) records, 90 news items and one TVN note saying a flaw is exploited. The
    // note scores 30 (CERT note), below the 40-candidate cap, so no kept candidate references it; under row 146's order alone the
    // size caps cut it first, its signal left the pack and Taiwan fell to baseline in both editions.
    const m = pinMorning({ tw: 120, notes: [tvnNote("TVN-202610001", "SAMPLE 路由器漏洞已遭利用", "SAMPLE 此漏洞已遭利用，請儘速更新。")] });
    const note = m.on.provisional.find((r) => r.source === "twcert-tvn")!;
    expect(m.on.ranked.kept.some((c) => c.id === note.id || c.pack_ids.includes(note.id))).toBe(false);
    expect(m.on.ranked.cut.find((c) => c.id === note.id)).toMatchObject({ score: 30, reason: "below_cap" });
    // The size caps ran (records were cut) and kept the note and every item; Taiwan stays elevated on the note's signal.
    expect(m.on.built.sizeCut.records.length).toBeGreaterThan(0);
    expect(m.on.built.sizeCut.over).toBe(false);
    expect(Buffer.byteLength(m.on.built.md)).toBeLessThanOrEqual(PACK_MD_MAX_BYTES);
    expect(m.on.built.pack.records.filter((r) => r.source === "twcert-tvn").map((r) => r.record_id)).toEqual(["TVN-202610001"]);
    expect(m.on.built.pack.items).toHaveLength(90);
    expect(levels(m.on.built.pack)).toMatchObject({ TW: ["elevated", "home-cert-exploitation"] });
    // Without the pin (row 146 alone) the note was the first record cut, and Taiwan fell to baseline.
    expect(m.off.built.sizeCut.records.map((r) => r.source)).toContain("twcert-tvn");
    expect(levels(m.off.built.pack)).toMatchObject({ TW: ["baseline", null] });
    expectAudit(m.on.built, m.items, m.on.capR.kept);
  });

  it("the size caps never cut an exchange filing or the dashboard record, which no candidate can reference (review of row 146)", () => {
    // The review's case: 330 Arcadyan records and 90 items over the 150 KB cap, with two exchange filings and a dashboard revision.
    // No candidate is built from these records, so none references them, and under row 146's order alone they were the first cut.
    const notes = [
      ...exchangePackRecords([
        { company_code: "2330", company: "SAMPLE Co", subject: "SAMPLE 資安事件 notice", text: "SAMPLE 本公司遭受網路攻擊", spoken_at: "2026-10-13T15:30:00+08:00", url: "https://openapi.twse.com.tw/v1/opendata/t187ap04_L" },
        { company_code: "3008", company: "SAMPLE Two", subject: "SAMPLE 勒索 notice", text: "SAMPLE 駭客", spoken_at: "2026-10-13T17:10:00+08:00", url: "https://openapi.twse.com.tw/v1/opendata/t187ap04_L" },
      ], window),
      cvdPackRecord({ revision: "42", as_of: "2026-10-10T00:00:00Z", found_n: 500, disclosed_n: 300, patched_n: 200, ledger_ids: [] }, "41", "https://red.anthropic.com/2026/cvd/")!,
    ];
    const m = pinMorning({ tw: 330, notes });
    const kinds = (recs: readonly { source: string }[]) => recs.filter((r) => r.source === "exchange-tw" || r.source === "anthropic-cvd").map((r) => r.source).sort();
    for (const r of m.on.provisional.filter((x) => x.source === "exchange-tw" || x.source === "anthropic-cvd")) {
      expect(m.on.ranked.kept.some((c) => c.id === r.id || c.pack_ids.includes(r.id)), r.record_id).toBe(false);
    }
    expect(m.on.capR.cut).toBe(0);
    expect(m.on.built.sizeCut.records.length).toBeGreaterThan(0);
    expect(m.on.built.sizeCut.over).toBe(false);
    expect(kinds(m.on.built.pack.records)).toEqual(["anthropic-cvd", "exchange-tw", "exchange-tw"]);
    expect(kinds(m.on.built.sizeCut.records)).toEqual([]);
    expect(m.on.built.pack.items).toHaveLength(90);
    expect(m.on.built.md).toContain("Anthropic disclosure dashboard, revision 42");
    // Under row 146 alone the dashboard and the two filings were the first records cut.
    expect(kinds(m.off.built.sizeCut.records)).toEqual(["anthropic-cvd", "exchange-tw", "exchange-tw"]);
    expectAudit(m.on.built, m.items, m.on.capR.kept);
    // A heavier morning (40 long new KEV entries and 200 items): every record the caps may cut goes and then news, but never a pinned record, nor the
    // TVN note whose signal keeps Taiwan elevated.
    const heavy = pinMorning({ tw: 330, items: 200, kev: 40, notes: [...notes, tvnNote("TVN-202610003", "SAMPLE 漏洞遭利用", "SAMPLE 此漏洞已遭利用。")] });
    expect(heavy.on.built.sizeCut.items.length).toBeGreaterThan(0);
    expect(heavy.on.built.sizeCut.over).toBe(false);
    expect(Buffer.byteLength(heavy.on.built.md)).toBeLessThanOrEqual(PACK_MD_MAX_BYTES);
    expect(heavy.on.built.pack.records.filter((r) => r.source !== "kev" && r.source !== "cvelist").map((r) => r.source).sort()).toEqual(["anthropic-cvd", "exchange-tw", "exchange-tw", "twcert-tvn"]);
    expect(levels(heavy.on.built.pack)).toMatchObject({ TW: ["elevated", "home-cert-exploitation"] });
    expectAudit(heavy.on.built, heavy.items, heavy.on.capR.kept);
  });

  it("over the 400-record cap the region-signal, exchange and dashboard records are kept right after KEV, and the size caps cut none of them (review of row 146)", () => {
    // 450 Arcadyan records and, all dated the same day, a TVN note and a non-alert JPCERT note that report exploitation, two exchange
    // filings and a dashboard revision, none of which a kept candidate references. By date, then source, they sort after the
    // CVE records, so under row 146 alone the 400-record cap cut every one of them.
    const notes = [
      tvnNote("TVN-202610002", "SAMPLE 漏洞已被利用", "SAMPLE 已被利用"),
      ...notePackRecords("jpcert", [{
        id: "wr264199", title: "SAMPLE 製品の脆弱性", url: "https://www.jpcert.or.jp/wr/2026/wr264199.html", text: "SAMPLE 本脆弱性を悪用する攻撃が確認されています。",
        published_at: "2026-10-13T10:00:00+09:00", cve_ids: [], alert: false,
      }], window),
      ...exchangePackRecords([
        { company_code: "2330", company: "SAMPLE Co", subject: "SAMPLE 資安事件 notice", text: "SAMPLE 本公司遭受網路攻擊", spoken_at: "2026-10-13T15:30:00+08:00", url: "https://openapi.twse.com.tw/v1/opendata/t187ap04_L" },
        { company_code: "3008", company: "SAMPLE Two", subject: "SAMPLE 勒索 notice", text: "SAMPLE 駭客", spoken_at: "2026-10-13T17:10:00+08:00", url: "https://openapi.twse.com.tw/v1/opendata/t187ap04_L" },
      ], window),
      cvdPackRecord({ revision: "42", as_of: "2026-10-13T00:00:00Z", found_n: 500, disclosed_n: 300, patched_n: 200, ledger_ids: [] }, "41", "https://red.anthropic.com/2026/cvd/")!,
    ];
    expect(notes.map((r) => r.source)).toEqual(["twcert-tvn", "jpcert", "exchange-tw", "exchange-tw", "anthropic-cvd"]);
    const m = pinMorning({ tw: 450, notes });
    const pinnedSources = ["anthropic-cvd", "exchange-tw", "exchange-tw", "jpcert", "twcert-tvn"];
    const ofPinned = (recs: readonly PackRecord[]) => recs.filter((r) => r.source !== "kev" && r.source !== "cvelist").map((r) => r.source).sort();
    expect(m.on.capR.cut).toBeGreaterThan(0);
    expect(ofPinned(m.on.capR.kept)).toEqual(pinnedSources);
    expect(ofPinned(m.on.built.pack.records)).toEqual(pinnedSources);
    expect(m.on.built.sizeCut.records.every((r) => r.source === "cvelist")).toBe(true);
    expect(levels(m.on.built.pack)).toMatchObject({ TW: ["elevated", "home-cert-exploitation"], JP: ["elevated", "home-cert-exploitation"] });
    // Under row 146 alone the 400-record cap cut all five, and Taiwan and Japan fell to baseline.
    expect(ofPinned(m.off.capR.kept)).toEqual([]);
    expect(levels(m.off.built.pack)).toMatchObject({ TW: ["baseline", null], JP: ["baseline", null] });
    // recordKeepOrder(): KEV, then the pinned records, then the referenced ones, then the rest.
    const pinned = pinnedRecordIds(m.on.provisional, regionsConfig(cfg), DATE);
    expect(pinned.size).toBe(5);
    const tierOf = (r: PackRecord) => (r.source === "kev" ? 0 : pinned.has(r.id) ? 1 : m.on.referenced.has(r.id) ? 2 : 3);
    const order = [...m.on.provisional].sort(recordKeepOrder(m.on.referenced, pinned)).map(tierOf);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.slice(0, 10)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
    // A referenced record that is not KEV comes after every pinned one, though by date and source it sorts before them all:
    // the latest Arcadyan CVE record, referenced here.
    const cve = [...m.on.provisional].filter((r) => r.source === "cvelist").sort(recordKeepOrder(new Set()))[0]!;
    const referenced = new Set([...m.on.referenced, cve.id]);
    const tier2 = (r: PackRecord) => (r.source === "kev" ? 0 : pinned.has(r.id) ? 1 : referenced.has(r.id) ? 2 : 3);
    const sorted = [...m.on.provisional].sort(recordKeepOrder(referenced, pinned));
    const at = (id: string) => sorted.findIndex((r) => r.id === id);
    for (const id of pinned) expect(at(id), id).toBeLessThan(at(cve.id));
    expect(sorted.slice(0, 11).map(tier2)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2]);
    const byDate = [...m.on.provisional].sort(recordKeepOrder(new Set()));
    for (const id of pinned) expect(byDate.findIndex((r) => r.id === id), id).toBeGreaterThan(byDate.findIndex((r) => r.id === cve.id));
  });

  it("drafts keep the window, drop unusable links and must_match misses, and wrap nothing yet", () => {
    const d = toItemDrafts(feedById("nhk"), [
      raw("SAMPLE ransomware attack on a hospital", "https://www3.nhk.or.jp/ct-sample/a"),
      raw("SAMPLE weather report", "https://www3.nhk.or.jp/ct-sample/b"),
      raw("SAMPLE ransomware notice", "ftp://www3.nhk.or.jp/ct-sample/c"),
      raw("SAMPLE ransomware, long ago", "https://www3.nhk.or.jp/ct-sample/d", "2026-10-01T00:00:00Z"),
    ], itemCtx);
    expect(d.drafts.map((x) => x.url)).toEqual(["https://www3.nhk.or.jp/ct-sample/a"]);
    expect(d.missedKeywords).toBe(1);
    // The ftp link is not a safe https link (B6): dropped and counted as a flag, not as a mere bad URL.
    expect(d.unsafeLinks).toBe(1);
    expect(d.badUrl).toBe(0);
    expect(d.outOfWindow).toBe(1);
    expect(d.drafts[0]!.title).not.toContain("<untrusted");
  });

  it("dedupe drops a repeated URL and a near-identical title, keeping the higher-priority feed's copy", () => {
    const a = toItemDrafts(feedById("therecord"), [raw("SAMPLE Ivanti Connect Secure flaw exploited in attacks", "https://www.example.com/ct-sample/one")], itemCtx).drafts;
    const b = toItemDrafts(feedById("krebs"), [
      raw("SAMPLE Ivanti Connect Secure flaw exploited in attacks", "https://www.example.com/ct-sample/one?utm_source=x"),
      raw("SAMPLE: Ivanti Connect Secure flaw exploited in attacks", "https://www.example.com/ct-sample/two"),
      raw("SAMPLE an unrelated story about a data breach", "https://www.example.com/ct-sample/three"),
    ], itemCtx).drafts;
    const r = dedupe([...b, ...a]);
    expect(r.dropped).toBe(2);
    expect(r.kept.map((x) => `${x.feed_id} ${x.url}`).sort()).toEqual([
      "krebs https://example.com/ct-sample/three", "therecord https://example.com/ct-sample/one",
    ]);
  });

  it("caps at 30 items per feed (the flood fixture has 40)", async () => {
    const flood = await parseRss(fs.readFileSync(path.join(FEEDS, "rss", "flood.xml")));
    const d = toItemDrafts(feedById("bleepingcomputer"), flood.entries, itemCtx).drafts;
    expect(d.length).toBe(40);
    const c = capItems(d);
    expect(c.kept.length).toBe(30);
    expect(c.cutByFeed).toEqual({ bleepingcomputer: 10 });
    expect(toPackItems(c.kept).map((i) => i.id).slice(0, 2)).toEqual(["p0001", "p0002"]);
  });

  it("an item that gives a region signal is never cut by the item caps: a CERT-FR alert on a morning of 34 higher-scored notices (review of row 146)", () => {
    // The review's s13 case: 34 CERT-FR notices whose titles carry keywords, and one ALE alert, the lowest score of the 35.
    const rc = regionsConfig(cfg);
    const ALERT = "https://www.cert.ssi.gouv.fr/alerte/CERTFR-2026-ALE-011/";
    const raws = Array.from({ length: 34 }, (_, i) =>
      raw(`SAMPLE Multiples vulnérabilités dans le produit ${i} exploit ransomware`, `https://www.cert.ssi.gouv.fr/avis/CERTFR-2026-AVI-${1000 + i}/`, `2026-10-13T${String(8 + (i % 12)).padStart(2, "0")}:00:00Z`, "SAMPLE vulnerability exploit"));
    raws.push(raw("SAMPLE Alerte de sécurité", ALERT, "2026-10-13T07:00:00Z", "SAMPLE"));
    const drafts = toItemDrafts(feedById("cert-fr"), raws, itemCtx).drafts;
    expect(drafts.length).toBe(35);
    const alert = drafts.find((d) => d.url === normalizeUrl(ALERT))!;
    expect(alert.alert).toBe(true);
    expect(Math.min(...drafts.map((d) => d.score))).toBe(alert.score);
    expect(drafts.filter((d) => itemGivesRegionSignal(d, rc, DATE)).map((d) => d.url)).toEqual([alert.url]);
    const euLevel = (kept: readonly ItemDraft[]) => levels({ items: toPackItems(kept), records: [] }).EU;
    // Without the predicate, the 30-per-feed cap cuts the alert by score, and Europe loses its agency-alert level.
    const plain = capItems(drafts);
    expect(plain.kept.some((d) => d.url === alert.url)).toBe(false);
    expect(euLevel(plain.kept)![1]).toBeNull();
    // As collect passes it: the alert is kept first and counts toward CERT-FR's 30; the five lowest notices go.
    const held = (d: ItemDraft) => itemGivesRegionSignal(d, rc, DATE);
    const c = capItems(drafts, ITEM_CAPS, held);
    expect(c.kept.length).toBe(30);
    expect(c.kept.some((d) => d.url === alert.url)).toBe(true);
    expect(c.cutByFeed).toEqual({ "cert-fr": 5 });
    const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
    const notices = drafts.filter((d) => d !== alert).sort((a, b) => b.score - a.score || cmp(b.published_at, a.published_at) || cmp(a.url, b.url));
    expect(c.kept.filter((d) => d !== alert).map((d) => d.url).sort()).toEqual(notices.slice(0, 29).map((d) => d.url).sort());
    expect(euLevel(c.kept)![1]).toBe("agency-alert");
    expect(collectSignals({ items: toPackItems(c.kept), records: [] }, null, null, rc, DATE).map((s) => [s.type, s.region, s.url])).toEqual([["agency_alert", "EU", alert.url]]);
    // Nor by the 60 per coverage section or the 200 in all: 300 higher-scored stories in CERT-FR's sections from 20 feeds.
    const many = Array.from({ length: 300 }, (_, i) => ({ ...drafts[0]!, feed_id: `feed-${i % 20}`, key: `k${i}`, url: `https://therecord.media/ct-sample/held-${i}`, coverage: [i % 2 ? "exploits" : "policy"] as ItemDraft["coverage"], score: 90 - i / 10 }));
    const full = capItems([...many, alert], ITEM_CAPS, held);
    // 60 per section, and the alert on top of them: it counts toward its feed's 30 and the 200, not a section's 60.
    expect(full.kept.length).toBe(121);
    expect(full.kept.some((d) => d.url === alert.url)).toBe(true);
    expect(capItems([...many, alert]).kept.some((d) => d.url === alert.url)).toBe(false);
    const spread = (["exploits", "breaches", "ai", "policy", "taiwan", "japan"] as const);
    const wide = Array.from({ length: 400 }, (_, i) => ({ ...many[0]!, feed_id: `feed-${i % 20}`, key: `w${i}`, url: `https://therecord.media/ct-sample/wide-${i}`, coverage: [spread[i % 6]!] as ItemDraft["coverage"], score: 90 - i / 10 }));
    const capped = capItems([...wide, alert], ITEM_CAPS, held);
    expect(capped.kept.length).toBe(200);
    expect(capped.kept.some((d) => d.url === alert.url)).toBe(true);
    // The alert took one of the 200 places: the lowest-scored story that would otherwise have stayed went instead.
    expect(capItems(wide, ITEM_CAPS, held).kept.filter((d) => !capped.kept.includes(d)).length).toBe(1);
  });

  it("caps at 60 per coverage section and 200 in all; at 400 records KEV is never cut; the size caps cut unreferenced records first (row 146)", () => {
    const base = toItemDrafts(feedById("therecord"), [raw("SAMPLE base item", "https://therecord.media/ct-sample/base")], itemCtx).drafts[0]!;
    const many = (n: number, coverage: (i: number) => ItemDraft["coverage"]) => Array.from({ length: n }, (_, i) => ({
      ...base, feed_id: `feed-${i % 20}`, key: `k${i}`, url: `https://therecord.media/ct-sample/item-${i}`, coverage: coverage(i), score: 50 - i / 10,
    }));
    expect(capItems(many(100, () => ["exploits"])).kept.length).toBe(60);
    const spread = capItems(many(400, (i) => [(["exploits", "breaches", "ai", "policy", "taiwan", "japan"] as const)[i % 6]!]));
    expect(spread.kept.length).toBe(200);
    expect(Object.values(spread.cutByFeed).reduce((a, b) => a + b, 0)).toBe(200);

    const rec = (i: number, source: "kev" | "epss") => ({
      key: `${source}:${i}`, source, record_id: `CVE-2026-${String(10000 + i)}`, url: `https://www.cve.org/CVERecord?id=CVE-2026-${10000 + i}`, advisory_urls: [],
      title: `SAMPLE ${"t".repeat(190)}`, text: `SAMPLE ${"x".repeat(990)}`, date: "2026-10-13", vendor: null, product: null, cve_ids: [`CVE-2026-${10000 + i}`], facts: {}, flags: [], flagged: 0,
    });
    const drafts = [...Array.from({ length: 60 }, (_, i) => rec(i, "kev")), ...Array.from({ length: 400 }, (_, i) => rec(100 + i, "epss"))];
    const capped = capRecords(provisionalRecords(drafts), new Set());
    expect(capped.kept.length).toBe(400);
    expect(capped.kept.filter((r) => r.source === "kev").length).toBe(60);
    const allKev = capRecords(provisionalRecords(Array.from({ length: 410 }, (_, i) => rec(i, "kev"))), new Set());
    expect(allKev.kept.length).toBe(410);

    const items = toPackItems(capItems(many(200, (i) => [(["exploits", "breaches", "ai", "policy", "taiwan", "japan"] as const)[i % 6]!]).map((d) => ({ ...d, snippet: "s".repeat(290) }))).kept);
    const built = buildPack({ date: DATE, window, generatedAt: GENERATED_AT, cutoff: "2026-10-12", degraded: false, feeds: [], items, records: capped.kept, injectionFlags: 0 }, cfg.sources);
    expect(Buffer.byteLength(built.md)).toBeLessThanOrEqual(PACK_MD_MAX_BYTES);
    // Every EPSS record went before any item; then the lowest-scored items, until it fit.
    expect(built.sizeCut.records.length).toBe(340);
    expect(built.pack.records.filter((r) => r.source === "kev").length).toBe(60);
    expect(built.sizeCut.items.length).toBeGreaterThan(0);
    expect(built.sizeCut.items.length).toBeLessThan(items.length);
    const byScore = [...items].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    expect(built.pack.items.map((i) => i.id).sort()).toEqual(byScore.slice(0, built.pack.items.length).map((i) => i.id).sort());
    expectAudit(built, items, capped.kept);
  });

  it("the size caps never cut an item that gives a region signal: a CERT-FR alert, the lowest score of 200 long items (review of row 146)", () => {
    const rc = regionsConfig(cfg);
    const ALERT = "https://www.cert.ssi.gouv.fr/alerte/CERTFR-2026-ALE-011/";
    const alertDraft = toItemDrafts(feedById("cert-fr"), [raw("SAMPLE Alerte de sécurité", ALERT, "2026-10-13T07:00:00Z", "s".repeat(290))], itemCtx).drafts[0]!;
    const spread = (["exploits", "breaches", "ai", "policy", "taiwan", "japan"] as const);
    const news = Array.from({ length: 199 }, (_, i) => ({
      ...alertDraft, feed_id: `feed-${i % 20}`, publisher: "therecord", alert: false, key: `k${i}`, url: `https://therecord.media/ct-sample/long-${i}`,
      title: `SAMPLE story ${i} ${"t".repeat(150)}`, coverage: [spread[i % 6]!] as ItemDraft["coverage"], score: 90 - i / 10,
    }));
    const items = toPackItems(capItems([...news, alertDraft], ITEM_CAPS, (d) => itemGivesRegionSignal(d, rc, DATE)).kept);
    expect(items.length).toBe(200);
    const alert = items.find((i) => i.url === normalizeUrl(ALERT))!;
    expect(Math.min(...items.map((i) => i.score))).toBe(alert.score);
    const kev = (i: number) => ({
      key: `kev:${i}`, source: "kev" as const, record_id: `CVE-2026-${10000 + i}`, url: `https://www.cve.org/CVERecord?id=CVE-2026-${10000 + i}`, advisory_urls: [],
      title: `SAMPLE ${"t".repeat(190)}`, text: `SAMPLE ${"x".repeat(990)}`, date: "2026-10-13", vendor: null, product: null, cve_ids: [`CVE-2026-${10000 + i}`], facts: {}, flags: [], flagged: 0,
    });
    const records = capRecords(provisionalRecords(Array.from({ length: 60 }, (_, i) => kev(i))), new Set()).kept;
    const input = { date: DATE, window, generatedAt: GENERATED_AT, cutoff: "2026-10-12", degraded: false, feeds: [], items, records, injectionFlags: 0 };
    const pinned = pinnedItemIds(items, rc, DATE);
    expect([...pinned]).toEqual([alert.id]);
    // As row 146 left it, the alert is the first item the size caps cut, and Europe's level falls.
    const before = buildPack(input, cfg.sources);
    expect(before.sizeCut.items.map((i) => i.id)).toContain(alert.id);
    expect(levels(before.pack).EU![1]).toBeNull();
    // With the pinned ids collect passes, the caps cut other news, never the alert; Europe keeps its level.
    for (const referenced of [new Set<string>(), new Set(items.map((i) => i.id))]) {
      const built = buildPack(input, cfg.sources, { pinned, referenced });
      expect(Buffer.byteLength(built.md)).toBeLessThanOrEqual(PACK_MD_MAX_BYTES);
      expect(built.sizeCut.over).toBe(false);
      expect(built.sizeCut.items.length).toBeGreaterThan(0);
      expect(built.sizeCut.items.map((i) => i.id)).not.toContain(alert.id);
      expect(built.pack.items.map((i) => i.id)).toContain(alert.id);
      expect(levels(built.pack).EU![1]).toBe("agency-alert");
      expectAudit(built, items, records);
    }
  });

  it("a planted instruction is flagged, counted and wrapped in the Markdown", async () => {
    const planted = await parseRss(fs.readFileSync(path.join(ROOT, "fixtures", "injection", "item.xml")));
    const at = Date.parse(planted.entries[0]!.published_at!);
    const w = { start: new Date(at - 3_600_000).toISOString().replace(".000", ""), end: new Date(at + 3_600_000).toISOString().replace(".000", "") };
    const d = toItemDrafts(feedById("therecord"), planted.entries, { ...itemCtx, window: w }).drafts;
    expect(d.length).toBe(1);
    expect(d[0]!.flags).toEqual(["injection_like"]);
    expect(d[0]!.flagged).toBeGreaterThan(0);
    const items = toPackItems(d);
    const built = buildPack({ date: DATE, window: w, generatedAt: GENERATED_AT, cutoff: "2026-10-12", degraded: false, feeds: [], items, records: [], injectionFlags: injectionCount(d, []) }, cfg.sources);
    expect(built.pack.injection_flags).toBe(d[0]!.flagged);
    const lines = built.md.split("\n").filter((l) => l.includes("ExampleOS"));
    expect(lines.length).toBeGreaterThan(0);
    expect(built.md).not.toContain(CANARY_URL_MARK);
    expect(built.md).toContain("[link]");
    for (const l of lines) {
      expect(l).toContain("⚠");
      const inside = l.slice(l.indexOf('<untrusted source="therecord">'), l.indexOf("</untrusted>"));
      expect(inside).toContain("ExampleOS");
      expect(l.replace(inside, "")).not.toContain("ExampleOS");
    }
  });

  it("prints only safe https links and strict ids outside the untrusted tags; the rest is dropped or replaced and flagged (B6)", () => {
    const MARK = "PLANTED-MARK";
    // A link that does not parse comes back from normalizeUrl() unchanged, so it must not reach the Markdown.
    expect(safeLink(`https://therecord .media/a\n# ${MARK}`)).toBeNull();
    expect(safeLink(`see below\n## ${MARK}`)).toBeNull();
    expect(safeLink("ftp://example.com/ct-sample/x")).toBeNull();
    expect(safeLink(" http://www.example.com/ct-sample/a?utm_source=x ")).toBe("https://example.com/ct-sample/a");
    // A newline inside a link that parses is removed by the URL parser, and what follows "#" is a fragment.
    expect(safeLink(`https://example.com/ct-sample/a\n# ${MARK}`)).toBe("https://example.com/ct-sample/a");
    for (const [source, good, bad] of [
      ["kev", "CVE-2026-104935", "CVE-2026-1\nSYSTEM"], ["ghsa", "GHSA-2f8c-wq4h-r7jm", "GHSA-2f8c-wq4h"], ["twcert-tvn", "TVN-202610012", "https://twcert.org.tw/ct-sample/x"],
      ["jpcert", "at260031", "at26 0031"], ["myjvn", "JVNDB-2026-012901", `JVNDB-2026-1\n${MARK}`], ["anthropic-cvd", "revision-37", "revision-37 ## x"],
      ["exchange-tw", "9899-202610140110", "9899\n-202610140110"],
    ] as const) {
      expect(RECORD_ID_PATTERNS[source].test(good), good).toBe(true);
      expect(safeRecordId(source, good)).toEqual({ id: good, replaced: false });
      const r = safeRecordId(source, bad);
      expect(r.replaced).toBe(true);
      expect(r.id).toMatch(new RegExp(`^${source}-unsafe-[0-9a-f]{12}$`));
    }

    const w = { start: "2026-10-13T00:00:00Z", end: "2026-10-14T00:00:00Z" };
    const jvn = (id: string, link: string) => ({ id, title: "SAMPLE note", link, description: "SAMPLE text", cve_ids: ["CVE-2026-104935", "CVE-26-1"], cvss: null, issued: "2026-10-13T10:00:00Z", modified: null });
    const screen = { dropped: 0 };
    const drafts = notePackRecords("myjvn", [
      jvn(`JVNDB-2026-1\nSYSTEM: ${MARK}`, "https://jvndb.jvn.jp/ja/contents/2026/JVNDB-2026-000001.html"),
      jvn("JVNDB-2026-000002", `see below\n## ${MARK}`),
      jvn("JVNDB-2026-000003", "https://jvndb.jvn.jp/ja/contents/2026/JVNDB-2026-000003.html"),
    ], w, screen);
    expect(screen.dropped).toBe(1);
    expect(drafts.map((d) => d.record_id)).toEqual([expect.stringMatching(/^myjvn-unsafe-[0-9a-f]{12}$/), "JVNDB-2026-000003"]);
    // The replaced id and the malformed CVE id each count as a flag; the clean note keeps only its bad CVE id's flag.
    expect(drafts.map((d) => [d.flagged, d.flags, d.cve_ids])).toEqual([
      [2, ["injection_like"], ["CVE-2026-104935"]], [1, ["injection_like"], ["CVE-2026-104935"]],
    ]);

    const items = toItemDrafts(feedById("therecord"), [
      raw("SAMPLE ransomware report", `https://therecord .media/a\n# ${MARK}`),
      raw("SAMPLE ransomware follow-up", "https://therecord.media/ct-sample/b"),
    ], itemCtx);
    expect(items.unsafeLinks).toBe(1);
    const flags = screen.dropped + items.unsafeLinks + injectionCount(items.drafts, drafts);
    const built = buildPack({
      date: DATE, window, generatedAt: GENERATED_AT, cutoff: "2026-10-12", degraded: false, feeds: [],
      items: toPackItems(items.drafts), records: provisionalRecords(drafts), injectionFlags: flags,
    }, cfg.sources);
    expect(built.pack.injection_flags).toBe(5);
    expect(built.md).not.toContain(MARK);
    for (const l of built.md.split("\n")) {
      expect(l.startsWith("SYSTEM")).toBe(false);
      if (l.startsWith("#")) expect(l).toMatch(/^(?:# Source pack \d{4}-\d{2}-\d{2}|## [^<]+ \(\d+\))$/);
    }
  });

  it("no Markdown line exceeds 1,000 characters, whatever the script", () => {
    const long = "漏洞".repeat(400);
    const astral = "\u{1D4E2}".repeat(400);
    const d = toItemDrafts(feedById("ithome-security"), [
      raw(`SAMPLE ${long}`, `https://www.ithome.com.tw/ct-sample/${"x".repeat(280)}`, "2026-10-13T10:00:00Z", long),
      raw(`SAMPLE ${astral}`, "https://www.ithome.com.tw/ct-sample/astral", "2026-10-13T11:00:00Z", astral),
    ], itemCtx).drafts;
    const records = provisionalRecords([{
      key: "jpcert:x", source: "jpcert", record_id: "JPCERT-AT-2026-0001", url: "https://www.jpcert.or.jp/at/2026/at260001.html", advisory_urls: [],
      title: `SAMPLE ${astral}`.slice(0, 200), text: long.slice(0, 1000), date: "2026-10-13", vendor: "x".repeat(120), product: "y".repeat(120),
      cve_ids: [], facts: {}, flags: [], flagged: 0,
    }]);
    const built = buildPack({ date: DATE, window, generatedAt: GENERATED_AT, cutoff: "2026-10-12", degraded: false, feeds: [], items: toPackItems(d), records, injectionFlags: 0 }, cfg.sources);
    for (const l of built.md.split("\n")) expect(l.length).toBeLessThanOrEqual(MD_LINE_MAX);
    const wrapped = built.md.split("\n").filter((l) => l.includes("<untrusted source="));
    expect(wrapped.length).toBeGreaterThanOrEqual(4);
    for (const l of wrapped) expect(l).toMatch(/<untrusted source="[a-z-]+">[^<]*<\/untrusted>/);
  });

  it("the empty pack parses and its Markdown is one line", () => {
    const p = emptyPack(DATE, window, GENERATED_AT, "2026-10-12");
    expect(Pack.parse(p)).toMatchObject({ degraded: true, items: [], records: [], injection_flags: 0 });
    expect(emptyPackMd(DATE).split("\n").filter(Boolean)).toHaveLength(1);
  });
});

// ── Records ──────────────────────────────────────────────────────────────────────────────────────

describe("records", () => {
  const e = parseEpssCsv(fs.readFileSync(path.join(FEEDS, "epss", "epss_scores-2026-10-13.csv.gz"))).day;
  const e1 = parseEpssCsv(fs.readFileSync(path.join(FEEDS, "epss", "epss_scores-2026-10-12.csv.gz"))).day;

  it("every EPSS jump gets a record, one per CVE even when it is also a mover", () => {
    const jumps = epssJumps(e, e1);
    expect(jumps.length).toBeGreaterThan(0);
    const mover = { cve_id: jumps[0]!.cve_id, score: jumps[0]!.score, percentile: jumps[0]!.percentile, delta_7d: 0.2 };
    const recs = epssPackRecords([mover], e.score_date, jumps);
    expect(recs.map((r) => r.record_id)).toEqual(jumps.map((j) => j.cve_id));
    expect(recs[0]!.facts.epss_delta_7d).toBe(0.2);
    expect(epssJumps(e, null)).toEqual([]);
  });

  it("perIdPlan: every KEV id, then a new revision's ledger CVE ids the state cannot date, newest first, within 500 (B13)", () => {
    const p = perIdPlan({
      kevIds: ["CVE-2026-0002", "CVE-2026-0001", "CVE-2026-0003"],
      ledgerIds: ["cve-2026-0009", "CVE-2026-0008", "CVE-2026-0007", "CVE-2026-0006", "CVE-2026-0002", "GHSA-7q8r-9v2w-c3f4", "CVE-2026-0005", "CVE-2026-0008"],
      dated: new Set(["CVE-2026-0007"]), have: new Set(["CVE-2026-0003", "CVE-2026-0006"]), max: 4,
    });
    // Two KEV ids to fetch (0003 is in today's zips), so two places are left, for the newest undated ledger ids;
    // 0007 is dated, 0006 is in the zips, 0002 is a KEV id and the GHSA id is no CVE: 0005 is over the cap.
    expect(p).toEqual({ ids: ["CVE-2026-0001", "CVE-2026-0002", "CVE-2026-0008", "CVE-2026-0009"], ledger: ["CVE-2026-0008", "CVE-2026-0009"], overCap: 1 });
    expect(perIdPlan({ kevIds: ["CVE-2026-0001"], ledgerIds: null, dated: new Set(), have: new Set() })).toEqual({ ids: ["CVE-2026-0001"], ledger: [], overCap: 0 });
    const many = Array.from({ length: PER_ID_MAX + 10 }, (_, i) => `CVE-2026-${String(10000 + i)}`);
    const kevOnly = perIdPlan({ kevIds: many, ledgerIds: ["CVE-2025-0001"], dated: new Set(), have: new Set() });
    expect(kevOnly.ids.length).toBe(PER_ID_MAX + 10);
    expect(kevOnly).toMatchObject({ ledger: [], overCap: 1 });
  });

  it("remapIds gives the candidates, cut entries and MERGED and BUNDLED log lines final ids, and a capped record none (B10)", () => {
    // r0001 and r0002 swap places in display order; r0350 fell to the cap of 400.
    const idMap = new Map([["r0001", "r0002"], ["r0002", "r0001"]]);
    const cand = (id: string, pack_ids: string[]) => ({ id, pack_ids }) as unknown as Parameters<typeof remapIds>[0][number];
    const cutEntry = (id: string, reason: string, pack_ids = [id]) => ({ id, score: 1, reason, pack_ids, cve_ids: [] });
    const r = remapIds(
      [cand("r0001", ["r0350", "r0001", "p0003"])],
      [cutEntry("r0350", "merged:r0001"), cutEntry("p0004", "merged:r0350"), cutEntry("r0002", "below_cap"), cutEntry("r0350", "below_cap")],
      [
        { code: "MERGED", detail: "r0350 (jpcert) merged into r0001 by CVE-2026-0001." },
        { code: "MERGED", detail: "p0004 (therecord) merged into r0350 by title." },
        { code: "BUNDLED", detail: "rel-sample: 3 records bundled, 1 exploited, 0 also kept as their own candidates." },
        { code: "KEV_INDEX_MISSING", detail: "No kev-index.json: every catalog entry counts as new (r0001)." },
      ],
      idMap,
    );
    expect(r.kept.map((c) => [c.id, c.pack_ids])).toEqual([["r0002", ["p0003", "r0002"]]]);
    expect(r.cut.map((c) => [c.id, c.reason, c.pack_ids])).toEqual([
      ["capped", "merged:r0002", []], ["p0004", "merged:capped", ["p0004"]], ["r0001", "below_cap", ["r0001"]], ["capped", "below_cap", []],
    ]);
    expect(r.log.map((l) => l.detail)).toEqual([
      "capped (jpcert) merged into r0002 by CVE-2026-0001.",
      "p0004 (therecord) merged into capped by title.",
      "rel-sample: 3 records bundled, 1 exploited, 0 also kept as their own candidates.",
      "No kev-index.json: every catalog entry counts as new (r0001).",
    ]);
    // Nothing capped and nothing moved: every id stays as it was.
    const same = remapIds([cand("r0001", ["r0001"])], [cutEntry("r0002", "merged:r0001")], [{ code: "MERGED", detail: "r0002 (jvn) merged into r0001 by title." }], new Map([["r0001", "r0001"], ["r0002", "r0002"]]));
    expect(same.cut[0]).toMatchObject({ id: "r0002", reason: "merged:r0001" });
    expect(same.log[0]!.detail).toBe("r0002 (jvn) merged into r0001 by title.");
  });

  it("capRecords keeps KEV records and referenced ones first, renumbers in display order, and maps the ids", () => {
    const draft = (source: "kev" | "epss", id: string, date: string) => ({
      key: `${source}:${id}`, source, record_id: id, url: `https://www.cve.org/CVERecord?id=${id}`, advisory_urls: [], title: id, text: "", date,
      vendor: null, product: null, cve_ids: [id], facts: {}, flags: [], flagged: 0,
    });
    const prov = provisionalRecords([draft("epss", "CVE-2026-0003", "2026-10-13"), draft("kev", "CVE-2026-0001", "2026-10-01"), draft("epss", "CVE-2026-0002", "2026-10-10"), draft("epss", "CVE-2026-0002", "2026-10-10")]);
    expect(prov.map((r) => `${r.id} ${r.source} ${r.record_id}`)).toEqual(["r0001 kev CVE-2026-0001", "r0002 epss CVE-2026-0003", "r0003 epss CVE-2026-0002"]);
    const c = capRecords(prov, new Set(["r0003"]), 2);
    expect(c.kept.map((r) => r.record_id)).toEqual(["CVE-2026-0001", "CVE-2026-0002"]);
    expect(c.cut).toBe(1);
    expect(c.idMap.get("r0003")).toBe("r0002");
    expect(c.idMap.has("r0002")).toBe(false);
  });
});

// ── Feed states and the degraded rule ────────────────────────────────────────────────────────────

describe("feed states", () => {
  const ref = Date.parse(window.end);
  const ok = (x: Partial<FeedOutcome>): FeedOutcome => ({ ...skippedOutcome(), skipped: false, ok: true, ...x });

  it("labels each state with its fixed note", () => {
    expect(feedState("rss", ok({ ok: false, error: "timeout" }), { fresh_days: 2 }, ref)).toEqual({ state: "failed", label: "FAIL", note: "Failed: timeout." });
    expect(feedState("kev", ok({ ok: false, error: "http_503", triedFallback: true }), { fresh_days: 7 }, ref).note).toBe("Failed: http_503 on both URLs.");
    expect(feedState("kev", ok({ fallbackUsed: true, newest: "2026-10-13T17:02:11Z" }), { fresh_days: 7 }, ref)).toEqual({ state: "ok", label: "OK", note: "Fallback URL used." });
    expect(feedState("rss", ok({ newest: null }), { fresh_days: 2 }, ref)).toEqual({ state: "stale", label: "NODATE", note: "Stale: no readable dates." });
    expect(feedState("rss", ok({ newest: "2026-08-10T09:00:00Z" }), { fresh_days: 14 }, ref)).toEqual({ state: "stale", label: "STALE", note: "Stale: newest entry 2026-08-10." });
    expect(feedState("rss", ok({ newest: "2026-08-10T09:00:00Z" }), { fresh_days: 90 }, ref).label).toBe("OK");
    expect(feedState("nvd", ok({ newest: null }), { fresh_days: 30 }, ref).label).toBe("OK");
    expect(feedState("nvd", skippedOutcome(), { fresh_days: 30 }, ref).label).toBe("SKIP");
    expect(freshColumn("rss", "STALE", "2026-08-10T09:00:00Z", ref)).toBe("no (64 d)");
    expect(freshColumn("rss", "OK", "2026-10-13T09:00:00Z", ref)).toBe("yes");
  });

  it("is degraded at 40% of rss entries failed, not at 39%, and whenever kev or cvelist failed", () => {
    const rows = (failed: number, total = 100): Pick<FeedIndexEntry, "id" | "kind" | "status">[] =>
      Array.from({ length: total }, (_, i) => ({ id: `rss-${i}`, kind: "rss", status: i < failed ? "failed" : "ok" }));
    expect(isDegraded(rows(39))).toBe(false);
    expect(isDegraded(rows(40))).toBe(true);
    expect(isDegraded([...rows(0), { id: "kev", kind: "kev", status: "failed" }])).toBe(true);
    expect(isDegraded([...rows(0), { id: "cvelist", kind: "cvelist", status: "failed" }])).toBe(true);
    expect(isDegraded([...rows(0), { id: "epss", kind: "epss", status: "failed" }])).toBe(false);
  });
});

// ── End to end on fixtures/feeds ─────────────────────────────────────────────────────────────────

describe("collect on the fixture world (2026-10-14)", () => {
  let root: string;
  let result: Awaited<ReturnType<typeof collect>>;
  let first: Record<string, string>;
  let stateBefore: string[];

  const urls: string[] = [];
  beforeAll(async () => {
    root = tempRoot(true);
    fs.mkdirSync(path.join(root, "cache", "cvelist", "records"), { recursive: true });
    fs.writeFileSync(path.join(root, "cache", "cvelist", "records", "CVE-2020-0001.json"), "{}");
    stateBefore = fs.readdirSync(path.join(root, "content", "state")).map((f) => `${f} ${sha256Hex(fs.readFileSync(path.join(root, "content", "state", f)))}`);
    result = await run(root, { urls });
    first = Object.fromEntries(OUTPUTS.map((f) => [f, readOut(root, f)]));
  });

  it("writes every output, each parsing with its schema", () => {
    expect(FeedIndexFile.parse(JSON.parse(first["cache/feeds/index.json"]!))).toEqual(result.index);
    expect(CollectInputsFile.parse(JSON.parse(first["cache/feeds/inputs.json"]!))).toEqual(result.inputs);
    expect(Pack.parse(JSON.parse(first[`packs/${DATE}.json`]!))).toEqual(result.pack);
    expect(CandidatesFile.parse(JSON.parse(first[`packs/${DATE}.candidates.json`]!))).toEqual(result.candidates);
    // Within both caps, so the size caps cut nothing and the log says so (row 146).
    expect(CandidateLogFile.parse(JSON.parse(first[`logs/${DATE}.candidates.json`]!)).size_cut).toEqual({ over: false, items: [], records: [] });
    expect(first[`logs/${DATE}.collect.log`]).not.toContain("the size caps cut");
    expect(first[`packs/${DATE}.md`]!.startsWith(`# Source pack ${DATE}\n`)).toBe(true);
    for (const l of first[`packs/${DATE}.md`]!.split("\n")) expect(l.length).toBeLessThanOrEqual(MD_LINE_MAX);
    expect(first[`logs/${DATE}.collect.log`]).toContain(result.summary[0]!);
  });

  it("writes nothing under content/", () => {
    const after = fs.readdirSync(path.join(root, "content")).sort();
    expect(after).toEqual(["state"]);
    expect(fs.readdirSync(path.join(root, "content", "state")).map((f) => `${f} ${sha256Hex(fs.readFileSync(path.join(root, "content", "state", f)))}`)).toEqual(stateBefore);
  });

  it("reads the fixture commits, the two zips and the re-join id by commit", () => {
    expect(result.inputs.commits).toEqual({
      cvelist: "c0de000000000000000000000000000000002013", kev_data: "feed000000000000000000000000000000001013", ghsa: "a11ce00000000000000000000000000000001013",
    });
    expect(result.inputs.generated_at).toBe(GENERATED_AT);
    expect(result.inputs.record_window).toEqual({ start: "2026-10-12T20:00:00Z", end: "2026-10-13T20:00:00Z" });
    expect(result.inputs.cvelist.zips.map((z) => z.tag)).toEqual([FEED_WORLD.eodTag, FEED_WORLD.hourlyTag]);
    expect(result.inputs.cvelist.days).toEqual([{ date: "2026-10-12", zips: ["2026-10-12_delta_CVEs_at_end_of_day.zip", "2026-10-13_delta_CVEs_at_2000Z.zip"], ok: true }]);
    expect(result.inputs.cvelist.by_id.fetched).toEqual([FEED_WORLD.rejoinId]);
    expect(result.inputs.kev).toMatchObject({ catalog_version: FEED_WORLD.kev.version, fallback_used: false });
    expect(result.inputs.epss?.files.map((f) => `${f.role} ${f.date}`)).toEqual(["e 2026-10-13", "e1 2026-10-12", "e7 2026-10-06"]);
    expect(fs.existsSync(path.join(root, "cache", "cvelist", "records", `${FEED_WORLD.rejoinId}.json`))).toBe(true);
  });

  it("lists every registry entry in the index, search rows skipped, and the fixture failures and stale feeds", () => {
    expect(result.index.feeds.map((f) => f.id)).toEqual(cfg.sources.feeds.map((f) => f.id));
    const by = new Map(result.index.feeds.map((f) => [f.id, f]));
    for (const f of cfg.sources.feeds.filter((x) => x.kind === "search")) expect(by.get(f.id)!.status).toBe("skipped");
    expect(by.get("krebs")).toMatchObject({ status: "failed", label: "FAIL", error_class: "timeout", note: "Failed: timeout." });
    expect(by.get("gtig")).toMatchObject({ status: "failed", error_class: "http_503" });
    expect(by.get("unit42")).toMatchObject({ status: "stale", label: "STALE" });
    expect(by.get("google-security")).toMatchObject({ status: "stale", label: "NODATE" });
    expect(by.get("kev")).toMatchObject({ status: "ok", items: 111, version: FEED_WORLD.kev.version, fetched_at: GENERATED_AT });
    expect(result.pack.degraded).toBe(false);
    expect(result.pack.feeds.length).toBe(cfg.sources.feeds.filter((f) => f.kind !== "search").length);
    expect(result.summary).toEqual([
      expect.stringMatching(/^Pack 2026-10-14: \d+ items, \d+ records from 35\/37 feeds; \d+ candidates \(2 new KEV\)\.$/),
      "Failed: krebs (timeout), gtig (http_503)",
      "Stale: unit42 (newest 2026-08-10), google-security (newest none)",
    ]);
  });

  it("ranks the two new KEV ids first, with the JPCERT alert merged, and every pack id resolves", () => {
    const kept = result.candidates.kept;
    expect(kept.slice(0, 2).map((c) => c.cve_ids[0])).toEqual(NEW_KEV);
    expect(kept[0]!.reasons).toContain("JPCERT alert");
    expect(kept.some((c) => c.id === "pt-microsoft-2026-10")).toBe(true);
    const ids = new Set([...result.pack.items.map((i) => i.id), ...result.pack.records.map((r) => r.id)]);
    for (const c of kept) {
      expect(c.pack_ids.length).toBeGreaterThan(0);
      for (const id of c.pack_ids) expect(ids.has(id)).toBe(true);
    }
    expect(result.pack.records.filter((r) => r.source === "jpcert" && r.facts.alert === true).length).toBeGreaterThan(0);
  });

  it("the records the caps keep whole are its region-signal records, by the predicate collectSignals() uses, and its exchange and dashboard records (review of row 146)", () => {
    const rc = regionsConfig(cfg);
    for (const r of result.pack.records) {
      expect(givesRegionSignal(r, rc, DATE), r.record_id).toBe(collectSignals({ items: [], records: [r] }, null, null, rc, DATE).length > 0);
    }
    const signalUrls = new Set(collectSignals({ items: [], records: result.pack.records }, null, null, rc, DATE).map((x) => x.url));
    expect([...signalUrls].sort()).toEqual(result.pack.records.filter((r) => givesRegionSignal(r, rc, DATE)).map((r) => normalizeUrl(r.url)).sort());
    const pinned = pinnedRecordIds(result.pack.records, rc, DATE);
    expect(result.pack.records.filter((r) => pinned.has(r.id)).map((r) => `${r.source} ${r.record_id}`).sort()).toEqual([
      "anthropic-cvd revision-37", "exchange-tw 9899-202610140110", "exchange-tw 9998-202610132130", "jpcert at260031", "jpcert wr264101",
      "twcert-tvn TVN-202610012",
    ]);
    // Not every note: a TVN note reporting no exploitation is not pinned.
    expect(result.pack.records.some((r) => r.source === "twcert-tvn" && !pinned.has(r.id))).toBe(true);
  });

  it("empties the records cache first, and the next zip's copy of a record wins", () => {
    const records = path.join(root, "cache", "cvelist", "records");
    expect(fs.existsSync(path.join(records, "CVE-2020-0001.json"))).toBe(false);
    const both = JSON.parse(fs.readFileSync(path.join(records, "CVE-2026-108917.json"), "utf8")) as { cveMetadata: { dateUpdated: string } };
    expect(both.cveMetadata.dateUpdated).toBe("2026-10-13T16:04:13.730Z");
  });

  it("renders the Markdown layout: header, sections with back-references, records with advisory lines, within 150 KB", () => {
    const md = first[`packs/${DATE}.md`]!;
    expect(Buffer.byteLength(md)).toBeLessThanOrEqual(PACK_MD_MAX_BYTES);
    const lines = md.split("\n");
    expect(lines[1]).toBe("Window: 2026-10-13 04:30 to 2026-10-14 04:30 Taipei (items up to 12 hours earlier kept for context).");
    expect(lines).toContain("Failed: Krebs on Security (timeout), " + `${cfg.sources.feeds.find((f) => f.id === "gtig")!.name} (http_503).`);
    for (const h of ["## Exploits (", "## Breaches (", "## AI (", "## Policy (", "## Taiwan (", "## Japan (", "## Records ("]) expect(lines.some((l) => l.startsWith(h)), h).toBe(true);
    expect(lines.some((l) => / see (Exploits|Breaches|AI|Policy|Taiwan): <untrusted source=/.test(l))).toBe(true);
    expect(lines.some((l) => /^- \[r\d{4}\] KEV 2026-10-13 \(US date\) · CVE-2026-\d+ · <untrusted source="kev">/.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith("  advisory: https://"))).toBe(true);
  });

  it("a rerun reuses the cached zips and EPSS files", async () => {
    const zipUrls = urls.filter((u) => u.endsWith(".zip") || u.endsWith(".csv.gz"));
    expect(zipUrls.length).toBe(5);
    const again: string[] = [];
    await run(root, { urls: again });
    expect(again.filter((u) => u.endsWith(".zip") || u.endsWith(".csv.gz"))).toEqual([]);
  });

  it("a rerun on the same inputs differs only in generated_at", async () => {
    const later = T0 + 60_000;
    const again = await run(root, { now: later });
    expect(again.pack.generated_at).toBe("2026-10-14T04:38:00+08:00");
    for (const f of OUTPUTS) {
      expect(readOut(root, f).replaceAll("2026-10-14T04:38:00+08:00", GENERATED_AT), f).toBe(first[f]);
    }
  });
});

describe("collect's other runs", () => {
  it("a morning over the 150 KB Markdown cap cuts unreferenced records first, then news, and lists every cut in logs/D.candidates.json (row 146)", async () => {
    // Nine newsrooms with 30 long, distinct stories each, on the fixture world: about 200 KB of Markdown before the size caps.
    const gen: Record<string, string> = {
      "https://therecord.media/feed": "therecord.media", "https://www.securityweek.com/feed/": "www.securityweek.com",
      "https://techcrunch.com/category/security/feed/": "techcrunch.com", "https://feeds.feedburner.com/TheHackersNews": "thehackernews.com",
      "https://www.microsoft.com/en-us/security/blog/feed/": "www.microsoft.com", "https://krebsonsecurity.com/feed/": "krebsonsecurity.com",
      "https://googleprojectzero.blogspot.com/feeds/posts/default": "googleprojectzero.blogspot.com",
      "https://www.ithome.com.tw/rss/security": "www.ithome.com.tw", "https://www.security-next.com/feed": "www.security-next.com",
    };
    // Words of their own per story, so no two titles are near-identical (dedupe) and none matches a candidate.
    const pick = (seed: number, n: number) => Array.from({ length: n }, (_, j) => `w${seed}q${j}`).join(" ");
    const feeds = feedsVariant((index) => {
      Object.keys(gen).forEach((url, f) => { index[url] = { file: `rss/gen-${f}.xml`, content_type: "application/rss+xml" }; });
      index["https://www.cert.ssi.gouv.fr/feed/"] = { file: "rss/cert-fr-alert.xml", content_type: "application/rss+xml" };
    });
    // And a CERT-FR ALE alert at the start of the window, among the lowest scores: an item that gives a region signal.
    const alertUrl = "https://www.cert.ssi.gouv.fr/alerte/CERTFR-2026-ALE-011/";
    fs.writeFileSync(path.join(feeds, "rss", "cert-fr-alert.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0"><channel><title>SAMPLE</title><link>https://www.cert.ssi.gouv.fr/</link><description>SAMPLE</description>\n<item><title>SAMPLE Alerte de sécurité</title><link>${alertUrl}</link><pubDate>${new Date(Date.parse(window.start) - 11 * 3_600_000).toUTCString()}</pubDate><description>SAMPLE ${pick(99999, 60)}</description></item>\n</channel></rss>\n`);
    Object.entries(gen).forEach(([, host], f) => {
      const items = Array.from({ length: 30 }, (_, k) => {
        const at = new Date(Date.parse("2026-10-13T10:00:00Z") + (f * 30 + k) * 60_000).toUTCString();
        const seed = f * 1000 + k * 10;
        return `<item><title>SAMPLE ransomware ${pick(seed, 28)}</title><link>https://${host}/ct-sample/gen-${f}-${k}</link><pubDate>${at}</pubDate><description>SAMPLE ${pick(seed + 5, 60)}</description></item>`;
      });
      fs.writeFileSync(path.join(feeds, "rss", `gen-${f}.xml`), `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0"><channel><title>SAMPLE</title><link>https://${host}/</link><description>SAMPLE</description>\n${items.join("\n")}\n</channel></rss>\n`);
    });
    const root = tempRoot(true);
    const log: string[] = [];
    const r = await run(root, { feeds, log });
    const md = readOut(root, `packs/${DATE}.md`);
    expect(Buffer.byteLength(md)).toBeLessThanOrEqual(PACK_MD_MAX_BYTES);
    const sizeCut = CandidateLogFile.parse(JSON.parse(readOut(root, `logs/${DATE}.candidates.json`))).size_cut;
    expect(sizeCut.over).toBe(false);
    expect(sizeCut.items.length).toBeGreaterThan(0);
    // Every kept candidate's own item and pack_ids are still there; only unreferenced records and items went.
    const referenced = new Set(r.candidates.kept.flatMap((c) => [c.id, ...c.pack_ids]).filter((id) => /^[pr]\d{4,}$/.test(id)));
    const inPack = new Set([...r.pack.items.map((i) => i.id), ...r.pack.records.map((x) => x.id)]);
    for (const id of referenced) expect(inPack.has(id), id).toBe(true);
    for (const x of [...sizeCut.items, ...sizeCut.records]) expect(inPack.has(x.id) || referenced.has(x.id), x.id).toBe(false);
    // An item went only once every record the caps may cut was gone: what is left is KEV, pinned (region-signal,
    // exchange and dashboard) and referenced records, and the caps cut none of the pinned ones (review of row 146).
    expect(sizeCut.records.length).toBeGreaterThan(0);
    const pinned = pinnedRecordIds(r.pack.records, regionsConfig(cfg), DATE);
    for (const x of r.pack.records) expect(x.source === "kev" || pinned.has(x.id) || referenced.has(x.id), x.id).toBe(true);
    expect(sizeCut.records.every((x) => x.source !== "kev" && x.source !== "exchange-tw" && x.source !== "anthropic-cvd")).toBe(true);
    // The fixture world's region-signal records (the TVN and JPCERT notes reporting exploitation, the JPCERT
    // /at/ alert), its two exchange filings and its dashboard record are all still in the pack.
    expect(r.pack.records.filter((x) => pinned.has(x.id)).map((x) => `${x.source} ${x.record_id}`).sort()).toEqual([
      "anthropic-cvd revision-37", "exchange-tw 9899-202610140110", "exchange-tw 9998-202610132130", "jpcert at260031", "jpcert wr264101",
      "twcert-tvn TVN-202610012",
    ]);
    // Nor any item that gives a region signal: the CERT-FR alert stays, below the score of items the caps cut.
    const alert = r.pack.items.find((i) => i.url === normalizeUrl(alertUrl));
    expect(alert, "the ALE alert").toBeDefined();
    expect(sizeCut.items.some((i) => i.score > alert!.score)).toBe(true);
    expect(levels(r.pack).EU![1]).toBe("agency-alert");
    // The audit names each cut item as the pack held it: a sanitised title, its feed and its score, in id order.
    expect(sizeCut.items.map((i) => i.id)).toEqual([...sizeCut.items.map((i) => i.id)].sort());
    expect(sizeCut.records.map((x) => x.id)).toEqual([...sizeCut.records.map((x) => x.id)].sort());
    for (const i of sizeCut.items) {
      expect(i.title).toMatch(/^SAMPLE /);
      expect(cfg.sources.feeds.some((f) => f.id === i.feed_id)).toBe(true);
    }
    // The collect log keeps its count line and names the cut items per feed.
    const text = readOut(root, `logs/${DATE}.collect.log`);
    expect(text).toContain(`pack: the size caps cut ${sizeCut.items.length} items and ${sizeCut.records.length} records.`);
    const byFeed = new Map<string, number>();
    for (const i of sizeCut.items) byFeed.set(i.feed_id, (byFeed.get(i.feed_id) ?? 0) + 1);
    expect(text).toContain(`pack: items the size caps cut, by feed: ${[...byFeed].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, n]) => `${id} ${n}`).join(", ")} (each listed in logs/${DATE}.candidates.json).`);
    expect(log.filter((l) => l.startsWith("pack: the size caps cut"))).toHaveLength(1);
  });

  it("a release whose CVE records tag no reference: the pack's member records carry the vendor's own page, as the candidate does (review of row 146)", async () => {
    // Six SAP fixes in the hourly zip, each citing its note on me.sap.com and the url.sap patch-day link, both untagged, as SAP's
    // 2026 records all do. Without the vendor pages the pack held no SAP page, so a patch batch could cite none from it.
    const zipName = "2026-10-13_delta_CVEs_at_2000Z.zip";
    const feeds = feedsVariant();
    const zipPath = path.join(feeds, "cvelist", "zips", zipName);
    const entries = readZip(fs.readFileSync(zipPath));
    const sap = Array.from({ length: 6 }, (_, i) => {
      const id = `CVE-2026-6209${i}`;
      return { name: `deltaCves/${id}.json`, data: Buffer.from(JSON.stringify({
        dataType: "CVE_RECORD", dataVersion: "5.2",
        cveMetadata: { cveId: id, assignerOrgId: "sample-sap", state: "PUBLISHED", assignerShortName: "sap", datePublished: `2026-10-13T0${i}:15:00.000Z`, dateUpdated: `2026-10-13T0${i}:15:00.000Z` },
        containers: { cna: {
          title: `SAMPLE SAP NetWeaver flaw ${i}`, affected: [{ vendor: "SAP_SE", product: "SAMPLE NetWeaver" }],
          descriptions: [{ lang: "en", value: `SAMPLE description ${i}.` }],
          metrics: [{ cvssV3_1: { version: "3.1", baseScore: 7.1 - i / 10, baseSeverity: "HIGH", vectorString: "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N" } }],
          references: [{ url: `https://me.sap.com/notes/36943${80 + i}` }, { url: "https://url.sap/sapsecuritypatchday" }],
        } },
      })) };
    });
    fs.writeFileSync(zipPath, storedZip([...entries, ...sap]));
    const root = tempRoot(true);
    const r = await run(root, { feeds });
    // The fixture world's own SAP fix (CVE-2026-58249, CVSS 9.8, its note on me.sap.com and a page on example.com) joins them.
    const pt = r.candidates.kept.find((c) => c.id === "pt-sap-2026-10")!;
    expect(pt.release).toMatchObject({ vendor: "SAP", total: 7, exploited: 0 });
    const fixtureNote = "https://me.sap.com/ct-sample/cve-2026-58249-1";
    const notes = [0, 1, 2, 3, 4, 5].map((i) => `https://me.sap.com/notes/36943${80 + i}`);
    expect(pt.advisory_urls).toEqual([fixtureNote, ...notes.slice(0, 4)]);
    const byCve = new Map(r.pack.records.filter((x) => x.source === "cvelist").map((x) => [x.record_id, x]));
    sap.forEach((_, i) => expect(byCve.get(`CVE-2026-6209${i}`)?.advisory_urls).toEqual([notes[i]]));
    expect(byCve.get("CVE-2026-58249")?.advisory_urls).toEqual([fixtureNote]);
    const md = readOut(root, `packs/${DATE}.md`);
    for (const u of [fixtureNote, ...notes]) expect(md).toContain(`  advisory: ${u}`);
    expect(md).not.toContain("url.sap");
    expect(md).not.toContain("  advisory: https://example.com/");
    // The pack is the run's evidence: a draft citing the note from the pack is citing a URL the run saw.
    for (const u of [fixtureNote, ...notes]) expect(packEvidence(r.pack).seen_as[u]).toBe("pack");
    // On the fixture morning alone the SAP fix is no release member (one record, under min_records): no vendor page, and no
    // other record's advisory URLs change either way.
    const before = await run(tempRoot(true));
    expect(before.candidates.kept.some((c) => c.kind === "patch_batch" && c.id.startsWith("pt-sap-"))).toBe(false);
    for (const x of before.pack.records) {
      const now = r.pack.records.find((y) => y.source === x.source && y.record_id === x.record_id);
      expect(now?.advisory_urls ?? x.advisory_urls, x.record_id).toEqual(x.record_id === "CVE-2026-58249" ? [fixtureNote] : x.advisory_urls);
    }
    expect(before.pack.records.find((x) => x.record_id === "CVE-2026-58249")?.advisory_urls ?? []).toEqual([]);
  });

  it("a CERT-FR morning of 34 higher-scored notices keeps its ALE alert past the 30-per-feed cap, and Europe its level (review of row 146)", async () => {
    // The review's s13 case end to end: the alert is the lowest score of CERT-FR's 35 items in the window.
    const alertUrl = "https://www.cert.ssi.gouv.fr/alerte/CERTFR-2026-ALE-011/";
    const at = (h: number) => new Date(Date.parse("2026-10-13T08:00:00Z") + h * 3_600_000).toUTCString();
    // Words of their own per notice, so dedupe keeps all 34 (no two titles are near-identical).
    const words = (i: number) => Array.from({ length: 6 }, (_, j) => `v${i}q${j}`).join(" ");
    const items = Array.from({ length: 34 }, (_, i) =>
      `<item><title>SAMPLE ${words(i)} exploit ransomware</title><link>https://www.cert.ssi.gouv.fr/avis/CERTFR-2026-AVI-${1000 + i}/</link><pubDate>${at(i % 12)}</pubDate><description>SAMPLE vulnerability exploit</description></item>`);
    items.push(`<item><title>SAMPLE Alerte de sécurité</title><link>${alertUrl}</link><pubDate>${at(-1)}</pubDate><description>SAMPLE</description></item>`);
    const feeds = feedsVariant((index) => {
      index["https://www.cert.ssi.gouv.fr/feed/"] = { file: "rss/cert-fr-many.xml", content_type: "application/rss+xml" };
    });
    fs.writeFileSync(path.join(feeds, "rss", "cert-fr-many.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0"><channel><title>SAMPLE</title><link>https://www.cert.ssi.gouv.fr/</link><description>SAMPLE</description>\n${items.join("\n")}\n</channel></rss>\n`);
    const root = tempRoot(true);
    const log: string[] = [];
    const r = await run(root, { feeds, log });
    expect(log).toContain("cert-fr: 5 items over the caps.");
    const certFr = r.pack.items.filter((i) => i.feed_id === "cert-fr");
    expect(certFr.length).toBe(30);
    const alert = certFr.find((i) => i.url === normalizeUrl(alertUrl));
    expect(alert, "the ALE alert").toBeDefined();
    expect(Math.min(...certFr.map((i) => i.score))).toBe(alert!.score);
    expect(collectSignals(r.pack, null, null, regionsConfig(cfg), DATE).filter((s) => s.region === "EU").map((s) => [s.type, s.url])).toEqual([["agency_alert", alert!.url]]);
    expect(levels(r.pack).EU![1]).toBe("agency-alert");
  });

  it("a morning over the 400-record cap keeps a TVN note reporting exploitation that no candidate references (review of row 146)", async () => {
    // 460 TVN notes in the window, all CERT notes of score 30; the one reporting exploitation is the oldest, so by date it would be
    // the first record the 400-record cap cuts, and Taiwan's signal would leave the pack.
    const items = Array.from({ length: 460 }, (_, k) => {
      const id = `TVN-202610${String(100 + k).padStart(3, "0")}`;
      const exploited = k === 0;
      const at = new Date(Date.parse(exploited ? "2026-10-12T21:00:00Z" : "2026-10-13T17:00:00Z") + k * 1000).toUTCString();
      const text = exploited ? "SAMPLE: 此漏洞已遭利用，請儘速更新。內容為虛構。" : `SAMPLE: 路由器漏洞 ${k}。內容為虛構。`;
      return `<item><title>${id} SAMPLE 路由器漏洞 ${k}</title><link>https://www.twcert.org.tw/ct-sample/${id.toLowerCase()}</link><description>${text}</description><pubDate>${at}</pubDate></item>`;
    });
    const feeds = feedsVariant((index) => {
      index["https://www.twcert.org.tw/tw/rss-132-1.xml"] = { file: "twcert-tvn/many.xml", content_type: "application/rss+xml" };
    });
    fs.writeFileSync(path.join(feeds, "twcert-tvn", "many.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>SAMPLE</title><link>https://www.twcert.org.tw/ct-sample/tvn</link><description>SAMPLE</description>\n${items.join("\n")}\n</channel></rss>\n`);
    const root = tempRoot(true);
    const log: string[] = [];
    const r = await run(root, { feeds, log });
    expect(log.some((l) => /^records: \d+ over the cap of 400\.$/.test(l))).toBe(true);
    const note = r.pack.records.find((x) => x.record_id === "TVN-202610100");
    expect(note, "the exploitation note").toBeDefined();
    expect(r.candidates.kept.some((c) => c.id === note!.id || c.pack_ids.includes(note!.id))).toBe(false);
    const rc = regionsConfig(cfg);
    expect(collectSignals(r.pack, null, null, rc, DATE).filter((x) => x.type === "cert_exploitation" && x.region === "TW").map((x) => x.url)).toContain(normalizeUrl(note!.url));
    // Its neighbours by date, the other notes no candidate references, went first.
    expect(r.pack.records.filter((x) => x.source === "twcert-tvn").length).toBeLessThan(460);
  });

  it("a morning that stays over the size caps cuts every item but the region-signal ones, and logs the exact line (review of row 146)", async () => {
    // 420 long TVN notes that all report exploitation: 400 stay as pinned records the caps never cut, about 190 KB of
    // Markdown on their own. And a CERT-FR ALE alert, an item that gives a region signal.
    const notes = Array.from({ length: 420 }, (_, k) => {
      const id = `TVN-202610${String(100 + k).padStart(3, "0")}`;
      const at = new Date(Date.parse("2026-10-13T12:00:00Z") + k * 1000).toUTCString();
      return `<item><title>${id} SAMPLE 路由器漏洞已遭利用 ${k}</title><link>https://www.twcert.org.tw/ct-sample/${id.toLowerCase()}</link><description>SAMPLE: 此漏洞已遭利用，請儘速更新。${"內容為虛構。".repeat(60)}</description><pubDate>${at}</pubDate></item>`;
    });
    const alertUrl = "https://www.cert.ssi.gouv.fr/alerte/CERTFR-2026-ALE-011/";
    const feeds = feedsVariant((index) => {
      index["https://www.twcert.org.tw/tw/rss-132-1.xml"] = { file: "twcert-tvn/many.xml", content_type: "application/rss+xml" };
      index["https://www.cert.ssi.gouv.fr/feed/"] = { file: "rss/cert-fr-alert.xml", content_type: "application/rss+xml" };
    });
    fs.writeFileSync(path.join(feeds, "twcert-tvn", "many.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>SAMPLE</title><link>https://www.twcert.org.tw/ct-sample/tvn</link><description>SAMPLE</description>\n${notes.join("\n")}\n</channel></rss>\n`);
    fs.writeFileSync(path.join(feeds, "rss", "cert-fr-alert.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0"><channel><title>SAMPLE</title><link>https://www.cert.ssi.gouv.fr/</link><description>SAMPLE</description>\n<item><title>SAMPLE Alerte de sécurité</title><link>${alertUrl}</link><pubDate>Tue, 13 Oct 2026 07:00:00 GMT</pubDate><description>SAMPLE</description></item>\n</channel></rss>\n`);
    const root = tempRoot(true);
    const log: string[] = [];
    const r = await run(root, { feeds, log });
    const sizeCut = CandidateLogFile.parse(JSON.parse(readOut(root, `logs/${DATE}.candidates.json`))).size_cut;
    expect(sizeCut.over).toBe(true);
    expect(log).toContain("pack: still over the size caps with only KEV, region-signal, exchange, dashboard and referenced records and region-signal items left; written as it is.");
    expect(log.filter((l) => l.startsWith("pack: still over"))).toHaveLength(1);
    // Every item went but the alert, referenced or not; no record went.
    expect(r.pack.items.map((i) => i.url)).toEqual([normalizeUrl(alertUrl)]);
    expect(sizeCut.items.length).toBeGreaterThan(10);
    expect(sizeCut.records).toEqual([]);
    expect(levels(r.pack).EU![1]).toBe("agency-alert");
    expect(Buffer.byteLength(readOut(root, `packs/${DATE}.md`))).toBeGreaterThan(PACK_MD_MAX_BYTES);
  });

  it("a deadline already past throws CollectTimeout and writes nothing", async () => {
    const root = tempRoot(true);
    await expect(run(root, { deadline: T0 - 1 })).rejects.toBeInstanceOf(CollectTimeout);
    expect(written(root)).toEqual([]);
  });

  it("fetchFeed gets the logical deadline converted to Date.now()'s clock with realDeadline (plan §3.2, G7)", async () => {
    process.env.CT_FIXTURE_FEEDS = FEEDS;
    // The run's clock stands at T0, weeks before Date.now(): T0 + 300 s as such would be long past for fetchFeed.
    const seen: { at: number; deadline: number | undefined }[] = [];
    const fetch: typeof fetchFeed = (url, opts) => {
      seen.push({ at: Date.now(), deadline: opts?.deadline });
      return fetchFeed(url, opts);
    };
    const t0 = Date.now();
    await collect({ date: DATE, deadline: T0 + 300_000, root: tempRoot(true), deps: { now: () => T0, aiMatch, fetch } });
    expect(seen.length).toBeGreaterThan(25);
    for (const s of seen) {
      // min(the 240 s budget, the 300 s deadline) from the clock's T0, moved onto the real clock.
      expect(s.deadline).toBeGreaterThanOrEqual(t0 + 240_000);
      expect(s.deadline).toBeLessThanOrEqual(s.at + 240_000);
    }
  });

  it("a deadline passed during the run writes no pack, no candidates and no index", async () => {
    const root = tempRoot(true);
    let calls = 0;
    const now = () => (++calls > 40 ? T0 + 400_000 : T0);
    await expect(run(root, { now, deadline: T0 + 300_000 })).rejects.toBeInstanceOf(CollectTimeout);
    const files = written(root);
    for (const f of OUTPUTS) expect(files).not.toContain(f);
  });

  it("phase A reads every light feed first, then the deltaLog, the zips, the EPSS files and the GHSA sync (B1)", async () => {
    process.env.CT_FIXTURE_FEEDS = FEEDS;
    const order: string[] = [];
    const base = fixtureGit(FEEDS);
    const git: GitSource = { ...base, syncGhsa: async (dir, months, sha) => { order.push("ghsa-sync"); return base.syncGhsa(dir, months, sha); } };
    const fetch: typeof fetchFeed = (url, opts) => { order.push(url); return fetchFeed(url, opts); };
    await collect({ date: DATE, deadline: T0 + 300_000, root: tempRoot(true), deps: { now: () => T0, aiMatch, fetch, git } });
    // Phase A's light reads: the registry URLs of rss, myjvn, exchange and anthropic-cvd, and the KEV catalog
    // (pinned to the kev-data commit, so matched by its file name). nvd is phase C, after the records.
    const lightUrls = cfg.sources.feeds
      .filter((f) => ["rss", "myjvn", "exchange", "anthropic-cvd", "kev"].includes(f.kind))
      .flatMap((f) => { const e = f as { url: string; fallback_url: string | null }; return [e.url, e.fallback_url]; })
      .filter((u): u is string => typeof u === "string");
    const isLight = (u: string) => lightUrls.includes(u) || u.endsWith("/known_exploited_vulnerabilities.json");
    const isHeavy = (u: string) => u === "ghsa-sync" || /(?:deltaLog\.json|\.zip|\.csv\.gz)$/.test(u);
    const firstHeavy = order.findIndex(isHeavy);
    const lastLight = order.reduce((at, u, i) => (isLight(u) ? i : at), -1);
    expect(order.filter((u) => u.endsWith(".zip")).length).toBeGreaterThan(0);
    expect(order).toContain("ghsa-sync");
    expect(order.some((u) => u.endsWith(".csv.gz"))).toBe(true);
    expect(order.filter(isLight).length).toBeGreaterThan(25);
    expect(lastLight).toBeLessThan(firstHeavy);
  });

  it("checks the advisories out at the ls-remote commit, so the GHSA read names the run's one commit (round 2)", async () => {
    process.env.CT_FIXTURE_FEEDS = FEEDS;
    const ghsaSha = "a11ce00000000000000000000000000000001013";
    const shas: (string | null)[] = [];
    const base = fixtureGit(FEEDS);
    const git: GitSource = { ...base, syncGhsa: async (dir, months, sha) => { shas.push(sha); return base.syncGhsa(dir, months, sha); } };
    const r = await collect({ date: DATE, deadline: T0 + 300_000, root: tempRoot(true), deps: { now: () => T0, aiMatch, fetch: fetchFeed, git } });
    expect(shas).toEqual([ghsaSha]);
    expect(r.inputs.commits.ghsa).toBe(ghsaSha);
    expect(r.inputs.ghsa?.commit).toBe(ghsaSha);
    // main moved on after ls-remote: a checkout that cannot be at the sampled commit is not read.
    const dir = path.join(tempRoot(true), "cache", "ghsa");
    expect(await base.syncGhsa(dir, ["2026/10"], "b".repeat(40))).toBeNull();
    expect((await base.syncGhsa(dir, ["2026/10"], ghsaSha))?.commit).toBe(ghsaSha);
    expect((await base.syncGhsa(dir, ["2026/10"], null))?.commit).toBe(ghsaSha);
  });

  it("an hourly zip that ends before the record window makes cvelist stale, naming the hour, and invents no record (B9)", async () => {
    const hourly = (hhmm: string) => `https://github.com/CVEProject/cvelistV5/releases/download/cve_2026-10-13_${hhmm}Z/2026-10-13_delta_CVEs_at_${hhmm}Z.zip`;
    const feeds = feedsVariant((idx) => { idx[hourly("1900")] = idx[hourly("2000")]!; });
    const refs = JSON.parse(fs.readFileSync(path.join(feeds, "git-refs.json"), "utf8"));
    delete refs.repos["CVEProject/cvelistV5"]["refs/tags/cve_2026-10-13_2000Z"];
    fs.writeFileSync(path.join(feeds, "git-refs.json"), JSON.stringify(refs));
    const log: string[] = [];
    const r = await run(tempRoot(true), { feeds, log });
    const note = "Stale: the CVE List zips read end at 19:00 UTC on 2026-10-13, before the record window ends at 20:00 UTC on 2026-10-13.";
    expect(r.index.feeds.find((f) => f.id === "cvelist")).toMatchObject({ status: "stale", note, version: "cve_2026-10-13_1900Z" });
    expect(r.pack.feeds.find((f) => f.id === "cvelist")).toMatchObject({ ok: true, stale: true });
    expect(r.inputs.cvelist.zips.map((z) => z.asset)).toEqual(["2026-10-12_delta_CVEs_at_end_of_day.zip", "2026-10-13_delta_CVEs_at_1900Z.zip"]);
    expect(log).toContain(`cvelist: ${note}`);
    // The same morning with the 2000Z zip: ok, and the records are the zips' own, never more.
    const full = await run(tempRoot(true));
    expect(full.index.feeds.find((f) => f.id === "cvelist")).toMatchObject({ status: "ok", note: null });
    expect(r.pack.records.length).toBe(full.pack.records.length);
  });

  it("a new dashboard revision makes collect fetch by id the ledger CVE ids the state cannot date, for the metrics (B13)", async () => {
    const LEDGER_ID = "CVE-2026-77206";
    const perIdUrl = "https://raw.githubusercontent.com/CVEProject/cvelistV5/c0de000000000000000000000000000000002013/cves/2026/77xxx/CVE-2026-77206.json";
    // The fixture state has no anthropic-cvd.json, so revision 37 is new: the id is asked for (the fixture CVE List answers 404).
    const urls: string[] = [];
    const log: string[] = [];
    const first = await run(tempRoot(true), { urls, log });
    expect(urls).toContain(perIdUrl);
    expect(first.inputs.cvelist.by_id.not_found).toContain(LEDGER_ID);
    expect(first.inputs.cvelist.by_id.over_cap).toBe(0);
    // The payload lists CVE-2026-77206, -77207, -79610 and -103658; the last is in the end-of-day zip.
    expect(log).toContain("cvelist: 3 ledger ids of revision 37 fetched by id for their dates.");
    // Published by now: the record is fetched, cached for the metrics and listed.
    const feeds = feedsVariant((idx) => { idx[perIdUrl] = { file: "cvelist/by-id/CVE-2026-77206.json", content_type: "application/json" }; });
    const src = fs.readFileSync(path.join(FEEDS, "cvelist", "by-id", "CVE-2024-38112.json"), "utf8");
    fs.writeFileSync(path.join(feeds, "cvelist", "by-id", "CVE-2026-77206.json"), src.replaceAll("CVE-2024-38112", LEDGER_ID));
    const root = tempRoot(true);
    const got = await run(root, { feeds });
    expect(got.inputs.cvelist.by_id.fetched).toContain(LEDGER_ID);
    expect(fs.existsSync(path.join(root, "cache", "cvelist", "records", `${LEDGER_ID}.json`))).toBe(true);
    // The same revision as the state's, already complete: not asked for again.
    const same = tempRoot(true);
    const cvdState = { schema_version: 1, updated_at: "2026-10-11", revision: "37", as_of: "2026-10-13", fetched_at: "2026-10-13T04:37:00+08:00", source_url: "https://red.anthropic.com/2026/cvd", found_n: 5530, disclosed_n: 4812, patched_n: 588, ledger_ids: [LEDGER_ID] };
    fs.writeFileSync(path.join(same, "content", "state", "anthropic-cvd.json"), JSON.stringify(cvdState));
    const sameUrls: string[] = [];
    await run(same, { urls: sameUrls });
    expect(sameUrls).not.toContain(perIdUrl);
    // The same revision, read earlier from the page alone (found_n null): today's payload completes it in the
    // metrics, so its ledger ids are asked for too.
    const completes = tempRoot(true);
    fs.writeFileSync(path.join(completes, "content", "state", "anthropic-cvd.json"), JSON.stringify({ ...cvdState, found_n: null }));
    const completesUrls: string[] = [];
    const completesLog: string[] = [];
    await run(completes, { urls: completesUrls, log: completesLog });
    expect(completesUrls).toContain(perIdUrl);
    expect(completesLog).toContain("cvelist: 3 ledger ids of revision 37 fetched by id for their dates.");
    // A new revision, but credit-candidates.json already dates the id: not asked for.
    const datedRoot = tempRoot(true);
    fs.writeFileSync(path.join(datedRoot, "content", "state", "anthropic-cvd.json"), JSON.stringify({ ...cvdState, revision: "36" }));
    const candidates = { schema_version: 1, updated_at: "2026-10-11", prefilter_sha256: sha256Hex("prefilter"), candidates: [[LEDGER_ID, "2026-09-20", "cna.credits", "SAMPLE Researcher using Claude"]] };
    fs.writeFileSync(path.join(datedRoot, "content", "state", "credit-candidates.json"), JSON.stringify(candidates));
    const datedUrls: string[] = [];
    await run(datedRoot, { urls: datedUrls });
    expect(datedUrls).not.toContain(perIdUrl);
  });

  it("a rerun that dies leaves no inputs.json or index.json from the earlier run (B8)", async () => {
    const root = tempRoot(true);
    const inputs = path.join(root, "cache", "feeds", "inputs.json");
    const index = path.join(root, "cache", "feeds", "index.json");
    await run(root);
    expect(fs.existsSync(inputs) && fs.existsSync(index)).toBe(true);
    let calls = 0;
    const now = () => (++calls > 40 ? T0 + 400_000 : T0);
    await expect(run(root, { now, deadline: T0 + 300_000 })).rejects.toBeInstanceOf(CollectTimeout);
    expect(fs.existsSync(inputs) || fs.existsSync(index)).toBe(false);
    // A write that fails part way (a folder where the pack goes) leaves neither: they are written last.
    await run(root);
    const pack = path.join(root, "packs", `${DATE}.json`);
    fs.rmSync(pack);
    fs.mkdirSync(pack);
    await expect(run(root)).rejects.toThrow();
    expect(fs.existsSync(inputs) || fs.existsSync(index)).toBe(false);
  });

  it("with no state at all it still writes a valid pack; per-id records it cannot find are listed", async () => {
    const root = tempRoot(false);
    const r = await run(root);
    Pack.parse(r.pack);
    expect(r.inputs.cvelist.by_id.not_found.length).toBeGreaterThan(0);
    const log = CandidateLogFile.parse(JSON.parse(readOut(root, `logs/${DATE}.candidates.json`)));
    expect(log.log.map((l) => l.code)).toContain("KEV_INDEX_MISSING");
    expect(r.inputs.cvelist.zips.map((z) => z.asset)).toEqual(["2026-10-12_delta_CVEs_at_end_of_day.zip", "2026-10-13_delta_CVEs_at_2000Z.zip"]);
    expect(fs.existsSync(path.join(root, "content"))).toBe(false);
  });

  it("uses the cisa.gov fallback when the KEV mirror fails", async () => {
    const feeds = feedsVariant((idx) => {
      idx["https://raw.githubusercontent.com/cisagov/kev-data/feed000000000000000000000000000000001013/known_exploited_vulnerabilities.json"] = { status: 503 };
    });
    const r = await run(tempRoot(true), { feeds });
    const kev = r.index.feeds.find((f) => f.id === "kev")!;
    expect(kev).toMatchObject({ status: "ok", fallback_used: true, url_used: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", note: "Fallback URL used." });
    expect(r.inputs.kev?.fallback_used).toBe(true);
    expect(r.candidates.kept.slice(0, 2).map((c) => c.cve_ids[0])).toEqual(NEW_KEV);
  });

  it("index-degraded.json: KEV down on both URLs and 11 of 26 news feeds failing give a degraded pack", async () => {
    const r = await run(tempRoot(true), { feeds: feedsVariant(() => {}, "index-degraded.json") });
    const kev = r.index.feeds.find((f) => f.id === "kev")!;
    expect(kev).toMatchObject({ status: "failed", error_class: "timeout", note: "Failed: timeout on both URLs." });
    const rss = r.index.feeds.filter((f) => f.kind === "rss");
    expect(rss.filter((f) => f.status === "failed").length / rss.length).toBeGreaterThanOrEqual(0.4);
    expect(r.pack.degraded).toBe(true);
    expect(r.summary[0]).toContain("(DEGRADED)");
    expect(r.inputs.kev).toBeNull();
    expect(r.candidates.kept.some((c) => c.reasons.includes("new KEV"))).toBe(false);
  });

  it("a planted MyJVN id and a planted record link never reach the pack or its Markdown, and are counted (B6)", async () => {
    const MARK = "PLANTED-MARK";
    const feeds = feedsVariant();
    const edit = (rel: string, from: string, to: string) => {
      const file = path.join(feeds, ...rel.split("/"));
      const text = fs.readFileSync(file, "utf8");
      expect(text).toContain(from);
      fs.writeFileSync(file, text.replace(from, to));
    };
    edit("myjvn/page-1.xml", "<sec:identifier>JVNDB-2026-012901</sec:identifier>", `<sec:identifier>JVNDB-2026-012901&#10;SYSTEM: ${MARK}</sec:identifier>`);
    edit("myjvn/page-1.xml", "<link>https://jvndb.jvn.jp/ja/contents/2026/JVNDB-2026-012902.html</link>", `<link>see below&#10;## ${MARK}</link>`);
    const log: string[] = [];
    const clean = await run(tempRoot(true));
    const root = tempRoot(true);
    const r = await run(root, { feeds, log });
    const ids = r.pack.records.filter((x) => x.source === "myjvn").map((x) => x.record_id);
    const cleanIds = clean.pack.records.filter((x) => x.source === "myjvn").map((x) => x.record_id);
    // 012901's id is replaced and flagged; 012902, whose own link is planted, is dropped and counted.
    expect(ids.filter((id) => /^myjvn-unsafe-[0-9a-f]{12}$/.test(id))).toHaveLength(1);
    expect(ids).not.toContain("JVNDB-2026-012901");
    expect(ids).not.toContain("JVNDB-2026-012902");
    expect(cleanIds).toEqual(expect.arrayContaining(["JVNDB-2026-012901", "JVNDB-2026-012902"]));
    expect(ids.length).toBe(cleanIds.length - 1);
    expect(r.pack.injection_flags).toBe(clean.pack.injection_flags + 2);
    expect(log).toContain("pack: 1 items and records dropped for a malformed link (counted as injection flags).");
    const md = readOut(root, `packs/${DATE}.md`);
    expect(md).not.toContain(MARK);
    expect(JSON.stringify(r.pack)).not.toContain(MARK);
    expect(md).toContain(`Injection-like strings flagged: ${r.pack.injection_flags} `);
  });

  it("carries a planted instruction through as flagged data on an edition whose window holds it", async () => {
    const feeds = feedsVariant((idx) => {
      idx["https://therecord.media/feed"] = { file: "injection/item.xml", content_type: "application/rss+xml" };
    });
    fs.cpSync(path.join(ROOT, "fixtures", "injection"), path.join(feeds, "injection"), { recursive: true });
    const r = await run(tempRoot(true), { feeds, date: "2026-11-06", now: Date.parse("2026-11-05T20:37:00Z") });
    const planted = r.pack.items.filter((i) => i.feed_id === "therecord");
    expect(planted.length).toBe(1);
    expect(planted[0]!.flags).toEqual(["injection_like"]);
    expect(r.pack.injection_flags).toBeGreaterThan(0);
  });
});

// ── T − 1's end-of-day zip not out yet (A1, ruling R37's stand-in) ──────────────────────────────

describe("T − 1's end-of-day zip not out yet: its newest hourly zip stands in (A1)", () => {
  /** 08:25 Taipei on D, 00:25 UTC on D (T = D): the hour of Kobol's timed dry run of 2026-11-11. */
  const EARLY = Date.parse("2026-10-14T00:25:00Z");
  const release = (tag: string, asset: string) => `https://github.com/CVEProject/cvelistV5/releases/download/${tag}/${asset}`;
  const eodUrl = (d: string) => release(`cve_${d}_at_end_of_day`, `${d}_delta_CVEs_at_end_of_day.zip`);
  const hourlyUrl = (d: string, hhmm: string) => release(`cve_${d}_${hhmm}Z`, `${d}_delta_CVEs_at_${hhmm}Z.zip`);
  const EOD = (d: string) => `${d}_delta_CVEs_at_end_of_day.zip`;

  /** git-refs.json in a feeds copy, its CVE List refs edited. */
  const editRefs = (feeds: string, edit: (refs: Record<string, string>) => void) => {
    const file = path.join(feeds, "git-refs.json");
    const refs = JSON.parse(fs.readFileSync(file, "utf8")) as { repos: Record<string, Record<string, string>> };
    edit(refs.repos[REPOS.cvelist]!);
    fs.writeFileSync(file, JSON.stringify(refs, null, 2));
  };

  /** fixtureGit over `feeds`, recording each CVE List ls-remote's patterns; a list of only `failTags`'s tags answers null. */
  const recordingGit = (feeds: string, lists: string[][], failTags: string | null = null): GitSource => {
    const base = fixtureGit(feeds);
    return {
      ...base,
      lsRemote: async (repo, patterns) => {
        if (repo === REPOS.cvelist) lists.push([...patterns]);
        if (failTags && patterns.length === 1 && patterns[0] === `refs/tags/cve_${failTags}_*`) return null;
        return base.lsRemote(repo, patterns);
      },
    };
  };

  const go = (root: string, feeds: string, git: GitSource, log: string[], at = EARLY) => {
    process.env.CT_FIXTURE_FEEDS = feeds;
    return collect({ date: DATE, deadline: at + 300_000, root, deps: { now: () => at, aiMatch, fetch: fetchFeed, git, log: (l) => log.push(l) } });
  };
  const cvelist = (r: Awaited<ReturnType<typeof collect>>) => r.index.feeds.find((f) => f.id === "cvelist")!;

  it("a run at 00:25 UTC on D reads D − 1's newest hourly zip for its end-of-day zip, and cvelist is ok", async () => {
    const feeds = feedsVariant((idx) => { idx[eodUrl("2026-10-13")] = { status: 404 }; });
    const lists: string[][] = [];
    const log: string[] = [];
    const r = await go(tempRoot(true), feeds, recordingGit(feeds, lists), log);
    // T's own tags first (none yet for 14 Oct in the fixture world), then D − 1's after the 404.
    expect(lists).toEqual([["refs/heads/main", "refs/tags/cve_2026-10-14_*"], ["refs/tags/cve_2026-10-13_*"]]);
    expect(log).toContain(`cvelist: ${EOD("2026-10-13")} is not out yet (HTTP 404); read cve_2026-10-13_2000Z instead, so the records changed after 20:00 UTC on 2026-10-13 wait for a later run.`);
    expect(cvelist(r)).toMatchObject({ status: "ok", error_class: null, note: null });
    expect(r.pack.degraded).toBe(false);
    expect(r.summary.join("\n")).not.toMatch(/cvelist/);
    expect(r.inputs.cvelist.zips.map((z) => [z.asset, z.kind, z.utc_day])).toEqual([
      [EOD("2026-10-12"), "end_of_day", "2026-10-12"], ["2026-10-13_delta_CVEs_at_2000Z.zip", "hourly", "2026-10-13"],
    ]);
    // The cutoff day counts with D − 1's hourly copy as its X + 1 zip, as every morning counts it with T's.
    expect(r.inputs.cvelist.days).toEqual([{ date: "2026-10-12", zips: [EOD("2026-10-12"), "2026-10-13_delta_CVEs_at_2000Z.zip"], ok: true }]);
    const morning = await run(tempRoot(true));
    const cves = (x: typeof r) => x.pack.records.filter((p) => p.source === "cvelist").map((p) => p.record_id);
    expect(cves(r)).toEqual(cves(morning));
    expect(cves(r).length).toBeGreaterThan(0);
  });

  it("when D − 1's tags cannot be listed either, cvelist fails as before and the log says why", async () => {
    const feeds = feedsVariant((idx) => { idx[eodUrl("2026-10-13")] = { status: 404 }; });
    const lists: string[][] = [];
    const log: string[] = [];
    const r = await go(tempRoot(true), feeds, recordingGit(feeds, lists, "2026-10-13"), log);
    expect(lists[1]).toEqual(["refs/tags/cve_2026-10-13_*"]);
    expect(log).toContain(`cvelist: ${EOD("2026-10-13")} is not out yet (HTTP 404), and the hourly tags of 2026-10-13 could not be listed, so no hourly zip stands in for it.`);
    expect(cvelist(r)).toMatchObject({ status: "failed", error_class: "http_404" });
    expect(r.pack.degraded).toBe(true);
    expect(r.inputs.cvelist.days).toEqual([{ date: "2026-10-12", zips: [EOD("2026-10-12"), EOD("2026-10-13")], ok: false }]);
  });

  it("on a morning whose cutoff end-of-day zip is late, the stand-in day is not counted and the hour no zip covers makes cvelist stale", async () => {
    // T = D − 1 (20:37 UTC on 13 Oct): the cutoff, 12 Oct, is T − 1, and its end-of-day zip answers 404.
    const feeds = feedsVariant((idx) => {
      idx[eodUrl("2026-10-12")] = { status: 404 };
      idx[hourlyUrl("2026-10-12", "2300")] = { file: `cvelist/zips/${EOD("2026-10-12")}`, content_type: "application/zip" };
    });
    editRefs(feeds, (refs) => { refs["refs/tags/cve_2026-10-12_2300Z"] = "c0de000000000000000000000000000000002300"; });
    const lists: string[][] = [];
    const log: string[] = [];
    const r = await go(tempRoot(true), feeds, recordingGit(feeds, lists), log, T0);
    expect(lists[1]).toEqual(["refs/tags/cve_2026-10-12_*"]);
    expect(r.inputs.cvelist.zips.map((z) => [z.asset, z.kind])).toEqual([["2026-10-12_delta_CVEs_at_2300Z.zip", "hourly"], ["2026-10-13_delta_CVEs_at_2000Z.zip", "hourly"]]);
    // 12 Oct was read only from an hourly zip: not ok, so it stays missing and a later run counts it from its end-of-day zip.
    expect(r.inputs.cvelist.days).toEqual([{ date: "2026-10-12", zips: [EOD("2026-10-12"), "2026-10-13_delta_CVEs_at_2000Z.zip"], ok: false }]);
    const note = "Stale: the CVE List zips read end at 23:00 UTC on 2026-10-12, before the record window ends at 20:00 UTC on 2026-10-13.";
    expect(cvelist(r)).toMatchObject({ status: "stale", note });
    expect(log).toContain(`cvelist: ${note}`);
    expect(log).toContain(`cvelist: ${EOD("2026-10-12")} is not out yet (HTTP 404); read cve_2026-10-12_2300Z instead, so the records changed after 23:00 UTC on 2026-10-12 wait for a later run.`);
    expect(r.pack.degraded).toBe(false);
  });

  it("an older missing end-of-day zip (a catch-up day) has no stand-in and stays as before", async () => {
    const feeds = feedsVariant((idx) => {
      idx[eodUrl("2026-10-11")] = { status: 404 };
      idx[eodUrl("2026-10-13")] = { status: 404 };
    });
    const root = tempRoot(true);
    const daysFile = path.join(root, "content", "state", "days.json");
    const days = JSON.parse(fs.readFileSync(daysFile, "utf8")) as { days: [string, ...unknown[]][] };
    days.days = days.days.filter((d) => d[0] !== "2026-10-11");
    fs.writeFileSync(daysFile, JSON.stringify(days));
    const lists: string[][] = [];
    const log: string[] = [];
    const r = await go(root, feeds, recordingGit(feeds, lists), log);
    expect(lists).toEqual([["refs/heads/main", "refs/tags/cve_2026-10-14_*"], ["refs/tags/cve_2026-10-13_*"]]);
    expect(log.filter((l) => l.includes("is not out yet"))).toEqual([expect.stringContaining(EOD("2026-10-13"))]);
    expect(r.inputs.cvelist.days).toEqual([
      { date: "2026-10-11", zips: [EOD("2026-10-11"), EOD("2026-10-12")], ok: false },
      { date: "2026-10-12", zips: [EOD("2026-10-12"), "2026-10-13_delta_CVEs_at_2000Z.zip"], ok: true },
    ]);
    expect(cvelist(r)).toMatchObject({ status: "ok" });
  });
});

// ── The command line (R47) ───────────────────────────────────────────────────────────────────────

describe("the command line", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };

  it("exits 2 on usage errors", async () => {
    for (const argv of [["--date", "2026-13-01"], ["--date"], ["--bogus"], ["--json"], ["--id", "kev"], ["--check-feeds", "--id"]]) {
      const c = io();
      expect(await main(argv, { io: c.io, env: { NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv, root: tempRoot(false) }), argv.join(" ")).toBe(2);
      expect(c.err.join("\n")).toMatch(/Usage:/);
    }
  });

  it.skipIf(!wp4Ready)("exits 0 when the pack is written, degraded or not (needs WP4's matchRecord)", async () => {
    process.env.CT_FIXTURE_FEEDS = FEEDS;
    const root = tempRoot(true);
    const c = io();
    expect(await main(["--date", DATE], { io: c.io, env: process.env, root })).toBe(0);
    expect(c.out[0]).toMatch(/^Pack 2026-10-14: /);
    expect(fs.existsSync(path.join(root, "packs", `${DATE}.json`))).toBe(true);
  });

  it("CT_FIXTURE_FEEDS outside a test run exits 2 and writes nothing", async () => {
    const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
    expect(() => fixtureGuard(env({ CT_FIXTURE_FEEDS: FEEDS }))).toThrow(FixtureGuardError);
    expect(() => fixtureGuard(env({ CT_FIXTURE_FEEDS: FEEDS }), true)).not.toThrow();
    expect(() => fixtureGuard(env({ CT_FIXTURE_FEEDS: FEEDS, NODE_ENV: "test" }))).not.toThrow();
    expect(() => fixtureGuard(env({ NODE_ENV: "production" }))).not.toThrow();
    const root = tempRoot(false);
    const c = io();
    expect(await main(["--date", DATE], { io: c.io, env: env({ CT_FIXTURE_FEEDS: FEEDS }), root })).toBe(2);
    expect(c.err.join("\n")).toContain("CT_FIXTURE_FEEDS");
    expect(written(root)).toEqual([]);
  });

  it("the real process exits 2 with CT_FIXTURE_FEEDS set and NODE_ENV unset", () => {
    const root = tempRoot(false);
    const { NODE_ENV: _node, VITEST: _vitest, ...rest } = process.env;
    const env = { ...rest, CT_FIXTURE_FEEDS: FEEDS } as unknown as NodeJS.ProcessEnv;
    const r = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "scripts", "collect.ts"), "--date", DATE], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("CT_FIXTURE_FEEDS");
    expect(written(root)).toEqual([]);
  });
});
