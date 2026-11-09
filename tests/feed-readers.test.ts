// The impure readers of scripts/lib/feeds.ts (SPEC §8.3) against an in-memory fetcher and a temporary
// cache: what each reads, what it keeps in cache/, and what it returns when a URL fails, answers older
// data or leaves a file behind. Nothing here touches the network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cvdPayloadUrl } from "@/lib/feeds/anthropic-cvd";
import { cachePaths } from "@/lib/feeds/cache";
import { epssUrlFor } from "@/lib/feeds/epss";
import { endOfDayAsset } from "@/lib/feeds/github";
import { fetchBudget, type FetchResult } from "@/lib/feeds/http";
import { sha256Hex } from "@/lib/json";
import type { FetchedFeed } from "@/lib/schema/registry";
import { cacheWrite, readCvd, readEpss, readKev, readRss, readZip, type FeedCtx } from "@/scripts/lib/feeds";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FEEDS = path.join(ROOT, "fixtures", "feeds");
const read = (rel: string) => fs.readFileSync(path.join(FEEDS, rel));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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

// ── The disclosure dashboard (A3) ────────────────────────────────────────────────────────────────

describe("readCvd: a payload left by an earlier run", () => {
  const cvd = entry({ id: "anthropic-cvd", kind: "anthropic-cvd", url: "https://red.anthropic.com/2026/cvd/", coverage: ["ai"] });
  const payloadUrl = cvdPayloadUrl(cvd.url);
  const page37 = read("anthropic-cvd/page.html");
  const payload37 = read("anthropic-cvd/payload.json");
  const page40 = Buffer.from(page37.toString("utf8").replace("Revision 37", "Revision 40").replace("2026-10-13 19:30", "2026-11-02 19:30"));

  it("is removed when today's payload is not read, so only today's page is in cache/", async () => {
    const h = harness({ [cvd.url]: page37, [payloadUrl]: payload37 });
    const first = await readCvd(cvd, h.ctx);
    expect([first.ok, first.data?.revision, first.data?.found_n]).toEqual([true, "37", expect.any(Number)]);
    const payloadFile = h.paths.feedBody("anthropic-cvd", "payload.json");
    expect(fs.readFileSync(payloadFile)).toEqual(payload37);

    const today = harness({ [cvd.url]: page40, [payloadUrl]: "timeout" });
    const second = await readCvd(cvd, { ...today.ctx, paths: h.paths });
    expect([second.ok, second.data?.revision, second.data?.as_of, second.data?.found_n]).toEqual([true, "40", "2026-11-02", null]);
    expect(second.sha256).toBe(sha256Hex(page40));
    expect(fs.existsSync(payloadFile)).toBe(false);
    expect(fs.readFileSync(h.paths.feedBody("anthropic-cvd", "html"))).toEqual(page40);
    expect(today.log.join("\n")).toMatch(/no payload at data\/payload\.json; reading the page alone/);
  });

  it("is removed when the payload answers an HTTP error too, and kept when it answers", async () => {
    const h = harness({ [cvd.url]: page37, [payloadUrl]: payload37 });
    await readCvd(cvd, h.ctx);
    const payloadFile = h.paths.feedBody("anthropic-cvd", "payload.json");
    await readCvd(cvd, { ...harness({ [cvd.url]: page40, [payloadUrl]: 404 }).ctx, paths: h.paths });
    expect(fs.existsSync(payloadFile)).toBe(false);
    const again = await readCvd(cvd, { ...harness({ [cvd.url]: page37, [payloadUrl]: payload37 }).ctx, paths: h.paths });
    expect([again.sha256, fs.readFileSync(payloadFile).equals(payload37)]).toEqual([sha256Hex(payload37), true]);
  });

  it("is left alone past the deadline, when collect writes and removes nothing", async () => {
    const h = harness({ [cvd.url]: page37, [payloadUrl]: payload37 });
    await readCvd(cvd, h.ctx);
    const late = harness({ [cvd.url]: page40, [payloadUrl]: "timeout" });
    await readCvd(cvd, { ...late.ctx, paths: h.paths, deadline: Date.now() - 1 });
    expect(fs.readFileSync(h.paths.feedBody("anthropic-cvd", "payload.json"))).toEqual(payload37);
    expect(fs.readFileSync(h.paths.feedBody("anthropic-cvd", "html"))).toEqual(page37);
  });
});

// ── KEV (A4, A5) ─────────────────────────────────────────────────────────────────────────────────

