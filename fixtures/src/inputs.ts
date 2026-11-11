// Everything a valid draft is validated against (SPEC §4.12 "Fixtures and tests", §8.6): per edition, the
// agent context (§4.15), the run's evidence (§4.12 Evidence), the same-date metrics (§4.7), the source pack
// (§4.14) and the regions input (§5.11), plus the CVE records the drafts cite and the config with the
// SAMPLE claims (loadConfig({ overrides }), §4.11). Each export returns a fresh deep copy.

import fs from "node:fs";
import path from "node:path";
import { cveRecordDomains } from "../../lib/context";
import { loadConfig, matchCredit, matchVendor, type LoadedConfig } from "../../lib/config";
import { addDays, isMonday, isoWeekStart, newestCompleteWeek, windowEnding } from "../../lib/dates";
import { composeHeadline, gapTableDisplays, kevLines } from "../../lib/metrics/headline";
import { homeVendorKev } from "../../lib/metrics/home-vendors";
import { referenceWindowStats } from "../../lib/metrics/reference";
import { round4 } from "../../lib/metrics/stats";
import { collectSignals, previewRegions, regionsConfig, regionsPreviewRows } from "../../lib/regions";
import { finderNames } from "../../lib/rules/shared";
import { sanitize, wrapUntrusted } from "../../lib/sanitize";
import { AgentContext, type Candidate } from "../../lib/schema/context";
import type { DraftItem } from "../../lib/schema/item";
import { Metrics, type WindowStats } from "../../lib/schema/metrics";
import { Evidence } from "../../lib/schema/misc";
import { Pack, type PackFeed, type PackItem, type PackRecord } from "../../lib/schema/pack";
import type { FeedEntry } from "../../lib/schema/registry";
import type { Threshold } from "../../lib/schema/scoreboard";
import { publisherFor } from "../../lib/sources";
import { normalizeUrl } from "../../lib/urls";
import { RegionsInputFile, cveLookupFromDir, packDatesOf, regionsInputFile, type DraftInputs } from "../../lib/validate";
import { BANNED_WORDS } from "../../lib/vocab";
import { SOURCE_KEYS, editionDraft } from "./drafts";
import {
  EDITIONS, FIXTURES_DIR, KEV_DUE, KEV_ROWS, RECORD_IDS, REPO_ROOT, SOURCES, cveRecord, recordView, seenText,
  type EditionName, type EditionTimes, type SourceKey, type SourceSpec,
} from "./world";

// ── Config ───────────────────────────────────────────────────────────────────────────────────────

export const CLAIMS_FILE = path.join(FIXTURES_DIR, "config", "claims.json");
/** Where build.ts writes the CVE records; cveLookupFromDir() reads them. */
export const CVE_RECORDS_DIR = path.join(FIXTURES_DIR, "cvelist", "records");

let config: LoadedConfig | null = null;

/** config/ with the SAMPLE claims of fixtures/config/claims.json (SB-01, SB-02), read once. Treat it as read-only. */
export function fixtureConfig(): LoadedConfig {
  config ??= loadConfig({ root: REPO_ROOT, overrides: { claims: JSON.parse(fs.readFileSync(CLAIMS_FILE, "utf8")) } });
  return config;
}

const pubCfg = () => ({ sourceTiers: fixtureConfig().sourceTiers, vendors: fixtureConfig().vendors });

function feed(id: string): FeedEntry {
  const f = fixtureConfig().sources.feeds.find((x) => x.id === id);
  if (!f) throw new Error(`No registry feed ${id}`);
  return f;
}

/** The registry feeds collect fetches records from for every pack. */
const RECORD_FEEDS = ["kev", "cvelist"] as const;

/** CVE records each edition's pack holds (published or KEV-listed in its window); other cited records were fetched. */
const PACK_RECORDS: Readonly<Record<EditionName, readonly string[]>> = {
  weekday: ["CVE-2026-104935", "CVE-2026-96951", "CVE-2026-108917", "CVE-2026-110036"],
  monday: [],
  quiet: [],
};

