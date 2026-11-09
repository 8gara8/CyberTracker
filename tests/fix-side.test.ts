// The fix-side strip (SPEC §5.6, rulings R10, R11, R13): the GHSA unfixed window and share, the dashboard
// state, fix_side's block status and notes, and the 52-week keep rule. Inline data only; the GHSA table
// is the as-of result recorded for the P2 PR (cutoff 2026-11-07). No content/ and no network.

import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import type { CvdDashboard, GhsaAdvisory } from "@/lib/feeds/types";
import {
  CVD_STALE_DAYS, FIX_NOTES, GHSA_DECISION, GHSA_UNFIXED_KEPT, anthropicCvdFigures, fixSide, ghsaKeepDecision, ghsaUnfixed, ghsaUnfixedWindow,
  updateAnthropicCvd, type GhsaWeek,
} from "@/lib/metrics/fix-side";
import { round4 } from "@/lib/metrics/stats";
import { fixSideLines } from "@/lib/page-text";
import { AnthropicCvdFile, FixSide, MetricsBlock, type AnthropicCvdFile as CvdFileT, type FixSide as FixSideT } from "@/lib/schema/metrics";

const C = "2026-11-06";
const EMPTY_CVD: CvdFileT = {
  schema_version: 1, updated_at: "2026-11-01", revision: null, as_of: null, fetched_at: null, source_url: null,
  found_n: null, disclosed_n: null, patched_n: null, ledger_ids: [],
};
const SOURCE = "https://example.com/ct-sample/cvd-dashboard";

let seq = 0;
function adv(published: string, fixed: boolean, over: Partial<GhsaAdvisory> = {}): GhsaAdvisory {
  seq += 1;
  return {
    id: `GHSA-test-${String(seq).padStart(4, "0")}-aaaa`, aliases: [], cve_ids: [], published_at: `${published}T12:00:00Z`, published,
    modified: `${published}T12:00:00Z`, withdrawn: null, severity: "moderate", reviewed: true, fixed, summary: null, packages: [], ...over,
  };
}
const many = (n: number, published: string, fixed: boolean) => Array.from({ length: n }, () => adv(published, fixed));

function cvdState(asOf: string, revision = "40"): CvdFileT {
  return {
    schema_version: 1, updated_at: asOf, revision, as_of: asOf, fetched_at: `${asOf}T21:00:00Z`, source_url: SOURCE,
    found_n: 6009, disclosed_n: 5087, patched_n: 629, ledger_ids: ["CVE-2026-1001"],
  };
}

describe("ghsaUnfixedWindow and ghsaUnfixed (§5.1, §5.6 item 2)", () => {
  it("is cutoff minus 120 to cutoff minus 30 days (2026-07-09 to 2026-10-07 for 2026-11-06)", () => {
    expect(ghsaUnfixedWindow(C)).toEqual({ from: "2026-07-09", to: "2026-10-07" });
  });

  it("counts the window's ends in and the days beyond them out", () => {
    const advs = [
      ...many(20, addDays(C, -120), false), ...many(15, addDays(C, -30), true),
      ...many(7, addDays(C, -121), false), ...many(9, addDays(C, -29), false),
    ];
    expect(ghsaUnfixed(advs, C, "2026-11-07")).toEqual({ share: round4(20 / 35), n_unfixed: 20, n_total: 35, from: "2026-07-09", to: "2026-10-07", as_of: "2026-11-07" });
  });

  it("leaves out withdrawn and unreviewed advisories and counts an id once", () => {
    const one = adv("2026-08-01", false);
    const advs = [
      ...many(30, "2026-08-01", true), one, one,
      adv("2026-08-01", false, { withdrawn: "2026-09-01T00:00:00Z" }), adv("2026-08-01", false, { reviewed: false }),
    ];
    expect(ghsaUnfixed(advs, C, "2026-11-07")).toMatchObject({ n_total: 31, n_unfixed: 1, share: round4(1 / 31) });
  });

  it("gives a null share below MIN_N, and fixSideLines leaves the line out", () => {
    const g29 = ghsaUnfixed(many(29, "2026-08-01", false), C, "2026-11-07");
    expect(g29).toMatchObject({ share: null, n_total: 29, n_unfixed: 29 });
    expect(FixSide.parse({ anthropic_cvd: null, ghsa_unfixed: g29 }).ghsa_unfixed?.share).toBeNull();
    expect(fixSideLines({ anthropic_cvd: null, ghsa_unfixed: g29 }, "2026-11-08")).toHaveLength(1); // the caption only
    const g30 = ghsaUnfixed(many(30, "2026-08-01", false), C, "2026-11-07");
    expect(g30.share).toBe(1);
    expect(fixSideLines({ anthropic_cvd: null, ghsa_unfixed: g30 }, "2026-11-08")[0]).toBe(
      "100% of GitHub-reviewed advisories published 30 to 120 days ago still list no fixed version (30 of 30, 7 Nov).",
    );
  });
});

