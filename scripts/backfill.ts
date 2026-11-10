// The two-year backfill (SPEC §5.9, §8.4; rulings R22 and R26 to R34):
//   tsx scripts/backfill.ts [--cutoff YYYY-MM-DD] [--commit SHA] [--kev-commit SHA] [--catch-up | --credits]
//                           [--fixtures] [--check-reference] [--out DIR] [--push]
// builds content/state/ from a CVE List clone (cache/cvelistV5, updated in place) and one KEV catalog, then
// the metrics for the cutoff's edition date E = cutoff + 2 with runMetrics({ frozenState: true }), which
// reads the state just built and changes none of it (R28). The build reads no existing state: two builds
// at one commit, catalog and cutoff write byte-identical state files (and, with one `now`, byte-identical
// metrics). `--catch-up` and `--credits` start from contentDir()/state and write state only. `--fixtures`
// also writes fixtures/reference/ and skips the metrics (R32); `--check-reference` recomputes Appendix D
// from fixtures/reference/ and, at commit 67c39b1, from the clone at Appendix D's cutoff (the default there;
// another cutoff is a usage error), and prints the table. `--push` keeps its guards (R34) and, under the
// run lock, hands the staged state to publish's publishState() (§8.7). Everything read from the clone and
// the catalog is data.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadCheckedConfig, type LoadedConfig } from "../lib/config";
import { addDays, dataCutoffFor, inRange, isValidDate, taipeiTime, taipeiToday } from "../lib/dates";
import { cachePaths } from "../lib/feeds/cache";
import { REPOS } from "../lib/feeds/github";
import type { CveFacts, KevCatalog } from "../lib/feeds/types";
import { byCodeUnit } from "../lib/ids";
import { jsonText } from "../lib/json";
import { aiFindersOf, applyLedger, buildCredits, updateCredits, aiWeekly, type AiFindersRun, type CreditState } from "../lib/metrics/ai-credit";
import { updateAnthropicCvd } from "../lib/metrics/fix-side";
import { countDay, countDays, dayMap, DAYS_FROM, missingDays } from "../lib/metrics/flood";
import { buildKevIndex, indexEntries, indexFacts } from "../lib/metrics/kev-index";
import { REFERENCE } from "../lib/metrics/reference";
import { extendSeries, liveFromAfter, weeklySeries } from "../lib/metrics/series";
import { joinKev, type JoinFacts, type JoinRow } from "../lib/metrics/window";
import { STATE_FILES, STATE_SCHEMAS, type AnthropicCvdFile, type DayRow, type StateFileName, type StateFiles } from "../lib/schema/metrics";
import { ReferenceAiCreditsFile, ReferenceFloodDaysFile, ReferenceJoinFile } from "../lib/schema/reference";
import { contentDir } from "../lib/site";
import {
  appendixFigures, cloneFigures, compareFigures, expectedFigures, formatFigures, REFERENCE_FILES, REFERENCE_INPUTS, referenceFiles, referenceTexts,
  type Figure, type ReferenceFileName,
} from "./lib/appendix-d";
import { ensureClone, readClone, type CloneInfo } from "./lib/cvelist-clone";
import { loadFeedCache } from "./lib/feed-cache";
import { git } from "./lib/git";
import { liveGit, type GitSource } from "./lib/git-source";
import { branchTip, cachedRun, kevSource, type KevRead } from "./lib/kev-source";
import { acquireLock, releaseLock } from "./lib/lock";
import { runMetrics } from "./metrics";
import { publishState } from "./publish";

export interface BackfillOptions {
  root: string;
  cutoff: string;
  commit: string | null;
  kevCommit: string | null;
  mode: "build" | "catch-up" | "credits";
  fixtures: boolean;
  checkReference: boolean;
  out: string;
  push: boolean;
}

export interface BackfillDeps {
  cloneUrl: string;
  git: GitSource;
  fetchKev(commit: string | null): Promise<{ catalog: KevCatalog; commit: string; sha256: string }>;
  /** Free bytes on the clone's file system (statfs); at least 10 GiB are needed. */
  freeBytes(dir: string): number;
  now(): Date;
  workers: number;
  /** Where the stdout lines go (default: process.stdout). */
  print(line: string): void;
  /** --push only: an origin URL that counts as repos.repo besides GitHub's (tests: a bare remote's path; publish's Deps.repo). */
  repo?: string;
}

export const USAGE = "Usage: npm run backfill -- [--cutoff YYYY-MM-DD] [--commit SHA] [--kev-commit SHA] [--catch-up | --credits] " +
  "[--fixtures] [--check-reference] [--out DIR] [--push]";
