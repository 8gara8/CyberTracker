// The record links of an item page (SPEC §6 Route details, `/items/[id]`, "Records"). Owner: pages lane.
// lib/rank.ts, lib/collect.ts and lib/apply.ts each hold a module-local cve.org builder, but importing them
// would pull the feed readers and git helpers into the site bundle, so the site keeps its own here;
// ghsaRecordUrl() comes from lib/feeds/ghsa.ts, which is light.
export { ghsaRecordUrl } from "@/lib/feeds/ghsa";

/** The CVE record on cve.org. */
export function cveRecordUrl(cveId: string): string {
  return `https://www.cve.org/CVERecord?id=${encodeURIComponent(cveId)}`;
}

/**
 * CISA's KEV catalog filtered to one CVE (`search_api_fulltext`, the catalog page's own search box). §6 asks
 * P4 to verify that it filters, else to link the catalog root: from the cloud container the check could not
 * run (the proxy refuses www.cisa.gov), so the filter link stays until the check on Kobol; switching to the
 * root is this one function (KEV_CATALOG_URL).
 */
export function kevRecordUrl(cveId: string): string {
  return `${KEV_CATALOG_URL}?search_api_fulltext=${encodeURIComponent(cveId)}`;
}

/** The catalog root, the fallback §6 names. */
export const KEV_CATALOG_URL = "https://www.cisa.gov/known-exploited-vulnerabilities-catalog";

/** The CVE on NVD: the one aggregator linked (keyless, shows CISA's ADP scores). */
export function nvdRecordUrl(cveId: string): string {
  return `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cveId)}`;
}