/** Feed kept and cut counts on the morning, invented. */
const CUT: Readonly<Record<EditionName, { count: number; by_reason: Record<string, number> }>> = {
  weekday: { count: 31, by_reason: { below_score: 24, duplicate: 5, stale: 2 } },
  monday: { count: 18, by_reason: { below_score: 15, duplicate: 3 } },
  quiet: { count: 12, by_reason: { below_score: 12 } },
};

// ── Metrics ──────────────────────────────────────────────────────────────────────────────────────

/** Appendix D.3's window counts (tests/metrics.test.ts), re-dated to each edition's cutoff. */
const W26_COUNTS = {
  kev_added_n: 179, unjoined_n: 0, cohort_n: 157, old_listed_n: 22, at_disclosure_n: 58, at_disclosure_share: round4(58 / 157),
  at_disclosure_ci80: [0.3217, 0.4199] as [number, number], n_day_n: 62, after_disclosure_n: 99, after_disclosure_median_days: 17,
  after_disclosure_median_ci80: [13, 22] as [number, number], k7_n: 87, p7: 0.5541, p7_ci80: [0.503, 0.6042] as [number, number],
};
const W13_COUNTS = {
  kev_added_n: 107, unjoined_n: 0, cohort_n: 94, old_listed_n: 13, at_disclosure_n: 36, at_disclosure_share: 0.383,
  at_disclosure_ci80: [0.3213, 0.4487] as [number, number], n_day_n: 35, after_disclosure_n: 58, after_disclosure_median_days: 20.5,
  after_disclosure_median_ci80: [13, 30] as [number, number], k7_n: 53, p7: 0.5638, p7_ci80: [0.4977, 0.6277] as [number, number],
};

/** The 104 ISO-week Mondays ending at the newest complete week before the cutoff. */
function seriesWeeks(cutoff: string): string[] {
  const last = newestCompleteWeek(cutoff);
  return Array.from({ length: 104 }, (_, i) => addDays(last, -7 * (103 - i)));
}

