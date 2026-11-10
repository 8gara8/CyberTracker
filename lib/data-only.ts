// The data-only edition (SPEC §4.5 "Data-only edition", §8.2 stage 4, §8.7 publishDataOnly): the brief the
// run publishes from the feeds alone, before the agent runs. Pure: every input is passed in. The headline
// and summary templates are fixtures/src/site.ts's text exactly (plan §1 L3). Owner: lane L3. Step S0
// wrote the exports; L3 replaces the stub bodies.

import type { ComposeCommon, ContentChanges, CveFacts } from "./apply";
import type { CveLookup } from "./rules/types";
import type { InputsManifest } from "./schema/metrics";

/** At most this many new KEV entries become items (§4.5). */
export const DATA_ONLY_MAX_ITEMS = 10;

/** `CISA lists ${cve} in ${vendorProject} ${product} as exploited`, cut to 90 characters. */
export function dataOnlyHeadline(cve: string, vendorProject: string, product: string): string {
  throw new Error("P3 stub: dataOnlyHeadline (lane L3)");
}

/** site.ts's data-only summary text exactly. */
export function dataOnlySummary(cve: string, vendorProject: string, product: string, added: string, published: string): string {
  throw new Error("P3 stub: dataOnlySummary (lane L3)");
}

export interface DataOnlyInput extends ComposeCommon {
  /** datePublished from the record, else the KEV row's. */
  cveList: CveLookup | null;
  /** cvss, ssvc, KEV due date and catalog version, EPSS, GHSA ids (plan A5). */
  facts: CveFacts;
  /** metrics/inputs/D.json (plan A5). */
  inputs: InputsManifest | null;
  /** SHA-256 of metrics/D.json as committed: gap.metrics_sha256 (plan A5). */
  metricsSha256: string;
}

/** brief.edition "data_only", data_only_published_at = publishedAt. */
export function composeDataOnly(i: DataOnlyInput): ContentChanges {
  throw new Error("P3 stub: composeDataOnly (lane L3)");
}
