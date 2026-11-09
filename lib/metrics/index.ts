// computeMetrics() (SPEC §5.10): the metrics file, its inputs manifest and the updated state from the
// state files, collect's feeds and the history. Pure: no clock, file, network or randomness; scripts/metrics.ts
// reads everything and passes it in. Steps, in §5.10's order:
//   2. count the UTC days days.json lacks (at most 25, none after more than 25 missed days), update the
//      credits from the zips' records, recompute them after a list change, apply the dashboard ledger;
//   3. KEV: update the index (re-joining rows whose record appeared), join, the `kev` summary;
//   4. window, flood, ai_credited, base_rate, fix_side, home_vendors, epss_movers, series;
//   5. block statuses: "ok" when computed from today's complete inputs (as_of the cutoff), "stale" when
//      carrying the previous file's value (its as_of, today's reason as the note), "failed" (null) when
//      there is none;
//   6. the headline, then the inputs manifest and its hash.
// Inside a backfill build (`frozenState`, ruling R28) steps 2 and 3 change nothing: the built state is read
// as it is, no state file is returned, and `kev` and `flood.new_days` list no new ids.

import type { CompiledConfig, LoadedConfig } from "../config";
import { configVersions } from "../config";
import { dataCutoffFor, daysBetween, newestCompleteWeek, utcDateOf, windowEnding } from "../dates";
import { tagTime } from "../feeds/github";
import { epssMovers } from "../feeds/epss";
import { byCodeUnit } from "../ids";
import { jsonText, sha256Hex } from "../json";
import {
  InputsManifest as InputsManifestSchema, STATE_FILES, STATE_SCHEMAS,
  type DayRow, type InputsManifest, type KevIndexFile, type KevSummary, type Metrics, type MetricsBlock, type Provenance, type StateFiles,
} from "../schema/metrics";
import type { MetricsFeeds } from "../../scripts/lib/feed-cache";
import {
  aiCredited, aiFindersOf, aiManifestRows, AI_NOTES, applyLedger, baseRate, creditListStatus, GHSA_CREDIT_SOURCE, recomputeCredits,
  updateCredits, type CreditState, type LedgerInput,
} from "./ai-credit";
import { updateAnthropicCvd, fixSide } from "./fix-side";
import { countDay, dayIds, dayMap, DAYS_FROM, floodStats, missingDays, yearAgo } from "./flood";
import { composeHeadline } from "./headline";
import { homeVendorKev } from "./home-vendors";
import { indexEntries, indexFacts, kevSummary, updateKevIndex } from "./kev-index";
import { BLOCK_NOTES, catchUpLine as catchUpText, metricsFirstLine, type StatusEntry } from "./notes";
import { REFERENCE, REFERENCE_JOIN_SHA256 } from "./reference";
import { extendSeries, seriesSlice, seriesUpTo } from "./series";
import { gapWindow, joinKev, shareDirection, speedDirection, windowManifestRows, type JoinFacts } from "./window";

export interface MetricsInputs {
  date: string;
  generatedAt: string;
  codeCommit: string;
  reconstructed: boolean;
  /** Inside a backfill build (ruling R28): read the built state, count no days, re-join nothing, write no state. */
  frozenState: boolean;
  config: LoadedConfig;
  compiled: CompiledConfig;
  state: StateFiles;
  feeds: MetricsFeeds;
  history: {
    previous: Metrics | null;
    kevBaseline: Pick<KevIndexFile, "entries" | "catalog_version"> | null;
    dataOnlyDates: string[];
  };
}

export interface ComputeResult {
  metrics: Metrics;
  manifest: InputsManifest;
  /** The state files this run changed. */
  state: Partial<StateFiles>;
  log: string[];
  firstLine: string;
  catchUpLine: string | null;
}

/** More missed days than this and the morning run counts none (§8.4): the backfill's --catch-up fills them. */
export const CATCH_UP_DAYS = 25;
/** Placeholders for provenance fields no input and no earlier file can give (logged when used). */
const UNKNOWN_SHA = "0".repeat(40);
const UNKNOWN = "unavailable";

