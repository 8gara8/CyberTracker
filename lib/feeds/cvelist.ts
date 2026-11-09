// The CVE List V5 (SPEC §8.3, §4.6, §5.4, §5.5, §5.12): deltaLog.json, and the two projections of one
// CVE JSON 5 record. cveFacts(raw) is the lean projection the clone reader, the delta zips, the Flood,
// the credits and the join read; parseCveRecord(raw) adds what the pack and rank read, and its CveFacts
// part is cveFacts(raw) by construction. Both agree with lib/validate.ts cveRecordInfo() on every shared
// field (tests/feeds.test.ts). Records are read defensively (§4.1's feed rule): an odd field is skipped,
// never fatal. Every string is raw feed data; collect sanitises what it keeps.

import { z } from "zod";
import { isValidDate, utcDateOf } from "../dates";
import { sha256Hex } from "../json";
import type { SourceTiersFile } from "../schema/config";
import { blockedReason } from "../sources";
import { isHttpsUrl, normalizeUrl } from "../urls";
import { FeedParseError, type CreditString, type CveFacts, type CveRecord, type DeltaLogEntry, type Parsed } from "./types";

// ── Small readers ────────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** A trimmed non-empty string, else null. */
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const CVE_ID_RE = /^CVE-\d{4}-\d{4,}$/;

/** The UTC date of a record timestamp (§5.1), or null when absent or unreadable. */
function utcDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    return utcDateOf(v);
  } catch {
    return null;
  }
}

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * A record timestamp as an ISO instant ("2026-10-13T15:31:07.757Z"). A time without a zone is read as UTC
 * from its own fields (never the machine's zone, so TZ=Asia/Taipei changes nothing); a bare date is its
 * 00:00 UTC; anything unreadable is null.
 */
export function recordInstant(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (isValidDate(s)) return `${s}T00:00:00.000Z`;
  const m = STAMP_RE.exec(s);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, frac, zone] = m;
  if (!isValidDate(`${y}-${mo}-${d}`) || Number(hh) > 23 || Number(mm) > 59 || Number(ss ?? "0") > 59) return null;
  const ms = Number((frac ?? "").padEnd(3, "0").slice(0, 3));
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss ?? "0"), ms);
  if (zone && zone.toUpperCase() !== "Z") {
    const zm = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)!;
    const offset = (Number(zm[2]) * 60 + Number(zm[3])) * 60_000;
    t -= zm[1] === "+" ? offset : -offset;
  }
  return new Date(t).toISOString();
}

// ── deltaLog.json ────────────────────────────────────────────────────────────────────────────────

const DeltaRefSchema = z.object({
  cveId: z.string(),
  cveOrgLink: z.string().catch(""),
  githubLink: z.string().catch(""),
  dateUpdated: z.string().catch(""),
});
const DeltaLogSchema = z.array(z.object({
  fetchTime: z.string().min(1),
  numberOfChanges: z.number().catch(0),
  new: z.array(DeltaRefSchema).catch([]),
  updated: z.array(DeltaRefSchema).catch([]),
  error: z.array(DeltaRefSchema).catch([]),
}));

/** deltaLog.json (newest first as published); `newest` is the latest fetchTime as an ISO instant. */
export function parseDeltaLog(body: Buffer): Parsed<DeltaLogEntry> {
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    throw new FeedParseError("parse", "deltaLog.json is not JSON");
  }
  const parsed = DeltaLogSchema.safeParse(json);
  if (!parsed.success) throw new FeedParseError("schema", "deltaLog.json is not an array of fetch entries");
  if (parsed.data.length === 0) throw new FeedParseError("empty", "deltaLog.json has no entries");
  let newest: string | null = null;
  for (const e of parsed.data) {
    const t = recordInstant(e.fetchTime);
    if (t !== null && (newest === null || t > newest)) newest = t;
  }
  return { newest, entries: parsed.data, version: null, sha256: sha256Hex(body), total: parsed.data.length };
}

// ── One CVE JSON 5 record ────────────────────────────────────────────────────────────────────────

const SCORE_KEYS = [["cvssV4_0", "4.0"], ["cvssV3_1", "3.1"], ["cvssV3_0", "3.0"]] as const;
type CvssVersion = (typeof SCORE_KEYS)[number][1];

