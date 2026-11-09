// Region levels (SPEC §5.11): collectSignals(), computeRegions() and previewRegions(). The US, Europe,
// Taiwan and Japan each get a daily level, baseline to critical, from the named rules in
// config/regions.json, never from item counts; Global shows only an item count. Pure: the edition date,
// items, history, signals, KEV lags and config all come in as parameters, and nothing here reads the
// clock, the machine's time zone, the network or a random source.

import { ALERT_PATTERN_FLAGS, matchVendor } from "./config";
import { addDays, daysBetween, isValidDate, taipeiDateOf } from "./dates";
import { severityAtLeast } from "./items";
import { sanitize } from "./sanitize";
import type { Item, RegionRaise } from "./schema";
import type { Brief, RegionRow, RegionSignal, Regions } from "./schema/brief";
import type { DraftSource, RegionCode, Source } from "./schema/common";
import type { RegionDef, RegionRule, RegionsFile, SourceTiersFile, VendorsFile } from "./schema/config";
import type { KevIndexFile } from "./schema/metrics";
import type { Pack } from "./schema/pack";
import { publisherFor } from "./sources";
import { jaccard } from "./text";
import { normalizeUrl } from "./urls";
import {
  COUNTRY_CODES, LEVELLED_REGIONS, REGION_LEVEL_INFO, REGION_LEVELS, REGION_SIGNAL_TYPES, type CountryCode, type LevelledRegion,
  type RegionLevel, type RegionRuleType,
} from "./vocab";

// ── Config and inputs ────────────────────────────────────────────────────────────────────────────

/** What the rules read (§5.11 `config`): regions.json, vendors.json and source-tiers.json as parsed. */
export interface RegionsConfig {
  regions: RegionsFile;
  vendors: VendorsFile;
  tiers: SourceTiersFile;
}

/** RegionsConfig from loadConfig()'s result (or any object with the three parsed files). */
export function regionsConfig(c: { regions: RegionsFile; vendors: VendorsFile; sourceTiers: SourceTiersFile }): RegionsConfig {
  return { regions: c.regions, vendors: c.vendors, tiers: c.sourceTiers };
}

/** A source as the rules read it: the brief's frozen publisher and tier, or publisherFor()'s for a draft source. */
export interface RegionSource {
  id: string;
  url: string;
  title: string;
  title_en: string | null;
  published_at: string | null;
  publisher: string;
  tier: 1 | 2 | 3;
}

/** An item as the rules read it: its own fields, `first_seen`, and every source its ids point at, resolved. */
export interface RegionItem {
  id: string;
  kind: Item["kind"];
  headline: string;
  severity: Item["severity"];
  regions: readonly Item["regions"][number][];
  incident: Pick<NonNullable<Item["incident"]>, "country" | "sector" | "status" | "disruption"> | null;
  flaw_evidence: readonly Pick<Item["flaw_evidence"][number], "cve_id" | "kind" | "basis" | "source_id">[];
  source_ids: readonly string[];
  first_seen: string;
  /** The brief's sources this item cites anywhere (source_ids, flaw evidence, incident status), by id. */
  sources: ReadonlyMap<string, RegionSource>;
}

/** The item fields regionItems() reads: a draft item with `first_seen` set, or a brief item. */
export type RegionItemInput = Pick<Item, "id" | "kind" | "headline" | "severity" | "regions" | "incident" | "flaw_evidence" | "source_ids" | "first_seen">;
/** A draft source (publisher and tier computed with publisherFor()) or a brief source (frozen fields used). */
export type RegionSourceInput = DraftSource | Source;

/**
 * Resolves items for the rules: each item with the sources it cites. A brief's sources carry their frozen
 * `publisher` and `tier`; a draft's get publisherFor()'s, from the config passed in.
 */
export function regionItems(items: readonly RegionItemInput[], sources: readonly RegionSourceInput[], config: RegionsConfig): RegionItem[] {
  const byId = new Map<string, RegionSource>();
  for (const s of sources) {
    const frozen = "publisher" in s && "tier" in s ? { publisher: s.publisher, tier: s.tier } : null;
    const info = frozen ?? publisherFor(s.url, s.source_type, { sourceTiers: config.tiers, vendors: config.vendors });
    byId.set(s.id, { id: s.id, url: s.url, title: s.title, title_en: s.title_en, published_at: s.published_at, publisher: info.publisher, tier: info.tier });
  }
  return items.map((it) => {
    const ids = [...it.source_ids, ...it.flaw_evidence.map((f) => f.source_id), ...(it.incident?.status_source_ids ?? [])];
    const own = new Map<string, RegionSource>();
    for (const id of ids) {
      const s = byId.get(id);
      if (s && !own.has(id)) own.set(id, s);
    }
    return {
      id: it.id,
      kind: it.kind,
      headline: it.headline,
      severity: it.severity,
      regions: it.regions,
      incident: it.incident ? { country: it.incident.country, sector: it.incident.sector, status: it.incident.status, disruption: it.incident.disruption } : null,
      flaw_evidence: it.flaw_evidence.map((f) => ({ cve_id: f.cve_id, kind: f.kind, basis: f.basis, source_id: f.source_id })),
      source_ids: it.source_ids,
      first_seen: it.first_seen,
      sources: own,
    };
  });
}