type BlockKey = keyof Metrics["blocks"];

const ok = (cutoff: string, note: string | null = null): MetricsBlock => ({ status: "ok", as_of: cutoff, note });

/**
 * The previous file's value for a block that cannot be computed today: "stale" with that file's as_of and
 * today's reason, or "failed" (null) when there is no earlier value.
 */
function carry<T>(prev: Metrics | null, key: BlockKey, value: T | null | undefined, note: string): { value: T | null; block: MetricsBlock } {
  if (!prev || value === null || value === undefined) return { value: null, block: { status: "failed", as_of: null, note } };
  return { value, block: { status: "stale", as_of: prev.blocks[key].as_of ?? prev.data_cutoff_utc, note } };
}

/** The newest date in days.json, or null for an empty file. */
function newestDay(rows: readonly DayRow[]): string | null {
  let out: string | null = null;
  for (const r of rows) if (out === null || r[0] > out) out = r[0];
  return out;
}

/** Publication dates the ledger can use: by-id and zip records, the KEV index and the stored credit rows. */
function publishedDates(feeds: MetricsFeeds, index: KevIndexFile, credits: CreditState): Map<string, string> {
  const out = new Map<string, string>();
  const put = (id: string, date: string | null) => {
    if (date !== null && !out.has(id)) out.set(id, date);
  };
  for (const [id, f] of feeds.cvelist.byId) if (f && f.state === "PUBLISHED") put(id, f.date_published);
  for (const f of feeds.cvelist.zipRecords) if (f.state === "PUBLISHED") put(f.cve_id, f.date_published);
  for (const r of index.entries) put(r[0], r[4]);
  for (const r of credits.candidates.candidates) put(r[0], r[1]);
  for (const r of credits.credits.matches) put(r[0], r[1]);
  return out;
}

/** The newest CVE List tag whose zip the run read (end-of-day tags end at the next day's 00:00 UTC). */
function newestZipTag(feeds: MetricsFeeds): string | null {
  let best: { tag: string; at: string } | null = null;
  for (const z of feeds.inputs.cvelist.zips) {
    const at = z.kind === "hourly" ? tagTime(z.tag) : `${z.utc_day}T24:00:00Z`;
    if (at === null) continue;
    if (!best || at > best.at || (at === best.at && byCodeUnit(z.tag, best.tag) > 0)) best = { tag: z.tag, at };
  }
  return best?.tag ?? feeds.inputs.cvelist.newest_hourly_tag;
}

function provenanceOf(i: MetricsInputs, index: KevIndexFile, log: string[]): Omit<Provenance, "inputs_sha256"> {
  const prev = i.history.previous?.provenance ?? null;
  const f = i.feeds;
  const pick = <T>(name: string, today: T | null | undefined, earlier: T | null | undefined, placeholder: T): T => {
    if (today !== null && today !== undefined) return today;
    if (earlier !== null && earlier !== undefined) return earlier;
    log.push(`Provenance: ${name} is unknown today and in every earlier file; written as a placeholder.`);
    return placeholder;
  };
  const catalog = f.kev.catalog;
  const kevFallback = f.inputs.kev?.fallback_used ?? false;
  return {
    kev_catalog_version: catalog?.catalogVersion ?? prev?.kev_catalog_version ?? index.catalog_version,
    kev_count: catalog?.count ?? prev?.kev_count ?? index.entries.length,
    kev_date_released: pick("kev_date_released", catalog?.dateReleased ?? f.inputs.kev?.date_released, prev?.kev_date_released, `${dataCutoffFor(i.date)}T00:00:00Z`),
    cve_list_release: pick("cve_list_release", newestZipTag(f), prev?.cve_list_release, UNKNOWN),
    cve_list_commit: pick("cve_list_commit", f.inputs.commits.cvelist, prev?.cve_list_commit, UNKNOWN_SHA),
    // null means the cisa.gov fallback; a mirror read whose commit ls-remote missed takes the earlier value or the placeholder (§0.4 row 41).
    kev_data_commit: catalog && !kevFallback ? pick("kev_data_commit", f.inputs.commits.kev_data, prev?.kev_data_commit, UNKNOWN_SHA) : catalog ? null : prev?.kev_data_commit ?? null,
    epss_model_version: pick("epss_model_version", f.epss.e?.model_version ?? f.inputs.epss?.model_version, prev?.epss_model_version, UNKNOWN),
    epss_date: pick("epss_date", f.epss.e ? utcDateOf(f.epss.e.score_date) : null, prev?.epss_date, dataCutoffFor(i.date)),
    ghsa_source: GHSA_CREDIT_SOURCE,
    ghsa_commit: f.inputs.commits.ghsa ?? f.inputs.ghsa?.commit ?? null,
    config_versions: configVersions(i.config),
    reference: { from: REFERENCE.from, to: REFERENCE.to },
    inputs_file: `metrics/inputs/${i.date}.json`,
  };
}

