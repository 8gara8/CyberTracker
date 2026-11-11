// SPEC §7 "Brief components", AIChip; Appendix A.3. The primary role only (ai_role_secondary is never
// rendered). none: nothing. unassessed: a grey outline "AI: unassessed", never violet. confirmed or reported: a
// filled violet chip (var(--ai), the one accent, which means AI) with the AI_ROLE_INFO word and the confidence
// meaning as its title. claimed: a violet outline with no fill, then CLAIMED_CHIP in muted text. The text is
// exactly kickerAi() joined with " · " (lib/page-text.ts), so a kicker that holds this chip keeps cardKicker()'s text.
import type { AiConfidence, AiRole } from "@/lib/schema/common";
import { kickerAi } from "@/lib/page-text";
import { AI_CONFIDENCE_INFO } from "@/lib/vocab";
import { PlainText } from "./PlainText";
import { CHIP } from "./SeverityPips";

export interface AIChipProps {
  role: AiRole;
  confidence: AiConfidence | null;
  claimant: string | null;
}

export function AIChip({ role, confidence, claimant }: AIChipProps) {
  const [chip, claimed] = kickerAi({ ai_role: role, ai_confidence: confidence, ai_claimant: claimant });
  if (!chip) return null;
  if (role === "unassessed") return <span className={`${CHIP} border-[var(--muted)] text-muted`}>{chip}</span>;
  const title = confidence ? AI_CONFIDENCE_INFO[confidence] : undefined;
  if (confidence === "claimed") {
    return (
      <>
        <span className={`${CHIP} border-[var(--ai)] text-[var(--ai)]`} title={title}>{chip}</span>
        {claimed ? <>{" · "}<span className="text-muted"><PlainText text={claimed} /></span></> : null}
      </>
    );
  }
  return <span className={`${CHIP} border-[var(--ai)] bg-[var(--ai)] text-[var(--ai-on)]`} title={title}>{chip}</span>;
}