describe("updateAnthropicCvd and anthropicCvdFigures (§5.6 item 1)", () => {
  const read: CvdDashboard = { revision: "41", as_of: "2026-11-02T19:30:00Z", found_n: 6100, disclosed_n: 5200, patched_n: 650, ledger_ids: ["GHSA-zzzz-0000-0001", "CVE-2026-1002", "CVE-2026-999", "CVE-2026-1002"] };
  const meta = { fetchedAt: "2026-11-07T20:41:12Z", sourceUrl: SOURCE };

  it("replaces the state on a new revision, with fetched_at and source_url from the feed index", () => {
    const next = updateAnthropicCvd(cvdState("2026-10-20"), read, meta, C);
    expect(next).toEqual({
      schema_version: 1, updated_at: C, revision: "41", as_of: "2026-11-02", fetched_at: "2026-11-07T20:41:12Z", source_url: SOURCE,
      found_n: 6100, disclosed_n: 5200, patched_n: 650, ledger_ids: ["CVE-2026-999", "CVE-2026-1002", "GHSA-zzzz-0000-0001"],
    });
    expect(AnthropicCvdFile.parse(next)).toEqual(next);
  });

  it("writes nothing new on the same revision, a failed read or an unreadable date", () => {
    const prev = cvdState("2026-10-20", "41");
    expect(updateAnthropicCvd(prev, read, meta, C)).toBe(prev);
    expect(updateAnthropicCvd(prev, null, meta, C)).toBe(prev);
    expect(updateAnthropicCvd(EMPTY_CVD, { ...read, as_of: "last Tuesday" }, meta, C)).toBe(EMPTY_CVD);
  });

  it("completes a same-revision state read from the page alone once the payload's figures arrive (B3)", () => {
    // Day 1: the payload failed, so the page alone gave revision 41 with no found_n and only the ids it shows.
    const pageOnly = updateAnthropicCvd(cvdState("2026-10-20"), { ...read, found_n: null, ledger_ids: ["CVE-2026-1002"] }, meta, C);
    expect(pageOnly).toMatchObject({ revision: "41", found_n: null, ledger_ids: ["CVE-2026-1002"] });
    // Day 2: the payload answers for the same revision; its figures and full ledger replace the page-only read.
    const later = { fetchedAt: "2026-11-08T20:41:12Z", sourceUrl: SOURCE };
    const full = updateAnthropicCvd(pageOnly, read, later, "2026-11-07");
    expect(full).toMatchObject({ revision: "41", found_n: 6100, fetched_at: later.fetchedAt, updated_at: "2026-11-07", ledger_ids: ["CVE-2026-999", "CVE-2026-1002", "GHSA-zzzz-0000-0001"] });
    // A page-only read never replaces a payload read of the same revision.
    expect(updateAnthropicCvd(full, { ...read, found_n: null }, meta, "2026-11-08")).toBe(full);
  });

  it("is null before any read, ok at 14 days and stale at 15", () => {
    expect(anthropicCvdFigures(EMPTY_CVD, C)).toBeNull();
    expect(CVD_STALE_DAYS).toBe(14);
    expect(anthropicCvdFigures(cvdState(addDays(C, -14)), C)?.status).toBe("ok");
    expect(anthropicCvdFigures(cvdState(addDays(C, -15)), C)?.status).toBe("stale");
    expect(anthropicCvdFigures(cvdState("2026-11-02"), C)).toEqual({
      status: "ok", revision: "40", as_of: "2026-11-02", fetched_at: "2026-11-02T21:00:00Z", found_n: 6009, disclosed_n: 5087, patched_n: 629, source_url: SOURCE,
    });
  });
});

