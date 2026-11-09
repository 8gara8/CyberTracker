// GitHub-reviewed advisories from the advisory-database git export (OSV JSON, SPEC §8.3, §5.6).
// P2 WP1 fills these stubs (S0 contract).

import type { GhsaAdvisory } from "./types";

/** One OSV advisory file; null when it is not a readable advisory. */
export function parseGhsa(raw: unknown): GhsaAdvisory | null {
  throw new Error("not implemented: parseGhsa");
}

/** True when some affected[].ranges[].events[] entry has a `fixed` key; last_affected alone is unfixed. */
export function ghsaIsFixed(osv: unknown): boolean {
  throw new Error("not implemented: ghsaIsFixed");
}

/** The "YYYY/MM" months spanning [cutoff − 120 days, cutoff + 1 day] (ruling R15), for the sparse checkout. */
export function ghsaMonths(cutoff: string): string[] {
  throw new Error("not implemented: ghsaMonths");
}

/** An advisory's page on github.com/advisories (the pack record URL). */
export function ghsaRecordUrl(id: string): string {
  throw new Error("not implemented: ghsaRecordUrl");
}
