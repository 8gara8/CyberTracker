// config/ (SPEC §4.11, §4.13, Appendix B): every file parses with its schema and passes validateConfig();
// the seed counts Appendix B states; the D.7 strip fix; normalizeVendor() and matchVendor(); the P2
// registry and Verify checks; sample mode and overrides; and a broken copy of each config file failing with
// its CONFIG_* code (§4.12 T cases).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_PATTERN_FLAGS, CONFIG_DIR, CONFIG_FILES, CONFIG_KEYS, ConfigError, cnaConfirms, compileConfig, configVersions, loadConfig,
  matchCredit, matchVendor, normalizeVendor, SAMPLE_CLAIMS_FILE, validateConfig, type ConfigFiles, type ConfigKey,
} from "@/lib/config";
import { liveIndicators, listedHosts } from "@/lib/rules/safety";
import { ClaimsFile } from "@/lib/schema/scoreboard";
import { contentDir, isSampleData, issueFormUrl, SITE_NAME, SITE_TAGLINE, siteUrl } from "@/lib/site";
import { blockedReason, compileTier1Paths, publisherFor, TIER1_PATH_FLAGS } from "@/lib/sources";
import { blockedEntry, hostMatches } from "@/lib/urls";
import { COVERAGE, LEVELLED_REGIONS, REGION_RULE_TYPES } from "@/lib/vocab";

