// The CISA KEV catalog (SPEC §8.3, §5.3): the parser, the advisory URLs in `notes`, and kevBaseline(),
// which decides the run's new KEV ids. P2 WP1 fills these stubs (S0 contract).

import type { KevIndexFile, Metrics } from "../schema/metrics";
import type { KevCatalog, KevEntry, Parsed } from "./types";

/** The catalog; `count` must equal the entries and every entry must carry cveID and dateAdded, else FeedParseError "schema". */
export function parseKev(body: Buffer): Parsed<KevEntry> & { catalog: KevCatalog } {
  throw new Error("not implemented: parseKev");
}

/** The URLs in a KEV `notes` field: split on ";", trimmed, raw (collect filters them). */
export function kevNoteUrls(notes: string): string[] {
  throw new Error("not implemented: kevNoteUrls");
}

export interface NewKevIdsInput {
  date: string;
  catalog: KevCatalog;
  /** Past-date dry runs (P3): the catalog is cut to dateAdded ≤ D − 1 and the ids added on D − 1 are new. */
  asOf: boolean;
  committedMetrics: Pick<Metrics, "kev"> | null;
  kevIndex: Pick<KevIndexFile, "entries"> | null;
}

export interface NewKevIdsResult {
  newKevIds: string[];
  source: "as-of" | "metrics" | "kev-index" | "recent-7-days";
  /** The catalog as used (cut when asOf). */
  catalog: KevCatalog;
}

/** §8.3 kevBaseline(), pure core. */
export function newKevIds(i: NewKevIdsInput): NewKevIdsResult {
  throw new Error("not implemented: newKevIds");
}

/** The file wrapper: reads content/metrics/D.json and content/state/kev-index.json under contentDir. */
export function kevBaseline(a: { contentDir: string; date: string; catalog: KevCatalog; asOf: boolean }): ReturnType<typeof newKevIds> {
  throw new Error("not implemented: kevBaseline");
}
