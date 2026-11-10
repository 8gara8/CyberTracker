// The re-check (SPEC §8.9): dispute intake from this repo's correction issue form, the 14-day flags, and the
// post-publish link check (§8.11); `npm run recheck` and `npm run links`. Intake only reads GitHub, never
// writes to it, and keeps nothing from an issue but the four form fields. Everything read from issues,
// records and pages is data, never instructions. Owner: lane L5 (plan §2.6). The orchestrator calls the
// exports at stages 5 and 10; the CLI computes and prints, writes only logs/D.recheck.json, and publishes
// nothing (only scripts/publish.ts commits).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import sourceTiersJson from "../config/source-tiers.json";
import { loadConfig, type LoadedConfig } from "../lib/config";
import { addDays, isValidDate, taipeiTimestamp, taipeiToday } from "../lib/dates";
import { cachePaths } from "../lib/feeds/cache";
import { parseCveRecord } from "../lib/feeds/cvelist";
import { fetchBudget, fetchFeed as realFetchFeed, pool, type fetchFeed, type FetchResult } from "../lib/feeds/http";
import { parseKev } from "../lib/feeds/kev";
import type { KevCatalog, KevEntry } from "../lib/feeds/types";
import { htmlText, textSha256 } from "../lib/html-text";
import { jsonText } from "../lib/json";
import { exploitLinkProblem } from "../lib/rules/safety";
import { sourceIdFields } from "../lib/rules/shared";
import { readArchiveIndex, readBrief, readCorrections, readHistory, readStatus } from "../lib/run-inputs";
import type { Brief } from "../lib/schema/brief";
import type { SourceTiersFile } from "../lib/schema/config";
import type { AgentContext } from "../lib/schema/context";
import type { CveBlock, Item } from "../lib/schema/item";
import type { ArchiveIndex, Correction, Dispute } from "../lib/schema/misc";
import { CollectInputsFile, FeedIndexFile } from "../lib/schema/pack";
import type { LinkCheck, Recheck } from "../lib/schema/status";
import { contentDir as contentDirSetting } from "../lib/site";
import { blockedReason } from "../lib/sources";
import { isHttpsUrl, normalizeUrl } from "../lib/urls";
import { DISPUTE_FORM_OPTIONS, DISPUTE_KINDS, RECHECK_FLAGS, type DisputeKind, type RecheckFlag } from "../lib/vocab";
import type { WithholdRequest } from "../lib/withhold";
import { bindingWithholds } from "../lib/withhold-mask";
import { realDeadline, type Clock } from "./lib/clock";
import { readCveById, type FeedCtx } from "./lib/feeds";
import { runPaths } from "./lib/paths";
import { SNAPSHOT_HEADERS, SNAPSHOT_LIMITS } from "./lib/snapshot";

const noop = () => {};

// ── The correction issue form (§9.2) ─────────────────────────────────────────────────────────────

export interface DisputeForm {
  item_id: string;
  edition_date: string | null;
  kind: DisputeKind;
  evidence_url: string | null;
}

/**
 * The labels of the four fields of .github/ISSUE_TEMPLATE/correction.yml, as GitHub renders a submitted
 * form: one `### <label>` heading per field, then the answer. tests/recheck.test.ts holds them equal to
 * the template. (An addition to plan §2.6.)
 */
export const FORM_LABELS = {
  item_id: "Item id",
  edition_date: "Edition date",
  kind: "What is wrong",
  evidence_url: "Evidence link",
} as const;

/** What GitHub writes under a heading whose optional field was left empty. */
export const NO_RESPONSE = "_No response_";

const ITEM_ID_RE = /^[a-z0-9][a-z0-9-]{2,80}$/;
const EVIDENCE_MAX = 500;
/** The source-tiers file as committed: blockedReason() needs only its `github` paths (Appendix B.3). */
const DEFAULT_TIERS = sourceTiersJson as unknown as Pick<SourceTiersFile, "github">;

type FieldKey = keyof typeof FORM_LABELS;
const FIELD_BY_LABEL = new Map<string, FieldKey>(
  (Object.entries(FORM_LABELS) as [FieldKey, string][]).map(([k, label]) => [label.toLowerCase(), k]),
);

/**
 * The four `### <label>` blocks, each its first non-empty line; null when a label appears twice. Text before
 * the first heading, under any other heading, and after a block's first line is never read.
 */
