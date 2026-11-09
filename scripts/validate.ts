// The validator CLI (SPEC §8.6), adapted from the Europe fork's scripts/validate.ts.
//   tsx scripts/validate.ts <file> [--context F] [--evidence F] [--metrics F] [--cve-cache DIR]
//                           [--regions-input F] [--pack F] [--published] [--json]
//   tsx scripts/validate.ts --all [DIR] [--json]
// A draft (the default mode) needs its context, evidence, metrics, CVE records, regions input and pack;
// each defaults to the run's file for the draft's date D, and a missing one is a usage error naming its
// flag. It never reads drafts/context.json, which the agent can write. --published runs
// validatePublished() with the same-date metrics; --all runs validateAll() on DIR (default contentDir()).
// Prints `ERROR CODE path: message` and `WARN CODE path: message` lines, then `<file>: E errors, W
// warnings.`; --json prints { ok, errors, warnings }. Exit 0 clean, 1 errors, 2 usage or read error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { z } from "zod";
import { ConfigError, SAMPLE_CLAIMS_FILE, loadCheckedConfig, type LoadedConfig } from "../lib/config";
import { isValidDate } from "../lib/dates";
import { regionsConfig } from "../lib/regions";
import { AgentContext } from "../lib/schema/context";
import { Metrics } from "../lib/schema/metrics";
import { Evidence } from "../lib/schema/misc";
import { Pack } from "../lib/schema/pack";
import { contentDir } from "../lib/site";
import {
  RegionsInputFile, cveLookupFromDir, packDatesOf, toResult, unparsableIssue, validateAll, validateDraft, validatePublished,
  type ValidationIssue, type ValidationResult,
} from "../lib/validate";

export const USAGE = `Usage:
  npm run validate -- <file> [--context F] [--evidence F] [--metrics F] [--cve-cache DIR]
                     [--regions-input F] [--pack F] [--published] [--json]
  npm run validate -- --all [DIR] [--json]`;

/** A usage or read error: exit 2 with the message and the usage text on stderr. */
export class UsageError extends Error {}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  /** The repo root the default paths are relative to; default the working directory. */
  root?: string;
}

const DRAFT_ONLY_FLAGS = ["context", "evidence", "cve-cache", "regions-input", "pack"] as const;
const DATED_NAME_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function line(i: ValidationIssue): string {
  const head = `${i.severity === "error" ? "ERROR" : "WARN"} ${i.code} ${i.path}: ${i.message}`;
  return i.hint ? `${head} Hint: ${i.hint}` : head;
}

function report(io: Io, label: string, r: ValidationResult, json: boolean): number {
  if (json) io.out(JSON.stringify({ ok: r.ok, errors: r.errors, warnings: r.warnings }, null, 2));
  else {
    for (const i of r.errors) io.out(line(i));
    for (const i of r.warnings) io.out(line(i));
    io.out(`${label}: ${plural(r.errors.length, "error")}, ${plural(r.warnings.length, "warning")}.`);
  }
  return r.ok ? 0 : 1;
}

function fileDateOf(file: string): string | null {
  const m = DATED_NAME_RE.exec(path.basename(file));
  return m && isValidDate(m[1]!) ? m[1]! : null;
}

/** Reads an input file through its schema; a missing, unreadable or invalid file is a usage error naming the flag. */
function readInput<T>(flag: string, file: string, schema: z.ZodType<T>, what: string): T {
  if (!fs.existsSync(file)) throw new UsageError(`Missing input for --${flag}: ${file} not found.`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`--${flag}: ${file} is not valid JSON (${(e as Error).message}).`);
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new UsageError(`--${flag}: ${file} is not ${what} (${first}).`);
  }
  return r.data;
}

/**
 * config/ through loadCheckedConfig(). A single file under fixtures/ (a fixture draft or brief) is checked
 * against the SAMPLE claims of fixtures/config/claims.json, as validateAll() does for a folder under
 * fixtures/ (§4.11 "Sample claims"), so the P1 milestone's fixture drafts resolve SB-01 and SB-02.
 */
function loadConfigOrThrow(root: string, file: string | null = null): LoadedConfig {
  const rel = file === null ? null : path.relative(path.join(root, "fixtures"), file);
  const underFixtures = rel !== null && rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  try {
    if (underFixtures) {
      const claims = JSON.parse(fs.readFileSync(path.join(root, SAMPLE_CLAIMS_FILE), "utf8")) as unknown;
      return loadCheckedConfig({ root, overrides: { claims } });
    }
    return loadCheckedConfig({ root });
  } catch (e) {
    if (e instanceof ConfigError) throw new UsageError(e.message);
    throw e;
  }
}

