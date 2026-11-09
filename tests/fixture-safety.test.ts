// Fixture safety for P2's fixture folders (SPEC §0.2, §4.12 "Fixtures and tests"; AGENTS rules 8 and 10;
// fixtures plan §6.1): real formats, invented prose, and nothing a reader could use or be harmed by. Over
// every text file, and every entry of the generated zips, under fixtures/feeds/, fixtures/state/,
// fixtures/reference/, fixtures/cvelist-clone/, fixtures/ai-credit/ and P1's fixtures/cvelist/records/:
//   - every link is https (an http XML namespace in a feed body aside), on no blocked host, with no exploit
//     path (NO_EXPLOIT_LINK's test), and on a listed publisher's host, a registry host, a canonical record page, one of the three
//     GitHub repos the run reads, or a reserved example domain;
//   - a CVE record's references are a listed publisher's /ct-sample/ page, the KEV catalog page or a
//     reserved example domain, and an exploit-tagged one only the last;
//   - credits name no person (SAMPLE Researcher, or an organisation or tool on the list below);
//   - fixtures/state/ and fixtures/reference/ hold no link and no e-mail address at all, and elsewhere an
//     e-mail address is a reserved example one or an organisation's role address;
//   - no model identifier, no credential-shaped string, no scanner query;
//   - no file over 1 MB, and fixtures/feeds/ under 3 MB.
// Everything read here is data.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { readZip } from "@/lib/feeds/zip";
import { exploitLinkProblem, hasScannerQuery, secretsIn } from "@/lib/rules/safety";
import { blockedReason, publisherFor } from "@/lib/sources";
import { extractUrls } from "@/lib/urls";

const ROOT = path.join(__dirname, "..");
const config = loadConfig({ root: ROOT });
const PUB = { sourceTiers: config.sourceTiers, vendors: config.vendors };

const FOLDERS = ["fixtures/feeds", "fixtures/state", "fixtures/reference", "fixtures/cvelist-clone", "fixtures/ai-credit", "fixtures/cvelist/records"] as const;
/** Folders that hold ids, dates, counts, vendor and product names and matched tool names only. */
const NO_LINK_FOLDERS = ["fixtures/state", "fixtures/reference"];

const MB = 1024 * 1024;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** XML namespace URIs a feed body declares (never fetched, never shown). */
const XML_NAMESPACE = /^http:\/\/(?:purl\.org|www\.w3\.org|jvn\.jp\/rss|data-marking\.mitre\.org|jvndb\.jvn\.jp\/myjvn|www\.us-cert\.gov\/tlp)\//;
/** The three repositories the run reads through git or raw.githubusercontent.com (SPEC §8.3). */
const RUN_REPOS = /^https:\/\/(?:github\.com|raw\.githubusercontent\.com)\/(?:CVEProject\/cvelistV5|cisagov\/kev-data|github\/advisory-database)(?:[/.]|$)/;
/** Canonical record pages: the CVE record, the NVD detail page and the KEV catalog entry. */
const RECORD_PAGE = /^https:\/\/(?:www\.cve\.org\/CVERecord\?id=CVE-\d{4}-\d{4,}|nvd\.nist\.gov\/vuln\/detail\/CVE-\d{4}-\d{4,}|www\.cisa\.gov\/known-exploited-vulnerabilities-catalog\?field_cve=CVE-\d{4}-\d{4,})$/;
const KEV_PAGE = /^https:\/\/www\.cisa\.gov\/known-exploited-vulnerabilities-catalog\?field_cve=CVE-\d{4}-\d{4,}$/;
const EXAMPLE_HOST = /(?:^|\.)example\.(?:com|org|net)$/;
/** Organisations' role addresses that real record and feed formats carry (a CNA, NVD's source id). */
const ROLE_EMAILS = new Set(["nvd@nist.gov", "security@apache.org", "cret@cert.org"]);
/**
 * Credit strings that name no person: organisations, programmes and tools, as the trimmed records keep
 * them. Any other credit must hold "SAMPLE" (SAMPLE Researcher, SAMPLE Developer).
 */
const ORG_CREDITS = new Set([
  "Ada Logics", "Anthropic, Claude", "Anthropic OSS program", "Anthropic OSS-scanner (re-report, ANT-2026-N0E1INIV)", "Claude Code",
  "Claude Security", "MopMonk AI", "OpenAI", "Red Hat would like to thank Aisle Research for reporting this issue.",
  "Security Research Center (SRC) @ Concordia University", "The ASF using Claude Agents", "The Apache Software Foundation",
  "This issue was discovered by Found by AISLE in partnership with Red Hat.", "Wiz", "WPScan", "Wordfence PRISM", "XBOW",
  "https://example.com/ct-sample/sample-researcher", "https://example.com/ct-sample/sample-xbow", "https://example.com/ct-sample/xbow-security",
]);

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

