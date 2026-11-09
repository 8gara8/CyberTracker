// The metrics run (SPEC §5.10, §8.4):
//   tsx scripts/metrics.ts --date YYYY-MM-DD [--recompute] [--out DIR]
// stages content/metrics/D.json, its inputs manifest and the state files the run changed under the out
// folder (default cache/staged/D/, emptied first; `--out content` writes the named files and deletes
// nothing). runMetrics() is what stage 3 calls in-process, the backfill calls at its end (frozenState) and
// the CLI wraps. It reads the clock once (`now`, injectable) for generated_at, so two runs differ only in
// generated_at and, through it, provenance.inputs_sha256 (ruling R31).
//
// --recompute (ruling R33) starts from the state at the parent of the commit that added
// content/metrics/D.json (read with git show; when that commit added the state too, from its own state, as
// a backfill build read it), takes now, code_commit and reconstructed from the committed file, reads D's
// feeds from cache/, writes into logs/recompute/D/ and prints "Reproduced." or the first differing JSON
// path and the feeds whose hashes differ from the committed manifest's.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadCheckedConfig } from "../lib/config";
import { dataCutoffFor, isValidDate, taipeiTimestamp, taipeiToday } from "../lib/dates";
import { cachePaths } from "../lib/feeds/cache";
import { byCodeUnit } from "../lib/ids";
import { jsonText } from "../lib/json";
import { computeMetrics, type ComputeResult, type MetricsInputs } from "../lib/metrics/index";
import {
  InputsManifest, KevIndexFile, Metrics, STATE_FILES, STATE_SCHEMAS, type StateFileName, type StateFiles,
} from "../lib/schema/metrics";
import { contentDir } from "../lib/site";
import { git, type Git } from "./lib/git";
import { loadFeedCache, NoFeedsError, noFeeds, type MetricsFeeds } from "./lib/feed-cache";

export interface RunMetricsOptions {
  date: string;
  out?: string;
  recompute?: boolean;
  /** Epoch ms. */
  deadline?: number;
  reconstructed?: boolean;
  root?: string;
  stateDir?: string;
  /** Inside a backfill build (ruling R28). */
  frozenState?: boolean;
  /** The one clock read (injectable). */
  now?: Date;
}

export interface RunMetricsResult {
  code: 0 | 1;
  firstLine: string;
  lines: string[];
  /** Files written, relative to the out folder. */
  wrote: string[];
}

export const STATE_MISSING = "state/ is missing: run npm run backfill (SPEC §8.4).";
export const REPRODUCED = "Reproduced.";
export const USAGE = "Usage: npm run metrics -- --date YYYY-MM-DD [--recompute] [--out DIR]";

const DATED_JSON = /^(\d{4}-\d{2}-\d{2})\.json$/;
const BriefEdition = z.object({ date: z.string(), edition: z.string() });

// ── Reading content/ from the working tree or from a commit ────────────────────────────────────────

/** A folder to read from: the working tree, or a tree in git. Names are relative to the folder. */
interface Reader {
  list(dir: string): Promise<string[]>;
  read(file: string): Promise<string | null>;
}

function diskReader(base: string): Reader {
  return {
    async list(dir) {
      try {
        return fs.readdirSync(path.join(base, dir)).sort(byCodeUnit);
      } catch {
        return [];
      }
    },
    async read(file) {
      try {
        return fs.readFileSync(path.join(base, file), "utf8");
      } catch {
        return null;
      }
    },
  };
}

