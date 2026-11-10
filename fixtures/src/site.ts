// The SAMPLE content folders (SPEC §4.12 "Fixtures and tests", §6 sample mode). fixtures/site-content/ is a
// small but complete content/ tree that validate:sample, the T cases in tests/validate.test.ts, the chat
// snapshots in tests/chat.test.ts and the P4 previews read; fixtures/empty-content/ holds only its README.md.
//
//   2026-10-06 Mon  data-only from --data-only (a manual run): CISA's one addition of 4 October
//   2026-10-07 Tue  data-only from --data-only: nothing new on KEV
//   2026-10-08 Wed  data-only from --data-only: nothing new on KEV
//   2026-10-09 Fri  data-only after E_VALIDATION: five new KEV items (old flaws CISA listed on 8 Oct)
//   2026-10-10 Sat  data-only: the run started after the 05:30 hard stop; nothing new on KEV
//   2026-10-11 Sun  full, no items (valid-quiet's draft)
//   2026-10-12 Mon  full, with the week in review (valid-monday's draft); its breach item is withheld on
//                   13 Oct (a victim dispute, C-0001) and its policy item clarified (C-0002)
//   2026-10-13 Tue  partial (one feed failed): the Edimax flaw, first seen here, and both corrections
//   2026-10-14 Wed  full (valid-weekday's draft): the Edimax flaw again, a Scoreboard report entry
//   2026-10-15 Thu  data-only from --data-only: four new KEV items
//   2026-10-16 Fri  status only: the metrics stage failed (E_METRICS), so no brief
//
// Every file holds what publish would write. The items are frozen by publish's own composers
// (lib/apply.ts freezeItems(), cveBlockOf() and releaseBlockOf(), as applyDraft() and composeDataOnly() call
// them), from the fixture CVE records, the day's KEV rows and inputs manifest and the edition context's
// release candidates, so a sample CVE or release block cannot drift from what publish composes (§0.4 row
// 79; tests/apply.test.ts C22). The rest of each brief is computed here the way the rules check it:
// publisherFor() for the source fields, computeRegions() over the earlier briefs, kevLines() and the
// metrics headline for the Lens and the Gap, pageWords() for computed.word_count. The metrics come from fixtures/src/inputs.ts
// (metricsFor()); each metrics/inputs/D.json manifest lists rows that add up to its figures, with invented
// CVE ids in the CVE-YYYY-99NNNN and CVE-2026-98NNNN ranges (the real KEV rows only for the home vendors).
// The data-only headlines, summaries and CVE titles are placeholders for lib/data-only.ts's templates.

import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  cveBlockOf, findersVersionOf, freezeItems as composeItems, releaseBlockOf, type CveBlockInputs, type CveFacts,
} from "../../lib/apply";
import { matchVendor, type LoadedConfig } from "../../lib/config";
import { addDays } from "../../lib/dates";
import { longDate, shortDate } from "../../lib/format";
import { kevLines } from "../../lib/metrics/headline";
import { collectSignals, computeRegions, regionItems, regionsConfig, type HistoryBrief } from "../../lib/regions";
import { READING_WORDS_PER_MINUTE, aiLinkedOf } from "../../lib/rules/computed";
import { pageWords } from "../../lib/rules/words";
import { Brief, type ActorSeen, type FeedStale, type RegionSignal } from "../../lib/schema/brief";
import type { Edition, Source } from "../../lib/schema/common";
import { DraftBrief, type DraftLensRow } from "../../lib/schema/draft-brief";
import type { DraftItem, Item } from "../../lib/schema/item";
import {
  AnthropicCvdFile, CreditCandidatesFile, InputsManifest, KevIndexFile, Metrics, type KevIndexRow, type WindowRow,
} from "../../lib/schema/metrics";
import { ArchiveIndex, CorrectionsFile, type ArchiveUrl, type Correction, type Dispute } from "../../lib/schema/misc";
import { ScoreboardFile, type ClaimState, type ScoreboardEntry } from "../../lib/schema/scoreboard";
import {
  StatusFile, type FeedRecord, type RunOutcome, type RunRecord, type RunStage, type RunTrigger, type StageRecord, type StageStatus,
} from "../../lib/schema/status";
import { publisherFor } from "../../lib/sources";
import { normalizeUrl } from "../../lib/urls";
import { cveRecordInfo, type CveLookup } from "../../lib/validate";
import {
  KEV_ABSENCE_NOTE, NONE_FOUND, RUN_STAGES, TAIWAN_LENS_ROWS, WITHHELD_HEADLINE, WITHHELD_MARK, WITHHELD_TEXT,
} from "../../lib/vocab";
import { STAGE_NOTES } from "../../lib/chat";
import type { Output } from "./build";
import { MONDAY_ITEMS, WEEKDAY_ITEMS, editionDraft } from "./drafts";
import { editionContext, editionEvidence, editionRegionsInput, fixtureConfig, metricsFor } from "./inputs";
import {
  EDITIONS, KEV_DUE, KEV_ROWS, RECORD_IDS, SOURCES, cveRecord, draftSources, seenText, sourceIds,
  type EditionName, type EditionTimes, type SourceKey,
} from "./world";

export const SITE_CONTENT_DIR = "fixtures/site-content";
export const EMPTY_CONTENT_DIR = "fixtures/empty-content";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const ZERO_COMMIT = "0".repeat(40);
const cfg = (): LoadedConfig => fixtureConfig();

/** A content file's text (§4.1): parsed through its schema, so keys follow the schema, 2-space indent, newline. */
function contentText(value: unknown, schema: z.ZodType): string {
  return `${JSON.stringify(schema.parse(value), null, 2)}\n`;
}

// ── Dates ────────────────────────────────────────────────────────────────────────────────────────

type SiteTimes = Omit<EditionTimes, "name">;
type Kev = EditionTimes["kev"];

const KEV_1008 = { version: EDITIONS.quiet.kev.version, count: EDITIONS.quiet.kev.count, released: EDITIONS.quiet.kev.released };
/** The catalog of 4 October, before the five additions of 8 October (1,739 − 5). */
const KEV_1004 = { version: "2026.10.04", count: 1734, released: "2026-10-04T16:58:21Z" };
/** The catalog after the four additions of 14 October (1,741 + 4). */
const KEV_1014 = { version: "2026.10.14", count: 1745, released: "2026-10-14T17:03:27Z" };

/** EditionTimes for a sample date; `start` is the run's Taipei start when it is not 04:37. */
function siteTimes(date: string, generated: string, kev: Kev, collectEnd = "04:41:05", metricsEnd = "04:41:12"): SiteTimes {
  return {
    date,
    window: { start: `${addDays(date, -1)}T04:30:00+08:00`, end: `${date}T04:30:00+08:00` },
    cutoff: addDays(date, -2),
    packAt: `${date}T${collectEnd}+08:00`,
    metricsAt: `${date}T${metricsEnd}+08:00`,
    generatedAt: `${date}T${generated}+08:00`,
    deadline: `${date}T05:15:00+08:00`,
    kev,
    cveListRelease: `cve_${addDays(date, -1)}_2000Z`,
  };
}

const named = (name: EditionName): SiteTimes => {
  const { name: _n, ...t } = EDITIONS[name];
  return t;
};

