// Dangerous material (SPEC §4.12): NO_LIVE_IOC †, NO_EXPLOIT_LINK †, SECRET_LIKE †. These are the safety
// codes: they read the current lists in both modes (BLOCKED_HOSTS, the domains config lists, the
// github.tier1_paths), and validateAll() downgrades NO_LIVE_IOC and NO_EXPLOIT_LINK hits on archived briefs to
// warnings (ARCHIVE_WARNING_CODES); SECRET_LIKE stays an error everywhere. The matchers are exported so the
// chat edition's guard (lib/chat.ts) and later scripts can share them. No message ever repeats a payload or
// a secret; an indicator is shown only defanged.

import type { LoadedConfig } from "../config";
import type { SourceTiersFile } from "../schema/config";
import type { Tier } from "../schema/common";
import { blockedReason } from "../sources";
import { splitSentences } from "../text";
import { blockedEntry, defang, hostOf, matchPath } from "../urls";
import { IOC_TLDS, PAYLOAD_PATTERNS, type BlockReason } from "../vocab";
import { allStrings, isBrief, textFields } from "./shared";
import { defineRule, error, list, type AnyBrief, type Rule, type RuleInput, type ValidationIssue } from "./types";

/**
 * The safety codes (SPEC §4.12 "Archived briefs", §6 item 2): they keep reading the current lists in both
 * modes, and the site skips a brief carrying any of them. Keep this export when the rules land here; a
 * new safety rule joins it in the same PR. lib/validate.ts re-exports it.
 */
export const SAFETY_CODES = ["NO_LIVE_IOC", "NO_EXPLOIT_LINK", "SECRET_LIKE"] as const;
export type SafetyCode = (typeof SAFETY_CODES)[number];

/** At most this many characters of a defanged indicator go into a message. */
const SHOW_MAX = 80;

const shown = (s: string) => {
  const d = defang(s);
  return d.length > SHOW_MAX ? `${d.slice(0, SHOW_MAX - 1)}…` : d;
};

// ── NO_LIVE_IOC ──────────────────────────────────────────────────────────────────────────────────

export type IndicatorKind = "url" | "email" | "onion" | "ipv4" | "domain";

/** One live indicator found in a text: what it is and the text as written (show it only through defang()). */
export interface Indicator {
  kind: IndicatorKind;
  text: string;
}

const INDICATOR_NAMES: Record<IndicatorKind, string> = {
  url: "a URL", email: "an email address", onion: "an onion or I2P name", ipv4: "an IPv4 address", domain: "a domain",
};

/** A URL of any scheme ("scheme://"). hxxp:// and hxxps:// are the defanged forms and pass. */
const URL_RE = /(?<![\p{L}\p{N}+.-])([a-z][a-z0-9+.-]*):\/\/[^\s<>"'`]*/giu;
const DEFANGED_SCHEMES = new Set(["hxxp", "hxxps"]);
/** An email address; the defanged `[@]` never matches. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu;
/** Any .onion or .i2p name, in any case. */
const ONION_RE = /(?<![\p{L}\p{N}_.-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:onion|i2p)(?![\p{L}\p{N}_-])/giu;
/** Four dotted octets; each must be 255 or less, checked after the match. */
const IPV4_RE = /(?<![\p{L}\p{N}.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\p{L}\p{N}]|\.\p{N})/gu;
/** The IPv4 is the first or second word after "version", "v", "build", "firmware" or "release": a version number. */
const VERSION_CONTEXT_RE = /(?:^|[^\p{L}\p{N}])(?:version|v|build|firmware|release)\s+(?:\S+\s+)?$/iu;
const TLD_ALT = [...IOC_TLDS].sort((a, b) => b.length - a.length).join("|");
/** A lower-case domain whose last label is in IOC_TLDS (case-sensitive on purpose: "Booking.com" in prose is a name). */
const DOMAIN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_@.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLD_ALT})(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, "gu");

const blank = (s: string) => " ".repeat(s.length);

