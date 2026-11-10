// Preflight (SPEC §8.2 "Preflight"): step functions that scripts/daily.ts sequences (plan §2.7, §3.3).
// Steps 1 to 5 throw PreflightFail and leave no status record. Owner: lane L6. Step S0 wrote the exports:
// PreflightFail is final, the functions are stubs L6 replaces.

import type { LoadedConfig } from "../lib/config";
import type { Brief } from "../lib/schema/brief";
import type { cliVersion } from "./lib/agent";
import type { Clock } from "./lib/clock";
import type { syncMain } from "./lib/git";
import type { dropPendingEditions, pushPending } from "./publish";

export type PreflightCode = "E_ARCH" | "E_NODE" | "E_CONFIG" | "E_NET" | "E_GIT" | "E_CLOCK";

export class PreflightFail extends Error {
  constructor(readonly code: PreflightCode, message: string) {
    super(message);
    this.name = "PreflightFail";
  }
}

/** Step 1: arm64, else E_ARCH; Node 22 or newer, else E_NODE. */
export function checkPlatform(o: { arch: string; nodeVersion: string }): void {
  throw new Error("P3 stub: checkPlatform (lane L6)");
}

/** Step 3: loadConfig + validateConfig, else E_CONFIG. */
export function loadRunConfig(root: string): LoadedConfig {
  throw new Error("P3 stub: loadRunConfig (lane L6)");
}

export interface Schedule {
  hardStop: number;
  retryCutoff: number;
  publishUntil: number;
  staleAfter: number;
  /** hardStop, or publishUntil for a non-dry run that started after hardStop. */
  endLimit: number;
  /** §8.2 TIMEOUTS.watchdog */
  watchdogAt: number;
}

export function scheduleFor(o: { date: string; start: number; config: LoadedConfig; noDeadline: boolean; dryRun: boolean }): Schedule {
  throw new Error("P3 stub: scheduleFor (lane L6)");
}

export type ClockState = "normal" | "after_hard_stop" | "too_late";

/** Throws PreflightFail("E_CLOCK") when the cutoff day for D is incomplete. */
export function clockRule(o: { date: string; now: number; dryRun: boolean; noDeadline: boolean; schedule: Schedule }): ClockState {
  throw new Error("P3 stub: clockRule (lane L6)");
}

/** Step 4: HEAD https://github.com answers below 500 within 10 s, else E_NET. */
export function checkNetwork(fetchImpl: typeof fetch, timeoutMs?: number): Promise<void> {
  throw new Error("P3 stub: checkNetwork (lane L6)");
}

export interface GitPrep {
  codeCommit: string;
  restartSha7: string | null;
  notes: string[];
  dropped: number;
  remade: number;
  pushed: number;
}

/** Step 5 (plan §2.7 and A3). SyncError and GitError become PreflightFail("E_GIT"); a PublishError from pushPending is a note. */
export function prepareGit(o: {
  root: string; repo?: string; config: LoadedConfig; dryRun: boolean; now: Clock; reexec: boolean; log: (line: string) => void;
}, fns?: { dropPendingEditions?: typeof dropPendingEditions; pushPending?: typeof pushPending; syncMain?: typeof syncMain }): Promise<GitPrep> {
  throw new Error("P3 stub: prepareGit (lane L6)");
}

/** node_modules/.ct-lock-sha missing or not the SHA-256 of package-lock.json. */
export function depsChanged(root: string): boolean {
  throw new Error("P3 stub: depsChanged (lane L6)");
}

export type IdempotencyState = "new" | "resume" | "skip_published" | "skip_late" | "replace";

/** Step 6. */
export function idempotency(o: { contentDir: string; date: string; clock: ClockState; force: boolean }): { state: IdempotencyState; existing: Brief | null; note: string | null } {
  throw new Error("P3 stub: idempotency (lane L6)");
}

/** Step 7. */
export function checkCliAndToken(o: {
  readToken: () => Promise<string | null>; bin: string; cliVersion?: typeof cliVersion;
}): Promise<{ code: "E_CLI" | "E_AUTH" | null; token: string | null; version: string | null }> {
  throw new Error("P3 stub: checkCliAndToken (lane L6)");
}
