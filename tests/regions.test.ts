// lib/regions.ts (SPEC §5.11): every rule type with a firing and a non-firing case, an unjoined (lag null)
// home_vendor_kev signal that fires, the TW and JP caps, ties between equal levels, a raise, history and
// signal merging, reasons, collectSignals(), previewRegions(), and the Appendix D.6 replay of the
// home-vendor rule. The rules are the seed's (config/regions.json); vendors and publishers are small
// hand-built lists. No content/ and no network.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import {
  alertRegions, BASELINE_REASON, CERT_EXPLOITATION_RE, collectSignals, computeRegions, cutAtWord, EVALUATORS, givesRegionSignal, maxLookbackDays,
  previewRegions, publisherCount, recordSignals, regionItems, regionsPreviewRows, renderReason, stepUp, type HistoryBrief, type KevCatalogEntry, type RaiseInput,
  type RegionsConfig,
} from "@/lib/regions";
import {
  RegionSignal as RegionSignalSchema, Regions as RegionsSchema, RegionsFile, SourceTiersFile, VendorsFile, type DraftSource, type Item,
  type KevIndexRow, type Pack, type RegionSignal, type Regions, type Source,
} from "@/lib/schema";
import type { Brief } from "@/lib/schema/brief";
import { LEVELLED_REGIONS, REGION_RULE_TYPES, WITHHELD_MARK, type LevelledRegion, type RegionLevel } from "@/lib/vocab";
import { rewriteItem } from "@/lib/withhold-mask";
import { D6_JP, D6_TW } from "./helpers/d6";

const DATE = "2026-11-08";
const SEED_REGIONS = RegionsFile.parse(JSON.parse(fs.readFileSync(path.join(__dirname, "../config/regions.json"), "utf8")));

const pub = (id: string, name: string, tier: 1 | 2 | 3, kind: string, domains: string[]) =>
  ({ id, name, tier, kind, country: null, domains, state_label: null, sole_newsroom_for_critical: true });
const TIERS = SourceTiersFile.parse({
  schema_version: 1, version: 1, updated: "2026-11-07",
  publishers: [
    pub("cisa-kev", "CISA KEV catalog", 1, "government", ["cisa.gov/known-exploited-vulnerabilities-catalog"]),
    pub("cisa", "CISA", 1, "government", ["cisa.gov"]),
    pub("anssi", "ANSSI and CERT-FR", 1, "cert", ["cyber.gouv.fr", "ssi.gouv.fr"]),
    pub("jpcert", "JPCERT/CC", 1, "cert", ["jpcert.or.jp"]),
    pub("twcert", "TWCERT/CC", 1, "cert", ["twcert.org.tw"]),
    pub("reuters", "Reuters", 2, "newsroom", ["reuters.com"]),
    pub("bleepingcomputer", "BleepingComputer", 2, "newsroom", ["bleepingcomputer.com"]),
    pub("kyodo", "Kyodo News", 2, "newsroom", ["kyodonews.net"]),
  ],
  github: { tier1_paths: [] },
});

const vendor = (id: string, name: string, country: string, aliases: string[] = []) =>
  ({ id, name, country, widely_deployed: true, aliases, cna: [], domains: [], note: null });
const VENDORS = VendorsFile.parse({
  schema_version: 1, version: 1, updated: "2026-11-07",
  vendors: [
    vendor("zyxel", "Zyxel", "TW"), vendor("asus", "ASUS", "TW"), vendor("edimax", "Edimax", "TW"), vendor("geovision", "GeoVision", "TW"),
    vendor("draytek", "DrayTek", "TW"), vendor("d-link", "D-Link", "TW"), vendor("digiever", "Digiever", "TW"), vendor("teamt5", "TeamT5", "TW"),
    vendor("hitachi", "Hitachi", "JP", ["Hitachi Vantara"]), vendor("trend-micro", "Trend Micro", "JP"), vendor("skysea", "SKYSEA", "JP"),
    vendor("motex", "Motex", "JP"), vendor("soliton", "Soliton Systems", "JP"), vendor("microsoft", "Microsoft", "US"),
  ],
});

const CONFIG: RegionsConfig = { regions: SEED_REGIONS, vendors: VENDORS, tiers: TIERS };

// ── Builders ─────────────────────────────────────────────────────────────────────────────────────

function src(id: string, url: string, publisher: string, tier: 1 | 2 | 3, title = `Report ${id} on the event`, published_at: string | null = null): Source {
  return {
    id, title, title_en: null, language: "en", outlet: publisher, url, source_type: tier === 2 ? "press" : "government", published_at,
    publisher, publisher_name: publisher, tier, state_label: null, seen_as: "pack",
  };
}

type Incident = NonNullable<Item["incident"]>;
function incident(p: Partial<Incident> = {}): Incident {
  return {
    victim: null, description: "a power company", sector: "energy", country: "DE", impact: "Services down", disruption: false,
    status: "confirmed", claimed_by: null, status_source_ids: ["s1"], ...p,
  };
}

function item(p: Partial<Item> & { id: string }): Item {
  return {
    kind: "breach", headline: `Headline for ${p.id}`, summary: "Summary.", why_it_matters: null, severity: "high", landmark: false,
    ai_role: "none", ai_role_secondary: null, ai_confidence: null, ai_claimant: null, ai_evidence: [], claim_type: "independent",
    regions: ["GLOBAL"], topics: [], attribution: [], actor_nexus: null, incident: null, cve_ids: [], release_id: null, flaw_evidence: [],
    exploit_reported_in_sources: null, exposure: null, standing_story: null, source_ids: ["s1"], first_seen: DATE, vendor: null, cves: [],
    release: null, public_exploit: null, anthropic_disclosure: false, withheld: null, ...p,
  };
}

const REUTERS = src("s1", "https://www.reuters.com/world/grid-operator-hit", "reuters", 2, "Grid operator hit by cyberattack");
const BLEEPING = src("s2", "https://www.bleepingcomputer.com/news/utility-outage", "bleepingcomputer", 2, "Utility confirms outage after ransomware attack");

function sig(id: string, type: RegionSignal["type"], region: LevelledRegion, date: string, extra: Partial<RegionSignal> = {}): RegionSignal {
  const cve = extra.cve_ids?.[0];
  return {
    id, type, region, date, publisher: type === "home_vendor_kev" ? "cisa-kev" : region === "JP" ? "jpcert" : region === "TW" ? "twcert" : "cisa",
    url: cve ? `https://www.cve.org/CVERecord?id=${cve}` : `https://example.org/${id}`, title: `Notice ${id}`, cve_ids: [], ...extra,
  };
}

