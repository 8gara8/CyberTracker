// scripts/publish.ts: the only writer to the content repo (SPEC §8.8).
//
//   tsx scripts/publish.ts --ops <branch> --from <dir> [--command <name>]
//
// P0 lands ops mode only: it pushes the files under --from to a short-lived `ops/*` branch of the
// content repo, which carries maintenance outputs back to coding sessions (SPEC §9.4). It refuses `main`
// and any branch outside `ops/`. P3 adds the data-only, full, status, withhold and state publishes.
// Exit 0 published, 1 refused or failed (the reason on stderr), 2 usage.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { taipeiTimestamp } from "../lib/dates";
import { ensureIdentity, git, pushWithRetry, type Git } from "./lib/git";

export class PublishError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ? `${code}: ${message}` : code);
  }
}

export const OPS_BRANCH_RE = /^ops\/[a-z0-9][a-z0-9-]*$/;
export const OPS_COMMAND_RE = /^[a-z][a-z-]*$/;

/** Commit titles hold dates, counts, run ids, outcomes and item ids only (SPEC §8.8). P0 builds the ops form. */
export function commitTitle(kind: "ops", args: { command: string; at: Date }): string {
  if (kind !== "ops") throw new Error(`unknown commit kind ${kind as string}`);
  if (!OPS_COMMAND_RE.test(args.command)) throw new PublishError("usage", "bad ops command name");
  const ts = taipeiTimestamp(args.at);
  return `ops: ${args.command} ${ts.slice(0, 10)} ${ts.slice(11, 16)}`;
}

export interface OpsOptions {
  branch: string;
  /** A folder whose files are copied, keeping their relative paths, into the branch. */
  from: string;
  command: string;
  /** The content repo's clone URL (run.json repos.content_clone_url, or a bare repo in tests). */
  remote: string;
  now?: Date;
  deadline?: number;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(path.relative(dir, path.join(entry.parentPath, entry.name)));
  }
  return out.sort();
}

async function remoteHas(g: Git, ref: string): Promise<boolean> {
  return (await g(["ls-remote", "origin", ref], 60_000)) !== "";
}

/**
 * Ops mode (SPEC §8.8 `publishOps`): starts from the branch's tip on origin when it exists, else from
 * `main` (or from nothing when the repo is still empty), adds one commit with the files under `from`,
 * and pushes that branch only. Exempt from the content layout; never touches `main`.
 */
export async function publishOps(o: OpsOptions): Promise<{ sha: string; branch: string; files: string[] }> {
  if (!OPS_BRANCH_RE.test(o.branch)) throw new PublishError("refused", "ops mode pushes only to ops/<name> branches");
  if (!fs.existsSync(o.from) || !fs.statSync(o.from).isDirectory()) throw new PublishError("usage", "--from is not a folder");
  const files = listFiles(o.from);
  if (!files.length) throw new PublishError("usage", "--from holds no files");
  const now = o.now ?? new Date();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ct-ops-"));
  try {
    const g = git(work, { deadline: o.deadline });
    await g(["init", "-q"]);
    await ensureIdentity(g);
    await g(["remote", "add", "origin", o.remote]);
    const branchRef = `refs/heads/${o.branch}`;
    if (await remoteHas(g, branchRef)) {
      await g(["fetch", "-q", "--depth", "1", "origin", `${branchRef}:refs/remotes/origin/${o.branch}`], 120_000);
      await g(["checkout", "-q", "-b", "ops-work", `refs/remotes/origin/${o.branch}`]);
    } else if (await remoteHas(g, "refs/heads/main")) {
      await g(["fetch", "-q", "--depth", "1", "origin", "refs/heads/main:refs/remotes/origin/main"], 120_000);
      await g(["checkout", "-q", "-b", "ops-work", "refs/remotes/origin/main"]);
    } else {
      await g(["checkout", "-q", "--orphan", "ops-work"]);
    }
    for (const rel of files) {
      const dest = path.join(work, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(o.from, rel), dest);
    }
    await g(["add", "--", ...files]);
    await g(["commit", "-q", "--allow-empty", "-m", commitTitle("ops", { command: o.command, at: now })]);
    const sha = await g(["rev-parse", "HEAD"]);
    await pushWithRetry(g, ["origin", `HEAD:${branchRef}`]);
    const remoteSha = (await g(["ls-remote", "origin", branchRef], 60_000)).split(/\s+/)[0];
    if (remoteSha !== sha) throw new PublishError("push", "the ops branch does not show the new commit");
    return { sha, branch: o.branch, files };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export function contentRemote(repo = process.cwd()): string {
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, "config", "run.json"), "utf8")) as { repos: { content_clone_url: string } };
  return process.env.CT_CONTENT_REMOTE || cfg.repos.content_clone_url;
}

async function main(): Promise<number> {
  let values: { ops?: string; from?: string; command?: string };
  try {
    ({ values } = parseArgs({ options: { ops: { type: "string" }, from: { type: "string" }, command: { type: "string" } } }));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (!values.ops || !values.from) {
    console.error("Usage: tsx scripts/publish.ts --ops <branch> --from <dir> [--command <name>] (other modes arrive in P3)");
    return 2;
  }
  try {
    const r = await publishOps({ branch: values.ops, from: path.resolve(values.from), command: values.command ?? "manual", remote: contentRemote() });
    console.log(`published ${r.files.length} file(s) to ${r.branch} at ${r.sha.slice(0, 12)}`);
    return 0;
  } catch (e) {
    console.error(e instanceof PublishError ? e.message : `failed: ${(e as Error).message.slice(0, 300)}`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) main().then((code) => { process.exitCode = code; });
