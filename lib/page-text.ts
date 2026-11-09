// Script-written page text (SPEC §7 "Script-written page text"). Every counted script string the page
// shows from the masthead to the end of the Taiwan Lens is built here and nowhere else: components render
// these outputs (never their own copies) and mark each with `data-words`, and scriptText() joins them in
// page order, so the words rule (§4.5 pageWords, §4.12) counts exactly what the page shows. Pure: no
// config, no clock, no I/O. Dates come from lib/format.ts, through §5.2's fmtDate() where the year shows
// only when it is not the edition's; numbers go through §5.2's display helpers.

import { daysBetween } from "./dates";
import { shortDate, taipeiTime } from "./format";
import { rowsByHead, TOP_STORY_COUNT } from "./items";
import { footerLine, inKevLine } from "./metrics/headline";
import { fmtDate, fmtInt, pct } from "./metrics/stats";
import { cutAtWord } from "./regions";
import type { Brief, Computed, FeedStale, GapRef, RegionRow, TaiwanLens } from "./schema/brief";
import type { CveBlock, Item, ReleaseBlock } from "./schema/item";
import type { FixSide, Metrics } from "./schema/metrics";
import {
  AI_CREDIT_CAPTION, AI_ROLE_INFO, CLAIMED_CHIP, EDITION_INFO, EXPLOITATION_BASIS_INFO, FIX_SIDE_CAPTION, KIND_INFO,
  REGION_CHANGE, REGION_LEVEL_INFO, SEVERITY_INFO, WINDOW_LABEL,
} from "./vocab";

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────

/** What cardKicker(), cveTimeline() and releaseLine() read from an item. A published Item satisfies it. */
export type CardItem = Pick<Item, "kind" | "severity" | "landmark" | "ai_role" | "ai_confidence" | "ai_claimant" | "regions" | "vendor" | "cves" | "release">;

/** What regionSummary() reads from a region row. */
export type SummaryRow = Pick<RegionRow, "code" | "level" | "change" | "reason">;

/**
 * What the page text reads from a brief. A published Brief satisfies it; a draft-mode caller passes a
 * provisional view (regions from computeRegions() on the draft, §4.12). No count depends on the values of
 * `published_at`, `reading_minutes` or `ai_linked`, only on their presence, so a provisional view may fill
 * them with placeholders.
 */
export interface PageBrief {
  date: Brief["date"];
  edition: Brief["edition"];
  published_at: Brief["published_at"];
  late: Brief["late"];
  lead: readonly Pick<Brief["lead"][number], "text">[];
  computed: Pick<Computed, "reading_minutes" | "ai_linked">;
  gap: Pick<GapRef, "headline" | "second_line" | "status" | "as_of">;
  regions: { rows: readonly SummaryRow[] };
  items: readonly CardItem[];
  actors_seen: readonly unknown[];
  taiwan_lens: Pick<TaiwanLens, "kev_lines" | "kev_note">;
  feeds_stale: readonly Pick<FeedStale, "name" | "stale_since">[];
}

// ── Fixed lines ──────────────────────────────────────────────────────────────────────────────────

/**
 * The one-line texts BriefView shows in place of an empty section (§7 "BriefView and section order").
 * `no_elsewhere` and §09's `not_data_only` sit after the Taiwan Lens, so they are never counted;
 * §06's and the Lens analysis's `not_data_only`, and the others, are.
 */
export const EMPTY_LINES = {
  no_items: "No item cleared the bar today.",
  no_rows: "No other items today.",
  no_actors: "No named actors today.",
  no_elsewhere: "Nothing else today.",
  not_data_only: "Not in a data-only edition.",
  gap_missing: "The Gap is not available for this edition.",
} as const;

/** Chart C's text key (§7 chart table), the first line of chartCaptions().ai. */
const AI_KEY = "Solid: other AI finders · light: Anthropic · hatched: provisional, credits arrive late";

/** The chart names a null block's caption uses: "<Chart name> is not available today." */
const CHART_NAMES = { flood: "The Flood", window: "The Window", ai: "AI-credited" } as const;

/** The Gap panel's metrics blocks, in panel order, with the name a stale-block notice uses. */
const PANEL_BLOCKS = [["flood", "Flood"], ["window", "Window"], ["ai_credited", "AI-credited"], ["fix_side", "Fix-side"]] as const;

const plural = (n: number, one: string, many: string) => `${fmtInt(n)} ${n === 1 ? one : many}`;

