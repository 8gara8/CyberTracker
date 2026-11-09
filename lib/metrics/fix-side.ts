// The fix side (SPEC §5.6): the Anthropic disclosure dashboard's figures and the share of GitHub-reviewed
// advisories still without a fixed version. Pure. P2 WP4 fills these stubs (S0 contract).

import type { CvdDashboard, FeedState, GhsaAdvisory } from "../feeds/types";
import type { AnthropicCvdFile, FixSide, Metrics, MetricsBlock } from "../schema/metrics";

/** §5.6's decision on the GitHub line (ruling R10): kept. Changing it is a PR with the 52-week table. */
export const GHSA_UNFIXED_KEPT = true;
/** The dashboard figures go stale when daysBetween(as_of, cutoff) is over this. */
export const CVD_STALE_DAYS = 14;

/** The GHSA unfixed window (§5.1): [cutoff − 120 days, cutoff − 30 days]. */
export function ghsaUnfixedWindow(cutoff: string): { from: string; to: string } {
  throw new Error("not implemented: ghsaUnfixedWindow");
}

/** fix_side.ghsa_unfixed: reviewed, not withdrawn, published in the window; share null below MIN_N. */
export function ghsaUnfixed(
  advs: Iterable<Pick<GhsaAdvisory, "id" | "published" | "withdrawn" | "fixed" | "reviewed">>,
  cutoff: string,
  asOf: string,
): NonNullable<FixSide["ghsa_unfixed"]> {
  throw new Error("not implemented: ghsaUnfixed");
}

/** state/anthropic-cvd.json after this run: replaced only when the revision changes. */
export function updateAnthropicCvd(prev: AnthropicCvdFile, read: CvdDashboard | null, meta: { fetchedAt: string; sourceUrl: string }, cutoff: string): AnthropicCvdFile {
  throw new Error("not implemented: updateAnthropicCvd");
}

/** fix_side and blocks.fix_side (ruling R13). */
export function fixSide(i: {
  cutoff: string;
  cvd: AnthropicCvdFile;
  ghsa: { status: FeedState; advisories: readonly GhsaAdvisory[]; headDate: string | null };
  previous: Pick<Metrics, "fix_side" | "blocks"> | null;
}): { fix_side: FixSide; block: MetricsBlock } {
  throw new Error("not implemented: fixSide");
}

/** The fix-side block's fixed notes (≤ 200 characters). S0 stub: WP4 writes the templates. */
export const FIX_NOTES: { cvdStale(asOf: string): string; ghsaStale(asOf: string): string } = {
  cvdStale: () => {
    throw new Error("not implemented: FIX_NOTES.cvdStale");
  },
  ghsaStale: () => {
    throw new Error("not implemented: FIX_NOTES.ghsaStale");
  },
};