/** An edition's metrics file from its times (fixtures/src/site.ts calls it for the site-content dates too). */
export function metricsFor(t: Pick<EditionTimes, "date" | "cutoff" | "metricsAt" | "kev" | "cveListRelease">): Metrics {
  const cfg = fixtureConfig();
  const cutoff = t.cutoff;
  const w26 = windowEnding(cutoff, 182);
  const w13 = windowEnding(cutoff, 91);
  const ok = { status: "ok" as const, as_of: cutoff, note: null };
  const weeks = seriesWeeks(cutoff);
  const zeros = weeks.map(() => 0);
  const nulls = weeks.map(() => null);
  const W26: WindowStats = { from: w26.from, to: w26.to, ...W26_COUNTS };
  const W13: WindowStats = { from: w13.from, to: w13.to, ...W13_COUNTS };
  const m: Metrics = {
    schema_version: 1, date: t.date, generated_at: t.metricsAt, data_cutoff_utc: cutoff, reconstructed: false,
    code_commit: "0".repeat(40),
    provenance: {
      kev_catalog_version: t.kev.version, kev_count: t.kev.count, kev_date_released: t.kev.released,
      cve_list_release: t.cveListRelease, cve_list_commit: "0".repeat(40), kev_data_commit: null,
      epss_model_version: "v2025.03.14", epss_date: cutoff, ghsa_source: "git", ghsa_commit: null,
      config_versions: {
        vendors: cfg.vendors.version, ai_finders: cfg.aiFinders.version, source_tiers: cfg.sourceTiers.version,
        regions: cfg.regions.version, actors: cfg.actors.version,
      },
      reference: { from: "2023-01-01", to: "2024-12-31" }, inputs_file: `metrics/inputs/${t.date}.json`, inputs_sha256: "0".repeat(64),
    },
    blocks: { flood: ok, window: ok, ai_credited: ok, fix_side: ok, kev: ok, home_vendors: ok },
    headline: { text: "x", second_line: "x", at_disclosure_direction: "no_clear_change", after_disclosure_direction: "no_clear_change", quoted: [] },
    flood: {
      from: w13.from, to: cutoff, n: 44944, kernel_n: 4804, ex_kernel_n: 40140, unscored_n: 3121,
      year_ago: { from: addDays(w13.from, -364), to: addDays(cutoff, -364), n: 12275, kernel_n: 1574, ex_kernel_n: 10701 },
      yoy_pct: 266.1, yoy_ex_kernel_pct: 275.1, reference: { w13_mean_n: 8561.1, w13_mean_ex_kernel_n: 8027.4 },
      vs_reference_pct: 425.0, vs_reference_ex_kernel_pct: 400.0, vs_reference_ratio: 5.2498, vs_reference_ex_kernel_ratio: 5.0004,
      last_week: { week_start: newestCompleteWeek(cutoff), n: 3426, kernel_n: 129, unscored_n: 106 },
    },
    window: { w26: W26, w13: W13, reference: referenceWindowStats(), reference_pace_26w: 70.21, volume_ratio: 2.2361, kev_pace_ratio: 1.9275 },
    ai_credited: {
      finders_version: cfg.aiFinders.version, from: w13.from, to: cutoff,
      // Appendix D.7's figures at finder list v2, matched on sanitised strings (§0.4 row 31).
      w13: { total: 502, by_family: { anthropic: 278, openai: 41, google: 1, other: 182 }, ex_anthropic: 224, ledger_only_anthropic: 0 },
      provisional_from: addDays(cutoff, -32),
      in_kev: { since: "2025-01-01", n: 0, entries: [] },
    },
    base_rate: {
      since: "2025-01-01", to_published: addDays(cutoff, -90), to: cutoff, follow_up_days: 90, ai_credited_n: 289, ai_credited_in_kev_n: 0,
      ai_rate: 0, all_n: 95725, all_in_kev_n: 281, all_rate: 0.0029, expected: 0.7329, ratio: null, ratio_ci80: null,
    },
    fix_side: { anthropic_cvd: null, ghsa_unfixed: null },
    kev: {
      catalog_version: t.kev.version, catalog_count: t.kev.count, date_released: t.kev.released,
      new_since_last_edition: { since_catalog_version: t.kev.since, cve_ids: [...t.kev.newIds] },
    },
    home_vendors: homeVendorKev(
      KEV_ROWS.map(([cve_id, date_added, vendor_project]) => ({ cve_id, date_added, vendor_project })),
      { vendors: cfg.vendors },
      cutoff,
    ),
    epss_movers: [],
    series: {
      weeks, live_from: isoWeekStart(t.date), flood_n13: zeros, flood_n13_kernel: zeros, flood_n13_year_ago: nulls,
      window_at_disclosure_share: nulls, window_at_disclosure_ci80: nulls, window_after_median: nulls, window_after_median_ci80: nulls,
      window_cohort_n: zeros, kev_recent_weekly: zeros, kev_weekly: zeros,
      ai_weekly: { anthropic: zeros, openai: zeros, google: zeros, other: zeros }, ai_ledger_only_weekly: zeros, data_only_weeks: [],
    },
  };
  m.headline = composeHeadline(m);
  return Metrics.parse(m);
}

const buildMetrics = (name: EditionName): Metrics => metricsFor(EDITIONS[name]);

// ── Pack ─────────────────────────────────────────────────────────────────────────────────────────

const CVE_RE = /\bCVE-\d{4}-\d{4,}\b/g;
const cveIdsIn = (text: string) => [...new Set(text.match(CVE_RE) ?? [])];

/** A Taipei (or any offset) timestamp in UTC: the pack stores published_at as UTC. */
const utc = (ts: string) => new Date(Date.parse(ts)).toISOString().replace(".000Z", "Z");

interface PackParts {
  pack: Pack;
  /** Source key → pack item or record id. */
  ids: Map<SourceKey, string>;
}

