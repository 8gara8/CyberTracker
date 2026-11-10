// The post-publish link check (SPEC §8.11; plan §2.6, named tests L1 to L10): a local HTTP server answering
// 200, 403, 404, 410, a slow response and a changed tier 1 page; the 301-then-200 case on a stubbed fetch,
// because fetchFeed follows only https hops (plan A12); the URL order, cap, exclusions and stop; the dry run;
// and applyLinkResults. Each URL is requested exactly as the brief stores it (plan A13).
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/lib/config";
import { addDays } from "@/lib/dates";
import { fetchFeed, type FetchOptions, type FetchResult } from "@/lib/feeds/http";
import { htmlText, textSha256 } from "@/lib/html-text";
import type { Brief } from "@/lib/schema/brief";
import { ArchiveIndex } from "@/lib/schema/misc";
import { normalizeUrl } from "@/lib/urls";
import { MIN, testClock } from "@/scripts/lib/clock";
import { SNAPSHOT_HEADERS, SNAPSHOT_LIMITS } from "@/scripts/lib/snapshot";
import { applyLinkResults, checkLinks, LINKS_LIMITS, linkResultOf, linkTargets, main, type LinkResult, type LinksOutcome } from "@/scripts/recheck";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(REPO, "fixtures", "site-content");
const config = loadConfig({ root: REPO });
/** The edition checked: the sample's 2026-10-14 brief is the template for every test brief. */
const D = "2026-10-14";
const TEMPLATE = JSON.parse(fs.readFileSync(path.join(SITE, "briefs", `${D}.json`), "utf8")) as Brief;

const PAGE = (text: string) => `<!doctype html><html><head><title>SAMPLE</title></head><body><nav>Menu</nav><main><p>${text}</p></main></body></html>`;
const TEXT = "SAMPLE page text for the link check.";
const EDITED = "SAMPLE page text for the link check, edited after it was cited.";
const hashOf = (text: string) => textSha256(htmlText(PAGE(text)));
const TAIPEI_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const write = (file: string, data: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

// ── The local server ─────────────────────────────────────────────────────────────────────────────

let server: http.Server;
let base = "";
/** Request targets the server saw (path and query), in order. */
const seen: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    const p = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const html = (status: number, text: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE(text));
    };
    if (p === "/ok" || p === "/ok-t2" || p === "/fresh") return html(200, TEXT);
    if (p === "/changed") return html(200, EDITED);
    if (p === "/forbidden") return html(403, "SAMPLE forbidden");
    if (p === "/missing") return html(404, "SAMPLE not found");
    if (p === "/gone") return html(410, "SAMPLE gone");
    if (p === "/slow") {
      const t = setTimeout(() => html(200, TEXT), 20_000);
      req.on("close", () => clearTimeout(t));
      return;
    }
    html(500, "SAMPLE unexpected");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const temps: string[] = [];
const cwd = process.cwd();
const savedFixtureFeeds = process.env.CT_FIXTURE_FEEDS;
delete process.env.CT_FIXTURE_FEEDS; // fetchFeed must reach the server or the stub, never saved files
afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  if (savedFixtureFeeds !== undefined) process.env.CT_FIXTURE_FEEDS = savedFixtureFeeds;
});

// ── Worlds ───────────────────────────────────────────────────────────────────────────────────────

interface Row { url: string; tier: 1 | 2 | 3; sha256?: string | null }

/** A brief for `date` from the template with `rows` as its sources s1 to sN (the items keep their source_ids). */
function briefWith(date: string, rows: readonly Row[], edit?: (b: Brief) => void): Brief {
  const b = structuredClone(TEMPLATE);
  b.date = date;
  b.sources = rows.map((r, i) => ({ ...TEMPLATE.sources[i % TEMPLATE.sources.length]!, id: `s${i + 1}`, url: r.url, tier: r.tier }));
  edit?.(b);
  return b;
}

/** The item that cites s<i + 1> in the template brief. */
const itemOf = (i: number) => TEMPLATE.items.find((it) => it.source_ids.includes(`s${i + 1}`))?.id ?? null;

interface LinkWorld { root: string; content: string; logs: string[]; log: (line: string) => void }

