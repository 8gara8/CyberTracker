// Run records and stage notes (SPEC §4.8, §8.2 "notes only from scripts/lib/status.ts templates"; plan
// §2.7, §3.7 and §5 G9). The notes the chat reads back are lib/chat.ts's STAGE_NOTES (same strings, so
// chatInputFor() finds them); the rest are the spec's texts and G9's new ones. A stage holds one note of
// at most 200 characters: notes on one stage are joined with one space, and past 200 the notes the chat
// reads are kept first, then the earliest others, each whole. Every time is written as a Taipei
// timestamp with its offset. Pure apart from priorStatus(), which reads content/status/. Owner: lane L6.

import run from "../../config/run.json";
import { STAGE_NOTES, whatHappened, type WhatFacts } from "../../lib/chat";
import { addDays, taipeiTimestamp } from "../../lib/dates";
import type { FeedStale } from "../../lib/schema/brief";
import type { CandidatesFile, FeedIndexEntry, FeedIndexFile } from "../../lib/schema/pack";
import type { FeedRecord, RunRecord, StageRecord, StatusFile } from "../../lib/schema/status";
import type { LoadedConfig } from "../../lib/config";
import { readStatus } from "../../lib/run-inputs";
import { PARTIAL_FEED_IDS, RUN_STAGES, type Edition, type RunOutcome, type RunStage, type RunTrigger, type StageStatus } from "../../lib/vocab";
import { LINES } from "./run-lines";
import type { Transcript } from "./transcript";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type NotRunReason = "metrics" | "cli" | "data_only" | "hard_stop";

export interface Notes {
  // Re-used from lib/chat.ts STAGE_NOTES (same strings, so chatInputFor reads them back).
  dataOnlyRequested: string;
  startedAfterHardStop(hhmm: string): string;
  alreadyPublished(hhmm: string): string;
  tooLate(hhmm: string): string;
  replaced(hhmm: string): string;
  floodStops(date: string): string;
  depsChanged: string;
  // The spec's texts.
  /** "Restored content/ left by an earlier run." */
  restored: string;
  /** "Restarted on the code synced from main (<sha7>)." */
  restarted(sha7: string): string;
  /** "Collector failed (timeout); continuing with an empty, degraded pack." */
  collectorFailed(kind: "timeout" | "error"): string;
  /** "Reused metrics/D.json." */
  reusedMetrics(date: string): string;
  /** "Data-only edition already up since HH:MM." */
  dataOnlyUpSince(hhmm: string): string;
  /** "Data-only edition not published." */
  dataOnlyFailed: string;
  /** "Dispute intake unavailable today." */
  intakeUnavailable: string;
  /** "Reused from run <run_id>." */
  reusedFrom(runId: string): string;
  /** "Dry run complete: drafts/D.json is valid." (LINES.dryRunComplete) */
  dryRunValid(date: string): string;
  // New texts (plan §5 G9).
  staleLock(hhmm: string): string;
  droppedPending(n: number): string;
  remadeWithholds(n: number): string;
  dryRunTree: string;
  degradedBlocks(ids: readonly string[]): string;
  withheld(n: number, waiting: number): string;
  flagsSkipped(feeds: readonly string[]): string;
  tooLittleTime(hhmm: string): string;
  notInDryRun: string;
  missedTarget(kind: "data_only" | "full", at: string, target: string): string;
  siteNotShowing(minutes: number): string;
  notReached(n: number): string;
  simulated: string;
  notRun(reason: NotRunReason): string;
  /** whatHappened(code, facts) from lib/chat.ts */
  failure(code: string, facts: WhatFacts): string;
  /** Preflight step 5 (an addition to G9): pushPending() refused or failed; the commits stay local for the next run. */
  pendingNotPushed: string;
  /** Publish's PublishError("compose"): the composer found a fact missing (lib/apply.ts ComposeError). */
  notComposed: string;
}