/** §5.9 step 1: at least 10 GiB free before any network. */
export const MIN_FREE_BYTES = 10 * 1024 ** 3;
export const DEFAULT_OUT = "cache/staged/backfill";
export const CLONE_URL = `https://github.com/${REPOS.cvelist}.git`;
/** The reference (Appendix D) is at this commit, catalog and cutoff; `--fixtures` takes only these. */
const REF = REFERENCE_INPUTS;
const SHA_RE = /^[0-9a-f]{40}$/;

class Usage extends Error {}
class Refused extends Error {}

// ── Small helpers ──────────────────────────────────────────────────────────────────────────────────

const mmss = (seconds: number): string => {
  const s = Math.round(seconds);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const sha7 = (sha: string) => sha.slice(0, 7);

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** statfs on the nearest existing folder at or above `dir`. */
function statfsFree(dir: string): number {
  let d = path.resolve(dir);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  const s = fs.statfsSync(d);
  return Number(s.bavail) * Number(s.bsize);
}

const emptyCvd = (cutoff: string): AnthropicCvdFile => ({
  schema_version: 1, updated_at: cutoff, revision: null, as_of: null, fetched_at: null, source_url: null,
  found_n: null, disclosed_n: null, patched_n: null, ledger_ids: [],
});

/** Join facts by CVE id from the clone's records. */
function factsById(facts: readonly CveFacts[]): Map<string, JoinFacts> {
  return new Map(facts.map((f) => [f.cve_id, f]));
}

/** PUBLISHED records' UTC publication dates, for the dashboard ledger. */
function publishedOf(facts: readonly CveFacts[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of facts) if (f.state === "PUBLISHED" && f.date_published !== null) out.set(f.cve_id, f.date_published);
  return out;
}

const BriefEdition = z.object({ date: z.string(), edition: z.string() });

/** The Taipei dates of the data-only briefs in contentDir()/briefs/ up to `upTo`, and whether any brief exists. */
function briefs(content: string, upTo: string): { dataOnly: string[]; any: boolean } {
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(content, "briefs")).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort(byCodeUnit);
  } catch {
    return { dataOnly: [], any: false };
  }
  const dataOnly: string[] = [];
  for (const n of names) {
    try {
      const b = BriefEdition.parse(JSON.parse(fs.readFileSync(path.join(content, "briefs", n), "utf8")));
      if (b.edition === "data_only" && b.date <= upTo) dataOnly.push(b.date);
    } catch { /* an unreadable brief is the validator's business, not the backfill's */ }
  }
  return { dataOnly, any: names.length > 0 };
}

