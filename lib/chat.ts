// The chat edition (SPEC §8.8): `logs/D.summary.md`, the scheduled task's reply, rendered by script from
// the brief as committed and the run records, so it matches the site. Europe's renderSummary() skeleton
// carries over; its board body is replaced. No tables, no emoji, at most 15 lines, and every link points
// at siteUrl(), never a source. Also here: NEXT_STEP and WHAT_HAPPENED (§8.2's error-code table), the
// stage-note sentences scripts/lib/status.ts writes and chatInputFor() reads back, and chatInputFor(),
// which daily.ts (at finish) and scripts/chat.ts both call. Pure apart from the run.json import.

import run from "../config/run.json";
import { dayMonth, taipeiTime } from "./format";
import { fmt2 } from "./metrics/stats";
import type { Brief, RegionRow } from "./schema/brief";
import type { Edition } from "./schema/common";
import type { Item } from "./schema/item";
import type { Metrics } from "./schema/metrics";
import type { RunRecord, RunStage } from "./schema/status";
import { SITE_NAME, siteUrl as configuredSiteUrl } from "./site";
import { splitSentences } from "./text";
import { defang } from "./urls";
import {
  AI_ROLE_INFO, CANARY_TOKEN, IOC_TLDS, PARTIAL_FEED_IDS, REGION_CHANGE, REGION_LEVEL_INFO, SEVERITY_INFO, TAIWAN_NO_NEWS,
  WITHHELD_HEADLINE,
} from "./vocab";

export const CHAT_MAX_LINES = 15;

// ── Error codes, next steps and what happened (§8.2) ─────────────────────────────────────────────

