// Run records and stage notes (SPEC §4.8, §8.2 "notes only from scripts/lib/status.ts templates"; plan
// §2.7 and §5 G9). The notes the chat reads back are lib/chat.ts's STAGE_NOTES (same strings, so
// chatInputFor() finds them); the rest are the spec's texts and G9's new ones. Owner: lane L6. Step S0
// wrote the exports: NOTES is written in full from the plan's texts, the functions are stubs L6 replaces.

import run from "../../config/run.json";
import { STAGE_NOTES, whatHappened, type WhatFacts } from "../../lib/chat";
import type { FeedStale } from "../../lib/schema/brief";
import type { CandidatesFile, FeedIndexFile } from "../../lib/schema/pack";
import type { FeedRecord, RunRecord, StatusFile } from "../../lib/schema/status";
import type { LoadedConfig } from "../../lib/config";
import type { Edition, RunOutcome, RunStage, RunTrigger, StageStatus } from "../../lib/vocab";
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
};

/** Taipei "YYYYMMDD-HHMMSS". */
export function runIdFor(ms: number): string {
  throw new Error("P3 stub: runIdFor (lane L6)");
}

/** Every stage skipped with null times, feeds [], budgets zero, nullables null. */
export function newRunRecord(o: {
  runId: string; trigger: RunTrigger; attempt: number; startedAt: number; codeCommit: string; dataCutoffUtc: string | null;
}): RunRecord {
  throw new Error("P3 stub: newRunRecord (lane L6)");
}

export function setStage(rec: RunRecord, id: RunStage, patch: { status: StageStatus; started?: number; ended?: number; note?: string }): void {
  throw new Error("P3 stub: setStage (lane L6)");
}

/** Joins with one space; over 200 characters keeps the notes chatInputFor reads, then the earliest others, whole. */
export function addNote(rec: RunRecord, id: RunStage, note: string): void {
  throw new Error("P3 stub: addNote (lane L6)");
}

/** D − days to D − 1, newest first. */
export function priorStatus(contentDir: string, date: string, days?: number): StatusFile[] {
  throw new Error("P3 stub: priorStatus (lane L6)");
}

export function feedRecords(o: { config: LoadedConfig; index: FeedIndexFile | null; prior: readonly StatusFile[]; date: string }): FeedRecord[] {
  throw new Error("P3 stub: feedRecords (lane L6)");
}

/** PARTIAL_FEED_IDS only. */
export function feedsStaleFor(feeds: readonly FeedRecord[], config: LoadedConfig): FeedStale[] {
  throw new Error("P3 stub: feedsStaleFor (lane L6)");
}

export function candidateCounts(c: CandidatesFile | null): RunRecord["candidates"] {
  throw new Error("P3 stub: candidateCounts (lane L6)");
}

export function budgetsFrom(transcripts: readonly Transcript[], o: { agentSeconds: number; repairRounds: number }): RunRecord["budgets"] {
  throw new Error("P3 stub: budgetsFrom (lane L6)");
}

export function closeRecord(rec: RunRecord, o: { outcome: RunOutcome; errorCode: string | null; edition: Edition | null; late: boolean; finishedAt: number }): void {
  throw new Error("P3 stub: closeRecord (lane L6)");
}

export function outcomeFor(o: {
  dryRun: boolean; skipped: boolean; full: "full" | "partial" | null;
  /** Published or resumed by this run. */
  dataOnly: boolean;
}): RunOutcome {
  throw new Error("P3 stub: outcomeFor (lane L6)");
}

/** §3.7 of the plan; SPEC §8.2 exit codes. */
export function exitCodeFor(outcome: RunOutcome): 0 | 1 | 3 {
  throw new Error("P3 stub: exitCodeFor (lane L6)");
}

/** One line of logs/runs.jsonl (§8.2 Finish step 5). */
export function runsJsonlLine(o: {
  date: string; run_id: string; trigger: RunTrigger; started: string; ended: string; outcome: RunOutcome;
  edition: Edition | null; attempts: number; repairs: number; error_code: string | null; duration_s: number;
}): string {
  throw new Error("P3 stub: runsJsonlLine (lane L6)");
}
