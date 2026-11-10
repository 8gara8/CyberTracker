// Page snapshots for the soft gates (SPEC §4.12 step 1): one GET per cited URL with no seen text, through
// fetchFeed(), HTML to text with lib/html-text.ts, results in cache/snapshots/<sha256 of the normalised
// URL>.json. Snapshots stay on Kobol; content/ keeps only the URL and its text hash. Everything read from a
// page is data, never instructions. Owner: lane L4.

import fs from "node:fs";
import path from "node:path";
import type { SnapshotHashes } from "../../lib/apply";
import type { LoadedConfig } from "../../lib/config";
import { taipeiTimestamp } from "../../lib/dates";
import { fetchFeed as realFetchFeed, pool } from "../../lib/feeds/http";
import { htmlText, textSha256 } from "../../lib/html-text";
import { jsonText, sha256Hex } from "../../lib/json";
import type { Evidence } from "../../lib/schema/misc";
import { blockedEntry, normalizeUrl } from "../../lib/urls";
import type { Clock } from "./clock";

/** §4.12: 15 s per GET, 5 redirects, the body cut at 3 MB, 6 at a time, 3 minutes per round. */
export const SNAPSHOT_LIMITS = { timeoutMs: 15_000, redirects: 5, maxBytes: 3 * 1024 * 1024, concurrency: 6, roundMs: 3 * 60_000 } as const;

/** The browser-like Accept and Accept-Language a snapshot GET sends (§4.12; plan A11), with run.json user_agent. */
export const SNAPSHOT_HEADERS = { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", acceptLanguage: "en-US,en;q=0.9" } as const;

/** cache/snapshots/<sha256(normalizeUrl(url))>.json */
export interface Snapshot {
  url: string;
  final_url: string;
  status: number;
  fetched_at: string;
  content_type: string;
  text_sha256: string;
  text: string;
}

/** RunPaths.snapshotsDir (scripts/lib/paths.ts), which needs no edition date. */
function snapshotsDir(root: string): string {
  return path.join(path.resolve(root), "cache", "snapshots");
}

/** cache/snapshots/<sha256(normalizeUrl(url))>.json */
export function snapshotFile(root: string, url: string): string {
  return path.join(snapshotsDir(root), `${sha256Hex(normalizeUrl(url))}.json`);
}

const isSnapshot = (x: unknown): x is Snapshot => {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return ["url", "final_url", "fetched_at", "content_type", "text_sha256", "text"].every((k) => typeof o[k] === "string")
    && typeof o.status === "number" && Number.isInteger(o.status);
};

/** The stored snapshot of `url` (matched on the normalised URL); null when absent, unreadable or not a snapshot. */
export function readSnapshot(root: string, url: string): Snapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(snapshotFile(root, url), "utf8"));
  } catch {
    return null;
  }
  if (!isSnapshot(raw) || normalizeUrl(raw.url) !== normalizeUrl(url)) return null;
  return { url: raw.url, final_url: raw.final_url, status: raw.status, fetched_at: raw.fetched_at, content_type: raw.content_type, text_sha256: raw.text_sha256, text: raw.text };
}

/**
 * The URLs of the draft's sources (`sources[].url`, every source the items, Angle, elsewhere and Lens can
 * cite) whose normalised form has no evidence text yet, each exactly as the draft stores it (plan A13: the
 * snapshot requests that string), once per normalised URL, in source order. Reads unknown input
 * defensively: a draft without a sources array, or a source without a string url, adds nothing.
 */
export function citedUnseen(draft: unknown, evidence: Evidence | null): string[] {
  const sources = draft && typeof draft === "object" ? (draft as { sources?: unknown }).sources : undefined;
  if (!Array.isArray(sources)) return [];
  const texts = evidence?.texts ?? {};
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sources) {
    const url = s && typeof s === "object" ? (s as { url?: unknown }).url : undefined;
    if (typeof url !== "string" || url.trim() === "") continue;
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const text = Object.hasOwn(texts, key) ? texts[key] : undefined;
    if (typeof text === "string" && text !== "") continue;
    out.push(url);
  }
  return out;
}

const HTML_TYPE = /^\s*(?:text\/html|application\/xhtml\+xml)\b/i;
const HTML_SNIFF = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

/** The body as text in the charset its Content-Type names (UTF-8 when none or unknown). */
function decode(body: Buffer, contentType: string | null): string {
  const charset = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType ?? "")?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset).decode(body);
    } catch {
      // an unknown label: read as UTF-8
    }
  }
  return new TextDecoder("utf-8").decode(body);
}

