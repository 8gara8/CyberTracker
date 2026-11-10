// composeDataOnly() and its templates (SPEC §4.5 "Data-only edition", §8.7 publishDataOnly; plan L3, C3):
// site-content's data-only editions rebuilt from their metrics, the KEV rows and earlier briefs, and §4.5's
// test of a data-only brief with three new KEV items through validatePublished.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CveFacts } from "@/lib/apply";
import { matchVendor } from "@/lib/config";
import { DATA_ONLY_MAX_ITEMS, composeDataOnly, dataOnlyHeadline, dataOnlyRows, dataOnlySummary, type DataOnlyInput } from "@/lib/data-only";
import { addDays } from "@/lib/dates";
import { sha256Hex } from "@/lib/json";
import { collectSignals, regionsConfig } from "@/lib/regions";
import { Brief } from "@/lib/schema/brief";
import { InputsManifest, Metrics, type KevIndexFile } from "@/lib/schema/metrics";
import { ArchiveIndex, CorrectionsFile } from "@/lib/schema/misc";
import { ScoreboardFile } from "@/lib/schema/scoreboard";
import { normalizeUrl } from "@/lib/urls";
import { cveLookupFromDir, validatePublished } from "@/lib/validate";
import { CVE_RECORDS_DIR, fixtureConfig } from "@/fixtures/src/inputs";
import { FIXTURES_DIR, KEV_DUE, KEV_ROWS, RECORD_IDS, cveRecord } from "@/fixtures/src/world";

const SITE = path.join(FIXTURES_DIR, "site-content");
const read = (p: string): unknown => JSON.parse(fs.readFileSync(p, "utf8"));
const cfg = fixtureConfig();
const BRIEFS = fs.readdirSync(path.join(SITE, "briefs")).sort().map((f) => Brief.parse(read(path.join(SITE, "briefs", f))));
const golden = (date: string) => structuredClone(BRIEFS.find((b) => b.date === date)!);
const GOLDEN_BOARD = ScoreboardFile.parse(read(path.join(SITE, "scoreboard.json")));
const GOLDEN_ARCHIVE = ArchiveIndex.parse(read(path.join(SITE, "archive-index.json")));

/** The KEV catalog version each sample data-only morning read (site.ts's buildDays()). */
const CATALOG: Readonly<Record<string, string>> = {
  "2026-10-06": "2026.10.04", "2026-10-07": "2026.10.04", "2026-10-08": "2026.10.04",
  "2026-10-09": "2026.10.08", "2026-10-10": "2026.10.08", "2026-10-15": "2026.10.14",
};

function kevIndexAt(version: string): KevIndexFile {
  const through = version.replace(/\./g, "-");
  return { schema_version: 1, updated_at: through, catalog_version: version, entries: KEV_ROWS.filter((r) => r[1] <= through).map((r) => [...r] as KevIndexFile["entries"][number]) };
}

function siteFacts(version: string): CveFacts {
  const idx = kevIndexAt(version);
  return {
    record: (id) => (RECORD_IDS.includes(id) ? cveRecord(id) : null),
    kev: (id) => {
      const r = idx.entries.find((x) => x[0] === id);
      return r ? { dateAdded: r[1], dueDate: KEV_DUE[id] ?? addDays(r[1], 21), ransomware: r[6], catalogVersion: version } : null;
    },
    epss: () => null,
    ghsaIds: () => [],
  };
}

function boardBefore(date: string): ScoreboardFile {
  const entries = GOLDEN_BOARD.entries.filter((e) => e.date < date);
  return {
    ...structuredClone(GOLDEN_BOARD), as_of: addDays(date, -1), entries,
    claims: GOLDEN_BOARD.claims.map((c) => ({ ...c, last_entry_id: [...entries].reverse().find((e) => e.claim_id === c.id)?.id ?? null })),
  };
}

