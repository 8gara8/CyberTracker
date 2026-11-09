// Loads and checks config/ (SPEC §4.11, §4.13, §5.11). loadConfig() parses every file with its schema
// (CONFIG_SCHEMA) and compiles every regex once (CONFIG_REGEX); validateConfig() runs the cross-file checks
// (CONFIG_DUP, CONFIG_REF, CONFIG_REGEX's examples). `npm run check` runs both, and preflight runs both
// every morning (E_CONFIG). Also here, defined once: normalizeVendor() and matchVendor() (§4.11, §5.7),
// and matchCredit(), the per-string AI-credit matcher of §5.5 that the examples check runs.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { ClaimsFile } from "./schema/scoreboard";
import {
  ActorsFile, AiFindersFile, AnnotationsFile, RegionsFile, RunFile, SourceTiersFile, StandingStoriesFile, VendorsFile,
  WatchWindowsFile, type Finder, type RegionRule, type Vendor,
} from "./schema/config";
import { SourcesFile } from "./schema/registry";
import type { ValidationIssue } from "./rules/types";
import { contentDir, isSampleData } from "./site";
import { TIER1_PATH_FLAGS } from "./sources";
import { countWords } from "./text";
import type { FinderFamily, FinderKind, RegionRuleType } from "./vocab";

// ── Files ────────────────────────────────────────────────────────────────────────────────────────

/** Every config file, by the key LoadedConfig and `overrides` use. */
export const CONFIG_FILES = {
  run: "run.json",
  sources: "sources.yaml",
  sourceTiers: "source-tiers.json",
  vendors: "vendors.json",
  aiFinders: "ai-finders.json",
  regions: "regions.json",
  annotations: "annotations.json",
  actors: "actors.json",
  watchWindows: "watch-windows.json",
  standingStories: "standing-stories.json",
  claims: "claims.json",
} as const;
export type ConfigKey = keyof typeof CONFIG_FILES;
export const CONFIG_KEYS = Object.keys(CONFIG_FILES) as ConfigKey[];

const SCHEMAS = {
  run: RunFile,
  sources: SourcesFile,
  sourceTiers: SourceTiersFile,
  vendors: VendorsFile,
  aiFinders: AiFindersFile,
  regions: RegionsFile,
  annotations: AnnotationsFile,
  actors: ActorsFile,
  watchWindows: WatchWindowsFile,
  standingStories: StandingStoriesFile,
  claims: ClaimsFile,
} as const satisfies Record<ConfigKey, z.ZodType>;

/** The folder every config file lives in, relative to the repo root. */
export const CONFIG_DIR = "config";
/** The SAMPLE claims (SB-01, SB-02) loaded in place of config/claims.json in sample mode (§4.11). */
export const SAMPLE_CLAIMS_FILE = "fixtures/config/claims.json";

/** Each file's parsed contents. */
export type ConfigFiles = { [K in ConfigKey]: z.output<(typeof SCHEMAS)[K]> };

// ── Issues ───────────────────────────────────────────────────────────────────────────────────────

export const CONFIG_CODES = ["CONFIG_SCHEMA", "CONFIG_DUP", "CONFIG_REF", "CONFIG_REGEX"] as const;
export type ConfigCode = (typeof CONFIG_CODES)[number];

/** lib/rules/types.ts ValidationIssue (§4.12): one shape, so config issues join the validator's reports. */
export type ConfigIssue = ValidationIssue;

function issue(code: ConfigCode, where: string, message: string, hint: string | null = null): ConfigIssue {
  return { code, severity: "error", path: where, message, hint };
}

