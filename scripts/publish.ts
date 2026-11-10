// The only direct writer of content/ on main (SPEC §8.7): the data-only, full, withhold, status and state
// commits, pushPending() and dropPendingEditions(), and the CLI for the manual steps NEXT_STEP names.
// Owner: lane L2. Step S0 wrote the exports (plan §2.3); CONTENT_LAYOUT and COMMIT_RE are final.
//
// Every call runs §8.7's steps: (1) the target check, (2) syncMain, (3) idempotency on the synced tree,
// (4) compose in memory, (5) write each file through its schema (staged files byte for byte), (6)
// validateAll on the tree, restoring what this call wrote on any error, (7) commit only the listed paths,
// (8) push within the deadline, with one fetch and rebase on a non-fast-forward rejection, and (9) the
// confirm, where an edition commit that is not on GitHub is reset away. Edition calls cap the deadline at
// publishUntil and confirm and reset with a second git handle that has no deadline (plan G21). A dry run
// runs no git command and does steps 3 to 6 in logs/dry-run/D/. The push loop follows the Europe fork's
// pushMain() (scripts/publish.ts there): retries at 2, 4 and 8 s within the deadline, and the content
// validated again when main moved under the commit.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ComposeError, applyDraft, dropUnverified, linkDisputes, type ApplyInput, type ComposeCommon, type ContentChanges, type GatedDraft, type SnapshotHashes } from "../lib/apply";
import { heldLockLine } from "../lib/chat";
import { loadCheckedConfig, type LoadedConfig } from "../lib/config";
import { composeDataOnly, type DataOnlyInput } from "../lib/data-only";
import { at, dataCutoffFor, isValidDate, taipeiTimestamp } from "../lib/dates";
import { cachePaths } from "../lib/feeds/cache";
import { jsonText, sha256Hex } from "../lib/json";
import { regionsConfig } from "../lib/regions";
import type { CveLookup, RegionsBase } from "../lib/rules/types";
import { firstSeenBefore, kevIndexFor, metricsFor, readArchiveIndex, readCorrections, readHistory, readScoreboard, regionsBaseFor } from "../lib/run-inputs";
import { Brief, type FeedStale } from "../lib/schema/brief";
import { AgentContext } from "../lib/schema/context";
import { STATE_FILES, STATE_SCHEMAS } from "../lib/schema/metrics";
import { ArchiveIndex, CorrectionsFile, Evidence, type Dispute } from "../lib/schema/misc";
import { Pack } from "../lib/schema/pack";
import { ScoreboardFile } from "../lib/schema/scoreboard";
import { RunRecord, StatusFile, type Recheck } from "../lib/schema/status";
import { contentDir } from "../lib/site";
import { RegionsInputFile, cveLookupFromDir, packDatesOf, validateAll, type AllOptions, type AllResult, type DraftInputs } from "../lib/validate";
import { PARTIAL_FEED_IDS, RUN_STAGES, type RunOutcome } from "../lib/vocab";
import { composeWithholds, type WithholdInput, type WithholdRequest } from "../lib/withhold";
import type { MaskedItem } from "../lib/withhold-mask";
import { P3_LIMITS, realDeadline, type Clock } from "./lib/clock";
import { cveFactsFor } from "./lib/cve-facts";
import { ensureIdentity, git, GitError, porcelainPaths, SyncError, syncMain, type Git, type Layout as GitLayout } from "./lib/git";
import { acquireLock, releaseLock } from "./lib/lock";
import { runPaths } from "./lib/paths";
import { readSnapshot, snapshotHashes, type Snapshot } from "./lib/snapshot";
import { GatedDraftSchema, validateGated } from "./lib/validate-loop";

/** "compose": the composer could not build the edition (lib/apply.ts ComposeError), nothing written. */
export type PublishCode = "wrong repository" | "too late" | "already published" | "validation" | "push" | "pending edition" | "compose";

/** A code-only error: message === code; `codes` holds rule codes only (validation), never messages. */
export class PublishError extends Error {
  constructor(readonly code: PublishCode, readonly codes: readonly string[] = []) {
    super(code);
    this.name = "PublishError";
  }
}

/** Re-export of git.ts Layout: a repo-relative path → whether sync and commit accept it. */
export type Layout = GitLayout;

const DATE = "\\d{4}-\\d{2}-\\d{2}";
const DATED_RE = new RegExp(`^content/(?:briefs|metrics|metrics/inputs|status)/(${DATE})\\.json$`);
const FIXED: ReadonlySet<string> = new Set([
  ...STATE_FILES.map((f) => `content/state/${f}`),
  "content/scoreboard.json",
  "content/corrections.json",
  "content/archive-index.json",
]);

/**
 * §3 and §4.7: content/briefs/D.json, content/metrics/D.json, content/metrics/inputs/D.json,
 * content/status/D.json, content/state/{days,series,kev-index,ai-credits,credit-candidates,anthropic-cvd}.json,
 * content/scoreboard.json, content/corrections.json, content/archive-index.json. Nothing else.
 */
export const CONTENT_LAYOUT: Layout = (repoRelativePath: string): boolean => {
  if (FIXED.has(repoRelativePath)) return true;
  const m = DATED_RE.exec(repoRelativePath);
  return m !== null && isValidDate(m[1]!);
};

export type CommitArgs = {
  data_only: { date: string };
  /** "N items", "1 item" */
  full: { date: string; edition: "full" | "partial"; items: number };
  /** "withheld a, b" */
  withhold: { date: string; itemIds: readonly string[] };
  status_started: { date: string; runId: string };
  status_ended: { date: string; runId: string; outcome: RunOutcome };
  status_retry: { date: string; runId: string; outcome: RunOutcome; retryId: string };
  state: { cutoff: string; mode: "catch-up" | "backfill" };
};

/** §8.7's commit subjects: dates, counts, run ids, outcomes and item ids only, never model text. */
export function commitTitle<K extends keyof CommitArgs>(kind: K, args: CommitArgs[K]): string {
  const a = args as CommitArgs[keyof CommitArgs];
  const date = "date" in a ? a.date : a.cutoff;
  if (!isValidDate(date)) throw new Error(`commitTitle: not a valid date: ${JSON.stringify(date)}`);
  switch (kind) {
    case "data_only":
      return `brief: ${date} · data-only edition`;
    case "full": {
      const f = a as CommitArgs["full"];
      if (!Number.isInteger(f.items) || f.items < 0) throw new Error(`commitTitle: bad item count ${f.items}`);
      return `brief: ${date} · ${f.edition} edition, ${f.items} ${f.items === 1 ? "item" : "items"}`;
    }
    case "withhold": {
      const w = a as CommitArgs["withhold"];
      if (w.itemIds.length === 0) throw new Error("commitTitle: a withhold names at least one item");
      return `correction: ${date} · withheld ${w.itemIds.join(", ")}`;
    }
    case "status_started":
      return `status: ${date} · run ${(a as CommitArgs["status_started"]).runId} started`;
    case "status_ended": {
      const e = a as CommitArgs["status_ended"];
      return `status: ${date} · run ${e.runId} ended: ${e.outcome}`;
    }
    case "status_retry": {
      const r = a as CommitArgs["status_retry"];
      return `status: ${date} · run ${r.runId} ended: ${r.outcome}; retry ${r.retryId} started`;
    }
    case "state":
      return `state: ${date} · ${(a as CommitArgs["state"]).mode}`;
    default:
      throw new Error(`commitTitle: unknown kind ${String(kind)}`);
  }
}

