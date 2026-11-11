// The words and sources rule groups (SPEC §4.12): WORDS_OVER, WORDS_UNDER, QUOTE_MAX_25, BANNED_WORDS,
// SOURCE_REF, SOURCE_DUP, SOURCE_URL, SOURCE_UNSEEN, SOURCE_TIER, SOURCE_CRITICAL_TWO, SOURCE_SYNDICATED,
// SOURCE_STATE_LABEL, RELEASE_SOURCE and SOURCE_ORPHAN. Each sub-condition gets a passing and a failing case on a mutated
// SAMPLE draft, run through validateDraft() with only the rules under test; the F fixtures run with every rule.
// Blocked-URL cases use bare blocked hosts or reserved example domains, never a usable exploit, paste or
// scanner URL.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { invalidDraft } from "../fixtures/src/build";
import { MONDAY_ITEMS, WEEKDAY_ITEMS, WEEKDAY_SOURCE_KEYS, editionDraft, mondayDraft, weekdayDraft } from "../fixtures/src/drafts";
import { dropSources, wordsSourcesCases } from "../fixtures/src/invalid/words-sources";
import { draftInputs, fixtureConfig } from "../fixtures/src/inputs";
import { FIXTURES_DIR, sourceIds, type EditionName } from "../fixtures/src/world";
import { RULES } from "../lib/rules";
import { derive } from "../lib/rules/shared";
import {
  exploitLinkUrl, RECORD_PUBLISHERS, releaseBasisOf, releaseMember, sourceRules, sourceTypeFits, sourceUrlProblem, stateClaimPhrase,
} from "../lib/rules/sources";
import type { RuleInput, ValidationIssue } from "../lib/rules/types";
import {
  bannedWordsIn, draftView, modelWords, pageWordCount, pageWords, quotedSpans, wordFields, wordRules,
} from "../lib/rules/words";
import { countWords } from "../lib/text";
import { normalizeUrl } from "../lib/urls";
import { ComposeError, freezeSource, releaseBlockOf } from "../lib/apply";
import { cardKicker, cveTimeline, releaseLine, scriptText } from "../lib/page-text";
import type { Brief } from "../lib/schema/brief";
import type { DraftBrief } from "../lib/schema/draft-brief";
import type { DraftSource } from "../lib/schema/common";
import { validateDraft, type DraftInputs } from "../lib/validate";
import { BANNED_WORDS, WITHHELD_MARK } from "../lib/vocab";

const I = WEEKDAY_ITEMS;
const S = sourceIds(WEEKDAY_SOURCE_KEYS);

/** The issues with `codes` that validateDraft() gives when only the rules reporting them run. */
function check(d: unknown, codes: readonly string[], opts: { edition?: EditionName; inputs?: Partial<DraftInputs> } = {}): ValidationIssue[] {
  const inputs = { ...draftInputs(opts.edition ?? "weekday"), ...opts.inputs };
  const rules = RULES.filter((r) => r.codes.some((c) => codes.includes(c)));
  const r = validateDraft(d, { ...inputs, rules });
  return [...r.errors, ...r.warnings].filter((i) => codes.includes(i.code));
}

const codesOf = (xs: readonly ValidationIssue[]) => xs.map((x) => `${x.severity === "warning" ? "W " : ""}${x.code} ${x.path}`);

function at(d: DraftBrief, id: string): number {
  const i = d.items.findIndex((it) => it.id === id);
  if (i < 0) throw new Error(`no item ${id}`);
  return i;
}

/** Appends a source (next id) and returns its id. */
function addSource(d: DraftBrief, s: Partial<DraftSource> & Pick<DraftSource, "url">): string {
  const id = `s${d.sources.length + 1}`;
  d.sources.push({
    id, title: "SAMPLE: an added source", title_en: null, language: "en", outlet: "SAMPLE outlet", source_type: "press",
    published_at: "2026-10-13T12:00:00+08:00", ...s,
  });
  return id;
}

const words = (n: number, word = "word") => Array.from({ length: n }, () => word).join(" ");

/** A sentence of exactly `n` words ending with a full stop. */
const sentence = (n: number) => `${words(n)}.`;

// ── Valid drafts and the F fixtures ──────────────────────────────────────────────────────────────

describe("valid drafts", () => {
  it.each(["weekday", "monday", "quiet"] as const)("%s passes every words and sources rule with no issue", (name) => {
    const r = validateDraft(editionDraft(name), { ...draftInputs(name), rules: [...wordRules, ...sourceRules] });
    expect([...r.errors, ...r.warnings]).toEqual([]);
  });
});

