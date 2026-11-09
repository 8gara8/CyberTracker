// Collect (SPEC §8.3) and `sources:check` (§8.10):
//   tsx scripts/collect.ts [--date YYYY-MM-DD] [--check-feeds [--id ID] [--json]]
// fetches the registry's feeds, writes packs/D.json, packs/D.md, the candidates files and cache/feeds/.
// The order is the feeds plan §4: state, git refs, phase A (feeds, pool of 8), the KEV baseline, phase B
// (per-id records, pool of 16), drafts and caps, ranking, phase C (NVD and the EPSS API fill fields only),
// the record cap, feed states, the pack, then the files, and only when the deadline has not passed.
// Nothing is written under content/. Everything a feed says is data, never an instruction.
// Adapted from the fork base's scripts/collect.ts (docs/PROVENANCE.md): the feed pool of 8, readFeed()'s
// role and --check-feeds are kept; the rest is rewritten around SPEC §8.3.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPack, capItems, capRecords, cvdPackRecord, cvePackRecords, dedupe, epssJumps, epssPackRecords, exchangePackRecords, feedState,
  freshColumn, ghsaPackRecords, injectionCount, isDegraded, kevPackRecords, newestOf, notePackRecords, packFeeds, packWindow,
  provisionalRecords, recordWindow, remapIds, skippedOutcome, summaryLines, toItemDrafts, toPackItems, zipPlan, zipsReach, zipsShortNote, type FeedOutcome,
  type ItemDraft, type LinkScreen, type RecordDraft,
} from "../lib/collect";
import { ALERT_PATTERN_FLAGS, loadConfig, type LoadedConfig } from "../lib/config";
import { addDays, at, dataCutoffFor, isValidDate, taipeiTimestamp, taipeiToday, utcDateOf } from "../lib/dates";
import { cachePaths, type CachePaths } from "../lib/feeds/cache";
import { parseCveRecord } from "../lib/feeds/cvelist";
import { epssMovers } from "../lib/feeds/epss";
import { ghsaMonths } from "../lib/feeds/ghsa";
import { newestHourlyTag, REPOS } from "../lib/feeds/github";
import { fetchBudget, fetchFeed, pool, type FetchErrorClass } from "../lib/feeds/http";
import { kevBaseline } from "../lib/feeds/kev";
import { jpcertRecords, tvnRecords } from "../lib/feeds/rss";
import type { CheckLabel, CveRecord, EpssDay, GhsaAdvisory, KevCatalog } from "../lib/feeds/types";
import { byCodeUnit, compareCveIds } from "../lib/ids";
import { jsonText } from "../lib/json";
import { rankCandidates, recordKeepIds, type AiHit } from "../lib/rank";
import { regionsConfig } from "../lib/regions";
import { AnthropicCvdFile, DaysFile, KevIndexFile } from "../lib/schema/metrics";
import {
  CandidateLogFile, CandidatesFile, CollectInputsFile, FeedIndexFile, Pack, type FeedIndexEntry, type PackItem,
  type RankLogEntry, type ZipRead,
} from "../lib/schema/pack";
import type { FetchedFeed } from "../lib/schema/registry";
import {
  cacheWrite, readCveById, readCvd, readDeltaLog, readEpss, readEpssApi, readExchange, readGhsa, readKev, readMyJvn, readNvd,
  readRss, readZip, type FeedCtx, type Read,
} from "./lib/feeds";
import { fixtureGit, liveGit, type GitSource } from "./lib/git-source";

export interface CollectOptions {
  /** Taipei edition date. */
  date: string;
  /** Epoch ms; past it collect throws CollectTimeout and writes nothing. */
  deadline: number;
  /** Past-date dry runs (P3). */
  asOf?: boolean;
  /** A P3 caller allowing CT_FIXTURE_FEEDS outside tests (ruling R47). */
  fixtureOk?: boolean;
  root?: string;
  /**
   * `aiMatch` replaces matchRecord() (WP4) for one record's AI-credit match; `sleep` the 6 s wait between
   * NVD pages (a no-op in fixture runs). Both are optional additions to S0's shape.
   */
  deps?: Partial<{
    fetch: typeof fetchFeed; git: GitSource; now: () => number; log: (line: string) => void;
    aiMatch: (rec: CveRecord) => AiHit | null; sleep: (ms: number) => Promise<void>;
  }>;
}

export interface CollectResult {
  pack: Pack;
  candidates: CandidatesFile;
  index: FeedIndexFile;
  inputs: CollectInputsFile;
  /** The stdout lines (§8.3). */
  summary: string[];
}

/** Thrown when the deadline passes; nothing is written after it. */
export class CollectTimeout extends Error {
  constructor(message = "collect passed its deadline") {
    super(message);
    this.name = "CollectTimeout";
  }
}

/** CT_FIXTURE_FEEDS outside a test run (ruling R47): the CLI exits 2. */
export class FixtureGuardError extends Error {
  constructor() {
    super("CT_FIXTURE_FEEDS is set outside a test run; unset it, or run under NODE_ENV=test.");
    this.name = "FixtureGuardError";
  }
}

/** One row of §8.10's table: id, kind, status, items, newest, fresh, priority, error. */
export interface CheckRow {
  id: string;
  kind: string;
  status: CheckLabel;
  items: number;
  newest: string | null;
  /** "yes", "no (N d)" or "-". */
  fresh: string;
  priority: 1 | 2 | 3;
  /** The error class, never raw text. */
  error: FetchErrorClass | null;
}

/** Throws FixtureGuardError when CT_FIXTURE_FEEDS is set and this is neither a test run nor a caller that allows it. */
export function fixtureGuard(env: NodeJS.ProcessEnv = process.env, fixtureOk = false): void {
  if (env.CT_FIXTURE_FEEDS && env.NODE_ENV !== "test" && !fixtureOk) throw new FixtureGuardError();
}