/** KEV rows of the catalog a version names (entries added up to its date). */
function kevThrough(version: string): KevIndexRow[] {
  const through = version.replace(/\./g, "-");
  return KEV_ROWS.filter((r) => r[1] <= through).map((r) => [...r] as KevIndexRow);
}

const newKev = (from: string, to: string) => KEV_ROWS.filter((r) => r[1] > from && r[1] <= to).map((r) => r[0]);

// ── Run records ──────────────────────────────────────────────────────────────────────────────────

/** One stage as [status, Taipei end time or null when skipped, note]. */
type StagePlan = [StageStatus, string | null, string?];

interface RunPlan {
  trigger: RunTrigger;
  start: string;
  stages: readonly StagePlan[];
  outcome: RunOutcome;
  edition: Edition | null;
  error_code: string | null;
  dataOnlyAt: string | null;
  fullAt: string | null;
  repairs: number;
  agentSeconds: number;
  fetches: number;
  searches: number;
  validation: RunRecord["validation"];
  candidates: RunRecord["candidates"];
  soft: RunRecord["soft_gates"];
  /** What the site shows after the deploy stage, or null when nothing was deployed. */
  shows: { date: string; edition: Edition } | null;
  failedFeeds?: readonly { id: string; status: "stale" | "failed"; newest: string | null; since: string; note: string }[];
  checks: boolean;
}

const ts = (date: string, hhmmss: string) => `${date}T${hhmmss}+08:00`;

/** The run's ten stage records: each starts where the last stage that ran ended. */
function stageRecords(date: string, start: string, plan: readonly StagePlan[]): StageRecord[] {
  if (plan.length !== RUN_STAGES.length) throw new Error(`${date}: ${plan.length} stage plans for ${RUN_STAGES.length} stages`);
  let prev = ts(date, start);
  return RUN_STAGES.map((id, i) => {
    const [status, end, note] = plan[i]!;
    if (end === null) return { id, status, started_at: null, ended_at: null, note: note ?? null };
    const rec = { id, status, started_at: prev, ended_at: ts(date, end), note: note ?? null };
    prev = rec.ended_at;
    return rec;
  });
}

/** One record per registry feed, registry order (§4.3): all fetched fine unless `failed` names them. */
function feedRecords(t: SiteTimes, checkedAt: string, failed: RunPlan["failedFeeds"] = []): FeedRecord[] {
  const listAt = /^cve_(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})Z$/.exec(t.cveListRelease)!;
  const day = addDays(t.date, -1);
  return cfg().sources.feeds.map((f, i): FeedRecord => {
    const bad = failed.find((x) => x.id === f.id);
    if (bad) {
      return { id: f.id, status: bad.status, newest: bad.newest, checked_at: checkedAt, stale_since: bad.since, records: null, note: bad.note };
    }
    let newest: string | null;
    let records: number | null;
    if (f.kind === "kev") [newest, records] = [t.kev.released, t.kev.count];
    else if (f.kind === "cvelist") [newest, records] = [`${listAt[1]}T${listAt[2]}:${listAt[3]}:00Z`, 412];
    else if (f.kind === "epss") [newest, records] = [t.cutoff, 296_114];
    else if (f.kind === "search") [newest, records] = [null, null];
    else [newest, records] = [`${day}T${String(17 + (i % 7)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}:00+08:00`, 8 + (i % 13)];
    return { id: f.id, status: "ok", newest, checked_at: checkedAt, stale_since: null, records, note: null };
  });
}

function runRecord(t: SiteTimes, p: RunPlan, attempt = 1): RunRecord {
  const stages = stageRecords(t.date, p.start, p.stages);
  const ends = stages.map((s) => s.ended_at).filter((x): x is string => x !== null);
  const collect = stages.find((s) => s.id === "collect")!;
  const deploy = stages.find((s) => s.id === "deploy")!;
  const links = stages.find((s) => s.id === "links")!;
  return {
    run_id: `${t.date.replace(/-/g, "")}-${p.start.replace(/:/g, "")}`,
    trigger: p.trigger,
    attempt,
    started_at: ts(t.date, p.start),
    finished_at: ends.at(-1) ?? null,
    outcome: p.outcome,
    edition: p.edition,
    error_code: p.error_code,
    code_commit: ZERO_COMMIT,
    data_cutoff_utc: t.cutoff,
    data_only_published_at: p.dataOnlyAt ? ts(t.date, p.dataOnlyAt) : null,
    full_published_at: p.fullAt ? ts(t.date, p.fullAt) : null,
    late: false,
    stages,
    feeds: feedRecords(t, collect.ended_at ?? ts(t.date, p.start), p.failedFeeds),
    budgets: {
      agent_seconds: p.agentSeconds, web_fetches: p.fetches, web_searches: p.searches, repair_rounds: p.repairs,
      tokens_in: null, tokens_out: null, usage: p.agentSeconds ? { window: "seven_day", utilization: 0.41 } : null, safety_stops: 0,
    },
    candidates: p.candidates,
    validation: p.validation,
    soft_gates: p.soft,
    deploy: p.shows
      ? { triggered: true, ready_at: deploy.ended_at, shows_date: p.shows.date, shows_edition: p.shows.edition }
      : { triggered: false, ready_at: null, shows_date: "2026-10-15", shows_edition: "data_only" },
    recheck: p.checks ? { from: addDays(t.date, -RECHECK_DAYS), to: addDays(t.date, -1), items_checked: 9, flagged: [] } : null,
    links: p.checks && links.ended_at ? { checked_at: links.ended_at, checked: 31, ok: 31, unknown: 0, broken: [] } : null,
  };
}

/** SPEC §8.9's re-check window, D − 14 to D − 1 (scripts/recheck.ts RECHECK_LIMITS.days; tests/recheck.test.ts checks they agree). */
export const RECHECK_DAYS = 14;

const ok = (end: string): StagePlan => ["ok", end];
const skip = (note?: string): StagePlan => ["skipped", null, note];

/** A full or partial morning: data-only by about 04:48, then the agent, validation and the full publish. */
function fullPlan(o: {
  edition: "full" | "partial"; date: string; dataOnly: string; draft: string; validate: string; publish: string; end: [string, string, string];
  items: number; repairs?: number; collect?: StageStatus; failedFeeds?: RunPlan["failedFeeds"];
}): RunPlan {
  return {
    trigger: "schedule", start: "04:37:02",
    stages: [ok("04:37:06"), [o.collect ?? "ok", "04:41:05"], ok("04:41:12"), ok(o.dataOnly), ok(o.draft), ok(o.validate), ok(o.publish),
      ok(o.end[0]), ok(o.end[1]), ok(o.end[2])],
    outcome: o.edition === "full" ? "published_full" : "published_partial", edition: o.edition, error_code: null,
    dataOnlyAt: o.dataOnly, fullAt: o.publish, repairs: o.repairs ?? 0, agentSeconds: 1140 + o.items * 45, fetches: 6 + o.items * 2, searches: 9,
    validation: { errors: 0, warnings: 0, codes: [] },
    candidates: { ranked: 40, kept: 6 + o.items, deep_read: Math.min(15, 4 + o.items) },
    soft: { checked: o.items, dropped: 0, by_code: {} },
    shows: { date: o.date, edition: o.edition }, failedFeeds: o.failedFeeds, checks: true,
  };
}

