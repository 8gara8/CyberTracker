// MyJVN (JVN iPedia's API, SPEC §4.13, §8.3). P2 WP1 fills these stubs (S0 contract).

import type { JvnNote, Parsed } from "./types";

/** One MyJVN getVulnOverviewList page, with its totalRes and totalResRet. */
export function parseMyJvn(body: Buffer): Parsed<JvnNote> & { totalRes: number; totalResRet: number } {
  throw new Error("not implemented: parseMyJvn");
}

/** The further page URLs (startItem 1, 51, 101 ...), at most `maxPages` (default 10). */
export function myjvnPageUrls(registryUrl: string, totalRes: number, maxPages?: number): string[] {
  throw new Error("not implemented: myjvnPageUrls");
}