/** The inputs manifest's feed rows: every metrics feed read today (one with a body hash), sorted by id. */
function manifestFeeds(feeds: MetricsFeeds): InputsManifest["feeds"] {
  const reads = [feeds.kev.read, feeds.cvelist.read, feeds.epss.read, feeds.ghsa.read, feeds.anthropicCvd.read];
  return reads
    .filter((r) => r.sha256 !== null && r.status !== "failed" && r.status !== "skipped")
    .map((r) => ({ id: r.id, as_of: r.as_of, version: r.version, sha256: r.sha256!, records: r.records }))
    .sort((a, b) => byCodeUnit(a.id, b.id));
}

/** The text a state file is written as, for "did it change". */
const stateText = <K extends keyof StateFiles>(name: K, value: StateFiles[K]): string => jsonText(value, STATE_SCHEMAS[name]);

export function computeMetrics(i: MetricsInputs): ComputeResult {
  const cutoff = dataCutoffFor(i.date);
  const frozen = i.frozenState;
  const prev = i.history.previous;
  const feeds = i.feeds;
  const log: string[] = [];

  // ── Step 2: days and credits ───────────────────────────────────────────────────────────────────
  const daysFile = i.state["days.json"];
  const days = dayMap(daysFile.days);
  const newest = newestDay(daysFile.days);
  const catchUp = !frozen && (newest === null || daysBetween(newest, cutoff) > CATCH_UP_DAYS);
  const stopAt = newest ?? DAYS_FROM;
  const newDays: InputsManifest["flood"]["new_days"] = [];
  if (!frozen && !catchUp) {
    const reads = new Map(feeds.cvelist.days.map((d) => [d.date, d]));
    for (const d of missingDays(days, daysFile.days[0]?.[0] ?? DAYS_FROM, cutoff).slice(0, CATCH_UP_DAYS)) {
      const read = reads.get(d);
      if (!read?.ok) continue;
      days.set(d, countDay(d, read.records));
      newDays.push({ date: d, ids: dayIds(d, read.records) });
    }
    if (newDays.length) log.push(`Counted ${newDays.length === 1 ? "1 day" : `${newDays.length} days`}: ${newDays.map((d) => d.date).join(", ")}.`);
  }
  if (catchUp) log.push(catchUpText(stopAt));
  const dayRows = [...days.values()].sort((a, b) => byCodeUnit(a[0], b[0]));

  const run = aiFindersOf(i.config, i.compiled);
  let credits: CreditState = { candidates: i.state["credit-candidates.json"], credits: i.state["ai-credits.json"] };
  const listStatus = creditListStatus(credits, run);
  let cvd = i.state["anthropic-cvd.json"];
  let index = i.state["kev-index.json"];
  let aiNote: string | null = null;
  if (!frozen) {
    const a = feeds.anthropicCvd;
    if (a.dashboard && a.read.fetched_at) cvd = updateAnthropicCvd(cvd, a.dashboard, { fetchedAt: a.read.fetched_at, sourceUrl: a.sourceUrl }, cutoff);
    if (!catchUp && listStatus !== "prefilter_changed") {
      const ledger = (): LedgerInput => ({ cveIds: cvd.ledger_ids, published: publishedDates(feeds, index, credits) });
      if (listStatus === "recompute") {
        credits = recomputeCredits(credits, run, cutoff, ledger());
        aiNote = AI_NOTES.recomputed(run.version);
        log.push(aiNote);
      }
      const upd = updateCredits(credits, { records: feeds.cvelist.zipRecords, ghsa: [] }, run, cutoff);
      credits = upd.state;
      if (upd.changed.length) log.push(`Credit matches changed: ${upd.changed.join(", ")}.`);
      const led = applyLedger(credits.credits, ledger(), run, cutoff);
      credits = { ...credits, credits: led.credits };
      if (led.missing.length) log.push(`Ledger ids without a publication date: ${led.missing.join(", ")}.`);
    }
    if (listStatus === "prefilter_changed") log.push(AI_NOTES.prefilterChanged);
  }

  // ── Step 3: KEV ────────────────────────────────────────────────────────────────────────────────
  const catalog = feeds.kev.catalog;
  if (frozen && catalog && catalog.catalogVersion !== index.catalog_version) {
    throw new Error(`computeMetrics: the built kev-index.json is for catalog ${index.catalog_version} but the cached catalog is ${catalog.catalogVersion}`);
  }
  if (!frozen && catalog) {
    const fetched = new Map<string, JoinFacts | null>();
    for (const r of feeds.cvelist.zipRecords) fetched.set(r.cve_id, r);
    for (const [id, f] of feeds.cvelist.byId) if (f || !fetched.has(id)) fetched.set(id, f);
    const before = new Map(index.entries.map((r) => [r[0], r[4]]));
    index = updateKevIndex(index, catalog, fetched, cutoff);
    const rejoined = index.entries.filter((r) => r[4] !== null && before.has(r[0]) && before.get(r[0]) === null).map((r) => r[0]);
    if (rejoined.length) log.push(`Re-joined: ${rejoined.join(", ")}.`);
  }
  const rows = joinKev(indexEntries(index), indexFacts(index));
  const kevToday = catalog !== null;

  // ── Step 4 and 5: values and blocks ───────────────────────────────────────────────────────────
  const blocks = {} as Metrics["blocks"];

  // Window, KEV and home vendors: from today's catalog, else carried.
  let window: Metrics["window"];
  let directions: Pick<Metrics["headline"], "at_disclosure_direction" | "after_disclosure_direction">;
  let kev: KevSummary | null;
  let homeVendors: Metrics["home_vendors"];
  const hvToday = homeVendorKev(index.entries.map((r) => ({ cve_id: r[0], date_added: r[1], vendor_project: r[2] })), { vendors: i.config.vendors }, cutoff);
  if (kevToday) {
    const gw = gapWindow(rows, cutoff);
    window = gw.window;
    directions = { at_disclosure_direction: shareDirection(gw.window.w26), after_disclosure_direction: speedDirection(gw.window.w26, gw.w26AfterLags) };
    kev = kevSummary(catalog, i.history.kevBaseline);
    if (frozen) kev = { ...kev, new_since_last_edition: { ...kev.new_since_last_edition, cve_ids: [] } };
    homeVendors = hvToday;
    blocks.window = ok(cutoff);
    blocks.kev = ok(cutoff);
    blocks.home_vendors = ok(cutoff);
  } else {
    const w = carry(prev, "window", prev?.window, BLOCK_NOTES.kevNotRead);
    window = w.value;
    blocks.window = w.block;
    directions = w.value && prev
      ? { at_disclosure_direction: prev.headline.at_disclosure_direction, after_disclosure_direction: prev.headline.after_disclosure_direction }
      : { at_disclosure_direction: "n_too_small", after_disclosure_direction: "n_too_small" };
    const k = carry(prev, "kev", prev?.kev, BLOCK_NOTES.kevNotRead);
    kev = k.value ? { ...k.value, new_since_last_edition: { ...k.value.new_since_last_edition, cve_ids: [] } } : null;
    blocks.kev = k.block;
    const h = carry(prev, "home_vendors", prev?.home_vendors, BLOCK_NOTES.kevNotRead);
    homeVendors = h.value;
    blocks.home_vendors = h.block;
  }

  // Flood: complete from days.json, else carried.
  const fs = floodStats(days, cutoff);
  const w13 = windowEnding(cutoff, 91);
  const missingNow = missingDays(days, daysFile.days[0]?.[0] ?? DAYS_FROM, cutoff);
  const lateNote = catchUp ? BLOCK_NOTES.catchUp(stopAt) : BLOCK_NOTES.daysMissing(Math.max(1, missingNow.length), missingNow[0] ?? fs.missing[0] ?? cutoff);
  let flood: Metrics["flood"];
  if (fs.flood) {
    flood = fs.flood;
    blocks.flood = ok(cutoff);
  } else {
    const f = carry(prev, "flood", prev?.flood, lateNote);
    flood = f.value;
    blocks.flood = f.block;
  }

  // AI-credited and the base rate: ok when no day of w13 is still uncounted and the list is current.
  let ai: Metrics["ai_credited"];
  let base: Metrics["base_rate"];
  const aiComplete = !catchUp && listStatus !== "prefilter_changed" && missingDays(days, w13.from, w13.to).length === 0;
  if (aiComplete) {
    ai = aiCredited({ credits: credits.credits, kevIndex: index.entries, cutoff, findersVersion: run.version });
    base = baseRate({ credits: credits.credits, days: dayRows, kevIndex: index.entries, cutoff });
    blocks.ai_credited = ok(cutoff, aiNote);
  } else {
    const note = listStatus === "prefilter_changed" ? AI_NOTES.prefilterChanged : lateNote;
    const a = carry(prev, "ai_credited", prev?.ai_credited, note);
    ai = a.value;
    base = a.value ? prev?.base_rate ?? null : null;
    blocks.ai_credited = a.block;
  }

  // Fix side (ruling R13: fixSide() composes its own block).
  const fx = fixSide({
    cutoff, cvd,
    ghsa: { status: feeds.ghsa.read.status, advisories: feeds.ghsa.advisories, headDate: feeds.ghsa.headDate },
    previous: prev,
  });
  blocks.fix_side = fx.block;

  const epss = feeds.epss;
  const movers = epss.e && epss.e7 ? epssMovers(epss.e, epss.e7) : [];

  // Series: Flood frozen, Window, KEV and AI recomputed (R5, R18); a build reads its own.
  let seriesState = i.state["series.json"];
  if (!frozen) seriesState = extendSeries(seriesState, { days, rows, credits: credits.credits, dataOnlyDates: i.history.dataOnlyDates }, cutoff);
  const series = seriesSlice(seriesUpTo(seriesState, newestCompleteWeek(cutoff)));

  // ── Step 6: headline and manifest ──────────────────────────────────────────────────────────────
  const orderedBlocks: Metrics["blocks"] = {
    flood: blocks.flood, window: blocks.window, ai_credited: blocks.ai_credited, fix_side: blocks.fix_side, kev: blocks.kev, home_vendors: blocks.home_vendors,
  };
  const headline = composeHeadline({ date: i.date, blocks: orderedBlocks, window, flood, ai_credited: ai, headline: directions });

  const windowOk = orderedBlocks.window.status === "ok" && window !== null;
  const floodDays = (() => {
    const ya = yearAgo(w13);
    const pick = dayRows.filter((r) => (r[0] >= w13.from && r[0] <= w13.to) || (r[0] >= ya.from && r[0] <= ya.to));
    return pick.map((r) => ({ date: r[0], n: r[1], kernel_n: r[2], unscored_n: r[3], ids_sha256: r[4] }));
  })();
  const manifest: InputsManifest = {
    schema_version: 1,
    date: i.date,
    data_cutoff_utc: cutoff,
    generated_at: i.generatedAt,
    code_commit: i.codeCommit,
    feeds: manifestFeeds(feeds),
    window: {
      w26: windowOk ? windowManifestRows(rows, window!.w26.from, window!.w26.to) : [],
      w13: windowOk ? windowManifestRows(rows, window!.w13.from, window!.w13.to) : [],
      reference_sha256: REFERENCE_JOIN_SHA256,
    },
    kev_new: orderedBlocks.kev.status === "ok" && kev ? [...kev.new_since_last_edition.cve_ids] : [],
    flood: { days: floodDays, new_days: newDays },
    ai_credited: orderedBlocks.ai_credited.status === "ok" && ai ? aiManifestRows(credits.credits, ai) : [],
    home_vendors: orderedBlocks.home_vendors.status === "ok" && homeVendors
      ? { tw: homeVendors.tw.cve_ids_90, jp: homeVendors.jp.cve_ids_90 }
      : { tw: [], jp: [] },
  };
  const manifestText = jsonText(manifest, InputsManifestSchema);

  const metrics: Metrics = {
    schema_version: 1,
    date: i.date,
    generated_at: i.generatedAt,
    data_cutoff_utc: cutoff,
    reconstructed: i.reconstructed,
    code_commit: i.codeCommit,
    provenance: { ...provenanceOf(i, index, log), inputs_sha256: sha256Hex(manifestText) },
    blocks: orderedBlocks,
    headline,
    flood,
    window,
    ai_credited: ai,
    base_rate: base,
    fix_side: fx.fix_side,
    kev,
    home_vendors: homeVendors,
    epss_movers: movers,
    series,
  };

  // ── The state files this run changed ───────────────────────────────────────────────────────────
  const state: Partial<StateFiles> = {};
  if (!frozen) {
    const next: StateFiles = {
      "kev-index.json": index,
      "days.json": newDays.length ? { schema_version: 1, updated_at: cutoff, days: dayRows } : daysFile,
      "ai-credits.json": credits.credits,
      "credit-candidates.json": credits.candidates,
      "anthropic-cvd.json": cvd,
      "series.json": seriesState,
    };
    for (const name of STATE_FILES) {
      if (stateText(name, next[name] as never) !== stateText(name, i.state[name] as never)) (state as Record<string, unknown>)[name] = next[name];
    }
  }

  // ── The first stdout line ──────────────────────────────────────────────────────────────────────
  const entries: StatusEntry[] = (["window", "flood", "ai_credited", "fix_side", "kev", "home_vendors"] as const).map((k) => ({
    name: k, status: orderedBlocks[k].status, asOf: orderedBlocks[k].as_of,
  }));
  entries.push(epssEntry(feeds));

  return {
    metrics,
    manifest,
    state,
    log,
    firstLine: metricsFirstLine(i.date, cutoff, entries),
    catchUpLine: catchUp ? catchUpText(stopAt) : null,
  };
}

/** EPSS in the first line (§8.4): ok with today's and the 7-day-old scores; stale on the fallback or a stale file; else failed. */
function epssEntry(feeds: MetricsFeeds): StatusEntry {
  const { read, e, e7 } = feeds.epss;
  if (e && e7 && read.status === "ok") return { name: "epss", status: "ok", asOf: null };
  if (!e && (read.status === "failed" || read.status === "skipped")) return { name: "epss", status: "failed", asOf: null };
  const asOf = e ? utcDateOf(e.score_date) : read.as_of ? utcDateOf(read.as_of) : null;
  return { name: "epss", status: "stale", asOf };
}

