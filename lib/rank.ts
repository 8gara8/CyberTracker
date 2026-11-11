// Candidate ranking (SPEC §5.12, §8.3): turns the pack's records and items into at most 40 ranked
// candidates before the agent reads anything. Pure: no clock, file, network or randomness, and every sort
// has an explicit comparator, so the same inputs in any order give byte-identical output. Rulings R41 to
// R45 and the feeds plan §3.15 settle what §5.12 leaves open (merge targets, release month, release
// cve_ids, record kinds, notes without a record, ties, the by_reason keys and advisory_urls).

import { matchVendor, type AiCreditMatch, type CompiledConfig, type LoadedConfig } from "./config";
import { utcDateOf } from "./dates";
import { advisoryUrlFilter, cveIdsIn } from "./collect";
import { ADVISORY_TAGS } from "./feeds/cvelist";
import { epssJump } from "./feeds/epss";
import type { NewKevIdsResult } from "./feeds/kev";
import type { CveRecord, EpssDay, GhsaAdvisory, KevCatalog, KevEntry } from "./feeds/types";
import { byCodeUnit, compareCveIds } from "./ids";
import { matchRecord } from "./metrics/ai-credit";
import { CERT_EXPLOITATION_RE } from "./regions";
import { sanitize, wrapUntrusted } from "./sanitize";
import type { TimeWindow } from "./schema/common";
import type { Vendor, WatchWindow, WatchWindowsFile } from "./schema/config";
import type { Candidate } from "./schema/context";
import type { CutEntry, PackItem, PackRecord, RankLogEntry } from "./schema/pack";
import { publisherFor, type PublisherConfig } from "./sources";
import type { Coverage, KindId } from "./vocab";

/** §5.12's weights: `base` (the highest that applies) plus each `bonus` that applies, once. */
export interface RankWeights {
  readonly base: {
    readonly new_kev: number; readonly release_exploited: number; readonly cert_alert: number; readonly critical_widely_deployed: number;
    readonly release: number; readonly ghsa_critical: number; readonly cert_note: number;
  };
  readonly bonus: {
    readonly kev_ransomware_known: number; readonly home_vendor: number; readonly ai_credit: number; readonly epss_crossed_99: number;
    readonly epss_rose_010: number; readonly ssvc_automatable_total: number; readonly public_exploit_reported: number; readonly watch_window: number;
  };
}

/** §5.12 verbatim. The calibration PR (§10) tunes them. */
export const RANK_WEIGHTS = {
  base: { new_kev: 100, release_exploited: 90, cert_alert: 60, critical_widely_deployed: 50,
          release: 40, ghsa_critical: 35, cert_note: 30 },
  bonus: { kev_ransomware_known: 10, home_vendor: 25, ai_credit: 30, epss_crossed_99: 40,
           epss_rose_010: 20, ssvc_automatable_total: 20, public_exploit_reported: 15, watch_window: 15 },
} as const satisfies RankWeights;

/** One AI-finder match on a record's credits (matchRecord(), §5.5), with the field it came from. */
export type AiHit = AiCreditMatch & { field: string };

export interface RankInput {
  date: string;
  /** The pack window. */
  window: TimeWindow;
  /** The pack window with both ends floored to the hour (ruling R37): CVE-record membership. */
  recordWindow: TimeWindow;
  pack: { items: readonly PackItem[]; records: readonly PackRecord[] };
  catalog: KevCatalog | null;
  newKevIds: readonly string[];
  /** Zip and per-id records. */
  records: readonly CveRecord[];
  epss: { e: EpssDay | null; e1: EpssDay | null; e7: EpssDay | null };
  ghsa: readonly GhsaAdvisory[];
  /** release_id of every earlier brief item (for the -DD suffix). */
  earlierReleaseIds: readonly string[];
  config: { loaded: LoadedConfig; compiled: CompiledConfig; watchWindows: readonly WatchWindow[] };
  /** Where newKevIds came from (kevBaseline()); "recent-7-days" logs KEV_INDEX_MISSING and "as-of" KEV_ASOF_DRY_RUN. */
  kevSource?: NewKevIdsResult["source"];
  /** The AI-credit match of one record; defaults to matchRecord(rec, null, compiled.aiFinders) (§5.5). */
  aiMatch?: (rec: CveRecord) => AiHit | null;
}

type Unscored = Omit<Candidate, "rank" | "score" | "deep_read">;
type BonusKey = keyof RankWeights["bonus"];

const KEV_SOURCES: ReadonlySet<PackRecord["source"]> = new Set(["kev", "cvelist", "epss", "ghsa", "nvd"]);
const NOTE_SOURCES: ReadonlySet<PackRecord["source"]> = new Set(["twcert-tvn", "jpcert", "myjvn"]);
const ADVISORY_MAX = 5;
const PRODUCT_MIN = 4;

/**
 * The most bundle members whose CVE List records a patch_batch candidate references (§5.12 step 2, §0.4
 * row 146): enough for every exploited fix of a usual Patch Tuesday and its highest-scored critical ones,
 * about 10 KB of the pack's 150 KB Markdown. The release block's counts come from every member, never from
 * these records, so the rest of a 1,000-fix release adds nothing the brief can use and once filled the pack.
 */
export const RELEASE_PACK_IDS_MAX = 20;

/** The kind a news candidate proposes from its first coverage (§5.12 step 3). */
export const NEWS_KIND_HINT: Readonly<Record<Coverage, KindId>> = {
  exploits: "critical_flaw", breaches: "breach", ai: "ai_capability", policy: "policy", taiwan: "campaign", japan: "campaign",
};