/** Every stage note text; each ends with a full stop. */
export const NOTES: Notes = {
  dataOnlyRequested: STAGE_NOTES.dataOnlyRequested,
  startedAfterHardStop: STAGE_NOTES.startedAfterHardStop,
  alreadyPublished: STAGE_NOTES.alreadyPublished,
  tooLate: STAGE_NOTES.tooLate,
  replaced: STAGE_NOTES.replaced,
  floodStops: STAGE_NOTES.floodStops,
  depsChanged: STAGE_NOTES.depsChanged,

  restored: "Restored content/ left by an earlier run.",
  restarted: (sha7) => `Restarted on the code synced from main (${sha7}).`,
  collectorFailed: (kind) => `Collector failed (${kind}); continuing with an empty, degraded pack.`,
  reusedMetrics: (date) => `Reused metrics/${date}.json.`,
  dataOnlyUpSince: (hhmm) => `Data-only edition already up since ${hhmm}.`,
  dataOnlyFailed: "Data-only edition not published.",
  intakeUnavailable: "Dispute intake unavailable today.",
  reusedFrom: (runId) => `Reused from run ${runId}.`,
  dryRunValid: (date) => LINES.dryRunComplete(date),

  staleLock: (hhmm) => `Replaced a stale lock from ${hhmm}.`,
  droppedPending: (n) => `Dropped ${plural(n, "unpushed edition commit")} left by an earlier run.`,
  remadeWithholds: (n) => `Remade ${plural(n, "withhold")} from the dropped commits.`,
  dryRunTree: "Dry run: the branch and uncommitted files were left as they were.",
  degradedBlocks: (ids) => `Shown with older data: ${ids.join(", ")}.`,
  withheld: (n, waiting) =>
    `Withheld ${plural(n, "item")} on reader disputes${waiting > 0 ? `; ${waiting} ${waiting === 1 ? "waits" : "wait"} for the next run` : ""}.`,
  flagsSkipped: (feeds) => `Re-check flags from ${feeds.join(" and ")} skipped: the ${feeds.length === 1 ? "feed" : "feeds"} failed.`,
  tooLittleTime: (hhmm) => `Not run: under 6 minutes left before ${hhmm}.`,
  notInDryRun: "Not run in a dry run.",
  missedTarget: (kind, at, target) => `${kind === "data_only" ? "Data-only" : "Full"} edition published at ${at}, after the ${target} target.`,
  siteNotShowing: (minutes) => `The site did not show this edition within ${plural(minutes, "minute")}.`,
  notReached: (n) => `${plural(n, "link")} not reached in time.`,
  simulated: "Simulated failure (--simulate-failure).",
  notRun: (reason) => {
    switch (reason) {
      case "metrics": return "Not run: no metrics file.";
      case "cli": return "Not run: the agent CLI or its sign-in token is missing.";
      case "data_only": return "Not run: the data-only edition stands.";
      case "hard_stop": return STAGE_NOTES.startedAfterHardStop(run.schedule.hard_stop);
    }
  },
  failure: (code, facts) => whatHappened(code, facts),
  pendingNotPushed: "Commits left unpushed by an earlier run could not be pushed; the next run tries again.",
  notComposed: "Not composed: a release or CVE block lacks its date, page or record facts (see the daily log).",
};

/** StageRecord.note's limit (§4.8). */
export const NOTE_MAX = 200;

/**
 * The stage notes chatInputFor() reads back (lib/chat.ts STAGE_NOTES, matched as its regexes match them):
 * addNote() keeps these first when a stage's notes pass NOTE_MAX. tests/status.test.ts (ST3, ST4) checks
 * that each STAGE_NOTES text matches one of these and that chatInputFor() finds it in a record.
 */
export const CHAT_READ_NOTES: readonly RegExp[] = [
  /^Data-only run requested \(--data-only\)\.$/,
  /^Started after \d\d:\d\d: no editorial pass today\.$/,
  /^The full edition was already published at \d\d:\d\d\.$/,
  /^Too late: nothing is published after \d\d:\d\d\.$/,
  /^Replaced the \d\d:\d\d edition \(--force\)\.$/,
  /^Flood counts stop at \d{4}-\d{2}-\d{2}: run npm run backfill -- --catch-up --push\.$/,
  /^Dependencies changed since the last npm ci\.$/,
];

const isChatRead = (note: string) => CHAT_READ_NOTES.some((re) => re.test(note));

