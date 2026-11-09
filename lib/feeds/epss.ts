// FIRST EPSS (SPEC §8.3, §5.12): the daily CSV, the API fallback, and the jump and mover tests that
// collect and the metrics share. Scores and percentiles are fractions with five decimals; differences are
// rounded to five decimals before any comparison, so 0.25 − 0.15 counts as a rise of 0.10.

import zlib from "node:zlib";
import { z } from "zod";
import { isValidDate } from "../dates";
import { compareCveIds } from "../ids";
import { sha256Hex } from "../json";
import type { EpssMover } from "../schema/metrics";
import { FeedParseError, type EpssDay, type EpssScore, type Parsed } from "./types";

const CVE_RE = /^CVE-\d{4}-\d{4,}$/;
const MAX_CSV_BYTES = 200 * 1024 * 1024;
const BATCH = 100;
const CROSS = 0.99;
const RISE = 0.1;
const MOVER_FLOOR = 0.1;
const MOVERS = 5;

/** Five decimals, the precision EPSS publishes. */
const round5 = (x: number) => Math.round(x * 1e5) / 1e5;
const fraction = (s: string | number | undefined): number | null => {
  const n = typeof s === "number" ? s : s === undefined || s.trim() === "" ? NaN : Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
};

/**
 * One day's gzipped CSV: a `#model_version:…,score_date:…` line, the `cve,epss,percentile` header, then a
 * row per CVE. `version` is the model version and `newest` the score date as written; rows that are not a
 * CVE id with two fractions are skipped. Not gzip is "parse"; a missing first line or header "schema"; no
 * rows "empty". Gunzip stops at 200 MB.
 */
export function parseEpssCsv(gz: Buffer): Parsed<never> & { day: EpssDay } {
  let text: string;
  try {
    text = zlib.gunzipSync(gz, { maxOutputLength: MAX_CSV_BYTES }).toString("utf8");
  } catch (e) {
    throw new FeedParseError("parse", `EPSS CSV: ${(e as Error).message}`);
  }
  const lines = text.split(/\r?\n/);
  const first = (lines[0] ?? "").replace(/^﻿/, "").trim();
  if (!first.startsWith("#")) throw new FeedParseError("schema", "EPSS CSV: no #model_version line");
  const meta = new Map<string, string>();
  for (const part of first.slice(1).split(",")) {
    const at = part.indexOf(":");
    if (at > 0) meta.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  const modelVersion = meta.get("model_version");
  const scoreDate = meta.get("score_date");
  if (!modelVersion || !scoreDate) throw new FeedParseError("schema", "EPSS CSV: the first line lacks model_version or score_date");
  if ((lines[1] ?? "").trim().replace(/\s+/g, "") !== "cve,epss,percentile") throw new FeedParseError("schema", "EPSS CSV: the header is not cve,epss,percentile");
  const scores = new Map<string, EpssScore>();
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    const [cve, e, p] = line.split(",");
    const id = (cve ?? "").trim().toUpperCase();
    const epss = fraction(e);
    const percentile = fraction(p);
    if (!CVE_RE.test(id) || epss === null || percentile === null) continue;
    scores.set(id, { epss, percentile });
  }
  if (scores.size === 0) throw new FeedParseError("empty", "EPSS CSV: no score rows");
  return {
    newest: scoreDate,
    entries: [],
    version: modelVersion,
    sha256: sha256Hex(gz),
    total: scores.size,
    day: { model_version: modelVersion, score_date: scoreDate, scores },
  };
}

const ApiAnswer = z.object({
  data: z.array(z.object({
    cve: z.string(),
    epss: z.union([z.string(), z.number()]),
    percentile: z.union([z.string(), z.number()]),
    date: z.string().catch(""),
  })),
});

