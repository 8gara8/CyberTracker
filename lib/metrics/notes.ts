// The metrics blocks' fixed notes (SPEC §4.7 `blocks[].note`: at most 200 characters, fixed templates
// only, never raw error text) and the metrics run's stdout lines (§8.4). The page shows a stale block as
// "<block> data from <as_of>: <note>" (lib/page-text.ts gapNotices()), so each note is a full sentence.
// The AI-finder notes live with the credit code (AI_NOTES) and the fix-side notes with fixSide()
// (FIX_NOTES); both are re-exported here so every template is reachable from one module.

import { shortDate } from "../format";

export { AI_NOTES } from "./ai-credit";
export { FIX_NOTES } from "./fix-side";

/** The longest a block note may be (§4.7). */
export const NOTE_MAX = 200;

/** Block notes, by cause. Dates are UTC calendar dates, shown as "6 Nov 2026". */
export const BLOCK_NOTES = {
  /** Window, KEV and home vendors when today's KEV catalog could not be read. */
  kevNotRead: "CISA's KEV catalog could not be read today.",
  /** Window, KEV and home vendors when today's catalog is older than the one kev-index.json already holds (never moved back). */
  kevOlder: (read: string, index: string): string =>
    `CISA's KEV catalog read today (${read}) is older than the one already counted (${index}), so it was not used.`,
  /** Flood and AI-credited when some UTC days before the cutoff are not yet counted. */
  daysMissing: (n: number, from: string): string =>
    `${n === 1 ? "One UTC day" : `${n} UTC days`} from ${shortDate(from)} could not be counted from the CVE List today.`,
  /** Flood and AI-credited when the newest counted day is more than 25 days before the cutoff (§8.4). */
  catchUp: (newest: string): string => `Flood counts stop at ${shortDate(newest)}; the missed days need a catch-up from the full CVE List.`,
} as const;

/** The stdout line after more than 25 missed days, exactly as §8.4 writes it (the Notes line drops the full stop). */
export function catchUpLine(newest: string): string {
  return `Flood counts stop at ${newest}: run npm run backfill -- --catch-up --push.`;
}

/** One entry of the first stdout line: a block or feed name and its status, with the as-of date when stale. */
export interface StatusEntry {
  name: string;
  status: "ok" | "stale" | "failed";
  asOf: string | null;
}

/**
 * The first stdout line (§8.4): `Metrics D: data to <cutoff> UTC · ok: window, flood, … · stale: epss (as
 * of YYYY-MM-DD) · failed: none.` Entries keep the order given; an empty group reads "none".
 */
export function metricsFirstLine(date: string, cutoff: string, entries: readonly StatusEntry[]): string {
  const group = (s: StatusEntry["status"]) => {
    const names = entries.filter((e) => e.status === s).map((e) => (s === "stale" && e.asOf ? `${e.name} (as of ${e.asOf})` : e.name));
    return `${s}: ${names.length ? names.join(", ") : "none"}`;
  };
  return `Metrics ${date}: data to ${cutoff} UTC · ${group("ok")} · ${group("stale")} · ${group("failed")}.`;
}
