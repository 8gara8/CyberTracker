import fs from "node:fs";
import path from "node:path";

// One run at a time. The lock file holds {pid, started}; a lock whose process is gone, or that is older
// than two hours, is stale and is replaced (SPEC §8.2).
//
// The lock appears atomically and complete: the holder is written to a private temp file, then
// hard-linked to the lock path, which fails with EEXIST if another run got there first. So a second run
// never sees a half-written lock (which it would take for stale), and losing the race returns
// `acquired: false` with the winner instead of throwing (PR 2 review).

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

/** The current holder, "missing" if the lock vanished meanwhile, or "unreadable" if it is corrupt. */
function readHolder(file: string): Holder | "missing" | "unreadable" {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw e;
  }
  try {
    const h = JSON.parse(raw) as Holder;
    return typeof h.pid === "number" && typeof h.started === "string" ? h : "unreadable";
  } catch {
    return "unreadable";
  }
}

export function acquireLock(file: string, now = Date.now()): LockResult {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, started: new Date(now).toISOString() });
  let replacedStale: string | null = null;
  // Three tries cover: the lock is free; it is held; it was released or found stale between our tries.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createExclusive(file, mine)) return { acquired: true, replacedStale };
    const holder = readHolder(file);
    if (holder === "missing") continue;
    if (holder !== "unreadable" && alive(holder.pid) && now - Date.parse(holder.started) < STALE_AFTER_MS) {
      return { acquired: false, holder };
    }
    replacedStale = holder === "unreadable" ? "an unreadable lock file" : `pid ${holder.pid} from ${holder.started}`;
    fs.rmSync(file, { force: true });
  }
  const holder = readHolder(file);
  if (holder !== "missing" && holder !== "unreadable") return { acquired: false, holder };
  throw new Error(`Could not take the lock ${file} after 3 tries`);
}

export function releaseLock(file: string): void {
  try {
    const holder = JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number };
    if (holder.pid === process.pid) fs.rmSync(file, { force: true });
  } catch { /* nothing to release */ }
}
