// Source tiers and publishers (SPEC §4.11 source-tiers.json and vendors.json, §4.12 "Tier lookup"). The
// config comes in as a parameter, so this file stays pure: lib/config.ts loads it, the callers pass it.
// lib/apply.ts freezes what publisherFor() returns into each cited source; collect stamps pack items.

import type { PublisherKind, SourceType, Tier } from "./schema/common";
import type { SourceTiersFile, VendorsFile } from "./schema/config";
import { blockedEntry, githubPathTier1, matchPath, normalizeUrl, TIER1_PATH_FLAGS } from "./urls";
import type { BlockReason } from "./vocab";

/**
 * What publisherFor() reads: source-tiers.json and vendors.json as loaded. The domain index is cached per
 * pair of objects, so treat them as immutable: pass a copy (as `loadConfig({ overrides })` does) to change one.
 */
export interface PublisherConfig {
  sourceTiers: Pick<SourceTiersFile, "publishers" | "github">;
  vendors: Pick<VendorsFile, "vendors">;
}

/** §4.12: `{ tier, publisher, publisher_name, kind, state_label, sole_newsroom_for_critical }`. */
export interface PublisherInfo {
  tier: Tier;
  /** A source-tiers.json id, `vendor:<id>` for an implicit vendor publisher, or `host:<host>` when unlisted. */
  publisher: string;
  /** At most 60 characters. */
  publisher_name: string;
  kind: PublisherKind;
  state_label: string | null;
  sole_newsroom_for_critical: boolean;
}

/** The publisher that owns github.com paths matching `github.tier1_paths` (§4.11, Appendix B.3). */
export const GITHUB_ADVISORIES = "github-advisories";
const GITHUB_HOST = "github.com";
const NAME_MAX = 60;

interface DomainEntry {
  host: string;
  /** matchPath() form without a trailing slash, or "" for a host-only entry. */
  path: string;
  info: PublisherInfo;
  explicit: boolean;
}

interface Index {
  byHost: Map<string, DomainEntry[]>;
  tier1Paths: RegExp[];
  github: PublisherInfo;
}

const cache = new WeakMap<object, WeakMap<object, Index>>();
const tier1Cache = new WeakMap<object, RegExp[]>();

function splitDomain(domain: string): { host: string; path: string } {
  const d = domain.trim().toLowerCase();
  const slash = d.indexOf("/");
  if (slash < 0) return { host: d, path: "" };
  return { host: d.slice(0, slash), path: matchPath(d.slice(slash)).replace(/\/+$/, "") };
}

export { TIER1_PATH_FLAGS };

/**
 * Compiles the `github.tier1_paths` regexes with TIER1_PATH_FLAGS ("iu", lib/urls.ts): they compare
 * matchPath() forms, which are lower-cased (§4.2), while the seed patterns are written with capitals.
 */
export function compileTier1Paths(sourceTiers: Pick<SourceTiersFile, "github">): RegExp[] {
  return sourceTiers.github.tier1_paths.map((p) => new RegExp(p, TIER1_PATH_FLAGS));
}

function tier1For(sourceTiers: Pick<SourceTiersFile, "github">): RegExp[] {
  let res = tier1Cache.get(sourceTiers);
  if (!res) {
    res = compileTier1Paths(sourceTiers);
    tier1Cache.set(sourceTiers, res);
  }
  return res;
}

function buildIndex(cfg: PublisherConfig): Index {
  const byHost = new Map<string, DomainEntry[]>();
  const add = (domain: string, info: PublisherInfo, explicit: boolean) => {
    const { host, path } = splitDomain(domain);
    // github.com belongs to step 1 alone: its tier 1 paths are github-advisories, every other path is blocked.
    if (host === GITHUB_HOST) return;
    const list = byHost.get(host) ?? [];
    if (list.some((e) => e.path === path && (e.explicit || !explicit))) return; // the explicit (or first) entry wins
    const at = list.findIndex((e) => e.path === path);
    if (at >= 0) list.splice(at, 1);
    list.push({ host, path, info, explicit });
    byHost.set(host, list);
  };
  for (const p of cfg.sourceTiers.publishers) {
    const info: PublisherInfo = {
      tier: p.tier, publisher: p.id, publisher_name: p.name.slice(0, NAME_MAX), kind: p.kind, state_label: p.state_label,
      sole_newsroom_for_critical: p.sole_newsroom_for_critical,
    };
    for (const d of p.domains) add(d, info, true);
  }
  for (const v of cfg.vendors.vendors) {
    const info: PublisherInfo = {
      tier: 1, publisher: `vendor:${v.id}`, publisher_name: v.name.slice(0, NAME_MAX), kind: "vendor", state_label: null,
      sole_newsroom_for_critical: true,
    };
    for (const d of v.domains) add(d, info, false);
  }
  // Longest path prefix first within a host.
  for (const list of byHost.values()) list.sort((a, b) => b.path.length - a.path.length);
  const gh = cfg.sourceTiers.publishers.find((p) => p.id === GITHUB_ADVISORIES);
  const github: PublisherInfo = {
    tier: 1, publisher: GITHUB_ADVISORIES, publisher_name: (gh?.name ?? "GitHub Advisory Database").slice(0, NAME_MAX),
    kind: gh?.kind ?? "other", state_label: gh?.state_label ?? null, sole_newsroom_for_critical: gh?.sole_newsroom_for_critical ?? true,
  };
  return { byHost, tier1Paths: tier1For(cfg.sourceTiers), github };
}

