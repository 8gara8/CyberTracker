// The Flood (SPEC §5.4) and content/state/days.json: new CVE records per UTC day, the kernel's share and
// the unscored count. Pure. P2 WP3 fills these stubs (S0 contract).

import type { CveFacts } from "../feeds/types";
import type { DayRow, Flood } from "../schema/metrics";

/** SHA-256 of the ids in code-unit order joined by "\n"; sha256("") for none. */
export function idsSha256(ids: readonly string[]): string {
  throw new Error("not implemented: idsSha256");
}

/** The days.json row for `day`: PUBLISHED records with date_published === day; kernel: assigner "Linux"; unscored: !scored. */
export function countDay(day: string, records: Iterable<CveFacts>): DayRow {
  throw new Error("not implemented: countDay");
}

/** Every calendar day in [from, to], zero days included. */
export function countDays(from: string, to: string, records: readonly CveFacts[]): DayRow[] {
  throw new Error("not implemented: countDays");
}

/** The days in [from, to] that `days` lacks. */
export function missingDays(days: ReadonlyMap<string, DayRow>, from: string, to: string): string[] {
  throw new Error("not implemented: missingDays");
}

/** metrics.flood from days.json; null with the missing dates when any needed day is absent. */
export function floodStats(days: ReadonlyMap<string, DayRow>, cutoff: string): { flood: Flood | null; missing: string[] } {
  throw new Error("not implemented: floodStats");
}
