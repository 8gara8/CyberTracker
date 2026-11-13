// Preflight (SPEC §8.2 "Preflight"): step functions that scripts/daily.ts sequences (plan §2.7, §3.3).
// Steps 1 to 5 throw PreflightFail and leave no status record; step 6 decides a skip, a resume or a
// replacement from content/briefs/D.json as synced; step 7 checks the agent CLI and reads the token, and a
// failure there only turns the run into a data-only run. The lock (step 2) and the start record (step 8)
// are daily.ts's, through scripts/lib/lock.ts and publish. Every git command goes through
// scripts/lib/git.ts (GIT_TERMINAL_PROMPT=0, a timeout per command). Messages name codes, paths and
// counts, never a remote URL or a token. The network probe and the ls-remote push-path probe follow
// Europe's scripts/preflight.ts. Owner: lane L6.

import fs from "node:fs";
import path from "node:path";
import run from "../config/run.json";
import { ConfigError, loadCheckedConfig, type LoadedConfig } from "../lib/config";
import { addDays, at, taipeiTime } from "../lib/dates";
import { sha256Hex } from "../lib/json";
import { readBrief } from "../lib/run-inputs";
import type { Brief } from "../lib/schema/brief";
import { cliVersion as defaultCliVersion, type cliVersion } from "./lib/agent";
import { P3_LIMITS, type Clock } from "./lib/clock";
import { GitError, git, isClean, porcelainPaths, syncMain as defaultSyncMain, type syncMain } from "./lib/git";
import { NOTES } from "./lib/status";
import {
  CONTENT_LAYOUT, PublishError, dropPendingEditions as defaultDropPendingEditions, pushPending as defaultPushPending,
  type Sleep, type dropPendingEditions, type pushPending,
} from "./publish";

export type PreflightCode = "E_ARCH" | "E_NODE" | "E_CONFIG" | "E_NET" | "E_GIT" | "E_CLOCK";

export class PreflightFail extends Error {
  constructor(readonly code: PreflightCode, message: string) {
    super(message);
    this.name = "PreflightFail";
  }
}

/** The oldest Node major the run accepts (§8.2 step 1, Appendix C). */
export const MIN_NODE_MAJOR = 22;

/** Step 1: arm64, else E_ARCH; Node 22 or newer, else E_NODE. `nodeVersion` is process.versions.node ("22.11.0"; a leading "v" is allowed). */
export function checkPlatform(o: { arch: string; nodeVersion: string }): void {
  if (o.arch !== "arm64") {
    throw new PreflightFail("E_ARCH", `Not native arm64 (${o.arch}): put /opt/homebrew/bin first on the PATH (SPEC Appendix C).`);
  }
  const m = /^v?(\d+)\.\d+/.exec(o.nodeVersion.trim());
  const major = m ? Number(m[1]) : Number.NaN;
  if (!(major >= MIN_NODE_MAJOR)) {
    throw new PreflightFail("E_NODE", `Node ${o.nodeVersion} is older than ${MIN_NODE_MAJOR}: use /opt/homebrew/bin/node (SPEC Appendix C).`);
  }
}

/** Step 3: loadConfig + validateConfig, else E_CONFIG. Read fresh, so a run reads the config of the commit it runs. */
export function loadRunConfig(root: string): LoadedConfig {
  try {
    return loadCheckedConfig({ root, fresh: true });
  } catch (e) {
    if (e instanceof ConfigError) {
      const first = e.issues[0];
      const n = e.issues.length;
      throw new PreflightFail("E_CONFIG", `config/ fails its checks: ${n} problem${n === 1 ? "" : "s"}${first ? `, first ${first.code} at ${first.path}` : ""}.`);
    }
    throw new PreflightFail("E_CONFIG", `config/ could not be read (${e instanceof Error ? e.name : "Error"}).`);
  }
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
  /** at(D, pack.window_end): the news window's end, before which no run drafts (§0.4 row 185). */
  windowEnd: number;
}

