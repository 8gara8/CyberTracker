// AI-credited CVE records (SPEC §5.5): matching credit strings against config/ai-finders.json, the two
// credit state files, and the metrics values that read them. Pure: no clock, file, network or randomness.
// matchCredit() itself stays in lib/config.ts (one implementation, which the config examples check also
// runs); this module re-exports it (ruling R9). Every credit string is sanitised (§4.14) before it is
// matched or stored (ruling R1), so a rematch from credit-candidates.json equals a match from records.

import { matchCredit, type AiCreditMatch, type CompiledAiFinders, type CompiledConfig, type LoadedConfig } from "../config";
import { addDays, daysBetween, inRange, isoWeekStart, newestCompleteWeek, windowEnding } from "../dates";
import type { CreditString } from "../feeds/types";
import { compareCveIds, compareIds } from "../ids";
import { sha256Hex } from "../json";
import { sanitize } from "../sanitize";
import type { AiCredit } from "../schema/item";
import type {
  AiCredited, AiCreditRow, AiCreditsFile, BaseRate, CreditCandidateRow, CreditCandidatesFile, DayRow, InputsManifest,
  KevIndexRow, Series,
} from "../schema/metrics";
import { FINDER_FAMILIES, MIN_N, type FinderFamily } from "../vocab";
import { poissonCi80, round4 } from "./stats";

export { matchCredit } from "../config";
export type { AiCreditMatch } from "../config";

/** The three credit fields, in the canonical order candidate rows are stored in (ruling R7). */
export type CreditSourceField = "cna.credits" | "adp.credits" | "ghsa.credits";
export const CREDIT_FIELD_ORDER: readonly CreditSourceField[] = ["cna.credits", "adp.credits", "ghsa.credits"];

/** One record's match: matchCredit()'s result plus the field it came from (§5.5 AiCreditHit). */
export type AiCreditHit = AiCreditMatch & { field: CreditSourceField };

/**
 * Where GitHub advisory credits come from (§5.5, §10 P2 item 4). "git": never read (the git export carries
 * no credits), so `ghsa.credits` is skipped and callers pass no GHSA credit sources.
 */
export const GHSA_CREDIT_SOURCE: "git" | "rest" = "git";

/** What a ledger-only row (rule and field "cvd_ledger", ruling R6) stores as `matched`. */
export const LEDGER_MATCHED = "Anthropic disclosure ledger";

/** The AI-credited on KEV span starts here (§4.7 `in_kev.since`, `BaseRate.since`). */
const KEV_SINCE = "2025-01-01";
/** `matched` is at most this long (§4.7). */
const MATCHED_MAX = 120;
/** The base rate's follow-up (§5.5). */
const FOLLOW_UP_DAYS = 90;

const CVE_ID_RE = /^CVE-\d{4}-\d{4,}$/;

// ── The run's list ───────────────────────────────────────────────────────────────────────────────

/** The parts of the config a credit run needs: compiled regexes, the list version and the file's SHA-256. */
export interface AiFindersRun {
  compiled: CompiledAiFinders;
  version: number;
  sha256: string;
}

export function aiFindersOf(config: LoadedConfig, compiled: CompiledConfig): AiFindersRun {
  return { compiled: compiled.aiFinders, version: config.aiFinders.version, sha256: config.sha256.aiFinders };
}

/** SHA-256 of the prefilter string's UTF-8 bytes (ruling R7). */
export function prefilterSha256(prefilter: string): string {
  return sha256Hex(prefilter);
}

// ── Matching ─────────────────────────────────────────────────────────────────────────────────────

/** Structural, so CveFacts and CveRecord both fit. `credits` are raw, CNA array order, then each ADP entry's. */
export interface CreditRecord {
  cve_id: string;
  state: string;
  date_published: string | null;
  credits: readonly CreditString[];
}

/** One GitHub-reviewed advisory's credits (REST logins); never built from the git export. */
export interface GhsaCreditSource {
  id: string;
  cve_ids: readonly string[];
  published: string;
  credits: readonly string[];
}

/** One sanitised credit string and its field. */
export interface CreditText {
  field: CreditSourceField;
  text: string;
}

/**
 * The record's sanitised credit strings in canonical field order (CNA, ADP, then GHSA), array order
 * within a field. GHSA strings only when `ghsa` is given.
 */
