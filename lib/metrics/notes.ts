// The metrics blocks' fixed notes (SPEC §4.7 `blocks[].note`: at most 200 characters, fixed templates
// only, never raw error text) and the metrics run's stdout lines (§8.4). The page shows a stale block as
// "<block> data from <as_of>: <note>" (lib/page-text.ts gapNotices()), so each note is a full sentence.
// The AI-finder notes live with the credit code (AI_NOTES) and the fix-side notes with fixSide()
// (FIX_NOTES); both are re-exported here so every template is reachable from one module.

import { addDays } from "../dates";
import { dayMonth, shortDate } from "../format";

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
  /**
   * Flood and AI-credited when some UTC days before the cutoff are not yet counted: the days of the catch-up
   * range still missing (collect retries them each morning), then the older gaps, which only a backfill
   * --catch-up fills. Runs of days are shown as ranges; a list too long for the note ends "and N more".
   */
  daysMissing: (recent: readonly string[], older: readonly string[]): string => missingDaysNote(recent, older),
  /** Flood and AI-credited when the newest counted day is more than 25 days before the cutoff (§8.4). */
  catchUp: (newest: string): string => `Flood counts stop at ${shortDate(newest)}; the missed days need a catch-up from the full CVE List.`,
} as const;

/** Consecutive UTC days as runs, oldest first. */
function runsOf(days: readonly string[]): string[][] {
  const runs: string[][] = [];
  for (const d of [...new Set(days)].sort()) {
    const last = runs.at(-1);
    if (last && addDays(last.at(-1)!, 1) === d) last.push(d);
    else runs.push([d]);
  }
  return runs;
}

/** "6 Nov 2026", "4 to 6 Nov 2026", "30 Oct to 1 Nov 2026", "31 Dec 2025 to 1 Jan 2026". */
function runText(run: readonly string[]): string {
  const a = run[0]!;
  const b = run.at(-1)!;
  if (a === b) return shortDate(a);
  if (a.slice(0, 7) === b.slice(0, 7)) return `${Number(a.slice(8))} to ${shortDate(b)}`;
  if (a.slice(0, 4) === b.slice(0, 4)) return `${dayMonth(a)} to ${shortDate(b)}`;
  return `${shortDate(a)} to ${shortDate(b)}`;
}

function missingDaysNote(recent: readonly string[], older: readonly string[]): string {
  const parts = [
    { prefix: "UTC days not yet counted from the CVE List: ", runs: runsOf(recent) },
    { prefix: "Older UTC days missing, for a backfill --catch-up: ", runs: runsOf(older) },
  ].filter((p) => p.runs.length);
  if (!parts.length) return "Some UTC days could not be counted from the CVE List today.";
  const shown = parts.map((p) => p.runs.length);
  const sentence = (i: number) => {
    const { prefix, runs } = parts[i]!;
    const n = shown[i]!;
    if (n >= runs.length) return `${prefix}${runs.map(runText).join(", ")}.`;
    const more = runs.slice(n).reduce((k, r) => k + r.length, 0);
    return `${prefix}${runs.slice(0, n).map(runText).join(", ")} and ${more} more.`;
  };
  const text = () => parts.map((_, i) => sentence(i)).join(" ");
  // Shorten the older list first, then the recent one, one run at a time.
  while (text().length > NOTE_MAX) {
    const i = shown.length > 1 && shown[1]! > 1 ? 1 : shown[0]! > 1 ? 0 : -1;
    if (i < 0) break;
    shown[i] = shown[i]! - 1;
  }
  const out = text();
  return out.length <= NOTE_MAX ? out : `${out.slice(0, NOTE_MAX - 1)}…`;
}

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
