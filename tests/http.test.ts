// The fetch harness (SPEC §8.3, lib/feeds/http.ts): retries, caps, truncation, redirects, the deadline,
// the pool and the shared budget. Every request goes to a server on 127.0.0.1 or to a stubbed fetch; no
// test touches the network.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchBudget, fetchFeed, pool } from "@/lib/feeds/http";

const UA = "CyberTracker test";
const hits = new Map<string, number>();
let base = "";
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const n = (hits.get(url) ?? 0) + 1;
    hits.set(url, n);
    if (url.startsWith("/flaky-503")) {
      if (n === 1) { res.writeHead(503); res.end("busy"); return; }
      res.writeHead(200, { "Content-Type": "text/plain" }); res.end("second time"); return;
    }
    if (url.startsWith("/always-503")) { res.writeHead(503); res.end("busy"); return; }
    if (url.startsWith("/reset")) {
      if (n === 1) { req.socket.destroy(); return; }
      res.writeHead(200); res.end("after reset"); return;
    }
    if (url.startsWith("/missing")) { res.writeHead(404); res.end("no"); return; }
    if (url.startsWith("/declared-big")) { res.writeHead(200, { "Content-Length": "100" }); res.end("x".repeat(100)); return; }
    if (url.startsWith("/streamed-big")) {
      res.writeHead(200, { "Content-Type": "text/plain" }); // chunked: no Content-Length
      res.write("a".repeat(8)); res.write("b".repeat(8)); res.end("c".repeat(8)); return;
    }
    if (url.startsWith("/to-http")) { res.writeHead(302, { Location: `${base}/plain` }); res.end(); return; }
    if (url.startsWith("/plain")) { res.writeHead(200); res.end("plain"); return; }
    if (url.startsWith("/hang")) return; // never answers
    res.writeHead(200); res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const opts = { userAgent: UA, retryDelayMs: 10, timeoutMs: 5_000 };

describe("fetchFeed: retries", () => {
  it("retries once on a 503", async () => {
    const r = await fetchFeed(`${base}/flaky-503`, opts);
    expect(r).toMatchObject({ ok: true, status: 200, attempts: 2, error: null });
    expect(r.body?.toString()).toBe("second time");
  });

  it("retries once on a reset connection", async () => {
    const r = await fetchFeed(`${base}/reset`, opts);
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(r.body?.toString()).toBe("after reset");
  });

  it("never retries a 4xx", async () => {
    const r = await fetchFeed(`${base}/missing`, opts);
    expect(r).toMatchObject({ ok: false, status: 404, error: "http_404", attempts: 1 });
    expect(hits.get("/missing")).toBe(1);
  });

  it("gives up after one retry", async () => {
    const r = await fetchFeed(`${base}/always-503?a`, opts);
    expect(r).toMatchObject({ ok: false, error: "http_503", attempts: 2 });
  });
});

describe("fetchFeed: body caps", () => {
  it("is too_large from Content-Length", async () => {
    const r = await fetchFeed(`${base}/declared-big`, { ...opts, maxBytes: 10 });
    expect(r).toMatchObject({ ok: false, error: "too_large", body: null });
  });

  it("is too_large from the streamed size", async () => {
    const r = await fetchFeed(`${base}/streamed-big`, { ...opts, maxBytes: 20 });
    expect(r).toMatchObject({ ok: false, error: "too_large" });
  });

  it("cuts the body at the cap with truncate, both when declared and when streamed", async () => {
    const declared = await fetchFeed(`${base}/declared-big?t`, { ...opts, maxBytes: 10, truncate: true });
    expect(declared).toMatchObject({ ok: true, error: null });
    expect(declared.body?.toString()).toBe("x".repeat(10));
    const streamed = await fetchFeed(`${base}/streamed-big?t`, { ...opts, maxBytes: 12, truncate: true });
    expect(streamed.body?.toString()).toBe(`${"a".repeat(8)}${"b".repeat(4)}`);
  });

  it("returns a body under the cap whole", async () => {
    const r = await fetchFeed(`${base}/streamed-big?whole`, { ...opts, maxBytes: 24 });
    expect(r.body?.length).toBe(24);
  });
});

