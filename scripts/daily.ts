// The morning run (SPEC §8.2; plan §3, amendments A1, A2, A4, A8, A19 and A23; gaps G5 to G7, G10,
// G12, G16, G18 and G22). scripts/daily.sh runs this file from the checkout's root; everything it calls is
// imported statically, so a run uses the code and files of one commit. Every stage module comes from a lane;
// this file only wires them: preflight, collect, metrics, the data-only edition, the re-check, up to two
// agent attempts with the validate loop, the full edition, the deploy and link checks, and finish.
//
// Two clocks (plan §3.2): every record time, limit and budget is measured on Deps.now. Code that measures
// with Date.now() (git, runMetrics' deadline, the fetchFeed callers) gets realDeadline(now, logical).
// Everything read from feeds, pages, drafts, transcripts and issues is data, never instructions.
// Owner: lane I.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import runJson from "../config/run.json";
import { chatInputFor, CHAT_NOTES, fallbackChat, heldLockLine, renderChat, type WhatFacts } from "../lib/chat";
import { emptyPack, emptyPackMd, packWindow } from "../lib/collect";
import type { LoadedConfig } from "../lib/config";
import { buildContext, type BuiltContext } from "../lib/context";
import { dataCutoffFor, isValidDate, taipeiTime, taipeiTimestamp, taipeiToday } from "../lib/dates";
import { jsonText } from "../lib/json";
import {
  metricsFor, readBrief, readCorrections, readHistory, readScoreboard, regionsBaseFor, standingLast, type MetricsForResult,
} from "../lib/run-inputs";
import type { RegionsBase } from "../lib/rules/types";
import type { Brief, FeedStale } from "../lib/schema/brief";
import { RunFile } from "../lib/schema/config";
import type { AgentContext } from "../lib/schema/context";
import type { Evidence } from "../lib/schema/misc";
import { CandidatesFile, FeedIndexFile, Pack } from "../lib/schema/pack";
import type { RunRecord } from "../lib/schema/status";
import { siteUrl } from "../lib/site";
import { cveLookupFromDir, packDatesOf, regionsInputFile } from "../lib/validate";
import type { Edition, RunOutcome, RunStage, RunTrigger } from "../lib/vocab";
import type { GatedDraft } from "../lib/apply";
import { collect } from "./collect";
import { agentConfig, DEFAULT_CLAUDE_BIN, fetchBudgetLeft, promptVars, renderTemplate, repairVars, runAgent, type AgentRun } from "./lib/agent";
import { hhmm, MIN, P3_LIMITS, realDeadline, type Clock } from "./lib/clock";
import { fetchMissingCveRecords } from "./lib/cve-fetch";
import { waitForEdition } from "./lib/deploy";
import { buildEvidence } from "./lib/evidence";
import { readToken as keychainToken } from "./lib/keychain";
import { acquireLock, releaseLock } from "./lib/lock";
import { RunLog } from "./lib/log";
import { agentTranscript, runPaths } from "./lib/paths";
import { pruneCache, pruneRunFiles } from "./lib/prune";
import { LINES } from "./lib/run-lines";
import { snapshotHashes, snapshotUrls, type Snapshot } from "./lib/snapshot";
import {
  addNote, budgetsFrom, candidateCounts, closeRecord, exitCodeFor, feedRecords, feedsStaleFor, newRunRecord, NOTES, outcomeFor, priorStatus,
  runIdFor, runsJsonlLine, setStage,
} from "./lib/status";
import type { Transcript } from "./lib/transcript";
import { validateLoop, type ValidateLoopIo } from "./lib/validate-loop";
import { runMetrics } from "./metrics";
import {
  checkCliAndToken, checkNetwork, checkPlatform, clockRule, depsChanged, idempotency, loadRunConfig, prepareGit, PreflightFail, scheduleFor,
  type ClockState, type IdempotencyState, type Schedule,
} from "./preflight";
import { PublishError, publishDataOnly, publishFull, publishStatus, publishWithholds, type PublishOptions, type Sleep, type StatusEvent } from "./publish";
import { applyLinkResults, checkLinks, intakeDisputes, recheckItems, writeRecheckLog, type IntakeResult, type LinkResult, type LinksOutcome } from "./recheck";

// ── Exports (plan §3.1) ──────────────────────────────────────────────────────────────────────────────

/** config/run.json beside this script, read once at import (§8.2). */
export const CONFIG: RunFile = RunFile.parse(runJson);

/** The fixed limits tests pin (§8.2 TIMEOUTS); deployWait is computed per call. */
export const TIMEOUTS = P3_LIMITS;

/** One attempt's agent time: min(agent_minutes, hardStop − now − 10 min). Under 10 min the attempt is not started. */
export function attemptBudget(hardStop: number, now: number): number {
  return Math.min(CONFIG.budgets.agent_minutes * MIN, hardStop - now - P3_LIMITS.agentReserveMs);
}

/** One repair round's time: left = hardStop − now − publish reserve; under 2 min 0, else min(6 min, left). stop−20 → 6, stop−7 → 3, stop−5 → 0. */
export function repairBudget(hardStop: number, now: number): number {
  const left = hardStop - now - CONFIG.budgets.publish_reserve_minutes * MIN;
  return left < P3_LIMITS.repairFloorMs ? 0 : Math.min(P3_LIMITS.repairMaxMs, left);
}

export { NEXT_STEP } from "../lib/chat";

export interface Deps {
  now?: () => number;
  /** The network probe, dispute intake and deploy check (never feeds; plan G6). */
  fetchImpl?: typeof fetch;
  readToken?: () => Promise<string | null>;
  /** An origin URL that counts as repos.repo. */
  repo?: string;
  /** Replaces the child process of a restart (tests). */
  restart?: (argv: string[]) => Promise<number>;
  /** Default process.arch (plan G5). */
  arch?: string;
  /** Publish's push retry waits (2, 4 and 8 s); default a real timer, tests pass an instant one. */
  sleep?: Sleep;
}

/** The watchdog's error class: its name is all fallbackChat() shows. */
export class WatchdogTimeout extends Error {
  constructor() {
    super("the run passed its watchdog time");
    this.name = "WatchdogTimeout";
  }
}

// ── Arguments ────────────────────────────────────────────────────────────────────────────────────────