function formBlocks(body: string): Partial<Record<FieldKey, string>> | null {
  const out: Partial<Record<FieldKey, string>> = {};
  const seen = new Set<FieldKey>();
  let current: FieldKey | null = null;
  let taken = false;
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^###[ \t]+(.+?)[ \t]*$/.exec(raw);
    if (heading) {
      const key = FIELD_BY_LABEL.get(heading[1]!.replace(/[ \t]+#+$/, "").trim().toLowerCase()) ?? null;
      if (key && seen.has(key)) return null;
      if (key) seen.add(key);
      current = key;
      taken = false;
      continue;
    }
    if (!current || taken) continue;
    const line = raw.trim();
    if (line === "") continue;
    out[current] = line;
    taken = true;
  }
  return out;
}

/**
 * An evidence link as §8.9 keeps it: https, at most 500 characters, not blocked, normalised; else null. A reader's
 * link is checked as a tier 3 page too (NO_EXPLOIT_LINK's path test, on any host), because it goes into the
 * agent's context and the public corrections.json: a path holding an exploit word gives null.
 */
function evidenceUrl(value: string | undefined, tiers: Pick<SourceTiersFile, "github">): string | null {
  if (value === undefined || value === NO_RESPONSE) return null;
  if (value.length > EVIDENCE_MAX || /\s/.test(value) || !/^https:/i.test(value) || !isHttpsUrl(value)) return null;
  if (blockedReason(value, tiers) !== null || exploitLinkProblem(value, 3, tiers) !== null) return null;
  const normal = normalizeUrl(value);
  if (normal.length > EVIDENCE_MAX || !isHttpsUrl(normal) || blockedReason(normal, tiers) !== null || exploitLinkProblem(normal, 3, tiers) !== null) return null;
  return normal;
}

/**
 * The four ### blocks of .github/ISSUE_TEMPLATE/correction.yml only; null when not parseable. briefs(): dates
 * holding the id. `item_id` must match ^[a-z0-9][a-z0-9-]{2,80}$ and be in a brief; `edition_date` must be
 * one of those dates (`_No response_` or no block: the newest); `kind` exactly one DISPUTE_FORM_OPTIONS
 * string; `evidence_url` https, at most 500 characters, not on the blocked list (blockedReason(), so a
 * github.com path outside `tier1_paths` counts as blocked too), normalised, else null. `o.sourceTiers`
 * (an addition) defaults to config/source-tiers.json.
 */
export function parseDisputeForm(
  body: string,
  briefs: (itemId: string) => readonly string[],
  o: { sourceTiers?: Pick<SourceTiersFile, "github"> } = {},
): DisputeForm | null {
  if (typeof body !== "string") return null;
  const blocks = formBlocks(body);
  if (!blocks) return null;
  const itemId = blocks.item_id;
  if (itemId === undefined || !ITEM_ID_RE.test(itemId)) return null;
  const dates = [...new Set(briefs(itemId))].filter(isValidDate).sort();
  if (dates.length === 0) return null;
  const given = blocks.edition_date;
  let edition: string;
  if (given === undefined || given === NO_RESPONSE) edition = dates.at(-1)!;
  else if (dates.includes(given)) edition = given;
  else return null;
  const answer = blocks.kind;
  const kind = DISPUTE_KINDS.find((k) => DISPUTE_FORM_OPTIONS[k] === answer);
  if (!kind) return null;
  return { item_id: itemId, edition_date: edition, kind, evidence_url: evidenceUrl(blocks.evidence_url, o.sourceTiers ?? DEFAULT_TIERS) };
}

// ── Dispute intake ───────────────────────────────────────────────────────────────────────────────

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

/** §8.9 step 1: one request's timeout, the page size and the page cap. */
export const INTAKE_LIMITS = { timeoutMs: 10_000, perPage: 100, maxPages: 3 } as const;

/** The intake's `since` (G19): the newest dispute's received as UTC "YYYY-MM-DDTHH:MM:SSZ", else D − 30 at 00:00 UTC. */
export function intakeSince(disputes: readonly Pick<Dispute, "received">[], date: string): string {
  let newest: number | null = null;
  for (const d of disputes) {
    const ms = Date.parse(d.received);
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  }
  if (newest === null) return `${addDays(date, -30)}T00:00:00Z`;
  return `${new Date(newest).toISOString().slice(0, 19)}Z`;
}

/** Page N of the intake read (§8.9 step 1): page 1 has no `page` parameter. */
export function intakeUrl(repo: string, since: string, page = 1): string {
  return `https://api.github.com/repos/${repo}/issues?state=all&labels=correction&since=${since}&per_page=${INTAKE_LIMITS.perPage}${page > 1 ? `&page=${page}` : ""}`;
}

/** The only issue fields intake looks at: no title, comment, label text or login is kept. */
interface IssueEntry {
  number: number;
  body: string | null;
  closed: boolean;
  stateReason: string | null;
  createdAt: string;
  pullRequest: boolean;
}

function issueEntry(v: unknown): IssueEntry | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const n = o.number;
  const created = o.created_at;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return null;
  if (typeof created !== "string" || !Number.isFinite(Date.parse(created))) return null;
  return {
    number: n,
    body: typeof o.body === "string" ? o.body : null,
    closed: o.state === "closed",
    stateReason: typeof o.state_reason === "string" ? o.state_reason : null,
    createdAt: created,
    pullRequest: o.pull_request !== undefined && o.pull_request !== null,
  };
}

