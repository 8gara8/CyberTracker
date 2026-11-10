// Page snapshots (SPEC §4.12 step 1; plan §2.5 L4, A11 to A13): HTML to text, the 3 MB cut, redirects, no
// snapshot for a PDF, BLOCKED_HOSTS never requested, 6 at a time, the round deadline, the file and its
// fields, and fixture mode with the URL requested exactly as cited. Every request goes to a server on
// 127.0.0.1, a stubbed fetch or a temporary fixture folder; no test touches the network.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/lib/config";
import type { fetchFeed } from "@/lib/feeds/http";
import { htmlText, textSha256 } from "@/lib/html-text";
import { sha256Hex } from "@/lib/json";
import type { Evidence } from "@/lib/schema/misc";
import { normalizeUrl } from "@/lib/urls";
import { runPaths } from "@/scripts/lib/paths";
import {
  citedUnseen, readSnapshot, SNAPSHOT_HEADERS, SNAPSHOT_LIMITS, snapshotFile, snapshotHashes, snapshotUrls, type Snapshot,
} from "@/scripts/lib/snapshot";
import { REPO } from "./helpers/harness";

const config = loadConfig({ root: REPO });
const PAGE = [
  "<!DOCTYPE html><html><head><title>Sample advisory</title><style>p { color: red }</style></head><body>",
  "<nav>Home Products Support</nav><header>Site header</header>",
  "<script>var sample = 1;</script>",
  "<article><h1>SAMPLE advisory</h1><p>Version 9.2 fixes the flaw; 3 products are affected.</p></article>",
  "<footer>Footer text</footer></body></html>",
].join("");

/** The text past the 3 MB cut in the /cut page (S2). */
const CUT_MARKER = "SAMPLE text after the cut";

