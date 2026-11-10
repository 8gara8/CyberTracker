// The publish tests' world (plan §1 L2, §4): fixtures/site-content as it stood before an edition D, seeded
// into the shared harness's clone, and fake composers that return site-content's own files for D, so
// validateAll() inside publish stays real while lib/apply.ts, lib/data-only.ts and lib/withhold.ts (lane
// L3) are not used. The integration lane reruns P3b and P13 with the real composers (I-P3, I-P13).
//
// The world before D: every dated file after D left out; no briefs/D.json or status/D.json; D's metrics
// and inputs moved to cache/staged/D/ (with site-content's kev-index.json as a staged state file); D's
// archive-index edition and its url references, D's Scoreboard entries and the corrections dated D
// removed. The clone's config/claims.json becomes the SAMPLE claims site-content cites (SB-01, SB-02), so
// validateAll() with the clone's config resolves them. content/state/ stays the harness's (fixtures/state).
// Everything here is test data; nothing reaches the network.
import fs from "node:fs";
import path from "node:path";
import { SAMPLE_CLAIMS_FILE, loadCheckedConfig, type LoadedConfig } from "@/lib/config";
import type { ContentChanges } from "@/lib/apply";
import type { DataOnlyInput } from "@/lib/data-only";
import type { ApplyInput } from "@/lib/apply";
import { addDays, at, isValidDate, taipeiDateOf } from "@/lib/dates";
import { longDate } from "@/lib/format";
import { jsonText } from "@/lib/json";
import { READING_WORDS_PER_MINUTE, aiLinkedOf } from "@/lib/rules/computed";
import { pageWords } from "@/lib/rules/words";
import { Brief } from "@/lib/schema/brief";
import { Metrics } from "@/lib/schema/metrics";
import { ArchiveIndex, CorrectionsFile, type Correction, type Dispute } from "@/lib/schema/misc";
import { ScoreboardFile } from "@/lib/schema/scoreboard";
import { StatusFile, type RunRecord } from "@/lib/schema/status";
import { RUN_STAGES, WITHHELD_HEADLINE, WITHHELD_MARK, WITHHELD_TEXT } from "@/lib/vocab";
import type { WithholdInput } from "@/lib/withhold";
import { runPaths } from "@/scripts/lib/paths";
import { REPO, type Harness } from "./harness";

/** fixtures/site-content in this repository. */
export const SITE = path.join(REPO, "fixtures", "site-content");

/** The two editions the publish tests start from (the plan's D = 2026-10-15 and 2026-10-14). */
export const WORLD_DATES = ["2026-10-15", "2026-10-14"] as const;

const DATED_RE = /^(briefs|metrics|metrics\/inputs|status)\/(\d{4}-\d{2}-\d{2})\.json$/;

/** site-content's files, path inside the content folder → text; README.md and state/ left out. */
function siteTree(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(SITE, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (r !== "README.md" && !r.startsWith("state/")) out.set(r, fs.readFileSync(path.join(SITE, r), "utf8"));
    }
  };
  walk("");
  return out;
}

const readSite = (rel: string) => JSON.parse(fs.readFileSync(path.join(SITE, rel), "utf8")) as unknown;

/** Brief dates in site-content, oldest first. */
function siteBriefDates(): string[] {
  return fs.readdirSync(path.join(SITE, "briefs")).map((n) => n.replace(/\.json$/, "")).filter(isValidDate).sort();
}

/** site-content's brief for D. */
export function siteBrief(date: string): Brief {
  return Brief.parse(readSite(`briefs/${date}.json`));
}

/** site-content's metrics/D.json text (Brief.gap.metrics_sha256 is its hash). */
export function siteMetricsText(date: string): string {
  return fs.readFileSync(path.join(SITE, "metrics", `${date}.json`), "utf8");
}

/** The archive index as it stood after the edition of `last`: later editions and url references left out. */
function archiveThrough(last: string, corrections: readonly Correction[]): ArchiveIndex {
  const ix = ArchiveIndex.parse(readSite("archive-index.json"));
  const urls: ArchiveIndex["urls"] = {};
  for (const [u, e] of Object.entries(ix.urls)) {
    if (e.first_cited > last) continue;
    urls[u] = { ...e, item_ids: e.item_ids.filter((id) => id.slice(0, 10) <= last) };
  }
  return ArchiveIndex.parse({
    schema_version: 1,
    editions: ix.editions.filter((e) => e.date <= last).map((e) => ({ ...e, corrected: corrections.some((c) => c.edition_date === e.date) })),
    urls,
  });
}

