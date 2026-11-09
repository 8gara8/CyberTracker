// RSS and Atom feeds (SPEC §4.13, §8.3), and the CERT notes read from them: TWCERT's TVN feed and
// JPCERT's. The harness (rssParser, feedDate, zoneOf, rssItems) is the fork base's lib/collect.ts,
// adapted: Google News <source> handling is gone, the RDF channel's dc:date and Atom's <updated> are read,
// and dates in "YYYY-MM-DD HH:mm" form or with a named European or Asian zone parse. A date without a zone
// takes the channel's own offset, else UTC, never the machine's zone. Every string is raw feed data.

import Parser from "rss-parser";
import { sha256Hex } from "../json";
import { normalizeUrl } from "../urls";
import { FeedParseError, type CertNote, type Parsed, type RawItem } from "./types";

/** rss-parser set up for the registry's feeds: the RDF channel's dc:date, and the Atom-style <updated> some items carry. */
export function rssParser(): Parser {
  return new Parser({
    customFields: {
      feed: ["dc:date", "updated"],
      item: ["a10:updated", "atom:updated", "updated", "dc:date"],
    },
  });
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Zone names seen on registry feeds (cert-eu writes CEST) and their neighbours, as numeric offsets. */
const NAMED_ZONES: Readonly<Record<string, string>> = {
  CET: "+0100", CEST: "+0200", MEZ: "+0100", MESZ: "+0200", EET: "+0200", EEST: "+0300", WET: "+0000", WEST: "+0100",
  BST: "+0100", JST: "+0900", KST: "+0900", HKT: "+0800", SGT: "+0800",
};
const NAMED_ZONE_RE = new RegExp(`\\s(${Object.keys(NAMED_ZONES).join("|")})$`, "i");
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2}|\b(?:GMT|UTC|UT|[ECMP][SD]T))$/i;

/**
 * A feed's date as an ISO timestamp, or null. A date without a zone takes `zone` (an offset like "+09:00",
 * default UTC), because Date.parse would read it as the machine's local time. Also reads "YYYY-MM-DD HH:mm"
 * (iThome), a two-digit-year "26-10-30 17:50", a bare date and a named zone such as CEST.
 */