function linkWorld(briefs: Record<string, readonly Row[]>, o: { config?: boolean; edit?: (date: string, b: Brief) => void } = {}): LinkWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-links-"));
  temps.push(root);
  const content = path.join(root, "content");
  const urls: ArchiveIndex["urls"] = {};
  for (const [date, rows] of Object.entries(briefs)) {
    write(path.join(content, "briefs", `${date}.json`), `${JSON.stringify(briefWith(date, rows, (b) => o.edit?.(date, b)), null, 2)}\n`);
    rows.forEach((r, i) => {
      const item = itemOf(i);
      urls[normalizeUrl(r.url)] ??= {
        first_cited: date, item_ids: item ? [`${date}/${item}`] : [], sha256: r.sha256 ?? null,
        hashed_at: r.sha256 ? `${date}T05:00:00+08:00` : null, last_check: null,
      };
    });
  }
  write(path.join(content, "archive-index.json"), `${JSON.stringify(ArchiveIndex.parse({ schema_version: 1, editions: [], urls }), null, 2)}\n`);
  if (o.config) fs.cpSync(path.join(REPO, "config"), path.join(root, "config"), { recursive: true });
  const logs: string[] = [];
  return { root, content, logs, log: (line) => logs.push(line) };
}

const run = (w: LinkWorld, o: { fetch?: typeof fetchFeed; now?: () => number; endLimit?: number; date?: string } = {}) =>
  checkLinks({ root: w.root, date: o.date ?? D, contentDir: w.content, config, now: o.now ?? Date.now, endLimit: o.endLimit ?? Number.POSITIVE_INFINITY, fetch: o.fetch, log: w.log });

const answer = (url: string, over: Partial<FetchResult> = {}): FetchResult =>
  ({ ok: true, status: 200, finalUrl: url, body: Buffer.alloc(0), contentType: "text/html", error: null, detail: null, durationMs: 1, attempts: 1, ...over });

// ── L1 to L8: the local server ───────────────────────────────────────────────────────────────────

