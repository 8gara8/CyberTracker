// Page snapshots for the soft gates (SPEC §4.12 step 1): one GET per cited URL with no seen text, through
// fetchFeed(), HTML to text with lib/html-text.ts, results in cache/snapshots/<sha256 of the normalised
// URL>.json. Snapshots stay on Kobol; content/ keeps only the URL and its text hash. Owner: lane L4. Step
// S0 wrote the exports; L4 replaces the stub bodies.

import type { SnapshotHashes } from "../../lib/apply";
import type { LoadedConfig } from "../../lib/config";
import type { fetchFeed } from "../../lib/feeds/http";
import type { Evidence } from "../../lib/schema/misc";

/** §4.12: 15 s per GET, 5 redirects, the body cut at 3 MB, 6 at a time, 3 minutes per round. */
export const SNAPSHOT_LIMITS = { timeoutMs: 15_000, redirects: 5, maxBytes: 3 * 1024 * 1024, concurrency: 6, roundMs: 3 * 60_000 } as const;

/** The browser-like Accept and Accept-Language a snapshot GET sends (§4.12; plan A11), with run.json user_agent. */
export const SNAPSHOT_HEADERS = { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", acceptLanguage: "en-US,en;q=0.9" } as const;

/** cache/snapshots/<sha256(normalizeUrl(url))>.json */
export interface Snapshot {
  url: string;
  final_url: string;
  status: number;
  fetched_at: string;
  content_type: string;
  text_sha256: string;
  text: string;
}

/** cache/snapshots/<sha256(normalizeUrl(url))>.json */
export function snapshotFile(root: string, url: string): string {
  throw new Error("P3 stub: snapshotFile (lane L4)");
}

export function readSnapshot(root: string, url: string): Snapshot | null {
  throw new Error("P3 stub: readSnapshot (lane L4)");
}

/** Normalised URLs of the draft's sources (items, angle, elsewhere, lens) with no evidence text yet. */
export function citedUnseen(draft: unknown, evidence: Evidence | null): string[] {
  throw new Error("P3 stub: citedUnseen (lane L4)");
}

/**
 * One round: GET via fetchFeed (SNAPSHOT_HEADERS, run.json user_agent), BLOCKED_HOSTS skipped, HTML only,
 * 6 at a time, no request started at or after `deadline` (Date.now() ms: pass realDeadline()). Each URL is
 * requested exactly as the draft stores it; normalizeUrl() is used only for keys and file names (plan A13).
 * Writes each snapshot file.
 */
export function snapshotUrls(o: {
  root: string; urls: readonly string[]; deadline: number; config: LoadedConfig;
  fetch?: typeof fetchFeed; log?: (line: string) => void;
}): Promise<{ taken: Snapshot[]; failed: string[]; skipped: string[] }> {
  throw new Error("P3 stub: snapshotUrls (lane L4)");
}

export function snapshotHashes(snaps: readonly Snapshot[]): SnapshotHashes {
  throw new Error("P3 stub: snapshotHashes (lane L4)");
}
