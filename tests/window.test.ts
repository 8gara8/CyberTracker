// lib/metrics/window.ts (SPEC §5.3): shareDirection(), speedDirection() and pacePhrase() from P1; the KEV
// join, the band rules, windowStats() and gapWindow() from P2, with the CVE-2026-118527 re-join case
// (kev-index.ts: buildKevIndex, updateKevIndex, indexFacts, kevSummary).
import { describe, expect, it } from "vitest";
import { cveFacts } from "@/lib/feeds/cvelist";
import { newKevIds } from "@/lib/feeds/kev";
import type { KevCatalog, KevEntry } from "@/lib/feeds/types";
import { jsonText } from "@/lib/json";
import { buildKevIndex, indexEntries, indexFacts, kevSummary, updateKevIndex } from "@/lib/metrics/kev-index";
import { KEV_REFERENCE_26W, REFERENCE, REFERENCE_PACE_26W, referenceWindowStats } from "@/lib/metrics/reference";
import { mannWhitneyZ, median, medianCi80, newcombe80, poissonCi80, round4, wilson80, Z80 } from "@/lib/metrics/stats";
import {
  afterLags, bandOf, gapWindow, JOIN_FROM, joinKev, MULTIPLES, pacePhrase, shareDirection, speedDirection, windowManifestRows,
  windowStats, type JoinFacts, type JoinRow,
} from "@/lib/metrics/window";
import { GapWindow, KevIndexFile, KevSummary, WindowRow } from "@/lib/schema/metrics";
import { MIN_N } from "@/lib/vocab";

describe("shareDirection (two-sample, newcombe80 against 104 of 282)", () => {
  it("calls D.3's w26 (58 of 157) no clear change", () => {
    expect(shareDirection({ cohort_n: 157, at_disclosure_n: 58 })).toBe("no_clear_change");
  });

  it("calls a clearly higher or lower share", () => {
    expect(shareDirection({ cohort_n: 157, at_disclosure_n: 90 })).toBe("higher");
    expect(shareDirection({ cohort_n: 157, at_disclosure_n: 30 })).toBe("lower");
  });

  it("says n_too_small below MIN_N, and decides at MIN_N", () => {
    expect(shareDirection({ cohort_n: MIN_N - 1, at_disclosure_n: MIN_N - 1 })).toBe("n_too_small");
    expect(shareDirection({ cohort_n: MIN_N, at_disclosure_n: MIN_N })).toBe("higher");
  });

  it("agrees with the sign of the interval's bounds at the edges", () => {
    for (let k = 0; k <= 157; k += 1) {
      const [lo, hi] = newcombe80(k, 157, 104, 282);
      const want = lo > 0 ? "higher" : hi < 0 ? "lower" : "no_clear_change";
      expect(shareDirection({ cohort_n: 157, at_disclosure_n: k })).toBe(want);
    }
  });
});

describe("speedDirection (Mann-Whitney against REFERENCE.after_lags)", () => {
  const ref: readonly number[] = REFERENCE.after_lags;

  it("calls the reference against itself no clear change", () => {
    expect(speedDirection({ after_disclosure_n: ref.length }, ref)).toBe("no_clear_change");
  });

  it("calls shorter lags faster and longer lags slower", () => {
    const short = Array.from({ length: 60 }, (_, i) => 2 + (i % 10));
    const long = Array.from({ length: 60 }, (_, i) => 60 + i * 4);
    expect(mannWhitneyZ(short, ref)).toBeLessThan(-Z80);
    expect(speedDirection({ after_disclosure_n: 60 }, short)).toBe("faster");
    expect(mannWhitneyZ(long, ref)).toBeGreaterThan(Z80);
    expect(speedDirection({ after_disclosure_n: 60 }, long)).toBe("slower");
  });

  it("says n_too_small below MIN_N and refuses lags that don't match the count", () => {
    expect(speedDirection({ after_disclosure_n: MIN_N - 1 }, [])).toBe("n_too_small");
    expect(() => speedDirection({ after_disclosure_n: 40 }, ref.slice(0, 39))).toThrow(/39 lags/);
  });
});