export function feedDate(raw: string | undefined, zone = "Z"): string | null {
  let s = raw === undefined ? "" : squash(raw);
  if (!s) return null;
  const named = NAMED_ZONE_RE.exec(s);
  if (named) s = `${s.slice(0, named.index)} ${NAMED_ZONES[named[1]!.toUpperCase()]}`;
  const short = /^(\d{2})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
  if (short) s = `20${short[1]}-${short[2]}-${short[3]}T${short[4]}:${short[5]}:00`;
  const spaced = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(.*)$/.exec(s);
  if (spaced) s = `${spaced[1]}T${spaced[2]}${spaced[3]!.replace(/^ /, "")}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00:00";
  if (!HAS_ZONE.test(s)) s = /^\d{4}-\d{2}-\d{2}T/.test(s) ? `${s}${zone}` : `${s} ${zone === "Z" ? "GMT" : zone.replace(":", "")}`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** The UTC offset a channel's own date is written in ("+09:00"), so its items' zone-less dates can use it; "Z" otherwise. */
export function zoneOf(date: string | undefined): string {
  const s = squash(date ?? "");
  const named = NAMED_ZONE_RE.exec(s);
  const offset = named ? NAMED_ZONES[named[1]!.toUpperCase()]! : s;
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(offset);
  return m ? `${m[1]}${m[2]}:${m[3]}` : "Z";
}

/** What rssItems() reads from an rss-parser result. */
export interface RssParsed {
  pubDate?: string;
  lastBuildDate?: string;
  "dc:date"?: string;
  updated?: string;
  items?: {
    title?: string; link?: string; pubDate?: string; date?: string; "dc:date"?: string; updated?: string;
    "a10:updated"?: string; "atom:updated"?: string; contentSnippet?: string; summary?: string;
  }[];
}

/** Items from an rss-parser result: a title and a link each, the first readable date, the plain-text snippet. */
export function rssItems(parsed: RssParsed): RawItem[] {
  const zone = zoneOf(parsed.pubDate ?? parsed.lastBuildDate ?? parsed["dc:date"] ?? parsed.updated);
  return (parsed.items ?? []).flatMap((i) => {
    const title = typeof i.title === "string" ? squash(i.title) : "";
    const url = typeof i.link === "string" ? i.link.trim() : "";
    if (!title || !url) return [];
    const published_at = [i.pubDate, i.date, i["dc:date"], i.updated, i["a10:updated"], i["atom:updated"]]
      .map((d) => (typeof d === "string" ? feedDate(d, zone) : null)).find((d) => d !== null) ?? null;
    const snippet = typeof i.contentSnippet === "string" ? i.contentSnippet : typeof i.summary === "string" ? i.summary : "";
    return [{ title, url, published_at, snippet: squash(snippet) }];
  });
}

/**
 * One RSS 2.0, RSS 1.0 (RDF) or Atom body. `newest` is the latest item date; a feed with items but no
 * readable dates has `newest` null (sources:check's NODATE). Anything rss-parser cannot read is "parse".
 */
export async function parseRss(body: Buffer): Promise<Parsed<RawItem>> {
  let parsed: RssParsed;
  try {
    parsed = (await rssParser().parseString(body.toString("utf8").replace(/^﻿/, ""))) as unknown as RssParsed;
  } catch (e) {
    throw new FeedParseError("parse", `RSS: ${(e as Error).message.slice(0, 200)}`);
  }
  const entries = rssItems(parsed);
  let newest: string | null = null;
  for (const it of entries) if (it.published_at !== null && (newest === null || it.published_at > newest)) newest = it.published_at;
  return { newest, entries, version: null, sha256: sha256Hex(body), total: entries.length };
}

const CVE_GLOBAL_RE = /CVE-\d{4}-\d{4,}/gi;
const TVN_RE = /TVN-\d{9}/i;

/** Upper-case CVE ids in `text`, unique, first-seen order. */
function cveIdsOf(...texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) for (const m of t.match(CVE_GLOBAL_RE) ?? []) if (!out.includes(m.toUpperCase())) out.push(m.toUpperCase());
  return out;
}

/**
 * TWCERT TVN notes: one per item, its id the first TVN-\d{9} in the title, snippet or link (upper case),
 * else the item's normalised link; CVE ids from title and snippet. TVN notes are never alerts.
 */
export function tvnRecords(items: readonly RawItem[]): CertNote[] {
  return items.map((it) => {
    const tvn = TVN_RE.exec(`${it.title} ${it.snippet} ${it.url}`);
    return {
      id: tvn ? tvn[0].toUpperCase() : normalizeUrl(it.url),
      title: it.title,
      url: it.url,
      text: it.snippet,
      published_at: it.published_at,
      cve_ids: cveIdsOf(it.title, it.snippet),
      alert: false,
    };
  });
}

/**
 * JPCERT notes: one per item, its id the link's last path segment without the extension (at260031,
 * wr264101), else the normalised link; `alert` when the normalised link matches one of Japan's
 * alert_patterns (compiled by the caller, flags "iu" as lib/regions.ts does).
 */
export function jpcertRecords(items: readonly RawItem[], alertRes: readonly RegExp[]): CertNote[] {
  return items.map((it) => {
    const norm = normalizeUrl(it.url);
    let id = norm;
    try {
      const last = new URL(it.url).pathname.split("/").filter((p) => p !== "").pop() ?? "";
      const stem = last.replace(/\.[a-z0-9]+$/i, "");
      if (stem) id = stem;
    } catch {
      // keep the normalised link
    }
    return {
      id,
      title: it.title,
      url: it.url,
      text: it.snippet,
      published_at: it.published_at,
      cve_ids: cveIdsOf(it.title, it.snippet),
      alert: alertRes.some((re) => re.test(norm)),
    };
  });
}