describe("F fixtures (fixtures/src/invalid/words-sources.ts)", () => {
  it("covers every hard code of the group a draft can trigger", () => {
    expect(wordsSourcesCases.map((c) => c.code).sort()).toEqual([
      "BANNED_WORDS", "QUOTE_MAX_25", "SOURCE_CRITICAL_TWO", "SOURCE_DUP", "SOURCE_REF", "SOURCE_STATE_LABEL", "SOURCE_SYNDICATED",
      "SOURCE_TIER", "SOURCE_UNSEEN", "SOURCE_URL", "WORDS_OVER", "WORDS_UNDER",
    ]);
    for (const c of wordsSourcesCases) expect(c.file).toBe(`invalid--${c.code}.json`);
  });

  it.each(wordsSourcesCases.map((c) => [c.code, c] as const))("%s fails validateDraft() with exactly its own code", (_code, c) => {
    const r = validateDraft(invalidDraft(c), draftInputs(c.edition ?? "weekday"));
    expect(r.errors.length).toBeGreaterThan(0);
    expect(codesOf(r.errors).filter((x) => !x.startsWith(`${c.code} `))).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("WORDS_UNDER cuts the Lead to one 10-word sentence with no number", () => {
    const c = wordsSourcesCases.find((x) => x.code === "WORDS_UNDER")!;
    const d = invalidDraft(c) as DraftBrief;
    expect(d.lead).toHaveLength(1);
    expect(countWords(d.lead[0]!.text)).toBe(10);
    expect(d.lead[0]!.text).not.toMatch(/\d/);
  });

  it("dropSources() renumbers every source-id field", () => {
    const d = weekdayDraft();
    d.items[at(d, I.criticalExploited)]!.source_ids = [S["ivanti-advisory"], S["bc-ivanti"]];
    dropSources(d, [S["rec-104935"]]);
    expect(d.sources.map((s) => s.id)).toEqual(Array.from({ length: 18 }, (_, i) => `s${i + 1}`));
    expect(d.items[0]!.source_ids).toEqual(["s1", "s2"]);
    expect(d.angle.source_id).toBe("s12"); // was s13
    expect(check(d, ["SOURCE_REF", "SOURCE_ORPHAN"])).toEqual([]);
  });
});

// ── Word budgets ─────────────────────────────────────────────────────────────────────────────────

describe("wordFields()", () => {
  it("holds every budget of the word table, with the total flags", () => {
    const f = new Map(wordFields(mondayDraft()).map((x) => [x.path, x]));
    const pick = (p: string) => {
      const x = f.get(p)!;
      return [x.min, x.max, x.total];
    };
    expect(pick("lead")).toEqual([15, 90, true]);
    expect(pick("angle.text")).toEqual([null, 30, true]);
    expect(pick("angle.counterpoint")).toEqual([null, 30, true]);
    expect(pick("items[0].headline")).toEqual([null, null, true]);
    expect(pick("items[0].summary")).toEqual([null, 55, true]);
    expect(pick("items[0].why_it_matters")).toEqual([null, 25, true]);
    expect(pick("items[0]")).toEqual([15, 70, false]);
    expect(pick("items[0].incident.impact")).toEqual([null, 12, true]);
    expect(pick("taiwan_lens.analysis")).toEqual([1, 120, true]);
    expect(pick("taiwan_lens.rows[5].text")).toEqual([null, 30, true]);
    expect(pick("taiwan_lens.japan.text")).toEqual([null, 40, true]);
    expect(pick("week_in_review.text")).toEqual([null, 150, false]);
    expect(pick("week_in_review.strongest_against.text")).toEqual([null, 50, false]);

    const w = new Map(wordFields(weekdayDraft()).map((x) => [x.path, x]));
    expect([w.get("items[3].summary")!.max, w.get("items[3].why_it_matters")!.max]).toEqual([25, 25]);
    expect(w.has("items[3]")).toBe(false); // the combined budget is for top stories only
    expect([w.get("items[0].exposure.text")!.max, w.get("region_raises[0].reason")!.max]).toEqual([20, 20]);
    expect([w.get("scoreboard_entries[0].summary")!.max, w.get("scoreboard_entries[0].summary")!.total]).toEqual([40, false]);
    expect(w.get("lead")!.text).toBe(weekdayDraft().lead.map((s) => s.text).join(" "));
  });

  it("modelWords() sums only the fields in the total", () => {
    const d = mondayDraft();
    const before = modelWords(d);
    d.week_in_review!.text = `${d.week_in_review!.text} ${words(20)}`;
    d.scoreboard_entries = [];
    expect(modelWords(d)).toBe(before);
    d.taiwan_lens.analysis = `${d.taiwan_lens.analysis} ${words(5)}`;
    expect(modelWords(d)).toBe(before + 5);
  });
});

describe("WORDS_OVER and WORDS_UNDER", () => {
  const W = ["WORDS_OVER", "WORDS_UNDER"];

  it("the Lead: 15 to 90 words over all sentences", () => {
    const d = weekdayDraft();
    d.lead = [{ text: sentence(50), item_ids: [I.criticalExploited], gap: false }, { text: sentence(41), item_ids: [I.patchBatch], gap: false }];
    const over = check(d, W);
    expect(codesOf(over)).toEqual(["WORDS_OVER lead"]);
    expect(over[0]!.message).toBe("lead has 91 words (all sentences together); the limit is 90. Cut at least 1.");
    d.lead = [{ text: sentence(50), item_ids: [I.criticalExploited], gap: false }, { text: sentence(40), item_ids: [I.patchBatch], gap: false }];
    expect(check(d, W)).toEqual([]);
    d.lead = [{ text: sentence(14), item_ids: [I.criticalExploited], gap: false }];
    expect(check(d, W)[0]!.message).toBe("lead has 14 words (all sentences together); the minimum is 15. Add at least 1.");
  });

  it("top stories: summary at most 55; summary + why_it_matters 15 to 70; why_it_matters at most 25", () => {
    const d = weekdayDraft();
    d.items[0]!.summary = sentence(56);
    d.items[0]!.why_it_matters = sentence(5);
    expect(codesOf(check(d, W))).toEqual(["WORDS_OVER items[0].summary"]);
    d.items[0]!.summary = sentence(50);
    d.items[0]!.why_it_matters = sentence(21);
    const both = check(d, W);
    expect(codesOf(both)).toEqual(["WORDS_OVER items[0]"]);
    expect(both[0]!.message).toBe("items[0].summary + why_it_matters has 71 words; the limit is 70. Cut at least 1.");
    d.items[0]!.summary = sentence(40);
    d.items[0]!.why_it_matters = sentence(26);
    expect(codesOf(check(d, W))).toEqual(["WORDS_OVER items[0].why_it_matters"]);
    d.items[1]!.summary = sentence(8);
    d.items[1]!.why_it_matters = sentence(6);
    d.items[0]!.why_it_matters = sentence(25);
    expect(codesOf(check(d, W))).toEqual(["WORDS_UNDER items[1]"]);
    d.items[1]!.why_it_matters = null;
    d.items[1]!.summary = sentence(15);
    expect(check(d, W)).toEqual([]);
  });

  it("rows: summary and why_it_matters at most 25 each, no minimum", () => {
    const d = weekdayDraft();
    const i = at(d, I.taiwanVendor);
    expect(i).toBeGreaterThanOrEqual(3);
    d.items[i]!.summary = sentence(26);
    d.items[i]!.why_it_matters = sentence(26);
    expect(codesOf(check(d, W))).toEqual([`WORDS_OVER items[${i}].summary`, `WORDS_OVER items[${i}].why_it_matters`]);
    d.items[i]!.summary = sentence(2);
    d.items[i]!.why_it_matters = null;
    expect(check(d, W)).toEqual([]);
  });

  it("incident impact 12, exposure 20, raise reason 20, Lens rows 30, Japan 40, analysis 1 to 120", () => {
    const d = weekdayDraft();
    d.items[at(d, I.claimedVictim)]!.incident!.impact = words(13);
    d.items[at(d, I.criticalExploited)]!.exposure!.text = words(21);
    d.region_raises[0]!.reason = words(21);
    d.taiwan_lens.rows[0]!.text = words(31);
    d.taiwan_lens.japan.text = words(41);
    d.taiwan_lens.analysis = words(121);
    expect(codesOf(check(d, W)).sort()).toEqual([
      `WORDS_OVER items[${at(d, I.claimedVictim)}].incident.impact`, "WORDS_OVER items[0].exposure.text", "WORDS_OVER region_raises[0].reason",
      "WORDS_OVER taiwan_lens.analysis", "WORDS_OVER taiwan_lens.japan.text", "WORDS_OVER taiwan_lens.rows[0].text",
    ].sort());
    d.taiwan_lens.analysis = "..."; // text with no word in it
    expect(codesOf(check(d, ["WORDS_UNDER"]))).toEqual(["WORDS_UNDER taiwan_lens.analysis"]);
    d.taiwan_lens.analysis = "   "; // blank is TAIWAN_LENS_REQUIRED's
    expect(check(d, ["WORDS_UNDER"])).toEqual([]);
  });

  it("not in the total but budgeted: week in review 150 and 50, Scoreboard summary 40, correction reason 40", () => {
    const m = mondayDraft();
    m.week_in_review!.text = words(151);
    m.week_in_review!.strongest_against.text = words(51);
    expect(codesOf(check(m, W, { edition: "monday" }))).toEqual(["WORDS_OVER week_in_review.text", "WORDS_OVER week_in_review.strongest_against.text"]);
    const d = weekdayDraft();
    d.scoreboard_entries[0]!.summary = words(41);
    d.corrections = [{ item_id: I.taiwanVendor, edition_date: "2026-10-13", type: "update", field: "summary", after: "SAMPLE", reason: words(41), source_id: null }];
    expect(codesOf(check(d, W))).toEqual(["WORDS_OVER scoreboard_entries[0].summary", "WORDS_OVER corrections[0].reason"]);
  });

  it("the Angle holds exactly one number", () => {
    const d = weekdayDraft();
    d.angle.text = "Red Hat has credited AISLE with many flaws since 1 October.";
    const none = check(d, W);
    expect(codesOf(none)).toEqual(["WORDS_UNDER angle.text"]);
    d.angle.text = "Red Hat has credited AISLE with 24 flaws, 3 of them high, since 1 October.";
    const two = check(d, W);
    expect(codesOf(two)).toEqual(["WORDS_OVER angle.text"]);
    expect(two[0]!.message).toContain("2 numbers (24, 3)");
    d.angle.text = "New CVE records are arriving at 5.2 times the 2023–24 pace.";
    expect(check(d, W)).toEqual([]);
    expect(none[0]!.hint).not.toContain("1.9 times");
    // A ratio glued to x is no number; the hint says to write it as the Gap does (review of row 145).
    for (const t of ["New CVE records are arriving at 5.2x the 2023–24 pace.", "New CVE records are arriving at 5.2X the 2023–24 pace.",
      "New CVE records are arriving at 5x the 2023–24 pace."]) {
      d.angle.text = t;
      const r = check(d, W);
      expect(codesOf(r), t).toEqual(["WORDS_UNDER angle.text"]);
      expect(r[0]!.hint, t).toBe("Dates, years, CVE ids and version strings are not counted as numbers. "
        + 'Write a ratio as the Gap does, "1.9 times", never "1.9x": a number glued to x is not read as a number.');
    }
    d.angle.text = "New CVE records on x86 builds are arriving faster than in 2023–24.";
    expect(check(d, W)[0]!.hint).not.toContain("1.9 times");
    d.angle.text = `${words(30)} 24.`;
    expect(codesOf(check(d, W))).toEqual(["WORDS_OVER angle.text"]);
    expect(check(d, W)[0]!.message).toBe("angle.text has 31 words; the limit is 30. Cut at least 1.");
  });

  it("a metric Angle may print its label's figures without them counting as numbers (row 145)", () => {
    const d = mondayDraft(); // metric_path window.w26.after_disclosure_median_days, label "median days to listing for the rest, 26 weeks"
    d.angle.text = "Over the last 26 weeks, flaws not exploited at disclosure reached CISA's list a median 17 days after it.";
    expect(check(d, W, { edition: "monday" })).toEqual([]);
    d.angle.text = "In the 26-week Window, flaws not exploited at disclosure reached CISA's list a median 17 days after it.";
    expect(check(d, W, { edition: "monday" })).toEqual([]);
    d.angle.text = "Over the last 13 weeks, flaws not exploited at disclosure reached CISA's list a median 17 days after it.";
    const wrong = check(d, W, { edition: "monday" });
    expect(codesOf(wrong)).toEqual(["WORDS_OVER angle.text"]);
    expect(wrong[0]!.message).toContain("2 numbers (13, 17)");
    expect(wrong[0]!.hint).toBe("Dates, years, CVE ids and version strings are not counted as numbers, nor the figures the metric's label prints "
      + "(26 weeks) the first time each is written. Write each label figure once: written again, it counts.");
    d.angle.text = "Over the last 26 weeks, CISA listed the rest after a while.";
    const under = check(d, W, { edition: "monday" });
    expect(codesOf(under)).toEqual(["WORDS_UNDER angle.text"]);
    // The Angle holds no number, so its hint does not say a figure written again counts (review of the sixth P3 fix pass).
    expect(under[0]!.hint).toBe("Dates, years, CVE ids and version strings are not counted as numbers, nor the figures the metric's label prints "
      + "(26 weeks) the first time each is written.");
    // Every figure of the label: "share listed within 7 days, 26 weeks".
    d.angle.metric_path = "window.w26.p7";
    d.angle.text = "In the 26 weeks to 6 Nov, 55% of recently disclosed flaws on CISA's list were listed within 7 days.";
    expect(check(d, W, { edition: "monday" })).toEqual([]);
    d.angle.text = "In the 26 weeks to 6 Nov, 55% of recently disclosed flaws on CISA's list were listed within 30 days.";
    const p7 = check(d, W, { edition: "monday" });
    expect(p7.map((x) => x.message)).toEqual([expect.stringContaining("2 numbers (55%, 30)")]);
    expect(p7[0]!.hint).toContain("nor the figures the metric's label prints (7 days, 26 weeks) the first time each is written.");
    // A path whose labels print no figure counts the window like any number.
    d.angle.metric_path = "window.reference.at_disclosure_share";
    d.angle.text = "In 2023–24, 37% of recently disclosed flaws on CISA's list were exploited at disclosure, over 26 weeks.";
    const ref = check(d, W, { edition: "monday" });
    expect(codesOf(ref)).toEqual(["WORDS_OVER angle.text"]);
    expect(ref[0]!.hint).toBe("Dates, years, CVE ids and version strings are not counted as numbers.");
  });

  it("a sourced Angle is read as before: every figure counts (row 145)", () => {
    const s = weekdayDraft(); // a sourced Angle: its window is the source's number
    s.angle.text = "Red Hat has credited AISLE with 24 flaws in 26 weeks.";
    const r = check(s, W);
    expect(codesOf(r)).toEqual(["WORDS_OVER angle.text"]);
    expect(r[0]!.hint).toBe("Dates, years, CVE ids and version strings are not counted as numbers.");
    s.angle.text = "Red Hat has credited AISLE with 24 flaws since 1 October.";
    expect(check(s, W)).toEqual([]);
  });

  it("without a metrics file, a metric Angle may print the Gap's window lengths only (row 145)", () => {
    const d = mondayDraft();
    d.angle.text = "Over the last 26 weeks, flaws not exploited at disclosure reached CISA's list a median 17 days after it.";
    expect(check(d, W, { edition: "monday", inputs: { metrics: null } })).toEqual([]);
    d.angle.text = "Over the last 26 weeks, flaws not exploited at disclosure reached CISA's list within 7 days, a median 17 days after it.";
    const r = check(d, W, { edition: "monday", inputs: { metrics: null } });
    expect(r.map((x) => x.message)).toEqual([expect.stringContaining("2 numbers (7, 17)")]);
    expect(r[0]!.hint).toContain("nor the Gap's window lengths (26 weeks, 13 weeks) the first time each is written. Write each window length once");
    d.angle.text = "Over the last 26 weeks, flaws not exploited at disclosure reached CISA's list a while after it.";
    const under = check(d, W, { edition: "monday", inputs: { metrics: null } });
    expect(codesOf(under)).toEqual(["WORDS_UNDER angle.text"]);
    expect(under[0]!.hint).toBe("Dates, years, CVE ids and version strings are not counted as numbers, nor the Gap's window lengths "
      + "(26 weeks, 13 weeks) the first time each is written.");
  });

  it("the page total: WORDS_OVER above budgets.words_max, with the parts in the message", () => {
    const inputs = draftInputs("weekday");
    const count = pageWordCount(weekdayDraft(), inputs.metrics, inputs);
    expect(count.total).toBe(count.model + count.script);
    expect(count.total).toBeLessThanOrEqual(1300);
    const config = { ...inputs.config, run: { ...inputs.config.run, budgets: { ...inputs.config.run.budgets, words_max: count.total - 10 } } };
    const r = check(weekdayDraft(), ["WORDS_OVER"], { inputs: { config } });
    expect(codesOf(r)).toEqual(["WORDS_OVER (root)"]);
    expect(r[0]!.message).toContain(`The page has ${count.total.toLocaleString("en-US")} counted words (provisional`);
    expect(r[0]!.message).toContain("Cut at least 10.");
    const exact = { ...config, run: { ...config.run, budgets: { ...config.run.budgets, words_max: count.total } } };
    expect(check(weekdayDraft(), ["WORDS_OVER"], { inputs: { config: exact } })).toEqual([]);
  });

  it("without metrics the page total is skipped (METRICS_MISSING) and the field budgets still run", () => {
    const d = weekdayDraft();
    d.region_raises[0]!.reason = words(21);
    const r = validateDraft(d, { ...draftInputs("weekday"), metrics: null, rules: wordRules });
    expect(codesOf(r.errors)).toEqual(["WORDS_OVER region_raises[0].reason"]);
    expect(r.warnings.map((w) => w.code)).toEqual(["METRICS_MISSING"]);
    expect(r.warnings[0]!.message).toContain("WORDS_OVER");
  });
});

// ── pageWords() and draftView() ──────────────────────────────────────────────────────────────────

/** A Brief-shaped copy of a draft: the draft plus its provisional view's S fields (what publish would add). */
function asBrief(d: DraftBrief, inputs: DraftInputs): Brief {
  const view = draftView(d, inputs);
  const { region_raises: _r, scoreboard_entries, ...rest } = d;
  return {
    ...rest, ...view, items: d.items.map((it, i) => ({ ...it, ...view.items[i], withheld: null })),
    regions: { rows: view.regions.rows, global: { item_count: 0 }, signals: [] },
    scoreboard: { entries: scoreboard_entries.map((e) => ({ ...e, source_url: null })), last: null },
    taiwan_lens: { ...d.taiwan_lens, ...view.taiwan_lens, watch_windows: [] },
    computed: { word_count: 0, reading_minutes: 1, item_count: d.items.length, ai_linked: view.computed.ai_linked, source_count: 0, publisher_count: 0 },
  } as unknown as Brief;
}

describe("pageWords()", () => {
  it("is the model fields in the total plus countWords(scriptText())", () => {
    const inputs = draftInputs("weekday");
    const d = weekdayDraft();
    const view = draftView(d, inputs);
    expect(pageWords(d, inputs.metrics, inputs)).toBe(modelWords(d) + countWords(scriptText(view, inputs.metrics)));
  });

  it("counts a Brief the same way it counts the draft it came from", () => {
    const inputs = draftInputs("weekday");
    const d = weekdayDraft();
    const brief = asBrief(d, inputs);
    expect(modelWords(brief)).toBe(modelWords(d));
    expect(pageWords(brief, inputs.metrics)).toBe(pageWords(d, inputs.metrics, inputs));
  });

  it("checks a published brief's total only on the brief being published (run.json can change)", () => {
    const inputs = draftInputs("weekday");
    const brief = asBrief(weekdayDraft(), inputs);
    const total = pageWords(brief, inputs.metrics);
    const config = { ...inputs.config, run: { ...inputs.config.run, budgets: { ...inputs.config.run.budgets, words_max: total - 1 } } };
    const rule = wordRules[1]!;
    const base = { draft: brief, mode: "published", metrics: inputs.metrics, config, derived: derive(brief, "published", config) };
    expect(rule.check({ ...base, crossFile: null } as unknown as RuleInput)).toEqual([]);
    expect(rule.check({ ...base, crossFile: { publishing: false, inputs: null, briefs: [] } } as unknown as RuleInput)).toEqual([]);
    const r = rule.check({ ...base, crossFile: { publishing: true, inputs: null, briefs: [] } } as unknown as RuleInput);
    expect(r.map((x) => x.path)).toEqual(["(root)"]);
    expect(r[0]!.message).toMatch(/^The page has [\d,]+ counted words: /);
  });

  it("throws for a draft without its inputs", () => {
    expect(() => (pageWords as (b: unknown, m: unknown) => number)(weekdayDraft(), null)).toThrow(/draft inputs/);
  });

  it("drops the minimums on a WITHHELD_MARK text, and gives a withheld item (§4.10) no budget and no words in the total", () => {
    const inputs = draftInputs("weekday");
    const brief = asBrief(weekdayDraft(), inputs);
    const open = pageWordCount(brief, inputs.metrics);
    brief.lead = [{ text: WITHHELD_MARK, item_ids: [I.criticalExploited], gap: false }];
    const before = pageWordCount(brief, inputs.metrics);
    const held = brief.items[1]!;
    brief.items[1] = { ...held, summary: "Details withheld.", why_it_matters: null, withheld: { correction_id: "C-0001", since: "2026-10-20" } };
    const f = wordFields(brief);
    expect(f.find((x) => x.path === "lead")!.withheld).toBe(true);
    expect(f.filter((x) => x.path.startsWith("items[1]"))).toEqual([]);
    const rule = wordRules[0]!;
    const out = rule.check({ draft: brief, mode: "published", derived: derive(brief, "published", inputs.config) } as RuleInput);
    expect(out.filter((x) => x.code === "WORDS_UNDER")).toEqual([]);
    // Its headline, summary, kicker and timeline leave the total; whatever its text, nothing fails (§0.4 row 126).
    const after = pageWordCount(brief, inputs.metrics);
    const line = held.release ? releaseLine(held.release, brief.date) : held.cves[0] ? cveTimeline(held.cves[0], brief.date) : null;
    const card = countWords(cardKicker(held)) + countWords(line);
    expect(before.model - after.model).toBe(countWords(held.headline) + countWords(held.summary) + countWords(held.why_it_matters)
      + countWords(held.incident?.impact ?? null) + countWords(held.exposure?.text ?? null));
    expect(before.script - after.script).toBe(card);
    expect(open.total).toBeGreaterThan(after.total);
    brief.items[1] = { ...brief.items[1]!, summary: Array.from({ length: 80 }, () => "word").join(" ") };
    expect(pageWords(brief, inputs.metrics)).toBe(after.total);
    expect(rule.check({ draft: brief, mode: "published", derived: derive(brief, "published", inputs.config) } as RuleInput)).toEqual([]);
  });
});

describe("draftView()", () => {
  const inputs = draftInputs("weekday");
  const view = draftView(weekdayDraft(), inputs);

  it("takes region rows from computeRegions() on the draft, the raise applied", () => {
    expect(view.regions.rows.map((r) => [r.code, r.level])).toEqual([["US", "elevated"], ["EU", "baseline"], ["TW", "elevated"], ["JP", "baseline"]]);
  });

  it("rebuilds each card's vendor, first CVE timeline and release line", () => {
    const top = view.items[0]!;
    expect(top.vendor).toEqual({ id: "ivanti", name: "Ivanti", country: "US" });
    expect(top.cves[0]!.date_published).toBe("2026-10-13");
    expect(top.cves[0]!.kev?.date_added).toBe("2026-10-13");
    expect(top.cves[0]!.patch?.date).toBe("2026-10-13");
    expect(top.cves[0]!.exploitation_evidence.map((e) => e.basis)).toEqual(["vendor_confirmed"]);
    const batch = view.items[at(weekdayDraft(), I.patchBatch)]!;
    expect(batch.release).toMatchObject({ fixes_n: 1384, critical_n: 60, exploited_n: 1 });
    expect(view.items[at(weekdayDraft(), I.glasswing)]!.vendor).toBeNull();
    const script = scriptText(view, inputs.metrics);
    expect(script).toContain("●●●● CRITICAL · US · GLOBAL · Ivanti (US)");
    expect(script).toContain("Released 13 Oct · 1,384 fixes · 1 exploited · 60 critical");
  });

  it("fills the Gap from the metrics and the masthead from the items", () => {
    expect(view.gap.headline).toBe(inputs.metrics!.headline.text);
    expect(view.computed.ai_linked).toEqual({ linked: 3, total: 8 });
    expect(view.actors_seen).toHaveLength(1);
    expect(view.edition).toBe("full");
    const noMetrics = draftView(weekdayDraft(), { ...inputs, metrics: null });
    expect(noMetrics.gap.status).toBe("missing");
    expect(scriptText(noMetrics, null)).toContain("The Gap is not available for this edition.");
  });

  it("makes the edition partial when the context lists stale or failed feeds", () => {
    const context = structuredClone(inputs.context);
    context.pack.failed_feeds = ["SAMPLE feed"];
    const v = draftView(weekdayDraft(), { ...inputs, context });
    expect(v.edition).toBe("partial");
    expect(scriptText(v, inputs.metrics)).toContain("Some feeds are stale: SAMPLE feed;");
  });

  it("falls back to the context's regions preview without a regions input", () => {
    const v = draftView(weekdayDraft(), { ...inputs, regionsBase: null });
    expect(v.regions.rows.map((r) => r.code)).toEqual(["US", "EU", "TW", "JP"]);
  });
});

// ── QUOTE_MAX_25 ─────────────────────────────────────────────────────────────────────────────────

describe("QUOTE_MAX_25", () => {
  const Q = ["QUOTE_MAX_25"];

  it("a quoted field over 25 words", () => {
    const d = weekdayDraft();
    const i = at(d, I.aiConfirmed);
    d.items[i]!.ai_evidence[0]!.quote = words(26);
    const r = check(d, Q);
    expect(codesOf(r)).toEqual([`QUOTE_MAX_25 items[${i}].ai_evidence[0].quote`]);
    expect(r[0]!.message).toBe(`items[${i}].ai_evidence[0].quote quotes 26 words; the limit is 25. Cut at least 1.`);
    d.items[i]!.ai_evidence[0]!.quote = words(25);
    expect(check(d, Q)).toEqual([]);
  });

  it("a blank quoted field; a null confidence_text passes", () => {
    const d = weekdayDraft();
    d.scoreboard_entries[0]!.quote = "  ";
    const c = at(d, I.chinaAxis);
    d.items[c]!.attribution[0]!.confidence_text = "";
    expect(codesOf(check(d, Q))).toEqual([`QUOTE_MAX_25 items[${c}].attribution[0].confidence_text`, "QUOTE_MAX_25 scoreboard_entries[0].quote"]);
    d.scoreboard_entries[0]!.quote = "We have not yet seen AI-powered malware used in an attack on UK critical national infrastructure.";
    d.items[c]!.attribution[0]!.confidence_text = null;
    expect(check(d, Q)).toEqual([]);
  });

  it("a quoted span in a prose field, curly or straight quotes", () => {
    expect(quotedSpans("He said “one two” and \"three four\".")).toEqual(["one two", "three four"]);
    const d = weekdayDraft();
    d.items[0]!.summary = `Ivanti says "${words(26)}" today.`;
    d.taiwan_lens.japan.text = `Police said “${words(25)}”.`;
    expect(codesOf(check(d, Q))).toEqual(["QUOTE_MAX_25 items[0].summary"]);
  });
});

// ── BANNED_WORDS ─────────────────────────────────────────────────────────────────────────────────

describe("BANNED_WORDS", () => {
  it("matches case-insensitively on word boundaries, hyphens and spaces alike", () => {
    expect(bannedWordsIn("A Game Changer for defenders")).toEqual(["game-changer"]);
    expect(bannedWordsIn("a wake up call and a wake-up-call")).toEqual(["wake-up call"]);
    expect(bannedWordsIn("a cyber 9/11 moment")).toEqual(["cyber 9/11"]);
    expect(bannedWordsIn("UNPRECEDENTED")).toEqual(["unprecedented"]);
    expect(bannedWordsIn("massively parallel, a nightmarish bug, skyrocketing")).toEqual(["skyrocketing"]);
    expect(bannedWordsIn("a tsunamis-free report")).toEqual([]);
    for (const w of BANNED_WORDS) expect(bannedWordsIn(`It was ${w}.`)).toContain(w);
  });

  it("fails a prose field; quoted fields and titles are exempt", () => {
    const d = weekdayDraft();
    d.region_raises[0]!.reason = "A massive patch deadline.";
    d.items[at(d, I.aiConfirmed)]!.ai_evidence[0]!.quote = "an unprecedented find";
    d.sources[0]!.title = "SAMPLE: a devastating flaw";
    const r = check(d, ["BANNED_WORDS"]);
    expect(codesOf(r)).toEqual(["BANNED_WORDS region_raises[0].reason"]);
    expect(r[0]!.message).toContain('uses "massive"');
  });

  it("runs in draft mode only (the list can change after publish)", () => {
    expect(wordRules.find((r) => r.codes.includes("BANNED_WORDS"))!.scope).toBe("draft");
  });
});

// ── SOURCE_REF ───────────────────────────────────────────────────────────────────────────────────

describe("SOURCE_REF", () => {
  const R = ["SOURCE_REF"];

  it("an unknown id in any source-id field", () => {
    const d = weekdayDraft();
    d.items[1]!.source_ids.push("s40");
    d.angle.counterpoint_source_ids = ["s41"];
    d.elsewhere[0]!.source_id = "s42";
    d.scoreboard_entries[0]!.quote_source_id = "s43";
    d.taiwan_lens.rows[0]!.source_ids = ["s44"];
    expect(codesOf(check(d, R))).toEqual([
      "SOURCE_REF items[1].source_ids[3]", "SOURCE_REF angle.counterpoint_source_ids[0]", "SOURCE_REF taiwan_lens.rows[0].source_ids[0]",
      "SOURCE_REF scoreboard_entries[0].quote_source_id", "SOURCE_REF elsewhere[0].source_id",
    ]);
  });

  it("an evidence, attribution, incident or flaw source missing from its item's source_ids", () => {
    const d = weekdayDraft();
    const c = at(d, I.chinaAxis);
    const v = at(d, I.claimedVictim);
    const a = at(d, I.aiConfirmed);
    d.items[0]!.flaw_evidence[0]!.source_id = S["msrc-october"];
    d.items[c]!.attribution[0]!.source_id = S["ncsc-review"];
    d.items[v]!.incident!.status_source_ids = [S["nhk-backups"]];
    d.items[a]!.ai_evidence[0]!.source_id = S["reg-aisle"]; // in the item: passes
    d.items[0]!.exposure!.source_id = S["ncsc-review"]; // exposure is not on the list
    const r = check(d, R);
    expect(codesOf(r)).toEqual([
      "SOURCE_REF items[0].flaw_evidence[0].source_id", `SOURCE_REF items[${c}].attribution[0].source_id`,
      `SOURCE_REF items[${v}].incident.status_source_ids[0]`,
    ]);
    expect(r[0]!.message).toContain("not in items[0].source_ids");
  });

  it("an item with no source ids", () => {
    const d = weekdayDraft();
    const v = at(d, I.claimedVictim);
    d.items[v]!.source_ids = [];
    expect(codesOf(check(d, R))).toContain(`SOURCE_REF items[${v}].source_ids`);
  });
});

// ── SOURCE_DUP, SOURCE_URL, SOURCE_UNSEEN ────────────────────────────────────────────────────────

describe("SOURCE_DUP", () => {
  it("two sources whose URLs normalise the same", () => {
    const d = weekdayDraft();
    const ivanti = d.sources[1]!.url;
    const id = addSource(d, { url: `${ivanti.replace("https://www.", "https://")}/#top` });
    d.items[0]!.source_ids.push(id);
    expect(codesOf(check(d, ["SOURCE_DUP"]))).toEqual(["SOURCE_DUP sources[19].url"]);
    d.sources[19]!.url = `${ivanti}-2`;
    expect(check(d, ["SOURCE_DUP"])).toEqual([]);
  });
});

describe("SOURCE_URL", () => {
  it("not https, malformed, a redirect or an archive", () => {
    expect(sourceUrlProblem("https://www.bleepingcomputer.com/ct-sample/x")).toBeNull();
    expect(sourceUrlProblem("http://www.bleepingcomputer.com/ct-sample/x")).toMatch(/^uses http/);
    expect(sourceUrlProblem("www.bleepingcomputer.com/ct-sample/x")).toMatch(/not a valid absolute https URL/);
    expect(sourceUrlProblem("https://localhost/x")).toMatch(/not a valid/);
    expect(sourceUrlProblem("https://news.google.com/")).toMatch(/redirect link \(news\.google\.com\)/);
    expect(sourceUrlProblem("https://www.google.com/url")).toMatch(/redirect link \(google\.com\/url\)/);
    expect(sourceUrlProblem("https://www.google.com/search")).toBeNull(); // only the /url wrapper
    expect(sourceUrlProblem("https://href.li/")).toMatch(/redirect/);
    expect(sourceUrlProblem("https://web.archive.org/web/2026/https://example.org/sample/page")).toMatch(/archive copy \(web\.archive\.org\)/);
    expect(sourceUrlProblem("https://archive.ph/")).toMatch(/archive copy/);
    expect(sourceUrlProblem("https://ghostarchive.org/")).toMatch(/archive copy/);
    for (const mirror of ["archive.li", "archive.md", "archive.vn", "archive.fo"]) {
      expect(sourceUrlProblem(`https://${mirror}/`)).toMatch(/archive copy/); // archive.today's other mirrors
    }
  });

  it("a URL with a user name or password before the host", () => {
    expect(sourceUrlProblem("https://ctsample:none@www.bleepingcomputer.com/ct-sample/x")).toMatch(/user name or password/);
    expect(sourceUrlProblem("https://www.bleepingcomputer.com@example.org/ct-sample/x")).toMatch(/user name or password/);
  });

  it("never throws on a url named after an Object.prototype member", () => {
    for (const url of ["constructor", "toString", "__proto__"]) {
      const d = weekdayDraft();
      d.sources[18]!.url = url;
      expect(codesOf(check(d, ["SOURCE_URL"]))).toEqual(["SOURCE_URL sources[18].url"]);
      expect(() => validateDraft(d, draftInputs("weekday"))).not.toThrow();
    }
  });

  it("leaves the other blocked hosts to NO_EXPLOIT_LINK", () => {
    expect(sourceUrlProblem("https://www.exploit-db.com/")).toBeNull();
    expect(sourceUrlProblem("https://pastebin.com/")).toBeNull();
    expect(sourceUrlProblem("https://bit.ly/")).toBeNull();
  });

  it("reports the source's URL field", () => {
    const d = weekdayDraft();
    d.sources[18]!.url = "http://www3.nhk.or.jp/news/ct-sample/local-government-backup-checks";
    const r = check(d, ["SOURCE_URL"]);
    expect(codesOf(r)).toEqual(["SOURCE_URL sources[18].url"]);
    expect(r[0]!.message).toBe("s19's URL uses http; cite the https address of the same page. Found: http://www3.nhk.or.jp/news/ct-sample/local-government-backup-checks");
  });
});

describe("SOURCE_UNSEEN", () => {
  const U = ["SOURCE_UNSEEN"];

  it("a URL the evidence doesn't list; normalised forms match", () => {
    const d = weekdayDraft();
    d.sources[18]!.url = "https://www3.nhk.or.jp/news/ct-sample/local-government-backup-checks/?utm_source=x#a";
    expect(check(d, U)).toEqual([]);
    d.sources[18]!.url = "https://www3.nhk.or.jp/news/ct-sample/another-page";
    expect(codesOf(check(d, U))).toEqual(["SOURCE_UNSEEN sources[18].url"]);
  });

  it("skips URLs that already fail SOURCE_URL or NO_EXPLOIT_LINK", () => {
    const d = weekdayDraft();
    const ids = [
      addSource(d, { url: "http://example.org/sample/plain-http-page" }),
      addSource(d, { url: "https://news.google.com/" }),
      addSource(d, { url: "https://www.exploit-db.com/" }),
      addSource(d, { url: "https://github.com/example/repository" }),
      addSource(d, { url: "https://example.org/sample/poc/readme", source_type: "other" }),
      addSource(d, { url: "https://example.org/sample/not-seen", source_type: "other" }),
    ];
    d.items[0]!.source_ids.push(...ids);
    expect(codesOf(check(d, U))).toEqual(["SOURCE_UNSEEN sources[24].url"]);
  });

  it("only warns, once, without an evidence file", () => {
    const r = check(weekdayDraft(), U, { inputs: { evidence: null } });
    expect(codesOf(r)).toEqual(["W SOURCE_UNSEEN sources"]);
    expect(r[0]!.message).toMatch(/^Skipped: no evidence file/);
  });

  it("exploitLinkUrl() mirrors NO_EXPLOIT_LINK's URL checks", () => {
    const tiers = fixtureConfig().sourceTiers;
    expect(exploitLinkUrl("https://www.exploit-db.com/", 3, tiers)).toBe(true);
    expect(exploitLinkUrl("https://github.com/example/repository", 3, tiers)).toBe(true);
    expect(exploitLinkUrl("https://github.com/advisories/GHSA-aaaa-bbbb-cccc", 1, tiers)).toBe(false);
    expect(exploitLinkUrl("https://example.org/sample/Exploits/x", 3, tiers)).toBe(true);
    expect(exploitLinkUrl("https://example.org/sample/exploitation-report", 3, tiers)).toBe(false);
    expect(exploitLinkUrl("https://www.bleepingcomputer.com/poc/x", 2, tiers)).toBe(false); // tier 3 or unlisted only
    expect(exploitLinkUrl("https://example.org/sample/cve-2026-1234-poc", 3, tiers)).toBe(true);
    expect(exploitLinkUrl("https://ct-sample-victim.example/poc/x", 1, tiers, "host:ct-sample-victim.example")).toBe(true);
  });

  it("leaves a source cited by flaw_evidence to FLAW_EVIDENCE (Close relatives)", () => {
    const d = weekdayDraft();
    const it = d.items[at(d, I.criticalExploited)]!;
    const sid = it.flaw_evidence[0]!.source_id;
    const url = normalizeUrl(d.sources.find((x) => x.id === sid)!.url);
    const evidence = draftInputs("weekday").evidence!;
    const unseen = { ...evidence, urls: evidence.urls.filter((u) => normalizeUrl(u) !== url) };
    expect(check(d, U, { inputs: { evidence: unseen } })).toEqual([]);
    const k = at(d, I.criticalExploited);
    expect(codesOf(check(d, ["SOURCE_UNSEEN", "FLAW_EVIDENCE"], { inputs: { evidence: unseen } })))
      .toEqual([`FLAW_EVIDENCE items[${k}].flaw_evidence[0].source_id`, `FLAW_EVIDENCE items[${k}].flaw_evidence[1].source_id`]);
  });
});

// ── SOURCE_TIER ──────────────────────────────────────────────────────────────────────────────────

describe("SOURCE_TIER", () => {
  const T = ["SOURCE_TIER"];

  it("an item with only tier 3 sources; beside a tier 1 or 2 source tier 3 only warns", () => {
    const d = weekdayDraft();
    const v = at(d, I.claimedVictim);
    const id = addSource(d, { url: "https://example.org/sample/leak-claim", source_type: "other" });
    d.items[v]!.source_ids = [id];
    d.items[v]!.incident!.status_source_ids = [id];
    const r = check(d, T);
    expect(codesOf(r)).toEqual([`SOURCE_TIER items[${v}].source_ids`, "W SOURCE_TIER sources[19].url"]);
    expect(r[0]!.message).toContain("s20 (example.org, tier 3)");
    d.items[v]!.source_ids = [S["sn-claim"], id];
    expect(codesOf(check(d, T))).toEqual(["W SOURCE_TIER sources[19].url"]);
  });

  it("a listed tier 3 publisher doesn't warn as unlisted", () => {
    const d = weekdayDraft();
    const id = addSource(d, { url: "https://www.msn.com/ct-sample/copy", source_type: "other" });
    d.items[0]!.source_ids.push(id);
    expect(check(d, T)).toEqual([]);
  });

  it("an unlisted URL that SOURCE_URL or NO_EXPLOIT_LINK fails doesn't also warn as unlisted", () => {
    const d = weekdayDraft();
    for (const url of ["https://www.exploit-db.com/", "https://example.org/sample/poc", "http://example.org/sample/notes"]) {
      d.items[0]!.source_ids.push(addSource(d, { url, source_type: "other" }));
    }
    expect(codesOf(check(d, T))).toEqual([]);
    d.items[0]!.source_ids.push(addSource(d, { url: "https://example.org/sample/notes", source_type: "other" }));
    expect(codesOf(check(d, T))).toEqual(["W SOURCE_TIER sources[22].url"]);
  });

  it("the Angle's source and an Elsewhere link need tier 1 or 2; a metric Angle has none", () => {
    const d = weekdayDraft();
    const id = addSource(d, { url: "https://medium.com/ct-sample/aisle-credits", source_type: "other" });
    d.angle.source_id = id;
    d.elsewhere[0]!.source_id = id;
    d.angle.counterpoint_source_ids = [S["reg-aisle"]];
    expect(codesOf(check(d, T))).toEqual(["SOURCE_TIER angle.source_id", "SOURCE_TIER elsewhere[0].source_id"]);
    expect(check(mondayDraft(), T, { edition: "monday" })).toEqual([]);
  });

  it("source_type fit, per type", () => {
    const cfg = fixtureConfig();
    const view = (url: string, type: DraftSource["source_type"] = "other") => derive(
      { ...weekdayDraft(), sources: [{ ...weekdayDraft().sources[0]!, url, source_type: type }] }, "draft", cfg).publisherBySourceId.get("s1")!;
    const fits = (type: DraftSource["source_type"], url: string) => sourceTypeFits(type, view(url, type));
    expect(RECORD_PUBLISHERS).toEqual(["cve-org", "nvd", "github-advisories", "jvn", "twcert"]);
    expect(fits("cve_record", "https://nvd.nist.gov/vuln/detail/CVE-2026-104935")).toBe(true);
    expect(fits("cve_record", "https://github.com/advisories/GHSA-aaaa-bbbb-cccc")).toBe(true);
    expect(fits("cve_record", "https://www.bleepingcomputer.com/ct-sample/x")).toBe(false);
    expect(fits("vendor_advisory", "https://www.ivanti.com/ct-sample/x")).toBe(true);
    expect(fits("vendor_advisory", "https://www.securityweek.com/ct-sample/x")).toBe(false);
    expect(fits("government", "https://www.jpcert.or.jp/ct-sample/x")).toBe(true);
    expect(fits("government", "https://www.sec.gov/ct-sample/x")).toBe(true);
    expect(fits("government", "https://www.mandiant.com/ct-sample/x")).toBe(false);
    expect(fits("regulator_filing", "https://www.sec.gov/ct-sample/x")).toBe(true);
    expect(fits("regulator_filing", "https://www.ncsc.gov.uk/ct-sample/x")).toBe(false);
    expect(fits("press", "https://www.reuters.com/ct-sample/x")).toBe(true);
    expect(fits("press", "https://www.msn.com/ct-sample/x")).toBe(false);
    expect(fits("press", "https://www.mandiant.com/ct-sample/x")).toBe(false);
    expect(fits("research", "https://www.mandiant.com/ct-sample/x")).toBe(true);
    expect(fits("research", "https://example.org/sample/x")).toBe(false);
    expect(fits("victim", "https://example.org/sample/statement")).toBe(true); // an unlisted victim site is tier 1
    expect(fits("finder_writeup", "https://red.anthropic.com/ct-sample/x")).toBe(true);
    expect(fits("other", "https://www.msn.com/ct-sample/x")).toBe(true);
    expect(fits("other", "https://www.reuters.com/ct-sample/x")).toBe(false);
  });

  it("reports a misfit with the type that fits", () => {
    const d = weekdayDraft();
    d.sources[0]!.source_type = "press";
    const r = check(d, T);
    expect(codesOf(r)).toEqual(["SOURCE_TIER sources[0].source_type"]);
    expect(r[0]!.message).toContain('Use "cve_record"');
  });

  it("a GitHub Advisory Database page cited as a vendor advisory (Kobol dry run, 2026-11-11): a listed record publisher, never \"unlisted\"", () => {
    const d = weekdayDraft();
    const id = addSource(d, { url: "https://github.com/advisories/GHSA-2222-3333-4444", source_type: "vendor_advisory" });
    d.items[0]!.source_ids.push(id);
    const r = check(d, T);
    expect(codesOf(r)).toEqual([`SOURCE_TIER sources[${d.sources.length - 1}].source_type`]);
    expect(r[0]!.message).toContain('needs a vendor\'s own domain, but GitHub Advisory Database is a record or data publisher of tier 1. Use "cve_record"');
    expect(r[0]!.message).not.toContain("unlisted");
  });

  it("skips the source_type fit in published mode (no publisher kind is frozen)", () => {
    const inputs = draftInputs("weekday");
    const d = weekdayDraft();
    d.sources[0]!.source_type = "press";
    const derivedDraft = derive(d, "draft", inputs.config);
    const frozen = {
      ...d, edition: "full", computed: {},
      sources: d.sources.map((s) => {
        const v = derivedDraft.publisherBySourceId.get(s.id)!;
        return { ...s, publisher: v.publisher, publisher_name: v.publisher_name, tier: v.tier, state_label: v.state_label, seen_as: "pack" };
      }),
    } as unknown as Brief;
    const rule = sourceRules.find((r) => r.codes.includes("SOURCE_TIER"))!;
    const input = { draft: frozen, mode: "published", derived: derive(frozen, "published", inputs.config), evidence: null } as unknown as RuleInput;
    expect(rule.check(input)).toEqual([]);
  });
});

// ── SOURCE_CRITICAL_TWO and SOURCE_SYNDICATED ────────────────────────────────────────────────────

describe("SOURCE_CRITICAL_TWO and SOURCE_SYNDICATED", () => {
  const C = ["SOURCE_CRITICAL_TWO", "SOURCE_SYNDICATED"];

  /** The weekday draft with the Critical item citing exactly these new sources (each added to the evidence). */
  function critical(sources: (Partial<DraftSource> & Pick<DraftSource, "url">)[]): { d: DraftBrief; inputs: DraftInputs } {
    const d = weekdayDraft();
    const inputs = draftInputs("weekday");
    const ids = sources.map((s) => addSource(d, s));
    d.items[0]!.source_ids = [S["ivanti-advisory"], ...ids]; // the flaw evidence cites the advisory
    return { d, inputs };
  }

  it("the valid Critical item has three publishers", () => {
    expect(check(weekdayDraft(), C)).toEqual([]);
  });

  it("fewer than two publishers", () => {
    const { d, inputs } = critical([]);
    const r = check(d, C, { inputs });
    expect(codesOf(r)).toEqual(["SOURCE_CRITICAL_TWO items[0].source_ids"]);
    expect(r[0]!.message).toContain("has 1 publisher (Ivanti)");
  });

  it("two newsrooms and no tier 1", () => {
    const d = weekdayDraft();
    const id = addSource(d, { url: "https://www.reuters.com/ct-sample/ivanti" });
    d.items[0]!.source_ids = [S["bc-ivanti"], id];
    d.items[0]!.flaw_evidence = [];
    const r = check(d, C);
    expect(codesOf(r)).toEqual(["SOURCE_CRITICAL_TWO items[0].source_ids"]);
    expect(r[0]!.message).toContain("has no tier 1 publisher");
  });

  it("The Hacker News can't be the only second publisher (draft mode)", () => {
    const { d, inputs } = critical([{ url: "https://thehackernews.com/ct-sample/ivanti" }]);
    const r = check(d, C, { inputs });
    expect(codesOf(r)).toEqual(["SOURCE_CRITICAL_TWO items[0].source_ids"]);
    expect(r[0]!.message).toContain("only with The Hacker News");
    const two = critical([{ url: "https://thehackernews.com/ct-sample/ivanti" }, { url: "https://www.reuters.com/ct-sample/ivanti" }]);
    expect(check(two.d, C, { inputs: two.inputs })).toEqual([]);
  });

  it("one of its sources must be in evidence.fetched (draft mode)", () => {
    const inputs = draftInputs("weekday");
    const evidence = { ...inputs.evidence!, fetched: [] };
    const r = check(weekdayDraft(), C, { inputs: { evidence } });
    expect(codesOf(r)).toEqual(["SOURCE_CRITICAL_TWO items[0].source_ids"]);
    expect(r[0]!.message).toContain("was fetched or read as a record");
    expect(check(weekdayDraft(), C, { inputs: { evidence: null } })).toEqual([]);
  });

  it("SOURCE_SYNDICATED: the bar met only by counting a copy separately", () => {
    const d = weekdayDraft();
    const advisory = d.sources[1]!;
    const id = addSource(d, { url: "https://www.reuters.com/ct-sample/ivanti-advisory-copy", title: `${advisory.title} - update` });
    d.items[0]!.source_ids = [advisory.id, id];
    const r = check(d, C);
    expect(codesOf(r)).toEqual(["SOURCE_SYNDICATED items[0].source_ids"]);
    expect(r[0]!.message).toContain("Ivanti = Reuters");
    // A title too different to fold: two publishers, passes.
    d.sources[19]!.title = "SAMPLE: Ivanti customers hit before the fix";
    expect(check(d, C)).toEqual([]);
  });

  it("SOURCE_CRITICAL_TWO, not SOURCE_SYNDICATED, when the bar is missed before folding too", () => {
    const d = weekdayDraft();
    const id = addSource(d, { url: "https://www.reuters.com/ct-sample/copy", title: d.sources[2]!.title });
    d.items[0]!.source_ids = [S["bc-ivanti"], id];
    d.items[0]!.flaw_evidence = [];
    expect(codesOf(check(d, C))).toEqual(["SOURCE_CRITICAL_TWO items[0].source_ids"]);
  });

  it("a withhold's masked titles never fold: a withheld Critical item keeps the publishers it was published with (published mode)", () => {
    const b = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "site-content", "briefs", "2026-10-14.json"), "utf8")) as Brief;
    const it0 = b.items[0]!;
    expect(it0.severity).toBe("critical");
    const own = b.sources.filter((s) => it0.source_ids.includes(s.id));
    expect(own.length).toBeGreaterThanOrEqual(2);
    const config = fixtureConfig();
    const groups = (x: Brief) => derive(x, "published", config).publishersByIndex[0]!.groups.length;
    const before = groups(b);
    const run = (x: Brief) => sourceRules.filter((r) => r.codes.some((c) => C.includes(c)))
      .flatMap((r) => r.check({ draft: x, mode: "published", config, derived: derive(x, "published", config) } as unknown as RuleInput));
    expect(run(b)).toEqual([]);
    for (const s of own) {
      s.title = WITHHELD_MARK;
      if (s.title_en !== null) s.title_en = WITHHELD_MARK;
    }
    expect(groups(b)).toBe(before);
    expect(run(b)).toEqual([]);
    // Real titles alike still fold as copies of one story.
    for (const s of own) {
      s.title = "SAMPLE: Ivanti Connect Secure flaw exploited in attacks";
      s.title_en = null;
    }
    expect(groups(b)).toBe(1);
    expect(run(b).map((x) => x.code)).toEqual(["SOURCE_SYNDICATED"]);
  });

  it("ignores items below Critical", () => {
    const d = weekdayDraft();
    d.items[0]!.severity = "high";
    d.items[0]!.source_ids = [S["ivanti-advisory"]];
    expect(check(d, C)).toEqual([]);
  });
});