const kevRow = (cve: string, added: string, vendorProject: string, lag: number | null): KevIndexRow =>
  [cve, added, vendorProject, "Product", lag === null ? null : addDays(added, -lag), "mitre", "unknown"];

function regionsWith(levels: Partial<Record<LevelledRegion, RegionLevel>>, signals: RegionSignal[] = []): Regions {
  return {
    rows: LEVELLED_REGIONS.map((code) => ({
      code, level: levels[code] ?? "baseline", computed_level: levels[code] ?? "baseline", previous_level: null, change: "new" as const,
      rule_id: null, reason: BASELINE_REASON, item_ids: [], fired: [], raised: null,
    })),
    global: { item_count: 0 },
    signals,
  };
}

function brief(date: string, items: Item[], sources: Source[], regions: Regions = regionsWith({})): HistoryBrief {
  return { date, items, sources, regions };
}

interface RunOpts {
  items?: Item[];
  sources?: (Source | DraftSource)[];
  signals?: RegionSignal[];
  history?: HistoryBrief[];
  kev?: KevIndexRow[];
  raises?: RaiseInput[];
  date?: string;
  config?: RegionsConfig;
}

/** computeRegions() on the inputs; the result must parse with the Brief's Regions schema. */
function run(o: RunOpts): Regions {
  const config = o.config ?? CONFIG;
  const out = computeRegions({
    date: o.date ?? DATE,
    items: regionItems(o.items ?? [], o.sources ?? [REUTERS, BLEEPING], config),
    history: o.history ?? [],
    signals: o.signals ?? [],
    kevIndex: { entries: o.kev ?? [] },
    config,
    raises: o.raises ?? [],
  });
  expect(RegionsSchema.parse(out)).toEqual(out);
  return out;
}

const row = (r: Regions, code: LevelledRegion) => r.rows.find((x) => x.code === code)!;
const firedIds = (r: Regions, code: LevelledRegion) => row(r, code).fired.map((f) => f.rule_id);

// ── Basics ───────────────────────────────────────────────────────────────────────────────────────

describe("rules engine basics", () => {
  it("has an evaluator for every rule type, and the seed's longest lookback is 7 days", () => {
    expect(Object.keys(EVALUATORS).sort()).toEqual([...REGION_RULE_TYPES].sort());
    expect(maxLookbackDays(SEED_REGIONS)).toBe(7);
    expect(stepUp("baseline")).toBe("elevated");
    expect(stepUp("critical")).toBe("critical");
  });

  it("gives four baseline rows with the baseline reason when nothing fires", () => {
    const r = run({});
    expect(r.rows.map((x) => x.code)).toEqual(["US", "EU", "TW", "JP"]);
    for (const x of r.rows) expect(x).toMatchObject({ level: "baseline", computed_level: "baseline", rule_id: null, reason: BASELINE_REASON, item_ids: [], fired: [], change: "new" });
    expect(r.global.item_count).toBe(0);
  });

  it("counts today's GLOBAL items only", () => {
    const r = run({ items: [item({ id: "inc-a", regions: ["US", "GLOBAL"] }), item({ id: "inc-b", regions: ["EU"] })] });
    expect(r.global.item_count).toBe(1);
  });
});

// ── Each rule type ───────────────────────────────────────────────────────────────────────────────

describe("confirmed_disruption (cni-disruption, critical, 72 h)", () => {
  const disrupted = (p: Partial<Item> = {}, inc: Partial<Incident> = {}) =>
    item({ id: "inc-grid", severity: "critical", regions: ["EU"], source_ids: ["s1", "s2"], incident: incident({ disruption: true, ...inc }), ...p });

  it("fires on a confirmed disruption of a CNI sector in the region with two publishers", () => {
    const r = run({ items: [disrupted()] });
    expect(row(r, "EU")).toMatchObject({ level: "critical", rule_id: "cni-disruption", item_ids: ["inc-grid"], reason: "Confirmed disruption of energy in Germany: Headline for inc-grid" });
    expect(firedIds(r, "EU")).toEqual(["cni-disruption", "high-breach", "serious-victim"]);
    expect(row(r, "US").level).toBe("baseline");
  });

  it("does not fire with one publisher once syndicated copies fold, outside CNI, or past 72 hours", () => {
    const copy = src("s2", "https://www.bleepingcomputer.com/news/copy", "bleepingcomputer", 2, "Grid operator hit by cyberattack");
    expect(publisherCount(regionItems([disrupted()], [REUTERS, copy], CONFIG)[0]!)).toBe(1);
    expect(firedIds(run({ items: [disrupted()], sources: [REUTERS, copy] }), "EU")).not.toContain("cni-disruption");
    expect(firedIds(run({ items: [disrupted({}, { sector: "retail" })] }), "EU")).not.toContain("cni-disruption");
    expect(firedIds(run({ items: [disrupted({ first_seen: addDays(DATE, -3) })] }), "EU")).not.toContain("cni-disruption");
    expect(firedIds(run({ items: [disrupted({ first_seen: addDays(DATE, -2) })] }), "EU")).toContain("cni-disruption");
  });

  it("ignores tier 3 sources when counting publishers", () => {
    const blog = src("s2", "https://blog.example.com/post", "host:blog.example.com", 3, "A blog post about the grid");
    expect(firedIds(run({ items: [disrupted()], sources: [REUTERS, blog] }), "EU")).not.toContain("cni-disruption");
  });
});

