// SPEC §7 "Untrusted text" item 4: every prose field goes through PlainText. Defanged indicators (hxxp://,
// hxxps://, [.], (.), [@], [:]) are never linked: each whitespace-delimited token holding one renders in
// <code>, the rest as React text. Owner: P4 foundation (S0); every lane uses it and none edits it.
import { Fragment } from "react";

/** §7's split pattern: a token holding a defanged form. */
export const DEFANGED_RE = /\S*(?:hxxps?:\/\/|\[\.\]|\(\.\)|\[@\]|\[:\])\S*/g;

/** The text cut into plain runs and defanged tokens, in order (empty runs dropped). */
export function plainTextParts(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(DEFANGED_RE)) {
    if (m[0] === "") continue;
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
    out.push({ code: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

export interface PlainTextProps {
  text: string;
  /** A source's `language` only. With it the text is wrapped in a <span lang>. */
  lang?: string;
}

export function PlainText({ text, lang }: PlainTextProps) {
  const parts = plainTextParts(text).map((p, i) =>
    p.code ? <code key={i} className="font-mono text-[0.9em] [overflow-wrap:anywhere]">{p.text}</code> : <Fragment key={i}>{p.text}</Fragment>);
  return lang ? <span lang={lang}>{parts}</span> : <>{parts}</>;
}
