// What app/methodology/page.tsx reads besides vocab and config (SPEC §6 Route details, `/methodology`):
// STYLE_SECTIONS, the feed-status rows from the last 14 status files and the corrections log. Pure over a
// loaded Content and config; no Markdown here (only the page imports lib/markdown, §7 Untrusted text item 1).
// Owner: pages lane.
import type { Content } from "@/lib/content";
import { loadMetrics } from "@/lib/content";
import type { LoadedConfig } from "@/lib/config";
import type { Metrics } from "@/lib/schema/metrics";
import type { Correction } from "@/lib/schema/misc";
import type { FeedRecord, StatusFile } from "@/lib/schema/status";

/**
 * The routine/STYLE.md outline numbers (§11) of "Numbers and the Gap", "Sources and tiers", "Naming victims
 * and attackers" and "Corrections", which Methodology renders through section(md, n).
 */
export const STYLE_SECTIONS: Record<"gap" | "sources" | "naming" | "corrections", number> = {
  gap: 6,
  sources: 7,
  naming: 8,
  corrections: 14,
};

/** How many status files the feeds table reads (§6 `feeds`). */
export const FEED_DAYS = 14;

/**
 * One feeds-table row: a sources.yaml feed and its record in each of the last status files, from the day's last
 * run record that lists feeds (a hand publish, a skipped rerun or a start record lists none).
 */
export interface FeedRow {
  id: string;
  name: string;
  /** The newest status file's record (its last run that lists feeds), or null when that run did not list the feed. */
  latest: FeedRecord | null;
  /** Days whose last run that lists feeds had the feed "ok". */
  okDays: number;
  /** Status files read (at most FEED_DAYS). */
  days: number;
}

/**
 * The last FEED_DAYS valid status files, oldest first, each with the feeds by id of its last run record that lists
 * feeds (§6 `feeds`), as scripts/lib/status.ts feedIn() and publish read them; an empty map when no record that
 * day lists feeds (before collect has run, or after a crash), so the day reads "not run".
 */
export function lastStatusDays(status: readonly StatusFile[]): { date: string; feeds: Map<string, FeedRecord> }[] {
  return status.slice(-FEED_DAYS).map((s) => {
    const run = [...s.runs].reverse().find((r) => r.feeds.length > 0);
    return { date: s.date, feeds: new Map((run?.feeds ?? []).map((f) => [f.id, f])) };
  });
}

/** A row per sources.yaml feed, in registry order, from the last FEED_DAYS status files. */
export function feedRows(status: readonly StatusFile[], sources: LoadedConfig["sources"]): FeedRow[] {
  const days = lastStatusDays(status);
  const newest = days.at(-1);
  return sources.feeds.map((feed) => ({
    id: feed.id,
    name: feed.name,
    latest: newest?.feeds.get(feed.id) ?? null,
    okDays: days.filter((d) => d.feeds.get(feed.id)?.status === "ok").length,
    days: days.length,
  }));
}

/** Every correction, newest first (date, then id, both descending). */
export function correctionsNewestFirst(corrections: readonly Correction[]): Correction[] {
  return [...corrections].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** The newest valid metrics file (by name), parsed; null when there is none. */
export function newestMetrics(content: Content): Metrics | null {
  const files = [...content.metricsFiles].sort();
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const m = loadMetrics(content, files[i]!);
    if (m) return m;
  }
  return null;
}