/** A brief the rules read for history: its date, items, sources and regions (§5.11 `history`). */
export type HistoryBrief = Pick<Brief, "date" | "items" | "sources" | "regions">;
/** The draft's `region_raises` entry the evaluation applies. */
export type RaiseInput = Pick<RegionRaise, "region" | "reason" | "trigger_class" | "item_ids">;

/**
 * §5.11's RegionsInput. `items`: today's items with `first_seen` set, resolved with regionItems() (the
 * draft's for the validator, the brief's for publish, [] for the preview). `history`: the briefs dated
 * date − N_max to date − 1 that exist, any edition. `signals`: collectSignals() for today. `kevIndex`:
 * the lags for home_vendor_kev. `raises`: the draft's `region_raises` ([] for data-only and the preview).
 */
export interface RegionsInput {
  date: string;
  items: readonly RegionItem[];
  history: readonly HistoryBrief[];
  signals: readonly RegionSignal[];
  kevIndex: Pick<KevIndexFile, "entries">;
  config: RegionsConfig;
  raises: readonly RaiseInput[];
}

// ── Levels ───────────────────────────────────────────────────────────────────────────────────────

/** A level's rank (REGION_LEVEL_INFO): baseline 1 to critical 4. */
export function levelRank(level: RegionLevel): number {
  return REGION_LEVEL_INFO[level].rank;
}

/** One level up, critical staying critical. */
export function stepUp(level: RegionLevel): RegionLevel {
  const i = REGION_LEVELS.indexOf(level);
  return REGION_LEVELS[Math.min(i + 1, REGION_LEVELS.length - 1)]!;
}

/** A rule's lookback in whole days: lookback_hours / 24. */
export function lookbackDays(rule: Pick<RegionRule, "params">): number {
  return Math.floor(rule.params.lookback_hours / 24);
}

/** N_max: the longest rule lookback in days (7 in the seed). */
export function maxLookbackDays(regions: Pick<RegionsFile, "rules">): number {
  return regions.rules.reduce((m, r) => Math.max(m, lookbackDays(r)), 0);
}

/** "Baseline means no rule fired" (BASELINE_TOOLTIP explains it on the page). */
export const BASELINE_REASON = "No rule fired.";

// ── Signals ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The Japanese half of CERT_EXPLOITATION_RE: 悪用 or 攻撃, then within the same sentence (at most 40
 * characters, no 。！？ or line break) the first 確認 after it in an affirmative form: 確認されています,
 * 確認されており, 確認しています, 確認しており, 確認されました, 確認しました, 確認された or 確認した. Kobol's
 * read of 2026-11-09 (V12) found bare 悪用 matching conditional boilerplate (容易に悪用可能, 悪用が困難,
 * 悪用された場合, 悪用されると), so neither word counts alone. A negative or conditional ending never counts:
 * 確認されていません, 確認していない and 確認してください have no affirmative form, and the lookahead refuses
 * 確認しておりません, 確認された場合, 確認したら, 確認した上で and the like. The gap may not hold 確認 itself, so
 * "悪用は確認されていませんが、修正を確認しました" does not match on the second 確認. Nor may it hold a negated
 * clause (ない, 無い, なかった or 無かった, then こと or の), so "悪用されていないことを確認しています" (no
 * exploitation confirmed) does not match.
 */
const JA_EXPLOITATION =
  "(?:悪用|攻撃)(?:(?!確認|(?:ない|無い|なかった|無かった)(?:こと|の))[^。！？!?\\r\\n]){0,40}確認(?:されています|されており|しています|しており|されました|しました|された|した)" +
  "(?!ません|ず|場合|ら|い|か|時|とき|際|上)";

/**
 * A national CERT reporting exploitation (§5.11), case-insensitive: English "exploited in the wild",
 * "actively exploited", "being exploited", "exploitation has been observed"; Japanese 悪用 or 攻撃 confirmed
 * in an affirmative form (JA_EXPLOITATION above); Chinese 遭利用, 已被利用 and 攻擊活動.
 */