const USAGE = "Usage: tsx scripts/daily.ts [--date YYYY-MM-DD] [--trigger schedule|manual] [--dry-run] [--force] [--no-deadline] [--data-only] [--simulate-failure]";

interface Args {
  date: string | null;
  trigger: "schedule" | "manual" | null;
  dryRun: boolean;
  force: boolean;
  noDeadline: boolean;
  dataOnly: boolean;
  simulateFailure: boolean;
}

/** Throws on an unknown flag, a flag without its value, a positional or a --trigger other than schedule or manual (plan G12). */
function parseCli(argv: string[]): Args {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      date: { type: "string" },
      trigger: { type: "string" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      "no-deadline": { type: "boolean" },
      "data-only": { type: "boolean" },
      "simulate-failure": { type: "boolean" },
    },
  });
  const trigger = values.trigger ?? null;
  if (trigger !== null && trigger !== "schedule" && trigger !== "manual") throw new Error(`--trigger takes schedule or manual, not ${trigger}.`);
  return {
    date: values.date ?? null,
    trigger,
    dryRun: values["dry-run"] === true,
    force: values.force === true,
    noDeadline: values["no-deadline"] === true,
    dataOnly: values["data-only"] === true,
    simulateFailure: values["simulate-failure"] === true,
  };
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────────

