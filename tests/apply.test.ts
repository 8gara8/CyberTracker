// applyDraft() and releaseBlockOf() (SPEC §4.4 to §4.6, §4.9, §4.10, §8.7 step 4; plan L3, amendments A5
// and A6): the weekday and Monday worlds rebuilt from the fixture drafts, contexts, evidence, metrics and
// CVE records with site.ts's times and history must equal fixtures/site-content, and pass the validator.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ComposeError, applyDraft, claimReading, firstSeenOf, claimStatus, claimZone, cveBlockOf, linkDisputes, markCorrected, releaseBlockOf,
  updateArchiveIndex, updateScoreboard, type ApplyInput, type CveFacts, type SnapshotHashes,
} from "@/lib/apply";
import type { LoadedConfig } from "@/lib/config";
import { addDays } from "@/lib/dates";
import { longDate } from "@/lib/format";
import { jsonText, sha256Hex } from "@/lib/json";
import { regionsConfig } from "@/lib/regions";
import { firstSeenBefore, readHistory } from "@/lib/run-inputs";
import type { CveLookup } from "@/lib/rules/types";
import { Brief } from "@/lib/schema/brief";
import { AgentContext } from "@/lib/schema/context";
import { DraftBrief } from "@/lib/schema/draft-brief";
import { InputsManifest, Metrics, type KevIndexFile } from "@/lib/schema/metrics";
import { ArchiveIndex, CorrectionsFile, Evidence, type Correction, type Dispute } from "@/lib/schema/misc";
import { ScoreboardFile, type Claim } from "@/lib/schema/scoreboard";
import { normalizeUrl } from "@/lib/urls";
import { cveLookupFromDir, validateAll, validatePublished } from "@/lib/validate";
import { WITHHELD_HEADLINE, WITHHELD_MARK, WITHHELD_TEXT } from "@/lib/vocab";
import { NAME_REMOVED_BEFORE, WITHHOLD_TEXTS } from "@/lib/withhold";
import { bindingWithholds, withheldRefs } from "@/lib/withhold-mask";
import { CVE_RECORDS_DIR, editionRegionsInput, fixtureConfig } from "@/fixtures/src/inputs";
import { SOURCES, EDITIONS, FIXTURES_DIR, KEV_DUE, KEV_ROWS, RECORD_IDS, cveRecord, type EditionName } from "@/fixtures/src/world";

const SITE = path.join(FIXTURES_DIR, "site-content");
const read = (p: string): unknown => JSON.parse(fs.readFileSync(p, "utf8"));
const cfg = fixtureConfig();
const BRIEFS = fs.readdirSync(path.join(SITE, "briefs")).sort().map((f) => Brief.parse(read(path.join(SITE, "briefs", f))));
const golden = (date: string) => structuredClone(BRIEFS.find((b) => b.date === date)!);
const GOLDEN_BOARD = ScoreboardFile.parse(read(path.join(SITE, "scoreboard.json")));
const GOLDEN_ARCHIVE = ArchiveIndex.parse(read(path.join(SITE, "archive-index.json")));
const GOLDEN_CORRECTIONS = CorrectionsFile.parse(read(path.join(SITE, "corrections.json")));

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
function siteCopy(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-apply-"));
  tmpDirs.push(dir);
  fs.cpSync(SITE, dir, { recursive: true });
  return dir;
}

function kevIndexAt(version: string): KevIndexFile {
  const through = version.replace(/\./g, "-");
  return { schema_version: 1, updated_at: through, catalog_version: version, entries: KEV_ROWS.filter((r) => r[1] <= through).map((r) => [...r] as KevIndexFile["entries"][number]) };
}

/** site.ts's CVE facts: the fixture records, the KEV rows of the catalog version, KEV_DUE or added + 21 days, no EPSS or GHSA. */
function siteFacts(version: string): CveFacts {
  const idx = kevIndexAt(version);
  return {
    record: (id) => (RECORD_IDS.includes(id) ? cveRecord(id) : null),
    kev: (id) => {
      const r = idx.entries.find((x) => x[0] === id);
      return r ? { dateAdded: r[1], dueDate: KEV_DUE[id] ?? addDays(r[1], 21), ransomware: r[6], catalogVersion: version } : null;
    },
    epss: () => null,
    ghsaIds: () => [],
  };
}

/** The archive index as it stood before D (inclusive: through D), with D's new URLs never checked yet. */
function archiveThrough(date: string, inclusive: boolean): ArchiveIndex {
  const keep = (d: string) => (inclusive ? d <= date : d < date);
  const urls: ArchiveIndex["urls"] = {};
  for (const [u, e] of Object.entries(GOLDEN_ARCHIVE.urls)) {
    if (!keep(e.first_cited)) continue;
    urls[u] = { ...structuredClone(e), item_ids: e.item_ids.filter((x) => keep(x.slice(0, 10))), last_check: e.first_cited === date ? null : e.last_check };
  }
  return { schema_version: 1, editions: GOLDEN_ARCHIVE.editions.filter((e) => keep(e.date)), urls };
}

/** scoreboard.json as it stood after the edition before D. */
function boardBefore(date: string): ScoreboardFile {
  const entries = GOLDEN_BOARD.entries.filter((e) => e.date < date);
  return {
    ...structuredClone(GOLDEN_BOARD), as_of: addDays(date, -1), entries,
    claims: GOLDEN_BOARD.claims.map((c) => ({ ...c, last_entry_id: [...entries].reverse().find((e) => e.claim_id === c.id)?.id ?? null })),
  };
}

/** The publish times of the sample's full editions (site.ts's run plans). */
const TIMES: Record<"weekday" | "monday", { published: string; dataOnly: string }> = {
  weekday: { published: "2026-10-14T05:07:44+08:00", dataOnly: "2026-10-14T04:48:02+08:00" },
  monday: { published: "2026-10-12T05:05:52+08:00", dataOnly: "2026-10-12T04:47:55+08:00" },
};

/**
 * A fixture world's ApplyInput (plan C1): the draft, context and evidence fixtures, site-content's
 * metrics, manifest and earlier briefs (newest first, the withholds already in them), the weekday
 * signals, KEV rows through the edition's catalog, and the snapshots site-content's archive index records.
 */