export function creditTexts(rec: CreditRecord | null, ghsa: GhsaCreditSource | null): CreditText[] {
  const out: CreditText[] = [];
  for (const field of ["cna.credits", "adp.credits"] as const) {
    for (const c of rec?.credits ?? []) if (c.field === field) out.push({ field, text: sanitize(c.value) });
  }
  for (const s of ghsa?.credits ?? []) out.push({ field: "ghsa.credits", text: sanitize(s) });
  return out;
}

/** §5.5's loop over already sanitised strings: each field in `cfg.fields` order, each string in order; the first hit decides. */
export function matchTexts(texts: readonly CreditText[], cfg: CompiledAiFinders): AiCreditHit | null {
  for (const field of cfg.fields) {
    for (const t of texts) {
      if (t.field !== field) continue;
      const h = matchCredit(t.text, cfg);
      if (h) return { ...h, field };
    }
  }
  return null;
}

/** §5.5's matchRecord(): the first match over the sanitised credit strings, in field order. Callers keep to PUBLISHED records. */
export function matchRecord(rec: CreditRecord, ghsa: GhsaCreditSource | null, cfg: CompiledAiFinders): AiCreditHit | null {
  return matchTexts(creditTexts(rec, ghsa), cfg);
}

// ── State files ──────────────────────────────────────────────────────────────────────────────────

export interface CreditState {
  candidates: CreditCandidatesFile;
  credits: AiCreditsFile;
}

/** Anthropic disclosure-ledger CVE ids and their publication dates (ruling R6). */
export interface LedgerInput {
  cveIds: readonly string[];
  published: ReadonlyMap<string, string>;
}

type CreditInputs = { records: Iterable<CreditRecord>; ghsa: readonly GhsaCreditSource[] };

const FIELD_RANK: Record<string, number> = { "cna.credits": 0, "adp.credits": 1, "ghsa.credits": 2 };

const isLedger = (r: AiCreditRow): boolean => r[7] === "cvd_ledger";

/** Candidates: by id, then canonical field order; array order within a field is kept (a stable sort). */
function sortCandidates(rows: CreditCandidateRow[]): CreditCandidateRow[] {
  return rows.sort((a, b) => compareIds(a[0], b[0]) || FIELD_RANK[a[2]]! - FIELD_RANK[b[2]]!);
}

/** Matches: by date_published, then id. One row per id, so the order is total. */
function sortMatches(rows: AiCreditRow[]): AiCreditRow[] {
  return rows.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : compareIds(a[0], b[0])));
}

function matchRow(id: string, published: string, h: AiCreditHit, firstMatched: string): AiCreditRow {
  return [id, published, h.finder_id, h.family, h.kind, h.field, h.matched.slice(0, MATCHED_MAX), h.rule, firstMatched];
}

/** True when a record's credits count today: PUBLISHED with a publication date on or before the cutoff (ruling R4). */
function counts(rec: CreditRecord, cutoff: string): rec is CreditRecord & { date_published: string } {
  return rec.state === "PUBLISHED" && rec.date_published !== null && rec.date_published <= cutoff;
}

/** Records by id, the last copy of an id winning (a later zip holds the newer copy). */
function byId(records: Iterable<CreditRecord>): Map<string, CreditRecord> {
  const out = new Map<string, CreditRecord>();
  for (const r of records) out.set(r.cve_id, r);
  return out;
}

/**
 * GitHub credit sources by target id: an advisory with a CVE alias counts under its lowest CVE id, one
 * without under its own id (§5.5). Several advisories for one target are merged in GHSA id order.
 */
function ghsaTargets(ghsa: readonly GhsaCreditSource[]): Map<string, GhsaCreditSource> {
  const sorted = [...ghsa].sort((a, b) => compareIds(a.id, b.id));
  const out = new Map<string, GhsaCreditSource>();
  for (const g of sorted) {
    const cves = g.cve_ids.filter((c) => CVE_ID_RE.test(c)).sort(compareCveIds);
    const target = cves[0] ?? g.id;
    const prev = out.get(target);
    out.set(target, prev ? { ...prev, credits: [...prev.credits, ...g.credits] } : { id: g.id, cve_ids: cves, published: g.published, credits: [...g.credits] });
  }
  return out;
}

/** The candidate rows of one record: its sanitised strings that pass `prefilter`. */
function candidateRows(id: string, published: string, texts: readonly CreditText[], cfg: CompiledAiFinders): CreditCandidateRow[] {
  return texts.filter((t) => cfg.prefilterRe.test(t.text)).map((t) => [id, published, t.field, t.text]);
}

