import fs from "node:fs";
import path from "node:path";

// One run at a time. The lock file holds {pid, started}; a lock whose process is gone, or that is older
// than two hours, is stale and is replaced (SPEC §8.2).

export const STALE_AFTER_MS = 2 * 3_600_000;

export type LockResult =
  | { acquired: true; replacedStale: string | null }
  | { acquired: false; holder: { pid: number; started: string } };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireLock(file: string, now = Date.now()): LockResult {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let replacedStale: string | null = null;
  if (fs.existsSync(file)) {
    let holder: { pid: number; started: string } | null = null;
    try {
      holder = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { /* unreadable: treat as stale */ }
    const fresh = holder && alive(holder.pid) && now - Date.parse(holder.started) < STALE_AFTER_MS;
    if (holder && fresh) return { acquired: false, holder };
    replacedStale = holder ? `pid ${holder.pid} from ${holder.started}` : "an unreadable lock file";
    fs.rmSync(file, { force: true });
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started: new Date(now).toISOString() }), { flag: "wx" });
  return { acquired: true, replacedStale };
}

export function releaseLock(file: string): void {
  try {
    const holder = JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number };
    if (holder.pid === process.pid) fs.rmSync(file, { force: true });
  } catch { /* nothing to release */ }
}
