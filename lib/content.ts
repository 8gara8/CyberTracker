// Content loading for the site (SPEC §6 "Content loading"). The siblings' readJson/readFolder (never throw;
// folders sorted by name; a missing folder is []), a cache per directory and { fresh: true } for tests,
// with CyberTracker's file set. Every file is re-checked with validateAll(dir, { perFile: true }) (§4.12):
// one invalid file never fails the build. A brief is skipped only for a SITE_BLOCKING_CODES code; any
// other error is a build warning and the brief is shown. A metrics, status, scoreboard or corrections file
// failing its schema is skipped. Only a missing content folder throws (ContentError), which fails
// `next build` and leaves the previous deployment up (§9.1).

import fs from "node:fs";
import path from "node:path";
import type { LoadedConfig } from "./config";
import { Brief } from "./schema/brief";
import { Metrics } from "./schema/metrics";
import { CorrectionsFile } from "./schema/misc";
import { ScoreboardFile } from "./schema/scoreboard";
import { StatusFile } from "./schema/status";
import { SAFETY_CODES } from "./rules/safety";
import { contentDir } from "./site";
import { validateAll, type FileResult } from "./validate";

export { contentDir };

/**
 * The codes that skip a brief (§6 item 2): the schema and file codes, CANARY and every code
 * lib/rules/safety.ts exports as SAFETY_CODES. A new safety rule joins in the same PR (tests/content.test.ts
 * checks the list holds every SAFETY_CODES code). Either severity counts: in validateAll() NO_LIVE_IOC and
 * NO_EXPLOIT_LINK are warnings on every brief but the one being published (ARCHIVE_WARNING_CODES), and the
 * site still skips such a brief. SOURCE_URL is not here: safeHref() renders those URLs unlinked.
 */
export const SITE_BLOCKING_CODES = ["SCHEMA", "FILE_NAME", "DATE_MISMATCH", "CANARY", "NO_LIVE_IOC", "NO_EXPLOIT_LINK", "SECRET_LIKE"] as const;
export type SiteBlockingCode = (typeof SITE_BLOCKING_CODES)[number];

/** The codes that skip a metrics, status, scoreboard or corrections file (§6 item 3): it fails its schema or file name. */
const FILE_BLOCKING_CODES: readonly string[] = ["SCHEMA", "FILE_NAME", "DATE_MISMATCH"];

/** A file the site did not load, or loaded with errors, and the codes that say why (never the matched text). */
export interface FileCodes {
  /** Relative to the content folder, "/"-separated: "briefs/2026-11-08.json". */
  file: string;
  codes: string[];
}

export interface Content {
  dir: string;
  /** Valid briefs, oldest first. */
  briefs: Brief[];
  /** Valid metrics files by relative path, "metrics/2026-11-08.json". */
  metricsFiles: Set<string>;
  /** Valid status files, oldest first. */
  status: StatusFile[];
  /** Null when missing or invalid. */
  scoreboard: ScoreboardFile | null;
  /** { schema_version: 1, corrections: [], disputes: [] } when missing or invalid. */
  corrections: CorrectionsFile;
  /** Files left out, with the codes that skipped them; printed once at the start of the build. */
  skipped: FileCodes[];
  /**
   * Files loaded although validateAll() found errors in them (codes outside the blocking sets, distinct, in
   * the validator's order): the build warnings of §6 item 2, printed with the skipped files. Not in §6's
   * interface; added in P4 so the log and the tests can see them.
   */
  warnings: FileCodes[];
  /**
   * Dates of the loaded briefs that failed GAP_MATCH (§6 item 3): their Gap is treated as missing, so
   * briefPropsFor() passes `gapOk: false`. Not in §6's interface; added in P4 (how gapOk is known).
   */
  gapFailed: Set<string>;
}

export class ContentError extends Error {}

export interface LoadContentOptions {
  /** Skip the cache (tests). */
  fresh?: boolean;
  /**
   * The config validateAll() checks against; default its own (loadCheckedConfig(), with the SAMPLE claims for
   * a folder under fixtures/). Tests pass one for a temporary copy of the sample outside fixtures/.
   */
  config?: LoadedConfig;
  /** Where the skip and warning lines go; default console.warn, once per folder per process. */
  log?: (line: string) => void;
}

interface RawFile {
  /** Relative to the content folder, "/"-separated. */
  file: string;
  data: unknown;
}

/** The file parsed as JSON, or null when it is missing or does not parse (never throws). */
function readJson(dir: string, file: string): RawFile | null {
  try {
    return { file, data: JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) };
  } catch {
    return null;
  }
}

/** The `.json` file names directly in `dir/sub`, sorted by name; [] when the folder is missing (never throws). */
function listJson(dir: string, sub: string): string[] {
  try {
    return fs.readdirSync(path.join(dir, sub), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => `${sub}/${e.name}`)
      .sort();
  } catch {
    return [];
  }
}

const distinct = (codes: readonly string[]) => [...new Set(codes)];

/** The distinct codes of a file's issues, errors and warnings alike, in the validator's order. */
function codesOf(r: FileResult | undefined): string[] {
  return r ? distinct([...r.errors, ...r.warnings].map((i) => i.code)) : [];
}