describe("a withhold (§4.10) leaves every region level unchanged", () => {
  // rewriteItem() sets the title of each source only the item cites to WITHHELD_MARK; two such titles must
  // not fold as syndicated copies (publishersOfItem() in lib/rules/shared.ts already keeps them apart).
  const disrupted = (first_seen: string) => item({
    id: "inc-grid", kind: "breach", severity: "critical", regions: ["EU"], source_ids: ["s1", "s2"], first_seen,
    incident: incident({ disruption: true, victim: "Sample Grid Operator" }),
  });
  /** The stored brief a withhold rewrites: just the parts rewriteItem() reads. */
  const stored = (date: string): Brief => ({
    date, items: [disrupted(date)], sources: [structuredClone(REUTERS), structuredClone(BLEEPING)], regions: regionsWith({}),
    lead: [], elsewhere: [], angle: null, week_in_review: null,
    taiwan_lens: { analysis: "", item_ids: [], source_ids: [], rows: [], japan: { text: null, item_ids: [], source_ids: [] } },
  }) as unknown as Brief;
  const levels = (r: Regions) => r.rows.map((x) => [x.code, x.level, x.rule_id]);

  it("counts two publishers whose titles a withhold set to WITHHELD_MARK as two; one publisher still folds", () => {
    const masked = [{ ...REUTERS, title: WITHHELD_MARK }, { ...BLEEPING, title: WITHHELD_MARK }];
    expect(publisherCount(regionItems([disrupted(DATE)], masked, CONFIG)[0]!)).toBe(2);
    const same = [masked[0]!, { ...masked[0]!, id: "s2", url: "https://www.reuters.com/world/grid-operator-hit-update" }];
    expect(publisherCount(regionItems([disrupted(DATE)], same, CONFIG)[0]!)).toBe(1);
  });

  it("gives the same levels from today's items and from history, before and after a victim or attribution withhold", () => {
    for (const kind of ["victim", "attribution"] as const) {
      const today = stored(DATE);
      const before = run({ items: today.items, sources: today.sources });
      expect(row(before, "EU")).toMatchObject({ level: "critical", rule_id: "cni-disruption" });
      rewriteItem(today, today.items[0]!, { kind, since: DATE }, "C-0001");
      expect(today.sources.map((x) => x.title)).toEqual([WITHHELD_MARK, WITHHELD_MARK]);
      expect(levels(run({ items: today.items, sources: today.sources }))).toEqual(levels(before));

      const past = stored(addDays(DATE, -1));
      const hBefore = run({ history: [brief(past.date, structuredClone(past.items), structuredClone(past.sources))] });
      expect(row(hBefore, "EU").level).toBe("critical");
      rewriteItem(past, past.items[0]!, { kind, since: DATE }, "C-0001");
      expect(levels(run({ history: [brief(past.date, past.items, past.sources)] }))).toEqual(levels(hBefore));
    }
  });
});

describe("agency_alert (agency-alert, high, 168 h)", () => {
  it("fires on an agency_alert signal for the region within 7 days", () => {
    const r = run({ signals: [sig("sig-20261101-1", "agency_alert", "US", "2026-11-01", { title: "Emergency Directive 26-03" })] });
    expect(row(r, "US")).toMatchObject({ level: "high", rule_id: "agency-alert", reason: "CISA emergency alert: Emergency Directive 26-03" });
    expect(row(r, "US").fired[0]!.signal_ids).toEqual(["sig-20261101-1"]);
    expect(run({ signals: [sig("sig-20261031-1", "agency_alert", "US", "2026-10-31")] }).rows[0]!.level).toBe("baseline");
  });

  it("fires on an item citing an agency page that matches the region's alert pattern", () => {
    const alert = src("s1", "https://cert.ssi.gouv.fr/alerte/CERTFR-2026-ALE-012/", "anssi", 1, "Multiple flaws in a VPN appliance", "2026-11-07T10:00:00+01:00");
    const r = run({ items: [item({ id: "vuln-vpn", kind: "critical_flaw", severity: "elevated", regions: ["EU"] })], sources: [alert] });
    expect(row(r, "EU")).toMatchObject({ level: "high", rule_id: "agency-alert", item_ids: ["vuln-vpn"], reason: "ANSSI and CERT-FR emergency alert: Multiple flaws in a VPN appliance" });
  });

  it("does not fire on an ordinary advisory page or an old alert", () => {
    const avis = src("s1", "https://cert.ssi.gouv.fr/avis/CERTFR-2026-AVI-0999/", "anssi", 1, "Advisory", "2026-11-07T10:00:00+01:00");
    expect(row(run({ items: [item({ id: "vuln-vpn", kind: "critical_flaw", severity: "elevated", regions: ["EU"] })], sources: [avis] }), "EU").level).toBe("baseline");
    const old = src("s1", "https://cert.ssi.gouv.fr/alerte/CERTFR-2026-ALE-001/", "anssi", 1, "Old alert", "2026-10-20T10:00:00+01:00");
    expect(row(run({ items: [item({ id: "vuln-vpn", kind: "critical_flaw", severity: "elevated", regions: ["EU"] })], sources: [old] }), "EU").level).toBe("baseline");
  });

  it("resolves a draft source's publisher with publisherFor()", () => {
    const draft: DraftSource = {
      id: "s1", title: "JPCERT alert", title_en: null, language: "ja", outlet: "JPCERT/CC", url: "https://www.jpcert.or.jp/at/2026/at260031.html",
      source_type: "government", published_at: "2026-11-07",
    };
    const r = run({ items: [item({ id: "vuln-x", kind: "exploited_flaw", severity: "high", regions: ["JP"] })], sources: [draft] });
    expect(row(r, "JP")).toMatchObject({ level: "high", rule_id: "agency-alert" });
  });
});

describe("confirmed_breach (high-breach, high) and victim_in_region (serious-victim, elevated)", () => {
  it("high-breach fires on a confirmed High breach of a victim in the region", () => {
    const r = run({ items: [item({ id: "inc-jp", regions: ["JP"], incident: incident({ country: "JP", sector: "manufacturing" }) })] });
    expect(row(r, "JP")).toMatchObject({ level: "high", rule_id: "high-breach", reason: "Confirmed breach in Japan: Headline for inc-jp" });
    expect(row(run({ items: [item({ id: "sc-jp", kind: "supply_chain", incident: incident({ country: "JP" }) })] }), "JP").rule_id).toBe("high-breach");
  });

  it("a reported breach is not high-breach but is serious-victim", () => {
    const r = run({ items: [item({ id: "inc-jp", incident: incident({ country: "JP", status: "reported" }) })] });
    expect(row(r, "JP")).toMatchObject({ level: "elevated", rule_id: "serious-victim", reason: "Victim in Japan: Headline for inc-jp" });
  });

  it("serious-victim needs High or above, a listed status and a country in the region", () => {
    const victim = (p: Partial<Item>, inc: Partial<Incident> = {}) => item({ id: "inc-tw", kind: "campaign", ...p, incident: incident({ country: "TW", status: "reported", ...inc }) });
    expect(row(run({ items: [victim({ severity: "high" })] }), "TW").rule_id).toBe("serious-victim");
    expect(row(run({ items: [victim({ severity: "elevated" })] }), "TW").fired.map((f) => f.rule_id)).not.toContain("serious-victim");
    expect(row(run({ items: [victim({ kind: "policy", severity: null })] }), "TW").level).toBe("baseline");
    expect(row(run({ items: [victim({ kind: "policy", severity: "critical" }, { status: "claimed" })] }), "TW").level).toBe("baseline");
    expect(row(run({ items: [victim({ kind: "policy", severity: "critical" }, { country: null })] }), "TW").level).toBe("baseline");
  });
});