/** Every page, or null on any failure (a network error, a timeout, a non-2xx answer, a body that is not an array). */
async function readIssues(o: { url: (page: number) => string; userAgent: string; fetchImpl: typeof fetch; log: (line: string) => void }): Promise<unknown[] | null> {
  const all: unknown[] = [];
  for (let page = 1; page <= INTAKE_LIMITS.maxPages; page++) {
    const url = o.url(page);
    let list: unknown;
    try {
      const res = await o.fetchImpl(url, {
        method: "GET",
        headers: { "User-Agent": o.userAgent, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(INTAKE_LIMITS.timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        o.log(`intake: page ${page} answered HTTP ${res.status}.`);
        return null;
      }
      list = await res.json();
    } catch (e) {
      o.log(`intake: page ${page} failed (${(e as Error).name ?? "error"}).`);
      return null;
    }
    if (!Array.isArray(list)) {
      o.log(`intake: page ${page} is not a list.`);
      return null;
    }
    all.push(...list);
    if (list.length < INTAKE_LIMITS.perPage) return all;
    if (page === INTAKE_LIMITS.maxPages) o.log(`intake: ${INTAKE_LIMITS.maxPages} full pages read; any further issues wait for a later run.`);
  }
  return all;
}

function nextDisputeId(disputes: readonly Dispute[]): () => string {
  let n = 0;
  for (const d of disputes) {
    const m = /^D-(\d{4})$/.exec(d.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return () => `D-${String(++n).padStart(4, "0")}`;
}

/** Item id → the dates of every stored brief that holds it, and the briefs themselves, read once and kept. */
class BriefIndex {
  private dates: Map<string, string[]> | null = null;
  private briefs = new Map<string, Brief | null>();
  constructor(private readonly dir: string) {}

  brief(date: string): Brief | null {
    if (!this.briefs.has(date)) this.briefs.set(date, readBrief(this.dir, date));
    return this.briefs.get(date) ?? null;
  }

  datesFor(itemId: string): string[] {
    if (!this.dates) {
      this.dates = new Map();
      let names: string[] = [];
      try {
        names = fs.readdirSync(path.join(this.dir, "briefs"));
      } catch {
        names = [];
      }
      for (const name of names.sort()) {
        const date = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name)?.[1];
        if (!date || !isValidDate(date)) continue;
        const b = this.brief(date);
        for (const it of b?.items ?? []) {
          const list = this.dates.get(it.id) ?? [];
          if (!list.includes(date)) list.push(date);
          this.dates.set(it.id, list);
        }
      }
    }
    return this.dates.get(itemId) ?? [];
  }

  item(itemId: string, date: string): Item | null {
    return this.brief(date)?.items.find((it) => it.id === itemId) ?? null;
  }
}

/** The name_removed correction a victim or attribution withhold writes (§4.10): its field is the withheld part. */
function withholdField(field: string, kind: "victim" | "attribution"): boolean {
  const f = field.trim();
  if (kind === "victim") return f === "incident.victim" || f.startsWith("incident.victim.");
  return f === "attribution" || f.startsWith("attribution.") || f.startsWith("attribution[") || f === "actor_nexus";
}

function closeStatus(e: IssueEntry): Dispute["status"] | null {
  if (!e.closed) return null;
  if (e.stateReason === "not_planned") return "rejected";
  if (e.stateReason === "completed") return "upheld";
  return null;
}

/**
 * GET https://api.github.com/repos/<repos.repo>/issues?state=all&labels=correction&since=<S>&per_page=100[&page=N]
 * through fetchImpl (10 s each, ≤ 3 pages, run.json user_agent, no token). S = the newest dispute's
 * received as UTC "YYYY-MM-DDTHH:MM:SSZ", else `${addDays(D, −30)}T00:00:00Z`. Never writes to GitHub.
 *
 * New issue numbers become open disputes (D-NNNN, received = created_at in Taipei); an open dispute whose
 * issue closed `not_planned` becomes rejected, `completed` upheld, resolved_on D. Withhold requests: every
 * open or upheld victim or attribution dispute without a correction, oldest first, at most 10 (one per
 * item, edition and kind; one already answered by a stored name_removed correction that still binds gets
 * that correction's id instead). Reports: open fact and link disputes, and rejected victim or attribution disputes on items
 * still withheld with no `update` correction since. When the read fails (`ok: false`), the stored list
 * still gives withholds and reports.
 */
export async function intakeDisputes(o: {
  root: string; date: string; contentDir: string; config: LoadedConfig; now: Clock; fetchImpl: typeof fetch;
  log?: (line: string) => void;
}): Promise<IntakeResult> {
  const log = o.log ?? noop;
  const stored = readCorrections(o.contentDir);
  const disputes: Dispute[] = (stored?.disputes ?? []).map((d) => ({ ...d }));
  const corrections: readonly Correction[] = stored?.corrections ?? [];
  const index = new BriefIndex(o.contentDir);
  const ignored: number[] = [];
  const repo = o.config.run.repos.repo;
  const since = intakeSince(disputes, o.date);

  const raw = await readIssues({ url: (page) => intakeUrl(repo, since, page), userAgent: o.config.run.user_agent, fetchImpl: o.fetchImpl, log });
  const ok = raw !== null;
  if (raw === null) log("Dispute intake unavailable today.");
  else {
    const entries: IssueEntry[] = [];
    for (const v of raw) {
      const e = issueEntry(v);
      if (e && !e.pullRequest) entries.push(e);
    }
    const byNumber = new Map(disputes.map((d) => [d.issue_number, d]));
    const nextId = nextDisputeId(disputes);
    const fresh = entries
      .filter((e) => !byNumber.has(e.number))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
    const done = new Set<number>();
    for (const e of fresh) {
      if (done.has(e.number)) continue;
      done.add(e.number);
      const form = e.body === null ? null : parseDisputeForm(e.body, (id) => index.datesFor(id), { sourceTiers: o.config.sourceTiers });
      if (!form) {
        ignored.push(e.number);
        log(`issue #${e.number}: form not parseable`);
        continue;
      }
      const d: Dispute = {
        id: nextId(), received: taipeiTimestamp(new Date(e.createdAt)), issue_number: e.number, item_id: form.item_id,
        edition_date: form.edition_date, kind: form.kind, evidence_url: form.evidence_url, status: "open", resolved_on: null,
        correction_id: null,
      };
      disputes.push(d);
      byNumber.set(e.number, d);
    }
    for (const e of entries) {
      const d = byNumber.get(e.number);
      const status = closeStatus(e);
      if (d && d.status === "open" && status) {
        d.status = status;
        d.resolved_on = o.date;
      }
    }
  }

  // Withholds (§8.9 step 4, §4.10). A stored correction answers a new dispute only while it still binds (its own
  // dispute open or upheld): one whose dispute was rejected or withdrawn withholds no later edition, so the new
  // dispute gets a withhold of its own.
  const withhold: WithholdRequest[] = [];
  let waiting = 0;
  const keys = new Set<string>();
  const binds = new Set(bindingWithholds(stored, disputes).map((x) => x.correction_id));
  for (const d of disputes) {
    if ((d.kind !== "victim" && d.kind !== "attribution") || (d.status !== "open" && d.status !== "upheld") || d.correction_id !== null) continue;
    const edition = d.edition_date ?? index.datesFor(d.item_id).at(-1) ?? null;
    if (!edition || !index.item(d.item_id, edition)) {
      log(`dispute ${d.id}: item ${d.item_id} is not in a stored brief; not withheld.`);
      continue;
    }
    const kind = d.kind;
    const answered = corrections.find((c) => c.type === "name_removed" && binds.has(c.id) && c.item_id === d.item_id && c.edition_date === edition && withholdField(c.field, kind));
    if (answered) {
      d.correction_id = answered.id;
      continue;
    }
    const key = `${d.item_id}|${edition}|${kind}`;
    if (keys.has(key)) continue;
    keys.add(key);
    if (withhold.length < MAX_WITHHOLDS) withhold.push({ item_id: d.item_id, edition_date: edition, kind, dispute_id: d.id, since: o.date });
    else waiting++;
  }

  // Reports to the agent (§8.9 step 5).
  const reports: AgentContext["corrections"]["reports"] = [];
  for (const d of disputes) {
    if (d.status === "open" && (d.kind === "fact" || d.kind === "link")) {
      reports.push({ item_id: d.item_id, type: d.kind, evidence_url: d.evidence_url });
      continue;
    }
    if (d.status !== "rejected" || (d.kind !== "victim" && d.kind !== "attribution")) continue;
    const edition = d.edition_date ?? index.datesFor(d.item_id).at(-1) ?? null;
    const item = edition ? index.item(d.item_id, edition) : null;
    if (!item?.withheld) continue;
    const restored = corrections.some((c) => c.type === "update" && c.item_id === d.item_id && c.edition_date === edition
      && (d.resolved_on === null || c.date >= d.resolved_on));
    if (!restored) reports.push({ item_id: d.item_id, type: d.kind, evidence_url: d.evidence_url });
  }

  const added = disputes.length - (stored?.disputes.length ?? 0);
  if (ok) log(`intake: ${added} new dispute${added === 1 ? "" : "s"}, ${withhold.length} to withhold, ${waiting} waiting, ${ignored.length} not parseable.`);
  return { ok, disputes, withhold, waiting, reports, ignored };
}

// ── The 14-day re-check ──────────────────────────────────────────────────────────────────────────

export interface RecheckResult {
  /** RunRecord.recheck, every flag (suppressed ones too), correction_id null. */
  record: Recheck;
  /** After suppression, for the context. */
  shown: AgentContext["corrections"]["flagged"];
  skipped: ("kev" | "cvelist")[];
}

/** §8.9: the days re-checked, records fetched past the cache at most, and §8.3's per-id pool. */
export const RECHECK_LIMITS = { days: 14, maxFetch: 150, pool: 16, detailMax: 120 } as const;

type Flag = Recheck["flagged"][number];
type Shown = AgentContext["corrections"]["flagged"][number];

interface FlagHit {
  flag: Flag;
  shown: Omit<Shown, "date" | "item_id" | "check">;
  /** The correction fields that answer it: a correction on one of these paths, or a parent or child of one. Empty: any field. */
  fields: string[];
}

const recordUrl = (cve: string) => `https://www.cve.org/CVERecord?id=${cve}`;
const kevUrl = (cve: string) => `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=${cve}`;
const one = (x: number) => x.toFixed(1);
const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : s);

/** CVSS v3 and v4 qualitative bands (none, low, medium, high, critical). */
export function cvssBand(score: number): "none" | "low" | "medium" | "high" | "critical" {
  if (score <= 0) return "none";
  if (score < 4) return "low";
  if (score < 7) return "medium";
  if (score < 9) return "high";
  return "critical";
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const SCORE_KEYS = [["cvssV4_0", "4.0"], ["cvssV3_1", "3.1"], ["cvssV3_0", "3.0"]] as const;

/** The base scores a record gives by scorer and CVSS version: the CNA's metrics and the CISA-ADP entry's (§4.6). */
function scoresOf(raw: unknown): Record<"cna" | "cisa_adp", Map<string, number>> {
  const containers = obj(obj(raw).containers);
  const read = (metrics: unknown, into: Map<string, number>) => {
    for (const [key, version] of SCORE_KEYS) {
      if (into.has(version)) continue;
      for (const m of arr(metrics)) {
        const s = obj(obj(m)[key]).baseScore;
        if (typeof s === "number" && Number.isFinite(s) && s >= 0 && s <= 10) {
          into.set(version, s);
          break;
        }
      }
    }
  };
  const cna = new Map<string, number>();
  const adp = new Map<string, number>();
  read(obj(containers.cna).metrics, cna);
  for (const a of arr(containers.adp).map(obj)) if (obj(a.providerMetadata).shortName === "CISA-ADP") read(a.metrics, adp);
  return { cna, cisa_adp: adp };
}

/** The current score for a frozen block's scorer: the frozen version's, else the scorer's first by §4.6's precedence. */
function currentScore(raw: unknown, frozen: NonNullable<CveBlock["cvss"]>): number | null {
  if (frozen.scorer === "nvd") return null;
  const map = scoresOf(raw)[frozen.scorer];
  if (map.has(frozen.version)) return map.get(frozen.version)!;
  for (const [, version] of SCORE_KEYS) if (map.has(version)) return map.get(version)!;
  return null;
}

function cnaTags(raw: unknown): string[] {
  return arr(obj(obj(obj(raw).containers).cna).tags).filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase());
}

/** The flags one frozen CVE block raises against today's record and catalog (§8.9 table). */
function cveFlags(o: {
  item: Item; edition: string; index: number; block: CveBlock; raw: unknown | null; kev: KevCatalogIndex | null;
}): FlagHit[] {
  const out: FlagHit[] = [];
  const { block, edition } = o;
  const cve = block.cve_id;
  const at = `cves.${o.index}`;
  const flag = (f: RecheckFlag, detail: string): Flag => ({ item_id: o.item.id, edition_date: edition, flag: f, detail: detail.slice(0, RECHECK_LIMITS.detailMax), correction_id: null });
  if (o.raw !== null) {
    const rec = parseCveRecord(o.raw);
    if (rec && rec.cve_id === cve) {
      if (rec.state.toUpperCase() === "REJECTED") {
        out.push({ flag: flag("cve_rejected", `${cve} is now rejected in the CVE List.`),
          shown: { before: "PUBLISHED", after: "REJECTED", evidence_url: recordUrl(cve) }, fields: [at, "cve_ids"] });
      } else {
        // The block keeps no tags, so "the frozen block did not" (§8.9) reads as: the record changed after the block's date_updated.
        if (cnaTags(o.raw).includes("disputed") && rec.date_updated !== null && rec.date_updated > block.date_updated) {
          out.push({ flag: flag("cve_disputed", `${cve} is now marked disputed by its CNA.`),
            shown: { before: "not disputed", after: "disputed", evidence_url: recordUrl(cve) }, fields: [at] });
        }
        if (block.cvss) {
          const now = currentScore(o.raw, block.cvss);
          if (now !== null) {
            const old = block.cvss.score;
            const moved = Math.round(Math.abs(now - old) * 10) >= 10;
            if (moved || cvssBand(now) !== cvssBand(old)) {
              const tag = `CVSS ${block.cvss.version}, ${block.cvss.scorer}`;
              out.push({ flag: flag("cvss_changed", `${cve}: CVSS ${one(old)} → ${one(now)} (${block.cvss.scorer}).`),
                shown: { before: `${one(old)} (${tag})`, after: `${one(now)} (${tag})`, evidence_url: recordUrl(cve) }, fields: [`${at}.cvss`] });
            }
          }
        }
      }
    }
  }
  if (o.kev && block.kev) {
    const entry = o.kev.get(cve);
    const fields = [`${at}.kev`];
    if (!entry) {
      out.push({ flag: flag("kev_changed", `${cve}: removed from the KEV catalog.`),
        shown: { before: `listed since ${block.kev.date_added}`, after: "removed", evidence_url: kevUrl(cve) }, fields });
    } else {
      const due = entry.dueDate.trim();
      if (due !== "" && due !== block.kev.due_date) {
        out.push({ flag: flag("kev_changed", `${cve}: KEV due date ${block.kev.due_date} → ${due}.`),
          shown: { before: block.kev.due_date, after: due, evidence_url: kevUrl(cve) }, fields });
      }
      const ransomware = entry.knownRansomwareCampaignUse.trim().toLowerCase();
      if ((ransomware === "known" || ransomware === "unknown") && ransomware !== block.kev.ransomware) {
        out.push({ flag: flag("kev_changed", `${cve}: KEV ransomware use ${capital(block.kev.ransomware)} → ${capital(ransomware)}.`),
          shown: { before: block.kev.ransomware, after: ransomware, evidence_url: kevUrl(cve) }, fields });
      }
    }
  }
  return out;
}

type KevCatalogIndex = Map<string, KevEntry>;

/** cache/feeds/kev.json as collect read it for D (inputs.json for D naming this body's SHA-256), else null. */
function todaysKev(root: string, date: string): KevCatalog | null {
  const p = cachePaths(root);
  try {
    const inputs = CollectInputsFile.safeParse(JSON.parse(fs.readFileSync(p.collectInputs, "utf8")));
    if (!inputs.success || inputs.data.date !== date || !inputs.data.kev) return null;
    const parsed = parseKev(fs.readFileSync(p.feedBody("kev", "json")));
    return parsed.sha256 === inputs.data.kev.sha256 ? parsed.catalog : null;
  } catch {
    return null;
  }
}

/** cache/feeds/inputs.json's `commits.cvelist` (readCveById reads main without one). */
function cvelistCommit(root: string): string | null {
  try {
    const r = CollectInputsFile.safeParse(JSON.parse(fs.readFileSync(cachePaths(root).collectInputs, "utf8")));
    return r.success ? r.data.commits.cvelist : null;
  } catch {
    return null;
  }
}

function cachedRecord(dir: string, cve: string): unknown | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, `${cve}.json`), "utf8"));
    return parseCveRecord(raw)?.cve_id === cve ? raw : null;
  } catch {
    return null;
  }
}