describe("pacePhrase (§5.3 Volume)", () => {
  it("gives D.3's 'more than twice' for 157 (Poisson 80% interval 141.2 to 174.3 excludes 70.21)", () => {
    const [lo, hi] = poissonCi80(157);
    expect(lo > REFERENCE_PACE_26W || hi < REFERENCE_PACE_26W).toBe(true);
    expect(pacePhrase(157)).toBe("more than twice");
  });

  it("says 'in line with' while the interval holds the reference pace", () => {
    expect(pacePhrase(70)).toBe("in line with");
    expect(pacePhrase(60)).toBe("in line with");
    expect(pacePhrase(80)).toBe("in line with");
    expect(pacePhrase(82)).toBe("17% above"); // its interval starts above 70.21
  });

  it("gives a percentage from the stored ratio in basis points, capped at 99", () => {
    expect(pacePhrase(85)).toBe("21% above"); // 85 / 70.21 = 1.2106
    expect(pacePhrase(55)).toBe("22% below"); // 0.7834
    expect(pacePhrase(140)).toBe("99% above"); // 1.9940: under twice, capped
    expect(pacePhrase(0)).toBe("99% below");
  });

  it("names multiples from twice to ten times", () => {
    expect(MULTIPLES[2]).toBe("twice");
    expect(MULTIPLES[10]).toBe("ten times");
    expect(pacePhrase(141)).toBe("more than twice");
    expect(pacePhrase(250)).toBe("more than three times");
    expect(pacePhrase(700)).toBe("more than nine times");
    expect(pacePhrase(2000)).toBe("more than ten times");
  });
});

// ── P2: the KEV join (§5.3) ──────────────────────────────────────────────────────────────────────

const published = (date: string, assigner = "example"): JoinFacts => ({ state: "PUBLISHED", date_published: date, assigner });
const entry = (cveID: string, dateAdded: string, vendorProject = "Example"): Pick<KevEntry, "cveID" | "dateAdded" | "vendorProject"> =>
  ({ cveID, dateAdded, vendorProject });

/** A full KEV entry with invented text (no real description or link). */
function kevEntry(cveID: string, dateAdded: string, vendorProject = "Example", ransomware = "Unknown"): KevEntry {
  return {
    cveID, vendorProject, product: "Product", vulnerabilityName: "SAMPLE vulnerability", dateAdded,
    shortDescription: "SAMPLE description.", requiredAction: "SAMPLE action.", dueDate: dateAdded,
    knownRansomwareCampaignUse: ransomware, forensicTriage: null, notes: "", cwes: [],
  };
}

function catalogOf(entries: KevEntry[], version = "2026.11.06"): KevCatalog {
  return { catalogVersion: version, dateReleased: "2026-11-06T19:44:45.1797Z", count: entries.length, vulnerabilities: entries };
}

/** CVE-2026-118527 trimmed to what the join reads: real ids, dates and assigner; no text, credits or links. */
const RECORD_118527 = {
  dataType: "CVE_RECORD",
  dataVersion: "5.2",
  cveMetadata: {
    cveId: "CVE-2026-118527", state: "PUBLISHED", assignerShortName: "ivanti",
    dateReserved: "2026-10-28T15:30:44.861Z", datePublished: "2026-11-03T14:53:28.232Z", dateUpdated: "2026-11-03T15:32:56.011Z",
  },
  containers: {
    cna: {
      providerMetadata: { shortName: "ivanti" },
      affected: [{ vendor: "Ivanti", product: "Connect Secure", defaultStatus: "affected" }],
      metrics: [{ format: "CVSS", cvssV3_1: { version: "3.1", baseScore: 4.3, vectorString: "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N" } }],
    },
  },
};