function indexFor(cfg: PublisherConfig): Index {
  let inner = cache.get(cfg.sourceTiers);
  if (!inner) {
    inner = new WeakMap();
    cache.set(cfg.sourceTiers, inner);
  }
  let idx = inner.get(cfg.vendors);
  if (!idx) {
    idx = buildIndex(cfg);
    inner.set(cfg.vendors, idx);
  }
  return idx;
}

/** Host and matchPath() path of a URL after normalizeUrl() (§4.1), or null when it doesn't parse. */
function parts(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(normalizeUrl(url));
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return { host: u.hostname.toLowerCase().replace(/\.$/, ""), path: matchPath(u.pathname).replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

function pathUnder(path: string, prefix: string): boolean {
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

/** True when a github.com URL's path matches a `github.tier1_paths` regex (on its matchPath() form). */
export function isGithubTier1(url: string, sourceTiers: Pick<SourceTiersFile, "github">): boolean {
  return githubPathTier1(url, tier1For(sourceTiers)) === true;
}

/**
 * The blocked-list reason for a URL (§4.2, §4.11): its `BLOCKED_HOSTS` entry, or `exploit_code` for a
 * github.com path that matches no `github.tier1_paths` regex. Null when the URL is not blocked or doesn't
 * parse. NO_EXPLOIT_LINK, SOURCE_URL, collect, the snapshot fetcher and the link check read the same.
 */
export function blockedReason(url: string, sourceTiers: Pick<SourceTiersFile, "github">): BlockReason | null {
  const entry = blockedEntry(url);
  if (entry) return entry.reason;
  if (githubPathTier1(url, tier1For(sourceTiers)) === false) return "exploit_code";
  return null;
}

/** True when `url` is on a config domain entry: the host or a subdomain, and the path prefix if any. */
export function urlOnDomain(url: string, domain: string): boolean {
  const p = parts(url);
  if (!p) return false;
  const d = splitDomain(domain);
  return (p.host === d.host || p.host.endsWith(`.${d.host}`)) && pathUnder(p.path, d.path);
}

/** True when `url` is on any of `domains` (e.g. a vendor's own advisory domains, for FLAW_EVIDENCE). */
export function urlOnAnyDomain(url: string, domains: readonly string[]): boolean {
  return domains.some((d) => urlOnDomain(url, d));
}

function unlisted(host: string, tier: Tier): PublisherInfo {
  const safe = host.replace(/[^a-z0-9.-]/g, "-") || "invalid";
  return { tier, publisher: `host:${safe}`, publisher_name: safe.slice(0, NAME_MAX), kind: "other", state_label: null, sole_newsroom_for_critical: true };
}

/**
 * publisherFor(url, source_type) (§4.12), on normalizeUrl(url); the first hit wins:
 * (1) a github.com path matching a `github.tier1_paths` regex: github-advisories, tier 1 (any other
 *     github.com path is blocked, `blockedReason()`, and comes back tier 3, `host:github.com`);
 * (2) the longest matching domain, host first and then each parent, a path entry before its host entry,
 *     across source-tiers.json `publishers` and the implicit vendor publishers (`vendor:<id>`, tier 1, kind
 *     vendor, from vendors.json `domains`; an explicit entry for the same domain wins);
 * (3) a `victim` source on an unlisted host: tier 1, kind other, `host:<host>`;
 * (4) anything else: tier 3, kind other, `host:<host>`.
 */
export function publisherFor(url: string, sourceType: SourceType, cfg: PublisherConfig): PublisherInfo {
  const idx = indexFor(cfg);
  const p = parts(url);
  if (!p) return unlisted("invalid", 3);
  if (p.host === GITHUB_HOST) {
    return idx.tier1Paths.some((re) => re.test(p.path || "/")) ? idx.github : unlisted(GITHUB_HOST, 3);
  }
  const labels = p.host.split(".");
  for (let i = 0; i < labels.length; i += 1) {
    const level = labels.slice(i).join(".");
    const hit = idx.byHost.get(level)?.find((e) => pathUnder(p.path, e.path));
    if (hit) return hit.info;
  }
  return unlisted(p.host, sourceType === "victim" ? 1 : 3);
}
