// The impure readers of scripts/lib/feeds.ts (SPEC §8.3) against an in-memory fetcher and a temporary
// cache: what each reads, what it keeps in cache/, and what it returns when a URL fails, answers older
// data or leaves a file behind. Nothing here touches the network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cachePaths } from "@/lib/feeds/cache";
import { fetchBudget, type FetchResult } from "@/lib/feeds/http";
import type { FetchedFeed } from "@/lib/schema/registry";
import { readRss, type FeedCtx } from "@/scripts/lib/feeds";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FEEDS = path.join(ROOT, "fixtures", "feeds");
const read = (rel: string) => fs.readFileSync(path.join(FEEDS, rel));

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** An answer: a body (status 200), an HTTP status without a body, or an error class. */
type Answer = Buffer | number | "timeout";

/** A FeedCtx over a fresh temporary root whose fetcher answers from `answers` (anything else is a dns error); `fetched` lists every URL asked. */
function harness(answers: Record<string, Answer>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-readers-"));
  roots.push(root);
  const fetched: string[] = [];
  const log: string[] = [];
  const fetch = async (url: string): Promise<FetchResult> => {
    fetched.push(url);
    const a = answers[url];
    const base = { finalUrl: url, detail: null, durationMs: 1, attempts: 1 };
    if (a === undefined) return { ...base, ok: false, status: null, body: null, contentType: null, error: "dns" };
    if (a === "timeout") return { ...base, ok: false, status: null, body: null, contentType: null, error: "timeout" };
    if (typeof a === "number") return { ...base, ok: false, status: a, body: null, contentType: "text/html", error: `http_${a}` };
    return { ...base, ok: true, status: 200, body: a, contentType: url.endsWith(".json") ? "application/json" : "application/xml", error: null };
  };
  const ctx: FeedCtx = {
    fetch: fetch as FeedCtx["fetch"], budget: fetchBudget(240_000), deadline: Date.now() + 60_000, now: Date.now,
    log: (l) => log.push(l), paths: cachePaths(root), sleep: async () => {},
  };
  return { root, ctx, fetched, log, paths: ctx.paths };
}

/** A registry entry of `kind` with every key written out. */
function entry(over: Partial<FetchedFeed> & Pick<FetchedFeed, "id" | "kind" | "url">): FetchedFeed {
  return {
    name: over.id, fallback_url: null, language: "en", region: "GLOBAL", coverage: ["exploits"], priority: 2, fresh_days: 2,
    must_match: false, date_zone: null, ...over,
  };
}

describe("readRss", () => {
  it("reads zone-less dates in the entry's date_zone (iThome, +08:00), the same in sources:check and collect", async () => {
    const url = "https://www.ithome.com.tw/ct-sample/rss";
    const h = harness({ [url]: read("rss/format-ithome.xml") });
    const taipei = await readRss(entry({ id: "ithome-security", kind: "rss", url, region: "TW", date_zone: "+08:00" }), h.ctx);
    expect(taipei.ok).toBe(true);
    expect(taipei.data!.items.map((i) => i.published_at)).toEqual(["2026-10-13T04:11:50.000Z", "2026-10-13T10:12:00.000Z"]);
    expect(taipei.data!.newest).toBe("2026-10-13T10:12:00.000Z");
    const utc = await readRss(entry({ id: "ithome-security", kind: "rss", url, date_zone: null }), h.ctx);
    expect(utc.data!.newest).toBe("2026-10-13T18:12:00.000Z");
  });
});
