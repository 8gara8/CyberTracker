// The feed parsers (SPEC §8.3, §4.13; feeds plan §9) on the fixtures under fixtures/feeds/ and on
// in-memory bodies, the generated feed fixtures (fixtures plan §3.3) and the three agreement checks:
// cveFacts() against parseCveRecord() and P1's cveRecordInfo(), zone-less records under TZ=Asia/Taipei,
// and byte-identical feedOutputs(). Nothing here touches the network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { addDays, dataCutoffFor } from "@/lib/dates";
import { compareCveIds } from "@/lib/ids";
import { blockedReason } from "@/lib/sources";
import type { SourceTiersFile } from "@/lib/schema/config";
import { cveRecordInfo } from "@/lib/validate";
import { cvdPayloadUrl, parseAnthropicCvd } from "@/lib/feeds/anthropic-cvd";
import { cveFacts, parseCveRecord, parseDeltaLog, recordAdvisoryUrls, recordInstant } from "@/lib/feeds/cvelist";
import { epssApiUrls, epssJump, epssMovers, epssUrlFor, parseEpssApi, parseEpssCsv } from "@/lib/feeds/epss";
import { EXCHANGE_ENDPOINTS, hitsExchangeTerms, parseExchange, rocDate } from "@/lib/feeds/exchange";
import { ghsaIsFixed, ghsaMonths, ghsaRecordUrl, parseGhsa } from "@/lib/feeds/ghsa";
import {
  cveRecordRawUrl, endOfDayAsset, hourlyAsset, newestHourlyTag, parseLsRemote, rawAtCommit, REPOS, tagTime,
} from "@/lib/feeds/github";
import { kevBaseline, kevNoteUrls, newKevIds, parseKev } from "@/lib/feeds/kev";
import { myjvnPageUrls, parseMyJvn } from "@/lib/feeds/myjvn";
import { nvdUrls, parseNvdPage } from "@/lib/feeds/nvd";
import { feedDate, itemZone, jpcertRecords, parseRss, rssItems, tvnRecords, zoneOf } from "@/lib/feeds/rss";
import { FeedParseError, type CveFacts, type KevCatalog, type KevEntry } from "@/lib/feeds/types";
import { crc32, parseDeltaZip, readZip } from "@/lib/feeds/zip";
import {
  EOD_ZIP_PATH, FEED_WORLD, feedOutputs, fixtureKevCatalog, fixtureKevRows, HOURLY_ZIP_PATH, KEV_BAD_COUNT_PATH,
  KEV_CATALOG_PATH, ZIP_SOURCES,
} from "@/fixtures/src/feeds";
import { cveRecord, EDITIONS } from "@/fixtures/src/world";
import { storedZip } from "@/fixtures/src/zip-writer";
import { makeZip } from "./helpers/zip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FEEDS = path.join(ROOT, "fixtures", "feeds");
const read = (rel: string) => fs.readFileSync(path.join(FEEDS, rel));
const readJson = (rel: string): unknown => JSON.parse(read(rel).toString("utf8"));
const json = (v: unknown) => Buffer.from(JSON.stringify(v));
const TIERS = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "source-tiers.json"), "utf8")) as Pick<SourceTiersFile, "github">;
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** The FeedParseError class a call throws (fails the test if it throws anything else or nothing). */
function errorClass(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FeedParseError);
    return (e as FeedParseError).errorClass;
  }
  throw new Error("expected a FeedParseError");
}

async function errorClassAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FeedParseError);
    return (e as FeedParseError).errorClass;
  }
  throw new Error("expected a FeedParseError");
}

/** Runs `fn` with the machine zone set to `tz`, then restores it. */
function withTz<T>(tz: string, fn: () => T): T {
  const old = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
}

async function withTzAsync<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
}

/** Every file under `dir` (recursive), relative to it. */
function walk(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
}

const RECORD_FILE = /(?:^|\/)CVE-\d{4}-\d{4,}\.json$/;
const feedRecordFiles = () => walk(path.join(FEEDS, "cvelist")).filter((f) => RECORD_FILE.test(f)).map((f) => `cvelist/${f}`);

/** A minimal KEV catalog entry. */
const kevEntry = (cveID: string, dateAdded: string): KevEntry => ({
  cveID, vendorProject: "V", product: "P", vulnerabilityName: "N", dateAdded, shortDescription: "", requiredAction: "",
  dueDate: addDays(dateAdded, 21), knownRansomwareCampaignUse: "Unknown", forensicTriage: null, notes: "", cwes: [],
});

/** The fixture KEV world as a catalog holding every row, the 2026-10-14 additions included. */
const fullCatalog = (): KevCatalog => {
  const rows = fixtureKevRows();
  return { catalogVersion: "2026.10.14", dateReleased: "2026-10-14T17:00:00Z", count: rows.length, vulnerabilities: rows.map((r) => kevEntry(r[0], r[1])).reverse() };
};

/** A CVE JSON 5 record for in-memory cases. */
function record(over: { cna?: Record<string, unknown>; adp?: unknown[]; meta?: Record<string, unknown> } = {}): unknown {
  return {
    dataType: "CVE_RECORD",
    dataVersion: "5.2",
    cveMetadata: {
      cveId: "CVE-2026-1000", state: "PUBLISHED", assignerShortName: "example", datePublished: "2026-10-13T10:00:00.000Z",
      dateUpdated: "2026-10-13T11:00:00.000Z", ...over.meta,
    },
    containers: {
      cna: { providerMetadata: { orgId: "x", shortName: "example" }, descriptions: [{ lang: "en", value: "SAMPLE description." }], ...over.cna },
      ...(over.adp ? { adp: over.adp } : {}),
    },
  };
}
const CISA = { orgId: "134c704f-9b21-4f2e-91b3-4a467353bcc0", shortName: "CISA-ADP" };
const v31 = (score: unknown, severity = "HIGH") => ({ cvssV3_1: { version: "3.1", baseScore: score, baseSeverity: severity, vectorString: "CVSS:3.1/AV:N" } });

// ── KEV ──────────────────────────────────────────────────────────────────────────────────────────

describe("KEV: parseKev and kevNoteUrls", () => {
  const kev = () => parseKev(read("kev/known_exploited_vulnerabilities.json"));

  it("reads the fixture catalog: version, release, count and the fields CISA writes", () => {
    const p = kev();
    expect(p.version).toBe("2026.10.13");
    expect(p.newest).toBe("2026-10-13T17:02:11Z");
    expect(p.total).toBe(p.catalog.count);
    expect(p.total).toBe(111);
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    const e = p.entries.find((x) => x.cveID === "CVE-2026-104935")!;
    expect(e).toMatchObject({
      vendorProject: "Ivanti", product: "Connect Secure", dateAdded: "2026-10-13", dueDate: "2026-10-16",
      knownRansomwareCampaignUse: "Unknown", forensicTriage: null, cwes: [],
    });
    expect(kevNoteUrls(e.notes)).toEqual(["https://ivanti.com/ct-sample/cve-2026-104935", "https://nvd.nist.gov/vuln/detail/CVE-2026-104935"]);
  });

  it("drops a key the schema does not know", () => {
    const raw = readJson("kev/known_exploited_vulnerabilities.json") as { vulnerabilities: Record<string, unknown>[] };
    expect(raw.vulnerabilities[0]).toHaveProperty("sampleExtraField");
    const first = kev().entries[0]!;
    expect(Object.keys(first).sort()).toEqual([
      "cveID", "cwes", "dateAdded", "dueDate", "forensicTriage", "knownRansomwareCampaignUse", "notes", "product",
      "requiredAction", "shortDescription", "vendorProject", "vulnerabilityName",
    ]);
  });

  it("keeps forensicTriage when given, upper-cases the id and defaults odd strings", () => {
    const p = parseKev(json({
      catalogVersion: "2026.11.06", dateReleased: "2026-11-06T19:44:45.1797Z", count: 1,
      vulnerabilities: [{ cveID: "cve-2026-19868", dateAdded: "2026-11-06", forensicTriage: "No", vendorProject: 7, cwes: "x" }],
    }));
    expect(p.entries[0]).toMatchObject({ cveID: "CVE-2026-19868", forensicTriage: "No", vendorProject: "", cwes: [] });
  });

  it("classes bad bodies: a wrong count or a bad entry is schema, not JSON parse, no entries empty", () => {
    expect(errorClass(() => parseKev(read("kev/bad-count.json")))).toBe("schema");
    expect(errorClass(() => parseKev(Buffer.from("{ not json")))).toBe("parse");
    const head = { catalogVersion: "v", dateReleased: "2026-10-13T17:02:11Z" };
    expect(errorClass(() => parseKev(json({ ...head, count: 0, vulnerabilities: [] })))).toBe("empty");
    expect(errorClass(() => parseKev(json({ ...head, count: 1, vulnerabilities: [{ cveID: "GHSA-2f8c-wq4h-r7jm", dateAdded: "2026-10-13" }] })))).toBe("schema");
    expect(errorClass(() => parseKev(json({ ...head, count: 1, vulnerabilities: [{ cveID: "CVE-2026-1", dateAdded: "2026-13-01" }] })))).toBe("schema");
    expect(errorClass(() => parseKev(json({ count: 1, vulnerabilities: [kevEntry("CVE-2026-1000", "2026-10-13")] })))).toBe("schema");
  });

  it("splits notes on semicolons and takes the first URL of each part", () => {
    expect(kevNoteUrls("https://vendor.example.com/a ; BOD 26-04: https://www.cisa.gov/x ; no link here ; https://nvd.nist.gov/vuln/detail/CVE-2026-1"))
      .toEqual(["https://vendor.example.com/a", "https://www.cisa.gov/x", "https://nvd.nist.gov/vuln/detail/CVE-2026-1"]);
    expect(kevNoteUrls("")).toEqual([]);
  });
});

describe("KEV: the fixture world", () => {
  it("the served catalog is fixtureKevRows() to 2026-10-13, newest first, with rows from 2023 on", () => {
    const rows = fixtureKevRows();
    const ids = parseKev(read("kev/known_exploited_vulnerabilities.json")).entries.map((e) => e.cveID);
    expect(ids).toEqual(rows.filter((r) => r[1] <= "2026-10-13").reverse().map((r) => r[0]));
    expect(rows[0]![1]).toBe("2023-03-14");
    expect(rows.map((r) => r[0])).toContain(FEED_WORLD.rejoinId);
    expect(rows.filter((r) => r[1] === "2026-10-14")).toHaveLength(4);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]![1] <= rows[i]![1]).toBe(true);
  });

  it("the catalog minus the 2026-10-08 index is the weekday edition's two new ids, in KEV order", () => {
    const catalog = parseKev(read("kev/known_exploited_vulnerabilities.json")).catalog;
    const index = { entries: fixtureKevRows().filter((r) => r[1] <= "2026-10-08") };
    const r = newKevIds({ date: "2026-10-14", catalog, asOf: false, committedMetrics: null, kevIndex: index });
    expect(r.source).toBe("kev-index");
    expect(r.newKevIds).toEqual(["CVE-2026-96951", "CVE-2026-104935"]);
    expect(new Set(r.newKevIds)).toEqual(new Set(EDITIONS.weekday.kev.newIds));
  });
});

