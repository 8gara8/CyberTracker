// The meta, ids and items rule groups (SPEC §4.12): DATE_MISMATCH, WEEKLY_FLAG, AI_UNASSESSED, CANARY,
// METRICS_MISSING (the engine's warning), ID_FORMAT, ID_SEQUENCE, ID_DUPLICATE, ITEM_CAP, ITEM_ORDER,
// TOP3_WHY, SEVERITY_NULL_FOR_NONTHREAT, SEVERITY_KIND, TAIWAN_LENS_REQUIRED, REGION_RAISE,
// STANDING_STORY_NEW_FACT, SCOREBOARD_REF. Each rule gets passing and failing cases for its
// sub-conditions on mutations of the fixture drafts, run with only these three groups so another group's
// rule never masks a result; the F fixtures (fixtures/src/invalid/meta-items.ts) are checked against every
// registered rule at the end. Sample text is invented and marked SAMPLE.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INVALID_CASES, invalidDraft } from "@/fixtures/src/build";
import { mondayDraft, quietDraft, weekdayDraft, WEEKDAY_ITEMS } from "@/fixtures/src/drafts";
import { draftInputs } from "@/fixtures/src/inputs";
import type { EditionName } from "@/fixtures/src/world";
import { metaItemsCases } from "@/fixtures/src/invalid/meta-items";
import { idRules, idProblem } from "@/lib/rules/ids";
import { claimOpen, datedAfter, draftFirstSeen, draftRegions, itemRules, termIn } from "@/lib/rules/items";
import { metaRules } from "@/lib/rules/meta";
import { derive } from "@/lib/rules/shared";
import { defineRule, warning, type Rule, type RuleInput, type ValidationIssue } from "@/lib/rules/types";
import type { DraftBrief } from "@/lib/schema/draft-brief";
import type { DraftItem } from "@/lib/schema/item";
import { normalizeUrl } from "@/lib/urls";
import { runRules, validateDraft, type DraftInputs } from "@/lib/validate";
import { CANARY_TOKEN, NO_NEWS_ROW, NONE_FOUND, TAIWAN_NO_NEWS } from "@/lib/vocab";

const MINE: readonly Rule[] = [...metaRules, ...idRules, ...itemRules];
const I = WEEKDAY_ITEMS;

/** validateDraft() with only this part's rules; `tweak` may change the fresh inputs. */
function check(draft: unknown, name: EditionName = "weekday", tweak?: (i: DraftInputs) => void) {
  const inputs = draftInputs(name);
  tweak?.(inputs);
  return validateDraft(draft, { ...inputs, rules: MINE });
}

const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);
const only = (r: { errors: ValidationIssue[] }, code: string) => r.errors.filter((e) => e.code === code);
const idx = (d: DraftBrief, id: string) => d.items.findIndex((it) => it.id === id);
const item = (d: DraftBrief, id: string): DraftItem => d.items[idx(d, id)]!;

/** A Brief-shaped copy of a draft for published mode (the rules read only the fields they need). */
function published(d: DraftBrief, edition: "full" | "partial" | "data_only" = "full"): Record<string, unknown> {
  const { region_raises: _r, scoreboard_entries: entries, ...rest } = d;
  return {
    ...rest, edition, computed: { word_count: 0 },
    regions: { rows: [], global: { item_count: 0 }, signals: [] },
    scoreboard: {
      entries: entries.map((e, i) => ({
        id: `SE-${String(i + 1).padStart(4, "0")}`, date: d.date, claim_id: e.claim_id, origin: "report", direction: "neutral",
        summary: e.summary, value: null, reported_value: e.reported_value, quote: e.quote, claim_type: e.claim_type,
        source_url: d.sources.find((s) => s.id === e.quote_source_id)?.url ?? null, metrics_ref: null,
      })),
      last: null,
    },
  };
}

/** runRules() in published mode on a Brief-shaped object (no context, evidence or regions input). */
function checkPublished(brief: Record<string, unknown>, fileDate: string | null = null) {
  const config = draftInputs("weekday").config;
  const input: Omit<RuleInput, "derived"> = {
    draft: brief as never, mode: "published", date: String(brief.date), fileDate, metrics: null, config,
    context: null, evidence: null, cveList: null, regionsBase: null, packDates: null, crossFile: null,
  };
  const issues = runRules(input, [], MINE);
  return { errors: issues.filter((i) => i.severity === "error"), warnings: issues.filter((i) => i.severity === "warning") };
}

// ── The valid drafts ─────────────────────────────────────────────────────────────────────────────

