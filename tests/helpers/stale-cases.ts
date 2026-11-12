// The StaleBanner cases of SPEC §7 Site tests ("Stale"), shared by tests/stale.test.ts in its own process and
// in child processes started under other TZ values. Run directly with `--print` it writes, as JSON, the
// process's time zone and every case's result, so the test can compare them.

import { isStale, staleText, taipeiClock } from "@/lib/stale";

export const STALE_AFTER = "08:00";

export interface StaleCase {
  name: string;
  now: string;
  lastDate: string;
  stale: boolean;
}

export const STALE_CASES: readonly StaleCase[] = [
  { name: "newest 7 Nov, 07:59 Taipei on 8 Nov", now: "2026-11-07T23:59:00Z", lastDate: "2026-11-07", stale: false },
  { name: "newest 7 Nov, 08:00 Taipei on 8 Nov", now: "2026-11-08T00:00:00Z", lastDate: "2026-11-07", stale: true },
  { name: "newest 7 Nov (yesterday), 08:01 Taipei on 8 Nov", now: "2026-11-08T00:01:00Z", lastDate: "2026-11-07", stale: true },
  { name: "newest 7 Nov, 00:00 Taipei on 8 Nov", now: "2026-11-07T16:00:00Z", lastDate: "2026-11-07", stale: false },
  { name: "newest 7 Nov, 23:59 Taipei on 7 Nov", now: "2026-11-07T15:59:00Z", lastDate: "2026-11-07", stale: false },
  { name: "newest 6 Nov, 07:59 Taipei on 8 Nov", now: "2026-11-07T23:59:00Z", lastDate: "2026-11-06", stale: true },
  { name: "newest 6 Nov, 00:00 Taipei on 8 Nov", now: "2026-11-07T16:00:00Z", lastDate: "2026-11-06", stale: true },
  { name: "newest 8 Nov, 00:00 Taipei on 8 Nov", now: "2026-11-07T16:00:00Z", lastDate: "2026-11-08", stale: false },
  { name: "newest 8 Nov, 07:59 Taipei on 8 Nov", now: "2026-11-07T23:59:00Z", lastDate: "2026-11-08", stale: false },
  { name: "newest 8 Nov, 08:00 Taipei on 8 Nov", now: "2026-11-08T00:00:00Z", lastDate: "2026-11-08", stale: false },
  { name: "newest 8 Nov, 12:00 Taipei on 8 Nov", now: "2026-11-08T04:00:00Z", lastDate: "2026-11-08", stale: false },
  { name: "newest 8 Nov, 23:59 Taipei on 8 Nov", now: "2026-11-08T15:59:00Z", lastDate: "2026-11-08", stale: false },
  { name: "newest 9 Nov (a future date), 23:59 Taipei on 8 Nov", now: "2026-11-08T15:59:00Z", lastDate: "2026-11-09", stale: false },
  { name: "newest 31 Dec 2026, 08:00 Taipei on 1 Jan 2027", now: "2027-01-01T00:00:00Z", lastDate: "2026-12-31", stale: true },
  { name: "newest 31 Dec 2026, 07:59 Taipei on 1 Jan 2027", now: "2026-12-31T23:59:00Z", lastDate: "2026-12-31", stale: false },
];

export interface StaleRun {
  tz: string;
  /** new Date("2026-11-08T00:00:00Z").getTimezoneOffset(): shows which zone the process really ran in. */
  offset: number;
  results: { name: string; stale: boolean; clock: { date: string; time: string } }[];
  text: string;
}

/** Every case's result in this process. */
export function runStaleCases(): StaleRun {
  return {
    tz: process.env.TZ ?? "",
    offset: new Date("2026-11-08T00:00:00Z").getTimezoneOffset(),
    results: STALE_CASES.map((c) => ({ name: c.name, stale: isStale(new Date(c.now), c.lastDate, STALE_AFTER), clock: taipeiClock(new Date(c.now)) })),
    text: staleText("2026-11-07", "2026-11-07T05:12:00+08:00"),
  };
}

if (process.argv.includes("--print")) process.stdout.write(JSON.stringify(runStaleCases()));