export const CERT_EXPLOITATION_RE = new RegExp(
  `exploited\\s+in\\s+the\\s+wild|actively\\s+exploited|being\\s+exploited|exploitation\\s+has\\s+been\\s+observed|${JA_EXPLOITATION}|遭利用|已被利用|攻擊活動`,
  "iu",
);

/** The KEV signals' publisher id (§5.11). */
export const KEV_PUBLISHER = "cisa-kev";

/** One CISA KEV catalog entry, the fields collectSignals() reads (the catalog's own key names). */
export interface KevCatalogEntry {
  cveID: string;
  vendorProject: string;
  product: string;
  vulnerabilityName: string;
  dateAdded: string;
}

/** The record page a KEV signal links to: the CVE record, as data-only items cite it (§4.5). */
export function kevSignalUrl(cveId: string): string {
  return `https://www.cve.org/CVERecord?id=${cveId}`;
}

const alertCache = new WeakMap<RegionsFile, Map<LevelledRegion, RegExp[]>>();

/** regions.json `alert_patterns`, compiled once per parsed file with flags "iu" (§4.11; the CONFIG_REGEX check's flags). */
function alertPatterns(regions: RegionsFile): Map<LevelledRegion, RegExp[]> {
  let m = alertCache.get(regions);
  if (!m) {
    m = new Map(regions.regions.map((r) => [r.code, r.alert_patterns.map((p) => new RegExp(p, ALERT_PATTERN_FLAGS))]));
    alertCache.set(regions, m);
  }
  return m;
}

/** True when the URL's normalised form matches one of the region's alert patterns. */
function isAlertUrl(config: RegionsConfig, code: LevelledRegion, url: string): boolean {
  const res = alertPatterns(config.regions).get(code) ?? [];
  const norm = normalizeUrl(url);
  return res.some((re) => re.test(norm));
}

/**
 * The regions whose agencies include `publisher` and whose alert_patterns match `url`'s normalised form
 * (§5.11), in regions.json order: what collect's PackItem.alert and JPCERT records' facts.alert are built
 * from, and what collectSignals() reads for items and records alike (ruling R36). A newsroom quoting an
 * alert page is not an agency, so its items never count.
 */
export function alertRegions(url: string, publisher: string, config: RegionsConfig): RegionCode[] {
  return config.regions.regions.filter((r) => r.agencies.includes(publisher) && isAlertUrl(config, r.code, url)).map((r) => r.code);
}

/** A source or signal date as a Taipei calendar date: a timestamp converted, a bare date as written. */
function taipeiDay(value: string): string | null {
  if (isValidDate(value)) return value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : taipeiDateOf(value);
}

function signalTitle(text: string, fallback: string): string {
  const t = sanitize(text, { max: 200 });
  return t || sanitize(fallback, { max: 200 }) || fallback.slice(0, 200);
}

type SignalDraft = Omit<RegionSignal, "id">;

