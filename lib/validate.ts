// The validator engine (SPEC §4.12), copied from the Europe fork's lib/validate.ts and adapted:
// formatPath() and schemaIssues() (SCHEMA), a best-effort runRules() that skips paths overlapping a schema
// error and honours each rule's scope, † flag and metrics need, then validateDraft(), validatePublished()
// and validateAll() with the cross-file rules (FILE_NAME, FILE_UNEXPECTED, XREF_*, MANIFEST_MISMATCH,
// FILE_ORDER) and the Archived briefs policy. Also the readers scripts/validate.ts and the morning run share:
// the CVE record lookup, the regions-input file and the pack's dates.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadCheckedConfig, SAMPLE_CLAIMS_FILE, type LoadedConfig } from "./config";
import { inRange, isValidDate, utcDateOf } from "./dates";
import { Brief, RegionSignal } from "./schema/brief";
import type { AgentContext } from "./schema/context";
import { DraftBrief } from "./schema/draft-brief";
import { InputsManifest, isStateFileName, KevIndexRow, Metrics, STATE_SCHEMAS } from "./schema/metrics";
import { ArchiveIndex, CorrectionsFile, type Evidence } from "./schema/misc";
import type { Pack } from "./schema/pack";
import { ScoreboardFile } from "./schema/scoreboard";
import { StatusFile } from "./schema/status";
import { RULES } from "./rules";
import { exploitLinkProblem } from "./rules/safety";
import { derive, isDataOnly } from "./rules/shared";
import { blockedReason } from "./sources";
import {
  error, plural, warning, type CrossFile, type CveLookup, type CveRecordInfo, type RegionsBase, type Rule, type RuleInput,
  type ValidationIssue,
} from "./rules/types";
import { contentDir, isSampleData } from "./site";
import { normalizeUrl } from "./urls";
import { WITHHELD_MARK } from "./vocab";
import { bindingWithholds } from "./withhold-mask";

export type { CveLookup, CveRecordInfo, RegionsBase, Rule, RuleInput, ValidationIssue } from "./rules/types";
export { SAFETY_CODES } from "./rules/safety";

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** Codes the engine itself reports (the rules' codes are in lib/rules/). */
export const ENGINE_CODES = [
  "SCHEMA", "METRICS_MISSING", "GAP_MATCH", "DATE_MISMATCH", "FILE_NAME", "FILE_UNEXPECTED", "XREF_UNRESOLVED", "XREF_FIRST_SEEN",
  "XREF_KIND", "XREF_STATUS", "XREF_CORRECTION", "XREF_ARCHIVE", "MANIFEST_MISMATCH", "FILE_ORDER",
] as const;

/**
 * The codes that read the current safety lists (§4.12 "Archived briefs"): BLOCKED_HOSTS (NO_EXPLOIT_LINK,
 * and SOURCE_URL's redirect and archive entries), NO_LIVE_IOC's listed domains and TLDs, and
 * NO_EXPLOIT_LINK's github.tier1_paths. In validateAll() their errors on any brief other than the one
 * `publishing` names become warnings, so a list change never turns a PR red or makes publish refuse a
 * later edition; the site still skips such a brief for NO_LIVE_IOC and NO_EXPLOIT_LINK (§6 item 2).
 * SECRET_LIKE reads no list and stays an error everywhere.
 */
export const ARCHIVE_WARNING_CODES: readonly string[] = ["NO_LIVE_IOC", "NO_EXPLOIT_LINK", "SOURCE_URL"];

const BEST_EFFORT_HINT = "Found while the file also had schema errors; re-check after fixing those.";

/**
 * Codes a best-effort run keeps even where a schema error overlaps their path: they read raw strings and
 * stay true whatever the shape, and CANARY is the injection signal that must always reach the repair
 * prompt and the run record.
 */
const ALWAYS_REPORTED: ReadonlySet<string> = new Set(["CANARY", "NO_LIVE_IOC", "NO_EXPLOIT_LINK", "SECRET_LIKE"]);

// ── Schema issues ────────────────────────────────────────────────────────────────────────────────

/** `items[3].summary` from ["items", 3, "summary"]; "(root)" for the empty path. */
export function formatPath(p: readonly PropertyKey[]): string {
  let out = "";
  for (const k of p) {
    if (typeof k === "number") out += `[${k}]`;
    else out += out ? `.${String(k)}` : String(k);
  }
  return out || "(root)";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when the key at `p` is absent from its parent object in `input`. */
function keyAbsent(input: unknown, p: readonly PropertyKey[]): boolean {
  if (p.length === 0) return false;
  let cur: unknown = input;
  for (const k of p.slice(0, -1)) {
    if (cur === null || typeof cur !== "object") return false;
    cur = (cur as Record<PropertyKey, unknown>)[k as never];
  }
  return isRecord(cur) && !(String(p[p.length - 1]) in cur);
}

/**
 * SCHEMA issues (§4.12): one per Zod issue; one "Unknown key" issue per unknown key, telling the writer
 * to remove it; "Missing key" for an absent key (every key is required, §4.1). Pass the parsed `input`
 * so a missing key is told apart from a wrong value; without it the message decides.
 */
export function schemaIssues(err: z.ZodError, input?: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const issue of err.issues) {
    const base = formatPath(issue.path);
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        const p = base === "(root)" ? key : `${base}.${key}`;
        out.push(error("SCHEMA", p, `Unknown key "${key}"; remove it.`,
          "Only keys the schema defines are allowed; scripts add the computed fields at publish."));
      }
      continue;
    }
    const missing = input === undefined
      ? issue.code === "invalid_type" && /received undefined/.test(issue.message)
      : keyAbsent(input, issue.path);
    if (missing) {
      const expected = issue.code === "invalid_type" ? ` (expected ${issue.expected})`
        : issue.code === "invalid_value" ? ` (expected ${issue.values.map((v) => JSON.stringify(v)).join(" or ")})` : "";
      out.push(error("SCHEMA", base, `Missing key${expected}.`,
        "Every key is required; use null or [] when there is nothing to report."));
    } else if (issue.code === "invalid_union") {
      out.push(error("SCHEMA", base, "Doesn't match any allowed form for this field; check the schema's description."));
    } else {
      out.push(error("SCHEMA", base, issue.message));
    }
  }
  return out;
}

