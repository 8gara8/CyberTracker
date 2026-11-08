// URL helpers (SPEC §4.1, §4.2, §4.12): normalisation for evidence matching and duplicate checks, defanging
// for indicators shown as text, and host helpers. Adapted from the Europe fork's lib/urls.ts.

import { BLOCKED_HOSTS, type BlockedHost } from "./vocab";

const ARCHIVE_RE = /^(?:https?:\/\/)?(?:www\.)?web\.archive\.org\/web\/[^/]+\/(.+)$/i;
const TRACKING_PARAM_RE = /^(?:utm_.*|fbclid|gclid|mc_cid|mc_eid)$/i;

/** Strips a `web.archive.org/web/<timestamp>/` prefix; returns the URL unchanged otherwise. */
export function stripArchivePrefix(url: string): string {
  const m = ARCHIVE_RE.exec(url.trim());
  if (!m) return url.trim();
  const inner = m[1]!;
  return /^https?:\/\//i.test(inner) ? inner : `https://${inner.replace(/^https?:\/+/i, "")}`;
}

/**
 * Canonical form used to compare URLs: https scheme, lower-case host without `www.`, no fragment, no
 * tracking parameters, sorted query, no trailing slash, and any Wayback prefix removed. Unparseable
 * input comes back trimmed but otherwise unchanged.
 */
export function normalizeUrl(url: string): string {
  const raw = stripArchivePrefix(url);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return raw;

  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/%[0-9a-f]{2}/gi, (s) => s.toUpperCase()).replace(/\/+$/, "");
  const params = [...u.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM_RE.test(key))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  const port = u.port ? `:${u.port}` : "";
  return `https://${host}${port}${path}${query}`;
}

/** True for a well-formed absolute https URL. */
export function isHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.includes(".");
  } catch {
    return false;
  }
}

/** The lower-case host of a URL, or null when it doesn't parse. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** True when `host` is `domain` or one of its subdomains. */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/** Every http(s) URL in a block of text, with trailing punctuation trimmed. */
export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s"'<>\\)\]}]+/gi) ?? [];
  return found.map((u) => u.replace(/[.,;:!?]+$/, ""));
}

/**
 * Makes an indicator safe to show as text: `http` schemes become `hxxp`, dots in host names become
 * `[.]`, `@` becomes `[@]` and a port colon becomes `[:]` (the defanged forms NO_LIVE_IOC accepts).
 */
export function defang(text: string): string {
  return text
    .replace(/\bhttp(s?):\/\//gi, (_m, s: string) => `hxxp${s}://`)
    .replace(/@/g, "[@]")
    .replace(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)(:\d{2,5})?\b/gi, (m, host: string, port?: string) =>
      /^\d+(?:\.\d+)*$/.test(host) && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
        ? m
        : `${host.replace(/\./g, "[.]")}${port ? `[:]${port.slice(1)}` : ""}`,
    );
}

/**
 * A URL path in the one form every path rule compares (SPEC §4.2): percent-escapes of unreserved
 * characters decoded (RFC 3986 §6.2.2.2), other escapes kept, runs of slashes collapsed, lower-cased. So
 * `/%73earch` and `//search` compare as `/search` (PR 2 review, round 3).
 */
export function matchPath(pathname: string): string {
  return pathname
    .replace(/%([0-9a-f]{2})/gi, (m: string, hex: string) => {
      const c = String.fromCharCode(parseInt(hex, 16));
      return /[A-Za-z0-9\-._~]/.test(c) ? c : m;
    })
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
}

/**
 * The BLOCKED_HOSTS entry a URL falls under, or null (Appendix B.3). A host entry matches the host and
 * every subdomain; an entry with a path matches that host (and its subdomains) and the path prefix, on
 * `matchPath()`; ".onion" and ".i2p" match any host ending so. Unparseable URLs are not matched here.
 */
export function blockedEntry(url: string): BlockedHost | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  for (const entry of BLOCKED_HOSTS) {
    const p = entry.pattern.toLowerCase();
    if (p.startsWith(".")) {
      if (host.endsWith(p)) return entry;
      continue;
    }
    const slash = p.indexOf("/");
    if (slash < 0) {
      if (hostMatches(host, p)) return entry;
      continue;
    }
    const [h, path] = [p.slice(0, slash), p.slice(slash)];
    if (hostMatches(host, h) && matchPath(u.pathname).startsWith(path)) return entry;
  }
  return null;
}
