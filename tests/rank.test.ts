import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { releaseMember } from "../lib/rules/sources";
import type { CveRecordInfo } from "../lib/rules/types";
import { cveIdsIn, cvePackRecords, ghsaPackRecords, kevPackRecords, notePackRecords, packWindow, provisionalRecords, recordWindow } from "../lib/collect";
import { loadConfig, matchCredit, type LoadedConfig } from "../lib/config";
import { parseCveRecord } from "../lib/feeds/cvelist";
import { parseEpssCsv } from "../lib/feeds/epss";
import { parseGhsa } from "../lib/feeds/ghsa";
import { kevBaseline, parseKev } from "../lib/feeds/kev";
import type { CveRecord, EpssDay, GhsaAdvisory, KevCatalog, KevEntry } from "../lib/feeds/types";
import { parseDeltaZip } from "../lib/feeds/zip";
import { compareCveIds } from "../lib/ids";
import { activeWatchWindows, buildCandidates, RANK_WEIGHTS, rankCandidates, recordKeepIds, RELEASE_PACK_IDS_MAX, releaseMemberUrls, releasePackMembers, releaseVendorUrls, type AiHit, type RankInput } from "../lib/rank";
import { sanitize } from "../lib/sanitize";
import { Candidate } from "../lib/schema/context";
import { CandidateLogFile, CandidatesFile, CutEntry, RankLogEntry, type PackItem, type PackRecord } from "../lib/schema/pack";

const ROOT = path.resolve(__dirname, "..");
const FEEDS = path.join(ROOT, "fixtures", "feeds");
const DATE = "2026-10-14";
const NEW_KEV = ["CVE-2026-104935", "CVE-2026-96951"];
const cfg = loadConfig({ root: ROOT });

/** WP4's matchRecord() is a stub in this lane: the same rule over sanitised credit strings, in field order. */
const aiMatch = (rec: CveRecord): AiHit | null => {
  for (const f of cfg.compiled.aiFinders.fields) {
    for (const c of rec.credits) {
      if (c.field !== f) continue;
      const h = matchCredit(sanitize(c.value), cfg.compiled.aiFinders);
      if (h) return { ...h, field: f };
    }
  }
  return null;
};

function readZipRecords(file: string): CveRecord[] {
  return parseDeltaZip(fs.readFileSync(path.join(FEEDS, "cvelist", "zips", file))).records.map((r) => parseCveRecord(r)).filter((r): r is CveRecord => r !== null);
}

const epssDay = (d: string) => parseEpssCsv(fs.readFileSync(path.join(FEEDS, "epss", `epss_scores-${d}.csv.gz`))).day;

function world() {
  const recs = new Map<string, CveRecord>();
  for (const r of [...readZipRecords("2026-10-12_delta_CVEs_at_end_of_day.zip"), ...readZipRecords("2026-10-13_delta_CVEs_at_2000Z.zip")]) recs.set(r.cve_id, r);
  const catalog = parseKev(fs.readFileSync(path.join(FEEDS, "kev", "known_exploited_vulnerabilities.json"))).catalog;
  const gdir = path.join(FEEDS, "ghsa", "repo", "advisories", "github-reviewed", "2026", "10");
  const ghsa = fs.readdirSync(gdir).sort().map((d) => parseGhsa(JSON.parse(fs.readFileSync(path.join(gdir, d, `${d}.json`), "utf8")))).filter((g): g is GhsaAdvisory => g !== null);
  const window = packWindow(DATE, cfg.run.pack);
  return { records: [...recs.values()], catalog, ghsa, window, recordWindow: recordWindow(window), e: epssDay("2026-10-13"), e1: epssDay("2026-10-12"), e7: epssDay("2026-10-06") };
}

const W = world();

function input(over: Partial<RankInput> = {}, config: LoadedConfig = cfg): RankInput {
  const base: Omit<RankInput, "pack"> = {
    date: DATE, window: W.window, recordWindow: W.recordWindow, catalog: W.catalog, newKevIds: NEW_KEV, records: W.records,
    epss: { e: W.e, e1: W.e1, e7: W.e7 }, ghsa: W.ghsa, earlierReleaseIds: [],
    config: { loaded: config, compiled: config.compiled, watchWindows: [] }, kevSource: "kev-index", aiMatch,
  };
  const merged = { ...base, ...over };
  if (over.pack) return merged as RankInput;
  const keep = recordKeepIds(merged);
  // As scripts/collect.ts writes them: a release member's record carries its vendor pages after its tagged URLs.
  const vendorUrls = releaseMemberUrls(merged);
  const drafts = [
    ...kevPackRecords(merged.catalog?.vulnerabilities ?? [], new Set(merged.newKevIds), cfg.sourceTiers),
    ...cvePackRecords(merged.records, (r) => keep.has(r.cve_id), cfg.sourceTiers, undefined, undefined, (r) => vendorUrls.get(r.cve_id) ?? []),
    ...ghsaPackRecords(merged.ghsa, merged.window),
  ];
  return { ...merged, pack: { items: [], records: provisionalRecords(drafts) } };
}

let itemN = 0;
function item(title: string, over: Partial<PackItem> = {}): PackItem {
  itemN += 1;
  const id = over.id ?? `p${String(itemN).padStart(4, "0")}`;
  return {
    id, feed_id: "bleepingcomputer", outlet: "BleepingComputer", publisher: "bleepingcomputer", tier: 2, language: "en", region: "GLOBAL",
    coverage: ["exploits"], title, snippet: "", url: `https://bleepingcomputer.com/ct-sample/${id}`, published_at: "2026-10-13T12:00:00Z",
    cve_ids: cveIdsIn(title), alert: false, flags: [], score: 30, ...over,
  };
}

/** A CVE record shaped as parseCveRecord() returns it. */
function rec(id: string, over: Partial<CveRecord> = {}): CveRecord {
  return {
    cve_id: id, state: "PUBLISHED", date_published: "2026-10-13", assigner: "example", scored: true, credits: [],
    affected: [{ vendor: "Example Corp", product: "Example Server" }], published_at: "2026-10-13T10:00:00Z", updated_at: "2026-10-13T10:00:00Z",
    date_updated: "2026-10-13", title: `SAMPLE flaw ${id}`, description: "SAMPLE description.", cvss: null, cna_severity: null, ssvc: null,
    kev_marker: null, references: [], exploit_reference: false, ...over,
  };
}

