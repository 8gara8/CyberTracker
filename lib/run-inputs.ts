import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import type { LoadedConfig } from "./config";
import { addDays, isValidDate } from "./dates";
import { cachePaths } from "./feeds/cache";
import { parseKev } from "./feeds/kev";
import type { KevCatalog } from "./feeds/types";
import { collectSignals, maxLookbackDays, regionsConfig, type HistoryBrief } from "./regions";
import type { RegionsBase } from "./rules/types";
import { Brief } from "./schema/brief";
import { InputsManifest, KevIndexFile, Metrics } from "./schema/metrics";
import { ArchiveIndex, CorrectionsFile } from "./schema/misc";
import { CollectInputsFile, type Pack } from "./schema/pack";
import { ScoreboardFile } from "./schema/scoreboard";
import { StatusFile } from "./schema/status";

// The reads the P3 stages share (publish, context, re-check, daily): content/ as synced, the files
// runMetrics() staged in cache/staged/D/, and the regions base of SPEC §5.11. Pure reads: nothing here
// writes, and a file that is missing or does not parse is null (or left out of a list), never a throw.
// `contentDir` is an absolute folder (RunPaths.content); `root` is the repo root holding cache/.
// Written by step S0 and frozen.

type Text = { text: string };

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The file parsed with `schema`, with its text; null when it is missing, not JSON or fails the schema. */
function readParsed<S extends z.ZodType>(file: string, schema: S): (Text & { value: z.output<S> }) | null {
  const text = readText(file);
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const r = schema.safeParse(json);
  return r.success ? { text, value: r.data } : null;
}

/** briefs/D.json; null when missing, invalid, or dated other than its file name. */
export function readBrief(contentDir: string, date: string): Brief | null {
  if (!isValidDate(date)) return null;
  const r = readParsed(path.join(contentDir, "briefs", `${date}.json`), Brief);
  return r && r.value.date === date ? r.value : null;
}

/** The briefs dated D − days to D − 1 that exist and parse, newest first. */
export function readHistory(contentDir: string, date: string, days: number): Brief[] {
  const out: Brief[] = [];
  for (let i = 1; i <= days; i++) {
    const b = readBrief(contentDir, addDays(date, -i));
    if (b) out.push(b);
  }
  return out;
}

/** status/D.json; null when missing or invalid. */
export function readStatus(contentDir: string, date: string): StatusFile | null {
  if (!isValidDate(date)) return null;
  const r = readParsed(path.join(contentDir, "status", `${date}.json`), StatusFile);
  return r && r.value.date === date ? r.value : null;
}

/** corrections.json; null when missing or invalid. */
export function readCorrections(contentDir: string): CorrectionsFile | null {
  return readParsed(path.join(contentDir, "corrections.json"), CorrectionsFile)?.value ?? null;
}

/** scoreboard.json; null when missing or invalid. */
export function readScoreboard(contentDir: string): ScoreboardFile | null {
  return readParsed(path.join(contentDir, "scoreboard.json"), ScoreboardFile)?.value ?? null;
}

/** archive-index.json; null when missing or invalid. */
export function readArchiveIndex(contentDir: string): ArchiveIndex | null {
  return readParsed(path.join(contentDir, "archive-index.json"), ArchiveIndex)?.value ?? null;
}

/** What metricsFor() returns: the file parsed, where it came from, its bytes as text, and D's inputs manifest. */
export interface MetricsForResult {
  metrics: Metrics;
  /** True when metrics/D.json is committed under contentDir; false when it is staged. */
  committed: boolean;
  /** The metrics file's text, exactly as stored (Brief.gap.metrics_sha256 is its SHA-256). */
  text: string;
  /** metrics/inputs/D.json, committed, else staged; null when neither parses. */
  inputs: InputsManifest | null;
}

/**
 * metrics/D.json committed under contentDir, else staged in cache/staged/D/metrics/D.json (runMetrics()'s
 * layout); null when neither exists and parses for D.
 */
