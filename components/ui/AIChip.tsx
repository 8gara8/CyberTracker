// STUB (SPEC §7 "Brief components", AIChip; Appendix A.3). Owner: items lane. none: nothing; unassessed: grey
// outline "AI: unassessed"; confirmed, reported: filled var(--ai) with the AI_ROLE_INFO word, title
// AI_CONFIDENCE_INFO[confidence]; claimed: violet outline, then CLAIMED_CHIP. Primary role only.
import type { AiConfidence, AiRole } from "@/lib/schema/common";

export interface AIChipProps {
  role: AiRole;
  confidence: AiConfidence | null;
  claimant: string | null;
}

export function AIChip({ role }: AIChipProps) {
  return role === "none" ? null : <span>{role}</span>;
}