// ── Masthead ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The masthead's line under the date (§7 EditionMasthead): "Published 05:12 Taipei · 5 min read ·
 * AI-linked: 4 of 7 items"; a data-only edition ends "AI roles unassessed"; "(late)" follows the time
 * when the brief was published after `stale_after`.
 */
export function mastheadLine(brief: Pick<PageBrief, "edition" | "published_at" | "late" | "computed">): string {
  const time = `Published ${taipeiTime(brief.published_at)} Taipei${brief.late ? " (late)" : ""}`;
  const read = `${fmtInt(brief.computed.reading_minutes)} min read`;
  const { linked, total } = brief.computed.ai_linked;
  const ai = brief.edition === "data_only" ? "AI roles unassessed" : `AI-linked: ${fmtInt(linked)} of ${plural(total, "item", "items")}`;
  return [time, read, ai].join(" · ");
}

/**
 * `gap.headline` as stored, as the masthead shows it (§5.8: the Gap panel does not repeat it); null when
 * EditionMasthead hides it: the Gap is missing, or the brief failed GAP_MATCH (`gapOk` false).
 */
export function gapHeadlineLine(brief: Pick<PageBrief, "gap">, gapOk = true): string | null {
  if (!gapOk || brief.gap.status === "missing" || !brief.gap.headline) return null;
  return brief.gap.headline;
}

/**
 * The masthead notice (`role="note"`). Null for a full edition. A partial edition names its stale feeds:
 * "Some feeds are stale: <name> (since <date>), …; their figures are shown with their own dates." A
 * data-only edition gives the same sentence when feeds are stale, else null (the dateline, the masthead
 * line and §01's EDITION_INFO.data_only already say what the edition is).
 */
export function editionNotice(brief: Pick<PageBrief, "date" | "edition" | "feeds_stale">): string | null {
  if (brief.edition === "full" || brief.feeds_stale.length === 0) return null;
  const names = brief.feeds_stale.map((f) => (f.stale_since ? `${f.name} (since ${fmtDate(f.stale_since, brief.date)})` : f.name));
  return `Some feeds are stale: ${names.join(", ")}; their figures are shown with their own dates.`;
}

/**
 * Page metadata and the feed only, so never counted (§6 `/feed.xml`): the Lead sentences joined, or
 * `gap.headline` when the Lead is empty, else the edition's EDITION_INFO text; whitespace collapsed and
 * cut to 300 characters at a word boundary.
 */
export function briefDescription(brief: Pick<PageBrief, "edition" | "lead" | "gap">): string {
  const lead = brief.lead.map((l) => l.text).join(" ");
  const text = [lead, brief.gap.headline, EDITION_INFO[brief.edition]].map((t) => t.replace(/\s+/g, " ").trim()).find(Boolean)!;
  return cutAtWord(text, 300);
}

// ── Regions ──────────────────────────────────────────────────────────────────────────────────────

/** A region row's one line: `head` "TW ●●○○ ELEVATED ↑" (no glyph with no edition yesterday), then `reason`. */
export interface RegionSummary {
  head: string;
  reason: string;
}

/** The closed RegionRow's line (§7): code, pips, level word and change glyph, then the stored reason. */
export function regionSummary(row: SummaryRow): RegionSummary {
  const info = REGION_LEVEL_INFO[row.level];
  const glyph = REGION_CHANGE[row.change];
  return { head: [row.code, info.pips, info.word, glyph].filter(Boolean).join(" "), reason: row.reason };
}

// ── Items ────────────────────────────────────────────────────────────────────────────────────────

/** The level part of a kicker: pips and word, "LANDMARK · <KIND>", the kind label, or UNRATED (§7 SeverityPips). */
function levelPart(item: Pick<CardItem, "kind" | "severity" | "landmark">): string {
  if (item.severity) return `${SEVERITY_INFO[item.severity].pips} ${SEVERITY_INFO[item.severity].word}`;
  const kind = KIND_INFO[item.kind];
  if (kind.severity === "required") return "UNRATED"; // a threat kind without severity: a data-only item
  return item.landmark ? `LANDMARK · ${kind.label.toUpperCase()}` : kind.label.toUpperCase();
}

/** The AI part of a kicker: the role chip (upper case, as chips show), "AI: unassessed", then CLAIMED_CHIP when claimed. */
function aiPart(item: Pick<CardItem, "ai_role" | "ai_confidence" | "ai_claimant">): string[] {
  const chip = AI_ROLE_INFO[item.ai_role].chip;
  if (!chip) return [];
  if (item.ai_role === "unassessed") return [chip];
  const out = [chip.toUpperCase()];
  if (item.ai_confidence === "claimed" && item.ai_claimant) out.push(CLAIMED_CHIP.replace("{claimant}", item.ai_claimant));
  return out;
}