function textsOf(rows: readonly CreditCandidateRow[]): CreditText[] {
  return rows.map((r) => ({ field: r[2], text: r[3] }));
}

/** §5.9 step 2: both credit files from every PUBLISHED record with date_published ≤ cutoff; matches get first_matched = cutoff. */
export function buildCredits(i: CreditInputs, run: AiFindersRun, cutoff: string): CreditState {
  const cfg = run.compiled;
  const ghsa = ghsaTargets(i.ghsa);
  const recs = byId(i.records);
  const candidates: CreditCandidateRow[] = [];
  const matches: AiCreditRow[] = [];
  const add = (id: string, published: string, texts: CreditText[]) => {
    const rows = candidateRows(id, published, texts, cfg);
    candidates.push(...rows);
    const h = matchTexts(textsOf(rows), cfg);
    if (h) matches.push(matchRow(id, published, h, cutoff));
  };
  for (const [id, rec] of recs) {
    if (!counts(rec, cutoff)) continue;
    add(id, rec.date_published, creditTexts(rec, ghsa.get(id) ?? null));
  }
  // GitHub sources whose target has no record here count on their own advisory's date (REST only).
  for (const [id, g] of ghsa) {
    if (recs.has(id) || g.published > cutoff) continue;
    add(id, g.published, creditTexts(null, g));
  }
  return {
    candidates: { schema_version: 1, updated_at: cutoff, prefilter_sha256: prefilterSha256(cfg.prefilter), candidates: sortCandidates(candidates) },
    credits: { schema_version: 1, updated_at: cutoff, finders_version: run.version, finders_sha256: run.sha256, matches: sortMatches(matches) },
  };
}

const sameMatch = (a: AiCreditRow | undefined, b: AiCreditRow | undefined): boolean =>
  !!a && !!b && a.slice(0, 8).every((v, k) => v === b[k]);

/**
 * A morning's update (§5.5 "Keeping matches current"). Per CVE record read, its CNA and ADP candidate rows
 * are replaced (a REJECTED, undated or not yet counted record loses all its rows); per GitHub source, the
 * GHSA rows of its target id. Every touched id is rematched from its candidate rows, keeping the
 * first_matched of an id that had a row before; a new match gets the cutoff. Ledger rows are left to
 * applyLedger(), except that a ledger row gives way to a credit match for the same id. The list's version,
 * hash and prefilter hash stay as stored, so creditListStatus() still sees a list change. Returns the ids
 * whose match row changed.
 */
export function updateCredits(prev: CreditState, i: CreditInputs, run: AiFindersRun, cutoff: string): { state: CreditState; changed: string[] } {
  const cfg = run.compiled;
  const recs = byId(i.records);
  const ghsa = ghsaTargets(i.ghsa);
  const touched = new Set<string>([...recs.keys(), ...ghsa.keys()]);

  const rowsById = new Map<string, CreditCandidateRow[]>();
  for (const r of prev.candidates.candidates) {
    const list = rowsById.get(r[0]);
    if (list) list.push(r);
    else rowsById.set(r[0], [r]);
  }
  for (const id of touched) {
    const old = rowsById.get(id) ?? [];
    const rec = recs.get(id);
    const g = ghsa.get(id);
    let published: string | null;
    let cveTexts: CreditText[];
    if (rec) {
      if (!counts(rec, cutoff)) { rowsById.delete(id); continue; }
      published = rec.date_published;
      cveTexts = creditTexts(rec, null);
    } else {
      published = old[0]?.[1] ?? (g && g.published <= cutoff ? g.published : null);
      cveTexts = textsOf(old.filter((r) => r[2] !== "ghsa.credits"));
    }
    if (published === null) { rowsById.delete(id); continue; }
    const ghsaTexts = g ? creditTexts(null, g) : textsOf(old.filter((r) => r[2] === "ghsa.credits"));
    const rows = candidateRows(id, published, [...cveTexts, ...ghsaTexts], cfg);
    if (rows.length) rowsById.set(id, rows);
    else rowsById.delete(id);
  }

  const prevById = new Map<string, AiCreditRow>();
  const ledger = new Map<string, AiCreditRow>();
  for (const r of prev.credits.matches) {
    if (isLedger(r)) ledger.set(r[0], r);
    else prevById.set(r[0], r);
  }
  const changed: string[] = [];
  const next = new Map(prevById);
  for (const id of touched) {
    const rows = rowsById.get(id) ?? [];
    const h = matchTexts(textsOf(rows), cfg);
    const before = prevById.get(id);
    const row = h ? matchRow(id, rows[0]![1], h, before?.[8] ?? ledger.get(id)?.[8] ?? cutoff) : undefined;
    if (row) {
      next.set(id, row);
      ledger.delete(id);
    } else next.delete(id);
    if (!sameMatch(before, row) && (before || row)) changed.push(id);
  }

  const candidates = sortCandidates([...rowsById.values()].flat());
  const matches = sortMatches([...next.values(), ...ledger.values()]);
  return {
    state: {
      candidates: { ...prev.candidates, updated_at: cutoff, candidates },
      credits: { ...prev.credits, updated_at: cutoff, matches },
    },
    changed: changed.sort(compareIds),
  };
}