function gitReader(g: Git, rev: string, base: string): Reader {
  const at = (p: string) => `${rev}:${[base, p].filter(Boolean).join("/")}`;
  return {
    async list(dir) {
      try {
        return (await g(["ls-tree", "--name-only", at(dir)])).split("\n").filter(Boolean).sort(byCodeUnit);
      } catch {
        return [];
      }
    },
    async read(file) {
      try {
        return `${await g(["show", at(file)])}\n`;
      } catch {
        return null;
      }
    },
  };
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** The six state files, or null when any is missing. A file that does not parse throws (exit 1). */
async function readState(r: Reader): Promise<StateFiles | null> {
  const out: Partial<Record<StateFileName, unknown>> = {};
  for (const name of STATE_FILES) {
    const text = await r.read(name);
    if (text === null) return null;
    const parsed = STATE_SCHEMAS[name].safeParse(parseJson(text));
    if (!parsed.success) throw new Error(`state/${name} does not parse: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    out[name] = parsed.data;
  }
  return out as StateFiles;
}

/** The newest metrics file before `date`, the committed KEV index (the baseline) and the data-only edition dates. */
async function readHistory(content: Reader, date: string): Promise<MetricsInputs["history"]> {
  let previous: MetricsInputs["history"]["previous"] = null;
  const dated = (names: string[]) => names.map((n) => DATED_JSON.exec(n)?.[1]).filter((d): d is string => !!d && d < date);
  for (const d of dated(await content.list("metrics")).sort(byCodeUnit).reverse()) {
    const text = await content.read(`metrics/${d}.json`);
    const parsed = text === null ? null : Metrics.safeParse(parseJson(text));
    if (parsed?.success) {
      previous = parsed.data;
      break;
    }
  }
  const kevText = await content.read("state/kev-index.json");
  const kev = kevText === null ? null : KevIndexFile.safeParse(parseJson(kevText));
  const dataOnlyDates: string[] = [];
  for (const d of dated(await content.list("briefs")).sort(byCodeUnit)) {
    const text = await content.read(`briefs/${d}.json`);
    const b = text === null ? null : BriefEdition.safeParse(parseJson(text));
    if (b?.success && b.data.edition === "data_only") dataOnlyDates.push(d);
  }
  return { previous, kevBaseline: kev?.success ? kev.data : null, dataOnlyDates };
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────────────

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** The outputs: metrics/D.json, metrics/inputs/D.json and each changed state file, through their schemas. */
function outputs(date: string, r: ComputeResult): [string, string][] {
  const files: [string, string][] = [
    [`metrics/${date}.json`, jsonText(r.metrics, Metrics)],
    [`metrics/inputs/${date}.json`, jsonText(r.manifest, InputsManifest)],
  ];
  for (const name of STATE_FILES) {
    const value = r.state[name];
    if (value) files.push([`state/${name}`, jsonText(value, STATE_SCHEMAS[name])]);
  }
  return files;
}

const pastDeadline = (deadline: number | undefined) => deadline !== undefined && Date.now() >= deadline;

function done(code: 0 | 1, lines: string[], wrote: string[] = []): RunMetricsResult {
  return { code, firstLine: lines[0] ?? "", lines, wrote };
}

async function headCommit(root: string): Promise<string> {
  return git(root)(["rev-parse", "HEAD"]);
}

function feedsFor(root: string, date: string, frozen: boolean, generatedAt: string, lines: string[]): MetricsFeeds | string {
  try {
    return loadFeedCache(root, date);
  } catch (e) {
    if (!(e instanceof NoFeedsError)) throw e;
    if (frozen) return `No feeds for ${date} in cache/: run npm run collect -- --date ${date} first.`;
    lines.push(`${e.message} Every feed counts as failed.`);
    return noFeeds(date, dataCutoffFor(date), generatedAt);
  }
}

// ── runMetrics ─────────────────────────────────────────────────────────────────────────────────────

export async function runMetrics(o: RunMetricsOptions): Promise<RunMetricsResult> {
  const root = path.resolve(o.root ?? process.cwd());
  try {
    if (!isValidDate(o.date)) return done(1, [`Invalid date: ${o.date}`]);
    if (o.recompute) return await recompute(o, root);

    const content = path.resolve(root, contentDir());
    if (fs.existsSync(path.join(content, "metrics", `${o.date}.json`))) return done(0, [`metrics/${o.date}.json exists`]);

    const stateDir = o.stateDir ? path.resolve(root, o.stateDir) : path.join(content, "state");
    const state = await readState(diskReader(stateDir));
    if (!state) return done(1, [STATE_MISSING]);

    const now = o.now ?? new Date();
    const generatedAt = taipeiTimestamp(now);
    const notes: string[] = [];
    const feeds = feedsFor(root, o.date, !!o.frozenState, generatedAt, notes);
    if (typeof feeds === "string") return done(1, [feeds]);
    const config = loadCheckedConfig({ root });
    const result = computeMetrics({
      date: o.date, generatedAt, codeCommit: await headCommit(root), reconstructed: o.reconstructed ?? o.date < taipeiToday(now),
      frozenState: !!o.frozenState, config, compiled: config.compiled, state, feeds, history: await readHistory(diskReader(content), o.date),
    });

    const staged = cachePaths(root).stagedMetrics(o.date);
    const out = o.out ? path.resolve(root, o.out) : staged;
    if (pastDeadline(o.deadline)) return done(1, [`Metrics ${o.date}: the deadline passed before anything was written.`]);
    if (out === staged) fs.rmSync(out, { recursive: true, force: true });
    const files = outputs(o.date, result);
    for (const [rel, text] of files) writeFile(path.join(out, rel), text);
    const wrote = files.map(([rel]) => rel);
    const lines = [result.firstLine, ...(result.catchUpLine ? [result.catchUpLine] : []), ...notes, ...result.log,
      `Wrote ${wrote.length} files to ${path.relative(root, out) || "."}.`];
    return done(0, lines, wrote);
  } catch (e) {
    return done(1, [e instanceof Error ? e.message : String(e)]);
  }
}

/** The first JSON path where two values differ (null when equal), e.g. "window.w26.cohort_n" or "series.weeks[3]". */
export function firstDifference(a: unknown, b: unknown, at = ""): string | null {
  if (a === b) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = firstDifference(a[i], b[i], `${at}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], at ? `${at}.${k}` : k);
      if (d !== null) return d;
    }
    return null;
  }
  return at || "(top level)";
}