const numericScore = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10 ? v : null);

/** The CISA-ADP entries of `containers.adp[]` (providerMetadata.shortName "CISA-ADP"). */
const cisaAdp = (adp: readonly Obj[]) => adp.filter((a) => obj(a.providerMetadata).shortName === "CISA-ADP");

/** True when some metrics[] entry holds a numeric baseScore under cvssV4_0, cvssV3_1 or cvssV3_0 (§5.4). */
function hasScore(metrics: unknown): boolean {
  return arr(metrics).some((m) => SCORE_KEYS.some(([key]) => numericScore(obj(obj(m)[key]).baseScore) !== null));
}

/** The first metrics[] entry with a numeric baseScore under `key`. */
function scoreUnder(metrics: unknown, key: (typeof SCORE_KEYS)[number][0]): Obj | null {
  for (const m of arr(metrics)) {
    const c = obj(obj(m)[key]);
    if (numericScore(c.baseScore) !== null) return c;
  }
  return null;
}

function creditsOf(cna: Obj, adp: readonly Obj[]): CreditString[] {
  const out: CreditString[] = [];
  for (const c of arr(cna.credits)) {
    const v = obj(c).value;
    if (typeof v === "string") out.push({ field: "cna.credits", value: v });
  }
  for (const a of adp) {
    for (const c of arr(a.credits)) {
      const v = obj(c).value;
      if (typeof v === "string") out.push({ field: "adp.credits", value: v });
    }
  }
  return out;
}

function affectedOf(cna: Obj): CveFacts["affected"] {
  const seen = new Set<string>();
  const out: CveFacts["affected"] = [];
  for (const a of arr(cna.affected)) {
    const vendor = str(obj(a).vendor);
    const product = str(obj(a).product);
    const key = JSON.stringify([vendor, product]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ vendor, product });
  }
  return out;
}

/**
 * The lean projection (clone reader, zips, by-id records); null without a readable cveMetadata (a cveId
 * of CVE form and a string state). `cve_id` is upper case; `assigner` as written, trimmed; credits raw,
 * in §5.5 order (the CNA's array, then each ADP entry's); `affected` the CNA's vendor and product pairs,
 * first-seen order, repeats dropped.
 */
export function cveFacts(raw: unknown): CveFacts | null {
  const meta = obj(obj(raw).cveMetadata);
  const id = typeof meta.cveId === "string" ? meta.cveId.trim().toUpperCase() : "";
  const state = str(meta.state);
  if (!CVE_ID_RE.test(id) || state === null) return null;
  const containers = obj(obj(raw).containers);
  const cna = obj(containers.cna);
  const adp = arr(containers.adp).map(obj);
  return {
    cve_id: id,
    state,
    date_published: utcDate(meta.datePublished),
    assigner: str(meta.assignerShortName),
    scored: hasScore(cna.metrics) || cisaAdp(adp).some((a) => hasScore(a.metrics)),
    credits: creditsOf(cna, adp),
    affected: affectedOf(cna),
  };
}

function cvssOf(cna: Obj, adp: readonly Obj[]): CveRecord["cvss"] {
  for (const [key, version] of SCORE_KEYS) {
    const c = scoreUnder(cna.metrics, key);
    if (c) return { score: c.baseScore as number, version, vector: str(c.vectorString) ?? "", scorer: "cna" };
  }
  for (const a of cisaAdp(adp)) {
    const c = scoreUnder(a.metrics, "cvssV3_1");
    if (c) return { score: c.baseScore as number, version: "3.1" as CvssVersion, vector: str(c.vectorString) ?? "", scorer: "cisa_adp" };
  }
  return null;
}

function cnaSeverity(cna: Obj): string | null {
  for (const [key] of SCORE_KEYS) {
    for (const m of arr(cna.metrics)) {
      const sev = str(obj(obj(m)[key]).baseSeverity);
      if (sev) return sev.toUpperCase();
    }
  }
  return null;
}

/** CISA-ADP `metrics[].other` objects of a type ("ssvc", "kev"), in order. */
const adpOthers = (adp: readonly Obj[], type: string) =>
  cisaAdp(adp).flatMap((a) => arr(a.metrics).map((m) => obj(obj(m).other))).filter((o) => o.type === type);