/** The record page a CVE candidate links to. */
export const cveRecordUrl = (cveId: string) => `https://www.cve.org/CVERecord?id=${cveId}`;

/** A candidate's wrapped title: sanitised (at most 200 characters), then `<untrusted source="…">`. */
export function candidateTitle(text: string, sourceId: string): string {
  return wrapUntrusted(sourceId, sanitize(text, { max: 200 }));
}

/** The watch-windows.json entries active on `date` (start and end inclusive Taipei dates), in file order. */
export function activeWatchWindows(file: WatchWindowsFile, date: string): WatchWindow[] {
  return file.windows.filter((w) => w.start <= date && date <= w.end);
}

// ── Working state ────────────────────────────────────────────────────────────────────────────────

interface Merge {
  id: string;
  /** The base weight it brings. */
  base: number;
  texts: string[];
  /** "JPCERT alert", "CERT note", "agency alert" or "news: <registry name>". */
  reason: string;
  exploited: boolean;
}

interface Work {
  c: Unscored;
  origin: "record" | "release" | "note" | "news" | "ghsa";
  /** Base weights from the candidate itself. */
  bases: number[];
  /** Own reasons, in template order, before the merged ones. */
  ownReasons: string[];
  bonuses: Set<BonusKey>;
  epss: "crossed" | "rose" | null;
  newKev: boolean;
  /** Tie-break date (§5.12 step 5), an ISO date or timestamp. */
  date: string;
  texts: string[];
  /** CVE ids a note or news item may name to merge here; empty for candidates that take no merges. */
  matchIds: string[];
  /** The matched vendor for the vendor-plus-product rule (single-CVE record candidates only). */
  vendor: Vendor | null;
  merges: Merge[];
  exploited: boolean;
  /**
   * A release candidate's vendor and the members it references, in releasePackMembers() order: finish()
   * reads its advisory URLs member by member in that order, so the exploited fixes' pages come first.
   */
  release?: { vendor: Vendor; members: string[] };
}

interface Ctx {
  input: RankInput;
  recs: Map<string, CveRecord>;
  kev: Map<string, KevEntry>;
  newKev: Set<string>;
  packByCve: Map<string, PackRecord[]>;
  packById: Map<string, PackRecord>;
  ai: (rec: CveRecord) => AiHit | null;
  inRecordWindow: (ts: string | null) => boolean;
  inWindow: (ts: string | null) => boolean;
  feedName: Map<string, string>;
}

const usable = (s: string | null | undefined): string | null => {
  const t = s?.trim() ?? "";
  return t === "" || t.toLowerCase() === "n/a" ? null : t;
};

function clean(s: string | null | undefined, max: number): string | null {
  const u = usable(s);
  if (!u) return null;
  const t = sanitize(u, { max });
  return t === "" ? null : t;
}

const between = (w: TimeWindow) => {
  const start = Date.parse(w.start);
  const end = Date.parse(w.end);
  return (ts: string | null) => {
    if (!ts) return false;
    const t = Date.parse(ts);
    return !Number.isNaN(t) && t >= start && t < end;
  };
};

function context(input: RankInput): Ctx {
  const recs = new Map<string, CveRecord>();
  // Canonical order first (feeds plan §3.15 note 1); a repeated id keeps its newest copy.
  const sorted = [...input.records].sort((a, b) => compareCveIds(a.cve_id, b.cve_id) || byCodeUnit(a.updated_at ?? "", b.updated_at ?? ""));
  for (const r of sorted) if (r.state === "PUBLISHED") recs.set(r.cve_id, r);
  const kev = new Map<string, KevEntry>();
  for (const v of input.catalog?.vulnerabilities ?? []) kev.set(v.cveID, v);
  const packById = new Map<string, PackRecord>();
  const packByCve = new Map<string, PackRecord[]>();
  for (const r of [...input.pack.records].sort((a, b) => byCodeUnit(a.id, b.id))) {
    packById.set(r.id, r);
    if (!KEV_SOURCES.has(r.source)) continue;
    for (const id of r.cve_ids) {
      const list = packByCve.get(id) ?? [];
      list.push(r);
      packByCve.set(id, list);
    }
  }
  const memo = new Map<string, AiHit | null>();
  const match = input.aiMatch ?? ((rec: CveRecord) => matchRecord(rec, null, input.config.compiled.aiFinders));
  const ai = (rec: CveRecord) => {
    if (!memo.has(rec.cve_id)) memo.set(rec.cve_id, match(rec));
    return memo.get(rec.cve_id)!;
  };
  const feedName = new Map(input.config.loaded.sources.feeds.map((f) => [f.id, f.name]));
  return {
    input, recs, kev, newKev: new Set(input.newKevIds), packByCve, packById, ai,
    inRecordWindow: between(input.recordWindow), inWindow: between(input.window), feedName,
  };
}

// ── Step 1 tests, shared with collect's record filter ────────────────────────────────────────────

interface CveSignals {
  rec: CveRecord | null;
  kev: KevEntry | null;
  vendor: Vendor | null;
  newKev: boolean;
  criticalWide: boolean;
  jump: { crossed: boolean; rose: boolean; change_24h: number | null };
  ssvcTotal: boolean;
  ai: AiHit | null;
  home: boolean;
  /** Published or updated in the record window. */
  touched: boolean;
  ghsa: GhsaAdvisory[];
  exploited: boolean;
  /** Any §5.12 step 1 test holds. */
  candidate: boolean;
}