async function recompute(o: RunMetricsOptions, root: string): Promise<RunMetricsResult> {
  const D = o.date;
  const content = path.resolve(root, contentDir());
  const file = path.join(content, "metrics", `${D}.json`);
  if (!fs.existsSync(file)) return done(1, [`metrics/${D}.json does not exist: nothing to recompute.`]);
  const committedText = fs.readFileSync(file, "utf8");
  const committed = Metrics.parse(JSON.parse(committedText));

  const g = git(root);
  const rel = path.relative(root, content).split(path.sep).join("/");
  const added = (await g(["log", "--diff-filter=A", "--format=%H", "--", `${rel}/metrics/${D}.json`])).split("\n").filter(Boolean);
  if (!added.length) return done(1, [`metrics/${D}.json is not committed: nothing to recompute.`]);
  const commit = added.at(-1)!;
  const lines: string[] = [];
  let rev = `${commit}^`;
  let frozen = false;
  let state = await readState(gitReader(g, rev, `${rel}/state`));
  if (!state) {
    rev = commit;
    frozen = true;
    state = await readState(gitReader(g, rev, `${rel}/state`));
    if (!state) return done(1, [`No state/ at ${commit.slice(0, 12)} or its parent: nothing to recompute from.`]);
    lines.push(`The state was added with metrics/${D}.json: recomputing as the build read it.`);
  }
  let feeds: MetricsFeeds;
  try {
    feeds = loadFeedCache(root, D);
  } catch (e) {
    if (e instanceof NoFeedsError) return done(1, [e.message]);
    throw e;
  }
  const config = loadCheckedConfig({ root });
  const result = computeMetrics({
    date: D, generatedAt: committed.generated_at, codeCommit: committed.code_commit, reconstructed: committed.reconstructed,
    frozenState: frozen, config, compiled: config.compiled, state, feeds, history: await readHistory(gitReader(g, rev, rel), D),
  });

  if (pastDeadline(o.deadline)) return done(1, [`Metrics ${D}: the deadline passed before anything was written.`]);
  const out = cachePaths(root).recompute(D);
  fs.rmSync(out, { recursive: true, force: true });
  const files = outputs(D, result);
  for (const [r, text] of files) writeFile(path.join(out, r), text);
  const wrote = files.map(([r]) => r);

  const ours = files[0]![1];
  if (ours === committedText) return done(0, [REPRODUCED, ...lines], wrote);
  const diff = firstDifference(JSON.parse(committedText), JSON.parse(ours)) ?? "(formatting only)";
  const out1 = [`Not reproduced: the first difference is at ${diff}.`, ...lines];
  const manifestText = fs.existsSync(path.join(content, "metrics", "inputs", `${D}.json`))
    ? fs.readFileSync(path.join(content, "metrics", "inputs", `${D}.json`), "utf8") : null;
  const before = manifestText ? InputsManifest.safeParse(parseJson(manifestText)) : null;
  if (before?.success) {
    const now = new Map(result.manifest.feeds.map((f) => [f.id, f]));
    const ids = [...new Set([...before.data.feeds.map((f) => f.id), ...now.keys()])].sort(byCodeUnit);
    const differ = ids.filter((id) => {
      const a = before.data.feeds.find((f) => f.id === id);
      const b = now.get(id);
      return a?.sha256 !== b?.sha256 || a?.version !== b?.version;
    });
    out1.push(differ.length ? `Feeds whose hashes differ: ${differ.join(", ")}.` : "Every feed hash matches the committed manifest.");
  } else out1.push(`metrics/inputs/${D}.json is missing or does not parse: no feed hashes to compare.`);
  return done(1, out1, wrote);
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let values: { date?: string; out?: string; recompute?: boolean };
  try {
    ({ values } = parseArgs({ args: argv, options: { date: { type: "string" }, out: { type: "string" }, recompute: { type: "boolean" } }, strict: true }));
  } catch {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const date = values.date ?? taipeiToday();
  if (!isValidDate(date) || (values.recompute && values.out)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const r = await runMetrics({ date, out: values.out, recompute: values.recompute });
  (r.code === 0 ? process.stdout : process.stderr).write(`${r.lines.join("\n")}\n`);
  return r.code;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main().then((code) => { process.exitCode = code; });