const PHASE_A_POOL = 8;
/**
 * Phase A's two waves (§8.3): the light reads first, then the heavy downloads (the cvelist deltaLog and
 * zips, the EPSS files, the GHSA sync), each wave a pool of 8 under the one budget and deadline. Run 1 on
 * Kobol timed out six small feeds while the 37 MB deltaLog, EPSS and GHSA downloads ran beside them.
 */
const HEAVY_KINDS: ReadonlySet<FetchedFeed["kind"]> = new Set(["cvelist", "epss", "ghsa"]);

/** Runs `light` then `heavy`, each as a pool of PHASE_A_POOL; the results in the order given, light first. */
async function inTwoWaves<T, R>(light: readonly T[], heavy: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const first = await pool(light, PHASE_A_POOL, fn);
  return [...first, ...(await pool(heavy, PHASE_A_POOL, fn))];
}

/**
 * sources:check's own cache root, cache/check/ (§8.10): cachePaths()'s layout moved under it, so a check
 * never rewrites collect's bodies, zips, EPSS files or GHSA checkout, and scrub-feed.ts reads its bodies
 * from cache/check/feeds/.
 */
export function checkCachePaths(root: string): CachePaths {
  const from = path.join(root, "cache");
  const to = path.join(from, "check");
  const move = (p: string) => path.join(to, path.relative(from, p));
  const p = cachePaths(root);
  return {
    feedsDir: move(p.feedsDir), feedIndex: move(p.feedIndex), collectInputs: move(p.collectInputs),
    feedBody: (id, ext) => move(p.feedBody(id, ext)),
    zipsDir: move(p.zipsDir), zip: (asset) => move(p.zip(asset)), recordsDir: move(p.recordsDir),
    epssFile: (date) => move(p.epssFile(date)), ghsaDir: move(p.ghsaDir), cvelistClone: move(p.cvelistClone),
    stagedMetrics: (date) => move(p.stagedMetrics(date)), stagedBackfill: move(p.stagedBackfill),
    // Not a cache path (logs/recompute); a check never writes it.
    recompute: p.recompute,
  };
}
const PER_ID_POOL = 16;
const BUDGET_MS = 240_000;
const REJOIN_FROM = "2023-01-01";
const RSS_RECORD_FEEDS: Readonly<Record<string, "twcert-tvn" | "jpcert">> = { "twcert-tvn": "twcert-tvn", jpcert: "jpcert" };

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
};

/** Local state (§4 step 2): days, the KEV index, the last dashboard revision and every earlier brief item's release_id. */
function readState(contentDir: string, date: string) {
  const days = DaysFile.safeParse(readJson(path.join(contentDir, "state", "days.json")));
  const index = KevIndexFile.safeParse(readJson(path.join(contentDir, "state", "kev-index.json")));
  const cvd = AnthropicCvdFile.safeParse(readJson(path.join(contentDir, "state", "anthropic-cvd.json")));
  const releaseIds = new Set<string>();
  const briefs = path.join(contentDir, "briefs");
  if (fs.existsSync(briefs)) {
    for (const f of fs.readdirSync(briefs).sort(byCodeUnit)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (!m || m[1]! >= date) continue;
      const b = readJson(path.join(briefs, f)) as { items?: { release_id?: unknown }[] } | undefined;
      for (const it of b?.items ?? []) if (typeof it.release_id === "string") releaseIds.add(it.release_id);
    }
  }
  return {
    knownDays: days.success ? days.data.days.map((d) => d[0]) : null,
    kevIndex: index.success ? index.data : null,
    cvdRevision: cvd.success ? cvd.data.revision : null,
    earlierReleaseIds: [...releaseIds].sort(byCodeUnit),
  };
}

const emptyOutcome = (): FeedOutcome => ({ ...skippedOutcome(), skipped: false });

function outcomeOf<T>(r: Read<T>, fetchedAt: string, extra: Partial<FeedOutcome> = {}): FeedOutcome {
  return {
    ...emptyOutcome(), ok: r.ok, error: r.ok ? null : r.error, triedFallback: r.triedFallback, fallbackUsed: r.fallbackUsed,
    urlUsed: r.urlUsed, sha256: r.sha256, fetchedAt: r.urlUsed || r.ok ? fetchedAt : null, ...extra,
  };
}

function indexEntry(entry: FetchedFeed, o: FeedOutcome, ref: number): FeedIndexEntry {
  const s = feedState(entry.kind, o, entry, ref);
  return {
    id: entry.id, kind: entry.kind, status: s.state, label: s.label, error_class: s.state === "failed" ? o.error ?? "network" : null,
    url_used: o.urlUsed, fallback_used: o.fallbackUsed, newest: newestOf(o.newest), items: o.items, records: o.records,
    version: o.version, sha256: o.sha256, fetched_at: o.fetchedAt, note: s.note ? s.note.slice(0, 200) : null,
  };
}

