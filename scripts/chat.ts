// npm run chat -- --date D: prints D's chat edition from the content folder alone (SPEC §8.8). It reads
// the last run's records in status/D.json (the last schedule, manual or dry_run record and any retry
// after it), the committed brief and metrics/D.json (for the data-only KEV count), rebuilds every note
// from them through chatInputFor(), the same function daily.ts calls at finish (with the same metrics),
// and prints renderChat()'s text. It equals logs/D.summary.md except
// "status not saved" and, for a failed run, the paths in First errors (the status file keeps codes only).
//
//   tsx scripts/chat.ts --date YYYY-MM-DD
//
// The content folder is contentDir(): CT_CONTENT_DIR, else run.json paths.content_dir. Exit 0 printed,
// 1 no or invalid status file (or an invalid brief), 2 usage.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chatInputFor, lastRunRecords, renderChat } from "../lib/chat";
import { isValidDate } from "../lib/dates";
import { Brief } from "../lib/schema/brief";
import type { Edition } from "../lib/schema/common";
import { Metrics } from "../lib/schema/metrics";
import { StatusFile } from "../lib/schema/status";
import { contentDir, siteUrl } from "../lib/site";

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/** A file's contents through a schema, or a message naming the file (never the content or Zod's text). */
function readJson<T>(file: string, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }, label: string): T | string {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return `${label} is not valid JSON.`;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : `${label} fails its schema; run npm run validate:all.`;
}

/**
 * The newest valid brief dated on or before `date` in `<dir>/briefs/`: what GitHub's main showed for the
 * failed format's "Site shows" line. Null when there is none.
 */
export function newestEdition(dir: string, date: string): { date: string; edition: Edition } | null {
  const briefs = path.join(dir, "briefs");
  if (!fs.existsSync(briefs)) return null;
  const dates = fs.readdirSync(briefs)
    .map((f) => DATE_FILE_RE.exec(f)?.[1])
    .filter((d): d is string => d !== undefined && isValidDate(d) && d <= date)
    .sort()
    .reverse();
  for (const d of dates) {
    const brief = readJson(path.join(briefs, `${d}.json`), Brief, `briefs/${d}.json`);
    if (typeof brief !== "string" && brief.date === d) return { date: d, edition: brief.edition };
  }
  return null;
}

/** D's chat edition from the content folder `dir`. Throws an Error with a plain message when it can't. */
export function chatFromContent(dir: string, date: string, site: string = siteUrl()): string {
  const statusFile = path.join(dir, "status", `${date}.json`);
  if (!fs.existsSync(statusFile)) throw new Error(`No status file for ${date} (${path.join(dir, "status", `${date}.json`)}).`);
  const status = readJson(statusFile, StatusFile, `status/${date}.json`);
  if (typeof status === "string") throw new Error(status);
  if (status.date !== date) throw new Error(`status/${date}.json holds the date ${status.date}.`);
  const runs = lastRunRecords(status.runs);
  if (!runs.length) throw new Error(`status/${date}.json holds no run record.`);

  const briefFile = path.join(dir, "briefs", `${date}.json`);
  let brief: Brief | null = null;
  if (fs.existsSync(briefFile)) {
    const parsed = readJson(briefFile, Brief, `briefs/${date}.json`);
    if (typeof parsed === "string") throw new Error(parsed);
    brief = parsed;
  }
  // metrics/D.json gives the data-only KEV count (the brief holds at most 10 items); without a valid one, the item count.
  const metricsFile = path.join(dir, "metrics", `${date}.json`);
  const parsedMetrics = fs.existsSync(metricsFile) ? readJson(metricsFile, Metrics, `metrics/${date}.json`) : null;
  const metrics = typeof parsedMetrics === "string" ? null : parsedMetrics;
  return renderChat(chatInputFor({ date, brief, runs, siteShows: newestEdition(dir, date), siteUrl: site, metrics }), site);
}

export function main(argv: string[] = process.argv.slice(2)): number {
  let date: string | undefined;
  try {
    ({ values: { date } } = parseArgs({ args: argv, options: { date: { type: "string" } }, strict: true }));
  } catch {
    date = undefined;
  }
  if (!date || !isValidDate(date)) {
    process.stderr.write("Usage: npm run chat -- --date YYYY-MM-DD\n");
    return 2;
  }
  try {
    process.stdout.write(chatFromContent(path.resolve(process.cwd(), contentDir()), date));
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main();