/** True when a correction on `field` answers a flag about `base`: the same path, a parent or a child. */
function fieldCovers(field: string, base: string): boolean {
  const f = field.trim();
  return f === base || f.startsWith(`${base}.`) || f.startsWith(`${base}[`) || base.startsWith(`${f}.`);
}

/**
 * Every item in the briefs dated D − 14 to D − 1 (data-only included, withheld excluded) against this
 * morning's feeds: CVE records from collect's cache, missing ones through readCveById (at most 150, newest
 * editions first, §8.3's pool of 16); KEV from cache/feeds/kev.json as collect read it; sources from
 * archive-index.json's `last_check`; reader reports from open fact and link disputes (`o.disputes`, an
 * addition: intake's updated list; default corrections.json's). With kev or cvelist failed, their flags
 * are skipped and logged. Suppression: a correction for the item and field dated on or after the flag
 * first appeared (in the status files of the 14 days, else D), or the same item, flag and detail with no
 * correction id in two earlier status files of the 14 days. `record` holds every flag; `shown` the rest.
 */
export async function recheckItems(o: {
  root: string; date: string; contentDir: string; config: LoadedConfig;
  /** From this morning's collect. */
  feedsOk: { kev: boolean; cvelist: boolean };
  /** Date.now() ms (realDeadline) */
  deadline: number;
  fetch?: typeof fetchFeed; log?: (line: string) => void;
  disputes?: readonly Dispute[] | null;
}): Promise<RecheckResult> {
  const log = o.log ?? noop;
  const root = path.resolve(o.root);
  const D = o.date;
  const from = addDays(D, -RECHECK_LIMITS.days);
  const to = addDays(D, -1);
  const briefs = readHistory(o.contentDir, D, RECHECK_LIMITS.days);
  const stored = readCorrections(o.contentDir);
  const disputes = o.disputes ?? stored?.disputes ?? [];
  const corrections = stored?.corrections ?? [];
  const archive = readArchiveIndex(o.contentDir);
  const skipped: RecheckResult["skipped"] = [];

  const failed = (["kev", "cvelist"] as const).filter((f) => !o.feedsOk[f]);
  if (failed.length) log(`recheck: flags from ${failed.join(" and ")} skipped: the feed failed.`);
  let kev: KevCatalogIndex | null = null;
  if (o.feedsOk.kev) {
    const catalog = todaysKev(root, D);
    if (catalog) kev = new Map(catalog.vulnerabilities.map((v) => [v.cveID, v]));
    else log("recheck: flags from kev skipped: the catalog collect read today is not in the cache.");
  }
  if (!kev) skipped.push("kev");
  const useRecords = o.feedsOk.cvelist;
  if (!useRecords) skipped.push("cvelist");

  // The items checked, newest edition first.
  const checked: { brief: Brief; item: Item }[] = [];
  for (const b of briefs) for (const item of b.items) if (!item.withheld) checked.push({ brief: b, item });

  // CVE records: collect's cache, then by id for the rest.
  const records = new Map<string, unknown | null>();
  if (useRecords) {
    const dir = cachePaths(root).recordsDir;
    const wanted: string[] = [];
    for (const { item } of checked) for (const c of item.cves) if (!records.has(c.cve_id)) {
      const raw = cachedRecord(dir, c.cve_id);
      records.set(c.cve_id, raw);
      if (raw === null) wanted.push(c.cve_id);
    }
    const asked = wanted.slice(0, RECHECK_LIMITS.maxFetch);
    if (wanted.length > asked.length) log(`recheck: ${wanted.length - asked.length} more CVE records not fetched, over the cap of ${RECHECK_LIMITS.maxFetch}.`);
    if (asked.length) {
      const fetchImpl = o.fetch ?? realFetchFeed;
      const ctx: FeedCtx = {
        fetch: (url, opts) => fetchImpl(url, { userAgent: o.config.run.user_agent, ...opts }),
        budget: fetchBudget(), deadline: o.deadline, now: Date.now, log, paths: cachePaths(root), sleep: async () => {},
      };
      const sha = cvelistCommit(root);
      let got = 0;
      await pool(asked, RECHECK_LIMITS.pool, async (id) => {
        if (Date.now() >= o.deadline) return;
        const r = await readCveById(ctx, sha, id);
        if (typeof r === "object" && parseCveRecord(r.raw)?.cve_id === id) {
          records.set(id, r.raw);
          got++;
        }
      });
      log(`recheck: ${got} of ${asked.length} CVE records fetched by id.`);
    }
  }

  // Suppression inputs: the 14 days of status files.
  const priorFiles: { date: string; keys: Set<string>; silent: Set<string> }[] = [];
  for (let i = 1; i <= RECHECK_LIMITS.days; i++) {
    const day = addDays(D, -i);
    const s = readStatus(o.contentDir, day);
    if (!s) continue;
    const keys = new Set<string>();
    const silent = new Set<string>();
    for (const run of s.runs) for (const f of run.recheck?.flagged ?? []) {
      const k = flagKey(f);
      keys.add(k);
      if (f.correction_id === null) silent.add(k);
    }
    priorFiles.push({ date: day, keys, silent });
  }

  const flagged: Flag[] = [];
  const shown: Shown[] = [];
  for (const { brief, item } of checked) {
    const hits: FlagHit[] = [];
    item.cves.forEach((block, index) => {
      hits.push(...cveFlags({ item, edition: brief.date, index, block, raw: useRecords ? (records.get(block.cve_id) ?? null) : null, kev }));
    });
    hits.push(...sourceFlags(brief, item, archive));
    for (const d of disputes) {
      if (d.status !== "open" || (d.kind !== "fact" && d.kind !== "link") || d.item_id !== item.id) continue;
      if (d.edition_date !== null && d.edition_date !== brief.date) continue;
      hits.push({
        flag: { item_id: item.id, edition_date: brief.date, flag: "reader_report", detail: `Reader report ${d.id} (${d.kind}).`, correction_id: null },
        shown: { before: "", after: `Reader report ${d.id} (${d.kind}).`, evidence_url: d.evidence_url }, fields: [],
      });
    }
    hits.sort((a, b) => RECHECK_FLAGS.indexOf(a.flag.flag) - RECHECK_FLAGS.indexOf(b.flag.flag));
    for (const h of hits) {
      flagged.push(h.flag);
      const k = flagKey(h.flag);
      const firstSeen = priorFiles.filter((p) => p.keys.has(k)).map((p) => p.date).sort()[0] ?? D;
      const corrected = corrections.some((c) => c.item_id === item.id && c.edition_date === brief.date && c.date >= firstSeen
        && (h.fields.length === 0 || h.fields.some((f) => fieldCovers(c.field, f))));
      const silentTwice = priorFiles.filter((p) => p.silent.has(k)).length >= 2;
      if (!corrected && !silentTwice) shown.push({ date: brief.date, item_id: item.id, check: h.flag.flag, ...h.shown });
    }
  }
  log(`recheck: ${checked.length} item${checked.length === 1 ? "" : "s"} checked, ${flagged.length} flag${flagged.length === 1 ? "" : "s"}, ${shown.length} shown.`);
  return { record: { from, to, items_checked: checked.length, flagged }, shown, skipped };
}