// ── SOURCE_STATE_LABEL ───────────────────────────────────────────────────────────────────────────

describe("SOURCE_STATE_LABEL", () => {
  const L = ["SOURCE_STATE_LABEL"];
  const M = (d: DraftBrief) => at(d, MONDAY_ITEMS.stateClaim);

  it("the label or '<country> state claim' in the headline or summary passes", () => {
    expect(stateClaimPhrase("PRC state source")).toBe("PRC state claim");
    expect(stateClaimPhrase("Russian state media")).toBe("Russian state claim");
    const d = mondayDraft();
    expect(check(d, L, { edition: "monday" })).toEqual([]);
    d.items[M(d)]!.headline = "CVERC says US agencies broke into a national time service network";
    expect(check(d, L, { edition: "monday" })).toEqual([]); // the summary still says "a PRC state source"
    d.items[M(d)]!.summary = "CVERC says so. This is a prc state claim with no evidence.";
    expect(check(d, L, { edition: "monday" })).toEqual([]);
  });

  it("a claim_type other than government", () => {
    const d = mondayDraft();
    d.items[M(d)]!.claim_type = "independent";
    const r = check(d, L, { edition: "monday" });
    expect(codesOf(r)).toEqual([`SOURCE_STATE_LABEL items[${M(d)}].claim_type`]);
    expect(r[0]!.message).toContain('Set claim_type to "government"');
  });

  it("a tier 3 state media source needs its own label", () => {
    const d = weekdayDraft();
    const c = at(d, I.chinaAxis);
    const id = addSource(d, { url: "https://tass.com/ct-sample/taiwan-chips", source_type: "other" });
    d.items[c]!.source_ids.push(id);
    d.items[c]!.claim_type = "government";
    const r = check(d, L);
    expect(codesOf(r)).toEqual([`SOURCE_STATE_LABEL items[${c}].headline`]);
    expect(r[0]!.message).toContain('"Russian state media" or "Russian state claim"');
    d.items[c]!.summary = `${d.items[c]!.summary} A Russian state claim adds nothing.`;
    expect(check(d, L)).toEqual([]);
  });
});

