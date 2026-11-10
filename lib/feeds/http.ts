import fs from "node:fs";
import path from "node:path";

// The fetch harness (SPEC §8.3): the only HTTP call in collect, the snapshot fetcher and the link check
// (git reads go through scripts/lib/git-source.ts). GET only, at most 5 redirects (https only after the
// first hop), one retry after 2 s on a timeout, a network error or a 5xx, a body cap (or a cut at the cap
// with `truncate`), an optional deadline, and errors reduced to a class. With CT_FIXTURE_FEEDS set, every
// URL is answered from <dir>/index.json and an unknown URL is a `dns` error. Collect runs requests through
// pool() (8 feeds, 16 per-id records at a time) under one fetchBudget() (240 s from the first request).

export type FetchErrorClass = "timeout" | "dns" | "tls" | `http_${number}` | "too_large" | "redirects" | "network" | "parse" | "schema" | "empty";

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  accept?: string;
  /** Sent as Accept-Language only when set (snapshots send a browser-like one, §4.12; plan A11). Fixture mode ignores headers. P3 S0. */
  acceptLanguage?: string;
  userAgent?: string;
  /** Retry once after this delay on a timeout, network error or 5xx. 0 turns the retry off. */
  retryDelayMs?: number;
  /** A body over `maxBytes` is cut there instead of failing `too_large` (snapshots and the link check, §8.3). P2 WP1. */
  truncate?: boolean;
  /** Epoch ms: each attempt's timeout is min(timeoutMs, deadline − now), and no attempt starts past it (`timeout`). P2 WP1. */
  deadline?: number;
  /**
   * Asked about every redirect target before it is requested: a reason ends the fetch with `redirects` and that
   * hop is never requested. The snapshot fetcher and the link check pass the blocked-host test, so a page that
   * redirects into a BLOCKED_HOSTS host is not read (§4.12 step 1). Fixture mode has no redirects.
   */
  refuseRedirect?: (url: string) => string | null;
}

export interface FetchResult {
  ok: boolean;
  status: number | null;
  /** The URL that answered, after redirects. */
  finalUrl: string;
  body: Buffer | null;
  contentType: string | null;
  error: FetchErrorClass | null;
  /** The raw error message: for logs only, never for a status file or a report. */
  detail: string | null;
  durationMs: number;
  attempts: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Per-request timeouts (§8.3): 15 s; 30 s for kev, nvd and each MyJVN page; 60 s per EPSS file; 90 s for deltaLog.json and each delta zip. */
export const FEED_TIMEOUTS = { default: 15_000, kev: 30_000, nvd: 30_000, myjvn: 30_000, epss: 60_000, deltaLog: 90_000, zip: 90_000 } as const;
/** Body caps (§8.3): 5 MB by default, 20 MB for KEV, EPSS and the disclosure dashboard's payload, 64 MB for deltaLog.json and the zips, 3 MB (truncated) for snapshots. */
export const FEED_MAX_BYTES = {
  default: 5 * 1024 * 1024,
  kev: 20 * 1024 * 1024,
  epss: 20 * 1024 * 1024,
  payload: 20 * 1024 * 1024,
  deltaLog: 64 * 1024 * 1024,
  zip: 64 * 1024 * 1024,
  snapshot: 3 * 1024 * 1024,
} as const;
const MAX_REDIRECTS = 5;

let cachedUserAgent: string | null = null;

/** run.json `user_agent`, read once. */
export function userAgent(): string {
  if (cachedUserAgent) return cachedUserAgent;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "run.json"), "utf8")) as { user_agent?: string };
    cachedUserAgent = cfg.user_agent ?? "CyberTracker/1.0";
  } catch {
    cachedUserAgent = "CyberTracker/1.0";
  }
  return cachedUserAgent;
}

