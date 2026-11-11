// SPEC §7 "Brief components", SeverityPips; Appendix A.3 (chips and glyphs). A level is never colour alone:
// the chip holds the pips (U+25CF, U+25CB) in an aria-hidden span and the word (HIGH), and hidden words follow
// ("High, 3 of 4"; "level 3 of 4" for regions). The four treatments: CRITICAL a filled ink chip, HIGH a filled
// tinted chip with a 1px border, ELEVATED an outline chip, WATCH and BASELINE grey text with no box. A null
// level is grey text with no pips: "LANDMARK · <KIND>", the kind label (POLICY, AI CAPABILITY, ECOSYSTEM), or
// UNRATED for a threat kind (only a data-only brief leaves its severity null). The visible text is exactly
// kickerLevel() (lib/page-text.ts), so a kicker that holds this chip keeps cardKicker()'s text.
import type { KindId, RegionLevel, Severity } from "@/lib/schema/common";
import { kickerLevel } from "@/lib/page-text";
import { REGION_LEVEL_INFO, SEVERITY_INFO } from "@/lib/vocab";

export interface SeverityPipsProps {
  scale: "severity" | "region";
  /** A Severity for scale "severity", a RegionLevel for scale "region"; null for no level. */
  level: Severity | RegionLevel | null;
  landmark?: boolean;
  /** The item's kind, for the null-level label. */
  kind?: KindId;
  /**
   * False leaves the hidden words out, for a caller that puts the chip inside a counted string (a kicker or a
   * region row's head, which carry `data-words`) and renders levelWords() just after it instead. Default true.
   */
  words?: boolean;
}

/** The chip classes every severity, region and AI chip shares (A.3): square, mono, uppercase, 12px. */
export const CHIP = "inline-flex items-center gap-1 whitespace-nowrap border px-2 py-[3px] font-mono text-[12px] uppercase leading-none tracking-[0.08em]";

/** The four treatments (A.3), by the level's rank (4 critical to 1 watch or baseline). */
const TREATMENT: Record<number, string> = {
  4: "border-[var(--sev-critical-bg)] bg-[var(--sev-critical-bg)] text-[var(--sev-critical-fg)]",
  3: "border-[var(--sev-high-border)] bg-[var(--sev-high-bg)] text-[var(--sev-high-fg)]",
  2: "border-[var(--sev-elevated-border)] text-[var(--sev-elevated-fg)]",
  1: "border-transparent text-[var(--sev-watch-fg)]",
};

/** Grey text, no box: WATCH, BASELINE, LANDMARK, the kind words and UNRATED. */
const GREY = `${CHIP} ${TREATMENT[1]}`;

function info(scale: SeverityPipsProps["scale"], level: Severity | RegionLevel): { pips: string; word: string; rank: number } | null {
  if (scale === "severity") return SEVERITY_INFO[level as Severity] ?? null;
  return REGION_LEVEL_INFO[level as RegionLevel] ?? null;
}

/**
 * The hidden words for a level (§7 SeverityPips, Accessibility): "High, 3 of 4" on the severity scale, "level 3
 * of 4" on the region scale; null for no level (its grey label is already words).
 */
export function levelWords(scale: SeverityPipsProps["scale"], level: Severity | RegionLevel | null): string | null {
  if (level === null) return null;
  const i = info(scale, level);
  if (!i) return null;
  if (scale === "region") return `level ${i.rank} of 4`;
  return `${i.word.charAt(0)}${i.word.slice(1).toLowerCase()}, ${i.rank} of 4`;
}

export function SeverityPips({ scale, level, landmark = false, kind, words = true }: SeverityPipsProps) {
  const i = level === null ? null : info(scale, level);
  if (!i) {
    // No level: grey words, no pips. Without a kind there is nothing better to say than UNRATED.
    const text = kind ? kickerLevel({ kind, severity: null, landmark }) : "UNRATED";
    return <span className={GREY}>{text}</span>;
  }
  const hidden = words ? levelWords(scale, level) : null;
  return (
    <>
      <span className={`${CHIP} ${TREATMENT[i.rank] ?? TREATMENT[1]}`}>
        <span className="pips" aria-hidden="true">{i.pips}</span> {i.word}
      </span>
      {hidden ? <span className="sr-only"> {hidden}</span> : null}
    </>
  );
}