describe("KEV: newKevIds and kevBaseline", () => {
  const catalog = parseKev(read("kev/known_exploited_vulnerabilities.json")).catalog;
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ct-kev-"));
  const writeFile = (dir: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const indexFile = (upTo: string) => JSON.stringify({
    schema_version: 1, updated_at: "2026-10-11", catalog_version: "2026.10.08", entries: fixtureKevRows().filter((r) => r[1] <= upTo),
  });

  it("as-of: a 2026-10-14 run cuts the catalog to 2026-10-13 and returns the 2026-10-13 entries", () => {
    const r = newKevIds({ date: "2026-10-14", catalog: fullCatalog(), asOf: true, committedMetrics: null, kevIndex: null });
    expect(r.source).toBe("as-of");
    expect(r.newKevIds).toEqual(["CVE-2026-96951", "CVE-2026-104935"]);
    expect(r.catalog.count).toBe(111);
    expect(r.catalog.vulnerabilities.every((v) => v.dateAdded <= "2026-10-13")).toBe(true);
  });

  it("a committed metrics file for D wins over the index, as written", () => {
    const dir = tmp();
    writeFile(dir, "metrics/2026-10-14.json", JSON.stringify({ kev: { new_since_last_edition: { since_catalog_version: "2026.10.08", cve_ids: ["CVE-2026-104935"] } } }));
    writeFile(dir, "state/kev-index.json", indexFile("2026-10-08"));
    const r = kevBaseline({ contentDir: dir, date: "2026-10-14", catalog, asOf: false });
    expect(r).toMatchObject({ source: "metrics", newKevIds: ["CVE-2026-104935"] });
  });

  it("an unreadable metrics file, or one with kev null, falls through to the index", () => {
    for (const body of ["{ not json", JSON.stringify({ kev: null })]) {
      const dir = tmp();
      writeFile(dir, "metrics/2026-10-14.json", body);
      writeFile(dir, "state/kev-index.json", indexFile("2026-10-08"));
      const r = kevBaseline({ contentDir: dir, date: "2026-10-14", catalog, asOf: false });
      expect(r).toMatchObject({ source: "kev-index", newKevIds: ["CVE-2026-96951", "CVE-2026-104935"] });
    }
  });

  it("with neither file, the entries added on or after cutoff − 6", () => {
    const r = kevBaseline({ contentDir: tmp(), date: "2026-10-14", catalog, asOf: false });
    const from = addDays(dataCutoffFor("2026-10-14"), -6);
    expect(from).toBe("2026-10-06");
    expect(r.source).toBe("recent-7-days");
    expect(r.newKevIds).toEqual(fixtureKevRows().filter((x) => x[1] >= from && x[1] <= "2026-10-13").map((x) => x[0]));
    expect(r.newKevIds.length).toBeGreaterThan(2);
  });

  it("an index that does not parse counts as absent", () => {
    const dir = tmp();
    writeFile(dir, "state/kev-index.json", JSON.stringify({ schema_version: 1, entries: [] }));
    expect(kevBaseline({ contentDir: dir, date: "2026-10-14", catalog, asOf: false }).source).toBe("recent-7-days");
  });

  it("rejects an invalid date", () => {
    expect(() => newKevIds({ date: "2026-10-32", catalog, asOf: false, committedMetrics: null, kevIndex: null })).toThrow();
    expect(() => kevBaseline({ contentDir: tmp(), date: "14 Oct", catalog, asOf: false })).toThrow();
  });
});

// ── CVE List ─────────────────────────────────────────────────────────────────────────────────────

describe("deltaLog.json", () => {
  it("reads the fixture: four fetches, newest first, the newest fetchTime", () => {
    const p = parseDeltaLog(read("cvelist/deltaLog.json"));
    expect(p.total).toBe(4);
    expect(p.newest).toBe("2026-10-13T20:13:21.512Z");
    expect(p.entries[0]!.fetchTime).toBe("2026-10-13T20:13:21.512Z");
    expect(p.entries[1]!.updated[0]).toMatchObject({ cveId: "CVE-2026-104935", dateUpdated: "2026-10-13T19:58:23.946Z" });
  });

  it("classes bad bodies", () => {
    expect(errorClass(() => parseDeltaLog(Buffer.from("[")))).toBe("parse");
    expect(errorClass(() => parseDeltaLog(json({ fetchTime: "x" })))).toBe("schema");
    expect(errorClass(() => parseDeltaLog(json([{ numberOfChanges: 1 }])))).toBe("schema");
    expect(errorClass(() => parseDeltaLog(json([])))).toBe("empty");
  });

  it("defaults missing lists to empty", () => {
    const p = parseDeltaLog(json([{ fetchTime: "2026-10-13T20:13:21.512Z" }]));
    expect(p.entries[0]).toMatchObject({ new: [], updated: [], error: [] });
  });
});

describe("zip: readZip and parseDeltaZip", () => {
  const name = (id: string) => `deltaCves/${id}.json`;

  it("computes the zip CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it("round-trips stored and deflated entries", () => {
    const big = JSON.stringify({ text: "SAMPLE ".repeat(2000) });
    const buf = makeZip([{ name: name("CVE-2026-1000"), data: '{"a":1}' }, { name: name("CVE-2026-1001"), data: big, method: 8 }]);
    const entries = readZip(buf);
    expect(entries.map((e) => [e.name, e.method, e.size])).toEqual([[name("CVE-2026-1000"), 0, 7], [name("CVE-2026-1001"), 8, big.length]]);
    expect(entries[1]!.data.toString()).toBe(big);
    expect(parseDeltaZip(buf).records).toEqual([{ a: 1 }, { text: "SAMPLE ".repeat(2000) }]);
  });

  it("refuses a CRC mismatch, zip64, method 12, encryption and a wrong size", () => {
    const e = { name: name("CVE-2026-1000"), data: '{"a":1}' };
    expect(errorClass(() => readZip(makeZip([{ ...e, crc: 1 }])))).toBe("schema");
    expect(errorClass(() => readZip(makeZip([e], { zip64Locator: true })))).toBe("schema");
    expect(errorClass(() => readZip(makeZip([e], { count: 0xffff })))).toBe("schema");
    expect(errorClass(() => readZip(makeZip([{ ...e, method: 12 }])))).toBe("schema");
    expect(errorClass(() => readZip(makeZip([{ ...e, flags: 0x0801 }])))).toBe("schema");
    expect(errorClass(() => readZip(makeZip([{ ...e, size: 6 }])))).toBe("schema");
  });

  it("stops an entry or a total over its cap, deflated or not", () => {
    const e = { name: name("CVE-2026-1000"), data: "x".repeat(5000) };
    expect(errorClass(() => readZip(makeZip([e]), { maxEntryBytes: 1000 }))).toBe("schema");
    expect(errorClass(() => readZip(makeZip([{ ...e, method: 8, size: 100 }]), { maxEntryBytes: 1000 }))).toBe("schema");
    expect(errorClass(() => readZip(makeZip([e, { ...e, name: name("CVE-2026-1001") }]), { maxTotalBytes: 6000 }))).toBe("schema");
    expect(readZip(makeZip([e]), { maxEntryBytes: 5000 })).toHaveLength(1);
  });

  it("says parse for bytes that are not a zip", () => {
    expect(errorClass(() => readZip(Buffer.from("PK")))).toBe("parse");
    expect(errorClass(() => readZip(Buffer.from("SAMPLE: not a zip at all, but long enough to search")))).toBe("parse");
  });

  it("ignores names outside deltaCves/CVE-*.json and says parse for a record that is not JSON", () => {
    const buf = makeZip([
      { name: "deltaCves/", data: "" }, { name: "README.md", data: "SAMPLE" }, { name: "deltaCves/notes.txt", data: "x" },
      { name: "other/CVE-2026-1000.json", data: "{}" }, { name: name("CVE-2026-1000"), data: '{"ok":true}' },
    ]);
    expect(parseDeltaZip(buf)).toEqual({ records: [{ ok: true }], names: [name("CVE-2026-1000")] });
    expect(errorClass(() => parseDeltaZip(makeZip([{ name: name("CVE-2026-1000"), data: "{" }])))).toBe("parse");
  });

  it("decodes names as UTF-8 under flag 0x0800 and as Latin-1 without it", () => {
    expect(readZip(makeZip([{ name: "é.json", data: "{}" }]))[0]!.name).toBe("é.json");
    expect(readZip(makeZip([{ name: "é.json", data: "{}", flags: 0 }]))[0]!.name).toBe("Ã©.json");
  });

  it("reads storedZip()'s output: stored, flag 0x0800, DOS date 1980-01-01, entries in order", () => {
    const buf = storedZip([{ name: name("CVE-2026-2"), data: Buffer.from("{}") }, { name: name("CVE-2026-1"), data: Buffer.from("[]") }]);
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(buf.readUInt16LE(6)).toBe(0x0800);
    expect(buf.readUInt16LE(8)).toBe(0);
    expect([buf.readUInt16LE(10), buf.readUInt16LE(12)]).toEqual([0, 0x0021]);
    expect(readZip(buf).map((e) => [e.name, e.method])).toEqual([[name("CVE-2026-2"), 0], [name("CVE-2026-1"), 0]]);
    expect(storedZip([]).length).toBe(22);
  });
});