/** Signal ids order: by edition date, then counter (sig-20261101-3 before sig-20261108-1). */
export function compareSignalIds(a: string, b: string): number {
  const pa = /^sig-(\d{8})-(\d+)$/.exec(a);
  const pb = /^sig-(\d{8})-(\d+)$/.exec(b);
  if (pa && pb) {
    if (pa[1] !== pb[1]) return pa[1]! < pb[1]! ? -1 : 1;
    return Number(pa[2]) - Number(pb[2]);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Today's region signals (§5.11), dated in [date − N_max, date]:
 * - `agency_alert`: every pack item or record whose publisher (an item's as collect stamped it, a
 *   record's from publisherFor() on its URL) is in a region's `agencies` and whose normalised URL matches
 *   one of that region's `alert_patterns` (alertRegions(), ruling R36: JPCERT /at/ notes are records);
 *   Taipei date of the item's `published_at` or the record's `date`.
 * - `home_vendor_kev`: every KEV entry with `dateAdded` in the span whose matchVendor() country is a
 *   region's `home_vendor_country`, all lags (the rule filters by lag); `dateAdded` (US date). Read from
 *   the catalog, or from kev-index.json when the catalog is null.
 * - `cert_exploitation`: every pack record or item whose publisherFor() publisher is in a region's `certs`
 *   and whose sanitised title or text matches CERT_EXPLOITATION_RE; Taipei date of the record's date.
 * Ids are `sig-YYYYMMDD-N`: the edition date, then a counter in that type order, then by date, URL and
 * region. Titles are sanitised, at most 200 characters.
 */
export function collectSignals(
  pack: Pick<Pack, "items" | "records"> | null,
  kevCatalog: { vulnerabilities: readonly KevCatalogEntry[] } | null,
  kevIndex: Pick<KevIndexFile, "entries"> | null,
  config: RegionsConfig,
  date: string,
): RegionSignal[] {
  const from = addDays(date, -maxLookbackDays(config.regions));
  const inSpan = (d: string | null): d is string => d !== null && d >= from && d <= date;
  const byType: Record<RegionSignal["type"], SignalDraft[]> = { agency_alert: [], home_vendor_kev: [], cert_exploitation: [] };
  const pubCfg = { sourceTiers: config.tiers, vendors: config.vendors };

  for (const it of pack?.items ?? []) {
    const d = taipeiDay(it.published_at);
    if (!inSpan(d)) continue;
    const alerts = alertRegions(it.url, it.publisher, config);
    for (const r of config.regions.regions) {
      const base = { region: r.code, date: d, publisher: it.publisher, url: normalizeUrl(it.url), title: signalTitle(it.title, it.outlet), cve_ids: [...it.cve_ids] };
      if (alerts.includes(r.code)) byType.agency_alert.push({ type: "agency_alert", ...base });
      if (r.certs.includes(it.publisher) && CERT_EXPLOITATION_RE.test(sanitize(`${it.title} ${it.snippet}`))) {
        byType.cert_exploitation.push({ type: "cert_exploitation", ...base });
      }
    }
  }
  for (const rec of pack?.records ?? []) {
    const d = taipeiDay(rec.date);
    if (!inSpan(d)) continue;
    const publisher = publisherFor(rec.url, "government", pubCfg).publisher;
    const alerts = alertRegions(rec.url, publisher, config);
    const exploited = CERT_EXPLOITATION_RE.test(sanitize(`${rec.title} ${rec.text}`));
    for (const r of config.regions.regions) {
      const base = { region: r.code, date: d, publisher, url: normalizeUrl(rec.url), title: signalTitle(rec.title, rec.record_id), cve_ids: [...rec.cve_ids] };
      if (alerts.includes(r.code)) byType.agency_alert.push({ type: "agency_alert", ...base });
      if (exploited && r.certs.includes(publisher)) byType.cert_exploitation.push({ type: "cert_exploitation", ...base });
    }
  }

  const kevRows: { cve: string; added: string; vendorProject: string; title: string }[] = kevCatalog
    ? kevCatalog.vulnerabilities.map((v) => ({ cve: v.cveID, added: v.dateAdded, vendorProject: v.vendorProject, title: v.vulnerabilityName }))
    : (kevIndex?.entries ?? []).map(([cve, added, vendorProject, product]) => ({ cve, added, vendorProject, title: `${vendorProject} ${product}` }));
  for (const k of kevRows) {
    if (!inSpan(k.added)) continue;
    const vendor = matchVendor(config, { kevVendorProject: k.vendorProject });
    if (!vendor?.country) continue;
    for (const r of config.regions.regions) {
      if (r.home_vendor_country !== vendor.country) continue;
      byType.home_vendor_kev.push({
        type: "home_vendor_kev", region: r.code, date: k.added, publisher: KEV_PUBLISHER, url: kevSignalUrl(k.cve),
        title: signalTitle(k.title, k.cve), cve_ids: [k.cve],
      });
    }
  }

  const stamp = date.replace(/-/g, "");
  const out: RegionSignal[] = [];
  for (const type of REGION_SIGNAL_TYPES) {
    const seen = new Set<string>();
    const list = byType[type]
      .sort((a, b) => cmp(a.date, b.date) || cmp(a.url, b.url) || LEVELLED_REGIONS.indexOf(a.region) - LEVELLED_REGIONS.indexOf(b.region))
      .filter((s) => {
        const key = `${s.region}\0${s.url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    for (const s of list) out.push({ id: `sig-${stamp}-${out.length + 1}`, ...s });
  }
  return out;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The key that merges one signal across editions: type, region, and the normalised URL (the CVE id for KEV). */
function signalKey(s: RegionSignal): string {
  const what = s.type === "home_vendor_kev" ? (s.cve_ids[0] ?? normalizeUrl(s.url)) : normalizeUrl(s.url);
  return `${s.type}\0${s.region}\0${what}`;
}

// ── Evaluation ───────────────────────────────────────────────────────────────────────────────────

/** Placeholder values a rule's reason template can use (§5.11 Reasons). */
interface ReasonFields {
  headline?: string;
  title?: string;
  publisher?: string;
  country?: string;
  sector?: string;
  vendor?: string;
  cve?: string;
}

/** One event behind a rule firing: the items and signals it rests on, its date and its reason fields. */
export interface RegionEvent {
  item_ids: string[];
  signal_ids: string[];
  /** The item's first_seen, or the signal's date. */
  date: string;
  /** The item's display position (today's items first, then history, newest edition first); null for a signal event. */
  order: number | null;
  /** The signal's id for a signal event, else null. */
  signal_id: string | null;
  fields: ReasonFields;
}

/** What an evaluator sees: one region, one rule, and the items and signals inside the rule's lookback. */
export interface EvalContext {
  date: string;
  region: RegionDef;
  rule: RegionRule;
  /** Items with `first_seen` in [date − (N − 1), date]. */
  items: readonly RegionItem[];
  /** The region's signals dated in [date − N, date]. */
  signals: readonly RegionSignal[];
  /** First day of the signal lookback, date − N. */
  signalFrom: string;
  /** The display position of each item id (RegionEvent.order). */
  order: ReadonlyMap<string, number>;
  /** CVE id → lag in days (dateAdded − datePublished), null when not yet joined; absent when not in the index. */
  kevLags: ReadonlyMap<string, number | null>;
  /** CVE id → the vendor_project kev-index.json lists. */
  kevVendors: ReadonlyMap<string, string>;
  config: RegionsConfig;
}

export type Evaluator = (ctx: EvalContext) => RegionEvent[];

function countryName(code: CountryCode | null | undefined): string | undefined {
  return code ? COUNTRY_CODES[code] : undefined;
}

/** The display name of a publisher id: source-tiers.json's name, a vendor's name for `vendor:<id>`, else the id. */
function publisherName(config: RegionsConfig, id: string): string {
  const p = config.tiers.publishers.find((x) => x.id === id);
  if (p) return p.name;
  if (id.startsWith("vendor:")) {
    const v = config.vendors.vendors.find((x) => x.id === id.slice("vendor:".length));
    if (v) return v.name;
  }
  return id.startsWith("host:") ? id.slice("host:".length) : id;
}

function itemEvent(ctx: EvalContext, item: RegionItem, extra: ReasonFields = {}): RegionEvent {
  return {
    item_ids: [item.id],
    signal_ids: [],
    date: item.first_seen,
    order: ctx.order.get(item.id) ?? Number.MAX_SAFE_INTEGER,
    signal_id: null,
    fields: {
      headline: item.headline,
      country: countryName(item.incident?.country),
      sector: item.incident?.sector,
      ...extra,
    },
  };
}

function signalEvent(ctx: EvalContext, s: RegionSignal, extra: ReasonFields = {}, more: { item_ids?: string[]; signal_ids?: string[] } = {}): RegionEvent {
  return {
    item_ids: [...(more.item_ids ?? [])],
    signal_ids: [s.id, ...(more.signal_ids ?? [])],
    date: s.date,
    order: null,
    signal_id: s.id,
    fields: { title: s.title, publisher: publisherName(ctx.config, s.publisher), cve: s.cve_ids[0], ...extra },
  };
}

const inRegion = (ctx: EvalContext, country: CountryCode | null | undefined): boolean =>
  country != null && ctx.region.countries.includes(country);

const statusOk = (ctx: EvalContext, status: string | undefined): boolean =>
  ctx.rule.params.statuses === null || (status !== undefined && (ctx.rule.params.statuses as readonly string[]).includes(status));

const severityOk = (ctx: EvalContext, item: RegionItem): boolean =>
  ctx.rule.params.min_severity === null || severityAtLeast(item.severity, ctx.rule.params.min_severity);

/**
 * The publishers of an item as §4.12 counts them: the distinct `publisher` values of its tier 1 and 2
 * sources (`source_ids`), syndicated copies folded into one (the same publisher, or titles, `title_en` if
 * present, whose word sets have Jaccard similarity ≥ 0.8).
 */
export function publisherCount(item: Pick<RegionItem, "source_ids" | "sources">): number {
  const list = [...new Set(item.source_ids)].map((id) => item.sources.get(id)).filter((s): s is RegionSource => !!s && s.tier <= 2);
  const parent = list.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]!;
      const b = list[j]!;
      if (a.publisher === b.publisher || jaccard(a.title_en ?? a.title, b.title_en ?? b.title) >= 0.8) parent[find(i)] = find(j);
    }
  }
  return new Set(list.map((_, i) => find(i))).size;
}

/** CVE ids a national CERT of the region reports exploited in the lookback: CERT signals, or CERT-confirmed flaw evidence on items. */
function certReports(ctx: EvalContext): Map<string, { item_ids: string[]; signal_ids: string[] }> {
  const out = new Map<string, { item_ids: string[]; signal_ids: string[] }>();
  const add = (cve: string, k: "item_ids" | "signal_ids", id: string) => {
    const e = out.get(cve) ?? { item_ids: [], signal_ids: [] };
    if (!e[k].includes(id)) e[k].push(id);
    out.set(cve, e);
  };
  for (const s of ctx.signals) if (s.type === "cert_exploitation") for (const c of s.cve_ids) add(c, "signal_ids", s.id);
  for (const it of ctx.items) {
    if (!it.regions.includes(ctx.region.code)) continue;
    for (const f of certEvidence(ctx, it)) add(f.cve_id, "item_ids", it.id);
  }
  return out;
}

/** An item's flaw evidence of kind exploited, basis cert_confirmed, whose source's publisher is one of the region's CERTs. */
function certEvidence(ctx: EvalContext, item: RegionItem) {
  return item.flaw_evidence.filter((f) => {
    if (f.kind !== "exploited" || f.basis !== "cert_confirmed") return false;
    const s = item.sources.get(f.source_id);
    return !!s && ctx.region.certs.includes(s.publisher);
  });
}

/** {vendor} for a KEV signal whose CVE kev-index.json does not list yet (collect normally adds it first). */
const HOME_VENDOR_FALLBACK: Partial<Record<LevelledRegion, string>> = { TW: "Taiwanese vendor", JP: "Japanese vendor" };

/** One evaluator per REGION_RULE_TYPES type; each reads exactly the params lib/config.ts's REGION_RULE_PARAMS lists. */
export const EVALUATORS: Record<RegionRuleType, Evaluator> = {
  confirmed_disruption: (ctx) => {
    const { min_publishers, sectors } = ctx.rule.params;
    return ctx.items
      .filter((it) => {
        const inc = it.incident;
        return !!inc && inc.disruption && statusOk(ctx, inc.status) && (sectors === null || sectors.includes(inc.sector))
          && inRegion(ctx, inc.country) && (min_publishers === null || publisherCount(it) >= min_publishers);
      })
      .map((it) => itemEvent(ctx, it));
  },

  agency_alert: (ctx) => {
    const events = ctx.signals.filter((s) => s.type === "agency_alert").map((s) => signalEvent(ctx, s));
    for (const it of ctx.items) {
      for (const id of it.source_ids) {
        const s = it.sources.get(id);
        if (!s || !ctx.region.agencies.includes(s.publisher) || !isAlertUrl(ctx.config, ctx.region.code, s.url)) continue;
        const d = (s.published_at ? taipeiDay(s.published_at) : null) ?? it.first_seen;
        if (d < ctx.signalFrom || d > ctx.date) continue;
        events.push(itemEvent(ctx, it, { title: s.title_en ?? s.title, publisher: publisherName(ctx.config, s.publisher) }));
        break;
      }
    }
    return events;
  },

  confirmed_breach: (ctx) => ctx.items
    .filter((it) => (it.kind === "breach" || it.kind === "supply_chain") && severityOk(ctx, it) && !!it.incident
      && statusOk(ctx, it.incident.status) && inRegion(ctx, it.incident.country))
    .map((it) => itemEvent(ctx, it)),

  victim_in_region: (ctx) => ctx.items
    .filter((it) => !!it.incident && statusOk(ctx, it.incident.status) && inRegion(ctx, it.incident.country) && severityOk(ctx, it))
    .map((it) => itemEvent(ctx, it)),

  campaign_target: (ctx) => ctx.items
    .filter((it) => it.kind === "campaign" && it.regions.includes(ctx.region.code))
    .map((it) => itemEvent(ctx, it)),

  home_vendor_kev: (ctx) => {
    const maxLag = ctx.rule.params.max_lag_days;
    const certs = certReports(ctx);
    const events: RegionEvent[] = [];
    for (const s of ctx.signals) {
      if (s.type !== "home_vendor_kev") continue;
      const cve = s.cve_ids[0];
      if (!cve) continue;
      const lag = ctx.kevLags.get(cve) ?? null; // not in the index yet: not yet joined
      const recent = maxLag === null || lag === null || lag <= maxLag;
      const cert = certs.get(cve);
      if (!recent && !cert) continue;
      const vendorProject = ctx.kevVendors.get(cve);
      const vendor = vendorProject ? matchVendor(ctx.config, { kevVendorProject: vendorProject }) : null;
      const name = vendor?.name ?? vendorProject ?? HOME_VENDOR_FALLBACK[ctx.region.code] ?? "home vendor";
      events.push(signalEvent(ctx, s, { vendor: name }, recent ? {} : cert));
    }
    return events;
  },

  national_cert_exploitation: (ctx) => {
    const events = ctx.signals.filter((s) => s.type === "cert_exploitation").map((s) => signalEvent(ctx, s));
    for (const it of ctx.items) {
      if (!it.regions.includes(ctx.region.code)) continue;
      const f = certEvidence(ctx, it)[0];
      if (!f) continue;
      const s = it.sources.get(f.source_id)!;
      events.push(itemEvent(ctx, it, { title: s.title_en ?? s.title, publisher: publisherName(ctx.config, s.publisher), cve: f.cve_id }));
    }
    return events;
  },
};

/**
 * topEvent order: the newest event first (latest first_seen or signal date), then item events in display
 * order, then signal events by lowest signal id.
 */
export function compareEvents(a: RegionEvent, b: RegionEvent): number {
  if (a.date !== b.date) return a.date > b.date ? -1 : 1;
  if (a.order !== null && b.order !== null) return a.order - b.order;
  if (a.order !== null) return -1;
  if (b.order !== null) return 1;
  return compareSignalIds(a.signal_id ?? "", b.signal_id ?? "");
}

// ── Reasons ──────────────────────────────────────────────────────────────────────────────────────

export const REASON_MAX = 160;
const CUT_FIELD_MAX = 80;
const CUT_FIELDS = new Set(["headline", "title"]);

/** Cuts text at a word boundary to at most `max` characters, ending with "…" when it was longer. */
export function cutAtWord(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  if (max <= 1) return "…";
  const room = max - 1; // one character for the "…"
  let head = t.slice(0, room);
  // A cut inside a word backs up to the last space; text without spaces (Chinese, Japanese) is cut where it falls.
  if (!/\s/u.test(t.charAt(room))) {
    const space = head.search(/\s\S*$/u);
    if (space > 0) head = head.slice(0, space);
  }
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head.trimEnd()}…`;
}

/**
 * Fills a rule's reason template (§5.11): {headline} and {title} cut at a word boundary to 80 characters
 * with "…"; {publisher} the source-tiers.json display name; {country} the English short name; {sector} the
 * SECTORS id as written; {vendor} the matched vendor's name; {cve} the CVE id. At most 160 characters,
 * cutting {headline} or {title} further. A placeholder with no value is left empty.
 */
export function renderReason(template: string, fields: ReasonFields): string {
  const tokens = template.split(/(\{[a-z]+\})/);
  const fill = (cut: (s: string) => string) => tokens
    .map((tok) => {
      const m = /^\{([a-z]+)\}$/.exec(tok);
      if (!m) return tok;
      const key = m[1] as keyof ReasonFields;
      const v = fields[key] ?? "";
      return CUT_FIELDS.has(key) ? cut(v) : v;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  let out = fill((v) => cutAtWord(v, CUT_FIELD_MAX));
  if (out.length > REASON_MAX) {
    const cuttable = tokens.filter((t) => /^\{(headline|title)\}$/.test(t)).length;
    const fixed = fill(() => "").length;
    const each = Math.max(1, Math.floor((REASON_MAX - fixed) / Math.max(1, cuttable)));
    out = fill((v) => cutAtWord(v, Math.min(CUT_FIELD_MAX, each)));
  }
  return out.length > REASON_MAX ? cutAtWord(out, REASON_MAX) : out;
}

// ── computeRegions ───────────────────────────────────────────────────────────────────────────────

function unique(ids: Iterable<string>): string[] {
  return [...new Set(ids)];
}

function kevMaps(kevIndex: Pick<KevIndexFile, "entries">): { lags: Map<string, number | null>; vendors: Map<string, string> } {
  const lags = new Map<string, number | null>();
  const vendors = new Map<string, string>();
  for (const [cve, added, vendorProject, , published] of kevIndex.entries) {
    lags.set(cve, published === null ? null : daysBetween(published, added));
    vendors.set(cve, vendorProject);
  }
  return { lags, vendors };
}

/**
 * §5.11 Evaluation. (1) Signals: today's plus every history brief's, merged by type, region and
 * normalised URL (CVE id for KEV), the earliest id kept, filtered to [date − N_max, date]. (2) Items:
 * one copy per id, today's if present, else the newest earlier edition's. (3) For each levelled region
 * and each rule in file order that names it, the rule's evaluator over the items and the region's signals
 * in its lookback; it fires on at least one event. (4) Fired rules sorted by level rank, then file order;
 * `computed_level` is the top rule's level, else baseline; `level` is one step up when the draft raised the
 * region. (5) `previous_level` from the brief dated date − 1; `change` by rank. (6) The rows, Global's
 * item count (today's items carrying GLOBAL) and the signals.
 */
export function computeRegions(input: RegionsInput): Regions {
  const { date, config } = input;
  const nMax = maxLookbackDays(config.regions);
  const spanFrom = addDays(date, -nMax);

  // (1) Signals.
  const merged = [...input.signals, ...input.history.flatMap((b) => b.regions.signals)].sort((a, b) => compareSignalIds(a.id, b.id));
  const seen = new Set<string>();
  const signals: RegionSignal[] = [];
  for (const s of merged) {
    const key = signalKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    if (s.date >= spanFrom && s.date <= date) signals.push(s);
  }

  // (2) Items: today's first, then history newest edition first; the first copy of an id wins.
  const history = [...input.history].sort((a, b) => cmp(b.date, a.date));
  const items: RegionItem[] = [];
  const order = new Map<string, number>();
  const take = (it: RegionItem) => {
    if (order.has(it.id)) return;
    order.set(it.id, items.length);
    items.push(it);
  };
  for (const it of input.items) take(it);
  for (const b of history) for (const it of regionItems(b.items, b.sources, config)) take(it);

  const { lags, vendors } = kevMaps(input.kevIndex);
  const yesterday = input.history.find((b) => b.date === addDays(date, -1)) ?? null;

  const rows: RegionRow[] = LEVELLED_REGIONS.map((code) => {
    const region = config.regions.regions.find((r) => r.code === code);
    const fired: { rule: RegionRule; index: number; events: RegionEvent[] }[] = [];
    if (region) {
      config.regions.rules.forEach((rule, index) => {
        if (!rule.regions.includes(code)) return;
        const n = lookbackDays(rule);
        const itemFrom = addDays(date, -(n - 1));
        const signalFrom = addDays(date, -n);
        const ctx: EvalContext = {
          date,
          region,
          rule,
          items: items.filter((it) => it.first_seen >= itemFrom && it.first_seen <= date),
          signals: signals.filter((s) => s.region === code && s.date >= signalFrom && s.date <= date),
          signalFrom,
          order,
          kevLags: lags,
          kevVendors: vendors,
          config,
        };
        const events = EVALUATORS[rule.type](ctx).sort(compareEvents);
        if (events.length) fired.push({ rule, index, events });
      });
    }
    fired.sort((a, b) => levelRank(b.rule.level) - levelRank(a.rule.level) || a.index - b.index);
    const top = fired[0] ?? null;
    const computed: RegionLevel = top ? top.rule.level : "baseline";

    const raise = input.raises.find((r) => r.region === code) ?? null;
    const raised = raise && computed !== "critical"
      ? { from: computed, to: stepUp(computed), reason: raise.reason, trigger_class: raise.trigger_class, item_ids: [...raise.item_ids] }
      : null;
    const level = raised ? raised.to : computed;

    const previous = yesterday?.regions.rows.find((r) => r.code === code)?.level ?? null;
    const change: RegionRow["change"] = previous === null ? "new"
      : levelRank(level) > levelRank(previous) ? "up" : levelRank(level) < levelRank(previous) ? "down" : "same";

    return {
      code,
      level,
      computed_level: computed,
      previous_level: previous,
      change,
      rule_id: top ? top.rule.id : null,
      reason: top ? renderReason(top.rule.reason, top.events[0]!.fields) : BASELINE_REASON,
      item_ids: top ? unique(top.events.flatMap((e) => e.item_ids)) : [],
      fired: fired.map((f) => ({
        rule_id: f.rule.id,
        level: f.rule.level,
        item_ids: unique(f.events.flatMap((e) => e.item_ids)),
        signal_ids: unique(f.events.flatMap((e) => e.signal_ids)),
      })),
      raised,
    };
  });

  return {
    rows,
    global: { item_count: input.items.filter((it) => it.regions.includes("GLOBAL")).length },
    signals,
  };
}

/** `previewRegions()` (§5.11): computeRegions() with no items and no raises, so only signal rules fire. */
export function previewRegions(input: Omit<RegionsInput, "items" | "raises">): Regions {
  return computeRegions({ ...input, items: [], raises: [] });
}

/** The context's `regions_preview` (§4.15): `region` = code, `level`, `fired_rule` = rule_id, `basis` = reason (null at baseline). */
export function regionsPreviewRows(regions: Pick<Regions, "rows">): { region: LevelledRegion; level: RegionLevel; fired_rule: string | null; basis: string | null }[] {
  return regions.rows.map((r) => ({ region: r.code, level: r.level, fired_rule: r.rule_id, basis: r.rule_id === null ? null : r.reason }));
}
