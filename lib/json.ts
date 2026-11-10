// How every content, state, cache and fixture JSON file is printed (SPEC §4.1), in one place so scripts
// write files exactly as the fixtures builder does, and the one SHA-256 helper the metrics, the feeds and
// the backfill share. Pure: no clock, file or network.

import { createHash } from "node:crypto";
import type { z } from "zod";

/**
 * The file text of a value: parsed with `schema` when given (so keys follow the schema's order and a bad
 * value throws), printed with two-space indent, LF line ends and a trailing newline.
 */
export function jsonText(value: unknown, schema?: z.ZodType): string {
  return `${JSON.stringify(schema ? schema.parse(value) : value, null, 2)}\n`;
}

/** SHA-256 as lower-case hex; a string is hashed as its UTF-8 bytes. */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