/** The one SCHEMA issue for a file that doesn't parse as JSON (§4.12, §8.2 step 7): rewrite it whole. */
export function unparsableIssue(file: string, err: unknown): ValidationIssue {
  const why = err instanceof Error ? err.message : String(err);
  return error("SCHEMA", "(file)", `${file} is not valid JSON (${why}); rewrite the whole file as valid JSON.`);
}

// ── Running the rules ────────────────────────────────────────────────────────────────────────────

/** True when one path is the other or lies inside it (`items[2]` and `items[2].summary`). */
export function overlaps(a: string, b: string): boolean {
  const starts = (x: string, y: string) => x === y || x.startsWith(`${y}.`) || x.startsWith(`${y}[`);
  return starts(a, b) || starts(b, a);
}

/** Whether a rule runs for this input (§4.12 "Scope"). */
export function inScope(rule: Pick<Rule, "scope">, input: Pick<RuleInput, "mode" | "crossFile">): boolean {
  if (rule.scope === "draft") return input.mode === "draft";
  if (rule.scope === "all") return input.mode === "published" && input.crossFile !== null;
  return true;
}

/**
 * Runs the registered rules on one draft or brief. Each rule runs when its scope fits the mode, when the
 * edition is not data-only or the rule is † (`dataOnly`), and when it has the metrics it needs; the rules
 * skipped for missing metrics give one METRICS_MISSING warning. With schema errors the run is best effort:
 * a rule that throws gives nothing, and an issue overlapping a schema error's path (other than an unknown
 * key) is dropped, except CANARY and the safety codes (ALWAYS_REPORTED).
 */
export function runRules(input: Omit<RuleInput, "derived">, schemaErrors: readonly ValidationIssue[] = [], rules: readonly Rule[] = RULES): ValidationIssue[] {
  const bestEffort = schemaErrors.length > 0;
  const guard = <T>(fn: () => T, fallback: T): T => {
    if (!bestEffort) return fn();
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  const derived = guard(() => derive(input.draft, input.mode, input.config), null);
  if (!derived) return [];
  const full: RuleInput = { ...input, derived };
  const blocking = schemaErrors.filter((e) => !e.message.startsWith("Unknown key")).map((e) => e.path);
  const dataOnly = isDataOnly(full);
  const skipped: string[] = [];
  const out: ValidationIssue[] = [];
  for (const rule of rules) {
    if (!inScope(rule, full)) continue;
    if (dataOnly && !rule.dataOnly) continue;
    if (rule.needsMetrics && !full.metrics) {
      skipped.push(...rule.codes);
      continue;
    }
    for (const issue of guard(() => rule.check(full), [] as ValidationIssue[])) {
      if (bestEffort && !ALWAYS_REPORTED.has(issue.code) && blocking.some((p) => overlaps(issue.path, p))) continue;
      out.push(bestEffort ? { ...issue, hint: issue.hint ?? BEST_EFFORT_HINT } : issue);
    }
  }
  if (skipped.length) {
    const codes = [...new Set(skipped)];
    out.push(warning("METRICS_MISSING", "(metrics)",
      `No metrics file for ${input.date}, so ${plural(codes.length, "check")} did not run: ${codes.join(", ")}.`,
      `Give the same-date metrics (content/metrics/${input.date}.json, else the staged copy) and validate again.`));
  }
  return out;
}

export function toResult(issues: readonly ValidationIssue[]): ValidationResult {
  const errors = issues.filter((i) => i.severity === "error");
  return { ok: errors.length === 0, errors, warnings: issues.filter((i) => i.severity === "warning") };
}

// ── Drafts ───────────────────────────────────────────────────────────────────────────────────────

/** Everything validateDraft() reads, from memory (§8.2 step 7), or from files through scripts/validate.ts. */
export interface DraftInputs {
  /** The copy in memory, never drafts/context.json. */
  context: AgentContext;
  evidence: Evidence | null;
  metrics: Metrics | null;
  config: LoadedConfig;
  cveList: CveLookup | null;
  regionsBase: RegionsBase | null;
  packDates: Record<string, string> | null;
  /** The date in a YYYY-MM-DD.json file name, when validating a file. */
  fileDate?: string | null;
  /** The rules to run; default RULES (tests pass their own). */
  rules?: readonly Rule[];
}

/** Validates the agent's draft: SCHEMA, then every draft and brief rule (best effort when the schema fails). */
export function validateDraft(input: unknown, inputs: DraftInputs): ValidationResult & { draft: DraftBrief | null } {
  const parsed = DraftBrief.safeParse(input);
  const schema = parsed.success ? [] : schemaIssues(parsed.error, input);
  const rules = parsed.success || isRecord(input)
    ? runRules({
        draft: (parsed.success ? parsed.data : input) as DraftBrief,
        mode: "draft",
        date: inputs.context.date,
        fileDate: inputs.fileDate ?? null,
        metrics: inputs.metrics,
        config: inputs.config,
        context: inputs.context,
        evidence: inputs.evidence,
        cveList: inputs.cveList,
        regionsBase: inputs.regionsBase,
        packDates: inputs.packDates,
        crossFile: null,
      }, schema, inputs.rules ?? RULES)
    : [];
  return { ...toResult([...schema, ...rules]), draft: parsed.success ? parsed.data : null };
}

// ── Published briefs ─────────────────────────────────────────────────────────────────────────────

export interface PublishedOptions {
  /** metrics/D.json for the brief's date; null skips the rules that need it (METRICS_MISSING). */
  metrics: Metrics | null;
  config: LoadedConfig;
  fileDate?: string | null;
  /** Set by validateAll() only. */
  crossFile?: CrossFile | null;
  rules?: readonly Rule[];
}

/**
 * Validates a stored brief on its own (§4.12 "Scope" brief): SCHEMA, then the brief rules in published
 * mode (frozen publishers, no context, evidence, CVE List or regions input); a data-only edition runs only
 * the † rules.
 */
export function validatePublished(input: unknown, opts: PublishedOptions): ValidationResult & { brief: Brief | null } {
  const parsed = Brief.safeParse(input);
  const schema = parsed.success ? [] : schemaIssues(parsed.error, input);
  const rawDate = isRecord(input) && typeof input.date === "string" && isValidDate(input.date) ? input.date : null;
  const rules = parsed.success || isRecord(input)
    ? runRules({
        draft: (parsed.success ? parsed.data : input) as Brief,
        mode: "published",
        date: parsed.success ? parsed.data.date : rawDate ?? opts.fileDate ?? "",
        fileDate: opts.fileDate ?? null,
        metrics: opts.metrics,
        config: opts.config,
        context: null,
        evidence: null,
        cveList: null,
        regionsBase: null,
        packDates: null,
        crossFile: opts.crossFile ?? null,
      }, schema, opts.rules ?? RULES)
    : [];
  return { ...toResult([...schema, ...rules]), brief: parsed.success ? parsed.data : null };
}

// ── Inputs read from files: CVE records, regions input, pack dates ───────────────────────────────

const CveMetadata = z.object({
  cveId: z.string(),
  state: z.enum(["PUBLISHED", "REJECTED", "RESERVED"]),
  assignerShortName: z.string().nullish().catch(null),
  datePublished: z.string().nullish().catch(null),
  dateUpdated: z.string().nullish().catch(null),
});

/** The UTC calendar date of a record timestamp (§5.1), offset applied; null when absent or unreadable. */
const utcDate = (s: unknown): string | null => {
  if (typeof s !== "string") return null;
  try {
    return utcDateOf(s);
  } catch {
    return null;
  }
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => x !== null))];

