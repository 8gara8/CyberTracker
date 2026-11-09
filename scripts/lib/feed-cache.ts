// Reads what collect left in cache/ (cache/feeds/inputs.json, index.json and the bodies) for the metrics.
// P2 WP3 fills this stub (S0 contract).

import type { CveFacts, CvdDashboard, EpssDay, FeedState, GhsaAdvisory, KevCatalog } from "../../lib/feeds/types";
import type { CollectInputsFile, FeedIndexFile } from "../../lib/schema/pack";

/** One feed as the metrics see it. */
export interface FeedRead {
  id: string;
  status: FeedState;
  as_of: string | null;
  version: string | null;
  sha256: string | null;
  records: number;
  fetched_at: string | null;
}

export interface MetricsFeeds {
  inputs: CollectInputsFile;
  index: FeedIndexFile;
  kev: { read: FeedRead; catalog: KevCatalog | null };
  cvelist: {
    read: FeedRead;
    /** Day X with X + 1's copy of a record winning. */
    days: { date: string; ok: boolean; records: CveFacts[] }[];
    zipRecords: CveFacts[];
    /** null = 404. */
    byId: ReadonlyMap<string, CveFacts | null>;
  };
  epss: { read: FeedRead; e: EpssDay | null; e1: EpssDay | null; e7: EpssDay | null };
  ghsa: { read: FeedRead; advisories: GhsaAdvisory[]; headDate: string | null };
  anthropicCvd: { read: FeedRead; dashboard: CvdDashboard | null; sourceUrl: string };
}

/** cache/feeds/inputs.json is absent, or for another date. */
export class NoFeedsError extends Error {
  constructor(message = "no collect cache for this date") {
    super(message);
    this.name = "NoFeedsError";
  }
}

/** Throws NoFeedsError when inputs.json is absent or for another date. */
export function loadFeedCache(root: string, date: string): MetricsFeeds {
  throw new Error("not implemented: loadFeedCache");
}
