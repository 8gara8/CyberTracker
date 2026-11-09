// RSS and Atom feeds (SPEC §4.13, §8.3), and the CERT notes read from them: TWCERT's TVN feed and
// JPCERT's. P2 WP1 fills these stubs (S0 contract).

import type { CertNote, Parsed, RawItem } from "./types";

/** One RSS or Atom body; a parser throw becomes FeedParseError "parse". */
export async function parseRss(body: Buffer): Promise<Parsed<RawItem>> {
  throw new Error("not implemented: parseRss");
}

/** TWCERT TVN notes: TVN-\d{9} and CVE ids from title and snippet. */
export function tvnRecords(items: readonly RawItem[]): CertNote[] {
  throw new Error("not implemented: tvnRecords");
}

/** JPCERT notes; `alert` when the link matches one of JP's alert_patterns (compiled by the caller). */
export function jpcertRecords(items: readonly RawItem[], alertRes: readonly RegExp[]): CertNote[] {
  throw new Error("not implemented: jpcertRecords");
}