/** "prefilter_changed" when the stored prefilter hash differs; "recompute" when the list version or hash differs; else "current". */
export function creditListStatus(state: CreditState, run: AiFindersRun): "current" | "recompute" | "prefilter_changed" {
  if (state.candidates.prefilter_sha256 !== prefilterSha256(run.compiled.prefilter)) return "prefilter_changed";
  if (state.credits.finders_version !== run.version || state.credits.finders_sha256 !== run.sha256) return "recompute";
  return "current";
}

/** §5.5 List changes: rematch every candidate, keep first_matched of ids that had a row, then re-apply the ledger. */
export function recomputeCredits(state: CreditState, run: AiFindersRun, cutoff: string, ledger: LedgerInput): CreditState {
  const cfg = run.compiled;
  const before = new Map<string, AiCreditRow>();
  for (const r of state.credits.matches) if (!before.has(r[0]) || !isLedger(r)) before.set(r[0], r);
  const rowsById = new Map<string, CreditCandidateRow[]>();
  for (const r of state.candidates.candidates) {
    const list = rowsById.get(r[0]);
    if (list) list.push(r);
    else rowsById.set(r[0], [r]);
  }
  const matches: AiCreditRow[] = [];
  for (const [id, rows] of rowsById) {
    const h = matchTexts(textsOf(rows), cfg);
    if (h) matches.push(matchRow(id, rows[0]![1], h, before.get(id)?.[8] ?? cutoff));
  }
  const keptLedger = state.credits.matches.filter(isLedger);
  const credits: AiCreditsFile = {
    schema_version: 1, updated_at: cutoff, finders_version: run.version, finders_sha256: run.sha256,
    matches: sortMatches([...matches, ...keptLedger]),
  };
  return {
    candidates: { ...state.candidates, updated_at: cutoff },
    credits: applyLedger(credits, ledger, run, cutoff).credits,
  };
}

/** The finder a ledger-only row names: the list's first Anthropic `ai_system` finder, else its first Anthropic finder. */
function ledgerFinder(cfg: CompiledAiFinders): { id: string; kind: AiCreditRow[4] } | null {
  const f = cfg.finders.find((x) => x.family === "anthropic" && x.kind === "ai_system") ?? cfg.finders.find((x) => x.family === "anthropic");
  return f ? { id: f.id, kind: f.kind } : null;
}

/**
 * Ledger-only rows (rule and field "cvd_ledger", ruling R6) for ledger CVE ids with no credit match and a
 * publication date on or before the cutoff. An id whose date is unknown (neither the ledger input nor an
 * earlier ledger row has it) is listed in `missing`. A ledger row is dropped when its id gains a credit
 * match or leaves the ledger; GHSA ids in the ledger are never counted.
 */
export function applyLedger(credits: AiCreditsFile, ledger: LedgerInput, run: AiFindersRun, cutoff: string): { credits: AiCreditsFile; missing: string[] } {
  const matched = new Set<string>();
  const oldLedger = new Map<string, AiCreditRow>();
  for (const r of credits.matches) {
    if (isLedger(r)) oldLedger.set(r[0], r);
    else matched.add(r[0]);
  }
  const finder = ledgerFinder(run.compiled);
  const ids = [...new Set(ledger.cveIds.map((x) => x.trim().toUpperCase()).filter((x) => CVE_ID_RE.test(x)))].sort(compareCveIds);
  const rows: AiCreditRow[] = [];
  const missing: string[] = [];
  for (const id of finder ? ids : []) {
    if (matched.has(id)) continue;
    const old = oldLedger.get(id);
    const published = ledger.published.get(id) ?? old?.[1] ?? null;
    if (published === null) { missing.push(id); continue; }
    if (published > cutoff) continue;
    rows.push([id, published, finder!.id, "anthropic", finder!.kind, "cvd_ledger", LEDGER_MATCHED, "cvd_ledger", old?.[8] ?? cutoff]);
  }
  return {
    credits: { ...credits, updated_at: cutoff, matches: sortMatches([...credits.matches.filter((r) => !isLedger(r)), ...rows]) },
    missing,
  };
}