// ── The days ─────────────────────────────────────────────────────────────────────────────────────

interface Day {
  t: SiteTimes;
  edition: Edition;
  /** The agent's draft for a full or partial edition; null for a data-only one. */
  draft: DraftBrief | null;
  /** Whose fixture evidence gives the sources' seen_as. */
  evidence: EditionName | null;
  run: RunPlan;
}

const STALE_FEED = { id: "ithome-security", status: "failed" as const, newest: "2026-10-12T16:40:00+08:00", since: "2026-10-13", note: "HTTP 503 on three tries" };

/** The partial edition's draft: the Edimax flaw on its first morning, cited from its CVE record alone. */
function partialDraft(t: SiteTimes): DraftBrief {
  const keys = ["rec-108917"] as const satisfies readonly SourceKey[];
  const s = sourceIds(keys);
  const weekday = editionDraft("weekday").items.find((it) => it.id === WEEKDAY_ITEMS.taiwanVendor)!;
  const edimax: DraftItem = {
    ...weekday,
    summary: "A CVE record published overnight describes a command injection flaw in the end-of-life BR-6208AC router; VulDB says Edimax never responded, so no fix is coming.",
    why_it_matters: "Old routers stay online for years, and a flaw with public details and no fix is an easy way in.",
    source_ids: [s["rec-108917"]],
  };
  const rows: DraftLensRow[] = TAIWAN_LENS_ROWS.map((row) => (row === "home_vendors"
    ? { row, text: "Details of an Edimax router flaw rated 10 are public, and no fix is coming.", item_ids: [edimax.id], source_ids: [] }
    : { row, text: null, item_ids: [], source_ids: [] }));
  return DraftBrief.parse({
    schema_version: 1,
    date: t.date,
    generated_at: t.generatedAt,
    lead: [
      { text: "Details of an Edimax router flaw rated 10 are public, and VulDB says Edimax never responded, so no fix is coming.", item_ids: [edimax.id], gap: false },
      { text: "37% of recently disclosed flaws on CISA's exploited list were already being exploited when disclosed, the same share as in 2023–24.", item_ids: [], gap: true },
    ],
    angle: {
      text: "New CVE records are arriving at 5.2 times the 2023–24 pace.",
      source_id: null, metric_path: "flood.vs_reference_ratio", as_of: t.cutoff, counterpoint: NONE_FOUND, counterpoint_source_ids: [], claim_id: null,
    },
    region_raises: [],
    items: [edimax],
    taiwan_lens: {
      analysis: "No Taiwanese vendor flaw was reported exploited today. An Edimax router flaw rated 10 has public details, and VulDB says no fix is coming.",
      item_ids: [edimax.id], source_ids: [], rows, japan: { text: null, item_ids: [], source_ids: [] },
    },
    scoreboard_entries: [],
    week_in_review: null,
    corrections: [],
    elsewhere: [],
    sources: draftSources(keys),
  });
}

/** A data-only morning from `--data-only` (a manual run started at 04:42): no draft, validate or publish stage. */
function requestedDataOnly(date: string, kev: Kev): Day {
  return {
    t: siteTimes(date, "04:51:12", kev, "04:46:02", "04:46:09"), edition: "data_only", draft: null, evidence: null,
    run: {
      trigger: "manual", start: "04:42:10",
      stages: [ok("04:42:14"), ok("04:46:02"), ok("04:46:09"), ok("04:51:27"), ...[0, 1, 2].map(() => skip(STAGE_NOTES.dataOnlyRequested)),
        ok("04:53:05"), ok("04:53:44"), ok("04:54:20")],
      outcome: "published_data_only", edition: "data_only", error_code: null, dataOnlyAt: "04:51:27", fullAt: null,
      repairs: 0, agentSeconds: 0, fetches: 0, searches: 0, validation: null, candidates: null, soft: null,
      shows: { date, edition: "data_only" }, checks: true,
    },
  };
}

function buildDays(): Day[] {
  const t09 = siteTimes("2026-10-09", "04:48:05", { ...KEV_1008, since: "2026.10.04", newIds: newKev("2026-10-04", "2026-10-08") });
  const t10 = siteTimes("2026-10-10", "05:51:18", { ...KEV_1008, since: "2026.10.08", newIds: [] }, "05:44:58", "05:45:06");
  const t13 = siteTimes("2026-10-13", "04:56:40", { ...KEV_1008, since: "2026.10.08", newIds: [] });
  const t15 = siteTimes("2026-10-15", "04:51:12", { ...KEV_1014, since: "2026.10.13", newIds: newKev("2026-10-13", "2026-10-14") }, "04:46:02", "04:46:09");
  const shown = (date: string, edition: Edition) => ({ date, edition });
  return [
    requestedDataOnly("2026-10-06", { ...KEV_1004, since: "2026.10.02", newIds: newKev("2026-10-02", "2026-10-04") }),
    requestedDataOnly("2026-10-07", { ...KEV_1004, since: "2026.10.04", newIds: [] }),
    requestedDataOnly("2026-10-08", { ...KEV_1004, since: "2026.10.04", newIds: [] }),
    {
      t: t09, edition: "data_only", draft: null, evidence: null,
      run: {
        trigger: "schedule", start: "04:37:04",
        stages: [ok("04:37:09"), ok("04:41:05"), ok("04:41:12"), ok("04:48:20"), ok("04:59:40"), ["failed", "05:06:15"], skip(), ok("05:08:30"), ok("05:09:10"), ok("05:10:02")],
        outcome: "published_data_only", edition: "data_only", error_code: "E_VALIDATION", dataOnlyAt: "04:48:20", fullAt: null,
        repairs: 2, agentSeconds: 1310, fetches: 17, searches: 9, validation: { errors: 2, warnings: 0, codes: ["LEAD_GROUNDED", "SOURCE_TIER"] },
        candidates: { ranked: 38, kept: 11, deep_read: 9 }, soft: null, shows: shown("2026-10-09", "data_only"), checks: true,
      },
    },
    {
      t: t10, edition: "data_only", draft: null, evidence: null,
      run: {
        trigger: "schedule", start: "05:41:16",
        stages: [ok("05:41:20"), ok("05:44:58"), ok("05:45:06"), ok("05:51:33"), ...[0, 1, 2].map(() => skip(STAGE_NOTES.startedAfterHardStop("05:30"))),
          ok("05:53:10"), ok("05:53:50"), ok("05:54:31")],
        outcome: "published_data_only", edition: "data_only", error_code: null, dataOnlyAt: "05:51:33", fullAt: null,
        repairs: 0, agentSeconds: 0, fetches: 0, searches: 0, validation: null, candidates: null, soft: null,
        shows: shown("2026-10-10", "data_only"), checks: true,
      },
    },
    {
      t: named("quiet"), edition: "full", draft: editionDraft("quiet"), evidence: "quiet",
      run: fullPlan({ edition: "full", date: "2026-10-11", dataOnly: "04:47:31", draft: "04:58:12", validate: "04:58:40", publish: "04:59:30", end: ["05:01:45", "05:02:20", "05:03:05"], items: 0 }),
    },
    {
      t: named("monday"), edition: "full", draft: editionDraft("monday"), evidence: "monday",
      run: fullPlan({ edition: "full", date: "2026-10-12", dataOnly: "04:47:55", draft: "05:04:32", validate: "05:05:01", publish: "05:05:52", end: ["05:08:10", "05:08:50", "05:09:41"], items: 3 }),
    },
    {
      t: t13, edition: "partial", draft: partialDraft(t13), evidence: null,
      run: fullPlan({
        edition: "partial", date: "2026-10-13", dataOnly: "04:47:40", draft: "04:56:42", validate: "04:57:10", publish: "04:58:02",
        end: ["05:00:20", "05:01:00", "05:01:48"], items: 1, collect: "degraded", failedFeeds: [STALE_FEED],
      }),
    },
    {
      t: named("weekday"), edition: "full", draft: editionDraft("weekday"), evidence: "weekday",
      run: fullPlan({ edition: "full", date: "2026-10-14", dataOnly: "04:48:02", draft: "05:06:14", validate: "05:06:50", publish: "05:07:44", end: ["05:10:05", "05:10:45", "05:11:30"], items: 8, repairs: 1 }),
    },
    {
      t: t15, edition: "data_only", draft: null, evidence: null,
      run: {
        trigger: "manual", start: "04:42:10",
        stages: [ok("04:42:14"), ok("04:46:02"), ok("04:46:09"), ok("04:51:27"), ...[0, 1, 2].map(() => skip(STAGE_NOTES.dataOnlyRequested)),
          ok("04:53:05"), ok("04:53:44"), ok("04:54:20")],
        outcome: "published_data_only", edition: "data_only", error_code: null, dataOnlyAt: "04:51:27", fullAt: null,
        repairs: 0, agentSeconds: 0, fetches: 0, searches: 0, validation: null, candidates: null, soft: null,
        shows: shown("2026-10-15", "data_only"), checks: true,
      },
    },
  ];
}

