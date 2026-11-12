// The site's record links (SPEC §6 Route details, `/items/[id]`, "Records"; §7 ItemDetails and EpssMovers):
// one builder per record page, used by the item page and the brief's components alike, and the KEV catalog's
// root as a constant (CISA has no page per CVE). lib/rank.ts, lib/collect.ts and lib/apply.ts each hold a
// module-local cve.org builder, but importing them would pull the feed readers and git helpers into the site
// bundle, so the site keeps its own here; ghsaRecordUrl() comes from lib/feeds/ghsa.ts, which is light.
export { ghsaRecordUrl } from "@/lib/feeds/ghsa";

/** The CVE record on cve.org. */
export function cveRecordUrl(cveId: string): string {
  return `https://www.cve.org/CVERecord?id=${encodeURIComponent(cveId)}`;
}

/**
 * CISA's KEV catalog, the root: the catalog has no page per CVE, and the Kobol check (2026-11-12) found that its
 * search parameter (`?search_api_fulltext=<CVE>`) is ignored, the page listing the whole catalog newest first,
 * so §6's fallback applies and the item page links the root for every CVE on the list.
 */
export const KEV_CATALOG_URL = "https://www.cisa.gov/known-exploited-vulnerabilities-catalog";

/** The CVE on NVD: the one aggregator linked (keyless, shows CISA's ADP scores). */
export function nvdRecordUrl(cveId: string): string {
  return `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cveId)}`;
}
