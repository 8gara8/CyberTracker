// The Angle's one number (SPEC §4.12, §0.4 row 145): a metric Angle may print the figures its own quotable
// label prints ("26 weeks", "within 7 days", "2 to 30 days", "80% interval"), and WORDS_OVER, WORDS_UNDER
// and LEAD_GROUNDED do not count them. Checked over every quotable row of the canary's metrics
// (fixtures/injection/metrics.json) and of the quiet, Monday and weekday fixtures, so a label the agent
// copies with its display never fails the canary's one shot (Kobol, 2026-11-11).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mondayDraft, weekdayDraft } from "@/fixtures/src/drafts";
import { draftInputs } from "@/fixtures/src/inputs";
import type { EditionName } from "@/fixtures/src/world";
import { quotableRows } from "@/lib/metrics/headline";
import { RULES } from "@/lib/rules";
import { angleFigures, angleNumbers } from "@/lib/rules/grounding";
import type { ValidationIssue } from "@/lib/rules/types";
import type { DraftBrief } from "@/lib/schema/draft-brief";
import { Metrics } from "@/lib/schema/metrics";
import { numbersIn } from "@/lib/text";
import { validateDraft } from "@/lib/validate";

const CODES = ["WORDS_OVER", "WORDS_UNDER", "LEAD_GROUNDED"];
const RULES_HERE = RULES.filter((r) => r.codes.some((c) => CODES.includes(c)));

const canaryMetrics = (): Metrics =>
  Metrics.parse(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "injection", "metrics.json"), "utf8")));

/** The metrics files the agent sees quotable rows from: the canary's, and the three fixture editions'. */
const SETS: readonly { name: string; metrics: () => Metrics }[] = [
  { name: "canary", metrics: canaryMetrics },
  ...(["quiet", "monday", "weekday"] as const satisfies readonly EditionName[]).map((n) => ({ name: n, metrics: () => draftInputs(n).metrics! })),
];

/** The Monday draft with a metric Angle on `metrics`; only the Angle's WORDS_* and LEAD_GROUNDED issues. */
function angleIssues(metrics: Metrics, metricPath: string, text: string): ValidationIssue[] {
  const d: DraftBrief = mondayDraft();
  d.angle = { ...d.angle, source_id: null, metric_path: metricPath, as_of: metrics.data_cutoff_utc, text };
  const r = validateDraft(d, { ...draftInputs("monday"), metrics, rules: RULES_HERE });
  return r.errors.filter((e) => CODES.includes(e.code) && e.path.startsWith("angle"));
}
const codes = (xs: readonly ValidationIssue[]) => [...new Set(xs.map((x) => `${x.code} ${x.path}`))].sort();

