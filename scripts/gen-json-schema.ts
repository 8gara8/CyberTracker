// Writes routine/schema/draft-brief.schema.json from the Zod DraftBrief schema (SPEC §4.4, §8.1).
// `--check` exits 1 when the committed file is stale and never writes it (CI runs it as schema:check).

import fs from "node:fs";
import path from "node:path";
import { DRAFT_SCHEMA_PATH, SCHEMA_LINE_LIMIT, renderDraftSchema, schemaFileStats } from "../lib/json-schema";

function main(): number {
  const rendered = renderDraftSchema();
  const stats = schemaFileStats(rendered);
  if (stats.longestLine >= SCHEMA_LINE_LIMIT) {
    console.error(`Line ${stats.longestLineNo} of the rendered schema has ${stats.longestLine} characters; the limit is under ${SCHEMA_LINE_LIMIT}.`);
    return 1;
  }
  const facts = `${stats.bytes} bytes, ${stats.lines} lines, longest line ${stats.longestLine} characters`;
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(DRAFT_SCHEMA_PATH) ? fs.readFileSync(DRAFT_SCHEMA_PATH, "utf8") : "";
    if (current !== rendered) {
      console.error(`${DRAFT_SCHEMA_PATH} is stale; run npm run schema:gen and commit the result.`);
      return 1;
    }
    console.log(`${DRAFT_SCHEMA_PATH} is current (${facts}).`);
    return 0;
  }
  fs.mkdirSync(path.dirname(DRAFT_SCHEMA_PATH), { recursive: true });
  fs.writeFileSync(DRAFT_SCHEMA_PATH, rendered);
  console.log(`Wrote ${DRAFT_SCHEMA_PATH} (${facts}).`);
  return 0;
}

process.exitCode = main();