describe("parseCveRecord: CVSS precedence and scoring", () => {
  const cvss = (raw: unknown) => parseCveRecord(raw)!.cvss;

  it("takes CNA v4.0, then CNA v3.1, then CNA v3.0, then CISA ADP v3.1", () => {
    const v40 = { cvssV4_0: { version: "4.0", baseScore: 9.3, baseSeverity: "CRITICAL", vectorString: "CVSS:4.0/AV:N" } };
    const v30 = { cvssV3_0: { version: "3.0", baseScore: 6.1, baseSeverity: "MEDIUM", vectorString: "CVSS:3.0/AV:N" } };
    const adp = [{ providerMetadata: CISA, metrics: [v31(9.8, "CRITICAL")] }];
    expect(cvss(record({ cna: { metrics: [v31(7.5), v40] }, adp }))).toMatchObject({ version: "4.0", score: 9.3, scorer: "cna" });
    expect(cvss(record({ cna: { metrics: [v30, v31(7.5)] }, adp }))).toMatchObject({ version: "3.1", score: 7.5, scorer: "cna" });
    expect(cvss(record({ cna: { metrics: [v30] }, adp }))).toMatchObject({ version: "3.0", score: 6.1, scorer: "cna" });
    expect(cvss(record({ cna: { metrics: [{ cvssV2_0: { baseScore: 10 } }] }, adp }))).toEqual({ version: "3.1", score: 9.8, scorer: "cisa_adp", vector: "CVSS:3.1/AV:N" });
  });

  it("scored: a numeric baseScore under v4.0, v3.1 or v3.0 in the CNA or a CISA-ADP entry, nothing else", () => {
    const scored = (raw: unknown) => cveFacts(raw)!.scored;
    expect(scored(record({ cna: { metrics: [v31(5)] } }))).toBe(true);
    expect(scored(record({ adp: [{ providerMetadata: CISA, metrics: [v31(5)] }] }))).toBe(true);
    expect(scored(record({ adp: [{ providerMetadata: { shortName: "Other-ADP" }, metrics: [v31(5)] }] }))).toBe(false);
    expect(scored(record({ cna: { metrics: [{ cvssV2_0: { baseScore: 5 } }] } }))).toBe(false);
    expect(scored(record({ cna: { metrics: [v31("5.0")] } }))).toBe(false);
    expect(scored(record({ cna: { metrics: [{ other: { type: "Textual description of severity", content: { text: "moderate" } } }] } }))).toBe(false);
  });

  it("reads the fixture cases: CNA v4.0, v3.0 beside v4.0, ADP only, unscored and a textual severity", () => {
    const at = (rel: string) => parseCveRecord(readJson(rel))!;
    expect(at("cvelist/src/eod-2026-10-12/CVE-2026-53997.json").cvss).toMatchObject({ version: "4.0", score: 9.1, scorer: "cna" });
    expect(at("cvelist/src/eod-2026-10-12/CVE-2026-53997.json").cna_severity).toBe("CRITICAL");
    expect(at("cvelist/src/hourly-2026-10-13-2000Z/CVE-2026-101020.json").cvss).toMatchObject({ version: "4.0", score: 8.5 });
    expect(at("cvelist/src/eod-2026-10-12/CVE-2026-84167.json")).toMatchObject({ scored: true, cna_severity: null, cvss: { version: "3.1", score: 4.3, scorer: "cisa_adp" } });
    expect(at("cvelist/src/hourly-2026-10-13-2000Z/CVE-2026-52394.json").cvss).toMatchObject({ scorer: "cisa_adp", score: 9.1 });
    expect(at("cvelist/src/eod-2026-10-12/CVE-2026-107248.json")).toMatchObject({ scored: false, cvss: null });
    expect(at("cvelist/src/eod-2026-10-12/CVE-2026-92116.json")).toMatchObject({ scored: false, cvss: null });
    expect(at("cvelist/src/eod-2026-10-12/CVE-2026-98385.json")).toMatchObject({ assigner: "Linux", affected: [{ vendor: "Linux", product: "Linux" }] });
  });
});

describe("parseCveRecord: SSVC, KEV marker, credits, dates, states and references", () => {
  it("lower-cases the SSVC options and dates them; all three options are needed", () => {
    const ssvc = (options: unknown[], timestamp = "2026-10-13T15:42:16.582526Z") => parseCveRecord(record({
      adp: [{ providerMetadata: CISA, metrics: [{ other: { type: "ssvc", content: { timestamp, options } } }] }],
    }))!.ssvc;
    expect(ssvc([{ Exploitation: "Active" }, { Automatable: "YES" }, { "Technical Impact": "Total" }]))
      .toEqual({ exploitation: "active", automatable: "yes", technical_impact: "total", date: "2026-10-13" });
    expect(ssvc([{ Exploitation: "none" }, { Automatable: "no" }])).toBeNull();
    expect(ssvc([{ Exploitation: "none" }, { Automatable: "no" }, { "Technical Impact": "partial" }], "not a date")).toBeNull();
    expect(parseCveRecord(readJson("cvelist/src/hourly-2026-10-13-2000Z/CVE-2026-104935.json"))!.ssvc)
      .toEqual({ exploitation: "active", automatable: "yes", technical_impact: "total", date: "2026-10-13" });
  });

  it("reads the KEV marker from the CISA-ADP entry only", () => {
    expect(parseCveRecord(readJson("cvelist/src/hourly-2026-10-13-2000Z/CVE-2026-104935.json"))!.kev_marker).toBe("2026-10-13");
    expect(parseCveRecord(readJson("cvelist/patch-tuesday/CVE-2026-96951.json"))!.kev_marker).toBeNull();
    const other = { providerMetadata: { shortName: "Other-ADP" }, metrics: [{ other: { type: "kev", content: { dateAdded: "2026-10-01" } } }] };
    expect(parseCveRecord(record({ adp: [other] }))!.kev_marker).toBeNull();
  });

  it("keeps credits raw, by field, CNA first then each ADP entry in order", () => {
    const facts = cveFacts(record({
      cna: { credits: [{ lang: "en", value: "SAMPLE Researcher" }, { lang: "en", value: "  Claude (Anthropic)  " }, { value: 7 }] },
      adp: [{ providerMetadata: CISA, credits: [{ value: "SAMPLE ADP one" }] }, { providerMetadata: { shortName: "X" }, credits: [{ value: "SAMPLE ADP two" }] }],
    }))!;
    expect(facts.credits).toEqual([
      { field: "cna.credits", value: "SAMPLE Researcher" }, { field: "cna.credits", value: "  Claude (Anthropic)  " },
      { field: "adp.credits", value: "SAMPLE ADP one" }, { field: "adp.credits", value: "SAMPLE ADP two" },
    ]);
    expect(cveFacts(readJson("cvelist/src/eod-2026-10-12/CVE-2026-103658.json"))!.credits.map((c) => c.value)).toEqual(["Anthropic, Claude", "Ada Logics"]);
  });

  it("reads zone-less timestamps as UTC from their own fields", () => {
    const r = parseCveRecord(readJson("cvelist/src/eod-2026-10-12/CVE-2022-38369.json"))!;
    expect(r.published_at).toBe("2022-09-05T09:50:09.000Z");
    expect(r.date_published).toBe("2022-09-05");
    expect(recordInstant("2022-09-05T23:50:09")).toBe("2022-09-05T23:50:09.000Z");
    expect(recordInstant("2026-10-13T05:00:00+09:00")).toBe("2026-10-12T20:00:00.000Z");
    expect(recordInstant("2026-10-13")).toBe("2026-10-13T00:00:00.000Z");
    expect(recordInstant("2026-10-13T24:00:00")).toBeNull();
    expect(recordInstant(17)).toBeNull();
  });

  it("gives the same results for CVE-2022-38369 and CVE-2022-38370 under TZ=Asia/Taipei", () => {
    const files = ["cvelist/src/eod-2026-10-12/CVE-2022-38369.json", "cvelist/src/eod-2026-10-12/CVE-2022-38370.json"];
    const run = () => files.map((f) => {
      const raw = readJson(f);
      return { record: parseCveRecord(raw), facts: cveFacts(raw), info: cveRecordInfo(raw) };
    });
    const utc = withTz("UTC", run);
    const taipei = withTz("Asia/Taipei", () => {
      expect(new Date(Date.UTC(2022, 8, 5)).getTimezoneOffset()).toBe(-480);
      return run();
    });
    expect(taipei).toEqual(utc);
    expect(utc.map((x) => x.record!.published_at)).toEqual(["2022-09-05T09:50:09.000Z", "2022-09-05T09:50:10.000Z"]);
    expect(utc.map((x) => x.info!.date_published)).toEqual(["2022-09-05", "2022-09-05"]);
  });

  it("reads a REJECTED record and returns null without a readable cveMetadata", () => {
    const r = parseCveRecord(readJson("cvelist/src/eod-2026-10-12/CVE-2026-104710.json"))!;
    expect(r).toMatchObject({ state: "REJECTED", date_published: null, published_at: null, scored: false, cvss: null, title: null, description: null, affected: [] });
    expect(r.date_updated).toBe("2026-10-12");
    expect(parseCveRecord({})).toBeNull();
    expect(cveFacts({ cveMetadata: { cveId: "GHSA-2f8c-wq4h-r7jm", state: "PUBLISHED" } })).toBeNull();
    expect(cveFacts({ cveMetadata: { cveId: "cve-2026-1000", state: "PUBLISHED" } })!.cve_id).toBe("CVE-2026-1000");
  });

  it("flags an exploit-tagged reference from the CNA or an ADP", () => {
    const tagged = [{ url: "https://example.com/ct-sample/exploit", tags: ["exploit"] }];
    expect(parseCveRecord(record({ cna: { references: tagged } }))!.exploit_reference).toBe(true);
    expect(parseCveRecord(record({ adp: [{ providerMetadata: CISA, references: tagged }] }))!.exploit_reference).toBe(true);
    expect(parseCveRecord(record({ cna: { references: [{ url: "https://example.com/ct-sample/a", tags: ["patch"] }] } }))!.exploit_reference).toBe(false);
  });

  it("recordAdvisoryUrls keeps https advisory links, normalised, at most 5, and drops the rest", () => {
    const refs = [
      { url: "https://vendor.example.com/advisory/1", tags: ["vendor-advisory"] },
      { url: "https://example.com/ct-sample/exploit", tags: ["exploit", "vendor-advisory"] },
      { url: "https://pastebin.com/", tags: ["third-party-advisory"] },
      { url: "https://github.com/example/example", tags: ["patch"] },
      { url: "http://vendor.example.com/advisory/2", tags: ["patch"] },
      { url: `https://vendor.example.com/${"a".repeat(500)}`, tags: ["patch"] },
      { url: "https://vendor.example.com/advisory/1?utm_source=feed", tags: ["patch"] },
      { url: "https://example.org/ct-sample/untagged", tags: ["x_refsource_MISC"] },
      ...[3, 4, 5, 6, 7].map((n) => ({ url: `https://vendor.example.com/advisory/${n}`, tags: ["patch"] })),
    ];
    const urls = recordAdvisoryUrls(parseCveRecord(record({ cna: { references: refs } }))!, TIERS);
    expect(urls).toEqual([1, 3, 4, 5, 6].map((n) => `https://vendor.example.com/advisory/${n}`));
    const adpFirst = parseCveRecord(record({
      cna: { references: [{ url: "https://vendor.example.com/a", tags: ["patch"] }] },
      adp: [{ providerMetadata: CISA, references: [{ url: "https://cert.example.org/b", tags: ["third-party-advisory"] }] }],
    }))!;
    expect(recordAdvisoryUrls(adpFirst, TIERS)).toEqual(["https://vendor.example.com/a", "https://cert.example.org/b"]);
  });
});

