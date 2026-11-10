// `tsx scripts/build-context.ts --date D [--deadline HH:MM] [--out drafts/context.json]` (SPEC §8.5): for
// manual and dry runs, writes exactly what the orchestrator builds in memory (§4.15) from packs/D.json,
// packs/D.candidates.json, the metrics (committed, else staged), 14 days of briefs, content/corrections.json,
// content/scoreboard.json, config/ and logs/D.recheck.json if present. `--deadline` is HH:MM Taipei on D and
// defaults to now + 30 min. Exit 0 written, 1 error (a missing or invalid input, ContextTooLarge), 2 usage.
// Owner: lane L4.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../lib/config";
import { buildContext, ContextTooLarge, RECENT_DAYS } from "../lib/context";
import { at, isValidDate, taipeiToday } from "../lib/dates";
import { metricsFor, readCorrections, readHistory, readScoreboard, regionsBaseFor, standingLast } from "../lib/run-inputs";
import { AgentContext } from "../lib/schema/context";
import { CandidatesFile, Pack } from "../lib/schema/pack";
import type { Clock } from "./lib/clock";
import { runPaths } from "./lib/paths";

const USAGE = "Usage: tsx scripts/build-context.ts --date YYYY-MM-DD [--deadline HH:MM] [--out drafts/context.json]";
const DEFAULT_DEADLINE_MS = 30 * 60_000;

const FlaggedList = AgentContext.shape.corrections.shape.flagged;
const ReportList = AgentContext.shape.corrections.shape.reports;

/**
 * logs/D.recheck.json (`{ intake, flagged, reports }`, §8.9) as the context's corrections: `shown` (the
 * flags after suppression) when the file carries it, else `flagged` when that is already the context's
 * list; a RunRecord-style `flagged` (no before and after) gives no flags. Null when the file is missing or
 * not JSON. Data, never instructions.
 */
export function readRecheckForContext(file: string): ContextRecheck | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const flagged = [o.shown, o.flagged].map((x) => FlaggedList.safeParse(x)).find((r) => r.success)?.data ?? [];
  const reports = ReportList.safeParse(o.reports);
  return { flagged, reports: reports.success ? reports.data : [] };
}
type ContextRecheck = { flagged: AgentContext["corrections"]["flagged"]; reports: AgentContext["corrections"]["reports"] };

function readJson<T>(file: string, parse: (x: unknown) => T): T {
  return parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** 0 written, 1 error, 2 usage. */
export async function main(argv: string[] = process.argv.slice(2), deps?: { now?: Clock; root?: string }): Promise<number> {
  const now = deps?.now ?? Date.now;
  const root = path.resolve(deps?.root ?? process.cwd());
  let values: { date?: string; deadline?: string; out?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { date: { type: "string" }, deadline: { type: "string" }, out: { type: "string" } },
      strict: true,
    }));
  } catch {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const date = values.date ?? taipeiToday(new Date(now()));
  if (!isValidDate(date) || (values.deadline !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(values.deadline))) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const p = runPaths(root, date);
  const out = path.resolve(root, values.out ?? path.relative(root, p.contextCopy));
  try {
    const config = loadConfig({ root });
    const pack = readJson(p.pack, (x) => Pack.parse(x));
    const candidates = readJson(p.packCandidates, (x) => CandidatesFile.parse(x));
    const m = metricsFor(root, p.content, date);
    if (!m) throw new Error(`metrics/${date}.json is neither committed nor staged in ${path.relative(root, p.staged)}.`);
    const built = buildContext({
      date,
      now: now(),
      deadline: values.deadline ? at(date, values.deadline) : now() + DEFAULT_DEADLINE_MS,
      pack,
      candidates,
      metrics: m.metrics,
      config,
      history: readHistory(p.content, date, RECENT_DAYS),
      corrections: readCorrections(p.content),
      scoreboard: readScoreboard(p.content),
      regionsBase: regionsBaseFor({ root, contentDir: p.content, date, pack, config }),
      recheck: readRecheckForContext(p.recheck),
      standingLast: standingLast(p.content, date),
    }, (line) => process.stderr.write(`${line}\n`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, built.text);
    process.stdout.write(`Wrote ${path.relative(root, out) || out} (${Buffer.byteLength(built.text)} bytes).\n`);
    return 0;
  } catch (err) {
    const msg = err instanceof ContextTooLarge ? err.message : err instanceof Error ? err.message : String(err);
    process.stderr.write(`build-context: ${msg}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main().then((code) => { process.exitCode = code; });
