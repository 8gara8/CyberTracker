// The impure per-kind readers collect and sources:check share (SPEC §8.3): each builds its URLs from the
// registry or a fixed pattern, fetches through fetchFeed() under the run's budget and deadline, keeps the
// raw body in cache/feeds/, and parses it with lib/feeds/<kind>.ts. They never throw for a feed's sake:
// a failure comes back as an error class, and the raw message goes to the log only. A URL found inside
// feed content is data and is never fetched.

import fs from "node:fs";
import path from "node:path";
import { addDays } from "../../lib/dates";
import { CVD_PAYLOAD_PATH, cvdPayloadUrl, parseAnthropicCvd } from "../../lib/feeds/anthropic-cvd";
import { parseDeltaLog } from "../../lib/feeds/cvelist";
import { epssApiUrls, epssUrlFor, parseEpssApi, parseEpssCsv } from "../../lib/feeds/epss";
import { EXCHANGE_ENDPOINTS, parseExchange } from "../../lib/feeds/exchange";
import { parseGhsa } from "../../lib/feeds/ghsa";
import { cveRecordRawUrl, rawAtCommit, type ReleaseAsset } from "../../lib/feeds/github";
import { FEED_MAX_BYTES, FEED_TIMEOUTS, type FetchBudget, type FetchErrorClass, type fetchFeed, type FetchResult } from "../../lib/feeds/http";
import { parseKev } from "../../lib/feeds/kev";
import { myjvnPageUrls, parseMyJvn } from "../../lib/feeds/myjvn";
import { NVD_PAGE_SIZE, nvdUrls, parseNvdPage } from "../../lib/feeds/nvd";
import type { CachePaths } from "../../lib/feeds/cache";
import { parseRss } from "../../lib/feeds/rss";
import { FeedParseError, type CvdDashboard, type DeltaLogEntry, type EpssDay, type EpssScore, type ExchangeNotice, type GhsaAdvisory, type JvnNote, type KevCatalog, type RawItem } from "../../lib/feeds/types";
import { parseDeltaZip } from "../../lib/feeds/zip";
import { byCodeUnit } from "../../lib/ids";
import { sha256Hex } from "../../lib/json";
import type { FetchedFeed } from "../../lib/schema/registry";
import { ghsaMonthPaths, type GitSource } from "./git-source";

/** What every reader needs: the fetcher, the shared budget, the run's deadline, the clock, the log and the cache. */
export interface FeedCtx {
  fetch: typeof fetchFeed;
  budget: FetchBudget;
  /** Epoch ms; nothing starts and nothing is written past it. */
  deadline: number;
  now: () => number;
  log: (line: string) => void;
  paths: CachePaths;
  /** Waits between NVD pages (6 s live; tests and fixture runs pass a no-op). */
  sleep: (ms: number) => Promise<void>;
}

type Limit = keyof typeof FEED_TIMEOUTS;

/** A fetch under the budget (it starts at the first request) and the run's deadline; failures are logged with their raw detail. */
export async function get(ctx: FeedCtx, url: string, limit: Limit = "default", maxKey: keyof typeof FEED_MAX_BYTES = "default"): Promise<FetchResult> {
  ctx.budget.begin(ctx.now());
  const deadline = Math.min(ctx.budget.deadline(), ctx.deadline);
  const r = await ctx.fetch(url, { timeoutMs: FEED_TIMEOUTS[limit], maxBytes: FEED_MAX_BYTES[maxKey], deadline });
  if (!r.ok) ctx.log(`fetch failed: ${url} (${r.error}${r.status ? `, HTTP ${r.status}` : ""})${r.detail ? `: ${r.detail}` : ""}`);
  return r;
}

/**
 * Writes a cache file unless the deadline has passed (collect writes nothing after it), through a temporary
 * file renamed into place, so a partial write never takes the final name. It never throws: when the write
 * fails (a full disk), the line is logged and neither the partial file nor an earlier one stays under the
 * name, so nothing later reads bytes this run did not keep.
 */