/** Every commit subject publish makes (§8.7 test 6). */
export const COMMIT_RE = /^(brief|status|correction|state): \d{4}-\d{2}-\d{2} · /;

export interface PublishOptions {
  root: string;
  date: string;
  /** Epoch ms on `now`'s clock. Edition calls cap it at publishUntil = at(date, schedule.publish_until). */
  deadline: number;
  now: Clock;
  dryRun: boolean;
  /** Dry runs only: replace logs/dry-run/D/ with a fresh copy of contentDir() first (the run's first call). */
  freshCopy?: boolean;
  /** Deps.repo: an origin URL that counts as repos.repo (tests: the bare remote's path). */
  repo?: string;
  /** The config the run loaded at its start. */
  config: LoadedConfig;
  /** This run's records, oldest first; the last is the current one. Written onto status/D.json by run_id (replace in place, else append). */
  records: readonly RunRecord[];
  log?: (line: string) => void;
  /** The push retries' wait (default realSleep); tests pass an instant one. */
  sleep?: Sleep;
}

/** Waits `ms` milliseconds. */
export type Sleep = (ms: number) => Promise<void>;
/** The production wait: a real timer. */
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** §8.7 step 8: the waits before the second, third and fourth push. */
export const PUSH_RETRY_MS: readonly number[] = [2_000, 4_000, 8_000];

export interface PublishResult {
  /** null in a dry run */
  sha: string | null;
  /** taipeiTimestamp(now()) at compose time */
  publishedAt: string;
  /** The last record as written to status/D.json (edition, data_only_published_at or full_published_at, recheck correction ids filled). */
  record: RunRecord;
  /** publishFull() only: the draft items withheld because they re-report a withheld item (ContentChanges.masked). */
  masked?: readonly MaskedItem[];
}

export interface PublishDeps {
  /** default lib/data-only.ts */
  composeDataOnly?: typeof composeDataOnly;
  /** default lib/apply.ts */
  applyDraft?: typeof applyDraft;
  /** default lib/withhold.ts */
  composeWithholds?: typeof composeWithholds;
  /** default validateAll */
  validateTree?: (dir: string, opts: AllOptions) => AllResult;
}

// ── Shared steps ─────────────────────────────────────────────────────────────────────────────────────

/** The CLI's usage line (§8.7). */
export const USAGE = "Usage: tsx scripts/publish.ts --date YYYY-MM-DD [--data-only | --state] [--force] [--dry-run]";
/** Every CLI mode's first check (§8.7, Appendix C). */
export const NOT_ARM64 = "Not native arm64: put /opt/homebrew/bin first on the PATH (SPEC Appendix C).";
/** The CLI's refusal of an edition after publishUntil. */
export const tooLateLine = (publishUntilHhmm: string): string => `Too late: nothing is published after ${publishUntilHhmm}.`;

/** publishUntil for edition date D: at(D, schedule.publish_until), epoch ms. */
export function publishUntil(config: LoadedConfig, date: string): number {
  return at(date, config.run.schedule.publish_until);
}

/**
 * Whether `url` (origin's URL) is the repository `repo` ("owner/name") on GitHub, in its https, ssh or
 * scp form, with or without `.git`; or, when given, exactly `alt` (Deps.repo, the tests' bare remote).
 */
export function originMatches(url: string, repo: string, alt?: string): boolean {
  const u = url.trim();
  const bare = (s: string) => s.replace(/\/+$/, "");
  if (alt !== undefined && alt !== "" && bare(u) === bare(alt.trim())) return true;
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(u);
  return m !== null && m[1]!.toLowerCase() === repo.toLowerCase();
}

/** Readings of a briefs/ folder: the dates that have a YYYY-MM-DD.json file, oldest first. */
function briefDates(dir: string): string[] {
  const briefs = path.join(dir, "briefs");
  if (!fs.existsSync(briefs)) return [];
  return fs.readdirSync(briefs).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map((n) => n.slice(0, 10)).filter(isValidDate).sort();
}

const lines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter(Boolean);
const sha7 = (sha: string) => sha.slice(0, 7);
const statusRel = (date: string) => `status/${date}.json`;
const HISTORY_DAYS = 30;
const NON_FAST_FORWARD_RE = /\((?:fetch first|non-fast-forward)\)|non-fast-forward/;

type Bytes = string | Buffer;
/** Content-relative path → the bytes to write. */
type Files = Map<string, Bytes>;

interface Ctx {
  root: string;
  /** The folder steps 3 to 6 run in: <root>/content, or logs/dry-run/D/ in a dry run. */
  dir: string;
  /** Deadline-capped; null in a dry run. */
  g: Git | null;
  /** No deadline: the confirm, the reset and the clean-ups (G21); null in a dry run. */
  free: Git | null;
  date: string;
  dryRun: boolean;
  edition: boolean;
  log: (line: string) => void;
  sleep: Sleep;
}

interface Plan {
  files: Files;
  title: string;
  validate: AllOptions;
}

type OpenOptions = Pick<PublishOptions, "root" | "date" | "deadline" | "now" | "dryRun" | "freshCopy" | "repo" | "config" | "log" | "sleep">;

/** Step 1: this checkout is the content repository's main, with its content folder at <root>/content. */
async function checkTarget(g: Git, root: string, config: LoadedConfig, repo?: string): Promise<void> {
  const wrong = () => new PublishError("wrong repository");
  if (path.resolve(root, contentDir()) !== path.join(root, "content")) throw wrong();
  const ask = async (args: string[]): Promise<string> => {
    try {
      return await g(args);
    } catch (e) {
      // A command refused for the deadline is not a wrong repository.
      if (e instanceof GitError && /not started/.test(e.message)) throw e;
      throw wrong();
    }
  };
  const top = await ask(["rev-parse", "--show-toplevel"]);
  let same = false;
  try {
    same = fs.realpathSync(top) === fs.realpathSync(root);
  } catch {
    same = false;
  }
  if (!same) throw wrong();
  if (!originMatches(await ask(["remote", "get-url", "origin"]), config.run.repos.repo, repo)) throw wrong();
  if ((await ask(["rev-parse", "--abbrev-ref", "HEAD"])) !== "main") throw wrong();
}

/** The dry run's copy of the content folder (§8.7): replaced when `fresh`, else made only if missing. */
function dryRunDir(root: string, date: string, fresh: boolean): string {
  const p = runPaths(root, date);
  const src = p.content;
  const copy = p.dryRunCopy;
  if (src === copy || copy.startsWith(`${src}${path.sep}`) || src.startsWith(`${copy}${path.sep}`)) {
    throw new Error(`publish: the content folder ${src} and the dry-run copy ${copy} overlap`);
  }
  if (fresh) fs.rmSync(copy, { recursive: true, force: true });
  if (!fs.existsSync(copy)) {
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    if (fs.existsSync(src)) fs.cpSync(src, copy, { recursive: true });
    else fs.mkdirSync(copy, { recursive: true });
  }
  return copy;
}

