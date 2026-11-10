// The fix side (SPEC §5.6): the Anthropic disclosure dashboard's figures and the share of GitHub-reviewed
// advisories still without a fixed version. Pure: no clock, file, network or randomness. Text only, each
// figure with its own date, never charted; lib/page-text.ts fixSideLines() renders it.

import { addDays, daysBetween, inRange, isValidDate, utcDateOf } from "../dates";
import type { CvdDashboard, FeedState, GhsaAdvisory } from "../feeds/types";
import { shortDate } from "../format";
import { compareIds } from "../ids";
import type { AnthropicCvdFile, FixSide, Metrics, MetricsBlock } from "../schema/metrics";
import { MIN_N } from "../vocab";
import { round4 } from "./stats";

/** §5.6's decision on the GitHub line (ruling R10): kept. Changing it is a PR with the 52-week table. */
export const GHSA_UNFIXED_KEPT = true;
/** §5.6's rule over 52 weekly as-of values: keep the line only if n_total ≥ 300 every week and the share reaches 5% in one. */
export const GHSA_DECISION = { weeks: 52, min_total: 300, min_peak: 0.05 } as const;
/** The dashboard figures go stale when daysBetween(as_of, cutoff) is over this. */
export const CVD_STALE_DAYS = 14;

/** The GHSA unfixed window (§5.1): [cutoff − 120 days, cutoff − 30 days]. */
export function ghsaUnfixedWindow(cutoff: string): { from: string; to: string } {
  return { from: addDays(cutoff, -120), to: addDays(cutoff, -30) };
}

/**
 * fix_side.ghsa_unfixed: GitHub-reviewed, not withdrawn, published (UTC date) in the window, each id once;
 * unfixed when no affected range has a `fixed` event (GhsaAdvisory.fixed). share = round4(n_unfixed /
 * n_total), null below MIN_N (ruling R11). `asOf` is the UTC date of the GHSA HEAD commit read (ruling R13).
 */
export function ghsaUnfixed(
  advs: Iterable<Pick<GhsaAdvisory, "id" | "published" | "withdrawn" | "fixed" | "reviewed">>,
  cutoff: string,
  asOf: string,
): NonNullable<FixSide["ghsa_unfixed"]> {
  const w = ghsaUnfixedWindow(cutoff);
  const seen = new Set<string>();
  let total = 0;
  let unfixed = 0;
  for (const a of advs) {
    if (!a.reviewed || a.withdrawn !== null || !inRange(a.published, w.from, w.to) || seen.has(a.id)) continue;
    seen.add(a.id);
    total++;
    if (!a.fixed) unfixed++;
  }
  return { share: total >= MIN_N ? round4(unfixed / total) : null, n_unfixed: unfixed, n_total: total, from: w.from, to: w.to, as_of: asOf };
}

/** The dashboard's as-of as a date: a date as written, a timestamp by its UTC date; null when it is neither. */
function asOfDate(s: string): string | null {
  try {
    const d = utcDateOf(s);
    return isValidDate(d) ? d : null;
  } catch {
    return null;
  }
}

/**
 * state/anthropic-cvd.json after this run (§5.6 item 1): replaced when the dashboard's revision differs
 * from the stored one, or when the stored read of that revision came from the page alone (no found_n,
 * because the payload failed that day) and today's read has the payload's figures; else returned unchanged
 * (updated_at included). fetched_at and source_url come from collect's feed index (ruling R13), never the
 * clock. A read whose as-of date cannot be read is ignored.
 */
export function updateAnthropicCvd(prev: AnthropicCvdFile, read: CvdDashboard | null, meta: { fetchedAt: string; sourceUrl: string }, cutoff: string): AnthropicCvdFile {
  if (!read) return prev;
  const completes = read.revision === prev.revision && prev.found_n === null && read.found_n !== null;
  if (read.revision === prev.revision && !completes) return prev;
  const asOf = asOfDate(read.as_of);
  if (!asOf) return prev;
  return {
    schema_version: 1,
    updated_at: cutoff,
    revision: read.revision,
    as_of: asOf,
    fetched_at: meta.fetchedAt,
    source_url: meta.sourceUrl,
    found_n: read.found_n,
    disclosed_n: read.disclosed_n,
    patched_n: read.patched_n,
    ledger_ids: [...new Set(read.ledger_ids)].sort(compareIds),
  };
}

/**
 * fix_side.anthropic_cvd from the state: null when no revision was ever read; "stale" when the stated
 * as-of date is more than CVD_STALE_DAYS before the cutoff, else "ok". Age decides, not today's fetch.
 */