describe("joinKev", () => {
  it("makes one row per entry from 2023-01-01, sorted by date_added then CVE number", () => {
    const rows = joinKev(
      [entry("CVE-2024-10000", "2024-03-01"), entry("CVE-2024-9999", "2024-03-01"), entry("CVE-2022-0001", "2022-12-31"), entry("CVE-2023-0002", JOIN_FROM)],
      new Map([["CVE-2024-10000", published("2024-02-20")], ["CVE-2024-9999", published("2024-02-29")], ["CVE-2023-0002", published("2022-12-01")]]),
    );
    expect(rows.map((r) => [r.cve_id, r.lag_days])).toEqual([["CVE-2023-0002", 31], ["CVE-2024-9999", 1], ["CVE-2024-10000", 10]]);
  });

  it("leaves a row unjoined when the record is missing, not PUBLISHED, or undated", () => {
    const rows = joinKev(
      [entry("CVE-2026-1", "2026-10-01"), entry("CVE-2026-2", "2026-10-01"), entry("CVE-2026-3", "2026-10-01")],
      new Map<string, JoinFacts>([
        ["CVE-2026-2", { state: "REJECTED", date_published: "2026-09-01", assigner: "x" }],
        ["CVE-2026-3", { state: "PUBLISHED", date_published: null, assigner: "x" }],
      ]),
    );
    expect(rows.every((r) => r.lag_days === null && r.date_published === null)).toBe(true);
    const s = windowStats(rows, "2026-10-01", "2026-10-01");
    expect(s).toMatchObject({ kev_added_n: 3, unjoined_n: 3, cohort_n: 0, old_listed_n: 0, after_disclosure_n: 0 });
  });

  it("gives negative lags when CISA listed before the record was published", () => {
    const [r] = joinKev([entry("CVE-2026-5", "2026-10-30")], new Map([["CVE-2026-5", published("2026-11-03")]]));
    expect(r!.lag_days).toBe(-4);
    expect(bandOf(r!.lag_days)).toBe("at_disclosure");
  });

  it("keeps the earliest dateAdded of a repeated id", () => {
    const rows = joinKev([entry("CVE-2026-7", "2026-10-05"), entry("CVE-2026-7", "2026-10-02")], new Map([["CVE-2026-7", published("2026-10-01")]]));
    expect(rows).toEqual([{ cve_id: "CVE-2026-7", date_added: "2026-10-02", vendor_project: "Example", date_published: "2026-10-01", lag_days: 1 }]);
  });
});