describe("campaign_target (campaign-target, elevated)", () => {
  it("fires for each region a campaign item names, at any severity", () => {
    const r = run({ items: [item({ id: "camp-x", kind: "campaign", severity: "watch", regions: ["TW", "JP"] })] });
    expect(row(r, "TW")).toMatchObject({ level: "elevated", rule_id: "campaign-target", reason: "Campaign naming the region: Headline for camp-x" });
    expect(row(r, "JP").rule_id).toBe("campaign-target");
    expect(row(r, "US").level).toBe("baseline");
  });

  it("does not fire for another kind", () => {
    expect(row(run({ items: [item({ id: "inc-tw", regions: ["TW"] })] }), "TW").level).toBe("baseline");
  });
});

describe("home_vendor_kev (home-vendor-kev, elevated, TW and JP)", () => {
  const cve = "CVE-2026-7273";
  const kevSig = sig("sig-20261108-1", "home_vendor_kev", "TW", "2026-11-05", { cve_ids: [cve], title: "Zyxel firmware flaw" });

  it("fires on a recent flaw (lag 97)", () => {
    const r = run({ signals: [kevSig], kev: [kevRow(cve, "2026-11-05", "Zyxel", 97)] });
    expect(row(r, "TW")).toMatchObject({ level: "elevated", rule_id: "home-vendor-kev", reason: "CISA listed a Zyxel flaw as exploited: CVE-2026-7273" });
  });

  it("does not fire on an old flaw (lag over 365) with no CERT report", () => {
    expect(row(run({ signals: [kevSig], kev: [kevRow(cve, "2026-11-05", "Zyxel", 400)] }), "TW").level).toBe("baseline");
  });

  it("fires on an unjoined flaw: lag null, or not in the index yet", () => {
    expect(row(run({ signals: [kevSig], kev: [kevRow(cve, "2026-11-05", "Zyxel", null)] }), "TW").rule_id).toBe("home-vendor-kev");
    const r = run({ signals: [kevSig], kev: [] });
    expect(row(r, "TW").rule_id).toBe("home-vendor-kev");
    expect(row(r, "TW").reason).toBe("CISA listed a Taiwanese vendor flaw as exploited: CVE-2026-7273"); // not in the index: no vendor name
  });

  it("fires on an old flaw a national CERT of the region reports exploited", () => {
    const certSig = sig("sig-20261108-2", "cert_exploitation", "TW", "2026-11-06", { cve_ids: [cve] });
    const r = run({ signals: [kevSig, certSig], kev: [kevRow(cve, "2026-11-05", "Zyxel", 400)] });
    expect(row(r, "TW").fired).toEqual([
      { rule_id: "home-vendor-kev", level: "elevated", item_ids: [], signal_ids: ["sig-20261108-1", "sig-20261108-2"] },
      { rule_id: "home-cert-exploitation", level: "elevated", item_ids: [], signal_ids: ["sig-20261108-2"] },
    ]);
    const twcert = src("s1", "https://www.twcert.org.tw/tw/cp-132-1.html", "twcert", 1, "TWCERT notice");
    const viaItem = run({
      signals: [kevSig], kev: [kevRow(cve, "2026-11-05", "Zyxel", 400)], sources: [twcert],
      items: [item({ id: "cve-2026-7273", kind: "exploited_flaw", regions: ["TW"], cve_ids: [cve], flaw_evidence: [{ cve_id: cve, kind: "exploited", basis: "cert_confirmed", date: "2026-11-06", source_id: "s1" }] })],
    });
    expect(row(viaItem, "TW").fired.map((f) => f.rule_id)).toEqual(["home-vendor-kev", "home-cert-exploitation"]);
    expect(row(viaItem, "TW").item_ids).toEqual(["cve-2026-7273"]);
  });
});

describe("national_cert_exploitation (home-cert-exploitation, elevated)", () => {
  const jpcert = src("s1", "https://www.jpcert.or.jp/newsflash/2026110701.html", "jpcert", 1, "Notice on an exploited flaw");
  const flawItem = (basis: "cert_confirmed" | "vendor_confirmed", regions: Item["regions"] = ["JP"]) => item({
    id: "cve-2026-50001", kind: "exploited_flaw", regions, cve_ids: ["CVE-2026-50001"],
    flaw_evidence: [{ cve_id: "CVE-2026-50001", kind: "exploited", basis, date: "2026-11-07", source_id: "s1" }],
  });

  it("fires on a cert_exploitation signal", () => {
    const r = run({ signals: [sig("sig-20261108-3", "cert_exploitation", "JP", "2026-11-07", { title: "Actively exploited flaw" })] });
    expect(row(r, "JP")).toMatchObject({ level: "elevated", rule_id: "home-cert-exploitation", reason: "JPCERT/CC reports exploitation at home: Actively exploited flaw" });
  });

  it("fires on an item with CERT-confirmed exploitation from the region's CERT", () => {
    expect(row(run({ items: [flawItem("cert_confirmed")], sources: [jpcert] }), "JP")).toMatchObject({
      rule_id: "home-cert-exploitation", item_ids: ["cve-2026-50001"], reason: "JPCERT/CC reports exploitation at home: Notice on an exploited flaw",
    });
  });

  it("does not fire on vendor confirmation, another publisher or an item outside the region", () => {
    expect(row(run({ items: [flawItem("vendor_confirmed")], sources: [jpcert] }), "JP").level).toBe("baseline");
    expect(row(run({ items: [flawItem("cert_confirmed")], sources: [{ ...jpcert, publisher: "kyodo", tier: 2 }] }), "JP").level).toBe("baseline");
    expect(row(run({ items: [flawItem("cert_confirmed", ["GLOBAL"])], sources: [jpcert] }), "JP").level).toBe("baseline");
  });
});

