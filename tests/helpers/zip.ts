// In-memory zips for the zip reader's tests: stored and deflated entries, and the broken shapes the reader
// must refuse (a bad CRC, an unknown method, zip64 markers, encryption). Never written to a fixture file:
// deflate bytes depend on the zlib build.
import zlib from "node:zlib";
import { crc32 } from "@/lib/feeds/zip";

export interface TestZipEntry {
  name: string;
  data: Buffer | string;
  /** 0 stored (default), 8 deflate; any other number is written as is with the data stored. */
  method?: number;
  /** General purpose flags; default 0x0800 (UTF-8 names). */
  flags?: number;
  /** Overrides the CRC-32 written in both headers. */
  crc?: number;
  /** Overrides the uncompressed size written in the central directory. */
  size?: number;
}

export interface TestZipOptions {
  /** Puts a zip64 end-of-central-directory locator before the end record. */
  zip64Locator?: boolean;
  /** Overrides the entry count in the end record (0xffff marks zip64). */
  count?: number;
  /** A comment after the end record. */
  comment?: string;
}

/** A zip built entry by entry, as a delta zip is laid out: local headers and data, central directory, end record. */
export function makeZip(entries: readonly TestZipEntry[], opts: TestZipOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : e.data;
    const method = e.method ?? 0;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(e.name, "utf8");
    const flags = e.flags ?? 0x0800;
    const crc = e.crc ?? crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(flags, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x0021, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.size ?? data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);

    parts.push(local, name, body);
    central.push(dir, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const comment = Buffer.from(opts.comment ?? "", "utf8");
  const locator = Buffer.alloc(opts.zip64Locator ? 20 : 0);
  if (opts.zip64Locator) locator.writeUInt32LE(0x07064b50, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(opts.count ?? entries.length, 8);
  end.writeUInt16LE(opts.count ?? entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, directory, locator, end, comment]);
}