function flagKey(f: Pick<Flag, "item_id" | "edition_date" | "flag" | "detail">): string {
  return JSON.stringify([f.item_id, f.edition_date, f.flag, f.detail]);
}

/** source_missing and source_changed for one item: its cited sources' last link check (archive-index.json). */
function sourceFlags(brief: Brief, item: Item, archive: ArchiveIndex | null): FlagHit[] {
  if (!archive) return [];
  const out: FlagHit[] = [];
  for (const sid of item.source_ids) {
    const s = brief.sources.find((x) => x.id === sid);
    if (!s) continue;
    const check = archive.urls[normalizeUrl(s.url)]?.last_check;
    if (!check) continue;
    const base = { item_id: item.id, edition_date: brief.date, correction_id: null };
    if (check.result === "broken") {
      const detail = check.http !== null ? `${sid} returned ${check.http} on ${check.date}.` : `${sid} could not be reached on ${check.date}.`;
      out.push({
        flag: { ...base, flag: "source_missing", detail },
        shown: { before: s.url, after: check.http !== null ? `HTTP ${check.http} on ${check.date}` : `no answer on ${check.date}`, evidence_url: null }, fields: [],
      });
    } else if (check.result === "changed" && s.tier === 1) {
      out.push({
        flag: { ...base, flag: "source_changed", detail: `${sid} (tier 1) changed since it was cited.` },
        shown: { before: s.url, after: `page text changed (link check ${check.date})`, evidence_url: null }, fields: [],
      });
    }
  }
  return out;
}

