import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cveIdsIn, cvePackRecords, ghsaPackRecords, kevPackRecords, notePackRecords, packWindow, provisionalRecords, recordWindow } from "../lib/collect";
import { loadConfig, matchCredit, type LoadedConfig } from "../lib/config";
import { parseCveRecord } from "../lib/feeds/cvelist";
import { parseEpssCsv } from "../lib/feeds/epss";
import { parseGhsa } from "../lib/feeds/ghsa";
import { kevBaseline, parseKev } from "../lib/feeds/kev";
import type { CveRecord, EpssDay, GhsaAdvisory, KevCatalog, KevEntry } from "../lib/feeds/types";
import { parseDeltaZip } from "../lib/feeds/zip";
import { activeWatchWindows, buildCandidates, RANK_WEIGHTS, rankCandidates, recordKeepIds, type AiHit, type RankInput } from "../lib/rank";
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
  const drafts = [
    ...kevPackRecords(merged.catalog?.vulnerabilities ?? [], new Set(merged.newKevIds), cfg.sourceTiers),
    ...cvePackRecords(merged.records, (r) => keep.has(r.cve_id), cfg.sourceTiers),
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
    CandidateLogFile.parse({ schema_version: 1, date: DATE, ranked: out.ranked, kept: out.kept.map((c) => c.id), cut: out.cut, log: out.log });
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
    expect(pt.release).toEqual({ release_id: "rel-microsoft-2026-10", vendor: "Microsoft", total: 9, critical: 4, exploited: 1, exploited_cve_ids: ["CVE-2026-96951"] });
    expect(pt.cve_ids).toEqual(["CVE-2026-96951"]);
    expect(pt.score).toBe(RANK_WEIGHTS.base.release_exploited);
    expect(pt.pack_ids).toHaveLength(9);
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
      id: "at260031", title: "SAMPLE 注意喚起 CVE-2026-5555", url: "https://jpcert.or.jp/at/2026/at260031.html", text: "SAMPLE 悪用を確認", published_at: "2026-10-13T06:00:00Z", cve_ids: ["CVE-2026-5555"], alert: true,
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
