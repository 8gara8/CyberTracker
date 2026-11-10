// Run records and stage notes (scripts/lib/status.ts; SPEC §4.8, §8.2 "Stages 2 to 10" and "Finish", §8.8;
// plan §2.7, §3.7 and §5 G9). ST1 to ST8 of the plan, plus the helpers the plan names without an id.
// Everything is built in memory or in a temp folder; the briefs ST4 renders come from fixtures/site-content.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STAGE_NOTES, chatInputFor, renderChat, type ChatInput } from "@/lib/chat";
import { loadConfig } from "@/lib/config";
import { at, taipeiTimestamp } from "@/lib/dates";
import { readBrief } from "@/lib/run-inputs";
import type { FeedIndexEntry, FeedIndexFile, CandidatesFile } from "@/lib/schema/pack";
import { RunRecord, StatusFile, type FeedRecord } from "@/lib/schema/status";
import { siteUrl } from "@/lib/site";
import { PARTIAL_FEED_IDS, RUN_OUTCOMES, RUN_STAGES, type RunOutcome } from "@/lib/vocab";
import {
  CHAT_READ_NOTES, NOTES, NOTE_MAX, addNote, budgetsFrom, candidateCounts, closeRecord, exitCodeFor, feedRecords, feedsStaleFor,
  newRunRecord, outcomeFor, priorStatus, runIdFor, runsJsonlLine, setStage, splitNotes,
} from "@/scripts/lib/status";
import { parseTranscript } from "@/scripts/lib/transcript";

const ROOT = path.resolve(__dirname, "..");
const SITE_CONTENT = path.join(ROOT, "fixtures", "site-content");
const config = loadConfig({ root: ROOT });
const SHA = "0123456789abcdef0123456789abcdef01234567";
const D = "2026-10-14";
const SITE = siteUrl();

function record(o: { date?: string; start?: string; trigger?: RunRecord["trigger"]; attempt?: number } = {}): RunRecord {
  const date = o.date ?? D;
  const startedAt = at(date, o.start ?? "04:37") + 2_000;
  return newRunRecord({
    runId: runIdFor(startedAt), trigger: o.trigger ?? "schedule", attempt: o.attempt ?? 1, startedAt, codeCommit: SHA,
    dataCutoffUtc: "2026-10-12",
  });
}

/** Marks every stage up to `upTo` ok, one minute apart from the record's start. */
function runStages(rec: RunRecord, upTo: number, skip: readonly string[] = []): void {
  let t = Date.parse(rec.started_at);
  RUN_STAGES.slice(0, upTo).forEach((id) => {
    if (skip.includes(id)) return;
    setStage(rec, id, { status: "ok", started: t, ended: t + 60_000 });
    t += 60_000;
  });
}

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("run records", () => {
  it("ST1 newRunRecord passes RunRecord: every stage skipped, times null, feeds [], budgets zero, nullables null", () => {
    const rec = record();
    expect(RunRecord.parse(rec)).toEqual(rec);
    expect(rec.stages.map((s) => s.id)).toEqual([...RUN_STAGES]);
    for (const s of rec.stages) expect(s).toEqual({ id: s.id, status: "skipped", started_at: null, ended_at: null, note: null });
    expect(rec).toMatchObject({
      run_id: "20261014-043702", trigger: "schedule", attempt: 1, started_at: "2026-10-14T04:37:02+08:00", finished_at: null,
      outcome: null, edition: null, error_code: null, code_commit: SHA, data_cutoff_utc: "2026-10-12", data_only_published_at: null,
      full_published_at: null, late: false, feeds: [], candidates: null, validation: null, soft_gates: null, recheck: null, links: null,
      deploy: { triggered: false, ready_at: null, shows_date: null, shows_edition: null },
      budgets: { agent_seconds: 0, web_fetches: 0, web_searches: 0, repair_rounds: 0, tokens_in: null, tokens_out: null, usage: null, safety_stops: 0 },
    });
    // Two records share nothing: a stage set on one leaves the other alone.
    const other = record();
    setStage(rec, "collect", { status: "ok" });
    expect(other.stages[1]!.status).toBe("skipped");
  });

  it("ST1 setStage writes Taipei times and adds the note; closeRecord fills the end of the record", () => {
    const rec = record();
    const t0 = at(D, "04:38");
    setStage(rec, "collect", { status: "degraded", started: t0, ended: t0 + 65_000, note: NOTES.collectorFailed("timeout") });
    expect(rec.stages.find((s) => s.id === "collect")).toEqual({
      id: "collect", status: "degraded", started_at: "2026-10-14T04:38:00+08:00", ended_at: "2026-10-14T04:39:05+08:00",
      note: "Collector failed (timeout); continuing with an empty, degraded pack.",
    });
    // A later status change keeps the times and the note it does not name.
    setStage(rec, "collect", { status: "failed" });
    expect(rec.stages.find((s) => s.id === "collect")).toMatchObject({ status: "failed", started_at: "2026-10-14T04:38:00+08:00",
      note: "Collector failed (timeout); continuing with an empty, degraded pack." });
    closeRecord(rec, { outcome: "published_data_only", errorCode: "E_AGENT", edition: "data_only", late: false, finishedAt: at(D, "05:20") + 9_000 });
    expect(rec).toMatchObject({ outcome: "published_data_only", error_code: "E_AGENT", edition: "data_only", late: false,
      finished_at: "2026-10-14T05:20:09+08:00" });
    expect(() => RunRecord.parse(rec)).not.toThrow();
  });

  it("ST2 runIdFor gives the Taipei start as YYYYMMDD-HHMMSS, across the UTC day boundary too", () => {
    expect(runIdFor(at(D, "04:37") + 2_999)).toBe("20261014-043702");
    expect(runIdFor(Date.parse("2026-10-13T20:00:00Z"))).toBe("20261014-040000");
    expect(runIdFor(Date.parse("2026-12-31T16:59:59Z"))).toBe("20270101-005959");
    expect(runIdFor(at(D, "23:59") + 59_000)).toBe("20261014-235959");
    expect(runIdFor(Date.now())).toMatch(/^\d{8}-\d{6}$/);
    expect(() => runIdFor(Number.NaN)).toThrow();
  });
});