function archiveBefore(date: string): ArchiveIndex {
  const urls: ArchiveIndex["urls"] = {};
  for (const [u, e] of Object.entries(GOLDEN_ARCHIVE.urls)) {
    if (e.first_cited < date) urls[u] = { ...structuredClone(e), item_ids: e.item_ids.filter((x) => x.slice(0, 10) < date) };
  }
  return { schema_version: 1, editions: GOLDEN_ARCHIVE.editions.filter((e) => e.date < date), urls };
}

/** A sample data-only morning: its metrics and manifest, the KEV rows of its catalog, the earlier briefs, KEV signals only. */
function dataOnlyWorld(date: string): DataOnlyInput {
  const g = golden(date);
  const mText = fs.readFileSync(path.join(SITE, "metrics", `${date}.json`), "utf8");
  const kevIndex = kevIndexAt(CATALOG[date]!);
  const history = BRIEFS.filter((b) => b.date < date).reverse();
  const rc = regionsConfig(cfg);
  return {
    date, config: cfg, metrics: Metrics.parse(JSON.parse(mText)), kevIndex, history,
    regionsBase: { date, history, signals: collectSignals(null, null, kevIndex, rc, date), kevIndex, config: rc },
    archiveIndex: archiveBefore(date), scoreboard: boardBefore(date),
    corrections: CorrectionsFile.parse(read(path.join(SITE, "corrections.json"))),
    feedsStale: [], publishedAt: g.published_at, generatedAt: g.generated_at,
    cveList: cveLookupFromDir(CVE_RECORDS_DIR), facts: siteFacts(CATALOG[date]!),
    inputs: InputsManifest.parse(read(path.join(SITE, "metrics", "inputs", `${date}.json`))), metricsSha256: sha256Hex(mText),
  };
}