const root = path.join(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const json = (rel: string) => JSON.parse(read(rel)) as unknown;

beforeEach(() => {
  vi.stubEnv("CT_CONTENT_DIR", "content");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** The production config, loaded fresh with config/claims.json. */
const prod = () => loadConfig({ root, fresh: true });

/** The CONFIG_* codes a set of overrides produces: loadConfig()'s (thrown) or validateConfig()'s. */
function codesFor(overrides: Partial<Record<ConfigKey, unknown>>, opts: { root?: string } = {}): string[] {
  try {
    const c = loadConfig({ root: opts.root ?? root, overrides, fresh: true });
    return [...new Set(validateConfig(c).map((i) => i.code))];
  } catch (e) {
    if (e instanceof ConfigError) return [...new Set(e.issues.map((i) => i.code))];
    throw e;
  }
}

/** A deep copy of one file's parsed contents, to break. */
function copyOf<K extends ConfigKey>(k: K): ConfigFiles[K] {
  return structuredClone(prod()[k]);
}

describe("config/ files", () => {
  it("holds exactly the files lib/config.ts loads", () => {
    const onDisk = fs.readdirSync(path.join(root, CONFIG_DIR)).sort();
    expect(onDisk).toEqual(Object.values(CONFIG_FILES).sort());
  });

  it("each parses with its schema, loads and passes validateConfig()", () => {
    const c = prod();
    for (const k of CONFIG_KEYS) expect(c.paths[k]).toBe(`config/${CONFIG_FILES[k]}`);
    expect(c.sampleClaims).toBe(false);
    expect(validateConfig(c)).toEqual([]);
  });

  it("parses the raw YAML registry with every key written out", () => {
    const raw = parseYaml(read("config/sources.yaml")) as { feeds: Record<string, unknown>[] };
    for (const f of raw.feeds) {
      if (f.kind === "search") continue;
      expect(Object.keys(f), String(f.id)).toEqual(expect.arrayContaining(["fallback_url", "must_match"]));
    }
  });

  it("records SHA-256 hashes and the versions the metrics file stores", () => {
    const c = prod();
    expect(c.sha256.aiFinders).toMatch(/^[0-9a-f]{64}$/);
    expect(configVersions(c)).toEqual({ vendors: 2, ai_finders: 2, source_tiers: 1, regions: 1, actors: 1 });
  });
});

describe("seed counts (Appendix B)", () => {
  it("B.1 vendors: 213, 162 widely deployed, 27 TW, 26 JP, 19 community; TW and JP first", () => {
    const { vendors } = prod().vendors;
    expect(vendors).toHaveLength(213);
    expect(vendors.filter((v) => v.widely_deployed)).toHaveLength(162);
    expect(vendors.filter((v) => v.country === "TW")).toHaveLength(27);
    expect(vendors.filter((v) => v.country === "JP")).toHaveLength(26);
    expect(vendors.filter((v) => v.country === null)).toHaveLength(19);
    expect(vendors.slice(0, 27).every((v) => v.country === "TW")).toBe(true);
    expect(vendors.slice(27, 53).every((v) => v.country === "JP")).toBe(true);
    expect(vendors.slice(-19).every((v) => v.country === null)).toBe(true);
    const byId = new Map(vendors.map((v) => [v.id, v]));
    expect(byId.get("tp-link")?.country).toBe("CN");
    expect(byId.get("hitachi")?.country).toBe("JP");
    expect(byId.get("samsung")?.cna).toEqual(["Samsung Mobile", "SamsungMobile", "samsung.tv_appliance"]);
  });

  it("B.2 ai-finders: three fields, thirteen finders in match order, generic last", () => {
    const af = prod().aiFinders;
    expect(af.updated).toBe("2026-11-09");
    expect(af.fields).toEqual(["cna.credits", "adp.credits", "ghsa.credits"]);
    expect(af.finders.map((f) => f.id)).toEqual(["anthropic-claude", "anthropic-claude-code", "openai-codex", "openai-chatgpt",
      "google-big-sleep", "google-gemini", "xbow", "aisle", "depthfirst", "zeropath", "aixcc", "vulnhuntr", "generic-ai-assisted"]);
    expect(af.strip).toHaveLength(8);
  });

  it("B.3 source tiers: 6 + 48 + 4 + 46 tier 1, 55 tier 2, 29 tier 3", () => {
    const { publishers, github } = prod().sourceTiers;
    const t1 = publishers.filter((p) => p.tier === 1);
    expect(t1).toHaveLength(104);
    expect(publishers.slice(0, 6).map((p) => p.id)).toEqual(["cve-org", "nvd", "cisa-kev", "github-advisories", "osv", "first-epss"]);
    expect(t1.filter((p) => p.state_label === "PRC state source").map((p) => p.id)).toEqual(["cverc", "prc-mfa", "prc-mps", "prc-cac"]);
    expect(t1.filter((p) => p.kind === "research")).toHaveLength(46);
    expect(t1.filter((p) => ["government", "cert", "regulator"].includes(p.kind) && p.state_label === null)).toHaveLength(48 + 2);
    expect(publishers.filter((p) => p.tier === 2 && p.kind === "newsroom")).toHaveLength(55);
    expect(publishers.filter((p) => p.tier === 2)).toHaveLength(55);
    const t3 = publishers.filter((p) => p.tier === 3);
    expect(t3).toHaveLength(29);
    expect(t3.filter((p) => p.state_label === "PRC state media").map((p) => p.id)).toEqual(["xinhua", "global-times", "cgtn"]);
    expect(t3.filter((p) => p.state_label === "Russian state media").map((p) => p.id)).toEqual(["tass", "rt"]);
    expect(publishers.filter((p) => !p.sole_newsroom_for_critical).map((p) => p.id)).toEqual(["the-hacker-news"]);
    expect(github.tier1_paths).toEqual(["^/advisories/GHSA-[\\w-]+", "^/[^/]+/[^/]+/security/advisories/GHSA-[\\w-]+", "^/CVEProject/",
      "^/cisagov/", "^/github/advisory-database/"]);
    // B.3 lists github.com for github-advisories; publisherFor() still gives tier 1 only to github.tier1_paths.
    expect(publishers.find((p) => p.id === "github-advisories")?.domains).toEqual(["github.com"]);
  });

  it("github.com: tier 1 only on github.tier1_paths, yet a listed domain for NO_LIVE_IOC", () => {
    const c = prod();
    expect(publisherFor("https://github.com/advisories/GHSA-abcd-efgh-ijkl", "cve_record", c).publisher).toBe("github-advisories");
    const other = publisherFor("https://github.com/example/example", "press", c);
    expect([other.tier, other.publisher]).toEqual([3, "host:github.com"]);
    expect(liveIndicators("The maintainers posted the fix on github.com.", listedHosts(c))).toEqual([]);
  });

  it("compiles alert_patterns and tier1_paths only to check them, with the flags lib/regions.ts and lib/sources.ts use", () => {
    const c = prod();
    expect(Object.keys(c.compiled)).toEqual(["aiFinders"]);
    expect([ALERT_PATTERN_FLAGS, TIER1_PATH_FLAGS]).toEqual(["iu", "iu"]);
    expect(compileTier1Paths(c.sourceTiers).map((re) => re.flags)).toEqual(c.sourceTiers.github.tier1_paths.map(() => TIER1_PATH_FLAGS));
  });

  it("B.4 regions: four regions, EU is the EU 27 plus IS, LI, NO, CH and GB, seven rules", () => {
    const r = prod().regions;
    expect(r.review_due).toBe("2026-12-02");
    expect(r.regions.map((x) => x.code)).toEqual([...LEVELLED_REGIONS]);
    const eu = r.regions.find((x) => x.code === "EU")!;
    expect(eu.countries).toHaveLength(32);
    expect(eu.countries).toEqual(expect.arrayContaining(["IS", "LI", "NO", "CH", "GB"]));
    expect(eu.countries).not.toContain("UA");
    expect(r.regions.filter((x) => x.alert_patterns.length > 0).map((x) => x.code)).toEqual(["US", "EU", "JP"]);
    expect(r.regions.map((x) => x.home_vendor_country)).toEqual([null, null, "TW", "JP"]);
    expect(r.rules.map((x) => x.id)).toEqual(["cni-disruption", "agency-alert", "high-breach", "serious-victim", "campaign-target",
      "home-vendor-kev", "home-cert-exploitation"]);
    expect(new Set(r.rules.map((x) => x.type))).toEqual(new Set(REGION_RULE_TYPES));
    expect(r.editor_raise).toEqual({ max_steps: 1, max_per_region: 1 });
  });

  it("B.5 annotations, B.7 watch windows, B.8 standing stories, B.10 claims", () => {
    const c = prod();
    expect(c.annotations.annotations.map((a) => [a.id, a.date, a.end_date, a.kind])).toEqual([
      ["nvd-scoring-stop", "2026-04-15", null, "data_change"],
      ["us-kev-three-day-deadline", "2026-06-10", null, "policy"],
      ["kernel-batch-2026-07", "2026-07-19", "2026-07-20", "data_change"],
    ]);
    expect(c.watchWindows).toEqual({ schema_version: 1, windows: [] });
    expect(c.standingStories.stories.map((s) => s.id)).toEqual(["salt-typhoon", "volt-typhoon", "dprk-it-workers", "taiwan-undersea-cables"]);
    expect(c.standingStories.stories.every((s) => s.seed_last_development === null && s.seed_source_url === null)).toBe(true);
    expect(json("config/claims.json")).toEqual({ schema_version: 1, version: 0, claims: [] });
  });

  it("B.6 actors: 25, sibling cross-links, aliases only with a MITRE page", () => {
    const { actors } = prod().actors;
    expect(actors).toHaveLength(25);
    expect(actors.filter((a) => a.related_tracker === "europe").map((a) => a.id)).toEqual(["apt28", "apt29", "sandworm", "turla", "noname057-16"]);
    expect(actors.filter((a) => a.related_tracker === "me").map((a) => a.id)).toEqual(["apt35", "muddywater", "cyberav3ngers"]);
    for (const a of actors) {
      if (a.mitre_id === null) expect(a.aliases, a.id).toEqual([]);
      for (const x of a.aliases) expect(x.source_url, a.id).toBe(`https://attack.mitre.org/groups/${a.mitre_id}/`);
    }
    const silk = actors.find((a) => a.id === "silk-typhoon")!;
    expect(silk.aliases).toEqual([{ name: "HAFNIUM", by: "Microsoft, former name", source_url: "https://attack.mitre.org/groups/G0125/" }]);
  });

  it("versioned files: vendors and ai-finders at 2 (P2: Schneider's CNA; the AISLE and Team Atlanta spellings), the rest at 1", () => {
    const c = prod();
    expect([c.vendors, c.aiFinders].map((f) => f.version)).toEqual([2, 2]);
    for (const f of [c.sourceTiers, c.regions, c.actors]) expect(f.version).toBe(1);
  });
});

describe("the D.7 strip fix", () => {
  const SEED_STRIP = "\\bClaude (?!Mythos\\b|Code\\b)[A-Z][\\w'’-]+\\b(?! \\d)";
  const FIXED_STRIP = "\\bClaude (?!Mythos\\b|Code\\b|Security\\b|Agents?\\b)[A-Z][\\w'’-]+\\b(?! \\d)";
  const CREDITS = ["Claude Security", "Claude Security Scans", "The ASF using Claude Agents"];

  it("is the third strip rule, as Appendix D.7 writes it", () => {
    expect(prod().aiFinders.strip[2]).toBe(FIXED_STRIP);
  });

  it("restores the Claude Security and Claude Agents credits", () => {
    const fixed = prod().compiled.aiFinders;
    for (const s of CREDITS) {
      expect(matchCredit(s, fixed), s).toEqual({ finder_id: "anthropic-claude", family: "anthropic", kind: "ai_system", rule: "pattern", matched: "Claude" });
    }
    const seed = structuredClone(prod().aiFinders);
    seed.strip[2] = SEED_STRIP;
    const before = compileConfig({ ...prod(), aiFinders: seed });
    expect(before.issues).toEqual([]);
    for (const s of CREDITS) expect(matchCredit(s, before.compiled.aiFinders), s).toBeNull();
  });

  it("still strips a person named Claude", () => {
    const fixed = prod().compiled.aiFinders;
    for (const s of ["Claude Dupont of Example Labs", "Jean-Claude Martin", "reported by Claude Agnelli"]) expect(matchCredit(s, fixed), s).toBeNull();
  });
});

describe("vendors (§4.11 Matching)", () => {
  it("normalizeVendor() follows §4.11", () => {
    expect(normalizeVendor("Soliton Systems K.K")).toBe("soliton systems");
    expect(normalizeVendor("Sangfor Technologies Co., Ltd.")).toBe("sangfor technologies");
    expect(normalizeVendor("Joomla!")).toBe("joomla");
    expect(normalizeVendor("D-Link and TRENDnet")).toBe(normalizeVendor("D-Link & TRENDnet"));
    expect(normalizeVendor("Inc")).toBe("inc");
    expect(normalizeVendor("  Hewlett Packard Enterprise (HPE)  ")).toBe("hewlett packard enterprise hpe");
  });

  it("matchVendor() reads KEV vendorProject first, then the first affected vendor that matches", () => {
    const c = prod();
    expect(matchVendor(c, { kevVendorProject: "QNAP Systems, Inc." })?.id).toBe("qnap");
    expect(matchVendor(c, { kevVendorProject: "Soliton Systems K.K" })?.id).toBe("soliton");
    expect(matchVendor(c, { kevVendorProject: "SolarView" })?.id).toBe("contec");
    expect(matchVendor(c, { kevVendorProject: "Unknown Maker", affectedVendors: ["n/a", "", null, "Nobody", "Hitachi Vantara", "Cisco"] })?.id).toBe("hitachi");
    expect(matchVendor(c, { kevVendorProject: "N/A", affectedVendors: ["n/a"] })).toBeNull();
    expect(matchVendor(c, { kevVendorProject: "TP-Link" })?.country).toBe("CN");
  });

  it("the assigner only confirms, never sets the vendor", () => {
    const c = prod();
    const qnap = matchVendor(c, { kevVendorProject: "QNAP" });
    expect(cnaConfirms(qnap, "qnap")).toBe(true);
    expect(cnaConfirms(qnap, "JFROG")).toBe(false);
    expect(cnaConfirms(null, "qnap")).toBe(false);
    expect(matchVendor(c, { kevVendorProject: null, affectedVendors: [] })).toBeNull();
  });
});

describe("source registry (§4.13)", () => {
  // Claims do not matter here, so whatever CT_CONTENT_DIR is set to at collection time is fine.
  const { sources, sourceTiers, vendors } = loadConfig({ root, fresh: true });
  const feeds = sources.feeds;

  it("has 35 to 60 entries and at least 40 keywords", () => {
    expect(feeds.length).toBeGreaterThanOrEqual(35);
    expect(feeds.length).toBeLessThanOrEqual(60);
    expect(sources.keywords.length).toBeGreaterThanOrEqual(40);
  });

  it("covers every coverage value; Taiwan and Japan in their own languages", () => {
    for (const cv of COVERAGE) expect(feeds.filter((f) => f.coverage.includes(cv)).length, cv).toBeGreaterThanOrEqual(3);
    const tw = feeds.filter((f) => f.coverage.includes("taiwan"));
    expect(tw.length).toBeGreaterThanOrEqual(5);
    expect(tw.filter((f) => f.language === "zh-Hant-TW").length).toBeGreaterThanOrEqual(2);
    const jp = feeds.filter((f) => f.coverage.includes("japan"));
    expect(jp.length).toBeGreaterThanOrEqual(4);
    expect(jp.filter((f) => f.language === "ja").length).toBeGreaterThanOrEqual(2);
  });

  it("has no rss or search entry on a blocked host, no Telegram and no Google News", () => {
    for (const f of feeds) {
      if (f.kind === "rss") expect(blockedEntry(f.url), f.id).toBeNull();
      if (f.kind === "search") {
        for (const m of f.query.matchAll(/\bsite:(\S+)/g)) expect(blockedEntry(`https://${m[1]}/`), f.id).toBeNull();
      }
      const text = f.kind === "search" ? f.query : `${f.url} ${f.fallback_url ?? ""}`;
      expect(text, f.id).not.toMatch(/t\.me\/|telegram|news\.google\.com/i);
    }
  });

  function listedTier(url: string): 1 | 2 | 3 {
    return publisherFor(url, "press", { sourceTiers, vendors }).tier;
  }

  // §4.13: every rss URL resolves through publisherFor() to tier 1 or 2, with no exemptions. The Hacker News
  // and CNA publish through feedburner, so their publishers list their feed paths on feeds.feedburner.com.
  it("resolves every rss URL to a tier 1 or 2 publisher", () => {
    const off = feeds.filter((f) => f.kind === "rss" && ![1, 2].includes(listedTier(f.url))).map((f) => f.id);
    expect(off).toEqual([]);
    const pub = (id: string) => publisherFor((feeds.find((f) => f.id === id) as { url: string }).url, "press", { sourceTiers, vendors }).publisher;
    expect([pub("thehackernews"), pub("cna")]).toEqual(["the-hacker-news", "cna"]);
    expect(publisherFor("https://feeds.feedburner.com/SomeOtherFeed", "press", { sourceTiers, vendors }).tier).toBe(3);
    const aggregators = sourceTiers.publishers.filter((p) => p.kind === "aggregator").flatMap((p) => p.domains);
    for (const f of feeds) if (f.kind === "rss") expect(aggregators.some((d) => hostMatches(new URL(f.url).hostname, d)), f.id).toBe(false);
  });
});

// P2 finalises the registry and the seed's Verify items (§4.13, Appendix B; fixtures plan §7). These are the
// checks that hold before the Kobol sessions; the two that need them stay skipped until then.
describe("the P2 registry and the Verify items", () => {
  const { sources, sourceTiers } = loadConfig({ root, fresh: true });
  const feeds = sources.feeds;
  const fetched = feeds.flatMap((f) => (f.kind === "search" ? [] : [f]));
  const STRUCTURED = ["kev", "cvelist", "epss", "ghsa", "nvd", "myjvn", "anthropic-cvd", "exchange"] as const;
  const one = (id: string) => feeds.find((f) => f.id === id)!;

  it("has unique ids, every structured kind (one entry each, exchange aside), and no search entry at priority 1", () => {
    expect(new Set(feeds.map((f) => f.id)).size).toBe(feeds.length);
    for (const k of STRUCTURED) {
      const n = feeds.filter((f) => f.kind === k).length;
      if (k === "exchange") expect(n, k).toBeGreaterThanOrEqual(1);
      else expect(n, k).toBe(1);
    }
    expect(feeds.filter((f) => f.kind === "search" && f.priority === 1).map((f) => f.id)).toEqual([]);
  });

  it("keeps §4.13's stated priorities and freshness, and the optional NVD read below priority 1", () => {
    expect(one("kev")).toMatchObject({ kind: "kev", priority: 1, fresh_days: 7 });
    expect(one("bleepingcomputer")).toMatchObject({ kind: "rss", priority: 1, fresh_days: 2 });
    expect(one("jpcert")).toMatchObject({ kind: "rss", priority: 1, fresh_days: 14 });
    expect(one("nvd").priority).toBeGreaterThan(1);
    for (const f of fetched) expect(f.fresh_days, f.id).toBeGreaterThanOrEqual(1);
  });

  it("fetches only https; raw.githubusercontent.com only for kev and cvelist (by script), and no other URL on a blocked host", () => {
    for (const f of fetched) {
      for (const u of [f.url, f.fallback_url].filter((x): x is string => x !== null)) {
        expect(u.startsWith("https://"), `${f.id}: ${u}`).toBe(true);
        const host = new URL(u).hostname;
        if (host === "raw.githubusercontent.com") expect(["kev", "cvelist"], `${f.id}: ${u}`).toContain(f.kind);
        else if (f.kind === "ghsa") expect(u).toBe("https://github.com/github/advisory-database.git");
        else expect(blockedReason(u, sourceTiers), `${f.id}: ${u}`).toBeNull();
      }
    }
  });

  it("source-tiers.json, regions.json and annotations.json hold no Verify note; vendors.json's are Appendix B.1's five domain and HQ checks", () => {
    for (const f of ["source-tiers.json", "regions.json", "annotations.json"]) expect(read(`config/${f}`), f).not.toMatch(/\bverify\b/i);
    const vendors = (json("config/vendors.json") as { vendors: { id: string; note: string | null }[] }).vendors;
    expect(vendors.filter((v) => /\bVerify\b/.test(v.note ?? "")).map((v) => v.id)).toEqual(["avtech", "digiever", "merit-lilin", "fxc", "sky"]);
  });

  it("names only gtig (unverified), the one feed path the cloud session could not confirm", () => {
    expect(feeds.filter((f) => /\(unverified\)/i.test(f.name)).map((f) => f.id)).toEqual(["gtig"]);
  });

  // TODO(Kobol session 1, build plan §5.1 K2 and K3): unskip once sources:check confirms gtig's feed path
  // (or the entry is replaced or dropped, ruling R49) and V15 settles the five vendor domains and HQs.
  it.skip("no registry name says (unverified) and no vendors.json note asks to Verify (after Kobol session 1)", () => {
    expect(feeds.filter((f) => /\(unverified\)/i.test(f.name)).map((f) => f.id)).toEqual([]);
    const vendors = (json("config/vendors.json") as { vendors: { id: string; note: string | null }[] }).vendors;
    expect(vendors.filter((v) => /\bVerify\b/.test(v.note ?? "")).map((v) => v.id)).toEqual([]);
  });
});

describe("sample mode and overrides (§4.11)", () => {
  const sample = ClaimsFile.parse(json(SAMPLE_CLAIMS_FILE));

  it("the sample claims are SB-01 and SB-02, marked SAMPLE", () => {
    expect(sample.claims.map((c) => [c.id, c.origin, c.judged_by, c.metric_path])).toEqual([
      ["SB-01", "rival", "script", "base_rate.ratio"],
      ["SB-02", "rival", "report", null],
    ]);
    for (const c of sample.claims) expect(c.text.startsWith("SAMPLE")).toBe(true);
    expect(sample.claims[0]!.support).toEqual({ kind: "value", op: "<=", value: 1, bound: "ci80_hi" });
    expect(sample.claims[0]!.challenge).toEqual({ kind: "value", op: ">=", value: 2, bound: "ci80_lo" });
    expect(sample.claims.map((c) => c.deadline)).toEqual(["2027-12-31", "2028-12-31"]);
  });

  it("reads fixtures/config/claims.json when the content folder is under fixtures/", () => {
    vi.stubEnv("CT_CONTENT_DIR", "fixtures/site-content");
    const c = loadConfig({ root, fresh: true });
    expect(c.sampleClaims).toBe(true);
    expect(c.paths.claims).toBe(SAMPLE_CLAIMS_FILE);
    expect(c.claims).toEqual(sample);
    expect(validateConfig(c)).toEqual([]);
    vi.stubEnv("CT_CONTENT_DIR", "fixtures/empty-content/");
    expect(loadConfig({ root, fresh: true }).claims.claims).toHaveLength(2);
  });

  it("reads config/claims.json everywhere else", () => {
    for (const dir of ["content", "logs/dry-run/tree", "fixtures", path.join(os.tmpdir(), "site-content-copy")]) {
      vi.stubEnv("CT_CONTENT_DIR", dir);
      const c = loadConfig({ root, fresh: true });
      expect(c.sampleClaims, dir).toBe(false);
      expect(c.claims.claims, dir).toEqual([]);
    }
  });

  it("overrides replace one file's contents, parsed with its schema", () => {
    const c = loadConfig({ root, overrides: { claims: json(SAMPLE_CLAIMS_FILE) } });
    expect(c.paths.claims).toBe("override");
    expect(c.claims).toEqual(sample);
    expect(c.sampleClaims).toBe(false);
    expect(c.vendors.vendors).toHaveLength(213);
    expect(validateConfig(c)).toEqual([]);
    expect(() => loadConfig({ root, overrides: { claims: { schema_version: 1, version: 0 } } })).toThrow(ConfigError);
    expect(() => loadConfig({ root, overrides: { nope: {} } as never })).toThrow(/unknown override/);
  });

  it("caches per root and claims file unless fresh or overridden", () => {
    const a = loadConfig({ root });
    expect(loadConfig({ root })).toBe(a);
    expect(loadConfig({ root, fresh: true })).not.toBe(a);
    vi.stubEnv("CT_CONTENT_DIR", "fixtures/site-content");
    expect(loadConfig({ root }).sampleClaims).toBe(true);
  });
});

describe("broken copies (CONFIG_SCHEMA, CONFIG_DUP, CONFIG_REF, CONFIG_REGEX)", () => {
  // One or more broken copies of every config file; each fails with exactly the code named.
  const cases: { name: string; code: string; overrides: () => Partial<Record<ConfigKey, unknown>> }[] = [
    { name: "run.json: wrong time zone", code: "CONFIG_SCHEMA", overrides: () => { const r = copyOf("run"); (r.schedule as { timezone: string }).timezone = "UTC"; return { run: r }; } },
    { name: "run.json: release for an unknown vendor", code: "CONFIG_REF", overrides: () => { const r = copyOf("run"); r.releases[0]!.vendor_id = "no-such-vendor"; return { run: r }; } },
    { name: "sources.yaml: must_match left out", code: "CONFIG_SCHEMA", overrides: () => {
      const s = copyOf("sources");
      const rss = s.feeds.find((f) => f.kind === "rss")! as Record<string, unknown>;
      delete rss.must_match;
      return { sources: s };
    } },
    { name: "sources.yaml: two feeds share an id", code: "CONFIG_DUP", overrides: () => { const s = copyOf("sources"); s.feeds[1]!.id = s.feeds[0]!.id; return { sources: s }; } },
    { name: "source-tiers.json: tier 4", code: "CONFIG_SCHEMA", overrides: () => { const s = copyOf("sourceTiers"); (s.publishers[0] as { tier: number }).tier = 4; return { sourceTiers: s }; } },
    { name: "source-tiers.json: two publishers share a domain", code: "CONFIG_DUP", overrides: () => {
      const s = copyOf("sourceTiers");
      s.publishers.find((p) => p.id === "reuters")!.domains.push("apnews.com");
      return { sourceTiers: s };
    } },
    { name: "source-tiers.json: a tier1_paths regex that does not compile", code: "CONFIG_REGEX", overrides: () => { const s = copyOf("sourceTiers"); s.github.tier1_paths.push("^/advisories/(GHSA"); return { sourceTiers: s }; } },
    { name: "vendors.json: a key left out", code: "CONFIG_SCHEMA", overrides: () => { const v = copyOf("vendors"); delete (v.vendors[0] as Partial<(typeof v.vendors)[0]>).note; return { vendors: v }; } },
    { name: "vendors.json: an alias that normalises to another vendor's name", code: "CONFIG_DUP", overrides: () => {
      const v = copyOf("vendors");
      v.vendors.find((x) => x.id === "qnap")!.aliases.push("Synology Inc.");
      return { vendors: v };
    } },
    { name: "vendors.json: two vendors list one CNA", code: "CONFIG_DUP", overrides: () => { const v = copyOf("vendors"); v.vendors.find((x) => x.id === "acer")!.cna.push("qnap"); return { vendors: v }; } },
    { name: "vendors.json: two vendors share a domain", code: "CONFIG_DUP", overrides: () => { const v = copyOf("vendors"); v.vendors.find((x) => x.id === "acer")!.domains.push("asus.com"); return { vendors: v }; } },
    { name: "ai-finders.json: an unknown family", code: "CONFIG_SCHEMA", overrides: () => { const a = copyOf("aiFinders"); (a.finders[0] as { family: string }).family = "meta"; return { aiFinders: a }; } },
    { name: "ai-finders.json: a pattern that does not compile", code: "CONFIG_REGEX", overrides: () => { const a = copyOf("aiFinders"); a.finders[0]!.patterns.push("\\bClaude("); return { aiFinders: a }; } },
    { name: "ai-finders.json: a match example that matches nothing", code: "CONFIG_REGEX", overrides: () => { const a = copyOf("aiFinders"); a.finders[6]!.examples.match.push("Jane Roe"); return { aiFinders: a }; } },
    { name: "ai-finders.json: a match example another finder takes first", code: "CONFIG_REGEX", overrides: () => {
      const a = copyOf("aiFinders");
      a.finders.at(-1)!.examples.match.push("Claude, an AI agent");
      return { aiFinders: a };
    } },
    { name: "ai-finders.json: a no_match example that matches", code: "CONFIG_REGEX", overrides: () => { const a = copyOf("aiFinders"); a.finders[0]!.examples.no_match.push("Claude (Anthropic)"); return { aiFinders: a }; } },
    { name: "ai-finders.json: two finders share an id", code: "CONFIG_DUP", overrides: () => { const a = copyOf("aiFinders"); a.finders[1]!.id = a.finders[0]!.id; return { aiFinders: a }; } },
    { name: "regions.json: a home rule above elevated", code: "CONFIG_SCHEMA", overrides: () => {
      const r = copyOf("regions");
      r.rules.find((x) => x.type === "home_vendor_kev")!.level = "high";
      return { regions: r };
    } },
    { name: "regions.json: a param the rule type does not read", code: "CONFIG_SCHEMA", overrides: () => {
      const r = copyOf("regions");
      r.rules.find((x) => x.type === "campaign_target")!.params.min_severity = "high";
      return { regions: r };
    } },
    { name: "regions.json: a param the rule type reads left null", code: "CONFIG_SCHEMA", overrides: () => {
      const r = copyOf("regions");
      r.rules.find((x) => x.type === "home_vendor_kev")!.params.max_lag_days = null;
      return { regions: r };
    } },
    { name: "regions.json: lookback not a whole number of days", code: "CONFIG_SCHEMA", overrides: () => { const r = copyOf("regions"); r.rules[0]!.params.lookback_hours = 36; return { regions: r }; } },
    { name: "regions.json: an agency that is not a publisher", code: "CONFIG_REF", overrides: () => { const r = copyOf("regions"); r.regions[2]!.agencies.push("no-such-agency"); return { regions: r }; } },
    { name: "regions.json: an alert pattern that does not compile", code: "CONFIG_REGEX", overrides: () => { const r = copyOf("regions"); r.regions[0]!.alert_patterns.push("cisa\\.gov/[a-z"); return { regions: r }; } },
    { name: "annotations.json: a policy marker without a source", code: "CONFIG_SCHEMA", overrides: () => { const a = copyOf("annotations"); a.annotations[1]!.source_url = null; return { annotations: a }; } },
    { name: "annotations.json: two markers share an id", code: "CONFIG_DUP", overrides: () => { const a = copyOf("annotations"); a.annotations[2]!.id = a.annotations[0]!.id; return { annotations: a }; } },
    { name: "actors.json: a bad MITRE id", code: "CONFIG_SCHEMA", overrides: () => { const a = copyOf("actors"); a.actors[0]!.mitre_id = "X1017"; return { actors: a }; } },
    { name: "actors.json: one alias on two actors", code: "CONFIG_DUP", overrides: () => {
      const a = copyOf("actors");
      const apt29 = a.actors.find((x) => x.id === "apt29")!;
      apt29.aliases.push({ name: "fancy bear", by: "SAMPLE", source_url: "https://attack.mitre.org/groups/G0016/" });
      return { actors: a };
    } },
    { name: "watch-windows.json: end before start", code: "CONFIG_SCHEMA", overrides: () => ({ watchWindows: { schema_version: 1, windows: [window("w-sample", "2026-11-10", "2026-11-09")] } }) },
    { name: "watch-windows.json: two windows share an id", code: "CONFIG_DUP", overrides: () => ({
      watchWindows: { schema_version: 1, windows: [window("w-sample", "2026-11-08", "2026-11-09"), window("w-sample", "2026-11-10", "2026-11-11")] },
    }) },
    // An unknown lens row or claim metric path fails the schema's enum (TaiwanLensRowId, ClaimMetricPath), not CONFIG_REF.
    { name: "watch-windows.json: an unknown lens row", code: "CONFIG_SCHEMA", overrides: () => ({
      watchWindows: { schema_version: 1, windows: [{ ...window("w-sample", "2026-11-08", "2026-11-09"), lens_row: "no-such-row" }] },
    }) },
    { name: "standing-stories.json: an unknown actor", code: "CONFIG_REF", overrides: () => { const s = copyOf("standingStories"); s.stories[0]!.actors.push("no-such-actor"); return { standingStories: s }; } },
    { name: "standing-stories.json: a summary over 40 words", code: "CONFIG_SCHEMA", overrides: () => {
      const s = copyOf("standingStories");
      s.stories[0]!.summary = Array.from({ length: 41 }, () => "word").join(" ");
      return { standingStories: s };
    } },
    { name: "claims.json: a report claim with a metric path", code: "CONFIG_SCHEMA", overrides: () => {
      const c = ClaimsFile.parse(json(SAMPLE_CLAIMS_FILE));
      (c.claims[1] as { metric_path: string | null }).metric_path = "base_rate.ratio";
      return { claims: c };
    } },
    { name: "claims.json: an unknown metric path", code: "CONFIG_SCHEMA", overrides: () => {
      const c = ClaimsFile.parse(json(SAMPLE_CLAIMS_FILE));
      (c.claims[0] as { metric_path: string | null }).metric_path = "no.such.path";
      return { claims: c };
    } },
    { name: "claims.json: an interval bound on a metric without one", code: "CONFIG_REF", overrides: () => {
      const c = ClaimsFile.parse(json(SAMPLE_CLAIMS_FILE));
      c.claims[0]!.metric_path = "flood.yoy_pct";
      return { claims: c };
    } },
    { name: "claims.json: a script claim with an event threshold", code: "CONFIG_REF", overrides: () => {
      const c = ClaimsFile.parse(json(SAMPLE_CLAIMS_FILE));
      c.claims[0]!.challenge = { kind: "event", text: "SAMPLE event" };
      return { claims: c };
    } },
    { name: "claims.json: two claims share an id", code: "CONFIG_DUP", overrides: () => {
      const c = ClaimsFile.parse(json(SAMPLE_CLAIMS_FILE));
      c.claims[1]!.id = "SB-01";
      return { claims: c };
    } },
  ];

  function window(id: string, start: string, end: string) {
    return { id, title: "SAMPLE window", start, end, regions: ["TW"], lens_row: "influence_ops", search_terms: ["SAMPLE"], note: null };
  }

  for (const c of cases) {
    it(`${c.name}: ${c.code}`, () => {
      expect(codesFor(c.overrides())).toEqual([c.code]);
    });
  }

  it("covers every config file and every code", () => {
    const files = new Set(cases.map((c) => c.name.split(":")[0]));
    expect([...files].sort()).toEqual(Object.values(CONFIG_FILES).sort());
    expect(new Set(cases.map((c) => c.code))).toEqual(new Set(["CONFIG_SCHEMA", "CONFIG_DUP", "CONFIG_REF", "CONFIG_REGEX"]));
  });

  describe("on disk", () => {
    let tmp = "";
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-config-"));
      fs.cpSync(path.join(root, CONFIG_DIR), path.join(tmp, CONFIG_DIR), { recursive: true });
    });
    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });
    const issuesFor = (dir: string) => {
      try {
        loadConfig({ root: dir, fresh: true });
        return [];
      } catch (e) {
        if (e instanceof ConfigError) return e.issues;
        throw e;
      }
    };

    it("a clean copy loads", () => {
      expect(validateConfig(loadConfig({ root: tmp, fresh: true }))).toEqual([]);
    });

    it("a missing file, bad JSON and bad YAML are CONFIG_SCHEMA, naming the file", () => {
      fs.rmSync(path.join(tmp, "config/standing-stories.json"));
      fs.writeFileSync(path.join(tmp, "config/annotations.json"), "{");
      fs.writeFileSync(path.join(tmp, "config/sources.yaml"), "feeds: [\n");
      const issues = issuesFor(tmp);
      expect(issues.map((i) => [i.code, i.path])).toEqual([
        ["CONFIG_SCHEMA", "config/sources.yaml"],
        ["CONFIG_SCHEMA", "config/annotations.json"],
        ["CONFIG_SCHEMA", "config/standing-stories.json"],
      ]);
    });

    it("an unknown key is CONFIG_SCHEMA with its path", () => {
      const v = JSON.parse(fs.readFileSync(path.join(tmp, "config/vendors.json"), "utf8")) as { vendors: Record<string, unknown>[] };
      v.vendors[3]!.hq = "SAMPLE";
      fs.writeFileSync(path.join(tmp, "config/vendors.json"), JSON.stringify(v));
      expect(issuesFor(tmp).map((i) => [i.code, i.path])).toEqual([["CONFIG_SCHEMA", "config/vendors.json: vendors[3].hq"]]);
    });

    it("sample mode needs fixtures/config/claims.json under the root", () => {
      vi.stubEnv("CT_CONTENT_DIR", "fixtures/site-content");
      expect(issuesFor(tmp).map((i) => [i.code, i.path])).toEqual([["CONFIG_SCHEMA", SAMPLE_CLAIMS_FILE]]);
      fs.mkdirSync(path.join(tmp, "fixtures/config"), { recursive: true });
      fs.copyFileSync(path.join(root, SAMPLE_CLAIMS_FILE), path.join(tmp, SAMPLE_CLAIMS_FILE));
      expect(loadConfig({ root: tmp, fresh: true }).claims.claims).toHaveLength(2);
    });
  });
});

