// STUB (SPEC §7 "Brief components", CorrectionsList). Owner: brief lane. The foot block (omitted when
// brief.corrections is empty): "<id> · <longDate(edition_date)> edition · <item id> (linked to
// /brief/<edition_date>#<item id>) · <TYPE> · <reason>".
import type { Correction } from "@/lib/schema/misc";

export interface CorrectionsListProps {
  corrections: Correction[];
}

export function CorrectionsList({ corrections }: CorrectionsListProps) {
  return <ol>{corrections.map((c) => <li key={c.id}>{c.id}</li>)}</ol>;
}
