import type { RunOutcome } from "../../lib/vocab";

// Every line scripts/daily.ts and the validate loop write to logs/D.daily.log (SPEC §8.2: the Files table's
// first line, stage 6 step 4, stage 7, Retry, stage 8 and Finish; plan amendment A4), in one place, so the
// orchestrator (lane I), validateLoop() (L4) and NOTES.dryRunValid (L6) say the same thing. Counts take
// the singular for 1. Times are "HH:MM" Taipei. Written by step S0 and frozen.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface FirstLine {
  date: string;
  /** The CLI trigger (`--trigger`, default manual); RunRecord.trigger stays "dry_run" for a dry run. */
  trigger: "schedule" | "manual";
  dryRun: boolean;
  /** dataCutoffFor(D), a UTC date. */
  cutoffUtc: string;
  hardStop: string;
  retryCutoff: string;
}

export interface AgentLine {
  attempt: number;
  /** Set for a repair call: the line reads "Attempt N: repair K: agent ...". */
  repair?: number;
  /** The CLI's exit code; null when it was stopped by a signal (the sandbox guard, a kill at the timeout). */
  exitCode: number | null;
  /** Whole minutes when the attempt timed out, else null. */
  timedOutMin: number | null;
  turns: number;
  /** Per-tool call counts in first-use order (Transcript.toolUses). */
  tools: Record<string, number>;
  fetches: number;
  budget: number;
  /** The result event's is_error. */
  isError: boolean;
}

export type NoRetryReason = "cutoff" | "not_retryable" | "too_little_time";

export const LINES = {
  /** "CyberTracker daily run for D (schedule|manual)[ (dry run)]; data to <cutoffUtc> UTC; hard stop HH:MM; retry cutoff HH:MM." */
  first(o: FirstLine): string {
    return `CyberTracker daily run for ${o.date} (${o.trigger})${o.dryRun ? " (dry run)" : ""}; data to ${o.cutoffUtc} UTC; hard stop ${o.hardStop}; retry cutoff ${o.retryCutoff}.`;
  },
  /** "Agent CLI <version>." (preflight step 7; new wording, A23). */
  cli(version: string): string {
    return `Agent CLI ${version}.`;
  },
  /**
   * "Attempt N: agent exited C · T turns · tools {...} · fetches F/B." or "Attempt N: timed out after M min · ...";
   * " · reported an error" before the full stop when isError. A child stopped by a signal (exit code null)
   * reads "agent was stopped". A repair call reads "Attempt N: repair K: agent ..." (new wording).
   */
  agent(o: AgentLine): string {
    const how = o.timedOutMin !== null
      ? `timed out after ${o.timedOutMin} min`
      : o.exitCode === null ? "agent was stopped" : `agent exited ${o.exitCode}`;
    const parts = [how, plural(o.turns, "turn"), `tools ${JSON.stringify(o.tools)}`, `fetches ${o.fetches}/${o.budget}`];
    if (o.isError) parts.push("reported an error");
    return `Attempt ${o.attempt}: ${o.repair !== undefined ? `repair ${o.repair}: ` : ""}${parts.join(" · ")}.`;
  },
  /** "Attempt N: no draft was written." */
  noDraft(attempt: number): string {
    return `Attempt ${attempt}: no draft was written.`;
  },
  /** "Attempt N: E errors, W warnings (S snapshot)." */
  validation(attempt: number, errors: number, warnings: number, snap: number): string {
    return `Attempt ${attempt}: ${plural(errors, "error")}, ${plural(warnings, "warning")} (${snap} snapshot).`;
  },
  /** "Attempt N: repair K for E errors and S snapshot warnings (CODE1, CODE2)." Distinct codes in issue order; no brackets when none. */
  repair(attempt: number, k: number, errors: number, snap: number, codes: readonly string[]): string {
    const distinct = [...new Set(codes)];
    const list = distinct.length ? ` (${distinct.join(", ")})` : "";
    return `Attempt ${attempt}: repair ${k} for ${plural(errors, "error")} and ${plural(snap, "snapshot warning")}${list}.`;
  },
  /** "No retry: it is past the retry cutoff (05:00)." / "No retry: the error is not retryable." / "No retry: too little time." */
  noRetry(reason: NoRetryReason, retryCutoff: string): string {
    const why = reason === "cutoff" ? `it is past the retry cutoff (${retryCutoff})`
      : reason === "not_retryable" ? "the error is not retryable" : "too little time";
    return `No retry: ${why}.`;
  },
  /** "Dry run complete: drafts/D.json is valid." */
  dryRunComplete(date: string): string {
    return `Dry run complete: drafts/${date}.json is valid.`;
  },
  /** "Full edition published at HH:MM (<sha7>)." */
  fullPublished(hhmm: string, sha7: string): string {
    return `Full edition published at ${hhmm} (${sha7}).`;
  },
  /** "Restarting on the code synced from main (<sha7>)." */
  restarting(sha7: string): string {
    return `Restarting on the code synced from main (${sha7}).`;
  },
  /**
   * "Not withheld: <item ids>; no editorial pass today." Intake's withhold for these items left no binding
   * correction in the tree (it failed to compose, validate or commit), so the run drafts nothing (§0.4 row 149).
   */
  notWithheld(itemIds: readonly string[]): string {
    return `Not withheld: ${[...new Set(itemIds)].join(", ")}; no editorial pass today.`;
  },
  /** "Watchdog: the run passed HH:MM; ending." (new wording, A23) */
  watchdog(hhmm: string): string {
    return `Watchdog: the run passed ${hhmm}; ending.`;
  },
  /** "Run ended: <outcome>." */
  runEnded(outcome: RunOutcome): string {
    return `Run ended: ${outcome}.`;
  },
} as const;