function world(name: "weekday" | "monday", history: readonly Brief[] = BRIEFS): ApplyInput {
  const t = EDITIONS[name as EditionName];
  const D = t.date;
  const mText = fs.readFileSync(path.join(SITE, "metrics", `${D}.json`), "utf8");
  const kevIndex = kevIndexAt(t.kev.version);
  const past = history.filter((b) => b.date < D).reverse();
  const snapshots: Record<string, { sha256: string; fetched_at: string }> = {};
  for (const [u, e] of Object.entries(GOLDEN_ARCHIVE.urls)) {
    if (e.first_cited === D && e.sha256 && e.hashed_at) snapshots[u] = { sha256: e.sha256, fetched_at: e.hashed_at };
  }
  const corrections = structuredClone(GOLDEN_CORRECTIONS);
  const before = (c: { date: string }) => c.date < D;
  return {
    date: D, config: cfg, metrics: Metrics.parse(JSON.parse(mText)), kevIndex, history: past,
    regionsBase: { date: D, history: past, signals: editionRegionsInput(name).signals, kevIndex, config: regionsConfig(cfg) },
    archiveIndex: archiveThrough(D, false),
    scoreboard: boardBefore(D),
    corrections: corrections.corrections.some(before) ? { ...corrections, corrections: corrections.corrections.filter(before) } : null,
    feedsStale: [], publishedAt: TIMES[name].published, generatedAt: t.generatedAt,
    edition: "full",
    draft: DraftBrief.parse(read(path.join(FIXTURES_DIR, "drafts", `valid-${name}.json`))),
    context: AgentContext.parse(read(path.join(FIXTURES_DIR, "context", `${name}.json`))),
    evidence: Evidence.parse(read(path.join(FIXTURES_DIR, "evidence", `${name}.json`))),
    cveList: cveLookupFromDir(CVE_RECORDS_DIR),
    snapshots: snapshots as SnapshotHashes,
    dataOnlyPublishedAt: TIMES[name].dataOnly,
    disputes: corrections.disputes.filter((d) => d.received < `${D}T00:00:00+08:00`),
    recheck: null,
    facts: siteFacts(t.kev.version),
    inputs: InputsManifest.parse(read(path.join(SITE, "metrics", "inputs", `${D}.json`))),
    metricsSha256: sha256Hex(mText),
  };
}

/** A6's release title: the vendor source's title, where site.ts hard-codes the release's own name. */
const MSRC_TITLE = SOURCES["msrc-october"].title;
function weekdayExpected(): Brief {
  const b = golden("2026-10-14");
  expect(b.items[1]!.release!.title).toBe("October 2026 Security Update");
  b.items[1]!.release!.title = MSRC_TITLE;
  return b;
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, p), text);
}

