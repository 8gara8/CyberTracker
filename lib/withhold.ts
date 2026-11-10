// Withholding an item on a reader dispute (SPEC §4.10): one name_removed correction per request (trigger
// reader_report, the dispute id), the brief rewritten, "[withheld]" marks in later stored briefs. Victim
// and attribution disputes withhold at once. Pure: every input is passed in. Owner: lane L3. Step S0 wrote
// the exports; L3 replaces the stub body.

import type { ContentChanges } from "./apply";
import type { LoadedConfig } from "./config";
import type { Brief } from "./schema/brief";
import type { Metrics } from "./schema/metrics";
import type { ArchiveIndex, CorrectionsFile, Dispute } from "./schema/misc";

/** One item to withhold: what intake (scripts/recheck.ts) and dropPendingEditions() hand to publish. */
export interface WithholdRequest {
  item_id: string;
  edition_date: string;
  kind: "victim" | "attribution";
  dispute_id: string;
  /** The run's edition date D. */
  since: string;
}

export interface WithholdInput {
  date: string;
  config: LoadedConfig;
  /** Every stored brief dated on or after the earliest request's edition_date (later briefs carry region reasons). */
  briefs: readonly Brief[];
  corrections: CorrectionsFile | null;
  /** The updated list; requests' disputes get correction_id. */
  disputes: readonly Dispute[];
  archiveIndex: ArchiveIndex | null;
  /** computed is recounted per brief. */
  metricsFor: (date: string) => Metrics | null;
  requests: readonly WithholdRequest[];
}

/** §4.10's rewrite: brief null; rewritten filled. */
export function composeWithholds(i: WithholdInput): ContentChanges {
  throw new Error("P3 stub: composeWithholds (lane L3)");
}