/** A taipeiTimestamp() of an epoch ms: "2026-10-14T04:37:02+08:00". */
const stamp = (ms: number) => taipeiTimestamp(new Date(ms));

/** Taipei "YYYYMMDD-HHMMSS". */
export function runIdFor(ms: number): string {
  if (!Number.isFinite(ms)) throw new Error(`runIdFor: not a time: ${ms}`);
  const t = stamp(ms); // YYYY-MM-DDTHH:MM:SS+08:00
  return `${t.slice(0, 10).replace(/-/g, "")}-${t.slice(11, 19).replace(/:/g, "")}`;
}

/** Every stage skipped with null times, feeds [], budgets zero, nullables null. */
export function newRunRecord(o: {
  runId: string; trigger: RunTrigger; attempt: number; startedAt: number; codeCommit: string; dataCutoffUtc: string | null;
}): RunRecord {
  return {
    run_id: o.runId,
    trigger: o.trigger,
    attempt: o.attempt,
    started_at: stamp(o.startedAt),
    finished_at: null,
    outcome: null,
    edition: null,
    error_code: null,
    code_commit: o.codeCommit,
    data_cutoff_utc: o.dataCutoffUtc,
    data_only_published_at: null,
    full_published_at: null,
    late: false,
    stages: RUN_STAGES.map((id): StageRecord => ({ id, status: "skipped", started_at: null, ended_at: null, note: null })),
    feeds: [],
    budgets: {
      agent_seconds: 0, web_fetches: 0, web_searches: 0, repair_rounds: 0, tokens_in: null, tokens_out: null, usage: null,
      safety_stops: 0,
    },
    candidates: null,
    validation: null,
    soft_gates: null,
    deploy: { triggered: false, ready_at: null, shows_date: null, shows_edition: null },
    recheck: null,
    links: null,
  };
}

function stageOf(rec: RunRecord, id: RunStage): StageRecord {
  const s = rec.stages.find((x) => x.id === id);
  if (!s) throw new Error(`Run record ${rec.run_id} has no ${id} stage.`);
  return s;
}

/** Sets a stage's status and, when given, its start and end times (epoch ms); a note is added with addNote(). */
export function setStage(rec: RunRecord, id: RunStage, patch: { status: StageStatus; started?: number; ended?: number; note?: string }): void {
  const s = stageOf(rec, id);
  s.status = patch.status;
  if (patch.started !== undefined) s.started_at = stamp(patch.started);
  if (patch.ended !== undefined) s.ended_at = stamp(patch.ended);
  if (patch.note !== undefined) addNote(rec, id, patch.note);
}

/**
 * The notes a stage note holds, in order. Every template ends with a full stop and none holds a full stop
 * followed by a space, so the joined note splits back exactly.
 */
export function splitNotes(note: string | null): string[] {
  if (!note) return [];
  return note.split(/(?<=\.)\s+(?=\S)/).map((n) => n.trim()).filter(Boolean);
}

/** A note longer than NOTE_MAX on its own (none of the templates is) is cut, so the record stays valid. */
const fitOne = (note: string) => (note.length <= NOTE_MAX ? note : `${note.slice(0, NOTE_MAX - 1).trimEnd()}…`);

/** Past NOTE_MAX: the chat-read notes first, then the others earliest first, each kept whole when it fits; original order kept. */
function capNotes(notes: readonly string[]): string[] {
  if (notes.join(" ").length <= NOTE_MAX) return [...notes];
  const keep = new Set<number>();
  let len = -1; // the joined length so far; each note adds its length and one space
  const take = (i: number) => {
    const add = notes[i]!.length + 1;
    if (len + add <= NOTE_MAX) {
      keep.add(i);
      len += add;
    }
  };
  notes.forEach((n, i) => isChatRead(n) && take(i));
  notes.forEach((n, i) => !isChatRead(n) && take(i));
  return notes.filter((_, i) => keep.has(i));
}

/**
 * Joins with one space; over 200 characters keeps the notes chatInputFor reads, then the earliest others,
 * whole. A note the stage already holds is not added twice; an empty note is ignored.
 */