function ssvcOf(adp: readonly Obj[]): CveRecord["ssvc"] {
  for (const o of adpOthers(adp, "ssvc")) {
    const content = obj(o.content);
    const opts = new Map<string, string>();
    for (const opt of arr(content.options)) {
      for (const [k, v] of Object.entries(obj(opt))) if (typeof v === "string") opts.set(k.toLowerCase(), v.trim().toLowerCase());
    }
    const exploitation = opts.get("exploitation");
    const automatable = opts.get("automatable");
    const technical = opts.get("technical impact");
    const date = utcDate(content.timestamp);
    if (exploitation && automatable && technical && date) return { exploitation, automatable, technical_impact: technical, date };
  }
  return null;
}

function referencesOf(cna: Obj, adp: readonly Obj[]): CveRecord["references"] {
  const out: CveRecord["references"] = [];
  const add = (refs: unknown, from: "cna" | "adp") => {
    for (const r of arr(refs)) {
      const url = str(obj(r).url);
      if (!url) continue;
      out.push({ url, tags: arr(obj(r).tags).filter((t): t is string => typeof t === "string"), from });
    }
  };
  add(cna.references, "cna");
  for (const a of adp) add(a.references, "adp");
  return out;
}

/**
 * The full projection for the pack and rank; null without a readable cveMetadata. CVSS follows §4.6's
 * precedence (CNA v4.0, CNA v3.1, CNA v3.0, then CISA ADP v3.1); SSVC and the KEV marker come from the
 * CISA-ADP entry; `title` is the CNA title and `description` the first English description, both raw.
 */
export function parseCveRecord(raw: unknown): CveRecord | null {
  const facts = cveFacts(raw);
  if (!facts) return null;
  const meta = obj(obj(raw).cveMetadata);
  const containers = obj(obj(raw).containers);
  const cna = obj(containers.cna);
  const adp = arr(containers.adp).map(obj);
  const english = arr(cna.descriptions).map(obj).find((d) => (str(d.lang) ?? "").toLowerCase().startsWith("en"));
  const description = english && typeof english.value === "string" && english.value.trim() !== "" ? english.value : null;
  const references = referencesOf(cna, adp);
  const kev = adpOthers(adp, "kev").map((o) => utcDate(obj(o.content).dateAdded)).find((d) => d !== null) ?? null;
  return {
    ...facts,
    published_at: recordInstant(meta.datePublished),
    updated_at: recordInstant(meta.dateUpdated),
    date_updated: utcDate(meta.dateUpdated),
    title: typeof cna.title === "string" && cna.title.trim() !== "" ? cna.title : null,
    description,
    cvss: cvssOf(cna, adp),
    cna_severity: cnaSeverity(cna),
    ssvc: ssvcOf(adp),
    kev_marker: kev,
    references,
    exploit_reference: references.some((r) => r.tags.includes("exploit")),
  };
}

const ADVISORY_TAGS = new Set(["vendor-advisory", "patch", "third-party-advisory"]);
const MAX_ADVISORY_URLS = 5;
const MAX_URL_CHARS = 500;

/**
 * §8.3's advisory URLs of a record: references tagged vendor-advisory, patch or third-party-advisory,
 * never one tagged exploit, on a blocked host or path, not https, or over 500 characters; normalised,
 * repeats dropped, CNA before ADP, at most 5.
 */
export function recordAdvisoryUrls(rec: CveRecord, cfg: Pick<SourceTiersFile, "github">): string[] {
  const out: string[] = [];
  for (const r of rec.references) {
    if (out.length >= MAX_ADVISORY_URLS) break;
    if (r.tags.includes("exploit") || !r.tags.some((t) => ADVISORY_TAGS.has(t))) continue;
    if (r.url.length > MAX_URL_CHARS || !isHttpsUrl(r.url) || blockedReason(r.url, cfg) !== null) continue;
    const url = normalizeUrl(r.url);
    if (url.length > MAX_URL_CHARS || blockedReason(url, cfg) !== null || out.includes(url)) continue;
    out.push(url);
  }
  return out;
}