/** The six state files from a folder, or null when any is missing. A file that does not parse throws. */
function readStateDir(dir: string): StateFiles | null {
  const out: Partial<Record<StateFileName, unknown>> = {};
  for (const name of STATE_FILES) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return null;
    const parsed = STATE_SCHEMAS[name].safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!parsed.success) throw new Refused(`state/${name} does not parse: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    out[name] = parsed.data;
  }
  return out as StateFiles;
}

/** Writes the given state files through their schemas into `<dir>/`; returns the names written. */
function writeState(dir: string, state: Partial<StateFiles>): string[] {
  const wrote: string[] = [];
  for (const name of STATE_FILES) {
    const value = state[name];
    if (!value) continue;
    writeFile(path.join(dir, name), jsonText(value, STATE_SCHEMAS[name]));
    wrote.push(name);
  }
  return wrote;
}

// ── Options ────────────────────────────────────────────────────────────────────────────────────────

/** Turns the command line into options (throws Usage). `today` is the Taipei date the default cutoff comes from. */
export function parseBackfillArgs(argv: readonly string[], root: string, today: string): BackfillOptions {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv], strict: true, allowPositionals: false,
      options: {
        cutoff: { type: "string" }, commit: { type: "string" }, "kev-commit": { type: "string" }, "catch-up": { type: "boolean" },
        credits: { type: "boolean" }, fixtures: { type: "boolean" }, "check-reference": { type: "boolean" }, out: { type: "string" }, push: { type: "boolean" },
      },
    }));
  } catch (e) {
    throw new Usage((e as Error).message);
  }
  if (values["catch-up"] && values.credits) throw new Usage("--catch-up and --credits are separate runs.");
  if (values.push && values.out !== undefined) throw new Usage("--push publishes the default staging folder: leave out --out.");
  let commit = (values.commit as string | undefined) ?? null;
  if (commit !== null && !SHA_RE.test(commit)) {
    if (/^[0-9a-f]{7,39}$/.test(commit) && REF.cveListCommit.startsWith(commit)) commit = REF.cveListCommit;
    else throw new Usage(`--commit takes a full 40-hex SHA (a short one only for ${sha7(REF.cveListCommit)}).`);
  }
  // B15 (§8.4): a clone check at the reference commit is at Appendix D's cutoff, whatever day it runs.
  const atReference = !!values["check-reference"] && commit === REF.cveListCommit;
  return {
    root,
    cutoff: (values.cutoff as string | undefined) ?? (atReference ? REF.cutoff : dataCutoffFor(today)),
    commit,
    kevCommit: (values["kev-commit"] as string | undefined) ?? null,
    mode: values["catch-up"] ? "catch-up" : values.credits ? "credits" : "build",
    fixtures: !!values.fixtures,
    checkReference: !!values["check-reference"],
    out: (values.out as string | undefined) ?? DEFAULT_OUT,
    push: !!values.push,
  };
}

/** The flag rules (§8.4): throws Usage on a combination the backfill does not run. */
function checkOptions(o: BackfillOptions, today: string): void {
  const maxCutoff = dataCutoffFor(today);
  if (!isValidDate(o.cutoff) || o.cutoff < DAYS_FROM || o.cutoff > maxCutoff) {
    throw new Usage(`--cutoff must be a date from ${DAYS_FROM} to ${maxCutoff} (the cutoff of today's edition).`);
  }
  if (o.commit !== null && !SHA_RE.test(o.commit)) throw new Usage("--commit takes a full 40-hex SHA.");
  if (o.kevCommit !== null && !SHA_RE.test(o.kevCommit)) throw new Usage("--kev-commit takes a full 40-hex SHA.");
  if (o.push && o.mode === "build") throw new Usage("--push goes with --catch-up or --credits.");
  if (o.push && path.resolve(o.root, o.out) !== cachePaths(o.root).stagedBackfill) throw new Usage("--push publishes the default staging folder: leave out --out.");
  if ((o.fixtures || o.checkReference) && (o.mode !== "build" || o.push)) throw new Usage("--fixtures and --check-reference go with the default build only.");
  if (o.fixtures && (o.commit !== REF.cveListCommit || o.kevCommit === null || o.cutoff !== REF.cutoff)) {
    throw new Usage(`--fixtures needs --commit ${REF.cveListCommit} --kev-commit <the 2026.11.06 commit> --cutoff ${REF.cutoff}.`);
  }
  if (o.checkReference && o.commit === REF.cveListCommit && o.kevCommit === null) throw new Usage("--check-reference at the reference commit needs --kev-commit.");
  if (o.checkReference && o.commit === REF.cveListCommit && o.cutoff !== REF.cutoff) {
    throw new Usage(`--check-reference at ${sha7(REF.cveListCommit)} checks Appendix D's cutoff ${REF.cutoff}: leave out --cutoff or give --cutoff ${REF.cutoff}.`);
  }
}

// ── The clone, the catalog and the build ───────────────────────────────────────────────────────────

interface CloneRead {
  clone: CloneInfo;
  facts: CveFacts[];
}

async function cloneAndRead(o: BackfillOptions, d: BackfillDeps, commit: string): Promise<CloneRead> {
  const dir = cachePaths(o.root).cvelistClone;
  const free = d.freeBytes(dir);
  if (free < MIN_FREE_BYTES) {
    throw new Refused(`The clone needs at least 10 GiB free; ${(free / 1024 ** 3).toFixed(1)} GiB are free where ${path.relative(o.root, dir) || dir} lives.`);
  }
  const clone = await ensureClone(dir, d.cloneUrl, commit);
  d.print(`Clone ${sha7(clone.commit)} (${clone.committedAt.replace("T", " ").replace("Z", "")} UTC): ${mmss(clone.seconds)}, ` +
    `${(clone.bytes / 1e9).toFixed(1)} GB on disk${clone.reused ? " (reused: already at the commit and clean)" : ""}.`);
  const dayEnd = `${addDays(o.cutoff, 1)}T00:00:00Z`;
  if (clone.committedAt < dayEnd) {
    throw new Refused(`CVE List commit ${sha7(clone.commit)} was committed at ${clone.committedAt}, before the cutoff day ${o.cutoff} ended ` +
      `(${dayEnd}): its records for that day would be incomplete. Use a later commit or an earlier cutoff.`);
  }
  const started = Date.now();
  const read = await readClone(dir, d.workers);
  const pub = read.facts.filter((f) => f.state === "PUBLISHED").length;
  const rej = read.facts.filter((f) => f.state === "REJECTED").length;
  d.print(`Read ${read.files} records in ${mmss((Date.now() - started) / 1000)} with ${d.workers} workers: ${pub} published, ${rej} rejected, ` +
    `${read.creditStrings} credit strings.`);
  if (read.unreadable.length) {
    d.print(`${read.unreadable.length} record files could not be read and are left out: ${read.unreadable.slice(0, 3).join(", ")}${read.unreadable.length > 3 ? ", …" : ""}.`);
  }
  return { clone, facts: read.facts };
}

