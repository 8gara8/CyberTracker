// Collect (SPEC §8.3) and `sources:check` (§8.10):
//   tsx scripts/collect.ts [--date YYYY-MM-DD] [--check-feeds [--id ID] [--json]]
// fetches the registry's feeds, writes packs/D.json, packs/D.md, the candidates files and cache/feeds/.
// P2 WP2 fills these stubs and adds the command line (S0 contract).

import type { FetchErrorClass, fetchFeed } from "../lib/feeds/http";
import type { CheckLabel } from "../lib/feeds/types";
import type { CandidatesFile, CollectInputsFile, FeedIndexFile, Pack } from "../lib/schema/pack";
import type { GitSource } from "./lib/git-source";

export interface CollectOptions {
  /** Taipei edition date. */
  date: string;
  /** Epoch ms; past it collect throws CollectTimeout and writes nothing. */
  deadline: number;
  /** Past-date dry runs (P3). */
  asOf?: boolean;
  /** A P3 caller allowing CT_FIXTURE_FEEDS outside tests (ruling R47). */
  fixtureOk?: boolean;
  root?: string;
  deps?: Partial<{ fetch: typeof fetchFeed; git: GitSource; now: () => number; log: (line: string) => void }>;
}

export interface CollectResult {
  pack: Pack;
  candidates: CandidatesFile;
  index: FeedIndexFile;
  inputs: CollectInputsFile;
  /** The stdout lines (§8.3). */
  summary: string[];
}

/** Thrown when the deadline passes; nothing is written after it. */
export class CollectTimeout extends Error {
  constructor(message = "collect passed its deadline") {
    super(message);
    this.name = "CollectTimeout";
  }
}

/** One row of §8.10's table: id, kind, status, items, newest, fresh, priority, error. */
export interface CheckRow {
  id: string;
  kind: string;
  status: CheckLabel;
  items: number;
  newest: string | null;
  /** "yes", "no (N d)" or "-". */
  fresh: string;
  priority: 1 | 2 | 3;
  /** The error class, never raw text. */
  error: FetchErrorClass | null;
}

/** §8.3's run. Throws CollectTimeout past the deadline, writing nothing then. */
export async function collect(o: CollectOptions): Promise<CollectResult> {
  throw new Error("not implemented: collect");
}

/** §8.10: every fetched registry entry (or `id`), no pack written; exit 1 when a priority-1 row is FAIL, NODATE or STALE. */
export async function checkFeeds(o: { id?: string; now?: number; root?: string; deps?: CollectOptions["deps"] }): Promise<{ rows: CheckRow[]; exitCode: 0 | 1 }> {
  throw new Error("not implemented: checkFeeds");
}