describe("results from a local server (L1 to L8)", () => {
  /** s1 to s8 of the 2026-10-14 brief: s1 to s3 cite cve-2026-104935, s4 to s6 pt-microsoft-2026-10, s7 and s8 camp-tw-semiconductor-2026-10. */
  const rows = (): Row[] => [
    { url: `${base}/ok?utm_source=ct-sample`, tier: 1, sha256: hashOf(TEXT) },
    { url: `${base}/forbidden`, tier: 2 },
    { url: `${base}/missing`, tier: 2 },
    { url: `${base}/gone`, tier: 1 },
    { url: `${base}/slow`, tier: 2 },
    { url: `${base}/changed`, tier: 1, sha256: hashOf(TEXT) },
    { url: `${base}/fresh`, tier: 1, sha256: null },
    { url: `${base}/ok-t2`, tier: 2 },
  ];
  let outcome: LinksOutcome;
  const calls: { url: string; opts: FetchOptions }[] = [];
  let urls: string[] = [];

  beforeAll(async () => {
    const w = linkWorld({ [D]: rows() });
    urls = rows().map((r) => r.url);
    // The real fetchFeed against the server; a short timeout for the slow page and no retry.
    const local = ((url: string, opts: FetchOptions = {}) => {
      calls.push({ url, opts });
      return fetchFeed(url, { ...opts, timeoutMs: 3_000, retryDelayMs: 0 });
    }) as typeof fetchFeed;
    outcome = await run(w, { fetch: local });
  }, 60_000);

  const resultFor = (i: number): LinkResult => outcome.results.find((r) => r.url === urls[i])!;

  it("L1 200 gives ok; each URL is requested as the brief stores it, with the snapshot fetcher's headers", () => {
    expect(resultFor(0)).toEqual({ url: urls[0], result: "ok", http: 200, sha256: null, hashed_at: null });
    expect(resultFor(7)).toEqual({ url: urls[7], result: "ok", http: 200, sha256: null, hashed_at: null });
    // The stored string, not normalizeUrl()'s https key (plan A13): the tracking parameter reaches the server.
    expect(seen).toContain("/ok?utm_source=ct-sample");
    expect(calls.map((c) => c.url).sort()).toEqual([...urls].sort());
    for (const c of calls) {
      expect(c.opts).toMatchObject({ timeoutMs: SNAPSHOT_LIMITS.timeoutMs, truncate: true, accept: SNAPSHOT_HEADERS.accept, acceptLanguage: SNAPSHOT_HEADERS.acceptLanguage, userAgent: config.run.user_agent });
      expect(typeof c.opts.deadline).toBe("number");
    }
    // Only tier 1 bodies are read (up to 3 MB).
    const tierOf = new Map(rows().map((r) => [r.url, r.tier]));
    for (const c of calls) expect(c.opts.maxBytes, c.url).toBe(tierOf.get(c.url) === 1 ? SNAPSHOT_LIMITS.maxBytes : 0);
    // Tier 1 first, then tier 2, each in brief order.
    expect(outcome.results.map((r) => urls.indexOf(r.url))).toEqual([0, 3, 5, 6, 1, 2, 4, 7]);
  });

  it("L3 403 gives unknown", () => {
    expect(resultFor(1)).toEqual({ url: urls[1], result: "unknown", http: 403, sha256: null, hashed_at: null });
    for (const status of [401, 429, 503]) expect(linkResultOf({ ok: false, status, error: `http_${status}` })).toBe("unknown");
    expect(linkResultOf({ ok: false, status: null, error: "tls" })).toBe("unknown");
  });

  it("L4 a slow response gives unknown", () => {
    expect(resultFor(4)).toEqual({ url: urls[4], result: "unknown", http: null, sha256: null, hashed_at: null });
    expect(outcome.notReached).toBe(0);
  });

  it("L5 404 gives broken, with the citing item", () => {
    expect(resultFor(2)).toEqual({ url: urls[2], result: "broken", http: 404, sha256: null, hashed_at: null });
    expect(outcome.record.broken).toContainEqual({ url: urls[2], item_id: "cve-2026-104935", edition_date: D, result: "broken", http: 404 });
    expect(linkResultOf({ ok: false, status: null, error: "dns" })).toBe("broken");
  });

  it("L6 410 gives broken", () => {
    expect(resultFor(3)).toEqual({ url: urls[3], result: "broken", http: 410, sha256: null, hashed_at: null });
    expect(outcome.record.broken).toContainEqual({ url: urls[3], item_id: "pt-microsoft-2026-10", edition_date: D, result: "broken", http: 410 });
  });

  it("L7 a changed tier 1 page gives changed", () => {
    expect(resultFor(5)).toEqual({ url: urls[5], result: "changed", http: 200, sha256: null, hashed_at: null });
    expect(outcome.record.broken).toContainEqual({ url: urls[5], item_id: "pt-microsoft-2026-10", edition_date: D, result: "changed", http: 200 });
  });

  it("L8 a null stored hash is stored with hashed_at, result ok", () => {
    const r = resultFor(6);
    expect(r).toMatchObject({ url: urls[6], result: "ok", http: 200, sha256: hashOf(TEXT) });
    expect(r.hashed_at).toMatch(TAIPEI_TS);
    // The record: 8 checked, 3 ok, 2 unknown, two broken and one changed in check order.
    expect(outcome.record).toMatchObject({ checked: 8, ok: 3, unknown: 2 });
    expect(outcome.record.checked_at).toMatch(TAIPEI_TS);
    expect(outcome.record.broken.map((b) => [urls.indexOf(b.url), b.result])).toEqual([[3, "broken"], [5, "changed"], [2, "broken"]]);
  });

  it("L2 301 then 200 gives ok (fetch stubbed on example.org URLs, plan A12)", async () => {
    const hops: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const u = String(input);
      hops.push(u);
      if (u === "https://example.org/ct-sample/moved") return new Response(null, { status: 301, headers: { location: "/ct-sample/moved-here" } });
      if (u === "https://example.org/ct-sample/moved-here") return new Response(PAGE(TEXT), { status: 200, headers: { "content-type": "text/html" } });
      if (u === "https://example.org/ct-sample/loop") return new Response(null, { status: 301, headers: { location: "https://example.org/ct-sample/loop" } });
      if (u === "https://example.org/ct-sample/off-https") return new Response(null, { status: 302, headers: { location: `${"http"}://example.org/ct-sample/plain` } });
      return new Response(null, { status: 404 });
    });
    const w = linkWorld({ [D]: [
      { url: "https://example.org/ct-sample/moved", tier: 1, sha256: null },
      { url: "https://example.org/ct-sample/loop", tier: 2 },
      { url: "https://example.org/ct-sample/off-https", tier: 2 },
    ] });
    const r = await run(w);
    expect(r.results[0]).toMatchObject({ url: "https://example.org/ct-sample/moved", result: "ok", http: 200, sha256: hashOf(TEXT) });
    expect(hops.indexOf("https://example.org/ct-sample/moved")).toBeGreaterThanOrEqual(0);
    expect(hops.indexOf("https://example.org/ct-sample/moved-here")).toBeGreaterThan(hops.indexOf("https://example.org/ct-sample/moved"));
    // More than 5 redirects, or a hop off https, is not followed: unknown.
    expect(r.results.slice(1).map((x) => [x.url, x.result])).toEqual([
      ["https://example.org/ct-sample/loop", "unknown"],
      ["https://example.org/ct-sample/off-https", "unknown"],
    ]);
    expect(linkResultOf({ ok: false, status: 301, error: "redirects" })).toBe("unknown");
    expect(linkResultOf({ ok: false, status: 304, error: "http_304" })).toBe("ok");
  });

  it("L2 a redirect into a blocked host is not followed: the hop is never requested and the link is unknown", async () => {
    const hops: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const u = String(input);
      hops.push(u);
      if (u === "https://example.org/ct-sample/to-archive") return new Response(null, { status: 301, headers: { location: "https://web.archive.org/web/2026/https://example.org/x" } });
      return new Response(PAGE(TEXT), { status: 200, headers: { "content-type": "text/html" } });
    });
    const w = linkWorld({ [D]: [{ url: "https://example.org/ct-sample/to-archive", tier: 1, sha256: null }] });
    const r = await run(w);
    expect(hops).toEqual(["https://example.org/ct-sample/to-archive"]);
    expect(r.results).toEqual([{ url: "https://example.org/ct-sample/to-archive", result: "unknown", http: 301, sha256: null, hashed_at: null }]);
  });
});