/** The CLI. Returns the exit code; never calls process.exit. */
export function main(argv: string[] = process.argv.slice(2), io: Io = { out: (s) => console.log(s), err: (s) => console.error(s) }): number {
  try {
    return run(argv, io);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (e instanceof UsageError || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"))) {
      io.err(`${(e as Error).message}\n${USAGE}`);
      return 2;
    }
    if (e instanceof ConfigError) {
      io.err(e.message);
      return 2;
    }
    io.err(e instanceof Error ? (e.stack ?? e.message) : String(e));
    return 2;
  }
}

function run(argv: string[], io: Io): number {
  const root = path.resolve(io.root ?? process.cwd());
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      all: { type: "boolean" },
      context: { type: "string" },
      evidence: { type: "string" },
      metrics: { type: "string" },
      "cve-cache": { type: "string" },
      "regions-input": { type: "string" },
      pack: { type: "string" },
      published: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const json = values.json === true;
  const at = (p: string) => path.resolve(root, p);

  if (values.all) {
    const extra = [...DRAFT_ONLY_FLAGS, "metrics", "published"].filter((f) => values[f as keyof typeof values] !== undefined);
    if (extra.length) throw new UsageError(`--all takes only a folder and --json, not --${extra.join(", --")}.`);
    if (positionals.length > 1) throw new UsageError("--all takes at most one folder.");
    const dir = positionals[0] ?? contentDir();
    return report(io, dir, validateAll(at(dir)), json);
  }

  if (positionals.length !== 1) throw new UsageError("Give exactly one file to validate, or --all.");
  const file = positionals[0]!;
  const abs = at(file);
  if (!fs.existsSync(abs)) throw new UsageError(`Can't read ${file}: not found.`);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (e) {
    throw new UsageError(`Can't read ${file}: ${(e as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return report(io, file, toResult([unparsableIssue(file, e)]), json);
  }
  const fileDate = fileDateOf(file);
  const ownDate = typeof (data as { date?: unknown })?.date === "string" && isValidDate((data as { date: string }).date)
    ? (data as { date: string }).date : null;
  const date = () => {
    const d = fileDate ?? ownDate;
    if (!d) throw new UsageError(`Can't tell the edition date of ${file}: name it YYYY-MM-DD.json or give every input flag.`);
    return d;
  };
  const config = loadConfigOrThrow(root, abs);

  /** --metrics, else content/metrics/D.json, else the staged copy cache/staged/D/metrics/D.json (§8.4). */
  const metricsPath = (): string => {
    if (values.metrics !== undefined) return at(values.metrics);
    const committed = at(path.join(contentDir(), "metrics", `${date()}.json`));
    const staged = at(path.join("cache", "staged", date(), "metrics", `${date()}.json`));
    return fs.existsSync(committed) || !fs.existsSync(staged) ? committed : staged;
  };

  if (values.published) {
    const extra = DRAFT_ONLY_FLAGS.filter((f) => values[f] !== undefined);
    if (extra.length) throw new UsageError(`--published reads only --metrics, not --${extra.join(", --")}.`);
    const metrics = readInput("metrics", metricsPath(), Metrics, "a metrics file");
    return report(io, file, validatePublished(data, { metrics, config, fileDate }), json);
  }

  const contextFile = at(values.context ?? path.join("logs", `${date()}.context.json`));
  if (contextFile === at(path.join("drafts", "context.json"))) {
    throw new UsageError("--context: drafts/context.json is the agent's writable copy; give logs/D.context.json.");
  }
  const context = readInput("context", contextFile, AgentContext, "an agent context");
  const evidence = readInput("evidence", at(values.evidence ?? path.join("logs", `${date()}.evidence.json`)), Evidence, "an evidence file");
  const metrics = readInput("metrics", metricsPath(), Metrics, "a metrics file");
  const cveDir = at(values["cve-cache"] ?? path.join("cache", "cvelist", "records"));
  if (!fs.existsSync(cveDir) || !fs.statSync(cveDir).isDirectory()) throw new UsageError(`Missing input for --cve-cache: ${cveDir} is not a folder.`);
  const regionsFile = readInput("regions-input", at(values["regions-input"] ?? path.join("logs", `${date()}.regions-input.json`)), RegionsInputFile, "a regions input file");
  const pack = readInput("pack", at(values.pack ?? path.join("packs", `${date()}.json`)), Pack, "a source pack");

  const result = validateDraft(data, {
    context,
    evidence,
    metrics,
    config,
    cveList: cveLookupFromDir(cveDir),
    regionsBase: { ...regionsFile, config: regionsConfig(config) },
    packDates: packDatesOf(pack),
    fileDate,
  });
  return report(io, file, result, json);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main();