describe("fixSide and blocks.fix_side (ruling R13)", () => {
  const advisories = [...many(40, "2026-08-01", true), ...many(10, "2026-09-01", false)];
  const okGhsa = { status: "ok" as const, advisories, headDate: "2026-11-07" };
  const failedGhsa = { status: "failed" as const, advisories: [], headDate: null };
  const previousGhsa: NonNullable<FixSideT["ghsa_unfixed"]> = { share: 0.05, n_unfixed: 100, n_total: 2000, from: "2026-07-06", to: "2026-10-04", as_of: "2026-11-03" };
  const previous = {
    fix_side: { anthropic_cvd: null, ghsa_unfixed: previousGhsa },
    blocks: { flood: ok(), window: ok(), ai_credited: ok(), fix_side: ok(), kev: ok(), home_vendors: ok() },
  };
  function ok() { return { status: "ok" as const, as_of: "2026-11-03", note: null }; }
  const check = (r: ReturnType<typeof fixSide>) => {
    expect(FixSide.parse(r.fix_side)).toEqual(r.fix_side);
    expect(MetricsBlock.parse(r.block)).toEqual(r.block);
    return r;
  };

  it("is ok with both parts fresh, as of the cutoff", () => {
    const r = check(fixSide({ cutoff: C, cvd: cvdState("2026-11-02"), ghsa: okGhsa, previous }));
    expect(r.block).toEqual({ status: "ok", as_of: C, note: null });
    expect(r.fix_side.ghsa_unfixed).toEqual({ share: 0.2, n_unfixed: 10, n_total: 50, from: "2026-07-09", to: "2026-10-07", as_of: "2026-11-07" });
    expect(r.fix_side.anthropic_cvd?.status).toBe("ok");
    expect(GHSA_UNFIXED_KEPT).toBe(true);
  });

  it("is stale when the dashboard is old, as of its date, with its note", () => {
    const r = check(fixSide({ cutoff: C, cvd: cvdState("2026-10-20"), ghsa: okGhsa, previous: null }));
    expect(r.block).toEqual({ status: "stale", as_of: "2026-10-20", note: FIX_NOTES.cvdStale("2026-10-20") });
    expect(r.block.note).toBe("The Anthropic dashboard has shown no new revision since 20 Oct 2026.");
    expect(fixSideLines(r.fix_side, "2026-11-08")[0]).toBe(
      "Anthropic disclosure dashboard (one lab, open source only, self-reported), revision 40, 20 Oct: 6,009 confirmed findings, 5,087 disclosed, 629 patched upstream. Not updated since 20 Oct.",
    );
  });

  it("carries the previous GitHub value when the feed failed or went stale, and is stale as of that value", () => {
    for (const status of ["failed", "stale", "skipped"] as const) {
      const r = check(fixSide({ cutoff: C, cvd: EMPTY_CVD, ghsa: { status, advisories, headDate: "2026-11-07" }, previous }));
      expect(r.fix_side).toEqual({ anthropic_cvd: null, ghsa_unfixed: previousGhsa });
      expect(r.block).toEqual({ status: "stale", as_of: "2026-11-03", note: "GitHub advisories were not read today; the unfixed share is from 3 Nov 2026." });
    }
    const noHead = check(fixSide({ cutoff: C, cvd: EMPTY_CVD, ghsa: { status: "ok", advisories, headDate: null }, previous }));
    expect(noHead.block.status).toBe("stale");
  });

  it("is stale as of the oldest part when both are earlier values, with both notes", () => {
    const r = check(fixSide({ cutoff: C, cvd: cvdState("2026-10-01"), ghsa: failedGhsa, previous }));
    expect(r.block).toEqual({ status: "stale", as_of: "2026-10-01", note: `${FIX_NOTES.cvdStale("2026-10-01")} ${FIX_NOTES.ghsaStale("2026-11-03")}` });
    expect(r.block.note!.length).toBeLessThanOrEqual(200);
  });

  it("is ok on one fresh part when the other has no value, and failed when neither has one", () => {
    expect(check(fixSide({ cutoff: C, cvd: cvdState("2026-11-02"), ghsa: failedGhsa, previous: null })).block).toEqual({ status: "ok", as_of: C, note: null });
    expect(check(fixSide({ cutoff: C, cvd: EMPTY_CVD, ghsa: okGhsa, previous: null })).block).toEqual({ status: "ok", as_of: C, note: null });
    const none = check(fixSide({ cutoff: C, cvd: EMPTY_CVD, ghsa: failedGhsa, previous: null }));
    expect(none).toEqual({ fix_side: { anthropic_cvd: null, ghsa_unfixed: null }, block: { status: "failed", as_of: null, note: null } });
    const prevNone = { ...previous, fix_side: { anthropic_cvd: null, ghsa_unfixed: null } };
    expect(check(fixSide({ cutoff: C, cvd: EMPTY_CVD, ghsa: failedGhsa, previous: prevNone })).block.status).toBe("failed");
  });

  it("keeps its notes short, plain and fixed", () => {
    for (const n of [FIX_NOTES.cvdStale("2025-12-31"), FIX_NOTES.ghsaStale("2025-12-31")]) {
      expect(n.length).toBeLessThanOrEqual(100);
      expect(n).not.toMatch(/—/);
    }
  });
});