/** 16 October: collect ran, the metrics stage failed, nothing was published. */
function failedMorning(): { t: SiteTimes; run: RunPlan } {
  const t = siteTimes("2026-10-16", "04:41:40", { ...KEV_1014, since: "2026.10.14", newIds: [] }, "04:41:02", "04:41:40");
  return {
    t,
    run: {
      trigger: "schedule", start: "04:37:03",
      stages: [ok("04:37:07"), ok("04:41:02"), ["failed", "04:41:40"], ...Array.from({ length: 7 }, () => skip())],
      outcome: "failed", edition: null, error_code: "E_METRICS", dataOnlyAt: null, fullAt: null,
      repairs: 0, agentSeconds: 0, fetches: 0, searches: 0, validation: null, candidates: null, soft: null, shows: null, checks: false,
    },
  };
}

// ── Metrics and their inputs manifests ───────────────────────────────────────────────────────────

/** `total` spread over `n` days, the remainder on the first days. */
function spread(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => base + (i < total - base * n ? 1 : 0));
}

function daysFrom(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The Window bands a manifest lists: [band, rows, lag of the first row, lag step]. */
type BandPlan = readonly [WindowRow["band"], number, number, number][];
/** Appendix D.3's 13-week counts, and the rows only the 26-week window adds (w26 minus w13). */
const W13_BANDS: BandPlan = [["at_disclosure", 36, 0, 0], ["n_day", 17, 2, 0.3], ["n_day", 18, 9, 1.2], ["late", 23, 31, 14], ["old", 13, 400, 300]];
const W26_ONLY_BANDS: BandPlan = [["at_disclosure", 22, 0, 0], ["n_day", 12, 2, 0.4], ["n_day", 15, 8, 1.5], ["late", 14, 33, 20], ["old", 9, 420, 350]];

function windowRows(plan: BandPlan, from: string, to: string, seq: { n: number }): WindowRow[] {
  const days = daysFrom(from, to);
  const total = plan.reduce((a, [, n]) => a + n, 0);
  const rows: WindowRow[] = [];
  let k = 0;
  for (const [band, n, lag0, step] of plan) {
    for (let j = 0; j < n; j += 1, k += 1) {
      const added = days[Math.floor((k * days.length) / total)]!;
      const lag = band === "at_disclosure" ? j % 2 : Math.round(lag0 + j * step);
      const published = addDays(added, -lag);
      seq.n += 1;
      rows.push({ cve_id: `CVE-${published.slice(0, 4)}-99${String(seq.n).padStart(4, "0")}`, kev_date_added: added, date_published: published, lag_days: lag, band });
    }
  }
  return rows.sort((a, b) => (a.kev_date_added < b.kev_date_added ? -1 : a.kev_date_added > b.kev_date_added ? 1 : a.cve_id < b.cve_id ? -1 : 1));
}

/** The AI-credited records of Appendix D.7's 13 weeks: [finder id, matched text, records]. */
// Appendix D.7's w13 split by finder at list v2 (§0.4 row 31): 502 rows, 278 Anthropic.
const AI_ROWS: readonly [string, string, number][] = [
  ["anthropic-claude", "Claude", 270], ["anthropic-claude-code", "Claude Code", 8], ["openai-codex", "Aardvark", 41],
  ["google-big-sleep", "Big Sleep", 1], ["aisle", "AISLE", 177], ["depthfirst", "depthfirst", 2], ["xbow", "XBOW", 1],
  ["aixcc", "Team Atlanta", 1], ["generic-ai-assisted", "AI-assisted", 1],
];

function manifestFor(t: SiteTimes, m: Metrics): InputsManifest {
  const c = cfg();
  const w26 = m.window!.w26;
  const w13 = m.window!.w13;
  const seq = { n: 0 };
  const rows13 = windowRows(W13_BANDS, w13.from, w13.to, seq);
  const rows26 = [...windowRows(W26_ONLY_BANDS, w26.from, addDays(w13.from, -1), seq), ...rows13];

  const f = m.flood!;
  const week = daysFrom(f.last_week.week_start, addDays(f.last_week.week_start, 6));
  const rest = daysFrom(f.from, f.to).filter((d) => !week.includes(d));
  const restN = spread(f.n - f.last_week.n, rest.length);
  const restK = spread(f.kernel_n - f.last_week.kernel_n, rest.length);
  const restU = spread(f.unscored_n - f.last_week.unscored_n, rest.length);
  const weekN = spread(f.last_week.n, 7);
  const weekK = spread(f.last_week.kernel_n, 7);
  const weekU = spread(f.last_week.unscored_n, 7);
  const ago = daysFrom(f.year_ago.from, f.year_ago.to);
  const agoN = spread(f.year_ago.n, ago.length);
  const agoK = spread(f.year_ago.kernel_n, ago.length);
  const agoU = spread(Math.round(f.year_ago.n * 0.07), ago.length);
  const day = (date: string, n: number, kernel_n: number, unscored_n: number) => ({ date, n, kernel_n, unscored_n, ids_sha256: sha256(`SAMPLE ${date} ${n}`) });
  const days = [
    ...ago.map((d, i) => day(d, agoN[i]!, agoK[i]!, agoU[i]!)),
    ...daysFrom(f.from, f.to).map((d) => {
      const w = week.indexOf(d);
      const r = rest.indexOf(d);
      return w >= 0 ? day(d, weekN[w]!, weekK[w]!, weekU[w]!) : day(d, restN[r]!, restK[r]!, restU[r]!);
    }),
  ];

  const a = m.ai_credited!;
  const aiDays = daysFrom(a.from, a.to);
  const aiTotal = AI_ROWS.reduce((x, [, , n]) => x + n, 0);
  let ai = 0;
  const aiCredited: InputsManifest["ai_credited"] = AI_ROWS.flatMap(([finderId, matched, n]) => {
    const finder = c.aiFinders.finders.find((x) => x.id === finderId)!;
    return Array.from({ length: n }, () => {
      ai += 1;
      return {
        id: `CVE-2026-98${String(ai).padStart(4, "0")}`, published: aiDays[Math.floor(((ai - 1) * aiDays.length) / aiTotal)]!,
        finder_id: finder.id, family: finder.family, kind: finder.kind, field: "cna.credits" as const, matched, rule: "pattern" as const,
      };
    });
  });

  const homeRows = (key: "tw" | "jp") => [...(m.home_vendors?.[key].cve_ids_90 ?? [])];
  const listAt = /^cve_(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})Z$/.exec(t.cveListRelease)!;
  return InputsManifest.parse({
    schema_version: 1,
    date: t.date,
    data_cutoff_utc: t.cutoff,
    generated_at: t.metricsAt,
    code_commit: ZERO_COMMIT,
    feeds: [
      { id: "kev", as_of: t.kev.released, version: t.kev.version, sha256: sha256(`SAMPLE kev ${t.kev.version}`), records: t.kev.count },
      { id: "cvelist", as_of: `${listAt[1]}T${listAt[2]}:${listAt[3]}:00Z`, version: t.cveListRelease, sha256: sha256(`SAMPLE ${t.cveListRelease}`), records: 336_417 },
      { id: "epss", as_of: t.cutoff, version: m.provenance.epss_model_version, sha256: sha256(`SAMPLE epss ${t.cutoff}`), records: 296_114 },
    ],
    window: { w26: rows26, w13: rows13, reference_sha256: sha256("SAMPLE reference 2023-01-01 to 2024-12-31") },
    kev_new: [...(m.kev?.new_since_last_edition.cve_ids ?? [])],
    flood: { days, new_days: [] },
    ai_credited: aiCredited,
    home_vendors: { tw: homeRows("tw"), jp: homeRows("jp") },
  });
}