// ── The post-publish link check (§8.11) ──────────────────────────────────────────────────────────

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

/** One URL the link check asks for: the string as the newest brief stores it, its key, its tier and who cites it. */
export interface LinkTarget {
  url: string;
  key: string;
  tier: 1 | 2 | 3;
  item_id: string;
  edition_date: string;
}

/** The top-level part of a source reference path ("angle.source_id" → "angle"), for a source no item cites. */
const refRoot = (p: string) => p.split(/[.[]/)[0] || "sources";

/**
 * §8.11 step 1 (an addition to plan §2.6, so the order can be tested): every `sources[].url` in the briefs
 * dated D − 13 to D, newest edition first and then tier 1, 2, 3, deduplicated on normalizeUrl(), without a
 * source that only withheld items cite or a blocked URL (blockedReason()), at most 300. `item_id` and
 * `edition_date` name the newest edition's citing item (else an older one's, else the archive index's
 * newest, else the part of the brief that cites it).
 */
export function linkTargets(o: { contentDir: string; date: string; config: LoadedConfig; archive?: ArchiveIndex | null }): { targets: LinkTarget[]; total: number } {
  const briefs = [readBrief(o.contentDir, o.date), ...readHistory(o.contentDir, o.date, 13)].filter((b): b is Brief => b !== null);
  const archive = o.archive === undefined ? readArchiveIndex(o.contentDir) : o.archive;
  const order: LinkTarget[] = [];
  const byKey = new Map<string, LinkTarget>();
  const itemFor = new Map<string, { item_id: string; edition_date: string }>();
  for (const b of briefs) {
    const refs = sourceIdFields(b);
    const rows: { s: Brief["sources"][number]; i: number; item: string | null; root: string | null }[] = [];
    b.sources.forEach((s, i) => {
      const mine = refs.filter((r) => r.id === s.id);
      const byItem = mine.filter((r) => r.item !== null);
      const live = byItem.find((r) => !b.items[r.item!]?.withheld);
      const other = mine.find((r) => r.item === null);
      if (byItem.length > 0 && !live && !other) return; // cited only by withheld items
      rows.push({ s, i, item: live ? b.items[live.item!]!.id : null, root: other ? refRoot(other.path) : null });
    });
    rows.sort((x, y) => x.s.tier - y.s.tier || x.i - y.i);
    for (const { s, item, root } of rows) {
      const key = normalizeUrl(s.url);
      if (blockedReason(s.url, o.config.sourceTiers) !== null || blockedReason(key, o.config.sourceTiers) !== null) continue;
      if (item && !itemFor.has(key)) itemFor.set(key, { item_id: item, edition_date: b.date });
      if (byKey.has(key)) continue;
      const t: LinkTarget = { url: s.url, key, tier: s.tier, item_id: root ?? "sources", edition_date: b.date };
      byKey.set(key, t);
      order.push(t);
    }
  }
  for (const t of order) {
    const it = itemFor.get(t.key);
    if (it) {
      t.item_id = it.item_id;
      t.edition_date = it.edition_date;
      continue;
    }
    const last = archive?.urls[t.key]?.item_ids.at(-1);
    const m = last ? /^(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(last) : null;
    if (m) {
      t.edition_date = m[1]!;
      t.item_id = m[2]!;
    }
  }
  return { targets: order.slice(0, LINKS_LIMITS.maxUrls), total: order.length };
}

const HTML_TYPE = /^\s*(?:text\/html|application\/xhtml\+xml)\b/i;
const HTML_SNIFF = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

/** The body as text in the charset its Content-Type names (UTF-8 when none or unknown), as the snapshot fetcher reads it. */
function decode(body: Buffer, contentType: string | null): string {
  const charset = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType ?? "")?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset).decode(body);
    } catch {
      // an unknown label: read as UTF-8
    }
  }
  return new TextDecoder("utf-8").decode(body);
}