function correctionsThrough(last: string): CorrectionsFile {
  const cf = CorrectionsFile.parse(readSite("corrections.json"));
  return {
    schema_version: 1,
    corrections: cf.corrections.filter((c) => c.date <= last),
    disputes: cf.disputes.filter((d) => taipeiDateOf(d.received) <= last),
  };
}

function scoreboardThrough(last: string): ScoreboardFile {
  const sb = ScoreboardFile.parse(readSite("scoreboard.json"));
  const entries = sb.entries.filter((e) => e.date <= last);
  const briefs = siteBriefDates().filter((d) => d <= last);
  return ScoreboardFile.parse({
    ...sb,
    as_of: briefs.at(-1) ?? sb.as_of,
    claims: sb.claims.map((c) => ({ ...c, last_entry_id: [...entries].reverse().find((e) => e.claim_id === c.id)?.id ?? null })),
    entries,
  });
}

/** The content folder's files as they stood after the edition of `last` (status files dated after it left out too). */
function treeThrough(last: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [rel, text] of siteTree()) {
    const m = DATED_RE.exec(rel);
    if (m && m[2]! > last) continue;
    if (!m && rel !== "archive-index.json" && rel !== "corrections.json" && rel !== "scoreboard.json") out.set(rel, text);
    else if (m) out.set(rel, text);
  }
  const corrections = correctionsThrough(last);
  out.set("corrections.json", jsonText(corrections, CorrectionsFile));
  out.set("archive-index.json", jsonText(archiveThrough(last, corrections.corrections), ArchiveIndex));
  out.set("scoreboard.json", jsonText(scoreboardThrough(last), ScoreboardFile));
  return out;
}

/**
 * The files the edition of D changes, as site-content holds them after D: the brief, the Scoreboard,
 * corrections.json and the archive index through D. What the fake composers start from.
 */
export function siteFiles(date: string): ContentChanges {
  if (!siteBriefDates().includes(date)) throw new Error(`siteFiles: site-content has no brief for ${date}`);
  const corrections = correctionsThrough(date);
  return {
    brief: siteBrief(date),
    rewritten: [],
    scoreboard: scoreboardThrough(date),
    corrections,
    archiveIndex: archiveThrough(date, corrections.corrections),
    flagCorrections: [],
  };
}

/** The content folder before the edition of D, path → text (no briefs/D.json, status/D.json or metrics for D). */
export function treeBefore(date: string): Map<string, string> {
  const dates = siteBriefDates();
  if (!dates.includes(date)) throw new Error(`treeBefore: site-content has no brief for ${date}`);
  const cf = CorrectionsFile.parse(readSite("corrections.json"));
  if (cf.corrections.some((c) => c.date === date && c.type === "name_removed")) {
    throw new Error(`treeBefore: a withhold dated ${date} rewrote an archived brief; that world cannot be undone here`);
  }
  const prev = addDays(date, -1);
  const out = treeThrough(prev);
  // The status file of a date with no brief (a failed morning) dated before D stays; nothing dated D is kept.
  return out;
}

/** The staged files for D (cache/staged/D/ in runMetrics()'s layout): D's metrics and inputs, and site-content's kev-index.json. */
export function stagedFiles(date: string): Map<string, string> {
  return new Map([
    [`metrics/${date}.json`, siteMetricsText(date)],
    [`metrics/inputs/${date}.json`, fs.readFileSync(path.join(SITE, "metrics", "inputs", `${date}.json`), "utf8")],
    ["state/kev-index.json", fs.readFileSync(path.join(SITE, "state", "kev-index.json"), "utf8")],
  ]);
}