// ── The three agreement checks ───────────────────────────────────────────────────────────────────

describe("agreement: cveFacts, parseCveRecord and P1's cveRecordInfo", () => {
  const files = [
    ...fs.readdirSync(path.join(ROOT, "fixtures", "cvelist", "records")).filter((f) => RECORD_FILE.test(f)).map((f) => path.join(ROOT, "fixtures", "cvelist", "records", f)),
    ...feedRecordFiles().map((f) => path.join(FEEDS, f)),
  ];
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => x !== null && x.trim() !== "").map((x) => x.trim()))];

  it("covers every record file: P1's five and the 51 static feed records", () => {
    expect(files.length - feedRecordFiles().length).toBe(5);
    expect(feedRecordFiles()).toHaveLength(18 + 21 + 9 + 3);
  });

  it.each(files.map((f) => [path.relative(ROOT, f), f]))("%s", (_rel, file) => {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const facts = cveFacts(raw);
    const rec = parseCveRecord(raw);
    const info = cveRecordInfo(raw);
    expect(facts).not.toBeNull();
    expect(rec).not.toBeNull();
    expect(info).not.toBeNull();
    const part: CveFacts = {
      cve_id: rec!.cve_id, state: rec!.state, date_published: rec!.date_published, assigner: rec!.assigner,
      scored: rec!.scored, credits: rec!.credits, affected: rec!.affected,
    };
    expect(part).toEqual(facts);
    expect(path.basename(file, ".json")).toBe(facts!.cve_id);
    expect(info!.cve_id).toBe(facts!.cve_id);
    expect(info!.state).toBe(facts!.state);
    expect(info!.date_published).toBe(facts!.date_published);
    expect(info!.date_updated).toBe(rec!.date_updated);
    expect(info!.assigner).toBe(facts!.assigner);
    expect(info!.vendors).toEqual(uniq(facts!.affected.map((a) => a.vendor)));
    expect(info!.products).toEqual(uniq(facts!.affected.map((a) => a.product)));
    expect(info!.exploit_reference).toBe(rec!.exploit_reference);
    expect(info!.kev_date_added).toBe(rec!.kev_marker);
    expect(info!.credits).toEqual(uniq(facts!.credits.map((c) => c.value)));
    if (rec!.title !== null) expect(info!.title).toBe(rec!.title.trim());
  });
});

describe("agreement: the generated feed fixtures", () => {
  const same = (a: ReturnType<typeof feedOutputs>, b: ReturnType<typeof feedOutputs>) => {
    expect(a.map((o) => o.path)).toEqual(b.map((o) => o.path));
    a.forEach((o, i) => {
      const p = b[i]!;
      if ("bytes" in o && "bytes" in p) expect(o.bytes.equals(p.bytes)).toBe(true);
      else if ("text" in o && "text" in p) expect(o.text).toBe(p.text);
      else throw new Error(`${o.path}: text in one run and bytes in the other`);
    });
  };

  it("two feedOutputs() calls give identical bytes", () => {
    same(feedOutputs(), feedOutputs());
  });

  it("the committed files are feedOutputs()'s output", () => {
    const outs = feedOutputs();
    expect(outs.map((o) => o.path)).toEqual([KEV_CATALOG_PATH, KEV_BAD_COUNT_PATH, EOD_ZIP_PATH, HOURLY_ZIP_PATH]);
    for (const o of outs) {
      const disk = fs.readFileSync(path.join(ROOT, o.path));
      if ("bytes" in o) expect(disk.equals(o.bytes)).toBe(true);
      else expect(disk.toString("utf8")).toBe(o.text);
    }
  });

  it("the bad-count catalog differs from the served one in count only", () => {
    const good = readJson("kev/known_exploited_vulnerabilities.json") as { count: number };
    const bad = readJson("kev/bad-count.json") as { count: number };
    expect(bad).toEqual({ ...good, count: good.count + 1 });
    expect(fixtureKevCatalog()).toEqual(good);
  });
});

// ── The delta-zip fixtures ───────────────────────────────────────────────────────────────────────

describe("the fixture delta zips", () => {
  const zip = (p: string) => parseDeltaZip(fs.readFileSync(path.join(ROOT, p)));
  const meta = (r: unknown) => (r as { cveMetadata: { cveId: string; dateUpdated: string; datePublished?: string } }).cveMetadata;

  it("hold deltaCves/<id>.json entries sorted by id, one per static record", () => {
    for (const [p, which] of [[EOD_ZIP_PATH, "eod"], [HOURLY_ZIP_PATH, "hourly"]] as const) {
      const z = zip(p);
      const ids = z.records.map((r) => meta(r).cveId);
      expect(z.names).toEqual(ids.map((id) => `deltaCves/${id}.json`));
      expect([...ids].sort(compareCveIds)).toEqual(ids);
      const files = ZIP_SOURCES[which].flatMap((d) => fs.readdirSync(path.join(FEEDS, "cvelist", d)).filter((f) => RECORD_FILE.test(f)));
      expect(ids.length).toBe(files.length);
    }
    expect(zip(EOD_ZIP_PATH).names).toHaveLength(18);
    expect(zip(HOURLY_ZIP_PATH).names).toHaveLength(30);
  });

  it("each record changed inside its zip's period: 2026-10-12 for end of day, 2026-10-13 to 20:00 UTC for the hourly", () => {
    for (const r of zip(EOD_ZIP_PATH).records) expect(meta(r).dateUpdated.slice(0, 10)).toBe("2026-10-12");
    for (const r of zip(HOURLY_ZIP_PATH).records) {
      const t = Date.parse(meta(r).dateUpdated);
      expect(t).toBeGreaterThanOrEqual(Date.parse("2026-10-13T00:00:00Z"));
      expect(t).toBeLessThanOrEqual(Date.parse("2026-10-13T20:00:00Z"));
    }
  });

  it("CVE-2026-108917 is in both, the hourly copy updated later and carrying CISA's update", () => {
    const pick = (p: string) => zip(p).records.map((r) => parseCveRecord(r)!).find((r) => r.cve_id === "CVE-2026-108917")!;
    const x = pick(EOD_ZIP_PATH);
    const x1 = pick(HOURLY_ZIP_PATH);
    expect(Date.parse(x1.updated_at!)).toBeGreaterThan(Date.parse(x.updated_at!));
    expect(x.ssvc).toBeNull();
    expect(x1.ssvc).toMatchObject({ exploitation: "poc", automatable: "yes", technical_impact: "total" });
  });

  it("the P1 records are world.ts's cveRecord(), the end-of-day CVE-2026-108917 before CISA's update", () => {
    for (const rel of ["src/hourly-2026-10-13-2000Z/CVE-2026-104935.json", "src/hourly-2026-10-13-2000Z/CVE-2026-108917.json",
      "src/hourly-2026-10-13-2000Z/CVE-2026-110036.json", "patch-tuesday/CVE-2026-96951.json", "by-id/CVE-2026-104935.json", "by-id/CVE-2026-96951.json"]) {
      expect(readJson(`cvelist/${rel}`)).toEqual(cveRecord(path.basename(rel, ".json")));
    }
    const eod = cveRecord("CVE-2026-108917") as { cveMetadata: Record<string, string>; containers: Record<string, unknown> };
    const { adp: _adp, ...containers } = eod.containers;
    expect(readJson("cvelist/src/eod-2026-10-12/CVE-2026-108917.json")).toEqual({
      ...eod, cveMetadata: { ...eod.cveMetadata, dateUpdated: eod.cveMetadata.datePublished }, containers,
    });
  });

  it("cover F §8's cases", () => {
    const recs = [...zip(EOD_ZIP_PATH).records, ...zip(HOURLY_ZIP_PATH).records].map((r) => parseCveRecord(r)!);
    const some = (f: (r: (typeof recs)[number]) => boolean) => expect(recs.some(f)).toBe(true);
    some((r) => r.cvss?.version === "4.0" && r.cvss.scorer === "cna");
    some((r) => r.cvss?.version === "3.1" && r.cvss.scorer === "cna");
    some((r) => r.cvss?.scorer === "cisa_adp");
    some((r) => r.state === "PUBLISHED" && !r.scored);
    some((r) => r.assigner === "Linux");
    some((r) => r.ssvc?.automatable === "yes" && r.ssvc.technical_impact === "total");
    some((r) => r.kev_marker !== null);
    some((r) => r.credits.some((c) => /\b(?:Claude|AISLE)\b/.test(c.value)));
    some((r) => r.affected.some((a) => a.vendor === "Edimax" || a.vendor === "D-Link"));
    some((r) => r.assigner === "jpcert");
    some((r) => r.state === "REJECTED");
    some((r) => r.published_at === "2022-09-05T09:50:09.000Z");
    some((r) => r.date_published !== null && r.date_published < "2026-10-12" && r.date_updated === "2026-10-13");
  });

  it("the Patch Tuesday records: Microsoft, published 2026-10-13, at least 8, one on KEV, CRITICAL among them", () => {
    const dir = path.join(FEEDS, "cvelist", "patch-tuesday");
    const recs = fs.readdirSync(dir).map((f) => parseCveRecord(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))!);
    expect(recs.length).toBeGreaterThanOrEqual(8);
    for (const r of recs) expect(r).toMatchObject({ assigner: "microsoft", date_published: "2026-10-13" });
    expect(recs.map((r) => r.cna_severity)).toContain("CRITICAL");
    const kev = new Set(parseKev(read("kev/known_exploited_vulnerabilities.json")).entries.map((e) => e.cveID));
    expect(recs.filter((r) => kev.has(r.cve_id)).map((r) => r.cve_id)).toEqual(["CVE-2026-96951"]);
  });

  it("by-id holds the two new KEV records and the re-join record", () => {
    expect(fs.readdirSync(path.join(FEEDS, "cvelist", "by-id")).sort()).toEqual(
      [...EDITIONS.weekday.kev.newIds, FEED_WORLD.rejoinId].map((id) => `${id}.json`).sort());
    expect(parseCveRecord(readJson(`cvelist/by-id/${FEED_WORLD.rejoinId}.json`))).toMatchObject({ state: "PUBLISHED", date_published: "2024-07-09", assigner: "microsoft" });
  });
});