// ── Freezing a brief ─────────────────────────────────────────────────────────────────────────────

/** A source as publish freezes it: publisherFor() on the current config, and how the run saw the URL. */
function freezeSource(s: DraftBrief["sources"][number], seenAs: Source["seen_as"]): Source {
  const p = publisherFor(s.url, s.source_type, cfg());
  return { ...s, publisher: p.publisher, publisher_name: p.publisher_name, tier: p.tier, state_label: p.state_label, seen_as: seenAs };
}

/**
 * The sample's CVE facts, as scripts/lib/cve-facts.ts's cveFactsFor() gives them to publish from the run's
 * cache: the fixture records, the KEV rows of the day's catalog (KEV_DUE, else added + 21 days; no
 * vulnerabilityName, so a title comes from the record), no EPSS or GHSA.
 */
function siteFacts(t: SiteTimes): CveFacts {
  const rows = kevThrough(t.kev.version);
  return {
    record: (id) => (RECORD_IDS.includes(id) ? cveRecord(id) : null),
    kev: (id) => {
      const r = rows.find((x) => x[0] === id);
      return r ? { dateAdded: r[1], dueDate: KEV_DUE[id] ?? addDays(r[1], 21), ransomware: r[6], catalogVersion: t.kev.version } : null;
    },
    epss: () => null,
    ghsaIds: () => [],
  };
}

/** The CVE List as collect fetched it for the sample: the fixture records (fixtures/cvelist/records/). */
const SITE_CVE_LIST: CveLookup = {
  get: (id) => {
    const cve = id.toUpperCase();
    return RECORD_IDS.includes(cve) ? cveRecordInfo(cveRecord(cve)) ?? undefined : undefined;
  },
};

/**
 * Frozen items (§4.6) through publish's own composers (lib/apply.ts freezeItems(), cveBlockOf(),
 * releaseBlockOf()), as applyDraft() and composeDataOnly() build them: every CVE block from the sample's
 * facts, the day's KEV rows and inputs manifest; a patch batch's release block from the edition context's
 * release candidate.
 */
function siteItems(draftItems: readonly DraftItem[], sources: readonly Source[], x: BriefContext): Item[] {
  const c = cfg();
  const t = x.day.t;
  const inputs: CveBlockInputs = {
    config: c, facts: siteFacts(t), cveList: SITE_CVE_LIST, kevIndex: { entries: kevThrough(t.kev.version) }, inputs: x.manifest,
    findersVersion: findersVersionOf(x.metrics, c), capturedAt: x.publishedAt,
  };
  const releases = x.day.evidence ? editionContext(x.day.evidence).candidates.flatMap((cand) => (cand.release ? [cand.release] : [])) : [];
  return composeItems(draftItems, sources, {
    config: c, date: t.date, history: x.history, firstSeen: firstSeenMap(x.history),
    blocks: (it) => it.cve_ids.map((cve) => cveBlockOf(cve, it, sources, inputs)),
    release: (it) => releaseBlockOf(it, releases.find((r) => r.release_id === it.release_id) ?? null, sources, c, SITE_CVE_LIST),
  });
}

/** One chip per actor named in the items (§4.5 ActorSeen). */
function actorsSeen(items: readonly Item[]): ActorSeen[] {
  const c = cfg();
  const out: ActorSeen[] = [];
  for (const it of items) {
    for (const a of it.attribution) {
      if (!a.actor_name_as_used) continue;
      const key = a.actor_name_as_used.toLowerCase();
      const actor = c.actors.actors.find((x) => x.name.toLowerCase() === key || x.aliases.some((al) => al.name.toLowerCase() === key)) ?? null;
      const name = actor?.name ?? a.actor_name_as_used;
      let seen = out.find((x) => x.name === name);
      if (!seen) {
        const url = actor?.related_tracker ? c.run.siblings[actor.related_tracker] : null;
        seen = { name, actor_id: actor?.id ?? null, nexus: it.actor_nexus ?? "unknown", item_ids: [], cross_link: actor?.related_tracker && url ? { tracker: actor.related_tracker, url } : null };
        out.push(seen);
      }
      if (!seen.item_ids.includes(it.id)) seen.item_ids.push(it.id);
      if (seen.nexus !== (it.actor_nexus ?? "unknown")) seen.nexus = "unknown";
    }
  }
  return out;
}

interface BriefContext {
  day: Day;
  metrics: Metrics;
  metricsText: string;
  /** metrics/inputs/D.json: the CVE blocks read its rows, as publish does. */
  manifest: InputsManifest;
  history: readonly Brief[];
  corrections: readonly Correction[];
  entries: readonly ScoreboardEntry[];
  last: Brief["scoreboard"]["last"];
  claims: readonly ClaimState[];
  publishedAt: string;
  dataOnlyAt: string;
  feedsStale: FeedStale[];
}