/** The build log's lines for a loaded folder: "content: skipped briefs/2026-11-08.json (SCHEMA)", then the warnings. */
export function contentLogLines(content: Pick<Content, "skipped" | "warnings">): string[] {
  return [
    ...content.skipped.map((s) => `content: skipped ${s.file} (${s.codes.join(", ")})`),
    ...content.warnings.map((w) => `content: warning ${w.file} (${w.codes.join(", ")})`),
  ];
}

const cache = new Map<string, Content>();
const logged = new Set<string>();

/**
 * The content folder, re-checked (§6 "Content loading"). Throws ContentError only when `dir` is not a
 * directory; no briefs is valid. Cached per directory unless `fresh`.
 */
export function loadContent(dir: string = contentDir(), opts: LoadContentOptions = {}): Content {
  const key = path.resolve(dir);
  const hit = cache.get(key);
  if (hit && !opts.fresh) return hit;
  let isDir = false;
  try {
    isDir = fs.statSync(key).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new ContentError(`Content folder ${dir} is missing`);

  const result = validateAll(key, { perFile: true, ...(opts.config ? { config: opts.config } : {}) });
  const byFile = new Map(result.files.map((f) => [f.file, f]));
  const skipped: FileCodes[] = [];
  const warnings: FileCodes[] = [];
  const blocking = (file: string, list: readonly string[]) => codesOf(byFile.get(file)).filter((c) => list.includes(c));

  /** Parses a file the validator passed; a file it blocked (or that still fails, or vanished) is skipped. */
  const load = <T>(raw: RawFile | null, file: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, list: readonly string[]): T | null => {
    const codes = blocking(file, list);
    if (codes.length) {
      skipped.push({ file, codes });
      return null;
    }
    const parsed = raw ? schema.safeParse(raw.data) : null;
    if (!parsed?.success) {
      skipped.push({ file, codes: ["SCHEMA"] });
      return null;
    }
    return parsed.data;
  };

  const briefs: Brief[] = [];
  const gapFailed = new Set<string>();
  for (const name of listJson(key, "briefs")) {
    const brief = load(readJson(key, name), name, Brief, SITE_BLOCKING_CODES);
    if (!brief) continue;
    briefs.push(brief);
    if (codesOf(byFile.get(name)).includes("GAP_MATCH")) gapFailed.add(brief.date);
  }
  briefs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Metrics are parsed lazily (loadMetrics()): a year of them is large, and a page needs at most one.
  const metricsFiles = new Set<string>();
  for (const name of listJson(key, "metrics")) {
    const codes = blocking(name, FILE_BLOCKING_CODES);
    if (codes.length) skipped.push({ file: name, codes });
    else metricsFiles.add(name);
  }

  // Every listed or present file goes through load(), so one that does not parse is skipped with SCHEMA (a null
  // read), never only a build warning while the site quietly uses the default.
  const status = listJson(key, "status")
    .map((name) => load(readJson(key, name), name, StatusFile, FILE_BLOCKING_CODES))
    .filter((s): s is StatusFile => s !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const present = (file: string) => fs.existsSync(path.join(key, file));
  const scoreboard = present("scoreboard.json") ? load(readJson(key, "scoreboard.json"), "scoreboard.json", ScoreboardFile, FILE_BLOCKING_CODES) : null;
  const corrections = (present("corrections.json") ? load(readJson(key, "corrections.json"), "corrections.json", CorrectionsFile, FILE_BLOCKING_CODES) : null)
    ?? { schema_version: 1 as const, corrections: [], disputes: [] };

  // Build warnings: every other error, in any file the site still reads (cross-file codes never hide anything, §6 item 4).
  const skippedFiles = new Set(skipped.map((s) => s.file));
  for (const f of result.files) {
    if (skippedFiles.has(f.file) || f.errors.length === 0) continue;
    warnings.push({ file: f.file, codes: distinct(f.errors.map((i) => i.code)) });
  }
  skipped.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const content: Content = { dir, briefs, metricsFiles, status, scoreboard, corrections, skipped, warnings, gapFailed };
  if (!opts.fresh) cache.set(key, content);

  const lines = contentLogLines(content);
  if (opts.log) for (const line of lines) opts.log(line);
  else if (lines.length && !logged.has(key)) {
    logged.add(key);
    for (const line of lines) console.warn(line);
  }
  return content;
}

const metricsCache = new WeakMap<Content, Map<string, Metrics | null>>();

/**
 * The metrics file a brief names (`brief.gap.metrics_file`, "metrics/2026-11-08.json"), parsed on first use
 * and cached; null unless it is in `content.metricsFiles` (so a skipped or missing file, or null, gives null).
 */
export function loadMetrics(content: Content, file: string | null): Metrics | null {
  if (file === null || !content.metricsFiles.has(file)) return null;
  let files = metricsCache.get(content);
  if (!files) {
    files = new Map();
    metricsCache.set(content, files);
  }
  if (!files.has(file)) {
    const raw = readJson(path.resolve(content.dir), file);
    const parsed = raw ? Metrics.safeParse(raw.data) : null;
    files.set(file, parsed?.success ? parsed.data : null);
  }
  return files.get(file) ?? null;
}