/**
 * The item kicker (§7 ItemCard, Appendix A.3): "●●●○ HIGH · AI-FOUND · US · TW · QNAP (TW)". Level (or
 * LANDMARK and the kind, the kind label, UNRATED), the primary AI role only, every region code, and the
 * vendor as text with its country, never a flag.
 */
export function cardKicker(item: Omit<CardItem, "cves" | "release">): string {
  const vendor = item.vendor ? (item.vendor.country ? `${item.vendor.name} (${item.vendor.country})` : item.vendor.name) : null;
  return [levelPart(item), ...aiPart(item), ...item.regions, vendor].filter((p): p is string => Boolean(p)).join(" · ");
}

/** "confirmed by the vendor": EXPLOITATION_BASIS_INFO with a lower-case first letter. */
const basisWord = (basis: keyof typeof EXPLOITATION_BASIS_INFO) => {
  const w = EXPLOITATION_BASIS_INFO[basis];
  return w.charAt(0).toLowerCase() + w.slice(1);
};

/**
 * A CVE block's timeline (§7): steps joined with " → ", then " · patch: <date>" or " · patch: none cited".
 * "CVE published 2 Nov → on CISA's list +1 day → US deadline 5 Nov · patch: 3 Nov". The KEV lag is
 * `kev.date_added` minus `date_published` ("+0 days" the same day, "before publication" when negative); off KEV,
 * "not on CISA's list"; then the earliest non-KEV exploitation evidence, "exploited (<basis>) <date>".
 * Dates show the year when it is not the edition's.
 */
export function cveTimeline(cve: Pick<CveBlock, "date_published" | "kev" | "exploitation_evidence" | "patch">, editionDate: string): string {
  const d = (date: string) => fmtDate(date, editionDate);
  const steps = [`CVE published ${d(cve.date_published)}`];
  if (cve.kev) {
    const lag = daysBetween(cve.date_published, cve.kev.date_added);
    steps.push(`on CISA's list ${lag < 0 ? "before publication" : `+${plural(lag, "day", "days")}`}`);
    steps.push(`US deadline ${d(cve.kev.due_date)}`);
  } else {
    steps.push("not on CISA's list");
  }
  const evidence = cve.exploitation_evidence.filter((e) => e.basis !== "kev_listed").reduce<CveBlock["exploitation_evidence"][number] | null>(
    (first, e) => (!first || e.date < first.date ? e : first), null);
  if (evidence) steps.push(`exploited (${basisWord(evidence.basis)}) ${d(evidence.date)}`);
  return `${steps.join(" → ")} · patch: ${cve.patch ? d(cve.patch.date) : "none cited"}`;
}

/**
 * A patch batch's release line (§7): "Released 10 Nov · 63 fixes · 2 exploited · 5 critical"; the
 * critical count is left out when the vendor gives no rating.
 */
export function releaseLine(release: Pick<ReleaseBlock, "date" | "fixes_n" | "exploited_n" | "critical_n">, editionDate: string): string {
  const parts = [`Released ${fmtDate(release.date, editionDate)}`, plural(release.fixes_n, "fix", "fixes"), `${fmtInt(release.exploited_n)} exploited`];
  if (release.critical_n !== null) parts.push(`${fmtInt(release.critical_n)} critical`);
  return parts.join(" · ");
}

/** The card's script line: the release line for a patch batch, else the first CVE block's timeline, else null. */
function cardLine(item: CardItem, editionDate: string): string | null {
  if (item.release) return releaseLine(item.release, editionDate);
  const cve = item.cves[0];
  return cve ? cveTimeline(cve, editionDate) : null;
}

// ── The Gap ──────────────────────────────────────────────────────────────────────────────────────

/** `gap.second_line` as stored, the Gap panel's opening line (§5.8); null when the Gap is missing. */
export function gapSecondLine(brief: Pick<PageBrief, "gap">): string | null {
  if (brief.gap.status === "missing" || !brief.gap.second_line) return null;
  return brief.gap.second_line;
}

/**
 * The Gap panel's notices (`role="note"`, §7): "Gap figures are from <as_of>; today's could not be
 * computed." when the brief shows an earlier metrics file, then "<block> data from <as_of>: <note>" for
 * each stale panel block (Flood, Window, AI-credited, Fix-side) of the metrics shown.
 */
