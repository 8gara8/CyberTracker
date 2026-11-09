// Date and time formatters for page text, the chat edition and the site (SPEC §7 "Script-written page
// text", §5.2). Pure string work on "YYYY-MM-DD" calendar dates, so no machine time zone leaks in; clock
// times are Taipei (UTC+8, no daylight saving). §5.2's number helpers (pct, fmtPct, fmtInt, fmt1, fmtDays,
// fmtDate) live in lib/metrics/stats.ts. P4 extends this file for the site.

import { isValidDate } from "./dates";

export { taipeiTime } from "./dates";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
  "December"] as const;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function parts(date: string): { y: number; m: number; d: number; dow: number } {
  if (!isValidDate(date)) throw new Error(`Invalid date: ${date}`);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** The month's three-letter English abbreviation, without a period: "Jan" to "Dec" ("Sep" for September). */
export function monthShort(month: number): string {
  const name = MONTHS[month - 1];
  if (!name) throw new Error(`Invalid month: ${month}`);
  return name.slice(0, 3);
}

/** "Sunday 8 November 2026": the brief's h1, page titles, the archive list and edition links. */
export function longDate(date: string): string {
  const { y, m, d, dow } = parts(date);
  return `${DAYS[dow]} ${d} ${MONTHS[m - 1]} ${y}`;
}

/** "7 Nov 2026": §5.2's fmtDate() form with the year always shown. */
export function shortDate(date: string): string {
  const { y, m, d } = parts(date);
  return `${d} ${monthShort(m)} ${y}`;
}

/** "3 Nov": day without a leading zero and the short month, no year. */
export function dayMonth(date: string): string {
  const { m, d } = parts(date);
  return `${d} ${monthShort(m)}`;
}