describe("valid drafts", () => {
  it.each(["weekday", "monday", "quiet"] as const)("%s passes every rule in this part", (name) => {
    const r = check({ weekday: weekdayDraft, monday: mondayDraft, quiet: quietDraft }[name](), name);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("the weekday draft passes in published mode too", () => {
    const r = checkPublished(published(weekdayDraft()), "2026-10-14");
    expect(r.errors).toEqual([]);
  });
});

// ── Shape, dates, editions ───────────────────────────────────────────────────────────────────────

describe("DATE_MISMATCH", () => {
  it("fails a date that differs from the run's Taipei date", () => {
    const d = weekdayDraft();
    d.date = "2026-10-13";
    const e = only(check(d), "DATE_MISMATCH");
    expect(e.map((x) => x.path)).toEqual(["date"]);
    expect(e[0]!.message).toContain('set "date" to "2026-10-14"');
  });

  it("fails a date that differs from the file name", () => {
    const r = check(weekdayDraft(), "weekday", (i) => { i.fileDate = "2026-10-15"; });
    expect(only(r, "DATE_MISMATCH")[0]!.message).toContain("2026-10-15.json");
  });

  it("fails generated_at before the window end or after the deadline, and passes the bounds", () => {
    const early = weekdayDraft();
    early.generated_at = "2026-10-14T04:29:00+08:00";
    expect(only(check(early), "DATE_MISMATCH")[0]!.message).toContain("before the news window ends");
    const late = weekdayDraft();
    late.generated_at = "2026-10-13T21:16:00Z"; // 05:16 Taipei
    expect(only(check(late), "DATE_MISMATCH")[0]!.message).toContain("after the deadline");
    for (const t of ["2026-10-14T04:30:00+08:00", "2026-10-14T05:15:00+08:00"]) {
      const ok = weekdayDraft();
      ok.generated_at = t;
      expect(codes(check(ok))).not.toContain("DATE_MISMATCH");
    }
  });

  it("in published mode checks only the file name, and runs on a data-only edition (†)", () => {
    const b = published(weekdayDraft(), "data_only");
    b.items = [];
    b.generated_at = "2026-10-14T09:00:00+08:00";
    expect(codes(checkPublished(b, "2026-10-14"))).not.toContain("DATE_MISMATCH");
    expect(codes(checkPublished(b, "2026-10-15"))).toContain("DATE_MISMATCH");
  });
});

describe("WEEKLY_FLAG", () => {
  it("fails a Monday without week_in_review", () => {
    const d = mondayDraft();
    d.week_in_review = null;
    expect(only(check(d, "monday"), "WEEKLY_FLAG")[0]!.message).toContain("is a Monday");
  });

  it("fails week_in_review on another day", () => {
    const d = weekdayDraft();
    d.week_in_review = { text: "SAMPLE.", strongest_against: { text: NONE_FOUND, claim_id: null, source_ids: [] } };
    expect(only(check(d), "WEEKLY_FLAG").map((e) => e.path)).toEqual(["week_in_review"]);
  });

  it(`fails "${NONE_FOUND}" with source ids, and a near miss of it`, () => {
    const a = mondayDraft();
    a.week_in_review!.strongest_against = { text: NONE_FOUND, claim_id: null, source_ids: ["s7"] };
    expect(only(check(a, "monday"), "WEEKLY_FLAG").map((e) => e.path)).toEqual(["week_in_review.strongest_against.source_ids"]);
    const b = mondayDraft();
    b.week_in_review!.strongest_against = { text: "None found.", claim_id: null, source_ids: [] };
    expect(only(check(b, "monday"), "WEEKLY_FLAG")[0]!.message).toContain(`write exactly "${NONE_FOUND}"`);
  });

  it("fails a text with no source or only tier 3 sources, and passes a tier 1 source", () => {
    const none = mondayDraft();
    none.week_in_review!.strongest_against.source_ids = [];
    expect(only(check(none, "monday"), "WEEKLY_FLAG")[0]!.message).toContain("cites no source");
    const t3 = mondayDraft();
    t3.sources.push({ ...t3.sources[0]!, id: "s8", url: "https://example.org/sample/ct-weekly", source_type: "other", title: "SAMPLE page" });
    t3.week_in_review!.strongest_against.source_ids = ["s8"];
    expect(only(check(t3, "monday"), "WEEKLY_FLAG")[0]!.message).toContain("only tier 3 sources (s8)");
    expect(codes(check(mondayDraft(), "monday"))).not.toContain("WEEKLY_FLAG");
  });

  it("leaves unknown source ids to SOURCE_REF", () => {
    const d = mondayDraft();
    d.week_in_review!.strongest_against.source_ids = ["s99"];
    expect(codes(check(d, "monday"))).not.toContain("WEEKLY_FLAG");
  });

  it("does not run on a data-only edition, which has no week in review", () => {
    const b = published(mondayDraft(), "data_only");
    b.week_in_review = null;
    b.items = [];
    expect(codes(checkPublished(b))).toEqual([]);
  });
});

describe("AI_UNASSESSED", () => {
  it("fails unassessed in a draft", () => {
    const d = weekdayDraft();
    item(d, I.landmark).ai_role = "unassessed";
    expect(only(check(d), "AI_UNASSESSED")).toHaveLength(1);
  });

  it("fails any other role in a data-only edition and passes unassessed there (†)", () => {
    const d = weekdayDraft();
    const b = published(d, "data_only");
    b.items = [{ ...d.items[0], ai_role: "none" }, { ...d.items[1], ai_role: "unassessed" }];
    const e = only(checkPublished(b), "AI_UNASSESSED");
    expect(e.map((x) => x.path)).toEqual(["items[0].ai_role"]);
  });

  it("fails unassessed in a full or partial edition", () => {
    for (const edition of ["full", "partial"] as const) {
      const d = weekdayDraft();
      d.items[0]!.ai_role = "unassessed";
      expect(codes(checkPublished(published(d, edition)))).toContain("AI_UNASSESSED");
    }
  });

  it("passes unassessed on a withheld item in a full edition: a data-only item kept withheld, unread (§4.10)", () => {
    const d = weekdayDraft();
    const b = published(d, "full");
    const items = b.items as Record<string, unknown>[];
    items[0] = { ...items[0], ai_role: "unassessed", withheld: { correction_id: "C-0001", since: "2026-10-14" } };
    items[1] = { ...items[1], ai_role: "unassessed" };
    expect(only(checkPublished(b), "AI_UNASSESSED").map((x) => x.path)).toEqual(["items[1].ai_role"]);
  });
});

describe("CANARY", () => {
  it("fails a draft carrying the planted instruction text from fixtures/injection/page.html", () => {
    const html = fs.readFileSync(path.join(process.cwd(), "fixtures/injection/page.html"), "utf8");
    const planted = /<p[^>]*>([^<]*CT-CANARY[^<]*)<\/p>/s.exec(html)?.[1] ?? "";
    expect(planted).toContain(CANARY_TOKEN);
    const d = weekdayDraft();
    d.items[0]!.summary = `SAMPLE. ${planted.replace(/\s+/g, " ").trim()}`;
    const e = only(check(d), "CANARY");
    expect(e.map((x) => x.path)).toEqual(["items[0].summary"]);
    expect(e[0]!.message).not.toContain(CANARY_TOKEN);
  });

  it("finds the token in any string, any case, and in published mode", () => {
    const d = weekdayDraft();
    d.sources[2]!.title = `SAMPLE ${CANARY_TOKEN.toLowerCase()}`;
    d.lead[0]!.item_ids.push(`x-${CANARY_TOKEN}`);
    expect(only(check(d), "CANARY").map((x) => x.path)).toEqual(["lead[0].item_ids[2]", "sources[2].title"]);
    expect(codes(checkPublished(published(d, "data_only")))).toContain("CANARY");
  });
});

describe("METRICS_MISSING", () => {
  const needs = defineRule({ code: "SAMPLE_NEEDS_METRICS", scope: "brief", needsMetrics: true, check: () => [] });

  it("warns once, naming the skipped checks, when metrics is null", () => {
    const inputs = { ...draftInputs("weekday"), metrics: null, rules: [...MINE, needs] };
    const r = validateDraft(weekdayDraft(), inputs);
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(["METRICS_MISSING"]);
    expect(r.warnings[0]!.message).toContain("SAMPLE_NEEDS_METRICS");
  });

  it("is silent when the metrics are there, or when no rule needs them", () => {
    expect(validateDraft(weekdayDraft(), { ...draftInputs("weekday"), rules: [...MINE, needs] }).warnings).toEqual([]);
    expect(validateDraft(weekdayDraft(), { ...draftInputs("weekday"), metrics: null, rules: MINE }).warnings).toEqual([]);
  });

  it("is a warning, never an error", () => {
    const w = warning("METRICS_MISSING", "(metrics)", "SAMPLE");
    expect(w.severity).toBe("warning");
  });
});

// ── Ids ──────────────────────────────────────────────────────────────────────────────────────────

describe("ID_FORMAT", () => {
  const flaw = { kind: "exploited_flaw" as const, cve_ids: ["CVE-2026-104935"], release_id: null };
  it.each([
    ["the first CVE id lower-cased", { ...flaw, id: "cve-2026-104935" }, null],
    ["another CVE id", { ...flaw, id: "cve-2026-999999" }, 'must be "cve-2026-104935"'],
    ["a slug on a flaw with a CVE", { ...flaw, id: "vuln-ivanti" }, 'must be "cve-2026-104935"'],
    ["vuln- on a flaw without a CVE id", { ...flaw, cve_ids: [], id: "vuln-ivanti-connect-secure" }, null],
    ["cve- with no cve_ids", { ...flaw, cve_ids: [], id: "cve-2026-104935" }, "cve_ids is empty"],
    ["cve- on a breach", { kind: "breach" as const, cve_ids: [], release_id: null, id: "cve-2026-104935" }, 'only a flaw item'],
    ["a policy slug", { kind: "policy" as const, cve_ids: [], release_id: null, id: "pol-tw-incident-reporting-2026-10" }, null],
    ["upper case", { kind: "policy" as const, cve_ids: [], release_id: null, id: "pol-TW-rules" }, 'e.g. "pol-tw-rules"'],
    ["a double hyphen", { kind: "breach" as const, cve_ids: [], release_id: null, id: "inc-retail--nl" }, "single hyphens"],
    ["a trailing hyphen", { kind: "campaign" as const, cve_ids: [], release_id: null, id: "camp-x-" }, "single hyphens"],
    ["the wrong prefix", { kind: "ecosystem" as const, cve_ids: [], release_id: null, id: "ai-nvd-backlog" }, '"eco-"'],
    ["a supply chain slug", { kind: "supply_chain" as const, cve_ids: [], release_id: null, id: "sc-pypi-litellm-2026-10" }, null],
    ["a patch batch from its release", { kind: "patch_batch" as const, cve_ids: [], release_id: "rel-microsoft-2026-10", id: "pt-microsoft-2026-10" }, null],
    ["a patch batch with the UTC day", { kind: "patch_batch" as const, cve_ids: [], release_id: "rel-microsoft-2026-10-14", id: "pt-microsoft-2026-10-14" }, null],
    ["a patch batch off its release", { kind: "patch_batch" as const, cve_ids: [], release_id: "rel-microsoft-2026-10", id: "pt-microsoft-october" }, 'must be "pt-microsoft-2026-10"'],
    ["a patch batch without a release", { kind: "patch_batch" as const, cve_ids: [], release_id: null, id: "pt-microsoft-2026-10" }, "needs release_id"],
    ["an id over 64 characters", { kind: "policy" as const, cve_ids: [], release_id: null, id: `pol-${"a".repeat(61)}` }, "the limit is 64"],
  ])("%s", (_name, it_, want) => {
    const p = idProblem(it_);
    if (want === null) expect(p).toBeNull();
    else expect(p).toContain(want);
  });

  it("fails a draft item with a bad id and passes the data-only edition's CVE ids (†)", () => {
    const d = weekdayDraft();
    item(d, I.aiConfirmed).id = "AI-aisle";
    expect(only(check(d), "ID_FORMAT").map((e) => e.path)).toEqual([`items[${idx(weekdayDraft(), I.aiConfirmed)}].id`]);
    const b = published(weekdayDraft(), "data_only");
    b.items = [{ ...weekdayDraft().items[0], ai_role: "unassessed", severity: null }];
    expect(codes(checkPublished(b))).toEqual([]);
  });

  it("draft mode fails an id the last 14 days used for another kind, and published mode skips that check", () => {
    const d = weekdayDraft();
    const tweak = (i: DraftInputs) => {
      i.context.recent_items.push({ date: "2026-10-13", id: I.landmark, kind: "campaign", headline: "SAMPLE", severity: "watch", source_urls: [] });
    };
    const e = only(check(d, "weekday", tweak), "ID_FORMAT");
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toContain("was a campaign item on 2026-10-13 but is a policy item here");
    const same = (i: DraftInputs) => {
      i.context.recent_items.push({ date: "2026-10-13", id: I.landmark, kind: "policy", headline: "SAMPLE", severity: null, source_urls: [] });
    };
    expect(codes(check(weekdayDraft(), "weekday", same))).not.toContain("ID_FORMAT");
  });
});

describe("ID_SEQUENCE", () => {
  it("fails a gap, a repeat and a wrong start, naming the first break", () => {
    const gap = weekdayDraft();
    gap.sources[4]!.id = "s6";
    expect(only(check(gap), "ID_SEQUENCE").map((e) => [e.path, e.message.slice(0, 40)])).toEqual([["sources[4].id", 'sources[4].id is "s6" but must be "s5": ']]);
    const zero = quietDraft();
    zero.sources = [{ ...weekdayDraft().sources[0]!, id: "s0" }];
    expect(only(check(zero, "quiet"), "ID_SEQUENCE")).toHaveLength(1);
    const swap = weekdayDraft();
    [swap.sources[0], swap.sources[1]] = [swap.sources[1]!, swap.sources[0]!];
    expect(only(check(swap), "ID_SEQUENCE")[0]!.message).toContain("2 of the 19 sources are out of place");
  });

  it("passes no sources", () => {
    expect(codes(check(quietDraft(), "quiet"))).toEqual([]);
  });
});

describe("ID_DUPLICATE", () => {
  it("fails the second item with an id, once per repeat", () => {
    const d = weekdayDraft();
    d.items[6]!.id = d.items[5]!.id;
    d.items[7]!.id = d.items[5]!.id;
    d.items[7]!.kind = "ai_capability";
    const e = only(check(d), "ID_DUPLICATE");
    expect(e.map((x) => x.path)).toEqual(["items[6].id", "items[7].id"]);
  });
});

// ── Items and sections ───────────────────────────────────────────────────────────────────────────

describe("ITEM_CAP", () => {
  it("fails 11 items and passes 10 or none", () => {
    const d = weekdayDraft();
    const extra = (n: number) => Array.from({ length: n }, (_, k) => ({ ...d.items[6]!, id: `ai-sample-extra-${k + 1}` }));
    const eleven = weekdayDraft();
    eleven.items = [...eleven.items, ...extra(3)];
    expect(only(check(eleven), "ITEM_CAP")[0]!.message).toBe(
      "items has 11 entries; the limit is 10. Cut at least 1, starting with the lowest-ranked Also-today rows.");
    const ten = weekdayDraft();
    ten.items = [...ten.items, ...extra(2)];
    expect(codes(check(ten))).not.toContain("ITEM_CAP");
    expect(codes(check(quietDraft(), "quiet"))).not.toContain("ITEM_CAP");
  });

  it("leaves withheld items out of the count: ten items and one a same-day withhold kept pass, eleven unwithheld fail (§4.10)", () => {
    const d = weekdayDraft();
    const extra = (n: number) => Array.from({ length: n }, (_, k) => ({ ...d.items[6]!, id: `ai-sample-extra-${k + 1}` }));
    const ten = weekdayDraft();
    ten.items = [...ten.items, ...extra(2)];
    const b = published(ten, "full");
    const items = b.items as Record<string, unknown>[];
    b.items = [...items, { ...items[9], id: "ai-sample-kept", withheld: { correction_id: "C-0001", since: "2026-10-14" } }];
    expect(only(checkPublished(b), "ITEM_CAP")).toEqual([]);
    b.items = [...items, { ...items[9], id: "ai-sample-kept", withheld: null }];
    expect(only(checkPublished(b), "ITEM_CAP")[0]!.message).toContain("items has 11 entries");
  });

  it("fails 7 Elsewhere rows and passes 6", () => {
    const d = weekdayDraft();
    d.elsewhere = Array.from({ length: 6 }, () => ({ ...d.elsewhere[0]! }));
    expect(codes(check(d))).not.toContain("ITEM_CAP");
    d.elsewhere.push({ ...d.elsewhere[0]! });
    expect(only(check(d), "ITEM_CAP")[0]!.path).toBe("elsewhere");
  });
});

describe("ITEM_ORDER", () => {
  it("fails top stories out of severity order and names where the item belongs", () => {
    const d = weekdayDraft();
    [d.items[0], d.items[1]] = [d.items[1]!, d.items[0]!];
    const e = only(check(d), "ITEM_ORDER");
    expect(e.map((x) => x.path)).toEqual(["items[0]"]);
    expect(e[0]!.message).toContain(`items[0] (${I.patchBatch}) is out of display order; it belongs at items[1]`);
  });

  it("fails rows out of head order", () => {
    const d = weekdayDraft();
    const a = idx(d, I.landmark);
    const b = idx(d, I.aiConfirmed);
    [d.items[a], d.items[b]] = [d.items[b]!, d.items[a]!];
    expect(codes(check(d))).toContain("ITEM_ORDER");
  });

  it("keeps the agent's order on a tie", () => {
    const d = weekdayDraft();
    const a = idx(d, I.aiConfirmed);
    const b = idx(d, I.glasswing);
    [d.items[a], d.items[b]] = [d.items[b]!, d.items[a]!];
    expect(codes(check(d))).not.toContain("ITEM_ORDER");
  });

  it("ranks a landmark as elevated: a top story above a watch item when there are few items", () => {
    const d = weekdayDraft();
    d.items = [item(d, I.landmark), item(d, I.taiwanVendor)].map((x) => ({ ...x, why_it_matters: "SAMPLE one sentence." }));
    expect(codes(check(d))).not.toContain("ITEM_ORDER");
    d.items.reverse();
    expect(codes(check(d))).toContain("ITEM_ORDER");
  });

  it("leaves a withheld item's slot free in a published brief: kept after the rest, or masked in a top slot, whatever its severity (§0.4 row 126)", () => {
    const withheld = { correction_id: "C-0001", since: "2026-10-14" };
    const held = (x: DraftItem) => ({ ...x, withheld });
    const order = (b: Record<string, unknown>) => only(checkPublished(b), "ITEM_ORDER");
    // The Critical item kept after every other item: its stored severity no longer pulls it into the top stories.
    const d = weekdayDraft();
    const top = { ...structuredClone(d.items[0]!), id: `${d.items[0]!.id}-kept` };
    expect(top.severity).toBe("critical");
    const kept = published({ ...d, items: [...d.items, held(top)] });
    expect(order(kept)).toEqual([]);
    // The same item unwithheld at the end is out of order.
    expect(order(published({ ...d, items: [...d.items, top] })).map((e) => e.path)).toEqual(["items[1]"]);
    // A withheld item rewritten in place in a top slot keeps it, and the items around it still order among themselves:
    // the other top stories by rank, the rows by head.
    const inPlace = published({ ...d, items: [d.items[0]!, held(d.items[1]!), ...d.items.slice(2)] });
    expect(order(inPlace)).toEqual([]);
    const swapped = weekdayDraft();
    [swapped.items[0], swapped.items[2]] = [swapped.items[2]!, swapped.items[0]!];
    const e = order(published({ ...swapped, items: [swapped.items[0]!, held(swapped.items[1]!), ...swapped.items.slice(2)] }));
    expect(e.map((x) => x.path)).toEqual(["items[0]"]);
    expect(e[0]!.message).toContain("it belongs at items[2]");
  });
});

describe("TOP3_WHY", () => {
  it.each([
    ["null", null, "no why_it_matters"],
    ["blank", "   ", "no why_it_matters"],
    ["two sentences", "SAMPLE first sentence. SAMPLE second sentence.", "has 2 sentences"],
  ])("fails a top story whose why_it_matters is %s", (_n, why, want) => {
    const d = weekdayDraft();
    d.items[2]!.why_it_matters = why;
    const e = only(check(d), "TOP3_WHY");
    expect(e.map((x) => x.path)).toEqual(["items[2].why_it_matters"]);
    expect(e[0]!.message).toContain(want);
  });

  it("passes an abbreviation inside one sentence, and a row without why_it_matters", () => {
    const d = weekdayDraft();
    d.items[0]!.why_it_matters = "SAMPLE: U.S. agencies rely on these gateways.";
    expect(codes(check(d))).not.toContain("TOP3_WHY");
    expect(d.items[3]!.why_it_matters).toBeNull();
  });

  it("checks every item when there are fewer than three", () => {
    const d = weekdayDraft();
    d.items = d.items.slice(0, 2);
    d.items[1]!.why_it_matters = null;
    expect(only(check(d), "TOP3_WHY").map((x) => x.path)).toEqual(["items[1].why_it_matters"]);
  });
});

describe("SEVERITY_NULL_FOR_NONTHREAT", () => {
  it("fails a severity on a no-severity kind, none on a kind that needs one, and landmark on a severity kind", () => {
    const a = weekdayDraft();
    item(a, I.glasswing).severity = "watch";
    const b = weekdayDraft();
    item(b, I.claimedVictim).severity = null;
    const c = weekdayDraft();
    item(c, I.chinaAxis).landmark = true;
    expect(only(check(a), "SEVERITY_NULL_FOR_NONTHREAT")[0]!.message).toContain("An ai_capability item has no severity");
    expect(only(check(b), "SEVERITY_NULL_FOR_NONTHREAT")[0]!.message).toContain("A breach item needs a severity");
    expect(only(check(c), "SEVERITY_NULL_FOR_NONTHREAT")[0]!.path).toBe(`items[${idx(c, I.chinaAxis)}].landmark`);
  });

  it("passes a null severity on a withheld, unassessed item in a full edition, and only there", () => {
    const d = weekdayDraft();
    const b = published(d, "full");
    const items = b.items as Record<string, unknown>[];
    const w = { correction_id: "C-0001", since: "2026-10-14" };
    items[0] = { ...items[0], ai_role: "unassessed", severity: null, withheld: w };
    items[1] = { ...items[1], ai_role: "none", severity: null, withheld: w };
    items[2] = { ...items[2], ai_role: "unassessed", severity: null };
    expect(only(checkPublished(b), "SEVERITY_NULL_FOR_NONTHREAT").map((x) => x.path)).toEqual(["items[1].severity", "items[2].severity"]);
  });

  it("does not run on a data-only edition, whose flaw items have no severity", () => {
    const d = weekdayDraft();
    const b = published(d, "data_only");
    b.items = [{ ...d.items[0], ai_role: "unassessed", severity: null }];
    expect(codes(checkPublished(b))).toEqual([]);
  });
});

describe("SEVERITY_KIND", () => {
  it("fails an exploited flaw below high and a critical flaw above elevated", () => {
    const a = weekdayDraft();
    item(a, I.criticalExploited).severity = "watch";
    expect(only(check(a), "SEVERITY_KIND")[0]!.message).toContain('this one is "watch"');
    const b = weekdayDraft();
    item(b, I.taiwanVendor).severity = "high";
    expect(only(check(b), "SEVERITY_KIND")[0]!.message).toContain("elevated at most");
  });

  it("passes an exploited flaw at high and a critical flaw at elevated", () => {
    const d = weekdayDraft();
    item(d, I.criticalExploited).severity = "high";
    item(d, I.taiwanVendor).severity = "elevated";
    expect(codes(check(d))).not.toContain("SEVERITY_KIND");
  });
});

describe("TAIWAN_LENS_REQUIRED", () => {
  const lensErrors = (d: DraftBrief, name: EditionName = "weekday") => only(check(d, name), "TAIWAN_LENS_REQUIRED");

  it("fails a blank analysis, and one that cites nothing unless it is the no-news line", () => {
    const blank = weekdayDraft();
    blank.taiwan_lens.analysis = "  ";
    expect(lensErrors(blank)[0]!.message).toContain("is blank");
    const bare = weekdayDraft();
    bare.taiwan_lens.item_ids = [];
    expect(lensErrors(bare)[0]!.message).toContain("cites no item or source");
    const sourced = weekdayDraft();
    sourced.taiwan_lens.item_ids = [];
    sourced.taiwan_lens.source_ids = ["s7"];
    expect(lensErrors(sourced)).toEqual([]);
    expect(quietDraft().taiwan_lens.analysis).toBe(TAIWAN_NO_NEWS);
    expect(lensErrors(quietDraft(), "quiet")).toEqual([]);
  });

  it("fails rows that aren't exactly the six in order", () => {
    const swapped = weekdayDraft();
    const r = swapped.taiwan_lens.rows;
    [r[0], r[1]] = [r[1]!, r[0]!];
    expect(lensErrors(swapped).map((e) => e.path)).toEqual(["taiwan_lens.rows"]);
    const seven = weekdayDraft();
    seven.taiwan_lens.rows.push({ ...seven.taiwan_lens.rows[3]! });
    expect(lensErrors(seven)[0]!.message).toContain("has 7 rows");
  });

  it("fails row or Japan text with no ids, and the no-news line written as text", () => {
    const d = weekdayDraft();
    d.taiwan_lens.rows[0]!.item_ids = [];
    d.taiwan_lens.japan.item_ids = [];
    d.taiwan_lens.rows[3]!.text = NO_NEWS_ROW;
    const e = lensErrors(d);
    expect(e.map((x) => x.path)).toEqual(["taiwan_lens.rows[0].text", "taiwan_lens.rows[3].text", "taiwan_lens.japan.text"]);
    expect(e[1]!.message).toContain("set text to null instead");
  });

  it("fails an id that isn't an item in this brief, wherever the Lens cites it", () => {
    const d = weekdayDraft();
    d.taiwan_lens.item_ids.push("pol-tw-sample-unknown");
    d.taiwan_lens.rows[5]!.item_ids.push("camp-sample-unknown");
    d.taiwan_lens.japan.item_ids.push("inc-sample-unknown");
    expect(lensErrors(d).map((x) => x.path)).toEqual([
      "taiwan_lens.item_ids[3]", "taiwan_lens.rows[5].item_ids[1]", "taiwan_lens.japan.item_ids[1]",
    ]);
  });
});

describe("REGION_RAISE", () => {
  it("computes the weekday levels from the draft's items: TW elevated by the campaign, US at baseline", () => {
    const inputs = draftInputs("weekday");
    const d = weekdayDraft();
    const input: RuleInput = {
      draft: d, mode: "draft", date: inputs.context.date, fileDate: null, metrics: inputs.metrics, config: inputs.config,
      derived: derive(d, "draft", inputs.config), context: inputs.context, evidence: inputs.evidence, cveList: inputs.cveList,
      regionsBase: inputs.regionsBase, packDates: inputs.packDates, crossFile: null,
    };
    const rows = draftRegions(input)!.rows.map((r) => [r.code, r.computed_level]);
    expect(rows).toEqual([["US", "baseline"], ["EU", "baseline"], ["TW", "elevated"], ["JP", "baseline"]]);
    expect(draftFirstSeen(input, I.criticalExploited)).toBe("2026-10-14");
  });

  it("fails a region raised twice, a raise with no items, an unknown item and an item without the region", () => {
    const d = weekdayDraft();
    const raise = d.region_raises[0]!;
    d.region_raises.push({ ...raise, item_ids: [] }, { ...raise, region: "TW", item_ids: ["camp-sample-unknown", I.criticalExploited] }, { ...raise, region: "JP", item_ids: [] });
    const e = only(check(d), "REGION_RAISE");
    expect(e.map((x) => x.path)).toEqual([
      "region_raises[1].region", "region_raises[2].item_ids[0]", "region_raises[2].item_ids[1]", "region_raises[3].item_ids",
    ]);
    expect(e[0]!.message).toContain("raised twice");
  });

  it("fails a raise on a region the rules already put at critical", () => {
    const d = weekdayDraft();
    d.region_raises = [{ region: "TW", reason: "SAMPLE reason.", trigger_class: "campaign_target", item_ids: [I.chinaAxis] }];
    expect(codes(check(d))).not.toContain("REGION_RAISE");
    const critical = (i: DraftInputs) => {
      const cfg = structuredClone(i.regionsBase!.config);
      cfg.regions.rules = cfg.regions.rules.map((r) => (r.id === "campaign-target" ? { ...r, level: "critical" as const } : r));
      i.regionsBase = { ...i.regionsBase!, config: cfg };
    };
    const e = only(check(d, "weekday", critical), "REGION_RAISE");
    expect(e.map((x) => x.path)).toEqual(["region_raises[0]"]);
    expect(e[0]!.message).toContain("already critical by the rules (campaign-target)");
  });

  it("checks the citations without a regions input, and never runs in published mode", () => {
    const d = weekdayDraft();
    d.region_raises[0]!.item_ids = [I.patchBatch];
    expect(codes(check(d, "weekday", (i) => { i.regionsBase = null; }))).toEqual(["REGION_RAISE"]);
    expect(codes(checkPublished(published(d)))).toEqual([]);
  });
});

describe("STANDING_STORY_NEW_FACT", () => {
  it("fails a headline holding a match term with no standing_story, in any case, and a Han term", () => {
    const d = weekdayDraft();
    d.items[2]!.headline = "SAMPLE: salt typhoon is back in telecom networks";
    d.items[3]!.headline = "SAMPLE 海纜 repair ship delayed";
    const e = only(check(d), "STANDING_STORY_NEW_FACT");
    expect(e.map((x) => x.path)).toEqual(["items[2].standing_story", "items[3].standing_story"]);
    expect(e[0]!.message).toContain('set standing_story to "salt-typhoon"');
    expect(termIn("Saltier Typhoons", "Salt Typhoon")).toBe(false);
    expect(termIn("Salt  Typhoon's reach", "Salt Typhoon")).toBe(true);
  });

  it("passes a tagged story with any tier 1 or 2 source when last_development is null", () => {
    const d = weekdayDraft();
    d.items[2]!.standing_story = "volt-typhoon";
    expect(codes(check(d))).not.toContain("STANDING_STORY_NEW_FACT");
  });

  it("needs a tier 1 or 2 source dated after last_development, by pack date else published_at", () => {
    const d = weekdayDraft();
    d.items[2]!.standing_story = "volt-typhoon"; // cites s7 (13 Oct 16:00 Taipei) and s8 (pack: 13 Oct 19:20 Taipei)
    const last = (date: string) => (i: DraftInputs) => {
      i.context.standing_stories.find((s) => s.id === "volt-typhoon")!.last_development = date;
    };
    expect(codes(check(d, "weekday", last("2026-10-12")))).not.toContain("STANDING_STORY_NEW_FACT");
    expect(codes(check(d, "weekday", last("2026-10-13")))).not.toContain("STANDING_STORY_NEW_FACT"); // both after 04:30 on the 13th
    expect(only(check(d, "weekday", last("2026-10-14")), "STANDING_STORY_NEW_FACT")[0]!.message).toContain("last developed on 2026-10-14");
    const later = (i: DraftInputs) => {
      last("2026-10-14")(i);
      i.packDates![normalizeUrl(d.sources[7]!.url)] = "2026-10-13T21:00:00Z"; // 05:00 Taipei on the 14th, after that window
    };
    expect(codes(check(d, "weekday", later))).not.toContain("STANDING_STORY_NEW_FACT");
  });

  it("fails a repeat of an item from the last 14 days unless a newer source not cited then backs it", () => {
    const d = weekdayDraft();
    const it_ = item(d, I.landmark); // cites s16 (13 Oct, a date) and s17 (14 Oct 02:00 Taipei)
    const urls = (ids: string[]) => ids.map((id) => d.sources.find((s) => s.id === id)!.url);
    const repeat = (date: string, cited: string[]) => (i: DraftInputs) => {
      i.context.recent_items.push({ date, id: it_.id, kind: "policy", headline: it_.headline, severity: null, source_urls: urls(cited) });
    };
    expect(only(check(d, "weekday", repeat("2026-10-13", ["s16", "s17"])), "STANDING_STORY_NEW_FACT")[0]!.message)
      .toContain("already ran on 2026-10-13");
    expect(codes(check(d, "weekday", repeat("2026-10-13", ["s16"])))).not.toContain("STANDING_STORY_NEW_FACT");
    expect(codes(check(d, "weekday", repeat("2026-10-12", ["s17"])))).not.toContain("STANDING_STORY_NEW_FACT"); // s16 is dated 13 Oct
    expect(codes(check(d, "weekday", repeat("2026-10-14", ["s16", "s17"])))).not.toContain("STANDING_STORY_NEW_FACT"); // not earlier
  });

  it("dates a timestamp against the earlier edition's window end, and a bare date by the day", () => {
    expect(datedAfter("2026-10-13T04:29:00+08:00", "2026-10-13", "04:30")).toBe(false);
    expect(datedAfter("2026-10-13T04:31:00+08:00", "2026-10-13", "04:30")).toBe(true);
    expect(datedAfter("2026-10-12T20:31:00Z", "2026-10-13", "04:30")).toBe(true);
    expect(datedAfter("2026-10-13", "2026-10-13", "04:30")).toBe(false);
    expect(datedAfter("2026-10-14", "2026-10-13", "04:30")).toBe(true);
    expect(datedAfter(null, "2026-10-13", "04:30")).toBe(false);
  });
});

describe("SCOREBOARD_REF", () => {
  it("fails an Angle claim that isn't open or doesn't exist (draft)", () => {
    const d = weekdayDraft();
    d.angle.claim_id = "SB-99";
    expect(only(check(d), "SCOREBOARD_REF")[0]!.message).toContain('"SB-99" is not a claim');
    const resolved = (i: DraftInputs) => {
      i.config = { ...i.config, claims: { ...i.config.claims, claims: i.config.claims.claims.map((c) =>
        (c.id === "SB-01" ? { ...c, resolution: { status: "void" as const, date: "2026-10-01", note: "SAMPLE", source_url: null } } : c)) } };
    };
    expect(only(check(weekdayDraft(), "weekday", resolved), "SCOREBOARD_REF")[0]!.message).toContain("resolved void");
    expect(claimOpen({ resolution: null, deadline: "2026-10-13" }, "2026-10-14")).toBe(false);
    expect(claimOpen({ resolution: null, deadline: "2026-10-14" }, "2026-10-14")).toBe(true);
  });

  it("fails an entry for a script-judged or unknown claim, a tier 3 quote source, and a finder write-up not self-reported", () => {
    const d = weekdayDraft();
    const e0 = d.scoreboard_entries[0]!;
    d.sources.push({ ...d.sources[0]!, id: "s20", url: "https://example.org/sample/ct-entry", source_type: "other", title: "SAMPLE page" });
    d.scoreboard_entries.push({ ...e0, claim_id: "SB-77" }, { ...e0, quote_source_id: "s20" }, { ...e0, quote_source_id: "s14", claim_type: "independent" });
    const e = only(check(d), "SCOREBOARD_REF");
    expect(e.map((x) => x.path)).toEqual([
      "scoreboard_entries[1].claim_id", "scoreboard_entries[2].quote_source_id", "scoreboard_entries[3].claim_type",
    ]);
    const ok = weekdayDraft();
    ok.scoreboard_entries.push({ ...e0, quote_source_id: "s14", claim_type: "self_reported" });
    expect(codes(check(ok))).not.toContain("SCOREBOARD_REF");
  });

  it("fails a strongest_against claim that doesn't exist", () => {
    const d = mondayDraft();
    d.week_in_review!.strongest_against.claim_id = "SB-42";
    expect(only(check(d, "monday"), "SCOREBOARD_REF").map((x) => x.path)).toEqual(["week_in_review.strongest_against.claim_id"]);
  });

  it("in published mode checks only that claims exist, plus the quote source's tier and type", () => {
    const resolvedCfg = draftInputs("weekday").config;
    const d = weekdayDraft();
    d.angle.claim_id = "SB-02";
    d.scoreboard_entries[0]!.claim_id = "SB-01"; // judged by script: a draft-only test
    expect(codes(checkPublished(published(d)))).toEqual([]);
    expect(resolvedCfg.claims.claims.map((c) => c.id)).toEqual(["SB-01", "SB-02"]);
    const unknown = weekdayDraft();
    unknown.angle.claim_id = "SB-99";
    expect(codes(checkPublished(published(unknown)))).toEqual(["SCOREBOARD_REF"]);
    const writeup = weekdayDraft();
    writeup.scoreboard_entries[0]!.quote_source_id = "s14";
    expect(only(checkPublished(published(writeup)), "SCOREBOARD_REF").map((x) => x.path)).toEqual(["scoreboard.entries[0].claim_type"]);
  });
});

// ── The F fixtures ───────────────────────────────────────────────────────────────────────────────

describe("F fixtures (fixtures/src/invalid/meta-items.ts)", () => {
  it("are all listed in the builder", () => {
    for (const c of metaItemsCases) expect(INVALID_CASES).toContain(c);
  });

  it.each(metaItemsCases.map((c) => [c.file, c] as const))("%s fails with exactly its code under every registered rule", (_f, c) => {
    const r = validateDraft(invalidDraft(c), draftInputs(c.edition ?? "weekday"));
    expect(r.errors.length).toBeGreaterThan(0);
    expect([...new Set(r.errors.map((e) => e.code))]).toEqual([c.code]);
    expect(r.warnings).toEqual([]);
  });

  it("the written files match the builder", () => {
    for (const c of metaItemsCases) {
      const file = path.join(process.cwd(), "fixtures/drafts", c.file);
      expect(fs.existsSync(file)).toBe(true);
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(JSON.parse(JSON.stringify(invalidDraft(c))));
    }
  });
});
