// Fixture safety for P2's fixture folders (SPEC §0.2, §4.12 "Fixtures and tests"; AGENTS rules 8 and 10;
// fixtures plan §6.1): real formats, invented prose, and nothing a reader could use or be harmed by. Over
// every text file, every entry of the generated zips and every .gz capture (decompressed), under
// fixtures/feeds/, fixtures/state/, fixtures/reference/, fixtures/cvelist-clone/, fixtures/ai-credit/,
// P1's fixtures/cvelist/records/ and P3's fixtures/agent/, fixtures/recheck/ and fixtures/injection/ (plan A24):
//   - every link is https in any letter case (an http XML namespace in a feed body aside), on no blocked
//     host, with no exploit path (NO_EXPLOIT_LINK's test), and on a listed publisher's host, a registry
//     host, a canonical record page, one of the three GitHub repos the run reads, or a reserved example domain;
//   - a CVE record's references are a listed publisher's /ct-sample/ page, the KEV catalog page or a
//     reserved example domain, and an exploit-tagged one only the last;
//   - credits name no person: every credit in any JSON fixture (a CVE record's value, an OSV GHSA name, a
//     GitHub user login) is one of the exact SAMPLE forms or an organisation or tool on the lists below;
//   - every author, creator, contributor and name element of a feed fixture, whatever its namespace prefix
//     (dc:creator, a10:name, atom:name, itunes:author), is empty, a SAMPLE form or a listed organisation;
//   - the canary's planted URL is exactly https://example.org/ct-canary/{{NONCE}} in the planted page and
//     item, and exactly example.org/ct-canary/{{NONCE}} with no scheme in the canary pack (pack.md and
//     pack.json, the form sanitize() keeps; agent-check fills the nonce in its run-time copy of the pack),
//     and only in fixtures/injection/; any other link with its path fails (plan A24);
//   - fixtures/state/ and fixtures/reference/ hold no link and no e-mail address at all, and elsewhere an
//     e-mail address is a reserved example one or an organisation's role address;
//   - no model identifier, no credential-shaped string, no scanner query (in a JSON fixture, in any one
//     string value), no attack-code pattern (PAYLOAD_PATTERNS; the empty script elements the scrubber
//     leaves in the dashboard page aside);
//   - no file over 1 MB, and fixtures/feeds/ under 3 MB.
// The checks are functions, run on the fixtures and on planted bad samples, so a check that stops catching
// what it looks for fails here too. Everything read here is data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { readZip } from "@/lib/feeds/zip";
import { exploitLinkProblem, hasScannerQuery, payloadsIn, secretsIn } from "@/lib/rules/safety";
import { blockedReason, publisherFor } from "@/lib/sources";
import { extractUrls } from "@/lib/urls";
import { BLOCKED_HOSTS, CANARY_URL_MARK, CANARY_URL_PREFIX } from "@/lib/vocab";
import { NAMESPACE_PREFIXES } from "../fixtures/src/scrub-feed";
import { MODEL_SAMPLES, modelRe } from "./helpers/model-names";

const ROOT = path.join(__dirname, "..");
const config = loadConfig({ root: ROOT });
const PUB = { sourceTiers: config.sourceTiers, vendors: config.vendors };

const FOLDERS = [
  "fixtures/feeds", "fixtures/state", "fixtures/reference", "fixtures/cvelist-clone", "fixtures/ai-credit", "fixtures/cvelist/records",
  "fixtures/agent", "fixtures/recheck", "fixtures/injection",
] as const;
/** Folders that hold ids, dates, counts, vendor and product names and matched tool names only. */
const NO_LINK_FOLDERS = ["fixtures/state", "fixtures/reference"];

const MB = 1024 * 1024;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/**
 * The http XML namespace prefixes a feed body may declare (never fetched, never shown): the http entries of
 * scrub-feed's NAMESPACE_PREFIXES, grown together (a test below holds them equal).
 */
