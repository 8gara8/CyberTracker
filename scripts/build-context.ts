// `npm run context -- --date D [--deadline HH:MM] [--out drafts/context.json]` (SPEC §8.5): reads §8.5's
// files and writes BuiltContext.text. Owner: lane L4. Step S0 wrote the export; L4 replaces the stub body
// and adds the direct-run line.

import type { Clock } from "./lib/clock";

/** 0 written, 1 error, 2 usage. */
export async function main(argv: string[], deps?: { now?: Clock }): Promise<number> {
  throw new Error("P3 stub: main (build-context, lane L4)");
}