describe("lib/site.ts (§6, §9.7)", () => {
  it("names and URLs come from run.json", () => {
    expect(SITE_NAME).toBe("CyberTracker");
    expect(SITE_TAGLINE).toBe("The AI-era exploit and breach brief");
    expect(siteUrl()).toBe("https://cybertracker.vercel.app");
    expect(issueFormUrl()).toBe("https://github.com/8gara8/CyberTracker/issues/new?template=correction.yml");
    expect(issueFormUrl({ id: "cve-2026-104935", date: "2026-11-08" }))
      .toBe("https://github.com/8gara8/CyberTracker/issues/new?template=correction.yml&item_id=cve-2026-104935&edition_date=2026-11-08");
  });

  it("contentDir() is CT_CONTENT_DIR, else run.json paths.content_dir", () => {
    expect(contentDir()).toBe("content");
    vi.stubEnv("CT_CONTENT_DIR", "");
    expect(contentDir()).toBe("content");
    vi.stubEnv("CT_CONTENT_DIR", "logs/dry-run/tree");
    expect(contentDir()).toBe("logs/dry-run/tree");
  });

  it("isSampleData() is true only for a folder under fixtures/", () => {
    expect(isSampleData("fixtures/site-content", root)).toBe(true);
    expect(isSampleData("./fixtures/empty-content/", root)).toBe(true);
    expect(isSampleData(path.join(root, "fixtures/site-content"), root)).toBe(true);
    expect(isSampleData("fixtures", root)).toBe(false);
    expect(isSampleData("content", root)).toBe(false);
    expect(isSampleData("logs/dry-run/tree", root)).toBe(false);
    expect(isSampleData("fixtures-old/site-content", root)).toBe(false);
    expect(isSampleData(path.join(os.tmpdir(), "fixtures/site-content"), root)).toBe(false);
    vi.stubEnv("CT_CONTENT_DIR", "fixtures/site-content");
    expect(isSampleData()).toBe(true);
  });
});
