// content/state/kev-index.json (SPEC §4.7, §5.3): every KEV entry with its CVE record's publication date
// and assigner, mirroring the current catalog (an entry CISA removes leaves it, ruling R20), and the
// metrics `kev` summary. Pure: the catalog and the records come in as parameters.

import type { KevCatalog, KevEntry } from "../feeds/types";
import { compareCveIds } from "../ids";
import type { KevIndexFile, KevIndexRow, KevSummary } from "../schema/metrics";
import type { JoinFacts } from "./window";

/** KEV order: date_added, then CVE number (newest last). */
const byAdded = (a: KevIndexRow, b: KevIndexRow): number =>
  a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : compareCveIds(a[0], b[0]);

/** KEV's knownRansomwareCampaignUse, lower-cased: "known", else "unknown". */
function ransomware(v: string): KevIndexRow[6] {
  return v.trim().toLowerCase() === "known" ? "known" : "unknown";
}

/** The facts a row stores: the record's UTC publication date and assigner when it joins, else both null. */
function joined(f: JoinFacts | null | undefined): { date_published: string | null; assigner: string | null } {
  if (!f || f.state !== "PUBLISHED" || f.date_published === null) return { date_published: null, assigner: null };
  return { date_published: f.date_published, assigner: f.assigner };
}

/** Rows in KEV order, one per CVE id (a repeated id keeps its earliest date_added). */
function finish(rows: KevIndexRow[]): KevIndexRow[] {
  rows.sort(byAdded);
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r[0]) ? false : (seen.add(r[0]), true)));
}

function row(e: KevEntry, facts: { date_published: string | null; assigner: string | null }): KevIndexRow {
  return [e.cveID, e.dateAdded, e.vendorProject, e.product, facts.date_published, facts.assigner, ransomware(e.knownRansomwareCampaignUse)];
}

/**
 * The backfill's index (§5.9 step 3): every catalog entry, all eras, with date_published and assigner from
 * `facts` (null when the record is missing, not PUBLISHED or undated). updated_at = cutoff.
 */
export function buildKevIndex(catalog: KevCatalog, facts: ReadonlyMap<string, JoinFacts>, cutoff: string): KevIndexFile {
  return {
    schema_version: 1,
    updated_at: cutoff,
    catalog_version: catalog.catalogVersion,
    entries: finish(catalog.vulnerabilities.map((e) => row(e, joined(facts.get(e.cveID))))),
  };
}

/**
 * A morning's update (§5.3): the entries are the current catalog's (new entries added, removed ones dropped,
 * vendor, product and ransomware as the catalog now writes them). A row that was joined keeps its facts; a
 * row without a publication date (a new entry, or one listed before its record was published) takes them
 * from `fetched`, collect's by-id records, where null is a 404 (still unjoined).
 */
export function updateKevIndex(prev: KevIndexFile, catalog: KevCatalog, fetched: ReadonlyMap<string, JoinFacts | null>, cutoff: string): KevIndexFile {
  const before = new Map<string, KevIndexRow>();
  for (const r of prev.entries) if (!before.has(r[0])) before.set(r[0], r);
  const entries = catalog.vulnerabilities.map((e) => {
    const old = before.get(e.cveID);
    if (old && old[4] !== null) return row(e, { date_published: old[4], assigner: old[5] });
    return row(e, joined(fetched.get(e.cveID)));
  });
  return { schema_version: 1, updated_at: cutoff, catalog_version: catalog.catalogVersion, entries: finish(entries) };
}

/** The join facts the index holds, by CVE id: a row with a publication date was PUBLISHED when joined; others are absent. */
export function indexFacts(index: Pick<KevIndexFile, "entries">): Map<string, JoinFacts> {
  const out = new Map<string, JoinFacts>();
  for (const r of index.entries) {
    if (r[4] !== null && !out.has(r[0])) out.set(r[0], { state: "PUBLISHED", date_published: r[4], assigner: r[5] });
  }
  return out;
}

/** The index rows as catalog entries for joinKev() (cveID, dateAdded, vendorProject). */
export function indexEntries(index: Pick<KevIndexFile, "entries">): Pick<KevEntry, "cveID" | "dateAdded" | "vendorProject">[] {
  return index.entries.map((r) => ({ cveID: r[0], dateAdded: r[1], vendorProject: r[2] }));
}

/**
 * metrics.kev (§4.7, §5.3): the catalog's version, count and release time, and the catalog entries whose CVE
 * id is not in `baseline` (content/state/kev-index.json as committed with the newest brief), in KEV order
 * (date_added, then CVE number, as newKevIds() orders them). Not windowed by the cutoff. With no baseline,
 * since_catalog_version is null and no id is new.
 */
export function kevSummary(catalog: KevCatalog, baseline: Pick<KevIndexFile, "entries" | "catalog_version"> | null): KevSummary {
  let ids: string[] = [];
  if (baseline) {
    const known = new Set(baseline.entries.map((r) => r[0]));
    ids = catalog.vulnerabilities
      .filter((v) => !known.has(v.cveID))
      .sort((a, b) => (a.dateAdded < b.dateAdded ? -1 : a.dateAdded > b.dateAdded ? 1 : compareCveIds(a.cveID, b.cveID)))
      .map((v) => v.cveID);
    ids = [...new Set(ids)];
  }
  return {
    catalog_version: catalog.catalogVersion,
    catalog_count: catalog.count,
    date_released: catalog.dateReleased,
    new_since_last_edition: { since_catalog_version: baseline?.catalog_version ?? null, cve_ids: ids },
  };
}