function firstSeenMap(history: readonly Brief[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of history) for (const it of b.items) if (!out.has(it.id)) out.set(it.id, b.date);
  return out;
}

function regionsFor(day: Day, items: readonly Item[], sources: readonly Source[], history: readonly Brief[], raises: DraftBrief["region_raises"]) {
  const c = cfg();
  const rc = regionsConfig(c);
  const kevIndex = { entries: kevThrough(day.t.kev.version) };
  const signals: RegionSignal[] = day.evidence
    ? editionRegionsInput(day.evidence).signals
    : collectSignals(null, null, kevIndex, rc, day.t.date);
  const past: HistoryBrief[] = history.map((b) => ({ date: b.date, items: b.items, sources: b.sources, regions: b.regions }));
  return computeRegions({ date: day.t.date, items: regionItems(items, sources, rc), history: past, signals, kevIndex, config: rc, raises });
}

function gapOf(m: Metrics, metricsText: string): Brief["gap"] {
  return {
    headline: m.headline.text, second_line: m.headline.second_line, status: "ok", metrics_file: `metrics/${m.date}.json`,
    metrics_sha256: sha256(metricsText), as_of: m.data_cutoff_utc,
  };
}

function lensScript(m: Metrics, date: string) {
  const lines = kevLines(m);
  const pick = (k: "tw" | "jp") => ({ d30_n: lines[k].d30_n, d90_n: lines[k].d90_n, text: lines[k].text });
  return {
    kev_lines: { tw: pick("tw"), jp: pick("jp") },
    kev_note: KEV_ABSENCE_NOTE,
    watch_windows: cfg().watchWindows.windows.filter((w) => w.start <= date && date <= w.end).map((w) => ({ id: w.id, title: w.title, start: w.start, end: w.end })),
  };
}

/** computed (§4.5): pageWords() against the same-date metrics, and the counts. */
function computedOf(b: Brief, m: Metrics): Brief["computed"] {
  const words = pageWords(b, m);
  return {
    word_count: words, reading_minutes: Math.ceil(words / READING_WORDS_PER_MINUTE), item_count: b.items.length,
    ai_linked: aiLinkedOf(b.items), source_count: b.sources.length, publisher_count: new Set(b.sources.map((s) => s.publisher)).size,
  };
}

/** A full or partial edition: the draft frozen with every S and C field (what applyDraft() will do, §8.11). */
function freezeDraft(x: BriefContext): Brief {
  const { day, metrics: m } = x;
  const d = day.draft!;
  const seen = day.evidence ? editionEvidence(day.evidence).seen_as : null;
  const sources = d.sources.map((s) => freezeSource(s, seen?.[normalizeUrl(s.url)] ?? "pack"));
  const items = siteItems(d.items, sources, x);
  const claimText = (id: string | null) => (id ? cfg().claims.claims.find((c) => c.id === id)!.text : null);
  const { region_raises: raises, scoreboard_entries: _entries, ...rest } = d;
  const b: Brief = {
    ...rest,
    edition: day.edition,
    published_at: x.publishedAt,
    data_only_published_at: x.dataOnlyAt,
    late: false,
    data_cutoff_utc: day.t.cutoff,
    angle: d.angle ? { ...d.angle, claim_text: claimText(d.angle.claim_id) } : null,
    regions: regionsFor(day, items, sources, x.history, raises),
    gap: gapOf(m, x.metricsText),
    items,
    actors_seen: actorsSeen(items),
    taiwan_lens: { ...d.taiwan_lens, ...lensScript(m, day.t.date) },
    scoreboard: { entries: [...x.entries], last: x.last },
    week_in_review: d.week_in_review
      ? {
        ...d.week_in_review, from: addDays(day.t.date, -7), to: addDays(day.t.date, -1),
        table: x.claims.map((c) => ({ claim_id: c.id, text: c.text, status: c.status, zone: c.zone, reading_text: c.reading_text, reading_as_of: c.reading_as_of })),
      }
      : null,
    corrections: [...x.corrections],
    epss_movers: [...m.epss_movers],
    feeds_stale: x.feedsStale,
    sources,
    computed: { word_count: 0, reading_minutes: 0, item_count: 0, ai_linked: { linked: 0, total: 0 }, source_count: 0, publisher_count: 0 },
  };
  b.computed = computedOf(b, m);
  return Brief.parse(b);
}

/** A data-only edition (§4.5): one exploited_flaw item per new KEV CVE, newest first, at most 10. */
function dataOnly(x: BriefContext): Brief {
  const { day, metrics: m } = x;
  const t = day.t;
  const rows = [...t.kev.newIds].reverse().slice(0, 10).map((id) => KEV_ROWS.find((r) => r[0] === id)!);
  const draftSources = rows.map(([cve, , , , published], i) => ({
    id: `s${i + 1}`, title: cve, title_en: null, language: "en" as const, outlet: "CVE Program",
    url: `https://www.cve.org/CVERecord?id=${cve}`, source_type: "cve_record" as const, published_at: published,
  }));
  const sources = draftSources.map((s) => freezeSource(s, "pack"));
  const draftItems: DraftItem[] = rows.map(([cve, added, vendorProject, product, published], i) => {
    const v = matchVendor(cfg(), { kevVendorProject: vendorProject });
    const home = v?.country === "TW" || v?.country === "JP" ? [v.country] : ["GLOBAL"];
    return {
      id: cve.toLowerCase(), kind: "exploited_flaw",
      headline: `CISA lists ${cve} in ${vendorProject} ${product} as exploited`.slice(0, 90),
      summary: `CISA added ${cve}, a flaw in ${vendorProject} ${product}, to its list of exploited flaws on ${shortDate(added)} (US date). The CVE record was published on ${shortDate(published!)}.`,
      why_it_matters: null, severity: null, landmark: false, ai_role: "unassessed", ai_role_secondary: null, ai_confidence: null,
      ai_claimant: null, ai_evidence: [], claim_type: "government", regions: home as DraftItem["regions"], topics: [], attribution: [],
      incident: null, cve_ids: [cve], release_id: null, flaw_evidence: [], exploit_reported_in_sources: null, exposure: null,
      standing_story: null, source_ids: [`s${i + 1}`],
    };
  });
  const items = siteItems(draftItems, sources, x);
  const b: Brief = {
    schema_version: 1,
    date: t.date,
    edition: "data_only",
    generated_at: t.generatedAt,
    published_at: x.publishedAt,
    data_only_published_at: x.publishedAt,
    late: false,
    data_cutoff_utc: t.cutoff,
    lead: [],
    angle: null,
    regions: regionsFor(day, items, sources, x.history, []),
    gap: gapOf(m, x.metricsText),
    items,
    actors_seen: [],
    taiwan_lens: {
      analysis: "", item_ids: [], source_ids: [],
      rows: TAIWAN_LENS_ROWS.map((row) => ({ row, text: null, item_ids: [], source_ids: [] })),
      japan: { text: null, item_ids: [], source_ids: [] },
      ...lensScript(m, t.date),
    },
    scoreboard: { entries: [...x.entries], last: x.last },
    week_in_review: null,
    corrections: [...x.corrections],
    elsewhere: [],
    epss_movers: [...m.epss_movers],
    feeds_stale: x.feedsStale,
    sources,
    computed: { word_count: 0, reading_minutes: 0, item_count: 0, ai_linked: { linked: 0, total: 0 }, source_count: 0, publisher_count: 0 },
  };
  b.computed = computedOf(b, m);
  return Brief.parse(b);
}