/**
 * Reads one CVE JSON 5 record (as cache/cvelist/records/<id>.json holds it) into what the CVE rules need;
 * null when it has no readable `cveMetadata`. The containers are read defensively: an odd field is skipped,
 * never fatal (the feed format rule of §4.1).
 */
export function cveRecordInfo(raw: unknown): CveRecordInfo | null {
  const meta = CveMetadata.safeParse(obj(raw).cveMetadata);
  if (!meta.success) return null;
  const containers = obj(obj(raw).containers);
  const cna = obj(containers.cna);
  const adp = arr(containers.adp).map(obj);
  const exploitTagged = (refs: unknown) => arr(refs).some((r) => arr(obj(r).tags).includes("exploit"));
  const english = arr(cna.descriptions).map(obj).find((d) => (str(d.lang) ?? "").toLowerCase().startsWith("en"));
  const englishText = english ? str(english.value) : null;
  const kevAdded = adp
    .filter((a) => obj(a.providerMetadata).shortName === "CISA-ADP")
    .flatMap((a) => arr(a.metrics).map((m) => obj(obj(m).other)))
    .map((o) => (o.type === "kev" ? utcDate(obj(o.content).dateAdded) : null))
    .find((d) => d !== null) ?? null;
  const affected = arr(cna.affected).map(obj);
  return {
    cve_id: meta.data.cveId.toUpperCase(),
    state: meta.data.state,
    date_published: utcDate(meta.data.datePublished),
    date_updated: utcDate(meta.data.dateUpdated),
    assigner: str(meta.data.assignerShortName),
    vendors: uniq(affected.map((a) => str(a.vendor))),
    products: uniq(affected.map((a) => str(a.product))),
    title: str(cna.title) ?? (englishText ? englishText.slice(0, 200) : null),
    exploit_reference: exploitTagged(cna.references) || adp.some((a) => exploitTagged(a.references)),
    kev_date_added: kevAdded,
    credits: uniq([...arr(cna.credits), ...adp.flatMap((a) => arr(a.credits))].map((c) => str(obj(c).value))),
  };
}

/**
 * The CVE List lookup over a records folder (`<dir>/<CVE id>.json`, CVE JSON 5): each record is read on
 * first use and kept. Throws when the folder doesn't exist; a record that is missing or unreadable is
 * undefined (an unknown id fails CVE_PUBLISHED).
 */
export function cveLookupFromDir(dir: string): CveLookup {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`No CVE records folder at ${dir}`);
  const cache = new Map<string, CveRecordInfo | undefined>();
  return {
    get(cveId: string) {
      const id = cveId.toUpperCase();
      if (!/^CVE-\d{4}-\d{4,}$/.test(id)) return undefined;
      if (!cache.has(id)) {
        let info: CveRecordInfo | undefined;
        try {
          const rec = cveRecordInfo(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")));
          info = rec && rec.cve_id === id ? rec : undefined;
        } catch {
          info = undefined;
        }
        cache.set(id, info);
      }
      return cache.get(id);
    },
  };
}

/**
 * logs/D.regions-input.json and fixtures/regions-input/<name>.json: the validator's regionsBase without
 * its config (§8.2 step 6.2), which the reader rebuilds from config/ (regionsConfig()). History briefs
 * keep only the fields computeRegions() reads; other keys are dropped on reading. `firstSeen` is the
 * base's first_seen map (firstSeenBefore(), item id → date), so the validate and publish CLIs give
 * today's items the first_seen the morning's loop gave them; a file without it falls back to the history.
 */
export const RegionsInputFile = z.object({
  date: z.string().refine(isValidDate, { error: "Expected a date as YYYY-MM-DD" }),
  history: z.array(z.object({ date: Brief.shape.date, items: Brief.shape.items, sources: Brief.shape.sources, regions: Brief.shape.regions })),
  signals: z.array(RegionSignal),
  kevIndex: z.object({ entries: z.array(KevIndexRow) }),
  firstSeen: z.record(z.string(), Brief.shape.date).optional(),
});
export type RegionsInputFile = z.infer<typeof RegionsInputFile>;