// ── Ordering, caps, raises, history ──────────────────────────────────────────────────────────────

describe("levels: caps, ties and raises", () => {
  it("keeps TW and JP at Elevated however many home rules fire", () => {
    const signals = [
      sig("sig-20261108-1", "home_vendor_kev", "TW", "2026-11-05", { cve_ids: ["CVE-2026-60001"] }),
      sig("sig-20261108-2", "home_vendor_kev", "TW", "2026-11-06", { cve_ids: ["CVE-2026-60002"] }),
      sig("sig-20261108-3", "cert_exploitation", "TW", "2026-11-07", { cve_ids: ["CVE-2026-60003"] }),
      sig("sig-20261108-4", "home_vendor_kev", "JP", "2026-11-07", { cve_ids: ["CVE-2026-60004"] }),
      sig("sig-20261108-5", "cert_exploitation", "JP", "2026-11-07", { cve_ids: ["CVE-2026-60004"] }),
    ];
    const r = run({ signals });
    expect(row(r, "TW")).toMatchObject({ level: "elevated", rule_id: "home-vendor-kev" });
    expect(row(r, "TW").fired.map((f) => f.rule_id)).toEqual(["home-vendor-kev", "home-cert-exploitation"]);
    expect(row(r, "JP").level).toBe("elevated");
    // The newest event gives the reason.
    expect(row(r, "TW").reason).toBe("CISA listed a Taiwanese vendor flaw as exploited: CVE-2026-60002");
  });

  it("breaks a tie between equal levels by file order", () => {
    const r = run({
      signals: [sig("sig-20261108-1", "agency_alert", "US", "2026-11-07")],
      items: [item({ id: "inc-us", regions: ["US"], incident: incident({ country: "US" }) })],
    });
    expect(row(r, "US").rule_id).toBe("agency-alert");
    expect(firedIds(r, "US")).toEqual(["agency-alert", "high-breach", "serious-victim"]);
    expect(row(r, "US").item_ids).toEqual([]); // the top rule's events only
  });

  it("raises one step, records the raise, and never raises past critical", () => {
    const camp = item({ id: "camp-tw", kind: "campaign", regions: ["TW"] });
    const raise: RaiseInput = { region: "TW", reason: "Several ministries reported intrusions", trigger_class: "confirmed_breach", item_ids: ["camp-tw"] };
    const r = run({ items: [camp], raises: [raise, { ...raise, reason: "second" }] });
    expect(row(r, "TW")).toMatchObject({
      level: "high", computed_level: "elevated", rule_id: "campaign-target",
      raised: { from: "elevated", to: "high", reason: "Several ministries reported intrusions", trigger_class: "confirmed_breach", item_ids: ["camp-tw"] },
    });
    expect(row(run({ raises: [{ ...raise, region: "US" }] }), "US")).toMatchObject({ level: "elevated", computed_level: "baseline" });
    const grid = item({ id: "inc-grid", severity: "critical", regions: ["EU"], source_ids: ["s1", "s2"], incident: incident({ disruption: true }) });
    expect(row(run({ items: [grid], raises: [{ ...raise, region: "EU" }] }), "EU")).toMatchObject({ level: "critical", raised: null });
  });
});

describe("history: previous level, merged items and signals", () => {
  it("compares the shown level with the brief dated the day before", () => {
    const yesterday = brief(addDays(DATE, -1), [], [], regionsWith({ US: "high", TW: "elevated" }));
    const r = run({ history: [yesterday], items: [item({ id: "camp-tw", kind: "campaign", regions: ["TW"] })], raises: [{ region: "TW", reason: "r", trigger_class: "campaign_target", item_ids: ["camp-tw"] }] });
    expect(row(r, "US")).toMatchObject({ previous_level: "high", change: "down" });
    expect(row(r, "TW")).toMatchObject({ previous_level: "elevated", level: "high", change: "up" });
    expect(row(r, "EU")).toMatchObject({ previous_level: "baseline", change: "same" });
    const older = brief(addDays(DATE, -2), [], [], regionsWith({ US: "high" }));
    expect(row(run({ history: [older] }), "US")).toMatchObject({ previous_level: null, change: "new" });
  });

  it("reads earlier editions' items, today's copy winning", () => {
    const old = item({ id: "camp-old", kind: "campaign", regions: ["JP"], first_seen: addDays(DATE, -3) });
    const reported = item({ id: "inc-jp", regions: ["JP"], first_seen: addDays(DATE, -1), incident: incident({ country: "JP", status: "reported" }) });
    const confirmed = { ...reported, incident: incident({ country: "JP", status: "confirmed" }) };
    const history = [brief(addDays(DATE, -1), [reported, old], [REUTERS])];
    const r = run({ history, items: [confirmed] });
    expect(row(r, "JP").rule_id).toBe("high-breach");
    expect(row(r, "JP").fired.find((f) => f.rule_id === "campaign-target")!.item_ids).toEqual(["camp-old"]);
    expect(r.global.item_count).toBe(0);
    const tooOld = item({ id: "camp-older", kind: "campaign", regions: ["US"], first_seen: addDays(DATE, -7) });
    expect(row(run({ history: [brief(addDays(DATE, -7), [tooOld], [REUTERS])] }), "US").level).toBe("baseline");
  });

  it("merges signals across editions, keeps the earliest id and drops those older than N_max", () => {
    const cve = "CVE-2026-7273";
    const today = sig("sig-20261108-1", "home_vendor_kev", "TW", "2026-11-05", { cve_ids: [cve] });
    const earlier = sig("sig-20261106-2", "home_vendor_kev", "TW", "2026-11-05", { cve_ids: [cve] });
    const stale = sig("sig-20261101-1", "agency_alert", "US", "2026-10-31");
    const r = run({ signals: [today], history: [brief("2026-11-06", [], [], regionsWith({}, [earlier])), brief("2026-11-01", [], [], regionsWith({}, [stale]))] });
    expect(r.signals.map((s) => s.id)).toEqual(["sig-20261106-2"]);
    expect(row(r, "TW").fired[0]!.signal_ids).toEqual(["sig-20261106-2"]);
  });
});

// ── Reasons ──────────────────────────────────────────────────────────────────────────────────────