/**
 * §8.11 step 4, by the status after redirects: 200 to 399 ok; 404, 410 and a host that does not resolve
 * broken; anything else unknown. A redirect fetchFeed would not follow (more than 5, an invalid Location, a
 * hop off https, a hop into a blocked URL) is unknown, whatever its status.
 */
export function linkResultOf(r: Pick<FetchResult, "ok" | "status" | "error">): "ok" | "unknown" | "broken" {
  if (r.ok) return "ok";
  if (r.status === 404 || r.status === 410 || r.error === "dns") return "broken";
  if (r.error !== "redirects" && r.status !== null && r.status >= 200 && r.status < 400) return "ok";
  return "unknown";
}

/** The page text's hash for a tier 1 answer, as a snapshot would store it; null when the answer is not HTML or holds no text. */
function pageHash(r: FetchResult): string | null {
  if (!r.ok || !r.body || r.body.length === 0) return null;
  const html = HTML_TYPE.test(r.contentType ?? "") || (!r.contentType && HTML_SNIFF.test(r.body.subarray(0, 512).toString("latin1")));
  if (!html) return null;
  const text = htmlText(decode(r.body, r.contentType));
  return text === "" ? null : textSha256(text);
}

/**
 * §8.11. Stops at min(now + 3 min, endLimit − 6 min) on the run's clock; fetches use realDeadline(). Each URL
 * is requested as the brief stores it (plan A13), through fetchFeed with the snapshot fetcher's headers
 * (15 s, 5 redirects, the run's user agent), 8 at a time; only tier 1 bodies are read (up to 3 MB), for the
 * hash. A URL not started before the stop, or cut by it, is not reached: counted and left as it was.
 */
export async function checkLinks(o: {
  root: string; date: string; contentDir: string; config: LoadedConfig; now: Clock; endLimit: number;
  fetch?: typeof fetchFeed; log?: (line: string) => void;
}): Promise<LinksOutcome> {
  const log = o.log ?? noop;
  const fetchImpl = o.fetch ?? realFetchFeed;
  const archive = readArchiveIndex(o.contentDir);
  const { targets, total } = linkTargets({ contentDir: o.contentDir, date: o.date, config: o.config, archive });
  if (total > targets.length) log(`links: ${total - targets.length} URLs over the cap of ${LINKS_LIMITS.maxUrls} not checked.`);
  const stop = Math.min(o.now() + LINKS_LIMITS.roundMs, o.endLimit - LINKS_LIMITS.minLeftMs);
  const results: (LinkResult | null)[] = new Array(targets.length).fill(null);
  await pool(targets, LINKS_LIMITS.concurrency, async (t, i) => {
    if (o.now() >= stop) return;
    const tier1 = t.tier === 1;
    const r = await fetchImpl(t.url, {
      timeoutMs: SNAPSHOT_LIMITS.timeoutMs,
      maxBytes: tier1 ? SNAPSHOT_LIMITS.maxBytes : 0,
      truncate: true,
      accept: SNAPSHOT_HEADERS.accept,
      acceptLanguage: SNAPSHOT_HEADERS.acceptLanguage,
      userAgent: o.config.run.user_agent,
      deadline: realDeadline(o.now, stop),
      // A redirect into a blocked URL is not followed: the link is unknown, and the blocked page is never read.
      refuseRedirect: (hop) => blockedReason(hop, o.config.sourceTiers),
    });
    if (r.error === "timeout" && o.now() >= stop) return; // cut by the stop: not reached
    let result: LinkResult["result"] = linkResultOf(r);
    let sha256: string | null = null;
    let hashedAt: string | null = null;
    if (tier1 && result === "ok") {
      const h = pageHash(r);
      const stored = archive?.urls[t.key]?.sha256 ?? null;
      if (h !== null && stored === null) {
        sha256 = h;
        hashedAt = taipeiTimestamp(new Date(o.now()));
      } else if (h !== null && stored !== h) result = "changed";
    }
    results[i] = { url: t.url, result, http: r.status, sha256, hashed_at: hashedAt };
  });
  const reached: LinkResult[] = [];
  const broken: LinkCheck["broken"] = [];
  let ok = 0;
  let unknown = 0;
  results.forEach((r, i) => {
    if (!r) return;
    reached.push(r);
    if (r.result === "ok") ok++;
    else if (r.result === "unknown") unknown++;
    else broken.push({ url: r.url, item_id: targets[i]!.item_id, edition_date: targets[i]!.edition_date, result: r.result, http: r.http });
  });
  const notReached = targets.length - reached.length;
  const changed = broken.filter((b) => b.result === "changed").length;
  log(`links: ${reached.length} checked, ${ok} ok, ${unknown} unknown, ${broken.length - changed} broken, ${changed} changed${notReached ? `, ${notReached} not reached` : ""}.`);
  return {
    record: { checked_at: taipeiTimestamp(new Date(o.now())), checked: reached.length, ok, unknown, broken },
    results: reached,
    notReached,
  };
}