describe("fetchFeed: redirects", () => {
  it("refuses a non-https hop after the first", async () => {
    const r = await fetchFeed(`${base}/to-http`, opts);
    expect(r).toMatchObject({ ok: false, error: "redirects" });
    expect(r.finalUrl).toBe(`${base}/plain`);
  });

  it("follows at most 5 redirects", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      calls++;
      const n = Number(new URL(url).searchParams.get("n") ?? "0");
      return new Response(null, { status: 302, headers: { location: `https://example.org/hop?n=${n + 1}` } });
    });
    const r = await fetchFeed("https://example.org/hop?n=0", { ...opts, retryDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, error: "redirects", detail: "more than 5 redirects" });
    expect(calls).toBe(6);
  });

  it("answers after 5 redirects", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const n = Number(new URL(url).searchParams.get("n") ?? "0");
      if (n === 5) return new Response("done", { status: 200 });
      return new Response(null, { status: 301, headers: { location: `https://example.org/hop?n=${n + 1}` } });
    });
    const r = await fetchFeed("https://example.org/hop?n=0", opts);
    expect(r).toMatchObject({ ok: true, finalUrl: "https://example.org/hop?n=5" });
  });
});

describe("fetchFeed: the deadline", () => {
  it("starts nothing past the deadline", async () => {
    const before = hits.get("/plain?late") ?? 0;
    const r = await fetchFeed(`${base}/plain?late`, { ...opts, deadline: Date.now() - 1 });
    expect(r).toMatchObject({ ok: false, error: "timeout", attempts: 0 });
    expect(hits.get("/plain?late") ?? 0).toBe(before);
  });

  it("skips the retry when its delay would cross the deadline", async () => {
    const r = await fetchFeed(`${base}/always-503?deadline`, { ...opts, retryDelayMs: 2_000, deadline: Date.now() + 1_000 });
    expect(r).toMatchObject({ ok: false, error: "http_503", attempts: 1 });
    expect(hits.get("/always-503?deadline")).toBe(1);
  });

  it("cuts an attempt's timeout to the deadline", async () => {
    const t0 = Date.now();
    const r = await fetchFeed(`${base}/hang`, { ...opts, timeoutMs: 30_000, retryDelayMs: 0, deadline: Date.now() + 300 });
    expect(r).toMatchObject({ ok: false, error: "timeout", attempts: 1 });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

describe("fetchFeed with CT_FIXTURE_FEEDS", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-http-"));
  fs.writeFileSync(path.join(dir, "big.txt"), "z".repeat(50));
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({
    "https://example.org/big": { file: "big.txt", content_type: "text/plain" },
    "https://example.org/gone": { status: 404 },
    "https://example.org/slow": { error: "timeout" },
  }));

  it("applies the body cap and truncate to saved files", async () => {
    vi.stubEnv("CT_FIXTURE_FEEDS", dir);
    expect(await fetchFeed("https://example.org/big", { maxBytes: 100 })).toMatchObject({ ok: true, contentType: "text/plain" });
    expect(await fetchFeed("https://example.org/big", { maxBytes: 10 })).toMatchObject({ ok: false, error: "too_large", body: null });
    const cut = await fetchFeed("https://example.org/big", { maxBytes: 10, truncate: true });
    expect(cut.body?.toString()).toBe("z".repeat(10));
  });

  it("answers errors, unknown URLs and statuses from the index, ignoring the deadline", async () => {
    vi.stubEnv("CT_FIXTURE_FEEDS", dir);
    expect(await fetchFeed("https://example.org/gone")).toMatchObject({ ok: false, status: 404, error: "http_404" });
    expect(await fetchFeed("https://example.org/slow")).toMatchObject({ ok: false, error: "timeout" });
    expect(await fetchFeed("https://example.org/nowhere")).toMatchObject({ ok: false, error: "dns" });
    expect(await fetchFeed("https://example.org/big", { deadline: 0 })).toMatchObject({ ok: true });
  });
});

describe("pool", () => {
  it("never runs more than the limit and keeps input order", async () => {
    let running = 0;
    let peak = 0;
    const out = await pool([5, 1, 4, 2, 3, 0, 6], 3, async (n, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n * 3));
      running--;
      return `${i}:${n}`;
    });
    expect(peak).toBe(3);
    expect(out).toEqual(["0:5", "1:1", "2:4", "3:2", "4:3", "5:0", "6:6"]);
  });

  it("handles an empty list and a limit below 1", async () => {
    expect(await pool([], 8, async () => 1)).toEqual([]);
    expect(await pool([1, 2], 0, async (n) => n * 2)).toEqual([2, 4]);
  });

  it("stops starting items after a failure and throws the first error", async () => {
    const started: number[] = [];
    await expect(pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      started.push(n);
      await new Promise((r) => setTimeout(r, 5));
      if (n === 2) throw new Error("boom 2");
      return n;
    })).rejects.toThrow("boom 2");
    expect(started.length).toBeLessThan(6);
  });
});

