// The cves, grounding and ai rule groups (SPEC §4.12): CVE_PUBLISHED, CVE_IN_SOURCE, VENDOR_CONFIRMED,
// EXPLOITED_BASIS, FLAW_EVIDENCE, LEAD_GROUNDED, GAP_MATCH, METRICS_ONLY_NUMBERS, NUMBER_FORM, AI_EVIDENCE_REQUIRED,
// AI_CONFIRMED_NONPRESS, SELF_REPORTED_WORDING, ANTHROPIC_DISCLOSURE_LINE. Each rule gets passing and failing
// cases for its sub-conditions on mutations of the fixture drafts, run with only these three groups so
// another group's rule never masks a result. GAP_MATCH and ANTHROPIC_DISCLOSURE_LINE (T codes) run on a
// Brief-shaped copy of the weekday draft. The F fixtures (fixtures/src/invalid/cves-grounding-ai.ts) are
// checked against every registered rule at the end. Sample text is invented and marked SAMPLE.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { invalidDraft } from "@/fixtures/src/build";
import { mondayDraft, quietDraft, weekdayDraft, WEEKDAY_ITEMS } from "@/fixtures/src/drafts";
import { draftInputs } from "@/fixtures/src/inputs";
import { cvesGroundingAiCases } from "@/fixtures/src/invalid/cves-grounding-ai";
import type { EditionName } from "@/fixtures/src/world";
import { kevLines } from "@/lib/metrics/headline";
import { aiRules, attributesClaim, mentionsAnthropic, anthropicReasons } from "@/lib/rules/ai";
import { cveIdsIn, cveRules, draftVendorConfirmedBy, holdsCveId, isCveRecordPage, onKevDraft } from "@/lib/rules/cves";
import { displaysFor, gapDayExample, groundingRules, metricTermsIn, valueAt } from "@/lib/rules/grounding";
import { derive } from "@/lib/rules/shared";
import type { CveRecordInfo, Rule, RuleInput, ValidationIssue } from "@/lib/rules/types";
import type { DraftBrief } from "@/lib/schema/draft-brief";
import type { DraftItem } from "@/lib/schema/item";
import type { Metrics } from "@/lib/schema/metrics";
import { publisherFor } from "@/lib/sources";
import { gluedRatios, wordRatios } from "@/lib/text";
import { normalizeUrl } from "@/lib/urls";
import { runRules, validateDraft, type DraftInputs } from "@/lib/validate";
import { KEV_ABSENCE_NOTE } from "@/lib/vocab";

const MINE: readonly Rule[] = [...cveRules, ...groundingRules, ...aiRules];
const I = WEEKDAY_ITEMS;

/** validateDraft() with only this part's rules; `tweak` may change the fresh inputs. */
function check(draft: unknown, name: EditionName = "weekday", tweak?: (i: DraftInputs) => void) {
  const inputs = draftInputs(name);
  tweak?.(inputs);
  return validateDraft(draft, { ...inputs, rules: MINE });
}

const only = (r: { errors: ValidationIssue[] }, code: string) => r.errors.filter((e) => e.code === code);
const warns = (r: { warnings: ValidationIssue[] }, code: string) => r.warnings.filter((e) => e.code === code);
const item = (d: DraftBrief, id: string): DraftItem => {
  const it = d.items.find((x) => x.id === id);
  if (!it) throw new Error(`no item ${id}`);
  return it;
};
const idx = (d: DraftBrief, id: string) => d.items.findIndex((x) => x.id === id);

/** Adds a SAMPLE source to a draft (and, unless `seen` is false, to the evidence with a seen text); returns its id. */
function addSource(d: DraftBrief, inputs: DraftInputs, url: string, opts: { type?: DraftItem["claim_type"] | string; text?: string; seen?: boolean } = {}): string {
  const id = `s${d.sources.length + 1}`;
  d.sources.push({
    id, title: "SAMPLE: added source", title_en: null, language: "en", outlet: "SAMPLE", url,
    source_type: (opts.type ?? "press") as DraftBrief["sources"][number]["source_type"], published_at: "2026-10-13T12:00:00+08:00",
  });
  if (opts.seen !== false && inputs.evidence) {
    const u = normalizeUrl(url);
    inputs.evidence.urls.push(u);
    inputs.evidence.fetched.push(u);
    inputs.evidence.texts[u] = opts.text ?? "SAMPLE page text.";
  }
  return id;
}

// ── A Brief-shaped copy for published mode ───────────────────────────────────────────────────────

interface BlockOpts {
  kev?: boolean;
  vendor_confirmed_by?: "vendor_cna" | "vendor_advisory" | "ghsa_reviewed" | null;
  family?: string | null;
}

/** A minimal frozen CVE block: only the fields these rules read are meaningful. */
function block(cve: string, o: BlockOpts = {}) {
  return {
    cve_id: cve, kev: o.kev ? { date_added: "2026-10-13", due_date: "2026-10-16", ransomware: "unknown", catalog_version: "2026.10.13" } : null,
    vendor_confirmed: Boolean(o.vendor_confirmed_by), vendor_confirmed_by: o.vendor_confirmed_by ?? null,
    cvss: null, epss: null, ai_credit: o.family ? { family: o.family } : null,
  };
}

/**
 * A Brief-shaped copy of a draft, as publish would freeze it from the fixture inputs: each source's
 * publisher and tier, each item's CVE blocks (KEV and vendor confirmation computed from the inputs), its
 * Anthropic flag, the Gap block and the Lens KEV lines from the metrics.
 */
function asBrief(d: DraftBrief, inputs: DraftInputs = draftInputs("weekday"), edition = "full"): Record<string, unknown> & { items: Record<string, unknown>[] } {
  const { region_raises: _r, scoreboard_entries: _s, ...rest } = d;
  const m = inputs.metrics!;
  const sources = d.sources.map((s) => {
    const p = publisherFor(s.url, s.source_type, inputs.config);
    return { ...s, publisher: p.publisher, publisher_name: p.publisher_name, tier: p.tier, state_label: p.state_label, seen_as: "pack" };
  });
  const derived = derive(d, "draft", inputs.config);
  const input = { ...inputs, derived } as unknown as RuleInput;
  const items = d.items.map((it) => ({
    ...it, actor_nexus: null, first_seen: d.date, vendor: null,
    cves: it.cve_ids.map((c) => block(c, { kev: onKevDraft(input, c), vendor_confirmed_by: draftVendorConfirmedBy(input, it, c) })),
    release: null, public_exploit: null, anthropic_disclosure: mentionsAnthropic(it, sources), withheld: null,
  }));
  return {
    ...rest, edition, items, sources,
    gap: { headline: m.headline.text, second_line: m.headline.second_line, status: "ok", metrics_file: `metrics/${m.date}.json`, metrics_sha256: "0".repeat(64), as_of: m.data_cutoff_utc },
    taiwan_lens: { ...d.taiwan_lens, kev_lines: kevLines(m), kev_note: KEV_ABSENCE_NOTE, watch_windows: [] },
    regions: { rows: [], global: { item_count: 0 }, signals: [] },
    scoreboard: { entries: [], last: null },
    computed: { word_count: 0 },
  };
}

/** runRules() in published mode with this part's rules. */
function checkPublished(brief: Record<string, unknown>, metrics: Metrics | null = draftInputs("weekday").metrics) {
  const config = draftInputs("weekday").config;
  const input: Omit<RuleInput, "derived"> = {
    draft: brief as never, mode: "published", date: String(brief.date), fileDate: null, metrics, config,
    context: null, evidence: null, cveList: null, regionsBase: null, packDates: null, crossFile: null,
  };
  const issues = runRules(input, [], MINE);
  return { errors: issues.filter((i) => i.severity === "error"), warnings: issues.filter((i) => i.severity === "warning") };
}

const bItem = (b: ReturnType<typeof asBrief>, id: string) => b.items.find((x) => x.id === id)!;

// ── The valid drafts ─────────────────────────────────────────────────────────────────────────────

