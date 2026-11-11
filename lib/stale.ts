// The stale-banner rule (SPEC §7 "StaleBanner", "lib/stale.ts"). Pure: the clock is a parameter and the
// Taipei date and time come from Intl with an explicit time zone, never the device's, so the banner reads
// the same on a phone in New York as on Kobol. components/layout/StaleBanner.tsx (a client component)
// calls isStale() and staleText() in the reader's browser; tests/stale.test.ts covers every case.

import { addDays } from "./dates";
import { shortDate, taipeiTime } from "./format";
import { STALE_BANNER } from "./vocab";

const TAIPEI_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Taipei's calendar date ("2026-11-08") and clock time ("07:59") at `now`. */
export function taipeiClock(now: Date): { date: string; time: string } {
  const part: Record<string, string> = {};
  for (const p of TAIPEI_CLOCK.formatToParts(now)) part[p.type] = p.value;
  return { date: `${part.year}-${part.month}-${part.day}`, time: `${part.hour}:${part.minute}` };
}

/**
 * True when the newest edition is from before today in Taipei and either it is `staleAfter` ("08:00") or
 * later today, or the newest edition is older than yesterday. A `lastDate` of today or later is never stale.
 */
export function isStale(now: Date, lastDate: string, staleAfter: string): boolean {
  const { date, time } = taipeiClock(now);
  return lastDate < date && (time >= staleAfter || lastDate < addDays(date, -1));
}

/** STALE_BANNER filled in: "Not updated today. Last edition: 7 Nov 2026, 05:12" (the time in Taipei). */
export function staleText(lastDate: string, lastPublishedAt: string): string {
  return STALE_BANNER.replace("{date}", shortDate(lastDate)).replace("{time}", taipeiTime(lastPublishedAt));
}
