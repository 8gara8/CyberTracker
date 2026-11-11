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
import { angleFigures, angleNumbers, figureList, rowFigures } from "@/lib/rules/grounding";
import type { ValidationIssue } from "@/lib/rules/types";
import type { DraftBrief } from "@/lib/schema/draft-brief";
import { Metrics } from "@/lib/schema/metrics";
import { numbersBesideFigures, numbersIn } from "@/lib/text";
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

/** The Monday draft with a zero-item Gap sentence first in its Lead, on `metrics`; only LEAD_GROUNDED's Lead issues. */
function gapLeadIssues(metrics: Metrics, text: string): ValidationIssue[] {
  const d: DraftBrief = mondayDraft();
  d.lead = [{ text, item_ids: [], gap: true }, ...d.lead.slice(1)];
  const r = validateDraft(d, { ...draftInputs("monday"), metrics, rules: RULES_HERE });
  return r.errors.filter((e) => e.code === "LEAD_GROUNDED" && e.path.startsWith("lead[0]"));
}

describe("a Gap sentence that names the day by its dates (review of row 145)", () => {
  for (const set of SETS) {
    it(`${set.name}: holds no number, whether or not its days are quoted`, () => {
      const m = set.metrics();
      const quoted = new Set(m.headline.quoted.flatMap((q) => numbersIn(q.display)).map((n) => n.value));
      // Days no set quotes, so the test does not pass by luck as the canary's 13 to 14 Oct did.
      for (const day of [2, 3, 10, 11, 30]) expect(quoted.has(day), `${set.name} quotes ${day}`).toBe(false);
      for (const text of ["Nothing published from 10 to 11 Nov cleared the bar for an item.",
        "Nothing published between 2 and 3 Nov cleared the bar for an item.", "Nothing published from Oct 30 to Nov 2 cleared the bar for an item.",
        "Nothing published 10–11 Nov cleared the bar for an item.", "Nothing published Nov 10 to 11 cleared the bar for an item."]) {
        expect(gapLeadIssues(m, text), `${set.name} | ${text}`).toEqual([]);
      }
      // A day count beside the dates is still a number the Gap does not quote.
      expect(gapLeadIssues(m, "Nothing published from 10 to 11 Nov cleared the bar, 3 days running.")).toHaveLength(1);
    });

    it(`${set.name}: holds no number in the natural forms of a day range either: and, or, /, through, weekdays (review of the seventh pass)`, () => {
      const m = set.metrics();
      const quoted = new Set(m.headline.quoted.flatMap((q) => numbersIn(q.display)).map((n) => n.value));
      for (const day of [2, 3, 7, 10, 11, 12]) expect(quoted.has(day), `${set.name} quotes ${day}`).toBe(false);
      for (const days of ["on 11 and 12 Nov", "Nov 11 and 12", "on 11 or 12 Nov", "from Tuesday 11 to Wednesday 12 Nov",
        "between Tuesday 11 and Wednesday 12 Nov", "overnight on 11/12 Nov", "11 through 12 Nov", "from Friday 7 to Monday 10 Nov",
        "from Sunday 2 to Monday 3 Nov"]) {
        const text = `Nothing published ${days} cleared the bar for an item.`;
        expect(gapLeadIssues(m, text), `${set.name} | ${text}`).toEqual([]);
      }
      // A spaced dash after the month joins the days at the end of a clause; before a word, it reads a count.
      expect(gapLeadIssues(m, "Nothing cleared the bar on Nov 11 – 12.")).toEqual([]);
      expect(gapLeadIssues(m, "On Nov 11 – 12 flaws cleared the bar.")).toHaveLength(1);
    });
  }
});

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

  it("a label figure is left out once: written a second time, it is a number (WORDS_OVER), and written once it still passes", () => {
    // The review's honest-looking drafts on the canary, each a made-up second figure (fifth P3 fix pass).
    const m = canaryMetrics();
    const cases: readonly [string, string, string][] = [
      ["window.w26.p7", "In the 26 weeks to 12 Oct, CISA listed 55% of recently disclosed flaws within 7 days, 7 days sooner than in 2023–24.",
        "In the 26 weeks to 12 Oct, CISA listed 55% of recently disclosed flaws within 7 days."],
      ["home_vendors.tw.d30_n", "In the 30 days to 12 Oct, CISA added 1 Taiwanese-vendor flaw, listed 30 days after its disclosure.",
        "In the 30 days to 12 Oct, CISA added 1 Taiwanese-vendor flaw to its KEV catalog."],
      ["home_vendors.tw.d90_n", "CISA added 1 Taiwanese-vendor flaw to KEV in the 90 days to 12 Oct, 90 days after a fix shipped.",
        "CISA added 1 Taiwanese-vendor flaw to KEV in the 90 days to 12 Oct."],
      ["window.w26.old_listed_n", "In the 26 weeks to 12 Oct, CISA newly listed 22 flaws more than 365 days old, some unpatched for 365 days.",
        "In the 26 weeks to 12 Oct, CISA newly listed 22 flaws more than 365 days old."],
      ["window.w26.n_day_share", "In the 26 weeks to 12 Oct, 39% of flaws were listed 2 to 30 days after disclosure, and fixes took 2 to 30 days.",
        "In the 26 weeks to 12 Oct, 39% of flaws were listed 2 to 30 days after disclosure."],
      ["window.w26.k7_n", "In the 26 weeks to 12 Oct, CISA listed 87 flaws within 7 days, and patches took 7 days more.",
        "In the 26 weeks to 12 Oct, CISA listed 87 flaws within 7 days of disclosure."],
      ["window.w26.at_disclosure_ci80.0", "The 26-week share exploited at disclosure, to 12 Oct, has an 80% interval from 32%, and 80% intervals are wide.",
        "The 26-week share exploited at disclosure, to 12 Oct, has an 80% interval from 32%."],
      ["window.w26.at_disclosure_share", "In the 26 weeks to 12 Oct, 37% of recently disclosed flaws were exploited at disclosure; the rest waited 26 weeks.",
        "In the 26 weeks to 12 Oct, 37% of recently disclosed flaws were exploited at disclosure."],
    ];
    for (const [p, twice, once] of cases) {
      const got = angleIssues(m, p, twice);
      expect(codes(got), `${p} | ${twice}`).toContain("WORDS_OVER angle.text");
      expect(got.find((e) => e.code === "WORDS_OVER")!.hint, p).toContain("Write each label figure once: written again, it counts.");
      expect(got.find((e) => e.code === "LEAD_GROUNDED")?.hint ?? "", p).toContain("may stand beside it as the label writes them, each at most once; no other number may.");
      expect(angleIssues(m, p, once), `${p} | ${once}`).toEqual([]);
    }
    // The figure's every written form counts the second time: "7-day" after "7 days".
    expect(codes(angleIssues(m, "window.w26.p7", "In the 26 weeks to 12 Oct, 55% of flaws were listed within 7 days, a 7-day window.")))
      .toContain("WORDS_OVER angle.text");
  });

  it("a label's range may be written \"between 2 and 30 days\", and its interval an \"80% confidence interval\"", () => {
    // The review's natural forms, which counted on the one-shot canary (fifth P3 fix pass).
    const m = canaryMetrics();
    for (const [p, text] of [
      ["window.w26.n_day_share", "In the 26 weeks to 12 Oct, 39% of recently disclosed flaws were listed between 2 and 30 days after disclosure."],
      ["window.w26.late_listed_n", "In the 26 weeks to 12 Oct, 37 recently disclosed flaws were listed between 31 and 365 days after disclosure."],
      ["window.w26.at_disclosure_ci80.0", "The 80% confidence interval for the 26-week share exploited at disclosure, to 12 Oct, starts at 32%."],
      ["window.w26.at_disclosure_ci80.1", "The 80% credible interval for the 26-week share exploited at disclosure, to 12 Oct, reaches 42%."],
    ] as const) expect(angleIssues(m, p, text), `${p} | ${text}`).toEqual([]);
    // Without "between", "2 and 30 days" is two more numbers.
    const got = angleIssues(m, "window.w26.n_day_share", "In the 26 weeks to 12 Oct, 39% of recently disclosed flaws were listed 2 and 30 days after disclosure.");
    expect(codes(got)).toEqual(["LEAD_GROUNDED angle.text", "WORDS_OVER angle.text"]);
    expect(got.find((e) => e.code === "WORDS_OVER")!.message).toContain("3 numbers (39%, 2, 30)");
  });

  it("a ratio glued to x holds no number: WORDS_UNDER's hint says to write it as the Gap does, \"1.9 times\"", () => {
    const m = canaryMetrics();
    const got = angleIssues(m, "window.kev_pace_ratio", "In the 26 weeks to 12 Oct, CISA's KEV additions ran at 1.9x the 2023–24 pace.");
    expect(codes(got)).toEqual(["WORDS_UNDER angle.text"]);
    expect(got[0]!.hint).toContain('Write a ratio as the Gap does, "1.9 times", never "1.9x"');
    expect(angleIssues(m, "window.kev_pace_ratio", "In the 26 weeks to 12 Oct, CISA's KEV additions ran at 1.9 times the 2023–24 pace.")).toEqual([]);
  });

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

  it("gives a figure as often as one label prints it, the most of any one row, and names it once in a hint (review of the sixth P3 fix pass)", () => {
    // Stub labels: no label prints a figure twice today, and no key but "constant" has two rows.
    const twice = [{ key: "p", label: "share in the 26 weeks to the date, against the 26 weeks before" }];
    const figs = rowFigures("p", twice);
    expect(figs.map((f) => f.text)).toEqual(["26 weeks", "26 weeks"]);
    expect(figureList(figs)).toBe("26 weeks");
    // Given twice, the figure is left out twice; a third copy counts.
    const raws = (text: string) => numbersBesideFigures(text, figs).map((n) => n.raw);
    expect(raws("37% in the 26 weeks to 6 Nov, against the 26 weeks before.")).toEqual(["37%"]);
    expect(raws("37% in the 26 weeks to 6 Nov, against the 26 weeks before and 26 weeks earlier.")).toEqual(["37%", "26"]);
    // Two rows of the key that each print "26 weeks" give it once, not twice; a row of another key gives nothing.
    const two = [{ key: "p", label: "share, 26 weeks" }, { key: "p", label: "count, 26 weeks" }, { key: "q", label: "count, 26 weeks" }];
    expect(rowFigures("p", two).map((f) => f.text)).toEqual(["26 weeks"]);
    expect(numbersBesideFigures("37% in 26 weeks, 26 weeks running.", rowFigures("p", two)).map((n) => n.raw)).toEqual(["37%", "26"]);
    // One row printing it twice and another once: twice, in label order with the other figures, each named once.
    const mixed = [{ key: "p", label: "listed within 7 days, 26 weeks" }, { key: "p", label: "26 weeks against 26 weeks" }];
    expect(rowFigures("p", mixed).map((f) => f.text)).toEqual(["7 days", "26 weeks", "26 weeks"]);
    expect(figureList(rowFigures("p", mixed))).toBe("7 days, 26 weeks");
    expect(rowFigures("q", mixed)).toEqual([]);
    // angleFigures() is rowFigures() of the day's quotable rows.
    const m = canaryMetrics();
    for (const r of quotableRows(m)) expect(angleFigures({ metric_path: r.key }, m), r.key).toEqual(rowFigures(r.key, quotableRows(m)));
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
