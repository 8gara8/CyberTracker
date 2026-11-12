"use client";
// SPEC §7 "Page frame", StaleBanner. Owner: pages lane. Props are baked in at build; the check runs only in
// the reader's browser, because a static page cannot know today's date: nothing renders on the server or
// on the first render (so hydration matches), then useEffect checks isStale(new Date(), lastDate,
// staleAfter) (lib/stale.ts, Taipei's clock, never the device's) at once, every 60 s and on
// visibilitychange. Stale: a full-width <div role="status">, inverted, mono 12px uppercase, staleText().
// BriefView shows it only when isLatest (on / and the newest brief). One of the two client components.
import { useEffect, useState } from "react";
import { isStale, staleText } from "@/lib/stale";

export interface StaleBannerProps {
  /** The newest valid brief's date. */
  lastDate: string;
  /** Its published_at. */
  lastPublishedAt: string;
  /** run.json schedule.stale_after ("08:00"): STALE_AFTER in lib/site.ts. */
  staleAfter: string;
}

/** How often an open page checks again (§7: every 60 s). */
const RECHECK_MS = 60_000;

export function StaleBanner({ lastDate, lastPublishedAt, staleAfter }: StaleBannerProps) {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const check = () => setStale(isStale(new Date(), lastDate, staleAfter));
    check();
    const timer = window.setInterval(check, RECHECK_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [lastDate, staleAfter]);

  if (!stale) return null;
  return (
    <div role="status" className="mb-4 w-full bg-fg px-3 py-2 font-mono text-[12px] uppercase tracking-[0.12em] text-bg">
      {staleText(lastDate, lastPublishedAt)}
    </div>
  );
}
