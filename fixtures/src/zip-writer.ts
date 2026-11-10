// A stored-method zip writer for the generated delta-zip fixtures (fixtures plan §3.2). Stored entries
// (no compression) keep the bytes the same on every platform and Node version, where deflate output
// depends on the zlib build. Deflate is exercised in memory only, in tests/feeds.test.ts.

import { crc32 } from "../../lib/feeds/zip";

/** One file to put in the zip: its name inside the archive and its bytes. */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** Version 1.0 is enough to extract a stored entry. */
const VERSION = 10;
/** General purpose flag bit 11: names are UTF-8. */
const FLAG_UTF8 = 0x0800;
/** DOS time 00:00:00 and DOS date 1980-01-01 ((1980 - 1980) << 9 | 1 << 5 | 1). */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

/**
 * A stored-method zip (no compression): local headers, central directory, end record; DOS time fixed at
 * 1980-01-01 00:00, general flag 0x0800 (UTF-8 names), entries in the given order, no extra fields and no
 * comments. Byte-identical on every platform and Node version. CRC from crc32() in lib/feeds/zip.ts.
 * Throws past the plain zip limits (65,535 entries, 4 GiB), which a fixture never comes near.
 */
export function storedZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length >= MAX_U16) throw new Error(`storedZip: ${entries.length} entries is past the plain zip limit`);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    if (name.length > MAX_U16) throw new Error(`storedZip: name too long: ${e.name.slice(0, 40)}`);
    const size = e.data.length;
    const crc = crc32(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(VERSION, 4); // made by: MS-DOS, 1.0
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, e.data);
    centrals.push(central, name);
    offset += local.length + name.length + size;
    if (offset >= MAX_U32) throw new Error("storedZip: archive past 4 GiB");
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}
