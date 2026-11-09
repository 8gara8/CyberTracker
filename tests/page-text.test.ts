// lib/page-text.ts (SPEC §7 "Script-written page text"): every export, the §7 examples verbatim, the
// null-block captions, the data-only and partial notices, and that scriptParts() follows page order.
// Brief and Metrics objects are built by hand and parsed through their schemas (the metrics are
// tests/metrics.test.ts's 2026-11-08 file, Appendix D.1 to D.3); sample text is invented and marked SAMPLE.

import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { composeHeadline, footerLine, kevLines } from "@/lib/metrics/headline";
import { REFERENCE, referenceWindowStats } from "@/lib/metrics/reference";
import { round4 } from "@/lib/metrics/stats";
import {
  EMPTY_LINES, briefDescription, cardKicker, chartCaptions, cveTimeline, editionNotice, fixSideLines, gapFooter, gapHeadlineLine,
  gapNotices, gapSecondLine, lensKevLines, mastheadLine, regionSummary, releaseLine, scriptParts, scriptText,
} from "@/lib/page-text";
import { Brief, type RegionRow } from "@/lib/schema/brief";
import type { Source } from "@/lib/schema/common";
import { CveBlock, ReleaseBlock, type Item } from "@/lib/schema/item";
import { FixSide, Metrics, type WindowStats } from "@/lib/schema/metrics";
import { countWords } from "@/lib/text";
import { AI_CREDIT_CAPTION, EDITION_INFO, FIX_SIDE_CAPTION, KEV_ABSENCE_NOTE, TAIWAN_LENS_ROWS, WINDOW_LABEL } from "@/lib/vocab";

const D = "2026-11-08";
const CUTOFF = "2026-11-06";
const at = (d: string, hhmmss: string) => `${d}T${hhmmss}+08:00`;

// ── Metrics (tests/metrics.test.ts's d3Metrics) ──────────────────────────────────────────────────

const W26: WindowStats = {
  from: "2026-05-09", to: "2026-11-06", kev_added_n: 179, unjoined_n: 0, cohort_n: 157, old_listed_n: 22, at_disclosure_n: 58,
  at_disclosure_share: round4(58 / 157), at_disclosure_ci80: [0.3217, 0.4199], n_day_n: 62, after_disclosure_n: 99,
  after_disclosure_median_days: 17, after_disclosure_median_ci80: [13, 22], k7_n: 87, p7: 0.5541, p7_ci80: [0.503, 0.6042],
};
const W13: WindowStats = {
  from: "2026-08-08", to: "2026-11-06", kev_added_n: 107, unjoined_n: 0, cohort_n: 94, old_listed_n: 13, at_disclosure_n: 36,
  at_disclosure_share: 0.383, at_disclosure_ci80: [0.3213, 0.4487], n_day_n: 35, after_disclosure_n: 58,
  after_disclosure_median_days: 20.5, after_disclosure_median_ci80: [13, 30], k7_n: 53, p7: 0.5638, p7_ci80: [0.4977, 0.6277],
};

function weeks(): string[] {
  const out: string[] = [];
  for (let d = "2024-11-04"; d <= "2026-10-26"; d = addDays(d, 7)) out.push(d);
  return out;
}