describe("fetchBudget", () => {
  it("starts at the first request and defaults to 240 s", () => {
    const b = fetchBudget();
    expect(b.capMs).toBe(240_000);
    expect(b.started).toBeNull();
    expect(b.deadline()).toBe(Number.POSITIVE_INFINITY);
    b.begin(1_000);
    b.begin(5_000);
    expect(b.started).toBe(1_000);
    expect(b.deadline()).toBe(241_000);
    expect(fetchBudget(10).capMs).toBe(10);
  });
});

// P3 step S0, plan amendment A11: snapshots send a browser-like Accept-Language (SPEC §4.12 step 1).
describe("fetchFeed: Accept-Language (H-AL)", () => {
  let echo: http.Server;
  let echoBase = "";
  const seen: (string | undefined)[] = [];

  beforeAll(async () => {
    echo = http.createServer((req, res) => {
      const lang = req.headers["accept-language"];
      seen.push(typeof lang === "string" ? lang : undefined);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(typeof lang === "string" ? lang : "(none)");
    });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    echoBase = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    echo.closeAllConnections();
    await new Promise<void>((r) => echo.close(() => r()));
  });

  it("H-AL: sends Accept-Language only when the option is set; fixture mode ignores it", async () => {
    const withLang = await fetchFeed(`${echoBase}/lang`, { ...opts, acceptLanguage: "en-US,en;q=0.9" });
    expect(withLang).toMatchObject({ ok: true, status: 200 });
    expect(withLang.body?.toString()).toBe("en-US,en;q=0.9");
    // Without the option fetchFeed adds no Accept-Language; Node's fetch then sends its own default ("*").
    const without = await fetchFeed(`${echoBase}/lang`, opts);
    expect(["(none)", "*"]).toContain(without.body?.toString());
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe("en-US,en;q=0.9");
    expect([undefined, "*"]).toContain(seen[1]);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-http-al-"));
    try {
      fs.writeFileSync(path.join(dir, "page.html"), "<p>saved</p>");
      fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ "https://example.org/ct-sample/page": { file: "page.html", content_type: "text/html" } }));
      vi.stubEnv("CT_FIXTURE_FEEDS", dir);
      const saved = await fetchFeed("https://example.org/ct-sample/page", { acceptLanguage: "en-US,en;q=0.9" });
      expect(saved).toMatchObject({ ok: true, status: 200, contentType: "text/html" });
      expect(saved.body?.toString()).toBe("<p>saved</p>");
      expect(seen).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