const XML_NAMESPACE_PREFIXES = [
  "http://purl.org/", "http://www.w3.org/", "http://jvn.jp/rss/", "http://data-marking.mitre.org/", "http://jvndb.jvn.jp/myjvn/",
  "http://www.us-cert.gov/tlp/", "http://wellformedweb.org/CommentAPI/", "http://search.yahoo.com/mrss/",
  "http://www.itunes.com/dtds/podcast-1.0.dtd", "http://news.web.nhk/rss/rss2.0/modules/nhknews/", "http://ogp.me/ns",
];
const XML_NAMESPACE = new RegExp(`^(?:${XML_NAMESPACE_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})`, "i");
const isHttp = (u: string) => /^http:\/\//i.test(u);
/** The three repositories the run reads through git or raw.githubusercontent.com (SPEC §8.3). */
const RUN_REPOS = /^https:\/\/(?:github\.com|raw\.githubusercontent\.com)\/(?:CVEProject\/cvelistV5|cisagov\/kev-data|github\/advisory-database)(?:[/.]|$)/;
/** Canonical record pages: the CVE record, the NVD detail page and the KEV catalog entry. */
const RECORD_PAGE = /^https:\/\/(?:www\.cve\.org\/CVERecord\?id=CVE-\d{4}-\d{4,}|nvd\.nist\.gov\/vuln\/detail\/CVE-\d{4}-\d{4,}|www\.cisa\.gov\/known-exploited-vulnerabilities-catalog\?field_cve=CVE-\d{4}-\d{4,})$/;
const KEV_PAGE = /^https:\/\/www\.cisa\.gov\/known-exploited-vulnerabilities-catalog\?field_cve=CVE-\d{4}-\d{4,}$/;
const EXAMPLE_HOST = /(?:^|\.)example\.(?:com|org|net)$/;
/** The canary's planted URL as fixtures/injection/ holds it (SPEC §9.6): agent-check puts a fresh nonce in place of {{NONCE}}. */
const CANARY_LINK = `${CANARY_URL_PREFIX}{{NONCE}}`;
/** The same link as extractUrls() reads it out of a text (it stops at the closing braces). */
const CANARY_READ = extractUrls(CANARY_LINK)[0]!;
const CANARY_FOLDER = "fixtures/injection";
/** The scheme-less form the canary pack carries: sanitize() turns a link with a scheme into [link] but keeps this. */
const CANARY_BARE = CANARY_LINK.slice("https://".length);
/** The canary pack's files, the only ones that hold CANARY_BARE (agent-check copies them with the nonce filled in). */
const CANARY_PACK_FILES = ["fixtures/injection/pack.json", "fixtures/injection/pack.md"];
const isCanaryLink = (u: string) => u.toLowerCase().includes(CANARY_URL_MARK);
/** Organisations' role addresses that real record and feed formats carry (a CNA, NVD's source id). */
const ROLE_EMAILS = new Set(["nvd@nist.gov", "security@apache.org", "cret@cert.org"]);
/**
 * Credit strings that name no person: organisations, programmes and tools, as the trimmed records keep
 * them. Any other credit must be one of SAMPLE_CREDITS exactly.
 */
const ORG_CREDITS = new Set([
  "Ada Logics", "Anthropic, Claude", "Anthropic OSS program", "Anthropic OSS-scanner (re-report, ANT-2026-N0E1INIV)", "Claude Code",
  "Claude Security", "MopMonk AI", "OpenAI", "Red Hat would like to thank Aisle Research for reporting this issue.",
  "Security Research Center (SRC) @ Concordia University", "The ASF using Claude Agents", "The Apache Software Foundation",
  "This issue was discovered by Found by AISLE in partnership with Red Hat.", "Wiz", "WPScan", "Wordfence PRISM", "XBOW",
  "https://example.com/ct-sample/sample-researcher", "https://example.com/ct-sample/sample-xbow", "https://example.com/ct-sample/xbow-security",
]);
/**
 * The credit strings with SAMPLE in them, exactly as the fixtures hold them: a credit is checked whole, so a
 * hand edit that leaves a real name beside "SAMPLE Researcher" fails. A new SAMPLE credit is reviewed and
 * added here on purpose.
 */
const SAMPLE_CREDITS = new Set([
  "SAMPLE Researcher", "SAMPLE Developer", "SAMPLE Researcher (VulDB User)", "SAMPLE Researcher at Calif.io", "SAMPLE Researcher of OpenAI",
  "SAMPLE Researcher using XBOW", "SAMPLE Researcher | Patchstack Bug Bounty Program", "SAMPLE Researcher reported these vulnerabilities to CISA.",
  "SAMPLE Researcher <researcher@example.com> (not reported as security issue)", "SAMPLE Researcher and SAMPLE Researcher using Claude from Anthropic",
  "SAMPLE Researcher of Google's Threat Analysis Group, with assistance from Google Big Sleep", "OpenAI Codex Security - SAMPLE Researcher and SAMPLE Researcher",
  "Red Hat would like to thank SAMPLE Researcher (SAMPLE Lab in collaboration with OpenAI Codex) for reporting this issue.",
  "Special thanks to SAMPLE Researcher for reporting this vulnerability",
  "Thanks SAMPLE Researcher for reporting this vulnerability through our HackerOne bug bounty program",
]);
const creditOk = (v: string) => SAMPLE_CREDITS.has(v) || ORG_CREDITS.has(v);
/** A feed's author or name text: scrub-feed's SAMPLE forms (SAMPLE Author; SAMPLE text N from older captures). */
const AUTHOR_SAMPLE = /^SAMPLE (?:Author|(?:text|author) \d+)$/;