/** The KEV join rows the state and the reference use: the index's own join (date_added, then CVE id). */
function joinOf(index: StateFiles["kev-index.json"]): JoinRow[] {
  return joinKev(indexEntries(index), indexFacts(index));
}

/** The KEV stdout lines (W §7, ruling R27): the commit and where it came from, then the catalog and its join. */
function kevLines(kev: KevRead, rows: readonly JoinRow[], cutoff: string, source: string): string[] {
  const since = rows.filter((r) => inRange(r.date_added, DAYS_FROM, cutoff));
  const joined = since.filter((r) => r.date_published !== null).length;
  return [
    `KEV commit ${kev.commit} (${source}).`,
    `KEV ${kev.catalog.catalogVersion} at ${sha7(kev.commit)}: ${kev.catalog.vulnerabilities.length} entries; ${joined} of ${since.length} from ${DAYS_FROM} joined.`,
  ];
}

const kevFrom = (o: BackfillOptions, d: BackfillDeps): string =>
  o.kevCommit ? "--kev-commit" : (d.fetchKev as { source?: () => string }).source?.() || "the default catalog";

interface Built {
  state: StateFiles;
  rows: JoinRow[];
}

/** §5.9 steps 2 to 4 and the anthropic-cvd seed (R29), from the clone and the catalog alone. */
function buildState(facts: readonly CveFacts[], catalog: KevCatalog, cutoff: string, run: AiFindersRun, dataOnly: readonly string[], cvd: AnthropicCvdFile): Built {
  const days = countDays(DAYS_FROM, cutoff, facts);
  const credits = buildCredits({ records: facts, ghsa: [] }, run, cutoff);
  const ledgered = cvd.ledger_ids.length
    ? applyLedger(credits.credits, { cveIds: cvd.ledger_ids, published: publishedOf(facts) }, run, cutoff).credits
    : credits.credits;
  const index = buildKevIndex(catalog, factsById(facts), cutoff);
  const rows = joinOf(index);
  const series = weeklySeries({ days: dayMap(days), rows, credits: ledgered, dataOnlyDates: dataOnly }, cutoff, liveFromAfter(cutoff));
  return {
    state: {
      "kev-index.json": index,
      "days.json": { schema_version: 1, updated_at: cutoff, days },
      "ai-credits.json": ledgered,
      "credit-candidates.json": credits.candidates,
      "anthropic-cvd.json": cvd,
      "series.json": series,
    },
    rows,
  };
}

/** R29: anthropic-cvd.json from E's cached dashboard read when collect's cache is for E, else the empty seed. */
function cvdSeed(root: string, editionDate: string, cutoff: string, print: (l: string) => void): AnthropicCvdFile {
  if (!cachedRun(root, editionDate)) return emptyCvd(cutoff);
  try {
    const feeds = loadFeedCache(root, editionDate);
    const a = feeds.anthropicCvd;
    if (!a.dashboard) return emptyCvd(cutoff);
    return updateAnthropicCvd(emptyCvd(cutoff), a.dashboard, { fetchedAt: a.read.fetched_at ?? feeds.inputs.generated_at, sourceUrl: a.sourceUrl }, cutoff);
  } catch (e) {
    print(`The dashboard read in collect's cache for ${editionDate} could not be used (${(e as Error).message}); anthropic-cvd.json starts empty.`);
    return emptyCvd(cutoff);
  }
}

// ── Appendix D ─────────────────────────────────────────────────────────────────────────────────────

function referenceDir(root: string): string {
  return path.join(root, "fixtures", "reference");
}

/** The committed reference files, parsed, and their texts; null when any is missing. */
function readReference(root: string): { texts: Record<ReferenceFileName, string>; files: ReturnType<typeof referenceFiles> } | null {
  const dir = referenceDir(root);
  const texts = {} as Record<ReferenceFileName, string>;
  for (const f of REFERENCE_FILES) {
    const file = path.join(dir, f);
    if (!fs.existsSync(file)) return null;
    texts[f] = fs.readFileSync(file, "utf8");
  }
  return {
    texts,
    files: {
      join: ReferenceJoinFile.parse(JSON.parse(texts["kev-cve-join.json"])),
      floodDays: ReferenceFloodDaysFile.parse(JSON.parse(texts["flood-days.json"])),
      aiCredits: ReferenceAiCreditsFile.parse(JSON.parse(texts["ai-credits.json"])),
    },
  };
}

