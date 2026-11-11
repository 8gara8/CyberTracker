// SPEC §7 "Untrusted text" item 3: the only renderer of a content URL. safeHref() decides; an unsafe or
// unparseable URL renders its children as plain text, never a link. Same tab, never target="_blank".
// Owner: P4 foundation (S0); every lane uses it and none edits it.
import type { ReactNode } from "react";
import { safeHref } from "@/lib/urls";

export interface ExternalLinkProps {
  /** The content URL, untrusted. */
  href: string;
  children: ReactNode;
  /** A source's `language` only (a BCP 47 subset), for its title. */
  lang?: string;
  /** Fixed classes only, never content. */
  className?: string;
  /** Text only. */
  title?: string;
}

export function ExternalLink({ href, children, lang, className, title }: ExternalLinkProps) {
  const safe = safeHref(href);
  if (safe === null) return <span lang={lang} className={className} title={title}>{children}</span>;
  return <a href={safe} rel="noopener noreferrer" lang={lang} className={className} title={title}>{children}</a>;
}