describe("applyDraft on the fixture worlds", { timeout: 120_000 }, () => {
  const weekday = applyDraft(world("weekday"));

  it("C1: the weekday world equals site-content's 2026-10-14 brief (release title per A6)", () => {
    expect(weekday.brief).toEqual(weekdayExpected());
    expect(weekday.rewritten).toEqual([]);
    expect(weekday.corrections).toBeNull();
    expect(weekday.flagCorrections).toEqual([]);
  });

  it("C2: the brief passes validatePublished, and validateAll with { publishing } in a copy of site-content", () => {
    const metrics = Metrics.parse(read(path.join(SITE, "metrics", "2026-10-14.json")));
    const one = validatePublished(weekday.brief, { metrics, config: cfg });
    expect(one.errors).toEqual([]);
    const dir = siteCopy();
    writeTree(dir, { "briefs/2026-10-14.json": jsonText(weekday.brief, Brief) });
    const all = validateAll(dir, { publishing: "2026-10-14", config: cfg });
    expect(all.errors).toEqual([]);
  });

  it("C9: the archive index gains D's URLs and item references, with snapshot hashes, editions newest first", () => {
    expect(weekday.archiveIndex).toEqual(archiveThrough("2026-10-14", true));
    expect(weekday.archiveIndex.editions.map((e) => e.date)).toEqual([...weekday.archiveIndex.editions.map((e) => e.date)].sort().reverse());
    const i = world("weekday");
    for (const s of weekday.brief!.sources) {
      const e = weekday.archiveIndex.urls[normalizeUrl(s.url)]!;
      if (e.first_cited !== "2026-10-14") continue;
      expect([e.sha256, e.hashed_at]).toEqual([i.snapshots[normalizeUrl(s.url)]?.sha256 ?? null, i.snapshots[normalizeUrl(s.url)]?.fetched_at ?? null]);
    }
  });

  it("C9: item_ids keep the 20 newest, newest last; a rerun of D gives the same index", () => {
    const i = world("weekday");
    const url = normalizeUrl(weekday.brief!.sources[0]!.url);
    const old = Array.from({ length: 25 }, (_, k) => `2026-09-${String(k + 1).padStart(2, "0")}/old-item-${k}`);
    const prev = structuredClone(i.archiveIndex!);
    prev.urls[url] = { first_cited: "2026-09-01", item_ids: old, sha256: null, hashed_at: null, last_check: null };
    const out = applyDraft({ ...i, archiveIndex: prev }).archiveIndex.urls[url]!;
    const mine = weekday.brief!.items.filter((it) => it.source_ids.includes(weekday.brief!.sources[0]!.id)).map((it) => `2026-10-14/${it.id}`);
    expect(out.item_ids).toHaveLength(20);
    expect(out.item_ids.slice(-mine.length)).toEqual(mine);
    expect(out.item_ids.slice(0, 20 - mine.length)).toEqual(old.slice(-(20 - mine.length)));
    expect(out.first_cited).toBe("2026-09-01");
    expect(mine.length).toBeGreaterThan(0);
    const again = updateArchiveIndex(weekday.archiveIndex, weekday.brief!, i.snapshots, GOLDEN_CORRECTIONS.corrections);
    expect(again).toEqual(weekday.archiveIndex);
    // A URL first cited on D that D's new brief no longer cites goes; an edition is listed once.
    const extra = structuredClone(weekday.archiveIndex);
    extra.urls["https://example.org/ct-sample/dropped"] = { first_cited: "2026-10-14", item_ids: ["2026-10-14/gone"], sha256: null, hashed_at: null, last_check: null };
    const redone = updateArchiveIndex(extra, weekday.brief!, i.snapshots, []);
    expect(redone.urls["https://example.org/ct-sample/dropped"]).toBeUndefined();
    expect(redone.editions.filter((e) => e.date === "2026-10-14")).toHaveLength(1);
  });

  it("C10: the report entry, the claim states and the brief's Scoreboard block", () => {
    const want = boardBefore("2026-10-15");
    expect(weekday.scoreboard).toEqual({ ...want, as_of: "2026-10-14" });
    expect(weekday.brief!.scoreboard.entries.map((e) => [e.id, e.origin, e.direction, e.source_url])).toEqual([
      ["SE-0002", "report", "neutral", "https://www.ncsc.gov.uk/ct-sample/annual-review-2026"],
    ]);
    expect(weekday.brief!.scoreboard.last?.entry_id).toBe("SE-0001");
    // A rerun of the same date replaces the date's report entries rather than adding more.
    const rerun = applyDraft({ ...world("weekday"), scoreboard: weekday.scoreboard });
    expect(rerun.scoreboard).toEqual(weekday.scoreboard);
  });

  it("C12: late and data_only_published_at come from the times passed in", () => {
    expect(weekday.brief!.late).toBe(false);
    expect(weekday.brief!.data_only_published_at).toBe("2026-10-14T04:48:02+08:00");
    const late = applyDraft({ ...world("weekday"), publishedAt: "2026-10-14T08:00:01+08:00", dataOnlyPublishedAt: null });
    expect(late.brief!.late).toBe(true);
    expect(late.brief!.published_at).toBe("2026-10-14T08:00:01+08:00");
    expect(late.brief!.data_only_published_at).toBeNull();
    expect(late.archiveIndex.editions.find((e) => e.date === "2026-10-14")?.published_at).toBe("2026-10-14T08:00:01+08:00");
  });

  it("C13: the same input gives byte-identical files, and the input is never changed", () => {
    const i = world("weekday");
    const before = JSON.stringify(i.draft);
    const a = applyDraft(i);
    const b = applyDraft(world("weekday"));
    expect(jsonText(a.brief, Brief)).toBe(jsonText(b.brief, Brief));
    expect(jsonText(a.scoreboard, ScoreboardFile)).toBe(jsonText(b.scoreboard, ScoreboardFile));
    expect(jsonText(a.archiveIndex, ArchiveIndex)).toBe(jsonText(b.archiveIndex, ArchiveIndex));
    expect(JSON.stringify(i.draft)).toBe(before);
  });

  it("C16: the Microsoft release block comes from the vendor source and the candidate's counts", () => {
    const i = world("weekday");
    const item = i.draft.items.find((it) => it.kind === "patch_batch")!;
    const cand = i.context.candidates.find((c) => c.release?.release_id === item.release_id)!.release!;
    const block = weekday.brief!.items.find((it) => it.id === item.id)!.release!;
    expect(block).toEqual({
      release_id: "rel-microsoft-2026-10", vendor: { id: "microsoft", name: "Microsoft", country: "US" }, date: "2026-10-13",
      title: MSRC_TITLE, fixes_n: cand.total, critical_n: cand.critical, exploited_n: cand.exploited,
      exploited_cve_ids: cand.exploited_cve_ids, counted_from: "cve_list", source_url: SOURCES["msrc-october"].url,
    });
    expect(validatePublished(weekday.brief, { metrics: i.metrics, config: cfg }).ok).toBe(true);
    // Counts are the candidate's, never the item's CVE count.
    const bigger = { ...cand, total: 1500, critical: null, exploited: 3 };
    expect(releaseBlockOf(item, bigger, weekday.brief!.sources, cfg, i.cveList)).toMatchObject({ fixes_n: 1500, critical_n: null, exploited_n: 3 });
    // No vendor source: the fixed title, the first bundled record's page and the newest record date.
    const noVendor = { ...item, source_ids: item.source_ids.filter((sid) => weekday.brief!.sources.find((s) => s.id === sid)!.publisher !== "vendor:microsoft") };
    const fallback = releaseBlockOf(noVendor, cand, weekday.brief!.sources, cfg, i.cveList)!;
    const recordDate = i.cveList.get(cand.exploited_cve_ids[0]!)!.date_published!;
    expect(fallback).toMatchObject({
      title: `Microsoft security updates, ${recordDate.slice(0, 7)}`, date: recordDate,
      source_url: `https://www.cve.org/CVERecord?id=${cand.exploited_cve_ids[0]}`,
    });
    expect(releaseBlockOf({ ...item, release_id: null }, cand, weekday.brief!.sources, cfg)).toBeNull();
    expect(releaseBlockOf(item, null, weekday.brief!.sources, cfg)).toBeNull();
  });

  it("C16: with no dated vendor source and no bundled record, releaseBlockOf throws ComposeError, and applyDraft passes it on", () => {
    const i = world("weekday");
    const item = i.draft.items.find((it) => it.kind === "patch_batch")!;
    const cand = i.context.candidates.find((c) => c.release?.release_id === item.release_id)!.release!;
    const pressOnly = { ...item, source_ids: item.source_ids.filter((sid) => weekday.brief!.sources.find((s) => s.id === sid)!.publisher !== "vendor:microsoft") };
    // No date: the vendor source is gone and no record of the bundle is known.
    const noDate = () => releaseBlockOf(pressOnly, cand, weekday.brief!.sources, cfg, null);
    expect(noDate).toThrow(ComposeError);
    expect(noDate).toThrow(`No release date for ${cand.release_id}: no vendor source with a date and no bundled record`);
    // No page: an empty bundle (no exploited CVE, no item CVE) with no vendor source, even when the date would come from a record.
    const dated: CveLookup = { get: () => ({ state: "PUBLISHED", date_published: "2026-10-13" }) as ReturnType<CveLookup["get"]> };
    expect(() => releaseBlockOf({ ...pressOnly, cve_ids: [] }, { ...cand, exploited_cve_ids: [] }, weekday.brief!.sources, cfg, dated)).toThrow(ComposeError);
    // The vendor source without a published_at and no record: no date either.
    const undated = weekday.brief!.sources.map((s) => (s.publisher === "vendor:microsoft" ? { ...s, published_at: null } : s));
    expect(() => releaseBlockOf(item, cand, undated, cfg, null)).toThrow(/^No release date/);
    // applyDraft lets ComposeError through unchanged, for publish to report as PublishError("compose").
    const undatedDraft = { ...i.draft, sources: i.draft.sources.map((s) => (s.url === SOURCES["msrc-october"].url ? { ...s, published_at: null } : s)) };
    expect(undatedDraft.sources.filter((s) => s.published_at === null && s.url === SOURCES["msrc-october"].url)).toHaveLength(1);
    const err = (() => {
      try {
        applyDraft({ ...i, draft: undatedDraft, cveList: { get: () => undefined } });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ComposeError);
  });
});

describe("first_seen over every stored brief (XREF_FIRST_SEEN)", { timeout: 120_000 }, () => {
  it("C17: an item first seen more than 30 days before D keeps that date, as validateAll's XREF_FIRST_SEEN reads it", () => {
    const i = world("weekday");
    const D = i.date;
    const id = i.draft.items[0]!.id;
    const OLD = addDays(D, -40);
    // A content folder holding site-content's briefs and one more, 40 days back, that holds the same item.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-first-seen-"));
    try {
      fs.cpSync(path.join(SITE, "briefs"), path.join(dir, "briefs"), { recursive: true });
      const old = { ...golden(D), date: OLD, items: golden(D).items.filter((it) => it.id === id).map((it) => ({ ...it, first_seen: OLD })) };
      fs.writeFileSync(path.join(dir, "briefs", `${OLD}.json`), jsonText(Brief.parse(old), Brief));
      fs.writeFileSync(path.join(dir, "briefs", "notes.json"), "{}\n");
      fs.writeFileSync(path.join(dir, "briefs", `${addDays(D, -41)}.json`), "not json\n");
      const all = firstSeenBefore(dir, D);
      expect(all.get(id)).toBe(OLD);
      // The 30-day history alone misses it, which is what made the published first_seen D.
      expect(firstSeenOf(readHistory(dir, D, 30)).get(id)).not.toBe(OLD);
      // Only briefs before D count, and every item of them is listed with its earliest date.
      expect([...all.values()].every((d) => d < D)).toBe(true);
      expect(firstSeenBefore(dir, OLD).size).toBe(0);
      expect(firstSeenBefore(path.join(dir, "missing"), D).size).toBe(0);

      const withAll = applyDraft({ ...i, firstSeen: all }).brief!;
      expect(withAll.items.find((it) => it.id === id)!.first_seen).toBe(OLD);
      const without = applyDraft(i).brief!;
      // Unchanged for the other items: the map agrees with the history wherever both know the id.
      for (const it of withAll.items) {
        if (it.id !== id) expect(it.first_seen, it.id).toBe(without.items.find((x) => x.id === it.id)!.first_seen);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a withhold binds the editions after it (§4.10)", { timeout: 120_000 }, () => {
  const D = "2026-10-14";
  const TRANSPORT = "inc-transport-jp-2026-10";
  const CAMPAIGN = "camp-tw-semiconductor-2026-10";
  const FLAW = "cve-2026-108917";
  const HEALTH = "inc-health-us-2026-10";

  /** The weekday world with one more name_removed correction, C-0003, and its dispute D-0002. */
  function withWithhold(o: { item: string; edition: string; kind: "victim" | "attribution"; date?: string }): ApplyInput {
    const i = world("weekday");
    const text = WITHHOLD_TEXTS[o.kind];
    const dispute: Dispute = {
      id: "D-0002", received: "2026-10-13T22:00:00+08:00", issue_number: 9, item_id: o.item, edition_date: o.edition, kind: o.kind,
      evidence_url: null, status: "open", resolved_on: null, correction_id: "C-0003",
    };
    const correction: Correction = {
      id: "C-0003", date: o.date ?? D, item_id: o.item, edition_date: o.edition, type: "name_removed", field: text.field,
      before: NAME_REMOVED_BEFORE, after: text.after, reason: text.reason, source_url: null, trigger: "reader_report", dispute_id: "D-0002",
    };
    const cf = structuredClone(GOLDEN_CORRECTIONS);
    i.corrections = { schema_version: 1, corrections: [...cf.corrections, correction], disputes: [...cf.disputes, dispute] };
    i.disputes = [...(i.disputes ?? []), dispute];
    return i;
  }
  const withStatus = (i: ApplyInput, status: Dispute["status"]): ApplyInput => ({
    ...i, disputes: i.disputes!.map((d) => (d.id === "D-0002" ? { ...d, status, resolved_on: D } : d)),
  });

  it("C18: bindingWithholds keeps name_removed corrections whose dispute is open or upheld; intake's statuses win", () => {
    const i = withWithhold({ item: FLAW, edition: "2026-10-13", kind: "victim" });
    expect(bindingWithholds(i.corrections, i.disputes)).toEqual([
      { item_id: HEALTH, edition_date: "2026-10-12", kind: "victim", correction_id: "C-0001", since: "2026-10-13" },
      { item_id: FLAW, edition_date: "2026-10-13", kind: "victim", correction_id: "C-0003", since: D },
    ]);
    expect(bindingWithholds(i.corrections, withStatus(i, "upheld").disputes).map((w) => w.correction_id)).toEqual(["C-0001", "C-0003"]);
    for (const s of ["rejected", "withdrawn"] as const) {
      expect(bindingWithholds(i.corrections, withStatus(i, s).disputes).map((w) => w.correction_id)).toEqual(["C-0001"]);
      // Without intake's list, corrections.json's statuses decide.
      const stored = { ...i.corrections!, disputes: [...withStatus(i, s).disputes!] };
      expect(bindingWithholds(stored, null).map((w) => w.correction_id)).toEqual(["C-0001"]);
    }
    // A correction whose dispute neither list holds binds (the safe side), its kind from the field; a clarification never.
    const orphan = { ...i.corrections!, corrections: i.corrections!.corrections.map((c) => (c.id === "C-0003" ? { ...c, field: "attribution" } : c)), disputes: [] };
    expect(bindingWithholds(orphan, []).map((w) => [w.correction_id, w.kind])).toEqual([["C-0001", "victim"], ["C-0003", "attribution"]]);
    expect(bindingWithholds(null, i.disputes)).toEqual([]);
  });

  it("C18: withheldRefs covers each withhold's own item and every stored item whose withheld names it", () => {
    const i = withWithhold({ item: FLAW, edition: "2026-10-13", kind: "victim" });
    const binding = bindingWithholds(i.corrections, i.disputes);
    const later = { date: "2026-10-13", items: [{ ...golden(D).items[0]!, withheld: { correction_id: "C-0001", since: "2026-10-13" } }] };
    const stale = { date: "2026-10-13", items: [{ ...golden(D).items[1]!, withheld: { correction_id: "C-0099", since: "2026-10-13" } }] };
    const refs = withheldRefs(binding, [...i.history, later, stale]);
    expect([...refs.keys()].sort()).toEqual([`2026-10-12/${HEALTH}`, `2026-10-13/${FLAW}`, `2026-10-13/${golden(D).items[0]!.id}`].sort());
    expect(refs.get(`2026-10-13/${golden(D).items[0]!.id}`)!.map((w) => w.correction_id)).toEqual(["C-0001"]);
  });

  it("C18: a same-day withhold the full draft re-reports by id is masked as §4.10 masks it, and the edition passes validateAll", () => {
    const i = withWithhold({ item: TRANSPORT, edition: D, kind: "victim" });
    const out = applyDraft(i);
    const want = weekdayExpected();
    const b = out.brief!;
    expect(out.masked).toEqual([{ item_id: TRANSPORT, correction_id: "C-0003", kind: "victim", match: "id" }]);
    expect(b.items.find((x) => x.id === TRANSPORT)).toMatchObject({
      headline: WITHHELD_HEADLINE, summary: WITHHELD_TEXT.replace("{date}", longDate(D)), why_it_matters: null,
      incident: { victim: null }, withheld: { correction_id: "C-0003", since: D },
    });
    // The Japan block lists it, and s11 is cited by it alone: both read [withheld]. Nothing else changes.
    expect(b.taiwan_lens.japan.text).toBe(WITHHELD_MARK);
    expect(b.sources.find((s) => s.id === "s11")!.title).toBe(WITHHELD_MARK);
    expect(b.items.filter((x) => x.id !== TRANSPORT)).toEqual(want.items.filter((x) => x.id !== TRANSPORT));
    expect(b.lead).toEqual(want.lead);
    expect(b.regions).toEqual(want.regions);
    expect(b.corrections.map((c) => c.id)).toEqual(["C-0003"]);
    expect(b.computed.word_count).toBeLessThan(want.computed.word_count);
    expect(out.archiveIndex.editions.find((e) => e.date === D)!.corrected).toBe(true);

    // In a copy of site-content (its 15 October brief too): the archive index as site-content holds it, with D now corrected.
    const dir = siteCopy();
    writeTree(dir, {
      "briefs/2026-10-14.json": jsonText(b, Brief), "corrections.json": jsonText(i.corrections, CorrectionsFile),
      "archive-index.json": jsonText({ ...GOLDEN_ARCHIVE, editions: markCorrected(GOLDEN_ARCHIVE.editions, i.corrections!.corrections) }, ArchiveIndex),
    });
    expect(validateAll(dir, { publishing: D, config: cfg }).errors).toEqual([]);
    // Unmasked (its dispute rejected in intake's list), the same edition fails XREF_CORRECTION, as it did before.
    const plain = applyDraft(withStatus(i, "rejected"));
    expect(plain.masked).toEqual([]);
    expect(plain.brief!.items).toEqual(want.items);
    writeTree(dir, { "briefs/2026-10-14.json": jsonText(plain.brief, Brief) });
    expect(validateAll(dir, { publishing: D, config: cfg }).errors.map((e) => e.code)).toEqual(["XREF_CORRECTION"]);
  });

  it("C18: an attribution withhold binds by URL: a later item citing a page the withheld item cited is masked, with its chip, Lead, Lens and region reason", () => {
    const i = withWithhold({ item: "camp-tw-old-2026-10", edition: "2026-10-10", kind: "attribution", date: "2026-10-13" });
    const url = normalizeUrl(i.draft.sources.find((s) => s.id === "s7")!.url);
    expect(i.archiveIndex!.urls[url]).toBeUndefined();
    i.archiveIndex!.urls[url] = { first_cited: "2026-10-10", item_ids: ["2026-10-10/camp-tw-old-2026-10"], sha256: null, hashed_at: null, last_check: null };
    const out = applyDraft(i);
    const want = weekdayExpected();
    const b = out.brief!;
    expect(out.masked).toEqual([{ item_id: CAMPAIGN, correction_id: "C-0003", kind: "attribution", match: "url" }]);
    const it = b.items.find((x) => x.id === CAMPAIGN)!;
    expect(it).toMatchObject({
      headline: WITHHELD_HEADLINE, summary: WITHHELD_TEXT.replace("{date}", longDate("2026-10-13")), why_it_matters: null,
      attribution: [], actor_nexus: null, withheld: { correction_id: "C-0003", since: "2026-10-13" },
    });
    expect(want.actors_seen.map((a) => a.item_ids)).toEqual([[CAMPAIGN]]);
    expect(b.actors_seen).toEqual([]);
    expect(b.lead.map((l) => l.text)).toEqual(want.lead.map((l) => (l.item_ids.includes(CAMPAIGN) ? WITHHELD_MARK : l.text)));
    expect(b.taiwan_lens.analysis).toBe(WITHHELD_MARK);
    expect(b.taiwan_lens.rows.map((r) => r.text)).toEqual(want.taiwan_lens.rows.map((r) => (r.item_ids.includes(CAMPAIGN) ? WITHHELD_MARK : r.text)));
    // The TW row keeps its level; only the reason, which embeds the headline, is marked.
    const tw = (x: Brief) => x.regions.rows.find((r) => r.code === "TW")!;
    expect(tw(b)).toEqual({ ...tw(want), reason: WITHHELD_MARK });
    expect(b.items.filter((x) => x.id !== CAMPAIGN)).toEqual(want.items.filter((x) => x.id !== CAMPAIGN));
    const metrics = Metrics.parse(read(path.join(SITE, "metrics", `${D}.json`)));
    expect(validatePublished(b, { metrics, config: cfg }).errors).toEqual([]);
    // Withdrawn, the dispute binds nothing: the brief is the golden one.
    const free = applyDraft(withStatus(i, "withdrawn"));
    expect(free.masked).toEqual([]);
    expect(free.brief).toEqual(want);
  });

  it("C18: an item an earlier edition masked carries the withhold on: the next item citing its page is masked under the same correction", () => {
    const i = world("weekday");
    const history = i.history.map((h) => (h.date !== "2026-10-13" ? h
      : { ...h, items: h.items.map((it) => (it.id === FLAW ? { ...it, withheld: { correction_id: "C-0001", since: "2026-10-13" } } : it)) }));
    const out = applyDraft({ ...i, history });
    expect(out.masked).toEqual([{ item_id: FLAW, correction_id: "C-0001", kind: "victim", match: "url" }]);
    const b = out.brief!;
    expect(b.items.find((x) => x.id === FLAW)!.withheld).toEqual({ correction_id: "C-0001", since: "2026-10-13" });
    expect(b.taiwan_lens.analysis).toBe(WITHHELD_MARK);
    // The id alone binds only on the withheld item's own edition date: C1's world masks nothing.
    expect(applyDraft(i).masked).toEqual([]);
  });

  it("C19: intake's list read before this morning's withhold: the dispute keeps the withhold's correction, and a draft correction does not answer it", () => {
    const i = world("weekday");
    // As intake read it: D-0001's withhold commit came after, so its correction_id is still null there.
    i.disputes = i.disputes!.map((d) => ({ ...d, correction_id: null }));
    i.draft = {
      ...i.draft,
      corrections: [{ item_id: HEALTH, edition_date: "2026-10-12", type: "update", field: "incident.status", after: "SAMPLE status.", reason: "SAMPLE reason.", source_id: null }],
    };
    const out = applyDraft(i);
    const c = out.corrections!.corrections.find((x) => x.id === "C-0003")!;
    expect([c.trigger, c.dispute_id]).toEqual(["recheck", null]);
    expect(out.corrections!.disputes).toEqual(GOLDEN_CORRECTIONS.disputes);
    expect(linkDisputes(i.disputes, GOLDEN_CORRECTIONS.corrections)).toEqual(GOLDEN_CORRECTIONS.disputes);
    expect(i.disputes[0]!.correction_id).toBeNull();
    // A dispute no correction names stays unanswered.
    expect(linkDisputes(i.disputes, [])).toEqual(i.disputes);
  });
});

describe("applyDraft on the Monday world", { timeout: 120_000 }, () => {
  // The Monday brief as first published, before the 13 October withhold: its history is the earlier briefs.
  const monday = applyDraft({ ...world("monday", BRIEFS.filter((b) => b.date < "2026-10-12")), corrections: null, disputes: null });

  it("C11: the Week in review covers the Monday to Sunday before, with one table row per claim", () => {
    const wir = monday.brief!.week_in_review!;
    expect([wir.from, wir.to]).toEqual(["2026-10-05", "2026-10-11"]);
    expect(wir).toEqual(golden("2026-10-12").week_in_review);
    expect(wir.table.map((r) => r.claim_id)).toEqual(cfg.claims.claims.map((c) => c.id));
    expect(monday.scoreboard!.claims.map((c) => [c.id, c.zone, c.status, c.last_entry_id])).toEqual([
      ["SB-01", "no_reading", "open", "SE-0001"], ["SB-02", "no_reading", "open", null],
    ]);
    expect(monday.brief!.scoreboard).toEqual(golden("2026-10-12").scoreboard);
  });
});

describe("Scoreboard zones, entries and status (§4.9)", () => {
  const metrics = Metrics.parse(read(path.join(SITE, "metrics", "2026-10-14.json")));
  const share: Claim = {
    ...structuredClone(cfg.claims.claims[0]!), id: "SB-09", metric_path: "window.w26.at_disclosure_share",
    support: { kind: "value", op: ">=", value: 0.35, bound: "ci80_lo" }, challenge: { kind: "value", op: "<=", value: 0.3, bound: "ci80_hi" },
  };
  const withClaims = (claims: Claim[]): LoadedConfig => ({ ...cfg, claims: { ...cfg.claims, claims } });

  it("C10: a value threshold reads the bound it names; no value is no_reading", () => {
    const r = claimReading(metrics, "window.w26.at_disclosure_share");
    expect(r).toEqual({ value: 0.3694, lo: 0.3217, hi: 0.4199, text: "37% (80% range 32% to 42%)" });
    expect(claimZone(share, r)).toBe("between");
    expect(claimZone({ ...share, support: { kind: "value", op: ">=", value: 0.3, bound: "ci80_lo" } }, r)).toBe("support");
    expect(claimZone({ ...share, challenge: { kind: "value", op: "<=", value: 0.42, bound: "ci80_hi" } }, r)).toBe("challenge");
    expect(claimZone(share, claimReading(metrics, "base_rate.ratio"))).toBe("no_reading");
    expect(claimReading(metrics, "window.w26.after_disclosure_median_days").text).toBe("17 (80% range 13 to 22)");
    expect(claimReading(metrics, "window.kev_pace_ratio").text).toBe("1.9 times");
  });

  it("C10: a metric entry on the first reading and on a zone change, never on a steady zone", () => {
    const config = withClaims([share]);
    const first = updateScoreboard({ date: "2026-10-14", config, metrics, scoreboard: null, reports: [], sources: [] });
    expect(first.file.entries).toEqual([{
      id: "SE-0001", date: "2026-10-14", claim_id: "SB-09", origin: "metric", direction: "neutral",
      summary: "First reading: the 26-week share of listed flaws exploited at disclosure is 37% (80% range 32% to 42%).",
      value: 0.3694, reported_value: null, quote: null, claim_type: null, source_url: null,
      metrics_ref: { file: "metrics/2026-10-14.json", path: "window.w26.at_disclosure_share" },
    }]);
    expect(first.file.claims[0]).toMatchObject({ zone: "between", reading: 0.3694, reading_as_of: "2026-10-12", last_entry_id: "SE-0001", status: "open" });
    const steady = updateScoreboard({ date: "2026-10-15", config, metrics, scoreboard: first.file, reports: [], sources: [] });
    expect(steady.file.entries).toHaveLength(1);
    expect(steady.brief).toEqual({ entries: [], last: { entry_id: "SE-0001", date: "2026-10-14", claim_id: "SB-09", claim_text: share.text } });
    const moved = updateScoreboard({
      date: "2026-10-16", config: withClaims([{ ...share, support: { kind: "value", op: ">=", value: 0.3, bound: "ci80_lo" } }]),
      metrics, scoreboard: steady.file, reports: [], sources: [],
    });
    expect(moved.file.entries.at(-1)).toMatchObject({
      id: "SE-0002", direction: "support",
      summary: "The 26-week share of listed flaws exploited at disclosure moved from between the thresholds to the support zone: it is 37% (80% range 32% to 42%).",
    });
    expect(moved.brief.entries.map((e) => e.id)).toEqual(["SE-0002"]);
  });

  it("C10: report entries take meets unless self-reported, and the quote source's URL", () => {
    const report = cfg.claims.claims.find((c) => c.judged_by === "report")!;
    const base = { claim_id: report.id, summary: "SAMPLE summary.", quote: "SAMPLE quote.", quote_source_id: "s1", reported_value: null };
    const out = updateScoreboard({
      date: "2026-10-14", config: cfg, metrics, scoreboard: boardBefore("2026-10-14"), sources: [{ id: "s1", url: "https://example.org/ct-sample/report" }],
      reports: [
        { ...base, claim_type: "government", meets: "support" },
        { ...base, claim_type: "self_reported", meets: "support" },
        { ...base, claim_type: "independent", meets: null },
      ],
    });
    expect(out.brief.entries.map((e) => [e.id, e.direction, e.source_url])).toEqual([
      ["SE-0002", "support", "https://example.org/ct-sample/report"], ["SE-0003", "neutral", "https://example.org/ct-sample/report"],
      ["SE-0004", "neutral", "https://example.org/ct-sample/report"],
    ]);
    expect(out.file.claims.find((c) => c.id === report.id)?.last_entry_id).toBe("SE-0004");
  });

  it("C10: status is open to the deadline, then hit or miss; a resolution overrides", () => {
    const report = cfg.claims.claims.find((c) => c.judged_by === "report")!;
    const support = [{ ...GOLDEN_BOARD.entries[1]!, direction: "support" as const }];
    expect(claimStatus(report, "no_reading", support, report.deadline)).toBe("open");
    expect(claimStatus(report, "no_reading", support, addDays(report.deadline, 1))).toBe("hit");
    expect(claimStatus(report, "no_reading", [], addDays(report.deadline, 1))).toBe("miss");
    expect(claimStatus(share, "support", [], addDays(share.deadline, 1))).toBe("hit");
    expect(claimStatus(share, "between", [], addDays(share.deadline, 1))).toBe("miss");
    const voided = { ...share, resolution: { status: "void" as const, date: "2026-10-20", note: "SAMPLE.", source_url: null } };
    expect(claimStatus(voided, "support", [], "2026-10-14")).toBe("void");
  });
});

describe("corrections and re-check flags", { timeout: 120_000 }, () => {
  function withCorrections(): ApplyInput {
    const i = world("weekday");
    const policy = BRIEFS.find((b) => b.date === "2026-10-12")!.items.find((it) => it.kind === "policy")!;
    i.draft = {
      ...i.draft,
      corrections: [
        { item_id: policy.id, edition_date: "2026-10-12", type: "update", field: "summary", after: "SAMPLE updated summary.", reason: "SAMPLE reason.", source_id: "s1" },
        { item_id: "cve-2026-108917", edition_date: "2026-10-13", type: "correction", field: "cves.0", after: "SAMPLE corrected block.", reason: "SAMPLE reason.", source_id: null },
        { item_id: "old-item-2026-09", edition_date: "2026-09-30", type: "clarification", field: "headline", after: "SAMPLE clarified headline.", reason: "SAMPLE reason.", source_id: null },
      ],
    };
    i.context = {
      ...i.context,
      corrections: { ...i.context.corrections, flagged: [{ date: "2026-09-30", item_id: "old-item-2026-09", check: "source_changed", before: "SAMPLE old headline", after: "SAMPLE new headline", evidence_url: null }] },
    };
    i.disputes = [...(i.disputes ?? []), {
      id: "D-0002", received: "2026-10-13T09:00:00+08:00", issue_number: 4, item_id: policy.id, edition_date: "2026-10-12",
      kind: "fact", evidence_url: null, status: "open", resolved_on: null, correction_id: null,
    }];
    i.recheck = {
      from: "2026-10-07", to: "2026-10-13", items_checked: 9,
      flagged: [
        { item_id: "cve-2026-108917", edition_date: "2026-10-13", flag: "cvss_changed", detail: "SAMPLE detail.", correction_id: null },
        { item_id: "cve-2026-108917", edition_date: "2026-10-13", flag: "kev_changed", detail: "SAMPLE detail.", correction_id: null },
        { item_id: "another-item", edition_date: "2026-10-13", flag: "source_missing", detail: "SAMPLE detail.", correction_id: null },
      ],
    };
    return i;
  }

  it("C7: ids continue C-NNNN, before is copied from the archived item (cut to 300) or the context, a dispute is answered", () => {
    const i = withCorrections();
    const out = applyDraft(i);
    const cs = out.corrections!.corrections;
    expect(cs.map((c) => c.id)).toEqual(["C-0001", "C-0002", "C-0003", "C-0004", "C-0005"]);
    const [c3, c4, c5] = cs.slice(2);
    const monday = BRIEFS.find((b) => b.date === "2026-10-12")!;
    const policy = monday.items.find((it) => it.kind === "policy")!;
    expect(c3).toEqual({
      id: "C-0003", date: "2026-10-14", item_id: policy.id, edition_date: "2026-10-12", type: "update", field: "summary",
      before: policy.summary, after: "SAMPLE updated summary.", reason: "SAMPLE reason.", source_url: i.draft.sources[0]!.url,
      trigger: "reader_report", dispute_id: "D-0002",
    });
    const block = BRIEFS.find((b) => b.date === "2026-10-13")!.items.find((it) => it.id === "cve-2026-108917")!.cves[0]!;
    expect(c4!.before).toBe(JSON.stringify(block).slice(0, 300));
    expect(c4!.before).toHaveLength(300);
    expect([c4!.trigger, c4!.dispute_id]).toEqual(["recheck", null]);
    expect(c5!.before).toBe("SAMPLE old headline");
    expect(out.corrections!.disputes.find((d) => d.id === "D-0002")).toMatchObject({ status: "upheld", resolved_on: "2026-10-14", correction_id: "C-0003" });
    expect(out.corrections!.disputes.find((d) => d.id === "D-0001")).toEqual(GOLDEN_CORRECTIONS.disputes[0]);
    expect(out.brief!.corrections.map((c) => c.id)).toEqual(["C-0003", "C-0004", "C-0005"]);
    expect(out.archiveIndex.editions.find((e) => e.date === "2026-10-13")?.corrected).toBe(true);
  });

  it("C8: flagCorrections maps each re-check flag to the draft correction for its item; a rerun adds nothing", () => {
    const i = withCorrections();
    const out = applyDraft(i);
    expect(out.flagCorrections).toEqual([
      { item_id: "cve-2026-108917", edition_date: "2026-10-13", flag: "cvss_changed", correction_id: "C-0004" },
      { item_id: "cve-2026-108917", edition_date: "2026-10-13", flag: "kev_changed", correction_id: "C-0004" },
    ]);
    const rerun = applyDraft({ ...withCorrections(), corrections: out.corrections, disputes: out.corrections!.disputes });
    expect(rerun.corrections).toBeNull();
    expect(rerun.flagCorrections).toEqual(out.flagCorrections);
    expect(rerun.brief!.corrections).toEqual(out.brief!.corrections);
  });
});

describe("CVE blocks from facts and the manifest (A5)", { timeout: 120_000 }, () => {
  const AI_CVE = "CVE-2026-110036";

  it("C14: a manifest ai_credited row gives the block's ai_credit and passes validateAll; a changed match fails", () => {
    const i = world("weekday");
    const inputs = structuredClone(i.inputs!);
    const k = inputs.ai_credited.findIndex((r) => r.finder_id === "aisle");
    inputs.ai_credited[k] = { ...inputs.ai_credited[k]!, id: AI_CVE, matched: "AISLE" };
    const out = applyDraft({ ...i, inputs });
    const block = out.brief!.items.flatMap((it) => it.cves).find((c) => c.cve_id === AI_CVE)!;
    const row = inputs.ai_credited[k]!;
    expect(block.ai_credit).toEqual({ finder_id: row.finder_id, family: row.family, kind: row.kind, field: row.field, matched: row.matched, rule: row.rule, finders_version: 2 });
    expect(block.date_published).toBe(row.published);
    const dir = siteCopy();
    writeTree(dir, { "briefs/2026-10-14.json": jsonText(out.brief, Brief), "metrics/inputs/2026-10-14.json": jsonText(inputs, InputsManifest) });
    expect(validateAll(dir, { publishing: "2026-10-14", config: cfg }).errors).toEqual([]);
    inputs.ai_credited[k] = { ...row, matched: "AISLE research team" };
    writeTree(dir, { "metrics/inputs/2026-10-14.json": jsonText(inputs, InputsManifest) });
    const bad = validateAll(dir, { publishing: "2026-10-14", config: cfg }).errors;
    expect(bad.some((e) => e.code === "COMPUTED_MISMATCH" && /\.ai_credit$/.test(e.path))).toBe(true);
  });

  it("C14: the manifest wins over the record's own credit match, and its dates and vendor id are copied", () => {
    const i = world("weekday");
    const inputs = structuredClone(i.inputs!);
    const k = inputs.ai_credited.findIndex((r) => r.finder_id === "xbow");
    inputs.ai_credited[k] = { ...inputs.ai_credited[k]!, id: AI_CVE, published: "2026-10-01" };
    const block = cveBlockOf(AI_CVE, { flaw_evidence: [] }, [], {
      config: cfg, facts: i.facts, cveList: i.cveList, kevIndex: i.kevIndex, inputs, findersVersion: 2, capturedAt: i.publishedAt,
    });
    expect(block.ai_credit).toMatchObject({ finder_id: "xbow", matched: inputs.ai_credited[k]!.matched });
    expect(block.date_published).toBe("2026-10-01");
    expect(block.discovery_credit).toBe(inputs.ai_credited[k]!.kind === "ai_system" ? "ai_autonomous" : "ai_assisted");
  });

  it("C15: kev.due_date, catalog_version and epss come from facts, never from defaults", () => {
    const i = world("weekday");
    const cve = "CVE-2026-104935";
    const facts: CveFacts = {
      ...i.facts,
      kev: (id) => (id === cve ? { dateAdded: "2026-10-13", dueDate: "2026-11-30", ransomware: "known", catalogVersion: "2099.01.01" } : null),
      epss: (id) => (id === cve ? { score: 0.5123, percentile: 0.9871, date: "2026-10-12" } : null),
      ghsaIds: (id) => (id === cve ? ["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"] : []),
    };
    const x = { config: cfg, facts, cveList: i.cveList, kevIndex: i.kevIndex, inputs: null, findersVersion: 2, capturedAt: i.publishedAt };
    const block = cveBlockOf(cve, { flaw_evidence: [] }, [], x);
    expect(block.kev).toEqual({ date_added: "2026-10-13", due_date: "2026-11-30", ransomware: "known", catalog_version: "2099.01.01" });
    expect(block.epss).toEqual({ score: 0.5123, percentile: 0.9871, date: "2026-10-12" });
    expect(block.ghsa_ids).toEqual(["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"]);
    // A CVE on the KEV index whose catalog facts are missing gets no kev block and no default due date.
    const other = cveBlockOf("CVE-2026-96951", { flaw_evidence: [] }, [], x);
    expect(other.kev).toBeNull();
    expect(other.epss).toBeNull();
    expect(other.exploitation_evidence.some((e) => e.basis === "kev_listed")).toBe(false);
    // The catalog's vulnerabilityName is the title's first choice (§4.6).
    const named: CveFacts = { ...facts, kev: (id) => ({ ...facts.kev(cve)!, vulnerabilityName: `SAMPLE ${id} name` }) };
    expect(cveBlockOf(cve, { flaw_evidence: [] }, [], { ...x, facts: named }).title).toBe(`SAMPLE ${cve} name`);
  });
});