let server: http.Server;
let base = "";
let inFlight = 0;
let maxInFlight = 0;
const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    seen.push({ url, headers: req.headers });
    if (url.startsWith("/page")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (url.startsWith("/big")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write("<html><body><main>");
      const chunk = `<p>${"word ".repeat(200)}</p>`;
      for (let n = 0; n < Math.ceil((SNAPSHOT_LIMITS.maxBytes + 512 * 1024) / chunk.length); n++) res.write(chunk);
      res.end("</main></body></html>");
      return;
    }
    if (url.startsWith("/cut")) {
      // A marker 64 KiB past the 3 MB cut, behind a script the text drops: read whole, the text would end with it.
      res.writeHead(200, { "Content-Type": "text/html" });
      const head = "<html><body><main><p>SAMPLE start of the page</p><script>";
      res.write(head);
      const filler = "x".repeat(64 * 1024);
      for (let n = 0; n < Math.ceil((SNAPSHOT_LIMITS.maxBytes + 64 * 1024 - head.length) / filler.length); n++) res.write(filler);
      res.end(`</script><p>${CUT_MARKER}</p></main></body></html>`);
      return;
    }
    if (url.startsWith("/report.pdf")) {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end("%PDF-1.7 sample");
      return;
    }
    if (url.startsWith("/missing")) {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<p>Not found</p>");
      return;
    }
    if (url.startsWith("/slow")) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const ms = Number(new URL(url, base).searchParams.get("ms") ?? "80");
      setTimeout(() => {
        inFlight--;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<p>slow ${url}</p>`);
      }, ms);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<p>ok</p>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const roots: string[] = [];
const tmpRoot = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "ct-snapshot-"));
  roots.push(r);
  return r;
};
const saved = process.env.CT_FIXTURE_FEEDS;

afterEach(() => {
  vi.unstubAllGlobals();
  if (saved === undefined) delete process.env.CT_FIXTURE_FEEDS;
  else process.env.CT_FIXTURE_FEEDS = saved;
  seen.length = 0;
  inFlight = 0;
  maxInFlight = 0;
});

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const soon = (ms = 20_000) => Date.now() + ms;

describe("snapshotUrls", () => {
  it("S1 turns HTML into text with script, style and nav dropped and article preferred", async () => {
    delete process.env.CT_FIXTURE_FEEDS;
    const root = tmpRoot();
    const r = await snapshotUrls({ root, urls: [`${base}/page`], deadline: soon(), config });
    expect(r.failed).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.taken).toHaveLength(1);
    const s = r.taken[0]!;
    expect(s.text).toBe("SAMPLE advisory Version 9.2 fixes the flaw; 3 products are affected.");
    expect(s.text).toBe(htmlText(PAGE));
    for (const gone of ["var sample", "Home Products", "Site header", "Footer text", "color"]) expect(s.text).not.toContain(gone);
    // One GET with the browser-like Accept and Accept-Language and the honest user agent (plan A11).
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers).toMatchObject({
      accept: SNAPSHOT_HEADERS.accept, "accept-language": SNAPSHOT_HEADERS.acceptLanguage, "user-agent": config.run.user_agent,
    });
  });

  it("S2 cuts a body over 3 MB and still takes the snapshot", async () => {
    delete process.env.CT_FIXTURE_FEEDS;
    const r = await snapshotUrls({ root: tmpRoot(), urls: [`${base}/big`], deadline: soon(), config });
    expect(r.failed).toEqual([]);
    expect(r.taken).toHaveLength(1);
    const text = r.taken[0]!.text;
    expect(text.length).toBeGreaterThan(100_000);
    expect(text.length).toBeLessThanOrEqual(200_000);
    expect(text.startsWith("word word")).toBe(true);
  });

  it("S2 reads no byte past 3 MB: text after the cut is not in the snapshot", async () => {
    delete process.env.CT_FIXTURE_FEEDS;
    const r = await snapshotUrls({ root: tmpRoot(), urls: [`${base}/cut`], deadline: soon(), config });
    expect(r.failed).toEqual([]);
    expect(r.taken.map((x) => x.text)).toEqual(["SAMPLE start of the page"]);
    expect(r.taken[0]!.text).not.toContain(CUT_MARKER);
  });

  it("S3 fails a URL after more than 5 redirects (stubbed fetch, plan A12)", async () => {
    delete process.env.CT_FIXTURE_FEEDS;
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      calls++;
      const n = Number(new URL(url).searchParams.get("n") ?? "0");
      return new Response(null, { status: 301, headers: { location: `https://example.org/ct-sample/hop?n=${n + 1}` } });
    });
    const root = tmpRoot();
    const url = "https://example.org/ct-sample/hop?n=0";
    const r = await snapshotUrls({ root, urls: [url], deadline: soon(), config });
    expect(r).toEqual({ taken: [], failed: [url], skipped: [] });
    expect(calls).toBe(6);
    expect(fs.existsSync(snapshotFile(root, url))).toBe(false);
  });

  it("S3 follows up to 5 redirects and records the final URL", async () => {
    delete process.env.CT_FIXTURE_FEEDS;
    vi.stubGlobal("fetch", async (url: string) => {
      const n = Number(new URL(url).searchParams.get("n") ?? "0");
      if (n === 5) return new Response("<p>arrived</p>", { status: 200, headers: { "content-type": "text/html" } });
      return new Response(null, { status: 302, headers: { location: `https://example.org/ct-sample/hop?n=${n + 1}` } });
    });
    const r = await snapshotUrls({ root: tmpRoot(), urls: ["https://example.org/ct-sample/hop?n=0"], deadline: soon(), config });
    expect(r.taken.map((s) => [s.final_url, s.text])).toEqual([["https://example.org/ct-sample/hop?n=5", "arrived"]]);
  });

  it("S4 takes no snapshot of a PDF or a failed page", async () => {
    delete process.env.CT_FIXTURE_FEEDS;
    const root = tmpRoot();
    const urls = [`${base}/report.pdf`, `${base}/missing`];
    const r = await snapshotUrls({ root, urls, deadline: soon(), config });
    expect(r).toEqual({ taken: [], failed: urls, skipped: [] });
    for (const u of urls) expect(fs.existsSync(snapshotFile(root, u))).toBe(false);
  });

  it("S5 never requests a BLOCKED_HOSTS URL, and skips a URL that is not http(s)", async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, finalUrl: url, body: Buffer.from("<p>fine</p>"), contentType: "text/html", error: null, detail: null, durationMs: 1, attempts: 1 };
    }) as typeof fetchFeed;
    const blocked = ["https://pastebin.com/ct-sample", "https://www.gist.github.com/ct-sample", "https://web.archive.org/web/2026/https://example.org/x", "https://sample.onion/x"];
    const ok = "https://www.ithome.com.tw/ct-sample/page";
    const r = await snapshotUrls({ root: tmpRoot(), urls: [...blocked, "ftp://example.org/ct-sample/file", ok], deadline: soon(), config, fetch: fake });
    expect(calls).toEqual([ok]);
    expect(r.taken.map((s) => s.url)).toEqual([ok]);
    expect(r.skipped).toEqual([...blocked, "ftp://example.org/ct-sample/file"]);
  });

  it("S5 follows no redirect into a BLOCKED_HOSTS host: the hop is never requested and the URL fails (stubbed fetch)", async () => {
    delete process.env.CT_FIXTURE_FEEDS;
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      if (url.endsWith("/hop")) return new Response(null, { status: 301, headers: { location: "https://web.archive.org/web/2026/https://example.org/x" } });
      if (url.endsWith("/hop-sub")) return new Response(null, { status: 302, headers: { location: "https://sample.onion/x" } });
      return new Response("<p>blocked page text</p>", { status: 200, headers: { "content-type": "text/html" } });
    });
    const root = tmpRoot();
    const urls = ["https://example.org/ct-sample/hop", "https://example.org/ct-sample/hop-sub"];
    const lines: string[] = [];
    const r = await snapshotUrls({ root, urls, deadline: soon(), config, log: (l) => lines.push(l) });
    expect(asked).toEqual(urls);
    expect(r).toEqual({ taken: [], failed: urls, skipped: [] });
    for (const u of urls) expect(fs.existsSync(snapshotFile(root, u))).toBe(false);
    expect(lines.every((l) => !l.includes("archive.org") && !l.includes("onion"))).toBe(true);
    expect(lines.filter((l) => l.includes("not read (redirects, HTTP 30"))).toHaveLength(2);
  });

  it("S6 runs at most 6 requests at a time", async () => {
    delete process.env.CT_FIXTURE_FEEDS;
    const urls = Array.from({ length: 15 }, (_, k) => `${base}/slow?k=${k}&ms=120`);
    const r = await snapshotUrls({ root: tmpRoot(), urls, deadline: soon(), config });
    expect(r.taken).toHaveLength(15);
    expect(maxInFlight).toBe(SNAPSHOT_LIMITS.concurrency);
    expect(SNAPSHOT_LIMITS.concurrency).toBe(6);
  });

  it("S7 starts no request at or after the round's deadline", async () => {
    delete process.env.CT_FIXTURE_FEEDS;
    const urls = Array.from({ length: 12 }, (_, k) => `${base}/slow?k=${k}&ms=3000`);
    const log: string[] = [];
    const r = await snapshotUrls({ root: tmpRoot(), urls, deadline: Date.now() + 1_000, config, log: (l) => log.push(l) });
    // The first six started and ran into the deadline; the other six never started.
    expect(seen.filter((s) => s.url.startsWith("/slow"))).toHaveLength(6);
    expect(r.taken).toEqual([]);
    expect(r.failed).toEqual(urls.slice(0, 6));
    expect(r.skipped).toEqual(urls.slice(6));
    expect(log).toContain("snapshot: 6 URLs not started before the round's deadline.");
    const late = await snapshotUrls({ root: tmpRoot(), urls: [`${base}/page`], deadline: Date.now() - 1, config });
    expect(late).toEqual({ taken: [], failed: [], skipped: [`${base}/page`] });
  });

  it("S8 stores every field under the sha256 of the normalised URL, and readSnapshot reads it back", async () => {
    delete process.env.CT_FIXTURE_FEEDS;
    const root = tmpRoot();
    const url = `${base}/page?utm_source=ct-sample`;
    const at = Date.parse("2026-10-14T04:58:00+08:00");
    const r = await snapshotUrls({ root, urls: [url], deadline: soon(), config, now: () => at });
    const s = r.taken[0]!;
    const file = snapshotFile(root, url);
    expect(file).toBe(path.join(runPaths(root, "2026-10-14").snapshotsDir, `${sha256Hex(normalizeUrl(url))}.json`));
    expect(path.basename(file)).toBe(`${sha256Hex(`${base.replace(/^http:/, "https:")}/page`)}.json`);
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
    expect(Object.keys(stored).sort()).toEqual(["content_type", "fetched_at", "final_url", "status", "text", "text_sha256", "url"]);
    expect(stored).toEqual({
      url, final_url: url, status: 200, fetched_at: "2026-10-14T04:58:00+08:00", content_type: "text/html; charset=utf-8",
      text_sha256: textSha256(s.text), text: s.text,
    });
    expect(readSnapshot(root, url)).toEqual(stored);
    expect(readSnapshot(root, `${base}/page`)).toEqual(stored);
    expect(readSnapshot(root, `${base}/other`)).toBeNull();
    expect(snapshotHashes(r.taken)).toEqual({ [normalizeUrl(url)]: { sha256: s.text_sha256, fetched_at: s.fetched_at } });
  });

  it("S9 requests the URL exactly as cited in fixture mode (a #frag), and stores it under the normalised hash", async () => {
    const dir = tmpRoot();
    const url = "https://www.ithome.com.tw/ct-sample/fragment-page#section-2";
    fs.writeFileSync(path.join(dir, "page.html"), "<html><body><article><p>SAMPLE fragment page text.</p></article></body></html>");
    fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ [url]: { file: "page.html", content_type: "text/html; charset=utf-8" } }));
    process.env.CT_FIXTURE_FEEDS = dir;
    const root = tmpRoot();
    const r = await snapshotUrls({ root, urls: [url], deadline: soon(), config });
    expect(r.taken.map((s) => [s.url, s.text])).toEqual([[url, "SAMPLE fragment page text."]]);
    expect(snapshotFile(root, url)).toBe(snapshotFile(root, "https://ithome.com.tw/ct-sample/fragment-page"));
    expect(readSnapshot(root, "https://www.ithome.com.tw/ct-sample/fragment-page")?.url).toBe(url);
    // The normalised form is not in the fixture index: requesting it instead would have failed.
    const other = await snapshotUrls({ root: tmpRoot(), urls: [normalizeUrl(url)], deadline: soon(), config });
    expect(other.failed).toEqual([normalizeUrl(url)]);
  });
});