/** What to write to the regions-input file for a regionsBase: everything but the config. */
export function regionsInputFile(base: RegionsBase): RegionsInputFile {
  return {
    date: base.date,
    history: base.history.map((h) => ({ date: h.date, items: [...h.items], sources: [...h.sources], regions: h.regions })),
    signals: [...base.signals],
    kevIndex: { entries: [...base.kevIndex.entries] },
    ...(base.firstSeen ? { firstSeen: { ...base.firstSeen } } : {}),
  };
}

/** RuleInput.packDates from a pack: normalised URL → an item's published_at, else a record's date. */
export function packDatesOf(pack: Pick<Pack, "items" | "records">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of pack.items) out[normalizeUrl(it.url)] = it.published_at;
  for (const r of pack.records) {
    const key = normalizeUrl(r.url);
    if (!(key in out)) out[key] = r.date;
  }
  return out;
}

// ── The content folder ───────────────────────────────────────────────────────────────────────────

export interface FileResult extends ValidationResult {
  /** Relative to the content folder, "/"-separated: "briefs/2026-11-08.json". */
  file: string;
}

export interface AllResult extends ValidationResult {
  /** With `perFile`: every file checked (and archive-index.json when it is missing but needed), issues with unprefixed paths; else []. */
  files: FileResult[];
}

export interface AllOptions {
  /** The edition publish is writing (§8.7 step 6): its brief also gets COMPUTED_MISMATCH's config-derived checks and keeps safety errors. */
  publishing?: string;
  /** The config the run loaded; default loadCheckedConfig() (with fixtures/config/claims.json for a folder under fixtures/). */
  config?: LoadedConfig;
  /** Also return the issues per file (the site's loadContent(), §6). */
  perFile?: boolean;
  /** The rules to run; default RULES (tests pass their own). */
  rules?: readonly Rule[];
}

const DATED_DIRS = [
  { prefix: "metrics/inputs/", kind: "inputs" },
  { prefix: "briefs/", kind: "brief" },
  { prefix: "metrics/", kind: "metrics" },
  { prefix: "status/", kind: "status" },
] as const;

const TOP_FILES = { "scoreboard.json": "scoreboard", "corrections.json": "corrections", "archive-index.json": "archive" } as const;

/** Names a filesystem walk can meet that git ignores (.gitignore `.DS_Store`): never content, never reported. */
const IGNORED_NAMES: ReadonlySet<string> = new Set([".DS_Store"]);

const DATED_NAME_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (IGNORED_NAMES.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk("");
  return out.sort();
}

/** The config for a content folder: the given one, else loadCheckedConfig(), with the SAMPLE claims for a folder under fixtures/. */
function configFor(dir: string): LoadedConfig {
  const base = loadCheckedConfig();
  if (base.sampleClaims || !isSampleData(dir, base.root)) return base;
  const claims: unknown = JSON.parse(fs.readFileSync(path.join(base.root, SAMPLE_CLAIMS_FILE), "utf8"));
  return loadCheckedConfig({ root: base.root, overrides: { claims } });
}

interface Loaded<T> {
  file: string;
  raw: unknown;
  data: T | null;
}

/** An item as the cross-file checks read it, from a parsed brief or (leniently) from one that failed its schema. */
interface ItemView {
  file: string;
  date: string;
  index: number;
  id: string;
  kind: string | null;
  first_seen: string | null;
}

function itemViews(file: string, date: string, raw: unknown): ItemView[] {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return [];
  return raw.items.flatMap((it, index) => (isRecord(it) && typeof it.id === "string" ? [{
    file, date, index, id: it.id,
    kind: typeof it.kind === "string" ? it.kind : null,
    first_seen: typeof it.first_seen === "string" ? it.first_seen : null,
  }] : []));
}

const sameTime = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === "string" && typeof b === "string" && Date.parse(a) === Date.parse(b);