export function addNote(rec: RunRecord, id: RunStage, note: string): void {
  const s = stageOf(rec, id);
  const add = note.replace(/\s+/g, " ").trim();
  if (!add) return;
  const notes = splitNotes(s.note);
  if (notes.includes(add)) return;
  const joined = capNotes([...notes, fitOne(add)]).join(" ");
  s.note = joined === "" ? null : joined;
}

/** D − days to D − 1, newest first: the status files that exist and parse. */
export function priorStatus(contentDir: string, date: string, days = 14): StatusFile[] {
  const out: StatusFile[] = [];
  for (let i = 1; i <= days; i++) {
    const s = readStatus(contentDir, addDays(date, -i));
    if (s) out.push(s);
  }
  return out;
}

/** The feed's row in a status file's final run: the last record that holds feeds (a start record holds none). */
function feedIn(s: StatusFile, id: string): FeedRecord | null {
  const r = [...s.runs].reverse().find((x) => x.feeds.length > 0);
  return r?.feeds.find((f) => f.id === id) ?? null;
}

/**
 * stale_since for a feed stale or failed today: carried from the newest earlier status file that lists the
 * feed when it was stale or failed there (its stale_since, else that file's date); D when it was ok,
 * skipped or never listed, since a new streak starts today.
 */
function staleSince(prior: readonly StatusFile[], id: string, date: string): string {
  const earlier = prior.filter((s) => s.date < date).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const s of earlier) {
    const f = feedIn(s, id);
    if (!f) continue;
    return f.status === "stale" || f.status === "failed" ? (f.stale_since ?? s.date) : date;
  }
  return date;
}

/**
 * RunRecord.feeds (§8.2 stage 2): one row per config/sources.yaml feed, in registry order, from collect's
 * cache/feeds/index.json for D. A feed the index lacks (collect failed, or the index is another day's) is
 * `failed` with nothing read (`skipped` for a search entry, which collect never fetches). `checked_at` is
 * the feed's fetch time, else `checkedAt` (an addition: the time collect ended), else the index's
 * generated_at, else now. `records` is null for a failed or skipped feed. `stale_since` as staleSince().
 */
export function feedRecords(o: {
  config: LoadedConfig; index: FeedIndexFile | null; prior: readonly StatusFile[]; date: string; checkedAt?: string;
}): FeedRecord[] {
  const index = o.index && o.index.date === o.date ? o.index : null;
  const byId = new Map<string, FeedIndexEntry>((index?.feeds ?? []).map((f) => [f.id, f]));
  const fallback = o.checkedAt ?? index?.generated_at ?? taipeiTimestamp();
  return o.config.sources.feeds.map((feed): FeedRecord => {
    const e = byId.get(feed.id);
    const status = e?.status ?? (feed.kind === "search" ? "skipped" : "failed");
    const bad = status === "stale" || status === "failed";
    return {
      id: feed.id,
      status,
      newest: e?.newest ?? null,
      checked_at: e?.fetched_at ?? fallback,
      stale_since: bad ? staleSince(o.prior, feed.id, o.date) : null,
      records: e && (status === "ok" || status === "stale") ? e.records : null,
      note: e?.note ?? null,
    };
  });
}

const PARTIAL: ReadonlySet<string> = new Set(PARTIAL_FEED_IDS);

/** Brief.feeds_stale: the PARTIAL_FEED_IDS feeds stale or failed, in the records' (registry) order, named from the registry. */
export function feedsStaleFor(feeds: readonly FeedRecord[], config: LoadedConfig): FeedStale[] {
  const names = new Map(config.sources.feeds.map((f) => [f.id, f.name]));
  return feeds
    .filter((f): f is FeedRecord & { status: "stale" | "failed" } => PARTIAL.has(f.id) && (f.status === "stale" || f.status === "failed"))
    .map((f) => ({ id: f.id, name: names.get(f.id) ?? f.id, status: f.status, newest: f.newest, stale_since: f.stale_since }));
}

/**
 * RunRecord.candidates from packs/D.candidates.json: `ranked` counts every scored candidate (the kept ones
 * and those cut below the cap; merged and bundled records were never scored, as rankCandidates() counts
 * them), `kept` the kept ones, `deep_read` those marked for a close read. Null without the file.
 */