function criticalGhsa(ctx: Ctx): { byCve: Map<string, GhsaAdvisory[]>; alone: GhsaAdvisory[] } {
  const byCve = new Map<string, GhsaAdvisory[]>();
  const alone: GhsaAdvisory[] = [];
  const list = [...ctx.input.ghsa].sort((a, b) => byCodeUnit(a.id, b.id));
  for (const g of list) {
    if (!g.reviewed || g.withdrawn || (g.severity ?? "").toUpperCase() !== "CRITICAL" || !ctx.inWindow(g.published_at)) continue;
    const cves = [...g.cve_ids].sort(compareCveIds);
    if (!cves.length) {
      alone.push(g);
      continue;
    }
    const first = cves[0]!;
    byCve.set(first, [...(byCve.get(first) ?? []), g]);
  }
  return { byCve, alone };
}

function signals(ctx: Ctx, id: string, ghsaByCve: Map<string, GhsaAdvisory[]>): CveSignals {
  const rec = ctx.recs.get(id) ?? null;
  const kev = ctx.kev.get(id) ?? null;
  const vendor = matchVendor(ctx.input.config.loaded, { kevVendorProject: kev?.vendorProject, affectedVendors: rec?.affected.map((a) => a.vendor) ?? [] });
  const published = !!rec && ctx.inRecordWindow(rec.published_at);
  const touched = !!rec && (published || ctx.inRecordWindow(rec.updated_at));
  const { e, e1 } = ctx.input.epss;
  const jump = e ? epssJump(e, e1, id) : { crossed: false, rose: false, change_24h: null };
  const ai = rec ? ctx.ai(rec) : null;
  const ssvcTotal = rec?.ssvc?.automatable === "yes" && rec.ssvc.technical_impact === "total";
  const criticalWide = !!rec?.cvss && rec.cvss.score >= 9 && touched && vendor?.widely_deployed === true;
  const home = vendor?.country === "TW" || vendor?.country === "JP";
  const ghsa = ghsaByCve.get(id) ?? [];
  const newKev = ctx.newKev.has(id);
  const candidate = newKev || criticalWide || jump.crossed || jump.rose || (ssvcTotal && touched) || (!!ai && touched) || (home && published) || ghsa.length > 0;
  return { rec, kev, vendor, newKev, criticalWide, jump, ssvcTotal, ai, home, touched, ghsa, exploited: !!kev || rec?.ssvc?.exploitation === "active", candidate };
}

interface Bundle {
  vendor: Vendor;
  releaseId: string;
  id: string;
  members: CveRecord[];
  exploited: string[];
  critical: number | null;
  /** The members' earliest and latest published_at (instants). */
  first: string;
  newest: string;
}

/** §5.12 step 2: one bundle per run.json `releases` entry with at least `min_records` records from its CNAs published in the record window. */
function bundles(ctx: Ctx): Bundle[] {
  const out: Bundle[] = [];
  const earlier = new Set(ctx.input.earlierReleaseIds);
  for (const rel of ctx.input.config.loaded.run.releases) {
    const vendor = ctx.input.config.loaded.vendors.vendors.find((v) => v.id === rel.vendor_id);
    if (!vendor || !vendor.cna.length) continue;
    const members = [...ctx.recs.values()].filter((r) => !!r.assigner && vendor.cna.includes(r.assigner) && ctx.inRecordWindow(r.published_at));
    if (members.length < rel.min_records) continue;
    const dates = members.map((r) => r.published_at!).sort(byCodeUnit);
    const first = dates[0]!;
    const newest = dates.at(-1)!;
    const month = newest.slice(0, 7);
    let releaseId = `rel-${vendor.id}-${month}`;
    let id = `pt-${vendor.id}-${month}`;
    if (earlier.has(releaseId)) {
      releaseId += `-${newest.slice(8, 10)}`;
      id += `-${newest.slice(8, 10)}`;
    }
    const exploited = members.filter((r) => ctx.kev.has(r.cve_id) || r.ssvc?.exploitation === "active").map((r) => r.cve_id).sort(compareCveIds);
    const rated = members.filter((r) => r.cna_severity !== null);
    const critical = rated.length ? rated.filter(isCritical).length : null;
    out.push({ vendor, releaseId, id, members, exploited, critical, first, newest });
  }
  return out;
}

/** A bundle's critical fix, as `release.critical` counts it: CNA baseSeverity CRITICAL. */
const isCritical = (r: CveRecord) => r.cna_severity !== null && r.cna_severity.toUpperCase() === "CRITICAL";

/**
 * The members whose CVE List records a patch_batch candidate references (§5.12 step 2, §0.4 row 146): the
 * exploited ones in CVE id order, then the critical ones (isCritical()), then the rest, each of these two
 * by CVSS score descending, unscored last, then CVE id; at most RELEASE_PACK_IDS_MAX in all. The rest fill
 * the slots the exploited and critical ones leave, so a release with neither (an all-High month) still
 * names its best-scored fixes, and its candidate their records and vendor advisory URLs. The release
 * counts still cover every member.
 */
