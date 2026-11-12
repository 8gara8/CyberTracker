// SPEC §7 "Page frame": the siblings' page chrome (Dateline, PageHeader, Section, Empty, Stamp) in the
// paper design, with their red accent replaced by ink (text-fg, border-rule; Appendix A.1: violet means AI).
// Owner: P4 foundation (S0); the lanes use it and none edits it.
import type { ReactNode } from "react";
import { SITE_NAME } from "@/lib/site";

/** A rubber-stamp label, rotated a little: the masthead's "AI-written · open sources". */
export function Stamp({ text, angle = -3 }: { text: string; angle?: number }) {
  return (
    <span
      className="inline-block border-2 border-rule px-[10px] py-[4px] font-mono text-[11px] font-bold uppercase tracking-[0.16em] whitespace-nowrap text-fg opacity-90"
      style={{ transform: `rotate(${angle}deg)` }}
    >
      {text}
    </span>
  );
}

/** The kicker line above a page or brief title: an ink bar and mono text. */
export function Dateline({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg">
      <span aria-hidden="true">▮ </span>{children}
    </p>
  );
}

/** A page's Dateline kicker (default SITE_NAME), its one h1 and an optional line under it. */
export function PageHeader({ title, kicker, children }: { title: string; kicker?: string; children?: ReactNode }) {
  return (
    <div className="mb-6">
      <Dateline>{kicker ?? SITE_NAME}</Dateline>
      <h1 className="brief-h1 mt-2 max-w-[24ch]">{title}</h1>
      {children ? <div className="mt-3 max-w-[72ch] text-[14px] text-soft">{children}</div> : null}
    </div>
  );
}

/**
 * A section with the siblings' rule: a 1px ink line, an optional fixed §NN number, the label (Plex Sans 600,
 * 11px uppercase, tracking 0.22em) in an h2, and right-side meta.
 */
export function Section({ id, title, children, note, number, right, className }: {
  id?: string; title: string; children: ReactNode; note?: ReactNode; number?: number; right?: ReactNode; className?: string;
}) {
  return (
    <section id={id} className={`mt-9${className ? ` ${className}` : ""}`}>
      <h2 className="mb-4 flex items-baseline gap-3 border-t border-rule pt-2">
        {number !== undefined ? <span className="font-mono text-[10px] tracking-[0.14em] text-muted">§{String(number).padStart(2, "0")}</span> : null}
        <span className="font-sans text-[11px] font-semibold uppercase tracking-[0.22em] text-fg">{title}</span>
        {right ? <span className="kicker ml-auto text-right">{right}</span> : null}
      </h2>
      {note ? <p className="-mt-2 mb-4 max-w-[72ch] text-[13px] text-muted">{note}</p> : null}
      {children}
    </section>
  );
}

/** An empty state: a dashed box with a mono line. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="border border-dashed border-line bg-panel px-4 py-6 text-center font-mono text-[11px] uppercase tracking-[0.12em] text-muted">{children}</p>;
}
