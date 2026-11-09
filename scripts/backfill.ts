// The two-year backfill (SPEC §5.9, §8.4): `tsx scripts/backfill.ts --commit SHA [--kev-commit SHA]
// --cutoff C [--fixtures] [--check-reference] [--catch-up | --credits] [--out DIR] [--push]` builds
// content/state/ from a CVE List clone and one KEV catalog, then the metrics for the edition. P2 WP5
// fills this stub and adds the command line (S0 contract).

import type { KevCatalog } from "../lib/feeds/types";
import type { GitSource } from "./lib/git-source";

export interface BackfillOptions {
  root: string;
  cutoff: string;
  commit: string | null;
  kevCommit: string | null;
  mode: "build" | "catch-up" | "credits";
  fixtures: boolean;
  checkReference: boolean;
  out: string;
  push: boolean;
}

export interface BackfillDeps {
  cloneUrl: string;
  git: GitSource;
  fetchKev(commit: string | null): Promise<{ catalog: KevCatalog; commit: string; sha256: string }>;
  /** Free bytes on the clone's file system (statfs); at least 10 GiB are needed. */
  freeBytes(dir: string): number;
  now(): Date;
  workers: number;
}

/** Exit code: 0 done, 1 failed or refused, 2 usage. */
export async function runBackfill(o: BackfillOptions, d?: Partial<BackfillDeps>): Promise<0 | 1 | 2> {
  throw new Error("not implemented: runBackfill");
}