export function releasePackMembers(b: { members: readonly CveRecord[]; exploited: readonly string[] }): string[] {
  const exploited = new Set(b.exploited);
  const byScore = (x: CveRecord, y: CveRecord) => (y.cvss?.score ?? -1) - (x.cvss?.score ?? -1) || compareCveIds(x.cve_id, y.cve_id);
  const rest = b.members.filter((r) => !exploited.has(r.cve_id));
  const critical = rest.filter(isCritical).sort(byScore).map((r) => r.cve_id);
  const others = rest.filter((r) => !isCritical(r)).sort(byScore).map((r) => r.cve_id);
  return [...b.exploited, ...critical, ...others].slice(0, RELEASE_PACK_IDS_MAX);
}

/**
 * The release vendor's own pages among a member record's references (§5.12 step 2, §8.3 Advisory URLs):
 * its CNA references that carry no advisory tag (recordAdvisoryUrls() takes the tagged ones) and no
 * exploit tag, and whose publisherFor() publisher is the vendor itself (`vendor:<id>`, tier 1), through
 * advisoryUrlFilter() (https, not blocked, at most 500 characters, normalised, unique, at most 5). SAP,
 * Siemens, Fortinet, Ivanti and Schneider Electric tag none of their references, so without these a
 * release of theirs would carry no vendor page; a reference on any other host is left out.
 */
export function releaseVendorUrls(rec: CveRecord, vendor: Pick<Vendor, "id">, cfg: PublisherConfig): string[] {
  const own = rec.references.filter((r) => r.from === "cna" && !r.tags.includes("exploit") && !r.tags.some((t) => ADVISORY_TAGS.has(t)))
    .map((r) => r.url)
    .filter((u) => {
      const p = publisherFor(u, "vendor_advisory", cfg);
      return p.publisher === `vendor:${vendor.id}` && p.tier === 1;
    });
  return advisoryUrlFilter(own, cfg.sourceTiers);
}

/**
 * The vendor pages (releaseVendorUrls()) of every member a release candidate references
 * (releasePackMembers()), by CVE id: collect adds them to those members' CVE List pack records, after
 * their tagged advisory URLs, so the pack and the run's evidence hold the page the patch batch is dated
 * from (RELEASE_SOURCE). No other record's advisory URLs change.
 */
export function releaseMemberUrls(input: Omit<RankInput, "pack">): Map<string, string[]> {
  const ctx = context({ ...input, pack: { items: [], records: [] } });
  const out = new Map<string, string[]>();
  for (const b of bundles(ctx)) {
    for (const id of releasePackMembers(b)) {
      const urls = releaseVendorUrls(ctx.recs.get(id)!, b.vendor, ctx.input.config.loaded);
      if (urls.length) out.set(id, urls);
    }
  }
  return out;
}

/**
 * The CVE ids whose CVE List records the pack keeps (§4.14 Records): records published or updated in the
 * record window that meet a §5.12 step 1 test, name a TW or JP vendor or carry an AI-finder match, every
 * new KEV id with a record and, of each release bundle, the members its candidate references
 * (releasePackMembers()) and every exploited member, which stays a candidate of its own (§0.4 row 146). A
 * member no test keeps is left out, so a 1,000-fix release cannot fill the 400 records with fixes that
 * only its counts need; the counts come from the CVE List records, never from the pack.
 */
export function recordKeepIds(input: Omit<RankInput, "pack">): Set<string> {
  const ctx = context({ ...input, pack: { items: [], records: [] } });
  const { byCve } = criticalGhsa(ctx);
  const keep = new Set<string>();
  for (const id of ctx.recs.keys()) {
    const s = signals(ctx, id, byCve);
    if (s.candidate || s.newKev || (s.touched && (s.home || !!s.ai))) keep.add(id);
  }
  for (const b of bundles(ctx)) for (const id of [...b.exploited, ...releasePackMembers(b)]) keep.add(id);
  return keep;
}

// ── Candidates ───────────────────────────────────────────────────────────────────────────────────

const fixed2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

function cvssReason(c: Unscored): string[] {
  if (!c.cvss) return [];
  return [`CVSS ${c.cvss.score.toFixed(1)} (${c.cvss.scorer}, ${c.cvss.version})`];
}

/** The advisory URLs of the pack records `ids`, in record id order, repeats dropped, at most ADVISORY_MAX. */
function packUrls(ctx: Ctx, ids: readonly string[]): string[] {
  return firstUrls([...ids].sort(byCodeUnit).map((id) => ctx.packById.get(id)?.advisory_urls ?? []));
}

function firstUrls(lists: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const u of list) {
      if (out.length >= ADVISORY_MAX) return out;
      if (!out.includes(u)) out.push(u);
    }
  }
  return out;
}

/**
 * A release candidate's advisory URLs (§5.12 step 2): member by member in releasePackMembers() order
 * (exploited, then critical, then the rest), each member's CVE List pack records' advisory URLs and then
 * its vendor pages (releaseVendorUrls()); then those of the other records it references (merged notes), in
 * record id order; repeats dropped, at most ADVISORY_MAX. So the exploited fix's own advisory is never
 * pushed out by the fill's better-scored fixes, and a vendor that tags no reference still gives its page.
 */
function releaseUrls(ctx: Ctx, w: Work, pack: readonly string[]): string[] {
  const rel = w.release!;
  const lists: (readonly string[])[] = [];
  const seen = new Set<string>();
  for (const id of rel.members) {
    for (const r of (ctx.packByCve.get(id) ?? []).filter((x) => x.source === "cvelist" && pack.includes(x.id))) {
      seen.add(r.id);
      lists.push(r.advisory_urls);
    }
    const rec = ctx.recs.get(id);
    if (rec) lists.push(releaseVendorUrls(rec, rel.vendor, ctx.input.config.loaded));
  }
  for (const id of pack) if (!seen.has(id)) lists.push(ctx.packById.get(id)?.advisory_urls ?? []);
  return firstUrls(lists);
}