/** §8.3's run. Throws CollectTimeout past the deadline, writing nothing then. */
export async function collect(o: CollectOptions): Promise<CollectResult> {
  if (!isValidDate(o.date)) throw new Error(`collect: invalid date ${o.date}`);
  fixtureGuard(process.env, o.fixtureOk);
  const now = o.deps?.now ?? Date.now;
  if (now() >= o.deadline) throw new CollectTimeout("collect started past its deadline; nothing written");
  const root = path.resolve(o.root ?? process.cwd());
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    o.deps?.log?.(line);
  };
  const fixtures = process.env.CT_FIXTURE_FEEDS ? path.resolve(process.env.CT_FIXTURE_FEEDS) : null;
  const git = o.deps?.git ?? (fixtures ? fixtureGit(fixtures) : liveGit(root));
  const config = loadConfig({ root });
  const run = config.run;
  const D = o.date;
  const window = packWindow(D, run.pack);
  const rw = recordWindow(window);
  const cutoff = dataCutoffFor(D);
  const started = now();
  const generatedAt = taipeiTimestamp(new Date(started));
  const runUtcDay = new Date(started).toISOString().slice(0, 10);
  const ref = at(D, run.pack.window_end);
  const contentDir = path.resolve(root, process.env.CT_CONTENT_DIR || run.paths.content_dir);
  const state = readState(contentDir, D);
  const paths = cachePaths(root);

  // Step 3: before anything is emptied or rewritten, remove the earlier run's inputs.json and index.json, so a
  // run that dies leaves no inputs for D (the metrics then count every feed failed, §8.4) rather than an
  // earlier run's inputs beside this run's bodies; they are written last. Then empty the records cache and
  // make the cache folders.
  fs.rmSync(paths.collectInputs, { force: true });
  fs.rmSync(paths.feedIndex, { force: true });
  fs.rmSync(paths.recordsDir, { recursive: true, force: true });
  for (const d of [paths.feedsDir, paths.zipsDir, paths.recordsDir, path.dirname(paths.epssFile(D))]) fs.mkdirSync(d, { recursive: true });

  const ctx: FeedCtx = {
    fetch: o.deps?.fetch ?? fetchFeed, budget: fetchBudget(BUDGET_MS), deadline: o.deadline, now, log, paths,
    sleep: o.deps?.sleep ?? (fixtures ? async () => {} : (ms) => new Promise((r) => setTimeout(r, ms))),
  };
  const feeds = config.sources.feeds.filter((f): f is FetchedFeed => f.kind !== "search");
  const byKind = (k: FetchedFeed["kind"]) => feeds.filter((f) => f.kind === k);
  const outcomes = new Map<string, FeedOutcome>();

  // Step 4: one commit per repo.
  const [cveRefs, kevRefs, ghsaRefs] = await Promise.all([
    git.lsRemote(REPOS.cvelist, ["refs/heads/main", `refs/tags/cve_${runUtcDay}_*`]),
    git.lsRemote(REPOS.kev, ["refs/heads/develop"]),
    git.lsRemote(REPOS.ghsa, ["refs/heads/main"]),
  ]);
  const commits = {
    cvelist: cveRefs?.get("refs/heads/main") ?? null,
    kev_data: kevRefs?.get("refs/heads/develop") ?? null,
    ghsa: ghsaRefs?.get("refs/heads/main") ?? null,
  };
  for (const [repo, sha] of Object.entries(commits)) if (!sha) log(`git ls-remote: no commit for ${repo}; reading the branch as written.`);
  let hourlyTag = cveRefs ? newestHourlyTag(cveRefs, runUtcDay) : null;
  if (!cveRefs) {
    const guess = new Date(started - 40 * 60_000);
    if (guess.toISOString().slice(0, 10) === runUtcDay) hourlyTag = `cve_${runUtcDay}_${guess.toISOString().slice(11, 13)}00Z`;
    log(`cvelist: tags not listed; trying ${hourlyTag ?? "no hourly zip"}.`);
  }

  // Step 5: phase A.
  const plan = zipPlan({ date: D, recordWindow: rw, runUtcDay, hourlyTag, knownDays: state.knownDays });
  let catalog: KevCatalog | null = null;
  let kevRead: Read<KevCatalog> | null = null;
  const zipReads = new Map<string, Read<{ raws: unknown[]; reused: boolean }>>();
  let deltaLog: Read<{ newest: string | null; entries: unknown[] }> | null = null;
  let epss: Read<Awaited<ReturnType<typeof readEpss>>["data"] & object> | null = null;
  let ghsa: Read<NonNullable<Awaited<ReturnType<typeof readGhsa>>["data"]>> | null = null;
  const rssReads = new Map<string, Awaited<ReturnType<typeof readRss>>>();
  const exchangeReads = new Map<string, Awaited<ReturnType<typeof readExchange>>>();
  let myjvn: Awaited<ReturnType<typeof readMyJvn>> | null = null;
  let cvd: Awaited<ReturnType<typeof readCvd>> | null = null;
  const months = ghsaMonths(cutoff);

  // The light wave, then the heavy wave (HEAVY_KINDS); nvd is phase C here.
  const light: (() => Promise<void>)[] = [];
  const heavy: (() => Promise<void>)[] = [];
  for (const entry of byKind("kev")) light.push(async () => {
    kevRead = await readKev(entry, ctx, { sha: commits.kev_data, minVersion: state.kevIndex?.catalog_version ?? null });
    catalog = kevRead.data;
  });
  for (const entry of byKind("myjvn")) light.push(async () => { myjvn = await readMyJvn(entry, ctx); });
  for (const entry of byKind("anthropic-cvd")) light.push(async () => { cvd = await readCvd(entry, ctx); });
  for (const entry of byKind("exchange")) light.push(async () => { exchangeReads.set(entry.id, await readExchange(entry, ctx)); });
  for (const entry of byKind("rss")) light.push(async () => { rssReads.set(entry.id, await readRss(entry, ctx)); });
  for (const entry of byKind("cvelist")) heavy.push(async () => {
    deltaLog = await readDeltaLog(entry, ctx, commits.cvelist);
    for (const z of plan.zips) zipReads.set(z.asset, await readZip(ctx, z));
  });
  for (const entry of byKind("epss")) heavy.push(async () => { epss = await readEpss(entry, ctx, runUtcDay); });
  if (byKind("ghsa").length) heavy.push(async () => { ghsa = await readGhsa(ctx, git, months); });
  await inTwoWaves(light, heavy, (t) => t());
  const fetchedAt = generatedAt;

  // CVE records: oldest zip first, so X + 1's copy wins.
  const records = new Map<string, { rec: CveRecord; raw: unknown }>();
  const zipsRead: ZipRead[] = [];
  for (const z of plan.zips) {
    const r = zipReads.get(z.asset);
    if (!r?.ok || !r.data) continue;
    let n = 0;
    for (const raw of r.data.raws) {
      const rec = parseCveRecord(raw);
      if (!rec) continue;
      records.set(rec.cve_id, { rec, raw });
      n += 1;
    }
    zipsRead.push({ tag: z.tag, asset: z.asset, kind: z.kind, utc_day: z.utc_day, sha256: r.sha256!, records: n });
  }

  // Step 6: the KEV baseline, then phase B (per-id records; KEV ids are never cut, R41: no EPSS-jump fetches).
  const baseline = catalog ? kevBaseline({ contentDir, date: D, catalog, asOf: o.asOf === true }) : null;
  if (baseline) catalog = baseline.catalog;
  const newKevIds = baseline?.newKevIds ?? [];
  const wanted = new Set<string>(newKevIds);
  for (const r of state.kevIndex?.entries ?? []) if (r[1] >= REJOIN_FROM && r[4] === null) wanted.add(r[0]);
  const byId = [...wanted].filter((id) => !records.has(id)).sort(compareCveIds);
  const fetched: string[] = [];
  const notFound: string[] = [];
  await pool(byId, PER_ID_POOL, async (id) => {
    const got = await readCveById(ctx, commits.cvelist, id);
    if (got === "missing") notFound.push(id);
    else if (typeof got === "object") {
      const rec = parseCveRecord(got.raw);
      if (rec) {
        records.set(rec.cve_id, { rec, raw: got.raw });
        fetched.push(id);
      }
    } else log(`cvelist: ${id} not read by id (${got}).`);
  });
  fetched.sort(compareCveIds);
  notFound.sort(compareCveIds);
  for (const [id, { raw }] of [...records.entries()].sort(([a], [b]) => compareCveIds(a, b))) cacheWrite(ctx, path.join(paths.recordsDir, `${id}.json`), jsonText(raw));
  const allRecords = [...records.values()].map((r) => r.rec).sort((a, b) => compareCveIds(a.cve_id, b.cve_id));

  // Step 7: drafts.
  const regions = regionsConfig(config);
  const itemCtx = { window, lookbackHours: run.pack.lookback_hours, keywords: config.sources.keywords, publishers: { sourceTiers: config.sourceTiers, vendors: config.vendors }, regions };
  const jpAlert = (config.regions.regions.find((r) => r.code === "JP")?.alert_patterns ?? []).map((p) => new RegExp(p, ALERT_PATTERN_FLAGS));
  const itemDrafts: ItemDraft[] = [];
  const recordDrafts: RecordDraft[] = [];
  // Items and records dropped for a link unfit to print outside the untrusted tags (§4.14): injection flags.
  const screen: LinkScreen = { dropped: 0 };
  for (const entry of byKind("rss")) {
    const r = rssReads.get(entry.id);
    if (!r?.ok || !r.data) continue;
    const asRecords = RSS_RECORD_FEEDS[entry.id];
    if (asRecords) {
      const notes = asRecords === "jpcert" ? jpcertRecords(r.data.items, jpAlert) : tvnRecords(r.data.items);
      recordDrafts.push(...notePackRecords(asRecords, notes, window, screen));
      continue;
    }
    const d = toItemDrafts(entry, r.data.items, itemCtx);
    itemDrafts.push(...d.drafts);
    screen.dropped += d.unsafeLinks;
    log(`${entry.id}: ${r.data.total} items, ${d.drafts.length} in the window${d.missedKeywords ? `, ${d.missedKeywords} without a keyword` : ""}${d.badUrl ? `, ${d.badUrl} with an unusable link or title` : ""}${d.unsafeLinks ? `, ${d.unsafeLinks} dropped for a malformed link (flagged)` : ""}.`);
  }
  const deduped = dedupe(itemDrafts);
  const capped = capItems(deduped.kept);
  for (const [id, n] of Object.entries(capped.cutByFeed)) log(`${id}: ${n} items over the caps.`);
  const items: PackItem[] = toPackItems(capped.kept);

  const e = (epss as Read<{ e: EpssDay | null; e1: EpssDay | null; e7: EpssDay | null }> | null)?.data ?? null;
  const aiMatch = o.deps?.aiMatch;
  const rankBase = {
    date: D, window, recordWindow: rw, catalog, newKevIds, records: allRecords, epss: { e: e?.e ?? null, e1: e?.e1 ?? null, e7: e?.e7 ?? null },
    ghsa: (ghsa as Read<{ advisories: GhsaAdvisory[] }> | null)?.data?.advisories ?? [], earlierReleaseIds: state.earlierReleaseIds,
    config: { loaded: config, compiled: config.compiled, watchWindows: activeWindows(config, D) }, kevSource: baseline?.source, ...(aiMatch ? { aiMatch } : {}),
  };
  const keep = recordKeepIds(rankBase);
  const cveFacts = (rec: CveRecord) => {
    const s = e?.e?.scores.get(rec.cve_id);
    return { epss: s?.epss ?? null, epss_percentile: s?.percentile ?? null };
  };
  if (catalog) recordDrafts.push(...kevPackRecords((catalog as KevCatalog).vulnerabilities, new Set(newKevIds), config.sourceTiers, screen));
  recordDrafts.push(...cvePackRecords(allRecords, (r) => keep.has(r.cve_id), config.sourceTiers, cveFacts, screen));
  if (e?.e) recordDrafts.push(...epssPackRecords(e.e7 ? epssMovers(e.e, e.e7) : [], e.e.score_date, epssJumps(e.e, e.e1), screen));
  recordDrafts.push(...ghsaPackRecords(rankBase.ghsa, window, screen));
  const jvn = myjvn as Awaited<ReturnType<typeof readMyJvn>> | null;
  if (jvn?.data) recordDrafts.push(...notePackRecords("myjvn", jvn.data.notes, window, screen));
  for (const r of exchangeReads.values()) if (r.data) recordDrafts.push(...exchangePackRecords(r.data.notices, window, screen));
  const dash = cvd as Awaited<ReturnType<typeof readCvd>> | null;
  const cvdEntry = byKind("anthropic-cvd")[0];
  if (dash?.data && cvdEntry) {
    const rec = cvdPackRecord(dash.data, state.cvdRevision, cvdEntry.url, screen);
    if (rec) recordDrafts.push(rec);
  }
  if (screen.dropped) log(`pack: ${screen.dropped} items and records dropped for a malformed link (counted as injection flags).`);
  const provisional = provisionalRecords(recordDrafts);

  // Step 8: rank on the provisional pack.
  const ranked = rankCandidates({ ...rankBase, pack: { items, records: provisional } });
  let kept = ranked.kept;

  // Step 9: phase C fills fields only (R45).
  const nvdEntry = byKind("nvd")[0];
  const lacking = kept.filter((c) => c.cve_ids.length === 1 && c.id.startsWith("cve-") && c.cvss === null);
  if (nvdEntry) {
    if (lacking.length) {
      const r = await readNvd(nvdEntry, ctx, window);
      if (r.data) {
        const scores = r.data.scores;
        kept = kept.map((c) => {
          const s = c.cvss === null && c.cve_ids.length === 1 ? scores.get(c.cve_ids[0]!) : undefined;
          return s ? { ...c, cvss: { score: s.score, version: s.version, scorer: "nvd" as const } } : c;
        });
      }
      outcomes.set(nvdEntry.id, outcomeOf(r, fetchedAt, { items: r.data?.total ?? 0 }));
    } else {
      outcomes.set(nvdEntry.id, { ...skippedOutcome(), notes: ["Skipped: every kept candidate has a CNA or CISA-ADP score."] });
    }
  }
  const epssEntry = byKind("epss")[0];
  let epssSource: "csv" | "api" = "csv";
  if (epssEntry && !e?.e) {
    const ids = [...new Set(kept.flatMap((c) => c.cve_ids))].sort(compareCveIds);
    const api = await readEpssApi(epssEntry, ctx, ids);
    if (api.size) epssSource = "api";
    kept = kept.map((c) => {
      const s = c.cve_ids.length === 1 ? api.get(c.cve_ids[0]!) : undefined;
      return s && !c.epss ? { ...c, epss: { score: s.epss, percentile: s.percentile, change_24h: null, date: s.date.slice(0, 10) } } : c;
    });
  }

  // Step 10: the record cap, final ids, rewritten pack_ids.
  const referenced = new Set(kept.flatMap((c) => [c.id, ...c.pack_ids]).filter((id) => /^r\d{4,}$/.test(id)));
  const capR = capRecords(provisional, referenced);
  if (capR.cut) log(`records: ${capR.cut} over the cap of 400.`);
  const remapped = remapIds(kept, ranked.cut, ranked.log, capR.idMap);
  kept = remapped.kept;

  // Step 11: feed states, the degraded rule, the pack.
  const kevEntry = byKind("kev")[0];
  const kr = kevRead as Read<KevCatalog> | null;
  if (kevEntry && kr) outcomes.set(kevEntry.id, outcomeOf(kr, fetchedAt, { newest: kr.data?.dateReleased ?? null, items: kr.data?.count ?? 0, version: kr.data?.catalogVersion ?? null }));
  const cveEntry = byKind("cvelist")[0];
  const dl = deltaLog as Read<{ newest: string | null; entries: unknown[] }> | null;
  if (cveEntry && dl) {
    const windowZips = plan.zips.filter((z) => z.utc_day >= utcDateOf(rw.start));
    const zipFail = windowZips.map((z) => zipReads.get(z.asset)).find((r) => r && !r.ok);
    const notes = windowZips.filter((z) => !zipReads.get(z.asset)?.ok).map((z) => `CVE List: ${z.asset} not read.`);
    const ok = dl.ok && !zipFail && windowZips.length > 0;
    // Zips that end before the record window does leave its last hours in no zip read: stale, with the hour.
    const staleNote = ok ? zipsShortNote(zipsReach(windowZips), rw) : null;
    if (staleNote) log(`cvelist: ${staleNote}`);
    outcomes.set(cveEntry.id, {
      ...outcomeOf(dl, fetchedAt), ok, error: ok ? null : dl.error ?? zipFail?.error ?? "network", newest: dl.data?.newest ?? null,
      items: dl.data?.entries.length ?? 0, version: hourlyTag, notes: notes.slice(0, 2), staleNote,
    });
  }
  if (epssEntry && epss) {
    const er = epss as Read<{ e: EpssDay | null; rows: number }>;
    outcomes.set(epssEntry.id, outcomeOf(er, fetchedAt, { newest: er.data?.e?.score_date ?? null, items: er.data?.rows ?? 0, version: er.data?.e?.model_version ?? null }));
  }
  const ghsaEntry = byKind("ghsa")[0];
  if (ghsaEntry && ghsa) {
    const gr = ghsa as Read<{ advisories: GhsaAdvisory[]; headDate: string; commit: string }>;
    outcomes.set(ghsaEntry.id, outcomeOf(gr, fetchedAt, { urlUsed: ghsaEntry.url, fetchedAt, newest: gr.data?.headDate ?? null, items: gr.data?.advisories.length ?? 0, version: gr.data?.commit ?? null }));
  }
  const myjvnEntry = byKind("myjvn")[0];
  if (myjvnEntry && jvn) outcomes.set(myjvnEntry.id, outcomeOf(jvn, fetchedAt, { newest: jvn.data?.newest ?? null, items: jvn.data?.notes.length ?? 0, notes: jvn.data?.note ? [jvn.data.note] : [] }));
  if (cvdEntry && dash) outcomes.set(cvdEntry.id, outcomeOf(dash, fetchedAt, { newest: dash.data?.as_of ?? null, items: dash.data?.ledger_ids.length ?? 0, version: dash.data?.revision ?? null }));
  for (const entry of byKind("exchange")) {
    const r = exchangeReads.get(entry.id);
    if (r) outcomes.set(entry.id, outcomeOf(r, fetchedAt, { newest: r.data?.newest ?? null, items: r.data?.notices.length ?? 0 }));
  }
  const keptByFeed: Record<string, number> = {};
  for (const it of items) keptByFeed[it.feed_id] = (keptByFeed[it.feed_id] ?? 0) + 1;
  for (const entry of byKind("rss")) {
    const r = rssReads.get(entry.id);
    if (r) outcomes.set(entry.id, outcomeOf(r, fetchedAt, { newest: r.data?.newest ?? null, items: r.data?.total ?? 0, kept: keptByFeed[entry.id] ?? 0 }));
  }
  const recordsBySource = new Map<string, number>();
  for (const r of capR.kept) recordsBySource.set(r.source, (recordsBySource.get(r.source) ?? 0) + 1);
  const recordCount = (entry: FetchedFeed): number => {
    if (entry.kind === "kev" || entry.kind === "cvelist" || entry.kind === "epss" || entry.kind === "ghsa" || entry.kind === "myjvn" || entry.kind === "anthropic-cvd") {
      return recordsBySource.get(entry.kind) ?? 0;
    }
    if (entry.kind === "exchange") return capR.kept.filter((r) => r.source === "exchange-tw" && exchangeReads.get(entry.id)?.data?.notices.some((n) => r.record_id.startsWith(`${n.company_code}-`))).length;
    if (RSS_RECORD_FEEDS[entry.id]) return recordsBySource.get(RSS_RECORD_FEEDS[entry.id]!) ?? 0;
    return 0;
  };
  const indexFeeds: FeedIndexEntry[] = config.sources.feeds.map((entry) => {
    if (entry.kind === "search") {
      return { id: entry.id, kind: entry.kind, status: "skipped", label: "SKIP", error_class: null, url_used: null, fallback_used: false, newest: null, items: 0, records: 0, version: null, sha256: null, fetched_at: null, note: null };
    }
    const out = outcomes.get(entry.id) ?? { ...emptyOutcome(), error: "network" as const, notes: ["Not read before the budget ran out."] };
    return indexEntry(entry, { ...out, records: out.skipped ? 0 : recordCount(entry) }, ref);
  });
  const index: FeedIndexFile = { schema_version: 1, date: D, generated_at: generatedAt, feeds: indexFeeds };
  const degraded = isDegraded(indexFeeds);

  const flaggedByKey = new Map<string, number>();
  for (const d of capped.kept) flaggedByKey.set(`i:${d.feed_id}:${d.url}`, d.flagged);
  for (const d of recordDrafts) flaggedByKey.set(`r:${d.source}:${d.record_id}`, d.flagged);
  const injectionFlags = screen.dropped + injectionCount(
    items.map((i) => ({ flagged: flaggedByKey.get(`i:${i.feed_id}:${i.url}`) ?? 0 })),
    capR.kept.map((r) => ({ flagged: flaggedByKey.get(`r:${r.source}:${r.record_id}`) ?? 0 })),
  );
  const built = buildPack({
    date: D, window, generatedAt, cutoff, degraded, feeds: packFeeds(indexFeeds, keptByFeed), items, records: capR.kept, injectionFlags,
  }, config.sources, { lookbackHours: run.pack.lookback_hours });
  if (built.sizeCut.items || built.sizeCut.records) log(`pack: the size caps cut ${built.sizeCut.items} items and ${built.sizeCut.records} records.`);
  const pack = built.pack;
  const inPack = new Set([...pack.items.map((i) => i.id), ...pack.records.map((r) => r.id)]);
  kept = kept.map((c) => ({ ...c, pack_ids: c.pack_ids.filter((id) => inPack.has(id)) }));

  const cut = remapped.cut;
  const byReason = { below_cap: 0, merged: 0, bundled: 0 };
  for (const c of cut) byReason[c.reason === "below_cap" ? "below_cap" : c.reason.startsWith("merged:") ? "merged" : "bundled"] += 1;
  const candidates: CandidatesFile = { schema_version: 1, date: D, kept, cut: { count: cut.length, by_reason: byReason } };
  const rankLog: RankLogEntry[] = remapped.log;
  const candidateLog = { schema_version: 1 as const, date: D, ranked: ranked.ranked, kept: kept.map((c) => c.id), cut, log: rankLog };

  const kevData = kr?.data ?? null;
  const er = epss as Read<{ e: EpssDay | null; files: { role: "e" | "e1" | "e7"; date: string; sha256: string }[] }> | null;
  const gr = ghsa as Read<{ advisories: GhsaAdvisory[]; headDate: string; commit: string; treeSha256: string; months: string[] }> | null;
  const inputs: CollectInputsFile = {
    schema_version: 1, date: D, data_cutoff_utc: cutoff, generated_at: generatedAt, run_utc_day: runUtcDay, record_window: rw,
    commits,
    cvelist: {
      zips: zipsRead,
      days: plan.days.map((d) => ({ date: d.date, zips: d.zips, ok: d.zips.every((a) => zipReads.get(a)?.ok === true) })),
      newest_hourly_tag: hourlyTag,
      delta_log_newest: newestOf(dl?.data?.newest ?? null) && /T/.test(newestOf(dl?.data?.newest ?? null)!) ? newestOf(dl!.data!.newest)! : null,
      by_id: { fetched, not_found: notFound, over_cap: 0 },
    },
    kev: kevData && kr ? {
      catalog_version: kevData.catalogVersion, date_released: newestOf(kevData.dateReleased) ?? `${kevData.dateReleased.slice(0, 10)}T00:00:00Z`,
      count: kevData.count, url_used: kr.urlUsed!, sha256: kr.sha256!, fallback_used: kr.fallbackUsed,
    } : null,
    epss: er?.data?.e ? { source: epssSource, model_version: er.data.e.model_version, files: er.data.files } : epssSource === "api" ? { source: "api", model_version: null, files: [] } : null,
    ghsa: gr?.data ? { commit: /^[0-9a-f]{40}$/.test(gr.data.commit) ? gr.data.commit : null, head_date: gr.data.headDate, months: gr.data.months, tree_sha256: gr.data.treeSha256, advisories: gr.data.advisories.length } : null,
    anthropic_cvd: dash?.data ? { revision: dash.data.revision, as_of: dash.data.as_of.slice(0, 10), sha256: dash.sha256!, fetched_at: fetchedAt, changed: dash.data.revision !== state.cvdRevision } : null,
  };
  const newKev = kept.filter((c) => c.reasons.includes("new KEV")).length;
  const summary = summaryLines({ pack, index, kept: kept.length, newKev });

  // Step 12: write, unless the deadline has passed; index.json and inputs.json last, so they exist only when
  // everything before them was written.
  const texts: [string, string][] = [
    [path.join(root, run.paths.packs, `${D}.json`), jsonText(pack, Pack)],
    [path.join(root, run.paths.packs, `${D}.md`), built.md],
    [path.join(root, run.paths.packs, `${D}.candidates.json`), jsonText(candidates, CandidatesFile)],
    [path.join(root, run.paths.logs, `${D}.candidates.json`), jsonText(candidateLog, CandidateLogFile)],
    [path.join(root, run.paths.logs, `${D}.collect.log`), `${[...lines, ...summary].join("\n")}\n`],
    [paths.feedIndex, jsonText(index, FeedIndexFile)],
    [paths.collectInputs, jsonText(inputs, CollectInputsFile)],
  ];
  if (now() >= o.deadline) throw new CollectTimeout();
  for (const [file, text] of texts) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return { pack, candidates, index, inputs, summary };
}