describe("stage notes", () => {
  it("ST3 every note text ends with a full stop, fits one stage, has no em-dash and splits back to itself", () => {
    const texts = [
      NOTES.dataOnlyRequested, NOTES.startedAfterHardStop("05:30"), NOTES.alreadyPublished("05:07"), NOTES.tooLate("11:00"),
      NOTES.replaced("05:07"), NOTES.floodStops("2026-10-12"), NOTES.depsChanged, NOTES.restored, NOTES.restarted("abc1234"),
      NOTES.collectorFailed("timeout"), NOTES.collectorFailed("error"), NOTES.reusedMetrics(D), NOTES.dataOnlyUpSince("04:48"),
      NOTES.dataOnlyFailed, NOTES.intakeUnavailable, NOTES.reusedFrom("20261014-043702"), NOTES.dryRunValid(D),
      NOTES.staleLock("02:31"), NOTES.droppedPending(1), NOTES.droppedPending(2), NOTES.remadeWithholds(1), NOTES.remadeWithholds(3),
      NOTES.dryRunTree, NOTES.degradedBlocks(["epss", "ghsa"]), NOTES.withheld(1, 0), NOTES.withheld(2, 1), NOTES.withheld(3, 2),
      NOTES.flagsSkipped(["kev"]), NOTES.flagsSkipped(["kev", "cvelist"]), NOTES.tooLittleTime("05:30"), NOTES.notInDryRun,
      NOTES.missedTarget("data_only", "04:55", "04:50"), NOTES.missedTarget("full", "05:21", "05:15"), NOTES.siteNotShowing(1),
      NOTES.siteNotShowing(8), NOTES.notReached(1), NOTES.notReached(12), NOTES.simulated, NOTES.notRun("metrics"), NOTES.notRun("cli"),
      NOTES.notRun("data_only"), NOTES.notRun("hard_stop"), NOTES.pendingNotPushed,
      NOTES.failure("E_TIMEOUT", { date: D, errors: 0, repairs: 0, attempts: 1, agentMinutes: null, hardStop: "05:30", publishUntil: "11:00" }),
      NOTES.failure("E_VALIDATION", { date: D, errors: 3, repairs: 2, attempts: 2, agentMinutes: 22, hardStop: "05:30", publishUntil: "11:00" }),
    ];
    for (const t of texts) {
      expect(t, t).toMatch(/\.$/);
      expect(t.length, t).toBeLessThanOrEqual(NOTE_MAX);
      expect(t, t).not.toMatch(/\u2014/);
      expect(splitNotes(t), t).toEqual([t]);
    }
    expect(splitNotes(texts.slice(0, 6).join(" "))).toEqual(texts.slice(0, 6));
    expect(splitNotes(null)).toEqual([]);
    // The texts the plan's §5 G9 table gives, word for word.
    expect(NOTES.staleLock("02:31")).toBe("Replaced a stale lock from 02:31.");
    expect(NOTES.droppedPending(2)).toBe("Dropped 2 unpushed edition commits left by an earlier run.");
    expect(NOTES.withheld(2, 1)).toBe("Withheld 2 items on reader disputes; 1 waits for the next run.");
    expect(NOTES.withheld(2, 0)).toBe("Withheld 2 items on reader disputes.");
    expect(NOTES.flagsSkipped(["kev"])).toBe("Re-check flags from kev skipped: the feed failed.");
    expect(NOTES.missedTarget("data_only", "04:55", "04:50")).toBe("Data-only edition published at 04:55, after the 04:50 target.");
    expect(NOTES.notReached(12)).toBe("12 links not reached in time.");
    expect(NOTES.notRun("hard_stop")).toBe("Started after 05:30: no editorial pass today.");
  });

  it("ST3 CHAT_READ_NOTES matches exactly the STAGE_NOTES texts, and NOTES reuses them", () => {
    const chatTexts = [
      STAGE_NOTES.dataOnlyRequested, STAGE_NOTES.startedAfterHardStop("05:30"), STAGE_NOTES.alreadyPublished("05:07"),
      STAGE_NOTES.tooLate("11:00"), STAGE_NOTES.replaced("05:07"), STAGE_NOTES.floodStops("2026-10-12"), STAGE_NOTES.depsChanged,
    ];
    expect(chatTexts.map((t) => CHAT_READ_NOTES.filter((re) => re.test(t)).length)).toEqual(chatTexts.map(() => 1));
    expect(Object.keys(STAGE_NOTES)).toHaveLength(CHAT_READ_NOTES.length);
    expect([NOTES.dataOnlyRequested, NOTES.startedAfterHardStop("05:30"), NOTES.alreadyPublished("05:07"), NOTES.tooLate("11:00"),
      NOTES.replaced("05:07"), NOTES.floodStops("2026-10-12"), NOTES.depsChanged]).toEqual(chatTexts);
    for (const t of [NOTES.restored, NOTES.staleLock("02:31"), NOTES.dataOnlyFailed, NOTES.notInDryRun, NOTES.pendingNotPushed]) {
      expect(CHAT_READ_NOTES.some((re) => re.test(t)), t).toBe(false);
    }
  });

  it("ST3 addNote joins with one space, skips repeats and empty notes, and stays within 200 characters", () => {
    const rec = record();
    addNote(rec, "preflight", NOTES.restored);
    addNote(rec, "preflight", "  ");
    addNote(rec, "preflight", NOTES.depsChanged);
    addNote(rec, "preflight", NOTES.restored);
    expect(rec.stages[0]!.note).toBe("Restored content/ left by an earlier run. Dependencies changed since the last npm ci.");

    // Past 200: the chat-read notes stay whatever their position, then the earliest others, whole.
    const busy = record();
    const early = [NOTES.staleLock("02:31"), NOTES.restored, NOTES.restarted("abc1234"), NOTES.droppedPending(2), NOTES.remadeWithholds(1)];
    for (const n of early) addNote(busy, "preflight", n);
    addNote(busy, "preflight", NOTES.depsChanged);
    addNote(busy, "preflight", NOTES.alreadyPublished("05:07"));
    const note = busy.stages[0]!.note!;
    expect(note.length).toBeLessThanOrEqual(NOTE_MAX);
    const kept = splitNotes(note);
    expect(kept).toContain(NOTES.depsChanged);
    expect(kept).toContain(NOTES.alreadyPublished("05:07"));
    // The others are whole notes from the start of the list, in their order, each one either kept or left out.
    const others = kept.filter((n) => !CHAT_READ_NOTES.some((re) => re.test(n)));
    expect(others.every((n) => early.includes(n))).toBe(true);
    expect(others).toEqual(early.filter((n) => others.includes(n)));
    expect(others[0]).toBe(early[0]);
    expect(kept.length).toBeLessThan(early.length + 2);
    expect(() => RunRecord.parse(busy)).not.toThrow();

    // A note too long on its own (no template is) is cut, so the record still passes its schema.
    const long = record();
    addNote(long, "metrics", NOTES.degradedBlocks(Array.from({ length: 40 }, (_, i) => `block-${i}`)));
    expect(long.stages[2]!.note!.length).toBeLessThanOrEqual(NOTE_MAX);
    expect(() => RunRecord.parse(long)).not.toThrow();
    expect(() => addNote(record(), "nope" as never, "x.")).toThrow(/no nope stage/);
  });

  describe("ST4 every chat-read template round-trips: status.ts records, chatInputFor, the chat edition", () => {
    const full = readBrief(SITE_CONTENT, "2026-10-14")!;
    const dataOnly = readBrief(SITE_CONTENT, "2026-10-15")!;
    expect(full.edition).toBe("full");
    expect(dataOnly.edition).toBe("data_only");

    /** A record that published `brief` with every stage ok, preflight carrying many other notes first. */
    function published(brief: typeof full, outcome: RunOutcome, extra: { stage: (typeof RUN_STAGES)[number]; note: string }): RunRecord {
      const rec = record({ date: brief.date });
      runStages(rec, RUN_STAGES.length, brief.edition === "data_only" ? ["draft", "validate", "publish"] : []);
      for (const n of [NOTES.staleLock("02:31"), NOTES.restored, NOTES.restarted("abc1234"), NOTES.droppedPending(2), NOTES.remadeWithholds(1)]) {
        addNote(rec, "preflight", n);
      }
      addNote(rec, extra.stage, extra.note);
      rec.data_only_published_at = brief.data_only_published_at;
      rec.full_published_at = brief.edition === "data_only" ? null : brief.published_at;
      rec.deploy = { triggered: true, ready_at: brief.published_at, shows_date: brief.date, shows_edition: brief.edition };
      closeRecord(rec, { outcome, errorCode: null, edition: brief.edition, late: false, finishedAt: at(brief.date, "05:20") });
      return RunRecord.parse(rec);
    }

    const render = (input: ChatInput) => {
      const text = renderChat(input, SITE);
      expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(15);
      return text;
    };
    const notesLine = (text: string) => text.split("\n").find((l) => l.startsWith("Notes: ")) ?? "";

    it("ST4 depsChanged, on preflight past 200 characters, reaches the Notes line", () => {
      const rec = published(full, "published_full", { stage: "preflight", note: NOTES.depsChanged });
      expect(rec.stages[0]!.note!.length).toBeGreaterThan(150);
      const input = chatInputFor({ date: full.date, brief: full, runs: [rec] });
      expect(input.kind).toBe("published");
      expect(notesLine(render(input))).toContain("Dependencies changed since the last npm ci");
    });

    it("ST4 floodStops on the metrics stage reaches the Notes line", () => {
      const rec = published(full, "published_full", { stage: "metrics", note: NOTES.floodStops("2026-10-09") });
      expect(notesLine(render(chatInputFor({ date: full.date, brief: full, runs: [rec] }))))
        .toContain("Flood counts stop at 2026-10-09: run npm run backfill -- --catch-up --push");
    });

    it("ST4 replaced on the publish stage reaches the Notes line", () => {
      const rec = published(full, "published_full", { stage: "publish", note: NOTES.replaced("04:58") });
      expect(notesLine(render(chatInputFor({ date: full.date, brief: full, runs: [rec] })))).toContain("replaced the 04:58 edition (--force)");
    });

    it("ST4 dataOnlyRequested is What happened, even for a start after the hard stop", () => {
      const rec = published(dataOnly, "published_data_only", { stage: "draft", note: NOTES.dataOnlyRequested });
      rec.started_at = taipeiTimestamp(new Date(at(dataOnly.date, "05:41")));
      const input = chatInputFor({ date: dataOnly.date, brief: dataOnly, runs: [rec] });
      expect(input).toMatchObject({ kind: "data_only", code: null, what: "Data-only run requested (--data-only)." });
      expect(render(input)).toContain("\nWhat happened: Data-only run requested (--data-only).\n");
    });

    it("ST4 startedAfterHardStop is What happened, read from the note and not only from the start time", () => {
      for (const start of ["05:35", "04:37"]) {
        const rec = published(dataOnly, "published_data_only", { stage: "draft", note: NOTES.startedAfterHardStop("05:30") });
        rec.started_at = taipeiTimestamp(new Date(at(dataOnly.date, start)));
        const input = chatInputFor({ date: dataOnly.date, brief: dataOnly, runs: [rec] });
        expect(input, start).toMatchObject({ kind: "data_only", what: "Started after 05:30: no editorial pass today." });
        expect(render(input)).toContain("\nWhat happened: Started after 05:30: no editorial pass today.\n");
      }
    });

    it("ST4 alreadyPublished is the skip reason, also for a dry run, whose outcome is dry_run", () => {
      for (const dry of [false, true]) {
        const rec = record({ start: "06:12", trigger: dry ? "dry_run" : "manual" });
        setStage(rec, "preflight", { status: "ok", started: at(D, "06:12"), ended: at(D, "06:13"), note: NOTES.depsChanged });
        addNote(rec, "preflight", NOTES.alreadyPublished("05:07"));
        closeRecord(rec, { outcome: dry ? "dry_run" : "skipped", errorCode: null, edition: "full", late: false, finishedAt: at(D, "06:13") });
        const input = chatInputFor({ date: D, brief: full, runs: [RunRecord.parse(rec)] });
        expect(input).toMatchObject({ kind: "skipped", reason: "The full edition was already published at 05:07.", dryRun: dry });
        expect(render(input).split("\n")[0]).toBe(dry
          ? `**CyberTracker ${D} · dry run (skipped).** The full edition was already published at 05:07.`
          : `**CyberTracker ${D} · skipped.** The full edition was already published at 05:07.`);
      }
    });

    it("ST4 tooLate is the skip reason", () => {
      for (const dry of [false, true]) {
        const rec = record({ start: "11:05", trigger: dry ? "dry_run" : "schedule" });
        setStage(rec, "preflight", { status: "ok", note: NOTES.tooLate("11:00") });
        closeRecord(rec, { outcome: dry ? "dry_run" : "skipped", errorCode: null, edition: null, late: false, finishedAt: at(D, "11:06") });
        const input = chatInputFor({ date: D, brief: null, runs: [RunRecord.parse(rec)] });
        expect(input).toMatchObject({ kind: "skipped", reason: "Too late: nothing is published after 11:00.", briefUrl: null });
        expect(render(input)).toContain("Too late: nothing is published after 11:00.");
      }
    });
  });
});