function cveWork(ctx: Ctx, id: string, s: CveSignals): Work {
  const { rec, kev } = s;
  const pack = ctx.packByCve.get(id) ?? [];
  const e = ctx.input.epss.e;
  const score = e?.scores.get(id);
  const g = s.ghsa[0] ?? null;
  const titleSource: [string | null | undefined, string][] = [
    [kev?.vulnerabilityName, "kev"], [rec?.title, "cvelist"], [rec?.description, "cvelist"], [g?.summary, "ghsa"],
  ];
  const [titleText, titleFeed] = titleSource.find(([t]) => clean(t, 200) !== null) ?? [id, score ? "epss" : "cvelist"];
  const firstAffected = rec?.affected.find((a) => usable(a.vendor) || usable(a.product));
  const c: Unscored = {
    id: id.toLowerCase(),
    kind: s.exploited ? "exploited_flaw" : "critical_flaw",
    reasons: [],
    title: candidateTitle(titleText!, titleFeed),
    cve_ids: [id],
    vendor: s.vendor?.name ?? clean(kev?.vendorProject, 80) ?? clean(firstAffected?.vendor, 80),
    vendor_country: s.vendor?.country ?? null,
    product: clean(kev?.product, 120) ?? clean(firstAffected?.product, 120) ?? clean(g?.packages[0]?.name, 120),
    cvss: rec?.cvss ? { score: rec.cvss.score, version: rec.cvss.version, scorer: rec.cvss.scorer } : null,
    epss: score && e ? { score: score.epss, percentile: score.percentile, change_24h: s.jump.change_24h, date: e.score_date.slice(0, 10) } : null,
    kev: kev ? { date_added: kev.dateAdded, due_date: kev.dueDate, ransomware: kev.knownRansomwareCampaignUse.toLowerCase() === "known" ? "known" : "unknown" } : null,
    ssvc: rec?.ssvc ? { exploitation: rec.ssvc.exploitation, automatable: rec.ssvc.automatable, technical_impact: rec.ssvc.technical_impact } : null,
    ai_credit_match: s.ai ? { family: s.ai.family, matched: sanitize(s.ai.matched, { max: 120 }) || s.ai.matched, field: s.ai.field, rule: s.ai.rule } : null,
    exploit_reference: rec?.exploit_reference ?? false,
    release: null,
    record_url: cveRecordUrl(id),
    advisory_urls: [],
    pack_ids: pack.map((r) => r.id),
  };
  const bases: number[] = [];
  if (s.newKev) bases.push(RANK_WEIGHTS.base.new_kev);
  if (s.criticalWide) bases.push(RANK_WEIGHTS.base.critical_widely_deployed);
  if (s.ghsa.length) bases.push(RANK_WEIGHTS.base.ghsa_critical);
  const bonuses = new Set<BonusKey>();
  if (c.kev?.ransomware === "known") bonuses.add("kev_ransomware_known");
  if (s.home) bonuses.add("home_vendor");
  if (c.ai_credit_match) bonuses.add("ai_credit");
  if (s.ssvcTotal) bonuses.add("ssvc_automatable_total");
  if (c.exploit_reference) bonuses.add("public_exploit_reported");
  const epss = s.jump.crossed ? "crossed" : s.jump.rose ? "rose" : null;
  const ownReasons = [
    ...(s.newKev ? ["new KEV"] : []),
    ...(c.kev?.ransomware === "known" ? ["KEV: ransomware known"] : []),
    ...(s.home ? [`${c.vendor_country} vendor`] : []),
    ...cvssReason(c),
    ...(epss === "crossed" ? ["EPSS crossed 0.99"] : epss === "rose" ? [`EPSS +${fixed2(s.jump.change_24h ?? 0)} in a day`] : []),
    ...(s.ssvcTotal ? ["SSVC: automatable, total impact"] : []),
    ...(c.ai_credit_match ? [`AI credit: ${c.ai_credit_match.family}`] : []),
    ...(c.exploit_reference ? ["public exploit reported"] : []),
    ...(s.ghsa.length ? ["GitHub critical"] : []),
  ];
  const dates = [c.kev?.date_added, rec?.published_at, ...pack.map((r) => r.date)].filter((d): d is string => !!d).sort(byCodeUnit);
  const texts = [titleText!, rec?.description ?? "", ...pack.flatMap((r) => [r.title, r.text])];
  return {
    c, origin: "record", bases, ownReasons, bonuses, epss, newKev: s.newKev, date: dates.at(-1) ?? ctx.input.date, texts,
    matchIds: [id], vendor: s.vendor, merges: [], exploited: s.exploited,
  };
}

