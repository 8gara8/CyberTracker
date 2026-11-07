import { run, type RunResult } from "./run";

// Git through child processes (SPEC §8.8). Never prompts: GIT_TERMINAL_PROMPT=0 makes a missing
// credential fail fast instead of hanging an unattended run. A deadline caps every command's timeout,
// so publishing can't run past the hard stop. Copied from the Europe fork's scripts/lib/git.ts; syncMain
// takes the allowed paths and fast-forwards, and onOriginMain replaces onOrigin.

export class GitError extends Error {}

/** Main can't be brought up to date automatically; retrying won't help. */
export class SyncError extends GitError {}

export interface Git {
  (args: string[], timeoutMs?: number): Promise<string>;
  cwd: string;
  deadline: number | null;
}

export function git(cwd: string, opts: { deadline?: number } = {}): Git {
  const deadline = opts.deadline ?? null;
  const fn = (async (args: string[], timeoutMs = 60_000) => {
    const ms = deadline === null ? timeoutMs : Math.min(timeoutMs, deadline - Date.now());
    if (ms <= 0) throw new GitError(`git ${args[0]} not started: the run's deadline has passed.`);
    const r: RunResult = await run("git", args, { cwd, timeoutMs: ms, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (r.code !== 0) throw new GitError(`git ${args.join(" ")} failed (${r.timedOut ? "timeout" : `exit ${r.code}`}): ${r.stderr.trim().slice(0, 400)}`);
    // Only the end is trimmed: `status --porcelain` lines start with a meaningful space.
    return r.stdout.replace(/\s+$/, "");
  }) as Git;
  fn.cwd = cwd;
  fn.deadline = deadline;
  return fn;
}

export async function isClean(g: Git): Promise<boolean> {
  return (await g(["status", "--porcelain"])) === "";
}

/** Runs `fn`, retrying after each delay unless the error is fatal or the next try would start past the deadline. */
export async function withRetry<T>(fn: () => Promise<T>, delays: number[], deadline: number | null, fatal: (e: unknown) => boolean = () => false): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (fatal(e)) throw e;
      last = e;
      const wait = delays[attempt];
      if (wait === undefined || (deadline !== null && Date.now() + wait >= deadline)) break;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

/** Sets a local commit identity only when none is configured (a fresh CI machine), so a commit never fails on it. */
export async function ensureIdentity(g: Git): Promise<void> {
  for (const [key, value] of [["user.name", "CyberTracker"], ["user.email", "run@cybertracker.invalid"]] as const) {
    try {
      await g(["config", key]);
    } catch {
      await g(["config", key, value]);
    }
  }
}

/** Pushes with retries at 2 s, 4 s and 8 s. */
export async function pushWithRetry(g: Git, args: string[], delays = [2_000, 4_000, 8_000]): Promise<void> {
  await withRetry(() => g(["push", ...args], 120_000), delays, g.deadline);
}

/** The paths a branch may hold: a path is allowed when it equals an entry or sits under an entry ending in "/". */
export type Layout = (path: string) => boolean;

/** Paths listed by `git status --porcelain` (renames give the new path). */
export function porcelainPaths(status: string): string[] {
  return status
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => {
      const p = l.slice(3);
      const arrow = p.indexOf(" -> ");
      return (arrow >= 0 ? p.slice(arrow + 4) : p).replace(/^"|"$/g, "");
    });
}

/**
 * Brings the checked-out main up to date with origin's (SPEC §8.8). Refuses when the working tree, or a
 * local commit origin lacks, touches a path outside `layout`. With no local commits it fast-forwards
 * (`merge --ff-only`, which keeps uncommitted metrics and state files in place); otherwise it rebases
 * with `--autostash`, aborting and throwing on conflict. `moved` is true when local commits now sit on
 * newer commits from origin.
 */
export async function syncMain(g: Git, layout: Layout): Promise<{ ahead: number; moved: boolean }> {
  const dirty = porcelainPaths(await g(["status", "--porcelain", "--untracked-files=all"])).filter((p) => !layout(p));
  if (dirty.length) throw new SyncError(`the working tree has changes outside the content layout: ${dirty.slice(0, 3).join(", ")}`);
  await g(["fetch", "origin", "main"], 60_000);
  const ahead = (await g(["rev-list", "origin/main..HEAD"])).split("\n").filter(Boolean).length;
  if (!ahead) {
    await g(["merge", "--ff-only", "origin/main"]);
    return { ahead, moved: false };
  }
  const other = (await g(["diff", "--name-only", "origin/main...HEAD"])).split("\n").filter((f) => f && !layout(f));
  if (other.length) throw new SyncError(`main has ${ahead} local commit(s) touching ${other.slice(0, 3).join(", ")}, outside the content layout.`);
  const before = await g(["rev-parse", "HEAD"]);
  try {
    await g(["rebase", "--autostash", "origin/main"]);
  } catch (e) {
    await g(["rebase", "--abort"]).catch(() => {});
    throw new SyncError(`Couldn't put main's unpushed commits on top of origin's main: ${(e as Error).message}`);
  }
  return { ahead, moved: (await g(["rev-parse", "HEAD"])) !== before };
}

/** True when origin's `main`, asked live with ls-remote, is exactly `sha` (SPEC §8.8 step 8). */
export async function onOriginMain(g: Git, sha: string): Promise<boolean> {
  const line = await g(["ls-remote", "origin", "refs/heads/main"], 60_000);
  return line.split(/\s+/)[0] === sha;
}