// ── RELEASE_SOURCE ───────────────────────────────────────────────────────────────────────────────

describe("RELEASE_SOURCE (review of row 146)", () => {
  const R = ["RELEASE_SOURCE"];
  const REL = "rel-microsoft-2026-10";
  /** The weekday inputs with the Microsoft release unexploited, the case the press-only probe hit at publish. */
  const unexploited = (base = draftInputs("weekday")): DraftInputs => ({
    ...base,
    context: {
      ...base.context!,
      candidates: base.context!.candidates.map((c) => (c.release?.release_id === REL
        ? { ...c, cve_ids: [], release: { ...c.release, exploited: 0, exploited_cve_ids: [] } } : c)),
    },
  });
  /** The patch batch citing only SecurityWeek and naming no CVE id. */
  const pressOnly = () => {
    const d = weekdayDraft();
    const p = at(d, I.patchBatch);
    Object.assign(d.items[p]!, { cve_ids: [], flaw_evidence: [], source_ids: [S["sw-microsoft"]] });
    return { d, p };
  };
  /** Whether releaseBlockOf() composes the item as publish would, from the same inputs. */
  const composes = (d: DraftBrief, p: number, inputs: DraftInputs): boolean => {
    const sources = d.sources.map((s) => freezeSource(s, "pack", inputs.config));
    const release = inputs.context!.candidates.find((c) => c.release?.release_id === REL)!.release!;
    try {
      return releaseBlockOf(d.items[p]!, release, sources, inputs.config, inputs.cveList) !== null;
    } catch (e) {
      if (e instanceof ComposeError) return false;
      throw e;
    }
  };

  it("RELEASE_SOURCE: a patch batch of an unexploited release citing only the press and naming no CVE id fails before publish, with the fix in its hint", () => {
    const { d, p } = pressOnly();
    const inputs = unexploited();
    const r = check(d, R, { inputs });
    expect(codesOf(r)).toEqual([`RELEASE_SOURCE items[${p}].source_ids`]);
    expect(r[0]!.message).toBe(`items[${p}] (${I.patchBatch}) names release ${REL}, but publish cannot date its release block: it cites no tier 1 source of Microsoft, and it names none of the release's CVE ids.`);
    expect(r[0]!.hint).toBe("Cite Microsoft's own advisory for the release from the pack (a tier 1 source on Microsoft's domain), with its published_at, or name the release's CVE ids (its pack records) in cve_ids.");
    // With every rule, as the morning runs it: the draft is rejected, so the repair round gets the finding.
    const all = validateDraft(d, { ...inputs });
    expect(all.ok).toBe(false);
    expect(all.errors.map((e) => e.code)).toContain("RELEASE_SOURCE");
    expect(composes(d, p, inputs)).toBe(false);
  });

  it("citing the vendor's own bulletin, or naming a CVE id of the release, passes; and releaseBlockOf() then composes", () => {
    const inputs = unexploited();
    const withBulletin = pressOnly();
    withBulletin.d.items[withBulletin.p]!.source_ids.unshift(S["msrc-october"]);
    expect(check(withBulletin.d, R, { inputs })).toEqual([]);
    expect(composes(withBulletin.d, withBulletin.p, inputs)).toBe(true);
    const withCve = pressOnly();
    withCve.d.items[withCve.p]!.cve_ids = ["CVE-2026-96951"];
    expect(check(withCve.d, R, { inputs })).toEqual([]);
    expect(composes(withCve.d, withCve.p, inputs)).toBe(true);
    // The weekday draft as it stands: an exploited release, dated from its bulletin.
    expect(check(weekdayDraft(), R)).toEqual([]);
  });

  it("the other ways publish cannot date a release: a bulletin with no published_at, and an exploited release whose records are unknown", () => {
    const inputs = unexploited();
    const undated = pressOnly();
    undated.d.items[undated.p]!.source_ids.unshift(S["msrc-october"]);
    const ms = undated.d.sources.findIndex((s) => s.id === S["msrc-october"]);
    undated.d.sources[ms]!.published_at = null;
    const r1 = check(undated.d, R, { inputs });
    expect(codesOf(r1)).toEqual([`RELEASE_SOURCE items[${undated.p}].source_ids`]);
    expect(r1[0]!.message).toContain(`its Microsoft source ${S["msrc-october"]} has no published_at, and it names none of the release's CVE ids.`);
    expect(r1[0]!.hint).toBe(`Give ${S["msrc-october"]} the published_at its page shows, or name the release's CVE ids (its pack records) in cve_ids.`);
    // The exploited release (the weekday context) dates from its exploited CVEs: with no CVE List, only the bulletin can.
    const exploited = pressOnly();
    const noList = { ...draftInputs("weekday"), cveList: null };
    const r2 = check(exploited.d, R, { inputs: noList });
    expect(r2[0]!.message).toContain("no CVE List record of CVE-2026-96951 gives a publication date");
    expect(r2[0]!.hint).toBe("Cite Microsoft's own advisory for the release from the pack (a tier 1 source on Microsoft's domain), with its published_at.");
    expect(composes(exploited.d, exploited.p, noList)).toBe(false);
    exploited.d.items[exploited.p]!.source_ids.push(S["msrc-october"]);
    expect(check(exploited.d, R, { inputs: noList })).toEqual([]);
    expect(composes(exploited.d, exploited.p, noList)).toBe(true);
  });

  it("agrees with releaseBlockOf() case by case: the rule fails a draft exactly when publish would throw ComposeError", () => {
    const cases: Array<[string, (d: DraftBrief, p: number) => void, () => DraftInputs]> = [
      ["press only, unexploited", () => {}, () => unexploited()],
      ["bulletin, unexploited", (d, p) => d.items[p]!.source_ids.push(S["msrc-october"]), () => unexploited()],
      ["CVE id, unexploited", (d, p) => { d.items[p]!.cve_ids = ["CVE-2026-96951"]; }, () => unexploited()],
      ["unknown CVE id, unexploited", (d, p) => { d.items[p]!.cve_ids = ["CVE-2026-99999"]; }, () => unexploited()],
      ["CVE id, no CVE List", (d, p) => { d.items[p]!.cve_ids = ["CVE-2026-96951"]; }, () => ({ ...unexploited(), cveList: null })],
      ["record source only, unexploited", (d, p) => { d.items[p]!.source_ids = [S["rec-96951"]]; }, () => unexploited()],
      ["press only, exploited", () => {}, () => draftInputs("weekday")],
      ["press only, exploited, no CVE List", () => {}, () => ({ ...draftInputs("weekday"), cveList: null })],
      ["bulletin second, exploited, no CVE List", (d, p) => d.items[p]!.source_ids.push(S["msrc-october"]), () => ({ ...draftInputs("weekday"), cveList: null })],
      // Only the release's own fixes count (review of row 146): a record from another CNA neither dates nor links the block.
      ["another CNA's CVE id, unexploited", (d, p) => { d.items[p]!.cve_ids = [OTHER_CNA]; }, () => unexploited()],
      ["another vendor's CVE id, unexploited", (d, p) => { d.items[p]!.cve_ids = [IVANTI]; }, () => unexploited()],
      ["another CNA's, then the release's CVE id, unexploited", (d, p) => { d.items[p]!.cve_ids = [OTHER_CNA, "CVE-2026-96951"]; }, () => unexploited()],
      ["another CNA's CVE id, exploited", (d, p) => { d.items[p]!.cve_ids = [OTHER_CNA]; }, () => draftInputs("weekday")],
      ["another CNA's CVE id and the bulletin, unexploited", (d, p) => { d.items[p]!.cve_ids = [OTHER_CNA]; d.items[p]!.source_ids.push(S["msrc-october"]); }, () => unexploited()],
    ];
    const seen = cases.map(([name, mutate, inputsOf]) => {
      const { d, p } = pressOnly();
      mutate(d, p);
      const inputs = inputsOf();
      return [name, check(d, R, { inputs }).length === 0, composes(d, p, inputs)];
    });
    expect(seen.map(([name, passes, ok]) => [name, passes === ok])).toEqual(cases.map(([name]) => [name, true]));
    expect(seen.filter(([, passes]) => !passes).map(([name]) => name)).toEqual([
      "press only, unexploited", "unknown CVE id, unexploited", "CVE id, no CVE List", "record source only, unexploited", "press only, exploited, no CVE List",
      "another CNA's CVE id, unexploited", "another vendor's CVE id, unexploited",
    ]);
  });

  /** CVE-2026-108917 is a VulDB record and CVE-2026-104935 an Ivanti one in the weekday CVE List; CVE-2026-96951 is Microsoft's. */
  const OTHER_CNA = "CVE-2026-108917";
  const IVANTI = "CVE-2026-104935";

  it("RELEASE_SOURCE: a CVE id that is not the release's neither dates nor links it, and the message names it (review of row 146)", () => {
    // Before, any CVE id with a record dated the block: a VulDB record dated Microsoft's release 2026-10-12, not the 13th, and
    // its cve.org page became the block's link.
    const inputs = unexploited();
    const one = pressOnly();
    one.d.items[one.p]!.cve_ids = [OTHER_CNA];
    const r = check(one.d, R, { inputs });
    expect(codesOf(r)).toEqual([`RELEASE_SOURCE items[${one.p}].source_ids`]);
    expect(r[0]!.message).toBe(`items[${one.p}] (${I.patchBatch}) names release ${REL}, but publish cannot date its release block: it cites no tier 1 source of Microsoft, and it names none of the release's CVE ids (${OTHER_CNA} is not among the release's fixes: it has no CVE List record from Microsoft's CNA, so it is ignored).`);
    expect(r[0]!.hint).toBe("Cite Microsoft's own advisory for the release from the pack (a tier 1 source on Microsoft's domain), with its published_at, or name the release's CVE ids (its pack records) in cve_ids.");
    expect(composes(one.d, one.p, inputs)).toBe(false);
    const two = pressOnly();
    two.d.items[two.p]!.cve_ids = [OTHER_CNA, IVANTI, "CVE-2026-99999"];
    expect(check(two.d, R, { inputs })[0]!.message).toContain(`(${OTHER_CNA}, ${IVANTI}, CVE-2026-99999 are not among the release's fixes: they have no CVE List record from Microsoft's CNA, so they are ignored)`);
    // Beside a fix of the release, the other id is ignored: the block is dated, titled and linked from Microsoft's record.
    const mixed = pressOnly();
    mixed.d.items[mixed.p]!.cve_ids = [OTHER_CNA, "CVE-2026-96951"];
    expect(check(mixed.d, R, { inputs })).toEqual([]);
    const release = inputs.context!.candidates.find((c) => c.release?.release_id === REL)!.release!;
    const block = releaseBlockOf(mixed.d.items[mixed.p]!, release, mixed.d.sources.map((s) => freezeSource(s, "pack", inputs.config)), inputs.config, inputs.cveList)!;
    expect(block).toMatchObject({ date: "2026-10-13", title: "Microsoft security updates, 2026-10", source_url: "https://www.cve.org/CVERecord?id=CVE-2026-96951" });
    const basis = releaseBasisOf(mixed.d.items[mixed.p]!, release, mixed.d.sources, () => undefined, inputs.config, inputs.cveList);
    expect([basis.bundle, basis.ignored, basis.date, basis.problem]).toEqual([["CVE-2026-96951"], [OTHER_CNA], "2026-10-13", null]);
  });

  it("releaseMember(): the release's exploited ids, or a record from one of the vendor's CNAs; never an unknown id (review of row 146)", () => {
    const { cveList, config } = draftInputs("weekday");
    const microsoft = config.vendors.vendors.find((v) => v.id === "microsoft")!;
    const none = { exploited_cve_ids: [] as string[] };
    const table: Array<[string, { exploited_cve_ids: string[] }, boolean, boolean]> = [
      // id, release, with the CVE List, without it
      ["CVE-2026-96951", none, true, false],
      ["cve-2026-96951", none, true, false],
      [OTHER_CNA, none, false, false],
      [IVANTI, none, false, false],
      ["CVE-2026-99999", none, false, false],
      [OTHER_CNA, { exploited_cve_ids: [OTHER_CNA] }, true, true],
    ];
    expect(table.map(([id, rel]) => [id, releaseMember(id, rel, microsoft, cveList), releaseMember(id, rel, microsoft, null)]))
      .toEqual(table.map(([id, , withList, without]) => [id, withList, without]));
    expect(releaseMember("CVE-2026-96951", none, null, cveList)).toBe(false);
  });
});