function releaseWork(ctx: Ctx, b: Bundle): Work {
  const ids = b.members.map((r) => r.cve_id).sort(compareCveIds);
  // pack_ids: the bounded members' CVE List records only (§0.4 row 146); merges still match every member id.
  const packIds = [...new Set(releasePackMembers(b).flatMap((id) => (ctx.packByCve.get(id) ?? []).filter((r) => r.source === "cvelist").map((r) => r.id)))].sort(byCodeUnit);
  const total = b.members.length;
  const n = b.exploited.length;
  const title = `${b.vendor.name} security updates, ${b.newest.slice(0, 7)}: ${total} fixes, ${n} exploited`;
  const c: Unscored = {
    id: b.id, kind: "patch_batch", reasons: [], title: candidateTitle(title, "cvelist"), cve_ids: [...b.exploited],
    vendor: b.vendor.name, vendor_country: b.vendor.country, product: null, cvss: null, epss: null, kev: null, ssvc: null,
    ai_credit_match: null, exploit_reference: false,
    release: {
      release_id: b.releaseId, vendor: b.vendor.name, total, critical: b.critical, exploited: n, exploited_cve_ids: [...b.exploited],
      // The span RELEASE_SOURCE and releaseBlockOf() read membership from (releaseMember(), §0.4 row 146).
      first_published: utcDateOf(b.first), last_published: utcDateOf(b.newest),
    },
    record_url: null, advisory_urls: [], pack_ids: packIds,
  };
  const home = b.vendor.country === "TW" || b.vendor.country === "JP";
  return {
    c, origin: "release", bases: [n > 0 ? RANK_WEIGHTS.base.release_exploited : RANK_WEIGHTS.base.release],
    ownReasons: [`release: ${total} fixes, ${n} exploited`, ...(home ? [`${b.vendor.country} vendor`] : [])],
    bonuses: new Set(home ? ["home_vendor"] : []), epss: null, newKev: false, date: b.newest, texts: [title],
    matchIds: ids, vendor: null, merges: [], exploited: n > 0, release: { vendor: b.vendor, members: releasePackMembers(b) },
  };
}

function ghsaWork(ctx: Ctx, g: GhsaAdvisory): Work {
  const rec = [...ctx.packById.values()].find((r) => r.source === "ghsa" && r.record_id === g.id) ?? null;
  const c: Unscored = {
    id: rec?.id ?? `vuln-${g.id.toLowerCase()}`, kind: "critical_flaw", reasons: [],
    title: candidateTitle(clean(g.summary, 200) ?? g.id, "ghsa"), cve_ids: [], vendor: null, vendor_country: null,
    product: clean(g.packages[0]?.name, 120), cvss: null, epss: null, kev: null, ssvc: null, ai_credit_match: null,
    exploit_reference: false, release: null, record_url: rec?.url ?? null, advisory_urls: [], pack_ids: rec ? [rec.id] : [],
  };
  return {
    c, origin: "ghsa", bases: [RANK_WEIGHTS.base.ghsa_critical], ownReasons: ["GitHub critical"], bonuses: new Set(), epss: null,
    newKev: false, date: g.published_at, texts: [g.summary ?? ""], matchIds: [], vendor: null, merges: [], exploited: false,
  };
}

function noteBase(r: PackRecord): { base: number; reason: string } {
  return r.source === "jpcert" && r.facts.alert === true
    ? { base: RANK_WEIGHTS.base.cert_alert, reason: "JPCERT alert" }
    : { base: RANK_WEIGHTS.base.cert_note, reason: "CERT note" };
}

function noteWork(ctx: Ctx, r: PackRecord, id: string, cves: string[]): Work {
  const { base, reason } = noteBase(r);
  const vendor = r.vendor ? matchVendor(ctx.input.config.loaded, { affectedVendors: [r.vendor] }) : null;
  const exploited = CERT_EXPLOITATION_RE.test(`${r.title} ${r.text}`);
  const c: Unscored = {
    id, kind: exploited ? "exploited_flaw" : "critical_flaw", reasons: [], title: candidateTitle(r.title || r.record_id, r.source),
    cve_ids: cves, vendor: r.vendor, vendor_country: vendor?.country ?? null, product: r.product, cvss: null, epss: null, kev: null,
    ssvc: null, ai_credit_match: null, exploit_reference: false, release: null, record_url: r.url, advisory_urls: [], pack_ids: [r.id],
  };
  return {
    c, origin: "note", bases: [base], ownReasons: [reason], bonuses: new Set(), epss: null, newKev: false, date: r.date,
    texts: [r.title, r.text], matchIds: cves, vendor: null, merges: [], exploited,
  };
}

function newsBase(it: PackItem): number {
  return it.alert ? Math.max(it.score, RANK_WEIGHTS.base.cert_alert) : it.score;
}

function newsReason(ctx: Ctx, it: PackItem): string {
  return it.alert ? "agency alert" : `news: ${ctx.feedName.get(it.feed_id) ?? it.feed_id}`;
}

function newsWork(ctx: Ctx, it: PackItem): Work {
  const c: Unscored = {
    id: it.id, kind: NEWS_KIND_HINT[it.coverage[0]!], reasons: [], title: wrapUntrusted(it.feed_id, it.title),
    cve_ids: [...it.cve_ids], vendor: null, vendor_country: null, product: null, cvss: null, epss: null, kev: null, ssvc: null,
    ai_credit_match: null, exploit_reference: false, release: null, record_url: null, advisory_urls: [], pack_ids: [it.id],
  };
  const reasons = it.alert ? ["agency alert", `news: ${ctx.feedName.get(it.feed_id) ?? it.feed_id}`] : [newsReason(ctx, it)];
  return {
    c, origin: "news", bases: [newsBase(it)], ownReasons: reasons, bonuses: new Set(), epss: null, newKev: false,
    date: it.published_at, texts: [it.title, it.snippet], matchIds: [], vendor: null, merges: [], exploited: false,
  };
}

