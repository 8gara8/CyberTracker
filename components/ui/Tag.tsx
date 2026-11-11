// SPEC Appendix A.3, label chips: the siblings' neutral Pill. Square, 11px mono uppercase, a 6px colour square,
// --badge-neutral background, muted text and a 30% color-mix border; not the 12px severity-chip size.
import type { ReactNode } from "react";

export interface TagProps {
  children: ReactNode;
  /** Text only. */
  title?: string;
}

/** Fixed values only (no content): the border is the muted ink at 30%, as the siblings' Pill. */
const BORDER = { borderColor: "color-mix(in srgb, var(--ink-mute) 30%, transparent)" } as const;

export function Tag({ children, title }: TagProps) {
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap border bg-[var(--badge-neutral)] px-2 py-[3px] font-mono text-[11px] uppercase leading-none tracking-[0.08em] text-muted"
      style={BORDER}
      title={title}
    >
      <span aria-hidden="true" className="inline-block size-[6px] shrink-0 bg-[var(--ink-mute)]" />
      {children}
    </span>
  );
}
