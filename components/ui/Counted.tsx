// SPEC §7 "Script-written page text" and "Site tests" (Word count): a counted string on a brief page. The
// element carries `data-words` and its text content is exactly the counted string (a §4.12 model field "in
// the total", or a lib/page-text.ts output), so tests/site.test.tsx can sum countWords() over every
// [data-words] element and compare computed.word_count. Never nest one inside another, never put hidden
// words, pips or labels inside one, and never mark a withheld item's card or anything in components/charts/.
// Owner: P4 foundation (S0); every lane uses it and none edits it.
import { PlainText } from "./PlainText";

/** The attribute itself, for elements that are not a <span>: `<p {...COUNTED}>`. */
export const COUNTED = { "data-words": "" } as const;

export interface CountedProps {
  text: string;
  /** A source's `language` only. */
  lang?: string;
  /** Fixed classes only. */
  className?: string;
}

/** A <span data-words> holding `text` through PlainText. */
export function Counted({ text, lang, className }: CountedProps) {
  return <span {...COUNTED} lang={lang} className={className}><PlainText text={text} /></span>;
}