/**
 * The run's limits, computed once at start (plan §3.2; SPEC §8.2 "Clock rules, times and budgets"):
 * hardStop at(D, hard_stop), or start + 75 min with --no-deadline (never past publish_until unless a dry
 * run); retryCutoff at(D, retry_cutoff), or hardStop − 50 min with --no-deadline; publishUntil
 * at(D, publish_until), +Infinity in a dry run; staleAfter at(D, stale_after). The watchdog fires at
 * hardStop + 2 min, at publishUntil + 2 min for a run started after hardStop, at start + 10 min for one
 * started after publishUntil, and, for a dry run started after hardStop (no --no-deadline), at start +
 * 77 min, the --no-deadline length plus the grace (an addition: the plan's hardStop + 2 min would
 * already have passed).
 */
export function scheduleFor(o: { date: string; start: number; config: LoadedConfig; noDeadline: boolean; dryRun: boolean }): Schedule {
  const sch = o.config.run.schedule;
  const until = at(o.date, sch.publish_until);
  const hardStop = o.noDeadline
    ? (o.dryRun ? o.start + P3_LIMITS.noDeadlineMs : Math.min(o.start + P3_LIMITS.noDeadlineMs, until))
    : at(o.date, sch.hard_stop);
  const retryCutoff = o.noDeadline ? hardStop - P3_LIMITS.noDeadlineRetryGapMs : at(o.date, sch.retry_cutoff);
  const publishUntil = o.dryRun ? Number.POSITIVE_INFINITY : until;
  const afterStop = o.start > hardStop;
  const endLimit = !o.dryRun && afterStop ? publishUntil : hardStop;
  let watchdogAt: number;
  if (!o.dryRun && o.start > until) watchdogAt = o.start + P3_LIMITS.watchdogLateStartMs;
  else if (!o.dryRun && afterStop) watchdogAt = until + P3_LIMITS.watchdogGraceMs;
  else if (o.dryRun && afterStop) watchdogAt = o.start + P3_LIMITS.noDeadlineMs + P3_LIMITS.watchdogGraceMs;
  else watchdogAt = hardStop + P3_LIMITS.watchdogGraceMs;
  return { hardStop, retryCutoff, publishUntil, staleAfter: at(o.date, sch.stale_after), endLimit, watchdogAt, windowEnd: at(o.date, o.config.run.pack.window_end) };
}

export type ClockState = "normal" | "after_hard_stop" | "too_late" | "too_early";

/**
 * Throws PreflightFail("E_CLOCK") when the cutoff day for D is incomplete: now before
 * `${D − 1}T00:00:00Z` (08:00 Taipei the day before, §5.1). Not a dry run and now more than
 * windowWaitMs (15 min) before the news window ends: too_early, --no-deadline or not (§0.4 row 185:
 * the draft's generated_at must fall after the window's end, so such a run could publish only the
 * data-only edition, and a full one then would cover less of the day). Not a dry run and now past
 * publishUntil: too_late. Not a dry run, no --no-deadline and now past hardStop: after_hard_stop. Else
 * normal; a normal start before the window's end waits for it (daily.ts, step 3).
 */
export function clockRule(o: { date: string; now: number; dryRun: boolean; noDeadline: boolean; schedule: Schedule }): ClockState {
  const complete = Date.parse(`${addDays(o.date, -1)}T00:00:00Z`);
  if (o.now < complete) {
    throw new PreflightFail("E_CLOCK", `The cutoff day for ${o.date} is not complete before 08:00 Taipei on ${addDays(o.date, -1)}.`);
  }
  if (!o.dryRun && o.now < o.schedule.windowEnd - P3_LIMITS.windowWaitMs) return "too_early";
  if (!o.dryRun && o.now > o.schedule.publishUntil) return "too_late";
  if (!o.dryRun && !o.noDeadline && o.now > o.schedule.hardStop) return "after_hard_stop";
  return "normal";
}