/** Hosts of the registry's own URLs (config/sources.yaml), which collect's fixture index maps. */
const REGISTRY_HOSTS: ReadonlySet<string> = new Set(config.sources.feeds.flatMap((f) => {
  const urls = (f.kind === "search" ? [] : [f.url, f.fallback_url]).filter((u): u is string => typeof u === "string");
  return urls.flatMap((u) => {
    try {
      return [new URL(u).hostname];
    } catch {
      return [];
    }
  });
}));

interface FixtureText {
  /** Repo-relative path, with ":<entry>" for a zip entry. */
  file: string;
  folder: (typeof FOLDERS)[number];
  text: string;
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const FILES = FOLDERS.flatMap((folder) => walk(path.join(ROOT, folder)).map((abs) => ({ folder, abs, rel: path.relative(ROOT, abs).split(path.sep).join("/") })));

/** The texts of one file: a text file as UTF-8, each zip entry as UTF-8, a .gz capture decompressed. */
function textsOf(abs: string, rel: string, folder: FixtureText["folder"]): FixtureText[] {
  if (rel.endsWith(".gz")) return [{ file: rel, folder, text: gunzipSync(fs.readFileSync(abs)).toString("utf8") }];
  if (rel.endsWith(".zip")) return readZip(fs.readFileSync(abs)).map((e) => ({ file: `${rel}:${e.name}`, folder, text: e.data.toString("utf8") }));
  return [{ file: rel, folder, text: fs.readFileSync(abs, "utf8") }];
}

/** Every text to scan. */
const TEXTS: FixtureText[] = FILES.flatMap(({ folder, abs, rel }) => textsOf(abs, rel, folder));

const urlsIn = (text: string) => extractUrls(text.replace(/&amp;/g, "&"));
const isListed = (url: string) => !publisherFor(url, "press", PUB).publisher.startsWith("host:");
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/** A CVE List V5 record (cveMetadata plus containers), or null. */
function cveRecord(t: FixtureText): { cveMetadata: { cveId: string }; containers: { cna?: Container; adp?: Container[] } } | null {
  if (!/(?:^|[/:])(?:deltaCves\/)?CVE-\d{4}-\d{4,}\.json$/.test(t.file)) return null;
  const raw = JSON.parse(t.text) as { cveMetadata?: { cveId?: unknown }; containers?: unknown };
  return raw.cveMetadata && typeof raw.cveMetadata.cveId === "string" && raw.containers ? (raw as ReturnType<typeof cveRecord>) : null;
}
interface Container {
  references?: { url: string; tags?: string[] }[];
  credits?: { value: string }[];
}
const containersOf = (r: NonNullable<ReturnType<typeof cveRecord>>): Container[] => [r.containers.cna ?? {}, ...(r.containers.adp ?? [])];
const RECORDS = TEXTS.flatMap((t) => {
  const r = cveRecord(t);
  return r ? [{ ...t, record: r }] : [];
});

// ── The checks ───────────────────────────────────────────────────────────────────────────────────

/** Not https (in any letter case; a feed's http XML namespace aside), on a blocked host, or an exploit path. */
function linkProblems(texts: readonly FixtureText[]): string[] {
  const bad: string[] = [];
  for (const t of texts) {
    for (const u of urlsIn(t.text)) {
      if (isHttp(u)) {
        if (!(/\.(?:xml|rdf)$/.test(t.file) && XML_NAMESPACE.test(u))) bad.push(`${t.file}: ${u} is not https`);
        continue;
      }
      if (RUN_REPOS.test(u)) continue;
      const reason = blockedReason(u, config.sourceTiers);
      if (reason) bad.push(`${t.file}: ${u} is blocked (${reason})`);
      // NO_EXPLOIT_LINK's own test (§4.12): an exploit path word on a tier 3 or unlisted page.
      const pub = publisherFor(u, "press", PUB);
      const problem = exploitLinkProblem(u, pub.tier, config.sourceTiers, pub.publisher);
      if (problem) bad.push(`${t.file}: ${u} ${problem}`);
    }
  }
  return bad;
}

/** A link on none of: a reserved example domain, a repo the run reads, a record page, a registry host, a listed publisher. */
function unlistedLinks(texts: readonly FixtureText[]): string[] {
  const bad: string[] = [];
  for (const t of texts) {
    for (const u of urlsIn(t.text)) {
      if (isHttp(u)) continue;
      // The canary's path is allowed by its exact link only, in fixtures/injection/ only; other example-domain links pass.
      if (isCanaryLink(u)) {
        if (!(u === CANARY_READ && t.folder === CANARY_FOLDER)) bad.push(`${t.file}: ${u}`);
        continue;
      }
      const ok = EXAMPLE_HOST.test(hostOf(u)) || RUN_REPOS.test(u) || RECORD_PAGE.test(u) || REGISTRY_HOSTS.has(hostOf(u)) || isListed(u);
      if (!ok) bad.push(`${t.file}: ${u}`);
    }
  }
  return bad;
}

/**
 * Every place a text holds the canary's mark (example.org/ct-canary/, any case, with or without a scheme) that
 * is not the exact CANARY_LINK in the planted files of fixtures/injection/, or the exact scheme-less CANARY_BARE
 * in the canary pack: a filled-in nonce, another scheme or path, a scheme-less form elsewhere, or a copy in
 * another folder (a pipeline draft or a transcript) fails.
 */
function canaryProblems(texts: readonly FixtureText[]): string[] {
  const bad: string[] = [];
  const urlChar = /[A-Za-z0-9{}/._~%:-]/;
  for (const t of texts) {
    const lower = t.text.toLowerCase();
    for (let i = lower.indexOf(CANARY_URL_MARK); i !== -1; i = lower.indexOf(CANARY_URL_MARK, i + 1)) {
      const start = i - "https://".length;
      const end = start + CANARY_LINK.length;
      const bareEnd = i + CANARY_BARE.length;
      const exact = CANARY_PACK_FILES.includes(t.file)
        ? t.text.slice(i, bareEnd) === CANARY_BARE && !urlChar.test(t.text[i - 1] ?? "") && !urlChar.test(t.text[bareEnd] ?? "")
        : start >= 0 && t.text.slice(start, end) === CANARY_LINK && !/[A-Za-z0-9{}/._~%-]/.test(t.text[end] ?? "");
      const seen = t.text.slice(Math.max(0, start), i + CANARY_URL_MARK.length + 12).split(/\s/)[0];
      if (t.folder !== CANARY_FOLDER) bad.push(`${t.file}: the canary's URL outside ${CANARY_FOLDER}/ (${seen})`);
      else if (!exact) bad.push(`${t.file}: ${seen} is not the canary's exact URL`);
    }
  }
  return bad;
}

/** An e-mail address that is neither a reserved example one nor an organisation's role address. */
function emailProblems(texts: readonly FixtureText[]): string[] {
  const bad: string[] = [];
  for (const t of texts) {
    for (const e of t.text.match(EMAIL_RE) ?? []) {
      if (!EXAMPLE_HOST.test(e.split("@")[1]!.toLowerCase()) && !ROLE_EMAILS.has(e.toLowerCase())) bad.push(`${t.file}: ${e}`);
    }
  }
  return bad;
}

const isJson = (t: FixtureText) => /\.json$/.test(t.file);
const parsed = (t: FixtureText): unknown => {
  try {
    return JSON.parse(t.text);
  } catch {
    return undefined; // a fixture that is not JSON on purpose (a garbage body); the text checks still read it
  }
};

/**
 * The prose a scanner query could sit in: each key and string value of a JSON fixture, or the whole text of
 * any other file. A JSON file's punctuation is not sentences, so read whole, the agent context's list of
 * publisher domains (censys.com among them) beside its keys would read as one 30,000-character sentence.
 */
function proseOf(t: FixtureText): string[] {
  const v = isJson(t) ? parsed(t) : undefined;
  if (v === undefined) return [t.text];
  const out: string[] = [];
  const walk = (x: unknown): void => {
    if (typeof x === "string") out.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      for (const [k, y] of Object.entries(x)) {
        out.push(k);
        walk(y);
      }
    }
  };
  walk(v);
  return out;
}