describe("reasons", () => {
  it("cuts {headline} and {title} at a word boundary to 80 characters", () => {
    expect(cutAtWord("alpha beta gamma", 12)).toBe("alpha beta…");
    expect(cutAtWord("alpha beta gamma", 16)).toBe("alpha beta gamma");
    expect(cutAtWord("資安漏洞資安漏洞", 5)).toBe("資安漏洞…");
    const headline = "Attackers disrupted a regional electricity distributor's billing and dispatch systems for most of the weekend";
    const out = renderReason("Victim in {country}: {headline}", { country: "Germany", headline });
    expect(out).toBe("Victim in Germany: Attackers disrupted a regional electricity distributor's billing and dispatch…");
    expect(out.length).toBeLessThanOrEqual(160);
  });

  it("keeps the whole reason within 160 characters and leaves a missing placeholder empty", () => {
    const long = "word ".repeat(40).trim();
    const out = renderReason(`${"x".repeat(100)} {title} {headline}`, { title: long, headline: long });
    expect(out.length).toBeLessThanOrEqual(160);
    expect(renderReason("{publisher} emergency alert: {title}", { title: "T" })).toBe("emergency alert: T");
  });
});

// ── collectSignals and previewRegions ────────────────────────────────────────────────────────────

const PACK: Pick<Pack, "items" | "records"> = {
  items: [
    {
      id: "p0001", feed_id: "cisa-news", outlet: "CISA", publisher: "cisa", tier: 1, language: "en", region: "US", coverage: ["policy"],
      title: "ED 26-03: Mitigate a VPN appliance flaw", snippet: "Emergency directive.", url: "https://cisa.gov/news-events/directives/ed-26-03",
      published_at: "2026-11-07T15:00:00Z", cve_ids: [], alert: true, flags: [], score: 9,
    },
    {
      id: "p0002", feed_id: "cisa-news", outlet: "CISA", publisher: "cisa", tier: 1, language: "en", region: "US", coverage: ["exploits"],
      title: "Advisory on a ransomware group", snippet: "Joint advisory.", url: "https://cisa.gov/news-events/cybersecurity-advisories/aa26-300a",
      published_at: "2026-11-07T16:00:00Z", cve_ids: [], alert: false, flags: [], score: 5,
    },
    {
      id: "p0003", feed_id: "jpcert-at", outlet: "JPCERT/CC", publisher: "jpcert", tier: 1, language: "ja", region: "JP", coverage: ["japan"],
      title: "VPN 製品の脆弱性を悪用する攻撃に関する注意喚起", snippet: "注意喚起。悪用する攻撃が確認されています。", url: "https://jpcert.or.jp/at/2026/at260031.html",
      published_at: "2026-11-06T01:00:00Z", cve_ids: ["CVE-2026-60010"], alert: true, flags: [], score: 8,
    },
  ],
  records: [
    {
      id: "r0001", source: "jpcert", record_id: "JPCERT-2026-1107", url: "https://www.jpcert.or.jp/newsflash/2026110701.html", advisory_urls: [],
      title: "Flaw in a file server is being exploited", text: "The vendor and JPCERT/CC report it is actively exploited.", date: "2026-11-07",
      vendor: null, product: null, cve_ids: ["CVE-2026-60011"], facts: {}, flags: [],
    },
    {
      id: "r0002", source: "twcert-tvn", record_id: "TVN-202610001", url: "https://www.twcert.org.tw/tw/cp-132-0001-1.html", advisory_urls: [],
      title: "漏洞已被利用", text: "已被利用", date: "2026-10-20", vendor: null, product: null, cve_ids: [], facts: {}, flags: [],
    },
    {
      id: "r0003", source: "twcert-tvn", record_id: "TVN-202611002", url: "https://www.twcert.org.tw/tw/cp-132-0002-1.html", advisory_urls: [],
      title: "Router flaw", text: "Describes a flaw and its fix.", date: "2026-11-07", vendor: null, product: null, cve_ids: [], facts: {}, flags: [],
    },
  ],
};

const kev = (cveID: string, dateAdded: string, vendorProject: string): KevCatalogEntry =>
  ({ cveID, dateAdded, vendorProject, product: "Product", vulnerabilityName: `${vendorProject} Product Improper Input Validation Vulnerability` });
const CATALOG = {
  vulnerabilities: [
    kev("CVE-2026-60020", "2026-11-05", "Zyxel"), kev("CVE-2026-60021", "2026-11-02", "Trend Micro"),
    kev("CVE-2026-60022", "2026-11-06", "Microsoft"), kev("CVE-2026-60023", "2026-10-20", "Zyxel"),
  ],
};

