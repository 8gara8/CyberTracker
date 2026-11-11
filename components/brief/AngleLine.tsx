// STUB (SPEC §7 "Brief components", AngleLine: the siblings' Aside). Owner: brief lane. "ANGLE →", text, refs
// or "Gap metrics, data to <as_of> UTC", "(<shortDate(as_of)>)", "Counter-point:" with refs, "Bears on:
// <claim_id> <claim_text>" when set.
import type { Angle } from "@/lib/schema/draft-brief";
import type { SourceIndex } from "./sources";

export interface AngleLineProps {
  angle: Angle;
  index: SourceIndex;
}

export function AngleLine({ angle }: AngleLineProps) {
  return <aside>{angle.as_of}</aside>;
}