describe("bandOf and windowStats (§5.3 bands)", () => {
  it("puts lags 1/2/7/8/30/31/365/366 in the right bands and k7", () => {
    expect([-3, 0, 1, 2, 7, 8, 30, 31, 365, 366, null].map(bandOf)).toEqual([
      "at_disclosure", "at_disclosure", "at_disclosure", "n_day", "n_day", "n_day", "n_day", "late", "late", "old", "unjoined",
    ]);
    const lags = [1, 2, 7, 8, 30, 31, 365, 366];
    const rows: JoinRow[] = lags.map((lag, i) => ({ cve_id: `CVE-2026-${1000 + i}`, date_added: "2026-06-01", vendor_project: "x", date_published: "2025-01-01", lag_days: lag }));
    const s = windowStats(rows, "2026-06-01", "2026-06-01");
    expect(s).toMatchObject({ kev_added_n: 8, cohort_n: 7, old_listed_n: 1, at_disclosure_n: 1, n_day_n: 4, after_disclosure_n: 6, k7_n: 3, unjoined_n: 0 });
    expect(afterLags(rows, "2026-06-01", "2026-06-01")).toEqual([2, 7, 8, 30, 31, 365]);
  });

  /** A deterministic pseudo-random row set (no Math.random). */
  function rowsFrom(seed: number, n: number): JoinRow[] {
    let x = seed;
    const next = () => (x = (x * 1103515245 + 12345) % 2147483648);
    return Array.from({ length: n }, (_, i) => {
      const day = next() % 182;
      const lag = next() % 9 === 0 ? null : (next() % 900) - 30;
      const added = new Date(Date.UTC(2026, 4, 9 + day)).toISOString().slice(0, 10);
      return { cve_id: `CVE-2026-${10000 + i}`, date_added: added, vendor_project: "x", date_published: lag === null ? null : "2025-01-01", lag_days: lag };
    });
  }

  it("keeps D.2's identities: R = at + n-day + late; after = n-day + late; KEV = R + old + unjoined", () => {
    for (const seed of [1, 7, 42, 99]) {
      const rows = rowsFrom(seed, 300);
      const s = windowStats(rows, "2026-05-09", "2026-11-06");
      const late = s.cohort_n - s.at_disclosure_n - s.n_day_n;
      expect(late).toBeGreaterThanOrEqual(0);
      expect(s.after_disclosure_n).toBe(s.n_day_n + late);
      expect(s.kev_added_n).toBe(s.cohort_n + s.old_listed_n + s.unjoined_n);
      expect(afterLags(rows, s.from, s.to)).toHaveLength(s.after_disclosure_n);
      const manifest = windowManifestRows(rows, s.from, s.to);
      expect(manifest).toHaveLength(s.kev_added_n);
      expect(manifest.filter((m) => m.band === "unjoined")).toHaveLength(s.unjoined_n);
      for (const m of manifest) WindowRow.parse(m);
    }
  });

  it("switches shares on at MIN_N and medians on at MIN_N after-disclosure lags", () => {
    const mk = (n: number, lag: number): JoinRow[] => Array.from({ length: n }, (_, i) =>
      ({ cve_id: `CVE-2026-${20000 + i}`, date_added: "2026-06-01", vendor_project: "x", date_published: "2026-05-01", lag_days: lag }));
    const below = windowStats(mk(MIN_N - 1, 10), "2026-06-01", "2026-06-01");
    expect(below).toMatchObject({ cohort_n: 29, at_disclosure_share: null, at_disclosure_ci80: null, p7: null, p7_ci80: null,
      after_disclosure_median_days: null, after_disclosure_median_ci80: null });
    const at = windowStats(mk(MIN_N, 10), "2026-06-01", "2026-06-01");
    expect(at.at_disclosure_share).toBe(0);
    expect(at.at_disclosure_ci80).toEqual(wilson80(0, 30).map(round4));
    expect(at.after_disclosure_median_days).toBe(10);
    expect(at.after_disclosure_median_ci80).toEqual([10, 10]);
    // Shares on, medians off: 30 in cohort R, 29 of them after disclosure.
    const mixed = [...mk(29, 10), { cve_id: "CVE-2026-29999", date_added: "2026-06-01", vendor_project: "x", date_published: "2026-06-01", lag_days: 0 }];
    const m = windowStats(mixed, "2026-06-01", "2026-06-01");
    expect(m.at_disclosure_share).toBe(round4(1 / 30));
    expect(m.after_disclosure_median_days).toBeNull();
  });

  it("stores a .5 median as .5", () => {
    const lags = [...Array.from({ length: 15 }, () => 10), ...Array.from({ length: 15 }, () => 11)];
    const rows: JoinRow[] = lags.map((lag, i) => ({ cve_id: `CVE-2026-${30000 + i}`, date_added: "2026-06-01", vendor_project: "x", date_published: "2026-05-01", lag_days: lag }));
    const s = windowStats(rows, "2026-06-01", "2026-06-01");
    expect(s.after_disclosure_median_days).toBe(10.5);
    expect(s.after_disclosure_median_ci80).toEqual(medianCi80(lags));
    expect(median(lags)).toBe(10.5);
  });

  it("gives identical output for shuffled input", () => {
    const rows = rowsFrom(5, 200);
    const catalog = rows.map((r) => entry(r.cve_id, r.date_added));
    const facts = new Map<string, JoinFacts>();
    for (const r of rows) if (r.lag_days !== null) facts.set(r.cve_id, published(addDaysPlain(r.date_added, -r.lag_days)));
    const a = joinKev(catalog, facts);
    const b = joinKev([...catalog].reverse(), new Map([...facts].reverse()));
    expect(jsonText(gapWindow(b, "2026-11-06").window, GapWindow)).toBe(jsonText(gapWindow(a, "2026-11-06").window, GapWindow));
    expect(b).toEqual(a);
  });
});