/** Reduces a thrown fetch error to a class (SPEC §8.3). */
export function classifyError(e: unknown): FetchErrorClass {
  const err = e as { name?: string; code?: string; cause?: { code?: string; name?: string; message?: string }; message?: string };
  const code = err.cause?.code ?? err.code ?? "";
  const msg = `${err.message ?? ""} ${err.cause?.message ?? ""}`;
  if (err.name === "TimeoutError" || err.name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return "timeout";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (/CERT|SSL|TLS/i.test(code) || /certificate|tls|ssl/i.test(msg)) return "tls";
  return "network";
}

interface FixtureEntry { status?: number; file?: string; content_type?: string; error?: FetchErrorClass }

/**
 * A saved answer from `<dir>/index.json`. The body cap applies as it does live (`too_large`, or a cut with
 * `truncate`). The deadline does not: a saved file answers at once, and tests drive time with their own clock.
 */
function fromFixtures(dir: string, url: string, started: number, opts: FetchOptions): FetchResult {
  const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")) as Record<string, FixtureEntry>;
  const entry = index[url];
  const base = { finalUrl: url, durationMs: Date.now() - started, attempts: 1 };
  if (!entry) return { ...base, ok: false, status: null, body: null, contentType: null, error: "dns", detail: "not in fixture index" };
  if (entry.error) return { ...base, ok: false, status: null, body: null, contentType: null, error: entry.error, detail: "fixture error" };
  const status = entry.status ?? 200;
  const contentType = entry.content_type ?? null;
  const ok = status >= 200 && status < 300;
  if (!ok) return { ...base, ok, status, body: null, contentType, error: `http_${status}`, detail: null };
  let body = entry.file ? fs.readFileSync(path.join(dir, entry.file)) : Buffer.alloc(0);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (body.length > maxBytes) {
    if (!opts.truncate) return { ...base, ok: false, status, body: null, contentType, error: "too_large", detail: null };
    body = body.subarray(0, maxBytes);
  }
  return { ...base, ok, status, body, contentType, error: null, detail: null };
}

/** The body, at most `maxBytes`: "too_large" past it, or cut there when `truncate` is set. */
async function readCapped(res: Response, maxBytes: number, truncate: boolean): Promise<Buffer | "too_large"> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes && !truncate) return "too_large";
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (size + chunk.length > maxBytes) {
        if (!truncate) return "too_large";
        chunks.push(chunk.subarray(0, maxBytes - size));
        size = maxBytes;
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, size);
}

type Attempt = Omit<FetchResult, "attempts" | "durationMs">;

const timedOut = (url: string, detail: string): Attempt =>
  ({ ok: false, status: null, finalUrl: url, body: null, contentType: null, error: "timeout", detail });

async function once(url: string, opts: Required<Pick<FetchOptions, "timeoutMs" | "maxBytes">> & FetchOptions): Promise<Attempt> {
  let current = url;
  const remaining = opts.deadline === undefined ? Infinity : opts.deadline - Date.now();
  if (remaining <= 0) return timedOut(url, "deadline passed before the request");
  const signal = AbortSignal.timeout(Math.max(1, Math.min(opts.timeoutMs, remaining)));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (hop > 0 && !current.startsWith("https:")) {
      return { ok: false, status: null, finalUrl: current, body: null, contentType: null, error: "redirects", detail: "redirect to a non-https URL" };
    }
    let res: Response;
    try {
      res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          "User-Agent": opts.userAgent ?? userAgent(),
          Accept: opts.accept ?? "*/*",
          ...(opts.acceptLanguage ? { "Accept-Language": opts.acceptLanguage } : {}),
        },
      });
    } catch (e) {
      return { ok: false, status: null, finalUrl: current, body: null, contentType: null, error: classifyError(e), detail: String((e as Error).cause ?? (e as Error).message).slice(0, 300) };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel().catch(() => {});
      try {
        current = new URL(res.headers.get("location")!, current).toString();
      } catch {
        return { ok: false, status: res.status, finalUrl: current, body: null, contentType: null, error: "redirects", detail: "a redirect with an invalid Location" };
      }
      const refused = opts.refuseRedirect?.(current) ?? null;
      if (refused !== null) {
        return { ok: false, status: res.status, finalUrl: current, body: null, contentType: null, error: "redirects", detail: `a redirect to a refused URL (${refused})` };
      }
      continue;
    }
    const contentType = res.headers.get("content-type");
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: res.status, finalUrl: current, body: null, contentType, error: `http_${res.status}`, detail: null };
    }
    let body: Buffer | "too_large";
    try {
      body = await readCapped(res, opts.maxBytes, opts.truncate === true);
    } catch (e) {
      return { ok: false, status: res.status, finalUrl: current, body: null, contentType, error: classifyError(e), detail: String((e as Error).message).slice(0, 300) };
    }
    if (body === "too_large") return { ok: false, status: res.status, finalUrl: current, body: null, contentType, error: "too_large", detail: null };
    return { ok: true, status: res.status, finalUrl: current, body, contentType, error: null, detail: null };
  }
  return { ok: false, status: null, finalUrl: current, body: null, contentType: null, error: "redirects", detail: `more than ${MAX_REDIRECTS} redirects` };
}