describe("fixture safety under fixtures/feeds", () => {
  const NAMESPACES = /^http:\/\/(?:purl\.org|www\.w3\.org|jvn\.jp\/rss|data-marking\.mitre\.org|jvndb\.jvn\.jp\/myjvn|www\.us-cert\.gov\/tlp)\//;
  const URL_RE = /https?:\/\/[^\s"'<>\\)]+/g;
  const textFiles = () => walk(FEEDS).filter((f) => !/\.(?:zip|gz)$/.test(f));

  it("every link is https (or an XML namespace), on no blocked host, and records link only to ct-sample or the KEV page", () => {
    for (const f of textFiles()) {
      for (const u of fs.readFileSync(path.join(FEEDS, f), "utf8").replace(/&amp;/g, "&").match(URL_RE) ?? []) {
        if (u.startsWith("http://")) {
          expect(u, f).toMatch(NAMESPACES);
          continue;
        }
        const cvelistRaw = f === "cvelist/deltaLog.json" && u.startsWith("https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/");
        // collect's fixture index maps the registry's own fetch URLs (tests/registry.test.ts pins them).
        const indexFetch = /^index(?:-degraded)?\.json$/.test(f)
          && /^https:\/\/(?:raw\.githubusercontent\.com|github\.com)\/(?:CVEProject\/cvelistV5|cisagov\/kev-data)\//.test(u);
        if (!cvelistRaw && !indexFetch) expect(blockedReason(u, TIERS), `${f}: ${u}`).toBeNull();
        if (RECORD_FILE.test(f)) expect(u, f).toMatch(/^https:\/\/[a-z0-9.-]+\/ct-sample\/[a-z0-9-]+$|^https:\/\/www\.cisa\.gov\/known-exploited-vulnerabilities-catalog\?field_cve=CVE-\d{4}-\d+$/);
      }
    }
  });

  it("record credits name no person: SAMPLE Researcher or an organisation or tool", () => {
    const allowed = new Set(["WPScan", "Anthropic, Claude", "Ada Logics", "MopMonk AI", "Wordfence PRISM",
      "This issue was discovered by Found by AISLE in partnership with Red Hat.", "Security Research Center (SRC) @ Concordia University"]);
    for (const f of feedRecordFiles()) {
      for (const c of cveFacts(readJson(f))!.credits) {
        if (!c.value.includes("SAMPLE Researcher")) expect(allowed.has(c.value), `${f}: ${c.value}`).toBe(true);
      }
    }
  });

  it("no record keeps an exploit-tagged reference", () => {
    for (const f of feedRecordFiles()) expect(parseCveRecord(readJson(f))!.exploit_reference, f).toBe(false);
  });
});

// ── EPSS ─────────────────────────────────────────────────────────────────────────────────────────

describe("EPSS", () => {
  const day = (d: string) => parseEpssCsv(read(`epss/epss_scores-${d}.csv.gz`)).day;
  const gz = (text: string) => zlib.gzipSync(Buffer.from(text));
  const HEAD = "#model_version:v2026.06.15,score_date:2026-10-13T12:00:21Z\ncve,epss,percentile\n";

  it("reads the first line, the header and the rows", () => {
    const p = parseEpssCsv(read("epss/epss_scores-2026-10-13.csv.gz"));
    expect(p).toMatchObject({ version: "v2026.06.15", newest: "2026-10-13T12:00:21Z", total: 62, entries: [] });
    expect(p.day.scores.get("CVE-2023-34362")).toEqual({ epss: 0.944, percentile: 0.9988 });
    expect(p.day.model_version).toBe("v2026.06.15");
  });

  it("skips bad rows and classes bad bodies", () => {
    const p = parseEpssCsv(gz(`${HEAD}not-a-cve,0.1,0.2\nCVE-2026-1000,2,0.5\ncve-2026-1001,0.10000,0.50000\n\n`));
    expect([...p.day.scores.keys()]).toEqual(["CVE-2026-1001"]);
    expect(errorClass(() => parseEpssCsv(Buffer.from("cve,epss,percentile\n")))).toBe("parse");
    expect(errorClass(() => parseEpssCsv(gz("cve,epss,percentile\nCVE-2026-1000,0.1,0.5\n")))).toBe("schema");
    expect(errorClass(() => parseEpssCsv(gz("#model_version:v1\ncve,epss,percentile\nCVE-2026-1000,0.1,0.5\n")))).toBe("schema");
    expect(errorClass(() => parseEpssCsv(gz("#model_version:v1,score_date:2026-10-13T00:00:00Z\ncve,score\nCVE-2026-1000,0.1\n")))).toBe("schema");
    expect(errorClass(() => parseEpssCsv(gz(HEAD)))).toBe("empty");
  });

  it("stops gunzip at 200 MB", () => {
    const member = zlib.gzipSync(Buffer.alloc(1024 * 1024));
    const bomb = Buffer.concat(Array.from({ length: 201 }, () => member));
    expect(errorClass(() => parseEpssCsv(bomb))).toBe("parse");
  });

  it("builds dated CSV URLs and API batches", () => {
    expect(epssUrlFor("https://epss.empiricalsecurity.com/epss_scores-current.csv.gz", "2026-10-13"))
      .toBe("https://epss.empiricalsecurity.com/epss_scores-2026-10-13.csv.gz");
    expect(epssUrlFor("https://epss.example.com/epss_scores-2026-10-12.csv.gz", "2026-10-06")).toBe("https://epss.example.com/epss_scores-2026-10-06.csv.gz");
    expect(epssUrlFor("https://epss.example.com/{date}/scores.csv.gz", "2026-10-06")).toBe("https://epss.example.com/2026-10-06/scores.csv.gz");
    expect(() => epssUrlFor("https://epss.example.com/scores.csv", "2026-10-06")).toThrow();
    expect(() => epssUrlFor("https://epss.empiricalsecurity.com/epss_scores-current.csv.gz", "2026-13-01")).toThrow();
    const ids = Array.from({ length: 250 }, (_, i) => `cve-2026-${10000 + i}`);
    const urls = epssApiUrls("https://api.first.org/data/v1/epss", [...ids, ids[0]!, "not-a-cve"]);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe(`https://api.first.org/data/v1/epss?cve=${ids.slice(0, 100).map((c) => c.toUpperCase()).join(",")}`);
    expect(urls[2]!.split("=")[1]!.split(",")).toHaveLength(50);
    expect(epssApiUrls("https://api.first.org/data/v1/epss?envelope=true", ["CVE-2026-1000"])).toEqual(["https://api.first.org/data/v1/epss?envelope=true&cve=CVE-2026-1000"]);
  });

  it("reads the API answer, string or number values", () => {
    const m = parseEpssApi(read("epss/api-batch.json"));
    expect(m.get("CVE-2023-34362")).toEqual({ epss: 0.944, percentile: 0.9988, date: "2026-10-13" });
    expect(m.size).toBe(3);
    expect(parseEpssApi(json({ data: [{ cve: "cve-2026-1000", epss: 0.5, percentile: 0.9 }] })).get("CVE-2026-1000")).toEqual({ epss: 0.5, percentile: 0.9, date: "" });
    expect(errorClass(() => parseEpssApi(Buffer.from("<html>")))).toBe("parse");
    expect(errorClass(() => parseEpssApi(json({ status: "OK" })))).toBe("schema");
  });

  it("jumps: crossed 0.99 on the percentile, rose by 0.10 or more, both, neither, and no E − 1", () => {
    const e = day("2026-10-13");
    const e1 = day("2026-10-12");
    expect(epssJump(e, e1, "CVE-2024-21762")).toEqual({ crossed: true, rose: false, change_24h: 0.03 });
    expect(epssJump(e, e1, "CVE-2024-38112")).toEqual({ crossed: false, rose: true, change_24h: 0.14 });
    expect(epssJump(e, e1, "cve-2023-34362")).toEqual({ crossed: true, rose: true, change_24h: 0.464 });
    expect(epssJump(e, e1, "CVE-2023-23397")).toEqual({ crossed: false, rose: true, change_24h: 0.1 });
    expect(epssJump(e, e1, "CVE-2020-9287")).toEqual({ crossed: false, rose: false, change_24h: 0.09999 });
    expect(epssJump(e, e1, "CVE-2026-104935")).toEqual({ crossed: false, rose: false, change_24h: null });
    expect(epssJump(e, null, "CVE-2024-21762")).toEqual({ crossed: false, rose: false, change_24h: null });
  });

  it("movers: the five largest rises from E − 7 among scores of 0.10 or more, ties by id", () => {
    const movers = epssMovers(day("2026-10-13"), day("2026-10-06"));
    expect(movers.map((m) => [m.cve_id, m.delta_7d])).toEqual([
      ["CVE-2023-34362", 0.544], ["CVE-2024-38112", 0.43], ["CVE-2023-23397", 0.2], ["CVE-2023-41179", 0.2], ["CVE-2026-106016", 0.15],
    ]);
    expect(movers[0]).toEqual({ cve_id: "CVE-2023-34362", score: 0.944, delta_7d: 0.544, percentile: 0.9988 });
  });
});

// ── GHSA, NVD, MyJVN ─────────────────────────────────────────────────────────────────────────────

describe("GHSA", () => {
  const dir = path.join(FEEDS, "ghsa", "repo", "advisories", "github-reviewed");
  const files = walk(dir).filter((f) => f.endsWith(".json"));
  const byId = new Map(files.map((f) => {
    const a = parseGhsa(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))!;
    return [a.id, { a, f }] as const;
  }));

  it("reads the five fixture advisories, each in its published month's folder", () => {
    expect(byId.size).toBe(5);
    for (const { a, f } of byId.values()) {
      expect(f).toBe(`${a.published.slice(0, 4)}/${a.published.slice(5, 7)}/${a.id}/${a.id}.json`);
      expect(a.reviewed).toBe(true);
    }
  });

  it("a CRITICAL advisory with a CVE alias that a fixture record holds, one without, a withdrawn one, a fixed MODERATE and an old one", () => {
    expect(byId.get("GHSA-2f8c-wq4h-r7jm")!.a).toMatchObject({ severity: "CRITICAL", cve_ids: ["CVE-2026-107460"], fixed: false, withdrawn: null,
      packages: [{ ecosystem: "Maven", name: "org.apache.fesod:fesod-sheet" }] });
    expect(fs.existsSync(path.join(FEEDS, "cvelist", "src", "hourly-2026-10-13-2000Z", "CVE-2026-107460.json"))).toBe(true);
    expect(byId.get("GHSA-3g9h-x4jp-v6qw")!.a).toMatchObject({ severity: "CRITICAL", cve_ids: [], fixed: false });
    expect(byId.get("GHSA-4hcj-5m6p-q7r8")!.a.withdrawn).toBe("2026-10-13T12:00:03.000Z");
    expect(byId.get("GHSA-5jmp-7q8r-9v2w")!.a).toMatchObject({ severity: "MODERATE", fixed: true });
    expect(byId.get("GHSA-6mpq-8r9v-2w3c")!.a).toMatchObject({ published: "2026-10-01", modified: "2026-10-13T10:00:00.000Z", fixed: true });
  });

  it("returns null without a GHSA id or a published date, and normalises aliases and severity", () => {
    expect(parseGhsa({ id: "GHSA-0000-0000-0000", published: "2026-10-13T00:00:00Z" })).toBeNull();
    expect(parseGhsa({ id: "GHSA-2f8c-wq4h-r7jm" })).toBeNull();
    expect(parseGhsa(null)).toBeNull();
    const a = parseGhsa({ id: "GHSA-2f8c-wq4h-r7jm", published: "2026-10-13T16:42:10", aliases: ["cve-2026-1000", "CVE-2026-1000", " PYSEC-2026-1 "],
      database_specific: { severity: "high" }, affected: [{ package: { ecosystem: "npm", name: "x" } }, { package: { ecosystem: "npm", name: "x" } }] })!;
    expect(a).toMatchObject({ cve_ids: ["CVE-2026-1000"], aliases: ["cve-2026-1000", "CVE-2026-1000", "PYSEC-2026-1"], severity: "HIGH",
      published_at: "2026-10-13T16:42:10.000Z", modified: "2026-10-13T16:42:10.000Z", reviewed: false, packages: [{ ecosystem: "npm", name: "x" }] });
  });

  it("ghsaIsFixed: a fixed event anywhere; last_affected alone is not fixed", () => {
    expect(ghsaIsFixed({ affected: [{ ranges: [{ events: [{ introduced: "0" }, { last_affected: "1.0" }] }] }] })).toBe(false);
    expect(ghsaIsFixed({ affected: [{ ranges: [{ events: [{ introduced: "0" }] }] }, { ranges: [{ events: [{ fixed: "2.0" }] }] }] })).toBe(true);
    expect(ghsaIsFixed({})).toBe(false);
  });

  it("ghsaMonths spans cutoff − 120 days to cutoff + 1 day", () => {
    expect(ghsaMonths("2026-10-12")).toEqual(["2026/06", "2026/07", "2026/08", "2026/09", "2026/10"]);
    expect(ghsaMonths("2026-01-15")).toEqual(["2025/09", "2025/10", "2025/11", "2025/12", "2026/01"]);
    expect(ghsaMonths("2026-12-31").at(-1)).toBe("2027/01");
    expect(() => ghsaMonths("2026-02-30")).toThrow();
  });

  it("ghsaRecordUrl", () => {
    expect(ghsaRecordUrl("GHSA-2f8c-wq4h-r7jm")).toBe("https://github.com/advisories/GHSA-2f8c-wq4h-r7jm");
    expect(() => ghsaRecordUrl("GHSA-0000-0000-0000")).toThrow();
  });
});

