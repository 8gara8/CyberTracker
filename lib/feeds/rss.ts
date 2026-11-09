// RSS and Atom feeds (SPEC §4.13, §8.3), and the CERT notes read from them: TWCERT's TVN feed and
// JPCERT's. The harness (rssParser, feedDate, zoneOf, rssItems) is the fork base's lib/collect.ts,
// adapted: Google News <source> handling is gone, the RDF channel's dc:date and Atom's raw <published> and
// <updated> are read, and dates in "YYYY-MM-DD HH:mm" form or with a named European or Asian zone parse. A date without a zone
// takes the channel's own offset, else the registry entry's `date_zone`, else UTC, never the machine's
// zone. Every string is raw feed data.

import Parser from "rss-parser";
import { sha256Hex } from "../json";
import { normalizeUrl } from "../urls";
import { FeedParseError, type CertNote, type Parsed, type RawItem } from "./types";

/**
 * Atom's <published> and <updated> (and the <updated> some RSS items carry) under names rss-parser does not
 * know, so it never turns them into dates itself: it would read a zone-less one in the machine's zone and
 * throw on one it cannot read, failing the whole feed. rssItems() reads the raw strings through feedDate().
 */
const RAW_PUBLISHED = "raw-published";
const RAW_UPDATED = "raw-updated";
const rawDateTag = (name: string): string => (name === "published" ? RAW_PUBLISHED : name === "updated" ? RAW_UPDATED : name);

/** rss-parser set up for the registry's feeds: the RDF channel's dc:date, and Atom's raw <published> and <updated>. */
export function rssParser(): Parser {
  return new Parser({
    customFields: {
      feed: ["dc:date", RAW_UPDATED],
      item: ["a10:updated", "atom:updated", RAW_PUBLISHED, RAW_UPDATED, "dc:date"],
    },
    xml2js: { tagNameProcessors: [rawDateTag] },
  });
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** An element's text: a string as is, xml2js's { _: text } for an element with attributes, else undefined. */
function textOf(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v !== null && typeof v === "object" && typeof (v as { _?: unknown })._ === "string") return (v as { _: string })._;
  return undefined;
}

/** Zone names seen on registry feeds (cert-eu writes CEST) and their neighbours, as numeric offsets. */
const NAMED_ZONES: Readonly<Record<string, string>> = {
  CET: "+0100", CEST: "+0200", MEZ: "+0100", MESZ: "+0200", EET: "+0200", EEST: "+0300", WET: "+0000", WEST: "+0100",
  BST: "+0100", JST: "+0900", KST: "+0900", HKT: "+0800", SGT: "+0800",
};
const NAMED_ZONE_RE = new RegExp(`\\s(${Object.keys(NAMED_ZONES).join("|")})$`, "i");
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2}|\b(?:GMT|UTC|UT|[ECMP][SD]T))$/i;

/** Date.parse's legacy reader takes "Tuesday +0900" for the year 900, so a date outside these years is no date. */
const YEARS = { from: 1990, to: 2100 } as const;

/**
 * A feed's date as an ISO timestamp, or null. A date without a zone takes `zone` (an offset like "+09:00",
 * default UTC), because Date.parse would read it as the machine's local time. Also reads "YYYY-MM-DD HH:mm"
 * (iThome), a two-digit-year "26-10-30 17:50", a bare date and a named zone such as CEST. Text without a
 * digit, or a year outside 1990 to 2100, is null.
 */