describe("citedUnseen", () => {
  const ev = (texts: Record<string, string>): Evidence => ({ urls: Object.keys(texts), fetched: [], texts, seen_as: {} });

  it("lists each cited URL with no seen text once, exactly as the draft stores it", () => {
    const draft = {
      sources: [
        { id: "s1", url: "https://www.ithome.com.tw/ct-sample/a#top" },
        { id: "s2", url: "https://ithome.com.tw/ct-sample/a" },
        { id: "s3", url: "https://www.jpcert.or.jp/ct-sample/b" },
        { id: "s4", url: "https://www.cisa.gov/ct-sample/c" },
        { id: "s5", url: 42 },
        { id: "s6" },
        { id: "s7", url: "https://www.security-next.com/ct-sample/d" },
      ],
    };
    const evidence = ev({ [normalizeUrl("https://www.jpcert.or.jp/ct-sample/b")]: "seen", [normalizeUrl("https://www.security-next.com/ct-sample/d")]: "" });
    expect(citedUnseen(draft, evidence)).toEqual([
      "https://www.ithome.com.tw/ct-sample/a#top", "https://www.cisa.gov/ct-sample/c", "https://www.security-next.com/ct-sample/d",
    ]);
    expect(citedUnseen(draft, null)).toHaveLength(4);
  });

  it("reads unknown input without throwing", () => {
    for (const d of [null, undefined, 3, "x", {}, { sources: "no" }, { sources: [null, 1, []] }]) expect(citedUnseen(d, null)).toEqual([]);
  });
});
