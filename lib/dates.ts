// Calendar helpers. Dates are "YYYY-MM-DD" strings handled as UTC calendar days, so no local time zone
// leaks in. Taipei is UTC+8 with no daylight saving. Cloud machines run on UTC with TZ unset, so every
// Taipei date is computed with an explicit offset, never from the machine's zone (SPEC §0.2, §4.1, §5.1).
// Copied from the Europe fork's lib/dates.ts and adapted (docs/PROVENANCE.md).

const DAY_MS = 86_400_000;
const TAIPEI_OFFSET_MS = 8 * 3_600_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === date;
}

function toUtcMs(date: string): number {
  if (!isValidDate(date)) throw new Error(`Invalid date: ${date}`);
  return Date.parse(`${date}T00:00:00Z`);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Today's Taipei calendar date. */
export function taipeiToday(now: Date = new Date()): string {
  return fromUtcMs(now.getTime() + TAIPEI_OFFSET_MS);
}

/** The Taipei calendar date of an ISO timestamp. */
export function taipeiDateOf(timestamp: string): string {
  return fromUtcMs(Date.parse(timestamp) + TAIPEI_OFFSET_MS);
}

/** "HH:MM" in Taipei for an ISO timestamp or Date. */
export function taipeiTime(at: string | Date): string {
  const ms = typeof at === "string" ? Date.parse(at) : at.getTime();
  return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(11, 16);
}

/** An ISO timestamp written as Taipei time with its offset: "2026-11-08T05:58:12+08:00". */
export function taipeiTimestamp(at: Date = new Date()): string {
  return `${new Date(at.getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 19)}+08:00`;
}

/** Milliseconds since the epoch of "HH:MM" Taipei time on `date` (SPEC §8: `at(date, "HH:MM")`). */
export function at(date: string, hhmm: string): number {
  if (!isValidDate(date) || !/^\d{2}:\d{2}$/.test(hhmm)) throw new Error(`Invalid time: ${date} ${hhmm}`);
  return Date.parse(`${date}T${hhmm}:00+08:00`);
}

/**
 * The UTC calendar date of a timestamp (SPEC §5.1). A timestamp with an offset or `Z` is converted to
 * UTC. One without an offset is read as UTC from its own fields, never through `new Date()` local
 * parsing. A bare date comes back unchanged.
 */
export function utcDateOf(timestamp: string): string {
  const s = timestamp.trim();
  if (isValidDate(s)) return s;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m) throw new Error(`Invalid timestamp: ${timestamp}`);
  const [, day, hh, mm, ss, zone] = m;
  // Every field must be in range, zoned or not: Date.parse would roll "24:00" into the next day, and an
  // unzoned timestamp never reaches Date.parse at all (PR 2 review).
  if (!isValidDate(day!) || Number(hh) > 23 || Number(mm) > 59 || Number(ss ?? "0") > 59) {
    throw new Error(`Invalid timestamp: ${timestamp}`);
  }
  if (!zone) return day!;
  const iso = `${day}T${hh}:${mm}:${ss ?? "00"}${zone.toUpperCase() === "Z" ? "Z" : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone}`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp: ${timestamp}`);
  return fromUtcMs(ms);
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

/** 0 for Sunday to 6 for Saturday. */
export function weekday(date: string): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

export function isMonday(date: string): boolean {
  return weekday(date) === 1;
}

/** The last complete UTC day an edition counts: the edition date minus 2 (SPEC §5.1). */
export function dataCutoffFor(editionDate: string): string {
  return addDays(editionDate, -2);
}

/** The closed window of `days` days ending on `cutoff`, both ends included (SPEC §5.1). */
export function windowEnding(cutoff: string, days: number): { from: string; to: string } {
  if (!Number.isInteger(days) || days < 1) throw new Error(`Invalid window length: ${days}`);
  return { from: addDays(cutoff, -(days - 1)), to: cutoff };
}

/** The Monday that starts the ISO week holding `date` (weeks run Monday to Sunday, UTC). */
export function isoWeekStart(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}

/** The latest Sunday on or before `cutoff`. */
export function lastSunday(cutoff: string): string {
  return addDays(cutoff, -weekday(cutoff));
}

/** The Monday of the newest ISO week that ends on or before `cutoff`. */
export function newestCompleteWeek(cutoff: string): string {
  return addDays(lastSunday(cutoff), -6);
}

/** True when `date` lies in [from, to], both inclusive. */
export function inRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}
