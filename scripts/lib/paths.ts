import path from "node:path";
import run from "../../config/run.json";
import { isValidDate } from "../../lib/dates";
import { cachePaths } from "../../lib/feeds/cache";
import { contentDir } from "../../lib/site";

// Every per-run file of SPEC §8.2 "Files the run leaves" and §9.8, in one table for all P3 lanes, so no
// module spells a run path itself. The cache paths come from cachePaths() (lib/feeds/cache.ts) and the
// pack paths from run.json's `paths`, as scripts/collect.ts writes them. Pure: builds paths, touches no
// file. contentDir() (CT_CONTENT_DIR) is read when runPaths() is called. Written by step S0 and frozen.

export interface RunPaths {
  root: string;
  date: string;
  /** path.resolve(root, contentDir()) */
  content: string;
  /** logs/.lock */
  lock: string;
  /** logs/D.daily.log */
  dailyLog: string;
  /** logs/D.summary.md */
  summary: string;
  /** logs/runs.jsonl */
  runsJsonl: string;
  /** logs/D.collect.log (collect writes it) */
  collectLog: string;
  /** logs/D.metrics.log */
  metricsLog: string;
  /** logs/D.candidates.json (collect writes it) */
  candidatesLog: string;
  /** logs/D.context.json */
  contextLog: string;
  /** logs/D.regions-input.json */
  regionsInput: string;
  /** logs/D.evidence.json */
  evidence: string;
  /** logs/D.validation.json */
  validation: string;
  /** logs/D.dropped.json */
  dropped: string;
  /** logs/D.recheck.json */
  recheck: string;
  /** logs/D.status.json (dry runs) */
  statusMirror: string;
  /** logs/dry-run/D */
  dryRunCopy: string;
  /** logs/dry-run/tree */
  dryRunTree: string;
  /** logs/agent-check */
  agentCheckDir: string;
  /** drafts/D.json */
  draft: string;
  /** drafts/context.json */
  contextCopy: string;
  /** packs/D.json */
  pack: string;
  /** packs/D.md */
  packMd: string;
  /** packs/D.candidates.json */
  packCandidates: string;
  /** needs-review/D */
  needsReview: string;
  /** cache/staged/D (cachePaths(root).stagedMetrics(D)) */
  staged: string;
  /** cache/snapshots */
  snapshotsDir: string;
  /** cache/cvelist/records (cachePaths(root).recordsDir) */
  cveRecords: string;
  /** cache/feeds/index.json (cachePaths(root).feedIndex) */
  feedIndex: string;
  /** node_modules/.ct-lock-sha */
  lockSha: string;
  /** package-lock.json */
  packageLock: string;
}

/** The run files for edition date `date` under the repo root `root`. Throws on a malformed date. */
export function runPaths(root: string, date: string): RunPaths {
  if (!isValidDate(date)) throw new Error(`runPaths: not a valid date: ${JSON.stringify(date)}`);
  const r = path.resolve(root);
  const logs = path.join(r, run.paths.logs);
  const drafts = path.join(r, run.paths.drafts);
  const packs = path.join(r, run.paths.packs);
  const cache = cachePaths(r);
  return {
    root: r,
    date,
    content: path.resolve(r, contentDir()),
    lock: path.join(logs, ".lock"),
    dailyLog: path.join(logs, `${date}.daily.log`),
    summary: path.join(logs, `${date}.summary.md`),
    runsJsonl: path.join(logs, "runs.jsonl"),
    collectLog: path.join(logs, `${date}.collect.log`),
    metricsLog: path.join(logs, `${date}.metrics.log`),
    candidatesLog: path.join(logs, `${date}.candidates.json`),
    contextLog: path.join(logs, `${date}.context.json`),
    regionsInput: path.join(logs, `${date}.regions-input.json`),
    evidence: path.join(logs, `${date}.evidence.json`),
    validation: path.join(logs, `${date}.validation.json`),
    dropped: path.join(logs, `${date}.dropped.json`),
    recheck: path.join(logs, `${date}.recheck.json`),
    statusMirror: path.join(logs, `${date}.status.json`),
    dryRunCopy: path.join(logs, "dry-run", date),
    dryRunTree: path.join(logs, "dry-run", "tree"),
    agentCheckDir: path.join(logs, "agent-check"),
    draft: path.join(drafts, `${date}.json`),
    contextCopy: path.join(drafts, "context.json"),
    pack: path.join(packs, `${date}.json`),
    packMd: path.join(packs, `${date}.md`),
    packCandidates: path.join(packs, `${date}.candidates.json`),
    needsReview: path.join(r, run.paths.needs_review, date),
    staged: cache.stagedMetrics(date),
    snapshotsDir: path.join(r, "cache", "snapshots"),
    cveRecords: cache.recordsDir,
    feedIndex: cache.feedIndex,
    lockSha: path.join(r, "node_modules", ".ct-lock-sha"),
    packageLock: path.join(r, "package-lock.json"),
  };
}

/** logs/D.agent-N.jsonl, or logs/D.agent-N-repair-K.jsonl for repair round K. */
export function agentTranscript(p: RunPaths, attempt: number, repair?: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`agentTranscript: attempt must be 1 or more, got ${attempt}`);
  if (repair !== undefined && (!Number.isInteger(repair) || repair < 1)) throw new Error(`agentTranscript: repair must be 1 or more, got ${repair}`);
  const name = repair === undefined ? `${p.date}.agent-${attempt}.jsonl` : `${p.date}.agent-${attempt}-repair-${repair}.jsonl`;
  return path.join(path.dirname(p.dailyLog), name);
}