/** The EPSS API answer (`data[]` of `{ cve, epss, percentile, date }`, numbers often as strings), by CVE id. */
export function parseEpssApi(body: Buffer): Map<string, EpssScore & { date: string }> {
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    throw new FeedParseError("parse", "EPSS API answer is not JSON");
  }
  const parsed = ApiAnswer.safeParse(json);
  if (!parsed.success) throw new FeedParseError("schema", "EPSS API answer has no data array");
  const out = new Map<string, EpssScore & { date: string }>();
  for (const row of parsed.data.data) {
    const id = row.cve.trim().toUpperCase();
    const epss = fraction(row.epss);
    const percentile = fraction(row.percentile);
    if (!CVE_RE.test(id) || epss === null || percentile === null) continue;
    out.set(id, { epss, percentile, date: row.date });
  }
  return out;
}

/**
 * The registry's CSV URL for `date` (§8.3's fixed pattern): "epss_scores-current.csv.gz", a dated file
 * name or a "{date}" placeholder becomes "epss_scores-<date>.csv.gz". Throws for any other URL.
 */
export function epssUrlFor(registryUrl: string, date: string): string {
  if (!isValidDate(date)) throw new Error(`epssUrlFor: invalid date ${date}`);
  if (registryUrl.includes("{date}")) return registryUrl.replace("{date}", date);
  const re = /epss_scores-(?:current|\d{4}-\d{2}-\d{2})\.csv\.gz/;
  if (!re.test(registryUrl)) throw new Error(`epssUrlFor: not an EPSS CSV URL: ${registryUrl}`);
  return registryUrl.replace(re, `epss_scores-${date}.csv.gz`);
}

/** API URLs for `cveIds` (upper-cased, repeats dropped, CVE order), in batches of 100: `<fallback>?cve=a,b,…`. */
export function epssApiUrls(fallbackUrl: string, cveIds: readonly string[]): string[] {
  const ids = [...new Set(cveIds.map((c) => c.trim().toUpperCase()).filter((c) => CVE_RE.test(c)))].sort(compareCveIds);
  const sep = fallbackUrl.includes("?") ? "&" : "?";
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += BATCH) out.push(`${fallbackUrl}${sep}cve=${ids.slice(i, i + BATCH).join(",")}`);
  return out;
}

/**
 * §5.12's EPSS jump for one CVE: crossed when the percentile was below 0.99 on E − 1 and is at least 0.99
 * on E; rose when the score rose by 0.10 or more since E − 1. Both need a score on both days; without
 * E − 1 (the API fallback) there is no jump and change_24h is null.
 */
export function epssJump(e: EpssDay, e1: EpssDay | null, cve: string): { crossed: boolean; rose: boolean; change_24h: number | null } {
  const id = cve.toUpperCase();
  const now = e.scores.get(id);
  const before = e1?.scores.get(id);
  if (!now || !before) return { crossed: false, rose: false, change_24h: null };
  const change = round5(now.epss - before.epss);
  return { crossed: before.percentile < CROSS && now.percentile >= CROSS, rose: change >= RISE, change_24h: change };
}

/**
 * metrics.epss_movers (§5.12): the five largest rises from E − 7 to E among CVEs scoring at least 0.10 on E,
 * ties by CVE id. A CVE with no score on E − 7 has no rise to measure and is left out.
 */
export function epssMovers(e: EpssDay, e7: EpssDay): EpssMover[] {
  const rows: EpssMover[] = [];
  for (const [cve_id, now] of e.scores) {
    if (now.epss < MOVER_FLOOR) continue;
    const before = e7.scores.get(cve_id);
    if (!before) continue;
    const delta = round5(now.epss - before.epss);
    if (delta <= 0) continue;
    rows.push({ cve_id, score: now.epss, delta_7d: delta, percentile: now.percentile });
  }
  rows.sort((a, b) => (b.delta_7d !== a.delta_7d ? b.delta_7d - a.delta_7d : compareCveIds(a.cve_id, b.cve_id)));
  return rows.slice(0, MOVERS);
}