interface CloneCheck {
  facts: readonly CveFacts[];
  catalog: KevCatalog;
  texts: Record<ReferenceFileName, string>;
  files: ReturnType<typeof referenceFiles>;
}

/** §5.9 step 6: the Appendix D table. Exit 1 on any difference. */
function checkReference(root: string, config: LoadedConfig, clone: CloneCheck | null, print: (l: string) => void): 0 | 1 {
  const committed = readReference(root);
  if (!committed) {
    print("fixtures/reference/ is missing a file: run npm run backfill -- --fixtures (SPEC §5.9 step 5).");
    return 1;
  }
  const src = (f: ReturnType<typeof referenceFiles>) => ({ join: f.join, floodDays: f.floodDays, aiCredits: f.aiCredits, config, compiled: config.compiled });
  const fixtures = appendixFigures(src(committed.files));
  const fromClone = clone ? { ...appendixFigures(src(clone.files)), ...cloneFigures(clone.facts, clone.catalog, { config, compiled: config.compiled }) } : null;
  const rows: Figure[] = compareFigures(expectedFigures(config), fixtures, fromClone);
  if (clone) {
    for (const f of REFERENCE_FILES) {
      const same = committed.texts[f] === clone.texts[f];
      rows.push({ id: `fixtures/reference/${f} bytes`, expected: "byte-identical to the clone's", fixtures: same ? "byte-identical to the clone's" : "differs",
        clone: same ? "byte-identical to the clone's" : `${clone.texts[f].length} characters regenerated`, ok: same });
    }
  }
  for (const line of formatFigures(rows)) print(line);
  if (fromClone) print(`AI credit matching to ${REF.cutoff} (ruling R1): ${fromClone["D.7 raw versus sanitised"]}.`);
  else print(`The clone check needs --commit ${REF.cveListCommit} --kev-commit <sha>: offline figures only.`);
  const bad = rows.filter((r) => !r.ok);
  print(bad.length ? `Appendix D: ${bad.length} of ${rows.length} figures differ.` : `Appendix D: all ${rows.length} figures ok.`);
  return bad.length ? 1 : 0;
}

// ── Modes ──────────────────────────────────────────────────────────────────────────────────────────

