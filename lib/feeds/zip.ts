// The CVE List delta zips (SPEC §8.3): a small reader for stored and deflated entries, CRC-32 checked.
// Zip64, encryption, other methods and an entry inflating past its cap are a FeedParseError ("schema").
// P2 WP1 fills these stubs (S0 contract).

export interface ZipEntry {
  name: string;
  method: 0 | 8;
  size: number;
  data: Buffer;
}

/** CRC-32 (IEEE) of `buf`. */
export function crc32(buf: Buffer): number {
  throw new Error("not implemented: crc32");
}

/** Every entry of a zip; caps default to 4 MB per entry and 256 MB in all. */
export function readZip(buf: Buffer, opts?: { maxEntryBytes?: number; maxTotalBytes?: number }): ZipEntry[] {
  throw new Error("not implemented: readZip");
}

/** The parsed deltaCves/CVE-*.json records of a delta zip, with their entry names. */
export function parseDeltaZip(buf: Buffer): { records: unknown[]; names: string[] } {
  throw new Error("not implemented: parseDeltaZip");
}