describe("feeds, candidates and budgets", () => {
  const feedIds = config.sources.feeds.map((f) => f.id);
  const searchIds = config.sources.feeds.filter((f) => f.kind === "search").map((f) => f.id);

  function entry(id: string, over: Partial<FeedIndexEntry> = {}): FeedIndexEntry {
    const search = searchIds.includes(id);
    return {
      id, kind: config.sources.feeds.find((f) => f.id === id)!.kind, status: search ? "skipped" : "ok", label: search ? "SKIP" : "OK",
      error_class: null, url_used: null, fallback_used: false, newest: search ? null : "2026-10-13T21:00:00Z", items: 3, records: 7,
      version: null, sha256: null, fetched_at: search ? null : "2026-10-14T04:38:12+08:00", note: null, ...over,
    };
  }
  function index(date: string, over: Record<string, Partial<FeedIndexEntry>> = {}): FeedIndexFile {
    return { schema_version: 1, date, generated_at: "2026-10-14T04:41:00+08:00", feeds: feedIds.map((id) => entry(id, over[id])) };
  }
  function status(date: string, feeds: Record<string, Pick<FeedRecord, "status" | "stale_since">>, withStart = true): StatusFile {
    const r = record({ date });
    r.feeds = feedIds.map((id) => ({
      id, status: feeds[id]?.status ?? (searchIds.includes(id) ? "skipped" : "ok"), newest: null, checked_at: `${date}T04:41:00+08:00`,
      stale_since: feeds[id]?.stale_since ?? null, records: null, note: null,
    }));
    // A later start record (feeds: []) must not hide the final record that holds the feeds.
    const start = record({ date, start: "08:30", trigger: "manual" });
    return StatusFile.parse({ schema_version: 1, date, runs: withStart ? [r, start] : [r] });
  }

  it("ST5 feedRecords: one per registry feed in order, from the index, with stale_since carried from the newest earlier status file", () => {
    const idx = index(D, {
      kev: { status: "failed", label: "FAIL", error_class: "http_5xx", newest: "2026-10-11", records: 0, note: "KEV did not answer." },
      epss: { status: "stale", label: "STALE", newest: "2026-10-10", records: 296_000 },
      ghsa: { status: "stale", label: "STALE", records: 12 },
      cvelist: { status: "failed", label: "FAIL" },
      nvd: { status: "failed", label: "FAIL" },
    });
    const prior = [
      status("2026-10-13", { kev: { status: "failed", stale_since: "2026-10-11" }, ghsa: { status: "stale", stale_since: null } }),
      status("2026-10-12", { epss: { status: "stale", stale_since: "2026-10-12" }, cvelist: { status: "failed", stale_since: "2026-10-09" } }),
      status("2026-10-11", { nvd: { status: "failed", stale_since: "2026-10-11" } }),
    ];
    // nvd failed on 10-11 but was ok in the newer 10-13 file, so its streak starts today.
    const rows = feedRecords({ config, index: idx, prior, date: D });
    expect(rows.map((r) => r.id)).toEqual(feedIds);
    for (const r of rows) expect(() => RunRecord.shape.feeds.element.parse(r), r.id).not.toThrow();
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.kev).toEqual({ id: "kev", status: "failed", newest: "2026-10-11", checked_at: "2026-10-14T04:38:12+08:00",
      stale_since: "2026-10-11", records: null, note: "KEV did not answer." });
    expect(by.ghsa).toMatchObject({ status: "stale", stale_since: "2026-10-13", records: 12 });   // stale yesterday with no date: that file's date
    expect(by.epss).toMatchObject({ status: "stale", stale_since: D, records: 296_000 });           // ok yesterday: a new streak
    expect(by.cvelist).toMatchObject({ status: "failed", stale_since: D });                         // ok yesterday, failed the day before
    expect(by.nvd).toMatchObject({ status: "failed", stale_since: D });
    expect(by.therecord).toEqual({ id: "therecord", status: "ok", newest: "2026-10-13T21:00:00Z", checked_at: "2026-10-14T04:38:12+08:00",
      stale_since: null, records: 7, note: null });
    expect(by[searchIds[0]!]).toMatchObject({ status: "skipped", checked_at: idx.generated_at, records: null, stale_since: null });

    // The order of `prior` and files dated D or later do not matter.
    const shuffled = [prior[2]!, status(D, { epss: { status: "failed", stale_since: "2026-10-01" } }), prior[0]!, prior[1]!];
    expect(feedRecords({ config, index: idx, prior: shuffled, date: D })).toEqual(rows);
    // A gap day without a status file: the newest earlier file still carries.
    expect(feedRecords({ config, index: idx, prior: [prior[1]!], date: D }).find((r) => r.id === "cvelist")!.stale_since).toBe("2026-10-09");
    // No earlier file: the streak starts today.
    expect(feedRecords({ config, index: idx, prior: [], date: D }).find((r) => r.id === "kev")!.stale_since).toBe(D);
  });

  it("ST5 feedRecords with no index for D: every fetched feed failed with nothing read, search entries skipped", () => {
    for (const idx of [null, index("2026-10-13")]) {
      const rows = feedRecords({ config, index: idx, prior: [status("2026-10-13", { kev: { status: "failed", stale_since: "2026-10-12" } })],
        date: D, checkedAt: "2026-10-14T04:42:00+08:00" });
      expect(rows.map((r) => r.id)).toEqual(feedIds);
      for (const r of rows) {
        const search = searchIds.includes(r.id);
        expect(r, r.id).toMatchObject({ status: search ? "skipped" : "failed", newest: null, checked_at: "2026-10-14T04:42:00+08:00", records: null, note: null });
        expect(r.stale_since, r.id).toBe(search ? null : r.id === "kev" ? "2026-10-12" : D);
      }
    }
  });

  it("ST5 priorStatus reads D-days to D-1, newest first, skipping missing, invalid and misdated files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-status-"));
    tmp.push(dir);
    fs.mkdirSync(path.join(dir, "status"));
    const put = (name: string, value: unknown) => fs.writeFileSync(path.join(dir, "status", `${name}.json`), typeof value === "string" ? value : JSON.stringify(value));
    put("2026-10-13", status("2026-10-13", {}));
    put("2026-10-11", status("2026-10-11", {}));
    put("2026-10-10", "{ not json");
    put("2026-10-09", { ...status("2026-10-08", {}) });   // its date is not its name
    put("2026-10-14", status(D, {}));                      // D itself is never prior
    put("2026-09-29", status("2026-09-29", {}));           // 15 days before D
    expect(priorStatus(dir, D).map((s) => s.date)).toEqual(["2026-10-13", "2026-10-11"]);
    expect(priorStatus(dir, D, 2).map((s) => s.date)).toEqual(["2026-10-13"]);
    expect(priorStatus(dir, D, 15).map((s) => s.date)).toEqual(["2026-10-13", "2026-10-11", "2026-09-29"]);
    expect(priorStatus(path.join(dir, "missing"), D)).toEqual([]);
    // The site-content sample: 14 days before 2026-10-16 hold ten files.
    expect(priorStatus(SITE_CONTENT, "2026-10-16").map((s) => s.date)).toEqual([
      "2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12", "2026-10-11", "2026-10-10", "2026-10-09", "2026-10-08", "2026-10-07", "2026-10-06"]);
  });

  it("ST6 outcomeFor and exitCodeFor follow the plan's §3.7 table", () => {
    const cases: [Parameters<typeof outcomeFor>[0], RunOutcome, 0 | 1 | 3][] = [
      [{ dryRun: false, skipped: false, full: "full", dataOnly: true }, "published_full", 0],
      [{ dryRun: false, skipped: false, full: "partial", dataOnly: true }, "published_partial", 0],
      [{ dryRun: false, skipped: false, full: "full", dataOnly: false }, "published_full", 0],   // a --force run that replaced a full edition
      [{ dryRun: false, skipped: false, full: null, dataOnly: true }, "published_data_only", 3],
      [{ dryRun: false, skipped: true, full: null, dataOnly: false }, "skipped", 0],
      [{ dryRun: false, skipped: true, full: null, dataOnly: true }, "skipped", 0],
      [{ dryRun: false, skipped: false, full: null, dataOnly: false }, "failed", 1],
      [{ dryRun: true, skipped: false, full: null, dataOnly: false }, "dry_run", 0],
      [{ dryRun: true, skipped: true, full: null, dataOnly: false }, "dry_run", 0],
      [{ dryRun: true, skipped: false, full: "full", dataOnly: true }, "dry_run", 0],
    ];
    for (const [input, outcome, exit] of cases) {
      expect(outcomeFor(input), JSON.stringify(input)).toBe(outcome);
      expect(exitCodeFor(outcomeFor(input))).toBe(exit);
    }
    expect(RUN_OUTCOMES.map(exitCodeFor)).toEqual([0, 0, 3, 1, 0, 0]);
  });

  it("ST6 runsJsonlLine writes one JSON line with the spec's keys in order", () => {
    const line = runsJsonlLine({
      date: D, run_id: "20261014-043702", trigger: "schedule", started: "2026-10-14T04:37:02+08:00", ended: "2026-10-14T05:21:40+08:00",
      outcome: "published_full", edition: "full", attempts: 1, repairs: 1, error_code: null, duration_s: 2678,
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(Object.keys(JSON.parse(line))).toEqual(["date", "run_id", "trigger", "started", "ended", "outcome", "edition", "attempts", "repairs",
      "error_code", "duration_s"]);
    expect(JSON.parse(line)).toMatchObject({ outcome: "published_full", error_code: null, duration_s: 2678 });
  });

  it("ST7 budgetsFrom sums an attempt's transcripts: calls, tokens, the last usage window, safety stops", () => {
    const toolUse = (name: string, input: Record<string, unknown>, id: string) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
    const result = (usage: Record<string, number> | null, safety = 0) =>
      JSON.stringify({ type: "result", is_error: false, num_turns: 4, session_id: "s", ...(usage ? { usage } : {}), safety_stops: safety });
    const limit = (window: string, utilization: number) =>
      JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: window, unifiedWindows: { [window]: { utilization } } } });
    const first = parseTranscript([
      toolUse("WebFetch", { url: "https://example.org/ct-sample/a" }, "t1"), toolUse("WebFetch", { url: "https://example.org/ct-sample/b" }, "t2"),
      toolUse("WebSearch", { query: "sample" }, "t3"), toolUse("Read", { file_path: "drafts/context.json" }, "t4"), limit("seven_day", 0.41),
      result({ input_tokens: 1000, cache_read_input_tokens: 500, output_tokens: 300 }, 1),
    ].join("\n"));
    const repair = parseTranscript([
      toolUse("WebFetch", { url: "https://example.org/ct-sample/c" }, "u1"), limit("five_hour", 0.83),
      result({ input_tokens: 200, output_tokens: 50 }),
    ].join("\n"));
    const noUsage = parseTranscript([toolUse("WebSearch", { query: "x" }, "v1"), result(null, 2)].join("\n"));

    expect(budgetsFrom([first, repair, noUsage], { agentSeconds: 1234.6, repairRounds: 1 })).toEqual({
      agent_seconds: 1235, web_fetches: 3, web_searches: 2, repair_rounds: 1, tokens_in: 1700, tokens_out: 350,
      usage: { window: "five_hour", utilization: 0.83 }, safety_stops: 3,
    });
    // No transcript with usage: tokens null; usage from the newest transcript that reported one.
    expect(budgetsFrom([repair, noUsage].slice(1), { agentSeconds: 0, repairRounds: 0 })).toEqual({
      agent_seconds: 0, web_fetches: 0, web_searches: 1, repair_rounds: 0, tokens_in: null, tokens_out: null, usage: null, safety_stops: 2,
    });
    expect(budgetsFrom([first, noUsage], { agentSeconds: 60, repairRounds: 0 }).usage).toEqual({ window: "seven_day", utilization: 0.41 });
    expect(budgetsFrom([], { agentSeconds: 0, repairRounds: 0 })).toEqual(record().budgets);
    const rec = record();
    rec.budgets = budgetsFrom([first, repair], { agentSeconds: 900, repairRounds: 2 });
    expect(() => RunRecord.parse(rec)).not.toThrow();
  });

  it("ST8 feedsStaleFor names only PARTIAL_FEED_IDS feeds stale or failed, in registry order, with their registry names", () => {
    const rows = feedRecords({
      config, date: D, prior: [],
      index: index(D, {
        kev: { status: "failed", newest: "2026-10-11" }, epss: { status: "stale", newest: "2026-10-10" }, "anthropic-cvd": { status: "stale" },
        therecord: { status: "failed" }, nvd: { status: "stale" }, ghsa: { status: "ok" }, cvelist: { status: "skipped" },
      }),
    });
    const stale = feedsStaleFor(rows, config);
    expect(stale.map((f) => f.id)).toEqual(["kev", "epss", "anthropic-cvd"]);
    const name = (id: string) => config.sources.feeds.find((f) => f.id === id)!.name;
    expect(stale[0]).toEqual({ id: "kev", name: name("kev"), status: "failed", newest: "2026-10-11", stale_since: D });
    expect(stale[1]).toEqual({ id: "epss", name: name("epss"), status: "stale", newest: "2026-10-10", stale_since: D });
    for (const f of stale) expect(PARTIAL_FEED_IDS as readonly string[]).toContain(f.id);
    expect(feedsStaleFor(feedRecords({ config, index: index(D), prior: [], date: D }), config)).toEqual([]);
    // Every PARTIAL_FEED_IDS id is a registry feed, so none is ever named by its id alone.
    for (const id of PARTIAL_FEED_IDS) expect(feedIds).toContain(id);
  });

  it("candidateCounts counts the scored, kept and deep-read candidates of packs/D.candidates.json", () => {
    const kept = (n: number, deep: number) => Array.from({ length: n }, (_, i) => ({ rank: i + 1, deep_read: i < deep }));
    const file = { schema_version: 1, date: D, kept: kept(12, 9), cut: { count: 31, by_reason: { below_cap: 20, merged: 7, bundled: 4 } } } as unknown as CandidatesFile;
    expect(candidateCounts(file)).toEqual({ ranked: 32, kept: 12, deep_read: 9 });
    expect(candidateCounts(null)).toBeNull();
  });
});