describe("collectSignals", () => {
  it("collects agency alerts, home-vendor KEV additions and CERT exploitation notices, with ids in table order", () => {
    const s = collectSignals(PACK, CATALOG, null, CONFIG, DATE);
    for (const x of s) expect(RegionSignalSchema.parse(x)).toEqual(x);
    expect(s.map((x) => [x.id, x.type, x.region, x.date, x.publisher])).toEqual([
      ["sig-20261108-1", "agency_alert", "JP", "2026-11-06", "jpcert"],
      ["sig-20261108-2", "agency_alert", "US", "2026-11-07", "cisa"],
      ["sig-20261108-3", "home_vendor_kev", "JP", "2026-11-02", "cisa-kev"],
      ["sig-20261108-4", "home_vendor_kev", "TW", "2026-11-05", "cisa-kev"],
      ["sig-20261108-5", "cert_exploitation", "JP", "2026-11-06", "jpcert"],
      ["sig-20261108-6", "cert_exploitation", "JP", "2026-11-07", "jpcert"],
    ]);
    expect(s[3]).toMatchObject({ url: "https://www.cve.org/CVERecord?id=CVE-2026-60020", cve_ids: ["CVE-2026-60020"], title: "Zyxel Product Improper Input Validation Vulnerability" });
  });

  it("reads KEV from kev-index.json when the catalog is missing, and caps titles at 200 characters", () => {
    const s = collectSignals(null, null, { entries: [kevRow("CVE-2026-60030", "2026-11-07", "ASUS", 3)] }, CONFIG, DATE);
    expect(s).toEqual([{ id: "sig-20261108-1", type: "home_vendor_kev", region: "TW", date: "2026-11-07", publisher: "cisa-kev", url: "https://www.cve.org/CVERecord?id=CVE-2026-60030", title: "ASUS Product", cve_ids: ["CVE-2026-60030"] }]);
    const long = { vulnerabilities: [{ ...kev("CVE-2026-60031", "2026-11-07", "ASUS"), vulnerabilityName: "A".repeat(300) }] };
    expect(collectSignals(null, long, null, CONFIG, DATE)[0]!.title.length).toBeLessThanOrEqual(200);
  });

  it("alertRegions() needs both an agency publisher and an alert-pattern URL (ruling R36)", () => {
    expect(alertRegions("https://www.jpcert.or.jp/at/2026/at260031.html", "jpcert", CONFIG)).toEqual(["JP"]);
    expect(alertRegions("https://WWW.JPCERT.OR.JP/at/2026/at260031.html?utm_source=rss", "jpcert", CONFIG)).toEqual(["JP"]);
    expect(alertRegions("https://www.jpcert.or.jp/wr/2026/wr264101.html", "jpcert", CONFIG)).toEqual([]);
    expect(alertRegions("https://www.jpcert.or.jp/at/2026/at260031.html", "bleepingcomputer", CONFIG)).toEqual([]);
    expect(alertRegions("https://www.cert.ssi.gouv.fr/alerte/CERTFR-2026-ALE-012/", "anssi", CONFIG)).toEqual(["EU"]);
    expect(alertRegions("https://www.cert.ssi.gouv.fr/avis/CERTFR-2026-AVI-0812/", "anssi", CONFIG)).toEqual([]);
    expect(alertRegions("https://cisa.gov/news-events/directives/ed-26-03", "cisa", CONFIG)).toEqual(["US"]);
  });

  it("gives a JP agency_alert for a JPCERT /at/ record, and none for a newsroom item quoting the alert URL", () => {
    const alertUrl = "https://www.jpcert.or.jp/at/2026/at260031.html";
    const pack: Pick<Pack, "items" | "records"> = {
      items: [{
        id: "p0001", feed_id: "bleepingcomputer", outlet: "BleepingComputer", publisher: "bleepingcomputer", tier: 2, language: "en", region: "GLOBAL",
        coverage: ["exploits"], title: "JPCERT warns of VPN attacks", snippet: `The alert is at ${alertUrl} for readers.`,
        url: "https://www.bleepingcomputer.com/news/security/ct-sample-jpcert-warns/", published_at: "2026-11-07T02:00:00Z", cve_ids: [], alert: false,
        flags: [], score: 30,
      }],
      records: [{
        id: "r0001", source: "jpcert", record_id: "at260031", url: alertUrl, advisory_urls: [], title: "VPN 製品の脆弱性に関する注意喚起",
        text: "注意喚起", date: "2026-11-07", vendor: null, product: null, cve_ids: ["CVE-2026-60010"], facts: { alert: true }, flags: [],
      }],
    };
    const s = collectSignals(pack, null, null, CONFIG, DATE);
    expect(s.map((x) => [x.id, x.type, x.region, x.date, x.publisher, x.url])).toEqual([
      ["sig-20261108-1", "agency_alert", "JP", "2026-11-07", "jpcert", "https://jpcert.or.jp/at/2026/at260031.html"],
    ]);
    const r = previewRegions({ date: DATE, history: [], signals: s, kevIndex: { entries: [] }, config: CONFIG });
    expect(row(r, "JP")).toMatchObject({ level: "high", rule_id: "agency-alert" });
    // Without the record, the newsroom item alone raises nothing.
    expect(collectSignals({ items: pack.items, records: [] }, null, null, CONFIG, DATE)).toEqual([]);
  });

  it("recordSignals() is what collectSignals() builds from each record, and givesRegionSignal() says whether it builds any (review of row 146)", () => {
    const strip = (xs: readonly Omit<RegionSignal, "id">[]) => xs.map((x) => JSON.stringify({ ...x, id: undefined })).sort();
    const alertRecord = { ...PACK.records[0]!, id: "r0004", source: "jpcert" as const, record_id: "at260031", url: "https://www.jpcert.or.jp/at/2026/at260031.html", title: "注意喚起", text: "注意喚起" };
    const records = [...PACK.records, alertRecord];
    expect(strip(records.flatMap((r) => recordSignals(r, CONFIG, DATE)))).toEqual(strip(collectSignals({ items: [], records }, null, null, CONFIG, DATE)));
    for (const r of records) {
      expect(givesRegionSignal(r, CONFIG, DATE), r.id).toBe(collectSignals({ items: [], records: [r] }, null, null, CONFIG, DATE).length > 0);
    }
    // The JPCERT note reporting exploitation and the /at/ alert give one; the TVN note dated before the 7-day span and the one
    // reporting no exploitation give none.
    expect(records.map((r) => [r.id, givesRegionSignal(r, CONFIG, DATE)])).toEqual([["r0001", true], ["r0002", false], ["r0003", false], ["r0004", true]]);
    expect(recordSignals(alertRecord, CONFIG, DATE).map((x) => [x.type, x.region])).toEqual([["agency_alert", "JP"]]);
    expect(givesRegionSignal({ ...PACK.records[1]!, date: DATE }, CONFIG, DATE)).toBe(true);
    expect(givesRegionSignal({ ...PACK.records[1]!, date: addDays(DATE, 1) }, CONFIG, DATE)).toBe(false);
  });

  it("matches the CERT exploitation wording in English, Japanese and Chinese", () => {
    for (const t of [
      "exploited in the wild", "Actively Exploited", "is being exploited", "exploitation has been observed",
      "本脆弱性を悪用する攻撃が確認されています", "悪用が確認されています", "攻撃に悪用されていることを確認しています",
      "遭利用", "已被利用", "攻擊活動",
    ]) {
      expect(CERT_EXPLOITATION_RE.test(t), t).toBe(true);
    }
    expect(CERT_EXPLOITATION_RE.test("A flaw that could allow code execution")).toBe(false);
  });

  // V12 (Kobol, 2026-11-09): bare 悪用 matched JVNDB and JPCERT boilerplate that reports no exploitation.
  it("matches Japanese only when 悪用 or 攻撃 is confirmed in an affirmative form in the same sentence (C1)", () => {
    for (const t of [
      "悪用が確認されており、対策を急いでください", "本脆弱性を悪用した攻撃を確認しております",
      "攻撃が確認されました。", "ベンダーは悪用を確認しました", "悪用された事例が確認された。", "攻撃を確認した",
      "SAMPLE 注意喚起 本脆弱性を悪用する攻撃を確認しています。詳細は架空です。",
    ]) {
      expect(CERT_EXPLOITATION_RE.test(t), t).toBe(true);
    }
    for (const t of [
      // Bare words and the conditional boilerplate V12 found.
      "悪用", "攻撃", "攻撃が確認", "悪用を確認", "容易に悪用可能", "悪用が困難", "悪用された場合、任意のコードが実行される可能性があります",
      "悪用されると、情報が漏えいする可能性があります",
      // Negative and request forms.
      "現時点で悪用は確認されていません", "本脆弱性の悪用を確認していません", "悪用は確認されていない", "悪用の有無を確認してください",
      "現時点で本脆弱性を悪用した攻撃は確認されておりません", "当社では攻撃を確認しておりません",
      // Conditional forms of an affirmative ending.
      "悪用が確認された場合は直ちに連絡してください", "攻撃を確認したら報告してください", "攻撃の影響を確認した上で対策を実施してください",
      // An affirmative 確認 of a negated clause: no exploitation was found.
      "悪用されていないことを確認しています", "悪用の痕跡がないことを確認しました", "攻撃を受けていないことを確認した",
      "悪用された形跡が無いことを確認しました", "攻撃がなかったのを確認しました",
      // The first 確認 after the word decides; a later one in the sentence does not count.
      "悪用は確認されていませんが、修正版の公開を確認しました",
      // A sentence boundary ends the reach.
      "悪用に注意してください。修正版の公開を確認しました",
      // More than 40 characters between the word and 確認.
      `悪用${"あ".repeat(41)}確認されています`,
    ]) {
      expect(CERT_EXPLOITATION_RE.test(t), t).toBe(false);
    }
    expect(CERT_EXPLOITATION_RE.test(`悪用${"あ".repeat(40)}確認されています`)).toBe(true);

    // A JPCERT alert whose title only names attacks gives its agency_alert, and no cert_exploitation.
    const titleOnly = { items: [{ ...PACK.items[2]!, snippet: "注意喚起" }], records: [] };
    expect(collectSignals(titleOnly, null, null, CONFIG, DATE).map((x) => x.type)).toEqual(["agency_alert"]);
    const boilerplate = {
      items: [],
      records: [{ ...PACK.records[0]!, title: "SAMPLE 製品の脆弱性", text: "本脆弱性は容易に悪用可能です。悪用された場合、任意のコードが実行される可能性があります。" }],
    };
    expect(collectSignals(boilerplate, null, null, CONFIG, DATE)).toEqual([]);
  });
});

