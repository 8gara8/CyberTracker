// content/state/kev-index.json (SPEC §4.7, §5.3): every KEV entry with its CVE record's publication date
// and assigner, mirroring the current catalog, and the metrics `kev` summary. Pure. P2 WP3 fills these
// stubs (S0 contract).

import type { KevCatalog } from "../feeds/types";
import type { KevIndexFile, KevSummary } from "../schema/metrics";
import type { JoinFacts } from "./window";

/** The backfill's index: every catalog entry joined to `facts`; updated_at = cutoff. */
export function buildKevIndex(catalog: KevCatalog, facts: ReadonlyMap<string, JoinFacts>, cutoff: string): KevIndexFile {
  throw new Error("not implemented: buildKevIndex");
}

/** A morning's update: new entries added, unjoined rows re-joined from `fetched` (null = 404), removed entries dropped. */
export function updateKevIndex(prev: KevIndexFile, catalog: KevCatalog, fetched: ReadonlyMap<string, JoinFacts | null>, cutoff: string): KevIndexFile {
  throw new Error("not implemented: updateKevIndex");
}

/** The join facts the index holds, by CVE id. */
export function indexFacts(index: Pick<KevIndexFile, "entries">): Map<string, JoinFacts> {
  throw new Error("not implemented: indexFacts");
}

/** metrics.kev; the new ids come from newKevIds(). */
export function kevSummary(catalog: KevCatalog, baseline: Pick<KevIndexFile, "entries" | "catalog_version"> | null): KevSummary {
  throw new Error("not implemented: kevSummary");
}