/** Step 4: HEAD https://github.com answers below 500 within 10 s, else E_NET. A fetch that ignores its abort signal is cut too. */
export async function checkNetwork(fetchImpl: typeof fetch, timeoutMs: number = P3_LIMITS.netProbeMs): Promise<void> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`);
      ac.abort(e);
      reject(e);
    }, Math.max(0, timeoutMs));
  });
  let status: number;
  try {
    const res = await Promise.race([fetchImpl("https://github.com", { method: "HEAD", redirect: "manual", signal: ac.signal }), cut]);
    status = res.status;
  } catch (e) {
    throw new PreflightFail("E_NET", `github.com did not answer (${e instanceof Error && /^no answer/.test(e.message) ? e.message : "the request failed"}).`);
  } finally {
    clearTimeout(timer);
  }
  if (status >= 500) throw new PreflightFail("E_NET", `github.com answered HTTP ${status}.`);
}

/** "owner/name" of a GitHub remote URL (https, ssh or scp form, any user part, ".git" or not); null for anything else. */
export function githubRepoOf(url: string): string | null {
  const u = url.trim();
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]*@)?github\.com(?::\d+)?\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(u)
    ?? /^(?:[\w.-]+@)?github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(u);
  return m ? m[1]! : null;
}

/** Whether `origin` counts as the repo: it equals Deps.repo (a local path is compared resolved), or names repos.repo on GitHub. */
export function originMatches(origin: string, o: { repo?: string; configRepo: string }): boolean {
  const u = origin.trim();
  if (o.repo !== undefined) {
    if (u === o.repo) return true;
    const local = (s: string) => !/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[\w.-]+@[\w.-]+:/.test(s);
    if (local(u) && local(o.repo) && path.resolve(u) === path.resolve(o.repo)) return true;
  }
  const r = githubRepoOf(u);
  return r !== null && r.toLowerCase() === o.configRepo.toLowerCase();
}

/** A git message with every URL (and so any credential in one) replaced, since git's stderr can quote the remote. */
export function redactRemotes(message: string): string {
  return message
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, "<remote>")
    .replace(/\b[\w.-]+@[\w.-]+:[^\s'"]+/g, "<remote>");
}

export interface GitPrep {
  codeCommit: string;
  restartSha7: string | null;
  notes: string[];
  dropped: number;
  remade: number;
  pushed: number;
}

/**
 * Step 5 (plan §2.7 and A3), in order: `origin` must equal o.repo or name repos.repo; `ls-remote --heads
 * origin main` within 30 s must list main. A dry run stops there, with the dryRunTree note when HEAD is not
 * main or the tree is dirty. Otherwise: restore content/ to HEAD (unstaged, checked out, cleaned; the
 * restored note when `status --porcelain -- content` was not empty); `status --porcelain` must then be
 * empty, else E_GIT; check out main if another branch is out; dropPendingEditions(), syncMain(g,
 * CONTENT_LAYOUT), pushPending(). When `diff --name-only <start>..HEAD` (start: HEAD as the process
 * found it, so a branch switch counts too) names a path outside content/, restartSha7 is HEAD's
 * `rev-parse --short=7`, unless `reexec`: then the restarted note with that sha7 is added always and
 * restartSha7 stays null. SyncError, GitError and a PublishError from dropPendingEditions become
 * PreflightFail("E_GIT"), with any URL in git's message redacted; a PublishError from pushPending is the pendingNotPushed note. Each note is also
 * logged.
 */
export async function prepareGit(o: {
  root: string; repo?: string; config: LoadedConfig; dryRun: boolean; now: Clock; reexec: boolean; log: (line: string) => void;
  /** The push retries' wait, passed to dropPendingEditions and pushPending (default realSleep). */
  sleep?: Sleep;
}, fns: { dropPendingEditions?: typeof dropPendingEditions; pushPending?: typeof pushPending; syncMain?: typeof syncMain } = {}): Promise<GitPrep> {
  const drop = fns.dropPendingEditions ?? defaultDropPendingEditions;
  const push = fns.pushPending ?? defaultPushPending;
  const sync = fns.syncMain ?? defaultSyncMain;
  const g = git(o.root);
  const branch = o.config.run.repos.branch;
  const content = o.config.run.paths.content_dir;
  const notes: string[] = [];
  const note = (n: string) => {
    notes.push(n);
    o.log(n);
  };

  try {
    let origin: string;
    try {
      origin = await g(["remote", "get-url", "origin"]);
    } catch {
      throw new PreflightFail("E_GIT", "The checkout has no origin remote.");
    }
    if (!originMatches(origin, { repo: o.repo, configRepo: o.config.run.repos.repo })) {
      throw new PreflightFail("E_GIT", `origin does not point at ${o.config.run.repos.repo}.`);
    }
    const heads = await g(["ls-remote", "--heads", "origin", branch], P3_LIMITS.lsRemoteMs);
    if (!heads.split("\n").some((l) => l.trim().endsWith(`refs/heads/${branch}`))) {
      throw new PreflightFail("E_GIT", `origin has no ${branch} branch.`);
    }
    const start = await g(["rev-parse", "HEAD"]);

    if (o.dryRun) {
      const onBranch = (await g(["rev-parse", "--abbrev-ref", "HEAD"])) === branch;
      if (!onBranch || !(await isClean(g))) note(NOTES.dryRunTree);
      return { codeCommit: start, restartSha7: null, notes, dropped: 0, remade: 0, pushed: 0 };
    }

    if ((await g(["status", "--porcelain", "--", content])) !== "") {
      await g(["reset", "-q", "--", content]);
      if ((await g(["ls-tree", "HEAD", "--", content])) !== "") await g(["checkout", "--", content]);
      await g(["clean", "-fdq", "--", content]);
      note(NOTES.restored);
    }
    const dirty = porcelainPaths(await g(["status", "--porcelain"]));
    if (dirty.length) {
      throw new PreflightFail("E_GIT", `The working tree has changes outside ${content}/: ${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? ", ..." : ""}.`);
    }
    if ((await g(["rev-parse", "--abbrev-ref", "HEAD"])) !== branch) {
      await g(["checkout", "-q", branch]);
      o.log(`Checked out ${branch}.`);
    }

    let dropped: Awaited<ReturnType<typeof dropPendingEditions>>;
    try {
      dropped = await drop(g, { root: o.root, config: o.config, now: o.now, repo: o.repo, log: o.log, sleep: o.sleep });
    } catch (e) {
      if (e instanceof PublishError) throw new PreflightFail("E_GIT", `Unpushed edition commits could not be dropped (${e.code}).`);
      throw e;
    }
    if (dropped.dropped > 0) note(NOTES.droppedPending(dropped.dropped));
    if (dropped.remade > 0) note(NOTES.remadeWithholds(dropped.remade));
    if (dropped.failed.length) o.log(`Withholds not remade, left for the next intake: ${dropped.failed.join(", ")}.`);

    await sync(g, CONTENT_LAYOUT);

    let pushed = 0;
    try {
      pushed = (await push(g, { sleep: o.sleep })).pushed;
    } catch (e) {
      if (!(e instanceof PublishError)) throw e;
      note(NOTES.pendingNotPushed);
    }

    const head = await g(["rev-parse", "HEAD"]);
    const code = (await g(["diff", "--name-only", `${start}..${head}`])).split("\n").filter((p) => p && p !== content && !p.startsWith(`${content}/`));
    const sha7 = await g(["rev-parse", "--short=7", "HEAD"]);
    let restartSha7: string | null = null;
    if (o.reexec) note(NOTES.restarted(sha7));
    else if (code.length) restartSha7 = sha7;
    return { codeCommit: head, restartSha7, notes, dropped: dropped.dropped, remade: dropped.remade, pushed };
  } catch (e) {
    if (e instanceof PreflightFail) throw e;
    if (e instanceof GitError) throw new PreflightFail("E_GIT", redactRemotes(e.message));
    throw e;
  }
}

/** node_modules/.ct-lock-sha missing or not the SHA-256 of package-lock.json (white space around it ignored). Never throws. */
export function depsChanged(root: string): boolean {
  try {
    const want = sha256Hex(fs.readFileSync(path.join(root, "package-lock.json")));
    const have = fs.readFileSync(path.join(root, "node_modules", ".ct-lock-sha"), "utf8").trim().toLowerCase();
    return have !== want;
  } catch {
    return true;
  }
}

export type IdempotencyState = "new" | "resume" | "skip_published" | "skip_late" | "skip_early" | "replace";

/**
 * Step 6, on briefs/D.json as synced (`existing`, null when missing or invalid). Too late (clock
 * too_late) skips whatever is there, --force or not: skip_late with the tooLate note; too early (clock
 * too_early) the same, skip_early with the tooEarly note (§0.4 row 185). Otherwise none:
 * new. A data-only edition: resume (the data_only stage's dataOnlyUpSince note is daily.ts's, at stage
 * 4; --force changes nothing). A full or partial one: skip_published with the alreadyPublished note
 * (its published_at); with --force, replace, but only while the clock is normal and the run drafts
 * (not --data-only), since after the hard stop no full edition can be drafted and a data-only edition
 * never replaces a full one (§8.2 --force), so it stays skip_published. The replaced note belongs to the
 * publish stage, once the new edition is out.
 */
export function idempotency(o: { contentDir: string; date: string; clock: ClockState; force: boolean; dataOnly?: boolean }): { state: IdempotencyState; existing: Brief | null; note: string | null } {
  const existing = readBrief(o.contentDir, o.date);
  if (o.clock === "too_late") return { state: "skip_late", existing, note: NOTES.tooLate(run.schedule.publish_until) };
  if (o.clock === "too_early") return { state: "skip_early", existing, note: NOTES.tooEarly(run.pack.window_end) };
  if (!existing) return { state: "new", existing, note: null };
  if (existing.edition === "data_only") return { state: "resume", existing, note: null };
  if (o.force && o.clock === "normal" && !o.dataOnly) return { state: "replace", existing, note: null };
  return { state: "skip_published", existing, note: NOTES.alreadyPublished(taipeiTime(existing.published_at)) };
}

/**
 * Step 7: `bin` is an executable file and `cliVersion(bin)` is ok within 30 s, else E_CLI (no token is
 * read); then readToken() is non-empty (trimmed), else E_AUTH. A throw from either counts as its failure.
 * The token is returned for the agent's environment only; it is never logged.
 */
export async function checkCliAndToken(o: {
  readToken: () => Promise<string | null>; bin: string; cliVersion?: typeof cliVersion;
}): Promise<{ code: "E_CLI" | "E_AUTH" | null; token: string | null; version: string | null }> {
  try {
    const st = fs.statSync(o.bin);
    if (!st.isFile()) return { code: "E_CLI", token: null, version: null };
    fs.accessSync(o.bin, fs.constants.X_OK);
  } catch {
    return { code: "E_CLI", token: null, version: null };
  }
  let version: string | null;
  try {
    const v = await (o.cliVersion ?? defaultCliVersion)(o.bin, P3_LIMITS.cliVersionMs);
    if (!v.ok) return { code: "E_CLI", token: null, version: v.version };
    version = v.version;
  } catch {
    return { code: "E_CLI", token: null, version: null };
  }
  let token: string | null;
  try {
    token = (await o.readToken())?.trim() || null;
  } catch {
    token = null;
  }
  return token ? { code: null, token, version } : { code: "E_AUTH", token: null, version };
}