/** The 2026-11-08 metrics file, with the headline composed; `patch` runs after, then the schema parses it. */
function metrics(patch: (m: Metrics) => void = () => {}): Metrics {
  const ws = weeks();
  const zeros = ws.map(() => 0);
  const nulls = ws.map(() => null);
  const ok = { status: "ok" as const, as_of: CUTOFF, note: null };
  const m: Metrics = {
    schema_version: 1, date: D, generated_at: at(D, "04:41:12"), data_cutoff_utc: CUTOFF, reconstructed: true, code_commit: "0".repeat(40),
    provenance: {
      kev_catalog_version: "2026.11.06", kev_count: 1769, kev_date_released: "2026-11-06T19:44:45.1797Z",
      cve_list_release: "cve_2026-11-06_2100Z", cve_list_commit: REFERENCE.flood.cve_list_commit, kev_data_commit: null,
      epss_model_version: "v2025.03.14", epss_date: CUTOFF, ghsa_source: "git", ghsa_commit: null,
      config_versions: { vendors: 1, ai_finders: 1, source_tiers: 1, regions: 1, actors: 1 },
      reference: { from: "2023-01-01", to: "2024-12-31" }, inputs_file: `metrics/inputs/${D}.json`, inputs_sha256: "0".repeat(64),
    },
    blocks: { flood: ok, window: ok, ai_credited: ok, fix_side: ok, kev: ok, home_vendors: ok },
    headline: { text: "x", second_line: "x", at_disclosure_direction: "no_clear_change", after_disclosure_direction: "no_clear_change", quoted: [] },
    flood: {
      from: "2026-08-08", to: CUTOFF, n: 44944, kernel_n: 4804, ex_kernel_n: 40140, unscored_n: 3121,
      year_ago: { from: "2025-08-09", to: "2025-11-07", n: 12275, kernel_n: 1574, ex_kernel_n: 10701 },
      yoy_pct: 266.1, yoy_ex_kernel_pct: 275.1, reference: { w13_mean_n: 8561.1, w13_mean_ex_kernel_n: 8027.4 },
      vs_reference_pct: 425.0, vs_reference_ex_kernel_pct: 400.0, vs_reference_ratio: 5.2498, vs_reference_ex_kernel_ratio: 5.0004,
      last_week: { week_start: "2026-10-26", n: 3426, kernel_n: 129, unscored_n: 106 },
    },
    window: { w26: W26, w13: W13, reference: referenceWindowStats(), reference_pace_26w: 70.21, volume_ratio: 2.2361, kev_pace_ratio: 1.9275 },
    ai_credited: {
      finders_version: 1, from: "2026-08-08", to: CUTOFF,
      w13: { total: 386, by_family: { anthropic: 213, openai: 41, google: 1, other: 131 }, ex_anthropic: 173, ledger_only_anthropic: 0 },
      provisional_from: "2026-10-05",
      in_kev: { since: "2025-01-01", n: 1, entries: [{ cve_id: "CVE-2026-111497", finder_id: "openai-codex", family: "openai", kev_date_added: "2026-10-27", matched: "Codex Security" }] },
    },
    base_rate: {
      since: "2025-01-01", to_published: "2026-08-08", to: CUTOFF, follow_up_days: 90, ai_credited_n: 195, ai_credited_in_kev_n: 0,
      ai_rate: 0, all_n: 95725, all_in_kev_n: 281, all_rate: 0.0029, expected: 0.4987, ratio: null, ratio_ci80: null,
    },
    fix_side: { anthropic_cvd: null, ghsa_unfixed: null },
    kev: { catalog_version: "2026.11.06", catalog_count: 1769, date_released: "2026-11-06T19:44:45.1797Z", new_since_last_edition: { since_catalog_version: "2026.11.05", cve_ids: [] } },
    home_vendors: {
      tw: { to: CUTOFF, d30_from: "2026-10-08", d30_n: 0, d90_from: "2026-08-09", d90_n: 1, cve_ids_90: [{ cve_id: "CVE-2026-7273", vendor_id: "zyxel", date_added: "2026-09-21" }] },
      jp: { to: CUTOFF, d30_from: "2026-10-08", d30_n: 0, d90_from: "2026-08-09", d90_n: 0, cve_ids_90: [] },
    },
    epss_movers: [],
    series: {
      weeks: ws, live_from: "2026-11-02", flood_n13: zeros, flood_n13_kernel: zeros, flood_n13_year_ago: nulls,
      window_at_disclosure_share: nulls, window_at_disclosure_ci80: nulls, window_after_median: nulls, window_after_median_ci80: nulls,
      window_cohort_n: zeros, kev_recent_weekly: zeros, kev_weekly: zeros,
      ai_weekly: { anthropic: zeros, openai: zeros, google: zeros, other: zeros }, ai_ledger_only_weekly: zeros, data_only_weeks: [],
    },
  };
  m.headline = composeHeadline(m);
  patch(m);
  return Metrics.parse(m);
}

const CVD = {
  status: "ok" as const, revision: "40", as_of: "2026-11-05", fetched_at: at("2026-11-05", "04:40:00"),
  found_n: 6009, disclosed_n: 5087, patched_n: 629, source_url: "https://red.anthropic.com/ct-sample-dashboard",
};
const GHSA = { share: 0.0155, n_unfixed: 19, n_total: 1229, from: "2026-07-09", to: "2026-10-07", as_of: CUTOFF };

// ── Briefs ───────────────────────────────────────────────────────────────────────────────────────

function source(n: number): Source {
  return {
    id: `s${n}`, title: `SAMPLE source ${n}`, title_en: null, language: "en", outlet: "SAMPLE Outlet",
    url: `https://news.example.com/ct-sample/source-${n}`, source_type: "press", published_at: "2026-11-07",
    publisher: "host:news.example.com", publisher_name: "SAMPLE Outlet", tier: 2, state_label: null, seen_as: "pack",
  };
}

