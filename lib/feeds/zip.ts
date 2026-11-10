// The CVE List delta zips (SPEC §8.3): a small reader for stored and deflated entries, CRC-32 checked,
// with no new package. It reads the end-of-central-directory record, then each central directory entry
// and its local header. Zip64, encryption, other methods, a bad CRC and an entry or a total inflating past
// its cap are a FeedParseError "schema"; bytes that are not a zip at all are "parse".

import zlib from "node:zlib";
import { FeedParseError } from "./types";

export interface ZipEntry {
  name: string;
  method: 0 | 8;
  size: number;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const DEFAULT_MAX_ENTRY = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL = 256 * 1024 * 1024;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3, the zip checksum) of `buf`, as an unsigned 32-bit number. */
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const schema = (message: string) => new FeedParseError("schema", `zip: ${message}`);

function findEocd(buf: Buffer): number {
  const stop = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG && i + EOCD_MIN + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  return -1;
}

/**
 * Every entry of a zip, in central-directory order. Caps default to 4 MB per entry and 256 MB in all;
 * directory entries (a name ending "/") come back with an empty body.
 */
export function readZip(buf: Buffer, opts: { maxEntryBytes?: number; maxTotalBytes?: number } = {}): ZipEntry[] {
  const maxEntry = opts.maxEntryBytes ?? DEFAULT_MAX_ENTRY;
  const maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL;
  if (buf.length < EOCD_MIN) throw new FeedParseError("parse", "zip: too short to be a zip");
  const eocd = findEocd(buf);
  if (eocd < 0) throw new FeedParseError("parse", "zip: no end-of-central-directory record");
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) throw schema("zip64 is not supported");
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const countHere = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw schema("zip64 is not supported");
  if (disk !== 0 || cdDisk !== 0 || countHere !== count) throw schema("multi-disk zips are not supported");
  if (cdOffset + cdSize > eocd) throw schema("central directory out of bounds");

  const out: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CENTRAL_SIG) throw schema(`central directory entry ${n} is malformed`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const name = nameBytes.toString(flags & FLAG_UTF8 ? "utf8" : "latin1");
    p += 46 + nameLen + extraLen + commentLen;

    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw schema(`${name}: zip64 is not supported`);
    if (flags & FLAG_ENCRYPTED) throw schema(`${name}: encrypted entries are not supported`);
    if (method !== 0 && method !== 8) throw schema(`${name}: compression method ${method} is not supported`);
    if (size > maxEntry) throw schema(`${name}: entry of ${size} bytes is over the ${maxEntry}-byte cap`);
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw schema(`${name}: local header missing`);
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + compSize > buf.length) throw schema(`${name}: data out of bounds`);
    const raw = buf.subarray(start, start + compSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: maxEntry });
      } catch (e) {
        throw schema(`${name}: ${(e as Error).message}`);
      }
    }
    if (data.length !== size) throw schema(`${name}: ${data.length} bytes where the directory says ${size}`);
    if (crc32(data) !== crc) throw schema(`${name}: CRC-32 mismatch`);
    total += data.length;
    if (total > maxTotal) throw schema(`entries total more than the ${maxTotal}-byte cap`);
    out.push({ name, method, size, data });
  }
  return out;
}

const DELTA_NAME = /^deltaCves\/CVE-\d{4}-\d{4,}\.json$/;

/**
 * The parsed deltaCves/CVE-*.json records of a delta zip, with their entry names, in zip order. Other
 * entries are ignored; a record that is not JSON is a FeedParseError "parse".
 */
export function parseDeltaZip(buf: Buffer): { records: unknown[]; names: string[] } {
  const records: unknown[] = [];
  const names: string[] = [];
  for (const e of readZip(buf)) {
    if (!DELTA_NAME.test(e.name)) continue;
    try {
      records.push(JSON.parse(e.data.toString("utf8")) as unknown);
    } catch {
      throw new FeedParseError("parse", `zip: ${e.name} is not JSON`);
    }
    names.push(e.name);
  }
  return { records, names };
}