function addDaysPlain(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

describe("gapWindow", () => {
  it("fills w26, w13, the frozen reference and the ratios from the exact paces", () => {
    const rows: JoinRow[] = Array.from({ length: 179 }, (_, i) => ({
      cve_id: `CVE-2026-${40000 + i}`, date_added: addDaysPlain("2026-05-09", i), vendor_project: "x",
      date_published: addDaysPlain("2026-05-09", i), lag_days: i < 157 ? 0 : 400,
    }));
    const { window: w, w26AfterLags } = gapWindow(rows, "2026-11-06");
    expect(GapWindow.parse(w)).toEqual(w);
    expect(w.w26).toMatchObject({ from: "2026-05-09", to: "2026-11-06", kev_added_n: 179, cohort_n: 157, old_listed_n: 22 });
    expect(w.w13).toMatchObject({ from: "2026-08-08", to: "2026-11-06" });
    expect(w.reference).toEqual(referenceWindowStats());
    expect(w.reference_pace_26w).toBe(70.21);
    expect(w.volume_ratio).toBe(2.2361); // D.3
    expect(w.kev_pace_ratio).toBe(1.9275); // 179 × 731 / (373 × 182), unrounded pace (R23)
    expect(round4(179 / 92.87)).toBe(1.9274); // the rounded pace would give D.3's old misprint
    expect(w.kev_pace_ratio).toBe(round4(179 / KEV_REFERENCE_26W));
    expect(w.volume_ratio).toBe(round4(157 / REFERENCE_PACE_26W));
    expect(w26AfterLags).toEqual([]);
  });

  it("leaves rows after the cutoff out of every window", () => {
    const rows = joinKev([entry("CVE-2026-1", "2026-11-07"), entry("CVE-2026-2", "2026-11-06")], new Map([["CVE-2026-1", published("2026-11-07")], ["CVE-2026-2", published("2026-11-06")]]));
    const { window: w } = gapWindow(rows, "2026-11-06");
    expect(w.w26.kev_added_n).toBe(1);
    expect(w.w13.kev_added_n).toBe(1);
  });
});

// ── P2: content/state/kev-index.json and the CVE-2026-118527 re-join ──────────────────────────────

describe("kev-index: build, update, re-join", () => {
  it("builds every catalog entry, all eras, ransomware lower-cased, in KEV order", () => {
    const cat = catalogOf([
      kevEntry("CVE-2026-1002", "2026-10-02", "B", "Known"), kevEntry("CVE-2021-44228", "2021-12-10", "Apache"), kevEntry("CVE-2026-1010", "2026-10-02"),
    ]);
    const idx = buildKevIndex(cat, new Map([["CVE-2021-44228", published("2021-12-10", "apache")], ["CVE-2026-1002", { state: "REJECTED", date_published: "2026-09-01", assigner: "b" }]]), "2026-11-06");
    expect(KevIndexFile.parse(idx)).toEqual(idx);
    expect(idx.entries).toEqual([
      ["CVE-2021-44228", "2021-12-10", "Apache", "Product", "2021-12-10", "apache", "unknown"],
      ["CVE-2026-1002", "2026-10-02", "B", "Product", null, null, "known"],
      ["CVE-2026-1010", "2026-10-02", "Example", "Product", null, null, "unknown"],
    ]);
    expect(idx).toMatchObject({ updated_at: "2026-11-06", catalog_version: "2026.11.06" });
    expect(indexFacts(idx)).toEqual(new Map([["CVE-2021-44228", published("2021-12-10", "apache")]]));
    expect(indexEntries(idx).map((e) => e.cveID)).toEqual(["CVE-2021-44228", "CVE-2026-1002", "CVE-2026-1010"]);
  });

  it("re-joins CVE-2026-118527 on the first run whose by-id fetch finds it (lag −4, at disclosure, in w26)", () => {
    // The earlier index: listed 2026-10-30 (US date) before its record existed.
    const earlier: KevIndexFile = {
      schema_version: 1, updated_at: "2026-11-01", catalog_version: "2026.10.30",
      entries: [["CVE-2026-118527", "2026-10-30", "Ivanti", "Connect Secure", null, null, "unknown"]],
    };
    const cat = catalogOf([kevEntry("CVE-2026-118527", "2026-10-30", "Ivanti")]);
    const before = joinKev(indexEntries(earlier), indexFacts(earlier));
    expect(before[0]!.lag_days).toBeNull();
    expect(windowStats(before, "2026-05-09", "2026-11-06")).toMatchObject({ unjoined_n: 1, at_disclosure_n: 0 });

    // A by-id 404 leaves it unjoined.
    const still = updateKevIndex(earlier, cat, new Map([["CVE-2026-118527", null]]), "2026-11-02");
    expect(still.entries[0]![4]).toBeNull();

    const facts = cveFacts(RECORD_118527);
    expect(facts).toMatchObject({ cve_id: "CVE-2026-118527", state: "PUBLISHED", date_published: "2026-11-03", assigner: "ivanti" });
    const next = updateKevIndex(earlier, cat, new Map([["CVE-2026-118527", facts]]), "2026-11-06");
    expect(next.entries[0]).toEqual(["CVE-2026-118527", "2026-10-30", "Ivanti", "Product", "2026-11-03", "ivanti", "unknown"]);
    const rows = joinKev(indexEntries(next), indexFacts(next));
    expect(rows[0]).toMatchObject({ lag_days: -4 });
    expect(bandOf(rows[0]!.lag_days)).toBe("at_disclosure");
    const w = gapWindow(rows, "2026-11-06").window.w26;
    expect(w).toMatchObject({ kev_added_n: 1, unjoined_n: 0, cohort_n: 1, at_disclosure_n: 1, k7_n: 1 });
  });

  it("mirrors the current catalog: removed entries leave, joined facts stay, new entries take the fetched facts", () => {
    const prev: KevIndexFile = {
      schema_version: 1, updated_at: "2026-11-05", catalog_version: "2026.11.05",
      entries: [
        ["CVE-2026-1001", "2026-10-01", "A", "Old name", "2026-09-30", "a", "unknown"],
        ["CVE-2026-1002", "2026-10-02", "B", "Product", "2026-09-01", "b", "unknown"],
      ],
    };
    const cat = catalogOf([kevEntry("CVE-2026-1001", "2026-10-01", "A", "Known"), kevEntry("CVE-2026-1003", "2026-11-06", "C")]);
    const next = updateKevIndex(prev, cat, new Map([["CVE-2026-1003", published("2026-11-05", "c")], ["CVE-2026-1001", published("2026-01-01", "zz")]]), "2026-11-06");
    expect(next.entries).toEqual([
      ["CVE-2026-1001", "2026-10-01", "A", "Product", "2026-09-30", "a", "known"],
      ["CVE-2026-1003", "2026-11-06", "C", "Product", "2026-11-05", "c", "unknown"],
    ]);
    expect(next.catalog_version).toBe("2026.11.06");
  });
});

describe("kevSummary", () => {
  const cat = catalogOf([kevEntry("CVE-2026-104935", "2026-10-13"), kevEntry("CVE-2026-96951", "2026-10-13"), kevEntry("CVE-2026-1001", "2026-10-01")]);
  const baseline = { catalog_version: "2026.10.12", entries: [["CVE-2026-1001", "2026-10-01", "x", "y", null, null, "unknown"]] as KevIndexFile["entries"] };

  it("lists the entries not in the baseline in KEV order, as newKevIds() does", () => {
    const s = kevSummary(cat, baseline);
    expect(KevSummary.parse(s)).toEqual(s);
    expect(s).toEqual({
      catalog_version: "2026.11.06", catalog_count: 3, date_released: "2026-11-06T19:44:45.1797Z",
      new_since_last_edition: { since_catalog_version: "2026.10.12", cve_ids: ["CVE-2026-96951", "CVE-2026-104935"] },
    });
    const viaFeeds = newKevIds({ date: "2026-10-14", catalog: cat, asOf: false, committedMetrics: null, kevIndex: baseline });
    expect(s.new_since_last_edition.cve_ids).toEqual(viaFeeds.newKevIds);
  });

  it("lists nothing new without a baseline", () => {
    expect(kevSummary(cat, null).new_since_last_edition).toEqual({ since_catalog_version: null, cve_ids: [] });
  });
});