function buildPack(name: EditionName): PackParts {
  const t = EDITIONS[name];
  const keys = SOURCE_KEYS[name];
  const ids = new Map<SourceKey, string>();
  const items: PackItem[] = [];
  keys.forEach((key) => {
    const s: SourceSpec = SOURCES[key];
    if (!s.pack || !s.published_at) return;
    const f = feed(s.pack.feed_id);
    const info = publisherFor(s.url, s.source_type, pubCfg());
    const id = `p${String(items.length + 1).padStart(4, "0")}`;
    ids.set(key, id);
    const title = sanitize(s.title, { max: 200 });
    const snippet = sanitize(s.pack.snippet, { max: 300 });
    items.push({
      id, feed_id: f.id, outlet: s.outlet, publisher: info.publisher, tier: info.tier, language: f.language, region: f.region,
      coverage: [...f.coverage], title, snippet, url: normalizeUrl(s.url), published_at: utc(s.published_at),
      cve_ids: cveIdsIn(`${title} ${snippet}`), alert: false, flags: [], score: round4(90 - items.length * 4.5),
    });
  });
  const records: PackRecord[] = [];
  keys.forEach((key) => {
    const s: SourceSpec = SOURCES[key];
    if (!s.record || !PACK_RECORDS[name].includes(s.record)) return;
    const r = recordView(s.record);
    const id = `r${String(records.length + 1).padStart(4, "0")}`;
    ids.set(key, id);
    records.push({
      id, source: "cvelist", record_id: r.id, url: normalizeUrl(s.url), advisory_urls: [], title: sanitize(r.title, { max: 200 }),
      text: sanitize(r.text, { max: 1000 }), date: r.date, vendor: r.vendor, product: r.product, cve_ids: [r.id],
      facts: {
        cvss: r.cvss.score, cvss_version: r.cvss.version, cvss_scorer: r.cvss.scorer,
        ssvc_exploitation: r.ssvc?.exploitation ?? null, kev_date_added: r.kevAdded,
      },
      flags: [],
    });
  });
  const feedIds = [...RECORD_FEEDS, ...new Set(items.map((i) => i.feed_id))];
  const feeds: PackFeed[] = feedIds.map((id) => {
    const f = feed(id);
    const mine = items.filter((i) => i.feed_id === id);
    const listAt = /^cve_(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})Z$/.exec(t.cveListRelease);
    const recordNewest = id === "kev" ? t.kev.released : listAt ? `${listAt[1]}T${listAt[2]}:${listAt[3]}:00Z` : null;
    const newest = mine.map((i) => i.published_at).sort().at(-1) ?? recordNewest;
    const kept = id === "cvelist" ? records.length : mine.length;
    return { id, kind: f.kind, ok: true, stale: false, newest, items_total: kept + 6, items_kept: kept, error: null, sha256: null };
  });
  const pack: Pack = {
    schema_version: 1, date: t.date, window: { ...t.window }, generated_at: t.packAt, data_cutoff_utc: t.cutoff, degraded: false,
    feeds, items, records, injection_flags: 0,
  };
  return { pack: Pack.parse(pack), ids };
}

// ── Evidence ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Extra seen pages per edition, added after the cited sources: for the soft fixtures' snapshot texts
 * (SPEC §4.12 "S"), so a mutation can cite a page whose text lacks a number, name or quote. Each URL is
 * normalised and lands in urls, fetched, texts and seen_as ("fetched"); a null text is a page fetched with no
 * snapshot (a PDF, a blocked or paywalled page), so it stays out of texts (soft--SNAP_MISSING).
 */
export const STATE_MEDIA_PAGE = {
  url: "https://www.globaltimes.cn/ct-sample/taiwan-chip-phishing-claims",
  text: "SAMPLE article. Global Times says claims that a mainland group phished Taiwanese chip equipment makers are unproven and serve the island's push for more security subsidies.",
} as const;

export const EVIDENCE_EXTRAS: Readonly<Record<EditionName, readonly { url: string; text: string | null }[]>> = {
  weekday: [
    { url: "https://www.security-next.com/ct-sample/logistics-ransomware-claim.pdf", text: null },
    // PRC state media on the chip phishing story: invalid--SOURCE_STATE_LABEL cites it without the label.
    { url: STATE_MEDIA_PAGE.url, text: STATE_MEDIA_PAGE.text },
  ],
  monday: [],
  quiet: [],
};