function activeWindows(config: LoadedConfig, date: string) {
  return config.watchWindows.windows.filter((w) => w.start <= date && date <= w.end);
}

// ── sources:check (§8.10) ────────────────────────────────────────────────────────────────────────

/** §8.10: every fetched registry entry (or `id`), no pack written; exit 1 when a priority-1 row is FAIL, NODATE or STALE. */
export async function checkFeeds(o: { id?: string; now?: number; root?: string; deps?: CollectOptions["deps"] }): Promise<{ rows: CheckRow[]; exitCode: 0 | 1 }> {
  fixtureGuard(process.env, false);
  const root = path.resolve(o.root ?? process.cwd());
  const config = loadConfig({ root });
  const clock = o.deps?.now ?? (o.now !== undefined ? () => o.now! : Date.now);
  const ref = o.now ?? clock();
  const fixtures = process.env.CT_FIXTURE_FEEDS ? path.resolve(process.env.CT_FIXTURE_FEEDS) : null;
  const git = o.deps?.git ?? (fixtures ? fixtureGit(fixtures) : liveGit(root));
  const paths = checkCachePaths(root);
  for (const d of [paths.feedsDir, paths.zipsDir, path.dirname(paths.epssFile("2026-01-01"))]) fs.mkdirSync(d, { recursive: true });
  const ctx: FeedCtx = {
    fetch: o.deps?.fetch ?? fetchFeed, budget: fetchBudget(BUDGET_MS), deadline: clock() + 5 * 60_000, now: clock, log: o.deps?.log ?? (() => {}), paths,
    sleep: o.deps?.sleep ?? (async () => {}),
  };
  const entries = config.sources.feeds.filter((f) => !o.id || f.id === o.id);
  if (o.id && !entries.length) throw new Error(`sources:check: no registry entry "${o.id}"`);
  const day = new Date(ref).toISOString().slice(0, 10);
  // Two waves as in collect (HEAVY_KINDS last), the rows put back in registry order.
  const heavyFirst = (e: (typeof entries)[number]) => e.kind !== "search" && HEAVY_KINDS.has(e.kind);
  const waves = await inTwoWaves(entries.filter((e) => !heavyFirst(e)), entries.filter(heavyFirst), async (entry): Promise<CheckRow> => {
    if (entry.kind === "search") return { id: entry.id, kind: entry.kind, status: "SKIP", items: 0, newest: null, fresh: "-", priority: entry.priority, error: null };
    let r: Read<unknown>;
    let newest: string | null = null;
    let items = 0;
    switch (entry.kind) {
      case "kev": { const k = await readKev(entry, ctx, { sha: null, minVersion: null }); r = k; newest = k.data?.dateReleased ?? null; items = k.data?.count ?? 0; break; }
      case "cvelist": { const k = await readDeltaLog(entry, ctx, null); r = k; newest = k.data?.newest ?? null; items = k.data?.entries.length ?? 0; break; }
      case "epss": { const k = await readEpss(entry, ctx, day); r = k; newest = k.data?.e?.score_date ?? null; items = k.data?.rows ?? 0; break; }
      case "ghsa": { const k = await readGhsa(ctx, git, ghsaMonths(addDays(day, -1))); r = k; newest = k.data?.headDate ?? null; items = k.data?.advisories.length ?? 0; break; }
      case "nvd": {
        // The window the morning run would read now: the Taipei edition date's pack window.
        const k = await readNvd(entry, ctx, packWindow(taipeiToday(new Date(ref)), config.run.pack));
        r = k; items = k.data?.total ?? 0; break;
      }
      case "myjvn": { const k = await readMyJvn(entry, ctx); r = k; newest = k.data?.newest ?? null; items = k.data?.totalRes ?? 0; break; }
      case "anthropic-cvd": { const k = await readCvd(entry, ctx); r = k; newest = k.data?.as_of ?? null; items = k.data?.ledger_ids.length ?? 0; break; }
      case "exchange": { const k = await readExchange(entry, ctx); r = k; newest = k.data?.newest ?? null; items = k.data?.notices.length ?? 0; break; }
      case "rss": { const k = await readRss(entry, ctx); r = k; newest = k.data?.newest ?? null; items = k.data?.total ?? 0; break; }
    }
    const out: FeedOutcome = { ...emptyOutcome(), ok: r.ok, error: r.ok ? null : r.error, triedFallback: r.triedFallback, fallbackUsed: r.fallbackUsed, newest, items };
    const s = feedState(entry.kind, out, entry, ref);
    return { id: entry.id, kind: entry.kind, status: s.label, items, newest: newestOf(newest), fresh: freshColumn(entry.kind, s.label, newest, ref), priority: entry.priority, error: s.state === "failed" ? r.error ?? "network" : null };
  });
  const byId = new Map(waves.map((row) => [row.id, row]));
  const rows = entries.map((e) => byId.get(e.id)!);
  const bad = rows.some((row) => row.priority === 1 && (row.status === "FAIL" || row.status === "NODATE" || row.status === "STALE"));
  return { rows, exitCode: bad ? 1 : 0 };
}

