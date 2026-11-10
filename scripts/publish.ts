// The only direct writer of content/ on main (SPEC §8.7): the data-only, full, withhold, status and state
// commits, pushPending() and dropPendingEditions(), and the CLI for the manual steps NEXT_STEP names.
// Owner: lane L2. Step S0 wrote the exports (plan §2.3): CONTENT_LAYOUT and COMMIT_RE are final, the
// functions are stubs that L2 replaces (L2 also adds the direct-run line).

import type { GatedDraft, SnapshotHashes, applyDraft } from "../lib/apply";
import type { LoadedConfig } from "../lib/config";
import type { composeDataOnly } from "../lib/data-only";
import { isValidDate } from "../lib/dates";
import type { CveLookup, RegionsBase } from "../lib/rules/types";
import type { FeedStale } from "../lib/schema/brief";
import type { AgentContext } from "../lib/schema/context";
import { STATE_FILES } from "../lib/schema/metrics";
import type { ArchiveIndex, Dispute, Evidence } from "../lib/schema/misc";
import type { Recheck, RunRecord } from "../lib/schema/status";
import type { AllOptions, AllResult } from "../lib/validate";
import type { RunOutcome } from "../lib/vocab";
import type { WithholdRequest, composeWithholds } from "../lib/withhold";
import type { Clock } from "./lib/clock";
import type { Git, Layout as GitLayout } from "./lib/git";

export type PublishCode = "wrong repository" | "too late" | "already published" | "validation" | "push" | "pending edition";

/** A code-only error: message === code; `codes` holds rule codes only (validation), never messages. */
export class PublishError extends Error {
  constructor(readonly code: PublishCode, readonly codes: readonly string[] = []) {
    super(code);
    this.name = "PublishError";
  }
}

/** Re-export of git.ts Layout: a repo-relative path → whether sync and commit accept it. */
export type Layout = GitLayout;

const DATE = "\\d{4}-\\d{2}-\\d{2}";
const DATED_RE = new RegExp(`^content/(?:briefs|metrics|metrics/inputs|status)/(${DATE})\\.json$`);
const FIXED: ReadonlySet<string> = new Set([
  ...STATE_FILES.map((f) => `content/state/${f}`),
  "content/scoreboard.json",
  "content/corrections.json",
  "content/archive-index.json",
]);

/**
 * §3 and §4.7: content/briefs/D.json, content/metrics/D.json, content/metrics/inputs/D.json,
 * content/status/D.json, content/state/{days,series,kev-index,ai-credits,credit-candidates,anthropic-cvd}.json,
 * content/scoreboard.json, content/corrections.json, content/archive-index.json. Nothing else.
 */
export const CONTENT_LAYOUT: Layout = (repoRelativePath: string): boolean => {
  if (FIXED.has(repoRelativePath)) return true;
  const m = DATED_RE.exec(repoRelativePath);
  return m !== null && isValidDate(m[1]!);
};

export type CommitArgs = {
  data_only: { date: string };
  /** "N items", "1 item" */
  full: { date: string; edition: "full" | "partial"; items: number };
  /** "withheld a, b" */
  withhold: { date: string; itemIds: readonly string[] };
  status_started: { date: string; runId: string };
  status_ended: { date: string; runId: string; outcome: RunOutcome };
  status_retry: { date: string; runId: string; outcome: RunOutcome; retryId: string };
  state: { cutoff: string; mode: "catch-up" | "backfill" };
};

/** §8.7's commit subjects: dates, counts, run ids, outcomes and item ids only, never model text. */
export function commitTitle<K extends keyof CommitArgs>(kind: K, args: CommitArgs[K]): string {
  const a = args as CommitArgs[keyof CommitArgs];
  const date = "date" in a ? a.date : a.cutoff;
  if (!isValidDate(date)) throw new Error(`commitTitle: not a valid date: ${JSON.stringify(date)}`);
  switch (kind) {
    case "data_only":
      return `brief: ${date} · data-only edition`;
    case "full": {
      const f = a as CommitArgs["full"];
      if (!Number.isInteger(f.items) || f.items < 0) throw new Error(`commitTitle: bad item count ${f.items}`);
      return `brief: ${date} · ${f.edition} edition, ${f.items} ${f.items === 1 ? "item" : "items"}`;
    }
    case "withhold": {
      const w = a as CommitArgs["withhold"];
      if (w.itemIds.length === 0) throw new Error("commitTitle: a withhold names at least one item");
      return `correction: ${date} · withheld ${w.itemIds.join(", ")}`;
    }
    case "status_started":
      return `status: ${date} · run ${(a as CommitArgs["status_started"]).runId} started`;
    case "status_ended": {
      const e = a as CommitArgs["status_ended"];
      return `status: ${date} · run ${e.runId} ended: ${e.outcome}`;
    }
    case "status_retry": {
      const r = a as CommitArgs["status_retry"];
      return `status: ${date} · run ${r.runId} ended: ${r.outcome}; retry ${r.retryId} started`;
    }
    case "state":
      return `state: ${date} · ${(a as CommitArgs["state"]).mode}`;
    default:
      throw new Error(`commitTitle: unknown kind ${String(kind)}`);
  }
}