/**
 * The live indicators in a text (§4.12 NO_LIVE_IOC), in this order: URLs of any scheme (not hxxp:// or
 * hxxps://), email addresses, .onion and .i2p names, IPv4 addresses (every octet 255 or less, not within
 * two words after "version", "v", "build", "firmware" or "release"), then lower-case domains on IOC_TLDS
 * whose host is not on `listedHosts` (the host itself or a parent). A match is blanked before the next
 * kind is read, so a domain inside a URL is reported once, as the URL. Defanged forms ([.], (.), [@], [:])
 * never match.
 */
export function liveIndicators(text: string, listedHosts: readonly string[] = []): Indicator[] {
  const out: Indicator[] = [];
  let s = text;
  s = s.replace(URL_RE, (m: string, scheme: string) => {
    if (DEFANGED_SCHEMES.has(scheme.toLowerCase())) return blank(m);
    out.push({ kind: "url", text: m.replace(/[.,;:!?)\]}]+$/u, "") });
    return blank(m);
  });
  s = s.replace(EMAIL_RE, (m) => {
    out.push({ kind: "email", text: m });
    return blank(m);
  });
  s = s.replace(ONION_RE, (m) => {
    out.push({ kind: "onion", text: m });
    return blank(m);
  });
  s = s.replace(IPV4_RE, (m: string, a: string, b: string, c: string, d: string, offset: number, whole: string) => {
    if ([a, b, c, d].some((o) => Number(o) > 255)) return m;
    if (VERSION_CONTEXT_RE.test(whole.slice(0, offset))) return m;
    out.push({ kind: "ipv4", text: m });
    return blank(m);
  });
  for (const m of s.matchAll(DOMAIN_RE)) {
    if (!isListedHost(m[0], listedHosts)) out.push({ kind: "domain", text: m[0] });
  }
  return out;
}

/** True when `host` is one of `hosts` or a subdomain of one. */
export function isListedHost(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  return hosts.some((d) => h === d || h.endsWith(`.${d}`));
}

const listedCache = new WeakMap<object, string[]>();

/**
 * The hosts NO_LIVE_IOC lets through (§4.12): every domain source-tiers.json (publishers) and vendors.json
 * list, without a path prefix. Read from the current config in both modes (a safety list).
 */
export function listedHosts(config: Pick<LoadedConfig, "sourceTiers" | "vendors">): string[] {
  const key = config.sourceTiers as object;
  const hit = listedCache.get(key);
  if (hit && listedCache.get(config.vendors as object) === hit) return hit;
  const hosts = new Set<string>();
  const add = (d: string) => hosts.add(d.split("/")[0]!.toLowerCase());
  for (const p of config.sourceTiers.publishers) p.domains.forEach(add);
  for (const v of config.vendors.vendors) v.domains.forEach(add);
  const out = [...hosts];
  listedCache.set(key, out);
  listedCache.set(config.vendors as object, out);
  return out;
}