/** Every run error code of §8.2's table, in its order. */
export const ERROR_CODES = [
  "E_ARCH", "E_NODE", "E_CONFIG", "E_NET", "E_GIT", "E_CLOCK", "E_CLI", "E_AUTH", "E_PUSH", "E_METRICS", "E_DATA_ONLY", "E_SANDBOX", "E_LIMIT",
  "E_AGENT", "E_TIMEOUT", "E_VALIDATION", "E_PUBLISH", "E_TOO_LATE", "E_SIMULATED", "E_INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The run.json schedule times the texts name. */
export interface ChatSchedule { hard_stop: string; publish_until: string }
const SCHEDULE: ChatSchedule = run.schedule;

/** The checkout NEXT_STEP names: a code default, as §0.2 allows. */
export const CHECKOUT = "/Users/kobol/Projects/CyberTracker";

function minutesOf(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Invalid time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function clockOf(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * The latest sensible start for a manual rerun: an hour before publish_until (11:00 gives 10:00). A
 * --no-deadline run may last 75 minutes but is cut at publish_until (§8.2), so this leaves it about 50.
 */
export const RERUN_BEFORE = clockOf(minutesOf(SCHEDULE.publish_until) - 60);
const RERUN = `rerun before ${RERUN_BEFORE}: zsh ${CHECKOUT}/scripts/daily.sh --no-deadline`;

/**
 * One line per code, from §8.2's table ("<rerun>" written out in full). `{date}` stands for the edition
 * date: use nextStepFor(), which fills it and gives unknown codes E_INTERNAL's line.
 */
export const NEXT_STEP: Readonly<Record<ErrorCode, string>> = {
  E_ARCH: `the run isn't native arm64 Node 22 or newer; check scripts/daily.sh's PATH and /opt/homebrew/bin/node (SPEC Appendix C), then ${RERUN}`,
  E_NODE: `the run isn't native arm64 Node 22 or newer; check scripts/daily.sh's PATH and /opt/homebrew/bin/node (SPEC Appendix C), then ${RERUN}`,
  E_CONFIG: `config/ on main fails its checks; fix it in a PR, then ${RERUN}`,
  E_NET: `Kobol had no network; ${RERUN}`,
  E_GIT: `the checkout can't be synced with GitHub; see docs/RUNBOOK.md, then ${RERUN}`,
  E_CLOCK: "run this date after 08:00 Taipei on the day before",
  E_CLI: `the agent CLI is missing; reinstall it (SPEC §9.4), then ${RERUN}`,
  E_AUTH: `the agent's sign-in token is missing or expired; JL renews it (SPEC §9.6), then ${RERUN}`,
  E_PUSH: `the run can't push to GitHub; check gh's login on Kobol (SPEC §9.6), then ${RERUN}`,
  E_METRICS: `read logs/{date}.metrics.log; fix in a PR, then ${RERUN}`,
  E_DATA_ONLY: `read logs/{date}.daily.log, then ${RERUN}`,
  E_SANDBOX: "the agent's sandbox is wrong; run npm run agent:check -- --sandbox and fix SPEC §9.5's settings before the next run",
  E_LIMIT: "the account's usage limit stopped the agent; the data-only edition stands; runs resume when the limit window resets",
  E_AGENT: RERUN,
  E_TIMEOUT: RERUN,
  E_VALIDATION: `${RERUN}; the draft is in needs-review/{date}/`,
  E_PUBLISH: `the draft is valid: in ${CHECKOUT} run PATH=/opt/homebrew/bin:$PATH npm run publish -- --date {date} before ${SCHEDULE.publish_until}`,
  E_TOO_LATE: `nothing: nothing is published after ${SCHEDULE.publish_until}; the next morning's run will publish`,
  E_SIMULATED: "nothing: this was a test of the failure path",
  E_INTERNAL: `read logs/{date}.daily.log, then ${RERUN}`,
};

function isErrorCode(code: string): code is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(code);
}

/** NEXT_STEP[code] with every `{date}` replaced; an unknown code gets E_INTERNAL's line. */
export function nextStepFor(code: string, date: string): string {
  return NEXT_STEP[isErrorCode(code) ? code : "E_INTERNAL"].replaceAll("{date}", date);
}

/** What WHAT_HAPPENED's templates are filled from: the run records (chatInputFor() builds it). */
export interface WhatFacts {
  date: string;
  /** Validation errors left: the issues given, else the last record's validation.errors. */
  errors: number;
  /** Repair rounds across the run's records. */
  repairs: number;
  /** Agent attempts: records whose draft stage ran. */
  attempts: number;
  /** The last record's agent time in whole minutes, null when the agent never ran. */
  agentMinutes: number | null;
  /** run.json schedule.hard_stop and publish_until, "HH:MM". */
  hardStop: string;
  publishUntil: string;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The per-code "What happened" sentence (§8.8); scripts/lib/status.ts takes its texts from here too. */
export const WHAT_HAPPENED: Readonly<Record<ErrorCode, (f: WhatFacts) => string>> = {
  E_ARCH: () => "The run was not on native arm64 Node, so it stopped in preflight.",
  E_NODE: () => "The run's Node was older than 22, so it stopped in preflight.",
  E_CONFIG: () => "The files in config/ failed their checks, so the run stopped in preflight.",
  E_NET: () => "GitHub did not answer within 10 seconds, so the run stopped in preflight.",
  E_GIT: () => "The checkout could not be synced with GitHub, so the run stopped in preflight.",
  E_CLOCK: (f) => `The cutoff day for ${f.date} is not complete yet, so nothing was computed.`,
  E_CLI: () => "The agent CLI was missing or did not start, so no editorial pass ran.",
  E_AUTH: () => "The agent's sign-in token was missing or expired, so no editorial pass ran.",
  E_PUSH: () => "The start record could not be pushed to GitHub, so nothing else was tried.",
  E_METRICS: () => "No metrics file was written, so nothing could be published.",
  E_DATA_ONLY: () => "The data-only edition could not be composed, validated or pushed, and no full edition followed.",
  E_SANDBOX: () => "The agent started with tools beyond its sandbox and was stopped.",
  E_LIMIT: () => "The account's usage limit stopped the agent before it wrote a valid draft.",
  E_AGENT: (f) => `The agent wrote no draft in ${count(f.attempts, "attempt")}.`,
  E_TIMEOUT: (f) => f.agentMinutes
    ? `The agent timed out after ${count(f.agentMinutes, "minute")} without writing a draft.`
    : `The run had too little time left for an editorial pass before ${f.hardStop}.`,
  E_VALIDATION: (f) => `The draft still had ${count(f.errors, "validation error")} after ${count(f.repairs, "repair")} and ${count(f.attempts, "attempt")}.`,
  E_PUBLISH: () => "The draft was valid, but the full edition failed whole-tree validation or its push.",
  E_TOO_LATE: (f) => `The full edition was not published: nothing is published after ${f.publishUntil}.`,
  E_SIMULATED: () => "A simulated failure (--simulate-failure) stopped the run after a valid draft.",
  E_INTERNAL: () => "The run hit an unexpected error; the stack is in the run log.",
};

/** WHAT_HAPPENED[code](facts); an unknown code gets E_INTERNAL's sentence. */
export function whatHappened(code: string, facts: WhatFacts): string {
  return WHAT_HAPPENED[isErrorCode(code) ? code : "E_INTERNAL"](facts);
}

// ── Stage notes and chat notes ───────────────────────────────────────────────────────────────────

/**
 * Stage-note sentences that scripts/lib/status.ts writes into RunRecord.stages[].note (several may share
 * one note, joined by a space) and chatInputFor() reads back, so `npm run chat` rebuilds the chat edition
 * from the status file alone. Times are "HH:MM" Taipei.
 */
export const STAGE_NOTES = {
  /** draft, validate, publish: skipped with --data-only (§8.2). */
  dataOnlyRequested: "Data-only run requested (--data-only).",
  /** draft, validate, publish: skipped after the hard stop (§8.2 clock rules). */
  startedAfterHardStop: (hhmm: string) => `Started after ${hhmm}: no editorial pass today.`,
  /** preflight: a skip at step 6 (§8.2). */
  alreadyPublished: (hhmm: string) => `The full edition was already published at ${hhmm}.`,
  tooLate: (hhmm: string) => `Too late: nothing is published after ${hhmm}.`,
  /** publish: a --force run that replaced an edition. */
  replaced: (hhmm: string) => `Replaced the ${hhmm} edition (--force).`,
  /** metrics: §8.4's stdout line. */
  floodStops: (date: string) => `Flood counts stop at ${date}: run npm run backfill -- --catch-up --push.`,
  /** preflight step 5. */
  depsChanged: "Dependencies changed since the last npm ci.",
} as const;

const NOTE_RES = {
  dataOnlyRequested: /Data-only run requested \(--data-only\)\./,
  startedAfterHardStop: /Started after \d\d:\d\d: no editorial pass today\./,
  alreadyPublished: /The full edition was already published at \d\d:\d\d\./,
  tooLate: /Too late: nothing is published after \d\d:\d\d\./,
  replaced: /Replaced the (\d\d:\d\d) edition \(--force\)/i,
  floodStops: /Flood counts stop at (\d{4}-\d{2}-\d{2})/,
  depsChanged: /Dependencies changed since the last npm ci/,
} as const;

/** The Notes line's entries (§8.8), each in the spec's words. */
export const CHAT_NOTES = {
  dropped: (n: number) => `${count(n, "item")} dropped (unverified)`,
  feedsStale: (ids: readonly string[]) => `feeds stale: ${ids.join(", ")}`,
  floodStops: (date: string) => `Flood counts stop at ${date}: run npm run backfill -- --catch-up --push`,
  links: (broken: number, changed: number) => `links: ${broken} broken, ${changed} changed`,
  siteNotShowing: "site not yet showing this edition",
  usage: (pct: number, window: string) => `usage ${pct}% of ${window} limit`,
  statusNotSaved: "status not saved",
  replaced: (hhmm: string) => `replaced the ${hhmm} edition (--force)`,
  depsChanged: "Dependencies changed since the last npm ci",
} as const;

/** The Notes line's order (§8.8); a note matching none goes last. */
const NOTE_ORDER: readonly RegExp[] = [
  /^\d+ items? dropped \(unverified\)$/, /^feeds stale: /, /^Flood counts stop at /, /^links: /, /^site not yet showing/,
  /^usage \d+% of /, /^status not saved$/, /^replaced the \d\d:\d\d edition/, /^Dependencies changed/,
];

/** Notes deduplicated and put in §8.8's order (stable for notes of the same kind). */
export function orderNotes(notes: readonly string[]): string[] {
  const rank = (n: string) => {
    const i = NOTE_ORDER.findIndex((re) => re.test(n));
    return i < 0 ? NOTE_ORDER.length : i;
  };
  return [...new Set(notes.map(oneLine).filter(Boolean))]
    .map((note, i) => ({ note, i, r: rank(note) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.note);
}

/** The rate-limit window's name as the usage note says it: seven_day windows are "weekly". */
function windowWord(window: string): string {
  if (/seven_day|weekly/i.test(window)) return "weekly";
  if (/five_hour/i.test(window)) return "5-hour";
  return window.replace(/_/g, " ");
}

// ── Chat input ───────────────────────────────────────────────────────────────────────────────────

export type ChatInput =
  | { kind: "published"; brief: Brief; runs: RunRecord[]; notes: string[]; dryRun: boolean }
  | { kind: "data_only"; brief: Brief; runs: RunRecord[]; code: string | null; what: string;
      nextStep: string | null; notes: string[]; dryRun: boolean;
      /** KEV entries new since the last edition (the brief holds at most 10, §4.5); null: the item count. */
      kevNew?: number | null }
  | { kind: "failed"; date: string; code: string; what: string; errors: { code: string; path: string }[];
      siteShows: { date: string; edition: Edition } | null; nextStep: string; runs: RunRecord[];
      needsReview: boolean; notes: string[]; dryRun: boolean }
  | { kind: "skipped"; date: string; reason: string; briefUrl: string | null; dryRun: boolean };

/** What chatInputFor() builds a ChatInput from. */
export interface ChatSource {
  /** The edition date D. */
  date: string;
  /** briefs/D.json as committed (in a dry run, the copy's), or null when none exists. */
  brief: Brief | null;
  /** This run's records and the retry's, oldest first (lastRunRecords() picks them from a status file). */
  runs: readonly RunRecord[];
  /** Notes only the caller knows, such as CHAT_NOTES.statusNotSaved; merged into §8.8's order. */
  notes?: readonly string[];
  /** A failed run's validator issues: only each code and path is kept, never a message. */
  issues?: readonly { code: string; path: string; severity?: "error" | "warning"; message?: string }[] | null;
  /** The newest brief on GitHub's main, for the failed format's "Site shows" line. */
  siteShows?: { date: string; edition: Edition } | null;
  /**
   * metrics/D.json, for the data-only KEV count: the brief holds at most 10 new-KEV items (§4.5), so the
   * count is `kev.new_since_last_edition.cve_ids`'s length. Ignored when its date is not D or `kev` is null.
   */
  metrics?: Pick<Metrics, "date" | "kev"> | null;
  /** Default: a failed run that is not a dry run (finish copies its files to needs-review/D/). */
  needsReview?: boolean;
  /** The code of a failure that left no record (preflight steps 1 to 5). */
  code?: string | null;
  /** A dry run, for a failure that left no record; otherwise the records say so. */
  dryRun?: boolean;
  /** Default siteUrl() (config/run.json). */
  siteUrl?: string;
  /** Default config/run.json schedule. */
  schedule?: ChatSchedule;
}

const RUN_STARTS: ReadonlySet<string> = new Set(["schedule", "manual", "dry_run"]);
const PARTIAL_FEEDS: ReadonlySet<string> = new Set(PARTIAL_FEED_IDS);

/**
 * The last run's records in a status file (§8.8): the last `schedule`, `manual` or `dry_run` record and
 * every `retry` record after it. With no such record, every record.
 */
export function lastRunRecords(runs: readonly RunRecord[]): RunRecord[] {
  let start = -1;
  runs.forEach((r, i) => {
    if (RUN_STARTS.has(r.trigger)) start = i;
  });
  if (start < 0) return [...runs];
  return [runs[start]!, ...runs.slice(start + 1).filter((r) => r.trigger === "retry")];
}

function stage(r: RunRecord, id: RunStage) {
  return r.stages.find((s) => s.id === id) ?? null;
}

/** Agent attempts (records whose draft stage ran) and repair rounds (summed over the records). */
export function runCounts(runs: readonly RunRecord[]): { attempts: number; repairs: number } {
  return {
    attempts: runs.filter((r) => (stage(r, "draft")?.status ?? "skipped") !== "skipped").length,
    repairs: runs.reduce((n, r) => n + r.budgets.repair_rounds, 0),
  };
}

/** Attempt 1's start to the last record's end (its latest stage end, else its start, while unfinished). */
export function runSpan(runs: readonly RunRecord[]): { start: string; end: string } | null {
  const first = runs[0];
  const last = runs.at(-1);
  if (!first || !last) return null;
  const ends = last.stages.map((s) => s.ended_at).filter((t): t is string => t !== null).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { start: first.started_at, end: last.finished_at ?? ends.at(-1) ?? last.started_at };
}

function allStageNotes(runs: readonly RunRecord[]): string {
  return runs.flatMap((r) => r.stages.map((s) => s.note ?? "")).filter(Boolean).join(" ");
}

/** The notes rebuilt from the records and the brief (§8.8), before the caller's own. */
function rebuiltNotes(date: string, brief: Brief | null, runs: readonly RunRecord[], kind: ChatInput["kind"], dryRun: boolean): string[] {
  const out: string[] = [];
  const last = runs.at(-1) ?? null;
  const notes = allStageNotes(runs);

  const dropped = runs.reduce((n, r) => n + (r.soft_gates?.dropped ?? 0), 0);
  if (dropped > 0) out.push(CHAT_NOTES.dropped(dropped));

  // Without a brief, the first record's feeds (the attempt that collected; a retry reuses its pack),
  // limited as feeds_stale is to the five structured feeds: RSS failures stay in the status file (§8.3).
  const stale = brief && kind !== "failed"
    ? brief.feeds_stale.map((f) => f.id)
    : (runs[0]?.feeds ?? []).filter((f) => PARTIAL_FEEDS.has(f.id) && (f.status === "stale" || f.status === "failed")).map((f) => f.id);
  if (stale.length) out.push(CHAT_NOTES.feedsStale(stale));

  const flood = NOTE_RES.floodStops.exec(notes);
  if (flood) out.push(CHAT_NOTES.floodStops(flood[1]!));

  const links = [...runs].reverse().find((r) => r.links !== null)?.links ?? null;
  if (links) {
    const broken = links.broken.filter((b) => b.result === "broken").length;
    const changed = links.broken.filter((b) => b.result === "changed").length;
    if (broken || changed) out.push(CHAT_NOTES.links(broken, changed));
  }

  if (!dryRun && last && brief && (kind === "published" || kind === "data_only")
    && (last.deploy.shows_date !== date || last.deploy.shows_edition !== brief.edition)) {
    out.push(CHAT_NOTES.siteNotShowing);
  }

  const usage = [...runs].reverse().find((r) => r.budgets.usage !== null)?.budgets.usage ?? null;
  if (usage && usage.utilization >= 0.8) out.push(CHAT_NOTES.usage(Math.round(usage.utilization * 100), windowWord(usage.window)));

  const replaced = NOTE_RES.replaced.exec(notes);
  if (replaced) out.push(CHAT_NOTES.replaced(replaced[1]!));

  if (NOTE_RES.depsChanged.test(notes)) out.push(CHAT_NOTES.depsChanged);
  return out;
}

// formatPath()'s forms: "(root)", "(file)", "(run)", or keys (`[A-Za-z_][A-Za-z0-9_]*`, never a dot or a
// hyphen inside one) and `[n]` indices joined by dots; at most one "<file>.json: " prefix.
const PATH_KEY = "[A-Za-z_][A-Za-z0-9_]*(?:\\[\\d+\\])*";
const SAFE_PATH_RE = new RegExp(
  `^(?:[a-z0-9_-]+(?:/[a-z0-9_-]+)*\\.json: )?(?:\\((?:root|file|run)\\)|(?:${PATH_KEY}|(?:\\[\\d+\\])+)(?:\\.${PATH_KEY})*)$`);
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * An issue path as the chat edition may show it: schema keys and `[n]` indices joined by dots (with at
 * most one "<file>.json: " prefix), at most 100 characters and free of the canary; anything else, such
 * as an unknown key the draft invented with a dot, hyphen or space in it (`login-update.example.com`,
 * `45.33.32.156`), becomes "(path not shown)". The last step still defangs a path of plain keys that
 * reads as a domain (`items[0].evil.com`).
 */
export function safePath(path: string): string {
  const p = path.trim();
  return p.length <= 100 && SAFE_PATH_RE.test(p) && !p.includes(CANARY_TOKEN) ? p : "(path not shown)";
}

/**
 * Builds the ChatInput (§8.8) from the brief as committed, the run records, the caller's notes and, for a
 * failed run, the validator's issues (code and path only). The format follows the last record: `skipped`;
 * an edition this run left published (`published_full`, `published_partial`: published;
 * `published_data_only`: data-only; a dry run: the record's `edition`, what the copy shows); else failed.
 */
export function chatInputFor(src: ChatSource): ChatInput {
  const { date } = src;
  const runs = [...src.runs];
  const last = runs.at(-1) ?? null;
  const schedule = src.schedule ?? SCHEDULE;
  const site = (src.siteUrl ?? configuredSiteUrl()).replace(/\/+$/, "");
  const brief = src.brief && src.brief.date === date ? src.brief : null;
  const dryRun = src.dryRun === true || runs.some((r) => r.trigger === "dry_run" || r.outcome === "dry_run");
  const notes = allStageNotes(runs);

  // Skipped: the outcome says so; a dry run that stopped at preflight step 6 carries the reason as a note.
  const skipNote = NOTE_RES.alreadyPublished.exec(notes) ?? NOTE_RES.tooLate.exec(notes);
  if (last?.outcome === "skipped" || (dryRun && skipNote)) {
    let reason = skipNote?.[0] ?? null;
    if (!reason) {
      reason = last && taipeiTime(last.started_at) > schedule.publish_until
        ? STAGE_NOTES.tooLate(schedule.publish_until)
        : STAGE_NOTES.alreadyPublished(brief ? taipeiTime(brief.published_at) : taipeiTime(last!.started_at));
    }
    return { kind: "skipped", date, reason, briefUrl: brief ? `${site}/brief/${date}` : null, dryRun };
  }

  const code = [...runs].reverse().find((r) => r.error_code !== null)?.error_code ?? src.code ?? null;
  const { attempts, repairs } = runCounts(runs);
  const errorIssues = (src.issues ?? []).filter((i) => i.severity !== "warning");
  const agentSeconds = last?.budgets.agent_seconds ?? 0;
  const facts: WhatFacts = {
    date,
    errors: src.issues ? errorIssues.length : (last?.validation?.errors ?? 0),
    repairs,
    attempts,
    agentMinutes: agentSeconds > 0 ? Math.max(1, Math.round(agentSeconds / 60)) : null,
    hardStop: schedule.hard_stop,
    publishUntil: schedule.publish_until,
  };

  let left: Edition | null = null;
  if (last && dryRun) left = last.edition;
  else if (last?.outcome === "published_full" || last?.outcome === "published_partial") left = brief?.edition ?? last.edition;
  else if (last?.outcome === "published_data_only") left = brief?.edition ?? "data_only";

  if (brief && (left === "full" || left === "partial")) {
    return { kind: "published", brief, runs, notes: orderNotes([...rebuiltNotes(date, brief, runs, "published", dryRun), ...(src.notes ?? [])]), dryRun };
  }
  if (brief && left === "data_only") {
    let what: string;
    if (code) what = whatHappened(code, facts);
    else {
      const noted = NOTE_RES.dataOnlyRequested.exec(notes) ?? NOTE_RES.startedAfterHardStop.exec(notes);
      what = noted?.[0]
        ?? (last && taipeiTime(last.started_at) > schedule.hard_stop ? STAGE_NOTES.startedAfterHardStop(schedule.hard_stop) : STAGE_NOTES.dataOnlyRequested);
    }
    const kev = src.metrics?.date === date ? src.metrics.kev : null;
    return {
      kind: "data_only", brief, runs, code, what, nextStep: code ? nextStepFor(code, date) : null,
      notes: orderNotes([...rebuiltNotes(date, brief, runs, "data_only", dryRun), ...(src.notes ?? [])]), dryRun,
      kevNew: kev ? kev.new_since_last_edition.cve_ids.length : null,
    };
  }

  const failCode = code ?? "E_INTERNAL";
  const unfinished = last !== null && last.outcome === null && code === null;
  let errors: { code: string; path: string }[];
  if (src.issues) errors = errorIssues.map((i) => ({ code: SAFE_CODE_RE.test(i.code) ? i.code : "UNKNOWN", path: safePath(i.path) }));
  else if (failCode === "E_SIMULATED") errors = [{ code: "SIMULATED", path: "(run)" }];
  else if (failCode === "E_VALIDATION") errors = (last?.validation?.codes ?? []).map((c) => ({ code: c, path: "" }));
  else errors = [];
  return {
    kind: "failed",
    date,
    code: failCode,
    what: unfinished ? "The run left no end record; it may have been stopped before it finished." : whatHappened(failCode, facts),
    errors,
    siteShows: src.siteShows ?? null,
    nextStep: nextStepFor(failCode, date),
    runs,
    needsReview: src.needsReview ?? !dryRun,
    notes: orderNotes([...rebuiltNotes(date, brief, runs, "failed", dryRun), ...(src.notes ?? [])]),
    dryRun,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────

/** Collapses every run of whitespace (newlines included) to one space, so no field adds a line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const EDITION_WORD: Record<Edition, string> = { full: "full", partial: "partial", data_only: "data-only" };
const CORRECTION_WORD = { correction: "correction", clarification: "clarification", update: "update", name_removed: "name withheld" } as const;

/** The item kicker (§8.8): severity pips and word (LANDMARK for a landmark), the AI chip, the region codes. */
export function kicker(item: Pick<Item, "severity" | "landmark" | "ai_role" | "ai_confidence" | "regions">): string {
  const parts: string[] = [];
  if (item.severity) parts.push(`${SEVERITY_INFO[item.severity].pips} ${SEVERITY_INFO[item.severity].word}`);
  else if (item.landmark) parts.push("LANDMARK");
  const chip = AI_ROLE_INFO[item.ai_role].chip;
  if (chip) parts.push(item.ai_confidence === "claimed" ? `${chip} (claimed)` : chip);
  parts.push(item.regions.join(" "));
  return parts.join(" · ");
}

/** The Gap line and second line (§8.8): ok, stale (dated) or missing (no second line). */
export function gapLines(brief: Pick<Brief, "gap">): string[] {
  const g = brief.gap;
  if (g.status === "missing") return ["Gap figures are not available today."];
  const head = g.status === "stale"
    ? `(Data to ${g.as_of ? dayMonth(g.as_of) : "an earlier day"} UTC; today's figures are not available.) ${oneLine(g.headline)}`
    : oneLine(g.headline);
  return [head, oneLine(g.second_line)].filter(Boolean);
}

function regionRow(r: RegionRow): string {
  const info = REGION_LEVEL_INFO[r.level];
  const change = REGION_CHANGE[r.change];
  return `${r.code} ${info.pips} ${info.word}${change ? ` ${change}` : ""}${r.raised ? " (raised)" : ""}`;
}

/** "Regions: US ●●○○ ELEVATED ↑ · EU … · TW … · JP … · GLOBAL <n>". */
export function regionsLine(brief: Pick<Brief, "regions">): string {
  return `Regions: ${[...brief.regions.rows.map(regionRow), `GLOBAL ${brief.regions.global.item_count}`].join(" · ")}`;
}

/** The chat edition's Taiwan line in a full or partial edition: the analysis's first sentence. */
export function taiwanLine(brief: Pick<Brief, "taiwan_lens">): string {
  const first = splitSentences(oneLine(brief.taiwan_lens.analysis))[0];
  return `Taiwan: ${first || TAIWAN_NO_NEWS}`;
}

function runLine(runs: readonly RunRecord[], brief: Brief, withSources: boolean): string | null {
  const span = runSpan(runs);
  if (!span) return null;
  const { attempts, repairs } = runCounts(runs);
  const parts = [`Run ${taipeiTime(span.start)}–${taipeiTime(span.end)}`];
  if (brief.data_only_published_at) parts.push(`data-only ${taipeiTime(brief.data_only_published_at)}`);
  parts.push(`${count(attempts, "attempt")}${repairs ? `, ${count(repairs, "repair")}` : ""}`);
  if (withSources) parts.push(count(brief.computed.source_count, "source"));
  parts.push(`data to ${dayMonth(brief.data_cutoff_utc)} UTC`);
  return parts.join(" · ");
}

const dryRunLine = (date: string) => `Dry run: nothing was published; files in logs/dry-run/${date}/`;
const notesLine = (notes: readonly string[]) => (notes.length ? `Notes: ${notes.map(oneLine).join(" · ")}` : null);

function publishedLines(input: Extract<ChatInput, { kind: "published" }>, site: string): (string | null)[] {
  const b = input.brief;
  const D = b.date;
  const edition = EDITION_WORD[b.edition];
  const first = input.dryRun
    ? `**${SITE_NAME} ${D} · dry run (${edition} edition)**`
    : `**${SITE_NAME} ${D} · ${edition} edition, published ${taipeiTime(b.published_at)}${b.late ? " (late)" : ""}**`;
  // As on the page, a withheld Lead sentence reads WITHHELD_MARK (§4.10).
  const lead = oneLine(b.lead.map((l) => l.text).join(" "));
  const top = b.items.slice(0, 3).map((item, i) =>
    `${i + 1}. ${kicker(item)} · ${item.withheld ? WITHHELD_HEADLINE : oneLine(item.headline)} · ${site}/brief/${D}#${item.id}`);
  const more = b.items.length - 3;
  const corrections = b.corrections.length
    ? `Corrections: ${[
      ...b.corrections.slice(0, 3).map((c) => `${c.id} ${CORRECTION_WORD[c.type]} to ${c.item_id} (${dayMonth(c.edition_date)})`),
      ...(b.corrections.length > 3 ? [`and ${b.corrections.length - 3} more`] : []),
    ].join("; ")}`
    : null;
  return [
    first,
    ...gapLines(b),
    lead || null,
    ...(top.length ? top : ["No top stories today."]),
    taiwanLine(b),
    regionsLine(b),
    input.dryRun ? dryRunLine(D) : more > 0 ? `Also today (${more}): ${site}/brief/${D}#also-today` : `Full brief: ${site}/brief/${D}`,
    corrections,
    notesLine(input.notes),
    runLine(input.runs, b, true),
  ];
}

function kevEntry(item: Item): string {
  const cve = item.cves[0];
  const id = cve?.cve_id ?? item.cve_ids[0] ?? item.id;
  const vendor = cve?.vendor.name ?? item.vendor?.name ?? "";
  return [id, oneLine(vendor), oneLine(cve?.product ?? "")].filter(Boolean).join(" ");
}

/** A signed EPSS move at 2 decimals ("+0.15", "-0.08"), through fmt2() like every number in the chat (§5.2). */
const signed2 = (x: number) => (fmt2(x).startsWith("-") ? fmt2(x) : `+${fmt2(x)}`);

function dataOnlyLines(input: Extract<ChatInput, { kind: "data_only" }>, site: string): (string | null)[] {
  const b = input.brief;
  const D = b.date;
  const code = input.code ? ` (${input.code})` : "";
  const first = input.dryRun
    ? `**${SITE_NAME} ${D} · dry run (data-only edition)**${code}`
    : `**${SITE_NAME} ${D} · data-only edition, published ${taipeiTime(b.published_at)}**${code}`;
  // The count is every KEV entry new since the last edition, not only the (at most 10) the brief holds,
  // and never fewer than the items (§8.8), even when the brief holds none of them.
  const newKev = Math.max(b.items.length, input.kevNew ?? 0);
  const shown = b.items.slice(0, 5);
  const kev = !newKev
    ? "New on CISA's exploited list: none since the last edition."
    : shown.length
      ? `New on CISA's exploited list (${newKev}): ${[
        ...shown.map(kevEntry),
        ...(newKev > shown.length ? [`and ${newKev - shown.length} more`] : []),
      ].join(" · ")}`
      : `New on CISA's exploited list (${newKev}).`;
  const epss = b.epss_movers.length
    ? `EPSS movers (7 days): ${b.epss_movers.slice(0, 3).map((m) =>
      `${m.cve_id} ${signed2(m.delta_7d)} to ${fmt2(m.score)}`).join(" · ")}`
    : null;
  const tl = b.taiwan_lens.kev_lines;
  return [
    first,
    ...gapLines(b),
    kev,
    epss,
    `Taiwan: ${oneLine(`${tl.tw.text} ${tl.jp.text}`)}`,
    regionsLine(b),
    `What happened: ${oneLine(input.what)}`,
    input.nextStep ? `Next step: ${oneLine(input.nextStep)}` : null,
    input.dryRun ? dryRunLine(D) : `Brief: ${site}/brief/${D}`,
    notesLine(input.notes),
    runLine(input.runs, b, false),
  ];
}

function failedLines(input: Extract<ChatInput, { kind: "failed" }>): (string | null)[] {
  const D = input.date;
  const errors = input.errors.slice(0, 5).map((e) => `- ${e.code}${e.path ? ` at ${e.path}` : ""}`);
  const span = runSpan(input.runs);
  const { attempts, repairs } = runCounts(input.runs);
  return [
    input.dryRun ? `**${SITE_NAME} ${D} · dry run (failed)** (${input.code})` : `**${SITE_NAME} ${D} · failed** (${input.code})`,
    `What happened: ${oneLine(input.what)}`,
    ...(errors.length ? ["First errors:", ...errors] : []),
    input.dryRun
      ? "Dry run: nothing was published."
      : input.siteShows ? `Site shows: the ${input.siteShows.date} ${EDITION_WORD[input.siteShows.edition]} edition` : "Site shows: no edition yet.",
    input.needsReview ? `Draft and logs: needs-review/${D}/` : null,
    `Next step: ${oneLine(input.nextStep)}`,
    notesLine(input.notes),
    span ? `Run: started ${taipeiTime(span.start)}, ended ${taipeiTime(span.end)} · attempts ${attempts}, repairs ${repairs}` : null,
  ];
}

function skippedLines(input: Extract<ChatInput, { kind: "skipped" }>): (string | null)[] {
  const head = input.dryRun ? `**${SITE_NAME} ${input.date} · dry run (skipped).**` : `**${SITE_NAME} ${input.date} · skipped.**`;
  return [`${head} ${oneLine(input.reason)}`, input.briefUrl];
}

// ── The last step (§8.8) ─────────────────────────────────────────────────────────────────────────

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;
const DEFANGED_SCHEME_RE = /^hxxps?:\/\//i;
/** A Markdown link or image destination, "](dest" (`<dest>` too), whatever the link text holds. */
const MD_DEST_RE = /\]\(\s*(<[^>]*>|[^\s)]*)/g;
/** A CommonMark autolink, `<scheme:...>`: `<https:evil.example>` links without the slashes. */
const AUTOLINK_RE = /<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*)>/gi;
/** A protocol-relative URL, "//host...", which resolves to https on that host. */
const PROTOCOL_RELATIVE_RE = /(?<![\p{L}\p{N}_:/\\])\/\/(?=[\p{L}\p{N}])[^\s<>"'`]*/gu;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// The lookbehinds refuse only a letter or digit (and, for IPv4, "<digit>." so a longer dotted number is
// not read from its middle): an indicator after ".", "_", "@", "-" or "]" (an issue path such as
// `items[0].evil.com`, prose such as `foo_bar.evil.com`) is defanged too.
const IPV4_RE = /(?<![\p{L}\p{N}]|\p{N}\.)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\p{L}\p{N}]|\.\p{N})/gu;
const VERSION_CONTEXT_RE = /(?:^|[^\p{L}\p{N}])(?:version|v|build|firmware|release)\s+(?:\S+\s+)?$/iu;
/** A "www." host, which GFM auto-links whatever its TLD. */
const WWW_RE = /(?<![\p{L}\p{N}])www\.[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*/giu;
const TLDS = [...IOC_TLDS, "onion", "i2p"].sort((a, b) => b.length - a.length).join("|");
const DOMAIN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS})(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, "giu");
const PICTOGRAPHIC_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}]/gu;
const PRIVATE_USE_RE = /[\uE000-\uF8FF]/g;
/** A line that would open a table, heading, quote or code block, or define a link reference ("[x]: dest"). */
const BLOCK_START_RE = /^(?:[|#>=]|```|~~~|\[[^\]]*\]:)/;

/**
 * The last step of every format (§8.8), on one line, so nothing the Claude app's Markdown links points
 * off-site: a Markdown link or image destination, a `<scheme:...>` autolink, a URL of any scheme (but
 * the defanged hxxp(s)) and a protocol-relative "//host" that do not start with `siteUrl` become
 * "[link removed]"; NO_LIVE_IOC's email, IPv4 and domain matches are defanged with defang() (domains on
 * IOC_TLDS plus .onion and .i2p, in any case, with no config exceptions, whatever character precedes
 * them), and so is any "www." host; emoji and the canary go; and a line that would open a table,
 * heading, quote or code block, or define a link reference, is escaped with a backslash.
 */
export function chatGuard(line: string, siteUrl: string): string {
  const site = siteUrl.replace(/\/+$/, "");
  const isSite = (u: string) => u === site || [`${site}/`, `${site}#`, `${site}?`].some((p) => u.startsWith(p));
  const kept: string[] = [];
  let s = line.replace(PRIVATE_USE_RE, "").replaceAll(CANARY_TOKEN, "[removed]");
  s = s.replace(MD_DEST_RE, (m: string, dest: string) => (isSite(dest.replace(/^<|>$/g, "")) ? m : "]([link removed]"));
  s = s.replace(AUTOLINK_RE, (m: string, url: string) => (isSite(url) ? m : "[link removed]"));
  s = s.replace(URL_RE, (match: string) => {
    const url = match.replace(/[.,;:!?)\]}]+$/, "");
    const tail = match.slice(url.length);
    if (DEFANGED_SCHEME_RE.test(url)) return match;
    if (isSite(url)) {
      kept.push(url);
      return `\uE000${kept.length - 1}\uE001${tail}`;
    }
    return `[link removed]${tail}`;
  });
  s = s.replace(PROTOCOL_RELATIVE_RE, (match: string) => `[link removed]${match.slice(match.replace(/[.,;:!?)\]}]+$/, "").length)}`);
  s = s.replace(EMAIL_RE, (m) => defang(m));
  s = s.replace(IPV4_RE, (m: string, a: string, b: string, c: string, d: string, offset: number, whole: string) => {
    if ([a, b, c, d].some((o) => Number(o) > 255)) return m;
    if (VERSION_CONTEXT_RE.test(whole.slice(0, offset))) return m;
    return defang(m);
  });
  s = s.replace(WWW_RE, (m) => m.replace(/\./g, "[.]"));
  s = s.replace(DOMAIN_RE, (m) => defang(m));
  s = s.replace(PICTOGRAPHIC_RE, "").replace(/ {2,}/g, " ").trimEnd();
  s = s.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => kept[Number(i)]!);
  return BLOCK_START_RE.test(s) ? `\\${s}` : s;
}

