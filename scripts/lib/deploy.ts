// The deploy check (SPEC §8.2 stage 9): the run requests no build; it watches `${siteUrl()}/` until the
// `ct-edition` meta (§6) shows D and the edition, or the wait ends. A timeout is a note, not a failure.
// Owner: lane L6. Step S0 wrote the exports; L6 replaces the stub bodies.

import type { Edition } from "../../lib/vocab";
import type { Clock } from "./clock";

export interface EditionMeta {
  date: string;
  edition: Edition;
  published_at: string;
}

/** <meta name="ct-edition" content="DATE EDITION PUBLISHED_AT"> */
export function parseEditionMeta(html: string): EditionMeta | null {
  throw new Error("P3 stub: parseEditionMeta (lane L6)");
}

export interface DeployCheck {
  ready_at: string | null;
  shows_date: string | null;
  shows_edition: Edition | null;
  shows: boolean;
}

/** GET `${siteUrl}/` at once, then every 20 s while time is left of maxMs (≤ 0: one GET only); each GET ≤ 15 s via fetchImpl. */
export function waitForEdition(date: string, edition: Edition | null, maxMs: number, o: {
  now: Clock; fetchImpl: typeof fetch; siteUrl?: string; pollMs?: number; getMs?: number; sleep?: (ms: number) => Promise<void>;
}): Promise<DeployCheck> {
  throw new Error("P3 stub: waitForEdition (lane L6)");
}
