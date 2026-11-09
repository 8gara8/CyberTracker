// NVD (SPEC §8.3): fills `cvss` on kept candidates that lack a CNA or CISA ADP score; never a score input
// for ranking. Only NIST's own Primary metrics, v4.0 before v3.1. P2 WP1 fills these stubs (S0 contract).

/** At most two pages of a published-date range, resultsPerPage=2000. */
export function nvdUrls(base: string, window: { start: string; end: string }): string[] {
  throw new Error("not implemented: nvdUrls");
}

/** One NVD API page: its totalResults and the NIST scores by CVE id. */
export function parseNvdPage(body: Buffer): { total: number; scores: Map<string, { score: number; version: "4.0" | "3.1"; vector: string }> } {
  throw new Error("not implemented: parseNvdPage");
}
