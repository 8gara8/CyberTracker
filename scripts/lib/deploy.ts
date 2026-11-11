// The deploy check (SPEC §8.2 stage 9): the run requests no build; it watches `${siteUrl()}/` until the
// `ct-edition` meta (§6) shows D and the edition, or the wait ends. A timeout is a note, not a failure.
// Every GET goes through the caller's fetchImpl (Deps.fetchImpl: the network probe, intake and this check
// are not feed reads, plan §5 G6), is cut at 15 s, and is read only for that one meta tag: the page is
// data. Times are measured on the caller's clock (Deps.now). The polling loop (a GET at once, then one
// every 20 s, each of at most 15 s) follows Europe's waitLive() in scripts/daily.ts. Owner: lane L6.

import { load } from "cheerio";
import run from "../../config/run.json";
import { isValidDate, taipeiTimestamp } from "../../lib/dates";
import { siteUrl as configuredSiteUrl } from "../../lib/site";
import { EDITIONS, type Edition } from "../../lib/vocab";
import { P3_LIMITS, type Clock } from "./clock";

export interface EditionMeta {
  date: string;
  edition: Edition;
  published_at: string;
}

/** An ISO timestamp with an offset or Z, as Brief.published_at is written (§4.1). */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * <meta name="ct-edition" content="DATE EDITION PUBLISHED_AT"> (§6): the first such meta in the page, its
 * three words separated by white space. Null when there is none, or when a word is not a real date, one
 * of EDITIONS or a timestamp.
 */
export function parseEditionMeta(html: string): EditionMeta | null {
  let content: string | undefined;
  try {
    const $ = load(html);
    content = $("meta").filter((_, el) => ($(el).attr("name") ?? "").trim().toLowerCase() === "ct-edition").first().attr("content");
  } catch {
    return null;
  }
  if (typeof content !== "string") return null;
  const words = content.trim().split(/\s+/);
  if (words.length !== 3) return null;
  const [date, edition, published] = words as [string, string, string];
  if (!isValidDate(date) || !(EDITIONS as readonly string[]).includes(edition) || !TIMESTAMP_RE.test(published)) return null;
  if (Number.isNaN(Date.parse(published))) return null;
  return { date, edition: edition as Edition, published_at: published };
}

export interface DeployCheck {
  ready_at: string | null;
  shows_date: string | null;
  shows_edition: Edition | null;
  shows: boolean;
}

/** The meta of one GET, or "error" when the request failed or passed getMs (no response to read). */
async function getOnce(url: string, fetchImpl: typeof fetch, getMs: number): Promise<EditionMeta | null | "error"> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cut = new Promise<"error">((resolve) => {
    timer = setTimeout(() => {
      ac.abort(new Error(`The site did not answer within ${getMs} ms.`));
      resolve("error");
    }, Math.max(0, getMs));
  });
  const read = (async () => {
    try {
      const res = await fetchImpl(url, {
        method: "GET", redirect: "follow", cache: "no-store", signal: ac.signal,
        headers: { Accept: "text/html", "User-Agent": run.user_agent },
      });
      // A 404 or a page without the meta is a response that shows nothing; it still counts as the last one.
      return parseEditionMeta(await res.text());
    } catch {
      return "error" as const;
    }
  })();
  try {
    return await Promise.race([read, cut]);
  } finally {
    clearTimeout(timer);
  }
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * GET `${siteUrl}/` at once, then every 20 s while time is left of maxMs (≤ 0: one GET only); each GET
 * ≤ 15 s via fetchImpl. Returns as soon as a response shows D and `edition`, with `ready_at` the time it
 * was seen. Otherwise, when the wait ends, `shows_date` and `shows_edition` come from the last response
 * that arrived (null when it carried no meta, or when none arrived) and `ready_at` is null. With `edition`
 * null (nothing for D on GitHub), the site matches when a response shows no edition for D: `shows` is
 * then true and `ready_at` stays null, since nothing became ready.
 */
export async function waitForEdition(date: string, edition: Edition | null, maxMs: number, o: {
  now: Clock; fetchImpl: typeof fetch; siteUrl?: string; pollMs?: number; getMs?: number; sleep?: (ms: number) => Promise<void>;
}): Promise<DeployCheck> {
  const url = `${(o.siteUrl ?? configuredSiteUrl()).replace(/\/+$/, "")}/`;
  const pollMs = Math.max(1, o.pollMs ?? P3_LIMITS.deployPollMs);
  const getMs = o.getMs ?? P3_LIMITS.deployGetMs;
  const sleep = o.sleep ?? realSleep;
  const end = o.now() + (Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 0);
  const once = !(Number.isFinite(maxMs) && maxMs > 0);
  let last: EditionMeta | null = null;
  const matches = (m: EditionMeta | null) => (edition === null ? m?.date !== date : m?.date === date && m.edition === edition);

  for (;;) {
    const r = await getOnce(url, o.fetchImpl, getMs);
    if (r !== "error") {
      last = r;
      if (matches(r)) {
        const readyAt = edition === null ? null : taipeiTimestamp(new Date(o.now()));
        return { ready_at: readyAt, shows_date: r?.date ?? null, shows_edition: r?.edition ?? null, shows: true };
      }
    }
    const left = end - o.now();
    if (once || left <= 0) break;
    await sleep(Math.min(pollMs, left));
  }
  return { ready_at: null, shows_date: last?.date ?? null, shows_edition: last?.edition ?? null, shows: false };
}
