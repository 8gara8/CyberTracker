// STUB (SPEC Appendix A.3, label chips). Owner: items lane. The siblings' neutral Pill: square, 11px mono
// uppercase, a 6px colour square, --badge-neutral background, muted text, a 30% color-mix border.
import type { ReactNode } from "react";

export interface TagProps {
  children: ReactNode;
  /** Text only. */
  title?: string;
}

export function Tag({ children, title }: TagProps) {
  return <span title={title}>{children}</span>;
}