/** Thrown by loadConfig() when a file is missing, does not parse or a regex does not compile. */
export class ConfigError extends Error {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[]) {
    const head = issues.slice(0, 5).map((i) => `${i.code} ${i.path}: ${i.message}`);
    const more = issues.length > 5 ? [`and ${issues.length - 5} more`] : [];
    super(`config: ${issues.length} problem${issues.length === 1 ? "" : "s"}\n${[...head, ...more].join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function formatPath(p: readonly PropertyKey[]): string {
  let out = "";
  for (const k of p) out += typeof k === "number" ? `[${k}]` : out ? `.${String(k)}` : String(k);
  return out;
}

const at = (file: string, p: string) => (p ? `${file}: ${p}` : file);

function schemaIssues(file: string, err: z.ZodError): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const i of err.issues) {
    const base = formatPath(i.path);
    if (i.code === "unrecognized_keys") {
      for (const key of i.keys) out.push(issue("CONFIG_SCHEMA", at(file, base ? `${base}.${key}` : key), `Unknown key "${key}"; remove it.`));
      continue;
    }
    const missing = i.code === "invalid_type" && /received undefined/.test(i.message);
    out.push(issue("CONFIG_SCHEMA", at(file, base), missing ? `Missing key (expected ${i.expected}).` : i.message,
      missing ? "Every key is written out; use null or [] when there is nothing to say (§4.1)." : null));
  }
  return out;
}

// ── Regexes ──────────────────────────────────────────────────────────────────────────────────────

/** An ai-finders.json finder with its regexes compiled (§5.5 matchCredit). */
export type CompiledFinder = Finder & { patternRes: RegExp[]; patternCsRes: RegExp[]; labNameRes: RegExp[] };
/** ai-finders.json with its regexes compiled once, at config load (§5.5). */
export type CompiledAiFinders = Omit<z.output<typeof AiFindersFile>, "finders"> & {
  prefilterRe: RegExp;
  stripRes: RegExp[];
  labContextRe: RegExp;
  finders: CompiledFinder[];
};
/**
 * The compiled ai-finders.json. regions.json alert_patterns and github.tier1_paths are compiled here only for
 * the CONFIG_REGEX check; lib/regions.ts and lib/sources.ts compile their own copies with the same flags.
 */
export interface CompiledConfig {
  aiFinders: CompiledAiFinders;
}

/** regions.json alert_patterns flags (§4.11), on the normalised URL (§5.11); lib/regions.ts compiles with these. */
export const ALERT_PATTERN_FLAGS = "iu";

// Every pattern is compiled with the u flag plus the flags §4.11 states.
const FLAGS = {
  prefilter: "iu", strip: "gu", labContext: "u", patterns: "iu", patternsCaseSensitive: "u", labNames: "iu",
  alertPatterns: ALERT_PATTERN_FLAGS, tier1Paths: TIER1_PATH_FLAGS,
} as const;

function compiler(issues: ConfigIssue[]) {
  return (source: string, flags: string, where: string): RegExp => {
    try {
      return new RegExp(source, flags);
    } catch (e) {
      issues.push(issue("CONFIG_REGEX", where, `Does not compile with flags "${flags}": ${(e as Error).message}`,
        "Regexes are JavaScript syntax in JSON strings: write \\b as \"\\\\b\"."));
      return /(?!)/u;
    }
  };
}

/** Compiles every config regex; each one that fails becomes a CONFIG_REGEX issue (and a never-matching placeholder). */
export function compileConfig(files: Pick<ConfigFiles, "aiFinders" | "regions" | "sourceTiers">): { compiled: CompiledConfig; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const re = compiler(issues);
  const af = files.aiFinders;
  const f = "config/ai-finders.json";
  const aiFinders: CompiledAiFinders = {
    ...af,
    prefilterRe: re(af.prefilter, FLAGS.prefilter, at(f, "prefilter")),
    stripRes: af.strip.map((s, i) => re(s, FLAGS.strip, at(f, `strip[${i}]`))),
    labContextRe: re(af.lab_context, FLAGS.labContext, at(f, "lab_context")),
    finders: af.finders.map((x, i) => ({
      ...x,
      patternRes: x.patterns.map((s, j) => re(s, FLAGS.patterns, at(f, `finders[${i}].patterns[${j}]`))),
      patternCsRes: x.patterns_case_sensitive.map((s, j) => re(s, FLAGS.patternsCaseSensitive, at(f, `finders[${i}].patterns_case_sensitive[${j}]`))),
      labNameRes: x.lab_names.map((s, j) => re(s, FLAGS.labNames, at(f, `finders[${i}].lab_names[${j}]`))),
    })),
  };
  files.regions.regions.forEach((r, i) => {
    r.alert_patterns.forEach((s, j) => re(s, FLAGS.alertPatterns, at("config/regions.json", `regions[${i}].alert_patterns[${j}]`)));
  });
  files.sourceTiers.github.tier1_paths.forEach((s, i) => re(s, FLAGS.tier1Paths, at("config/source-tiers.json", `github.tier1_paths[${i}]`)));
  return { compiled: { aiFinders }, issues };
}

/** One credit string's match (§5.5 AiCreditHit without `field`). `matched` is the matched substring only, never the credit line. */
export interface AiCreditMatch {
  finder_id: string;
  family: FinderFamily;
  kind: FinderKind;
  rule: "pattern" | "lab_context";
  matched: string;
}

/**
 * §5.5's matchCredit(): `prefilter`, then `strip` (each match replaced by a space), then the finders in
 * file order, the first match winning: `patterns`, `patterns_case_sensitive`, then `lab_names` only when
 * `lab_context` matches the stripped text. The caller sanitises the string first (§4.14). Defined here so
 * the examples check and lib/metrics/ai-credit.ts (P2) share one implementation.
 */
export function matchCredit(raw: string, cfg: CompiledAiFinders): AiCreditMatch | null {
  if (!cfg.prefilterRe.test(raw)) return null;
  let t = raw;
  for (const re of cfg.stripRes) t = t.replace(re, " ");
  const toolWords = cfg.labContextRe.test(t);
  const hit = (f: CompiledFinder, rule: AiCreditMatch["rule"], matched: string): AiCreditMatch =>
    ({ finder_id: f.id, family: f.family, kind: f.kind, rule, matched });
  for (const f of cfg.finders) {
    for (const re of f.patternRes) { const m = t.match(re); if (m) return hit(f, "pattern", m[0]); }
    for (const re of f.patternCsRes) { const m = t.match(re); if (m) return hit(f, "pattern", m[0]); }
    if (toolWords) for (const re of f.labNameRes) { const m = t.match(re); if (m) return hit(f, "lab_context", m[0]); }
  }
  return null;
}

// ── Load ─────────────────────────────────────────────────────────────────────────────────────────

export interface LoadedConfig extends ConfigFiles {
  /** The repo root the files were read from. */
  root: string;
  /** Where each file came from, relative to the root ("config/claims.json", "fixtures/config/claims.json"), or "override". */
  paths: Record<ConfigKey, string>;
  /** SHA-256 of each file's bytes as read; for an override, of its JSON printed with two-space indent and a newline. */
  sha256: Record<ConfigKey, string>;
  /** True when claims came from fixtures/config/claims.json: sample mode (§4.11). */
  sampleClaims: boolean;
  /** Regexes compiled once, at load. */
  compiled: CompiledConfig;
}

export interface LoadConfigOptions {
  /** The repo root holding config/ (and fixtures/config/ in sample mode). Default: the working directory. */
  root?: string;
  /**
   * Replaces files' contents explicitly, e.g. `{ claims: <fixtures/config/claims.json parsed> }` for tests
   * and the fixtures builder (§4.11). Each value is parsed with its file's schema, so raw JSON works.
   */
  overrides?: Partial<Record<ConfigKey, unknown>>;
  /** Skip the cache (tests). */
  fresh?: boolean;
}

const cache = new Map<string, LoadedConfig>();

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const defaultPaths = () => Object.fromEntries(CONFIG_KEYS.map((k) => [k, `${CONFIG_DIR}/${CONFIG_FILES[k]}`])) as Record<ConfigKey, string>;

/** How issues name each file: its path, or "config/<file> (override)". */
function labelsOf(paths: Record<ConfigKey, string>): Record<ConfigKey, string> {
  return Object.fromEntries(CONFIG_KEYS.map((k) => [k, paths[k] === "override" ? `${CONFIG_DIR}/${CONFIG_FILES[k]} (override)` : paths[k]])) as Record<ConfigKey, string>;
}

/**
 * Reads and parses every config file. `claims.json` is required; in sample mode (isSampleData(): the
 * content folder is under fixtures/) it is read from fixtures/config/claims.json instead, and only then.
 * Throws ConfigError (CONFIG_SCHEMA, CONFIG_REGEX) listing every problem found. The result is cached per
 * root and claims file unless `overrides` or `fresh` is given; treat it as read-only.
 */
export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const root = path.resolve(opts.root ?? process.cwd());
  const sampleClaims = isSampleData(contentDir(), root);
  const paths = defaultPaths();
  if (sampleClaims) paths.claims = SAMPLE_CLAIMS_FILE;
  const overrides = opts.overrides ?? {};
  for (const k of Object.keys(overrides) as ConfigKey[]) {
    if (!(k in CONFIG_FILES)) throw new Error(`loadConfig: unknown override "${k}"`);
    paths[k] = "override";
  }

  const key = `${root}\0${paths.claims}`;
  const cacheable = !opts.fresh && Object.keys(overrides).length === 0;
  const hit = cacheable ? cache.get(key) : undefined;
  if (hit) return hit;

  const issues: ConfigIssue[] = [];
  const files: Partial<Record<ConfigKey, unknown>> = {};
  const hashes = {} as Record<ConfigKey, string>;
  const labels = labelsOf(paths);
  for (const k of CONFIG_KEYS) {
    const rel = paths[k];
    let raw: unknown;
    if (k in overrides) {
      raw = overrides[k];
      hashes[k] = sha256(`${JSON.stringify(raw, null, 2)}\n`);
    } else {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) {
        issues.push(issue("CONFIG_SCHEMA", rel, "File is missing.", `Every config file is required; see SPEC §4.11 for ${CONFIG_FILES[k]}.`));
        continue;
      }
      const bytes = fs.readFileSync(file);
      hashes[k] = sha256(bytes);
      try {
        raw = rel.endsWith(".yaml") ? parseYaml(bytes.toString("utf8")) : JSON.parse(bytes.toString("utf8"));
      } catch (e) {
        issues.push(issue("CONFIG_SCHEMA", rel, `Does not parse: ${(e as Error).message}`));
        continue;
      }
    }
    const r = SCHEMAS[k].safeParse(raw);
    if (r.success) files[k] = r.data;
    else issues.push(...schemaIssues(labels[k], r.error));
  }
  if (issues.length) throw new ConfigError(issues);

  const parsed = files as ConfigFiles;
  issues.push(...loadTimeIssues(parsed, labels));
  const { compiled, issues: regexIssues } = compileConfig(parsed);
  issues.push(...regexIssues);
  if (issues.length) throw new ConfigError(issues);

  const loaded: LoadedConfig = { ...parsed, root, paths, sha256: hashes, sampleClaims, compiled };
  if (cacheable) cache.set(key, loaded);
  return loaded;
}

/** loadConfig() then validateConfig(); throws ConfigError when either finds a problem. What preflight and validate:all need. */
export function loadCheckedConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const config = loadConfig(opts);
  const issues = validateConfig(config);
  if (issues.length) throw new ConfigError(issues);
  return config;
}

// ── Load-time checks the schemas cannot state (CONFIG_SCHEMA) ────────────────────────────────────

type RuleParam = Exclude<keyof RegionRule["params"], "lookback_hours">;

/**
 * The params each region rule type reads besides `lookback_hours` (§5.11). A rule's read params must be
 * set and every other param null (CONFIG_SCHEMA). lib/regions.ts's evaluators read exactly these.
 */
export const REGION_RULE_PARAMS = {
  confirmed_disruption: ["min_publishers", "sectors", "statuses"],
  agency_alert: [],
  confirmed_breach: ["statuses", "min_severity"],
  victim_in_region: ["statuses", "min_severity"],
  campaign_target: [],
  home_vendor_kev: ["max_lag_days"],
  national_cert_exploitation: [],
} as const satisfies Record<RegionRuleType, readonly RuleParam[]>;

const ALL_PARAMS: readonly RuleParam[] = ["min_publishers", "sectors", "statuses", "min_severity", "max_lag_days"];

function loadTimeIssues(c: ConfigFiles, paths: Record<ConfigKey, string>): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  c.regions.rules.forEach((r, i) => {
    const reads: readonly RuleParam[] = REGION_RULE_PARAMS[r.type];
    for (const p of ALL_PARAMS) {
      const set = r.params[p] !== null;
      if (reads.includes(p) && !set) {
        out.push(issue("CONFIG_SCHEMA", at(paths.regions, `rules[${i}].params.${p}`), `A ${r.type} rule reads ${p}; set it.`));
      } else if (!reads.includes(p) && set) {
        out.push(issue("CONFIG_SCHEMA", at(paths.regions, `rules[${i}].params.${p}`), `A ${r.type} rule does not read ${p}; set it to null.`,
          `${r.type} reads lookback_hours${reads.length ? `, ${reads.join(", ")}` : " only"} (§5.11).`));
      }
    }
  });
  c.standingStories.stories.forEach((s, i) => {
    const n = countWords(s.summary);
    if (n > 40) out.push(issue("CONFIG_SCHEMA", at(paths.standingStories, `stories[${i}].summary`), `summary has ${n} words; the limit is 40. Cut at least ${n - 40}.`));
  });
  c.claims.claims.forEach((cl, i) => {
    const n = countWords(cl.restates?.quote);
    if (n > 25) out.push(issue("CONFIG_SCHEMA", at(paths.claims, `claims[${i}].restates.quote`), `quote has ${n} words; the limit is 25. Cut at least ${n - 25}.`));
  });
  return out;
}

// ── Cross-file checks ────────────────────────────────────────────────────────────────────────────

/** Metric paths whose 80% interval exists, so a threshold may name `ci80_lo` or `ci80_hi` (§4.2, §4.9). */
export const CI80_METRIC_PATHS: readonly string[] = ["window.w26.at_disclosure_share", "window.w26.after_disclosure_median_days", "base_rate.ratio"];

/**
 * The cross-file checks of §4.11: CONFIG_DUP, CONFIG_REF and CONFIG_REGEX (each regex compiles; each
 * finder's `examples` behave as stated). Returns every issue; [] means the config is good.
 */
export function validateConfig(c: ConfigFiles & { paths?: Record<ConfigKey, string> }): ConfigIssue[] {
  const p = labelsOf(c.paths ?? defaultPaths());
  return [...dupIssues(c, p), ...refIssues(c, p), ...regexIssues(c, p)];
}

/** Flags every value seen before under another owner (or, with `sameOwner`, under the same one too). */
function dupChecker(out: ConfigIssue[], what: string, sameOwner: boolean) {
  const seen = new Map<string, { owner: string; where: string }>();
  return (value: string, owner: string, where: string) => {
    const prev = seen.get(value);
    if (!prev) { seen.set(value, { owner, where }); return; }
    if (prev.owner === owner && !sameOwner) return;
    out.push(issue("CONFIG_DUP", where, `${what} "${value}" is already used at ${prev.where}.`, "Each value may appear once; merge or rename the entries."));
  };
}

function dupIssues(c: ConfigFiles, p: Record<ConfigKey, string>): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  const ids = (file: string, field: string, list: readonly { id: string }[], what: string) => {
    const check = dupChecker(out, `${what} id`, true);
    list.forEach((x, i) => check(x.id, `${i}`, at(file, `${field}[${i}].id`)));
  };
  ids(p.vendors, "vendors", c.vendors.vendors, "Vendor");
  ids(p.sourceTiers, "publishers", c.sourceTiers.publishers, "Publisher");
  ids(p.aiFinders, "finders", c.aiFinders.finders, "Finder");
  ids(p.regions, "rules", c.regions.rules, "Region rule");
  ids(p.annotations, "annotations", c.annotations.annotations, "Annotation");
  ids(p.actors, "actors", c.actors.actors, "Actor");
  ids(p.watchWindows, "windows", c.watchWindows.windows, "Watch window");
  ids(p.standingStories, "stories", c.standingStories.stories, "Standing story");
  ids(p.claims, "claims", c.claims.claims, "Claim");
  ids(p.sources, "feeds", c.sources.feeds, "Feed");
  const releases = dupChecker(out, "Release vendor", true);
  c.run.releases.forEach((r, i) => releases(r.vendor_id, `${i}`, at(p.run, `releases[${i}].vendor_id`)));

  // Vendors: normalised names and aliases, CNA short names, domains.
  const names = dupChecker(out, "Normalised vendor name", false);
  const cnas = dupChecker(out, "CNA short name", true);
  const vendorDomains = dupChecker(out, "Vendor domain", true);
  c.vendors.vendors.forEach((v, i) => {
    const w = (s: string) => at(p.vendors, `vendors[${i}].${s}`);
    names(normalizeVendor(v.name), v.id, w("name"));
    v.aliases.forEach((a, j) => names(normalizeVendor(a), v.id, w(`aliases[${j}]`)));
    v.cna.forEach((s, j) => cnas(s, v.id, w(`cna[${j}]`)));
    v.domains.forEach((d, j) => vendorDomains(d, v.id, w(`domains[${j}]`)));
  });

  // Publishers: domains (a vendor domain may also be listed here: the explicit entry wins, §4.11).
  const pubDomains = dupChecker(out, "Publisher domain", true);
  c.sourceTiers.publishers.forEach((x, i) => x.domains.forEach((d, j) => pubDomains(d, x.id, at(p.sourceTiers, `publishers[${i}].domains[${j}]`))));

  // Actors: names and aliases, case-insensitive, as publish matches them (§4.11).
  const actorNames = dupChecker(out, "Actor name or alias", false);
  c.actors.actors.forEach((a, i) => {
    actorNames(a.name.toLowerCase(), a.id, at(p.actors, `actors[${i}].name`));
    a.aliases.forEach((x, j) => actorNames(x.name.toLowerCase(), a.id, at(p.actors, `actors[${i}].aliases[${j}].name`)));
  });
  return out;
}

function refIssues(c: ConfigFiles, p: Record<ConfigKey, string>): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  const publishers = new Set(c.sourceTiers.publishers.map((x) => x.id));
  c.regions.regions.forEach((r, i) => {
    for (const [field, list] of [["agencies", r.agencies], ["certs", r.certs]] as const) {
      list.forEach((id, j) => {
        if (!publishers.has(id)) {
          out.push(issue("CONFIG_REF", at(p.regions, `regions[${i}].${field}[${j}]`), `"${id}" is not a publisher id in ${p.sourceTiers}.`,
            "Agencies and CERTs are explicit publishers: add the publisher first."));
        }
      });
    }
  });

  const actors = new Set(c.actors.actors.map((a) => a.id));
  c.standingStories.stories.forEach((s, i) => s.actors.forEach((id, j) => {
    if (!actors.has(id)) out.push(issue("CONFIG_REF", at(p.standingStories, `stories[${i}].actors[${j}]`), `"${id}" is not an actor id in ${p.actors}.`));
  }));

  // A watch window's lens_row and a claim's metric_path are schema enums (TaiwanLensRowId, ClaimMetricPath,
  // §4.11's interfaces), so an unknown one fails CONFIG_SCHEMA at load, before these checks run.

  const vendors = new Set(c.vendors.vendors.map((v) => v.id));
  c.run.releases.forEach((r, i) => {
    if (!vendors.has(r.vendor_id)) out.push(issue("CONFIG_REF", at(p.run, `releases[${i}].vendor_id`), `"${r.vendor_id}" is not a vendor id in ${p.vendors}.`));
  });

  c.claims.claims.forEach((cl, i) => {
    const w = (s: string) => at(p.claims, `claims[${i}].${s}`);
    for (const side of ["support", "challenge"] as const) {
      const t = cl[side];
      if (cl.judged_by === "script" && t.kind !== "value") {
        out.push(issue("CONFIG_REF", w(side), `A script-judged claim needs a value threshold on ${cl.metric_path}; this one is an event.`));
      } else if (cl.judged_by === "report" && t.kind !== "event") {
        out.push(issue("CONFIG_REF", w(side), "A report-judged claim uses an event threshold (§4.9); this one is a value."));
      } else if (t.kind === "value" && t.bound !== "value" && (cl.metric_path === null || !CI80_METRIC_PATHS.includes(cl.metric_path))) {
        out.push(issue("CONFIG_REF", w(`${side}.bound`), `${cl.metric_path ?? "This metric"} has no 80% interval, so the bound cannot be ${t.bound}.`,
          `Intervals exist for ${CI80_METRIC_PATHS.join(", ")}.`));
      }
    }
  });
  return out;
}

function regexIssues(c: ConfigFiles, p: Record<ConfigKey, string>): ConfigIssue[] {
  const { compiled, issues } = compileConfig(c);
  if (issues.length) return issues;
  const out: ConfigIssue[] = [];
  compiled.aiFinders.finders.forEach((f, i) => {
    f.examples.match.forEach((s, j) => {
      const m = matchCredit(s, compiled.aiFinders);
      if (m?.finder_id !== f.id) {
        out.push(issue("CONFIG_REGEX", at(p.aiFinders, `finders[${i}].examples.match[${j}]`),
          `"${s}" should match ${f.id} but ${m ? `matches ${m.finder_id} first` : "matches no finder"}.`,
          m ? "The first finder that matches wins: move the pattern or the example." : "Check prefilter, strip and the finder's patterns."));
      }
    });
    f.examples.no_match.forEach((s, j) => {
      const m = matchCredit(s, compiled.aiFinders);
      if (m) {
        out.push(issue("CONFIG_REGEX", at(p.aiFinders, `finders[${i}].examples.no_match[${j}]`),
          `"${s}" should match no finder but matches ${m.finder_id} on "${m.matched}".`));
      }
    });
  });
  return out;
}

// ── Vendors (§4.11 Matching, §5.7) ───────────────────────────────────────────────────────────────

const COMPANY_SUFFIXES = new Set(["inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited", "llc", "gmbh", "ag",
  "sa", "kk", "plc", "nv", "bv"]);

/**
 * §4.11's normalizeVendor(): lower-case; `&` becomes " and "; delete . , ( ) ' " ’ ! (not replaced by
 * spaces, so "K.K" becomes "kk"); split on whitespace; while more than one token remains and the last is a
 * company suffix, drop it; join with single spaces.
 */
export function normalizeVendor(name: string): string {
  const tokens = name.toLowerCase().replace(/&/g, " and ").replace(/[.,()'"’!]/g, "").split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && COMPANY_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join(" ");
}

const vendorIndexes = new WeakMap<object, Map<string, Vendor>>();

/** Normalised name and alias to vendor, first entry winning (CONFIG_DUP keeps them unique). */
export function vendorIndex(vendors: z.output<typeof VendorsFile>): Map<string, Vendor> {
  let index = vendorIndexes.get(vendors);
  if (!index) {
    index = new Map();
    for (const v of vendors.vendors) {
      for (const n of [v.name, ...v.aliases]) {
        const k = normalizeVendor(n);
        if (k && !index.has(k)) index.set(k, v);
      }
    }
    vendorIndexes.set(vendors, index);
  }
  return index;
}

const usableVendorName = (s: string | null | undefined): s is string => {
  const t = s?.trim().toLowerCase() ?? "";
  return t !== "" && t !== "n/a";
};

/**
 * A CVE's vendor (§4.11 Matching): the entry whose normalised name or alias equals the normalised KEV
 * `vendorProject`; failing that, the first of the CNA container's `affected[].vendor` values that
 * matches. "n/a" and empty values are ignored. The assigner never sets the vendor: pass it to
 * cnaConfirms() instead.
 */
export function matchVendor(
  config: Pick<ConfigFiles, "vendors">,
  names: { kevVendorProject?: string | null; affectedVendors?: readonly (string | null | undefined)[] },
): Vendor | null {
  const index = vendorIndex(config.vendors);
  for (const n of [names.kevVendorProject, ...(names.affectedVendors ?? [])]) {
    if (!usableVendorName(n)) continue;
    const v = index.get(normalizeVendor(n));
    if (v) return v;
  }
  return null;
}

/** True when the matched vendor operates the record's assigning CNA (exact short name): `vendor_confirmed_by: "vendor_cna"`. */
export function cnaConfirms(vendor: Vendor | null, assignerShortName: string | null | undefined): boolean {
  return vendor !== null && !!assignerShortName && vendor.cna.includes(assignerShortName);
}

/** The versions the metrics file records (§4.7 provenance.config_versions). */
export function configVersions(c: Pick<ConfigFiles, "vendors" | "aiFinders" | "sourceTiers" | "regions" | "actors">) {
  return { vendors: c.vendors.version, ai_finders: c.aiFinders.version, source_tiers: c.sourceTiers.version, regions: c.regions.version, actors: c.actors.version };
}