// ── Corrections, the Scoreboard and withholding ──────────────────────────────────────────────────

const WITHHOLD_DATE = "2026-10-13";
const POLICY_SUMMARY_AFTER = "The National Police Agency published guidelines on when officers may access and disable servers used in attacks on Japan, under the active cyber defence law, whose measures take effect in stages through 2027.";

function corrections(monday: Brief): Correction[] {
  const policy = monday.items.find((it) => it.id === MONDAY_ITEMS.policy)!;
  return [
    {
      id: "C-0001", date: WITHHOLD_DATE, item_id: MONDAY_ITEMS.confirmedBreach, edition_date: monday.date, type: "name_removed",
      field: "incident.victim", before: "[name removed]", after: "withheld while a dispute about a named party is reviewed",
      reason: "SAMPLE. A reader disputed the naming of the company, so the item is withheld while the dispute is reviewed.",
      source_url: null, trigger: "reader_report", dispute_id: "D-0001",
    },
    {
      id: "C-0002", date: WITHHOLD_DATE, item_id: policy.id, edition_date: monday.date, type: "clarification",
      field: "summary", before: policy.summary, after: POLICY_SUMMARY_AFTER,
      reason: "SAMPLE. The law's measures start in stages; the guidelines cover only police access to attack servers.",
      source_url: SOURCES["npa-guidelines"].url, trigger: "editor", dispute_id: null,
    },
  ];
}

const DISPUTES: readonly Dispute[] = [{
  id: "D-0001", received: "2026-10-12T21:14:05+08:00", issue_number: 3, item_id: MONDAY_ITEMS.confirmedBreach, edition_date: "2026-10-12",
  kind: "victim", evidence_url: null, status: "open", resolved_on: null, correction_id: "C-0001",
}];

/**
 * §4.10's one exception: a victim dispute withholds the item at once. The archived brief's item text and
 * victim go, `withheld` is set, Lead, Angle and Lens text citing the item becomes "[withheld]", and so do
 * the region row reasons and raise reasons that list it (a reason embeds the item's headline, §5.11) and
 * the titles of sources only that item cites; computed is recounted.
 */
function withhold(b: Brief, itemId: string, correctionId: string, since: string, m: Metrics): Brief {
  const out = structuredClone(b);
  const it = out.items.find((x) => x.id === itemId)!;
  it.headline = WITHHELD_HEADLINE;
  it.summary = WITHHELD_TEXT.replace("{date}", longDate(since));
  it.why_it_matters = null;
  if (it.incident) it.incident.victim = null;
  it.withheld = { correction_id: correctionId, since };
  for (const l of out.lead) if (l.item_ids.includes(itemId)) l.text = WITHHELD_MARK;
  const lens = out.taiwan_lens;
  if (lens.item_ids.includes(itemId)) lens.analysis = WITHHELD_MARK;
  for (const r of lens.rows) if (r.item_ids.includes(itemId)) r.text = WITHHELD_MARK;
  if (lens.japan.item_ids.includes(itemId)) lens.japan.text = WITHHELD_MARK;
  for (const r of out.regions.rows) {
    if (r.item_ids.includes(itemId)) r.reason = WITHHELD_MARK;
    if (r.raised?.item_ids.includes(itemId)) r.raised.reason = WITHHELD_MARK;
  }
  const others =out.items.filter((x) => x.id !== itemId).flatMap((x) => [...x.source_ids, ...x.flaw_evidence.map((f) => f.source_id), ...(x.incident?.status_source_ids ?? [])]);
  const elsewhere = [
    ...out.elsewhere.map((e) => e.source_id), ...(out.angle?.source_id ? [out.angle.source_id] : []), ...(out.angle?.counterpoint_source_ids ?? []),
    ...(out.week_in_review?.strongest_against.source_ids ?? []), ...lens.source_ids, ...lens.rows.flatMap((r) => r.source_ids), ...lens.japan.source_ids,
  ];
  for (const s of out.sources) {
    if (!it.source_ids.includes(s.id) || others.includes(s.id) || elsewhere.includes(s.id)) continue;
    s.title = WITHHELD_MARK;
    if (s.title_en !== null) s.title_en = WITHHELD_MARK;
  }
  out.computed = computedOf(out, m);
  return Brief.parse(out);
}

const CLAIM_SB01_ENTRY = "SAMPLE. First reading: the base-rate ratio has no value yet, because no AI-credited flaw since 2025 has reached CISA's list.";

/** The claims' state on an edition date (§4.9): SB-01 has no reading yet; SB-02 is judged by reports. */
function claimStates(entries: readonly ScoreboardEntry[]): ClaimState[] {
  return cfg().claims.claims.map((c) => ({
    id: c.id, text: c.text, status: c.resolution?.status ?? "open", zone: "no_reading", reading: null, reading_text: null, reading_as_of: null,
    last_entry_id: [...entries].reverse().find((e) => e.claim_id === c.id)?.id ?? null,
  }));
}

/** The Scoreboard entries an edition creates: SB-01's first reading on the first edition, then each report entry. */
function newEntries(day: Day, numberFrom: number, isFirst: boolean): ScoreboardEntry[] {
  const sources = day.draft?.sources ?? [];
  const out: ScoreboardEntry[] = [];
  const id = () => `SE-${String(numberFrom + out.length).padStart(4, "0")}`;
  if (isFirst) {
    out.push({
      id: id(), date: day.t.date, claim_id: "SB-01", origin: "metric", direction: "neutral", summary: CLAIM_SB01_ENTRY, value: null,
      reported_value: null, quote: null, claim_type: null, source_url: null, metrics_ref: { file: `metrics/${day.t.date}.json`, path: "base_rate.ratio" },
    });
  }
  for (const e of day.draft?.scoreboard_entries ?? []) {
    const meets = e.meets;
    const direction = e.claim_type === "self_reported" || meets === null ? "neutral" : meets;
    out.push({
      id: id(), date: day.t.date, claim_id: e.claim_id, origin: "report", direction, summary: e.summary, value: null,
      reported_value: e.reported_value, quote: e.quote, claim_type: e.claim_type,
      source_url: sources.find((s) => s.id === e.quote_source_id)?.url ?? null, metrics_ref: null,
    });
  }
  return out;
}

// ── The archive index and state ──────────────────────────────────────────────────────────────────

const KEY_BY_URL = new Map((Object.keys(SOURCES) as SourceKey[]).map((k) => [normalizeUrl(SOURCES[k].url), k]));

