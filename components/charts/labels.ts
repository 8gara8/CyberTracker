// SPEC §7 "GapPanel and charts": the charts' own text, none of it counted (§7 "Script-written page text": chart
// titles, the chartLabel() aria-labels, direct labels, axis text, marker keys, hover titles and the data tables
// are never marked as counted). The chart names come from lib/page-text.ts (chartName()); the strings below
// appear nowhere in lib/. Numbers go through §5.2's display helpers and dates through lib/format.ts
// (shortDate: the charts get no edition date, so a date always shows its year). Owner: gap lane.
import { shortDate } from "@/lib/format";
import { fmtDays, fmtInt, pct } from "@/lib/metrics/stats";
import { plural } from "@/lib/page-text";
import type { AiCredited, Flood, GapWindow } from "@/lib/schema/metrics";
import { MIN_N } from "@/lib/vocab";

/** The chart titles above each plot (§7 chart table). */
export const CHART_TITLES = {
  flood: "NEW CVE RECORDS, 13-WEEK TOTAL",
  window: "ROLLING 26 WEEKS",
  ai: "WEEKLY RECORDS, LOWER BOUND",
} as const;

/** The chart letters (§7 chart table: "A · The Flood", "B · The Window", "C · AI-credited"). */
export const CHART_LETTERS = { flood: "A", window: "B", ai: "C" } as const;

/** Chart B's three rows (§7 chart table). */
export const WINDOW_ROWS = {
  share: "Already exploited at disclosure",
  median: "Median days to CISA listing, for the rest",
  kev: "Recent flaws CISA listed each week",
} as const;

/** What a null latest value reads (§7 "Nulls"). */
export const N_TOO_SMALL = "n too small";
/** A year-ago value the series does not have (its week is before the series starts). */
export const NOT_AVAILABLE = "not available";
/** The KEV charts' hover suffix (§7 "Hover"). */
export const KEV_US_DATES = "(KEV dates are US dates)";
/** The 2023 to 2024 reference period as the charts write it. */
export const REF = "2023–24";
/** Chart A's label for the dashed line. */
export const YEAR_EARLIER = "a year earlier";
/** The data tables' Source column (§7): weeks before series.live_from came from the backfill. */
export const SOURCE = { backfill: "backfill", live: "live" } as const;

/** The finder families in the order chart C stacks them (OpenAI, Google, other solid; Anthropic on top). */
export const FAMILY_ORDER = ["openai", "google", "other", "anthropic"] as const;
export const FAMILY_NAMES = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", other: "other" } as const;

/** §5.3's line under the Gap data table, exactly. */
export const CHANGE_CALL_LINE = "A change is called when the 80% interval for the difference from 2023–24 excludes zero; 2023–24 "
  + "is itself a sample, and about one call in five can still be chance.";

/** §5.3's Gap data table rows, in order. */
export const PERIOD_ROWS = {
  kev: "KEV additions",
  unjoined: "Not joined to a CVE record",
  cohort: "Recently disclosed (cohort R, CVE published at most 365 days before listing)",
  atDisclosure: "Already exploited at disclosure (listed at most 1 day after CVE publication)",
  nDay: "n-day race (listed 2 to 30 days after)",
  late: "Listed 31 to 365 days after",
  median: "Median days to listing, for the rest",
  p7: "Listed within 7 days (P7)",
  old: "Old flaws newly listed (more than 365 days old)",
} as const;

/** "Week of 2 Nov 2026": a hover title's and a data table row's week. */
export function weekOf(week: string): string {
  return `Week of ${shortDate(week)}`;
}

/** "Data table: <chart name>" (§7). */
export function tableSummary(name: string): string {
  return `Data table: ${name}`;
}

/** A from-to date range with both years: "11 May 2026 to 8 Nov 2026". */
export function dateRange(from: string, to: string): string {
  return `${shortDate(from)} to ${shortDate(to)}`;
}

// ── chartLabel() (§7): each chart's svg aria-label ───────────────────────────────────────────────

/** A: "The Flood: <n> new CVE records in the 13 weeks to <to>, <kernel_n> of them Linux kernel; a year earlier <year_ago.n>." */
export function floodLabel(flood: Pick<Flood, "n" | "to" | "kernel_n" | "year_ago">): string {
  return `The Flood: ${fmtInt(flood.n)} new CVE records in the 13 weeks to ${shortDate(flood.to)}, ${fmtInt(flood.kernel_n)} of them `
    + `Linux kernel; a year earlier ${fmtInt(flood.year_ago.n)}.`;
}

/**
 * B: "The Window over 26 weeks to <to>: <share> already exploited at disclosure (2023–24: <ref>); for the rest, a
 * median <days> days to CISA listing (2023–24: <ref> days); <cohort_n> recent flaws listed." A share or median
 * not shown (below MIN_N) is said in words with "n too small"; a cohort of 1 reads "1 recent flaw listed".
 */
export function windowLabel(win: Pick<GapWindow, "w26" | "reference">): string {
  const w = win.w26;
  const ref = win.reference;
  const refShare = ref.cohort_n >= MIN_N ? `${pct(ref.at_disclosure_n, ref.cohort_n)}%` : N_TOO_SMALL;
  const refDays = ref.after_disclosure_median_days === null ? N_TOO_SMALL : `${fmtDays(ref.after_disclosure_median_days)} days`;
  const share = w.cohort_n >= MIN_N
    ? `${pct(w.at_disclosure_n, w.cohort_n)}% already exploited at disclosure (${REF}: ${refShare})`
    : `the share already exploited at disclosure is not shown (${N_TOO_SMALL}; ${REF}: ${refShare})`;
  const days = w.after_disclosure_median_days === null
    ? `the median days to CISA listing is not shown (${N_TOO_SMALL}; ${REF}: ${refDays})`
    : `a median ${fmtDays(w.after_disclosure_median_days)} days to CISA listing (${REF}: ${refDays})`;
  return `The Window over 26 weeks to ${shortDate(w.to)}: ${share}; for the rest, ${days}; ${plural(w.cohort_n, "recent flaw", "recent flaws")} listed.`;
}

/**
 * C: "AI-credited records, a lower bound: <total> in 13 weeks, <ex_anthropic> without Anthropic; <in_kev.n>
 * AI-credited flaws on CISA's list since 1 Jan 2025." A count of 1 takes the singular ("1 AI-credited flaw"), as
 * B's "1 recent flaw listed".
 */
export function aiLabel(ai: Pick<AiCredited, "w13" | "in_kev">): string {
  return `AI-credited records, a lower bound: ${fmtInt(ai.w13.total)} in 13 weeks, ${fmtInt(ai.w13.ex_anthropic)} without Anthropic; `
    + `${plural(ai.in_kev.n, "AI-credited flaw", "AI-credited flaws")} on CISA's list since ${shortDate(ai.in_kev.since)}.`;
}