/** "a domain (evil[.]example[.]org) and an IPv4 address (192[.]0[.]2[.]1)". */
function describeIndicators(found: readonly Indicator[]): string {
  const parts = found.map((f) => `${INDICATOR_NAMES[f.kind]} (${shown(f.text)})`);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** NO_LIVE_IOC † (brief): a live URL, email address, onion name, IPv4 address or unlisted domain in a prose field, quoted field or title. */
const noLiveIoc = defineRule({
  code: "NO_LIVE_IOC",
  scope: "brief",
  dataOnly: true,
  check: ({ draft, config }) => {
    const hosts = listedHosts(config);
    const out: ValidationIssue[] = [];
    for (const f of textFields(draft)) {
      const found = liveIndicators(f.text, hosts);
      if (!found.length) continue;
      out.push(error("NO_LIVE_IOC", f.path,
        `${f.path} holds ${found.length === 1 ? "a live indicator" : `${found.length} live indicators`}: ${describeIndicators(found)}. Defang each (hxxp:// for the scheme, [.] for every dot, [@] for @, [:] before a port) or remove it.`,
        "The page shows indicators only as defanged plain text; a domain that source-tiers.json or vendors.json lists may stay as it is."));
    }
    return out;
  },
});

// ── NO_EXPLOIT_LINK ──────────────────────────────────────────────────────────────────────────────

/** NO_EXPLOIT_LINK's tier 3 path segments (§4.12). */
export const EXPLOIT_PATH_SEGMENTS: readonly string[] = ["poc", "exploit", "exploits", "payload", "0day"];

const REASON_TEXT: Record<BlockReason, string> = {
  exploit_code: "an exploit archive or code host",
  paste: "a paste or raw-file host",
  messaging: "a messaging service",
  shortener: "a link shortener",
  redirect: "a redirect wrapper",
  archive: "an archive copy",
  leak_site: "a leak site or hidden service",
  scan_query: "a scanner search",
};

/**
 * Why a cited URL is an exploit link (§4.12 NO_EXPLOIT_LINK), or null: on a BLOCKED_HOSTS entry other than
 * the `redirect` and `archive` ones (SOURCE_URL's); a github.com path matching no `github.tier1_paths`
 * regex; or, when `tier` is 3, a path segment poc, exploit, exploits, payload or 0day (on matchPath()).
 */
export function exploitLinkProblem(url: string, tier: Tier | null | undefined, sourceTiers: Pick<SourceTiersFile, "github">): string | null {
  const reason = blockedReason(url, sourceTiers);
  if (reason === "redirect" || reason === "archive") return null;
  if (reason !== null) {
    const host = hostOf(url) ?? "an unreadable host";
    if (!blockedEntry(url)) return `is a github.com path outside the advisory paths (${shown(host)}): code repositories are never cited`;
    return `is on ${REASON_TEXT[reason]} (${shown(host)})`;
  }
  if (tier !== 3) return null;
  let path: string;
  try {
    path = matchPath(new URL(url).pathname);
  } catch {
    return null;
  }
  const seg = path.split("/").find((x) => EXPLOIT_PATH_SEGMENTS.includes(x));
  return seg ? `is a tier 3 page whose path holds "${seg}"` : null;
}

/** The names of the PAYLOAD_PATTERNS a text matches (the name, never the match). */
export function payloadsIn(text: string): string[] {
  return PAYLOAD_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

const SCANNER_RE = /(?<![\p{L}\p{N}])(?:shodan|censys|fofa|zoomeye)(?![\p{L}\p{N}])/iu;
/** `field:value` search syntax: `port:502`, `http.title:"..."`, `product:"X"`; a URL scheme (value starting "/") is not one. */
const FIELD_VALUE_RE = /(?<![\p{L}\p{N}_/:.-])[A-Za-z][A-Za-z0-9_.]*:(?:"[^"]*"|[^\s"/][^\s"]*)/u;

/** True when one sentence of `text` names Shodan, Censys, FOFA or ZoomEye and uses `field:value` syntax (a scanner query). */
export function hasScannerQuery(text: string): boolean {
  return splitSentences(text).some((s) => SCANNER_RE.test(s) && FIELD_VALUE_RE.test(s));
}

/** The URL fields of a published Brief besides `sources[].url`, with their paths: the copies of source URLs publish writes. */
function briefUrlFields(b: AnyBrief): { path: string; url: string }[] {
  if (!isBrief(b)) return [];
  const out: { path: string; url: string }[] = [];
  const push = (path: string, url: unknown) => {
    if (typeof url === "string") out.push({ path, url });
  };
  (b.items ?? []).forEach((it, i) => {
    (it?.cves ?? []).forEach((c, k) => {
      push(`items[${i}].cves[${k}].patch.source_url`, c?.patch?.source_url);
      (c?.exploitation_evidence ?? []).forEach((e, j) => push(`items[${i}].cves[${k}].exploitation_evidence[${j}].source_url`, e?.source_url));
    });
    push(`items[${i}].release.source_url`, it?.release?.source_url);
  });
  (b.scoreboard?.entries ?? []).forEach((e, i) => push(`scoreboard.entries[${i}].source_url`, e?.source_url));
  (b.corrections ?? []).forEach((c, i) => push(`corrections[${i}].source_url`, c?.source_url));
  (b.regions?.signals ?? []).forEach((s, i) => push(`regions.signals[${i}].url`, s?.url));
  return out;
}

/**
 * NO_EXPLOIT_LINK † (brief): a cited URL on a blocked host (not a redirect or archive), a github.com path
 * outside `github.tier1_paths`, or a tier 3 URL with an exploit-like path segment; in a text field, a
 * scanner query or a PAYLOAD_PATTERNS match. A Brief's other URL fields get the host and github checks.
 */
const noExploitLink = defineRule({
  code: "NO_EXPLOIT_LINK",
  scope: "brief",
  dataOnly: true,
  check: (input: RuleInput) => {
    const { draft, derived, config } = input;
    const out: ValidationIssue[] = [];
    const fix = "Cite the vendor advisory, the CVE record or a newsroom report instead; items say whether a public exploit is reported (exploit_reported_in_sources), never link one.";
    (draft.sources ?? []).forEach((s, i) => {
      if (!s || typeof s.url !== "string") return;
      const problem = exploitLinkProblem(s.url, derived.tierBySourceId.get(s.id), config.sourceTiers);
      if (problem) out.push(error("NO_EXPLOIT_LINK", `sources[${i}].url`, `${s.id}'s URL ${problem}. Remove ${s.id} and every citation of it, then renumber the ids.`, fix));
    });
    for (const { path, url } of briefUrlFields(draft)) {
      const problem = exploitLinkProblem(url, null, config.sourceTiers);
      if (problem) out.push(error("NO_EXPLOIT_LINK", path, `${path} ${problem}.`, fix));
    }
    for (const f of textFields(draft)) {
      const payloads = payloadsIn(f.text);
      if (payloads.length) {
        out.push(error("NO_EXPLOIT_LINK", f.path,
          `${f.path} holds text that looks like attack code (${list(payloads)}). Describe the flaw in words and remove the code-like text.`,
          "No commands, payloads, code fences or traversal strings anywhere in a brief."));
      }
      if (hasScannerQuery(f.text)) {
        out.push(error("NO_EXPLOIT_LINK", f.path,
          `${f.path} holds a scanner query (Shodan, Censys, FOFA or ZoomEye with field:value search syntax in one sentence). Give the exposure figure and who reported it, never the query.`));
      }
    }
    return out;
  },
});

// ── SECRET_LIKE ──────────────────────────────────────────────────────────────────────────────────

/** SECRET_LIKE's patterns (§4.12), each with the name a message gives instead of the match. */
export const SECRET_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "an AWS access key id", re: /AKIA[0-9A-Z]{16}/u },
  { name: "a GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}/u },
  { name: "a GitHub fine-grained token", re: /github_pat_[A-Za-z0-9_]{20,}/u },
  { name: "a Slack token", re: /xox[abprs]-[A-Za-z0-9-]{10,}/u },
  { name: "a Google API key", re: /AIza[0-9A-Za-z_-]{35}/u },
  { name: "an sk- secret key", re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}/u },
  { name: "a private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
];

/** The names of the SECRET_PATTERNS a text matches (never the match). */
export function secretsIn(text: string): string[] {
  return SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

/** SECRET_LIKE † (brief): any string shaped like a credential. The message names the path and the pattern, never the match. */
const secretLike = defineRule({
  code: "SECRET_LIKE",
  scope: "brief",
  dataOnly: true,
  check: ({ draft }) => allStrings(draft).flatMap((s) => {
    const names = secretsIn(s.text);
    return names.length
      ? [error("SECRET_LIKE", s.path,
        `${s.path} holds a string shaped like ${list(names)}. Remove it: the repo is public, and GitHub push protection would reject the push and lose the edition.`,
        "Never copy tokens, keys or credentials from a page, even a leaked one being reported on.")]
      : [];
  }),
});

export const safetyRules: Rule[] = [noLiveIoc, noExploitLink, secretLike];
