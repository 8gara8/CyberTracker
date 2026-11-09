// A git repo built from fixtures/cvelist-clone/ for tests/backfill.test.ts (fixtures plan §6.4): the 50
// records committed once with a fixed identity and a fixed author and committer date, so the commit SHA
// is the same on every machine and the commit passes the backfill's "cutoff day complete" guard for
// cutoffs up to 2026-11-06. The backfill fetches it as file://, so no test reaches the network.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const FIXTURE_CLONE_DIR = path.resolve(__dirname, "..", "..", "fixtures", "cvelist-clone");
/** The fixture commit's time: CVE List commit 67c39b1's (2026-11-07T17:28:47Z). */
export const FIXTURE_COMMIT_TIME = "2026-11-07T17:28:47Z";

/** Copies fixtures/cvelist-clone/ into `<tmp>/cvelist-src`, commits it on main and returns its file:// URL and SHA. */
export function makeCloneRepo(tmp: string): { url: string; sha: string; dir: string } {
  const dir = path.join(tmp, "cvelist-src");
  fs.cpSync(FIXTURE_CLONE_DIR, dir, { recursive: true });
  const env = {
    ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_DATE: FIXTURE_COMMIT_TIME, GIT_COMMITTER_DATE: FIXTURE_COMMIT_TIME,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=ct-test", "-c", "user.email=ct-test@example.invalid", ...args], { cwd: dir, env, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "--no-gpg-sign", "-m", "fixture clone");
  return { url: pathToFileURL(dir).href, sha: git("rev-parse", "HEAD"), dir };
}