export function metricsFor(root: string, contentDir: string, date: string): MetricsForResult | null {
  if (!isValidDate(date)) return null;
  const staged = cachePaths(root).stagedMetrics(date);
  const rel = path.join("metrics", `${date}.json`);
  const inputsRel = path.join("metrics", "inputs", `${date}.json`);
  const fromDir = (dir: string) => {
    const r = readParsed(path.join(dir, rel), Metrics);
    return r && r.value.date === date ? r : null;
  };
  const committed = fromDir(contentDir);
  const found = committed ?? fromDir(staged);
  if (!found) return null;
  const manifestOf = (dir: string) => {
    const r = readParsed(path.join(dir, inputsRel), InputsManifest);
    return r && r.value.date === date ? r.value : null;
  };
  return { metrics: found.value, committed: committed !== null, text: found.text, inputs: manifestOf(contentDir) ?? manifestOf(staged) };
}

/** state/kev-index.json staged for D (cache/staged/D/state/) if staged, else the committed one; null when neither parses. */
export function kevIndexFor(root: string, contentDir: string, date: string): KevIndexFile | null {
  if (!isValidDate(date)) return null;
  const staged = readParsed(path.join(cachePaths(root).stagedMetrics(date), "state", "kev-index.json"), KevIndexFile);
  if (staged) return staged.value;
  return readParsed(path.join(contentDir, "state", "kev-index.json"), KevIndexFile)?.value ?? null;
}

/**
 * The KEV catalog collect read for D (cache/feeds/kev.json), counted only as collect read it (§0.4 row 65,
 * as scripts/lib/feed-cache.ts does): cache/feeds/inputs.json must be D's and name this body's SHA-256.
 * Null otherwise, and collectSignals() then reads kev-index.json instead.
 */
function cachedKevCatalog(root: string, date: string): KevCatalog | null {
  const p = cachePaths(root);
  const inputs = readParsed(p.collectInputs, CollectInputsFile)?.value;
  if (!inputs || inputs.date !== date || !inputs.kev) return null;
  let body: Buffer;
  try {
    body = fs.readFileSync(p.feedBody("kev", "json"));
  } catch {
    return null;
  }
  try {
    const parsed = parseKev(body);
    return parsed.sha256 === inputs.kev.sha256 ? parsed.catalog : null;
  } catch {
    return null;
  }
}

/**
 * The regions base for D (§5.11): history over maxLookbackDays (the briefs dated D − N_max to D − 1 that
 * exist, any edition), signals from collectSignals(pack, the cached KEV catalog, kevIndex), kevIndex
 * (kevIndexFor(), else no entries) and regionsConfig(config). What the validator, publish and the
 * regions-input file all use.
 */
export function regionsBaseFor(o: { root: string; contentDir: string; date: string; pack: Pack | null; config: LoadedConfig }): RegionsBase {
  const rc = regionsConfig(o.config);
  const history: HistoryBrief[] = readHistory(o.contentDir, o.date, maxLookbackDays(o.config.regions))
    .map((b) => ({ date: b.date, items: b.items, sources: b.sources, regions: b.regions }));
  const kevIndex = { entries: kevIndexFor(o.root, o.contentDir, o.date)?.entries ?? [] };
  const signals = collectSignals(o.pack, cachedKevCatalog(o.root, o.date), kevIndex, rc, o.date);
  return { date: o.date, history, signals, kevIndex, config: rc };
}

/**
 * For each standing story some stored brief dated before D tags (an item's `standing_story`): the newest
 * such brief's date and the first item in it carrying the story (§4.15 `last_development`, `last_item_id`).
 * Every brief in contentDir/briefs/ is read, not only the 14 days of `recent_items` (plan A15). Stories no
 * brief tags are absent; buildContext() falls back to the seed date.
 */
export function standingLast(contentDir: string, date: string): Record<string, { date: string; item_id: string }> {
  const out: Record<string, { date: string; item_id: string }> = {};
  let names: string[];
  try {
    names = fs.readdirSync(path.join(contentDir, "briefs"));
  } catch {
    return out;
  }
  const dates = names
    .map((n) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(n)?.[1])
    .filter((d): d is string => d !== undefined && isValidDate(d) && d < date)
    .sort()
    .reverse();
  for (const d of dates) {
    const b = readBrief(contentDir, d);
    if (!b) continue;
    for (const item of b.items) {
      const story = item.standing_story;
      if (story && !(story in out)) out[story] = { date: d, item_id: item.id };
    }
  }
  return out;
}