/** Every credit in a JSON fixture: a CVE record's value, an OSV name, a GitHub user's login, a bare string. */
function creditsIn(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) {
    for (const x of v) creditsIn(x, out);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "credits" && Array.isArray(x)) {
        for (const c of x) {
          if (typeof c === "string") out.push(c);
          else if (c && typeof c === "object") {
            const o = c as { value?: unknown; name?: unknown; login?: unknown; user?: { login?: unknown } | null };
            for (const s of [o.value, o.name, o.login, o.user?.login]) if (typeof s === "string") out.push(s);
          }
        }
      } else creditsIn(x, out);
    }
  }
  return out;
}

/** A credit that is not an exact SAMPLE form or a listed organisation or tool. */
function creditProblems(texts: readonly FixtureText[]): string[] {
  return texts.filter(isJson).flatMap((t) => creditsIn(parsed(t)).filter((c) => !creditOk(c)).map((c) => `${t.file}: ${c}`));
}

/** Person elements with any namespace prefix; a person construct with child elements is checked through them. */
const PERSON_ELEMENT = /<((?:[\w.-]+:)?)(creator|contributor|author|name|managingEditor|webMaster)(?=[\s>])(?:\s[^>]*)?>([\s\S]*?)<\/\1\2>/g;

function personProblems(file: string, xml: string, bad: string[]): string[] {
  for (const m of xml.matchAll(PERSON_ELEMENT)) {
    const inner = m[3]!;
    // A person construct (Atom's author with name, email and uri children): check its children.
    if (/<[A-Za-z]/.test(inner.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ""))) {
      personProblems(file, inner, bad);
      continue;
    }
    const text = inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
    if (text && !AUTHOR_SAMPLE.test(text) && !creditOk(text)) bad.push(`${file}: <${m[1]}${m[2]}> ${text}`);
  }
  return bad;
}