// ── Metrics values ───────────────────────────────────────────────────────────────────────────────

/** metrics.ai_credited (§4.7, §5.5). Ledger rows count only in `ledger_only_anthropic`. */
export function aiCredited(i: { credits: AiCreditsFile; kevIndex: readonly KevIndexRow[]; cutoff: string; findersVersion: number }): AiCredited {
  const w = windowEnding(i.cutoff, 91);
  const by_family = Object.fromEntries(FINDER_FAMILIES.map((f) => [f, 0])) as Record<FinderFamily, number>;
  let total = 0;
  let ledgerOnly = 0;
  const credited = new Map<string, AiCreditRow>();
  for (const r of i.credits.matches) {
    const inW13 = inRange(r[1], w.from, w.to);
    if (isLedger(r)) {
      if (inW13) ledgerOnly++;
      continue;
    }
    credited.set(r[0], r);
    if (!inW13) continue;
    total++;
    by_family[r[3]]++;
  }
  const seen = new Set<string>();
  const entries: AiCredited["in_kev"]["entries"] = [];
  for (const k of i.kevIndex) {
    const r = credited.get(k[0]);
    if (!r || seen.has(k[0]) || !inRange(k[1], KEV_SINCE, i.cutoff)) continue;
    seen.add(k[0]);
    entries.push({ cve_id: k[0], finder_id: r[2], family: r[3], kev_date_added: k[1], matched: r[6] });
  }
  entries.sort((a, b) => (a.kev_date_added < b.kev_date_added ? -1 : a.kev_date_added > b.kev_date_added ? 1 : compareCveIds(a.cve_id, b.cve_id)));
  return {
    finders_version: i.findersVersion,
    from: w.from,
    to: w.to,
    w13: { total, by_family, ex_anthropic: total - by_family.anthropic, ledger_only_anthropic: ledgerOnly },
    provisional_from: addDays(newestCompleteWeek(i.cutoff), -21),
    in_kev: { since: KEV_SINCE, n: entries.length, entries },
  };
}

/** The inputs manifest's ai_credited rows: every row (ledger rows too) published in the window, plus every in_kev id's row; by published, then id. */
export function aiManifestRows(credits: AiCreditsFile, ai: AiCredited): InputsManifest["ai_credited"] {
  const kevIds = new Set(ai.in_kev.entries.map((e) => e.cve_id));
  const out = new Map<string, InputsManifest["ai_credited"][number]>();
  for (const r of credits.matches) {
    const inWindow = inRange(r[1], ai.from, ai.to);
    if (!inWindow && !(kevIds.has(r[0]) && !isLedger(r))) continue;
    const prev = out.get(r[0]);
    if (prev && prev.rule !== "cvd_ledger") continue;
    out.set(r[0], { id: r[0], published: r[1], finder_id: r[2], family: r[3], kind: r[4], field: r[5], matched: r[6], rule: r[7] });
  }
  return [...out.values()].sort((a, b) => (a.published < b.published ? -1 : a.published > b.published ? 1 : compareIds(a.id, b.id)));
}

/** "YYYY-MM" of each month from `from` to `to`. */
function monthsOf(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number) as [number, number];
  const end = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > end) return out;
    out.push(key);
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }
}

/**
 * metrics.base_rate (§4.7 BaseRate, §5.5), CVE ids only. Span [2025-01-01, cutoff − 90]. Per UTC month m:
 * ai_n(m) from the credit matches, all_n(m) the days.json counts, all_listed_n(m) the kev-index rows
 * published in m and listed within 90 days (negative lags included, date_added ≤ cutoff). An AI-credited id
 * is listed by the same test on its own kev-index row. expected = Σ ai_n·all_listed_n / all_n.
 */
