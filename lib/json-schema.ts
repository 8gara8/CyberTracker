import { z } from "zod";
import { DraftBrief } from "./schema/draft-brief";

// The JSON Schema the drafting agent writes against, generated from the Zod DraftBrief schema
// (SPEC §4.1, §4.4). `npm run schema:gen` writes it; `npm run schema:check` fails when it is stale.

export const DRAFT_SCHEMA_PATH = "routine/schema/draft-brief.schema.json";

/** No line of the schema file may reach this many characters, so the agent's file reader never cuts one. */
export const SCHEMA_LINE_LIMIT = 1000;

/**
 * JSON with short objects and arrays kept on one line. About a quarter smaller than 2-space
 * pretty-printing, and no line is long enough for the agent's file reader to truncate.
 */
export function printJson(value: unknown, indent = "", width = 110): string {
  const flat = JSON.stringify(value);
  if (value === null || typeof value !== "object" || flat.length + indent.length <= width) return flat;
  const next = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((v) => next + printJson(v, next, width)).join(",\n")}\n${indent}]`;
  const entries = Object.entries(value as Record<string, unknown>);
  return `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${printJson(v, next, width)}`).join(",\n")}\n${indent}}`;
}

/** The DraftBrief JSON Schema as a plain object (draft 2020-12), with a title and a do-not-edit note. */
export function draftSchema(): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(DraftBrief, { target: "draft-2020-12" }) as Record<string, unknown>;
  return {
    $schema,
    title: "CyberTracker DraftBrief",
    description: "The drafting agent's output, drafts/YYYY-MM-DD.json (SPEC.md §4.4). Generated from lib/schema by `npm run schema:gen`; do not edit by hand. Word budgets, counts and cross-references in descriptions are enforced by the validator.",
    ...rest,
  };
}

/** The file's exact text: the compact-printed schema and a final newline. */
export function renderDraftSchema(): string {
  return `${printJson(draftSchema())}\n`;
}

/** Size facts for the PR description and the tests: bytes, lines and the longest line. */
export function schemaFileStats(text: string): { bytes: number; lines: number; longestLine: number; longestLineNo: number } {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  let longestLine = 0;
  let longestLineNo = 0;
  lines.forEach((line, i) => {
    if (line.length > longestLine) {
      longestLine = line.length;
      longestLineNo = i + 1;
    }
  });
  return { bytes: Buffer.byteLength(text, "utf8"), lines: lines.length, longestLine, longestLineNo };
}
