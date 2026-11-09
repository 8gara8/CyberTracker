// The backfill's CVE List clone (SPEC §5.9 step 1, ruling R26): updated in place at one commit, then read
// with worker threads into CveFacts. In place means `git init` once, then a shallow fetch of the commit and
// a forced checkout with `git clean -fdx`, so a second commit transfers only what changed and the tree is
// the commit's exactly. A clone already at the commit and clean is reused. Git runs through P1's
// scripts/lib/git.ts (GIT_TERMINAL_PROMPT=0); both repos are public, so no credential is ever involved.

import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { CveFacts } from "../../lib/feeds/types";
import { byCodeUnit, compareCveIds } from "../../lib/ids";
import { git, type Git } from "./git";
import { readBuckets, type BucketRead, type CveReadJob } from "./cve-read-worker";
import { run } from "./run";

/** The fetch and the checkout of about 420,000 files may each take minutes on a first clone. */
const FETCH_TIMEOUT_MS = 30 * 60_000;
const CHECKOUT_TIMEOUT_MS = 30 * 60_000;
const SHA_RE = /^[0-9a-f]{40}$/;
const YEAR_RE = /^\d{4}$/;
const BUCKET_RE = /^\d+xxx$/;

export interface CloneInfo {
  commit: string;
  /** The commit's committer time, as an ISO instant in UTC ("2026-11-07T17:28:47Z"). */
  committedAt: string;
  seconds: number;
  /** Disk use of the clone folder (du), .git included. */
  bytes: number;
  /** True when the folder was already at the commit and clean, so nothing was fetched. */
  reused: boolean;
}

/** An ISO time with an offset (git's %cI) as a UTC instant without milliseconds. */
function utcInstant(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Unreadable commit time: ${JSON.stringify(iso)}`);
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Disk use in bytes (du -sk; the same command on Linux and macOS). */
export async function diskBytes(dir: string): Promise<number> {
  const r = await run("du", ["-sk", dir], { timeoutMs: 10 * 60_000 });
  const kb = Number(/^(\d+)/.exec(r.stdout)?.[1]);
  return r.code === 0 && Number.isFinite(kb) ? kb * 1024 : 0;
}

async function headOf(g: Git): Promise<string | null> {
  try {
    return await g(["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch {
    return null;
  }
}

/**
 * Fetches `commit` (or the tip of `main` when null) from `url` into `dir` and checks it out clean: §5.9
 * step 1 in place (ruling R26). Reuses a clone already at the commit with a clean tree. Throws on any git
 * failure, or when HEAD is not the commit asked for afterwards.
 */
export async function ensureClone(dir: string, url: string, commit: string | null): Promise<CloneInfo> {
  if (commit !== null && !SHA_RE.test(commit)) throw new Error(`Not a full commit SHA: ${JSON.stringify(commit)}`);
  const started = Date.now();
  fs.mkdirSync(dir, { recursive: true });
  const g = git(dir);
  const isRepo = fs.existsSync(path.join(dir, ".git"));
  let reused = false;
  if (isRepo && commit !== null && (await headOf(g)) === commit && (await g(["status", "--porcelain", "--untracked-files=all"], CHECKOUT_TIMEOUT_MS)) === "") {
    reused = true;
  } else {
    if (!isRepo) await g(["init", "--quiet"]);
    const remotes = (await g(["remote"])).split("\n").filter(Boolean);
    await g(remotes.includes("origin") ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url]);
    await g(["fetch", "--quiet", "--depth", "1", "--no-tags", "origin", commit ?? "main"], FETCH_TIMEOUT_MS);
    await g(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"], CHECKOUT_TIMEOUT_MS);
    await g(["clean", "-fdxq"], CHECKOUT_TIMEOUT_MS);
  }
  const head = await headOf(g);
  if (head === null || (commit !== null && head !== commit)) throw new Error(`The clone is at ${head ?? "no commit"}, not ${commit ?? "main"}.`);
  const committedAt = utcInstant(await g(["log", "-1", "--format=%cI", "HEAD"]));
  const seconds = (Date.now() - started) / 1000;
  return { commit: head, committedAt, seconds, bytes: await diskBytes(dir), reused };
}

/** The clone-relative bucket folders cves/<YYYY>/<Nxxx>, in code-unit order (delta.json and deltaLog.json are skipped). */
export function cloneBuckets(dir: string): string[] {
  const cves = path.join(dir, "cves");
  const dirs = (p: string, re: RegExp) =>
    fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && re.test(e.name)).map((e) => e.name).sort(byCodeUnit);
  if (!fs.existsSync(cves)) throw new Error(`No cves/ folder in ${dir}: not a CVE List V5 clone.`);
  return dirs(cves, YEAR_RE).flatMap((y) => dirs(path.join(cves, y), BUCKET_RE).map((b) => `cves/${y}/${b}`));
}

/** tsx's loader for the workers (ruling R35): absolute, so the workers find it whatever the working folder. */
function tsxImport(): string {
  try {
    return import.meta.resolve("tsx");
  } catch {
    return "tsx";
  }
}

function readInWorker(dir: string, buckets: string[]): Promise<BucketRead> {
  const job: CveReadJob = { kind: "cve-read", dir, buckets };
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./cve-read-worker.ts", import.meta.url), { workerData: job, execArgv: ["--import", tsxImport()] });
    let settled = false;
    w.once("message", (m: { ok: true; result: BucketRead } | { ok: false; error: string }) => {
      settled = true;
      if (m.ok) resolve(m.result);
      else reject(new Error(`Clone reader worker: ${m.error}`));
      void w.terminate();
    });
    w.once("error", (e) => {
      if (!settled) reject(e);
      settled = true;
    });
    w.once("exit", (code) => {
      if (!settled) reject(new Error(`Clone reader worker exited with code ${code} before answering.`));
      settled = true;
    });
  });
}

/**
 * Every cves/<YYYY>/<Nxxx>/CVE-*.json in the clone as CveFacts, sorted by CVE id. The bucket folders are
 * dealt round-robin to `workers` worker threads (1 reads in this thread), and the results are merged and
 * sorted with compareCveIds, so the worker count never changes the result. `unreadable` lists files that
 * are not JSON or have no readable cveMetadata (counted in `files`, absent from `facts`).
 */
export async function readClone(dir: string, workers: number): Promise<{ facts: CveFacts[]; files: number; creditStrings: number; unreadable: string[] }> {
  const buckets = cloneBuckets(dir);
  const n = Math.max(1, Math.min(Math.floor(workers) || 1, buckets.length || 1));
  let parts: BucketRead[];
  if (n === 1) {
    parts = [readBuckets(dir, buckets)];
  } else {
    const shares: string[][] = Array.from({ length: n }, () => []);
    buckets.forEach((b, i) => shares[i % n]!.push(b));
    parts = await Promise.all(shares.map((s) => readInWorker(dir, s)));
  }
  const facts = parts.flatMap((p) => p.facts).sort((a, b) => compareCveIds(a.cve_id, b.cve_id));
  return {
    facts,
    files: parts.reduce((s, p) => s + p.files, 0),
    creditStrings: facts.reduce((s, f) => s + f.credits.length, 0),
    unreadable: parts.flatMap((p) => p.unreadable).sort(byCodeUnit),
  };
}