/**
 * A title, term, label or alt attribute in a feed fixture that holds text other than SAMPLE (an Atom link's
 * title kept a real post title in Kobol's session 2 capture of project-zero).
 */
const TEXT_ATTR = /\s((?:[\w.-]+:)?(?:title|label|alt|term))\s*=\s*(["'])([^"']*)\2/gi;
function textAttrProblems(texts: readonly FixtureText[]): string[] {
  return texts.filter((x) => /\.(?:xml|rdf|atom)$/.test(x.file)).flatMap((t) =>
    [...t.text.matchAll(TEXT_ATTR)].filter((m) => /\S/.test(m[3]!) && m[3] !== "SAMPLE").map((m) => `${t.file}: ${m[1]}="${m[3]}"`));
}

/** An author, creator, contributor or name in a feed fixture that is not empty, a SAMPLE form or a listed organisation. */
function authorProblems(texts: readonly FixtureText[]): string[] {
  return texts.filter((x) => /\.(?:xml|rdf|atom)$/.test(x.file)).flatMap((t) => personProblems(t.file, t.text, []));
}

/** Any model identifier or model flag (tests/helpers/model-names.ts, shared with the other scans). */
const MODEL_RE = modelRe("i");

/** A model identifier, a credential-shaped string, a scanner query or a PAYLOAD_PATTERNS match. */
function contentProblems(texts: readonly FixtureText[]): string[] {
  const bad: string[] = [];
  for (const t of texts) {
    if (MODEL_RE.test(t.text)) bad.push(`${t.file}: a model identifier`);
    for (const name of secretsIn(t.text)) bad.push(`${t.file}: ${name}`);
    if (proseOf(t).some(hasScannerQuery)) bad.push(`${t.file}: a scanner query`);
    // scrub-feed empties the dashboard page's scripts and keeps the elements; one with content still counts.
    const text = /\.html?$/.test(t.file) ? t.text.replace(/<script\b[^>]*><\/script>/gi, "") : t.text;
    for (const p of payloadsIn(text)) bad.push(`${t.file}: ${p}`);
  }
  return bad;
}

// ── On the fixtures ──────────────────────────────────────────────────────────────────────────────

describe("fixture safety: what the scan covers", () => {
  it("reads every P2 fixture folder, the generated zips' entries, the .gz captures and the trimmed records", () => {
    for (const f of FOLDERS) expect(FILES.some((x) => x.folder === f), f).toBe(true);
    expect(TEXTS.some((t) => t.file.includes(".zip:deltaCves/"))).toBe(true);
    for (const f of ["fixtures/feeds", "fixtures/cvelist-clone", "fixtures/ai-credit", "fixtures/cvelist/records"]) {
      expect(RECORDS.some((r) => r.folder === f), f).toBe(true);
    }
    const gz = TEXTS.filter((t) => t.file.endsWith(".gz"));
    expect(gz.map((t) => t.file)).toContain("fixtures/feeds/live/epss.csv.gz");
    for (const t of gz) expect(t.text, t.file).toMatch(/^#model_version:/);
    expect(TEXTS.filter(isJson).some((t) => t.file.startsWith("fixtures/feeds/ghsa/"))).toBe(true);
  });

  it("allows over http exactly the namespace prefixes scrub-feed keeps", () => {
    expect(XML_NAMESPACE_PREFIXES).toEqual(NAMESPACE_PREFIXES.filter((p) => p.startsWith("http://")));
  });
});

describe("fixture safety: links", () => {
  it("every link is https (or a feed's XML namespace), on no blocked host and with no exploit path", () => {
    expect(linkProblems(TEXTS)).toEqual([]);
  });

  it("every link is a listed publisher's, a registry host, a record page, a repo the run reads, or a reserved example domain", () => {
    expect(unlistedLinks(TEXTS)).toEqual([]);
  });

  it("fixtures/state/ and fixtures/reference/ hold no link and no e-mail address", () => {
    for (const t of TEXTS.filter((x) => NO_LINK_FOLDERS.includes(x.folder))) {
      expect(urlsIn(t.text), t.file).toEqual([]);
      expect(t.text.match(EMAIL_RE) ?? [], t.file).toEqual([]);
    }
  });

  it("the canary's URL is exactly https://example.org/ct-canary/{{NONCE}}, or its scheme-less form in the canary pack, and only in fixtures/injection/ (A24)", () => {
    const holders = TEXTS.filter((t) => t.text.toLowerCase().includes(CANARY_URL_MARK)).map((t) => t.file).sort();
    expect(holders).toEqual(["fixtures/injection/item.xml", "fixtures/injection/pack.json", "fixtures/injection/pack.md", "fixtures/injection/page.html"]);
    expect(canaryProblems(TEXTS)).toEqual([]);
  });

  it("an e-mail address anywhere else is a reserved example one or an organisation's role address", () => {
    expect(emailProblems(TEXTS)).toEqual([]);
  });
});

describe("fixture safety: CVE records", () => {
  it("references are a listed publisher's /ct-sample/ page, the KEV catalog page or a reserved example domain", () => {
    const bad: string[] = [];
    for (const r of RECORDS) {
      for (const c of containersOf(r.record)) {
        for (const ref of c.references ?? []) {
          const u = ref.url;
          const example = EXAMPLE_HOST.test(hostOf(u));
          const ok = example || KEV_PAGE.test(u) || (/^https:\/\/[a-z0-9.-]+\/ct-sample\/[a-z0-9.-]+$/.test(u) && isListed(u));
          if (!ok) bad.push(`${r.file}: ${u}`);
          if ((ref.tags ?? []).some((tag) => /exploit/i.test(tag)) && !example) bad.push(`${r.file}: exploit-tagged ${u}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("only the feed fixtures keep references: the clone's, the AI-credit and P1's records hold none", () => {
    for (const r of RECORDS.filter((x) => x.folder !== "fixtures/feeds")) {
      for (const c of containersOf(r.record)) expect(c.references, r.file).toBeUndefined();
    }
  });
});

describe("fixture safety: people", () => {
  it("credits name no person: every credit in every JSON fixture is an exact SAMPLE form or a listed organisation or tool", () => {
    expect(RECORDS.flatMap((r) => containersOf(r.record).flatMap((c) => c.credits ?? [])).length).toBeGreaterThan(0);
    expect(creditProblems(TEXTS)).toEqual([]);
  });

  it("every author, creator, contributor and name in a feed fixture is empty, a SAMPLE form or a listed organisation", () => {
    expect(TEXTS.some((t) => /<dc:creator>SAMPLE text \d+<\/dc:creator>/.test(t.text))).toBe(true);
    expect(authorProblems(TEXTS)).toEqual([]);
  });

  it("every title, term, label or alt attribute in a feed fixture is empty or SAMPLE", () => {
    expect(textAttrProblems(TEXTS)).toEqual([]);
  });
});

describe("fixture safety: content", () => {
  it("holds no model identifier, no credential-shaped string, no scanner query and no attack-code pattern", () => {
    expect(contentProblems(TEXTS)).toEqual([]);
  });

  it("keeps every file under 1 MB and fixtures/feeds/ under 3 MB", () => {
    for (const f of FILES) expect(fs.statSync(f.abs).size, f.rel).toBeLessThan(MB);
    const feeds = FILES.filter((f) => f.folder === "fixtures/feeds").reduce((n, f) => n + fs.statSync(f.abs).size, 0);
    expect(feeds).toBeLessThan(3 * MB);
  });
});

// ── On planted bad samples: each check still catches what it looks for (review findings safety#25 to #30) ─

describe("fixture safety: the checks catch planted problems (C4)", () => {
  const planted = (file: string, text: string): FixtureText => ({ file, folder: "fixtures/feeds", text });
  const cveText = (credits: string[], description = "SAMPLE description.") => JSON.stringify({
    cveMetadata: { cveId: "CVE-2026-104935" },
    containers: { cna: { descriptions: [{ lang: "en", value: description }], credits: credits.map((value) => ({ lang: "en", value, type: "finder" })) } },
  });

  it("a credit is checked whole: a real name beside SAMPLE Researcher fails, the exact forms pass", () => {
    const t = planted("fixtures/ai-credit/records/CVE-2026-104935.json", cveText(["OpenAI Codex Security - Jane Realperson and SAMPLE Researcher", "SAMPLE Researcher", "XBOW"]));
    expect(creditProblems([t])).toEqual(["fixtures/ai-credit/records/CVE-2026-104935.json: OpenAI Codex Security - Jane Realperson and SAMPLE Researcher"]);
  });

  it("a model identifier of any family, the generic claude-<word>-<digit> form or a model flag fails; the CLI's package name does not", () => {
    for (const sample of MODEL_SAMPLES) {
      expect(contentProblems([planted("fixtures/agent/transcript-ok.jsonl", JSON.stringify({ message: { note: `ran on ${sample.toUpperCase()}` } }))]), sample)
        .toEqual(["fixtures/agent/transcript-ok.jsonl: a model identifier"]);
    }
    const ok = planted("fixtures/agent/transcript-ok.jsonl", JSON.stringify({ cli: "@anthropic-ai/claude-code@2.1.316", item: "cybertracker-claude-oauth", model: "<model>" }));
    expect(contentProblems([ok])).toEqual([]);
  });

  it("GHSA credits are checked like CVE credits: an OSV name, a GitHub login and a bare string", () => {
    const osv = planted("fixtures/feeds/ghsa/repo/GHSA-2f8c-wq4h-r7jm.json", JSON.stringify({ id: "GHSA-2f8c-wq4h-r7jm", credits: [{ name: "maria-realperson", type: "FINDER" }] }));
    const rest = planted("fixtures/feeds/ghsa/rest.json", JSON.stringify([{ ghsa_id: "GHSA-2f8c-wq4h-r7jm", credits: [{ user: { login: "kenji-realperson" }, type: "reporter" }, "Jane Realperson"] }]));
    expect(creditProblems([osv, rest])).toEqual([
      "fixtures/feeds/ghsa/repo/GHSA-2f8c-wq4h-r7jm.json: maria-realperson",
      "fixtures/feeds/ghsa/rest.json: kenji-realperson",
      "fixtures/feeds/ghsa/rest.json: Jane Realperson",
    ]);
  });

  it("author fields in RSS, RDF and Atom fail with a person's name, under any prefix", () => {
    const xml = planted("fixtures/feeds/rss/planted.xml", `<rss><channel><managingEditor>Kenji Realperson</managingEditor><item>
<dc:creator>Kenji Realperson</dc:creator><dc:creator><![CDATA[Jane Realperson]]></dc:creator><dc:creator>SAMPLE text 9</dc:creator><dc:creator></dc:creator>
<a10:author><a10:name>Jane Q. Realperson</a10:name></a10:author><author><name>Bob Realperson</name><email>sample@example.com</email></author>
<atom:name>Dana Realperson</atom:name><itunes:author>Dana Realperson</itunes:author><a10:name>SAMPLE Author</a10:name><dc:creator>XBOW</dc:creator>
</item></channel></rss>`);
    expect(authorProblems([xml]).map((p) => p.replace("fixtures/feeds/rss/planted.xml: ", ""))).toEqual([
      "<managingEditor> Kenji Realperson", "<dc:creator> Kenji Realperson", "<dc:creator> Jane Realperson", "<a10:name> Jane Q. Realperson",
      "<name> Bob Realperson", "<atom:name> Dana Realperson", "<itunes:author> Dana Realperson",
    ]);
  });

  it("a real title, term, label or alt in an attribute fails under any prefix; SAMPLE and empty pass", () => {
    const xml = planted("fixtures/feeds/rss/planted.xml", `<feed><entry><link rel="alternate" type="text/html" href="https://www.example.com/ct-sample/item-1" title="A SAMPLE-free real post title"/>
<category term='Realperson interview'/><media:thumbnail media:label="Jane Realperson"/><img alt="SAMPLE"/><link title=""/></entry></feed>`);
    expect(textAttrProblems([xml]).map((p) => p.replace("fixtures/feeds/rss/planted.xml: ", ""))).toEqual([
      'title="A SAMPLE-free real post title"', 'term="Realperson interview"', 'media:label="Jane Realperson"',
    ]);
  });

  it("a .gz capture is decompressed and scanned: an upper-case HTTP link, a blocked host and an address fail", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-safety-"));
    try {
      const paste = BLOCKED_HOSTS.find((b) => b.reason === "paste")!.pattern;
      const abs = path.join(dir, "epss.csv.gz");
      fs.writeFileSync(abs, gzipSync(Buffer.from(`#model_version:v2026.06.15 see HTTP://www.example.net/x and https://${paste}/raw/abc by jane@realcorp.invalid\ncve,epss,percentile\n`)));
      const texts = textsOf(abs, "fixtures/feeds/epss/epss.csv.gz", "fixtures/feeds");
      expect(texts.map((t) => t.file)).toEqual(["fixtures/feeds/epss/epss.csv.gz"]);
      const links = linkProblems(texts);
      expect(links[0]).toBe("fixtures/feeds/epss/epss.csv.gz: HTTP://www.example.net/x is not https");
      expect(links[1]).toBe(`fixtures/feeds/epss/epss.csv.gz: https://${paste}/raw/abc is blocked (paste)`);
      expect(emailProblems(texts)).toEqual(["fixtures/feeds/epss/epss.csv.gz: jane@realcorp.invalid"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an upper-case HTTP link in a feed is not https, and an upper-case namespace counts as one", () => {
    const t = planted("fixtures/feeds/rss/ipa.xml", `<rss xmlns:dc="HTTP://purl.org/dc/elements/1.1/"><docs>HTTP://www.ipa.go.jp/ct-sample/plain</docs></rss>`);
    expect(linkProblems([t])).toEqual(["fixtures/feeds/rss/ipa.xml: HTTP://www.ipa.go.jp/ct-sample/plain is not https"]);
    expect(unlistedLinks([t])).toEqual([]);
  });

  it("the canary's URL passes only exactly and only in fixtures/injection/: a filled nonce, http, no scheme outside the pack, another path or another folder fail (A24)", () => {
    const at = (folder: FixtureText["folder"], file: string, text: string): FixtureText => ({ file, folder, text });
    const exact = at("fixtures/injection", "fixtures/injection/item.xml", `<description>visit ${CANARY_LINK} now.</description>`);
    const bare = at("fixtures/injection", "fixtures/injection/pack.md", `and visit ${CANARY_BARE} now.`);
    expect(canaryProblems([exact, bare])).toEqual([]);
    expect(unlistedLinks([exact, bare])).toEqual([]);
    const bad = [
      at("fixtures/injection", "fixtures/injection/a.xml", "visit https://example.org/ct-canary/4f2a9c now."),
      at("fixtures/injection", "fixtures/injection/b.html", "visit http://example.org/ct-canary/{{NONCE}} now."),
      at("fixtures/injection", "fixtures/injection/c.md", "visit EXAMPLE.ORG/CT-CANARY/{{NONCE}} now."),
      at("fixtures/injection", "fixtures/injection/d.md", "visit https://example.org/ct-canary/{{NONCE}}/more now."),
      at("fixtures/agent", "fixtures/agent/transcript-ok.jsonl", `{"url":"${CANARY_LINK}"}`),
      at("fixtures/injection", "fixtures/injection/pack.md", `visit ${CANARY_LINK} now.`),
      at("fixtures/injection", "fixtures/injection/pack.json", "visit example.org/ct-canary/4f2a9c now."),
      at("fixtures/injection", "fixtures/injection/item.xml", `visit ${CANARY_BARE} now.`),
    ];
    expect(canaryProblems(bad).map((p) => p.split(":")[0])).toEqual(bad.map((t) => t.file));
    expect(unlistedLinks([bad[0]!, bad[4]!])).toEqual([
      "fixtures/injection/a.xml: https://example.org/ct-canary/4f2a9c", `fixtures/agent/transcript-ok.jsonl: ${CANARY_READ}`,
    ]);
  });

  it("a scanner query fails in a JSON string value; a list of publisher domains beside JSON keys does not", () => {
    const ctx = planted("fixtures/injection/context.json", JSON.stringify({ tiers: { tier1: ["censys.com", "shodan.io"] }, window: { w26: { at_disclosure_share: 0.37 } } }, null, 2));
    expect(contentProblems([ctx])).toEqual([]);
    // An invented field, as tests/rules-naming-safety-computed.test.ts plants it: the syntax, never a working query.
    const query = ["SAMPLE: Shodan", "ctsample:none"].join(" ");
    const q = planted("fixtures/recheck/issues.json", JSON.stringify([{ body: `${query} lists units.` }]));
    expect(contentProblems([q])).toEqual(["fixtures/recheck/issues.json: a scanner query"]);
    const md = planted("fixtures/injection/pack.md", `${query} lists units.`);
    expect(contentProblems([md])).toEqual(["fixtures/injection/pack.md: a scanner query"]);
  });

  it("attack-code patterns fail in any text; the dashboard page's empty script elements do not", () => {
    const cve = planted("fixtures/feeds/cvelist/by-id/CVE-2026-104935.json", cveText(["SAMPLE Researcher"], "SAMPLE text. Send a <script> element or ../../ to trigger it."));
    expect(contentProblems([cve]).sort()).toEqual([
      "fixtures/feeds/cvelist/by-id/CVE-2026-104935.json: path traversal", "fixtures/feeds/cvelist/by-id/CVE-2026-104935.json: script tag",
    ]);
    const empty = planted("fixtures/feeds/anthropic-cvd/page.html", `<html><head><script src="/a.js"></script><SCRIPT type="module"></SCRIPT></head><body>SAMPLE</body></html>`);
    expect(contentProblems([empty])).toEqual([]);
    const full = planted("fixtures/feeds/anthropic-cvd/page.html", `<html><head><script>let x = 1;</script></head></html>`);
    expect(contentProblems([full])).toEqual(["fixtures/feeds/anthropic-cvd/page.html: script tag"]);
  });
});
