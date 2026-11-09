// The backfill's CVE List clone (SPEC §5.9 step 1, ruling R26): updated in place at one commit, then read
// with worker threads into CveFacts. P2 WP5 fills these stubs (S0 contract).

import type { CveFacts } from "../../lib/feeds/types";

/** Fetches `commit` (or the default branch tip) into `dir` and checks it out clean; reuses a clone already there. */
export async function ensureClone(dir: string, url: string, commit: string | null): Promise<{ commit: string; committedAt: string; seconds: number; bytes: number }> {
  throw new Error("not implemented: ensureClone");
}

/** Every cves/<year>/<Nxxx>/CVE-*.json in the clone as CveFacts, sorted by CVE id; the same for 1 or 4 workers. */
export async function readClone(dir: string, workers: number): Promise<{ facts: CveFacts[]; files: number; creditStrings: number }> {
  throw new Error("not implemented: readClone");
}