export function candidateCounts(c: CandidatesFile | null): RunRecord["candidates"] {
  if (!c) return null;
  return { ranked: c.kept.length + c.cut.by_reason.below_cap, kept: c.kept.length, deep_read: c.kept.filter((k) => k.deep_read).length };
}

/**
 * RunRecord.budgets over an attempt's transcripts (the first call and its repairs, §8.2 stage 6 step 5):
 * WebFetch and WebSearch calls counted, tokens summed from the result events' usage (null when none has
 * one), `usage` the last rate_limit_event's window, `safety_stops` summed. `agentSeconds` is rounded.
 */
export function budgetsFrom(transcripts: readonly Transcript[], o: { agentSeconds: number; repairRounds: number }): RunRecord["budgets"] {
  const sum = (f: (t: Transcript) => number) => transcripts.reduce((n, t) => n + f(t), 0);
  const withUsage = transcripts.filter((t) => t.usage !== null);
  const usage = [...transcripts].reverse().find((t) => t.rateLimitUsage !== null)?.rateLimitUsage ?? null;
  return {
    agent_seconds: Math.max(0, Math.round(o.agentSeconds)),
    web_fetches: sum((t) => t.toolUses.WebFetch ?? 0),
    web_searches: sum((t) => t.toolUses.WebSearch ?? 0),
    repair_rounds: Math.max(0, Math.round(o.repairRounds)),
    tokens_in: withUsage.length ? withUsage.reduce((n, t) => n + t.usage!.input, 0) : null,
    tokens_out: withUsage.length ? withUsage.reduce((n, t) => n + t.usage!.output, 0) : null,
    usage: usage ? { window: usage.window, utilization: Math.max(0, usage.utilization) } : null,
    safety_stops: sum((t) => t.safetyStops),
  };
}

/** Finish step 1 (§8.2): the outcome, error code, edition, `late` and the end time. */
export function closeRecord(rec: RunRecord, o: { outcome: RunOutcome; errorCode: string | null; edition: Edition | null; late: boolean; finishedAt: number }): void {
  rec.outcome = o.outcome;
  rec.error_code = o.errorCode;
  rec.edition = o.edition;
  rec.late = o.late;
  rec.finished_at = stamp(o.finishedAt);
}

/**
 * The plan's §3.7: a dry run is always `dry_run`; a skip at preflight step 6 is `skipped`; a full or
 * partial edition this run published is `published_full` or `published_partial`; else a data-only
 * edition this run published or resumed is `published_data_only`; else `failed`.
 */
export function outcomeFor(o: {
  dryRun: boolean; skipped: boolean; full: "full" | "partial" | null;
  /** Published or resumed by this run. */
  dataOnly: boolean;
}): RunOutcome {
  if (o.dryRun) return "dry_run";
  if (o.skipped) return "skipped";
  if (o.full === "full") return "published_full";
  if (o.full === "partial") return "published_partial";
  return o.dataOnly ? "published_data_only" : "failed";
}

/** §3.7 of the plan; SPEC §8.2 exit codes: 0 published_full, published_partial, skipped, dry_run; 1 failed; 3 published_data_only. */
export function exitCodeFor(outcome: RunOutcome): 0 | 1 | 3 {
  switch (outcome) {
    case "published_full":
    case "published_partial":
    case "skipped":
    case "dry_run":
      return 0;
    case "published_data_only":
      return 3;
    case "failed":
      return 1;
  }
}

/**
 * One line of logs/runs.jsonl (§8.2 Finish step 5): the JSON object with its keys in the spec's order,
 * ending with a newline, so the caller appends it as it is.
 */
export function runsJsonlLine(o: {
  date: string; run_id: string; trigger: RunTrigger; started: string; ended: string; outcome: RunOutcome;
  edition: Edition | null; attempts: number; repairs: number; error_code: string | null; duration_s: number;
}): string {
  const line = {
    date: o.date, run_id: o.run_id, trigger: o.trigger, started: o.started, ended: o.ended, outcome: o.outcome,
    edition: o.edition, attempts: o.attempts, repairs: o.repairs, error_code: o.error_code, duration_s: o.duration_s,
  };
  return `${JSON.stringify(line)}\n`;
}