/** The counts in a metrics file that its inputs manifest lists ids or rows for (§4.7); blocks that aren't "ok" are skipped. */
export function manifestIssues(m: Metrics, inp: InputsManifest): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const check = (p: string, stored: number, listed: number, what: string) => {
    if (stored !== listed) {
      out.push(error("MANIFEST_MISMATCH", p, `${p} is ${stored} but the inputs manifest lists ${listed} ${what}.`,
        "The metrics file and its manifest come from one metrics run; recompute both rather than editing either."));
    }
  };
  if (m.window && m.blocks.window.status === "ok") {
    for (const w of ["w26", "w13"] as const) {
      const rows = inp.window[w];
      const s = m.window[w];
      const band = (b: string) => rows.filter((r) => r.band === b).length;
      const cohort = rows.filter((r) => r.band === "at_disclosure" || r.band === "n_day" || r.band === "late");
      check(`window.${w}.kev_added_n`, s.kev_added_n, rows.length, `window.${w} rows`);
      check(`window.${w}.unjoined_n`, s.unjoined_n, band("unjoined"), "unjoined rows");
      check(`window.${w}.cohort_n`, s.cohort_n, cohort.length, "rows with a lag of 365 days or less");
      check(`window.${w}.old_listed_n`, s.old_listed_n, band("old"), "old rows");
      check(`window.${w}.at_disclosure_n`, s.at_disclosure_n, band("at_disclosure"), "at_disclosure rows");
      check(`window.${w}.n_day_n`, s.n_day_n, band("n_day"), "n_day rows");
      check(`window.${w}.after_disclosure_n`, s.after_disclosure_n, band("n_day") + band("late"), "rows with a lag of 2 to 365 days");
      check(`window.${w}.k7_n`, s.k7_n, cohort.filter((r) => r.lag_days !== null && r.lag_days <= 7).length, "rows with a lag of 7 days or less");
    }
  }
  if (m.kev && m.blocks.kev.status === "ok") {
    const stored = [...new Set(m.kev.new_since_last_edition.cve_ids)].sort();
    const listed = [...new Set(inp.kev_new)].sort();
    if (stored.join() !== listed.join()) {
      out.push(error("MANIFEST_MISMATCH", "kev.new_since_last_edition.cve_ids",
        `kev.new_since_last_edition lists ${plural(stored.length, "CVE")} but the manifest's kev_new lists ${listed.length}, and they differ.`,
        "The metrics file and its manifest come from one metrics run; recompute both rather than editing either."));
    }
  }
  if (m.home_vendors && m.blocks.home_vendors.status === "ok") {
    for (const k of ["tw", "jp"] as const) {
      const hv = m.home_vendors[k];
      const rows = inp.home_vendors[k];
      check(`home_vendors.${k}.d90_n`, hv.d90_n, rows.filter((r) => inRange(r.date_added, hv.d90_from, hv.to)).length, "rows in the 90 days");
      check(`home_vendors.${k}.d30_n`, hv.d30_n, rows.filter((r) => inRange(r.date_added, hv.d30_from, hv.to)).length, "rows in the 30 days");
      check(`home_vendors.${k}.cve_ids_90`, hv.cve_ids_90.length, rows.filter((r) => inRange(r.date_added, hv.d90_from, hv.to)).length, "rows in the 90 days");
    }
  }
  if (m.flood && m.blocks.flood.status === "ok") {
    const f = m.flood;
    const sum = (from: string, to: string, key: "n" | "kernel_n" | "unscored_n") =>
      inp.flood.days.filter((d) => inRange(d.date, from, to)).reduce((a, d) => a + d[key], 0);
    check("flood.n", f.n, sum(f.from, f.to, "n"), "records over the manifest's days");
    check("flood.kernel_n", f.kernel_n, sum(f.from, f.to, "kernel_n"), "kernel records over the manifest's days");
    check("flood.unscored_n", f.unscored_n, sum(f.from, f.to, "unscored_n"), "unscored records over the manifest's days");
    check("flood.year_ago.n", f.year_ago.n, sum(f.year_ago.from, f.year_ago.to, "n"), "records over the manifest's year-ago days");
    check("flood.year_ago.kernel_n", f.year_ago.kernel_n, sum(f.year_ago.from, f.year_ago.to, "kernel_n"), "kernel records over the manifest's year-ago days");
  }
  if (m.ai_credited && m.blocks.ai_credited.status === "ok") {
    const a = m.ai_credited;
    const inWindow = inp.ai_credited.filter((x) => inRange(x.published, a.from, a.to));
    const families = new Map<string, string>();
    for (const x of inWindow) if (x.rule !== "cvd_ledger" && !families.has(x.id)) families.set(x.id, x.family);
    const fam = (f: string) => [...families.values()].filter((v) => v === f).length;
    const credited = new Set(families.keys());
    const ledgerOnly = new Set(inWindow.filter((x) => x.rule === "cvd_ledger" && !credited.has(x.id)).map((x) => x.id));
    check("ai_credited.w13.total", a.w13.total, families.size, "credited records in the window");
    for (const f of ["anthropic", "openai", "google", "other"] as const) {
      check(`ai_credited.w13.by_family.${f}`, a.w13.by_family[f], fam(f), `${f} records in the window`);
    }
    check("ai_credited.w13.ex_anthropic", a.w13.ex_anthropic, families.size - fam("anthropic"), "credited records outside Anthropic");
    check("ai_credited.w13.ledger_only_anthropic", a.w13.ledger_only_anthropic, ledgerOnly.size, "ledger-only ids in the window");
  }
  return out;
}

/**
 * `npm run validate:all` (§4.12 "validateAll() cross-file rules"): every file under `dir` against its
 * schema (SCHEMA), every brief through validatePublished() with its same-date metrics, then the cross-file
 * rules. An empty or missing folder passes; a top-level README.md is allowed. On every brief except the
 * one `publishing` names, errors from ARCHIVE_WARNING_CODES are warnings (§4.12 "Archived briefs").
 * Issue paths are prefixed with the file ("briefs/2026-11-08.json: items[0].headline").
 */