describe("valid drafts", () => {
  it.each(["weekday", "monday", "quiet"] as const)("%s passes every rule in this part", (name) => {
    const r = check({ weekday: weekdayDraft, monday: mondayDraft, quiet: quietDraft }[name](), name);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("the weekday and Monday drafts pass in published mode too", () => {
    expect(checkPublished(asBrief(weekdayDraft()))).toEqual({ errors: [], warnings: [] });
    const monday = draftInputs("monday");
    expect(checkPublished(asBrief(mondayDraft(), monday), monday.metrics)).toEqual({ errors: [], warnings: [] });
  });
});

// ── CVE_PUBLISHED ────────────────────────────────────────────────────────────────────────────────

describe("CVE_PUBLISHED", () => {
  it("reads CVE ids in any case, upper-cases them and never takes a prefix of a longer id", () => {
    expect(cveIdsIn("cve-2026-104935 and CVE-2026-104935, then CVE-2026-96951.")).toEqual(["CVE-2026-104935", "CVE-2026-96951"]);
    expect(holdsCveId("see CVE-2026-1049351", "CVE-2026-104935")).toBe(false);
    expect(holdsCveId("https://example.org/ct-sample/cve-2026-104935-notes", "CVE-2026-104935")).toBe(true);
  });

  it("fails an unknown id in cve_ids, and a REJECTED or RESERVED one", () => {
    const d = weekdayDraft();
    item(d, I.criticalExploited).cve_ids.push("CVE-2026-9999999");
    expect(only(check(d), "CVE_PUBLISHED").map((e) => e.path)).toEqual([`items[${idx(d, I.criticalExploited)}].cve_ids[1]`]);

    for (const state of ["REJECTED", "RESERVED"] as const) {
      const r = check(weekdayDraft(), "weekday", (inputs) => {
        const real = inputs.cveList!;
        inputs.cveList = { get: (id) => (id.toUpperCase() === "CVE-2026-110036" ? { ...(real.get(id) as CveRecordInfo), state } : real.get(id)) };
      });
      expect(only(r, "CVE_PUBLISHED")).toHaveLength(1);
      expect(only(r, "CVE_PUBLISHED")[0]!.message).toContain(`is ${state} in the CVE List`);
    }
  });

  it("fails an id in an item's text that isn't in its cve_ids", () => {
    const d = weekdayDraft();
    item(d, I.criticalExploited).why_it_matters = "Connect Secure gateways sit on the edge of many networks, much like the Windows flaw CVE-2026-96951.";
    const r = only(check(d), "CVE_PUBLISHED");
    expect(r.map((e) => e.path)).toEqual([`items[${idx(d, I.criticalExploited)}].why_it_matters`]);
    expect(r[0]!.message).toContain("not in items[0].cve_ids (CVE-2026-104935)");
  });

  it("fails a Lead, Angle or Lens id that none of the items it cites carries", () => {
    const d = weekdayDraft();
    d.lead[0]!.text = "Ivanti fixed CVE-2026-104935 and Microsoft fixed CVE-2026-96951, and CISA listed both as exploited on 13 October.";
    expect(only(check(d), "CVE_PUBLISHED")).toEqual([]);
    d.lead[2]!.text = "TeamT5 says a China-nexus group phished Taiwanese chip equipment makers, as attackers used CVE-2026-104935.";
    expect(only(check(d), "CVE_PUBLISHED").map((e) => e.path)).toEqual(["lead[2].text"]);

    const a = weekdayDraft();
    a.angle.counterpoint = "Red Hat rated none of them critical; CVE-2026-110036, the newest, needs a user to open a crafted file.";
    expect(only(check(a), "CVE_PUBLISHED")).toEqual([]); // the AISLE item shares the Angle's source
    a.angle.counterpoint = "Red Hat rated none of them critical, unlike CVE-2026-104935.";
    expect(only(check(a), "CVE_PUBLISHED").map((e) => e.path)).toEqual(["angle.counterpoint"]);

    const l = weekdayDraft();
    const home = l.taiwan_lens.rows.findIndex((r) => r.row === "home_vendors");
    l.taiwan_lens.rows[home]!.text = "Details of CVE-2026-108917, an unfixed Edimax router flaw, are public.";
    expect(only(check(l), "CVE_PUBLISHED")).toEqual([]);
    l.taiwan_lens.japan.text = "A Japanese logistics company is named in a claim; CVE-2026-108917 is unrelated.";
    expect(only(check(l), "CVE_PUBLISHED").map((e) => e.path)).toEqual(["taiwan_lens.japan.text"]);
  });

  it("checks other fields against the CVE List only, and skips the state test without a CVE List", () => {
    const d = weekdayDraft();
    d.scoreboard_entries[0]!.summary = "SAMPLE. The NCSC's review mentions CVE-2026-9999999 and reports no confirmed AI-powered malware.";
    expect(only(check(d), "CVE_PUBLISHED").map((e) => e.path)).toEqual(["scoreboard_entries[0].summary"]);
    const skipped = check(d, "weekday", (i) => { i.cveList = null; });
    expect(only(skipped, "CVE_PUBLISHED")).toEqual([]);
    // ...and says so once, as SOURCE_UNSEEN does without evidence, so a caller that forgot the List is told.
    expect(warns(skipped, "CVE_PUBLISHED").map((w) => w.path)).toEqual(["(cveList)"]);
    expect(warns(check(d), "CVE_PUBLISHED")).toEqual([]);
  });

  it("in published mode reads the stored CVE blocks, and runs on a data-only edition (†)", () => {
    const b = asBrief(weekdayDraft());
    expect(only(checkPublished(b), "CVE_PUBLISHED")).toEqual([]);
    const top = bItem(b, I.criticalExploited);
    top.cves = [];
    expect(only(checkPublished(b), "CVE_PUBLISHED").map((e) => e.path)).toEqual(["items[0].cve_ids[0]"]);
    const dataOnly = asBrief(weekdayDraft(), draftInputs("weekday"), "data_only");
    bItem(dataOnly, I.criticalExploited).cves = [];
    expect(only(checkPublished(dataOnly), "CVE_PUBLISHED")).toHaveLength(1);
  });

  it("in published mode needs exactly one CVE block per cve_ids entry, in the same order (§4.6)", () => {
    const base = asBrief(weekdayDraft());
    const other = base.items.find((x) => x.id !== I.criticalExploited && (x.cves as unknown[] | undefined)?.length)!;
    const two = (order: (a: unknown, b: unknown) => unknown[]) => {
      const b = asBrief(weekdayDraft());
      const top = bItem(b, I.criticalExploited);
      const [a] = top.cves as Record<string, unknown>[];
      const o = (bItem(b, other.id as string).cves as Record<string, unknown>[])[0]!;
      top.cve_ids = [a!.cve_id, o.cve_id];
      top.cves = order(a, o);
      return only(checkPublished(b), "CVE_PUBLISHED").map((e) => e.path);
    };
    expect(two((a, o) => [a, o])).toEqual([]);
    expect(two((a, o) => [o, a])).toEqual(["items[0].cve_ids[0]", "items[0].cve_ids[1]"]);
    expect(two((a) => [a, a])).toEqual(["items[0].cve_ids[1]"]);
    expect(two((a, o) => [a, o, a])).toEqual(["items[0].cves[2]"]);
    expect(two((a) => [a])).toEqual(["items[0].cve_ids[1]"]);
  });
});

// ── CVE_IN_SOURCE ────────────────────────────────────────────────────────────────────────────────

describe("CVE_IN_SOURCE", () => {
  const aisle = (d: DraftBrief) => {
    item(d, I.aiConfirmed).summary = "Red Hat rated none of them critical; the newest, CVE-2026-110036, a local crash bug scored 3.3, was published on 13 October.";
    return `items[${idx(d, I.aiConfirmed)}].summary`;
  };

  it("knows the CVE record pages", () => {
    expect(isCveRecordPage("https://www.cve.org/CVERecord?id=CVE-2026-104935")).toBe(true);
    expect(isCveRecordPage("https://nvd.nist.gov/vuln/detail/CVE-2026-104935")).toBe(true);
    expect(isCveRecordPage("https://github.com/CVEProject/cvelistV5/blob/main/cves/2026/104xxx/CVE-2026-104935.json")).toBe(true);
    expect(isCveRecordPage("https://github.com/advisories/GHSA-c2c2-c2c2-c2c2")).toBe(false);
    expect(isCveRecordPage("https://www.ivanti.com/ct-sample/cve-2026-104935")).toBe(false);
  });

  it("fails an id that only the CVE record names", () => {
    const d = weekdayDraft();
    const p = aisle(d);
    expect(only(check(d), "CVE_IN_SOURCE").map((e) => e.path)).toEqual([p]);
  });

  it("passes on a cited URL or the seen text of a non-record source", () => {
    // The Ivanti advisory's URL names CVE-2026-104935 even when no page text does.
    const r = check(weekdayDraft(), "weekday", (inputs) => {
      for (const k of Object.keys(inputs.evidence!.texts)) if (!k.includes("cve.org")) inputs.evidence!.texts[k] = "SAMPLE text.";
    });
    // Only the patch batch fails: its sources' URLs don't name CVE-2026-96951, and their texts no longer do.
    expect(only(r, "CVE_IN_SOURCE").map((e) => e.path)).toEqual(["items[1].summary"]);
    // The Register's text, once it names the CVE.
    const d = weekdayDraft();
    aisle(d);
    const ok = check(d, "weekday", (inputs) => {
      const u = normalizeUrl(d.sources.find((s) => s.outlet === "The Register")!.url);
      inputs.evidence!.texts[u] += " The newest is CVE-2026-110036.";
    });
    expect(only(ok, "CVE_IN_SOURCE")).toEqual([]);
  });

  it("warns instead when no non-record source has seen text, and once when there is no evidence", () => {
    const d = weekdayDraft();
    const p = aisle(d);
    const r = check(d, "weekday", (inputs) => {
      delete inputs.evidence!.texts[normalizeUrl(d.sources.find((s) => s.outlet === "The Register")!.url)];
    });
    expect(only(r, "CVE_IN_SOURCE")).toEqual([]);
    expect(warns(r, "CVE_IN_SOURCE").map((w) => w.path)).toEqual([p]);
    const none = check(d, "weekday", (inputs) => { inputs.evidence = null; });
    expect(warns(none, "CVE_IN_SOURCE").map((w) => w.path)).toEqual(["(evidence)"]);
  });

  it("never runs in published mode", () => {
    const d = weekdayDraft();
    aisle(d);
    expect(only(checkPublished(asBrief(d)), "CVE_IN_SOURCE")).toEqual([]);
  });
});

// ── VENDOR_CONFIRMED ─────────────────────────────────────────────────────────────────────────────

describe("VENDOR_CONFIRMED", () => {
  const elevated = () => {
    const d = weekdayDraft();
    item(d, I.taiwanVendor).severity = "elevated";
    return d;
  };
  const path = (d: DraftBrief) => `items[${idx(d, I.taiwanVendor)}].severity`;

  it("passes an unconfirmed critical flaw at watch and fails it above", () => {
    expect(only(check(weekdayDraft()), "VENDOR_CONFIRMED")).toEqual([]);
    const d = elevated();
    const r = only(check(d), "VENDOR_CONFIRMED");
    expect(r.map((e) => e.path)).toEqual([path(d)]);
    expect(r[0]!.message).toContain('the assigner "VulDB" is not in its cna list');
  });

  it("takes the vendor's CNA, a checked advisory on its domain, or a GitHub-reviewed advisory", () => {
    const cna = check(elevated(), "weekday", (inputs) => {
      inputs.config = { ...inputs.config, vendors: { ...inputs.config.vendors, vendors: inputs.config.vendors.vendors.map((v) => (v.id === "edimax" ? { ...v, cna: ["VulDB"] } : v)) } };
    });
    expect(only(cna, "VENDOR_CONFIRMED")).toEqual([]);

    const inputs = draftInputs("weekday");
    const d = elevated();
    const it = item(d, I.taiwanVendor);
    const s = addSource(d, inputs, "https://www.edimax.com/ct-sample/br-6208ac-end-of-life-notice", { type: "vendor_advisory" });
    it.source_ids.push(s);
    it.flaw_evidence.push({ cve_id: "CVE-2026-108917", kind: "patched", basis: "vendor_advisory", date: "2026-10-13", source_id: s });
    expect(only(validateDraft(d, { ...inputs, rules: MINE }), "VENDOR_CONFIRMED")).toEqual([]);
    // Not in the evidence set: not a checked entry.
    const unseen = draftInputs("weekday");
    expect(only(validateDraft(d, { ...unseen, rules: MINE }), "VENDOR_CONFIRMED")).toHaveLength(1);

    const g = elevated();
    const ghsa = addSource(g, inputs, "https://github.com/advisories/GHSA-c2c2-c2c2-c2c2", { type: "cve_record" });
    item(g, I.taiwanVendor).source_ids.push(ghsa);
    expect(only(validateDraft(g, { ...inputs, rules: MINE }), "VENDOR_CONFIRMED")).toEqual([]);
  });

  it("fails a critical flaw with no CVE id above watch, and skips a null severity", () => {
    const d = elevated();
    item(d, I.taiwanVendor).cve_ids = [];
    expect(only(check(d), "VENDOR_CONFIRMED")[0]!.message).toContain("has no CVE id");
    const n = weekdayDraft();
    item(n, I.taiwanVendor).severity = null;
    expect(only(check(n), "VENDOR_CONFIRMED")).toEqual([]);
  });

  it("in published mode reads the stored vendor_confirmed_by of the first CVE block", () => {
    const b = asBrief(elevated());
    expect(only(checkPublished(b), "VENDOR_CONFIRMED")).toHaveLength(1);
    bItem(b, I.taiwanVendor).cves = [block("CVE-2026-108917", { vendor_confirmed_by: "vendor_cna" })];
    expect(only(checkPublished(b), "VENDOR_CONFIRMED")).toEqual([]);
  });
});

// ── EXPLOITED_BASIS ──────────────────────────────────────────────────────────────────────────────

describe("EXPLOITED_BASIS", () => {
  it("passes an exploited flaw on KEV with no flaw evidence", () => {
    const d = weekdayDraft();
    item(d, I.criticalExploited).flaw_evidence = [];
    expect(only(check(d), "EXPLOITED_BASIS")).toEqual([]);
  });

  it("reads KEV from the index rows, the record's KEV marker or the candidate", () => {
    const inputs = draftInputs("weekday");
    const input = { ...inputs, derived: derive(weekdayDraft(), "draft", inputs.config) } as unknown as RuleInput;
    expect(onKevDraft(input, "CVE-2026-96951")).toBe(true);
    expect(onKevDraft({ ...input, regionsBase: null }, "CVE-2026-96951")).toBe(true); // the candidate's kev
    expect(onKevDraft({ ...input, regionsBase: null, context: null }, "CVE-2026-104935")).toBe(true); // the record's ADP marker
    expect(onKevDraft({ ...input, regionsBase: null, context: null }, "CVE-2026-96951")).toBe(false);
    expect(onKevDraft(input, "CVE-2026-108917")).toBe(false);
  });

  /** The Edimax flaw as an exploited flaw (not on KEV), with the given evidence. */
  function exploited(evidence: DraftItem["flaw_evidence"]) {
    const d = invalidDraft(cvesGroundingAiCases.find((c) => c.code === "EXPLOITED_BASIS")!) as DraftBrief;
    item(d, I.taiwanVendor).flaw_evidence = evidence;
    return d;
  }

  it("needs a vendor or CERT statement when the CVE is not on KEV; news is not enough", () => {
    const news = only(check(exploited([{ cve_id: "CVE-2026-108917", kind: "exploited", basis: "news_reported", date: "2026-10-13", source_id: "s10" }])), "EXPLOITED_BASIS");
    expect(news).toHaveLength(1);
    expect(news[0]!.message).toContain("news_reported is not enough");
    const cert = exploited([{ cve_id: "CVE-2026-108917", kind: "exploited", basis: "cert_confirmed", date: "2026-10-13", source_id: "s10" }]);
    expect(only(check(cert), "EXPLOITED_BASIS")).toEqual([]);
  });

  it("in published mode reads the CVE blocks' kev", () => {
    const d = weekdayDraft();
    item(d, I.criticalExploited).flaw_evidence = [];
    const b = asBrief(d);
    expect(only(checkPublished(b), "EXPLOITED_BASIS")).toEqual([]);
    bItem(b, I.criticalExploited).cves = [block("CVE-2026-104935")];
    expect(only(checkPublished(b), "EXPLOITED_BASIS").map((e) => e.path)).toEqual(["items[0].flaw_evidence"]);
  });
});

// ── FLAW_EVIDENCE ────────────────────────────────────────────────────────────────────────────────

describe("FLAW_EVIDENCE", () => {
  const top = (d: DraftBrief) => item(d, I.criticalExploited);

  it("fails a CVE outside cve_ids and a basis that doesn't fit the kind", () => {
    const d = weekdayDraft();
    top(d).flaw_evidence[0]!.cve_id = "CVE-2026-96951";
    top(d).flaw_evidence[1]!.kind = "exploited";
    top(d).flaw_evidence[1]!.basis = "vendor_advisory";
    expect(only(check(d), "FLAW_EVIDENCE").map((e) => e.path)).toEqual(["items[0].flaw_evidence[0].cve_id", "items[0].flaw_evidence[1].basis"]);
  });

  it("checks the source against the basis: vendor domain, CERT, tier 2 newsroom", () => {
    const fit = (basis: "vendor_confirmed" | "cert_confirmed" | "news_reported", source: string, extra?: (d: DraftBrief) => void) => {
      const d = weekdayDraft();
      extra?.(d);
      top(d).flaw_evidence[0] = { cve_id: "CVE-2026-104935", kind: "exploited", basis, date: "2026-10-13", source_id: source };
      return only(check(d), "FLAW_EVIDENCE").map((e) => e.path);
    };
    expect(fit("vendor_confirmed", "s2")).toEqual([]); // ivanti.com
    expect(fit("vendor_confirmed", "s3")).toEqual(["items[0].flaw_evidence[0].source_id"]); // BleepingComputer
    expect(fit("news_reported", "s3")).toEqual([]);
    expect(fit("news_reported", "s2")).toEqual(["items[0].flaw_evidence[0].source_id"]);
    expect(fit("cert_confirmed", "s3")).toEqual(["items[0].flaw_evidence[0].source_id"]);
    expect(fit("cert_confirmed", "s18", (d) => top(d).source_ids.push("s18"))).toEqual([]); // NCSC, a CERT
  });

  it("takes CISA, the US national CERT, for cert_confirmed (Kobol dry run, 2026-11-11), but no other government body", () => {
    const fit = (url: string) => {
      const d = weekdayDraft();
      const inputs = draftInputs("weekday");
      const sid = addSource(d, inputs, url, { type: "government" });
      top(d).source_ids.push(sid);
      top(d).flaw_evidence[0] = { cve_id: "CVE-2026-104935", kind: "exploited", basis: "cert_confirmed", date: "2026-10-13", source_id: sid };
      return only(validateDraft(d, { ...inputs, rules: MINE }), "FLAW_EVIDENCE").map((e) => e.message);
    };
    expect(fit("https://www.cisa.gov/ct-sample/news-events/alerts/cisa-adds-two-known-exploited-vulnerabilities")).toEqual([]);
    expect(fit("https://www.cisa.gov/known-exploited-vulnerabilities-catalog")).toEqual([]); // cisa-kev
    const fbi = fit("https://www.fbi.gov/ct-sample/news/flash-alert");
    expect(fbi).toHaveLength(1);
    expect(fbi[0]).toContain('basis "cert_confirmed" needs a national CERT\'s page, but s20 is published by FBI (kind government)');
    const cfg = draftInputs("weekday").config;
    expect(cfg.sourceTiers.publishers.filter((p) => p.national_cert).map((p) => p.id)).toEqual(["cisa-kev", "cisa"]);
  });

  it("fails a vendor statement for a CVE no vendor matches", () => {
    const d = weekdayDraft();
    const r = check(d, "weekday", (inputs) => {
      inputs.config = { ...inputs.config, vendors: { ...inputs.config.vendors, vendors: inputs.config.vendors.vendors.filter((v) => v.id !== "ivanti") } };
    });
    expect(only(r, "FLAW_EVIDENCE")[0]!.message).toContain("no vendor in vendors.json matches CVE-2026-104935");
  });

  it("leaves a source missing from source_ids to SOURCE_REF", () => {
    const d = weekdayDraft();
    top(d).flaw_evidence[0]!.source_id = "s18";
    expect(only(check(d), "FLAW_EVIDENCE")).toEqual([]);
  });

  it("fails a source outside the evidence set, and skips that test without evidence", () => {
    const d = weekdayDraft();
    const url = normalizeUrl(d.sources[1]!.url);
    const r = check(d, "weekday", (inputs) => { inputs.evidence!.urls = inputs.evidence!.urls.filter((u) => u !== url); });
    expect(only(r, "FLAW_EVIDENCE").map((e) => e.path)).toEqual(["items[0].flaw_evidence[0].source_id", "items[0].flaw_evidence[1].source_id"]);
    expect(only(check(d, "weekday", (inputs) => { inputs.evidence = null; }), "FLAW_EVIDENCE")).toEqual([]);
  });

  it("in published mode checks the CVE and the basis, never the source fit", () => {
    const d = weekdayDraft();
    top(d).flaw_evidence[0]!.source_id = "s3";
    expect(only(checkPublished(asBrief(d)), "FLAW_EVIDENCE")).toEqual([]);
    top(d).flaw_evidence[1]!.basis = "news_reported";
    expect(only(checkPublished(asBrief(d)), "FLAW_EVIDENCE").map((e) => e.path)).toEqual(["items[0].flaw_evidence[1].basis"]);
  });
});

// ── LEAD_GROUNDED ────────────────────────────────────────────────────────────────────────────────

describe("LEAD_GROUNDED", () => {
  const lead = (text: string, item_ids: string[], gap = false) => {
    const d = weekdayDraft();
    d.lead[0] = { text, item_ids, gap };
    return only(check(d), "LEAD_GROUNDED");
  };

  it("fails an id that isn't an item, and a sentence with no item that isn't a Gap sentence", () => {
    expect(lead("Ivanti fixed a flaw that attackers were already using.", [I.criticalExploited, "pt-microsoft-2026-11"]).map((e) => e.path))
      .toEqual(["lead[0].item_ids[1]"]);
    expect(lead("Attackers were busy.", []).map((e) => e.path)).toEqual(["lead[0].item_ids"]);
  });

  it("lets a Gap sentence quote only headline.quoted numbers", () => {
    expect(lead("157 recently disclosed flaws reached CISA's exploited list in 26 weeks.", [], true)).toEqual([]);
    expect(lead("38% of recently disclosed flaws were exploited when disclosed.", [], true)).toHaveLength(1);
    // 179 is a metric (the data table) but not a headline number.
    expect(lead("CISA added 179 flaws in 26 weeks.", [], true)).toHaveLength(1);
    expect(lead("Ivanti's flaw is one of 179 KEV additions in 26 weeks.", [I.criticalExploited])).toEqual([]);
  });

  it("tells a Gap sentence that names the day as a length of hours to name it by its dates (review of row 145)", () => {
    const DAY = ' When a Gap sentence names the day, it names it by its dates ("13 to 14 Oct"), never as a length of hours.';
    for (const text of ["Nothing in the 24 hours to 04:30 Taipei cleared the bar for an item.", "Nothing in the 24-hour window cleared the bar.",
      "Nothing in the last 24 hrs cleared the bar."]) {
      const r = lead(text, [], true);
      expect(r.map((e) => e.message), text).toEqual([expect.stringContaining("holds 24, which is not one of the Gap's quoted numbers")]);
      expect(r[0]!.hint, text).toBe(`Copy the number exactly as metrics.quotable shows it, or set gap: false and cite the item it comes from.${DAY}`);
    }
    // Named by its dates, the day holds no number, whether or not its days are quoted numbers (these metrics quote 13,
    // the 13 weeks, but not 2, 3, 10 or 11); any other stray number keeps the plain hint.
    for (const text of ["Nothing published between 13 and 14 Oct cleared the bar for an item.",
      "Nothing published from 10 to 11 Nov cleared the bar for an item.", "Nothing published between 2 and 3 Nov cleared the bar for an item.",
      "Nothing published from Oct 30 to Nov 2 cleared the bar for an item.", "Nothing published 10–11 Nov cleared the bar for an item.",
      "Nothing published Nov 10 to 11 cleared the bar for an item."]) expect(lead(text, [], true), text).toEqual([]);
    expect(lead("38% of recently disclosed flaws were exploited when disclosed, in 24 hours.", [], true).map((e) => e.hint)).toEqual([
      "Copy the number exactly as metrics.quotable shows it, or set gap: false and cite the item it comes from.", expect.stringContaining(DAY)]);
  });

  it("names the edition's own day in the hints, and offers gap: false only when there is an item to cite (review of the seventh pass)", () => {
    expect(gapDayExample("2026-11-12")).toBe("11 to 12 Nov");
    expect(gapDayExample("2026-10-11")).toBe("10 to 11 Oct");
    expect(gapDayExample("2026-11-01")).toBe("31 Oct to 1 Nov");
    expect(gapDayExample("2027-01-01")).toBe("31 Dec to 1 Jan");
    expect(gapDayExample("")).toBeNull();
    // The quiet edition (2026-10-11) has no items, so there is none to cite.
    const quiet = (text: string) => {
      const d = quietDraft();
      d.lead[0] = { text, item_ids: [], gap: true };
      return only(check(d, "quiet"), "LEAD_GROUNDED");
    };
    expect(quiet("Nothing in the 24 hours to 04:30 Taipei cleared the bar for an item.").map((e) => e.hint)).toEqual([
      'Copy the number exactly as metrics.quotable shows it, or remove it. When a Gap sentence names the day, it names it by its dates ("10 to 11 Oct"), never as a length of hours.']);
    // A stray day before a month or weekday name: the third day of a list is no range.
    expect(quiet("Nothing published on 8, 9 or 10 Oct cleared the bar for an item.").map((e) => [e.message, e.hint])).toEqual([[
      expect.stringContaining("holds 8, which is not one of the Gap's quoted numbers"),
      'Copy the number exactly as metrics.quotable shows it, or remove it. A day number is read as a number unless written as a date or a date range like "10 to 11 Oct".']]);
    expect(quiet("Nothing published from Friday 9 to Saturday 10 Oct cleared the bar for an item.")).toEqual([]);
    // No month or weekday name after it: no day hint.
    expect(quiet("Nothing cleared the bar, 3 days running.").map((e) => e.hint)).toEqual(["Copy the number exactly as metrics.quotable shows it, or remove it."]);
    // The weekday edition (2026-10-14) has items, so gap: false and an item stay on offer; a non-Gap sentence gets the day hint too.
    expect(lead("Nothing published on 8, 9 or 10 Oct cleared the bar.", [], true).map((e) => e.hint)).toEqual([
      'Copy the number exactly as metrics.quotable shows it, or set gap: false and cite the item it comes from. A day number is read as a number unless written as a date or a date range like "13 to 14 Oct".']);
    expect(lead("Ivanti's fix shipped on 8, 9 or 10 Oct.", [I.criticalExploited]).map((e) => e.hint)).toEqual([
      'Use the number as the item states it, cite the item that gives it, or copy a metric exactly as metrics.quotable shows it. A day number is read as a number unless written as a date or a date range like "13 to 14 Oct".']);
  });

  it("matches other numbers against the cited items' text and CVE blocks, rounding as written", () => {
    expect(lead("Shadowserver counts about 9,000 unpatched Ivanti gateways.", [I.criticalExploited])).toEqual([]);
    expect(lead("Microsoft fixed about 1,400 flaws.", [I.patchBatch])).toEqual([]);
    expect(lead("Microsoft fixed 1,400 flaws.", [I.patchBatch])).toHaveLength(1);
    expect(lead("Ivanti's flaw scores 8.6.", [I.criticalExploited])).toEqual([]); // the CVE block's CVSS
    expect(lead("Ivanti's flaw scores 8.7.", [I.criticalExploited])).toHaveLength(1);
    expect(lead("The batch holds 60 critical fixes.", [I.criticalExploited])).toHaveLength(1); // not that item's number
  });

  it("needs every known name in the cited items, through any alias", () => {
    expect(lead("Pulse Secure gateways were exploited before a fix.", [I.criticalExploited])).toEqual([]); // an Ivanti alias
    const r = lead("Ivanti and Edimax shipped flaws attackers are using.", [I.criticalExploited]);
    expect(r).toHaveLength(1);
    expect(r[0]!.message).toContain("names Edimax");
    expect(lead("NightCrane hit Ivanti gateways.", [I.criticalExploited])).toHaveLength(1); // an item's own name
  });

  it("fails a known name in a sentence with no item, unless the Gap itself names it", () => {
    expect(lead("Microsoft-found flaws: 502 in 13 weeks.", [], true)).toHaveLength(1);
    expect(lead("AI-credited flaws: 502 in 13 weeks, 224 excluding Anthropic.", [], true)).toEqual([]);
  });

  it("in published mode uses only the items' own names", () => {
    const d = weekdayDraft();
    d.lead[0] = { text: "Ivanti and Edimax shipped flaws attackers are using.", item_ids: [I.criticalExploited], gap: false };
    expect(only(checkPublished(asBrief(d)), "LEAD_GROUNDED")).toEqual([]);
    d.lead[0] = { text: "NightCrane hit Ivanti gateways.", item_ids: [I.criticalExploited], gap: false };
    expect(only(checkPublished(asBrief(d)), "LEAD_GROUNDED")).toHaveLength(1);
  });

  it("checks the Angle's number against its metric_path as the Gap shows it", () => {
    const monday = () => mondayDraft();
    expect(only(check(monday(), "monday"), "LEAD_GROUNDED")).toEqual([]);
    const wrong = monday();
    wrong.angle.text = "Flaws not exploited at disclosure reached CISA's list a median 18 days after it.";
    expect(only(check(wrong, "monday"), "LEAD_GROUNDED").map((e) => e.path)).toEqual(["angle.text"]);
    const missing = monday();
    missing.angle.metric_path = "window.w26.no_such_value";
    expect(only(check(missing, "monday"), "LEAD_GROUNDED").map((e) => e.path)).toEqual(["angle.metric_path"]);
  });

  it("lets a metric Angle print its label's figures, and no other number (row 145)", () => {
    const d = mondayDraft(); // metric_path window.w26.after_disclosure_median_days, display 17
    d.angle.text = "Over the last 26 weeks, flaws not exploited at disclosure reached CISA's list a median 17 days after it.";
    expect(only(check(d, "monday"), "LEAD_GROUNDED")).toEqual([]);
    d.angle.text = "Over the last 13 weeks, flaws not exploited at disclosure reached CISA's list a median 17 days after it.";
    const r = only(check(d, "monday"), "LEAD_GROUNDED");
    expect(r.map((e) => e.path)).toEqual(["angle.text"]);
    expect(r[0]!.message).toContain("holds 13");
    expect(r[0]!.hint).toBe("Write the number exactly as metrics.quotable shows it for that path, or fix metric_path. "
      + "The figures its label prints (26 weeks) may stand beside it as the label writes them, each at most once; no other number may.");
    // The windowed ratios' labels name their window ("new CVE records, pace vs 2023–24, 13 weeks").
    d.angle.metric_path = "flood.vs_reference_ratio";
    d.angle.text = "Over 13 weeks, new CVE records arrived at 5.2 times the 2023–24 pace.";
    expect(only(check(d, "monday"), "LEAD_GROUNDED")).toEqual([]);
    d.angle.text = "Over 26 weeks, new CVE records arrived at 5.2 times the 2023–24 pace.";
    expect(only(check(d, "monday"), "LEAD_GROUNDED").map((e) => e.message)).toEqual([expect.stringContaining("holds 26")]);
    d.angle.metric_path = "window.kev_pace_ratio";
    d.angle.text = "Over the 26-week Window, CISA's KEV additions ran at 1.9 times the 2023–24 pace.";
    expect(only(check(d, "monday"), "LEAD_GROUNDED")).toEqual([]);
    // A label's range and interval: "n-day race (listed 2 to 30 days after), 26 weeks", "80% interval low, at disclosure, 26 weeks".
    d.angle.metric_path = "window.w26.n_day_n";
    d.angle.text = "In the 26 weeks to 6 Nov, CISA listed 62 recently disclosed flaws 2 to 30 days after disclosure.";
    expect(only(check(d, "monday"), "LEAD_GROUNDED")).toEqual([]);
    d.angle.metric_path = "window.w26.at_disclosure_ci80.0";
    d.angle.text = "The 80% interval for the 26-week share exploited at disclosure starts at 32%.";
    expect(only(check(d, "monday"), "LEAD_GROUNDED")).toEqual([]);
  });

  it("a key names one row: another row's number under a path fails (row 145)", () => {
    const d = mondayDraft();
    // 37 is "listed 31 to 365 days after" (window.w26.late_listed_n), not the cohort (157).
    d.angle.metric_path = "window.w26.cohort_n";
    d.angle.text = "CISA listed 37 recently disclosed flaws in 26 weeks.";
    expect(only(check(d, "monday"), "LEAD_GROUNDED").map((e) => e.message)).toEqual([expect.stringContaining("holds 37")]);
    d.angle.metric_path = "window.w26.late_listed_n";
    d.angle.text = "In the 26 weeks to 6 Nov, CISA listed 37 recently disclosed flaws 31 to 365 days after disclosure.";
    expect(only(check(d, "monday"), "LEAD_GROUNDED")).toEqual([]);
    // 39% is the n-day share (window.w26.n_day_share), not the n-day count (62).
    d.angle.metric_path = "window.w26.n_day_n";
    d.angle.text = "In 26 weeks, 39% of recently disclosed flaws on CISA's list were in the n-day race.";
    expect(only(check(d, "monday"), "LEAD_GROUNDED").map((e) => e.message)).toEqual([expect.stringContaining("holds 39%")]);
    d.angle.metric_path = "window.w26.n_day_share";
    expect(only(check(d, "monday"), "LEAD_GROUNDED")).toEqual([]);
    // The share's label prints the race's range too, so the share's Angle may say what the race is.
    d.angle.text = "In 26 weeks, 39% of recently disclosed flaws on CISA's list were listed 2 to 30 days after disclosure.";
    expect([...only(check(d, "monday"), "LEAD_GROUNDED"), ...only(check(d, "monday"), "WORDS_OVER")]).toEqual([]);
    // The 2023–24 pace per 13 weeks (11) is not the reference's own count (91) nor the 26-week pace (23).
    d.angle.text = "At the 2023–24 pace, 11 old flaws would be newly listed in 13 weeks.";
    for (const p of ["window.reference.old_listed_n", "window.reference.old_listed_pace_26w"]) {
      d.angle.metric_path = p; // neither label prints "13 weeks"
      expect(only(check(d, "monday"), "LEAD_GROUNDED").map((e) => e.message), p).toEqual([expect.stringContaining("holds 11"), expect.stringContaining("holds 13")]);
    }
    d.angle.metric_path = "window.reference.old_listed_pace_13w";
    expect(only(check(d, "monday"), "LEAD_GROUNDED")).toEqual([]);
  });

  it("a sourced Angle is read as before, label figures and all (row 145)", () => {
    const d = weekdayDraft(); // source_id reg-aisle, "Red Hat has credited AISLE with 24 flaws since 1 October."
    expect(only(check(d), "LEAD_GROUNDED")).toEqual([]);
    d.angle.text = "Red Hat has credited AISLE with 24 flaws in 26 weeks.";
    expect(only(check(d), "LEAD_GROUNDED").map((e) => e.message)).toEqual([expect.stringContaining("holds 26, which is not in the text seen at its source")]);
  });

  it("reads a raw metric with the rounding rule when the Gap shows no display for its path", () => {
    const m = draftInputs("monday").metrics!;
    expect(displaysFor(m, "flood.kernel_n")).toEqual([]);
    const kernel = valueAt(m, "flood.kernel_n") as number;
    const d = mondayDraft();
    d.angle.metric_path = "flood.kernel_n";
    d.angle.text = `Linux kernel records numbered ${kernel.toLocaleString("en-US")} this quarter.`;
    expect(only(check(d, "monday"), "LEAD_GROUNDED")).toEqual([]);
    d.angle.text = `Linux kernel records numbered ${(kernel + 7).toLocaleString("en-US")} this quarter.`;
    expect(only(check(d, "monday"), "LEAD_GROUNDED")).toHaveLength(1);
  });

  it("checks a sourced Angle's number against its source's seen text in draft mode only", () => {
    const d = weekdayDraft();
    d.angle.text = "Red Hat has credited AISLE with 25 flaws since 1 October.";
    expect(only(check(d), "LEAD_GROUNDED").map((e) => e.path)).toEqual(["angle.text"]);
    const blank = check(d, "weekday", (inputs) => { inputs.evidence!.texts[normalizeUrl(d.sources[12]!.url)] = ""; });
    expect(only(blank, "LEAD_GROUNDED")).toEqual([]); // nothing seen: SNAP_MISSING's
    expect(only(checkPublished(asBrief(d)), "LEAD_GROUNDED")).toEqual([]);
  });

  it("is skipped with METRICS_MISSING when there are no metrics", () => {
    const d = weekdayDraft();
    d.lead[0]!.item_ids = ["no-such-item"];
    const r = check(d, "weekday", (inputs) => { inputs.metrics = null; });
    expect(only(r, "LEAD_GROUNDED")).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toContain("METRICS_MISSING");
    expect(r.warnings.find((w) => w.code === "METRICS_MISSING")!.message).toContain("LEAD_GROUNDED");
  });
});

// ── GAP_MATCH (T) ────────────────────────────────────────────────────────────────────────────────

describe("GAP_MATCH", () => {
  const gap = (b: ReturnType<typeof asBrief>) => b.gap as Record<string, unknown>;
  const lens = (b: ReturnType<typeof asBrief>) => b.taiwan_lens as { kev_lines: Record<"tw" | "jp", { d30_n: number; d90_n: number; text: string }> };

  it("passes a Gap block and Lens KEV lines copied from the same-date metrics", () => {
    expect(only(checkPublished(asBrief(weekdayDraft())), "GAP_MATCH")).toEqual([]);
  });

  it("fails a changed headline, second line or cutoff", () => {
    const b = asBrief(weekdayDraft());
    gap(b).headline = `${String(gap(b).headline)} SAMPLE`;
    gap(b).second_line = "SAMPLE second line.";
    gap(b).as_of = "2026-10-11";
    expect(only(checkPublished(b), "GAP_MATCH").map((e) => e.path)).toEqual(["gap.headline", "gap.second_line", "gap.as_of"]);
  });

  it("fails a stale or missing Gap when the same-date metrics exist", () => {
    const b = asBrief(weekdayDraft());
    Object.assign(gap(b), { status: "stale", metrics_file: "metrics/2026-10-13.json" });
    expect(only(checkPublished(b), "GAP_MATCH").map((e) => e.path)).toEqual(["gap.status", "gap.metrics_file"]);
  });

  it("fails Lens KEV lines that differ from kevLines(metrics)", () => {
    const b = asBrief(weekdayDraft());
    lens(b).kev_lines.tw.d30_n += 1;
    lens(b).kev_lines.jp.text = "KEV additions for Japanese vendors: 2 in 30 days, 2 in 90, to 12 Oct (US date).";
    expect(only(checkPublished(b), "GAP_MATCH").map((e) => e.path)).toEqual(["taiwan_lens.kev_lines.tw.d30_n", "taiwan_lens.kev_lines.jp.text"]);
  });

  it("runs on a data-only edition (†), and is skipped without metrics", () => {
    const b = asBrief(weekdayDraft(), draftInputs("weekday"), "data_only");
    gap(b).headline = "SAMPLE";
    expect(only(checkPublished(b), "GAP_MATCH")).toHaveLength(1);
    const r = checkPublished(b, null);
    expect(only(r, "GAP_MATCH")).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(["METRICS_MISSING"]);
  });

  it("has nothing to check in a draft", () => {
    expect(only(check(weekdayDraft()), "GAP_MATCH")).toEqual([]);
  });
});

// ── METRICS_ONLY_NUMBERS ─────────────────────────────────────────────────────────────────────────

describe("METRICS_ONLY_NUMBERS", () => {
  it("reads the metric terms, the panel names only when capitalised", () => {
    expect(metricTermsIn("It went on CISA’s list in 3 days.")).toEqual(["on CISA's list"]);
    expect(metricTermsIn("The Window narrowed.")).toEqual(["the Window"]);
    expect(metricTermsIn("the window for patching is 3 days; the gap is wide")).toEqual([]);
    expect(metricTermsIn("n-day exploitation and AI-credited records")).toEqual(["AI-credited", "n-day"]);
  });

  const summary = (text: string) => {
    const d = weekdayDraft();
    item(d, I.criticalExploited).summary = text;
    return only(check(d), "METRICS_ONLY_NUMBERS");
  };

  it("lets an item sentence with a metric term hold metric numbers and its own CVE block's numbers", () => {
    expect(summary("Ivanti says attackers exploited CVE-2026-104935. It is one of 179 KEV additions in 26 weeks.")).toEqual([]);
    expect(summary("Ivanti says attackers exploited CVE-2026-104935. It is one of 180 KEV additions in 26 weeks.").map((e) => e.path))
      .toEqual(["items[0].summary"]);
    expect(summary("Ivanti says attackers exploited CVE-2026-104935, scored 8.6; it is now on CISA's list.")).toEqual([]);
    expect(summary("Ivanti says attackers exploited CVE-2026-104935, scored 8.7; it is now on CISA's list.")).toHaveLength(1);
    // A number outside the metric sentence is SNAP_NUMBER's business, not this rule's.
    expect(summary("Ivanti says 9,000 gateways are exposed. CVE-2026-104935 is now on CISA's list.")).toEqual([]);
  });

  it("lets a Lens block use the CVE blocks of the items it cites", () => {
    const d = weekdayDraft();
    const home = d.taiwan_lens.rows.findIndex((r) => r.row === "home_vendors");
    d.taiwan_lens.rows[home]!.text = "An Edimax router flaw scored 10 has not been added to KEV.";
    expect(only(check(d), "METRICS_ONLY_NUMBERS")).toEqual([]);
    d.taiwan_lens.rows[home]!.item_ids = [];
    d.taiwan_lens.rows[home]!.source_ids = ["s10"];
    expect(only(check(d), "METRICS_ONLY_NUMBERS").map((e) => e.path)).toEqual([`taiwan_lens.rows[${home}].text`]);
  });

  it("checks the week in review against the metrics only", () => {
    const d = mondayDraft();
    d.week_in_review!.text = "SAMPLE. The Window held: 157 such flaws in 26 weeks. The Flood brought 6 surprises.";
    const r = only(check(d, "monday"), "METRICS_ONLY_NUMBERS");
    expect(r.map((e) => e.path)).toEqual(["week_in_review.text"]);
    expect(r[0]!.message).toContain("holds 6,");
  });

  it("reads the Monday week in review's day range, with its weekdays, as one date (review of the seventh pass)", () => {
    // Neither 2 nor 8 is a metric number, so the range's first day failed the sentence.
    for (const text of ["SAMPLE. From Monday 2 to Sunday 8 Nov, CISA's KEV catalog grew while the Flood held.",
      "SAMPLE. Between Monday 2 and Sunday 8 Nov, CISA's KEV catalog grew while the Flood held."]) {
      const d = mondayDraft();
      d.week_in_review!.text = text;
      expect(only(check(d, "monday"), "METRICS_ONLY_NUMBERS"), text).toEqual([]);
    }
  });

  it("adds a day hint, with the edition's dates, when the stray number is a day before a month or weekday name (review of the seventh pass)", () => {
    const d = mondayDraft();
    d.week_in_review!.text = "SAMPLE. On 8, 9 or 10 Oct, CISA's KEV catalog grew while the Flood held.";
    const r = only(check(d, "monday"), "METRICS_ONLY_NUMBERS");
    expect(r.map((e) => e.message)).toEqual([expect.stringContaining("holds 8,")]);
    expect(r[0]!.hint).toBe("A sentence about KEV, the Flood, the Window or AI credits may quote only metrics.quotable, exactly. Copy the metric, "
      + 'or rewrite the sentence without the metric term. A day number is read as a number unless written as a date or a date range like "11 to 12 Oct".');
    d.week_in_review!.text = "SAMPLE. The Window held: 157 such flaws in 26 weeks. The Flood brought 6 surprises.";
    expect(only(check(d, "monday"), "METRICS_ONLY_NUMBERS")[0]!.hint).not.toContain("day number");
  });

  it("leaves the Lead and the Angle to LEAD_GROUNDED", () => {
    const d = weekdayDraft();
    d.lead[0]!.text = "Ivanti's flaw was one of 3 KEV additions that day.";
    const r = check(d);
    expect(only(r, "METRICS_ONLY_NUMBERS")).toEqual([]);
    expect(only(r, "LEAD_GROUNDED")).toHaveLength(1);
  });
});

// ── NUMBER_FORM ──────────────────────────────────────────────────────────────────────────────────

describe("NUMBER_FORM (review of the sixth P3 fix pass)", () => {
  it("NUMBER_FORM: reads a ratio glued to x, and nothing else glued to an x", () => {
    expect(gluedRatios("9.9x, 5.2X, 10x-faster, (3x), 1,000x and at 2x.")).toEqual(["9.9x", "5.2X", "10x", "3x", "1,000x", "2x"]);
    for (const text of ["0x1F", "4x4", "2X2", "x86", "Win10x64", "v1.9x", "1.9×", "1.9 times", "5 x 4", "X-ray", "10xs"]) {
      expect(gluedRatios(text), text).toEqual([]);
    }
  });

  // Review of the seventh pass: product, standard and id names ending in x are not ratios (CVE-2025-29635, the D-Link DIR-823X
  // flaw, is in KEV), and of 132,638 CVE List descriptions from 2025 and 2026, 127 held a match before and 28 do now, all ratios but
  // two "30x redirect" ones.
  const NAMES = ["D-Link DIR-823X", "DIR-823x", "802.1X", "802.1x", "802.3x", "Catalyst 9300X", "Catalyst 9500X", "3x-ui", "3X-UI",
    "AMD Ryzen 9 7950X", "Windows 9x", "10x Genomics", "iPhone 16x", "SAP NetWeaver 7.5x", "HTTP 30x redirects", "XikeStor SKS8310-8X",
    "GHSA-683x-4444-jxh8"];
  const RATIOS: readonly (readonly [string, string])[] = [
    ["New CVE records arrived at 9.9x the 2023–24 pace.", "9.9x"], ["Exploits came 10x faster.", "10x"], ["Exploitation rose 5x.", "5x"],
    ["The Flood ran at 5.2x, against 1.9 for KEV.", "5.2x"], ["It was a 3x jump.", "3x"], ["KEV added 2.5x more.", "2.5x"],
    ["Nearly 10x more flaws were listed.", "10x"], ["In October, 5x more were listed.", "5x"], ["KEV's 2x jump", "2x"]];

  it("NUMBER_FORM: reads no product, standard or id name ending in x, alone or in a sentence, and every ratio", () => {
    for (const name of NAMES) {
      for (const text of [name, `The flaw affects ${name}.`, `${name} devices are affected, as are ${name} units.`, `It names ${name}, again.`]) {
        expect(gluedRatios(text), text).toEqual([]);
      }
    }
    for (const text of ["Cisco Catalyst 9500X and 9600X Series Switches", "versions from 4.3x before 5.1", "a 30X HTTP response",
      "sprintf('%08x%05x')", "Windows 9x is legacy.", "Catalyst 9300X switches are affected.", "+0x159/0x200 and 0x",
      "affects versions 4.3x of the plugin", "firmware 2.1x is affected"]) {
      expect(gluedRatios(text), text).toEqual([]);
    }
    for (const [text, ratio] of RATIOS) expect(gluedRatios(text), text).toEqual([ratio]);
  });

  it("NUMBER_FORM: reads a ratio after a date label or a name before a comparison, in a range, and before + or / (review of the eighth pass)", () => {
    // Each was caught at 3e511f6 and missed at 37d5bb3: the word before read as a name, or the dash before the digits refused.
    for (const [text, ratio] of [
      ["In October 5x more records arrived.", "5x"], ["Since September 3x more flaws were listed.", "3x"],
      ["In 2026 5x more CVE records arrived.", "5x"], ["In Q3 5x more records arrived.", "5x"], ["In H2 5x.", "5x"], ["On Monday 5x.", "5x"],
      ["Attacks on Taiwan 3x more often hit chipmakers.", "3x"], ["CISA 2x faster", "2x"], ["AI 10x faster triage", "10x"],
      ["AI tools find bugs 2-3x faster than fuzzers.", "3x"], ["AI tools find bugs 2–3x faster than fuzzers.", "3x"],
      ["a 5x–10x jump in reports", "10x"], ["a 10x+ jump", "10x"], ["up 10x/year", "10x"], ["KEV 3x the 2023–24 pace", "3x"],
      ["Exploits rose 3x a year.", "3x"], ["CISA 2x-faster", "2x"],
      ["In October 9.9x more CVE records arrived than in 2023–24.", "9.9x"],
    ] as const) expect(gluedRatios(text), text).toEqual([ratio]);
    // A list of names stays a list of names: a token joined by "and" or "or" to a name, or before "series" or "branch".
    for (const text of ["DrayTek Vigor 286x and 296x routers", "Cisco 350x and 550x switches", "Drupal 10.x and 11x", "the 3x series",
      "for 2x and 3x branches", "Microsoft.IdentityModel 7x and 6x are affected.", "Juniper EX4300 and 4600x", "Cisco 9300x or 9500x",
      "the 1.x and 2x lines", "the Linux kernel 5.1x series", "the 2x branch"]) {
      expect(gluedRatios(text), text).toEqual([]);
    }
    // A comparison after the token still makes it a ratio in a list.
    expect(gluedRatios("Vigor 286x and 3x more often")).toEqual(["3x"]);
  });

  it("NUMBER_FORM: a zero-item Gap sentence with a wrong ratio after a month or in a range fails (review of the eighth pass)", () => {
    // The display is 5.2: each gave 0 errors at 37d5bb3.
    for (const text of ["In October 9.9x more CVE records arrived than in 2023–24.", "Since July 9.9x more CVE records arrived than in 2023–24.",
      "New CVE records arrived at 5x–10x the 2023–24 pace in 13 weeks."]) {
      const d = weekdayDraft();
      d.lead.push({ text, item_ids: [], gap: true });
      expect(check(d).errors.map((e) => `${e.code} ${e.path}`), text).toEqual(["NUMBER_FORM lead[3].text"]);
    }
  });

  it("NUMBER_FORM: a draft that names a product, standard or id ending in x passes, and one that writes a ratio fails", () => {
    for (const name of NAMES) {
      const d = weekdayDraft();
      d.items[3]!.summary = `Attackers target ${name}.`;
      expect(only(check(d), "NUMBER_FORM"), name).toEqual([]);
    }
    for (const [text, ratio] of RATIOS) {
      const d = weekdayDraft();
      d.items[3]!.summary = text;
      expect(only(check(d), "NUMBER_FORM").map((e) => e.message), text).toEqual([
        `items[3].summary writes the ratio "${ratio}", glued to x, which the validator does not read as a number, so it cannot check it.`]);
    }
  });

  it("NUMBER_FORM: reads a ratio in words, and no count of occurrences, \"once\" or \"twice\"", () => {
    for (const [text, ratio] of [
      ["nearly ten times the 2023–24 pace", "ten times"], ["more than five times the reference", "five times"],
      ["twenty-one times more", "twenty-one times"], ["a hundred times faster", "a hundred times"], ["Ten times the pace", "Ten times"],
      ["ten times that of 2023–24", "ten times"], ["three times as many flaws", "three times"], ["seven times higher", "seven times"],
      ["five times over the 2023–24 pace", "five times"], ["two times greater", "two times"], ["rose tenfold.", "tenfold"],
      ["a ten-fold rise", "ten-fold"], ["a hundredfold increase", "a hundredfold"], ["a twofold rise", "twofold"],
    ] as const) expect(wordRatios(text), text).toEqual([ratio]);
    for (const text of ["updated three times this year", "three times in October", "patched three times the following week",
      "updated three times as of today", "patched five times over the past week", "more than twice the pace", "once the pace",
      "The problem is twofold: speed and scale.", "a threefold approach", "The risk is twofold.", "more than five times.",
      "3 times the pace", "5.2 times the 2023–24 pace"]) {
      expect(wordRatios(text), text).toEqual([]);
    }
  });

  it("NUMBER_FORM: a zero-item Gap sentence with a ratio in words fails, with a hint to write it in digits (review of the seventh pass)", () => {
    // The review's G9 rewritten: no rule read "nearly ten times", so a display of 5.2 published as ten.
    const d = weekdayDraft();
    d.lead.push({ text: "New CVE records arrived at nearly ten times the 2023–24 pace in 13 weeks.", item_ids: [], gap: true });
    const r = check(d);
    expect(r.errors.map((e) => [e.code, e.path, e.message, e.hint])).toEqual([["NUMBER_FORM", "lead[3].text",
      'lead[3].text writes the ratio "ten times" in words, which the validator does not read as a number, so it cannot check it.',
      'Write it in digits as the Gap does, "N times", with N exactly as metrics.quotable or the cited source gives it.']]);
    d.lead[3]!.text = "New CVE records arrived at 5.2 times the 2023–24 pace in 13 weeks.";
    expect(check(d).errors).toEqual([]);
    // The Gap headline's own "more than twice" is no ratio in words.
    d.lead[3]!.text = "Exploitation ran at more than twice the 2023–24 pace, and CISA updated its list three times in October.";
    expect(only(check(d), "NUMBER_FORM")).toEqual([]);
  });

  it("NUMBER_FORM: a zero-item Gap sentence with a wrong ratio glued to x fails, though LEAD_GROUNDED reads no number in it", () => {
    // The review's G9: the display is 5.2, and 13 is a quoted Gap number, so no other rule notices.
    const d = weekdayDraft();
    d.lead.push({ text: "New CVE records arrived at 9.9x the 2023–24 pace in 13 weeks.", item_ids: [], gap: true });
    const r = check(d);
    expect(r.errors.map((e) => `${e.code} ${e.path}`)).toEqual(["NUMBER_FORM lead[3].text"]);
    expect(r.errors[0]!.message).toBe('lead[3].text writes the ratio "9.9x", glued to x, which the validator does not read as a number, so it cannot check it.');
    // The hint never proposes the miscopied 9.9 (review of the seventh pass): "9.9 times" would fail LEAD_GROUNDED next round.
    expect(r.errors[0]!.hint).toBe('Write it as "N times", with N exactly as metrics.quotable or the cited source gives it, never "9.9x", even where a source writes it that way.');
    // Written as the Gap writes it, the wrong ratio is read, and LEAD_GROUNDED fails it.
    d.lead[3]!.text = "New CVE records arrived at 9.9 times the 2023–24 pace in 13 weeks.";
    expect(check(d).errors.map((e) => e.code)).toEqual(["LEAD_GROUNDED"]);
    d.lead[3]!.text = "New CVE records arrived at 5.2 times the 2023–24 pace in 13 weeks.";
    expect(check(d).errors).toEqual([]);
  });

  it("NUMBER_FORM: a ratio glued to x beside another number in a metric Angle fails, with no WORDS_UNDER to hint at it", () => {
    const d = weekdayDraft();
    d.angle = { ...d.angle, source_id: null, claim_id: null, metric_path: "flood.vs_reference_ratio", as_of: draftInputs("weekday").metrics!.data_cutoff_utc,
      text: "New CVE records arrived at 5.2x the 2023–24 pace in the 13 weeks to 12 Oct, against 1.9 for KEV." };
    const r = validateDraft(d, draftInputs("weekday"));
    expect(only(r, "NUMBER_FORM").map((e) => [e.path, e.hint])).toEqual([
      ["angle.text", 'Write it as "N times", with N exactly as metrics.quotable or the cited source gives it, never "5.2x", even where a source writes it that way.']]);
    expect(only(r, "WORDS_UNDER")).toEqual([]);
  });

  it("NUMBER_FORM: reads every prose field, once per ratio as written, and no quoted field or title", () => {
    const d = weekdayDraft();
    const it0 = d.items[0]!;
    it0.summary = `${it0.summary} Exposure grew 3x, then 3x again.`;
    it0.headline = `${it0.headline} at 2x`;
    d.angle.counterpoint = `${d.angle.counterpoint} Red Hat rated them 4X less severe.`;
    d.taiwan_lens.analysis = `${d.taiwan_lens.analysis} Phishing rose 2.5x.`;
    d.taiwan_lens.rows[0]!.text = `${d.taiwan_lens.rows[0]!.text} Alerts rose 6x.`;
    d.taiwan_lens.japan.text = `${d.taiwan_lens.japan.text} Claims rose 7x.`;
    const ai = d.items.find((x) => x.ai_evidence.length)!;
    ai.ai_evidence[0]!.quote = `${ai.ai_evidence[0]!.quote} 10x faster`;
    d.sources[0]!.title = `${d.sources[0]!.title} 10x`;
    expect(only(check(d), "NUMBER_FORM").map((e) => e.path).sort()).toEqual([
      "angle.counterpoint", "items[0].headline", "items[0].summary", "taiwan_lens.analysis", "taiwan_lens.japan.text", "taiwan_lens.rows[0].text"]);
  });

  it("NUMBER_FORM: runs on drafts only, so a published brief is never failed for it", () => {
    const d = weekdayDraft();
    d.lead.push({ text: "New CVE records arrived at 9.9x the 2023–24 pace in 13 weeks.", item_ids: [], gap: true });
    expect(only(checkPublished(asBrief(d)), "NUMBER_FORM")).toEqual([]);
  });
});

// ── AI_EVIDENCE_REQUIRED ─────────────────────────────────────────────────────────────────────────

describe("AI_EVIDENCE_REQUIRED", () => {
  const run = (f: (it: DraftItem) => void, id: string = I.chinaAxis) => {
    const d = weekdayDraft();
    f(item(d, id));
    return only(check(d), "AI_EVIDENCE_REQUIRED").map((e) => e.path.replace(/^items\[\d+\]/, "item"));
  };

  it("needs evidence and a confidence for an AI-linked role", () => {
    expect(run((it) => { it.ai_evidence = []; })).toEqual(["item.ai_evidence"]);
    expect(run((it) => { it.ai_confidence = null; })).toEqual(["item.ai_confidence"]);
  });

  it("allows nothing AI-related with ai_role none or unassessed", () => {
    expect(run((it) => { it.ai_claimant = "SAMPLE Lab"; }, I.landmark)).toEqual(["item.ai_role"]);
    expect(run((it) => { it.ai_confidence = "reported"; it.ai_role_secondary = "ai_found"; }, I.landmark)).toEqual(["item.ai_role"]);
    expect(run((it) => { it.ai_role = "none"; })).toEqual(["item.ai_role"]); // its evidence and confidence remain
    expect(run((it) => { it.ai_role = "unassessed"; it.ai_evidence = []; it.ai_confidence = null; })).toEqual([]);
  });

  it("needs a secondary role that is AI-linked and differs from the main one", () => {
    expect(run((it) => { it.ai_role_secondary = "ai_weapon"; })).toEqual(["item.ai_role_secondary"]);
    expect(run((it) => { it.ai_role_secondary = "none"; })).toEqual(["item.ai_role_secondary"]);
    expect(run((it) => { it.ai_role_secondary = "ai_target"; })).toEqual([]);
  });

  it("needs a claimant for claimed, and at most 3 evidence entries", () => {
    expect(run((it) => { it.ai_claimant = null; }, I.glasswing)).toEqual(["item.ai_claimant"]);
    expect(run((it) => { it.ai_evidence = [0, 1, 2, 3].map(() => ({ ...it.ai_evidence[0]! })); })).toEqual(["item.ai_evidence"]);
  });
});

// ── AI_CONFIRMED_NONPRESS ────────────────────────────────────────────────────────────────────────

describe("AI_CONFIRMED_NONPRESS", () => {
  const confirmed = (source: string, fromClaimant = false, type?: string) => {
    const inputs = draftInputs("weekday");
    const d = weekdayDraft();
    const it = item(d, I.aiConfirmed);
    let id = source;
    if (type) {
      id = addSource(d, inputs, "https://www.example.org/ct-sample/victim-statement", { type });
      it.source_ids.push(id);
    }
    it.ai_evidence = [{ source_id: id, quote: "SAMPLE quote.", from_claimant: fromClaimant }];
    return only(validateDraft(d, { ...inputs, rules: MINE }), "AI_CONFIRMED_NONPRESS");
  };

  it("needs a non-claimant record, vendor, government or victim source", () => {
    expect(confirmed("s12")).toEqual([]); // the CVE record
    expect(confirmed("s12", true)).toHaveLength(1);
    expect(confirmed("s13")).toHaveLength(1); // The Register, press
    expect(confirmed("", false, "victim")).toEqual([]);
    expect(confirmed("", false, "research")).toHaveLength(1);
  });

  it("never checks claimed or reported confidence", () => {
    const d = weekdayDraft();
    item(d, I.chinaAxis).ai_evidence[0]!.from_claimant = true;
    expect(only(check(d), "AI_CONFIRMED_NONPRESS")).toEqual([]);
  });
});

// ── SELF_REPORTED_WORDING ────────────────────────────────────────────────────────────────────────

describe("SELF_REPORTED_WORDING", () => {
  it("needs an attributing word in the headline or summary, as a whole word", () => {
    expect(attributesClaim("Anthropic says partners disclosed flaws")).toBe(true);
    expect(attributesClaim("partners disclosed flaws, according to Anthropic")).toBe(true);
    expect(attributesClaim("one-hour incident reporting")).toBe(false);
    expect(attributesClaim("the claimant")).toBe(false);
    const d = weekdayDraft();
    const it = item(d, I.landmark);
    it.claim_type = "self_reported";
    expect(only(check(d), "SELF_REPORTED_WORDING").map((e) => e.path)).toEqual([`items[${idx(d, I.landmark)}].headline`]);
    it.summary = `${it.summary} The Cabinet said so.`;
    expect(only(check(d), "SELF_REPORTED_WORDING")).toEqual([]);
  });

  it("fails a self-reported claim marked confirmed", () => {
    const d = weekdayDraft();
    item(d, I.glasswing).ai_confidence = "confirmed";
    expect(only(check(d), "SELF_REPORTED_WORDING").map((e) => e.path)).toEqual([`items[${idx(d, I.glasswing)}].ai_confidence`]);
  });

  it("skips an item a withholding rewrote", () => {
    const d = weekdayDraft();
    const b = asBrief(d);
    Object.assign(bItem(b, I.claimedVictim), {
      headline: "Item under review", summary: "Details withheld from 15 Oct while a dispute about a named party is reviewed.",
      withheld: { correction_id: "C-0001", since: "2026-10-15" },
    });
    expect(only(checkPublished(b), "SELF_REPORTED_WORDING")).toEqual([]);
    bItem(b, I.claimedVictim).withheld = null;
    expect(only(checkPublished(b), "SELF_REPORTED_WORDING")).toHaveLength(1);
  });
});

// ── ANTHROPIC_DISCLOSURE_LINE (T) ────────────────────────────────────────────────────────────────

describe("ANTHROPIC_DISCLOSURE_LINE", () => {
  const sources = (d: DraftBrief) => {
    const config = draftInputs("weekday").config;
    return d.sources.map((s) => ({ id: s.id, publisher: publisherFor(s.url, s.source_type, config).publisher }));
  };

  it("mentionsAnthropic() is true for the Glasswing item only among the weekday items", () => {
    const d = weekdayDraft();
    expect(d.items.filter((it) => mentionsAnthropic(it, sources(d))).map((it) => it.id)).toEqual([I.glasswing]);
  });

  it("reads the four words in any case, as whole words, in any prose, quoted, claimant, incident or attribution field", () => {
    const d = weekdayDraft();
    const src = sources(d);
    const base = item(d, I.landmark);
    const yes = (patch: Partial<DraftItem>) => mentionsAnthropic({ ...base, ...patch }, src);
    expect(yes({ summary: "SAMPLE. Written with claude." })).toBe(true);
    expect(yes({ why_it_matters: "SAMPLE MYTHOS-class finding." })).toBe(true);
    expect(yes({ headline: "SAMPLE: Glasswing's partners" })).toBe(true);
    expect(yes({ summary: "SAMPLE. Claudette and Anthropics are not names here." })).toBe(false);
    expect(yes({ ai_claimant: "Anthropic" })).toBe(true);
    const inc = item(d, I.claimedVictim).incident!;
    expect(yes({ incident: { ...inc, claimed_by: "SAMPLE Claude Crew" } })).toBe(true);
    const attr = item(d, I.chinaAxis).attribution[0]!;
    expect(yes({ attribution: [{ ...attr, attributed_by: "Anthropic Threat Intelligence" }] })).toBe(true);
    expect(yes({ attribution: [{ ...attr, confidence_text: "per Anthropic analysts" }] })).toBe(true);
  });

  it("is true for a cited Anthropic page or an Anthropic AI credit, with no word in the text", () => {
    const d = weekdayDraft();
    const it = item(d, I.landmark);
    expect(mentionsAnthropic({ ...it, source_ids: [...it.source_ids, "s14"] }, sources(d))).toBe(true); // red.anthropic.com
    expect(mentionsAnthropic({ ...it, cves: [{ ai_credit: { family: "anthropic" } }] }, sources(d))).toBe(true);
    expect(mentionsAnthropic({ ...it, cves: [{ ai_credit: { family: "google" } }, { ai_credit: null }] }, sources(d))).toBe(false);
    expect(anthropicReasons({ ...it, source_ids: ["s14"] }, sources(d))).toEqual(["it cites s14, an Anthropic page"]);
  });

  it("fails a published flag that differs from mentionsAnthropic(), reading the frozen publishers", () => {
    const b = asBrief(weekdayDraft());
    expect(only(checkPublished(b), "ANTHROPIC_DISCLOSURE_LINE")).toEqual([]);
    bItem(b, I.glasswing).anthropic_disclosure = false;
    bItem(b, I.landmark).anthropic_disclosure = true;
    const r = only(checkPublished(b), "ANTHROPIC_DISCLOSURE_LINE");
    expect(r.map((e) => e.path)).toEqual([`items[${idx(weekdayDraft(), I.glasswing)}].anthropic_disclosure`, `items[${idx(weekdayDraft(), I.landmark)}].anthropic_disclosure`]);
    expect(r[0]!.message).toContain('headline says "Anthropic"');

    // A frozen publisher wins over the current config.
    const frozen = asBrief(weekdayDraft());
    const ey = (frozen.sources as { id: string; publisher: string }[]).find((s) => s.id === "s16")!;
    ey.publisher = "anthropic";
    expect(only(checkPublished(frozen), "ANTHROPIC_DISCLOSURE_LINE").map((e) => e.path)).toEqual([`items[${idx(weekdayDraft(), I.landmark)}].anthropic_disclosure`]);
  });

  it("skips a withheld item, and has nothing to check in a draft", () => {
    const b = asBrief(weekdayDraft());
    Object.assign(bItem(b, I.glasswing), { headline: "Item under review", withheld: { correction_id: "C-0001", since: "2026-10-15" }, source_ids: ["s15"] });
    expect(only(checkPublished(b), "ANTHROPIC_DISCLOSURE_LINE")).toEqual([]);
    expect(only(check(weekdayDraft()), "ANTHROPIC_DISCLOSURE_LINE")).toEqual([]);
  });
});

// ── The F fixtures ───────────────────────────────────────────────────────────────────────────────

describe("F fixtures (fixtures/src/invalid/cves-grounding-ai.ts)", () => {
  it("cover every hard code in this part a draft can trigger", () => {
    expect(cvesGroundingAiCases.map((c) => c.code).sort()).toEqual([
      "AI_CONFIRMED_NONPRESS", "AI_EVIDENCE_REQUIRED", "CVE_IN_SOURCE", "CVE_PUBLISHED", "EXPLOITED_BASIS", "FLAW_EVIDENCE",
      "LEAD_GROUNDED", "METRICS_ONLY_NUMBERS", "NUMBER_FORM", "SELF_REPORTED_WORDING", "VENDOR_CONFIRMED",
    ]);
  });

  it.each(cvesGroundingAiCases.map((c) => [c.code, c] as const))("%s fails with exactly its own code under every rule", (_code, c) => {
    const r = validateDraft(invalidDraft(c), draftInputs(c.edition ?? "weekday"));
    expect(r.errors.length).toBeGreaterThan(0);
    expect([...new Set(r.errors.map((e) => e.code))]).toEqual([c.code]);
    expect(r.warnings).toEqual([]);
  });

  it.each(cvesGroundingAiCases.map((c) => [c.file] as const))("%s is written and up to date", (file) => {
    const c = cvesGroundingAiCases.find((x) => x.file === file)!;
    const disk = JSON.parse(fs.readFileSync(path.join("fixtures", "drafts", file), "utf8")) as unknown;
    expect(disk).toEqual(JSON.parse(JSON.stringify(invalidDraft(c))));
  });
});