export function cacheWrite(ctx: FeedCtx, file: string, data: string | Buffer): void {
  if (ctx.now() >= ctx.deadline) return;
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    ctx.log(`cache: could not write ${path.basename(file)}: ${(e as Error).message.slice(0, 300)}`);
    for (const f of [tmp, file]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // nothing more to do
      }
    }
  }
}

/** Removes a cache file unless the deadline has passed. */
function cacheRemove(ctx: FeedCtx, file: string): void {
  if (ctx.now() >= ctx.deadline) return;
  fs.rmSync(file, { force: true });
}

/** The error class of a parser throw: FeedParseError's own, anything else "parse". */
export function parseClass(e: unknown): FetchErrorClass {
  return e instanceof FeedParseError ? e.errorClass : "parse";
}

export interface Read<T> {
  ok: boolean;
  error: FetchErrorClass | null;
  urlUsed: string | null;
  triedFallback: boolean;
  fallbackUsed: boolean;
  sha256: string | null;
  data: T | null;
}

const failed = <T>(error: FetchErrorClass, urlUsed: string | null, triedFallback = false): Read<T> =>
  ({ ok: false, error, urlUsed, triedFallback, fallbackUsed: false, sha256: null, data: null });

/**
 * One URL, then the registry's fallback when the first fails to fetch, fails to parse or answers data
 * `accept` refuses (older than the run needs). `body` keeps a body in cache/ only once it is the one
 * returned: parsed and accepted. When every answer that parsed was refused, the read fails "schema" (the
 * body parsed, but what it holds breaks the run's rule) and `refused` gives the log line.
 */
async function withFallback<T>(
  ctx: FeedCtx,
  entry: FetchedFeed,
  first: string,
  parse: (body: Buffer, r: FetchResult) => T | Promise<T>,
  opts: {
    limit?: Limit; max?: keyof typeof FEED_MAX_BYTES; body?: (body: Buffer) => void;
    accept?: (data: T) => boolean; refused?: (data: T) => string;
  } = {},
): Promise<Read<T>> {
  const urls = [first, ...(entry.fallback_url ? [entry.fallback_url] : [])];
  let last: Read<T> = failed("network", first);
  let refused: { url: string; data: T } | null = null;
  for (const [i, url] of urls.entries()) {
    const r = await get(ctx, url, opts.limit, opts.max);
    if (!r.ok || !r.body) {
      last = failed(r.error ?? "network", url, i > 0);
      continue;
    }
    let data: T;
    try {
      data = await parse(r.body, r);
    } catch (e) {
      ctx.log(`${entry.id}: ${url} did not parse: ${(e as Error).message.slice(0, 300)}`);
      last = failed(parseClass(e), url, i > 0);
      continue;
    }
    if (opts.accept && !opts.accept(data)) {
      ctx.log(`${entry.id}: ${url} answered with older data${i + 1 < urls.length ? "; trying the fallback URL" : ""}.`);
      refused = { url, data };
      continue;
    }
    opts.body?.(r.body);
    return { ok: true, error: null, urlUsed: url, triedFallback: i > 0, fallbackUsed: i > 0, sha256: sha256Hex(r.body), data };
  }
  if (refused) {
    if (opts.refused) ctx.log(opts.refused(refused.data));
    return failed("schema", refused.url, urls.length > 1);
  }
  return { ...last, triedFallback: urls.length > 1 };
}

