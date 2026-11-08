import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// One run at a time. The lock file holds {pid, started}; a lock whose process is gone, or that is older
// than two hours, is stale and is replaced (SPEC §8.2).
//
// The lock appears atomically and complete: the holder is written to a private temp file, then
// hard-linked to the lock path, which fails with EEXIST if another run got there first. So a second run
// never sees a half-written lock (which it would take for stale), and losing the race returns
// `acquired: false` with the winner instead of throwing (PR 2 review).
//
// Replacing a stale lock is guarded the same way (PR 2 review, round 2). Two runs can both read the same
// stale lock; removing it by path would let the slower one delete the lock the faster one has just taken.
// So a run first creates a reap marker named after the stale lock's exact contents, re-reads the lock
// while it holds the marker, and removes it only if it is still that same stale lock. A fresh lock never
// has the stale one's contents, so it is never removed. A marker left by a run that died is removed once
// its process is gone.

export const STALE_AFTER_MS = 2 * 3_600_000;

type Holder = { pid: number; started: string };

export type LockResult =
  | { acquired: true; replacedStale: string | null }
  | { acquired: false; holder: Holder };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Creates `file` with `content` only if it doesn't exist. False when another run holds it. */
function createExclusive(file: string, content: string): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

type Read = { raw: string; holder: Holder | "unreadable" };

/** The lock's text and holder ("unreadable" if it is corrupt), or "missing" if it vanished meanwhile. */
function readLock(file: string): Read | "missing" {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw e;
  }
  try {
    const h = JSON.parse(raw) as Holder;
    return { raw, holder: typeof h.pid === "number" && typeof h.started === "string" ? h : "unreadable" };
  } catch {
    return { raw, holder: "unreadable" };
  }
}

/** Removes the stale lock whose text is `stale.raw`, unless another run is replacing it or it has changed. */
function reapStale(file: string, stale: Read, mine: string): boolean {
  const marker = `${file}.reap-${createHash("sha256").update(stale.raw).digest("hex").slice(0, 16)}`;
  if (!createExclusive(marker, mine)) {
    const m = readLock(marker);
    if (m !== "missing" && (m.holder === "unreadable" || !alive(m.holder.pid))) fs.rmSync(marker, { force: true });
    return false;
  }
  try {
    const now = readLock(file);
    if (now === "missing" || now.raw !== stale.raw) return false;
    fs.rmSync(file, { force: true });
    return true;
  } finally {
    fs.rmSync(marker, { force: true });
  }
}

/** `hooks.beforeReap` is a test seam: it runs after a stale lock is read and before it is replaced. */
export function acquireLock(file: string, now = Date.now(), hooks: { beforeReap?: () => void } = {}): LockResult {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, started: new Date(now).toISOString() });
  let replacedStale: string | null = null;
  // Three tries cover: the lock is free; it is held; it was released or found stale between our tries.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createExclusive(file, mine)) return { acquired: true, replacedStale };
    const read = readLock(file);
    if (read === "missing") continue;
    const { holder } = read;
    if (holder !== "unreadable" && alive(holder.pid) && now - Date.parse(holder.started) < STALE_AFTER_MS) {
      return { acquired: false, holder };
    }
    hooks.beforeReap?.();
    if (reapStale(file, read, mine)) {
      replacedStale = holder === "unreadable" ? "an unreadable lock file" : `pid ${holder.pid} from ${holder.started}`;
    }
  }
  const last = readLock(file);
  if (last !== "missing" && last.holder !== "unreadable") return { acquired: false, holder: last.holder };
  throw new Error(`Could not take the lock ${file} after 3 tries`);
}

export function releaseLock(file: string): void {
  try {
    const holder = JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number };
    if (holder.pid === process.pid) fs.rmSync(file, { force: true });
  } catch { /* nothing to release */ }
}