describe("NVD", () => {
  it("builds the two page URLs in UTC with milliseconds and no zone", () => {
    const urls = nvdUrls("https://services.nvd.nist.gov/rest/json/cves/2.0", { start: "2026-10-13T04:30:00+08:00", end: "2026-10-14T04:30:00+08:00" });
    expect(urls).toEqual([0, 2000].map((i) => `https://services.nvd.nist.gov/rest/json/cves/2.0?pubStartDate=2026-10-12T20:30:00.000&pubEndDate=2026-10-13T20:30:00.000&resultsPerPage=2000&startIndex=${i}`));
    expect(() => nvdUrls("https://services.nvd.nist.gov/rest/json/cves/2.0", { start: "2026-10-13T04:30:00", end: "2026-10-14T04:30:00Z" })).toThrow();
  });

  it("keeps NIST's own Primary scores, v4.0 first, and ignores a Secondary", () => {
    const p = parseNvdPage(read("nvd/page-1.json"));
    expect(p.total).toBe(2);
    expect(p.scores.get("CVE-2026-107248")).toMatchObject({ score: 8.7, version: "4.0" });
    expect(p.scores.get("CVE-2026-107460")).toMatchObject({ score: 7.5, version: "3.1" });
    const secondaryOnly = parseNvdPage(json({ totalResults: 1, vulnerabilities: [{ cve: { id: "CVE-2026-1000", metrics: {
      cvssMetricV31: [{ source: "secalert@example.com", type: "Secondary", cvssData: { baseScore: 9.8, vectorString: "v" } }] } } }] }));
    expect(secondaryOnly.scores.size).toBe(0);
  });

  it("classes bad bodies", () => {
    expect(errorClass(() => parseNvdPage(Buffer.from("<html>")))).toBe("parse");
    expect(errorClass(() => parseNvdPage(json({ vulnerabilities: [] })))).toBe("schema");
  });
});

describe("MyJVN", () => {
  const REGISTRY = "https://jvndb.jvn.jp/myjvn?method=getVulnOverviewList&feed=hnd&rangeDatePublic=w&maxCountItem=50&startItem=1";

  it("reads a page: items, the status totals, CVE references and the newest CVSS", () => {
    const p = parseMyJvn(read("myjvn/page-1.xml"));
    expect(p).toMatchObject({ total: 50, totalRes: 60, totalResRet: 50, version: null });
    expect(p.entries[0]).toMatchObject({
      id: "JVNDB-2026-012900", link: "https://jvndb.jvn.jp/ja/contents/2026/JVNDB-2026-012900.html", cve_ids: ["CVE-2026-101020"],
      cvss: { score: 5.1, version: "4.0" }, issued: "2026-10-11T20:00:00.000Z",
    });
    expect(p.entries[7]!.cve_ids).toEqual(["CVE-2026-104935", "CVE-2026-96951"]);
    expect(p.entries[1]!.cvss).toMatchObject({ version: "3.0" });
    expect(p.newest).toBe("2026-10-13T13:59:00.000Z");
    for (const e of p.entries) if (e.issued !== null) expect(e.issued <= p.newest!).toBe(true);
    const p2 = parseMyJvn(read("myjvn/page-2.xml"));
    expect(p2).toMatchObject({ total: 10, totalRes: 60, totalResRet: 10 });
  });

  it("reads the RDF feed without a status: the totals are the item count", () => {
    const text = read("myjvn/page-1.xml").toString("utf8").replace(/<status:Status[^>]*\/>/, "");
    expect(parseMyJvn(Buffer.from(text))).toMatchObject({ totalRes: 50, totalResRet: 50 });
  });

  it("classes an error status as schema and a body that is not RDF as parse", () => {
    expect(errorClass(() => parseMyJvn(read("myjvn/error.xml")))).toBe("schema");
    expect(errorClass(() => parseMyJvn(Buffer.from("<rss><channel/></rss>")))).toBe("parse");
  });

  it("pages from startItem 1 by maxCountItem, at most ten pages; a feed URL is one page", () => {
    expect(myjvnPageUrls(REGISTRY, 60)).toEqual([REGISTRY, REGISTRY.replace("startItem=1", "startItem=51")]);
    expect(myjvnPageUrls(REGISTRY, 0)).toEqual([REGISTRY]);
    expect(myjvnPageUrls(REGISTRY, 100_000)).toHaveLength(10);
    expect(myjvnPageUrls(REGISTRY, 100_000, 3).at(-1)).toContain("startItem=101");
    expect(myjvnPageUrls("https://jvndb.jvn.jp/ja/rss/jvndb_new.rdf", 500)).toEqual(["https://jvndb.jvn.jp/ja/rss/jvndb_new.rdf"]);
  });
});

// ── RSS, TVN and JPCERT ──────────────────────────────────────────────────────────────────────────