function cve(over: Partial<CveBlock> = {}): CveBlock {
  return CveBlock.parse({
    cve_id: "CVE-2026-104935", date_published: "2026-11-02", date_updated: "2026-11-05", assigner: "qnap",
    vendor: { id: "qnap", name: "QNAP", country: "TW" }, product: "SAMPLE NAS firmware", title: "SAMPLE NAS firmware flaw",
    cvss: null, epss: null, ssvc: null,
    kev: { date_added: "2026-11-03", due_date: "2026-11-05", ransomware: "unknown", catalog_version: "2026.11.03" },
    credits: [], ai_credit: null, discovery_credit: "unknown", advisory_date: "2026-11-03",
    patch: { date: "2026-11-03", basis: "vendor_advisory", source_url: "https://www.qnap.com/en/security-advisory/ct-sample" },
    exploitation_evidence: [{ date: "2026-11-03", basis: "kev_listed", source_url: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog" }],
    exploit_reference: false, vendor_confirmed: true, vendor_confirmed_by: "vendor_cna", ghsa_ids: [], captured_at: at(D, "04:44:10"),
    ...over,
  });
}

function release(over: Partial<ReleaseBlock> = {}): ReleaseBlock {
  return ReleaseBlock.parse({
    release_id: "rel-sample-2026-11", vendor: { id: null, name: "SAMPLE Software", country: "US" }, date: "2026-11-05",
    title: "SAMPLE November 2026 Security Update", fixes_n: 63, critical_n: 5, exploited_n: 2,
    exploited_cve_ids: ["CVE-2026-104901", "CVE-2026-104902"], counted_from: "cve_list", source_url: "https://software.example.com/ct-sample/release",
    ...over,
  });
}

function item(over: Partial<Item> & Pick<Item, "id" | "kind" | "headline">): Item {
  return {
    summary: "SAMPLE summary of the event.", why_it_matters: "SAMPLE: it bears on the Gap.", severity: null, landmark: false,
    ai_role: "none", ai_role_secondary: null, ai_confidence: null, ai_claimant: null, ai_evidence: [], claim_type: "independent",
    regions: ["GLOBAL"], topics: [], attribution: [], actor_nexus: null, incident: null, cve_ids: [], release_id: null,
    flaw_evidence: [], exploit_reported_in_sources: null, exposure: null, standing_story: null, source_ids: ["s1"],
    first_seen: D, vendor: null, cves: [], release: null, public_exploit: null, anthropic_disclosure: false, withheld: null,
    ...over,
  };
}

// Display order (§4.6): three top stories, then rows by head (exploits, ai_frontier, policy_actors).
const EXPLOITED = item({
  id: "cve-2026-104935", kind: "exploited_flaw", headline: "SAMPLE: NAS flaw exploited days after disclosure", severity: "high",
  ai_role: "ai_found", ai_confidence: "confirmed", regions: ["US", "TW"], cve_ids: ["CVE-2026-104935"], public_exploit: "no",
  vendor: { id: "qnap", name: "QNAP", country: "TW" }, cves: [cve()],
});
const PATCH = item({
  id: "pt-sample-2026-11", kind: "patch_batch", headline: "SAMPLE: monthly release fixes two exploited flaws", severity: "high",
  regions: ["US", "GLOBAL"], cve_ids: ["CVE-2026-104901", "CVE-2026-104902"], release_id: "rel-sample-2026-11", public_exploit: "no",
  vendor: { id: null, name: "SAMPLE Software", country: "US" }, release: release(),
});
const BREACH = item({
  id: "inc-sample-retail-jp", kind: "breach", headline: "SAMPLE: retailer reports stolen customer records", severity: "elevated",
  regions: ["JP"],
});
const CRITICAL = item({
  id: "cve-2026-104990", kind: "critical_flaw", headline: "SAMPLE: critical flaw in a mail gateway", severity: "watch",
  cve_ids: ["CVE-2026-104990"], public_exploit: "no", vendor: { id: null, name: "SAMPLE Corp", country: null },
  cves: [cve({
    cve_id: "CVE-2026-104990", date_published: "2026-11-04", vendor: { id: null, name: "SAMPLE Corp", country: null }, kev: null, patch: null,
    vendor_confirmed: false, vendor_confirmed_by: null,
    exploitation_evidence: [
      { date: "2026-11-06", basis: "news_reported", source_url: "https://news.example.com/ct-sample/source-1" },
      { date: "2026-11-07", basis: "vendor_confirmed", source_url: "https://corp.example.com/ct-sample/advisory" },
    ],
  })],
});
const AI_ITEM = item({
  id: "ai-sample-finder", kind: "ai_capability", headline: "SAMPLE: lab says its agent found a kernel bug", landmark: true,
  ai_role: "ai_found", ai_confidence: "claimed", ai_claimant: "SAMPLE Lab", claim_type: "self_reported",
});
const POLICY = item({ id: "pol-sample-rule", kind: "policy", headline: "SAMPLE: new incident-reporting rule takes effect", regions: ["EU"] });
const ITEMS = [EXPLOITED, PATCH, BREACH, CRITICAL, AI_ITEM, POLICY];

function row(code: RegionRow["code"], level: RegionRow["level"], change: RegionRow["change"], reason: string): RegionRow {
  return {
    code, level, computed_level: level, previous_level: change === "new" ? null : level, change,
    rule_id: level === "baseline" ? null : "campaign-target", reason, item_ids: [], fired: [], raised: null,
  };
}

const ROWS = [
  row("US", "high", "up", "SAMPLE: an agency alert on a gateway flaw."),
  row("EU", "baseline", "same", "No rule fired."),
  row("TW", "elevated", "up", "SAMPLE: a Taiwanese vendor's flaw was added to CISA's list."),
  row("JP", "baseline", "new", "No rule fired."),
];

const M = metrics();

function lens(analysis: string): Brief["taiwan_lens"] {
  return {
    analysis, item_ids: [], source_ids: [], rows: TAIWAN_LENS_ROWS.map((r) => ({ row: r, text: null, item_ids: [], source_ids: [] })),
    japan: { text: null, item_ids: [], source_ids: [] }, kev_lines: kevLines(M), kev_note: KEV_ABSENCE_NOTE, watch_windows: [],
  };
}

function brief(over: Partial<Brief> = {}): Brief {
  return Brief.parse({
    schema_version: 1, date: D, edition: "full", generated_at: at(D, "05:08:00"), published_at: at(D, "05:12:40"),
    data_only_published_at: at(D, "04:48:03"), late: false, data_cutoff_utc: CUTOFF,
    lead: [
      { text: "SAMPLE: Attackers hit a NAS flaw within a day of disclosure.", item_ids: ["cve-2026-104935"], gap: false },
      { text: "SAMPLE: The Gap held steady.", item_ids: [], gap: true },
    ],
    angle: null,
    regions: { rows: ROWS, global: { item_count: 3 }, signals: [] },
    gap: {
      headline: M.headline.text, second_line: M.headline.second_line, status: "ok", metrics_file: `metrics/${D}.json`,
      metrics_sha256: "a".repeat(64), as_of: CUTOFF,
    },
    items: ITEMS,
    actors_seen: [{ name: "SAMPLE Panda", actor_id: null, nexus: "unknown", item_ids: ["inc-sample-retail-jp"], cross_link: null }],
    taiwan_lens: lens("SAMPLE: Taiwan's home vendors had one new KEV listing this week. The rows below give the detail."),
    scoreboard: { entries: [], last: null },
    week_in_review: null, corrections: [], elsewhere: [], epss_movers: [], feeds_stale: [],
    sources: [source(1), source(2)],
    computed: { word_count: 900, reading_minutes: 5, item_count: ITEMS.length, ai_linked: { linked: 2, total: 6 }, source_count: 2, publisher_count: 1 },
    ...over,
  });
}

/** A data-only item for one new KEV CVE (§4.5). */
function kevItem(cveId: string, vendor: NonNullable<Item["vendor"]>, regions: Item["regions"]): Item {
  return item({
    id: cveId.toLowerCase(), kind: "exploited_flaw", headline: `SAMPLE: ${vendor.name} flaw added to CISA's list`, why_it_matters: null,
    ai_role: "unassessed", claim_type: "government", regions, cve_ids: [cveId], public_exploit: "no", vendor,
    cves: [cve({ cve_id: cveId, vendor, date_published: "2026-10-30", kev: { date_added: CUTOFF, due_date: "2026-11-27", ransomware: "unknown", catalog_version: "2026.11.06" }, patch: null })],
  });
}

const STALE_FEED = { id: "sample-feed", name: "SAMPLE feed", status: "stale" as const, newest: "2026-11-05", stale_since: "2026-11-07" };

function dataOnlyBrief(over: Partial<Brief> = {}): Brief {
  const items = [
    kevItem("CVE-2026-104950", { id: null, name: "SAMPLE Router Co", country: "TW" }, ["TW"]),
    kevItem("CVE-2026-104951", { id: null, name: "SAMPLE Mail Co", country: null }, ["GLOBAL"]),
  ];
  return brief({
    edition: "data_only", generated_at: at(D, "04:47:30"), published_at: at(D, "04:48:03"), lead: [], items, actors_seen: [],
    taiwan_lens: lens(""), feeds_stale: [STALE_FEED],
    computed: { word_count: 300, reading_minutes: 2, item_count: 2, ai_linked: { linked: 0, total: 2 }, source_count: 2, publisher_count: 1 },
    ...over,
  });
}

// ── Expected strings ─────────────────────────────────────────────────────────────────────────────

const AI_KEY = "Solid: other AI finders · light: Anthropic · hatched: provisional, credits arrive late";
const FLOOD_CAPTION = "CVE records published (CVE.org); not comparable to disclosure counts elsewhere. Hatched: Linux kernel records, which "
  + "automated assignment inflates. 3,121 of 44,944 had no CVSS score from the CNA or CISA.";
const WINDOW_CAPTION = `${WINDOW_LABEL} Shares and medians use KEV additions whose CVE was published at most a year earlier; bars show how `
  + "many CISA listed, so a rise that only reflects CISA listing more is visible. Also listed in 26 weeks: 22 flaws disclosed more than a year earlier.";
const IN_KEV = ["AI-credited and now on CISA's list: 1 since 1 Jan 2025", "CVE-2026-111497: Codex Security (openai-codex), listed 27 Oct (US date)"];
const FOOTER = ["data to 6 Nov 2026 UTC · KEV catalog 2026.11.06 · CVE List cve_2026-11-06_2100Z · AI-finder list v1",
  "Weeks before 2 Nov 2026: reconstructed from current records."];
const REGION_PARTS = [
  "US ●●●○ HIGH ↑", "SAMPLE: an agency alert on a gateway flaw.",
  "EU ●○○○ BASELINE =", "No rule fired.",
  "TW ●●○○ ELEVATED ↑", "SAMPLE: a Taiwanese vendor's flaw was added to CISA's list.",
  "JP ●○○○ BASELINE", "No rule fired.",
];
const LENS_PARTS = [
  "KEV additions for Taiwanese vendors: 0 in 30 days, 1 in 90, to 6 Nov (US date).",
  "KEV additions for Japanese vendors: 0 in 30 days, 0 in 90, to 6 Nov (US date).",
  KEV_ABSENCE_NOTE,
];

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────

describe("EMPTY_LINES", () => {
  it("holds §7's empty and data-only texts", () => {
    expect(EMPTY_LINES).toEqual({
      no_items: "No item cleared the bar today.", no_rows: "No other items today.", no_actors: "No named actors today.",
      no_elsewhere: "Nothing else today.", not_data_only: "Not in a data-only edition.", gap_missing: "The Gap is not available for this edition.",
    });
  });
});

describe("masthead", () => {
  it("mastheadLine gives §7's examples", () => {
    const b = brief({ computed: { ...brief().computed, ai_linked: { linked: 4, total: 7 } } });
    expect(mastheadLine(b)).toBe("Published 05:12 Taipei · 5 min read · AI-linked: 4 of 7 items");
    expect(mastheadLine(dataOnlyBrief())).toBe("Published 04:48 Taipei · 2 min read · AI roles unassessed");
  });

  it("mastheadLine marks a late edition and reads its time in Taipei", () => {
    const b = brief({ published_at: "2026-11-08T00:12:40Z", late: true });
    expect(mastheadLine(b)).toBe("Published 08:12 Taipei (late) · 5 min read · AI-linked: 2 of 6 items");
    const one = brief({ items: [EXPLOITED], computed: { ...brief().computed, item_count: 1, ai_linked: { linked: 1, total: 1 } } });
    expect(mastheadLine(one)).toBe("Published 05:12 Taipei · 5 min read · AI-linked: 1 of 1 item");
  });

  it("gapHeadlineLine shows the stored headline unless the Gap is missing or failed GAP_MATCH", () => {
    expect(gapHeadlineLine(brief())).toBe(M.headline.text);
    expect(gapHeadlineLine(brief(), false)).toBeNull();
    const stale = brief({ gap: { ...brief().gap, status: "stale", as_of: "2026-11-05", metrics_file: "metrics/2026-11-07.json" } });
    expect(gapHeadlineLine(stale)).toBe(M.headline.text);
    const missing = brief({ gap: { headline: "", second_line: "", status: "missing", metrics_file: null, metrics_sha256: null, as_of: null } });
    expect(gapHeadlineLine(missing)).toBeNull();
  });

  it("editionNotice: null for full; the partial notice names stale feeds; a data-only edition names them too", () => {
    expect(editionNotice(brief())).toBeNull();
    const partial = brief({
      edition: "partial",
      feeds_stale: [STALE_FEED, { id: "sample-failed", name: "SAMPLE failed feed", status: "failed", newest: null, stale_since: null }],
    });
    expect(editionNotice(partial)).toBe(
      "Some feeds are stale: SAMPLE feed (since 7 Nov), SAMPLE failed feed; their figures are shown with their own dates.");
    const longStale = brief({ edition: "partial", feeds_stale: [{ ...STALE_FEED, stale_since: "2025-12-30" }] });
    expect(editionNotice(longStale)).toBe("Some feeds are stale: SAMPLE feed (since 30 Dec 2025); their figures are shown with their own dates.");
    expect(editionNotice(dataOnlyBrief())).toBe("Some feeds are stale: SAMPLE feed (since 7 Nov); their figures are shown with their own dates.");
    expect(editionNotice(dataOnlyBrief({ feeds_stale: [] }))).toBeNull();
  });

  it("briefDescription: the Lead, else the Gap headline, else the edition text, cut to 300 characters", () => {
    expect(briefDescription(brief())).toBe("SAMPLE: Attackers hit a NAS flaw within a day of disclosure. SAMPLE: The Gap held steady.");
    const fromGap = briefDescription(dataOnlyBrief()); // the D.3 headline is over 300 characters
    expect(fromGap.length).toBeLessThanOrEqual(300);
    expect(fromGap.endsWith("…")).toBe(true);
    expect(M.headline.text.startsWith(fromGap.slice(0, -1))).toBe(true);
    const missing = dataOnlyBrief({ gap: { headline: "", second_line: "", status: "missing", metrics_file: null, metrics_sha256: null, as_of: null } });
    expect(briefDescription(missing)).toBe(EDITION_INFO.data_only);
    const long = "SAMPLE: " + "the flaw was patched and then exploited again ".repeat(10).trim() + ".";
    const cut = briefDescription(brief({ lead: [{ text: long, item_ids: [], gap: true }] }));
    expect(cut.length).toBeLessThanOrEqual(300);
    expect(cut.endsWith("…")).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(long.charAt(cut.length - 1)).toBe(" ");
  });
});

describe("regionSummary", () => {
  it("gives §7's example head, then the reason", () => {
    expect(regionSummary(ROWS[2]!)).toEqual({ head: "TW ●●○○ ELEVATED ↑", reason: "SAMPLE: a Taiwanese vendor's flaw was added to CISA's list." });
  });

  it("shows ↓ and =, and no glyph with no edition yesterday", () => {
    expect(regionSummary(row("US", "high", "down", "r")).head).toBe("US ●●●○ HIGH ↓");
    expect(regionSummary(ROWS[1]!).head).toBe("EU ●○○○ BASELINE =");
    expect(regionSummary(ROWS[3]!).head).toBe("JP ●○○○ BASELINE");
    expect(regionSummary(row("TW", "critical", "up", "r")).head).toBe("TW ●●●● CRITICAL ↑");
  });
});

describe("cardKicker", () => {
  it("gives §7's example", () => {
    expect(cardKicker(EXPLOITED)).toBe("●●●○ HIGH · AI-FOUND · US · TW · QNAP (TW)");
  });

  it("covers landmark, kind-only, claimed, unassessed, no-AI and countryless vendors", () => {
    expect(cardKicker(AI_ITEM)).toBe("LANDMARK · AI CAPABILITY · AI-FOUND · AI role claimed by SAMPLE Lab · GLOBAL");
    expect(cardKicker(POLICY)).toBe("POLICY · EU");
    expect(cardKicker(item({ id: "eco-sample", kind: "ecosystem", headline: "SAMPLE", landmark: true }))).toBe("LANDMARK · ECOSYSTEM · GLOBAL");
    expect(cardKicker(BREACH)).toBe("●●○○ ELEVATED · JP");
    expect(cardKicker(CRITICAL)).toBe("●○○○ WATCH · GLOBAL · SAMPLE Corp");
    expect(cardKicker(dataOnlyBrief().items[0]!)).toBe("UNRATED · AI: unassessed · TW · SAMPLE Router Co (TW)");
    const reported = item({ ...BREACH, severity: "critical", ai_role: "ai_weapon", ai_confidence: "reported", ai_role_secondary: "ai_target" });
    expect(cardKicker(reported)).toBe("●●●● CRITICAL · AI-WEAPON · JP"); // the secondary role is never rendered
  });
});

describe("cveTimeline", () => {
  it("gives §7's example", () => {
    expect(cveTimeline(cve(), D)).toBe("CVE published 2 Nov → on CISA's list +1 day → US deadline 5 Nov · patch: 3 Nov");
  });

  it("reads +0 days, before publication and not on CISA's list", () => {
    const sameDay = cve({ kev: { ...cve().kev!, date_added: "2026-11-02" } });
    expect(cveTimeline(sameDay, D)).toBe("CVE published 2 Nov → on CISA's list +0 days → US deadline 5 Nov · patch: 3 Nov");
    const before = cve({ kev: { ...cve().kev!, date_added: "2026-11-01" } });
    expect(cveTimeline(before, D)).toBe("CVE published 2 Nov → on CISA's list before publication → US deadline 5 Nov · patch: 3 Nov");
    expect(cveTimeline(CRITICAL.cves[0]!, D))
      .toBe("CVE published 4 Nov → not on CISA's list → exploited (reported in the news) 6 Nov · patch: none cited");
  });

  it("adds the earliest non-KEV evidence and shows the year when it is not the edition's", () => {
    const old = cve({
      date_published: "2019-03-12",
      kev: { date_added: "2026-12-18", due_date: "2027-01-08", ransomware: "known", catalog_version: "2026.12.18" },
      exploitation_evidence: [
        { date: "2026-12-14", basis: "cert_confirmed", source_url: "https://www.twcert.org.tw/ct-sample" },
        { date: "2026-12-18", basis: "kev_listed", source_url: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog" },
        { date: "2026-12-15", basis: "vendor_confirmed", source_url: "https://www.qnap.com/en/security-advisory/ct-sample" },
      ],
      patch: { date: "2026-12-16", basis: "vendor_advisory", source_url: "https://www.qnap.com/en/security-advisory/ct-sample" },
    });
    expect(cveTimeline(old, "2026-12-20")).toBe(
      "CVE published 12 Mar 2019 → on CISA's list +2,838 days → US deadline 8 Jan 2027 → exploited (confirmed by a national CERT) 14 Dec · patch: 16 Dec");
  });
});

describe("releaseLine", () => {
  it("gives §7's example", () => {
    expect(releaseLine(release({ date: "2026-11-10" }), "2026-11-11")).toBe("Released 10 Nov · 63 fixes · 2 exploited · 5 critical");
  });

  it("leaves out an unrated critical count and says 1 fix", () => {
    expect(releaseLine(release({ fixes_n: 1, exploited_n: 0, exploited_cve_ids: [], critical_n: null }), D)).toBe("Released 5 Nov · 1 fix · 0 exploited");
    expect(releaseLine(release({ fixes_n: 1204 }), D)).toBe("Released 5 Nov · 1,204 fixes · 2 exploited · 5 critical");
  });
});

describe("the Gap panel", () => {
  it("gapSecondLine is the stored second line, null when the Gap is missing", () => {
    expect(gapSecondLine(brief())).toBe(M.headline.second_line);
    expect(gapSecondLine(brief({ gap: { headline: "", second_line: "", status: "missing", metrics_file: null, metrics_sha256: null, as_of: null } }))).toBeNull();
  });

  it("gapNotices: none when all is fresh; the stale-Gap line and each stale panel block, dated", () => {
    expect(gapNotices(brief(), M)).toEqual([]);
    const stale = brief({ gap: { ...brief().gap, status: "stale", as_of: "2026-11-05", metrics_file: "metrics/2026-11-07.json" } });
    const m = metrics((x) => {
      x.blocks.window = { status: "stale", as_of: "2026-11-04", note: null };
      x.blocks.ai_credited = { status: "stale", as_of: "2026-11-03", note: "SAMPLE: the credit list could not be read today." };
      x.blocks.kev = { status: "stale", as_of: "2026-11-04", note: null }; // not a panel block
    });
    expect(gapNotices(stale, m)).toEqual([
      "Gap figures are from 5 Nov; today's could not be computed.",
      "Window data from 4 Nov.",
      "AI-credited data from 3 Nov: SAMPLE: the credit list could not be read today.",
    ]);
    expect(gapNotices(stale, null)).toEqual(["Gap figures are from 5 Nov; today's could not be computed."]);
    const missing = brief({ gap: { headline: "", second_line: "", status: "missing", metrics_file: null, metrics_sha256: null, as_of: null } });
    expect(gapNotices(missing, m)).toEqual([]);
  });

  it("chartCaptions: the three captions, chart C's key and the in-KEV lines", () => {
    expect(chartCaptions(M)).toEqual({ flood: FLOOD_CAPTION, window: WINDOW_CAPTION, ai: [AI_KEY, AI_CREDIT_CAPTION], aiInKev: IN_KEV });
    const none = metrics((x) => { x.ai_credited!.in_kev = { since: "2025-01-01", n: 0, entries: [] }; x.window!.w26 = { ...W26, old_listed_n: 1 }; });
    expect(chartCaptions(none).aiInKev).toEqual(["AI-credited and now on CISA's list: 0 since 1 Jan 2025"]);
    expect(chartCaptions(none).window.endsWith("Also listed in 26 weeks: 1 flaw disclosed more than a year earlier.")).toBe(true);
  });

  it("chartCaptions: a null block's entry is '<Chart name> is not available today.' and aiInKev is then null", () => {
    const failed = { status: "failed" as const, as_of: null, note: null };
    const m = metrics((x) => {
      x.blocks.flood = failed; x.blocks.window = failed; x.blocks.ai_credited = failed;
      x.flood = null; x.window = null; x.ai_credited = null;
    });
    expect(chartCaptions(m)).toEqual({
      flood: "The Flood is not available today.", window: "The Window is not available today.", ai: ["AI-credited is not available today."], aiInKev: null,
    });
  });

  it("fixSideLines: the dashboard and GitHub lines when set, each dated, and FIX_SIDE_CAPTION always", () => {
    expect(fixSideLines(FixSide.parse({ anthropic_cvd: null, ghsa_unfixed: null }), D)).toEqual([FIX_SIDE_CAPTION]);
    expect(fixSideLines(FixSide.parse({ anthropic_cvd: CVD, ghsa_unfixed: GHSA }), D)).toEqual([
      "Anthropic disclosure dashboard (one lab, open source only, self-reported), revision 40, 5 Nov: 6,009 confirmed findings, 5,087 disclosed, 629 patched upstream.",
      "2% of GitHub-reviewed advisories published 30 to 120 days ago still list no fixed version (19 of 1,229, 6 Nov).",
      FIX_SIDE_CAPTION,
    ]);
    const stale = FixSide.parse({ anthropic_cvd: { ...CVD, status: "stale", revision: "38", as_of: "2026-10-20", found_n: null }, ghsa_unfixed: null });
    expect(fixSideLines(stale, D)[0]).toBe(
      "Anthropic disclosure dashboard (one lab, open source only, self-reported), revision 38, 20 Oct: 5,087 disclosed, 629 patched upstream. Not updated since 20 Oct.");
    const bare = FixSide.parse({ anthropic_cvd: { ...CVD, found_n: null, disclosed_n: null, patched_n: null, as_of: "2025-12-20" }, ghsa_unfixed: null });
    expect(fixSideLines(bare, "2026-01-05")[0]).toBe("Anthropic disclosure dashboard (one lab, open source only, self-reported), revision 40, 20 Dec 2025.");
    // No share from fewer than MIN_N (30) cases: the GitHub line is left out below it.
    const few = (n_unfixed: number, n_total: number) => FixSide.parse({ anthropic_cvd: null, ghsa_unfixed: { ...GHSA, n_unfixed, n_total, share: n_unfixed / n_total } });
    expect(fixSideLines(few(1, 5), D)).toEqual([FIX_SIDE_CAPTION]);
    expect(fixSideLines(few(1, 29), D)).toEqual([FIX_SIDE_CAPTION]);
    expect(fixSideLines(few(3, 30), D)[0]).toBe("10% of GitHub-reviewed advisories published 30 to 120 days ago still list no fixed version (3 of 30, 6 Nov).");
  });

  it("gapFooter: footerLine(), then the reconstructed-weeks line while the axis starts before live_from", () => {
    expect(footerLine(M)).toBe(FOOTER[0]);
    expect(gapFooter(M)).toEqual(FOOTER);
    expect(gapFooter(metrics((x) => { x.series.live_from = x.series.weeks[0]!; }))).toEqual([FOOTER[0]]);
  });
});

describe("lensKevLines", () => {
  it("gives the stored TW and JP lines and the fixed note", () => {
    expect(lensKevLines(brief().taiwan_lens)).toEqual(LENS_PARTS);
  });
});

describe("scriptParts and scriptText", () => {
  const ITEM_PARTS = [
    "●●●○ HIGH · AI-FOUND · US · TW · QNAP (TW)", "CVE published 2 Nov → on CISA's list +1 day → US deadline 5 Nov · patch: 3 Nov",
    "●●●○ HIGH · US · GLOBAL · SAMPLE Software (US)", "Released 5 Nov · 63 fixes · 2 exploited · 5 critical",
    "●●○○ ELEVATED · JP",
    "●○○○ WATCH · GLOBAL · SAMPLE Corp", "CVE published 4 Nov → not on CISA's list → exploited (reported in the news) 6 Nov · patch: none cited",
    "LANDMARK · AI CAPABILITY · AI-FOUND · AI role claimed by SAMPLE Lab · GLOBAL",
    "POLICY · EU",
  ];

  it("lists a full edition's script strings in page order, from the masthead to the end of the Lens", () => {
    const m = metrics((x) => { x.fix_side = { anthropic_cvd: CVD, ghsa_unfixed: GHSA }; });
    const b = brief();
    expect(scriptParts(b, m)).toEqual([
      "Published 05:12 Taipei · 5 min read · AI-linked: 2 of 6 items",
      M.headline.text,
      ...REGION_PARTS,
      M.headline.second_line,
      FLOOD_CAPTION, WINDOW_CAPTION, AI_KEY, AI_CREDIT_CAPTION, ...IN_KEV,
      ...fixSideLines(m.fix_side, D),
      ...FOOTER,
      ...ITEM_PARTS,
      ...LENS_PARTS,
    ]);
    expect(fixSideLines(m.fix_side, D)).toHaveLength(3);
  });

  it("groups Also-today rows by head as the page does, whatever the stored order", () => {
    const shuffled = brief({ items: [EXPLOITED, PATCH, BREACH, POLICY, AI_ITEM, CRITICAL] });
    const parts = scriptParts(shuffled, M);
    const idx = (s: string) => parts.indexOf(s);
    expect(idx("●○○○ WATCH · GLOBAL · SAMPLE Corp")).toBeLessThan(idx("LANDMARK · AI CAPABILITY · AI-FOUND · AI role claimed by SAMPLE Lab · GLOBAL"));
    expect(idx("LANDMARK · AI CAPABILITY · AI-FOUND · AI role claimed by SAMPLE Lab · GLOBAL")).toBeLessThan(idx("POLICY · EU"));
  });

  it("a data-only edition: its notice, UNRATED kickers, no rows, and the data-only lines in §06 and the Lens", () => {
    const b = dataOnlyBrief();
    expect(scriptParts(b, M)).toEqual([
      "Published 04:48 Taipei · 2 min read · AI roles unassessed",
      M.headline.text,
      "Some feeds are stale: SAMPLE feed (since 7 Nov); their figures are shown with their own dates.",
      ...REGION_PARTS,
      M.headline.second_line,
      FLOOD_CAPTION, WINDOW_CAPTION, AI_KEY, AI_CREDIT_CAPTION, ...IN_KEV,
      FIX_SIDE_CAPTION,
      ...FOOTER,
      "UNRATED · AI: unassessed · TW · SAMPLE Router Co (TW)", "CVE published 30 Oct → on CISA's list +7 days → US deadline 27 Nov · patch: none cited",
      "UNRATED · AI: unassessed · GLOBAL · SAMPLE Mail Co", "CVE published 30 Oct → on CISA's list +7 days → US deadline 27 Nov · patch: none cited",
      EMPTY_LINES.no_rows,
      EMPTY_LINES.not_data_only,
      EMPTY_LINES.not_data_only,
      ...LENS_PARTS,
    ]);
  });

  it("an edition with no items and no metrics: the Gap headline stays, the panel and sections read their empty lines", () => {
    const b = brief({ items: [], actors_seen: [], computed: { ...brief().computed, item_count: 0, ai_linked: { linked: 0, total: 0 } } });
    expect(scriptParts(b, null)).toEqual([
      "Published 05:12 Taipei · 5 min read · AI-linked: 0 of 0 items",
      M.headline.text,
      ...REGION_PARTS,
      EMPTY_LINES.gap_missing,
      EMPTY_LINES.no_items,
      EMPTY_LINES.no_rows,
      EMPTY_LINES.no_actors,
      ...LENS_PARTS,
    ]);
  });

  it("a missing Gap, or a brief that failed GAP_MATCH, drops the headline and shows gap_missing", () => {
    const missing = brief({ gap: { headline: "", second_line: "", status: "missing", metrics_file: null, metrics_sha256: null, as_of: null } });
    for (const parts of [scriptParts(missing, M), scriptParts(brief(), M, { gapOk: false })]) {
      expect(parts).not.toContain(M.headline.text);
      expect(parts).not.toContain(M.headline.second_line);
      expect(parts).not.toContain(FLOOD_CAPTION);
      expect(parts.slice(1, 10)).toEqual([...REGION_PARTS, EMPTY_LINES.gap_missing]);
    }
  });

  it("a stale Gap adds its notices after the second line", () => {
    const stale = brief({ gap: { ...brief().gap, status: "stale", as_of: "2026-11-05", metrics_file: "metrics/2026-11-07.json" } });
    const parts = scriptParts(stale, M);
    expect(parts.slice(10, 12)).toEqual([M.headline.second_line, "Gap figures are from 5 Nov; today's could not be computed."]);
  });

  it("counts no model field and nothing after the Lens; scriptText joins the parts with newlines", () => {
    const b = brief();
    const parts = scriptParts(b, M);
    for (const field of [...b.lead.map((l) => l.text), ...b.items.map((i) => i.headline), b.taiwan_lens.analysis, EMPTY_LINES.no_elsewhere]) {
      expect(parts.some((p) => p.includes(field))).toBe(false);
    }
    expect(parts.every((p) => p.length > 0)).toBe(true);
    const text = scriptText(b, M);
    expect(text).toBe(parts.join("\n"));
    expect(countWords(text)).toBe(parts.reduce((n, p) => n + countWords(p), 0));
    expect(scriptText(b, M, { gapOk: false })).toBe(scriptParts(b, M, { gapOk: false }).join("\n"));
  });

  it("pips, arrows and separators are not words", () => {
    expect(countWords("TW ●●○○ ELEVATED ↑")).toBe(2);
    expect(countWords("●●●○ HIGH · AI-FOUND · US · TW · QNAP (TW)")).toBe(6);
    expect(countWords("CVE published 2 Nov → on CISA's list +1 day → US deadline 5 Nov · patch: 3 Nov")).toBe(16);
  });
});
