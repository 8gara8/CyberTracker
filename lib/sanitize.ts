// The sanitiser for untrusted text (SPEC §4.14 "Sanitisation", §8.3 "Sanitiser"). Every string from
// outside the project passes sanitize() before it is stored, ranked or shown to the agent, and reaches the
// agent only inside wrapUntrusted(). Text that looks like instructions to an AI is flagged by
// injectionLike(), never stripped, so items about prompt injection survive, wrapped and marked. Pure.

import { load } from "cheerio";
import { INJECTION_PATTERNS } from "./vocab";

/** The most characters sanitize() keeps (§4.14 step 7); titles use 200, snippets 300. */
export const SANITIZE_MAX = 1000;

/**
 * Step 2: C0 and C1 controls except tab, newline and carriage return; the soft hyphen; the Mongolian
 * vowel separator; zero-width and directional marks; bidi embeddings, overrides and isolates; invisible
 * operators; the byte order mark; variation selectors; and the tag characters. One `u`-flag expression,
 * without `g` so `.test()` is stateless; sanitize() uses a global copy.
 */
export const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿︀-️\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
const INVISIBLE_G = new RegExp(INVISIBLE.source, "gu");

const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// ── Step 1: markup and entities ──────────────────────────────────────────────────────────────────

/** HTML (and common SVG) element names step 1 strips as tags. Anything else, `<untrusted>` included, is
 *  text, so step 5 turns its brackets into ‹ and › and a planted wrapper stays visible and harmless. */
const HTML_ELEMENTS: ReadonlySet<string> = new Set(`a abbr acronym address area article aside audio b base bdi bdo big blink
blockquote body br button canvas caption center circle cite code col colgroup data datalist dd del details dfn dialog dir div dl dt
em embed fieldset figcaption figure font footer form frame frameset g h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe image
img input ins kbd label legend li line link main map mark marquee math menu meta meter nav nobr noscript object ol optgroup option
output p param path picture polygon polyline pre progress q rect rp rt ruby s samp script search section select slot small source
span strike strong style sub summary sup svg table tbody td template text textarea tfoot th thead time title tr track tt u ul use var
video wbr`.split(/\s+/));
/** Inline elements are removed without a break, so "un<b>known</b>" stays one word; the rest end a line. */
const INLINE_ELEMENTS: ReadonlySet<string> = new Set(`a abbr acronym b bdi bdo big cite code data del dfn em font i ins kbd label mark
nobr q s samp small span strike strong sub sup time tt u var wbr`.split(/\s+/));

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?\/?>/g;
const DROP_WITH_CONTENT_RE = /<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const PRE_RE = /<pre\b[^>]*>[\s\S]*?(?:<\/pre\s*>|$)/gi;
const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
const CDATA_RE = /<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)/g;
const DECLARATION_RE = /<![a-zA-Z][^>]*>|<\?[\s\S]*?(?:\?>|$)/g;
const ENTITY_RE = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

const entityCache = new Map<string, string>();

/** One entity, decoded by cheerio's HTML5 tables; only semicolon-terminated forms are passed in. */
function decodeEntity(entity: string): string {
  let out = entityCache.get(entity);
  if (out === undefined) {
    out = load(entity, null, false).root().text();
    entityCache.set(entity, out);
  }
  return out;
}

function stripMarkup(s: string): { text: string; markup: boolean } {
  let markup = false;
  const mark = (to: string) => () => {
    markup = true;
    return to;
  };
  let t = s
    .replace(COMMENT_RE, mark(""))
    .replace(CDATA_RE, (_m, inner: string) => {
      markup = true;
      return inner;
    })
    .replace(DECLARATION_RE, mark(""))
    .replace(DROP_WITH_CONTENT_RE, mark("\n"))
    .replace(PRE_RE, mark("\n[code removed]\n"));
  t = t.replace(TAG_RE, (m, name: string) => {
    const n = name.toLowerCase();
    if (!HTML_ELEMENTS.has(n) && !n.includes(":")) return m;
    markup = true;
    return INLINE_ELEMENTS.has(n) ? "" : "\n";
  });
  return { text: t, markup };
}

function decodeEntities(s: string): string {
  return s.includes("&") ? s.replace(ENTITY_RE, decodeEntity) : s;
}

// ── Step 4: code, Markdown and URLs ──────────────────────────────────────────────────────────────