// ── L9: which URLs, in what order, and when to stop ──────────────────────────────────────────────

describe("the URL list and the stop (L9)", () => {
  const ex = (name: string) => `https://example.org/ct-sample/${name}`;

  it("L9 newest edition first, then tier 1, 2, 3; deduplicated on the normalised URL; D - 13 read, D - 14 not", () => {
    const w = linkWorld({
      [D]: [{ url: ex("a"), tier: 2 }, { url: ex("b"), tier: 1 }, { url: ex("c"), tier: 3 }],
      [addDays(D, -1)]: [{ url: ex("e"), tier: 2 }, { url: "https://www.example.org/ct-sample/a/?utm_source=x", tier: 1 }, { url: ex("f"), tier: 1 }],
      [addDays(D, -13)]: [{ url: ex("old"), tier: 1 }],
      [addDays(D, -14)]: [{ url: ex("too-old"), tier: 1 }],
    });
    const { targets, total } = linkTargets({ contentDir: w.content, date: D, config });
    expect(targets.map((t) => t.url)).toEqual([ex("b"), ex("a"), ex("c"), ex("f"), ex("e"), ex("old")]);
    expect(total).toBe(6);
    // The newest edition's string and tier, and its citing item.
    expect(targets[1]).toEqual({ url: ex("a"), key: normalizeUrl(ex("a")), tier: 2, item_id: "cve-2026-104935", edition_date: D });
    expect(targets[3]).toMatchObject({ url: ex("f"), edition_date: addDays(D, -1), item_id: "cve-2026-104935" });
  });

  it("L9 at most 300 URLs", async () => {
    const many: Row[] = Array.from({ length: 305 }, (_, i) => ({ url: ex(`n${i}`), tier: 2 as const }));
    const w = linkWorld({ [D]: many });
    const { targets, total } = linkTargets({ contentDir: w.content, date: D, config });
    expect(LINKS_LIMITS.maxUrls).toBe(300);
    expect(targets).toHaveLength(300);
    expect(total).toBe(305);
    expect(targets.at(-1)!.url).toBe(ex("n299"));
    let fetched = 0;
    const fake = (async (url: string) => {
      fetched++;
      return answer(url);
    }) as typeof fetchFeed;
    const r = await run(w, { fetch: fake });
    expect(fetched).toBe(300);
    expect(r.record.checked).toBe(300);
    expect(w.logs).toContain("links: 5 URLs over the cap of 300 not checked.");
  });

  it("L9 sources cited only by withheld items, and blocked URLs, are left out", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-links-"));
    temps.push(root);
    const content = path.join(root, "content");
    fs.cpSync(SITE, content, { recursive: true });
    // 2026-10-12: inc-health-us-2026-10 is withheld; it alone cites s1 and s2.
    const b12 = readJson<Brief>(path.join(content, "briefs", "2026-10-12.json"));
    const withheldOnly = b12.sources.filter((s) => s.id === "s1" || s.id === "s2").map((s) => s.url);
    let urls = linkTargets({ contentDir: content, date: "2026-10-12", config }).targets.map((t) => t.url);
    for (const u of withheldOnly) expect(urls).not.toContain(u);
    expect(urls).toContain(b12.sources.find((s) => s.id === "s3")!.url);
    // Cited by a live item as well: checked, under that item.
    b12.items.find((it) => it.id === "pol-jp-active-cyber-defence-2026-10")!.source_ids.push("s1");
    write(path.join(content, "briefs", "2026-10-12.json"), JSON.stringify(b12));
    const t = linkTargets({ contentDir: content, date: "2026-10-12", config }).targets.find((x) => x.url === withheldOnly[0]);
    expect(t).toMatchObject({ item_id: "pol-jp-active-cyber-defence-2026-10", edition_date: "2026-10-12" });

    // A redirect wrapper and a shortener on BLOCKED_HOSTS are never requested.
    const w = linkWorld({ [D]: [{ url: "https://news.google.com/ct-sample/wrapped", tier: 2 }, { url: "https://bit.ly/ct-sample", tier: 2 }, { url: ex("kept"), tier: 2 }] });
    urls = linkTargets({ contentDir: w.content, date: D, config }).targets.map((x) => x.url);
    expect(urls).toEqual([ex("kept")]);
  });

  const rows: Row[] = Array.from({ length: 20 }, (_, i) => ({ url: ex(`p${i}`), tier: 2 as const }));

  it("L9 the round stops 3 minutes after it starts; URLs not reached are counted and left alone", async () => {
    const w = linkWorld({ [D]: rows });
    const clock = testClock(Date.parse("2026-10-14T05:20:00+08:00"));
    const asked: { url: string; deadline: number | undefined }[] = [];
    const fake = (async (url: string, opts: FetchOptions = {}) => {
      asked.push({ url, deadline: opts.deadline });
      clock.jump(LINKS_LIMITS.roundMs + 1); // the first answer arrives after the round's end
      return answer(url);
    }) as typeof fetchFeed;
    const before = Date.now();
    const r = await run(w, { fetch: fake, now: clock });
    expect(asked).toHaveLength(1);
    // The fetch deadline is the stop on the real clock (realDeadline): about 3 minutes from now.
    expect(asked[0]!.deadline!).toBeGreaterThanOrEqual(before + LINKS_LIMITS.roundMs - 5_000);
    expect(asked[0]!.deadline!).toBeLessThanOrEqual(Date.now() + LINKS_LIMITS.roundMs + 5_000);
    expect(r.record.checked).toBe(1);
    expect(r.results).toHaveLength(1);
    expect(r.notReached).toBe(19);
    expect(w.logs.at(-1)).toContain("19 not reached");
  });

  it("L9 a request cut by the stop is not reached", async () => {
    const w = linkWorld({ [D]: rows.slice(0, 3) });
    const clock = testClock(Date.parse("2026-10-14T05:20:00+08:00"));
    const fake = (async (url: string) => {
      clock.jump(LINKS_LIMITS.roundMs);
      return answer(url, { ok: false, status: null, body: null, error: "timeout" });
    }) as typeof fetchFeed;
    const r = await run(w, { fetch: fake, now: clock });
    expect(r.record.checked).toBe(0);
    expect(r.notReached).toBe(3);
  });

  it("L9 nothing starts with under 6 minutes before the end limit; with 8 left the round is 2 minutes", async () => {
    const w = linkWorld({ [D]: rows });
    const clock = testClock(Date.parse("2026-10-14T05:20:00+08:00"));
    let calls = 0;
    const fake = (async (url: string) => {
      calls++;
      clock.jump(2 * MIN);
      return answer(url);
    }) as typeof fetchFeed;
    let r = await run(w, { fetch: fake, now: clock, endLimit: clock() + LINKS_LIMITS.minLeftMs - 1 });
    expect(calls).toBe(0);
    expect(r.record).toMatchObject({ checked: 0, ok: 0, unknown: 0, broken: [] });
    expect(r.notReached).toBe(20);

    r = await run(w, { fetch: fake, now: clock, endLimit: clock() + 8 * MIN });
    expect(calls).toBe(1);
    expect(r.notReached).toBe(19);
  });

  it("L9 the CLI: a dry run writes nothing; a real run writes logs/D.recheck.json and still edits no archive index", async () => {
    const w = linkWorld({ [D]: rows.slice(0, 4) }, { config: true });
    process.chdir(w.root);
    vi.stubEnv("CT_CONTENT_DIR", w.content);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { out.push(String(s)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fake = (async (url: string) => answer(url, url.endsWith("p1") ? { ok: false, status: 404, body: null, error: "http_404" } : {})) as typeof fetchFeed;
    const snapshot = () => {
      const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
      return Object.fromEntries(files(w.root).map((f) => [path.relative(w.root, f), fs.readFileSync(f, "utf8")]));
    };
    const before = snapshot();
    expect(await main(["--date", D, "--links", "--dry-run", "--json"], { fetch: fake })).toBe(0);
    expect(snapshot()).toEqual(before);
    const printed = JSON.parse(out.join("")) as { intake: unknown; flagged: unknown; links: LinksOutcome };
    expect(printed.intake).toBeNull();
    expect(printed.flagged).toBeNull();
    expect(printed.links.record).toMatchObject({ checked: 4, ok: 3, unknown: 0 });
    expect(printed.links.record.broken).toEqual([{ url: ex("p1"), item_id: "cve-2026-104935", edition_date: D, result: "broken", http: 404 }]);

    out.length = 0;
    expect(await main(["--date", D, "--links"], { fetch: fake })).toBe(0);
    expect(out.join("")).toContain("Links: 4 checked, 3 ok, 0 unknown, 1 broken, 0 changed, 0 not reached.");
    const after = snapshot();
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), `logs/${D}.recheck.json`].sort());
    for (const k of Object.keys(before)) expect(after[k], k).toBe(before[k]);
    expect(readJson<{ links: LinksOutcome }>(path.join(w.root, "logs", `${D}.recheck.json`)).links.record.checked).toBe(4);
  });
});