// ── SOURCE_ORPHAN ────────────────────────────────────────────────────────────────────────────────

describe("SOURCE_ORPHAN", () => {
  it("warns for a source no field cites", () => {
    const d = weekdayDraft();
    addSource(d, { url: "https://www.reuters.com/ct-sample/uncited" });
    const r = check(d, ["SOURCE_ORPHAN"]);
    expect(codesOf(r)).toEqual(["W SOURCE_ORPHAN sources[19]"]);
    expect(r[0]!.message).toContain("s20 (https://www.reuters.com/ct-sample/uncited) is never cited");
  });

  it("in a Brief, a Scoreboard entry or correction citing by URL counts", () => {
    const inputs = draftInputs("weekday");
    const d = weekdayDraft();
    const ncsc = d.sources[17]!;
    const brief = asBrief(d, inputs);
    (brief.scoreboard.entries[0] as { source_url: string | null }).source_url = ncsc.url;
    const rule = sourceRules.find((r) => r.codes.includes("SOURCE_ORPHAN"))!;
    const run = (b: Brief) => rule.check({ draft: b, mode: "published", derived: derive(b, "published", inputs.config) } as RuleInput);
    expect(run(brief)).toEqual([]);
    (brief.scoreboard.entries[0] as { source_url: string | null }).source_url = null;
    expect(run(brief).map((x) => x.path)).toEqual(["sources[17]"]);
  });
});