/** Re-executes this file once with the same argv and CT_REEXEC=1 (§8.2 "Code and files of one commit"); resolves with its exit code. */
function spawnSelf(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(path.join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/daily.ts", ...argv], {
      cwd: process.cwd(), stdio: "inherit", env: { ...process.env, CT_REEXEC: "1" },
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const errorText = (e: unknown) => (e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e));

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function readJsonFile<T>(file: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): T | null {
  try {
    const r = schema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** The newest brief in a content folder, for the failed format's "Site shows" line. */
function newestBrief(dir: string): { date: string; edition: Edition } | null {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(dir, "briefs")).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().reverse();
  } catch {
    return null;
  }
  for (const n of names) {
    const b = readBrief(dir, n.slice(0, 10));
    if (b) return { date: b.date, edition: b.edition };
  }
  return null;
}

/** "pid N from <ISO>" (lock.ts) to the lock's Taipei HH:MM; an unreadable lock has no time. */
function staleLockTime(replaced: string): string {
  const m = /from (\S+)$/.exec(replaced);
  const ms = m ? Date.parse(m[1]!) : Number.NaN;
  return Number.isFinite(ms) ? hhmm(ms) : "an unknown time";
}

const emptyCandidates = (date: string): CandidatesFile => ({
  schema_version: 1, date, kept: [], cut: { count: 0, by_reason: { below_cap: 0, merged: 0, bundled: 0 } },
});

const RETRYABLE: ReadonlySet<string> = new Set(["E_AGENT", "E_TIMEOUT", "E_VALIDATION"]);

/** The codes that stop an agent call, first or repair, in §8.2's order: a sandbox breach, a lost sign-in, the usage limit. */
function agentStop(r: AgentRun): "E_SANDBOX" | "E_AUTH" | "E_LIMIT" | null {
  if (r.sandbox.length) return "E_SANDBOX";
  if (r.transcript.authFailed) return "E_AUTH";
  if (r.transcript.limitHit) return "E_LIMIT";
  return null;
}

/**
 * Thrown out of a repair round (validateLoop's io.repair) whose agent call agentStop() stopped: its init broke
 * the sandbox, or it was signed out or hit the usage limit. No later repair can fix that, so §8.2 stage 6's
 * checks hold for repairs too: the validate loop stops there and the run fails with the same code as the first
 * call would, with no retry.
 */
class RepairStopped extends Error {
  constructor(readonly code: "E_SANDBOX" | "E_AUTH" | "E_LIMIT") {
    super(`a repair round's agent call was stopped (${code})`);
    this.name = "RepairStopped";
  }
}

type Issue = { code: string; path: string; severity?: "error" | "warning"; message?: string };

interface RunState {
  /** This run's records, oldest first; the last is the current one. */
  records: RunRecord[];
  code: string | null;
  /** A failure at preflight steps 1 to 5 (no record). */
  noRecordCode: string | null;
  skipped: boolean;
  /** This run published or resumed the data-only edition. */
  dataOnly: boolean;
  /** This run published the data-only edition (a resume does not count). */
  dataOnlyPublished: boolean;
  full: "full" | "partial" | null;
  /** A brief: commit this run pushed. */
  pushedBrief: boolean;
  issues: Issue[] | null;
  /** Chat-only notes (CHAT_NOTES.statusNotSaved). */
  notes: string[];
  linkResults: LinkResult[] | null;
  restartCode?: number;
  /** A dry run's first publish call makes the copy (A1's rule for §3.8). */
  freshCopy: boolean;
  attempts: number;
  repairs: number;
  mf: MetricsForResult | null;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2), deps: Deps = {}): Promise<number> {
  const now: Clock = deps.now ?? Date.now;
  const start = now();
  const root = process.cwd();
  const env = process.env;

  let a: Args;
  try {
    a = parseCli(argv);
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  const today = taipeiToday(new Date(start));
  const D = a.date ?? today;
  if (!isValidDate(D)) {
    console.error(`Invalid --date ${D}`);
    return 2;
  }
  if (D !== today && !a.dryRun) {
    console.error("Publishing a date other than today needs --dry-run; past editions are never published.");
    return 2;
  }
  if (env.CT_FIXTURE_FEEDS && !a.dryRun && env.NODE_ENV !== "test") {
    console.error("CT_FIXTURE_FEEDS needs --dry-run.");
    return 2;
  }
  const dryRun = a.dryRun;
  const noDeadline = a.noDeadline || (dryRun && D !== today);
  const trigger: RunTrigger = dryRun ? "dry_run" : (a.trigger ?? "manual");
  const cliTrigger = a.trigger ?? "manual";
  const fetchImpl = deps.fetchImpl ?? fetch;

  const P = runPaths(root, D);
  fs.mkdirSync(path.dirname(P.dailyLog), { recursive: true });
  const log = new RunLog(P.dailyLog, true, now);
  const line = (l: string) => log.line(l);
  /** The folder this run's editions land in: the dry-run copy, else content/. */
  const outDir = () => (dryRun ? P.dryRunCopy : P.content);

  const state: RunState = {
    records: [], code: null, noRecordCode: null, skipped: false, dataOnly: false, dataOnlyPublished: false, full: null,
    pushedBrief: false, issues: null, notes: [], linkResults: null, freshCopy: dryRun, attempts: 0, repairs: 0, mf: null,
  };
  const cur = (): RunRecord => {
    const r = state.records.at(-1);
    if (!r) throw new Error("daily: no run record yet");
    return r;
  };
  const setCur = (r: RunRecord) => {
    state.records[state.records.length - 1] = r;
  };

  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const clearWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  };

  /**
   * The no-record failure (preflight steps 1 to 5): the failed chat format, a runs.jsonl line, exit 1. A
   * dry run keeps its own forms (§8.2, §8.8): the dry-run failed format, outcome dry_run with the code, exit 0.
   */
  const finishNoRecord = (code: string): number => {
    const outcome: RunOutcome = dryRun ? "dry_run" : "failed";
    let summary: string;
    try {
      summary = renderChat(chatInputFor({ date: D, brief: null, runs: [], code, dryRun, siteShows: newestBrief(P.content), needsReview: false }), siteUrl());
    } catch (e) {
      line(errorText(e));
      summary = fallbackChat(D, e);
    }
    try {
      writeFile(P.summary, summary);
      fs.appendFileSync(P.runsJsonl, runsJsonlLine({
        date: D, run_id: runIdFor(start), trigger, started: taipeiTimestamp(new Date(start)), ended: taipeiTimestamp(new Date(now())),
        outcome, edition: null, attempts: 0, repairs: 0, error_code: code, duration_s: Math.max(0, Math.round((now() - start) / 1000)),
      }));
    } catch (e) {
      line(errorText(e));
    }
    clearWatchdog();
    releaseLock(P.lock);
    line(LINES.runEnded(outcome));
    console.log(summary.replace(/\n$/, ""));
    return exitCodeFor(outcome);
  };

  // Step 1, before the lock, so a wrong Node never touches logs/.lock.
  try {
    checkPlatform({ arch: deps.arch ?? process.arch, nodeVersion: process.versions.node });
  } catch (e) {
    if (e instanceof PreflightFail) {
      line(e.message);
      return finishNoRecord(e.code);
    }
    throw e;
  }

  // Step 2.
  const lock = acquireLock(P.lock, now());
  if (!lock.acquired) {
    const held = heldLockLine(D, lock.holder.started);
    console.log(held);
    if (!fs.existsSync(P.summary)) writeFile(P.summary, `${held}\n`);
    return 0;
  }
  const staleNote = lock.replacedStale ? NOTES.staleLock(staleLockTime(lock.replacedStale)) : null;

  // Set once preflight has them.
  let config: LoadedConfig | null = null;
  let s: Schedule | null = null;
  let codeCommit = "";
  let idem: { state: IdempotencyState; existing: Brief | null; note: string | null } = { state: "new", existing: null, note: null };
  let clock: ClockState = "normal";
  let cli: { code: "E_CLI" | "E_AUTH" | null; token: string | null; version: string | null } = { code: null, token: null, version: null };

  const takeFresh = () => {
    const f = state.freshCopy;
    state.freshCopy = false;
    return f;
  };
  const base = (deadline: number): PublishOptions => ({
    root, date: D, deadline, now, dryRun, freshCopy: takeFresh(), repo: deps.repo, config: config!, records: state.records, log: line,
    sleep: deps.sleep,
  });
  const facts = (o: Partial<WhatFacts> = {}): WhatFacts => {
    const last = state.records.at(-1);
    return {
      date: D,
      errors: last?.validation?.errors ?? 0,
      repairs: state.repairs,
      attempts: state.attempts,
      agentMinutes: last && last.budgets.agent_seconds > 0 ? Math.round(last.budgets.agent_seconds / 60) : null,
      hardStop: s ? hhmm(s.hardStop) : CONFIG.schedule.hard_stop,
      publishUntil: CONFIG.schedule.publish_until,
      ...o,
    };
  };
  /** A stage failure that sets the run's error code: the stage `failed` with whatHappened()'s note. */
  const fail = (code: string, stage: RunStage, extra: Partial<WhatFacts> = {}) => {
    state.code = code;
    setStage(cur(), stage, { status: "failed", ended: now(), note: NOTES.failure(code, facts(extra)) });
  };

  // ── Stages 2 to 10 (plan §3.4) ───────────────────────────────────────────────────────────────────

  const stages = async () => {
    const cfg = config!;
    const sch = s!;
    const budgetFetches = cfg.run.budgets.web_fetches;

    // 2. Collect.
    const collectStart = now();
    setStage(cur(), "collect", { status: "ok", started: collectStart });
    let collectFailed: "timeout" | "error" | null = null;
    try {
      await collect({ date: D, deadline: now() + P3_LIMITS.collectMs, asOf: dryRun && D !== today, fixtureOk: dryRun, root, deps: { now } });
    } catch (e) {
      collectFailed = e instanceof Error && e.name === "CollectTimeout" ? "timeout" : "error";
      line(errorText(e));
    }
    let pack = collectFailed ? null : readJsonFile(P.pack, Pack);
    if (pack && pack.date !== D) pack = null;
    if (!pack) {
      collectFailed ??= "error";
      pack = emptyPack(D, packWindow(D, cfg.run.pack), taipeiTimestamp(new Date(now())), dataCutoffFor(D));
      writeFile(P.pack, jsonText(pack, Pack));
      writeFile(P.packMd, emptyPackMd(D));
      writeFile(P.packCandidates, jsonText(emptyCandidates(D), CandidatesFile));
      line(NOTES.collectorFailed(collectFailed));
    }
    const candidates = (collectFailed ? null : readJsonFile(P.packCandidates, CandidatesFile)) ?? emptyCandidates(D);
    const collectEnd = now();
    cur().feeds = feedRecords({
      config: cfg, index: collectFailed ? null : readJsonFile(P.feedIndex, FeedIndexFile), prior: priorStatus(P.content, D), date: D,
      checkedAt: taipeiTimestamp(new Date(collectEnd)),
    });
    cur().candidates = candidateCounts(candidates);
    setStage(cur(), "collect", {
      status: collectFailed ? "failed" : pack.degraded ? "degraded" : "ok", ended: collectEnd,
      note: collectFailed ? NOTES.collectorFailed(collectFailed) : undefined,
    });
    const feedsStale: FeedStale[] = feedsStaleFor(cur().feeds, cfg);
    const edition: "full" | "partial" = feedsStale.length ? "partial" : "full";

    // 3. Metrics.
    const metricsStart = now();
    setStage(cur(), "metrics", { status: "ok", started: metricsStart });
    let metricsLines: string[] = [];
    const committed = fs.existsSync(path.join(P.content, "metrics", `${D}.json`));
    if (committed) {
      addNote(cur(), "metrics", NOTES.reusedMetrics(D));
    } else {
      try {
        const m = await runMetrics({ date: D, root, deadline: realDeadline(now, now() + P3_LIMITS.metricsMs), now: new Date(now()) });
        metricsLines = m.lines;
        writeFile(P.metricsLog, m.lines.length ? `${m.lines.join("\n")}\n` : "");
      } catch (e) {
        line(errorText(e));
      }
    }
    state.mf = metricsFor(root, P.content, D);
    if (!state.mf) {
      fail("E_METRICS", "metrics");
    } else {
      const blocks = Object.entries(state.mf.metrics.blocks).filter(([, b]) => b.status !== "ok").map(([id]) => id);
      setStage(cur(), "metrics", {
        status: blocks.length ? "degraded" : "ok", ended: now(), note: blocks.length ? NOTES.degradedBlocks(blocks) : undefined,
      });
      const flood = metricsLines.map((l) => /Flood counts stop at (\d{4}-\d{2}-\d{2}): run npm run backfill/.exec(l)).find((x) => x !== null);
      if (flood) addNote(cur(), "metrics", NOTES.floodStops(flood[1]!));
    }
    const mf = state.mf;
    const baseOfRegions = (): RegionsBase => regionsBaseFor({ root, contentDir: P.content, date: D, pack, config: cfg });
    let regionsBase = baseOfRegions();

    // 4. The data-only edition.
    const dataOnlyTarget = cfg.run.schedule.data_only_target;
    if (idem.state === "resume") {
      setStage(cur(), "data_only", { status: "skipped", note: NOTES.dataOnlyUpSince(taipeiTime(idem.existing!.published_at)) });
      state.dataOnly = true;
    } else if (idem.state === "replace") {
      setStage(cur(), "data_only", { status: "skipped" });
    } else if (!mf) {
      setStage(cur(), "data_only", { status: "skipped", note: NOTES.notRun("metrics") });
    } else if (now() > sch.publishUntil) {
      setStage(cur(), "data_only", { status: "skipped", note: NOTES.tooLate(cfg.run.schedule.publish_until) });
      // 11:00 passed during collect or metrics: whatever follows, nothing of D is published by this run.
      state.code ??= "E_TOO_LATE";
    } else {
      const t0 = now();
      setStage(cur(), "data_only", { status: "ok", started: t0 });
      try {
        const res = await publishDataOnly({ ...base(now() + P3_LIMITS.dataOnlyPublishMs), feedsStale, generatedAt: pack.generated_at });
        setCur(res.record);
        state.dataOnly = true;
        state.dataOnlyPublished = true;
        if (!dryRun) state.pushedBrief = true;
        setStage(cur(), "data_only", { status: "ok", ended: now() });
        const masked = new Set((res.masked ?? []).map((m) => m.item_id)).size;
        if (masked) addNote(cur(), "data_only", NOTES.maskedRepeats(masked));
        const at = hhmm(Date.parse(res.publishedAt));
        if (!dryRun && at > dataOnlyTarget) addNote(cur(), "data_only", NOTES.missedTarget("data_only", at, dataOnlyTarget));
      } catch (e) {
        line(errorText(e));
        setStage(cur(), "data_only", { status: "failed", ended: now(), note: NOTES.dataOnlyFailed });
        if (e instanceof PublishError && e.code === "compose") addNote(cur(), "data_only", NOTES.notComposed);
      }
    }

    // 5. The re-check (at least 6 min before the run's end limit).
    let intake: IntakeResult | null = null;
    let shown: AgentContext["corrections"]["flagged"] = [];
    if (sch.endLimit - now() < P3_LIMITS.linksMinLeftMs) {
      setStage(cur(), "recheck", { status: "skipped", note: NOTES.tooLittleTime(hhmm(sch.endLimit)) });
    } else {
      const t0 = now();
      setStage(cur(), "recheck", { status: "ok", started: t0 });
      if (!dryRun) {
        try {
          intake = await intakeDisputes({ root, date: D, contentDir: P.content, config: cfg, now, fetchImpl, log: line });
        } catch (e) {
          line(errorText(e));
          intake = null;
          addNote(cur(), "recheck", NOTES.intakeUnavailable);
        }
        if (intake && !intake.ok) addNote(cur(), "recheck", NOTES.intakeUnavailable);
        if (intake && intake.withhold.length) {
          const n = new Set(intake.withhold.map((w) => w.item_id)).size;
          addNote(cur(), "recheck", NOTES.withheld(n, intake.waiting));
          try {
            const res = await publishWithholds({ ...base(now() + P3_LIMITS.finalCommitMs), requests: intake.withhold, disputes: intake.disputes });
            setCur(res.record);
          } catch (e) {
            line(errorText(e));
          }
          // The history stage 3 read predates the withhold: region reasons embed headlines (§5.11), so the
          // validator, the full edition and logs/D.regions-input.json read the rewritten briefs.
          regionsBase = baseOfRegions();
        }
      }
      let recheckFailed = false;
      try {
        const ok = (id: string) => {
          const f = cur().feeds.find((x) => x.id === id);
          return !!f && f.status !== "failed" && f.status !== "skipped";
        };
        const rc = await recheckItems({
          root, date: D, contentDir: P.content, config: cfg, feedsOk: { kev: ok("kev"), cvelist: ok("cvelist") },
          deadline: realDeadline(now, now() + 2 * MIN), log: line, disputes: intake?.disputes ?? null,
        });
        cur().recheck = rc.record;
        shown = rc.shown;
        if (rc.skipped.length) addNote(cur(), "recheck", NOTES.flagsSkipped(rc.skipped));
      } catch (e) {
        line(errorText(e));
        recheckFailed = true;
      }
      setStage(cur(), "recheck", { status: recheckFailed ? "failed" : "ok", ended: now() });
      try {
        writeRecheckLog(root, D, { intake, flagged: cur().recheck, shown, reports: intake?.reports ?? [] });
      } catch (e) {
        line(errorText(e));
      }
    }

    // 6, 7 and 8, per attempt.
    const skipEditorial = (note: string) => {
      for (const st of ["draft", "validate", "publish"] as const) setStage(cur(), st, { status: "skipped", note });
    };
    if (a.dataOnly) skipEditorial(NOTES.dataOnlyRequested);
    else if (clock === "after_hard_stop") skipEditorial(NOTES.startedAfterHardStop(cfg.run.schedule.hard_stop));
    else if (!mf) skipEditorial(NOTES.notRun("metrics"));
    else if (cli.code) {
      skipEditorial(NOTES.notRun("cli"));
      state.code ??= cli.code;
    } else {
      await attempts({ cfg, sch, pack, candidates, mf, regionsBase, feedsStale, edition, intake, shown, budgetFetches });
    }

    // 9 and 10, concurrently; not in dry runs.
    if (dryRun) {
      setStage(cur(), "deploy", { status: "skipped", note: NOTES.notInDryRun });
      setStage(cur(), "links", { status: "skipped", note: NOTES.notInDryRun });
      return;
    }
    const deployStage = async () => {
      if (state.code === "E_METRICS") {
        setStage(cur(), "deploy", { status: "skipped", note: NOTES.notRun("metrics") });
        return;
      }
      const t0 = now();
      setStage(cur(), "deploy", { status: "ok", started: t0 });
      const triggered = state.pushedBrief;
      const raw = env.CT_DEPLOY_WAIT_MS;
      const configured = raw !== undefined && raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : cfg.run.budgets.deploy_wait_minutes * MIN;
      const wait = Math.min(configured, sch.endLimit - now() - P3_LIMITS.deployReserveMs);
      try {
        const d = await waitForEdition(D, readBrief(P.content, D)?.edition ?? null, wait, { now, fetchImpl });
        cur().deploy = { triggered, ready_at: d.ready_at, shows_date: d.shows_date, shows_edition: d.shows_edition };
        setStage(cur(), "deploy", { status: "ok", ended: now(), note: d.shows ? undefined : NOTES.siteNotShowing(Math.max(0, Math.round(wait / MIN))) });
      } catch (e) {
        line(errorText(e));
        cur().deploy = { triggered, ready_at: null, shows_date: null, shows_edition: null };
        setStage(cur(), "deploy", { status: "failed", ended: now() });
      }
    };
    const linksStage = async () => {
      if (sch.endLimit - now() < P3_LIMITS.linksMinLeftMs) {
        setStage(cur(), "links", { status: "skipped", note: NOTES.tooLittleTime(hhmm(sch.endLimit)) });
        return;
      }
      const t0 = now();
      setStage(cur(), "links", { status: "ok", started: t0 });
      let lk: LinksOutcome;
      try {
        lk = await checkLinks({ root, date: D, contentDir: P.content, config: cfg, now, endLimit: sch.endLimit, log: line });
      } catch (e) {
        line(errorText(e));
        setStage(cur(), "links", { status: "failed", ended: now() });
        return;
      }
      cur().links = lk.record;
      state.linkResults = lk.results;
      setStage(cur(), "links", { status: "ok", ended: now(), note: lk.notReached > 0 ? NOTES.notReached(lk.notReached) : undefined });
      try {
        writeRecheckLog(root, D, { intake, flagged: cur().recheck, shown, reports: intake?.reports ?? [], links: lk });
      } catch (e) {
        line(errorText(e));
      }
    };
    await Promise.all([deployStage(), linksStage()]);
  };

  // ── Attempts, validation, retry and publish (plan §3.5) ──────────────────────────────────────────

  interface AttemptInputs {
    cfg: LoadedConfig;
    sch: Schedule;
    pack: Pack;
    candidates: CandidatesFile;
    mf: MetricsForResult;
    regionsBase: RegionsBase;
    feedsStale: FeedStale[];
    edition: "full" | "partial";
    intake: IntakeResult | null;
    shown: AgentContext["corrections"]["flagged"];
    budgetFetches: number;
  }

  const attempts = async (x: AttemptInputs) => {
    const { cfg, sch } = x;
    const loopState = { repairsUsed: 0, maxRepairs: cfg.run.budgets.repair_rounds };
    const transcripts: Transcript[] = [];
    const runSnapshots: Snapshot[] = [];
    const max = cfg.run.budgets.attempts_max;
    const readRoutine = (name: string) => fs.readFileSync(path.join(root, "routine", name), "utf8");

    /** After attempt N failed with `code`: true when a retry record was opened and attempt N + 1 should run. */
    const maybeRetry = async (code: string, attempt: number): Promise<boolean> => {
      if (attempt >= max) return false;
      const reason = !RETRYABLE.has(code) ? "not_retryable" as const
        : now() > sch.retryCutoff ? "cutoff" as const
        : attemptBudget(sch.hardStop, now()) < P3_LIMITS.agentMinMs ? "too_little_time" as const : null;
      if (reason) {
        line(LINES.noRetry(reason, hhmm(sch.retryCutoff)));
        return false;
      }
      const rec1 = cur();
      const outcome1: RunOutcome = state.dataOnly ? "published_data_only" : "failed";
      const brief = readBrief(outDir(), D);
      closeRecord(rec1, { outcome: outcome1, errorCode: code, edition: brief?.edition ?? null, late: lateOf(brief), finishedAt: now() });
      let t2 = now();
      if (runIdFor(t2) === rec1.run_id) t2 += 1_000;
      const rec2 = newRunRecord({ runId: runIdFor(t2), trigger: "retry", attempt: attempt + 1, startedAt: t2, codeCommit, dataCutoffUtc: dataCutoffFor(D) });
      for (const st of ["preflight", "collect", "metrics", "data_only", "recheck"] as const) {
        setStage(rec2, st, { status: "skipped", note: NOTES.reusedFrom(rec1.run_id) });
      }
      rec2.feeds = structuredClone(rec1.feeds);
      rec2.candidates = structuredClone(rec1.candidates);
      rec2.recheck = structuredClone(rec1.recheck);
      state.records.push(rec2);
      state.code = null;
      // Attempt 1's validator issues belong to its record; the failed format lists only the last attempt's.
      state.issues = null;
      const event: StatusEvent = { kind: "retry", outcome: outcome1, retryId: rec2.run_id };
      try {
        await publishStatus({ ...base(now() + P3_LIMITS.finalCommitMs), event });
      } catch (e) {
        line(errorText(e));
        if (!state.notes.includes(CHAT_NOTES.statusNotSaved)) state.notes.push(CHAT_NOTES.statusNotSaved);
      }
      return true;
    };

    for (let attempt = 1; attempt <= max; attempt++) {
      state.attempts = attempt;
      const t = attemptBudget(sch.hardStop, now());
      if (t < P3_LIMITS.agentMinMs) {
        fail("E_TIMEOUT", "draft", { agentMinutes: null });
        if (attempt === 1) await maybeRetry("E_TIMEOUT", attempt);
        else line(LINES.noRetry("too_little_time", hhmm(sch.retryCutoff)));
        return;
      }
      const draftStart = now();
      setStage(cur(), "draft", { status: "ok", started: draftStart });
      fs.rmSync(P.draft, { force: true });

      let built: BuiltContext;
      try {
        built = buildContext({
          date: D, now: now(), deadline: now() + t - P3_LIMITS.contextReserveMs, pack: x.pack, candidates: x.candidates, metrics: x.mf.metrics,
          config: cfg, history: readHistory(P.content, D, 14), today: readBrief(P.content, D), corrections: readCorrections(P.content), disputes: x.intake?.disputes ?? null,
          scoreboard: readScoreboard(P.content),
          regionsBase: x.regionsBase, recheck: { flagged: x.shown, reports: x.intake?.reports ?? [] }, standingLast: standingLast(P.content, D),
        }, line);
      } catch (e) {
        line(errorText(e));
        fail("E_INTERNAL", "draft");
        return;
      }
      writeFile(P.contextCopy, built.text);
      writeFile(P.contextLog, built.text);
      writeFile(P.regionsInput, jsonText(regionsInputFile(x.regionsBase)));
      const prompt = renderTemplate(readRoutine("PROMPT.md"), promptVars({
        root, date: D, context: built.context, fetchBudget: fetchBudgetLeft(x.budgetFetches, transcripts), maxItems: cfg.run.budgets.items_max,
      }));
      const agentCfg = agentConfig(root, cli.token ?? "");
      const attemptTranscripts: Transcript[] = [];
      let agentMs = 0;
      const t0 = now();
      const ar: AgentRun = await runAgent(prompt, agentCfg, { timeoutMs: t, transcriptFile: agentTranscript(P, attempt), sessionId: randomUUID() });
      agentMs += now() - t0;
      transcripts.push(ar.transcript);
      attemptTranscripts.push(ar.transcript);
      line(LINES.agent({
        attempt, exitCode: ar.run.code, timedOutMin: ar.run.timedOut ? Math.round(t / MIN) : null, turns: ar.transcript.numTurns ?? 0,
        tools: ar.transcript.toolUses, fetches: ar.transcript.toolUses.WebFetch ?? 0, budget: x.budgetFetches, isError: ar.transcript.isError === true,
      }));
      const setBudgets = (repairRounds: number) => {
        cur().budgets = budgetsFrom(attemptTranscripts, { agentSeconds: agentMs / 1000, repairRounds });
      };
      setBudgets(0);
      const stopped = agentStop(ar);
      if (stopped) {
        fail(stopped, "draft");
        await maybeRetry(stopped, attempt);
        return;
      }
      if (!fs.existsSync(P.draft)) {
        line(LINES.noDraft(attempt));
        const code = ar.run.timedOut ? "E_TIMEOUT" : "E_AGENT";
        fail(code, "draft");
        if (await maybeRetry(code, attempt)) continue;
        return;
      }
      setStage(cur(), "draft", { status: "ok", ended: now() });

      // 7. Validate, with the soft pass and repairs (§4.12).
      setStage(cur(), "validate", { status: "ok", started: now() });
      fs.mkdirSync(P.cveRecords, { recursive: true });
      let roundsRun = 0;
      const io: ValidateLoopIo = {
        readDraft: () => {
          try {
            return { ok: true, value: JSON.parse(fs.readFileSync(P.draft, "utf8")) as unknown };
          } catch (e) {
            return { ok: false, error: e instanceof SyntaxError ? e.message : "the file could not be read" };
          }
        },
        writeDraft: (g) => writeFile(P.draft, jsonText(g)),
        fetchCves: async (ids) => {
          await fetchMissingCveRecords({ root, cveIds: ids, deadline: realDeadline(now, now() + 60_000), config: cfg, log: line });
        },
        snapshot: async (urls) => {
          const deadline = realDeadline(now, Math.min(now() + P3_LIMITS.snapshotRoundMs, sch.hardStop - P3_LIMITS.snapshotReserveMs));
          runSnapshots.push(...(await snapshotUrls({ root, urls, deadline, config: cfg, now, log: line })).taken);
        },
        evidence: () => {
          const ev = buildEvidence({ transcripts, pack: x.pack, snapshots: runSnapshots });
          writeFile(P.evidence, jsonText(ev));
          return ev;
        },
        cveList: () => cveLookupFromDir(P.cveRecords),
        repair: async (k, issues) => {
          const vars = repairVars({ root, date: D, context: built.context, fetchBudget: fetchBudgetLeft(x.budgetFetches, transcripts), issues });
          const t1 = now();
          const tr = repairBudget(sch.hardStop, t1);
          const r = await runAgent(renderTemplate(readRoutine("REPAIR.md"), vars), agentCfg, {
            resume: ar.sessionId, timeoutMs: tr, transcriptFile: agentTranscript(P, attempt, k),
          });
          agentMs += now() - t1;
          transcripts.push(r.transcript);
          attemptTranscripts.push(r.transcript);
          roundsRun = k;
          const stop = agentStop(r);
          if (stop) {
            line(LINES.agent({
              attempt, repair: k, exitCode: r.run.code, timedOutMin: r.run.timedOut ? Math.round(tr / MIN) : null, turns: r.transcript.numTurns ?? 0,
              tools: r.transcript.toolUses, fetches: r.transcript.toolUses.WebFetch ?? 0, budget: x.budgetFetches, isError: r.transcript.isError === true,
            }));
            throw new RepairStopped(stop);
          }
        },
        repairBudgetMs: () => repairBudget(sch.hardStop, now()),
        log: line,
        writeValidation: (r) => writeFile(P.validation, jsonText(r)),
        writeDropped: (r) => writeFile(P.dropped, jsonText(r)),
      };
      let out: Awaited<ReturnType<typeof validateLoop>>;
      try {
        out = await validateLoop(attempt, {
          context: built.context, metrics: x.mf.metrics, config: cfg, regionsBase: x.regionsBase, packDates: packDatesOf(x.pack), fileDate: D,
        }, io, loopState);
      } catch (e) {
        if (!(e instanceof RepairStopped)) throw e;
        // A repair round denied by the sandbox, signed out or stopped by the usage limit: never retried (§8.2).
        state.repairs = loopState.repairsUsed;
        setBudgets(roundsRun);
        fail(e.code, "validate");
        await maybeRetry(e.code, attempt);
        return;
      }
      state.repairs = loopState.repairsUsed;
      cur().validation = {
        errors: out.result.errors.length, warnings: out.result.warnings.length,
        codes: [...new Set([...out.result.errors, ...out.result.warnings].map((i) => i.code))].sort(),
      };
      cur().soft_gates = out.softGates;
      setBudgets(out.repairs);
      if (!out.ok || !out.draft) {
        state.issues = out.issues;
        fail("E_VALIDATION", "validate", { errors: out.result.errors.length });
        if (await maybeRetry("E_VALIDATION", attempt)) continue;
        return;
      }
      setStage(cur(), "validate", { status: "ok", ended: now() });
      if (a.simulateFailure) {
        state.code = "E_SIMULATED";
        state.issues = [{ code: "SIMULATED", path: "(run)", severity: "error" }];
        setStage(cur(), "validate", { status: "failed", note: NOTES.simulated });
        return;
      }
      await publishStage(x, out.draft, built.context, io.evidence(), runSnapshots);
      return;
    }
  };

  /** Stage 8: the full (or partial) edition. */
  const publishStage = async (x: AttemptInputs, gated: GatedDraft, context: AgentContext, evidence: Evidence, runSnapshots: readonly Snapshot[]) => {
    const { cfg, sch } = x;
    const t0 = now();
    if (!dryRun && now() > sch.publishUntil) {
      setStage(cur(), "publish", { status: "failed", started: t0 });
      return fail("E_TOO_LATE", "publish");
    }
    setStage(cur(), "publish", { status: "ok", started: t0 });
    if (dryRun) line(LINES.dryRunComplete(D));
    fs.mkdirSync(P.cveRecords, { recursive: true });
    try {
      const res = await publishFull({
        ...base(dryRun ? Number.POSITIVE_INFINITY : sch.hardStop - P3_LIMITS.publishFullMarginMs),
        force: dryRun || a.force || idem.state === "replace",
        edition: x.edition, draft: gated, context, evidence, cveList: cveLookupFromDir(P.cveRecords), regionsBase: x.regionsBase,
        snapshots: snapshotHashes(runSnapshots), feedsStale: x.feedsStale, disputes: x.intake?.disputes ?? null, recheck: cur().recheck,
      });
      setCur(res.record);
      state.full = x.edition;
      setStage(cur(), "publish", { status: "ok", ended: now() });
      const masked = new Set((res.masked ?? []).filter((m) => m.match !== "carried").map((m) => m.item_id)).size;
      if (masked) addNote(cur(), "publish", NOTES.maskedRepeats(masked));
      const kept = new Set((res.masked ?? []).filter((m) => m.match === "carried" && !m.draft_id).map((m) => m.item_id)).size;
      if (kept) addNote(cur(), "publish", NOTES.keptWithheld(kept));
      const inSlot = new Set((res.masked ?? []).filter((m) => m.match === "carried" && m.draft_id).map((m) => m.item_id)).size;
      if (inSlot) addNote(cur(), "publish", NOTES.keptInSlot(inSlot));
      if (dryRun) return;
      state.pushedBrief = true;
      const at = hhmm(Date.parse(res.publishedAt));
      line(LINES.fullPublished(at, (res.sha ?? "").slice(0, 7)));
      if (idem.state === "replace" && idem.existing) addNote(cur(), "publish", NOTES.replaced(taipeiTime(idem.existing.published_at)));
      const target = cfg.run.schedule.full_target;
      if (at > target) addNote(cur(), "publish", NOTES.missedTarget("full", at, target));
    } catch (e) {
      line(errorText(e));
      fail("E_PUBLISH", "publish");
      if (e instanceof PublishError && e.code === "compose") addNote(cur(), "publish", NOTES.notComposed);
      if (e instanceof PublishError && e.code === "validation") addNote(cur(), "publish", NOTES.notValid);
    }
  };

  /** `late` for a record: the brief's, when this run published it. */
  const lateOf = (brief: Brief | null) => ((state.full || state.dataOnlyPublished) && brief ? brief.late : false);

  // ── Finish (plan §3.6) ───────────────────────────────────────────────────────────────────────────

  const finish = async (): Promise<number> => {
    if (state.noRecordCode || state.records.length === 0) return finishNoRecord(state.noRecordCode ?? "E_INTERNAL");
    const rec = cur();
    const outcome = outcomeFor({ dryRun, skipped: state.skipped, full: state.full, dataOnly: state.dataOnly });
    let errorCode = outcome === "failed" || outcome === "published_data_only" || outcome === "dry_run" ? state.code : null;
    // Nothing published and no stage named why (a dry run: nothing written to its copy): with no editorial
    // code, the data-only edition's own failure, else an unexpected one.
    const nothingOut = outcome === "failed" || (dryRun && !state.skipped && !state.full && !state.dataOnly);
    if (nothingOut && !errorCode) {
      errorCode = rec.stages.find((x) => x.id === "data_only")?.status === "failed" ? "E_DATA_ONLY" : "E_INTERNAL";
    }
    const brief = readBrief(outDir(), D);
    closeRecord(rec, { outcome, errorCode, edition: brief?.edition ?? null, late: lateOf(brief), finishedAt: now() });

    // G16: the failure bundle whenever the run has an error code and is not a dry run.
    if (errorCode && !dryRun) {
      try {
        const logsDir = path.dirname(P.dailyLog);
        const files = [P.draft, P.contextCopy, P.packMd, ...fs.readdirSync(logsDir).filter((n) => n.startsWith(`${D}.`)).map((n) => path.join(logsDir, n))];
        fs.mkdirSync(P.needsReview, { recursive: true });
        for (const f of files) {
          if (fs.existsSync(f) && fs.statSync(f).isFile()) fs.copyFileSync(f, path.join(P.needsReview, path.basename(f)));
        }
      } catch (e) {
        line(errorText(e));
      }
    }

    const results = state.linkResults;
    try {
      await publishStatus({
        ...base(now() + P3_LIMITS.finalCommitMs), event: { kind: "ended", outcome },
        updateArchive: results && results.length ? (ix) => applyLinkResults(ix, D, results) : undefined,
      });
    } catch (e) {
      line(errorText(e));
      if (!state.notes.includes(CHAT_NOTES.statusNotSaved)) state.notes.push(CHAT_NOTES.statusNotSaved);
    }

    let summary: string;
    try {
      summary = renderChat(chatInputFor({
        date: D, brief: readBrief(outDir(), D), runs: state.records, notes: state.notes, issues: state.issues, siteShows: newestBrief(outDir()),
        metrics: state.mf?.metrics ?? null, needsReview: !!errorCode && !dryRun,
      }), siteUrl());
    } catch (e) {
      line(errorText(e));
      summary = fallbackChat(D, e);
    }
    const first = state.records[0]!;
    try {
      writeFile(P.summary, summary);
      fs.appendFileSync(P.runsJsonl, runsJsonlLine({
        date: D, run_id: first.run_id, trigger: first.trigger, started: first.started_at, ended: rec.finished_at ?? taipeiTimestamp(new Date(now())),
        outcome, edition: rec.edition, attempts: state.attempts, repairs: state.repairs, error_code: errorCode,
        duration_s: Math.max(0, Math.round((now() - start) / 1000)),
      }));
    } catch (e) {
      line(errorText(e));
    }
    pruneRunFiles(root, today);
    // File times are on the real clock, whatever deps.now says.
    pruneCache(root, Date.now());
    clearWatchdog();
    releaseLock(P.lock);
    line(LINES.runEnded(outcome));
    console.log(summary.replace(/\n$/, ""));
    return exitCodeFor(outcome);
  };

  // ── Preflight steps 3 to 8 (plan §3.3) ─────────────────────────────────────────────────────────────

  /** Steps 3 to 8, then the stages; returns early for a restart, a skip or E_PUSH, all of which go to finish (or exit with the child's code). */
  const body = async (): Promise<void> => {
    // Step 3.
    config = loadRunConfig(root);
    s = scheduleFor({ date: D, start, config, noDeadline, dryRun });
    const sch = s;
    watchdog = setTimeout(() => {
      try {
        writeFile(P.summary, fallbackChat(D, new WatchdogTimeout()));
        line(LINES.watchdog(hhmm(sch.watchdogAt)));
      } finally {
        releaseLock(P.lock);
        process.exit(1);
      }
    }, Math.max(0, sch.watchdogAt - now()));
    watchdog.unref();
    line(LINES.first({ date: D, trigger: cliTrigger, dryRun, cutoffUtc: dataCutoffFor(D), hardStop: hhmm(sch.hardStop), retryCutoff: hhmm(sch.retryCutoff) }));
    clock = clockRule({ date: D, now: now(), dryRun, noDeadline, schedule: sch });

    // Step 4.
    await checkNetwork(fetchImpl);

    // Step 5.
    const gp = await prepareGit({ root, repo: deps.repo, config, dryRun, now, reexec: env.CT_REEXEC === "1", log: line, sleep: deps.sleep });
    if (gp.restartSha7) {
      line(LINES.restarting(gp.restartSha7));
      clearWatchdog();
      releaseLock(P.lock);
      state.restartCode = await (deps.restart ?? spawnSelf)(argv);
      return;
    }
    codeCommit = gp.codeCommit;
    const preNotes = [staleNote, ...gp.notes, depsChanged(root) ? NOTES.depsChanged : null].filter((n): n is string => n !== null);

    // Step 6, and the skip decided at once (A1): a skipped run makes exactly one status commit, in finish.
    idem = idempotency({ contentDir: P.content, date: D, clock, force: a.force, dataOnly: a.dataOnly });
    const newRecord = () => newRunRecord({
      runId: runIdFor(start), trigger, attempt: 1, startedAt: start, codeCommit, dataCutoffUtc: dataCutoffFor(D),
    });
    if (clock === "too_late" || idem.state === "skip_published" || idem.state === "skip_late") {
      const rec = newRecord();
      setStage(rec, "preflight", { status: "ok", started: start, ended: now() });
      for (const n of [...preNotes, idem.note]) if (n) addNote(rec, "preflight", n);
      state.records.push(rec);
      state.skipped = true;
      return;
    }

    // Step 7.
    if (!a.dataOnly && clock === "normal") {
      cli = await checkCliAndToken({ readToken: deps.readToken ?? keychainToken, bin: env.CT_CLAUDE_BIN || DEFAULT_CLAUDE_BIN });
      if (cli.version) line(LINES.cli(cli.version));
    }

    // Step 8: the start record, the real write probe.
    const rec = newRecord();
    state.records.push(rec);
    setStage(rec, "preflight", { status: cli.code ? "degraded" : "ok", started: start, ended: now() });
    for (const n of [...preNotes, idem.note]) if (n) addNote(rec, "preflight", n);
    if (cli.code) {
      state.code = cli.code;
      addNote(rec, "preflight", NOTES.failure(cli.code, facts()));
    }
    try {
      const res = await publishStatus({ ...base(now() + P3_LIMITS.finalCommitMs), event: { kind: "started" } });
      setCur(res.record);
    } catch (e) {
      line(errorText(e));
      state.code = "E_PUSH";
      return;
    }
    await stages();
  };

  try {
    await body();
  } catch (e) {
    line(errorText(e));
    if (state.records.length === 0) state.noRecordCode = e instanceof PreflightFail ? e.code : "E_INTERNAL";
    else state.code ??= "E_INTERNAL";
  }
  if (state.restartCode !== undefined) return state.restartCode;
  try {
    return await finish();
  } catch (e) {
    line(errorText(e));
    clearWatchdog();
    releaseLock(P.lock);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