function buildEvidence(name: EditionName): Evidence {
  const { pack } = parts(name);
  const urls: string[] = [];
  const texts: Record<string, string> = {};
  const seenAs: Record<string, "pack" | "fetched" | "search"> = {};
  const add = (url: string, text: string | null, how: "pack" | "fetched") => {
    const u = normalizeUrl(url);
    if (!urls.includes(u)) urls.push(u);
    if (text !== null) texts[u] ??= text;
    seenAs[u] ??= how;
  };
  for (const it of pack.items) add(it.url, `${it.title}\n${it.snippet}`, "pack");
  for (const r of pack.records) add(r.url, `${r.title}\n${r.text}`, "pack");
  const cited = SOURCE_KEYS[name].map((key) => normalizeUrl(SOURCES[key].url));
  // A deep read replaces a pack item's title and snippet with the fuller text the run read.
  for (const key of SOURCE_KEYS[name]) {
    const u = normalizeUrl(SOURCES[key].url);
    add(u, seenText(key), "fetched");
    texts[u] = seenText(key);
  }
  for (const x of EVIDENCE_EXTRAS[name]) add(x.url, x.text, "fetched");
  const extras = EVIDENCE_EXTRAS[name].map((x) => normalizeUrl(x.url));
  const fetched = [...new Set([...pack.records.map((r) => normalizeUrl(r.url)), ...cited, ...extras])];
  return Evidence.parse({ urls, fetched, texts, seen_as: seenAs });
}

// ── Regions input ────────────────────────────────────────────────────────────────────────────────

/** KEV rows as kev-index.json held them that morning: entries up to the catalog the run read. */
function kevIndexFor(name: EditionName) {
  const through = EDITIONS[name].kev.version.replace(/\./g, "-");
  return { entries: KEV_ROWS.filter((r) => r[1] <= through).map((r) => [...r] as typeof r) };
}

/**
 * The regions input. `firstSeen` is firstSeenBefore() over the editions before this one (PREVIOUS, the
 * stored briefs the context's recent_items list): each id's earliest edition date.
 */
function buildRegionsInput(name: EditionName): RegionsInputFile {
  const t = EDITIONS[name];
  const cfg = fixtureConfig();
  const kevIndex = kevIndexFor(name);
  const signals = collectSignals(parts(name).pack, null, kevIndex, regionsConfig(cfg), t.date);
  const firstSeen: Record<string, string> = {};
  for (const d of PREVIOUS[name].map((n) => editionDraft(n)).sort((a, b) => a.date.localeCompare(b.date))) {
    for (const it of d.items) if (!(it.id in firstSeen)) firstSeen[it.id] = d.date;
  }
  return RegionsInputFile.parse(regionsInputFile({ date: t.date, history: [], signals, kevIndex, config: regionsConfig(cfg), firstSeen }));
}

// ── Context ──────────────────────────────────────────────────────────────────────────────────────

const LABELS: Record<string, string> = {
  constant: "weeks in the window",
  "window.w26.at_disclosure_share": "share already exploited at disclosure, 26 weeks",
  "window.reference.at_disclosure_share": "share already exploited at disclosure, 2023–24",
  "window.w26.after_disclosure_median_days": "median days to listing for the rest, 26 weeks",
  "window.reference.after_disclosure_median_days": "median days to listing for the rest, 2023–24",
  "window.w26.cohort_n": "recently disclosed flaws on CISA's list, 26 weeks",
  "window.kev_pace_ratio": "KEV additions, pace vs 2023–24",
  "window.volume_ratio": "recently disclosed flaws listed, pace vs 2023–24",
  "flood.n": "new CVE records, 13 weeks",
  "flood.vs_reference_ratio": "new CVE records, pace vs 2023–24",
  "flood.vs_reference_ex_kernel_ratio": "new CVE records excluding the Linux kernel, pace vs 2023–24",
  "ai_credited.w13.total": "AI-credited records, 13 weeks",
  "ai_credited.w13.ex_anthropic": "AI-credited records excluding Anthropic, 13 weeks",
};