/** The as-of 52-week values recorded for the P2 PR: [cutoff, n_total, n_unfixed] (cutoff C = 2026-11-07). */
const WEEKS_2026_11_07: [string, number, number][] = [
  ["2025-11-15", 975, 133], ["2025-11-22", 1002, 135], ["2025-11-29", 1049, 150], ["2025-12-06", 1049, 149], ["2025-12-13", 1019, 148],
  ["2025-12-20", 1021, 143], ["2025-12-27", 978, 142], ["2026-01-03", 1013, 155], ["2026-01-10", 1026, 156], ["2026-01-17", 1017, 160],
  ["2026-01-24", 975, 140], ["2026-01-31", 961, 139], ["2026-02-07", 1012, 140], ["2026-02-14", 1036, 148], ["2026-02-21", 1082, 152],
  ["2026-02-28", 1087, 148], ["2026-03-07", 1228, 159], ["2026-03-14", 1312, 177], ["2026-03-21", 1427, 168], ["2026-03-28", 1570, 182],
  ["2026-04-04", 1862, 194], ["2026-04-11", 2037, 189], ["2026-04-18", 2303, 220], ["2026-04-25", 2621, 282], ["2026-05-02", 2955, 331],
  ["2026-05-09", 3260, 376], ["2026-05-16", 3553, 426], ["2026-05-23", 3725, 470], ["2026-05-30", 3843, 476], ["2026-06-06", 4155, 543],
  ["2026-06-13", 4468, 573], ["2026-06-20", 4616, 613], ["2026-06-27", 4577, 597], ["2026-07-04", 4462, 603], ["2026-07-11", 4378, 600],
  ["2026-07-18", 4512, 587], ["2026-07-25", 4511, 521], ["2026-08-01", 4527, 489], ["2026-08-08", 4308, 455], ["2026-08-15", 4125, 414],
  ["2026-08-22", 4207, 364], ["2026-08-29", 4321, 382], ["2026-09-05", 4096, 306], ["2026-09-12", 3730, 251], ["2026-09-19", 3576, 213],
  ["2026-09-26", 3516, 203], ["2026-10-03", 3540, 175], ["2026-10-10", 3482, 158], ["2026-10-17", 3144, 127], ["2026-10-24", 2946, 105],
  ["2026-10-31", 2760, 91], ["2026-11-07", 2926, 76],
];
const asWeeks = (rows: [string, number, number][]): GhsaWeek[] =>
  rows.map(([cutoff, n, u]) => ({ cutoff, commit: "0".repeat(40), as_of: addDays(cutoff, 1), n_total: n, n_unfixed: u, share: n >= 30 ? round4(u / n) : null }));

describe("ghsaKeepDecision (§5.6: n_total ≥ 300 every week, the share reaching 5% once)", () => {
  it("keeps the GitHub line on the recorded 52 weeks, as GHSA_UNFIXED_KEPT says", () => {
    const d = ghsaKeepDecision(asWeeks(WEEKS_2026_11_07));
    expect(d).toEqual({ keep: true, weeks: 52, min_n_total: 961, max_share: 0.1573, weeks_at_peak: 46 });
    expect(d.keep).toBe(GHSA_UNFIXED_KEPT);
  });

  it("drops it at one week of 299, at a peak of 0.0499 or with fewer than 52 weeks; 0.05 exactly keeps it", () => {
    const flat = (n: number, u: number): [string, number, number][] => WEEKS_2026_11_07.map(([c]) => [c, n, u]);
    expect(GHSA_DECISION).toEqual({ weeks: 52, min_total: 300, min_peak: 0.05 });
    const low = flat(1000, 100);
    low[10] = [low[10]![0], 299, 30];
    expect(ghsaKeepDecision(asWeeks(low)).keep).toBe(false);
    expect(ghsaKeepDecision(asWeeks(flat(10000, 499))).keep).toBe(false); // 0.0499
    expect(ghsaKeepDecision(asWeeks(flat(10000, 500))).keep).toBe(true); // 0.05
    expect(ghsaKeepDecision(asWeeks(flat(1000, 100).slice(1))).keep).toBe(false);
  });
});