export function validateAll(dir: string = contentDir(), opts: AllOptions = {}): AllResult {
  const root = path.resolve(dir);
  const byFile = new Map<string, ValidationIssue[]>();
  const add = (file: string, ...issues: ValidationIssue[]) => {
    const list = byFile.get(file) ?? [];
    list.push(...issues);
    byFile.set(file, list);
  };
  const finish = (): AllResult => {
    const files = [...byFile.keys()].sort();
    const all = files.flatMap((f) => byFile.get(f)!.map((i) => ({ ...i, path: `${f}: ${i.path}` })));
    return { ...toResult(all), files: opts.perFile ? files.map((file) => ({ file, ...toResult(byFile.get(file)!) })) : [] };
  };
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return finish();

  let cfg: LoadedConfig | null = opts.config ?? null;
  const config = () => (cfg ??= configFor(root));

  const briefs = new Map<string, Loaded<Brief>>();
  const metrics = new Map<string, Loaded<Metrics>>();
  const inputs = new Map<string, Loaded<InputsManifest>>();
  const status = new Map<string, Loaded<StatusFile>>();
  let scoreboard: Loaded<ScoreboardFile> | null = null;
  let corrections: Loaded<CorrectionsFile> | null = null;
  let archive: Loaded<ArchiveIndex> | null = null;

  const read = (file: string): { ok: true; raw: unknown } | { ok: false } => {
    try {
      return { ok: true, raw: JSON.parse(fs.readFileSync(path.join(root, file), "utf8")) };
    } catch (e) {
      add(file, unparsableIssue(file, e));
      return { ok: false };
    }
  };
  const parse = <T>(file: string, schema: z.ZodType<T>): Loaded<T> | null => {
    const r = read(file);
    if (!r.ok) return null;
    const p = schema.safeParse(r.raw);
    if (!p.success) add(file, ...schemaIssues(p.error, r.raw));
    return { file, raw: r.raw, data: p.success ? p.data : null };
  };

  for (const file of listFiles(root)) {
    add(file);
    if (file === "README.md") continue;
    if (Object.hasOwn(TOP_FILES, file)) {
      const kind = TOP_FILES[file as keyof typeof TOP_FILES];
      if (kind === "scoreboard") scoreboard = parse(file, ScoreboardFile);
      else if (kind === "corrections") corrections = parse(file, CorrectionsFile);
      else archive = parse(file, ArchiveIndex);
      continue;
    }
    const stateName = file.startsWith("state/") ? file.slice(6) : null;
    if (stateName !== null && isStateFileName(stateName)) {
      const schema: z.ZodType = STATE_SCHEMAS[stateName];
      parse(file, schema);
      continue;
    }
    const dated = DATED_DIRS.find((d) => file.startsWith(d.prefix) && !file.slice(d.prefix.length).includes("/"));
    if (!dated) {
      add(file, error("FILE_UNEXPECTED", "(file)",
        `${file} is outside content/'s layout (briefs/, metrics/, metrics/inputs/, status/, the state/ files, scoreboard.json, corrections.json, archive-index.json, README.md).`,
        "Delete it or move it out of the content folder; publish never stages it."));
      continue;
    }
    const name = file.slice(dated.prefix.length);
    const m = DATED_NAME_RE.exec(name);
    if (!m || !isValidDate(m[1]!)) {
      add(file, error("FILE_NAME", "(file)", `${file} must be named YYYY-MM-DD.json with a real date.`, "Rename it to its date."));
      continue;
    }
    const date = m[1]!;
    if (dated.kind === "brief") {
      const r = read(file);
      if (r.ok) briefs.set(date, { file, raw: r.raw, data: null });
      continue;
    }
    const loaded = dated.kind === "metrics" ? parse(file, Metrics) : dated.kind === "inputs" ? parse(file, InputsManifest) : parse(file, StatusFile);
    if (!loaded) continue;
    if (loaded.data && loaded.data.date !== date) {
      add(file, error("DATE_MISMATCH", "date", `date is ${loaded.data.date} but the file is named ${date}.json; they must match.`));
    }
    if (dated.kind === "metrics") metrics.set(date, loaded as Loaded<Metrics>);
    else if (dated.kind === "inputs") inputs.set(date, loaded as Loaded<InputsManifest>);
    else status.set(date, loaded as Loaded<StatusFile>);
  }

  // Briefs: parse once, then validatePublished() with the same-date metrics and the cross-file view.
  const dates = [...briefs.keys()].sort();
  for (const date of dates) {
    const b = briefs.get(date)!;
    const p = Brief.safeParse(b.raw);
    b.data = p.success ? p.data : null;
  }
  const parsedBriefs = dates.flatMap((d) => (briefs.get(d)!.data ? [briefs.get(d)!.data!] : []));
  for (const date of dates) {
    const b = briefs.get(date)!;
    const m = metrics.get(date)?.data ?? null;
    const r = validatePublished(b.raw, {
      metrics: m,
      config: config(),
      fileDate: date,
      crossFile: { publishing: date === opts.publishing, inputs: inputs.get(date)?.data ?? null, briefs: parsedBriefs },
      rules: opts.rules,
    });
    const archived = date !== opts.publishing;
    add(b.file, ...[...r.errors, ...r.warnings].map((i) =>
      (archived && i.severity === "error" && ARCHIVE_WARNING_CODES.includes(i.code) ? { ...i, severity: "warning" as const } : i)));
    if (!m) {
      add(b.file, error("GAP_MATCH", "gap", `No valid metrics/${date}.json to check the Gap block and the Lens KEV lines against.`,
        "Every brief is published with its same-date metrics file; the site treats this brief's Gap as missing."));
    }
    if (!metrics.has(date)) add(b.file, error("XREF_UNRESOLVED", "(root)", `No metrics/${date}.json for this brief.`, "Publish commits the day's metrics with its brief."));
    if (!status.has(date)) add(b.file, error("XREF_UNRESOLVED", "(root)", `No status/${date}.json for this brief.`, "Publish writes the run's status file with every edition."));
  }

  // XREF_FIRST_SEEN, XREF_KIND: every item id across the briefs, oldest first.
  const views = dates.flatMap((d) => itemViews(briefs.get(d)!.file, d, briefs.get(d)!.raw));
  const firstById = new Map<string, ItemView>();
  for (const v of views) if (!firstById.has(v.id)) firstById.set(v.id, v);
  for (const v of views) {
    const first = firstById.get(v.id)!;
    if (v.first_seen !== null && v.first_seen !== first.date) {
      add(v.file, error("XREF_FIRST_SEEN", `items[${v.index}].first_seen`,
        `first_seen is ${v.first_seen} but ${v.id} first appears in ${first.file}; set it to ${first.date}.`));
    }
    if (v !== first && v.kind !== null && first.kind !== null && v.kind !== first.kind) {
      add(v.file, error("XREF_KIND", `items[${v.index}].kind`,
        `${v.id} is ${v.kind} here but ${first.kind} in ${first.file}; one item id keeps one kind.`,
        "Use a new id for a different kind of event."));
    }
  }

  // XREF_STATUS: each status file's final edition and publish time against its brief.
  for (const [date, s] of status) {
    if (!s.data) continue;
    const runs = s.data.runs;
    const lastIndex = (pick: (r: (typeof runs)[number]) => unknown) => {
      for (let i = runs.length - 1; i >= 0; i -= 1) if (pick(runs[i]!) !== null) return i;
      return -1;
    };
    const ei = lastIndex((r) => r.edition);
    const edition = ei >= 0 ? runs[ei]!.edition : null;
    const b = briefs.get(date);
    if (!b) {
      if (edition !== null) {
        add(s.file, error("XREF_STATUS", `runs[${ei}].edition`, `The status file records a ${edition} edition for ${date}, but there is no briefs/${date}.json.`));
      }
      continue;
    }
    if (!b.data) continue;
    if (edition !== b.data.edition) {
      add(s.file, error("XREF_STATUS", ei >= 0 ? `runs[${ei}].edition` : "runs",
        `The status file's final edition is ${edition ?? "none"} but briefs/${date}.json is a ${b.data.edition} edition.`));
    }
    const key = b.data.edition === "data_only" ? "data_only_published_at" : "full_published_at";
    const ti = lastIndex((r) => r[key]);
    const at = ti >= 0 ? runs[ti]![key] : null;
    if (!sameTime(at, b.data.published_at)) {
      add(s.file, error("XREF_STATUS", ti >= 0 ? `runs[${ti}].${key}` : "runs",
        `The status file's ${key} is ${at ?? "not set"} but briefs/${date}.json was published at ${b.data.published_at}.`));
    }
  }

  // Claims (XREF_UNRESOLVED): every claim id a brief or the Scoreboard names is in config/claims.json.
  const claimIds = () => new Set(config().claims.claims.map((c) => c.id));
  const unknownClaim = (file: string, p: string, id: string | null | undefined) => {
    if (typeof id === "string" && !claimIds().has(id)) {
      add(file, error("XREF_UNRESOLVED", p, `Claim ${id} is not in config/claims.json.`, "Claims are added only by a PR to config/claims.json."));
    }
  };
  for (const date of dates) {
    const b = briefs.get(date)!;
    if (!b.data) continue;
    unknownClaim(b.file, "angle.claim_id", b.data.angle?.claim_id);
    b.data.scoreboard.entries.forEach((e, i) => unknownClaim(b.file, `scoreboard.entries[${i}].claim_id`, e.claim_id));
    unknownClaim(b.file, "scoreboard.last.claim_id", b.data.scoreboard.last?.claim_id);
    if (b.data.week_in_review) {
      unknownClaim(b.file, "week_in_review.strongest_against.claim_id", b.data.week_in_review.strongest_against.claim_id);
      b.data.week_in_review.table.forEach((t, i) => unknownClaim(b.file, `week_in_review.table[${i}].claim_id`, t.claim_id));
    }
  }
  if (scoreboard?.data) {
    const sb = scoreboard.data;
    sb.claims.forEach((c, i) => {
      unknownClaim(scoreboard!.file, `claims[${i}].id`, c.id);
      const prev = sb.claims[i - 1];
      if (prev && prev.id > c.id) {
        add(scoreboard!.file, error("FILE_ORDER", `claims[${i}]`, `scoreboard.json claims must be sorted by claim id (${c.id} comes after ${prev.id}).`));
      }
    });
    sb.entries.forEach((e, i) => unknownClaim(scoreboard!.file, `entries[${i}].claim_id`, e.claim_id));
  }

  // Corrections: targets (XREF_UNRESOLVED), withholds and ids (XREF_CORRECTION), order (FILE_ORDER).
  if (corrections?.data) {
    const cf = corrections.data;
    const file = corrections.file;
    // A withhold whose stored dispute is open or upheld binds every later edition (§4.10): publish rewrites
    // or masks each later copy of the item, so those are checked too. A rejected or withdrawn dispute binds
    // nothing after its edition, so a later copy may stand.
    const binding = new Set(bindingWithholds(cf).map((w) => w.correction_id));
    cf.corrections.forEach((c, i) => {
      const p = `corrections[${i}]`;
      const target = briefs.get(c.edition_date);
      if (!target) {
        add(file, error("XREF_UNRESOLVED", `${p}.edition_date`, `${c.id} targets ${c.edition_date}, which has no brief.`));
      } else if (!itemViews(target.file, c.edition_date, target.raw).some((v) => v.id === c.item_id)) {
        add(file, error("XREF_UNRESOLVED", `${p}.item_id`, `${c.id} targets ${c.item_id}, which is not an item in ${target.file}.`));
      } else if (c.type === "name_removed" && target.data) {
        const kind = cf.disputes.find((d) => d.id === c.dispute_id)?.kind ?? null;
        // The target brief, and every earlier stored brief holding the item: an item keeps its id in every
        // edition it appears in (§4.6), so an earlier edition left as it was would still show the name. While
        // the withhold binds, every later brief holding the item too.
        const holders = [...briefs].filter(([d, b]) => (d <= c.edition_date || binding.has(c.id)) && b.data?.items.some((it) => it.id === c.item_id))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        for (const [, held] of holders) {
          const data = held.data!;
          const idx = data.items.findIndex((it) => it.id === c.item_id);
          const it = data.items[idx]!;
          const where = `${held.file} items[${idx}]`;
          const problems: string[] = [];
          if (it.withheld === null) problems.push("withheld is not set");
          if (kind === "victim" && it.incident?.victim != null) problems.push("incident.victim is not null after a victim dispute");
          if (kind === "attribution" && (it.attribution.length > 0 || it.actor_nexus !== null)) {
            problems.push("attribution is not [] or actor_nexus is not null after an attribution dispute");
          }
          // A region reason embeds the item's headline (§5.11): every row and raise that lists it reads "[withheld]".
          data.regions.rows.forEach((r, k) => {
            if (r.item_ids.includes(c.item_id) && r.reason !== WITHHELD_MARK) problems.push(`regions.rows[${k}].reason is not "${WITHHELD_MARK}"`);
            if (r.raised?.item_ids.includes(c.item_id) && r.raised.reason !== WITHHELD_MARK) {
              problems.push(`regions.rows[${k}].raised.reason is not "${WITHHELD_MARK}"`);
            }
          });
          if (problems.length) {
            add(file, error("XREF_CORRECTION", p, `${c.id} removes a name but ${where} is not rewritten: ${problems.join("; ")}.`,
              "A name_removed correction rewrites the archived item as SPEC §4.10 says."));
          }
        }
      }
      const prev = cf.corrections[i - 1];
      if (prev && (prev.date > c.date || (prev.date === c.date && prev.id > c.id))) {
        add(file, error("FILE_ORDER", p, `corrections.json must be sorted by date, then id (${c.id} comes after ${prev.id}).`));
      }
    });
    // NO_EXPLOIT_LINK: a reader's evidence link is published in corrections.json, so it gets the cited-URL check as a
    // tier 3 page (any exploit word in its path fails, on any host), and no blocked host passes (§8.9 intake keeps neither).
    cf.disputes.forEach((d, i) => {
      if (d.evidence_url === null) return;
      const tiers = config().sourceTiers;
      const why = exploitLinkProblem(d.evidence_url, 3, tiers) ?? (blockedReason(d.evidence_url, tiers) !== null ? "is on the blocked list" : null);
      if (why) {
        add(file, error("NO_EXPLOIT_LINK", `disputes[${i}].evidence_url`, `${d.id}'s evidence link ${why}.`,
          "Set the dispute's evidence_url to null: dispute intake keeps only a safe https link (SPEC §8.9)."));
      }
    });
    // Links (§4.10, §8.9): a correction's dispute_id names a dispute whose correction_id is that correction, and a
    // dispute's correction_id names a correction on its item (and its edition, when it names one) that answers a
    // dispute. Not the strict reverse: intake answers a later dispute on an item and edition a stored name_removed
    // correction already withholds with that correction's id, so one correction can answer several disputes.
    // The first record under an id (a repeated id is its own error below).
    const disputeById = new Map([...cf.disputes].reverse().map((d) => [d.id, d] as const));
    const correctionById = new Map([...cf.corrections].reverse().map((c) => [c.id, c] as const));
    const LINK_HINT = "Publish links both records: the correction's dispute_id and the dispute's correction_id (SPEC §4.10, §8.9).";
    cf.corrections.forEach((c, i) => {
      if (c.dispute_id === null) return;
      const d = disputeById.get(c.dispute_id);
      const why = !d ? "which is not a dispute in corrections.json"
        : d.correction_id !== c.id ? `but ${d.id}'s correction_id is ${d.correction_id ?? "null"}` : null;
      if (why) add(file, error("XREF_CORRECTION", `corrections[${i}].dispute_id`, `${c.id} answers ${c.dispute_id}, ${why}.`, LINK_HINT));
    });
    cf.disputes.forEach((d, i) => {
      if (d.correction_id === null) return;
      const c = correctionById.get(d.correction_id);
      const why = !c ? "which is not a correction in corrections.json"
        : c.item_id !== d.item_id || (d.edition_date !== null && c.edition_date !== d.edition_date)
          ? `which corrects ${c.item_id} in ${c.edition_date}, not ${d.item_id} in ${d.edition_date ?? "any edition"}`
          : c.dispute_id === null ? "which answers no dispute" : null;
      if (why) add(file, error("XREF_CORRECTION", `disputes[${i}].correction_id`, `${d.id} names ${d.correction_id}, ${why}.`, LINK_HINT));
    });
    const numbers = cf.corrections.map((c) => Number(c.id.slice(2)));
    const seen = new Set<number>();
    cf.corrections.forEach((c, i) => {
      const n = numbers[i]!;
      if (seen.has(n)) add(file, error("XREF_CORRECTION", `corrections[${i}].id`, `${c.id} is used twice; correction ids are unique.`));
      seen.add(n);
    });
    const sorted = [...seen].sort((a, b) => a - b);
    const gap = sorted.findIndex((n, i) => n !== i + 1);
    if (gap >= 0) {
      add(file, error("XREF_CORRECTION", "corrections",
        `Correction ids must run C-0001, C-0002, ... with no gaps; C-${String(gap + 1).padStart(4, "0")} is missing.`));
    }
  }

  // XREF_ARCHIVE and FILE_ORDER: archive-index.json lists exactly the briefs, newest first.
  if (archive?.data) {
    const ed = archive.data.editions;
    const file = archive.file;
    const firstAt = new Map<string, number>();
    ed.forEach((e, i) => {
      const p = `editions[${i}]`;
      if (firstAt.has(e.date)) add(file, error("XREF_ARCHIVE", p, `${e.date} is listed twice.`));
      else firstAt.set(e.date, i);
      const b = briefs.get(e.date);
      if (!b) add(file, error("XREF_ARCHIVE", p, `${e.date} is listed but there is no briefs/${e.date}.json.`));
      else if (b.data && (e.edition !== b.data.edition || !sameTime(e.published_at, b.data.published_at))) {
        add(file, error("XREF_ARCHIVE", p,
          `${e.date} is listed as ${e.edition}, published ${e.published_at}, but the brief is ${b.data.edition}, published ${b.data.published_at}.`));
      }
      const prev = ed[i - 1];
      if (prev && prev.date <= e.date) add(file, error("FILE_ORDER", p, `archive-index.json editions must be newest first (${e.date} comes after ${prev.date}).`));
    });
    for (const date of dates) {
      if (!firstAt.has(date)) add(file, error("XREF_ARCHIVE", "editions", `briefs/${date}.json is not listed.`, "Publish adds every edition to archive-index.json."));
    }
  } else if (!archive && dates.length) {
    add("archive-index.json", error("XREF_ARCHIVE", "(file)", `archive-index.json is missing but ${plural(dates.length, "brief")} ${dates.length === 1 ? "exists" : "exist"}.`,
      "Publish writes archive-index.json with every edition."));
  }

  // MANIFEST_MISMATCH: each metrics file against its inputs manifest.
  for (const [date, m] of metrics) {
    if (!m.data) continue;
    const named = m.data.provenance.inputs_file;
    const inp = inputs.get(date);
    if (!inp || named !== `metrics/inputs/${date}.json`) {
      add(m.file, error("MANIFEST_MISMATCH", "provenance.inputs_file",
        `provenance.inputs_file is ${named}, but metrics/inputs/${date}.json ${inp ? "is the same-date manifest" : "is missing"}.`,
        "Every metrics file is committed with its inputs manifest (SPEC §4.7)."));
      continue;
    }
    if (inp.data) add(m.file, ...manifestIssues(m.data, inp.data));
  }

  return finish();
}