function writeTree(dir: string, files: ReadonlyMap<string, string>): void {
  for (const [rel, text] of files) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

/**
 * The harness seed (makeHarness({ seed: (h) => beforeEdition(h, D) })): writes the content folder before
 * D into h.root/content (state/ stays the harness's), stages D's metrics, inputs and kev-index.json in
 * cache/staged/D/ (gitignored, so outside the seed commit) and puts the SAMPLE claims in config/claims.json.
 * Returns siteFiles(D).
 */
export function beforeEdition(h: Harness, date: string): ContentChanges {
  writeTree(path.join(h.root, "content"), treeBefore(date));
  writeTree(runPaths(h.root, date).staged, stagedFiles(date));
  fs.copyFileSync(path.join(REPO, SAMPLE_CLAIMS_FILE), path.join(h.root, "config", "claims.json"));
  return siteFiles(date);
}

/** The run config publish gets in these tests: the clone's config/, the SAMPLE claims included. */
export function worldConfig(h: Harness): LoadedConfig {
  return loadCheckedConfig({ root: h.root });
}

// ── Run records ──────────────────────────────────────────────────────────────────────────────────────

/** "2026-10-15T04:37:02+08:00" → "20261015-043702". */
export function runIdOf(startedAt: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+08:00$/.exec(startedAt);
  if (!m) throw new Error(`runIdOf: expected a +08:00 timestamp, got ${startedAt}`);
  return `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}`;
}

/**
 * A run record as a run opens it (scripts/lib/status.ts newRunRecord() is lane L6's; this one is the
 * tests' own): every stage skipped, no outcome, no feeds; `over` sets any field.
 */
export function testRecord(date: string, startedAt: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: runIdOf(startedAt),
    trigger: "schedule",
    attempt: 1,
    started_at: startedAt,
    finished_at: null,
    outcome: null,
    edition: null,
    error_code: null,
    code_commit: "0".repeat(40),
    data_cutoff_utc: addDays(date, -2),
    data_only_published_at: null,
    full_published_at: null,
    late: false,
    stages: RUN_STAGES.map((id) => ({ id, status: "skipped" as const, started_at: null, ended_at: null, note: null })),
    feeds: [],
    budgets: { agent_seconds: 0, web_fetches: 0, web_searches: 0, repair_rounds: 0, tokens_in: null, tokens_out: null, usage: null, safety_stops: 0 },
    candidates: null,
    validation: null,
    soft_gates: null,
    deploy: { triggered: false, ready_at: null, shows_date: null, shows_edition: null },
    recheck: null,
    links: null,
    ...over,
  };
}

/** status/D.json's text holding these records (as publish writes it). */
export function statusText(date: string, runs: readonly RunRecord[]): string {
  return jsonText({ schema_version: 1, date, runs }, StatusFile);
}

// ── Fake composers ───────────────────────────────────────────────────────────────────────────────────

/** The newest edition first; D's entry replaced or added; D's url references from site-content merged in. */
function archiveWith(base: ArchiveIndex | null, date: string, brief: Brief, corrections: readonly Correction[]): ArchiveIndex {
  const site = archiveThrough(date, corrections);
  const out: ArchiveIndex = structuredClone(base ?? { schema_version: 1, editions: [], urls: {} });
  out.editions = [
    ...out.editions.filter((e) => e.date !== date),
    { date, edition: brief.edition, published_at: brief.published_at, item_count: brief.items.length, corrected: corrections.some((c) => c.edition_date === date) },
  ].sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const [u, e] of Object.entries(site.urls)) {
    const mine = e.item_ids.filter((id) => id.startsWith(`${date}/`));
    if (e.first_cited !== date && mine.length === 0) continue;
    const have = out.urls[u];
    if (!have) out.urls[u] = { ...e, item_ids: e.item_ids.filter((id) => id.slice(0, 10) <= date) };
    else have.item_ids = [...have.item_ids, ...mine.filter((id) => !have.item_ids.includes(id))].slice(-20);
  }
  for (const e of out.editions) e.corrected = e.corrected || corrections.some((c) => c.edition_date === e.date);
  return ArchiveIndex.parse(out);
}

/**
 * A full or partial brief turned into a data-only one, for a date whose site edition is full (P3b): the
 * edition changed, every item's AI fields unassessed (AI_UNASSESSED), computed recounted.
 */
function asDataOnly(b: Brief): Brief {
  const out: Brief = { ...structuredClone(b), edition: "data_only" };
  for (const it of out.items) {
    it.ai_role = "unassessed";
    it.ai_role_secondary = null;
    it.ai_confidence = null;
    it.ai_claimant = null;
    it.ai_evidence = [];
  }
  out.computed = computedOf(out, Metrics.parse(JSON.parse(siteMetricsText(b.date))));
  return Brief.parse(out);
}