function kevEntry(id: string, over: Partial<KevEntry> = {}): KevEntry {
  return {
    cveID: id, vendorProject: "Example Corp", product: "Example Server", vulnerabilityName: `SAMPLE KEV ${id}`, dateAdded: "2026-10-13",
    shortDescription: "SAMPLE.", requiredAction: "Apply updates.", dueDate: "2026-11-03", knownRansomwareCampaignUse: "Unknown",
    forensicTriage: null, notes: "", cwes: [], ...over,
  };
}

const catalogOf = (entries: KevEntry[]): KevCatalog => ({ catalogVersion: "2026.10.13", dateReleased: "2026-10-13T17:02:11Z", count: entries.length, vulnerabilities: entries });

function epss(scores: Record<string, [number, number]>, date: string): EpssDay {
  return { model_version: "v2025.03.14", score_date: `${date}T00:00:00Z`, scores: new Map(Object.entries(scores).map(([k, [e, p]]) => [k, { epss: e, percentile: p }])) };
}

/** A seeded shuffle (mulberry32), so the shuffled test is the same every run. */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const REASON_TEMPLATES = [
  /^new KEV$/, /^KEV: ransomware known$/, /^(?:TW|JP) vendor$/, /^CVSS \d+\.\d \((?:cna|cisa_adp|nvd), (?:4\.0|3\.1|3\.0)\)$/, /^EPSS crossed 0\.99$/,
  /^EPSS \+\d\.\d\d in a day$/, /^SSVC: automatable, total impact$/, /^AI credit: [a-z_]+$/, /^public exploit reported$/, /^watch window: [a-z0-9-]+$/,
  /^GitHub critical$/, /^JPCERT alert$/, /^CERT note$/, /^agency alert$/, /^release: \d+ fixes, \d+ exploited$/,
];

describe("RANK_WEIGHTS", () => {
  it("is §5.12's object", () => {
    expect(RANK_WEIGHTS).toEqual({
      base: { new_kev: 100, release_exploited: 90, cert_alert: 60, critical_widely_deployed: 50, release: 40, ghsa_critical: 35, cert_note: 30 },
      bonus: { kev_ransomware_known: 10, home_vendor: 25, ai_credit: 30, epss_crossed_99: 40, epss_rose_010: 20, ssvc_automatable_total: 20, public_exploit_reported: 15, watch_window: 15 },
    });
  });
});

