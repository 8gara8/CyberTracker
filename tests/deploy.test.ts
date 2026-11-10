// The deploy check (scripts/lib/deploy.ts; SPEC §8.2 stage 9, §6's ct-edition meta; plan §2.7). DP1 to DP5
// of the plan. Every GET goes to an injected fetchImpl (the harness router in DP1), never the network; the
// wait runs on a test clock whose sleep jumps it, so no case waits 20 s for real.

import { afterEach, describe, expect, it, vi } from "vitest";
import { at } from "@/lib/dates";
import { siteUrl } from "@/lib/site";
import type { Edition } from "@/lib/vocab";
import { P3_LIMITS, testClock } from "@/scripts/lib/clock";
import { parseEditionMeta, waitForEdition, type EditionMeta } from "@/scripts/lib/deploy";
import { inRoot, makeHarness, type Harness } from "./helpers/harness";

const D = "2026-10-14";
const SITE = siteUrl();

const page = (meta: string | null) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${meta ?? ""}<title>CyberTracker</title></head><body><p>SAMPLE</p></body></html>`;
const metaTag = (m: EditionMeta) => `<meta name="ct-edition" content="${m.date} ${m.edition} ${m.published_at}">`;
const shown = (edition: Edition, date = D): EditionMeta => ({ date, edition, published_at: `${date}T05:07:44+08:00` });

/** A fetch that answers each GET with the next item: a meta, null (a 200 page with no meta), 404, or "throw". */
function scripted(answers: (EditionMeta | null | 404 | "throw")[]) {
  const calls: { url: string; method: string; signal: AbortSignal | null }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", signal: init?.signal ?? null });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a === "throw") throw new TypeError("fetch failed");
    if (a === 404) return new Response("Not found", { status: 404 });
    return new Response(page(a ? metaTag(a) : null), { status: 200, headers: { "Content-Type": "text/html" } });
  }) as typeof fetch;
  return { impl, calls };
}

function clockAt(hhmm: string) {
  const clock = testClock(at(D, hhmm));
  return { clock, sleep: async (ms: number) => clock.jump(ms) };
}

let h: Harness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
  vi.useRealTimers();
});

describe("waitForEdition", () => {
  it("DP1 sees D and the edition: returns at that GET with ready_at set and shows true", async () => {
    const { clock, sleep } = clockAt("05:08");
    const t0 = clock();
    const { impl, calls } = scripted([404, shown("data_only"), shown("full")]);
    const d = await waitForEdition(D, "full", 8 * 60_000, { now: clock, fetchImpl: impl, sleep });
    expect(d).toMatchObject({ shows: true, shows_date: D, shows_edition: "full" });
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.url === `${SITE}/` && c.method === "GET" && c.signal !== null)).toBe(true);
    const ready = Date.parse(d.ready_at!);
    expect(ready).toBeGreaterThanOrEqual(t0 + 40_000 - 1_000);
    expect(ready).toBeLessThan(t0 + 40_000 + 5_000);
    expect(d.ready_at).toMatch(/^2026-10-14T05:08:\d\d\+08:00$/);
  });

  it("DP1 against the harness router: the site's meta for D, and a 404 before any brief", async () => {
    h = makeHarness();
    const harness = h;
    await inRoot(harness, async () => {
      harness.site(shown("partial"));
      expect(await waitForEdition(D, "partial", 0, { now: harness.clock, fetchImpl: harness.deps.fetchImpl })).toMatchObject({
        shows: true, shows_date: D, shows_edition: "partial" });
      harness.site("from-remote");   // no briefs/D.json on the remote: 404
      expect(await waitForEdition(D, "data_only", 0, { now: harness.clock, fetchImpl: harness.deps.fetchImpl })).toEqual({
        ready_at: null, shows_date: null, shows_edition: null, shows: false });
    });
    expect(harness.requests().filter((r) => r.url === `${SITE}/`)).toHaveLength(2);
  });

  it("DP2 a wrong edition until the end: shows false, the last response's fields filled, a GET every 20 s and one at the end", async () => {
    const { clock, sleep } = clockAt("05:10");
    const { impl, calls } = scripted([shown("full", "2026-10-13"), shown("data_only")]);
    const d = await waitForEdition(D, "full", 60_000, { now: clock, fetchImpl: impl, sleep });
    expect(d).toEqual({ ready_at: null, shows_date: D, shows_edition: "data_only", shows: false });
    expect(calls).toHaveLength(4);   // at 0, 20, 40 and 60 s

    // A last GET that fails leaves the fields of the last response that arrived.
    const c2 = clockAt("05:10");
    const s2 = scripted([shown("data_only"), "throw"]);
    expect(await waitForEdition(D, "full", 30_000, { now: c2.clock, fetchImpl: s2.impl, sleep: c2.sleep })).toEqual({
      ready_at: null, shows_date: D, shows_edition: "data_only", shows: false });
    expect(s2.calls).toHaveLength(3);   // at 0, 20 and 30 s
    // A page without the meta is a response that shows nothing.
    const c3 = clockAt("05:10");
    expect(await waitForEdition(D, "full", 20_000, { now: c3.clock, fetchImpl: scripted([shown("data_only"), null]).impl, sleep: c3.sleep }))
      .toEqual({ ready_at: null, shows_date: null, shows_edition: null, shows: false });
  });

  it("DP3 maxMs 0 (or less, or not a number) makes one GET only", async () => {
    for (const maxMs of [0, -5_000, Number.NaN]) {
      const { clock, sleep } = clockAt("05:28");
      const slept: number[] = [];
      const { impl, calls } = scripted([shown("data_only")]);
      const d = await waitForEdition(D, "full", maxMs, { now: clock, fetchImpl: impl, sleep: async (ms) => { slept.push(ms); await sleep(ms); } });
      expect(calls, String(maxMs)).toHaveLength(1);
      expect(slept).toEqual([]);
      expect(d).toEqual({ ready_at: null, shows_date: D, shows_edition: "data_only", shows: false });
    }
    // With nothing published for D (edition null), a site that shows another day matches it; one claiming D does not.
    const { clock } = clockAt("05:28");
    expect(await waitForEdition(D, null, 0, { now: clock, fetchImpl: scripted([shown("full", "2026-10-13")]).impl })).toEqual({
      ready_at: null, shows_date: "2026-10-13", shows_edition: "full", shows: true });
    expect(await waitForEdition(D, null, 0, { now: clock, fetchImpl: scripted([404]).impl })).toMatchObject({ shows: true, shows_date: null });
    expect(await waitForEdition(D, null, 0, { now: clock, fetchImpl: scripted([shown("data_only")]).impl })).toMatchObject({ shows: false });
  });

  it("DP4 each GET is cut at 15 s: the request is aborted and the wait goes on", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null = null;
    let calls = 0;
    const hang = ((_: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      signal = init?.signal ?? null;
      return new Promise<Response>(() => {});   // never answers, and ignores the signal
    }) as typeof fetch;
    const now = () => at(D, "05:12");
    let done = false;
    const p = waitForEdition(D, "full", 0, { now, fetchImpl: hang }).then((d) => { done = true; return d; });
    await vi.advanceTimersByTimeAsync(P3_LIMITS.deployGetMs - 1);
    expect(done).toBe(false);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(signal!.aborted).toBe(true);
    expect(calls).toBe(1);
    expect(await p).toEqual({ ready_at: null, shows_date: null, shows_edition: null, shows: false });
    expect(P3_LIMITS.deployGetMs).toBe(15_000);
    expect(P3_LIMITS.deployPollMs).toBe(20_000);
  });

  it("DP4 a cut GET is followed by the next poll, with the default 20 s between GETs", async () => {
    vi.useFakeTimers();
    let t = at(D, "05:12");
    const now = () => t;
    let calls = 0;
    const fetchImpl = ((_: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return new Promise<Response>(() => {});
      expect(init?.signal?.aborted).toBe(false);
      return Promise.resolve(new Response(page(metaTag(shown("full"))), { status: 200 }));
    }) as typeof fetch;
    const p = waitForEdition(D, "full", 120_000, {
      now, fetchImpl, sleep: async (ms) => { t += ms; await new Promise((r) => setTimeout(r, ms)); },
    });
    await vi.advanceTimersByTimeAsync(15_000);   // the first GET is cut
    t += 15_000;
    await vi.advanceTimersByTimeAsync(20_000);   // the poll interval
    const d = await p;
    expect(calls).toBe(2);
    expect(d).toMatchObject({ shows: true, shows_edition: "full" });
  });
});

describe("parseEditionMeta", () => {
  it("DP5 reads the ct-edition meta in its variants and refuses malformed ones", () => {
    const want = { date: D, edition: "full", published_at: "2026-10-14T05:07:44+08:00" };
    expect(parseEditionMeta(page(metaTag(shown("full"))))).toEqual(want);
    // Attribute order, quotes, case of the name, extra white space, the meta in the body.
    expect(parseEditionMeta(`<meta content='2026-10-14 full 2026-10-14T05:07:44+08:00' name='ct-edition'>`)).toEqual(want);
    expect(parseEditionMeta(`<META NAME="CT-Edition" CONTENT="  2026-10-14   full\t2026-10-14T05:07:44+08:00 ">`)).toEqual(want);
    expect(parseEditionMeta(`<html><body><meta name="ct-edition" content="2026-10-14 full 2026-10-14T05:07:44+08:00"></body></html>`)).toEqual(want);
    expect(parseEditionMeta(`<meta name="ct-edition" content="2026-10-15 data_only 2026-10-14T21:00:00Z">`)).toEqual({
      date: "2026-10-15", edition: "data_only", published_at: "2026-10-14T21:00:00Z" });
    expect(parseEditionMeta(`<meta name="ct-edition" content="2026-10-13 partial 2026-10-13T04:58:02+08:00">`)?.edition).toBe("partial");
    // The first meta wins; other metas are ignored.
    expect(parseEditionMeta(`<meta name="description" content="2026-10-01 full 2026-10-01T05:00:00+08:00">${metaTag(shown("full"))}`
      + `<meta name="ct-edition" content="2026-10-13 partial 2026-10-13T04:58:02+08:00">`)).toEqual(want);
    // Refused: none, empty, a word missing or extra, a date that is not real, an unknown edition, not a timestamp.
    for (const bad of [
      page(null), "", "not html at all", `<meta name="ct-edition">`, `<meta name="ct-edition" content="">`,
      `<meta name="ct-edition" content="2026-10-14 full">`, `<meta name="ct-edition" content="2026-10-14 full 2026-10-14T05:07:44+08:00 extra">`,
      `<meta name="ct-edition" content="2026-02-30 full 2026-02-28T05:07:44+08:00">`, `<meta name="ct-edition" content="2026-10-14 FULL 2026-10-14T05:07:44+08:00">`,
      `<meta name="ct-edition" content="2026-10-14 weekly 2026-10-14T05:07:44+08:00">`, `<meta name="ct-edition" content="2026-10-14 full 05:07">`,
      `<meta name="ct-edition" content="2026-10-14 full 2026-10-14T05:07:44">`, `<meta property="ct-edition" content="2026-10-14 full 2026-10-14T05:07:44+08:00">`,
    ]) {
      expect(parseEditionMeta(bad), bad).toBeNull();
    }
  });
});
