// STUB (SPEC §7 "Brief components", SeverityPips; Appendix A.3). Owner: items lane. <span class="pips"
// aria-hidden="true">●●●○</span>, the word (HIGH), hidden "High, 3 of 4" ("level 3 of 4" for regions). Null
// level: "LANDMARK · <KIND label>" when landmark, else the kind label in grey, or "UNRATED" for a kind whose
// severity is required (only a data-only brief leaves it null).
import type { KindId, RegionLevel, Severity } from "@/lib/schema/common";

export interface SeverityPipsProps {
  scale: "severity" | "region";
  /** A Severity for scale "severity", a RegionLevel for scale "region"; null for no level. */
  level: Severity | RegionLevel | null;
  landmark?: boolean;
  /** The item's kind, for the null-level label. */
  kind?: KindId;
}

export function SeverityPips({ level }: SeverityPipsProps) {
  return <span>{level ?? ""}</span>;
}