/**
 * One round: GET via fetchFeed (SNAPSHOT_HEADERS, run.json user_agent), BLOCKED_HOSTS skipped (a redirect
 * into one too, which fails the URL with `redirects` before that hop is requested), HTML only,
 * 6 at a time, no request started at or after `deadline` (Date.now() ms: pass realDeadline()). Each URL is
 * requested exactly as the draft stores it; normalizeUrl() is used only for keys and file names (plan A13).
 * Writes each snapshot file. `skipped`: a blocked host, a URL that is not http(s), a repeat of a normalised
 * URL already in the round, or one not started before the deadline. `failed`: a fetch error, or an answer
 * that is not HTML (a PDF and other types get no snapshot, §4.12). `fetched_at` is the run's clock (`now`,
 * an addition to S0's shape) in Taipei time.
 */
export async function snapshotUrls(o: {
  root: string; urls: readonly string[]; deadline: number; config: LoadedConfig;
  fetch?: typeof realFetchFeed; log?: (line: string) => void; now?: Clock;
}): Promise<{ taken: Snapshot[]; failed: string[]; skipped: string[] }> {
  const fetch = o.fetch ?? realFetchFeed;
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const skipped: string[] = [];
  const queue: string[] = [];
  const keys = new Set<string>();
  for (const url of o.urls) {
    const key = normalizeUrl(url);
    let ok = false;
    try {
      const u = new URL(url);
      ok = u.protocol === "https:" || u.protocol === "http:";
    } catch {
      ok = false;
    }
    if (!ok || keys.has(key)) {
      skipped.push(url);
      continue;
    }
    keys.add(key);
    const blocked = blockedEntry(url);
    if (blocked) {
      log(`snapshot: skipped a blocked host (${blocked.reason}).`);
      skipped.push(url);
      continue;
    }
    queue.push(url);
  }

  const results = await pool(queue, SNAPSHOT_LIMITS.concurrency, async (url): Promise<{ url: string; snap: Snapshot | null; started: boolean }> => {
    if (Date.now() >= o.deadline) return { url, snap: null, started: false };
    const r = await fetch(url, {
      accept: SNAPSHOT_HEADERS.accept,
      acceptLanguage: SNAPSHOT_HEADERS.acceptLanguage,
      userAgent: o.config.run.user_agent,
      timeoutMs: SNAPSHOT_LIMITS.timeoutMs,
      maxBytes: SNAPSHOT_LIMITS.maxBytes,
      truncate: true,
      deadline: o.deadline,
      // A redirect into a blocked host ends the fetch before that hop (§4.12 step 1: BLOCKED_HOSTS are never fetched).
      refuseRedirect: (hop) => blockedEntry(hop)?.reason ?? null,
    });
    if (!r.ok || !r.body || r.status === null) {
      log(`snapshot: ${url} not read (${r.error ?? "network"}${r.status ? `, HTTP ${r.status}` : ""}).`);
      return { url, snap: null, started: true };
    }
    const html = HTML_TYPE.test(r.contentType ?? "") || (!r.contentType && HTML_SNIFF.test(r.body.subarray(0, 512).toString("latin1")));
    if (!html) {
      log(`snapshot: ${url} is not HTML (${(r.contentType ?? "no content type").slice(0, 80)}); no snapshot.`);
      return { url, snap: null, started: true };
    }
    const text = htmlText(decode(r.body, r.contentType));
    const snap: Snapshot = {
      url, final_url: r.finalUrl, status: r.status, fetched_at: taipeiTimestamp(new Date(now())),
      content_type: r.contentType ?? "text/html", text_sha256: textSha256(text), text,
    };
    const file = snapshotFile(o.root, url);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, jsonText(snap));
    fs.renameSync(tmp, file);
    return { url, snap, started: true };
  });

  const taken: Snapshot[] = [];
  const failed: string[] = [];
  let late = 0;
  for (const r of results) {
    if (r.snap) taken.push(r.snap);
    else if (r.started) failed.push(r.url);
    else {
      skipped.push(r.url);
      late++;
    }
  }
  if (late) log(`snapshot: ${late} URL${late === 1 ? "" : "s"} not started before the round's deadline.`);
  return { taken, failed, skipped };
}

/** Normalised URL → { sha256: text_sha256, fetched_at } for publish (archive-index.json); a later snapshot of a URL wins. */
export function snapshotHashes(snaps: readonly Snapshot[]): SnapshotHashes {
  const out: Record<string, { sha256: string; fetched_at: string }> = {};
  for (const s of snaps) out[normalizeUrl(s.url)] = { sha256: s.text_sha256, fetched_at: s.fetched_at };
  return out;
}