describe("RSS: parseRss, feedDate and zoneOf", () => {
  const dates = async (rel: string) => (await parseRss(read(rel))).entries.map((e) => e.published_at);

  it("reads RSS 2.0, Atom, RDF and a10:updated dates", async () => {
    expect(await dates("rss/format-two-digit-year.xml")).toEqual(["2026-10-13T12:00:00.000Z", "2026-10-12T12:00:00.000Z"]);
    expect(await dates("rss/format-atom.xml")).toEqual(["2026-10-13T17:00:00.000Z", "2026-10-12T10:51:28.036Z"]);
    expect((await parseRss(read("rss/format-atom.xml"))).entries[0]!.snippet).toBe("SAMPLE: an Atom entry with an offset and a summary.");
    expect(await dates("rss/format-a10.xml")).toEqual(["2026-10-13T07:44:00.000Z", "2026-10-13T07:15:00.000Z"]);
    expect(await dates("rss/format-cest.xml")).toEqual(["2026-10-13T14:36:26.000Z", "2026-11-03T09:00:00.000Z"]);
    expect(await dates("rss/format-ithome.xml")).toEqual(["2026-10-13T12:11:50.000Z", "2026-10-13T18:12:00.000Z"]);
  });

  it("gives a zone-less item date the channel's offset: RSS pubDate and RDF dc:date", async () => {
    expect(await dates("rss/zoneless.xml")).toEqual(["2026-10-13T09:30:00.000Z", "2026-10-13T00:15:00.000Z"]);
    expect(await dates("rss/zoneless.rdf")).toEqual(["2026-10-13T08:00:00.000Z", "2026-10-13T03:00:00.000Z"]);
  });

  // Kobol 2026-11-09: iThome's /rss/security writes "YYYY-MM-DD HH:mm" with no zone and no channel date, and
  // the newest item read at 22:20 Taipei was "21:16": Taipei time. The registry's date_zone says so.
  it("gives a zone-less date the registry's date_zone when the channel writes no zone: iThome in Taipei time", async () => {
    const zoned = async (rel: string, zone: string | null) => (await parseRss(read(rel), zone)).entries.map((e) => e.published_at);
    expect(await zoned("rss/format-ithome.xml", "+08:00")).toEqual(["2026-10-13T04:11:50.000Z", "2026-10-13T10:12:00.000Z"]);
    expect((await parseRss(read("rss/format-ithome.xml"), "+08:00")).newest).toBe("2026-10-13T10:12:00.000Z");
    expect(await zoned("rss/format-ithome.xml", null)).toEqual(await dates("rss/format-ithome.xml"));
    // The channel's own offset still wins: zoneless.xml's channel is +09:00, zoneless.rdf's +08:00.
    expect(await zoned("rss/zoneless.xml", "-05:00")).toEqual(await dates("rss/zoneless.xml"));
    expect(await zoned("rss/zoneless.rdf", "-05:00")).toEqual(await dates("rss/zoneless.rdf"));
    // A channel date that says GMT is an offset too; one written without a zone is not.
    const chan = (date: string) => ({ lastBuildDate: date, items: [{ title: "SAMPLE", link: "https://example.com/ct-sample/a", pubDate: "2026-10-13 09:00" }] });
    expect(rssItems(chan("Tue, 13 Oct 2026 10:00:00 GMT"), "+08:00")[0]!.published_at).toBe("2026-10-13T09:00:00.000Z");
    expect(rssItems(chan("2026-10-13 10:00"), "+08:00")[0]!.published_at).toBe("2026-10-13T01:00:00.000Z");
    expect(rssItems({ items: chan("x").items }, "+08:00")[0]!.published_at).toBe("2026-10-13T01:00:00.000Z");
    expect(rssItems({ items: chan("x").items })[0]!.published_at).toBe("2026-10-13T09:00:00.000Z");
    // An item date with its own zone never takes date_zone.
    expect(rssItems({ items: [{ title: "SAMPLE", link: "https://example.com/ct-sample/a", pubDate: "Tue, 13 Oct 2026 09:00:00 +0000" }] }, "+08:00")[0]!.published_at)
      .toBe("2026-10-13T09:00:00.000Z");
    expect(itemZone(undefined, "+08:00")).toBe("+08:00");
    expect(itemZone("Tue, 13 Oct 2026 16:36:26 CEST", "+08:00")).toBe("+02:00");
    expect(itemZone(undefined)).toBe("Z");
  });

  it("never reads the machine's zone", async () => {
    const files = ["rss/zoneless.xml", "rss/zoneless.rdf", "rss/format-ithome.xml", "rss/near-dup.xml"];
    const all = async () => [...await Promise.all(files.map(dates)), (await parseRss(read("rss/format-ithome.xml"), "+08:00")).entries.map((e) => e.published_at)];
    const utc = await withTzAsync("UTC", all);
    expect(await withTzAsync("Asia/Taipei", all)).toEqual(utc);
    expect(await withTzAsync("America/New_York", all)).toEqual(utc);
  });

  it("newest, NODATE, STALE, garbage and the flood", async () => {
    expect((await parseRss(read("rss/zoneless.xml"))).newest).toBe("2026-10-13T09:30:00.000Z");
    const nodate = await parseRss(read("rss/nodate.xml"));
    expect([nodate.total, nodate.newest]).toEqual([2, null]);
    expect((await parseRss(read("rss/stale.xml"))).newest).toBe("2026-08-10T09:00:00.000Z");
    expect(await errorClassAsync(() => parseRss(read("rss/garbage.xml")))).toBe("parse");
    expect((await parseRss(read("rss/flood.xml"))).total).toBe(40);
    expect((await parseRss(read("rss/near-dup.xml"))).total).toBe(6);
    expect((await parseRss(read("rss/must-match.xml"))).total).toBe(5);
  });

  it("skips items without a title or a link", () => {
    expect(rssItems({ items: [{ title: "SAMPLE", link: "" }, { title: " ", link: "https://example.com/ct-sample/a" }, { title: "SAMPLE  two", link: " https://example.com/ct-sample/b " }] }))
      .toEqual([{ title: "SAMPLE two", url: "https://example.com/ct-sample/b", published_at: null, snippet: "" }]);
  });

  it("feedDate and zoneOf", () => {
    expect(feedDate(undefined)).toBeNull();
    expect(feedDate("  ")).toBeNull();
    expect(feedDate("not a date")).toBeNull();
    expect(feedDate("2026-10-13")).toBe("2026-10-13T00:00:00.000Z");
    expect(feedDate("2026-10-13 09:00", "+09:00")).toBe("2026-10-13T00:00:00.000Z");
    expect(feedDate("26-10-30 17:50")).toBe("2026-10-30T17:50:00.000Z");
    expect(feedDate("Tue, 13 Oct 2026 16:36:26 MESZ")).toBe("2026-10-13T14:36:26.000Z");
    expect(feedDate("Tue, 13 Oct 2026 16:36:26 GMT", "+09:00")).toBe("2026-10-13T16:36:26.000Z");
    expect(feedDate("Tue, 13 Oct 2026 16:36:26", "+09:00")).toBe("2026-10-13T07:36:26.000Z");
    expect(zoneOf("Tue, 13 Oct 2026 21:00:00 +0900")).toBe("+09:00");
    expect(zoneOf("2026-10-13T21:00+09:00")).toBe("+09:00");
    expect(zoneOf("Tue, 13 Oct 2026 16:36:26 CEST")).toBe("+02:00");
    expect(zoneOf("Tue, 13 Oct 2026 16:36:26 GMT")).toBe("Z");
    expect(zoneOf(undefined)).toBe("Z");
    // A value that is not a string (an element with attributes or children) is no date, never a throw.
    expect(feedDate({ _: "x" } as unknown as string)).toBeNull();
    // Date.parse reads "Tuesday +0900" as the year 900: text without a digit, or a year outside 1990 to 2100, is no date.
    expect(feedDate("Tuesday", "+09:00")).toBeNull();
    expect(feedDate("x 7", "+09:00")).toBeNull();
    expect(feedDate("Tue, 13 Oct 1066 16:36:26 GMT")).toBeNull();
    expect(feedDate("Tue, 13 Oct 1990 16:36:26 GMT")).toBe("1990-10-13T16:36:26.000Z");
    expect(zoneOf({ b: ["x"] } as unknown as string)).toBe("Z");
  });

  const atom = (feedUpdated: string, ...entries: string[]) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>SAMPLE Atom</title><id>tag:example.com,2026:ct-sample</id>${feedUpdated}
${entries.map((e, i) => `<entry><title>SAMPLE ${i + 1}</title><link href="https://www.example.com/ct-sample/atom-${i + 1}"/><id>tag:example.com,2026:${i + 1}</id>${e}</entry>`).join("\n")}
</feed>`);

  it("Atom: a zone-less <published> takes the feed's offset, never the machine's zone", async () => {
    const body = atom("<updated>2026-11-09T12:00:00+09:00</updated>",
      "<published>2026-11-09T10:00:00</published><updated>2026-11-09T11:00:00</updated>",
      "<updated>2026-11-09 09:30</updated>");
    const read = async () => (await parseRss(body)).entries.map((e) => e.published_at);
    for (const tz of ["UTC", "Asia/Taipei", "America/New_York"]) {
      expect(await withTzAsync(tz, read), tz).toEqual(["2026-11-09T01:00:00.000Z", "2026-11-09T00:30:00.000Z"]);
    }
    // No feed date: date_zone, else UTC.
    const bare = atom("", "<published>2026-11-09T10:00:00</published>");
    expect((await withTzAsync("Asia/Taipei", () => parseRss(bare))).entries[0]!.published_at).toBe("2026-11-09T10:00:00.000Z");
    expect((await withTzAsync("UTC", () => parseRss(bare, "+08:00"))).entries[0]!.published_at).toBe("2026-11-09T02:00:00.000Z");
  });

  it("Atom: an unreadable <published> drops that date, not the entry or the feed", async () => {
    const body = atom("<updated>2026-11-09T12:00:00+09:00</updated>",
      "<published>Tuesday</published><updated>2026-11-09T11:00:00+09:00</updated>",
      "<published>Tuesday</published>",
      "<published>2026-11-08T10:00:00Z</published>");
    const p = await parseRss(body);
    expect(p.entries.map((e) => [e.title, e.published_at])).toEqual([
      ["SAMPLE 1", "2026-11-09T02:00:00.000Z"], ["SAMPLE 2", null], ["SAMPLE 3", "2026-11-08T10:00:00.000Z"],
    ]);
    expect(p.newest).toBe("2026-11-09T02:00:00.000Z");
  });

  it("a channel or entry date that is not a plain string never throws: attributes are read, anything else ignored", async () => {
    const item = "<item><title>SAMPLE</title><link>https://www.example.com/ct-sample/a</link><pubDate>2026-11-09 09:00</pubDate></item>";
    const rss = (channel: string) => Buffer.from(`<rss version="2.0"><channel><title>SAMPLE</title>${channel}${item}</channel></rss>`);
    // Children in lastBuildDate: no channel zone, so date_zone or UTC.
    const kids = await parseRss(rss("<lastBuildDate><b>x</b></lastBuildDate>"), "+08:00");
    expect(kids.entries.map((e) => e.published_at)).toEqual(["2026-11-09T01:00:00.000Z"]);
    // An attribute on the channel date: its text still gives the zone.
    const attr = await parseRss(rss('<lastBuildDate xml:lang="en">Mon, 09 Nov 2026 10:00:00 +0900</lastBuildDate>'));
    expect(attr.entries.map((e) => e.published_at)).toEqual(["2026-11-09T00:00:00.000Z"]);
    // Atom: feed-level <updated> with an attribute, or with no text at all.
    const lang = atom('<updated xml:lang="en">2026-11-09T10:00:00+09:00</updated>', '<published xml:lang="en">2026-11-09T10:00:00</published>');
    expect((await parseRss(lang)).entries.map((e) => e.published_at)).toEqual(["2026-11-09T01:00:00.000Z"]);
    const empty = atom('<updated a="1"/>', "<published>2026-11-09T10:00:00Z</published>");
    expect((await parseRss(empty)).entries.map((e) => e.published_at)).toEqual(["2026-11-09T10:00:00.000Z"]);
    expect(rssItems({ pubDate: { b: ["x"] }, items: [{ title: "SAMPLE", link: "https://www.example.com/ct-sample/a", pubDate: { $: { a: "1" } } }] }))
      .toEqual([{ title: "SAMPLE", url: "https://www.example.com/ct-sample/a", published_at: null, snippet: "" }]);
  });
});

describe("TVN and JPCERT notes", () => {
  const regions = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "regions.json"), "utf8")) as { regions: { code: string; alert_patterns: string[] }[] };
  const jpAlerts = regions.regions.find((r) => r.code === "JP")!.alert_patterns.map((p) => new RegExp(p, "iu"));

  it("TVN: the id from the title, CVE ids, never an alert; one note says exploited", async () => {
    const notes = tvnRecords((await parseRss(read("twcert-tvn/rss.xml"))).entries);
    expect(notes.map((n) => [n.id, n.cve_ids, n.alert])).toEqual([
      ["TVN-202610012", ["CVE-2026-104935"], false], ["TVN-202610013", ["CVE-2026-107437"], false],
      ["TVN-202610011", ["CVE-2026-108971"], false], ["TVN-202610008", [], false],
    ]);
    expect(notes.filter((n) => n.text.includes("已被利用")).map((n) => n.id)).toEqual(["TVN-202610012"]);
    expect(tvnRecords([{ title: "SAMPLE", url: "https://www.twcert.org.tw/ct-sample/x?utm_source=rss", published_at: null, snippet: "" }])[0]!.id)
      .toBe("https://twcert.org.tw/ct-sample/x");
  });

  it("JPCERT: the id from the path, alert by Japan's alert_patterns, one weekly report says exploited", async () => {
    const notes = jpcertRecords((await parseRss(read("jpcert/jpcert.rdf"))).entries, jpAlerts);
    expect(notes.map((n) => [n.id, n.alert, n.cve_ids, n.published_at])).toEqual([
      ["wr264101", false, ["CVE-2026-96951"], "2026-10-13T18:00:00.000Z"],
      ["at260031", true, ["CVE-2026-104935"], "2026-10-13T15:15:00.000Z"],
      ["at260029", true, [], "2026-10-02T01:00:00.000Z"],
      ["wr264001", false, [], "2026-10-07T18:00:00.000Z"],
    ]);
    expect(notes[0]!.text).toContain("悪用");
    expect(jpcertRecords([{ title: "SAMPLE", url: "https://www.jpcert.or.jp/", published_at: null, snippet: "" }], jpAlerts)[0]!.id).toBe("https://jpcert.or.jp");
  });
});

// ── Exchange notices and the dashboard ───────────────────────────────────────────────────────────

describe("TWSE and TPEx notices", () => {
  it("TWSE: trims keys, reads ROC dates as +08:00 instants, skips a row without a date", () => {
    const p = parseExchange(read("exchange-tw/twse.json"), "twse");
    expect(p.total).toBe(4);
    expect(p.entries.map((e) => [e.company_code, e.spoken_at])).toEqual([
      ["9998", "2026-10-13T21:30:15+08:00"], ["9997", "2026-10-13T16:30:00+08:00"], ["9996", "2026-10-12T10:05:00+08:00"],
    ]);
    expect(p.entries[0]).toMatchObject({ company: "範例電子(SAMPLE)", subject: "本公司部分資訊系統遭受駭客網路攻擊 (SAMPLE)", url: EXCHANGE_ENDPOINTS.twse });
    expect(p.newest).toBe("2026-10-13T21:30:15+08:00");
  });

  it("TPEx: its own column names", () => {
    const p = parseExchange(read("exchange-tw/tpex.json"), "tpex");
    expect(p.entries[0]).toMatchObject({ company_code: "9899", company: "範例軟體(SAMPLE)", spoken_at: "2026-10-14T01:10:00+08:00", url: EXCHANGE_ENDPOINTS.tpex });
  });

  it("the terms filter keeps the security notices only", () => {
    const hits = (body: Buffer, e: "twse" | "tpex") => parseExchange(body, e).entries.filter((n) => hitsExchangeTerms(`${n.subject} ${n.text}`)).map((n) => n.company_code);
    expect(hits(read("exchange-tw/twse.json"), "twse")).toEqual(["9998", "9996"]);
    expect(hits(read("exchange-tw/tpex.json"), "tpex")).toEqual(["9899"]);
  });

  it("rocDate and bad bodies", () => {
    expect(rocDate("1151013")).toBe("2026-10-13");
    expect(rocDate("115/10/13")).toBe("2026-10-13");
    expect(rocDate("991231")).toBe("2010-12-31");
    expect(rocDate("1151332")).toBeNull();
    expect(rocDate("abc")).toBeNull();
    expect(errorClass(() => parseExchange(Buffer.from("<html>"), "twse"))).toBe("parse");
    expect(errorClass(() => parseExchange(json({ rows: [] }), "twse"))).toBe("schema");
    expect(parseExchange(json([]), "tpex")).toMatchObject({ entries: [], total: 0, newest: null });
  });
});

describe("the disclosure dashboard (provisional until the Kobol capture)", () => {
  const page = read("anthropic-cvd/page.html");
  const payload = read("anthropic-cvd/payload.json");
  const LEDGER = ["CVE-2026-77206", "CVE-2026-77207", "CVE-2026-79610", "CVE-2026-103658", "GHSA-7q8r-9v2w-c3f4", "GHSA-9v2w-c3f4-g5h6"];

  it("the payload wins: figures, revision, date and the ids of rows not withdrawn, corrected ids first", () => {
    expect(parseAnthropicCvd(page, "text/html; charset=utf-8", payload)).toEqual({
      revision: "37", as_of: "2026-10-13", found_n: 5710, disclosed_n: 4812, patched_n: 588, ledger_ids: LEDGER,
    });
  });

  it("a JSON body is read as the payload", () => {
    expect(parseAnthropicCvd(payload, "application/json", null).ledger_ids).toEqual(LEDGER);
  });

  it("the page alone gives its revision, date, counts and the ids it shows", () => {
    expect(parseAnthropicCvd(page, "text/html", null)).toEqual({
      revision: "37", as_of: "2026-10-13", found_n: null, disclosed_n: 4812, patched_n: 588,
      ledger_ids: ["CVE-2026-77206", "CVE-2026-103658", "GHSA-7q8r-9v2w-c3f4"],
    });
  });

  it("no revision or no date is schema; a payload that is not JSON is parse", () => {
    expect(errorClass(() => parseAnthropicCvd(Buffer.from("<p>Last updated 2026-10-13 19:30 UTC</p>"), "text/html", null))).toBe("schema");
    expect(errorClass(() => parseAnthropicCvd(Buffer.from("<p>Revision 37</p>"), "text/html", null))).toBe("schema");
    expect(errorClass(() => parseAnthropicCvd(page, "text/html", Buffer.from("{")))).toBe("parse");
  });

  it("the payload URL sits beside the page", () => {
    expect(cvdPayloadUrl("https://red.anthropic.com/2026/cvd/")).toBe("https://red.anthropic.com/2026/cvd/data/payload.json");
    expect(cvdPayloadUrl("https://www.example.com/a/index.html")).toBe("https://www.example.com/a/data/payload.json");
  });
});

// ── GitHub helpers and the fixture world ─────────────────────────────────────────────────────────

describe("GitHub helpers", () => {
  it("parseLsRemote: peeled tags replace the tag object; malformed lines are skipped", () => {
    const out = parseLsRemote([
      `${SHA}\tHEAD`, `${"a".repeat(40)}\trefs/tags/cve_2026-10-13_2000Z`, `${"b".repeat(40)}\trefs/tags/cve_2026-10-13_2000Z^{}`,
      "", "not a line", `${"c".repeat(64)}\trefs/heads/main`,
    ].join("\n"));
    expect([...out]).toEqual([["HEAD", SHA], ["refs/tags/cve_2026-10-13_2000Z", "b".repeat(40)], ["refs/heads/main", "c".repeat(64)]]);
  });

  it("rawAtCommit swaps the ref for a sha; anything else throws", () => {
    expect(rawAtCommit("https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json", SHA))
      .toBe(`https://raw.githubusercontent.com/cisagov/kev-data/${SHA}/known_exploited_vulnerabilities.json`);
    expect(rawAtCommit("https://raw.githubusercontent.com/CVEProject/cvelistV5/refs/heads/main/cves/deltaLog.json", SHA))
      .toBe(`https://raw.githubusercontent.com/CVEProject/cvelistV5/${SHA}/cves/deltaLog.json`);
    expect(() => rawAtCommit("https://www.example.com/a/b/c/d", SHA)).toThrow();
    expect(() => rawAtCommit("https://raw.githubusercontent.com/a/b/main", SHA)).toThrow();
    expect(() => rawAtCommit("https://raw.githubusercontent.com/a/b/main/x.json", "main")).toThrow();
  });

  it("cveRecordRawUrl uses the cves/<year>/<n div 1000>xxx path", () => {
    expect(cveRecordRawUrl(SHA, "CVE-2026-0842")).toBe(`https://raw.githubusercontent.com/${REPOS.cvelist}/${SHA}/cves/2026/0xxx/CVE-2026-0842.json`);
    expect(cveRecordRawUrl(SHA, "cve-2026-104935")).toBe(`https://raw.githubusercontent.com/${REPOS.cvelist}/${SHA}/cves/2026/104xxx/CVE-2026-104935.json`);
    expect(() => cveRecordRawUrl(SHA, "GHSA-2f8c-wq4h-r7jm")).toThrow();
  });

  it("release assets, the newest hourly tag and tag times", () => {
    expect(endOfDayAsset("2026-10-12")).toEqual({
      tag: "cve_2026-10-12_at_end_of_day", asset: "2026-10-12_delta_CVEs_at_end_of_day.zip",
      url: "https://github.com/CVEProject/cvelistV5/releases/download/cve_2026-10-12_at_end_of_day/2026-10-12_delta_CVEs_at_end_of_day.zip",
    });
    expect(hourlyAsset("2026-10-13", "2000").asset).toBe("2026-10-13_delta_CVEs_at_2000Z.zip");
    expect(() => hourlyAsset("2026-10-13", "2460")).toThrow();
    expect(() => endOfDayAsset("2026-10-32")).toThrow();
    const refs = new Map([
      ["refs/tags/cve_2026-10-13_1900Z", SHA], ["refs/tags/cve_2026-10-13_2000Z", SHA], ["refs/tags/cve_2026-10-13_at_end_of_day", SHA],
      ["refs/tags/cve_2026-10-14_0000Z", SHA], ["cve_2026-10-13_0800Z", SHA],
    ]);
    expect(newestHourlyTag(refs, "2026-10-13")).toBe("cve_2026-10-13_2000Z");
    expect(newestHourlyTag(refs, "2026-10-12")).toBeNull();
    expect(tagTime("cve_2026-10-13_2000Z")).toBe("2026-10-13T20:00:00Z");
    expect(tagTime("cve_2026-10-12_at_end_of_day")).toBeNull();
  });

  it("FEED_WORLD agrees with world.ts's weekday edition and the asset names", () => {
    const w = EDITIONS.weekday;
    expect(FEED_WORLD.date).toBe(w.date);
    expect(FEED_WORLD.cutoff).toBe(w.cutoff);
    expect(FEED_WORLD.runUtcDay).toBe(addDays(w.date, -1));
    expect(FEED_WORLD.kev).toEqual({ version: w.kev.version, released: w.kev.released });
    expect(FEED_WORLD.hourlyTag).toBe(w.cveListRelease);
    expect(FEED_WORLD.eodTag).toBe(endOfDayAsset(FEED_WORLD.cutoff).tag);
    expect(FEED_WORLD.hourlyTag).toBe(hourlyAsset(FEED_WORLD.runUtcDay, "2000").tag);
  });
});