/** Every commit subject publish makes (§8.7 test 6). */
export const COMMIT_RE = /^(brief|status|correction|state): \d{4}-\d{2}-\d{2} · /;

export interface PublishOptions {
  root: string;
  date: string;
  /** Epoch ms on `now`'s clock. Edition calls cap it at publishUntil = at(date, schedule.publish_until). */
  deadline: number;
  now: Clock;
  dryRun: boolean;
  /** Dry runs only: replace logs/dry-run/D/ with a fresh copy of contentDir() first (the run's first call). */
  freshCopy?: boolean;
  /** Deps.repo: an origin URL that counts as repos.repo (tests: the bare remote's path). */
  repo?: string;
  /** The config the run loaded at its start. */
  config: LoadedConfig;
  /** This run's records, oldest first; the last is the current one. Written onto status/D.json by run_id (replace in place, else append). */
  records: readonly RunRecord[];
  log?: (line: string) => void;
}

export interface PublishResult {
  /** null in a dry run */
  sha: string | null;
  /** taipeiTimestamp(now()) at compose time */
  publishedAt: string;
  /** The last record as written to status/D.json (edition, data_only_published_at or full_published_at, recheck correction ids filled). */
  record: RunRecord;
}

export interface PublishDeps {
  /** default lib/data-only.ts */
  composeDataOnly?: typeof composeDataOnly;
  /** default lib/apply.ts */
  applyDraft?: typeof applyDraft;
  /** default lib/withhold.ts */
  composeWithholds?: typeof composeWithholds;
  /** default validateAll */
  validateTree?: (dir: string, opts: AllOptions) => AllResult;
}

export function publishDataOnly(o: PublishOptions & {
  feedsStale: readonly FeedStale[];
  /** pack.generated_at */
  generatedAt: string;
}, deps?: PublishDeps): Promise<PublishResult> {
  throw new Error("P3 stub: publishDataOnly (lane L2)");
}

export function publishFull(o: PublishOptions & {
  force: boolean;
  edition: "full" | "partial";
  draft: GatedDraft;
  /** The in-memory copy. */
  context: AgentContext;
  evidence: Evidence;
  cveList: CveLookup;
  regionsBase: RegionsBase;
  /** §2.5 */
  snapshots: SnapshotHashes;
  feedsStale: readonly FeedStale[];
  /** Intake's updated list; null keeps the file's. */
  disputes: readonly Dispute[] | null;
  /** This run's flags (correction ids filled from the result). */
  recheck: Recheck | null;
}, deps?: PublishDeps): Promise<PublishResult> {
  throw new Error("P3 stub: publishFull (lane L2)");
}

export function publishWithholds(o: PublishOptions & {
  /** §2.4 */
  requests: readonly WithholdRequest[];
  /** Intake's updated list, committed with the withholds. */
  disputes: readonly Dispute[];
}, deps?: PublishDeps): Promise<PublishResult> {
  throw new Error("P3 stub: publishWithholds (lane L2)");
}

export type StatusEvent =
  | { kind: "started" }
  | { kind: "ended"; outcome: RunOutcome }
  /** records = [closed attempt 1, open attempt 2] */
  | { kind: "retry"; outcome: RunOutcome; retryId: string };

export function publishStatus(o: PublishOptions & {
  event: StatusEvent;
  /** Applied to archive-index.json in the same commit (the end record carries the link results). */
  updateArchive?: (ix: ArchiveIndex) => ArchiveIndex;
}): Promise<PublishResult> {
  throw new Error("P3 stub: publishStatus (lane L2)");
}

export function publishState(o: Omit<PublishOptions, "records"> & {
  mode: "catch-up" | "backfill"; stagedDir: string; cutoff: string;
}): Promise<{ sha: string | null; files: string[] }> {
  throw new Error("P3 stub: publishState (lane L2)");
}

/** Pushes local status and withhold commits GitHub lacks (after 11:00 too). A brief: among them: PublishError("pending edition"), nothing pushed. */
export function pushPending(g: Git): Promise<{ pushed: number }> {
  throw new Error("P3 stub: pushPending (lane L2)");
}

/** §8.7's table. `failed` lists the withhold item ids that failed validation (noted for the next intake). */
export function dropPendingEditions(g: Git, o: {
  root: string; config: LoadedConfig; now: Clock; repo?: string; log?: (line: string) => void;
}, deps?: PublishDeps): Promise<{ dropped: number; remade: number; failed: string[] }> {
  throw new Error("P3 stub: dropPendingEditions (lane L2)");
}

/** The CLI. deps.arch defaults to process.arch; exit 0 published, 1 refused or failed, 2 usage. */
export function main(argv: string[], deps?: { arch?: string; now?: Clock; repo?: string }): Promise<number> {
  throw new Error("P3 stub: main (publish, lane L2)");
}