const lateOf = (b: Pick<Brief, "date" | "published_at">) => Date.parse(b.published_at) > at(b.date, "08:00");

/** `late` from the new published_at, and computed recounted when it changed (a late notice adds words). */
function retime(b: Brief): void {
  const late = lateOf(b);
  if (late === b.late) return;
  b.late = late;
  b.computed = computedOf(b, Metrics.parse(JSON.parse(siteMetricsText(b.date))));
}

export interface FakeComposers {
  composeDataOnly: (i: DataOnlyInput) => ContentChanges;
  applyDraft: (i: ApplyInput) => ContentChanges;
  composeWithholds: (i: WithholdInput) => ContentChanges;
  /** Every input each fake received, in order (the spies of P3b). */
  calls: { dataOnly: DataOnlyInput[]; apply: ApplyInput[]; withholds: WithholdInput[] };
}

/**
 * Composers returning siteFiles(D), timed by publish: the brief's published_at (and the archive edition's)
 * become the input's publishedAt, data_only_published_at follows the input, and `late` (with computed,
 * when it changes) is recomputed.
 * composeDataOnly turns a full site brief into a data-only one when D's site edition is full (P3b);
 * applyDraft refuses a date whose site edition is data-only. composeWithholds rewrites each requested item
 * as §4.10 says (the test-only form of fixtures/src/site.ts's withhold()).
 */
export function fakeComposers(date: string): FakeComposers {
  const calls: FakeComposers["calls"] = { dataOnly: [], apply: [], withholds: [] };
  return {
    calls,
    composeDataOnly(i) {
      calls.dataOnly.push(i);
      const site = siteFiles(date);
      const b0 = site.brief!.edition === "data_only" ? site.brief! : asDataOnly(site.brief!);
      const brief = Brief.parse({ ...b0, published_at: i.publishedAt, data_only_published_at: i.publishedAt });
      retime(brief);
      const corrections = i.corrections?.corrections ?? [];
      return { brief, rewritten: [], scoreboard: null, corrections: null, archiveIndex: archiveWith(i.archiveIndex, date, brief, corrections), flagCorrections: [] };
    },
    applyDraft(i) {
      calls.apply.push(i);
      const site = siteFiles(date);
      if (site.brief!.edition === "data_only") throw new Error(`fakeComposers: site-content's ${date} is a data-only edition; there is no full brief to return`);
      const brief = Brief.parse({ ...site.brief!, published_at: i.publishedAt, data_only_published_at: i.dataOnlyPublishedAt });
      retime(brief);
      const corrections = i.corrections?.corrections ?? [];
      return { brief, rewritten: [], scoreboard: site.scoreboard, corrections: null, archiveIndex: archiveWith(i.archiveIndex, date, brief, corrections), flagCorrections: [] };
    },
    composeWithholds(i) {
      calls.withholds.push(i);
      return withholdItems(i);
    },
  };
}

/** computed (§4.5) recounted against the brief's same-date metrics. */
function computedOf(b: Brief, m: Metrics | null): Brief["computed"] {
  const words = pageWords(b, m);
  return {
    word_count: words, reading_minutes: Math.ceil(words / READING_WORDS_PER_MINUTE), item_count: b.items.length,
    ai_linked: aiLinkedOf(b.items), source_count: b.sources.length, publisher_count: new Set(b.sources.map((s) => s.publisher)).size,
  };
}