/**
 * The chat edition (§8.8) in its four formats and their dry-run forms: at most CHAT_MAX_LINES lines (13
 * at most by construction), each passed through chatGuard(), with a trailing newline.
 */
export function renderChat(input: ChatInput, siteUrl: string): string {
  const site = siteUrl.replace(/\/+$/, "");
  const lines = input.kind === "published" ? publishedLines(input, site)
    : input.kind === "data_only" ? dataOnlyLines(input, site)
    : input.kind === "failed" ? failedLines(input)
    : skippedLines(input);
  const out = lines.filter((l): l is string => l !== null && l.trim() !== "").map((l) => chatGuard(l, site)).slice(0, CHAT_MAX_LINES);
  return `${out.join("\n")}\n`;
}

/** Preflight step 2's line for a held lock (§8.2), written as the summary when none exists. */
export function heldLockLine(date: string, lockStarted: string): string {
  return `${SITE_NAME} ${date}: another run is in progress (started ${taipeiTime(lockStarted)}); nothing done.`;
}

/** Finish step 4's fallback when rendering throws (§8.2), and the watchdog's summary: the error's class name only. */
export function fallbackChat(date: string, error: unknown): string {
  const name = error instanceof Error ? error.constructor.name || "Error" : "Error";
  return `**${SITE_NAME} ${date} · failed** (E_INTERNAL)\nThe chat edition could not be rendered (${/^[A-Za-z_$][\w$]*$/.test(name) ? name : "Error"}).\n`;
}