/** Steps 1 and 2 (or the dry-run copy), with the edition calls' too-late refusal and capped deadline. */
async function open(o: OpenOptions, edition: boolean): Promise<Ctx> {
  const root = path.resolve(o.root);
  const log = o.log ?? (() => {});
  const sleep = o.sleep ?? realSleep;
  if (!isValidDate(o.date)) throw new Error(`publish: not a valid date: ${JSON.stringify(o.date)}`);
  if (o.dryRun) {
    return { root, dir: dryRunDir(root, o.date, !!o.freshCopy), g: null, free: null, date: o.date, dryRun: true, edition, log, sleep };
  }
  let deadline = o.deadline;
  if (edition) {
    const until = publishUntil(o.config, o.date);
    if (o.now() >= until) throw new PublishError("too late");
    deadline = Math.min(deadline, until);
  }
  const g = git(root, { deadline: realDeadline(o.now, deadline) });
  await checkTarget(g, root, o.config, o.repo);
  await syncMain(g, CONTENT_LAYOUT);
  return { root, dir: path.join(root, "content"), g, free: git(root), date: o.date, dryRun: false, edition, log, sleep };
}

interface Written {
  rel: string;
  before: Buffer | null;
}

/** Step 5: writes the files, keeping what each path held before so a failed call can put it back. */
function writeFiles(dir: string, files: Files): Written[] {
  const out: Written[] = [];
  for (const [rel, bytes] of files) {
    const file = path.join(dir, rel);
    out.push({ rel, before: fs.existsSync(file) ? fs.readFileSync(file) : null });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  return out;
}

/** Puts back what writeFiles() replaced and removes what it added (the §8.7 step 6 restore). */
function restore(dir: string, written: readonly Written[]): void {
  for (const w of [...written].reverse()) {
    const file = path.join(dir, w.rel);
    if (w.before === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, w.before);
  }
}

/** Step 6: throws PublishError("validation", codes) on any error; the caller restores. */
function check(ctx: Ctx, opts: AllOptions, deps: PublishDeps): void {
  const r = (deps.validateTree ?? validateAll)(ctx.dir, opts);
  if (r.errors.length === 0) return;
  for (const e of r.errors.slice(0, 5)) ctx.log(`Validation: ${e.code} at ${e.path}`);
  throw new PublishError("validation", [...new Set(r.errors.map((e) => e.code))].sort());
}

/** One `git ls-remote` on a deadline-free handle: is origin's main exactly `sha`? */
async function confirm(free: Git, sha: string): Promise<boolean> {
  try {
    const line = await free(["ls-remote", "origin", "refs/heads/main"], P3_LIMITS.confirmMs);
    return line.split(/\s+/)[0] === sha;
  } catch {
    return false;
  }
}

/**
 * Step 8: push within g's deadline, retrying after PUSH_RETRY_MS (2, 4 and 8 s, waited through `sleep`).
 * A non-fast-forward rejection fetches and rebases once when the incoming commits touch none of `paths`,
 * then `revalidate()` runs and the push is tried again. A rebase that fails is aborted with the
 * deadline-free handle.
 */
async function pushLoop(g: Git, free: Git, paths: ReadonlySet<string>, revalidate: () => void, sleep: Sleep): Promise<void> {
  const delays = PUSH_RETRY_MS;
  let rebased = false;
  let attempt = 0;
  for (;;) {
    try {
      await g(["push", "origin", "main"], 120_000);
      return;
    } catch (e) {
      if (!rebased && e instanceof GitError && NON_FAST_FORWARD_RE.test(e.message)) {
        rebased = true;
        await g(["fetch", "origin", "main"], P3_LIMITS.gitMs);
        const clash = lines(await g(["diff", "--name-only", "HEAD...origin/main"])).filter((p) => paths.has(p));
        if (clash.length) throw new SyncError(`origin's main changed ${clash.slice(0, 3).join(", ")}, which this commit also writes.`);
        try {
          await g(["rebase", "origin/main"]);
        } catch (re) {
          await free(["rebase", "--abort"]).catch(() => {});
          throw new SyncError(`Couldn't put the commit on top of origin's newer main: ${(re as Error).message}`);
        }
        revalidate();
        continue;
      }
      const wait = delays[attempt++];
      if (wait === undefined || (g.deadline !== null && Date.now() + wait >= g.deadline)) throw e;
      await sleep(wait);
    }
  }
}

/**
 * Steps 7 to 9 for a written and validated plan. Returns the commit on GitHub, or null when nothing
 * changed. An edition commit that is not on GitHub at the end is reset away (PublishError "push"); any
 * other commit whose push fails stays local for the next push (PublishError "push" too).
 */
async function land(ctx: Ctx, plan: Plan, written: readonly Written[], deps: PublishDeps): Promise<string | null> {
  const g = ctx.g!;
  const free = ctx.free!;
  const repoPaths = [...plan.files.keys()].map((rel) => `content/${rel}`);
  let before: string | null = null;
  let sha: string;
  try {
    before = await g(["rev-parse", "HEAD"]);
    await ensureIdentity(g);
    await g(["add", "--", ...repoPaths]);
    if ((await g(["diff", "--cached", "--name-only"])) === "") {
      ctx.log("Nothing changed: no commit.");
      return null;
    }
    await g(["commit", "-q", "-m", plan.title]);
    sha = await g(["rev-parse", "HEAD"]);
  } catch (e) {
    // The tree was clean before the call: put it back as it was.
    const head = await free(["rev-parse", "HEAD"]).catch(() => before);
    if (before !== null && head !== before) await free(["reset", "-q", "--hard", before]).catch(() => {});
    else {
      await free(["reset", "-q"]).catch(() => {});
      restore(ctx.dir, written);
    }
    if (ctx.edition) {
      ctx.log(`The edition was not committed: ${(e as Error).message.slice(0, 200)}`);
      throw new PublishError("push");
    }
    throw e;
  }

  let pushError: unknown = null;
  try {
    await pushLoop(g, free, new Set(repoPaths), () => check(ctx, plan.validate, deps), ctx.sleep);
  } catch (e) {
    pushError = e;
    ctx.log(`Push of ${sha7(sha)} failed: ${(e as Error).message.slice(0, 200)}`);
  }
  const head = (await free(["rev-parse", "HEAD"]).catch(() => sha)) || sha;
  let landed = pushError === null && (await confirm(free, head));
  if (!landed && ctx.edition) {
    // §8.7 step 9: once more, then the edition commit goes; it never waits locally for a later push.
    landed = await confirm(free, head);
    if (!landed) {
      await free(["reset", "-q", "--hard", "HEAD^"]);
      ctx.log(`${sha7(head)} is not on GitHub: reset away.`);
      if (pushError instanceof PublishError) throw pushError;
      throw new PublishError("push");
    }
  }
  if (!landed) {
    ctx.log(`${sha7(head)} stays local; the next push carries it.`);
    if (pushError instanceof PublishError) throw pushError;
    throw new PublishError("push");
  }
  return head;
}

/** Steps 5 to 9 for a plan: the layout check, write, validate (restore on failure), then commit and push, or the dry run's mirror. */
async function runPlan(ctx: Ctx, plan: Plan, deps: PublishDeps): Promise<string | null> {
  for (const rel of plan.files.keys()) {
    if (!CONTENT_LAYOUT(`content/${rel}`)) throw new Error(`publish: content/${rel} is outside the content layout`);
  }
  const written = writeFiles(ctx.dir, plan.files);
  try {
    check(ctx, plan.validate, deps);
  } catch (e) {
    restore(ctx.dir, written);
    throw e;
  }
  if (ctx.dryRun) {
    const status = path.join(ctx.dir, statusRel(ctx.date));
    if (plan.files.has(statusRel(ctx.date)) && fs.existsSync(status)) {
      const mirror = runPaths(ctx.root, ctx.date).statusMirror;
      fs.mkdirSync(path.dirname(mirror), { recursive: true });
      fs.copyFileSync(status, mirror);
    }
    ctx.log(`Dry run: ${plan.title} (${plan.files.size} files in ${path.relative(ctx.root, ctx.dir) || "."}).`);
    return null;
  }
  return land(ctx, plan, written, deps);
}

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────────

function lastOf(records: readonly RunRecord[]): RunRecord {
  const last = records.at(-1);
  if (!last) throw new Error("publish: no run record to write");
  return last;
}

/** status/D.json as synced, with each record written by run_id (replaced in place, else appended). */
function statusText(dir: string, date: string, records: readonly RunRecord[]): string {
  const runs = (readStatusRuns(dir, date)).map((r) => structuredClone(r));
  for (const r of records) {
    const i = runs.findIndex((x) => x.run_id === r.run_id);
    if (i >= 0) runs[i] = structuredClone(r);
    else runs.push(structuredClone(r));
  }
  return jsonText({ schema_version: 1, date, runs }, StatusFile);
}

function readStatusRuns(dir: string, date: string): RunRecord[] {
  try {
    const s = StatusFile.parse(JSON.parse(fs.readFileSync(path.join(dir, statusRel(date)), "utf8")));
    return s.date === date ? s.runs : [];
  } catch {
    return [];
  }
}

function readJson<T>(file: string, schema: { parse(v: unknown): T }): T | null {
  try {
    return schema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

const readBriefAt = (dir: string, date: string): Brief | null => {
  const b = readJson(path.join(dir, "briefs", `${date}.json`), Brief);
  return b && b.date === date ? b : null;
};

/** packs/D.json, null when missing or invalid. */
function readPack(root: string, date: string): Pack | null {
  const p = readJson(runPaths(root, date).pack, Pack);
  return p && p.date === date ? p : null;
}

/** The staged metrics, inputs and state files of cache/staged/D/, byte for byte, unless metrics/D.json is already in the tree. */
function stagedFiles(ctx: Ctx, date: string): Files {
  const out: Files = new Map();
  if (fs.existsSync(path.join(ctx.dir, "metrics", `${date}.json`))) return out;
  const staged = runPaths(ctx.root, date).staged;
  for (const rel of [`metrics/${date}.json`, `metrics/inputs/${date}.json`]) {
    const file = path.join(staged, rel);
    if (fs.existsSync(file)) out.set(rel, fs.readFileSync(file));
  }
  const state = path.join(staged, "state");
  if (fs.existsSync(state)) {
    for (const name of STATE_FILES) {
      const file = path.join(state, name);
      if (fs.existsSync(file)) out.set(`state/${name}`, fs.readFileSync(file));
    }
  }
  return out;
}

/** What every composer reads, from the synced tree (or the dry-run copy) and cache/. */
function composeCommon(ctx: Ctx, o: { config: LoadedConfig; feedsStale: readonly FeedStale[] }, publishedAt: string, generatedAt: string, regionsBase: RegionsBase | null) {
  const D = ctx.date;
  const mf = readMetrics(ctx, D);
  const kevIndex = kevIndexFor(ctx.root, ctx.dir, D);
  if (!kevIndex) throw new Error(`publish: no state/kev-index.json for ${D}, staged or committed`);
  const common: ComposeCommon = {
    date: D,
    config: o.config,
    metrics: mf.metrics,
    kevIndex,
    history: readHistory(ctx.dir, D, HISTORY_DAYS),
    firstSeen: firstSeenBefore(ctx.dir, D),
    regionsBase: regionsBase ?? regionsBaseFor({ root: ctx.root, contentDir: ctx.dir, date: D, pack: readPack(ctx.root, D), config: o.config }),
    archiveIndex: readArchiveIndex(ctx.dir),
    scoreboard: readScoreboard(ctx.dir),
    corrections: readCorrections(ctx.dir),
    feedsStale: o.feedsStale,
    publishedAt,
    generatedAt,
  };
  return { common, mf };
}

function readMetrics(ctx: Ctx, date: string) {
  const mf = metricsFor(ctx.root, ctx.dir, date);
  if (!mf) throw new Error(`publish: no metrics for ${date} (content/metrics/${date}.json or cache/staged/${date}/)`);
  return mf;
}

/** A CVE lookup over cache/cvelist/records, or null when the folder is missing (a failed collect). */
function cveListOrNull(root: string, date: string): CveLookup | null {
  const dir = runPaths(root, date).cveRecords;
  return fs.existsSync(dir) ? cveLookupFromDir(dir) : null;
}

/** The files a composer's changes write (scoreboard and corrections only when changed). */
function changeFiles(ch: ContentChanges): Files {
  const out: Files = new Map();
  if (ch.brief) out.set(`briefs/${ch.brief.date}.json`, jsonText(ch.brief, Brief));
  for (const b of ch.rewritten) out.set(`briefs/${b.date}.json`, jsonText(b, Brief));
  if (ch.scoreboard) out.set("scoreboard.json", jsonText(ch.scoreboard, ScoreboardFile));
  if (ch.corrections) out.set("corrections.json", jsonText(ch.corrections, CorrectionsFile));
  out.set("archive-index.json", jsonText(ch.archiveIndex, ArchiveIndex));
  return out;
}

/** Runs a composer; a ComposeError is logged and becomes PublishError("compose") before anything is written. */
function composed<T>(ctx: Ctx, edition: string, compose: () => T): T {
  try {
    return compose();
  } catch (e) {
    if (!(e instanceof ComposeError)) throw e;
    ctx.log(`The ${edition} edition could not be composed: ${e.message.slice(0, 200)}`);
    throw new PublishError("compose");
  }
}

function briefOf(ch: ContentChanges, date: string): Brief {
  if (!ch.brief || ch.brief.date !== date) throw new Error(`publish: the composer returned no brief for ${date}`);
  return ch.brief;
}

function fillRecheck(r: Recheck | null, flags: ContentChanges["flagCorrections"]): Recheck | null {
  if (!r) return null;
  return {
    ...r,
    flagged: r.flagged.map((f) => {
      const m = flags.find((x) => x.item_id === f.item_id && x.edition_date === f.edition_date && x.flag === f.flag);
      return m ? { ...f, correction_id: m.correction_id } : { ...f };
    }),
  };
}

// ── The exports of §8.7 ──────────────────────────────────────────────────────────────────────────────

export async function publishDataOnly(o: PublishOptions & {
  feedsStale: readonly FeedStale[];
  /** pack.generated_at */
  generatedAt: string;
}, deps: PublishDeps = {}): Promise<PublishResult> {
  const last = lastOf(o.records);
  const ctx = await open(o, true);
  const D = o.date;
  if (fs.existsSync(path.join(ctx.dir, "briefs", `${D}.json`))) throw new PublishError("already published");
  const publishedAt = taipeiTimestamp(new Date(o.now()));
  const { common, mf } = composeCommon(ctx, o, publishedAt, o.generatedAt, null);
  const input: DataOnlyInput = {
    ...common, cveList: cveListOrNull(ctx.root, D), facts: cveFactsFor(ctx.root, D), inputs: mf.inputs, metricsSha256: sha256Hex(mf.text),
  };
  const changes = composed(ctx, "data-only", () => (deps.composeDataOnly ?? composeDataOnly)(input));
  const brief = briefOf(changes, D);
  const record: RunRecord = { ...structuredClone(last), edition: brief.edition, data_only_published_at: publishedAt };
  const files: Files = new Map([...stagedFiles(ctx, D), ...changeFiles(changes)]);
  files.set(statusRel(D), statusText(ctx.dir, D, [...o.records.slice(0, -1), record]));
  const sha = await runPlan(ctx, { files, title: commitTitle("data_only", { date: D }), validate: { publishing: D, config: o.config } }, deps);
  return { sha, publishedAt, record };
}

export async function publishFull(o: PublishOptions & {
  force: boolean;
  edition: "full" | "partial";
  draft: GatedDraft;
  /** The in-memory copy. */
  context: AgentContext;
  evidence: Evidence;
  cveList: CveLookup;
  regionsBase: RegionsBase;
  /** §2.5 */
  snapshots: SnapshotHashes;
  feedsStale: readonly FeedStale[];
  /** Intake's updated list; null keeps the file's. */
  disputes: readonly Dispute[] | null;
  /** This run's flags (correction ids filled from the result). */
  recheck: Recheck | null;
}, deps: PublishDeps = {}): Promise<PublishResult> {
  const last = lastOf(o.records);
  const ctx = await open(o, true);
  const D = o.date;
  const stored = readBriefAt(ctx.dir, D);
  if (stored && stored.edition !== "data_only" && !o.force) throw new PublishError("already published");
  const publishedAt = taipeiTimestamp(new Date(o.now()));
  const { common, mf } = composeCommon(ctx, o, publishedAt, o.draft.generated_at, o.regionsBase);
  const input: ApplyInput = {
    ...common,
    edition: o.edition,
    draft: o.draft,
    context: o.context,
    evidence: o.evidence,
    cveList: o.cveList,
    snapshots: o.snapshots,
    dataOnlyPublishedAt: stored?.data_only_published_at ?? null,
    disputes: o.disputes,
    recheck: o.recheck,
    facts: cveFactsFor(ctx.root, D),
    inputs: mf.inputs,
    metricsSha256: sha256Hex(mf.text),
  };
  const changes = composed(ctx, "full", () => (deps.applyDraft ?? applyDraft)(input));
  const brief = briefOf(changes, D);
  if (brief.edition !== o.edition) throw new Error(`publish: applyDraft returned a ${brief.edition} edition, not ${o.edition}`);
  const masked = changes.masked ?? [];
  for (const x of masked) ctx.log(`Withheld ${x.item_id} in this edition: it re-reports the item ${x.correction_id} withholds (${x.match} match).`);
  const files: Files = new Map([...stagedFiles(ctx, D), ...changeFiles(changes)]);
  if (!changes.corrections && o.disputes) {
    // Intake's updated disputes go in with the edition even when no correction changed, linked to the
    // corrections that answer them (a withhold this morning answered one after intake read the list).
    const cf = readCorrections(ctx.dir);
    const disputes = linkDisputes(o.disputes, cf?.corrections ?? []);
    if (JSON.stringify(cf?.disputes ?? []) !== JSON.stringify(disputes)) {
      files.set("corrections.json", jsonText({ schema_version: 1, corrections: cf?.corrections ?? [], disputes }, CorrectionsFile));
    }
  }
  const record: RunRecord = {
    ...structuredClone(last), edition: brief.edition, full_published_at: publishedAt, recheck: fillRecheck(o.recheck ?? last.recheck, changes.flagCorrections),
  };
  files.set(statusRel(D), statusText(ctx.dir, D, [...o.records.slice(0, -1), record]));
  const title = commitTitle("full", { date: D, edition: o.edition, items: brief.items.length });
  const sha = await runPlan(ctx, { files, title, validate: { publishing: D, config: o.config } }, deps);
  return { sha, publishedAt, record, masked };
}

/**
 * The files of a withhold (§4.10): composeWithholds over every stored brief dated on or after the earliest
 * request's edition (their region reasons may list the item), and every earlier one that holds a requested
 * item: an item keeps its id in every edition it appears in, so an earlier edition would keep the name.
 */
function withholdFiles(ctx: Ctx, config: LoadedConfig, requests: readonly WithholdRequest[], disputes: readonly Dispute[], deps: PublishDeps): Files {
  const from = [...requests.map((r) => r.edition_date)].sort()[0]!;
  const ids = new Set(requests.map((r) => r.item_id));
  const briefs = briefDates(ctx.dir).map((d) => readBriefAt(ctx.dir, d))
    .filter((b): b is Brief => b !== null && (b.date >= from || b.items.some((it) => ids.has(it.id))));
  const input: WithholdInput = {
    date: ctx.date, config, briefs, corrections: readCorrections(ctx.dir), disputes, archiveIndex: readArchiveIndex(ctx.dir),
    metricsFor: (d) => metricsFor(ctx.root, ctx.dir, d)?.metrics ?? null, requests,
  };
  const ch = (deps.composeWithholds ?? composeWithholds)(input);
  if (!ch.corrections) throw new Error("publish: composeWithholds returned no corrections.json");
  return changeFiles(ch);
}

const withheldIds = (requests: readonly WithholdRequest[]) => [...new Set(requests.map((r) => r.item_id))];

export async function publishWithholds(o: PublishOptions & {
  /** §2.4 */
  requests: readonly WithholdRequest[];
  /** Intake's updated list, committed with the withholds. */
  disputes: readonly Dispute[];
}, deps: PublishDeps = {}): Promise<PublishResult> {
  const last = lastOf(o.records);
  if (o.requests.length === 0) throw new Error("publishWithholds: no withhold requests");
  const ctx = await open(o, false);
  const D = o.date;
  const publishedAt = taipeiTimestamp(new Date(o.now()));
  const files = withholdFiles(ctx, o.config, o.requests, o.disputes, deps);
  files.set(statusRel(D), statusText(ctx.dir, D, o.records));
  const sha = await runPlan(ctx, { files, title: commitTitle("withhold", { date: D, itemIds: withheldIds(o.requests) }), validate: {} }, deps);
  return { sha, publishedAt, record: last };
}

export type StatusEvent =
  | { kind: "started" }
  | { kind: "ended"; outcome: RunOutcome }
  /** records = [closed attempt 1, open attempt 2] */
  | { kind: "retry"; outcome: RunOutcome; retryId: string };

function statusTitle(date: string, records: readonly RunRecord[], event: StatusEvent): string {
  const last = lastOf(records);
  switch (event.kind) {
    case "started":
      return commitTitle("status_started", { date, runId: last.run_id });
    case "ended":
      return commitTitle("status_ended", { date, runId: last.run_id, outcome: event.outcome });
    case "retry": {
      const closed = records.at(-2);
      if (!closed) throw new Error("publishStatus: a retry needs the closed attempt and the new one");
      return commitTitle("status_retry", { date, runId: closed.run_id, outcome: event.outcome, retryId: event.retryId });
    }
  }
}

export async function publishStatus(o: PublishOptions & {
  event: StatusEvent;
  /** Applied to archive-index.json in the same commit (the end record carries the link results). */
  updateArchive?: (ix: ArchiveIndex) => ArchiveIndex;
}): Promise<PublishResult> {
  const last = lastOf(o.records);
  const title = statusTitle(o.date, o.records, o.event);
  const ctx = await open(o, false);
  const D = o.date;
  const publishedAt = taipeiTimestamp(new Date(o.now()));
  const files: Files = new Map([[statusRel(D), statusText(ctx.dir, D, o.records)]]);
  if (o.updateArchive) {
    const ix = readArchiveIndex(ctx.dir) ?? { schema_version: 1 as const, editions: [], urls: {} };
    files.set("archive-index.json", jsonText(o.updateArchive(structuredClone(ix)), ArchiveIndex));
  }
  const sha = await runPlan(ctx, { files, title, validate: {} }, {});
  return { sha, publishedAt, record: last };
}

export async function publishState(o: Omit<PublishOptions, "records"> & {
  mode: "catch-up" | "backfill"; stagedDir: string; cutoff: string;
}): Promise<{ sha: string | null; files: string[] }> {
  const title = commitTitle("state", { cutoff: o.cutoff, mode: o.mode });
  const ctx = await open(o, false);
  const staged = path.join(path.resolve(ctx.root, o.stagedDir), "state");
  if (!fs.existsSync(staged)) throw new Error(`publishState: nothing is staged in ${path.relative(ctx.root, staged) || staged}`);
  // §5.3: kev-index.json is rebuilt only while no brief exists; never a staged metrics file.
  const anyBrief = briefDates(ctx.dir).length > 0;
  const files: Files = new Map();
  for (const name of STATE_FILES) {
    if (name === "kev-index.json" && anyBrief) continue;
    const file = path.join(staged, name);
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file);
    STATE_SCHEMAS[name].parse(JSON.parse(bytes.toString("utf8")));
    const current = path.join(ctx.dir, "state", name);
    if (fs.existsSync(current) && fs.readFileSync(current).equals(bytes)) continue;
    files.set(`state/${name}`, bytes);
  }
  const repoPaths = [...files.keys()].map((rel) => `content/${rel}`);
  if (files.size === 0) {
    ctx.log("The staged state matches content/state/: nothing to publish.");
    return { sha: null, files: [] };
  }
  const sha = await runPlan(ctx, { files, title, validate: {} }, {});
  return { sha, files: repoPaths };
}

interface LocalCommit {
  sha: string;
  subject: string;
}

async function localCommits(g: Git): Promise<LocalCommit[]> {
  return lines(await g(["log", "--reverse", "--format=%H%x1f%s", "origin/main..HEAD"])).map((l) => {
    const [sha, subject] = l.split("\x1f") as [string, string];
    return { sha, subject: subject ?? "" };
  });
}

/**
 * Pushes local status and withhold commits GitHub lacks (after 11:00 too). A brief: among them:
 * PublishError("pending edition"), nothing pushed. `o.sleep` is the retries' wait (default realSleep).
 */
export async function pushPending(g: Git, o: { sleep?: Sleep } = {}): Promise<{ pushed: number }> {
  const free = git(g.cwd);
  await g(["fetch", "origin", "main"], P3_LIMITS.gitMs);
  const local = await localCommits(g);
  if (local.length === 0) return { pushed: 0 };
  if (local.some((c) => c.subject.startsWith("brief: "))) throw new PublishError("pending edition");
  const { ahead } = await syncMain(g, CONTENT_LAYOUT);
  if (ahead === 0) return { pushed: 0 };
  const paths = new Set(lines(await g(["diff", "--name-only", "origin/main...HEAD"])));
  try {
    await pushLoop(g, free, paths, () => {}, o.sleep ?? realSleep);
  } catch (e) {
    if (e instanceof SyncError) throw e;
    throw new PublishError("push");
  }
  const head = await free(["rev-parse", "HEAD"]);
  if (!(await confirm(free, head))) throw new PublishError("push");
  return { pushed: ahead };
}

/** The corrections file at a commit, or null when it is missing there or does not parse. */
async function correctionsAt(g: Git, rev: string): Promise<CorrectionsFile | null> {
  try {
    return CorrectionsFile.parse(JSON.parse(await g(["show", `${rev}:content/corrections.json`])));
  } catch {
    return null;
  }
}

/** GitHub's disputes with the dropped commits' changed ones written in by id; a correction id GitHub lacks is cleared. */
function mergeDisputes(base: readonly Dispute[], changed: readonly Dispute[], correctionIds: ReadonlySet<string>): Dispute[] {
  const out = base.map((d) => structuredClone(d));
  for (const d of changed) {
    const next = { ...structuredClone(d), correction_id: d.correction_id !== null && correctionIds.has(d.correction_id) ? d.correction_id : null };
    const i = out.findIndex((x) => x.id === d.id);
    if (i < 0) out.push(next);
    else if (out[i]!.correction_id === null) out[i] = next;
  }
  return out;
}

/** §8.7's table. `failed` lists the withhold item ids that failed validation (noted for the next intake). */
export async function dropPendingEditions(g: Git, o: {
  root: string; config: LoadedConfig; now: Clock; repo?: string; log?: (line: string) => void; sleep?: Sleep;
}, deps: PublishDeps = {}): Promise<{ dropped: number; remade: number; failed: string[] }> {
  const root = path.resolve(o.root);
  const log = o.log ?? (() => {});
  const none = { dropped: 0, remade: 0, failed: [] as string[] };
  await checkTarget(g, root, o.config, o.repo);
  const dirty = porcelainPaths(await g(["status", "--porcelain", "--untracked-files=all"]));
  if (dirty.length) throw new SyncError(`the working tree has uncommitted changes: ${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? ", ..." : ""}`);
  await g(["fetch", "origin", "main"], P3_LIMITS.gitMs);
  const local = await localCommits(g);
  if (local.length === 0) return none;
  const outside = lines(await g(["diff", "--name-only", "origin/main...HEAD"])).filter((f) => !CONTENT_LAYOUT(f));
  if (outside.length) throw new SyncError(`main has ${local.length} local commit(s) touching ${outside.slice(0, 3).join(", ")}, outside the content layout.`);
  if (!local.some((c) => c.subject.startsWith("brief: "))) return none;

  // What each local correction: commit adds: its name_removed corrections and the disputes it changed.
  const requests: WithholdRequest[] = [];
  const changed = new Map<string, Dispute>();
  let date: string | null = null;
  for (const c of local) {
    if (!c.subject.startsWith("correction: ")) continue;
    const m = /^correction: (\d{4}-\d{2}-\d{2}) · /.exec(c.subject);
    if (m && isValidDate(m[1]!)) date = m[1]!;
    const after = await correctionsAt(g, c.sha);
    const before = await correctionsAt(g, `${c.sha}^`);
    if (!after) continue;
    const had = new Set((before?.corrections ?? []).map((x) => x.id));
    const prev = new Map((before?.disputes ?? []).map((d) => [d.id, JSON.stringify(d)]));
    for (const d of after.disputes) if (prev.get(d.id) !== JSON.stringify(d)) changed.set(d.id, d);
    for (const x of after.corrections) {
      if (had.has(x.id) || x.type !== "name_removed" || x.dispute_id === null) continue;
      const dispute = after.disputes.find((d) => d.id === x.dispute_id);
      const kind = dispute?.kind === "attribution" || dispute?.kind === "victim" ? dispute.kind : x.field.startsWith("attribution") ? "attribution" : "victim";
      requests.push({ item_id: x.item_id, edition_date: x.edition_date, kind, dispute_id: x.dispute_id, since: x.date });
    }
  }

  await g(["reset", "-q", "--hard", "origin/main"]);
  const dropped = local.length;
  log(`Dropped ${dropped} local commit(s) GitHub lacks, an edition among them (§8.7).`);

  const content = path.join(root, "content");
  const synced = readCorrections(content);
  const done = new Set((synced?.corrections ?? []).filter((c) => c.type === "name_removed").map((c) => `${c.edition_date}/${c.item_id}`));
  const todo = requests.filter((r) => !done.has(`${r.edition_date}/${r.item_id}`));
  if (todo.length === 0 || date === null) return { dropped, remade: 0, failed: [] };

  const ctx: Ctx = { root, dir: content, g, free: git(root), date, dryRun: false, edition: false, log, sleep: o.sleep ?? realSleep };
  const disputesNow = () => {
    const cf = readCorrections(content);
    return mergeDisputes(cf?.disputes ?? [], [...changed.values()], new Set((cf?.corrections ?? []).map((c) => c.id)));
  };
  const all: Files = new Map();
  /** What each path held before the first accepted write, so a failed commit puts the tree back. */
  const firstWritten: Written[] = [];
  const remade: WithholdRequest[] = [];
  const failed: string[] = [];
  const attempt = (batch: readonly WithholdRequest[]): boolean => {
    const files = withholdFiles(ctx, o.config, batch, disputesNow(), deps);
    for (const rel of files.keys()) {
      if (!CONTENT_LAYOUT(`content/${rel}`)) throw new Error(`publish: content/${rel} is outside the content layout`);
    }
    const written = writeFiles(content, files);
    try {
      check(ctx, {}, deps);
    } catch (e) {
      restore(content, written);
      if (e instanceof PublishError) return false;
      throw e;
    }
    for (const w of written) if (!all.has(w.rel)) firstWritten.push(w);
    for (const [rel, bytes] of files) all.set(rel, bytes);
    remade.push(...batch);
    return true;
  };
  if (!attempt(todo)) {
    for (const r of todo) if (!attempt([r])) failed.push(r.item_id);
  }
  if (remade.length === 0) {
    log(`No withhold could be made again (${failed.join(", ")}); the next intake sees the disputes.`);
    return { dropped, remade: 0, failed };
  }
  const title = commitTitle("withhold", { date, itemIds: withheldIds(remade) });
  try {
    await land(ctx, { files: all, title, validate: {} }, firstWritten, deps);
  } catch (e) {
    if (!(e instanceof PublishError && e.code === "push")) throw e;
    // A withhold commit whose push fails stays local; the next push carries it.
  }
  return { dropped, remade: remade.length, failed };
}

// ── The CLI ──────────────────────────────────────────────────────────────────────────────────────────

class CliUsage extends Error {}
class CliRefusal extends Error {}

interface CliArgs {
  date: string;
  mode: "full" | "data_only" | "state";
  force: boolean;
  dryRun: boolean;
}

function parseCli(argv: string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { date: { type: "string" }, "data-only": { type: "boolean" }, state: { type: "boolean" }, force: { type: "boolean" }, "dry-run": { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    throw new CliUsage((e as Error).message);
  }
  const { values, positionals } = parsed;
  if (positionals.length) throw new CliUsage(`Unexpected argument: ${positionals[0]}`);
  if (!values.date || !isValidDate(values.date)) throw new CliUsage("--date YYYY-MM-DD is required.");
  if (values["data-only"] && values.state) throw new CliUsage("--data-only and --state cannot be used together.");
  return { date: values.date, mode: values.state ? "state" : values["data-only"] ? "data_only" : "full", force: !!values.force, dryRun: !!values["dry-run"] };
}

/** The CLI's own record: opened and closed in the same commit (plan A18), every stage skipped but its own. */
function cliRecord(o: { date: string; at: number; trigger: "manual" | "dry_run"; codeCommit: string; outcome: RunOutcome; stage: "data_only" | "publish"; config: LoadedConfig }): RunRecord {
  const ts = taipeiTimestamp(new Date(o.at));
  return RunRecord.parse({
    run_id: ts.slice(0, 19).replace(/[-:]/g, "").replace("T", "-"),
    trigger: o.trigger,
    attempt: 1,
    started_at: ts,
    finished_at: ts,
    outcome: o.outcome,
    edition: null,
    error_code: null,
    code_commit: o.codeCommit,
    data_cutoff_utc: dataCutoffFor(o.date),
    data_only_published_at: null,
    full_published_at: null,
    late: o.at > at(o.date, o.config.run.schedule.stale_after),
    stages: RUN_STAGES.map((id) => ({ id, status: id === o.stage ? "ok" : "skipped", started_at: id === o.stage ? ts : null, ended_at: id === o.stage ? ts : null, note: null })),
    feeds: [],
    budgets: { agent_seconds: 0, web_fetches: 0, web_searches: 0, repair_rounds: 0, tokens_in: null, tokens_out: null, usage: null, safety_stops: 0 },
    candidates: null,
    validation: null,
    soft_gates: null,
    deploy: { triggered: false, ready_at: null, shows_date: null, shows_edition: null },
    recheck: null,
    links: null,
  });
}

/** feeds_stale from GitHub's status/D.json: the newest record with feeds, its PARTIAL_FEED_IDS feeds that are stale or failed. */
function feedsStaleFrom(contentFolder: string, date: string, config: LoadedConfig): FeedStale[] {
  const rec = [...readStatusRuns(contentFolder, date)].reverse().find((r) => r.feeds.length > 0);
  if (!rec) return [];
  const ids: readonly string[] = PARTIAL_FEED_IDS;
  return rec.feeds
    .filter((f) => ids.includes(f.id) && (f.status === "stale" || f.status === "failed"))
    .map((f) => ({
      id: f.id,
      name: (config.sources.feeds.find((x) => x.id === f.id) as { name?: string } | undefined)?.name ?? f.id,
      status: f.status as "stale" | "failed",
      newest: f.newest,
      stale_since: f.stale_since,
    }));
}

function readRequired<T>(file: string, root: string, schema: { parse(v: unknown): T }): T {
  const rel = path.relative(root, file);
  if (!fs.existsSync(file)) throw new CliRefusal(`${rel} is missing: nothing was published.`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new CliRefusal(`${rel} is not JSON: nothing was published.`);
  }
  try {
    return schema.parse(raw);
  } catch {
    throw new CliRefusal(`${rel} does not match its schema: nothing was published.`);
  }
}

/** The cutoff of the staged backfill state: days.json's updated_at. */
function stagedCutoff(stagedDir: string): string {
  const days = readJson(path.join(stagedDir, "state", "days.json"), STATE_SCHEMAS["days.json"]);
  if (!days) throw new CliRefusal(`${path.join(stagedDir, "state", "days.json")} is missing or invalid: run npm run backfill first (SPEC §8.4).`);
  return days.updated_at;
}

function failureLine(e: unknown): string {
  if (e instanceof PublishError) return `Nothing published: ${e.code}${e.codes.length ? ` (${e.codes.join(", ")})` : ""}.`;
  if (e instanceof CliRefusal) return e.message;
  if (e instanceof SyncError) return `Nothing published: main could not be synced with GitHub. ${e.message.slice(0, 300)}`;
  return `Publish failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`;
}

/** The CLI. deps.arch defaults to process.arch, deps.sleep to realSleep; exit 0 published, 1 refused or failed, 2 usage. */
export async function main(argv: string[], deps: { arch?: string; now?: Clock; repo?: string; sleep?: Sleep } = {}): Promise<number> {
  const err = (line: string) => void process.stderr.write(`${line}\n`);
  const out = (line: string) => void process.stdout.write(`${line}\n`);
  let a: CliArgs;
  try {
    a = parseCli(argv);
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if ((deps.arch ?? process.arch) !== "arm64") {
    err(NOT_ARM64);
    return 1;
  }
  const now = deps.now ?? Date.now;
  const root = path.resolve(process.cwd());
  const P = runPaths(root, a.date);
  const got = acquireLock(P.lock, now());
  if (!got.acquired) {
    err(heldLockLine(a.date, got.holder.started));
    return 1;
  }
  try {
    const config = loadCheckedConfig({ root });
    const until = publishUntil(config, a.date);
    if (a.mode !== "state" && !a.dryRun && now() >= until) {
      err(tooLateLine(config.run.schedule.publish_until));
      return 1;
    }
    const D = a.date;
    const base = { root, date: D, now, dryRun: a.dryRun, freshCopy: a.dryRun, repo: deps.repo, config, log: out, sleep: deps.sleep };
    if (!a.dryRun) {
      const r = await dropPendingEditions(git(root), { root, config, now, repo: deps.repo, log: out, sleep: deps.sleep });
      if (r.dropped) out(`Dropped ${r.dropped} unpushed commit(s); ${r.remade} withhold(s) made again${r.failed.length ? `, ${r.failed.join(", ")} left for the next intake` : ""}.`);
      await syncMain(git(root), CONTENT_LAYOUT);
    }

    if (a.mode === "state") {
      const stagedDir = cachePaths(root).stagedBackfill;
      const r = await publishState({ ...base, deadline: Number.POSITIVE_INFINITY, mode: "backfill", stagedDir, cutoff: stagedCutoff(stagedDir) });
      out(r.sha ? `State published (${sha7(r.sha)}): ${r.files.length} files.` : a.dryRun ? `Dry run: ${r.files.length} state files in logs/dry-run/${D}.` : "Nothing to publish: the staged state matches content/state/.");
      return 0;
    }

    const codeCommit = await git(root)(["rev-parse", "HEAD"]);
    const trigger = a.dryRun ? "dry_run" : "manual";
    const startedAt = now();
    if (a.mode === "data_only") {
      const rec = cliRecord({ date: D, at: startedAt, trigger, codeCommit, outcome: a.dryRun ? "dry_run" : "published_data_only", stage: "data_only", config });
      const pack = readPack(root, D);
      const r = await publishDataOnly({
        ...base, deadline: until, records: [rec], feedsStale: feedsStaleFrom(P.content, D, config), generatedAt: pack?.generated_at ?? taipeiTimestamp(new Date(startedAt)),
      });
      out(r.sha ? `Data-only edition for ${D} published (${sha7(r.sha)}).` : `Dry run: the data-only edition for ${D} is in logs/dry-run/${D}.`);
      return 0;
    }

    // Full mode (plan A18): drafts/D.json validated against the run's logs and the metrics, the soft pass
    // dropping what the snapshots do not support, with no new fetches.
    const raw = readRequired(P.draft, root, { parse: (v: unknown) => v });
    const parsed = GatedDraftSchema.safeParse(raw);
    if (!parsed.success) throw new CliRefusal(`drafts/${D}.json does not match the draft schema (SCHEMA): nothing was published.`);
    const context = readRequired(P.contextLog, root, AgentContext);
    const evidence = readRequired(P.evidence, root, Evidence);
    const regionsBase: RegionsBase = { ...readRequired(P.regionsInput, root, RegionsInputFile), config: regionsConfig(config) };
    const mf = metricsFor(root, P.content, D);
    fs.mkdirSync(P.cveRecords, { recursive: true });
    const pack = readPack(root, D);
    const inputs: DraftInputs = {
      context, evidence, metrics: mf?.metrics ?? null, config, cveList: cveLookupFromDir(P.cveRecords), regionsBase,
      packDates: pack ? packDatesOf(pack) : null, fileDate: D,
    };
    const first = validateGated(parsed.data, inputs);
    const { draft } = dropUnverified(parsed.data, [...first.errors, ...first.warnings]);
    const second = validateGated(draft, { ...inputs, cveList: cveLookupFromDir(P.cveRecords) });
    if (second.errors.length) {
      throw new CliRefusal(`drafts/${D}.json has ${second.errors.length} validation errors (${[...new Set(second.errors.map((e) => e.code))].sort().join(", ")}): nothing was published.`);
    }
    const snaps = draft.sources.map((s) => readSnapshot(root, s.url)).filter((s): s is Snapshot => s !== null);
    const feedsStale = feedsStaleFrom(P.content, D, config);
    const edition = feedsStale.length ? "partial" : "full";
    const rec = cliRecord({
      date: D, at: startedAt, trigger, codeCommit, outcome: a.dryRun ? "dry_run" : edition === "partial" ? "published_partial" : "published_full", stage: "publish", config,
    });
    rec.validation = { errors: 0, warnings: second.warnings.length, codes: [...new Set(second.warnings.map((w) => w.code))].sort() };
    const r = await publishFull({
      ...base, deadline: until, records: [rec], force: a.force, edition, draft, context, evidence, cveList: cveLookupFromDir(P.cveRecords),
      regionsBase, snapshots: snapshotHashes(snaps), feedsStale, disputes: null, recheck: null,
    });
    out(r.sha ? `${edition === "partial" ? "Partial" : "Full"} edition for ${D} published (${sha7(r.sha)}).` : `Dry run: the ${edition} edition for ${D} is in logs/dry-run/${D}.`);
    return 0;
  } catch (e) {
    err(failureLine(e));
    return 1;
  } finally {
    releaseLock(P.lock);
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
