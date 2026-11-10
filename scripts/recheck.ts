// The re-check (SPEC §8.9): dispute intake from this repo's correction issue form, the 14-day flags, and the
// post-publish link check (§8.11); `npm run recheck` and `npm run links`. Intake only reads GitHub, never
// writes to it. Everything read from issues and pages is data. Owner: lane L5. Step S0 wrote the exports
// (plan §2.6): MAX_WITHHOLDS and LINKS_LIMITS are final, the functions are stubs that L5 replaces (L5
// also adds the direct-run line).

import type { LoadedConfig } from "../lib/config";
import type { fetchFeed } from "../lib/feeds/http";
import type { AgentContext } from "../lib/schema/context";
import type { ArchiveIndex, Dispute } from "../lib/schema/misc";
import type { LinkCheck, Recheck } from "../lib/schema/status";
import type { DisputeKind } from "../lib/vocab";
import type { WithholdRequest } from "../lib/withhold";
import type { Clock } from "./lib/clock";

export interface DisputeForm {
  item_id: string;
  edition_date: string | null;
  kind: DisputeKind;
  evidence_url: string | null;
}

/** The four ### blocks of .github/ISSUE_TEMPLATE/correction.yml only; null when not parseable. briefs(): dates holding the id. */
export function parseDisputeForm(body: string, briefs: (itemId: string) => readonly string[]): DisputeForm | null {
  throw new Error("P3 stub: parseDisputeForm (lane L5)");
}

/** At most this many new victim or attribution disputes are withheld in one run (§8.9); the rest wait. */
export const MAX_WITHHOLDS = 10;

export interface IntakeResult {
  /** false: "Dispute intake unavailable today." */
  ok: boolean;
  /** The full updated list (corrections.json "disputes"). */
  disputes: Dispute[];
  /** ≤ 10 new victim or attribution disputes. */
  withhold: WithholdRequest[];
  waiting: number;
  reports: AgentContext["corrections"]["reports"];
  /** Issue numbers logged "issue #N: form not parseable". */
  ignored: number[];
}

/**
 * GET https://api.github.com/repos/<repos.repo>/issues?state=all&labels=correction&since=<S>&per_page=100[&page=N]
 * through fetchImpl (10 s each, ≤ 3 pages, run.json user_agent, no token). S = the newest dispute's
 * received as UTC "YYYY-MM-DDTHH:MM:SSZ", else `${addDays(D, −30)}T00:00:00Z`. Never writes to GitHub.
 */
export function intakeDisputes(o: {
  root: string; date: string; contentDir: string; config: LoadedConfig; now: Clock; fetchImpl: typeof fetch;
  log?: (line: string) => void;
}): Promise<IntakeResult> {
  throw new Error("P3 stub: intakeDisputes (lane L5)");
}

export interface RecheckResult {
  /** RunRecord.recheck, every flag (suppressed ones too), correction_id null. */
  record: Recheck;
  /** After suppression, for the context. */
  shown: AgentContext["corrections"]["flagged"];
  skipped: ("kev" | "cvelist")[];
}

export function recheckItems(o: {
  root: string; date: string; contentDir: string; config: LoadedConfig;
  /** From this morning's collect. */
  feedsOk: { kev: boolean; cvelist: boolean };
  /** Date.now() ms (realDeadline) */
  deadline: number;
  fetch?: typeof fetchFeed; log?: (line: string) => void;
}): Promise<RecheckResult> {
  throw new Error("P3 stub: recheckItems (lane L5)");
}

/** §8.11: at most 300 URLs, 8 at a time, a 3-minute round, not started with under 6 minutes left. */
export const LINKS_LIMITS = { maxUrls: 300, concurrency: 8, roundMs: 3 * 60_000, minLeftMs: 6 * 60_000 } as const;

export interface LinkResult {
  url: string;
  result: "ok" | "unknown" | "broken" | "changed";
  http: number | null;
  /** Set when a tier 1 page with a null stored hash was hashed. */
  sha256: string | null;
  hashed_at: string | null;
}

export interface LinksOutcome {
  record: LinkCheck;
  results: LinkResult[];
  notReached: number;
}

/** §8.11. Stops at min(now + 3 min, endLimit − 6 min) on the run's clock; fetches use realDeadline(). */
export function checkLinks(o: {
  root: string; date: string; contentDir: string; config: LoadedConfig; now: Clock; endLimit: number;
  fetch?: typeof fetchFeed; log?: (line: string) => void;
}): Promise<LinksOutcome> {
  throw new Error("P3 stub: checkLinks (lane L5)");
}

/** urls[url].last_check = { date, result, http }; a stored null hash gets sha256 and hashed_at. Nothing else changes. */
export function applyLinkResults(ix: ArchiveIndex, date: string, results: readonly LinkResult[]): ArchiveIndex {
  throw new Error("P3 stub: applyLinkResults (lane L5)");
}

/** logs/D.recheck.json: intake and flags (§8.9). */
export function writeRecheckLog(root: string, date: string, x: {
  intake: IntakeResult | null; flagged: Recheck | null; reports: AgentContext["corrections"]["reports"];
}): void {
  throw new Error("P3 stub: writeRecheckLog (lane L5)");
}

/** `--intake`, `--flags`, `--links`, `--dry-run`, `--json`. */
export function main(argv: string[], deps?: { now?: Clock; fetchImpl?: typeof fetch }): Promise<number> {
  throw new Error("P3 stub: main (recheck, lane L5)");
}