/** §8.10's table, tab-separated, then "N of M entries ok; K priority-1 problems." (M counts fetched entries). */
export function formatCheckTable(rows: readonly CheckRow[]): string {
  const head = ["id", "kind", "status", "items", "newest", "fresh", "priority", "error"].join("\t");
  const body = rows.map((r) => [r.id, r.kind, r.status, String(r.items), r.newest ?? "-", r.fresh, String(r.priority), r.error ?? "-"].join("\t"));
  const fetched = rows.filter((r) => r.status !== "SKIP");
  const okN = fetched.filter((r) => r.status === "OK").length;
  const p1 = rows.filter((r) => r.priority === 1 && (r.status === "FAIL" || r.status === "NODATE" || r.status === "STALE")).length;
  return `${[head, ...body, `${okN} of ${fetched.length} entries ok; ${p1} priority-1 problems.`].join("\n")}\n`;
}

// ── The command line ─────────────────────────────────────────────────────────────────────────────

/** A standalone `npm run collect` gets 5 minutes; daily.ts passes its own deadline (P3). */
const CLI_DEADLINE_MS = 5 * 60_000;
const USAGE = "Usage: tsx scripts/collect.ts [--date YYYY-MM-DD] [--check-feeds [--id ID] [--json]]";

export interface MainOptions {
  env?: NodeJS.ProcessEnv;
  io?: { out: (s: string) => void; err: (s: string) => void };
  /** The repo root (default the working directory). */
  root?: string;
}

