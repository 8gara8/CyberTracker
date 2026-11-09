// Scrubs a feed body that `npm run sources:check` left in cache/check/feeds/ into a fixture (fixtures plan
// §3.5, feeds plan §8), for the Kobol capture session:
//
//   tsx fixtures/src/scrub-feed.ts <kind> <cache file> <fixture file> [--keep CVE-…,CVE-…]
//   kind: rss | rdf | atom | epss | anthropic-cvd | exchange | myjvn | nvd
//
// It keeps the structure, namespaces, dates, ids and structured NVD fields (CVSS vectors, status words);
// replaces titles, descriptions, summaries and other free text with invented SAMPLE text (keeping only the
// registry keywords, exchange terms and CVE ids the text held, so the fixture still exercises must_match
// and merging), and authors, names and credits with SAMPLE Author or SAMPLE Researcher, whatever their
// namespace prefix (dc:, a10:, atom:, itunes:); rewrites every link to https://<host>/ct-sample/<slug>,
// where <host> is the link's own only when it is a registry host or a listed publisher (else
// www.example.com) and <slug> is an id the path ended in (a CVE, GHSA, JVNDB, TVN or JPCERT id) or a
// counter (item-1, img-1), never other path text; removes e-mail addresses (a JSON string that held one
// besides the address is invented whole); drops reference lists; caps items at 6 (EPSS: the fixture
// world's CVEs plus 40 filler rows). It refuses (exit 1, nothing written) when a link stays on a blocked
// host (BLOCKED_HOSTS, or a github.com path outside the tier 1 paths), when a link in another scheme is
// left, or when a URL kept as written is not a known XML namespace. Exit 2 is a usage error.
// The input is untrusted data: nothing in it is followed, fetched or run. Read the output in full before
// committing it. Not part of fixtures:gen (its inputs are Kobol's cache/).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { loadConfig, type LoadedConfig } from "../../lib/config";
import { EXCHANGE_TERMS } from "../../lib/feeds/exchange";
import { compareCveIds } from "../../lib/ids";
import { blockedReason, publisherFor, type PublisherConfig } from "../../lib/sources";
import { normalizeUrl } from "../../lib/urls";

export const SCRUB_KINDS = ["rss", "rdf", "atom", "epss", "anthropic-cvd", "exchange", "myjvn", "nvd"] as const;
export type ScrubKind = (typeof SCRUB_KINDS)[number];
export const SCRUB_ITEMS_MAX = 6;
export const EPSS_FILLER_ROWS = 40;

/**
 * URL prefixes kept as written: XML namespace, schema and vocabulary identifiers, never links a reader
 * follows. The http ones are exactly the prefixes tests/feeds.test.ts and tests/fixture-safety.test.ts allow
 * over http; a capture that declares another namespace is refused until the lists grow together. Kobol's
 * captures of 2026-11-09 added the comment API (WordPress feeds), Media RSS, the iTunes podcast DTD and
 * NHK's news module.
 */
export const NAMESPACE_PREFIXES = [
  "http://purl.org/", "http://www.w3.org/", "http://jvn.jp/rss/", "http://data-marking.mitre.org/", "http://jvndb.jvn.jp/myjvn/",
  "http://www.us-cert.gov/tlp/", "http://wellformedweb.org/CommentAPI/", "http://search.yahoo.com/mrss/",
  "http://www.itunes.com/dtds/podcast-1.0.dtd", "http://news.web.nhk/rss/rss2.0/modules/nhknews/",
  "https://purl.org/", "https://www.w3.org/", "https://jvndb.jvn.jp/schema/",
] as const;
/** Organisational addresses a parser reads (NVD marks its own scores with it); every other address is replaced. */
const KEEP_EMAILS: ReadonlySet<string> = new Set(["nvd@nist.gov"]);

export interface ScrubOptions {
  /** source-tiers.json: its blocked github paths, and its publishers (a link there keeps its host). */
  sourceTiers: PublisherConfig["sourceTiers"];
  /** vendors.json: a vendor's own domain is a listed publisher too (publisherFor). */
  vendors?: PublisherConfig["vendors"];
  /** Hosts of the registry's own URLs (config/sources.yaml): a link there keeps its host. */
  registryHosts?: ReadonlySet<string>;
  /** Registry keywords kept when an original text held them. */
  keywords?: readonly string[];
  /** EPSS: the CVE ids whose rows are kept (the fixture world's). */
  keepCves?: ReadonlySet<string>;
}