// ── L10: applyLinkResults ────────────────────────────────────────────────────────────────────────

describe("applyLinkResults (L10)", () => {
  it("L10 writes last_check, fills a null hash, and changes nothing else", () => {
    const ix = ArchiveIndex.parse(readJson(path.join(SITE, "archive-index.json")));
    const frozen = structuredClone(ix);
    const nullKey = Object.keys(ix.urls).find((k) => ix.urls[k]!.sha256 === null)!;
    const hashedKey = Object.keys(ix.urls).find((k) => ix.urls[k]!.sha256 !== null)!;
    const ts = "2026-10-16T05:10:00+08:00";
    // The URL as a brief stores it may differ from its key: applyLinkResults keys by normalizeUrl().
    const stored = `${nullKey.replace("https://", "https://www.")}${nullKey.includes("?") ? "&" : "?"}utm_source=ct-sample`;
    expect(normalizeUrl(stored)).toBe(nullKey);
    const results: LinkResult[] = [
      { url: stored, result: "ok", http: 200, sha256: "a".repeat(64), hashed_at: ts },
      { url: hashedKey, result: "changed", http: 200, sha256: "b".repeat(64), hashed_at: ts },
      { url: "https://example.org/ct-sample/never-cited", result: "broken", http: 404, sha256: null, hashed_at: null },
    ];
    const out = applyLinkResults(ix, "2026-10-16", results);
    expect(ix).toEqual(frozen); // the input is not changed
    expect(ArchiveIndex.parse(out)).toEqual(out);
    expect(out.editions).toEqual(ix.editions);
    expect(Object.keys(out.urls)).toEqual(Object.keys(ix.urls));
    expect(out.urls[nullKey]).toEqual({ ...ix.urls[nullKey], sha256: "a".repeat(64), hashed_at: ts, last_check: { date: "2026-10-16", result: "ok", http: 200 } });
    expect(out.urls[hashedKey]).toEqual({ ...ix.urls[hashedKey], last_check: { date: "2026-10-16", result: "changed", http: 200 } });
    for (const k of Object.keys(ix.urls)) if (k !== nullKey && k !== hashedKey) expect(out.urls[k], k).toEqual(ix.urls[k]);
  });
});
