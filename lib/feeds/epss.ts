// FIRST EPSS (SPEC §8.3, §5.12): the daily CSV, the API fallback, and the jump and mover tests that
// collect and the metrics share. P2 WP1 fills these stubs (S0 contract).

import type { EpssMover } from "../schema/metrics";
import type { EpssDay, EpssScore, Parsed } from "./types";

/** One day's gzipped CSV (model version and score date from its first line). */
export function parseEpssCsv(gz: Buffer): Parsed<never> & { day: EpssDay } {
  throw new Error("not implemented: parseEpssCsv");
}

/** The EPSS API answer, by CVE id. */
export function parseEpssApi(body: Buffer): Map<string, EpssScore & { date: string }> {
  throw new Error("not implemented: parseEpssApi");
}

/** The registry's "-current" CSV URL rewritten for `date` (§8.3's fixed pattern). */
export function epssUrlFor(registryUrl: string, date: string): string {
  throw new Error("not implemented: epssUrlFor");
}

/** API URLs for `cveIds`, in batches of 100. */
export function epssApiUrls(fallbackUrl: string, cveIds: readonly string[]): string[] {
  throw new Error("not implemented: epssApiUrls");
}

/** §5.12's EPSS jump for one CVE: percentile crossed 0.99, or score rose by 0.10 or more since E − 1. */
export function epssJump(e: EpssDay, e1: EpssDay | null, cve: string): { crossed: boolean; rose: boolean; change_24h: number | null } {
  throw new Error("not implemented: epssJump");
}

/** metrics.epss_movers (§5.12): the five largest rises from E − 7 to E among scores of at least 0.10, ties by id. */
export function epssMovers(e: EpssDay, e7: EpssDay): EpssMover[] {
  throw new Error("not implemented: epssMovers");
}
