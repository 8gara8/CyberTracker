// STUB (SPEC §7 "Brief components", CorrectionBanner). Owner: items lane (ItemCard and the item page use it).
// role="note", left rule, panel: per correction "<TYPE> <shortDate(date)> · <field>: now '<after>'. <reason>"
// with link; NAME REMOVED reads "NAME REMOVED <date> · while a dispute about a named party is reviewed."
import type { Correction } from "@/lib/schema/misc";

export interface CorrectionBannerProps {
  /** Oldest first (correctionsFor()); renders nothing when empty. */
  corrections: Correction[];
}

export function CorrectionBanner({ corrections }: CorrectionBannerProps) {
  return corrections.length ? <div role="note">{corrections.length}</div> : null;
}
