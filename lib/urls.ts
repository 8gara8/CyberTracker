// URL helpers (SPEC §4.1, §4.2, §4.12): normalisation for evidence matching and duplicate checks, defanging
// for indicators shown as text, and host helpers. Adapted from the Europe fork's lib/urls.ts.

import sourceTiersFile from "../config/source-tiers.json";
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

/**
 * The flags `github.tier1_paths` compile with (§4.11). They compare matchPath() forms, which are lower-cased
 * (§4.2), while the seed patterns are written with capitals (`^/CVEProject/`, `GHSA-`), so "iu", not §4.11's
 * default "u". lib/sources.ts re-exports it; lib/config.ts's CONFIG_REGEX check compiles with the same flags.
 */
export const TIER1_PATH_FLAGS = "iu";

/**
 * For a github.com URL (after normalizeUrl()), whether its matchPath() path, trailing slashes removed, matches
 * one of `tier1Paths`; null for any other host, a scheme other than http(s), or an unparseable URL. The one
 * github.com path check: isGithubTier1() and blockedReason() in lib/sources.ts and safeHref() read it.
 */
export function githubPathTier1(url: string, tier1Paths: readonly RegExp[]): boolean | null {
  let u: URL;
  try {
    u = new URL(normalizeUrl(url));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.hostname.toLowerCase().replace(/\.$/, "") !== "github.com") return null;
  const p = matchPath(u.pathname).replace(/\/+$/, "") || "/";
  return tier1Paths.some((re) => re.test(p));
}

/** The longest URL safeHref() links (§7 "Untrusted text" item 3). */
export const SAFE_HREF_MAX = 2_000;

let siteTier1Paths: RegExp[] | null = null;

/**
 * safeHref(url) (§7 "Untrusted text" item 3): the URL as given when `new URL()` parses it, the protocol is
 * `https:`, there is no username or password, it is at most 2,000 characters, it is not on BLOCKED_HOSTS
 * (blockedEntry(), §4.2) and it is not a blocked github.com path (a path matching no `github.tier1_paths`
 * regex of the committed config/source-tiers.json, §4.11); else null, and the caller renders plain text.
 * `ExternalLink` (components/ui/) is the only renderer of a content URL and the only caller on the site.
 */
export function safeHref(url: string): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > SAFE_HREF_MAX) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return null;
  if (blockedEntry(url) !== null) return null;
  siteTier1Paths ??= sourceTiersFile.github.tier1_paths.map((p) => new RegExp(p, TIER1_PATH_FLAGS));
  if (githubPathTier1(url, siteTier1Paths) === false) return null;
  return url;
}
