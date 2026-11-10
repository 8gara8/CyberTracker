// lib/metrics/flood.ts (SPEC §5.4, §4.7 days.json): countDay(), countDays(), idsSha256(), missingDays()
// and floodStats(), on inline records (through WP1's cveFacts() where the record shape matters) and
// synthetic days. The D.3 Flood block from the reference fixture is checked in tests/reference.test.ts.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { cveFacts } from "@/lib/feeds/cvelist";
import type { CveFacts } from "@/lib/feeds/types";
import { countDay, countDays, dayIds, dayMap, floodStats, idsSha256, missingDays, yearAgo } from "@/lib/metrics/flood";
import { FLOOD_REFERENCE_W13, FLOOD_REFERENCE_W13_EX_KERNEL } from "@/lib/metrics/reference";
import { round4, roundTo } from "@/lib/metrics/stats";
import { DayRow, Flood, type DayRow as DayRowT } from "@/lib/schema/metrics";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const EMPTY = sha("");

/** A trimmed CVE record: metadata, an optional CNA metrics block and optional ADP entries. No text, credits or links. */
function record(id: string, o: { state?: string; published?: string; assigner?: string; cnaMetrics?: unknown[]; adp?: unknown[] } = {}): unknown {
  return {
    dataType: "CVE_RECORD",
    dataVersion: "5.2",
    cveMetadata: { cveId: id, state: o.state ?? "PUBLISHED", assignerShortName: o.assigner ?? "example", datePublished: o.published ?? "2026-10-12T10:00:00.000Z" },
    containers: { cna: { providerMetadata: { shortName: o.assigner ?? "example" }, metrics: o.cnaMetrics ?? [] }, adp: o.adp ?? [] },
  };
}
const facts = (raw: unknown): CveFacts => {
  const f = cveFacts(raw);
  if (!f) throw new Error("cveFacts gave null");
  return f;
};
const v31 = (score: unknown) => ({ format: "CVSS", cvssV3_1: { version: "3.1", baseScore: score, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" } });

describe("idsSha256", () => {
  it("hashes the ids in code-unit order joined by newlines, and the empty string for none", () => {
    expect(idsSha256([])).toBe(EMPTY);
    expect(idsSha256(["CVE-2026-9", "CVE-2026-10"])).toBe(sha("CVE-2026-10\nCVE-2026-9"));
    expect(idsSha256(["CVE-2026-10", "CVE-2026-9"])).toBe(idsSha256(["CVE-2026-9", "CVE-2026-10"]));
  });
});

describe("countDay (§5.4)", () => {
  it("counts PUBLISHED records of the day only; kernel is assigner exactly 'Linux'", () => {
    const recs = [
      facts(record("CVE-2026-1001", { assigner: "Linux" })),
      facts(record("CVE-2026-1002", { assigner: "linux" })),
      facts(record("CVE-2026-1003", { state: "REJECTED" })),
      facts(record("CVE-2026-1004", { published: "2026-10-11T23:59:59.000Z" })),
      facts(record("CVE-2026-1005", { cnaMetrics: [v31(9.8)] })),
    ];
    const row = countDay("2026-10-12", recs);
    expect(DayRow.parse(row)).toEqual(row);
    expect(row).toEqual(["2026-10-12", 3, 1, 2, idsSha256(["CVE-2026-1001", "CVE-2026-1002", "CVE-2026-1005"])]);
    expect(dayIds("2026-10-12", recs)).toEqual(["CVE-2026-1001", "CVE-2026-1002", "CVE-2026-1005"]);
  });

  it("treats CVSS v2 only, a non-CISA ADP score and a string baseScore as unscored, and a CISA-ADP v3.1 score as scored", () => {
    const v2only = facts(record("CVE-2026-2001", { cnaMetrics: [{ format: "CVSS", cvssV2_0: { version: "2.0", baseScore: 7.5, vectorString: "AV:N/AC:L/Au:N/C:P/I:P/A:P" } }] }));
    const nvdAdp = facts(record("CVE-2026-2002", { adp: [{ providerMetadata: { shortName: "NVD" }, metrics: [v31(7.5)] }] }));
    const strScore = facts(record("CVE-2026-2003", { cnaMetrics: [v31("7.5")] }));
    const cisaAdp = facts(record("CVE-2026-2004", { adp: [{ providerMetadata: { shortName: "CISA-ADP" }, metrics: [v31(7.5)] }] }));
    expect([v2only, nvdAdp, strScore, cisaAdp].map((f) => f.scored)).toEqual([false, false, false, true]);
    expect(countDay("2026-10-12", [v2only, nvdAdp, strScore, cisaAdp])[3]).toBe(3);
  });

  it("counts the last copy of a repeated id (X + 1's copy wins)", () => {
    const old = facts(record("CVE-2026-3001", { state: "PUBLISHED" }));
    const rejected = facts(record("CVE-2026-3001", { state: "REJECTED" }));
    expect(countDay("2026-10-12", [old, rejected])[1]).toBe(0);
    expect(countDay("2026-10-12", [rejected, old])[1]).toBe(1);
  });

  describe("zone-less timestamps", () => {
    const tz = process.env.TZ;
    afterEach(() => {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });
    it("counts CVE-2022-38369 and CVE-2022-38370 on 2022-09-05, also with TZ=Asia/Taipei", () => {
      const recs = () => [
        facts(record("CVE-2022-38369", { published: "2022-09-05T09:50:09" })),
        facts(record("CVE-2022-38370", { published: "2022-09-05T09:50:10" })),
      ];
      const utc = countDay("2022-09-05", recs());
      process.env.TZ = "Asia/Taipei";
      const taipei = countDay("2022-09-05", recs());
      expect(utc[1]).toBe(2);
      expect(taipei).toEqual(utc);
    });
  });

  it("writes a zero day as [d, 0, 0, 0, sha256('')]", () => {
    expect(countDay("2023-05-13", [])).toEqual(["2023-05-13", 0, 0, 0, EMPTY]);
  });
});

describe("countDays", () => {
  it("writes every calendar day, zero days included", () => {
    const recs = [
      facts(record("CVE-2023-0001", { published: "2023-01-01T00:00:00Z", assigner: "Linux" })),
      facts(record("CVE-2023-0002", { published: "2023-01-03T12:00:00Z" })),
      facts(record("CVE-2023-0003", { published: "2022-12-31T23:59:59Z" })),
      facts(record("CVE-2023-0004", { published: "2023-01-04T00:00:00Z" })),
    ];
    const rows = countDays("2023-01-01", "2023-01-03", recs);
    expect(rows.map((r) => r.slice(0, 4))).toEqual([["2023-01-01", 1, 1, 1], ["2023-01-02", 0, 0, 0], ["2023-01-03", 1, 0, 1]]);
    expect(rows[1]![4]).toBe(EMPTY);
    expect(rows).toEqual(["2023-01-01", "2023-01-02", "2023-01-03"].map((d) => countDay(d, recs)));
  });
});

/** Synthetic days.json rows from `from` to `to`: n = 100 + day of month, kernel 10, unscored 3. */
function synthDays(from: string, to: string, n: (d: string) => number = (d) => 100 + Number(d.slice(8))): DayRowT[] {
  const out: DayRowT[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push([d, n(d), 10, 3, EMPTY]);
  return out;
}

describe("floodStats (§5.4)", () => {
  const cutoff = "2026-11-06";
  const days = synthDays("2025-01-01", cutoff);

  it("sums w13, its year-ago window and the newest complete week", () => {
    const map = dayMap(days);
    const { flood, missing } = floodStats(map, cutoff);
    expect(missing).toEqual([]);
    expect(Flood.parse(flood)).toEqual(flood);
    const sum = (from: string, to: string) => days.filter((d) => d[0] >= from && d[0] <= to).reduce((a, d) => a + d[1], 0);
    const n = sum("2026-08-08", "2026-11-06");
    const ya = sum("2025-08-09", "2025-11-07");
    expect(flood).toMatchObject({
      from: "2026-08-08", to: "2026-11-06", n, kernel_n: 910, ex_kernel_n: n - 910, unscored_n: 273,
      year_ago: { from: "2025-08-09", to: "2025-11-07", n: ya, kernel_n: 910, ex_kernel_n: ya - 910 },
      yoy_pct: roundTo((n / ya - 1) * 100, 1),
      yoy_ex_kernel_pct: roundTo(((n - 910) / (ya - 910) - 1) * 100, 1),
      reference: { w13_mean_n: 8561.1, w13_mean_ex_kernel_n: 8027.4 },
      vs_reference_pct: roundTo((n / FLOOD_REFERENCE_W13 - 1) * 100, 1),
      vs_reference_ex_kernel_pct: roundTo(((n - 910) / FLOOD_REFERENCE_W13_EX_KERNEL - 1) * 100, 1),
      vs_reference_ratio: round4(n / FLOOD_REFERENCE_W13),
      vs_reference_ex_kernel_ratio: round4((n - 910) / FLOOD_REFERENCE_W13_EX_KERNEL),
      last_week: { week_start: "2026-10-26", n: sum("2026-10-26", "2026-11-01"), kernel_n: 70, unscored_n: 21 },
    });
    expect(yearAgo({ from: "2026-08-08", to: "2026-11-06" })).toEqual({ from: "2025-08-09", to: "2025-11-07" });
  });

  it("gives D.3's Flood ratios and percentages from its counts", () => {
    // D.3: 44,944 in w13 with 4,804 kernel; 12,275 a year earlier with 1,574 kernel.
    const d = (m: Record<string, [number, number]>) => synthDays("2025-01-01", cutoff).map((r): DayRowT => [r[0], m[r[0]]?.[0] ?? 0, m[r[0]]?.[1] ?? 0, 0, EMPTY]);
    const map = dayMap(d({ "2026-10-27": [44944, 4804], "2025-08-09": [12275, 1574] }));
    const { flood } = floodStats(map, cutoff);
    expect(flood).toMatchObject({ n: 44944, ex_kernel_n: 40140, yoy_pct: 266.1, yoy_ex_kernel_pct: 275.1, vs_reference_pct: 425, vs_reference_ex_kernel_pct: 400,
      vs_reference_ratio: 5.2498, vs_reference_ex_kernel_ratio: 5.0004 });
  });

  it("is null with the missing dates when a day of w13, the year-ago window or the last week is absent", () => {
    for (const gap of ["2026-09-15", "2025-09-15", "2026-10-28", "2026-11-06"]) {
      const map = dayMap(days.filter((d) => d[0] !== gap));
      expect(floodStats(map, cutoff)).toEqual({ flood: null, missing: [gap] });
    }
    // A day outside every window does not matter.
    expect(floodStats(dayMap(days.filter((d) => d[0] !== "2026-01-15")), cutoff).flood).not.toBeNull();
  });

  it("gives yoy null when the year-ago denominator is below MIN_N", () => {
    const thin = days.map((d): DayRowT => (d[0] >= "2025-08-09" && d[0] <= "2025-11-07" ? [d[0], d[0] === "2025-08-09" ? 29 : 0, 0, 0, EMPTY] : d));
    const { flood } = floodStats(dayMap(thin), cutoff);
    expect(flood?.year_ago.n).toBe(29);
    expect(flood?.yoy_pct).toBeNull();
    expect(flood?.yoy_ex_kernel_pct).toBeNull();
    const ok = thin.map((d): DayRowT => (d[0] === "2025-08-09" ? [d[0], 30, 0, 0, EMPTY] : d));
    expect(floodStats(dayMap(ok), cutoff).flood?.yoy_pct).not.toBeNull();
  });
});

describe("missingDays", () => {
  it("lists the absent days oldest first", () => {
    const map = dayMap(synthDays("2026-10-01", "2026-10-10").filter((d) => d[0] !== "2026-10-04" && d[0] !== "2026-10-07"));
    expect(missingDays(map, "2026-09-30", "2026-10-10")).toEqual(["2026-09-30", "2026-10-04", "2026-10-07"]);
    expect(missingDays(map, "2026-10-08", "2026-10-10")).toEqual([]);
  });
});