/** Raised when the output would keep an unsafe link; `urls` lists them (data from the input, for the operator). */
export class ScrubRefused extends Error {
  constructor(readonly urls: string[]) {
    super(`scrub-feed refused: ${urls.length} unsafe link(s) would be kept`);
    this.name = "ScrubRefused";
  }
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>\\)\]]+/gi;
const OTHER_SCHEME_RE = /\b(?:ftp|ftps|file|javascript|vbscript|data|sftp|smb):[^\s"'<>]*/gi;
const EMAIL_RE = /\b(?:mailto:)?[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CVE_IN_TEXT = /\bCVE-\d{4}-\d{4,}\b/gi;
const SAMPLE_EMAIL = "sample@example.com";
const isNamespace = (u: string) => NAMESPACE_PREFIXES.some((p) => u.startsWith(p));

/** The host a rewritten link takes when its own is neither a registry host nor a listed publisher. */
export const SAMPLE_LINK_HOST = "www.example.com";
/** Ids a link's last path segment may keep as its slug (lower-cased): CVE, GHSA, JVNDB, TWCERT TVN, JPCERT at/wr. */
const ID_SLUG = /^(?:CVE-\d{4}-\d{4,}|GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}|JVNDB-\d{4}-\d{6}|TVN-\d{9}|(?:at|wr)\d{6})$/i;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i;
const NO_VENDORS: PublisherConfig["vendors"] = { vendors: [] };

/**
 * True when a rewritten link (https://<host>/ct-sample/<slug>) may keep its host: not blocked, and the host
 * is a registry host or the link is a listed publisher's (tests/fixture-safety.test.ts allows the same).
 */
export function keepsHost(o: Pick<ScrubOptions, "sourceTiers" | "vendors" | "registryHosts">): (candidate: string, host: string) => boolean {
  const pub: PublisherConfig = { sourceTiers: o.sourceTiers, vendors: o.vendors ?? NO_VENDORS };
  return (candidate, host) => blockedReason(candidate, o.sourceTiers) === null
    && ((o.registryHosts?.has(host) ?? false) || !publisherFor(candidate, "press", pub).publisher.startsWith("host:"));
}

/**
 * Rewrites links to https://<host>/ct-sample/<slug>, one slug per original URL, unique within the file. The
 * host is the link's own only when `keep` allows it, else SAMPLE_LINK_HOST. The slug is "home" for a bare
 * host, the id the path ended in when it is one (ID_SLUG), else a counter (item-1, img-1 for an image): no
 * other text of the original path survives, so a name in a slug or a profile URL never reaches a fixture.
 */
export class LinkRewriter {
  private readonly byUrl = new Map<string, string>();
  private readonly used = new Set<string>();
  private readonly counters = { item: 0, img: 0 };

  constructor(private readonly keep: (candidate: string, host: string) => boolean = () => false) {}

  rewrite(raw: string): string {
    const url = raw.replace(/&amp;/g, "&");
    if (isNamespace(url)) return raw;
    // One page, one slug: tracking parameters and fragments do not make a new page (lib/urls.ts).
    const key = normalizeUrl(url);
    const known = this.byUrl.get(key);
    if (known) return known;
    let host: string;
    let last = "";
    try {
      const u = new URL(url);
      host = u.hostname.toLowerCase();
      last = u.pathname.split("/").filter(Boolean).at(-1) ?? "";
    } catch {
      return raw;
    }
    const stem = last.replace(/\.[A-Za-z0-9]{2,5}$/, "");
    const base = !last ? "home"
      : ID_SLUG.test(stem) ? stem.toLowerCase()
      : IMAGE_FILE.test(last) ? `img-${++this.counters.img}`
      : `item-${++this.counters.item}`;
    const target = /^[a-z0-9.-]+$/.test(host) && this.keep(`https://${host}/ct-sample/${base}`, host) ? host : SAMPLE_LINK_HOST;
    let slug = base;
    for (let n = 2; this.used.has(`${target}/${slug}`); n++) slug = `${base}-${n}`;
    this.used.add(`${target}/${slug}`);
    const out = `https://${target}/ct-sample/${slug}`;
    this.byUrl.set(key, out);
    return out;
  }
}

/** Invented text: "SAMPLE <label> <n>" plus the keywords, exchange terms and CVE ids the original held. */
function invented(label: string, n: number, original: string, o: ScrubOptions): string {
  const lower = original.toLowerCase();
  const cves = [...new Set((original.match(CVE_IN_TEXT) ?? []).map((c) => c.toUpperCase()))].sort(compareCveIds).slice(0, 2);
  // A keyword that only matched inside a CVE id ("CVE-") adds nothing the id does not.
  const rest = cves.reduce((t, c) => t.replaceAll(c.toLowerCase(), " "), lower);
  const hits = [...(o.keywords ?? []), ...EXCHANGE_TERMS].filter((k) => k && rest.includes(k.toLowerCase()));
  const unique = [...new Set(hits)].slice(0, 3);
  return [`SAMPLE ${label} ${n}`, ...unique, ...cves].join(" ");
}

/** Every e-mail address (and mailto: link) but the organisational ones a parser reads, as sample@example.com. */
const scrubEmails = (s: string) => s.replace(EMAIL_RE, (m) => {
  const addr = m.replace(/^mailto:/, "");
  if (KEEP_EMAILS.has(addr.toLowerCase())) return m;
  return m.startsWith("mailto:") ? `mailto:${SAMPLE_EMAIL}` : SAMPLE_EMAIL;
});

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Every URL left in `text` that is unsafe: a blocked host, another scheme, or a URL kept as written that is not a namespace. */
export function unsafeUrls(text: string, o: Pick<ScrubOptions, "sourceTiers">): string[] {
  const bad = new Set<string>();
  const decoded = text.replace(/&amp;/g, "&");
  for (const u of decoded.match(URL_RE) ?? []) {
    if (isNamespace(u)) continue;
    if (!/^https:\/\/[a-z0-9.-]+\/ct-sample\/[a-z0-9-]+$/.test(u)) bad.add(u);
    else if (blockedReason(u, o.sourceTiers)) bad.add(u);
  }
  for (const u of decoded.match(OTHER_SCHEME_RE) ?? []) bad.add(u);
  return [...bad].sort();
}

// ── XML: rss, rdf, atom, myjvn ───────────────────────────────────────────────────────────────────

const FREE_TEXT_TAGS = [
  "title", "description", "summary", "subtitle", "content:encoded", "content", "dc:description", "dc:subject",
  "category", "itunes:summary", "media:description", "media:title", "rights", "copyright", "dc:rights", "generator",
] as const;
/**
 * Person fields, with any namespace prefix (dc:creator, a10:author, itunes:author, managingEditor, ...): their
 * text becomes SAMPLE Author. Atom's person constructs hold child elements (name, email, uri), which are
 * scrubbed one by one instead (PERSON_PART_RE).
 */
const PERSON_RE = /<((?:[\w.-]+:)?)(creator|contributor|author|managingEditor|webMaster)(\s[^>]*)?>([\s\S]*?)<\/\1\2>/g;
const PERSON_PART_RE = /<((?:[\w.-]+:)?)(name|email)(\s[^>]*)?>[\s\S]*?<\/\1\2>/g;
const SAMPLE_AUTHOR = "SAMPLE Author";
const withoutCdata = (s: string) => s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");

function replaceElements(xml: string, tag: string, label: string, counter: { n: number }, o: ScrubOptions): string {
  const t = tag.replace(":", "\\:");
  const re = new RegExp(`<${t}(\\s[^>]*)?>([\\s\\S]*?)</${t}>`, "g");
  return xml.replace(re, (_m, attrs: string | undefined, inner: string) => {
    counter.n += 1;
    const text = inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
    return `<${tag}${attrs ?? ""}>${escapeXml(invented(label, counter.n, text, o))}</${tag}>`;
  });
}

/** One XML feed body: items capped, free text invented, links rewritten, e-mail removed, the RDF item list kept in step. */
export function scrubXml(xml: string, kind: "rss" | "rdf" | "atom" | "myjvn", o: ScrubOptions): string {
  const itemRe = kind === "atom" ? /<entry\b[\s\S]*?<\/entry>\s*/g : /<item\b[\s\S]*?<\/item>\s*/g;
  let kept = 0;
  let out = xml.replace(itemRe, (m) => (++kept <= SCRUB_ITEMS_MAX ? m : ""));
  // RDF lists the items' URLs in the channel: keep the first six there too.
  let li = 0;
  out = out.replace(/<rdf:li\b[^>]*\/>\s*/g, (m) => (++li <= SCRUB_ITEMS_MAX ? m : ""));
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  const counter = { n: 0 };
  for (const tag of FREE_TEXT_TAGS) out = replaceElements(out, tag, tag === "title" ? "title" : "text", counter, o);
  out = out.replace(PERSON_RE, (m, p: string, tag: string, attrs: string | undefined, inner: string) => {
    if (/<[A-Za-z]/.test(withoutCdata(inner))) return m;
    return /\S/.test(inner) ? `<${p}${tag}${attrs ?? ""}>${SAMPLE_AUTHOR}</${p}${tag}>` : m;
  });
  out = out.replace(PERSON_PART_RE, (_m, p: string, tag: string, attrs: string | undefined) =>
    `<${p}${tag}${attrs ?? ""}>${tag === "name" ? SAMPLE_AUTHOR : SAMPLE_EMAIL}</${p}${tag}>`);
  out = scrubEmails(out);
  // xmlns values are identifiers: never rewritten, so an unknown one is refused below instead of disguised.
  const ns: string[] = [];
  out = out.replace(/(\sxmlns(?::[\w.-]+)?\s*=\s*)(["'])([^"']*)\2/g, (_m, a: string, q: string, v: string) => {
    ns.push(v);
    return `${a}${q}\u0000${ns.length - 1}\u0000${q}`;
  });
  const links = new LinkRewriter(keepsHost(o));
  out = out.replace(URL_RE, (u) => links.rewrite(u));
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => ns[Number(i)]!);
}

// ── HTML: the dashboard page ─────────────────────────────────────────────────────────────────────

/** The dashboard page: scripts and styles emptied, text reduced to the words and figures the parser reads, links rewritten. */
export function scrubHtml(html: string, o: ScrubOptions): string {
  let out = html.replace(/<(script|style)\b([^>]*)>[\s\S]*?<\/\1>/gi, (_m, tag: string, attrs: string) => `<${tag}${attrs}></${tag}>`);
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  const KEEP = /Revision|Last updated|UTC|CVE-\d{4}-\d{4,}|GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}|\d[\d,.:/-]*/gi;
  out = out.replace(/>([^<]+)</g, (m, text: string) => {
    if (!/\p{L}/u.test(text)) return m;
    const kept = text.match(KEEP) ?? [];
    return `>${["SAMPLE", ...kept].join(" ")}<`;
  });
  out = out.replace(/(\s(?:title|alt|aria-label|content)=")([^"]*)(")/gi, (_m, a: string, v: string, b: string) => (/^https?:/i.test(v) ? `${a}${v}${b}` : `${a}SAMPLE${b}`));
  out = scrubEmails(out);
  const links = new LinkRewriter(keepsHost(o));
  return out.replace(URL_RE, (u) => links.rewrite(u));
}

// ── JSON: anthropic-cvd payload, exchange, nvd ───────────────────────────────────────────────────

const KEEP_STRING = /^(?:[\d\s:/.,+\-TZ]*|[A-Za-z0-9_.:/*+=()#\-]{1,120}|CVE-\d{4}-\d{4,}|GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})$/;
const DROP_KEYS = new Set(["references", "reference", "refs"]);
/** A string that is one e-mail address and nothing else (NVD's sourceIdentifier and source). */
const ONE_ADDRESS = /^\s*(?:mailto:)?[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s*$/;
/**
 * Structured values kept as written whatever their length or spaces, by key: CVSS vectors (a 4.0 vector
 * runs past KEEP_STRING's 120 characters) and NVD's closed status and role words.
 */
const STRUCTURED: Readonly<Record<string, RegExp>> = {
  vectorString: /^(?:CVSS:[234]\.\d\/)?[A-Za-z]{1,5}:[A-Za-z]{1,8}(?:\/[A-Za-z]{1,5}:[A-Za-z]{1,8})*$/,
  vulnStatus: /^(?:Received|Awaiting Analysis|Undergoing Analysis|Analyzed|Modified|Deferred|Rejected)$/,
  role: /^CISA Coordinator$/,
};
/** Inside a credits list, these keys name a person (CVE credits' value, OSV's name, GitHub's user login). */
const CREDIT_PERSON_KEYS: ReadonlySet<string> = new Set(["value", "name", "login"]);
const SAMPLE_CREDIT = "SAMPLE Researcher";

/** One JSON body: arrays capped (exchange keeps notices with cyber terms first), references dropped, free text invented, links rewritten. */
export function scrubJson(value: unknown, kind: "anthropic-cvd" | "exchange" | "nvd", o: ScrubOptions): unknown {
  const links = new LinkRewriter(keepsHost(o));
  const counter = { n: 0 };
  const walk = (v: unknown, key: string, inCredits = false): unknown => {
    if (Array.isArray(v)) {
      let list = v;
      if (kind === "exchange" && key === "") {
        const hit = (x: unknown) => EXCHANGE_TERMS.some((t) => JSON.stringify(x).includes(t));
        list = [...v.filter(hit), ...v.filter((x) => !hit(x))].slice(0, SCRUB_ITEMS_MAX);
        list = v.filter((x) => list.includes(x));
      }
      return list.slice(0, SCRUB_ITEMS_MAX).map((x) => walk(x, key, inCredits));
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = DROP_KEYS.has(k) && Array.isArray(x) ? [] : walk(x, k, inCredits || k === "credits");
      if (kind === "nvd" && key === "" && Array.isArray(out.vulnerabilities)) {
        out.totalResults = out.vulnerabilities.length;
        if (typeof out.resultsPerPage === "number") out.resultsPerPage = out.vulnerabilities.length;
      }
      return out;
    }
    if (typeof v !== "string") return v;
    if (/^https?:\/\//i.test(v.trim())) return links.rewrite(v.trim());
    // A bare address keeps its form (a parser may read it); any other text that held one is invented whole.
    if (ONE_ADDRESS.test(v)) return KEEP_EMAILS.has(v.trim().toLowerCase()) ? v : scrubEmails(v);
    if (inCredits && (CREDIT_PERSON_KEYS.has(key) || key === "credits")) return SAMPLE_CREDIT;
    if (STRUCTURED[key]?.test(v)) return v;
    if (KEEP_STRING.test(v.trim())) return v;
    counter.n += 1;
    return invented(key.trim() || "text", counter.n, v, o);
  };
  return walk(value, "");
}

// ── EPSS ─────────────────────────────────────────────────────────────────────────────────────────

/** The CSV.gz: its model line and header, the kept CVEs' rows, then 40 filler rows spread evenly over the rest, in file order. */
export function scrubEpss(gz: Buffer, keep: ReadonlySet<string>): Buffer {
  const lines = gunzipSync(gz).toString("utf8").split(/\r?\n/).filter((l) => l.length);
  const head = lines.filter((l) => l.startsWith("#") || /^cve,/i.test(l));
  const rows = lines.filter((l) => /^CVE-\d{4}-\d{4,},/i.test(l));
  const isKept = (l: string) => keep.has(l.slice(0, l.indexOf(",")).toUpperCase());
  const others = rows.filter((l) => !isKept(l));
  const step = Math.max(1, Math.floor(others.length / EPSS_FILLER_ROWS));
  const filler = new Set(others.filter((_, i) => i % step === 0).slice(0, EPSS_FILLER_ROWS));
  const body = rows.filter((l) => isKept(l) || filler.has(l));
  return gzipSync(Buffer.from(`${[...head, ...body].join("\n")}\n`, "utf8"), { level: 9 });
}

// ── One call ─────────────────────────────────────────────────────────────────────────────────────

/** Scrubs one body. Throws ScrubRefused when the output would keep an unsafe link. */
export function scrubFeed(kind: ScrubKind, body: Buffer, o: ScrubOptions): Buffer {
  let text: string;
  switch (kind) {
    case "epss":
      return scrubEpss(body, o.keepCves ?? new Set());
    case "rss": case "rdf": case "atom": case "myjvn":
      text = scrubXml(body.toString("utf8"), kind, o);
      break;
    case "anthropic-cvd": {
      const s = body.toString("utf8");
      text = /^\s*[[{]/.test(s) ? `${JSON.stringify(scrubJson(JSON.parse(s), kind, o), null, 2)}\n` : scrubHtml(s, o);
      break;
    }
    case "exchange": case "nvd":
      text = `${JSON.stringify(scrubJson(JSON.parse(body.toString("utf8")), kind, o), null, 2)}\n`;
      break;
  }
  const bad = unsafeUrls(text, o);
  if (bad.length) throw new ScrubRefused(bad);
  return Buffer.from(text, "utf8");
}

/** The registry's own hosts (config/sources.yaml url and fallback_url), where a rewritten link keeps its host. */
export function registryHosts(cfg: Pick<LoadedConfig, "sources">): Set<string> {
  const out = new Set<string>();
  for (const f of cfg.sources.feeds) {
    if (f.kind === "search") continue;
    for (const u of [f.url, f.fallback_url]) {
      if (typeof u !== "string") continue;
      try {
        out.add(new URL(u).hostname.toLowerCase());
      } catch {
        // A registry URL that does not parse adds no host.
      }
    }
  }
  return out;
}

/** The options the command line scrubs with: the tiers, the vendors, the registry hosts and the keywords. */
export function scrubOptionsFor(cfg: Pick<LoadedConfig, "sourceTiers" | "vendors" | "sources">): ScrubOptions {
  return { sourceTiers: cfg.sourceTiers, vendors: cfg.vendors, registryHosts: registryHosts(cfg), keywords: cfg.sources.keywords };
}

/** The CVE ids named anywhere in the fixture world (fixtures/feeds outside epss/), for the EPSS rows kept. */
export function fixtureCveIds(feedsDir: string): Set<string> {
  const out = new Set<string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "epss") walk(p);
      } else if (/\.(?:json|xml|rdf|html)$/.test(e.name)) {
        for (const m of fs.readFileSync(p, "utf8").match(CVE_IN_TEXT) ?? []) out.add(m.toUpperCase());
      }
    }
  };
  walk(feedsDir);
  return out;
}

const USAGE = `Usage: tsx fixtures/src/scrub-feed.ts <${SCRUB_KINDS.join(" | ")}> <cache file> <fixture file> [--keep CVE-…,CVE-…]`;

/** 0 written, 1 refused (nothing written), 2 usage. */
export function main(argv: string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: console.log, err: console.error }, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")): number {
  const args = [...argv];
  let keepArg: string | null = null;
  const k = args.indexOf("--keep");
  if (k >= 0) {
    keepArg = args[k + 1] ?? "";
    args.splice(k, 2);
  }
  const [kind, from, to] = args;
  if (args.length !== 3 || !SCRUB_KINDS.includes(kind as ScrubKind) || keepArg === "") {
    io.err(USAGE);
    return 2;
  }
  if (!fs.existsSync(from!)) {
    io.err(`No such cache file: ${from}. ${USAGE}`);
    return 2;
  }
  const cfg = loadConfig({ root });
  const keepCves = keepArg ? new Set(keepArg.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)) : fixtureCveIds(path.join(root, "fixtures", "feeds"));
  try {
    const out = scrubFeed(kind as ScrubKind, fs.readFileSync(from!), { ...scrubOptionsFor(cfg), keepCves });
    fs.mkdirSync(path.dirname(path.resolve(to!)), { recursive: true });
    fs.writeFileSync(to!, out);
    io.out(`Wrote ${to} (${out.length} bytes). Read it in full before committing it.`);
    return 0;
  } catch (e) {
    if (e instanceof ScrubRefused) {
      io.err(`${e.message}; nothing written. Unsafe links (data from the cache file, do not open them):`);
      for (const u of e.urls) io.err(`  ${u}`);
      return 1;
    }
    io.err(`scrub-feed: ${(e as Error).message}`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main(process.argv.slice(2));
