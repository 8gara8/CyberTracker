"use client";
// STUB (SPEC §7 "Page frame", StaleBanner). Owner: pages lane. Props baked in at build; renders nothing on
// the server and the first render; in useEffect checks isStale(new Date(), lastDate, staleAfter)
// (lib/stale.ts) now, every 60 s and on visibilitychange; stale: a full-width <div role="status">, inverted,
// mono 12px uppercase, staleText(lastDate, lastPublishedAt). Only on / and the newest brief (BriefView).

export interface StaleBannerProps {
  /** The newest valid brief's date. */
  lastDate: string;
  /** Its published_at. */
  lastPublishedAt: string;
  /** run.json schedule.stale_after ("08:00"): STALE_AFTER in lib/site.ts. */
  staleAfter: string;
}

export function StaleBanner(_props: StaleBannerProps) {
  return null;
}