/** The default build (§5.9 steps 1 to 6, §8.4), with --fixtures and --check-reference. */
async function build(o: BackfillOptions, d: BackfillDeps, config: LoadedConfig): Promise<0 | 1> {
  const E = addDays(o.cutoff, 2);
  const root = o.root;
  const content = path.resolve(root, contentDir());
  const out = path.resolve(root, o.out);
  const run = aiFindersOf(config, config.compiled);
  const onlyCheck = o.checkReference && !o.fixtures;
  const atReference = o.commit === REF.cveListCommit;

  if (onlyCheck && !atReference) return checkReference(root, config, null, d.print);

  const metricsExist = fs.existsSync(path.join(content, "metrics", `${E}.json`));
  const cached = cachedRun(root, E);
  if (!o.fixtures && !onlyCheck && !metricsExist && !cached) {
    d.print(`No feeds for ${E} in cache/: run npm run collect -- --date ${E} first.`);
    return 1;
  }
  let commit = o.commit;
  let source = "--commit";
  if (commit === null && cached?.cvelistCommit) [commit, source] = [cached.cvelistCommit, `collect's cache for ${E}`];
  if (commit === null) {
    commit = await branchTip(d.git, REPOS.cvelist, "main");
    source = "the tip of main";
    if (commit === null) throw new Refused("git ls-remote could not read the tip of CVEProject/cvelistV5 main.");
  }
  d.print(`CVE List commit ${commit} (${source}).`);
  const { facts } = await cloneAndRead(o, d, commit);

  const kev = await d.fetchKev(o.kevCommit);
  if ((o.fixtures || o.checkReference) && (kev.catalog.catalogVersion !== REF.kevCatalogVersion || kev.catalog.vulnerabilities.length !== REF.kevEntries)) {
    d.print(`KEV ${kev.catalog.catalogVersion} at ${sha7(kev.commit)} has ${kev.catalog.vulnerabilities.length} entries; Appendix D needs ` +
      `${REF.kevCatalogVersion} with ${REF.kevEntries} (D.1).`);
    return 1;
  }

  const cvd = o.fixtures || onlyCheck ? emptyCvd(o.cutoff) : cvdSeed(root, E, o.cutoff, d.print);
  const dataOnly = o.fixtures || onlyCheck ? [] : briefs(content, E).dataOnly;
  const built = buildState(facts, kev.catalog, o.cutoff, run, dataOnly, cvd);
  for (const line of kevLines(kev, built.rows, o.cutoff, kevFrom(o, d))) d.print(line);
  const series = built.state["series.json"];
  const matches = built.state["ai-credits.json"].matches.length;
  d.print(`State to ${o.cutoff}: ${built.state["days.json"].days.length} days, ${matches} AI matches, ${series.weeks.length} weeks; live_from ${series.live_from}.`);

  const refFiles = atReference && o.cutoff === REF.cutoff
    ? referenceFiles({ cveListCommit: commit, kevCatalogVersion: kev.catalog.catalogVersion, kevDataCommit: kev.commit, cutoff: o.cutoff,
        days: built.state["days.json"].days, joinRows: built.rows, credits: built.state["ai-credits.json"] })
    : null;

  if (!onlyCheck) {
    if (out === cachePaths(root).stagedBackfill) fs.rmSync(out, { recursive: true, force: true });
    const wrote = writeState(path.join(out, "state"), built.state);
    d.print(`Wrote ${wrote.length} state files to ${path.relative(root, path.join(out, "state")) || "."}.`);
  }
  if (o.fixtures && refFiles) {
    const texts = referenceTexts(refFiles);
    for (const f of REFERENCE_FILES) writeFile(path.join(referenceDir(root), f), texts[f]);
    d.print(`Wrote ${REFERENCE_FILES.map((f) => `fixtures/reference/${f}`).join(", ")}: ${refFiles.join.rows.length}, ` +
      `${refFiles.floodDays.days.length} and ${refFiles.aiCredits.matches.length} rows.`);
  }
  if (o.checkReference) {
    const clone = refFiles ? { facts, catalog: kev.catalog, texts: referenceTexts(refFiles), files: refFiles } : null;
    return checkReference(root, config, clone, d.print);
  }
  if (o.fixtures) return 0; // R32: no metrics for a reference build

  const r = await runMetrics({ date: E, root, out, stateDir: path.join(out, "state"), reconstructed: true, frozenState: true, now: d.now() });
  for (const line of r.lines) d.print(line);
  return r.code;
}

