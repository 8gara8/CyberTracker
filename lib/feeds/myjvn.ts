// MyJVN (JVN iPedia, SPEC §4.13, §8.3): the getVulnOverviewList answer, an RSS 1.0 (RDF) document with
// `sec:`, `dc:`, `dcterms:` and `status:` namespaces, read with cheerio in XML mode. The same reader takes
// JVN iPedia's plain RDF feed (jvndb_new.rdf, the same item shape without `status:Status`), which Kobol
// found answering while the API path did not (2026-11-09); the registry decides which URL is read.

import { load } from "cheerio";
import { sha256Hex } from "../json";
import { recordInstant } from "./cvelist";
import { FeedParseError, type JvnNote, type Parsed } from "./types";

const CVE_GLOBAL_RE = /CVE-\d{4}-\d{4,}/gi;
const DEFAULT_PAGE = 50;
const DEFAULT_MAX_PAGES = 10;

/** The CVSS of an item: the Base metric of the newest version given (4.0, then 3.x, then 2.0). */
function cvssOf(entries: { score: string | undefined; version: string | undefined; type: string | undefined }[]): JvnNote["cvss"] {
  const rank = (v: string) => (v.startsWith("4") ? 3 : v.startsWith("3") ? 2 : v.startsWith("2") ? 1 : 0);
  let best: { score: number; version: string } | null = null;
  for (const e of entries) {
    if (e.type && e.type.toLowerCase() !== "base") continue;
    const score = Number(e.score);
    const version = (e.version ?? "").trim();
    if (!Number.isFinite(score) || score < 0 || score > 10 || version === "") continue;
    if (best === null || rank(version) > rank(best.version)) best = { score, version };
  }
  return best;
}

/**
 * One MyJVN page (or the RDF feed), with `status:Status` totalRes and totalResRet (both the item count
 * when the document has no status). `newest` is the latest dcterms:issued (dc:date when an item has none);
 * `cve_ids` come from `sec:references` with source CVE and from CVE ids in their text, upper case. Not XML
 * or not RDF is "parse"; a MyJVN error status (retCd other than 0) is "schema".
 */
export function parseMyJvn(body: Buffer): Parsed<JvnNote> & { totalRes: number; totalResRet: number } {
  const text = body.toString("utf8").replace(/^﻿/, "");
  let $: ReturnType<typeof load>;
  try {
    $ = load(text, { xml: true });
  } catch (e) {
    throw new FeedParseError("parse", `MyJVN: ${(e as Error).message}`);
  }
  if ($("rdf\\:RDF").length === 0) throw new FeedParseError("parse", "MyJVN: not an RDF document");
  const status = $("status\\:Status").first();
  const retCd = status.attr("retCd");
  if (status.length && retCd !== undefined && retCd.trim() !== "0") {
    throw new FeedParseError("schema", `MyJVN: error status ${retCd.trim()}`);
  }
  const notes: JvnNote[] = [];
  let newest: string | null = null;
  $("item").each((_, el) => {
    const item = $(el);
    const id = item.children("sec\\:identifier").first().text().trim();
    const link = item.children("link").first().text().trim() || (item.attr("rdf:about") ?? "").trim();
    if (!id || !link) return;
    const ids: string[] = [];
    item.children("sec\\:references").each((__, r) => {
      const ref = $(r);
      const source = (ref.attr("source") ?? "").toUpperCase();
      for (const candidate of [source === "CVE" ? ref.attr("id") ?? "" : "", ref.text()]) {
        for (const m of candidate.match(CVE_GLOBAL_RE) ?? []) {
          const cve = m.toUpperCase();
          if (!ids.includes(cve)) ids.push(cve);
        }
      }
    });
    const cvss = cvssOf(item.children("sec\\:cvss").toArray().map((c) => ({
      score: $(c).attr("score"), version: $(c).attr("version"), type: $(c).attr("type"),
    })));
    const issued = recordInstant(item.children("dcterms\\:issued").first().text().trim());
    const modified = recordInstant(item.children("dcterms\\:modified").first().text().trim());
    const dcDate = recordInstant(item.children("dc\\:date").first().text().trim());
    const stamp = issued ?? dcDate;
    if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
    notes.push({
      id,
      title: item.children("title").first().text(),
      link,
      description: item.children("description").first().text(),
      cve_ids: ids,
      cvss,
      issued,
      modified,
    });
  });
  const count = (name: string) => {
    const v = Number(status.attr(name));
    return status.length && Number.isInteger(v) && v >= 0 ? v : notes.length;
  };
  return {
    newest,
    entries: notes,
    version: null,
    sha256: sha256Hex(body),
    total: notes.length,
    totalRes: count("totalRes"),
    totalResRet: count("totalResRet"),
  };
}

/**
 * The page URLs of a MyJVN query (startItem 1, 51, 101 … to totalRes, the page size from maxCountItem,
 * default 50), at most `maxPages` (default 10), the first page included. A URL without a startItem
 * parameter (the RDF feed) is one page.
 */
export function myjvnPageUrls(registryUrl: string, totalRes: number, maxPages: number = DEFAULT_MAX_PAGES): string[] {
  const u = new URL(registryUrl);
  if (!u.searchParams.has("startItem")) return [registryUrl];
  const size = Number(u.searchParams.get("maxCountItem")) || DEFAULT_PAGE;
  const pages = Math.max(1, Math.min(maxPages, Math.ceil(Math.max(0, totalRes) / size)));
  const out: string[] = [];
  for (let p = 0; p < pages; p++) {
    u.searchParams.set("startItem", String(p * size + 1));
    out.push(u.toString());
  }
  return out;
}
