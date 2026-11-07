import fs from "node:fs";
import path from "node:path";

// The fetch harness (SPEC §8.3): the only network call in collect, the snapshot fetcher, the link check
// and probe.ts. GET only, at most 5 redirects (https only after the first hop), one retry after 2 s on
// a timeout, a network error or a 5xx, a body cap, and errors reduced to a class. With CT_FIXTURE_FEEDS
// set, every URL is answered from <dir>/index.json and an unknown URL is a `dns` error.
// P0 lands fetchFeed() only; P2 adds the concurrency pool and the total cap.

export type FetchErrorClass = "timeout" | "dns" | "tls" | `http_${number}` | "too_large" | "redirects" | "network" | "parse" | "schema" | "empty";

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  accept?: string;
  userAgent?: string;
  /** Retry once after this delay on a timeout, network error or 5xx. 0 turns the retry off. */
  retryDelayMs?: number;
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

function fromFixtures(dir: string, url: string, started: number): FetchResult {
  const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")) as Record<string, FixtureEntry>;
  const entry = index[url];
  const base = { finalUrl: url, durationMs: Date.now() - started, attempts: 1 };
  if (!entry) return { ...base, ok: false, status: null, body: null, contentType: null, error: "dns", detail: "not in fixture index" };
  if (entry.error) return { ...base, ok: false, status: null, body: null, contentType: null, error: entry.error, detail: "fixture error" };
  const status = entry.status ?? 200;
  const body = entry.file ? fs.readFileSync(path.join(dir, entry.file)) : Buffer.alloc(0);
  const ok = status >= 200 && status < 300;
  return { ...base, ok, status, body, contentType: entry.content_type ?? null, error: ok ? null : `http_${status}`, detail: null };
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer | "too_large"> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return "too_large";
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBytes) return "too_large";
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function once(url: string, opts: Required<Pick<FetchOptions, "timeoutMs" | "maxBytes">> & FetchOptions): Promise<Omit<FetchResult, "attempts" | "durationMs">> {
  let current = url;
  const signal = AbortSignal.timeout(opts.timeoutMs);
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
        headers: { "User-Agent": opts.userAgent ?? userAgent(), Accept: opts.accept ?? "*/*" },
      });
    } catch (e) {
      return { ok: false, status: null, finalUrl: current, body: null, contentType: null, error: classifyError(e), detail: String((e as Error).cause ?? (e as Error).message).slice(0, 300) };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      await res.body?.cancel().catch(() => {});
      continue;
    }
    const contentType = res.headers.get("content-type");
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: res.status, finalUrl: current, body: null, contentType, error: `http_${res.status}`, detail: null };
    }
    let body: Buffer | "too_large";
    try {
      body = await readCapped(res, opts.maxBytes);
    } catch (e) {
      return { ok: false, status: res.status, finalUrl: current, body: null, contentType, error: classifyError(e), detail: String((e as Error).message).slice(0, 300) };
    }
    if (body === "too_large") return { ok: false, status: res.status, finalUrl: current, body: null, contentType, error: "too_large", detail: null };
    return { ok: true, status: res.status, finalUrl: current, body, contentType, error: null, detail: null };
  }
  return { ok: false, status: null, finalUrl: current, body: null, contentType: null, error: "redirects", detail: `more than ${MAX_REDIRECTS} redirects` };
}

function retryable(r: Omit<FetchResult, "attempts" | "durationMs">): boolean {
  if (r.ok) return false;
  if (r.error === "timeout" || r.error === "network") return true;
  return r.status !== null && r.status >= 500;
}

/** One GET with SPEC §8.3's rules. Never throws. */
export async function fetchFeed(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const started = Date.now();
  const fixtures = process.env.CT_FIXTURE_FEEDS;
  if (fixtures) return fromFixtures(fixtures, url, started);
  const opts = { timeoutMs: DEFAULT_TIMEOUT_MS, maxBytes: DEFAULT_MAX_BYTES, retryDelayMs: 2_000, ...options };
  let r = await once(url, opts);
  let attempts = 1;
  if (retryable(r) && opts.retryDelayMs > 0) {
    await new Promise((res) => setTimeout(res, opts.retryDelayMs));
    r = await once(url, opts);
    attempts = 2;
  }
  return { ...r, attempts, durationMs: Date.now() - started };
}