/** urls[url].last_check = { date, result, http }; a stored null hash gets sha256 and hashed_at. Nothing else changes. */
export function applyLinkResults(ix: ArchiveIndex, date: string, results: readonly LinkResult[]): ArchiveIndex {
  const urls: ArchiveIndex["urls"] = { ...ix.urls };
  for (const r of results) {
    const key = normalizeUrl(r.url);
    const entry = urls[key];
    if (!entry) continue;
    const next = { ...entry, last_check: { date, result: r.result, http: r.http } };
    if (entry.sha256 === null && r.sha256 !== null) {
      next.sha256 = r.sha256;
      next.hashed_at = r.hashed_at;
    }
    urls[key] = next;
  }
  return { ...ix, urls };
}

// ── The run log ──────────────────────────────────────────────────────────────────────────────────

/**
 * logs/D.recheck.json: intake and flags (§8.9). `shown` (an addition) is the context's flag list after
 * suppression, what the agent was shown, so the build-context CLI rebuilds exactly the orchestrator's context
 * (§8.5); written when given. `links` (an addition) is written when the link check ran.
 */
export function writeRecheckLog(root: string, date: string, x: {
  intake: IntakeResult | null; flagged: Recheck | null; shown?: AgentContext["corrections"]["flagged"] | null;
  reports: AgentContext["corrections"]["reports"]; links?: LinksOutcome | null;
}): void {
  const file = runPaths(root, date).recheck;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out: Record<string, unknown> = { intake: x.intake, flagged: x.flagged, ...(x.shown !== undefined ? { shown: x.shown } : {}), reports: x.reports };
  if (x.links !== undefined) out.links = x.links;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, jsonText(out));
  fs.renameSync(tmp, file);
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

const USAGE = "Usage: tsx scripts/recheck.ts --date YYYY-MM-DD [--intake] [--flags] [--links] [--dry-run] [--json]";

/** This morning's kev and cvelist rows in cache/feeds/index.json: usable unless failed, skipped or another date's. */
function feedsOkFor(root: string, date: string): { kev: boolean; cvelist: boolean } {
  try {
    const ix = FeedIndexFile.safeParse(JSON.parse(fs.readFileSync(cachePaths(root).feedIndex, "utf8")));
    if (!ix.success || ix.data.date !== date) return { kev: false, cvelist: false };
    const okRow = (id: string) => {
      const row = ix.data.feeds.find((f) => f.id === id);
      return !!row && row.status !== "failed" && row.status !== "skipped";
    };
    return { kev: okRow("kev"), cvelist: okRow("cvelist") };
  } catch {
    return { kev: false, cvelist: false };
  }
}

/**
 * `--intake`, `--flags`, `--links`, `--dry-run`, `--json`. No mode flag runs --intake then --flags. Reads the
 * repo in the working folder and the content folder (CT_CONTENT_DIR). Intake only reads GitHub and never
 * withholds (publish does); --links prints the results and edits no archive index. Without --dry-run,
 * logs/D.recheck.json is written; with it, nothing. Exit 0 done, 1 intake unavailable or an error, 2 usage.
 * `deps.fetch` (an addition) replaces fetchFeed for the flags' records and the link check.
 */
export async function main(argv: string[] = process.argv.slice(2), deps: { now?: Clock; fetchImpl?: typeof fetch; fetch?: typeof fetchFeed } = {}): Promise<number> {
  let values: { date?: string; intake?: boolean; flags?: boolean; links?: boolean; "dry-run"?: boolean; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { date: { type: "string" }, intake: { type: "boolean" }, flags: { type: "boolean" }, links: { type: "boolean" }, "dry-run": { type: "boolean" }, json: { type: "boolean" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const now = deps.now ?? Date.now;
  const date = values.date ?? taipeiToday(new Date(now()));
  if (!isValidDate(date)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const none = !values.intake && !values.flags && !values.links;
  const doIntake = none || values.intake === true;
  const doFlags = none || values.flags === true;
  const doLinks = values.links === true;
  const dryRun = values["dry-run"] === true;
  const root = process.cwd();
  const lines: string[] = [];
  const log = (line: string) => {
    if (!values.json) process.stderr.write(`${line}\n`);
  };
  try {
    const config = loadConfig({ root });
    const content = path.resolve(root, contentDirSetting());
    let intake: IntakeResult | null = null;
    let flagged: RecheckResult | null = null;
    let links: LinksOutcome | null = null;
    if (doIntake) {
      intake = await intakeDisputes({ root, date, contentDir: content, config, now, fetchImpl: deps.fetchImpl ?? fetch, log });
      lines.push(intake.ok
        ? `Intake: ${intake.disputes.length} disputes, ${intake.withhold.length} to withhold (publish does that, not this command), ${intake.waiting} waiting, ${intake.reports.length} reports, ${intake.ignored.length} not parseable.`
        : "Dispute intake unavailable today.");
    }
    if (doFlags) {
      flagged = await recheckItems({
        root, date, contentDir: content, config, feedsOk: feedsOkFor(root, date), deadline: Date.now() + 2 * 60_000,
        fetch: deps.fetch, log, disputes: intake?.disputes ?? null,
      });
      lines.push(`Flags: ${flagged.record.items_checked} items checked, ${flagged.record.flagged.length} flags, ${flagged.shown.length} shown${flagged.skipped.length ? `; ${flagged.skipped.join(" and ")} skipped` : ""}.`);
    }
    if (doLinks) {
      links = await checkLinks({ root, date, contentDir: content, config, now, endLimit: Number.POSITIVE_INFINITY, fetch: deps.fetch, log });
      const changed = links.record.broken.filter((b) => b.result === "changed").length;
      lines.push(`Links: ${links.record.checked} checked, ${links.record.ok} ok, ${links.record.unknown} unknown, ${links.record.broken.length - changed} broken, ${changed} changed, ${links.notReached} not reached.`);
    }
    const reports = intake?.reports ?? [];
    const shown = flagged ? flagged.shown : null;
    const out = { intake, flagged: flagged?.record ?? null, shown, reports, ...(doLinks ? { links } : {}) };
    if (!dryRun) writeRecheckLog(root, date, { intake, flagged: flagged?.record ?? null, shown, reports, ...(doLinks ? { links } : {}) });
    process.stdout.write(values.json ? jsonText(out) : `${lines.join("\n")}\n`);
    return intake && !intake.ok ? 1 : 0;
  } catch (e) {
    process.stderr.write(`recheck: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main().then((code) => { process.exitCode = code; });