/**
 * The CLI: 0 when the pack was written (degraded or not), 1 when it could not be, 2 for usage and for
 * CT_FIXTURE_FEEDS outside a test run. `--check-feeds` exits 1 when a priority-1 row is FAIL, NODATE or
 * STALE. Never calls process.exit.
 */
export async function main(argv: string[] = process.argv.slice(2), opts: MainOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const io = opts.io ?? { out: (s: string) => console.log(s), err: (s: string) => console.error(s) };
  const root = opts.root ?? process.cwd();
  let date: string | null = null;
  let check = false;
  let id: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--date") date = argv[++i] ?? "";
    else if (a === "--check-feeds") check = true;
    else if (a === "--id") id = argv[++i] ?? "";
    else if (a === "--json") json = true;
    else {
      io.err(`Unknown argument ${JSON.stringify(a)}. ${USAGE}`);
      return 2;
    }
  }
  if (date !== null && !isValidDate(date)) {
    io.err(`--date wants YYYY-MM-DD, got ${JSON.stringify(date)}. ${USAGE}`);
    return 2;
  }
  if (!check && (id !== undefined || json)) {
    io.err(`--id and --json go with --check-feeds. ${USAGE}`);
    return 2;
  }
  if (id === "") {
    io.err(`--id wants a registry id. ${USAGE}`);
    return 2;
  }
  try {
    fixtureGuard(env, false);
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
  if (check) {
    try {
      const r = await checkFeeds({ id, root });
      io.out(json ? jsonText(r.rows).trimEnd() : formatCheckTable(r.rows).trimEnd());
      return r.exitCode;
    } catch (e) {
      io.err((e as Error).message);
      return 2;
    }
  }
  try {
    const r = await collect({ date: date ?? taipeiToday(), deadline: Date.now() + CLI_DEADLINE_MS, root });
    for (const line of r.summary) io.out(line);
    return 0;
  } catch (e) {
    io.err(`collect: ${(e as Error).message}`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main().then((code) => { process.exitCode = code; });