describe("rankCandidates() on the 2026-10-14 fixture morning", () => {
  const items = [
    item("Ivanti Connect Secure flaw CVE-2026-104935 exploited", { id: "p0001" }),
    item("Microsoft fixes a Windows flaw attackers already use", { id: "p0002", score: 33.5 }),
    item("Ivanti says more customers should patch", { id: "p0003" }),
    item("A hospital chain reports a ransomware attack", { id: "p0004", coverage: ["breaches", "exploits"], score: 41.2 }),
    item("CERT-FR alerte sur une campagne", { id: "p0005", feed_id: "cert-fr", publisher: "anssi", alert: true, score: 25, language: "fr", region: "EU" }),
  ];
  const run = () => rankCandidates({ ...input(), pack: { items, records: input().pack.records } });

  it("keeps both new KEV entries first, and every output parses with its schema", () => {
    const out = run();
    expect(out.kept.slice(0, 2).map((c) => c.id)).toEqual(["cve-2026-104935", "cve-2026-96951"]);
    for (const c of out.kept) Candidate.parse(c);
    for (const c of out.cut) CutEntry.parse(c);
    for (const l of out.log) RankLogEntry.parse(l);
    expect(out.kept.length).toBeLessThanOrEqual(cfg.run.budgets.candidates_max);
    CandidatesFile.parse({ schema_version: 1, date: DATE, kept: out.kept, cut: { count: out.cut.length, by_reason: { below_cap: 0, merged: 2, bundled: 8 } } });
    CandidateLogFile.parse({ schema_version: 1, date: DATE, ranked: out.ranked, kept: out.kept.map((c) => c.id), cut: out.cut, log: out.log, size_cut: { over: false, items: [], records: [] } });
    expect(out.kept.every((c, i) => c.rank === i + 1)).toBe(true);
  });

  it("gives shuffled input byte-identical output", () => {
    const base = input();
    const a = JSON.stringify(rankCandidates({ ...base, pack: { items, records: base.pack.records } }));
    for (const seed of [1, 7, 42]) {
      const b = JSON.stringify(rankCandidates({
        ...base,
        records: shuffled(base.records, seed),
        newKevIds: shuffled(base.newKevIds, seed),
        ghsa: shuffled(base.ghsa, seed),
        catalog: { ...W.catalog, vulnerabilities: shuffled(W.catalog.vulnerabilities, seed) },
        pack: { items: shuffled(items, seed), records: shuffled(base.pack.records, seed) },
      }));
      expect(b).toBe(a);
    }
  });

  it("finds Patch Tuesday as one pt-microsoft-2026-10 with its counts, the exploited CVE kept apart", () => {
    const out = run();
    const pt = out.kept.find((c) => c.id === "pt-microsoft-2026-10")!;
    expect(pt.kind).toBe("patch_batch");
    expect(pt.release).toEqual({
      release_id: "rel-microsoft-2026-10", vendor: "Microsoft", total: 9, critical: 4, exploited: 1, exploited_cve_ids: ["CVE-2026-96951"],
      first_published: "2026-10-13", last_published: "2026-10-13",
    });
    expect(pt.cve_ids).toEqual(["CVE-2026-96951"]);
    expect(pt.score).toBe(RANK_WEIGHTS.base.release_exploited);
    // pack_ids: the exploited member's CVE List record, then the critical ones by CVSS, then the rest by CVSS, at most 20
    // (§0.4 row 146 and its review): all nine fixes of this release.
    const byId = new Map(input().pack.records.map((r) => [r.id, r]));
    expect(pt.pack_ids.map((id) => `${byId.get(id)!.source} ${byId.get(id)!.record_id}`).sort()).toEqual(
      ["CVE-2026-96951", "CVE-2026-70157", "CVE-2026-84011", "CVE-2026-84012", "CVE-2026-84015", "CVE-2026-102210", "CVE-2026-102234", "CVE-2026-102238", "CVE-2026-102860"]
        .map((id) => `cvelist ${id}`).sort(),
    );
    expect(out.kept.some((c) => c.id === "cve-2026-96951")).toBe(true);
    const bundled = out.cut.filter((c) => c.reason === "bundled:rel-microsoft-2026-10");
    expect(bundled.map((c) => c.cve_ids[0])).toEqual(["CVE-2026-70157", "CVE-2026-84011", "CVE-2026-84012", "CVE-2026-84015", "CVE-2026-102210", "CVE-2026-102234", "CVE-2026-102238", "CVE-2026-102860"]);
    expect(out.kept.some((c) => bundled.some((b) => b.id === c.id))).toBe(false);
    expect(out.log.filter((l) => l.code === "BUNDLED")).toHaveLength(1);
  });

  it("adds the -DD suffix when an earlier edition already holds rel-microsoft-2026-10", () => {
    const out = rankCandidates({ ...input({ earlierReleaseIds: ["rel-microsoft-2026-10"] }) });
    const pt = out.kept.find((c) => c.kind === "patch_batch")!;
    expect(pt.id).toBe("pt-microsoft-2026-10-13");
    expect(pt.release?.release_id).toBe("rel-microsoft-2026-10-13");
  });

  it("merges news by CVE id, or vendor plus product for a single-CVE candidate, never by vendor alone", () => {
    const out = run();
    const ivanti = out.kept.find((c) => c.id === "cve-2026-104935")!;
    expect(ivanti.pack_ids).toContain("p0001");
    expect(out.cut).toContainEqual(expect.objectContaining({ id: "p0001", reason: "merged:cve-2026-104935" }));
    // "Microsoft … Windows" matches two single-CVE Microsoft Windows candidates: the higher pre-merge score wins.
    expect(out.cut).toContainEqual(expect.objectContaining({ id: "p0002", reason: "merged:cve-2026-96951" }));
    expect(out.kept.find((c) => c.id === "cve-2024-38112")?.pack_ids ?? []).not.toContain("p0002");
    // Vendor alone: its own news candidate.
    const solo = out.kept.find((c) => c.id === "p0003")!;
    expect(solo.kind).toBe("critical_flaw");
    expect(solo.reasons).toEqual(["news: BleepingComputer"]);
    expect(out.kept.find((c) => c.id === "p0004")?.kind).toBe("breach");
    expect(out.log.filter((l) => l.code === "MERGED").map((l) => l.detail)).toEqual([
      "p0001 (bleepingcomputer) merged into cve-2026-104935 by CVE id.",
      "p0002 (bleepingcomputer) merged into cve-2026-96951 by vendor and product.",
    ]);
  });

  it("lifts an agency alert item to cert_alert", () => {
    const out = run();
    const alert = out.kept.find((c) => c.id === "p0005")!;
    expect(alert.score).toBe(RANK_WEIGHTS.base.cert_alert);
    expect(alert.reasons).toContain("agency alert");
  });

  it("logs every cut, merge and bundle with its reason, and by_reason has the three keys", () => {
    const cap = { ...cfg, run: { ...cfg.run, budgets: { ...cfg.run.budgets, candidates_max: 5 } } };
    const base = input({}, cap);
    const out = rankCandidates({ ...base, pack: { items, records: base.pack.records } });
    const built = buildCandidates({ ...base, pack: { items, records: base.pack.records } });
    expect(out.kept).toHaveLength(5);
    expect(out.ranked).toBe(built.candidates.length);
    const below = out.cut.filter((c) => c.reason === "below_cap");
    expect(below).toHaveLength(out.ranked - 5);
    expect(new Set([...out.kept.map((c) => c.id), ...below.map((c) => c.id)]).size).toBe(out.ranked);
    expect(out.cut.filter((c) => c.reason.startsWith("merged:"))).toEqual(built.merges);
    expect(out.cut.filter((c) => c.reason.startsWith("bundled:"))).toEqual(built.bundled);
    expect(out.log.filter((l) => l.code === "MERGED")).toHaveLength(built.merges.length);
    for (const c of out.cut) expect(c.reason).toMatch(/^(?:below_cap|merged:\S+|bundled:rel-\S+)$/);
  });

  it("writes reasons from fixed templates only, never feed text", () => {
    const loud = item("SAMPLE unusual headline words about Ivanti Connect Secure", { id: "p0009", snippet: "SAMPLE snippet words" });
    const out = rankCandidates({ ...input(), pack: { items: [...items, loud], records: input().pack.records } });
    const names = new Set(cfg.sources.feeds.map((f) => `news: ${f.name}`));
    for (const c of out.kept) {
      for (const r of c.reasons) expect(REASON_TEMPLATES.some((re) => re.test(r)) || names.has(r)).toBe(true);
      expect(c.reasons.join(" ")).not.toMatch(/SAMPLE|CANARY|Ivanti|Connect/);
    }
  });

  it("sets deep_read on ranks 1 to 15 only", () => {
    const many = Array.from({ length: 30 }, (_, i) => item(`SAMPLE story number ${i}`, { id: `p${String(100 + i).padStart(4, "0")}`, score: 10 + i / 10 }));
    const out = rankCandidates({ ...input(), pack: { items: many, records: input().pack.records } });
    expect(out.kept.length).toBe(40);
    expect(out.kept.filter((c) => c.deep_read).map((c) => c.rank)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });
});

describe("rankCandidates() on built cases", () => {
  const empty = { records: [], catalog: catalogOf([]), newKevIds: [], ghsa: [], epss: { e: null, e1: null, e7: null } } as const;

  it("keeps exactly the 45 new KEV entries past the cap, with CAP_KEV_OVERFLOW", () => {
    const ids = Array.from({ length: 45 }, (_, i) => `CVE-2026-${200000 + i}`);
    const others = ["CVE-2026-300001", "CVE-2026-300002"].map((id) => rec(id, {
      affected: [{ vendor: "Ivanti", product: "Connect Secure" }], cvss: { score: 9.8, version: "3.1", vector: "CVSS:3.1/AV:N", scorer: "cna" },
    }));
    const out = rankCandidates(input({ ...empty, records: others, catalog: catalogOf(ids.map((id) => kevEntry(id))), newKevIds: ids }));
    expect(out.kept.map((c) => c.cve_ids[0]).sort()).toEqual([...ids].sort());
    expect(out.log.map((l) => l.code)).toContain("CAP_KEV_OVERFLOW");
    expect(out.cut.filter((c) => c.reason === "below_cap").map((c) => c.id)).toEqual(["cve-2026-300001", "cve-2026-300002"]);
  });

  it("breaks score ties by the newest date, then the id", () => {
    const crit = (id: string, at: string) => rec(id, {
      published_at: at, updated_at: at, affected: [{ vendor: "Ivanti", product: "Connect Secure" }],
      cvss: { score: 9.8, version: "3.1", vector: "CVSS:3.1/AV:N", scorer: "cna" },
    });
    const out = rankCandidates(input({ ...empty, records: [crit("CVE-2026-1003", "2026-10-13T09:00:00Z"), crit("CVE-2026-1002", "2026-10-13T11:00:00Z"), crit("CVE-2026-1001", "2026-10-13T09:00:00Z")] }));
    expect(out.kept.map((c) => [c.id, c.score])).toEqual([["cve-2026-1002", 50], ["cve-2026-1001", 50], ["cve-2026-1003", 50]]);
  });

  it("gives +40 only when EPSS both crosses 0.99 and rises 0.10", () => {
    const e1 = epss({ "CVE-2025-1111": [0.5, 0.98], "CVE-2025-2222": [0.2, 0.9], "CVE-2025-3333": [0.97, 0.985] }, "2026-10-12");
    const e = epss({ "CVE-2025-1111": [0.95, 0.995], "CVE-2025-2222": [0.34, 0.95], "CVE-2025-3333": [0.971, 0.991] }, "2026-10-13");
    const out = rankCandidates(input({ ...empty, epss: { e, e1, e7: null } }));
    const by = new Map(out.kept.map((c) => [c.id, c]));
    expect(by.get("cve-2025-1111")).toMatchObject({ score: 40, reasons: ["EPSS crossed 0.99"], title: '<untrusted source="epss">CVE-2025-1111</untrusted>', vendor: null, product: null });
    expect(by.get("cve-2025-2222")).toMatchObject({ score: 20, reasons: ["EPSS +0.14 in a day"] });
    expect(by.get("cve-2025-3333")).toMatchObject({ score: 40, reasons: ["EPSS crossed 0.99"] });
    expect(by.get("cve-2025-1111")?.epss).toEqual({ score: 0.95, percentile: 0.995, change_24h: 0.45, date: "2026-10-13" });
  });

  /** A Microsoft fix published in the record window, as a Patch Tuesday zip holds it. */
  const msFix = (n: number, severity: string, score: number | null) => rec(`CVE-2026-${500000 + n}`, {
    assigner: "microsoft", affected: [{ vendor: "Microsoft", product: "Windows" }], cna_severity: severity,
    cvss: score === null ? null : { score, version: "3.1", vector: "CVSS:3.1/AV:N", scorer: "cna" }, published_at: `2026-10-13T17:${String(n % 60).padStart(2, "0")}:00Z`,
  });

  it("a 390-fix release references at most RELEASE_PACK_IDS_MAX records: the exploited, then the critical by CVSS; its counts cover every fix (row 146)", () => {
    // 3 fixes on the catalog (added long ago, so exploited but not new), 30 critical with CVSS 9.0 to 9.9, 2 critical unscored, 355 high.
    const exploited = [0, 1, 2].map((n) => msFix(n, "HIGH", 8.8));
    const critical = Array.from({ length: 30 }, (_, i) => msFix(10 + i, "CRITICAL", 9 + (i % 10) / 10));
    const unscored = [50, 51].map((n) => msFix(n, "CRITICAL", null));
    const high = Array.from({ length: 355 }, (_, i) => msFix(100 + i, "HIGH", 7.5));
    const records = [...exploited, ...critical, ...unscored, ...high];
    const catalog = catalogOf(exploited.map((r) => kevEntry(r.cve_id, { vendorProject: "Microsoft", product: "Windows", dateAdded: "2026-09-01" })));
    const base = input({ ...empty, records, catalog });
    const out = rankCandidates(base);
    const pt = out.kept.find((c) => c.kind === "patch_batch")!;
    expect(pt.release).toEqual({
      release_id: "rel-microsoft-2026-10", vendor: "Microsoft", total: 390, critical: 32, exploited: 3, exploited_cve_ids: exploited.map((r) => r.cve_id),
      first_published: "2026-10-13", last_published: "2026-10-13",
    });
    expect(pt.title).toContain("390 fixes, 3 exploited");
    expect(RELEASE_PACK_IDS_MAX).toBe(20);
    expect(pt.pack_ids).toHaveLength(RELEASE_PACK_IDS_MAX);
    const byId = new Map(base.pack.records.map((r) => [r.id, r]));
    const named = pt.pack_ids.map((id) => byId.get(id)!);
    expect(named.every((r) => r.source === "cvelist")).toBe(true);
    const ids = new Set(named.map((r) => r.record_id));
    for (const r of exploited) expect(ids.has(r.cve_id)).toBe(true);
    // The other 17 are the highest-scored critical fixes; no unscored or high one.
    const chosen = critical.filter((r) => ids.has(r.cve_id));
    expect(chosen).toHaveLength(17);
    const lowestChosen = Math.min(...chosen.map((r) => r.cvss!.score));
    expect(critical.filter((r) => !ids.has(r.cve_id)).every((r) => r.cvss!.score <= lowestChosen)).toBe(true);
    for (const r of [...unscored, ...high]) expect(ids.has(r.cve_id)).toBe(false);
    // In that order: the exploited by CVE id, then the critical by CVSS descending, then CVE id.
    const order = [...chosen].sort((a, b) => b.cvss!.score - a.cvss!.score || compareCveIds(a.cve_id, b.cve_id)).map((r) => r.cve_id);
    expect(releasePackMembers({ members: shuffled(records, 3), exploited: exploited.map((r) => r.cve_id) })).toEqual([...exploited.map((r) => r.cve_id), ...order]);
    // The pack keeps those records, the exploited ones (their own candidates) and the critical ones a test of their own keeps (CVSS 9+ on a
    // widely deployed vendor), never a fix no test keeps.
    const keep = recordKeepIds(base);
    for (const r of [...exploited, ...critical]) expect(keep.has(r.cve_id)).toBe(true);
    for (const r of [...unscored, ...high]) expect(keep.has(r.cve_id)).toBe(false);
    for (const r of exploited) expect(out.kept.find((c) => c.id === r.cve_id.toLowerCase())?.pack_ids).toHaveLength(1);

    // A news item and a JPCERT note naming high fixes the release does not reference still merge into it, since it matches every member
    // id, and add only their own ids: its member records stay at RELEASE_PACK_IDS_MAX (review of row 146). Neither names the vendor or
    // product, so only the CVE id can match.
    const [newsCve, noteCve] = [high[200]!.cve_id, high[201]!.cve_id];
    expect(ids.has(newsCve) || ids.has(noteCve)).toBe(false);
    const news = item(`SAMPLE: ${newsCve} is fixed in this month's update`, { id: "p0901" });
    const note = notePackRecords("jpcert", [{
      id: "wr264102", title: `SAMPLE weekly report ${noteCve}`, url: "https://jpcert.or.jp/wr/2026/wr264102.html", text: "SAMPLE",
      published_at: "2026-10-13T06:00:00Z", cve_ids: [noteCve], alert: false,
    }], W.window);
    const packRecords = provisionalRecords([
      ...kevPackRecords(catalog.vulnerabilities, new Set<string>(), cfg.sourceTiers),
      ...cvePackRecords(records, (r) => keep.has(r.cve_id), cfg.sourceTiers),
      ...note,
    ]);
    const noteId = packRecords.find((r) => r.source === "jpcert")!.id;
    const merged = rankCandidates({ ...base, pack: { items: [news], records: packRecords } });
    const mpt = merged.kept.find((c) => c.kind === "patch_batch")!;
    expect(mpt.id).toBe("pt-microsoft-2026-10");
    expect(merged.cut).toContainEqual(expect.objectContaining({ id: news.id, reason: `merged:${mpt.id}` }));
    expect(merged.cut).toContainEqual(expect.objectContaining({ id: noteId, reason: `merged:${mpt.id}` }));
    expect(merged.log).toContainEqual({ code: "MERGED", detail: `${news.id} (bleepingcomputer) merged into ${mpt.id} by CVE id.` });
    const sourceOf = new Map(packRecords.map((r) => [r.id, r.source]));
    expect(mpt.pack_ids.filter((id) => sourceOf.get(id) === "cvelist")).toHaveLength(RELEASE_PACK_IDS_MAX);
    expect(mpt.pack_ids.filter((id) => sourceOf.get(id) !== "cvelist").sort()).toEqual([news.id, noteId].sort());
    expect(mpt.pack_ids).toHaveLength(RELEASE_PACK_IDS_MAX + 2);
    expect(merged.kept.some((c) => c.id !== mpt.id && (c.pack_ids.includes(news.id) || c.pack_ids.includes(noteId)))).toBe(false);
  });

  it("past RELEASE_PACK_IDS_MAX exploited fixes the release names the first 20 by CVE id, and the pack keeps every exploited fix's record", () => {
    const exploited = Array.from({ length: 25 }, (_, i) => msFix(i, "HIGH", 8.8));
    const records = [...exploited, msFix(40, "CRITICAL", 9.8)];
    const catalog = catalogOf(exploited.map((r) => kevEntry(r.cve_id, { vendorProject: "Microsoft", product: "Windows", dateAdded: "2026-09-01" })));
    const base = input({ ...empty, records, catalog });
    const pt = buildCandidates(base).candidates.find((c) => c.kind === "patch_batch")!;
    const byId = new Map(base.pack.records.map((r) => [r.id, r.record_id]));
    expect(pt.pack_ids.map((id) => byId.get(id)).sort()).toEqual(exploited.slice(0, 20).map((r) => r.cve_id).sort());
    expect(pt.release).toMatchObject({ total: 26, critical: 1, exploited: 25 });
    const keep = recordKeepIds(base);
    for (const r of records) expect(keep.has(r.cve_id)).toBe(true);
  });

  /** An Adobe fix in the record window, HIGH, citing the month's bulletin as a vendor advisory, as an all-High Adobe month has them. */
  const ADOBE_BULLETIN = "https://helpx.adobe.com/security/products/acrobat/apsb26-91.html";
  const adobeFix = (n: number, score: number | null) => rec(`CVE-2026-${610000 + n}`, {
    assigner: "adobe", affected: [{ vendor: "Adobe", product: "Acrobat Reader" }], cna_severity: "HIGH",
    cvss: score === null ? null : { score, version: "3.1", vector: "CVSS:3.1/AV:N", scorer: "cna" }, published_at: `2026-10-13T17:${String(n % 60).padStart(2, "0")}:00Z`,
    references: [{ url: ADOBE_BULLETIN, tags: ["vendor-advisory"], from: "cna" }],
  });

  it("a release with no exploited and no critical fix names its best-scored fixes: 20 of 35, by CVSS, unscored last, then CVE id, with the vendor's advisory (review of row 146)", () => {
    // 35 HIGH fixes: CVSS 7.0 to 8.6 in steps of 0.1 (some scores shared), three unscored. Before the fill the candidate named no record,
    // so it carried no advisory URL and no CVE id, and an item citing only the press failed at publish (releaseBlockOf()).
    const scores = Array.from({ length: 32 }, (_, i) => Math.round((7 + (i % 17) / 10) * 10) / 10);
    const fixes = [...scores.map((sc, i) => adobeFix(i, sc)), ...[40, 41, 42].map((n) => adobeFix(n, null))];
    const base = input({ ...empty, records: shuffled(fixes, 7) });
    const pt = rankCandidates(base).kept.find((c) => c.kind === "patch_batch")!;
    expect(pt.release).toEqual({
      release_id: "rel-adobe-2026-10", vendor: "Adobe", total: 35, critical: 0, exploited: 0, exploited_cve_ids: [], first_published: "2026-10-13", last_published: "2026-10-13",
    });
    expect(pt.cve_ids).toEqual([]);
    const order = [...fixes].sort((a, b) => (b.cvss?.score ?? -1) - (a.cvss?.score ?? -1) || compareCveIds(a.cve_id, b.cve_id)).map((r) => r.cve_id);
    expect(releasePackMembers({ members: shuffled(fixes, 11), exploited: [] })).toEqual(order.slice(0, RELEASE_PACK_IDS_MAX));
    const byId = new Map(base.pack.records.map((r) => [r.id, r]));
    expect(pt.pack_ids).toHaveLength(RELEASE_PACK_IDS_MAX);
    expect(pt.pack_ids.map((id) => byId.get(id)!.record_id).sort()).toEqual(order.slice(0, RELEASE_PACK_IDS_MAX).sort());
    expect(pt.advisory_urls).toEqual([ADOBE_BULLETIN]);
    // The pack keeps those 20 records and no other fix.
    const keep = recordKeepIds(base);
    expect(fixes.filter((r) => keep.has(r.cve_id)).map((r) => r.cve_id).sort()).toEqual(order.slice(0, RELEASE_PACK_IDS_MAX).sort());
    // A release of 8 fixes names all 8, the unscored last; a critical fix still comes before a better-scored high one.
    const eight = [...fixes.slice(0, 6), fixes[33]!, fixes[34]!];
    expect(releasePackMembers({ members: eight, exploited: [] })).toEqual(
      [...eight].sort((a, b) => (b.cvss?.score ?? -1) - (a.cvss?.score ?? -1) || compareCveIds(a.cve_id, b.cve_id)).map((r) => r.cve_id),
    );
    const small = rankCandidates(input({ ...empty, records: eight })).kept.find((c) => c.kind === "patch_batch")!;
    expect(small.pack_ids).toHaveLength(8);
    expect(small.advisory_urls).toEqual([ADOBE_BULLETIN]);
    const critLow: CveRecord = { ...fixes[0]!, cve_id: "CVE-2026-619999", cna_severity: "CRITICAL", cvss: { score: 7.0, version: "3.1", vector: "CVSS:3.1/AV:N", scorer: "cna" } };
    expect(releasePackMembers({ members: [...eight, critLow], exploited: [eight[1]!.cve_id] }).slice(0, 2)).toEqual([eight[1]!.cve_id, "CVE-2026-619999"]);
  });

  it("a release carries its fixes' first and last UTC publication dates, and releaseMember() takes exactly the records rank bundles (fourth review of row 146)", () => {
    // The record window for 2026-10-14 is 2026-10-12T20:00Z to 2026-10-13T20:00Z. Two fixes on the 12th's evening, four on the
    // 13th; two older Adobe records the delta zips carry because they were updated in the window, and one published after it.
    const fixes = [0, 1, 2, 3, 4, 5].map((n) => ({ ...adobeFix(n, 7.5), published_at: n < 2 ? `2026-10-12T21:3${n}:00Z` : `2026-10-13T17:0${n}:00Z` }));
    const older = [6, 7].map((n) => ({ ...adobeFix(n, 9.8), cna_severity: "CRITICAL", published_at: "2026-07-14T17:00:00Z", date_published: "2026-07-14", updated_at: "2026-10-13T10:00:00Z" }));
    const after = { ...adobeFix(8, 9.8), published_at: "2026-10-14T00:30:00Z", date_published: "2026-10-14" };
    const records = [...fixes, ...older, after].map((r) => ({ ...r, date_published: r.published_at.slice(0, 10) }));
    const pt = rankCandidates(input({ ...empty, records })).kept.find((c) => c.kind === "patch_batch")!;
    expect(pt.release).toMatchObject({ release_id: "rel-adobe-2026-10", total: 6, critical: 0, first_published: "2026-10-12", last_published: "2026-10-13" });
    // The CVE List lookup the validator and publish read holds all nine; only the six fixes are the release's.
    const lookup = new Map(records.map((r): [string, CveRecordInfo] => [r.cve_id, {
      cve_id: r.cve_id, state: "PUBLISHED", date_published: r.date_published, date_updated: r.date_updated, assigner: r.assigner, vendors: ["Adobe"],
      products: ["Acrobat Reader"], title: r.title, exploit_reference: false, kev_date_added: null, credits: [],
    }]));
    const adobe = cfg.vendors.vendors.find((v) => v.id === "adobe")!;
    const inWindow = (ts: string) => Date.parse(ts) >= Date.parse(W.recordWindow.start) && Date.parse(ts) < Date.parse(W.recordWindow.end);
    expect(records.map((r) => [r.cve_id, releaseMember(r.cve_id, pt.release!, adobe, lookup)])).toEqual(records.map((r) => [r.cve_id, inWindow(r.published_at)]));
    expect(records.filter((r) => releaseMember(r.cve_id, pt.release!, adobe, lookup)).map((r) => r.cve_id)).toEqual(fixes.map((r) => r.cve_id));
  });

  /** A fix of `vendor` (its CNA `assigner`) whose CNA references carry no tag, as SAP's, Siemens' and Schneider's do. */
  const untaggedFix = (n: number, assigner: string, vendor: string, urls: string[], score = 7.5) => rec(`CVE-2026-${620000 + n}`, {
    assigner, affected: [{ vendor, product: "SAMPLE Product" }], cna_severity: "HIGH", cvss: { score, version: "3.1", vector: "CVSS:3.1/AV:N", scorer: "cna" },
    published_at: `2026-10-13T16:${String(n % 60).padStart(2, "0")}:00Z`, references: urls.map((url) => ({ url, tags: [], from: "cna" as const })),
  });

  it("a release whose CVE records tag no reference still carries the vendor's own page, and no page on another host (review of row 146)", () => {
    // SAP: each record cites its note on me.sap.com (vendor:sap, tier 1) and the url.sap patch-day link (host:url.sap, tier 3).
    const sap = Array.from({ length: 6 }, (_, i) => untaggedFix(i, "sap", "SAP", [`https://me.sap.com/notes/36943${80 + i}`, "https://url.sap/sapsecuritypatchday"], 8 - i / 10));
    const ptSap = rankCandidates(input({ ...empty, records: sap })).kept.find((c) => c.kind === "patch_batch")!;
    expect(ptSap.id).toBe("pt-sap-2026-10");
    // Best-scored first (releasePackMembers()), at most five; url.sap is never one.
    expect(ptSap.advisory_urls).toEqual([0, 1, 2, 3, 4].map((i) => `https://me.sap.com/notes/36943${80 + i}`));
    // Siemens: one ProductCERT page per record on cert-portal.siemens.com; one record also cites a page on another host.
    const siemens = Array.from({ length: 5 }, (_, i) => untaggedFix(10 + i, "siemens", "Siemens", [
      `https://cert-portal.siemens.com/productcert/html/ssa-0635${10 + i}.html`, ...(i === 0 ? ["https://example.com/ct-sample/siemens-writeup"] : []),
    ]));
    const ptSiemens = rankCandidates(input({ ...empty, records: siemens })).kept.find((c) => c.kind === "patch_batch")!;
    expect(ptSiemens.id).toBe("pt-siemens-2026-10");
    expect(ptSiemens.advisory_urls).toEqual([10, 11, 12, 13, 14].map((n) => `https://cert-portal.siemens.com/productcert/html/ssa-0635${n}.html`));
    // Schneider Electric's notices sit on download.schneider-electric.com as well as download.se.com: both are its own (vendors.json).
    const schneider = Array.from({ length: 5 }, (_, i) => untaggedFix(20 + i, "schneider", "Schneider Electric", [
      `https://download.${i % 2 ? "se" : "schneider-electric"}.com/files?p_Doc_Ref=SEVD-2026-286-0${i}`,
    ]));
    const ptSchneider = rankCandidates(input({ ...empty, records: schneider })).kept.find((c) => c.kind === "patch_batch")!;
    expect(ptSchneider.advisory_urls).toHaveLength(5);
    expect(ptSchneider.advisory_urls.filter((u) => u.startsWith("https://download.schneider-electric.com/"))).toHaveLength(3);
    // Only references on another host: no advisory URL. An exploit-tagged reference on the vendor's domain is never taken either.
    const elsewhere = sap.map((r, i) => ({ ...r, references: [
      { url: "https://url.sap/sapsecuritypatchday", tags: [], from: "cna" as const },
      { url: `https://example.com/ct-sample/sap-${i}`, tags: [], from: "cna" as const },
      { url: `https://me.sap.com/notes/39${i}`, tags: ["exploit"], from: "cna" as const },
      { url: `https://me.sap.com/notes/38${i}`, tags: [], from: "adp" as const },
    ] }));
    expect(rankCandidates(input({ ...empty, records: elsewhere })).kept.find((c) => c.kind === "patch_batch")!.advisory_urls).toEqual([]);
    // The vendor pages are the release's only: the same records outside a bundle (four, below min_records) carry none.
    expect(releaseVendorUrls(sap[0]!, { id: "sap" }, cfg)).toEqual(["https://me.sap.com/notes/3694380"]);
    expect(releaseVendorUrls(sap[0]!, { id: "siemens" }, cfg)).toEqual([]);
    const base = input({ ...empty, records: sap });
    expect([...releaseMemberUrls(base).keys()].sort()).toEqual(sap.map((r) => r.cve_id).sort());
    expect(releaseMemberUrls(input({ ...empty, records: sap.slice(0, 4) })).size).toBe(0);
    expect(cvePackRecords(sap.slice(0, 1), () => true, cfg.sourceTiers)[0]!.advisory_urls).toEqual([]);
    // Collect adds them to the member records it writes, after the tagged ones, so the pack holds them.
    const urls = releaseMemberUrls(base);
    const drafts = cvePackRecords(sap, () => true, cfg.sourceTiers, undefined, undefined, (r) => urls.get(r.cve_id) ?? []);
    expect(drafts.map((d) => d.advisory_urls)).toEqual(sap.map((_, i) => [`https://me.sap.com/notes/36943${80 + i}`]));
  });

  it("every advisory URL a release candidate carries is one its pack records hold: a vendor page collect's link screen refuses stays out (fourth review of row 146)", () => {
    // Before, releaseUrls() also read the vendor pages straight from the CVE records, so a page with an apostrophe in its path,
    // which safeLink() drops from the member's pack record (flagging it), still reached the candidate's advisory_urls.
    const sap = Array.from({ length: 8 }, (_, i) => untaggedFix(30 + i, "sap", "SAP", [
      i < 6 ? `https://me.sap.com/notes/37000${i}'x` : `https://me.sap.com/notes/37000${i}`,
    ], 9 - i / 10));
    const base = input({ ...empty, records: sap });
    const pt = rankCandidates(base).kept.find((c) => c.kind === "patch_batch")!;
    const held = new Set(base.pack.records.flatMap((r) => r.advisory_urls));
    expect(pt.advisory_urls.length).toBeGreaterThan(0);
    for (const u of pt.advisory_urls) expect(held.has(u), u).toBe(true);
    expect(pt.advisory_urls).toEqual(["https://me.sap.com/notes/370006", "https://me.sap.com/notes/370007"]);
    // The six refused pages are in no pack record, and their records are flagged.
    const refused = base.pack.records.filter((r) => r.flags.includes("injection_like"));
    expect(refused.map((r) => r.record_id).sort()).toEqual(sap.slice(0, 6).map((r) => r.cve_id).sort());
    expect(refused.every((r) => r.advisory_urls.length === 0)).toBe(true);
  });

  it("a release's advisory URLs start with its exploited fix's own, whatever the fill adds (review of row 146)", () => {
    // MSRC-style: one per-CVE vendor-advisory page per record. The exploited fix has the highest CVE id, so record id order would put
    // its page last; the critical fixes come next, then the rest by CVSS.
    const msrc = (id: string) => `https://msrc.microsoft.com/update-guide/vulnerability/${id}`;
    const fix = (i: number, severity: string, score: number) => {
      const r = msFix(i, severity, score);
      return { ...r, references: [{ url: msrc(r.cve_id), tags: ["vendor-advisory"], from: "cna" as const }] };
    };
    for (const n of [90, 8]) {
      const records = Array.from({ length: n }, (_, i) => fix(i, i === 1 || i === 2 ? "CRITICAL" : "HIGH", i === 1 ? 9.1 : i === 2 ? 9.8 : 8.8 - (i % 9) / 10));
      const exploitedId = records.at(-1)!.cve_id;
      const catalog = catalogOf([kevEntry(exploitedId, { vendorProject: "Microsoft", product: "Windows", dateAdded: "2026-09-01" })]);
      const base = input({ ...empty, records, catalog });
      const pt = rankCandidates(base).kept.find((c) => c.kind === "patch_batch")!;
      const members = releasePackMembers({ members: records, exploited: [exploitedId] });
      expect(members[0], `${n} fixes`).toBe(exploitedId);
      expect(pt.advisory_urls, `${n} fixes`).toEqual(members.slice(0, 5).map(msrc));
      expect(pt.advisory_urls[0]).toBe(msrc(exploitedId));
      expect(pt.advisory_urls.slice(1, 3)).toEqual([msrc(records[2]!.cve_id), msrc(records[1]!.cve_id)]);
    }
  });

  it("bundles schneider-electric once its cna is set", () => {
    const recs = Array.from({ length: 5 }, (_, i) => rec(`CVE-2026-4000${i}`, { assigner: "schneider", affected: [{ vendor: "Schneider Electric", product: "EcoStruxure" }], published_at: `2026-10-13T0${i}:00:00Z` }));
    const out = rankCandidates(input({ ...empty, records: recs }));
    const pt = out.kept.find((c) => c.kind === "patch_batch")!;
    expect(pt.id).toBe("pt-schneider-electric-2026-10");
    expect(pt.release).toMatchObject({ release_id: "rel-schneider-electric-2026-10", vendor: "Schneider Electric", total: 5, critical: null, exploited: 0 });
    expect(pt.score).toBe(RANK_WEIGHTS.base.release);
    const four = rankCandidates(input({ ...empty, records: recs.slice(0, 4) }));
    expect(four.kept.some((c) => c.kind === "patch_batch")).toBe(false);
  });

  it("merges a JPCERT alert note into its record candidate and makes it exploited", () => {
    const r = rec("CVE-2026-5555", { affected: [{ vendor: "Ivanti", product: "Connect Secure" }], cvss: { score: 9.1, version: "3.1", vector: "CVSS:3.1/AV:N", scorer: "cna" } });
    const window = W.window;
    const notes = notePackRecords("jpcert", [{
      id: "at260031", title: "SAMPLE 注意喚起 CVE-2026-5555", url: "https://jpcert.or.jp/at/2026/at260031.html", text: "SAMPLE 悪用を確認しています", published_at: "2026-10-13T06:00:00Z", cve_ids: ["CVE-2026-5555"], alert: true,
    }, {
      id: "wr264101", title: "SAMPLE weekly report", url: "https://jpcert.or.jp/wr/2026/wr264101.html", text: "SAMPLE", published_at: "2026-10-13T06:00:00Z", cve_ids: ["CVE-2026-7777"], alert: false,
    }], window);
    const base = input({ ...empty, records: [r] });
    const records = provisionalRecords([...cvePackRecords([r], () => true, cfg.sourceTiers), ...notes]);
    const out = rankCandidates({ ...base, pack: { items: [], records } });
    const c = out.kept.find((k) => k.id === "cve-2026-5555")!;
    expect(c.kind).toBe("exploited_flaw");
    expect(c.score).toBe(RANK_WEIGHTS.base.cert_alert);
    expect(c.reasons).toContain("JPCERT alert");
    const note = out.kept.find((k) => k.id === "cve-2026-7777")!;
    expect(note).toMatchObject({ score: RANK_WEIGHTS.base.cert_note, reasons: ["CERT note"], cve_ids: ["CVE-2026-7777"] });
  });

  it("applies a watch window's search terms once", () => {
    const ww = { id: "sample-window", title: "SAMPLE", start: "2026-10-10", end: "2026-10-20", regions: ["TW" as const], lens_row: null, search_terms: ["SAMPLE term", "海纜"], note: null };
    const base = input({ ...empty, config: { loaded: cfg, compiled: cfg.compiled, watchWindows: [ww] } });
    const out = rankCandidates({ ...base, pack: { items: [item("Story with a sample TERM and 海纜", { id: "p0001", score: 20 })], records: [] } });
    expect(out.kept[0]).toMatchObject({ score: 35, reasons: ["news: BleepingComputer", "watch window: sample-window"] });
    expect(activeWatchWindows({ schema_version: 1, windows: [ww] }, "2026-10-21")).toEqual([]);
    expect(activeWatchWindows({ schema_version: 1, windows: [ww] }, "2026-10-20")).toEqual([ww]);
  });
});

describe("kevBaseline() through rank's log", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ct-rank-"));

  it("a committed metrics/D.json wins over the index", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "metrics"));
    fs.mkdirSync(path.join(dir, "state"));
    fs.writeFileSync(path.join(dir, "metrics", `${DATE}.json`), JSON.stringify({ kev: { new_since_last_edition: { cve_ids: ["CVE-2026-104935"] } } }));
    fs.writeFileSync(path.join(dir, "state", "kev-index.json"), JSON.stringify({ schema_version: 1, updated_at: "2026-10-13T05:00:00+08:00", catalog_version: "2026.10.12", entries: [] }));
    const b = kevBaseline({ contentDir: dir, date: DATE, catalog: W.catalog, asOf: false });
    expect(b).toMatchObject({ source: "metrics", newKevIds: ["CVE-2026-104935"] });
    const out = rankCandidates(input({ newKevIds: b.newKevIds, kevSource: b.source }));
    expect(out.kept.filter((c) => c.reasons.includes("new KEV")).map((c) => c.id)).toEqual(["cve-2026-104935"]);
    expect(out.log.map((l) => l.code)).not.toContain("KEV_INDEX_MISSING");
  });

  it("without an index gives KEV_INDEX_MISSING and the last 7 days", () => {
    const b = kevBaseline({ contentDir: tmp(), date: DATE, catalog: W.catalog, asOf: false });
    expect(b.source).toBe("recent-7-days");
    expect(b.newKevIds.length).toBeGreaterThan(0);
    const out = rankCandidates(input({ newKevIds: b.newKevIds, kevSource: b.source }));
    expect(out.log[0]?.code).toBe("KEV_INDEX_MISSING");
  });

  it("a 2026-10-14 as-of run returns the 2026-10-13 entries", () => {
    const b = kevBaseline({ contentDir: tmp(), date: DATE, catalog: W.catalog, asOf: true });
    expect(b.source).toBe("as-of");
    expect(b.newKevIds).toEqual(W.catalog.vulnerabilities.filter((v) => v.dateAdded === "2026-10-13").map((v) => v.cveID).sort((x, y) => (x < y ? -1 : 1)).sort((x, y) => Number(x.split("-")[2]) - Number(y.split("-")[2])));
    const out = rankCandidates(input({ newKevIds: b.newKevIds, catalog: b.catalog, kevSource: b.source }));
    expect(out.log[0]?.code).toBe("KEV_ASOF_DRY_RUN");
  });
});
