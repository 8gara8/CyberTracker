// NVD (SPEC §8.3, §4.6): fills `cvss` on kept candidates that lack a CNA or CISA ADP score; never a score
// input for ranking. Only NIST's own Primary metrics (source nvd@nist.gov), v4.0 before v3.1. Keyless:
// at most two GETs, six seconds apart (the caller spaces them).

import { z } from "zod";
import { FeedParseError } from "./types";

/** resultsPerPage, the most NVD returns a page; collect reads two pages, so at most 4,000 records a window. */
export const NVD_PAGE_SIZE = 2000;
const PAGE_SIZE = NVD_PAGE_SIZE;
const NIST = "nvd@nist.gov";
const CVE_RE = /^CVE-\d{4}-\d{4,}$/;

/** An instant as NVD's date parameter: UTC, milliseconds, no zone ("2026-10-12T20:30:00.000", read on Kobol). */
function nvdDate(instant: string): string {
  const t = Date.parse(instant);
  if (Number.isNaN(t) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(instant.trim())) throw new Error(`nvdUrls: not a zoned instant: ${instant}`);
  return new Date(t).toISOString().slice(0, 23);
}

/**
 * The two page URLs of a published-date range (window instants converted to UTC), resultsPerPage=2000:
 * startIndex 0, then 2000. The caller reads the second only when the first's totalResults is over 2,000.
 */
export function nvdUrls(base: string, window: { start: string; end: string }): string[] {
  const start = nvdDate(window.start);
  const end = nvdDate(window.end);
  const sep = base.includes("?") ? "&" : "?";
  return [0, PAGE_SIZE].map((i) => `${base}${sep}pubStartDate=${start}&pubEndDate=${end}&resultsPerPage=${PAGE_SIZE}&startIndex=${i}`);
}

const Metric = z.object({
  source: z.string().catch(""),
  type: z.string().catch(""),
  cvssData: z.object({ baseScore: z.number(), vectorString: z.string().catch("") }).optional().catch(undefined),
});
const NvdPage = z.object({
  totalResults: z.int().min(0),
  vulnerabilities: z.array(z.object({
    cve: z.object({
      id: z.string(),
      metrics: z.object({
        cvssMetricV40: z.array(Metric).catch([]),
        cvssMetricV31: z.array(Metric).catch([]),
      }).catch({ cvssMetricV40: [], cvssMetricV31: [] }),
    }),
  })),
});

type NvdScore = { score: number; version: "4.0" | "3.1"; vector: string };

/** One NVD API page: its totalResults and NIST's own Primary scores by CVE id (v4.0 first, else v3.1). */
export function parseNvdPage(body: Buffer): { total: number; scores: Map<string, NvdScore> } {
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    throw new FeedParseError("parse", "NVD answer is not JSON");
  }
  const parsed = NvdPage.safeParse(json);
  if (!parsed.success) throw new FeedParseError("schema", "NVD answer lacks totalResults or vulnerabilities");
  const scores = new Map<string, NvdScore>();
  const nist = (ms: z.infer<typeof Metric>[]) =>
    ms.find((m) => m.source === NIST && m.type === "Primary" && m.cvssData && m.cvssData.baseScore >= 0 && m.cvssData.baseScore <= 10);
  for (const v of parsed.data.vulnerabilities) {
    const id = v.cve.id.trim().toUpperCase();
    if (!CVE_RE.test(id)) continue;
    const v40 = nist(v.cve.metrics.cvssMetricV40);
    const v31 = nist(v.cve.metrics.cvssMetricV31);
    const pick = v40 ? { m: v40, version: "4.0" as const } : v31 ? { m: v31, version: "3.1" as const } : null;
    if (pick) scores.set(id, { score: pick.m.cvssData!.baseScore, version: pick.version, vector: pick.m.cvssData!.vectorString });
  }
  return { total: parsed.data.totalResults, scores };
}