// ── KEV ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The KEV catalog: the mirror at `sha` (or as written), then the fallback when it fails or is older than
 * `minVersion` (the committed kev-index's catalog_version). A catalog older than the index is never an ok
 * read: when only older catalogs answer, the read fails "schema" with the line "KEV: only catalog X
 * answered, older than kev-index Y", and nothing is cached.
 */
export async function readKev(entry: FetchedFeed, ctx: FeedCtx, o: { sha: string | null; minVersion: string | null }): Promise<Read<KevCatalog>> {
  const first = o.sha ? rawAtCommit(entry.url, o.sha) : entry.url;
  return withFallback(ctx, entry, first, (b) => parseKev(b).catalog, {
    limit: "kev", max: "kev",
    body: (b) => cacheWrite(ctx, ctx.paths.feedBody(entry.id, "json"), b),
    accept: (c) => !o.minVersion || byCodeUnit(c.catalogVersion, o.minVersion) >= 0,
    refused: (c) => `KEV: only catalog ${c.catalogVersion} answered, older than kev-index ${o.minVersion}`,
  });
}

// ── CVE List ─────────────────────────────────────────────────────────────────────────────────────

export async function readDeltaLog(entry: FetchedFeed, ctx: FeedCtx, sha: string | null): Promise<Read<{ newest: string | null; entries: DeltaLogEntry[] }>> {
  const url = sha ? rawAtCommit(entry.url, sha) : entry.url;
  return withFallback(ctx, { ...entry, fallback_url: null }, url, (b) => {
    const p = parseDeltaLog(b);
    return { newest: p.newest, entries: p.entries };
  }, { limit: "deltaLog", max: "deltaLog", body: (b) => cacheWrite(ctx, ctx.paths.feedBody(entry.id, "deltaLog.json"), b) });
}

/**
 * One delta zip: the cached asset of the same name when present and it parses (assets are immutable per
 * tag), else fetched and kept. A cached file that no longer parses (a partial write) is removed and the
 * asset fetched once more.
 */
export async function readZip(ctx: FeedCtx, asset: ReleaseAsset): Promise<Read<{ raws: unknown[]; reused: boolean }>> {
  const file = ctx.paths.zip(asset.asset);
  const ok = (body: Buffer, raws: unknown[], reused: boolean): Read<{ raws: unknown[]; reused: boolean }> =>
    ({ ok: true, error: null, urlUsed: asset.url, triedFallback: false, fallbackUsed: false, sha256: sha256Hex(body), data: { raws, reused } });
  if (fs.existsSync(file)) {
    const cached = fs.readFileSync(file);
    try {
      return ok(cached, parseDeltaZip(cached).records, true);
    } catch (e) {
      ctx.log(`cvelist: the cached ${asset.asset} did not parse (${(e as Error).message.slice(0, 200)}); fetching it again.`);
      cacheRemove(ctx, file);
    }
  }
  const r = await get(ctx, asset.url, "zip", "zip");
  if (!r.ok || !r.body) return failed(r.error ?? "network", asset.url);
  try {
    const { records } = parseDeltaZip(r.body);
    cacheWrite(ctx, file, r.body);
    return ok(r.body, records, false);
  } catch (e) {
    ctx.log(`cvelist: ${asset.asset} did not parse: ${(e as Error).message.slice(0, 300)}`);
    return failed(parseClass(e), asset.url);
  }
}

/** One CVE record at a commit (or `main` when ls-remote failed): the raw JSON, "missing" on a 404 (not yet published), or an error class. */
export async function readCveById(ctx: FeedCtx, sha: string | null, cveId: string): Promise<{ raw: unknown } | "missing" | FetchErrorClass> {
  const pin = sha ?? "0".repeat(40);
  const url = sha ? cveRecordRawUrl(pin, cveId) : cveRecordRawUrl(pin, cveId).replace(`/${pin}/`, "/main/");
  const r = await get(ctx, url);
  if (r.status === 404) return "missing";
  if (!r.ok || !r.body) return r.error ?? "network";
  try {
    return { raw: JSON.parse(r.body.toString("utf8")) as unknown };
  } catch {
    return "parse";
  }
}

// ── EPSS ─────────────────────────────────────────────────────────────────────────────────────────

export interface EpssRead {
  e: EpssDay | null;
  e1: EpssDay | null;
  e7: EpssDay | null;
  files: { role: "e" | "e1" | "e7"; date: string; sha256: string }[];
  /** Rows on E. */
  rows: number;
}

/** One EPSS day: the cached file when present and it parses, else fetched and kept; a cached file that no longer parses is removed and fetched once more. */
async function epssFile(entry: FetchedFeed, ctx: FeedCtx, date: string): Promise<{ day: EpssDay; sha256: string; total: number; url: string } | FetchErrorClass> {
  const file = ctx.paths.epssFile(date);
  const url = epssUrlFor(entry.url, date);
  if (fs.existsSync(file)) {
    const cached = fs.readFileSync(file);
    try {
      const p = parseEpssCsv(cached);
      return { day: p.day, sha256: sha256Hex(cached), total: p.day.scores.size, url };
    } catch (e) {
      ctx.log(`epss: the cached ${date} file did not parse (${(e as Error).message.slice(0, 200)}); fetching it again.`);
      cacheRemove(ctx, file);
    }
  }
  const r = await get(ctx, url, "epss", "epss");
  if (!r.ok || !r.body) return r.error ?? "network";
  try {
    const p = parseEpssCsv(r.body);
    cacheWrite(ctx, file, r.body);
    return { day: p.day, sha256: sha256Hex(r.body), total: p.day.scores.size, url };
  } catch (e) {
    ctx.log(`epss: ${date} did not parse: ${(e as Error).message.slice(0, 300)}`);
    return parseClass(e);
  }
}

/** E is the run's UTC date T, else T − 1, else T − 2 (at most 3 tries); then E − 1 and E − 7. Cached files are reused by date. */
export async function readEpss(entry: FetchedFeed, ctx: FeedCtx, runUtcDay: string): Promise<Read<EpssRead>> {
  let lastError: FetchErrorClass = "network";
  for (let back = 0; back < 3; back++) {
    const date = addDays(runUtcDay, -back);
    const got = await epssFile(entry, ctx, date);
    if (typeof got === "string") {
      lastError = got;
      continue;
    }
    const files: EpssRead["files"] = [{ role: "e", date, sha256: got.sha256 }];
    const side = async (role: "e1" | "e7", days: number) => {
      const d = addDays(date, -days);
      const r = await epssFile(entry, ctx, d);
      if (typeof r === "string") return null;
      files.push({ role, date: d, sha256: r.sha256 });
      return r.day;
    };
    const e1 = await side("e1", 1);
    const e7 = await side("e7", 7);
    return { ok: true, error: null, urlUsed: got.url, triedFallback: false, fallbackUsed: false, sha256: got.sha256, data: { e: got.day, e1, e7, files, rows: got.total } };
  }
  return failed(lastError, epssUrlFor(entry.url, runUtcDay));
}

/** The FIRST API fallback for the kept candidates' CVE ids (batches of 100), when the CSV failed. */
export async function readEpssApi(entry: FetchedFeed, ctx: FeedCtx, cveIds: readonly string[]): Promise<Map<string, EpssScore & { date: string }>> {
  const out = new Map<string, EpssScore & { date: string }>();
  if (!entry.fallback_url || !cveIds.length) return out;
  for (const url of epssApiUrls(entry.fallback_url, cveIds)) {
    const r = await get(ctx, url, "epss", "epss");
    if (!r.ok || !r.body) continue;
    try {
      for (const [k, v] of parseEpssApi(r.body)) out.set(k, v);
    } catch (e) {
      ctx.log(`epss: the API answer did not parse: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  return out;
}

// ── GitHub advisories ────────────────────────────────────────────────────────────────────────────

export interface GhsaRead {
  advisories: GhsaAdvisory[];
  commit: string;
  headDate: string;
  treeSha256: string;
  months: string[];
}

/**
 * The sparse checkout of the months at `sha` (collect's ls-remote commit; null: the tip of main), then every
 * advisory JSON under them, parsed (unreadable files skipped and logged).
 */
export async function readGhsa(ctx: FeedCtx, git: GitSource, months: readonly string[], sha: string | null): Promise<Read<GhsaRead>> {
  ctx.budget.begin(ctx.now());
  const head = await git.syncGhsa(ctx.paths.ghsaDir, months, sha);
  if (!head) return failed("network", null);
  const advisories: GhsaAdvisory[] = [];
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => byCodeUnit(a.name, b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) {
        try {
          const g = parseGhsa(JSON.parse(fs.readFileSync(p, "utf8")));
          if (g) advisories.push(g);
        } catch {
          ctx.log(`ghsa: ${e.name} did not parse`);
        }
      }
    }
  };
  for (const rel of ghsaMonthPaths(months)) walk(path.join(ctx.paths.ghsaDir, rel));
  return { ok: true, error: null, urlUsed: null, triedFallback: false, fallbackUsed: false, sha256: head.treeSha256, data: { advisories, commit: head.commit, headDate: head.headDate, treeSha256: head.treeSha256, months: [...months] } };
}

// ── MyJVN, the dashboard, the exchanges ──────────────────────────────────────────────────────────

export interface MyJvnRead {
  notes: JvnNote[];
  newest: string | null;
  totalRes: number;
  /** "MyJVN: n of N read." when the page cap stopped the read. */
  note: string | null;
}

export async function readMyJvn(entry: FetchedFeed, ctx: FeedCtx): Promise<Read<MyJvnRead>> {
  const first = await withFallback(ctx, entry, entry.url, (b) => parseMyJvn(b), { limit: "myjvn", body: (b) => cacheWrite(ctx, ctx.paths.feedBody(entry.id, "p1.xml"), b) });
  if (!first.ok || !first.data) return { ...first, data: null };
  const p1 = first.data;
  const notes = [...p1.entries];
  let newest = p1.newest;
  const all = myjvnPageUrls(first.urlUsed!, p1.totalRes);
  const paged = new URL(first.urlUsed!).searchParams.has("startItem");
  const pages = all.slice(1);
  for (const [i, url] of pages.entries()) {
    const r = await get(ctx, url, "myjvn");
    if (!r.ok || !r.body) break;
    cacheWrite(ctx, ctx.paths.feedBody(entry.id, `p${i + 2}.xml`), r.body);
    try {
      const p = parseMyJvn(r.body);
      notes.push(...p.entries);
      if (p.newest && (!newest || p.newest > newest)) newest = p.newest;
    } catch (e) {
      ctx.log(`myjvn: page ${i + 2} did not parse: ${(e as Error).message.slice(0, 300)}`);
      break;
    }
  }
  // Only a paged query can fall short of totalRes; the RDF feed is one page by design.
  const note = paged && notes.length < p1.totalRes ? `MyJVN: ${notes.length} of ${p1.totalRes} read.` : null;
  return { ...first, data: { notes, newest, totalRes: p1.totalRes, note } };
}

/**
 * The dashboard page, then its payload (data/payload.json beside it) when it answers. When the payload is
 * not read, a payload an earlier run cached is removed, so the metrics never read it beside today's page.
 */
export async function readCvd(entry: FetchedFeed, ctx: FeedCtx): Promise<Read<CvdDashboard>> {
  const page = await get(ctx, entry.url);
  if (!page.ok || !page.body) return failed(page.error ?? "network", entry.url);
  cacheWrite(ctx, ctx.paths.feedBody(entry.id, "html"), page.body);
  const payloadUrl = cvdPayloadUrl(page.finalUrl || entry.url);
  const payloadFile = ctx.paths.feedBody(entry.id, "payload.json");
  const payload = await get(ctx, payloadUrl, "kev", "payload"); // about 6.4 MB on 2026-11-09, over the 5 MiB default
  const payloadBody = payload.ok && payload.body ? payload.body : null;
  if (payloadBody) cacheWrite(ctx, payloadFile, payloadBody);
  else {
    ctx.log(`anthropic-cvd: no payload at ${CVD_PAYLOAD_PATH}; reading the page alone.`);
    cacheRemove(ctx, payloadFile);
  }
  try {
    const d = parseAnthropicCvd(page.body, page.contentType, payloadBody);
    return { ok: true, error: null, urlUsed: entry.url, triedFallback: false, fallbackUsed: false, sha256: sha256Hex(payloadBody ?? page.body), data: d };
  } catch (e) {
    ctx.log(`anthropic-cvd: did not parse: ${(e as Error).message.slice(0, 300)}`);
    return failed(parseClass(e), entry.url);
  }
}

/** Which exchange endpoint a registry entry reads (its URL's host). */
export function exchangeEndpoint(entry: Pick<FetchedFeed, "url">): "twse" | "tpex" {
  return new URL(entry.url).hostname === new URL(EXCHANGE_ENDPOINTS.tpex).hostname ? "tpex" : "twse";
}

export async function readExchange(entry: FetchedFeed, ctx: FeedCtx): Promise<Read<{ notices: ExchangeNotice[]; newest: string | null }>> {
  return withFallback(ctx, entry, entry.url, (b) => {
    const p = parseExchange(b, exchangeEndpoint(entry));
    return { notices: p.entries, newest: p.newest };
  }, { body: (b) => cacheWrite(ctx, ctx.paths.feedBody(entry.id, "json"), b) });
}

// ── RSS and NVD ──────────────────────────────────────────────────────────────────────────────────

export async function readRss(entry: FetchedFeed, ctx: FeedCtx): Promise<Read<{ items: RawItem[]; newest: string | null; total: number }>> {
  return withFallback(ctx, entry, entry.url, async (b) => {
    const p = await parseRss(b, entry.date_zone);
    return { items: p.entries, newest: p.newest, total: p.total };
  }, { body: (b) => cacheWrite(ctx, ctx.paths.feedBody(entry.id, "xml"), b) });
}

/**
 * NIST's own scores for the window's published records: page 1, and page 2 (6 s later) only when page 1 says there are
 * more, each under NVD's own body cap (FEED_MAX_BYTES.nvd). A window past two pages is logged: its tail is not read.
 */
export async function readNvd(entry: FetchedFeed, ctx: FeedCtx, window: { start: string; end: string }): Promise<Read<{ total: number; scores: Map<string, { score: number; version: "4.0" | "3.1"; vector: string }> }>> {
  const urls = nvdUrls(entry.url, window);
  const [p1, p2] = urls;
  const one = async (url: string, n: number) => {
    const r = await get(ctx, url, "nvd", "nvd");
    if (!r.ok || !r.body) return r.error ?? "network";
    cacheWrite(ctx, ctx.paths.feedBody(entry.id, `p${n}.json`), r.body);
    try {
      return { page: parseNvdPage(r.body), sha256: sha256Hex(r.body) };
    } catch (e) {
      return parseClass(e);
    }
  };
  const first = await one(p1!, 1);
  if (typeof first === "string") return failed(first, p1!);
  const readable = urls.length * NVD_PAGE_SIZE;
  if (first.page.total > readable) {
    ctx.log(`nvd: ${first.page.total} records in the window, more than the ${readable} two pages hold; the last ${first.page.total - readable} were not read.`);
  }
  const scores = new Map(first.page.scores);
  if (first.page.total > first.page.scores.size && first.page.total > 2000) {
    await ctx.sleep(6_000);
    const second = await one(p2!, 2);
    if (typeof second !== "string") for (const [k, v] of second.page.scores) scores.set(k, v);
  }
  return { ok: true, error: null, urlUsed: p1!, triedFallback: false, fallbackUsed: false, sha256: first.sha256, data: { total: first.page.total, scores } };
}
