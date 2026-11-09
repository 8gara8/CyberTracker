// Scrubs a feed body that `npm run sources:check` left in cache/feeds/ into a fixture (fixtures plan §3.5,
// feeds plan §8), for the Kobol capture session:
//
//   tsx fixtures/src/scrub-feed.ts <kind> <cache file> <fixture file> [--keep CVE-…,CVE-…]
//   kind: rss | rdf | atom | epss | anthropic-cvd | exchange | myjvn | nvd
//
// It keeps the structure, namespaces, dates and ids; replaces titles, descriptions, summaries, authors and
// other free text with invented SAMPLE text (keeping only the registry keywords, exchange terms and CVE ids
// the text held, so the fixture still exercises must_match and merging); rewrites every link to
// https://<host>/ct-sample/<slug>; removes e-mail addresses; drops reference lists; caps items at 6 (EPSS:
// the fixture world's CVEs plus 40 filler rows). It refuses (exit 1, nothing written) when a link stays on
// a blocked host (BLOCKED_HOSTS, or a github.com path outside the tier 1 paths), when a link in another
// scheme is left, or when a URL kept as written is not a known XML namespace. Exit 2 is a usage error.
// The input is untrusted data: nothing in it is followed, fetched or run. Read the output in full before
// committing it. Not part of fixtures:gen (its inputs are Kobol's cache/).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { loadConfig } from "../../lib/config";
import { EXCHANGE_TERMS } from "../../lib/feeds/exchange";
import { compareCveIds } from "../../lib/ids";
import type { SourceTiersFile } from "../../lib/schema/config";
import { blockedReason } from "../../lib/sources";
import { normalizeUrl } from "../../lib/urls";

export const SCRUB_KINDS = ["rss", "rdf", "atom", "epss", "anthropic-cvd", "exchange", "myjvn", "nvd"] as const;
export type ScrubKind = (typeof SCRUB_KINDS)[number];
export const SCRUB_ITEMS_MAX = 6;
export const EPSS_FILLER_ROWS = 40;

/**
 * URL prefixes kept as written: XML namespace, schema and vocabulary identifiers, never links a reader
 * follows. The http ones are exactly the hosts tests/feeds.test.ts allows over http; a capture that
 * declares another namespace is refused until both lists grow together.
 */
export const NAMESPACE_PREFIXES = [
  "http://purl.org/", "http://www.w3.org/", "http://jvn.jp/rss/", "http://data-marking.mitre.org/", "http://jvndb.jvn.jp/myjvn/",
  "http://www.us-cert.gov/tlp/", "https://purl.org/", "https://www.w3.org/", "https://jvndb.jvn.jp/schema/",
] as const;
/** Organisational addresses a parser reads (NVD marks its own scores with it); every other address is replaced. */
const KEEP_EMAILS: ReadonlySet<string> = new Set(["nvd@nist.gov"]);