describe("composeDataOnly", { timeout: 120_000 }, () => {
  it("C3: rebuilds site-content's data-only editions of 15, 9 and 7 October exactly", () => {
    for (const date of ["2026-10-15", "2026-10-09", "2026-10-07"]) {
      const out = composeDataOnly(dataOnlyWorld(date));
      expect(out.brief, date).toEqual(golden(date));
      expect(out.rewritten).toEqual([]);
      expect(out.corrections).toBeNull();
      expect(out.flagCorrections).toEqual([]);
    }
  });

  it("C3: the first edition (6 October) differs only in the first-reading entry's text, a SAMPLE placeholder", () => {
    const out = composeDataOnly(dataOnlyWorld("2026-10-06"));
    const want = golden("2026-10-06");
    expect(want.scoreboard.entries[0]!.summary).toMatch(/^SAMPLE\. First reading/);
    want.scoreboard.entries[0]!.summary = "First reading: the base-rate ratio has no value yet.";
    expect(out.brief).toEqual(want);
    expect(out.scoreboard!.entries).toEqual(want.scoreboard.entries);
  });

  it("C3: the templates are site.ts's text exactly", () => {
    const item = golden("2026-10-15").items[0]!;
    const row = KEV_ROWS.find((r) => r[0] === item.cves[0]!.cve_id)!;
    expect(dataOnlyHeadline(row[0], row[2], row[3])).toBe(item.headline);
    expect(dataOnlySummary(row[0], row[2], row[3], row[1], row[4]!)).toBe(item.summary);
    expect(dataOnlyHeadline("CVE-2026-0001", "V".repeat(60), "P".repeat(60))).toHaveLength(90);
  });

  it("C3: the scoreboard, archive index and status of a data-only publish", () => {
    const w = dataOnlyWorld("2026-10-15");
    const out = composeDataOnly(w);
    expect(out.scoreboard).toEqual({ ...GOLDEN_BOARD, as_of: "2026-10-15" });
    expect(out.archiveIndex.editions[0]).toEqual(GOLDEN_ARCHIVE.editions[0]);
    for (const s of out.brief!.sources) {
      const e = out.archiveIndex.urls[normalizeUrl(s.url)]!;
      expect(e).toMatchObject({ first_cited: "2026-10-15", sha256: null, hashed_at: null });
      expect(e.item_ids).toEqual([`2026-10-15/${s.title.toLowerCase()}`]);
    }
  });

  it("C3: §4.5's data-only brief with three new KEV items passes validatePublished", () => {
    const w = dataOnlyWorld("2026-10-15");
    const three = w.metrics.kev!.new_since_last_edition.cve_ids.slice(0, 3);
    const metrics = Metrics.parse({ ...w.metrics, kev: { ...w.metrics.kev!, new_since_last_edition: { ...w.metrics.kev!.new_since_last_edition, cve_ids: three } } });
    const out = composeDataOnly({ ...w, metrics });
    const b = out.brief!;
    expect(b.items).toHaveLength(3);
    expect(b.items.every((it) => it.kind === "exploited_flaw" && it.ai_role === "unassessed" && it.severity === null && it.claim_type === "government")).toBe(true);
    expect(b.sources.map((s) => [s.outlet, s.source_type, s.seen_as, s.title_en])).toEqual(three.map(() => ["CVE Program", "cve_record", "pack", null]));
    expect([b.lead, b.angle, b.elsewhere, b.actors_seen, b.week_in_review]).toEqual([[], null, [], [], null]);
    expect(b.taiwan_lens.rows.every((r) => r.text === null)).toBe(true);
    const r = validatePublished(b, { metrics, config: cfg });
    expect(r.errors).toEqual([]);
  });

  it("C3: at most ten items, newest first by date added, then catalog position", () => {
    const w = dataOnlyWorld("2026-10-15");
    const ids = w.kevIndex.entries.slice(-14).map((r) => r[0]);
    const metrics = Metrics.parse({ ...w.metrics, kev: { ...w.metrics.kev!, new_since_last_edition: { ...w.metrics.kev!.new_since_last_edition, cve_ids: ids } } });
    const rows = dataOnlyRows({ ...w, metrics });
    expect(rows).toHaveLength(DATA_ONLY_MAX_ITEMS);
    const pos = (id: string) => w.kevIndex.entries.findIndex((r) => r[0] === id);
    for (let k = 1; k < rows.length; k += 1) {
      const [a, b] = [rows[k - 1]!, rows[k]!];
      expect(a[1] > b[1] || (a[1] === b[1] && pos(a[0]) > pos(b[0]))).toBe(true);
    }
    expect(composeDataOnly({ ...w, metrics }).brief!.items.map((it) => it.cves[0]!.cve_id)).toEqual(rows.map((r) => r[0]));
  });

  it("C3: a home vendor's flaw is placed in its home region; an unknown publication date leaves the CVE out", () => {
    const w = dataOnlyWorld("2026-10-15");
    const tw = w.kevIndex.entries.find((r) => matchVendor(cfg, { kevVendorProject: r[2] })?.country === "TW" && r[4] !== null);
    expect(tw).toBeDefined();
    if (tw) {
      const metrics = Metrics.parse({ ...w.metrics, kev: { ...w.metrics.kev!, new_since_last_edition: { ...w.metrics.kev!.new_since_last_edition, cve_ids: [tw[0]] } } });
      expect(composeDataOnly({ ...w, metrics }).brief!.items[0]!.regions).toEqual(["TW"]);
    }
    const id = w.metrics.kev!.new_since_last_edition.cve_ids[0]!;
    const kevIndex = { ...w.kevIndex, entries: w.kevIndex.entries.map((r) => (r[0] === id ? ([r[0], r[1], r[2], r[3], null, null, r[6]] as typeof r) : r)) };
    const out = composeDataOnly({ ...w, kevIndex, regionsBase: { ...w.regionsBase, kevIndex } });
    expect(out.brief!.items.map((it) => it.cves[0]!.cve_id)).not.toContain(id);
    expect(out.brief!.items).toHaveLength(3);
  });
});