function retryable(r: Attempt): boolean {
  if (r.ok) return false;
  if (r.error === "timeout" || r.error === "network") return true;
  return r.status !== null && r.status >= 500;
}

/**
 * One GET with SPEC §8.3's rules. Never throws. With `deadline`, no attempt starts past it (a first attempt
 * that cannot start is `timeout`, attempts 0) and the retry is skipped when its delay would cross it.
 */
export async function fetchFeed(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const started = Date.now();
  let attempts = 0;
  try {
    const fixtures = process.env.CT_FIXTURE_FEEDS;
    if (fixtures) return fromFixtures(fixtures, url, started, options);
    const opts = { timeoutMs: DEFAULT_TIMEOUT_MS, maxBytes: DEFAULT_MAX_BYTES, retryDelayMs: 2_000, ...options };
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
      return { ...timedOut(url, "deadline passed before the request"), attempts, durationMs: Date.now() - started };
    }
    attempts = 1;
    let r = await once(url, opts);
    const retryAt = Date.now() + opts.retryDelayMs;
    if (retryable(r) && opts.retryDelayMs > 0 && (opts.deadline === undefined || retryAt < opts.deadline)) {
      await new Promise((res) => setTimeout(res, opts.retryDelayMs));
      attempts = 2;
      r = await once(url, opts);
    }
    return { ...r, attempts, durationMs: Date.now() - started };
  } catch (e) {
    // Anything once() did not foresee (a bad option, an unreadable fixture index) is still a result.
    return { ok: false, status: null, finalUrl: url, body: null, contentType: null, error: "network", detail: String((e as Error).message).slice(0, 300), attempts, durationMs: Date.now() - started };
  }
}

// ── The harness pieces collect needs (§8.3: 8 feeds at a time, the per-id pool 16, a 240 s total cap) ──

/**
 * Runs `fn` over `items` with at most `limit` (at least 1) in flight; results in input order. When a call
 * throws, no further item starts, the calls in flight finish, and the first error is thrown.
 */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  let failed = false;
  let firstError: unknown = null;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!, i);
      } catch (e) {
        if (!failed) firstError = e;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: items.length === 0 ? 0 : width }, worker));
  if (failed) throw firstError;
  return out;
}

/** The shared 240 s cap: the clock starts at the first request (begin), and deadline() is begin + capMs. */
export interface FetchBudget {
  readonly started: number | null;
  readonly capMs: number;
  begin(now: number): void;
  deadline(): number;
}

/**
 * A fresh budget; capMs defaults to 240_000. begin() takes effect once (the first request); later calls
 * change nothing. Before begin(), deadline() is Infinity (nothing has started, so nothing is late).
 */
export function fetchBudget(capMs: number = 240_000): FetchBudget {
  let started: number | null = null;
  return {
    get started() {
      return started;
    },
    capMs,
    begin(now: number) {
      if (started === null) started = now;
    },
    deadline() {
      return started === null ? Number.POSITIVE_INFINITY : started + capMs;
    },
  };
}