/** metrics.quotable: every number the headline quotes, then every Gap table display, then the Lens KEV counts. */
function quotable(m: Metrics): AgentContext["metrics"]["quotable"] {
  const out: AgentContext["metrics"]["quotable"] = [];
  const seen = new Set<string>();
  const add = (key: string, label: string, display: string) => {
    const k = `${key}\0${display}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ key, label, display, as_of: m.data_cutoff_utc });
  };
  for (const q of m.headline.quoted) add(q.path, LABELS[q.path] ?? q.path, q.display);
  if (m.window) for (const d of gapTableDisplays(m.window)) add(d.key, d.label, d.display);
  const lines = kevLines(m);
  for (const key of ["tw", "jp"] as const) {
    const word = key === "tw" ? "Taiwanese" : "Japanese";
    add(`home_vendors.${key}.d30_n`, `KEV additions for ${word} vendors, 30 days`, String(lines[key].d30_n));
    add(`home_vendors.${key}.d90_n`, `KEV additions for ${word} vendors, 90 days`, String(lines[key].d90_n));
  }
  return out;
}

function thresholdText(th: Threshold): string {
  if (th.kind === "event") return th.text;
  const bound = th.bound === "value" ? "value" : th.bound === "ci80_lo" ? "80% interval low" : "80% interval high";
  return `${bound} ${th.op} ${th.value}`;
}

/** One candidate per item with a source in the pack, in display order (lib/rank.ts builds the real ones, §5.12). */
function candidates(name: EditionName, items: readonly DraftItem[]): Candidate[] {
  const { pack, ids } = parts(name);
  const cfg = fixtureConfig();
  const draft = editionDraft(name);
  const keyOf = new Map(draft.sources.map((s, i) => [s.id, SOURCE_KEYS[name][i]!]));
  const out: Candidate[] = [];
  for (const it of items) {
    const keys = it.source_ids.map((id) => keyOf.get(id)!).filter((k) => ids.has(k));
    if (!keys.length) continue;
    const packIds = keys.map((k) => ids.get(k)!);
    const first = SOURCES[keys[0]!];
    const cve = it.cve_ids[0] ?? null;
    const rec = cve && RECORD_IDS.includes(cve) ? recordView(cve) : null;
    const vendor = rec ? matchVendor(cfg, { affectedVendors: [rec.vendor] }) : null;
    const kevRow = cve ? KEV_ROWS.find((r) => r[0] === cve && r[1] <= EDITIONS[name].kev.version.replace(/\./g, "-")) : undefined;
    const credit = rec?.credits.map((c) => matchCredit(c, cfg.compiled.aiFinders)).find((x) => x !== null) ?? null;
    const release = it.release_id ? { release_id: it.release_id, vendor: "Microsoft", total: 1384, critical: 60, exploited: 1, exploited_cve_ids: [...it.cve_ids] } : null;
    const rank = out.length + 1;
    const reasons = [
      ...(kevRow ? ["new KEV"] : []),
      ...(vendor?.country === "TW" ? ["TW vendor"] : []),
      ...(rec ? [`CVSS ${rec.cvss.score.toFixed(1)} (cna, ${rec.cvss.version})`] : []),
      ...(credit ? [`AI credit: ${credit.matched}`] : []),
      ...(release ? ["patch batch"] : []),
      ...(it.regions.includes("TW") ? ["Taiwan"] : []),
      ...(it.regions.includes("JP") ? ["Japan"] : []),
    ];
    out.push({
      rank, score: round4(100 - rank * 6.25), id: it.id, kind: it.kind, reasons: reasons.length ? reasons : ["newsroom report"],
      title: wrapUntrusted(packIds[0]!, sanitize(first.record ? recordView(first.record).title : first.title, { max: 200 })),
      cve_ids: [...it.cve_ids],
      vendor: vendor?.name ?? (release ? "Microsoft" : null),
      vendor_country: vendor?.country ?? (release ? "US" : null),
      product: rec?.product ?? null,
      cvss: rec ? { score: rec.cvss.score, version: rec.cvss.version, scorer: rec.cvss.scorer } : null,
      epss: null,
      kev: kevRow ? { date_added: kevRow[1], due_date: KEV_DUE[kevRow[0]] ?? addDays(kevRow[1], 21), ransomware: kevRow[6] } : null,
      ssvc: rec?.ssvc ? { ...rec.ssvc } : null,
      ai_credit_match: credit ? { family: credit.family, matched: credit.matched, field: "cna.credits", rule: credit.rule } : null,
      exploit_reference: false,
      release,
      record_url: rec ? normalizeUrl(SOURCES[keys.find((k) => SOURCES[k].record) ?? keys[0]!].url) : null,
      advisory_urls: [],
      pack_ids: packIds,
      deep_read: rank <= fixtureConfig().run.budgets.deep_read_max,
    });
  }
  return out;
}

/** The editions before each one, as the context's recent_items and yesterday see them. */
const PREVIOUS: Readonly<Record<EditionName, readonly EditionName[]>> = { quiet: [], monday: ["quiet"], weekday: ["monday", "quiet"] };

function buildContext(name: EditionName): AgentContext {
  const t = EDITIONS[name];
  const cfg = fixtureConfig();
  const metrics = editionMetrics(name);
  const draft = editionDraft(name);
  const b = cfg.run.budgets;
  const ri = editionRegionsInput(name);
  const regions = previewRegions({ date: ri.date, history: ri.history, signals: ri.signals, kevIndex: ri.kevIndex, config: regionsConfig(cfg) });
  const tiers = cfg.sourceTiers.publishers;
  const domains = (pred: (p: (typeof tiers)[number]) => boolean) => tiers.filter(pred).flatMap((p) => p.domains);
  const families = [...new Set(cfg.aiFinders.finders.map((f) => f.family))];
  const previous = PREVIOUS[name].map((n) => ({ name: n, draft: editionDraft(n) }));
  const yesterday = previous.find((p) => p.draft.date === addDays(t.date, -1)) ?? null;
  const lines = kevLines(metrics);

  const context: AgentContext = {
    date: t.date,
    window: { ...t.window },
    weekly: isMonday(t.date),
    deadline: t.deadline,
    data_cutoff_utc: t.cutoff,
    budgets: {
      max_items: b.items_max, typical_items: [b.typical_items[0], b.typical_items[1]], deep_reads: b.deep_read_max,
      page_fetches: b.web_fetches, words: { target: b.words_target, max: b.words_max },
    },
    candidates: candidates(name, draft.items),
    cut: { count: CUT[name].count, by_reason: { ...CUT[name].by_reason } },
    metrics: {
      gap_headline: metrics.headline.text,
      quotable: quotable(metrics),
      home_vendor_kev: { tw: { d30_n: lines.tw.d30_n, d90_n: lines.tw.d90_n }, jp: { d30_n: lines.jp.d30_n, d90_n: lines.jp.d90_n } },
      stale: [],
    },
    regions_preview: regionsPreviewRows(regions),
    standing_stories: cfg.standingStories.stories.map((s) => ({
      id: s.id, title: s.title, match_terms: [...s.match_terms], last_development: s.seed_last_development, last_item_id: null,
    })),
    watch_windows: cfg.watchWindows.windows
      .filter((w) => w.start <= t.date && t.date <= w.end)
      .map((w) => ({ id: w.id, title: w.title, start: w.start, end: w.end, search_terms: [...w.search_terms] })),
    watch_searches: cfg.sources.feeds.flatMap((f) => (f.kind === "search"
      ? [{ id: f.id, name: f.name, query: f.query, language: f.language, region: f.region }] : [])),
    recent_items: previous.flatMap(({ draft: d }) => d.items.map((it) => ({
      date: d.date, id: it.id, kind: it.kind, headline: it.headline, severity: it.severity,
      source_urls: it.source_ids.map((id) => d.sources.find((s) => s.id === id)!.url),
    }))),
    yesterday: yesterday
      ? { date: yesterday.draft.date, edition: "full", lead: yesterday.draft.lead.map((l) => l.text), item_ids: yesterday.draft.items.map((i) => i.id) }
      : null,
    scoreboard: cfg.claims.claims.map((c) => ({
      id: c.id, text: c.text, judged_by: c.judged_by, metric_path: c.metric_path, support: thresholdText(c.support),
      challenge: thresholdText(c.challenge), deadline: c.deadline, status: c.resolution?.status ?? "open", reading: null, reading_as_of: null,
    })),
    corrections: { flagged: [], reports: [] },
    config: {
      tiers: {
        t1: domains((p) => p.tier === 1),
        t2: domains((p) => p.tier === 2),
        not_sole_newsroom: domains((p) => !p.sole_newsroom_for_critical),
        state_labelled: domains((p) => p.state_label !== null),
        cve_record: cveRecordDomains(cfg.sourceTiers),
      },
      home_vendors: {
        tw: cfg.vendors.vendors.filter((v) => v.country === "TW").map((v) => v.name),
        jp: cfg.vendors.vendors.filter((v) => v.country === "JP").map((v) => v.name),
      },
      actors: cfg.actors.actors.map((a) => ({ name: a.name, aliases: a.aliases.map((x) => x.name), related_tracker: a.related_tracker })),
      ai_finders: families.map((family) => ({
        family, names: [...new Set(cfg.aiFinders.finders.filter((f) => f.family === family).flatMap((f) => finderNames(f)))],
      })),
      banned_words: [...BANNED_WORDS],
    },
    pack: { md: `packs/${t.date}.md`, json: `packs/${t.date}.json`, degraded: false, failed_feeds: [] },
  };
  return AgentContext.parse(context);
}

// ── Memo and exports ─────────────────────────────────────────────────────────────────────────────

const packCache = new Map<EditionName, PackParts>();
function parts(name: EditionName): PackParts {
  let p = packCache.get(name);
  if (!p) {
    p = buildPack(name);
    packCache.set(name, p);
  }
  return p;
}

function memo<T>(build: (name: EditionName) => T): (name: EditionName) => T {
  const cache = new Map<EditionName, T>();
  return (name) => {
    if (!cache.has(name)) cache.set(name, build(name));
    return structuredClone(cache.get(name)!);
  };
}

/** The same-date metrics file, content/metrics/D.json's shape. */
export const editionMetrics = memo(buildMetrics);
/** The morning's source pack, packs/D.json's shape. */
export const editionPack = memo((name) => parts(name).pack);
/** The run's evidence, logs/D.evidence.json's shape. */
export const editionEvidence = memo(buildEvidence);
/** The regions input, logs/D.regions-input.json's shape (RegionsInputFile). */
export const editionRegionsInput = memo(buildRegionsInput);
/** The agent context, logs/D.context.json's shape. */
export const editionContext = memo(buildContext);

export const weekdayContext = () => editionContext("weekday");
export const mondayContext = () => editionContext("monday");
export const quietContext = () => editionContext("quiet");
export const weekdayEvidence = () => editionEvidence("weekday");
export const mondayEvidence = () => editionEvidence("monday");
export const quietEvidence = () => editionEvidence("quiet");
export const weekdayMetrics = () => editionMetrics("weekday");
export const mondayMetrics = () => editionMetrics("monday");
export const quietMetrics = () => editionMetrics("quiet");
export const weekdayPack = () => editionPack("weekday");
export const mondayPack = () => editionPack("monday");
export const quietPack = () => editionPack("quiet");
export const weekdayRegionsInput = () => editionRegionsInput("weekday");
export const mondayRegionsInput = () => editionRegionsInput("monday");
export const quietRegionsInput = () => editionRegionsInput("quiet");

/** Every CVE record the drafts cite, by id, in CVE JSON 5 shape. */
export function cveRecords(): Record<string, unknown> {
  return Object.fromEntries(RECORD_IDS.map((id) => [id, cveRecord(id)]));
}

/**
 * What validateDraft() needs for an edition's draft (or a mutation of it), built from memory exactly as
 * scripts/validate.ts builds it from the fixture files: the CVE lookup reads fixtures/cvelist/records/,
 * so run `npm run fixtures:gen` first.
 */
export function draftInputs(name: EditionName): DraftInputs {
  const cfg = fixtureConfig();
  return {
    context: editionContext(name),
    evidence: editionEvidence(name),
    metrics: editionMetrics(name),
    config: cfg,
    cveList: cveLookupFromDir(CVE_RECORDS_DIR),
    regionsBase: { ...editionRegionsInput(name), config: regionsConfig(cfg) },
    packDates: packDatesOf(editionPack(name)),
    fileDate: null,
  };
}