export function gapNotices(brief: Pick<PageBrief, "date" | "gap">, metrics: Pick<Metrics, "blocks"> | null): string[] {
  if (brief.gap.status === "missing") return [];
  const d = (date: string | null) => (date ? fmtDate(date, brief.date) : "an earlier day");
  const out: string[] = [];
  if (brief.gap.status === "stale") out.push(`Gap figures are from ${d(brief.gap.as_of)}; today's could not be computed.`);
  for (const [key, name] of PANEL_BLOCKS) {
    const block = metrics?.blocks[key];
    if (block?.status !== "stale") continue;
    out.push(`${name} data from ${d(block.as_of)}${block.note ? `: ${block.note}` : "."}`);
  }
  return out;
}

/** The three charts' captions (§7 chart table, caption column). */
export interface ChartCaptions {
  /** Chart A's caption. */
  flood: string;
  /** Chart B's caption (under row 3): WINDOW_LABEL, then the cohort sentence. */
  window: string;
  /** Chart C's text key, then AI_CREDIT_CAPTION; one line when the block is null. */
  ai: string[];
  /** "AI-credited and now on CISA's list: <n> since 1 Jan 2025", then one line per entry; null with no AI block. */
  aiInKev: string[] | null;
}

/**
 * chartCaptions(metrics) (§7): each chart's caption from the metrics shown; a null block's entry is
 * "<Chart name> is not available today." and `aiInKev` is then null. The in-KEV entries name the finder
 * by its id (§7), which the metrics file freezes, so a later rename in config/ai-finders.json never
 * changes an archived page or its word count.
 */
export function chartCaptions(metrics: Pick<Metrics, "date" | "flood" | "window" | "ai_credited">): ChartCaptions {
  const unavailable = (name: string) => `${name} is not available today.`;
  const f = metrics.flood;
  const flood = f
    ? "CVE records published (CVE.org); not comparable to disclosure counts elsewhere. Hatched: Linux kernel records, which "
      + `automated assignment inflates. ${fmtInt(f.unscored_n)} of ${fmtInt(f.n)} had no CVSS score from the CNA or CISA.`
    : unavailable(CHART_NAMES.flood);
  const w = metrics.window;
  const window = w
    ? `${WINDOW_LABEL} Shares and medians use KEV additions whose CVE was published at most a year earlier; bars show how many `
      + "CISA listed, so a rise that only reflects CISA listing more is visible. "
      + `Also listed in 26 weeks: ${plural(w.w26.old_listed_n, "flaw", "flaws")} disclosed more than a year earlier.`
    : unavailable(CHART_NAMES.window);
  const a = metrics.ai_credited;
  if (!a) return { flood, window, ai: [unavailable(CHART_NAMES.ai)], aiInKev: null };
  const inKev = inKevLine(a, [], metrics.date);
  return { flood, window, ai: [AI_KEY, AI_CREDIT_CAPTION], aiInKev: [inKev.head, ...inKev.entries] };
}

/**
 * The fix-side strip (§5.6), text only, each figure dated: the Anthropic dashboard line when
 * `anthropic_cvd` is set (" Not updated since <date>." when stale; a figure the dashboard did not give is
 * left out), the GitHub line when `ghsa_unfixed` is set, and FIX_SIDE_CAPTION always.
 */
export function fixSideLines(fixSide: FixSide, editionDate: string): string[] {
  const d = (date: string) => fmtDate(date, editionDate);
  const out: string[] = [];
  const cvd = fixSide.anthropic_cvd;
  if (cvd) {
    const figures = [
      cvd.found_n === null ? null : `${fmtInt(cvd.found_n)} confirmed findings`,
      cvd.disclosed_n === null ? null : `${fmtInt(cvd.disclosed_n)} disclosed`,
      cvd.patched_n === null ? null : `${fmtInt(cvd.patched_n)} patched upstream`,
    ].filter((x): x is string => x !== null);
    let line = `Anthropic disclosure dashboard (one lab, open source only, self-reported), revision ${cvd.revision}, ${d(cvd.as_of)}`
      + `${figures.length ? `: ${figures.join(", ")}` : ""}.`;
    if (cvd.status === "stale") line += ` Not updated since ${d(cvd.as_of)}.`;
    out.push(line);
  }
  const g = fixSide.ghsa_unfixed;
  if (g && g.n_total >= 1) {
    out.push(`${pct(g.n_unfixed, g.n_total)}% of GitHub-reviewed advisories published 30 to 120 days ago still list no fixed version `
      + `(${fmtInt(g.n_unfixed)} of ${fmtInt(g.n_total)}, ${d(g.as_of)}).`);
  }
  out.push(FIX_SIDE_CAPTION);
  return out;
}

