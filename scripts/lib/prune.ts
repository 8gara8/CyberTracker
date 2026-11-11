// Pruning at the run's finish (SPEC §9.8), never failing the run. Owner: lane L6.
//
// pruneRunFiles(): logs, drafts, packs, dry-run copies and logs/recompute/D older than 60 days by the date
// in the name; logs/dry-run/tree/, needs-review/ and anything newer are kept. An entry counts only when its
// name starts with a real date followed by "." or nothing at all ("2026-10-14.daily.log", "2026-10-14.json",
// the folder "2026-10-14"): undated names (runs.jsonl, .lock, drafts/context.json, logs/dry-run/tree, the
// agent check's canary.jsonl) are never removed, and neither is anything outside its folders. Ages are
// counted in whole days from `today`, never from file times, so a copied or touched file is pruned like any
// other. Europe's scripts/daily.ts cleanup() is the model (best effort, never fails the run); this one goes
// by name instead of mtime and also takes the dated folders.
//
// pruneCache(): the cache's feed bodies (EPSS files and the CVE List delta zips, the other bulk copies,
// included) and page snapshots, kept 60 days by modification time, since snapshots are named by a hash and
// bodies by their feed. collect rewrites every body it reads, so only bodies no collect has written for 60
// days go. index.json and inputs.json, the clones (cvelistV5, the GHSA checkout), staged/ and
// cvelist/records/ are never touched; collect and the backfill manage those (§9.8).

import fs from "node:fs";
import path from "node:path";
import { daysBetween, isValidDate } from "../../lib/dates";
import { cachePaths } from "../../lib/feeds/cache";
import { MIN } from "./clock";
import { runPaths } from "./paths";

export const KEEP_DAYS = 60;
const DAY_MS = 24 * 60 * MIN;

/** The date a run file's name starts with, or null: "2026-10-14.agent-1.jsonl" and "2026-10-14" give 2026-10-14. */
export function dateInName(name: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:\.|$)/.exec(name);
  return m && isValidDate(m[1]!) ? m[1]! : null;
}

/** The folders pruneRunFiles reads, each for its dated entries only (files or folders). */
export function pruneDirs(root: string, today: string): string[] {
  const p = runPaths(root, today);
  const logs = path.dirname(p.dailyLog);
  return [
    logs,
    path.dirname(p.dryRunCopy),          // logs/dry-run/D; logs/dry-run/tree is undated and stays
    path.join(logs, "recompute"),        // logs/recompute/D (§8.4)
    p.agentCheckDir,
    path.dirname(p.draft),
    path.dirname(p.pack),
  ];
}

/**
 * Removes every dated entry of pruneDirs() whose date is more than `keepDays` days before `today`
 * (today − 60 stays, today − 61 goes). A symlink is removed as a link, never followed. Never throws: an
 * unreadable folder or an entry that cannot be removed is passed over, and a malformed `today` removes
 * nothing. `removed` counts the entries removed (a folder counts once).
 */
export function pruneRunFiles(root: string, today: string, keepDays: number = KEEP_DAYS): { removed: number } {
  if (!isValidDate(today)) return { removed: 0 };
  const keep = Number.isFinite(keepDays) && keepDays >= 0 ? Math.floor(keepDays) : KEEP_DAYS;
  let removed = 0;
  let dirs: string[];
  try {
    dirs = pruneDirs(root, today);
  } catch {
    return { removed: 0 };
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const date = dateInName(name);
      if (date === null || daysBetween(date, today) <= keep) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.lstatSync(full);
        if (st.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
        else fs.unlinkSync(full);
        removed += 1;
      } catch {
        // Best effort: the next run tries again.
      }
    }
  }
  return { removed };
}

/** A cache folder pruneCache() reads: its files (never its subfolders) go after 60 days, except `keep`. */
export interface CacheBodyDir {
  dir: string;
  keep: readonly string[];
}

/**
 * The folders of bodies and snapshots (§9.8): collect's cache/feeds (but index.json and inputs.json),
 * cache/cvelist/zips, cache/epss and cache/snapshots, and the same body folders under sources:check's
 * cache/check/ (collect.ts checkCachePaths()). No clone, staged/ or cvelist/records/ is listed.
 */
export function cacheBodyDirs(root: string): CacheBodyDir[] {
  const p = cachePaths(root);
  const cache = path.join(root, "cache");
  const check = (dir: string) => path.join(cache, "check", path.relative(cache, dir));
  const fixed = [path.basename(p.feedIndex), path.basename(p.collectInputs)];
  const bodies = [
    { dir: p.feedsDir, keep: fixed },
    { dir: p.zipsDir, keep: [] },
    { dir: path.dirname(p.epssFile("2026-01-01")), keep: [] },
  ];
  return [
    ...bodies,
    { dir: runPaths(root, "2026-01-01").snapshotsDir, keep: [] },
    ...bodies.map((b) => ({ dir: check(b.dir), keep: b.keep })),
  ];
}

/**
 * Removes every file in cacheBodyDirs() last modified more than `keepDays` days before `nowMs` (real epoch
 * ms, the clock file times are on), except each folder's `keep` names. Subfolders are never entered or
 * removed, and a symlink is judged and removed as a link, never followed. Never throws; `removed` counts
 * the files removed.
 */
export function pruneCache(root: string, nowMs: number, keepDays: number = KEEP_DAYS): { removed: number } {
  if (!Number.isFinite(nowMs)) return { removed: 0 };
  const keep = Number.isFinite(keepDays) && keepDays >= 0 ? keepDays : KEEP_DAYS;
  const cutoff = nowMs - keep * DAY_MS;
  let removed = 0;
  let dirs: CacheBodyDir[];
  try {
    dirs = cacheBodyDirs(root);
  } catch {
    return { removed: 0 };
  }
  for (const { dir, keep: kept } of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (kept.includes(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.lstatSync(full);
        if (st.isDirectory() || st.mtimeMs >= cutoff) continue;
        fs.unlinkSync(full);
        removed += 1;
      } catch {
        // Best effort: the next run tries again.
      }
    }
  }
  return { removed };
}