// ── Merging (§5.12 step 3) ───────────────────────────────────────────────────────────────────────

const wordRes = new Map<string, RegExp>();

/** Whole words, any case: no letter or digit right before or after (works for Han and Kana as well). */
function hasWords(text: string, phrase: string): boolean {
  let re = wordRes.get(phrase);
  if (!re) {
    const esc = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "iu");
    wordRes.set(phrase, re);
  }
  return re.test(text);
}

/** How `text` (naming `ids`) matches a merge target: by CVE id, or vendor name or alias plus product for a single-CVE record candidate. */
function matches(w: Work, ids: ReadonlySet<string>, text: string): "CVE id" | "vendor and product" | null {
  if (w.matchIds.some((id) => ids.has(id))) return "CVE id";
  const product = w.c.product;
  if (w.origin === "record" && w.c.cve_ids.length === 1 && w.vendor && product && product.length >= PRODUCT_MIN && hasWords(text, product)
    && [w.vendor.name, ...w.vendor.aliases].some((n) => hasWords(text, n))) return "vendor and product";
  return null;
}

// ── Scoring (§5.12 step 4) ───────────────────────────────────────────────────────────────────────

function watchHit(w: Work, windows: readonly WatchWindow[]): WatchWindow | null {
  const texts = [...w.texts, ...w.merges.flatMap((m) => m.texts)].map((t) => t.toLowerCase());
  return windows.find((win) => win.search_terms.some((term) => texts.some((t) => t.includes(term.toLowerCase())))) ?? null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function scoreOf(w: Work, windows: readonly WatchWindow[]): number {
  const base = Math.max(0, ...w.bases, ...w.merges.map((m) => m.base));
  let bonus = 0;
  for (const k of w.bonuses) bonus += RANK_WEIGHTS.bonus[k];
  if (w.epss === "crossed") bonus += RANK_WEIGHTS.bonus.epss_crossed_99;
  else if (w.epss === "rose") bonus += RANK_WEIGHTS.bonus.epss_rose_010;
  if (watchHit(w, windows)) bonus += RANK_WEIGHTS.bonus.watch_window;
  return round1(base + bonus);
}

function reasonsOf(w: Work, windows: readonly WatchWindow[]): string[] {
  const out = [...w.ownReasons];
  for (const m of w.merges) if (!out.includes(m.reason)) out.push(m.reason);
  const hit = watchHit(w, windows);
  if (hit) out.push(`watch window: ${hit.id}`);
  return out;
}

function finish(ctx: Ctx, w: Work, windows: readonly WatchWindow[]): Unscored {
  const pack = [...new Set(w.c.pack_ids)].sort(byCodeUnit);
  const exploited = w.origin !== "release" && w.origin !== "news" && (w.exploited || w.merges.some((m) => m.exploited));
  return {
    ...w.c,
    kind: exploited ? "exploited_flaw" : w.c.kind,
    reasons: reasonsOf(w, windows),
    advisory_urls: w.release ? releaseUrls(ctx, w, pack) : packUrls(ctx, pack),
    pack_ids: pack,
  };
}

interface Built {
  ctx: Ctx;
  works: Work[];
  merges: CutEntry[];
  bundled: CutEntry[];
  log: RankLogEntry[];
}

function build(input: RankInput): Built {
  const ctx = context(input);
  const windows = input.config.watchWindows;
  const { byCve, alone } = criticalGhsa(ctx);
  const log: RankLogEntry[] = [];
  const merges: CutEntry[] = [];
  const bundled: CutEntry[] = [];

  if (input.kevSource === "recent-7-days") {
    log.push({ code: "KEV_INDEX_MISSING", detail: `No KEV index: new KEV is the entries added within 7 days of the cutoff (${input.newKevIds.length}).` });
  } else if (input.kevSource === "as-of") {
    log.push({ code: "KEV_ASOF_DRY_RUN", detail: `As-of dry run: the catalog cut to the day before ${input.date}; new KEV is that day's entries (${input.newKevIds.length}).` });
  }

  // Step 2 first, so bundled records do not also stand alone.
  const rels = bundles(ctx);
  const absorbed = new Set<string>();
  const apart = new Set<string>();
  const works: Work[] = [];
  for (const b of rels) {
    works.push(releaseWork(ctx, b));
    let kept = 0;
    for (const r of [...b.members].sort((x, y) => compareCveIds(x.cve_id, y.cve_id))) {
      const s = signals(ctx, r.cve_id, byCve);
      if (s.exploited || s.ai) {
        apart.add(r.cve_id);
        kept += 1;
        continue;
      }
      absorbed.add(r.cve_id);
      const solo = cveWork(ctx, r.cve_id, s);
      bundled.push({ id: solo.c.id, score: scoreOf(solo, windows), reason: `bundled:${b.releaseId}`, pack_ids: [...solo.c.pack_ids].sort(byCodeUnit), cve_ids: [r.cve_id] });
    }
    log.push({ code: "BUNDLED", detail: `${b.releaseId}: ${b.members.length} records bundled, ${b.exploited.length} exploited, ${kept} also kept as their own candidates.` });
  }

  // Step 1: one candidate per CVE id (bundled records only when exploited or AI-credited).
  const ids = new Set<string>([...ctx.newKev, ...ctx.recs.keys(), ...byCve.keys()]);
  const { e } = input.epss;
  if (e) {
    for (const id of e.scores.keys()) {
      const j = epssJump(e, input.epss.e1, id);
      if (j.crossed || j.rose) ids.add(id);
    }
  }
  for (const id of [...ids].sort(compareCveIds)) {
    if (absorbed.has(id)) continue;
    const s = signals(ctx, id, byCve);
    if (!s.candidate && !apart.has(id)) continue;
    works.push(cveWork(ctx, id, s));
  }
  for (const g of alone) works.push(ghsaWork(ctx, g));

  // Step 3: notes, then news, merge into record or release candidates; pre-merge scores pick the target.
  const pre = new Map<Work, number>(works.map((w) => [w, scoreOf(w, windows)]));
  const pick = (ids: ReadonlySet<string>, text: string) => {
    let best: { w: Work; how: string } | null = null;
    for (const w of works) {
      if (w.origin !== "record" && w.origin !== "release" && !(w.origin === "note" && w.matchIds.length)) continue;
      const how = matches(w, ids, text);
      if (!how) continue;
      if (!best || pre.get(w)! > pre.get(best.w)! || (pre.get(w) === pre.get(best.w) && byCodeUnit(w.c.id, best.w.c.id) < 0)) best = { w, how };
    }
    return best;
  };
  const notes = [...input.pack.records].filter((r) => NOTE_SOURCES.has(r.source)).sort((a, b) => byCodeUnit(a.id, b.id));
  for (const r of notes) {
    const text = `${r.title} ${r.text}`;
    const cves = [...new Set([...r.cve_ids, ...cveIdsIn(text)])];
    const target = pick(new Set(cves), text);
    const { base, reason } = noteBase(r);
    if (target) {
      const standalone = noteWork(ctx, r, r.id, cves);
      target.w.merges.push({ id: r.id, base, texts: [r.title, r.text], reason, exploited: standalone.exploited });
      target.w.c.pack_ids.push(r.id);
      merges.push({ id: r.id, score: scoreOf(standalone, windows), reason: `merged:${target.w.c.id}`, pack_ids: [r.id], cve_ids: [...r.cve_ids] });
      log.push({ code: "MERGED", detail: `${r.id} (${r.source}) merged into ${target.w.c.id} by ${target.how}.` });
      continue;
    }
    const w = noteWork(ctx, r, cves.length ? cves[0]!.toLowerCase() : r.id, cves);
    works.push(w);
    pre.set(w, scoreOf(w, windows));
  }
  for (const it of [...input.pack.items].sort((a, b) => byCodeUnit(a.id, b.id))) {
    const text = `${it.title} ${it.snippet}`;
    const target = pick(new Set(it.cve_ids), text);
    if (target) {
      target.w.merges.push({ id: it.id, base: newsBase(it), texts: [it.title, it.snippet], reason: newsReason(ctx, it), exploited: false });
      target.w.c.pack_ids.push(it.id);
      merges.push({ id: it.id, score: scoreOf(newsWork(ctx, it), windows), reason: `merged:${target.w.c.id}`, pack_ids: [it.id], cve_ids: [...it.cve_ids] });
      log.push({ code: "MERGED", detail: `${it.id} (${it.feed_id}) merged into ${target.w.c.id} by ${target.how}.` });
      continue;
    }
    works.push(newsWork(ctx, it));
  }
  return { ctx, works, merges, bundled, log };
}

/** Steps 1 to 3 of §5.12: record candidates, release bundles, notes and news merged in. */
export function buildCandidates(input: RankInput): {
  candidates: Omit<Candidate, "rank" | "score" | "deep_read">[];
  merges: CutEntry[];
  bundled: CutEntry[];
} {
  const b = build(input);
  return { candidates: b.works.map((w) => finish(b.ctx, w, input.config.watchWindows)), merges: b.merges, bundled: b.bundled };
}

/** Steps 1 to 6 of §5.12: the kept candidates, the cuts and the ranking log. */
export function rankCandidates(input: RankInput): { kept: Candidate[]; cut: CutEntry[]; log: RankLogEntry[]; ranked: number } {
  const b = build(input);
  const windows = input.config.watchWindows;
  const { candidates_max: cap, deep_read_max: deep } = input.config.loaded.run.budgets;
  const scored = b.works.map((w) => ({ w, c: finish(b.ctx, w, windows), score: scoreOf(w, windows) }));
  // Step 5: score descending, then the newest date (ISO strings), then id.
  scored.sort((x, y) => y.score - x.score || byCodeUnit(y.w.date, x.w.date) || byCodeUnit(x.c.id, y.c.id));
  const kevCount = scored.filter((s) => s.w.newKev).length;
  const log = [...b.log];
  if (kevCount > cap) log.push({ code: "CAP_KEV_OVERFLOW", detail: `${kevCount} new KEV candidates exceed the cap of ${cap}: all kept and nothing else.` });
  let slots = Math.max(0, cap - kevCount);
  const kept: Candidate[] = [];
  const cut: CutEntry[] = [...b.bundled, ...b.merges];
  for (const s of scored) {
    const keep = s.w.newKev || slots > 0;
    if (!keep) {
      cut.push({ id: s.c.id, score: s.score, reason: "below_cap", pack_ids: [...s.c.pack_ids], cve_ids: [...s.c.cve_ids] });
      continue;
    }
    if (!s.w.newKev) slots -= 1;
    const rank = kept.length + 1;
    kept.push({ rank, score: s.score, ...s.c, deep_read: rank <= deep });
  }
  return { kept, cut, log, ranked: scored.length };
}
