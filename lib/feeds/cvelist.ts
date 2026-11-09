// The CVE List V5 (SPEC §8.3, §4.6, §5.4, §5.5, §5.12): deltaLog.json, and the two projections of one
// CVE JSON 5 record. cveFacts(raw) equals the CveFacts part of parseCveRecord(raw), and both agree with
// lib/validate.ts cveRecordInfo() on every shared field. P2 WP1 fills these stubs (S0 contract).

import type { SourceTiersFile } from "../schema/config";
import type { CveFacts, CveRecord, DeltaLogEntry, Parsed } from "./types";

/** deltaLog.json; `newest` is the latest fetchTime. */
export function parseDeltaLog(body: Buffer): Parsed<DeltaLogEntry> {
  throw new Error("not implemented: parseDeltaLog");
}

/** The lean projection (clone reader, zips, by-id records); null without a readable cveMetadata. */
export function cveFacts(raw: unknown): CveFacts | null {
  throw new Error("not implemented: cveFacts");
}

/** The full projection for the pack and rank; null without a readable cveMetadata. */
export function parseCveRecord(raw: unknown): CveRecord | null {
  throw new Error("not implemented: parseCveRecord");
}

/** §8.3's advisory URLs of a record: never exploit-tagged, blocked, non-https or over 500 characters; at most 5, normalised. */
export function recordAdvisoryUrls(rec: CveRecord, cfg: Pick<SourceTiersFile, "github">): string[] {
  throw new Error("not implemented: recordAdvisoryUrls");
}