/**
 * The Gap panel's footer (§7): footerLine() (§5.8), then "Weeks before <live_from>: reconstructed from
 * current records." when the chart axis starts before the first live week.
 */
export function gapFooter(metrics: Pick<Metrics, "data_cutoff_utc" | "provenance" | "ai_credited" | "series">): string[] {
  const out = [footerLine(metrics)];
  const { live_from: liveFrom, weeks } = metrics.series;
  if (weeks.length > 0 && liveFrom > weeks[0]) out.push(`Weeks before ${shortDate(liveFrom)}: reconstructed from current records.`);
  return out;
}

// ── Taiwan Lens ──────────────────────────────────────────────────────────────────────────────────

/** The home_vendors row's script lines (§5.7): the TW and JP KEV lines and the fixed note, as stored. */
export function lensKevLines(lens: Pick<TaiwanLens, "kev_lines" | "kev_note">): string[] {
  return [lens.kev_lines.tw.text, lens.kev_lines.jp.text, lens.kev_note];
}

// ── The count ────────────────────────────────────────────────────────────────────────────────────

/** Options a page passes when it differs from a valid published brief. */
export interface ScriptOptions {
  /** False when the brief failed GAP_MATCH (§6 "Content loading"): the Gap is treated as missing. Default true. */
  gapOk?: boolean;
}

/** The items' script lines in page order: each top story, then the Also-today rows by head (§7). */
function itemParts(brief: Pick<PageBrief, "date" | "items">): (string | null)[] {
  const card = (item: CardItem) => [cardKicker(item), cardLine(item, brief.date)];
  const top = brief.items.slice(0, TOP_STORY_COUNT);
  const rows = rowsByHead(brief.items).flatMap((g) => g.items);
  return [
    ...(top.length ? top.flatMap(card) : [EMPTY_LINES.no_items]),
    ...(rows.length ? rows.flatMap(card) : [EMPTY_LINES.no_rows]),
  ];
}

/**
 * Every counted script string the page shows from the masthead to the end of the Taiwan Lens, in page
 * order, nulls dropped (§4.12 word table, §7): the masthead line, Gap headline and edition notice; each
 * region row's head and reason; the Gap panel (second line, notices, captions, fix-side lines, footer) or
 * EMPTY_LINES.gap_missing when `metrics` is null, the Gap is missing or `gapOk` is false; each top story's
 * and Also-today row's kicker and CVE timeline or release line (or the empty lines); §06's empty or
 * data-only line; the Lens's data-only line and its KEV lines. Not here: model fields (the words rule adds
 * those), section titles, datelines, chips and labels built outside this file, and anything after the Lens.
 */
export function scriptParts(brief: PageBrief, metrics: Metrics | null, opts: ScriptOptions = {}): string[] {
  const gapOk = opts.gapOk ?? true;
  const dataOnly = brief.edition === "data_only";
  const gapShown = gapOk && metrics !== null && brief.gap.status !== "missing";
  const parts: (string | null)[] = [
    mastheadLine(brief),
    gapHeadlineLine(brief, gapOk),
    editionNotice(brief),
    ...brief.regions.rows.flatMap((row) => {
      const s = regionSummary(row);
      return [s.head, s.reason];
    }),
  ];
  if (gapShown) {
    const c = chartCaptions(metrics);
    parts.push(
      gapSecondLine(brief),
      ...gapNotices(brief, metrics),
      c.flood, c.window, ...c.ai, ...(c.aiInKev ?? []),
      ...fixSideLines(metrics.fix_side, brief.date),
      ...gapFooter(metrics),
    );
  } else {
    parts.push(EMPTY_LINES.gap_missing);
  }
  parts.push(...itemParts(brief));
  parts.push(dataOnly ? EMPTY_LINES.not_data_only : brief.actors_seen.length ? null : EMPTY_LINES.no_actors);
  parts.push(dataOnly ? EMPTY_LINES.not_data_only : null, ...lensKevLines(brief.taiwan_lens));
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0);
}

/** scriptParts() joined with newlines: what pageWords() counts with countWords() (§4.5, §4.12). */
export function scriptText(brief: PageBrief, metrics: Metrics | null, opts: ScriptOptions = {}): string {
  return scriptParts(brief, metrics, opts).join("\n");
}