export function anthropicCvdFigures(state: AnthropicCvdFile, cutoff: string): FixSide["anthropic_cvd"] {
  if (state.revision === null || state.as_of === null || state.fetched_at === null || state.source_url === null) return null;
  return {
    status: daysBetween(state.as_of, cutoff) > CVD_STALE_DAYS ? "stale" : "ok",
    revision: state.revision,
    as_of: state.as_of,
    fetched_at: state.fetched_at,
    found_n: state.found_n,
    disclosed_n: state.disclosed_n,
    patched_n: state.patched_n,
    source_url: state.source_url,
  };
}

/**
 * fix_side and blocks.fix_side (ruling R13). The dashboard part comes from the state; the GitHub part is
 * computed when the ghsa feed was read today ("ok" with a HEAD date), else the previous metrics file's
 * value is carried as an earlier value, else null. The block is "failed" when neither part has a value,
 * "stale" when a shown part is an earlier value (as_of the oldest such, note from FIX_NOTES), else "ok"
 * with as_of the cutoff.
 */
export function fixSide(i: {
  cutoff: string;
  cvd: AnthropicCvdFile;
  ghsa: { status: FeedState; advisories: readonly GhsaAdvisory[]; headDate: string | null };
  previous: Pick<Metrics, "fix_side" | "blocks"> | null;
}): { fix_side: FixSide; block: MetricsBlock } {
  const cvd = anthropicCvdFigures(i.cvd, i.cutoff);
  let ghsa: FixSide["ghsa_unfixed"] = null;
  let ghsaCarried = false;
  if (GHSA_UNFIXED_KEPT) {
    if (i.ghsa.status === "ok" && i.ghsa.headDate !== null) ghsa = ghsaUnfixed(i.ghsa.advisories, i.cutoff, i.ghsa.headDate);
    else if (i.previous?.fix_side.ghsa_unfixed) {
      ghsa = i.previous.fix_side.ghsa_unfixed;
      ghsaCarried = true;
    }
  }
  const fix_side: FixSide = { anthropic_cvd: cvd, ghsa_unfixed: ghsa };
  if (!cvd && !ghsa) return { fix_side, block: { status: "failed", as_of: null, note: null } };

  const stale: { asOf: string; note: string }[] = [];
  if (cvd?.status === "stale") stale.push({ asOf: cvd.as_of, note: FIX_NOTES.cvdStale(cvd.as_of) });
  if (ghsa && ghsaCarried) stale.push({ asOf: ghsa.as_of, note: FIX_NOTES.ghsaStale(ghsa.as_of) });
  if (!stale.length) return { fix_side, block: { status: "ok", as_of: i.cutoff, note: null } };
  const asOf = stale.map((s) => s.asOf).sort()[0]!;
  return { fix_side, block: { status: "stale", as_of: asOf, note: stale.map((s) => s.note).join(" ") } };
}

/** The fix-side block's fixed notes (each ≤ 100 characters, so both together stay within 200). */
export const FIX_NOTES: { cvdStale(asOf: string): string; ghsaStale(asOf: string): string } = {
  cvdStale: (asOf) => `The Anthropic dashboard has shown no new revision since ${shortDate(asOf)}.`,
  ghsaStale: (asOf) => `GitHub advisories were not read today; the unfixed share is from ${shortDate(asOf)}.`,
};

/** One week's as-of GitHub value, for the §5.6 decision (the 52-week table in the P2 PR). */
export interface GhsaWeek {
  cutoff: string;
  commit: string;
  as_of: string;
  n_total: number;
  n_unfixed: number;
  share: number | null;
}

/** §5.6's rule: keep the GitHub line iff n_total ≥ 300 in every one of the 52 weeks and the share reaches 5% in at least one. */
export function ghsaKeepDecision(weeks: readonly GhsaWeek[]): { keep: boolean; weeks: number; min_n_total: number; max_share: number; weeks_at_peak: number } {
  const shares = weeks.map((w) => w.share ?? 0);
  const minTotal = weeks.length ? Math.min(...weeks.map((w) => w.n_total)) : 0;
  const maxShare = shares.length ? Math.max(...shares) : 0;
  const atPeak = shares.filter((s) => s >= GHSA_DECISION.min_peak).length;
  const keep = weeks.length === GHSA_DECISION.weeks && minTotal >= GHSA_DECISION.min_total && atPeak > 0;
  return { keep, weeks: weeks.length, min_n_total: minTotal, max_share: maxShare, weeks_at_peak: atPeak };
}