describe("a metric Angle that copies its quotable row (row 145)", () => {
  for (const set of SETS) {
    it(`${set.name}: "<label>: <display>." passes WORDS_OVER, WORDS_UNDER and LEAD_GROUNDED for every row`, () => {
      const m = set.metrics();
      const rows = quotableRows(m);
      expect(rows.length).toBeGreaterThan(50);
      for (const r of rows) {
        const text = `${r.label}: ${r.display}.`;
        expect(angleIssues(m, r.key, text), `${r.key} | ${text}`).toEqual([]);
      }
    });

    it(`${set.name}: every key but "constant" shows exactly one display`, () => {
      const shown = new Map<string, Set<string>>();
      for (const r of quotableRows(set.metrics())) shown.set(r.key, (shown.get(r.key) ?? new Set()).add(r.display));
      for (const [key, displays] of shown) if (key !== "constant") expect([...displays], key).toHaveLength(1);
      expect([...shown.get("constant")!]).toEqual(["26", "13"]);
    });

    it(`${set.name}: the other window on a row fails WORDS_OVER and LEAD_GROUNDED`, () => {
      const m = set.metrics();
      let checked = 0;
      for (const r of quotableRows(m)) {
        const w = /, (26|13) weeks$/.exec(r.label)?.[1];
        if (!w) continue;
        const other = w === "26" ? "13" : "26";
        const text = `${r.label.replace(`${w} weeks`, `${other} weeks`)}: ${r.display}.`;
        const got = codes(angleIssues(m, r.key, text));
        expect(got, `${r.key} | ${text}`).toContain("WORDS_OVER angle.text");
        // LEAD_GROUNDED reads each written number once, so a wrong window equal to the row's own display ("13 weeks: 13") is WORDS_OVER's alone.
        if (r.display !== other) expect(got, `${r.key} | ${text}`).toContain("LEAD_GROUNDED angle.text");
        checked += 1;
      }
      expect(checked).toBeGreaterThan(40);
    });
  }

  it("a path whose labels print no figure counts a window like any number", () => {
    const m = canaryMetrics();
    expect(angleFigures({ metric_path: "window.reference.at_disclosure_share" }, m)).toEqual([]);
    const got = angleIssues(m, "window.reference.at_disclosure_share", "In 2023–24, 37% of recently disclosed flaws on CISA's list were exploited at disclosure, over 26 weeks.");
    expect(codes(got)).toEqual(["LEAD_GROUNDED angle.text", "WORDS_OVER angle.text"]);
    expect(got.find((e) => e.code === "LEAD_GROUNDED")!.message).toContain("holds 26");
    // A path with no quotable row (a raw value) has no figures either.
    expect(angleFigures({ metric_path: "flood.kernel_n" }, m)).toEqual([]);
  });

  it("an old-flaws Angle may give their age as the label does, more than 365 days old", () => {
    const m = canaryMetrics();
    expect(angleIssues(m, "window.w26.old_listed_n", "CISA newly listed 22 flaws more than 365 days old in the last 26 weeks.")).toEqual([]);
    expect(angleIssues(m, "window.w26.old_listed_n", "In the 26 weeks to 12 Oct, CISA newly listed 22 365-day-old flaws.")).toEqual([]);
    // The late-listed band's label prints a range, not an age: a lone "365 days old" counts there.
    const got = angleIssues(m, "window.w26.late_listed_n", "CISA listed 37 flaws 365 days old in the last 26 weeks.");
    expect(codes(got)).toEqual(["LEAD_GROUNDED angle.text", "WORDS_OVER angle.text"]);
  });

  it("a sourced Angle has no figures: its text is read with numbersIn(), as before", () => {
    const m = canaryMetrics();
    const sourced = weekdayDraft().angle;
    expect(sourced.metric_path).toBeNull();
    for (const text of [sourced.text, "Red Hat has credited AISLE with 24 flaws in 26 weeks.", "24 flaws within 7 days, an 80% interval of 2 to 30 days."]) {
      expect(angleFigures(sourced, m)).toEqual([]);
      expect(angleNumbers({ ...sourced, text }, m)).toEqual(numbersIn(text));
      expect(angleNumbers({ ...sourced, text }, null)).toEqual(numbersIn(text));
    }
  });

  it("collects the figures of every row under the path, each once, and the Gap's two windows without metrics", () => {
    const m = canaryMetrics();
    const texts = (p: string, mm: Metrics | null = m) => angleFigures({ metric_path: p }, mm).map((f) => f.text);
    expect(texts("window.w26.at_disclosure_share")).toEqual(["26 weeks"]);
    expect(texts("window.w26.p7")).toEqual(["7 days", "26 weeks"]);
    expect(texts("window.w26.p7_ci80.0")).toEqual(["80% interval", "7 days", "26 weeks"]);
    expect(texts("window.w26.n_day_n")).toEqual(["2 to 30 days", "26 weeks"]);
    expect(texts("window.w26.n_day_share")).toEqual(["2 to 30 days", "26 weeks"]);
    expect(texts("window.w13.late_listed_n")).toEqual(["31 to 365 days", "13 weeks"]);
    expect(texts("window.reference.old_listed_n")).toEqual(["365 days old"]);
    expect(texts("window.reference.old_listed_pace_13w")).toEqual(["13 weeks"]);
    expect(texts("window.kev_pace_ratio")).toEqual(["26 weeks"]);
    expect(texts("flood.vs_reference_ex_kernel_ratio")).toEqual(["13 weeks"]);
    expect(texts("home_vendors.tw.d90_n")).toEqual(["90 days"]);
    expect(texts("constant")).toEqual([]);
    expect(texts("window.w26.p7", null)).toEqual(["26 weeks", "13 weeks"]);
  });
});