describe("readKev: a catalog older than kev-index, and what is cached", () => {
  const kev = entry({
    id: "kev", kind: "kev", url: "https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json",
    fallback_url: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", region: "US", priority: 1, fresh_days: 7,
  });
  const v13 = read("kev/known_exploited_vulnerabilities.json"); // catalogVersion 2026.10.13
  const withVersion = (version: string) => {
    const c = JSON.parse(v13.toString("utf8")) as Record<string, unknown>;
    return Buffer.from(JSON.stringify({ ...c, catalogVersion: version }));
  };
  const v12 = withVersion("2026.10.12");
  const v14 = withVersion("2026.10.14");
  const html = Buffer.from("<!DOCTYPE html><html><body>SAMPLE challenge page</body></html>");
  const kevFile = (h: ReturnType<typeof harness>) => h.paths.feedBody("kev", "json");

  it("fails schema when only an older catalog answers (the fallback timed out), logs both versions and caches nothing", async () => {
    const h = harness({ [kev.url]: v12, [kev.fallback_url!]: "timeout" });
    const r = await readKev(kev, h.ctx, { sha: null, minVersion: "2026.10.13" });
    expect(r).toMatchObject({ ok: false, error: "schema", data: null, urlUsed: kev.url, triedFallback: true, fallbackUsed: false, sha256: null });
    expect(h.log).toContain("KEV: only catalog 2026.10.12 answered, older than kev-index 2026.10.13");
    expect(h.fetched).toEqual([kev.url, kev.fallback_url]);
    expect(fs.existsSync(kevFile(h))).toBe(false);
  });

  it("fails schema when the fallback alone answers, older (the mirror failed), and when both answer older", async () => {
    const mirrorDown = harness({ [kev.url]: 503, [kev.fallback_url!]: v12 });
    const a = await readKev(kev, mirrorDown.ctx, { sha: null, minVersion: "2026.10.13" });
    expect([a.ok, a.error, a.urlUsed]).toEqual([false, "schema", kev.fallback_url]);
    expect(mirrorDown.log).toContain("KEV: only catalog 2026.10.12 answered, older than kev-index 2026.10.13");
    const both = harness({ [kev.url]: v12, [kev.fallback_url!]: v12 });
    const b = await readKev(kev, both.ctx, { sha: null, minVersion: "2026.10.13" });
    expect([b.ok, b.error]).toEqual([false, "schema"]);
    expect(fs.existsSync(kevFile(both))).toBe(false);
  });

  it("takes the fallback when it is current, and caches only that body", async () => {
    const h = harness({ [kev.url]: v12, [kev.fallback_url!]: v14 });
    const r = await readKev(kev, h.ctx, { sha: null, minVersion: "2026.10.13" });
    expect(r).toMatchObject({ ok: true, error: null, urlUsed: kev.fallback_url, triedFallback: true, fallbackUsed: true, sha256: sha256Hex(v14) });
    expect(r.data!.catalogVersion).toBe("2026.10.14");
    expect(fs.readFileSync(kevFile(h))).toEqual(v14);
  });

  it("an equal catalog is current; without a kev-index any catalog is (sources:check)", async () => {
    const same = harness({ [kev.url]: v13 });
    expect((await readKev(kev, same.ctx, { sha: null, minVersion: "2026.10.13" })).ok).toBe(true);
    expect(same.fetched).toEqual([kev.url]);
    const none = harness({ [kev.url]: v12 });
    expect((await readKev(kev, none.ctx, { sha: null, minVersion: null })).data?.catalogVersion).toBe("2026.10.12");
  });

  it("never caches a body it refused or could not parse: the older mirror plus an HTML fallback leave yesterday's kev.json", async () => {
    const h = harness({ [kev.url]: v12, [kev.fallback_url!]: html });
    fs.mkdirSync(path.dirname(kevFile(h)), { recursive: true });
    fs.writeFileSync(kevFile(h), v13);
    const r = await readKev(kev, h.ctx, { sha: null, minVersion: "2026.10.13" });
    expect([r.ok, r.error]).toEqual([false, "schema"]);
    expect(fs.readFileSync(kevFile(h))).toEqual(v13);
    const down = harness({ [kev.url]: "timeout", [kev.fallback_url!]: html });
    const d = await readKev(kev, { ...down.ctx, paths: h.paths }, { sha: null, minVersion: null });
    expect([d.ok, d.error]).toEqual([false, "parse"]);
    expect(fs.readFileSync(kevFile(h))).toEqual(v13);
  });
});

describe("readRss: a body that does not parse is not cached", () => {
  it("keeps the earlier cached body when today's answer is garbage", async () => {
    const url = "https://www.example.com/ct-sample/feed.xml";
    const feed = entry({ id: "sample-feed", kind: "rss", url });
    const good = read("rss/zoneless.xml");
    const h = harness({ [url]: good });
    expect((await readRss(feed, h.ctx)).ok).toBe(true);
    const file = h.paths.feedBody("sample-feed", "xml");
    expect(fs.readFileSync(file)).toEqual(good);
    const bad = await readRss(feed, { ...harness({ [url]: read("rss/garbage.xml") }).ctx, paths: h.paths });
    expect([bad.ok, bad.error]).toEqual([false, "parse"]);
    expect(fs.readFileSync(file)).toEqual(good);
  });
});