/** --catch-up (§8.4): the days days.json lacks, every record's credits rematched, the series extended. State only. */
async function catchUp(o: BackfillOptions, d: BackfillDeps, config: LoadedConfig): Promise<0 | 1> {
  const content = path.resolve(o.root, contentDir());
  const prev = readStateDir(path.join(content, "state"));
  if (!prev) {
    d.print("state/ is missing: run npm run backfill first (SPEC §8.4).");
    return 1;
  }
  // B16 (§8.4): with no --commit, the CVE List commit collect read for E, as kevSource() does for the catalog,
  // so the catch-up and E's metrics count one clone; else the tip of main.
  const E = addDays(o.cutoff, 2);
  const cachedCommit = o.commit === null ? cachedRun(o.root, E)?.cvelistCommit ?? null : null;
  const commit = o.commit ?? cachedCommit ?? (await branchTip(d.git, REPOS.cvelist, "main"));
  if (commit === null) throw new Refused("git ls-remote could not read the tip of CVEProject/cvelistV5 main.");
  d.print(`CVE List commit ${commit} (${o.commit ? "--commit" : cachedCommit ? `collect's cache for ${E}` : "the tip of main"}).`);
  const { facts } = await cloneAndRead(o, d, commit);
  const run = aiFindersOf(config, config.compiled);

  const days = dayMap(prev["days.json"].days);
  const missing = missingDays(days, DAYS_FROM, o.cutoff);
  const wanted = new Set(missing);
  const byDay = new Map<string, CveFacts[]>();
  for (const f of facts) {
    if (f.date_published === null || !wanted.has(f.date_published)) continue;
    const list = byDay.get(f.date_published);
    if (list) list.push(f);
    else byDay.set(f.date_published, [f]);
  }
  const added: DayRow[] = missing.map((day) => countDay(day, byDay.get(day) ?? []));
  const allDays = [...prev["days.json"].days, ...added].sort((a, b) => byCodeUnit(a[0], b[0]));

  // Rematched: every record published to the cutoff, first_matched kept (§8.4, §0.4 row 65). The
  // mornings a catch-up stands in for matched none (in catch-up mode, or the morning that missed a day behind
  // the newest counted one), and a record published earlier can have changed in that time.
  const rematch = facts.filter((f) => f.date_published !== null && f.date_published <= o.cutoff);
  const prevCredits: CreditState = { candidates: prev["credit-candidates.json"], credits: prev["ai-credits.json"] };
  const updated = updateCredits(prevCredits, { records: rematch, ghsa: [] }, run, o.cutoff).state;
  // B14: the dashboard's ledger ids applied again with the clone's publication dates, as the build and --credits do.
  const credits: CreditState = {
    candidates: updated.candidates,
    credits: applyLedger(updated.credits, { cveIds: prev["anthropic-cvd.json"].ledger_ids, published: publishedOf(facts) }, run, o.cutoff).credits,
  };

  const edition = briefs(content, E);
  const anyBrief = edition.any;
  let index = prev["kev-index.json"];
  if (!anyBrief) {
    const kev = await d.fetchKev(o.kevCommit);
    index = buildKevIndex(kev.catalog, factsById(facts), o.cutoff);
    for (const line of kevLines(kev, joinOf(index), o.cutoff, kevFrom(o, d))) d.print(line);
  } else d.print("A brief exists in content/: kev-index.json and live_from stay as they are.");
  const rows = joinOf(index);
  let series = extendSeries(prev["series.json"], { days: dayMap(allDays), rows, credits: credits.credits, dataOnlyDates: edition.dataOnly }, o.cutoff);
  if (!anyBrief) series = { ...series, live_from: liveFromAfter(o.cutoff) };

  const state: StateFiles = {
    ...prev,
    "kev-index.json": index,
    "days.json": { schema_version: 1, updated_at: o.cutoff, days: allDays },
    "ai-credits.json": credits.credits,
    "credit-candidates.json": credits.candidates,
    "series.json": series,
  };
  d.print(`Catch-up to ${o.cutoff}: ${added.length} days added (${added[0]?.[0] ?? "none"}${added.length > 1 ? ` to ${added.at(-1)![0]}` : ""}), ` +
    `${rematch.length} records to ${o.cutoff} rematched, ${series.weeks.length} weeks; live_from ${series.live_from}.`);
  return await finishStateOnly(o, d, state);
}

/** --credits (§8.4, §5.5): both credit files rebuilt from the clone, first_matched kept, the series' AI fields rewritten. State only. */
async function rebuildCredits(o: BackfillOptions, d: BackfillDeps, config: LoadedConfig): Promise<0 | 1> {
  const content = path.resolve(o.root, contentDir());
  const prev = readStateDir(path.join(content, "state"));
  if (!prev) {
    d.print("state/ is missing: run npm run backfill first (SPEC §8.4).");
    return 1;
  }
  const commit = o.commit ?? (await branchTip(d.git, REPOS.cvelist, "main"));
  if (commit === null) throw new Refused("git ls-remote could not read the tip of CVEProject/cvelistV5 main.");
  d.print(`CVE List commit ${commit} (${o.commit ? "--commit" : "the tip of main"}).`);
  const { facts } = await cloneAndRead(o, d, commit);
  const run = aiFindersOf(config, config.compiled);
  const fresh = buildCredits({ records: facts, ghsa: [] }, run, o.cutoff);
  const first = new Map(prev["ai-credits.json"].matches.map((m) => [m[0], m[8]]));
  const prevLedger = prev["ai-credits.json"].matches.filter((m) => m[7] === "cvd_ledger");
  const matches = fresh.credits.matches.map((m) => {
    const was = first.get(m[0]);
    return was === undefined ? m : ([...m.slice(0, 8), was] as typeof m);
  });
  const credits = applyLedger({ ...fresh.credits, matches: [...matches, ...prevLedger] },
    { cveIds: prev["anthropic-cvd.json"].ledger_ids, published: publishedOf(facts) }, run, o.cutoff).credits;
  const s = prev["series.json"];
  const series = { ...s, ...aiWeekly(credits, s.weeks) };
  const state: StateFiles = { ...prev, "ai-credits.json": credits, "credit-candidates.json": fresh.candidates, "series.json": series };
  d.print(`Credits to ${o.cutoff}: ${fresh.candidates.candidates.length} candidate strings, ${credits.matches.length} AI matches at list v${run.version}.`);
  return await finishStateOnly(o, d, state);
}

/**
 * Writes the state into <out>/state/; with --push, takes the run lock and publishes the staged state files
 * with publishState() (§8.4, §8.7): one `state: <cutoff> · catch-up` (or `· backfill`) commit, pushed.
 */
async function finishStateOnly(o: BackfillOptions, d: BackfillDeps, state: StateFiles): Promise<0 | 1> {
  const out = path.resolve(o.root, o.out);
  if (out === cachePaths(o.root).stagedBackfill) fs.rmSync(out, { recursive: true, force: true });
  const wrote = writeState(path.join(out, "state"), state);
  d.print(`Wrote ${wrote.length} state files to ${path.relative(o.root, path.join(out, "state")) || "."}.`);
  if (!o.push) return 0;
  const lock = path.join(o.root, "logs", ".lock");
  const got = acquireLock(lock, d.now().getTime());
  if (!got.acquired) {
    d.print(`The run lock is held (pid ${got.holder.pid} since ${got.holder.started}): nothing was published.`);
    return 1;
  }
  try {
    const config = loadCheckedConfig({ root: o.root });
    const now = () => d.now().getTime();
    const r = await publishState({
      root: o.root, date: taipeiToday(d.now()), deadline: Number.POSITIVE_INFINITY, now, dryRun: false, repo: d.repo, config,
      mode: o.mode === "catch-up" ? "catch-up" : "backfill", stagedDir: out, cutoff: o.cutoff, log: d.print,
    });
    d.print(r.sha
      ? `Published ${r.files.length} state files to main as ${sha7(r.sha)}.`
      : "Nothing was published: content/state/ already holds this state.");
    return 0;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    d.print(`Nothing was published: ${typeof code === "string" ? code : e instanceof Error ? e.message.slice(0, 300) : String(e)}.`);
    return 1;
  } finally {
    releaseLock(lock);
  }
}

/** --push's guards before any work (§8.4): the main checkout, on a clean main, outside 04:00 to 06:00 Taipei. */
async function pushGuards(o: BackfillOptions, now: Date): Promise<void> {
  const t = taipeiTime(now);
  if (t >= "04:00" && t < "06:00") throw new Refused(`--push is refused from 04:00 to 06:00 Taipei (now ${t}): the morning run owns main then.`);
  const g = git(o.root);
  const [dir, common, branch, status] = await Promise.all([
    g(["rev-parse", "--absolute-git-dir"]), g(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    g(["rev-parse", "--abbrev-ref", "HEAD"]), g(["status", "--porcelain"]),
  ]);
  if (path.resolve(dir) !== path.resolve(common)) throw new Refused("--push runs in the main checkout, not a worktree.");
  if (branch !== "main") throw new Refused(`--push runs on main (this checkout is on ${branch}).`);
  if (status !== "") throw new Refused("--push needs a clean checkout: commit or stash the changes first.");
}

// ── runBackfill and the CLI ────────────────────────────────────────────────────────────────────────

function defaults(root: string, cutoff: string, d: Partial<BackfillDeps>): BackfillDeps {
  const g = d.git ?? liveGit(root);
  return {
    cloneUrl: d.cloneUrl ?? CLONE_URL,
    git: g,
    fetchKev: d.fetchKev ?? kevSource(root, g, addDays(cutoff, 2)),
    freeBytes: d.freeBytes ?? statfsFree,
    now: d.now ?? (() => new Date()),
    workers: d.workers ?? 4,
    print: d.print ?? ((line) => process.stdout.write(`${line}\n`)),
    repo: d.repo,
  };
}

/** Exit code: 0 done, 1 failed or refused, 2 usage. */
export async function runBackfill(o: BackfillOptions, d: Partial<BackfillDeps> = {}): Promise<0 | 1 | 2> {
  const deps = defaults(o.root, o.cutoff, d);
  try {
    checkOptions(o, taipeiToday(deps.now()));
    if (o.push) await pushGuards(o, deps.now());
    const config = loadCheckedConfig({ root: o.root });
    if (o.mode === "catch-up") return await catchUp(o, deps, config);
    if (o.mode === "credits") return await rebuildCredits(o, deps, config);
    return await build(o, deps, config);
  } catch (e) {
    if (e instanceof Usage) {
      deps.print(`${e.message}\n${USAGE}`);
      return 2;
    }
    deps.print(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

export async function main(argv: string[] = process.argv.slice(2), root: string = process.cwd()): Promise<number> {
  let o: BackfillOptions;
  try {
    o = parseBackfillArgs(argv, path.resolve(root), taipeiToday());
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}\n`);
    return 2;
  }
  return runBackfill(o);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main().then((code) => { process.exitCode = code; });
