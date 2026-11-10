// The run's evidence (SPEC §8.12 "Evidence"): every URL the agent fetched or searched, the texts the
// validator may check against (pack, CVE records, snapshots) and seen_as per URL (pack, else fetched, else
// search), which publish copies to each source. Replaces Europe's evidenceUrls(). Owner: lane L4. Step S0
// wrote the export; L4 replaces the stub body.

import type { Evidence } from "../../lib/schema/misc";
import type { Pack } from "../../lib/schema/pack";
import type { Snapshot } from "./snapshot";
import type { Transcript } from "./transcript";

export function buildEvidence(i: { transcripts: readonly Transcript[]; pack: Pack; snapshots: readonly Snapshot[] }): Evidence {
  throw new Error("P3 stub: buildEvidence (lane L4)");
}