export interface ScrubOptions {
  sourceTiers: Pick<SourceTiersFile, "github">;
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

const URL_RE = /\bhttps?:\/\/[^\s"'<>\\)\]]+/g;
const OTHER_SCHEME_RE = /\b(?:ftp|ftps|file|javascript|vbscript|data|sftp|smb):[^\s"'<>]*/gi;
const EMAIL_RE = /\b(?:mailto:)?[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CVE_IN_TEXT = /\bCVE-\d{4}-\d{4,}\b/gi;
const SAMPLE_EMAIL = "sample@example.com";
const isNamespace = (u: string) => NAMESPACE_PREFIXES.some((p) => u.startsWith(p));

/** Rewrites links to https://<host>/ct-sample/<slug>, one slug per original URL, unique within the file. */
export class LinkRewriter {
  private readonly byUrl = new Map<string, string>();
  private readonly used = new Set<string>();

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
    const base = last.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "home";
    let slug = base;
    for (let n = 2; this.used.has(`${host}/${slug}`); n++) slug = `${base}-${n}`;
    this.used.add(`${host}/${slug}`);
    const out = `https://${host}/ct-sample/${slug}`;
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
  "title", "description", "summary", "subtitle", "content:encoded", "content", "dc:description", "dc:creator", "dc:subject",
  "dc:contributor", "category", "author", "contributor", "managingEditor", "webMaster", "itunes:summary", "itunes:author",
  "media:description", "media:title", "rights", "copyright", "dc:rights", "generator",
] as const;
/** Atom's person constructs hold child elements (name, email, uri), scrubbed one by one instead. */
const PERSON_TAGS: ReadonlySet<string> = new Set(["author", "contributor"]);

function replaceElements(xml: string, tag: string, label: string, counter: { n: number }, o: ScrubOptions): string {
  const t = tag.replace(":", "\\:");
  const re = new RegExp(`<${t}(\\s[^>]*)?>([\\s\\S]*?)</${t}>`, "g");
  return xml.replace(re, (m, attrs: string | undefined, inner: string) => {
    if (PERSON_TAGS.has(tag) && /<[A-Za-z]/.test(inner.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ""))) return m;
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
  out = out.replace(/<(atom:)?name>([\s\S]*?)<\/(atom:)?name>/g, (_m, p: string | undefined) => `<${p ?? ""}name>SAMPLE Author</${p ?? ""}name>`);
  out = out.replace(/<(atom:)?email>[\s\S]*?<\/(atom:)?email>/g, (_m, p: string | undefined) => `<${p ?? ""}email>${SAMPLE_EMAIL}</${p ?? ""}email>`);
  out = scrubEmails(out);
  // xmlns values are identifiers: never rewritten, so an unknown one is refused below instead of disguised.
  const ns: string[] = [];
  out = out.replace(/(\sxmlns(?::[\w.-]+)?\s*=\s*)(["'])([^"']*)\2/g, (_m, a: string, q: string, v: string) => {
    ns.push(v);
    return `${a}${q}\u0000${ns.length - 1}\u0000${q}`;
  });
  const links = new LinkRewriter();
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
  out = out.replace(/(\s(?:title|alt|aria-label|content)=")([^"]*)(")/gi, (_m, a: string, v: string, b: string) => (/^https?:/.test(v) ? `${a}${v}${b}` : `${a}SAMPLE${b}`));
  out = scrubEmails(out);
  const links = new LinkRewriter();
  return out.replace(URL_RE, (u) => links.rewrite(u));
}

// ── JSON: anthropic-cvd payload, exchange, nvd ───────────────────────────────────────────────────

const KEEP_STRING = /^(?:[\d\s:/.,+\-TZ]*|[A-Za-z0-9_.:/*+=()#\-]{1,120}|CVE-\d{4}-\d{4,}|GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})$/;
const DROP_KEYS = new Set(["references", "reference", "refs"]);

/** One JSON body: arrays capped (exchange keeps notices with cyber terms first), references dropped, free text invented, links rewritten. */
export function scrubJson(value: unknown, kind: "anthropic-cvd" | "exchange" | "nvd", o: ScrubOptions): unknown {
  const links = new LinkRewriter();
  const counter = { n: 0 };
  const walk = (v: unknown, key: string): unknown => {
    if (Array.isArray(v)) {
      let list = v;
      if (kind === "exchange" && key === "") {
        const hit = (x: unknown) => EXCHANGE_TERMS.some((t) => JSON.stringify(x).includes(t));
        list = [...v.filter(hit), ...v.filter((x) => !hit(x))].slice(0, SCRUB_ITEMS_MAX);
        list = v.filter((x) => list.includes(x));
      }
      return list.slice(0, SCRUB_ITEMS_MAX).map((x) => walk(x, key));
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = DROP_KEYS.has(k) && Array.isArray(x) ? [] : walk(x, k);
      if (kind === "nvd" && key === "" && Array.isArray(out.vulnerabilities)) {
        out.totalResults = out.vulnerabilities.length;
        if (typeof out.resultsPerPage === "number") out.resultsPerPage = out.vulnerabilities.length;
      }
      return out;
    }
    if (typeof v !== "string") return v;
    if (/^https?:\/\//.test(v.trim())) return links.rewrite(v.trim());
    if (/@/.test(v) && scrubEmails(v) !== v) return scrubEmails(v);
    if (KEEP_STRING.test(v.trim()) || KEEP_EMAILS.has(v.trim())) return v;
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
    const out = scrubFeed(kind as ScrubKind, fs.readFileSync(from!), { sourceTiers: cfg.sourceTiers, keywords: cfg.sources.keywords, keepCves });
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