function archiveIndex(briefs: readonly Brief[], corrections: readonly Correction[]): ArchiveIndex {
  const urls: Record<string, ArchiveUrl> = {};
  for (const b of briefs) {
    for (const s of b.sources) {
      const u = normalizeUrl(s.url);
      const key = KEY_BY_URL.get(u);
      const entry = urls[u] ??= {
        first_cited: b.date, item_ids: [], sha256: key ? sha256(seenText(key)) : null, hashed_at: key ? b.generated_at : null, last_check: null,
      };
      for (const it of b.items) if (it.source_ids.includes(s.id)) entry.item_ids.push(`${b.date}/${it.id}`);
      entry.item_ids = entry.item_ids.slice(-20);
    }
  }
  const last = briefs.at(-1)!.date;
  for (const entry of Object.values(urls)) entry.last_check = { date: last, result: "ok", http: 200 };
  return ArchiveIndex.parse({
    schema_version: 1,
    editions: [...briefs].reverse().map((b) => ({
      date: b.date, edition: b.edition, published_at: b.published_at, item_count: b.items.length,
      corrected: corrections.some((c) => c.edition_date === b.date),
    })),
    urls,
  });
}

// ── Build ────────────────────────────────────────────────────────────────────────────────────────

export interface SiteContent {
  /** Path inside the content folder → the file's text. */
  files: Map<string, string>;
  briefs: Brief[];
}

function buildSite(): SiteContent {
  const files = new Map<string, string>();
  const days = buildDays();
  const briefs: Brief[] = [];
  const metricsByDate = new Map<string, Metrics>();
  const entries: ScoreboardEntry[] = [];
  let allCorrections: Correction[] = [];

  days.forEach((day, i) => {
    const t = day.t;
    const metrics0 = metricsFor(t);
    const manifest = manifestFor(t, metrics0);
    const manifestText = contentText(manifest, InputsManifest);
    const metrics = Metrics.parse({ ...metrics0, provenance: { ...metrics0.provenance, inputs_sha256: sha256(manifestText) } });
    const metricsText = contentText(metrics, Metrics);
    metricsByDate.set(t.date, metrics);
    files.set(`metrics/inputs/${t.date}.json`, manifestText);
    files.set(`metrics/${t.date}.json`, metricsText);

    const run = day.run;
    const publishedAt = ts(t.date, (day.edition === "data_only" ? run.dataOnlyAt : run.fullAt)!);
    const dataOnlyAt = ts(t.date, run.dataOnlyAt!);
    if (t.date === WITHHOLD_DATE) {
      // 13 October: dispute intake withholds the Monday breach item in its archived brief before this
      // morning's edition is built, so this edition and later ones read the rewritten history (§8.2 stage 5).
      const mi = briefs.findIndex((b) => b.date === "2026-10-12");
      allCorrections = corrections(briefs[mi]!);
      briefs[mi] = withhold(briefs[mi]!, MONDAY_ITEMS.confirmedBreach, "C-0001", WITHHOLD_DATE, metricsByDate.get("2026-10-12")!);
    }
    const todays = allCorrections.filter((c) => c.date === t.date);
    const last = entries.at(-1) ?? null;
    const claimText = (id: string) => cfg().claims.claims.find((c) => c.id === id)!.text;
    const created = newEntries(day, entries.length + 1, i === 0);
    entries.push(...created);
    const ctx: BriefContext = {
      day, metrics, metricsText, manifest, history: briefs, corrections: todays, entries: created,
      last: last ? { entry_id: last.id, date: last.date, claim_id: last.claim_id, claim_text: claimText(last.claim_id) } : null,
      claims: claimStates(entries.slice(0, entries.length - created.length)),
      publishedAt, dataOnlyAt,
      feedsStale: (run.failedFeeds ?? []).map((f) => ({
        id: f.id, name: cfg().sources.feeds.find((x) => x.id === f.id)!.name, status: f.status, newest: f.newest, stale_since: f.since,
      })),
    };
    briefs.push(day.edition === "data_only" ? dataOnly(ctx) : freezeDraft(ctx));
    files.set(`status/${t.date}.json`, contentText({ schema_version: 1, date: t.date, runs: [runRecord(t, run)] }, StatusFile));
  });

  for (const b of briefs) files.set(`briefs/${b.date}.json`, contentText(b, Brief));

  const failed = failedMorning();
  files.set(`status/${failed.t.date}.json`, contentText({ schema_version: 1, date: failed.t.date, runs: [runRecord(failed.t, failed.run)] }, StatusFile));

  const lastDate = briefs.at(-1)!.date;
  files.set("scoreboard.json", contentText({
    schema_version: 1, as_of: lastDate, claims_version: cfg().claims.version, claims: claimStates(entries), entries,
  }, ScoreboardFile));
  files.set("corrections.json", contentText({ schema_version: 1, corrections: allCorrections, disputes: DISPUTES }, CorrectionsFile));
  files.set("archive-index.json", contentText(archiveIndex(briefs, allCorrections), ArchiveIndex));

  const lastT = days.at(-1)!.t;
  files.set("state/kev-index.json", contentText({
    schema_version: 1, updated_at: lastDate, catalog_version: lastT.kev.version, entries: kevThrough(lastT.kev.version),
  }, KevIndexFile));
  files.set("state/credit-candidates.json", contentText({
    schema_version: 1, updated_at: lastDate, prefilter_sha256: sha256(cfg().aiFinders.prefilter), candidates: [],
  }, CreditCandidatesFile));
  files.set("state/anthropic-cvd.json", contentText({
    schema_version: 1, updated_at: lastDate, revision: null, as_of: null, fetched_at: null, source_url: null,
    found_n: null, disclosed_n: null, patched_n: null, ledger_ids: [],
  }, AnthropicCvdFile));
  files.set("README.md", SITE_README);
  return { files, briefs };
}

const SITE_README = `# SAMPLE content

Invented SAMPLE editions from 6 to 15 October 2026, with the status file of a failed morning on 16 October,
for the site previews (\`npm run dev:sample\`), \`npm run validate:sample\` and the tests. Built by
\`npm run fixtures:gen\` from \`fixtures/src/site.ts\`; do not edit by hand. The claims they cite, SB-01 and
SB-02, are the SAMPLE claims in \`fixtures/config/claims.json\`.
`;

const EMPTY_README = `# Empty content

An empty content folder for the site's empty states and the end-to-end tests. It holds only this file.
`;

let site: SiteContent | null = null;
/** The sample content, built once (fresh copies of the briefs on each call). */
export function siteContent(): SiteContent {
  site ??= buildSite();
  return { files: new Map(site.files), briefs: structuredClone(site.briefs) };
}

/** The sample edition of each date, oldest first. */
export const SITE_EDITIONS: Readonly<Record<string, Edition>> = {
  "2026-10-06": "data_only", "2026-10-07": "data_only", "2026-10-08": "data_only",
  "2026-10-09": "data_only", "2026-10-10": "data_only", "2026-10-11": "full", "2026-10-12": "full",
  "2026-10-13": "partial", "2026-10-14": "full", "2026-10-15": "data_only",
};
/** The date with a status file and no brief (E_METRICS). */
export const SITE_FAILED_DATE = "2026-10-16";

export function siteOutputs(): Output[] {
  const { files } = siteContent();
  const out: Output[] = [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, text]) => ({ path: `${SITE_CONTENT_DIR}/${p}`, text }));
  out.push({ path: `${EMPTY_CONTENT_DIR}/README.md`, text: EMPTY_README });
  return out;
}
