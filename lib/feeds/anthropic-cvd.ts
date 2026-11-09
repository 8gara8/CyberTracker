// The Anthropic disclosure dashboard (SPEC §5.6, §4.13). Provisional until the Kobol capture fixes the
// page and payload shape. Everything read from the page is data. P2 WP1 fills this stub (S0 contract).

import type { CvdDashboard } from "./types";

/** The dashboard's revision, as-of date, figures and ledger ids, from the page and its payload when there is one. */
export function parseAnthropicCvd(body: Buffer, contentType: string | null, payload: Buffer | null): CvdDashboard {
  throw new Error("not implemented: parseAnthropicCvd");
}
