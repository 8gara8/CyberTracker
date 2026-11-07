// Word counting (SPEC §4.1), copied from the Europe fork unchanged. URLs are removed, the rest is split on
// whitespace, and a token counts when it contains at least one letter or digit, so markdown symbols and
// stray dashes never count. Hyphenated words and numbers such as "1,800" each count as one word. A
// Chinese or Japanese run without spaces counts as one word.

const URL_RE = /\bhttps?:\/\/\S+/gi;
const WORDISH_RE = /[\p{L}\p{N}]/u;

export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  let n = 0;
  for (const token of text.replace(URL_RE, " ").split(/\s+/)) {
    if (WORDISH_RE.test(token)) n += 1;
  }
  return n;
}