/** §4.10's rewrite of one item, victim or attribution (the test-only form of site.ts's withhold()). */
function rewrite(b: Brief, itemId: string, kind: "victim" | "attribution", correctionId: string, since: string, m: Metrics | null, target: boolean): Brief {
  const out = structuredClone(b);
  for (const r of out.regions.rows) {
    if (r.item_ids.includes(itemId)) r.reason = WITHHELD_MARK;
    if (r.raised?.item_ids.includes(itemId)) r.raised.reason = WITHHELD_MARK;
  }
  if (target) {
    const it = out.items.find((x) => x.id === itemId);
    if (!it) throw new Error(`withholdItems: ${itemId} is not in briefs/${b.date}.json`);
    it.headline = WITHHELD_HEADLINE;
    it.summary = WITHHELD_TEXT.replace("{date}", longDate(since));
    it.why_it_matters = null;
    if (kind === "victim" && it.incident) it.incident.victim = null;
    if (kind === "attribution") {
      it.attribution = [];
      it.actor_nexus = null;
    }
    it.withheld = { correction_id: correctionId, since };
    for (const l of out.lead) if (l.item_ids.includes(itemId)) l.text = WITHHELD_MARK;
    const lens = out.taiwan_lens;
    if (lens.item_ids.includes(itemId)) lens.analysis = WITHHELD_MARK;
    for (const r of lens.rows) if (r.item_ids.includes(itemId)) r.text = WITHHELD_MARK;
    if (lens.japan.item_ids.includes(itemId)) lens.japan.text = WITHHELD_MARK;
    const others = out.items.filter((x) => x.id !== itemId).flatMap((x) => [...x.source_ids, ...x.flaw_evidence.map((f) => f.source_id), ...(x.incident?.status_source_ids ?? [])]);
    const elsewhere = [
      ...out.elsewhere.map((e) => e.source_id), ...(out.angle?.source_id ? [out.angle.source_id] : []), ...(out.angle?.counterpoint_source_ids ?? []),
      ...(out.week_in_review?.strongest_against.source_ids ?? []), ...lens.source_ids, ...lens.rows.flatMap((r) => r.source_ids), ...lens.japan.source_ids,
    ];
    for (const s of out.sources) {
      if (!it.source_ids.includes(s.id) || others.includes(s.id) || elsewhere.includes(s.id)) continue;
      s.title = WITHHELD_MARK;
      if (s.title_en !== null) s.title_en = WITHHELD_MARK;
    }
  }
  out.computed = computedOf(out, m);
  return Brief.parse(out);
}

/** One name_removed correction per request, continuing the C-NNNN ids; the briefs rewritten; the disputes given their correction ids. */
function withholdItems(i: WithholdInput): ContentChanges {
  const corrections = structuredClone(i.corrections?.corrections ?? []);
  const disputes: Dispute[] = structuredClone([...i.disputes]);
  const briefs = new Map(i.briefs.map((b) => [b.date, structuredClone(b)]));
  const touched = new Set<string>();
  let n = corrections.reduce((max, c) => Math.max(max, Number(c.id.slice(2))), 0);
  for (const r of i.requests) {
    const id = `C-${String(++n).padStart(4, "0")}`;
    corrections.push({
      id, date: i.date, item_id: r.item_id, edition_date: r.edition_date, type: "name_removed",
      field: r.kind === "victim" ? "incident.victim" : "attribution", before: "[name removed]",
      after: "withheld while a dispute about a named party is reviewed",
      reason: "A reader disputed the naming of a party, so the item is withheld while the dispute is reviewed.",
      source_url: null, trigger: "reader_report", dispute_id: r.dispute_id,
    });
    const d = disputes.find((x) => x.id === r.dispute_id);
    if (d) d.correction_id = id;
    for (const [date, b] of briefs) {
      if (date < r.edition_date) continue;
      const target = date === r.edition_date;
      const lists = target || b.regions.rows.some((row) => row.item_ids.includes(r.item_id) || row.raised?.item_ids.includes(r.item_id));
      if (!lists) continue;
      briefs.set(date, rewrite(b, r.item_id, r.kind, id, r.since, i.metricsFor(date), target));
      touched.add(date);
    }
  }
  corrections.sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));
  const rewritten = [...touched].sort().map((d) => briefs.get(d)!);
  const archive = structuredClone(i.archiveIndex ?? { schema_version: 1 as const, editions: [], urls: {} });
  for (const e of archive.editions) e.corrected = corrections.some((c) => c.edition_date === e.date);
  return {
    brief: null,
    rewritten,
    scoreboard: null,
    corrections: CorrectionsFile.parse({ schema_version: 1, corrections, disputes }),
    archiveIndex: ArchiveIndex.parse(archive),
    flagCorrections: [],
  };
}

/** A victim dispute on the 2026-10-14 breach item (its victim is already null, so the rewrite is all §4.10 checks). */
export function victimDispute(o: { id?: string; issue?: number; received?: string } = {}): Dispute {
  return {
    id: o.id ?? "D-0002", received: o.received ?? "2026-10-15T03:12:40+08:00", issue_number: o.issue ?? 4,
    item_id: "inc-transport-jp-2026-10", edition_date: "2026-10-14", kind: "victim", evidence_url: null,
    status: "open", resolved_on: null, correction_id: null,
  };
}