const CODE = "[code removed]";
const LINK = "[link]";
const FENCE_BACKTICK_RE = /^[ \t]{0,3}(`{3,})[^`\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1`*[ \t]*$|(?![\s\S]))/gm;
const FENCE_TILDE_RE = /^[ \t]{0,3}(~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1~*[ \t]*$|(?![\s\S]))/gm;
const INLINE_CODE_RE = /(`+)([^`\n]+?)\1/g;
const IMAGE_RE = /!\[([^\]\n]*)\]\([^)\n]*\)/g;
const LINK_RE = /\[([^\]\n]+)\]\([^)\n]*\)/g;
const REF_LINK_RE = /\[([^\]\n]+)\]\[[^\]\n]*\]/g;
const REF_DEFINITION_RE = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S+.*$/gm;
const AUTOLINK_RE = /<(?:https?|ftp|wss?):[^>\s]*>/gi;
/** Heading marks, a run of them at once ("# # a"), so nesting them costs no extra clean() pass. */
const HEADING_RE = /^[ \t]{0,3}#{1,6}(?=[ \t]|$)(?:[ \t]+#{1,6}(?=[ \t]|$))*/gm;
const STRONG_RE = /(?<![\p{L}\p{N}_*])(\*\*|__)(?=\S)([^\n]*?\S)\1(?![\p{L}\p{N}_*])/gu;
const EM_STAR_RE = /(?<![\p{L}\p{N}*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\p{L}\p{N}*])/gu;
const EM_UNDERSCORE_RE = /(?<![\p{L}\p{N}_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\p{L}\p{N}_])/gu;
const STRIKE_RE = /~~(?=\S)([^~\n]*?\S)~~/g;
const BARE_URL_RE = /\b(?:(?:https?|ftp|wss?):\/\/|www\.)[^\s<>"]+/gi;
const URL_TRAILING_RE = /[.,;:!?'")\]*_]+$/;

/** Markdown indented code: a run of lines indented 4 spaces or a tab, at the start or after a blank line. */
function removeIndentedCode(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const startsBlock = /^(?: {4}|\t)/.test(line) && line.trim() !== "" && (i === 0 || lines[i - 1]!.trim() === "");
    if (!startsBlock) {
      out.push(line);
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && (lines[j]!.trim() === "" || /^(?: {4}|\t)/.test(lines[j]!))) j += 1;
    while (j > i + 1 && lines[j - 1]!.trim() === "") j -= 1;
    out.push(CODE);
    i = j;
  }
  return out.join("\n");
}

function flattenMarkdown(s: string, markup: boolean): string {
  let t = s.replace(FENCE_BACKTICK_RE, `\n${CODE}\n`).replace(FENCE_TILDE_RE, `\n${CODE}\n`);
  // In HTML, indentation is source formatting, never code (code there is <pre>, removed in step 1).
  if (!markup) t = removeIndentedCode(t);
  return t
    .replace(INLINE_CODE_RE, "$2")
    .replace(AUTOLINK_RE, LINK)
    .replace(IMAGE_RE, "$1")
    .replace(LINK_RE, "$1")
    .replace(REF_LINK_RE, "$1")
    .replace(REF_DEFINITION_RE, "")
    .replace(HEADING_RE, "")
    .replace(STRONG_RE, "$2")
    .replace(EM_STAR_RE, "$1")
    .replace(EM_UNDERSCORE_RE, "$1")
    .replace(STRIKE_RE, "$1")
    .replace(BARE_URL_RE, (m) => {
      const trail = URL_TRAILING_RE.exec(m)?.[0] ?? "";
      return LINK + trail;
    });
}

// ── Steps 5 to 7 ─────────────────────────────────────────────────────────────────────────────────

/** Step 5: no text can open or close the `<untrusted>` wrapper. */
function neutraliseBrackets(s: string): string {
  return s.replace(/</g, "‹").replace(/>/g, "›");
}

/**
 * Cuts `text` to at most `max` UTF-16 code units, ending with "…" when it was longer. Never leaves a lone
 * surrogate: a pair the cut would split is dropped whole.
 */
export function cutText(text: string, max: number): string {
  if (!Number.isInteger(max) || max < 1) throw new Error(`Invalid cut length: ${max}`);
  if (text.length <= max) return text;
  let head = text.slice(0, max - 1);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head.trimEnd()}…`;
}

/** NFKC, except that "…" stays one character: the cut's own mark must survive a second pass unchanged. */
function nfkc(s: string): string {
  return s.includes("…") ? s.split("…").map((part) => part.normalize("NFKC")).join("…") : s.normalize("NFKC");
}

/** The character rules alone (steps 2 and 3): what page snapshots get, without the cut (§4.12). */
export function sanitizeChars(text: string): string {
  return nfkc(text.replace(INVISIBLE_G, "")).replace(INVISIBLE_G, "");
}

/** One pass of steps 1 to 6. */
function cleanOnce(text: string): string {
  // Steps 1 to 3 repeat until nothing changes, so double-encoded markup (`&amp;lt;b&amp;gt;`) and a tag
  // split by a zero-width character are caught.
  let s = text;
  let markup = false;
  for (let round = 0; round < 8; round += 1) {
    const stripped = stripMarkup(s);
    markup ||= stripped.markup;
    const next = sanitizeChars(decodeEntities(stripped.text));
    if (next === s) break;
    s = next;
  }
  s = flattenMarkdown(s.replace(/\r\n?/g, "\n"), markup);
  s = neutraliseBrackets(s);
  return s.replace(/\s+/gu, " ").trim();
}

/** The most passes clean() makes; real text settles in one or two. */
const CLEAN_PASSES = 32;

/**
 * Steps 1 to 6: everything but the cut, repeated until a pass changes nothing, so a second sanitize()
 * changes nothing. One pass is not enough: flattening Markdown can expose an entity (`&*lt*;` becomes
 * `&lt;`, which the next pass decodes and neutralises), a second heading mark or an outer link, and
 * collapsing whitespace can join emphasis split over two lines.
 */
function clean(text: string): string {
  let s = cleanOnce(text);
  for (let pass = 1; pass < CLEAN_PASSES; pass += 1) {
    const next = cleanOnce(s);
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Step 7 on clean()'s output; a cut that exposes Markdown (a closing mark just before "…") is settled. */
function cutClean(full: string, max: number): string {
  let out = cutText(full, max);
  if (out === full) return out;
  for (let pass = 0; pass < CLEAN_PASSES; pass += 1) {
    const next = cutText(clean(out), max);
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * sanitize(text, { max }) (§4.14): (1) strip HTML tags and comments and decode entities; (2) remove the
 * INVISIBLE code points; (3) NFKC; (4) replace fenced and indented code with "[code removed]", flatten
 * Markdown and replace every bare URL with "[link]"; (5) `<` and `>` to `‹` and `›`; (6) collapse
 * whitespace to single spaces; (7) cut to `max` (at most 1,000, the default), surrogate-safe, ending with
 * "…". Step 8, the flag, is injectionLike() (or sanitizeFlagged(), which does both). Idempotent: steps 1
 * to 6 repeat until a pass changes nothing (up to CLEAN_PASSES, which only text nested deeper than real
 * markup ever reaches), a cut that exposes Markdown is settled, and step 3 leaves "…" as it is (NFKC
 * would make it "..."), so the cut's mark survives a second pass.
 */
export function sanitize(text: string, opts: { max?: number } = {}): string {
  const max = Math.min(opts.max ?? SANITIZE_MAX, SANITIZE_MAX);
  return cutClean(clean(text), max);
}

/**
 * Step 8: true when the text matches an INJECTION_PATTERNS entry (instructions aimed at an AI). Flags,
 * never strips. Works on raw or sanitised text (the patterns accept ‹ and › for < and >).
 */
export function injectionLike(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

/**
 * sanitize() plus its flag, for collect: the flag is read on the cleaned text before the cut, so an
 * instruction past the cut still marks the item.
 */
export function sanitizeFlagged(text: string, opts: { max?: number } = {}): { text: string; flags: "injection_like"[] } {
  const full = clean(text);
  const max = Math.min(opts.max ?? SANITIZE_MAX, SANITIZE_MAX);
  return { text: cutClean(full, max), flags: injectionLike(full) ? ["injection_like"] : [] };
}

/**
 * `<untrusted source="<id>">text</untrusted>`, the wrapper every untrusted string carries in the pack's
 * Markdown and the agent context (§4.14, §4.15). `sourceId` is a feed or registry id
 * (`^[a-z0-9][a-z0-9-]*$`). The text's own angle brackets become ‹ and › here too, so even a string that
 * skipped sanitize() cannot close the wrapper.
 */
export function wrapUntrusted(sourceId: string, text: string): string {
  if (!SOURCE_ID_RE.test(sourceId)) throw new Error(`Invalid untrusted source id: ${JSON.stringify(sourceId)}`);
  return `<untrusted source="${sourceId}">${neutraliseBrackets(text)}</untrusted>`;
}