export function feedDate(raw: string | undefined, zone = "Z"): string | null {
  let s = typeof raw === "string" ? squash(raw) : "";
  if (!/\d/.test(s)) return null;
  const named = NAMED_ZONE_RE.exec(s);
  if (named) s = `${s.slice(0, named.index)} ${NAMED_ZONES[named[1]!.toUpperCase()]}`;
  const short = /^(\d{2})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
  if (short) s = `20${short[1]}-${short[2]}-${short[3]}T${short[4]}:${short[5]}:00`;
  const spaced = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(.*)$/.exec(s);
  if (spaced) s = `${spaced[1]}T${spaced[2]}${spaced[3]!.replace(/^ /, "")}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00:00";
  if (!HAS_ZONE.test(s)) s = /^\d{4}-\d{2}-\d{2}T/.test(s) ? `${s}${zone}` : `${s} ${zone === "Z" ? "GMT" : zone.replace(":", "")}`;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const year = new Date(t).getUTCFullYear();
  return year < YEARS.from || year > YEARS.to ? null : new Date(t).toISOString();
}

/** The UTC offset a channel's own date is written in ("+09:00"), so its items' zone-less dates can use it; "Z" otherwise. */
export function zoneOf(date: string | undefined): string {
  const s = typeof date === "string" ? squash(date) : "";
  const named = NAMED_ZONE_RE.exec(s);
  const offset = named ? NAMED_ZONES[named[1]!.toUpperCase()]! : s;
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(offset);
  return m ? `${m[1]}${m[2]}:${m[3]}` : "Z";
}

/**
 * What rssItems() reads from an rss-parser result. Values are unknown: an element with attributes comes
 * back as an object, and feed data is never trusted to be a string.
 */
export interface RssParsed {
  pubDate?: unknown;
  lastBuildDate?: unknown;
  "dc:date"?: unknown;
  "raw-updated"?: unknown;
  items?: {
    title?: unknown; link?: unknown; pubDate?: unknown; date?: unknown; "dc:date"?: unknown; "raw-published"?: unknown;
    "raw-updated"?: unknown; "a10:updated"?: unknown; "atom:updated"?: unknown; contentSnippet?: unknown; summary?: unknown;
  }[];
}

/** True when a date string ends in a zone: an offset, Z, GMT, UTC, a US zone or one of NAMED_ZONES. */
function hasZone(date: string): boolean {
  const s = squash(date);
  return HAS_ZONE.test(s) || NAMED_ZONE_RE.test(s);
}

/**
 * The zone for an item's zone-less dates: the channel date's own offset when it writes one (zoneOf), else
 * `dateZone` (the registry entry's `date_zone`, "+08:00"), else UTC.
 */
export function itemZone(channelDate: string | undefined, dateZone: string | null = null): string {
  if (typeof channelDate === "string" && hasZone(channelDate)) return zoneOf(channelDate);
  return dateZone ?? "Z";
}

/**
 * Items from an rss-parser result: a title and a link each, the first readable date, the plain-text snippet.
 * `dateZone` is the registry entry's `date_zone`, used only when the channel's date writes no zone.
 */
export function rssItems(parsed: RssParsed, dateZone: string | null = null): RawItem[] {
  const channelDate = [parsed.pubDate, parsed.lastBuildDate, parsed["dc:date"], parsed["raw-updated"]].map(textOf).find((d) => d !== undefined);
  const zone = itemZone(channelDate, dateZone);
  return (Array.isArray(parsed.items) ? parsed.items : []).flatMap((i) => {
    const title = typeof i.title === "string" ? squash(i.title) : "";
    const url = typeof i.link === "string" ? i.link.trim() : "";
    if (!title || !url) return [];
    // The first date that reads: an unreadable one is skipped, never the item or the feed.
    const published_at = [i.pubDate, i["raw-published"], i.date, i["dc:date"], i["raw-updated"], i["a10:updated"], i["atom:updated"]]
      .map((d) => feedDate(textOf(d), zone)).find((d) => d !== null) ?? null;
    const snippet = typeof i.contentSnippet === "string" ? i.contentSnippet : typeof i.summary === "string" ? i.summary : "";
    return [{ title, url, published_at, snippet: squash(snippet) }];
  });
}

/**
 * One RSS 2.0, RSS 1.0 (RDF) or Atom body. `newest` is the latest item date; a feed with items but no
 * readable dates has `newest` null (sources:check's NODATE). Anything rss-parser cannot read is "parse".
 * `dateZone` is the registry entry's `date_zone` (rssItems).
 */
export async function parseRss(body: Buffer, dateZone: string | null = null): Promise<Parsed<RawItem>> {
  let parsed: RssParsed;
  try {
    parsed = (await rssParser().parseString(body.toString("utf8").replace(/^﻿/, ""))) as unknown as RssParsed;
  } catch (e) {
    throw new FeedParseError("parse", `RSS: ${(e as Error).message.slice(0, 200)}`);
  }
  const entries = rssItems(parsed, dateZone);
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