export function baseRate(i: { credits: AiCreditsFile; days: readonly DayRow[]; kevIndex: readonly KevIndexRow[]; cutoff: string }): BaseRate {
  const to_published = addDays(i.cutoff, -FOLLOW_UP_DAYS);
  const inSpan = (d: string | null): d is string => d !== null && inRange(d, KEV_SINCE, to_published);
  const kev = new Map<string, KevIndexRow>();
  for (const k of i.kevIndex) if (!kev.has(k[0])) kev.set(k[0], k);
  const listed = (k: KevIndexRow | undefined): boolean =>
    !!k && k[4] !== null && k[1] <= i.cutoff && daysBetween(k[4], k[1]) <= FOLLOW_UP_DAYS;

  const months = new Map<string, { ai: number; aiListed: number; all: number; allListed: number }>();
  for (const m of to_published >= KEV_SINCE ? monthsOf(KEV_SINCE, to_published) : []) months.set(m, { ai: 0, aiListed: 0, all: 0, allListed: 0 });
  const month = (d: string) => months.get(d.slice(0, 7))!;
  const aiIds = new Set<string>();
  for (const r of i.credits.matches) {
    if (isLedger(r) || !CVE_ID_RE.test(r[0]) || !inSpan(r[1]) || aiIds.has(r[0])) continue;
    aiIds.add(r[0]);
    const m = month(r[1]);
    m.ai++;
    if (listed(kev.get(r[0]))) m.aiListed++;
  }
  for (const d of i.days) if (inSpan(d[0])) month(d[0]).all += d[1];
  for (const k of kev.values()) if (inSpan(k[4]) && listed(k)) month(k[4]).allListed++;

  let aiN = 0, aiK = 0, allN = 0, allK = 0, expected = 0;
  for (const m of months.values()) {
    aiN += m.ai;
    aiK += m.aiListed;
    allN += m.all;
    allK += m.allListed;
    if (m.all > 0) expected += (m.ai * m.allListed) / m.all;
  }
  const exp4 = round4(expected);
  const shown = aiN >= MIN_N && exp4 >= 5;
  const ci = poissonCi80(aiK);
  return {
    since: KEV_SINCE,
    to_published,
    to: i.cutoff,
    follow_up_days: FOLLOW_UP_DAYS,
    ai_credited_n: aiN,
    ai_credited_in_kev_n: aiK,
    ai_rate: aiN > 0 ? round4(aiK / aiN) : null,
    all_n: allN,
    all_in_kev_n: allK,
    all_rate: allN > 0 ? round4(allK / allN) : null,
    expected: exp4,
    ratio: shown ? round4(aiK / expected) : null,
    ratio_ci80: shown ? [round4(ci[0] / expected), round4(ci[1] / expected)] : null,
  };
}

/** The series' AI fields for the given Mondays, counted on isoWeekStart(date_published); every week is rewritten each run (ruling R5). */
export function aiWeekly(credits: AiCreditsFile, weeks: readonly string[]): Pick<Series, "ai_weekly" | "ai_ledger_only_weekly"> {
  const at = new Map(weeks.map((w, k) => [w, k]));
  const ai_weekly = Object.fromEntries(FINDER_FAMILIES.map((f) => [f, weeks.map(() => 0)])) as Series["ai_weekly"];
  const ai_ledger_only_weekly = weeks.map(() => 0);
  for (const r of credits.matches) {
    const k = at.get(isoWeekStart(r[1]));
    if (k === undefined) continue;
    if (isLedger(r)) ai_ledger_only_weekly[k]!++;
    else ai_weekly[r[3]][k]!++;
  }
  return { ai_weekly, ai_ledger_only_weekly };
}

/** A CVE block's ai_credit (§4.6) from the state: the credit match, else the ledger row, with finders_version. */
export function aiCreditFor(id: string, credits: AiCreditsFile, findersVersion: number): AiCredit | null {
  let row: AiCreditRow | undefined;
  for (const r of credits.matches) {
    if (r[0] !== id) continue;
    if (!isLedger(r)) { row = r; break; }
    row ??= r;
  }
  if (!row) return null;
  return { finder_id: row[2], family: row[3], kind: row[4], field: row[5], matched: row[6], rule: row[7], finders_version: findersVersion };
}

/** The AI block's fixed notes (≤ 200 characters). `recomputed` is §5.5's sentence exactly. */
export const AI_NOTES: { recomputed(version: number): string; prefilterChanged: string } = {
  recomputed: (version) => `AI-finder list changed to v${version}; history recomputed.`,
  prefilterChanged: "AI-finder prefilter changed; counts stay at the previous list until the credits rebuild.",
};