describe("previewRegions", () => {
  it("uses signals only and maps to the context's regions_preview", () => {
    const signals = collectSignals(PACK, CATALOG, null, CONFIG, DATE);
    const r = previewRegions({ date: DATE, history: [], signals, kevIndex: { entries: [kevRow("CVE-2026-60020", "2026-11-05", "Zyxel", 30)] }, config: CONFIG });
    expect(r.rows.map((x) => [x.code, x.level, x.rule_id])).toEqual([
      ["US", "high", "agency-alert"], ["EU", "baseline", null], ["TW", "elevated", "home-vendor-kev"], ["JP", "high", "agency-alert"],
    ]);
    expect(regionsPreviewRows(r)).toEqual([
      { region: "US", level: "high", fired_rule: "agency-alert", basis: "CISA emergency alert: ED 26-03: Mitigate a VPN appliance flaw" },
      { region: "EU", level: "baseline", fired_rule: null, basis: null },
      { region: "TW", level: "elevated", fired_rule: "home-vendor-kev", basis: "CISA listed a Zyxel flaw as exploited: CVE-2026-60020" },
      { region: "JP", level: "high", fired_rule: "agency-alert", basis: "JPCERT/CC emergency alert: VPN 製品の脆弱性を悪用する攻撃に関する注意喚起" },
    ]);
  });
});

// ── Appendix D.6: the home-vendor rule alone, replayed ───────────────────────────────────────────

describe("Appendix D.6 replay", () => {
  // KEV additions for Taiwanese and Japanese vendors, 2025-01-01 to 2026-11-06: date, vendor, lags in days
  // (tests/helpers/d6.ts, shared with the Appendix D check).
  const TW = D6_TW;
  const JP = D6_JP;
  const catalog: KevCatalogEntry[] = [];
  const index: KevIndexRow[] = [];
  let n = 0;
  for (const [date, vendorProject, lags] of [...TW, ...JP, ["2025-06-02", "Microsoft", [3]] as const]) {
    for (const lag of lags) {
      n += 1;
      const cve = `CVE-${date.slice(0, 4)}-${90000 + n}`;
      catalog.push(kev(cve, date, vendorProject));
      index.push(kevRow(cve, date, vendorProject, lag));
    }
  }

  function replay(maxLag: number) {
    const regions: RegionsFile = {
      ...SEED_REGIONS,
      rules: SEED_REGIONS.rules.filter((r) => r.id === "home-vendor-kev").map((r) => ({ ...r, params: { ...r.params, max_lag_days: maxLag } })),
    };
    const config: RegionsConfig = { ...CONFIG, regions };
    const count = { TW: 0, JP: 0, editions: 0, aboveElevated: 0 };
    for (let date = "2025-01-01"; date <= "2026-11-08"; date = addDays(date, 1)) {
      count.editions += 1;
      const seen = { vulnerabilities: catalog.filter((k) => k.dateAdded <= addDays(date, -1)) }; // KEV up to the day before
      const signals = collectSignals(null, seen, null, config, date);
      const r = computeRegions({ date, items: [], history: [], signals, kevIndex: { entries: index }, config, raises: [] });
      for (const code of ["TW", "JP"] as const) if (row(r, code).level === "elevated") count[code] += 1;
      count.aboveElevated += r.rows.filter((x) => x.level === "high" || x.level === "critical").length;
    }
    return count;
  }

  it("sets TW to Elevated on 47 editions and JP on 28, never higher", () => {
    expect(TW.reduce((s, [, , l]) => s + l.length, 0)).toBe(18); // 18 entries on 13 dates
    expect(JP.reduce((s, [, , l]) => s + l.length, 0)).toBe(7); // 7 entries on 6 dates
    expect(replay(365)).toEqual({ TW: 47, JP: 28, editions: 677, aboveElevated: 0 });
  });

  it("gives 89 and 42 without the 365-day limit (comparison only)", () => {
    expect(replay(100_000)).toEqual({ TW: 89, JP: 42, editions: 677, aboveElevated: 0 });
  });
});