/** Every text to scan: text files as UTF-8, each zip entry as UTF-8; .gz captures are binary and skipped. */
const TEXTS: FixtureText[] = FILES.flatMap(({ folder, abs, rel }): FixtureText[] => {
  if (rel.endsWith(".gz")) return [];
  if (rel.endsWith(".zip")) return readZip(fs.readFileSync(abs)).map((e) => ({ file: `${rel}:${e.name}`, folder, text: e.data.toString("utf8") }));
  return [{ file: rel, folder, text: fs.readFileSync(abs, "utf8") }];
});

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

describe("fixture safety: what the scan covers", () => {
  it("reads every P2 fixture folder, the generated zips' entries and the trimmed records", () => {
    for (const f of FOLDERS) expect(FILES.some((x) => x.folder === f), f).toBe(true);
    expect(TEXTS.some((t) => t.file.includes(".zip:deltaCves/"))).toBe(true);
    for (const f of ["fixtures/feeds", "fixtures/cvelist-clone", "fixtures/ai-credit", "fixtures/cvelist/records"]) {
      expect(RECORDS.some((r) => r.folder === f), f).toBe(true);
    }
  });
});

describe("fixture safety: links", () => {
  it("every link is https (or a feed's XML namespace), on no blocked host and with no exploit path", () => {
    const bad: string[] = [];
    for (const t of TEXTS) {
      for (const u of urlsIn(t.text)) {
        if (u.startsWith("http://")) {
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
    expect(bad).toEqual([]);
  });

  it("every link is a listed publisher's, a registry host, a record page, a repo the run reads, or a reserved example domain", () => {
    const bad: string[] = [];
    for (const t of TEXTS) {
      for (const u of urlsIn(t.text)) {
        if (u.startsWith("http://")) continue;
        const ok = EXAMPLE_HOST.test(hostOf(u)) || RUN_REPOS.test(u) || RECORD_PAGE.test(u) || REGISTRY_HOSTS.has(hostOf(u)) || isListed(u);
        if (!ok) bad.push(`${t.file}: ${u}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("fixtures/state/ and fixtures/reference/ hold no link and no e-mail address", () => {
    for (const t of TEXTS.filter((x) => NO_LINK_FOLDERS.includes(x.folder))) {
      expect(urlsIn(t.text), t.file).toEqual([]);
      expect(t.text.match(EMAIL_RE) ?? [], t.file).toEqual([]);
    }
  });

  it("an e-mail address anywhere else is a reserved example one or an organisation's role address", () => {
    const bad: string[] = [];
    for (const t of TEXTS) {
      for (const e of t.text.match(EMAIL_RE) ?? []) {
        if (!EXAMPLE_HOST.test(e.split("@")[1]!.toLowerCase()) && !ROLE_EMAILS.has(e.toLowerCase())) bad.push(`${t.file}: ${e}`);
      }
    }
    expect(bad).toEqual([]);
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

  it("credits name no person: SAMPLE Researcher, or an organisation or tool", () => {
    const bad: string[] = [];
    for (const r of RECORDS) {
      for (const c of containersOf(r.record)) {
        for (const cr of c.credits ?? []) if (!cr.value.includes("SAMPLE") && !ORG_CREDITS.has(cr.value)) bad.push(`${r.file}: ${cr.value}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("fixture safety: content", () => {
  // Built from parts so this file does not hold the patterns tests/no-europe-strings.test.ts looks for.
  const modelRe = new RegExp(`claude-(?:opus|sonnet|haiku)|${"-".repeat(2)}model\\b`, "i");

  it("holds no model identifier, no credential-shaped string and no scanner query", () => {
    const bad: string[] = [];
    for (const t of TEXTS) {
      if (modelRe.test(t.text)) bad.push(`${t.file}: a model identifier`);
      for (const name of secretsIn(t.text)) bad.push(`${t.file}: ${name}`);
      if (hasScannerQuery(t.text)) bad.push(`${t.file}: a scanner query`);
    }
    expect(bad).toEqual([]);
  });

  it("keeps every file under 1 MB and fixtures/feeds/ under 3 MB", () => {
    for (const f of FILES) expect(fs.statSync(f.abs).size, f.rel).toBeLessThan(MB);
    const feeds = FILES.filter((f) => f.folder === "fixtures/feeds").reduce((n, f) => n + fs.statSync(f.abs).size, 0);
    expect(feeds).toBeLessThan(3 * MB);
  });
});
