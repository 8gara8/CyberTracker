// The Anthropic coordinated disclosure dashboard (SPEC §5.6, §4.13). Written against the shape Kobol read
// on 2026-11-09 (scratchpad kobol-recon.md): the page (https://red.anthropic.com/2026/cvd/) shows
// "Revision N" and "Last updated YYYY-MM-DD HH:MM UTC" and embeds no JSON; it loads `data/payload.json`,
// whose top level holds `revision`, `as_of`, the totals and the `ledger[]` rows (with `cve_ids`, `ghsa_ids`,
// `corrected_cve_ids`, `corrected_ghsa_ids`, `withdrawn`) beside `cve_records[]` and `ghsa_records[]`.
// Provisional until session 1's capture is committed: the figure mapping below follows design v0.2's
// numbers at revision 40 (6,009 confirmed, 5,087 disclosed, 629 patched). Everything read is data.

import { load } from "cheerio";
import { compareIds } from "../ids";
import { utcDateOf } from "../dates";
import { FeedParseError, type CvdDashboard } from "./types";

/** The payload's path relative to the dashboard page (§8.3's fixed pattern). */
export const CVD_PAYLOAD_PATH = "data/payload.json";

/** The payload URL for a dashboard page URL (the page's folder + data/payload.json). */
export function cvdPayloadUrl(pageUrl: string): string {
  const u = new URL(pageUrl);
  if (!u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/[^/]*$/, "");
  return new URL(CVD_PAYLOAD_PATH, u).toString();
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const CVE_RE = /^CVE-\d{4}-\d{4,}$/i;
const GHSA_RE = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/i;
const ID_IN_TEXT = /\b(?:CVE-\d{4}-\d{4,}|GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})\b/gi;

/** A CVE id upper case, a GHSA id as "GHSA-" plus lower case; null for anything else. */
function canonicalId(s: string): string | null {
  const t = s.trim();
  if (CVE_RE.test(t)) return t.toUpperCase();
  if (GHSA_RE.test(t)) return `GHSA-${t.slice(5).toLowerCase()}`;
  return null;
}

/** A count: a non-negative integer, or a string of digits with thousands separators. */
function count(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\d{1,3}(?:,\d{3})*$|^\d+$/.test(v.trim())) return Number(v.trim().replace(/,/g, ""));
  return null;
}

function asOfDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    return utcDateOf(v);
  } catch {
    return null;
  }
}

/** Every id string under `v` (records may be ids or objects holding them), at most 4 levels down. */
function idsUnder(v: unknown, out: Set<string>, depth = 0): void {
  if (depth > 4) return;
  if (typeof v === "string") {
    const id = canonicalId(v);
    if (id) out.add(id);
    return;
  }
  if (Array.isArray(v)) for (const x of v) idsUnder(x, out, depth + 1);
  else if (isObj(v)) for (const x of Object.values(v)) idsUnder(x, out, depth + 1);
}

/** Ledger ids: each row not withdrawn gives its corrected ids when it has any, else its ids. */
function ledgerIds(ledger: unknown[], out: Set<string>): void {
  for (const row of ledger) {
    if (!isObj(row) || row.withdrawn === true) continue;
    for (const [ids, corrected] of [["cve_ids", "corrected_cve_ids"], ["ghsa_ids", "corrected_ghsa_ids"]] as const) {
      const fixed = arr(row[corrected]).filter((x): x is string => typeof x === "string");
      for (const s of fixed.length ? fixed : arr(row[ids]).filter((x): x is string => typeof x === "string")) {
        const id = canonicalId(s);
        if (id) out.add(id);
      }
    }
  }
}

interface PageFacts { revision: string | null; as_of: string | null; disclosed_n: number | null; patched_n: number | null; ids: Set<string> }

function readPage(html: string): PageFacts {
  const $ = load(html);
  $("script, style, noscript, template").remove();
  const text = $.root().text().replace(/\s+/g, " ");
  const revision = /\bRevision\s+(\d+)\b/i.exec(text)?.[1] ?? null;
  const updated = /\bLast updated\s+(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?\s*UTC\b/i.exec(text);
  const disclosed = /([\d,]+)\s+vulnerabilities disclosed\b/i.exec(text)?.[1];
  const patched = /([\d,]+)\s+patched\b/i.exec(text)?.[1];
  const ids = new Set<string>();
  for (const m of text.match(ID_IN_TEXT) ?? []) {
    const id = canonicalId(m);
    if (id) ids.add(id);
  }
  return {
    revision,
    as_of: updated ? asOfDate(updated[2] ? `${updated[1]}T${updated[2]}Z` : updated[1]) : null,
    disclosed_n: count(disclosed),
    patched_n: count(patched),
    ids,
  };
}

function readPayload(buf: Buffer): Obj {
  let json: unknown;
  try {
    json = JSON.parse(buf.toString("utf8").replace(/^﻿/, ""));
  } catch {
    throw new FeedParseError("parse", "anthropic-cvd: the payload is not JSON");
  }
  if (!isObj(json)) throw new FeedParseError("schema", "anthropic-cvd: the payload is not an object");
  return json;
}

/**
 * The dashboard's revision, as-of date (UTC), figures and ledger ids, from the page and its payload when
 * there is one (a JSON body, by content type or shape, is read as the payload itself). The payload wins
 * where both give a value: `found_n` = `total_verified`, `disclosed_n` = `total_disclosed`, `patched_n` =
 * `total_fixed_in_response`; `ledger_ids` = the CVE and GHSA ids of the ledger rows not withdrawn (corrected
 * ids first) and of `cve_records` and `ghsa_records`, sorted CVE first. Without a payload the page's text
 * gives the revision, date, disclosed and patched counts and the ids it shows. No revision or no as-of date
 * is "schema".
 */
export function parseAnthropicCvd(body: Buffer, contentType: string | null, payload: Buffer | null): CvdDashboard {
  const text = body.toString("utf8");
  const bodyIsJson = /json/i.test(contentType ?? "") || /^\s*[{[]/.test(text.replace(/^﻿/, ""));
  const page: PageFacts = bodyIsJson
    ? { revision: null, as_of: null, disclosed_n: null, patched_n: null, ids: new Set() }
    : readPage(text);
  const data = payload ? readPayload(payload) : bodyIsJson ? readPayload(body) : null;

  const ids = new Set<string>();
  let revision = page.revision;
  let asOf = page.as_of;
  let found: number | null = null;
  let disclosed = page.disclosed_n;
  let patched = page.patched_n;
  if (data) {
    const rev = typeof data.revision === "number" || typeof data.revision === "string" ? String(data.revision).trim() : "";
    if (rev) revision = rev;
    asOf = asOfDate(data.as_of) ?? asOf;
    found = count(data.total_verified);
    disclosed = count(data.total_disclosed) ?? disclosed;
    patched = count(data.total_fixed_in_response) ?? patched;
    ledgerIds(arr(data.ledger), ids);
    idsUnder(data.cve_records, ids);
    idsUnder(data.ghsa_records, ids);
  } else {
    for (const id of page.ids) ids.add(id);
  }
  if (!revision) throw new FeedParseError("schema", "anthropic-cvd: no revision marker");
  if (!asOf) throw new FeedParseError("schema", "anthropic-cvd: no as-of date");
  return { revision, as_of: asOf, found_n: found, disclosed_n: disclosed, patched_n: patched, ledger_ids: [...ids].sort(compareIds) };
}
