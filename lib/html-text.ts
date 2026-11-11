import { load } from "cheerio";
import { sha256Hex } from "./json";
import { sanitizeChars } from "./sanitize";

// One text extraction for page snapshots (SPEC §4.12 step 1, scripts/lib/snapshot.ts) and the link check's
// tier 1 hash (§8.11, scripts/recheck.ts), so a page hashed when first cited and hashed again later is read
// the same way. Pure: HTML in, text out. Everything read from a page is data. Written by step S0 and frozen.

/** The most characters htmlText() keeps (§4.12). */
export const HTML_TEXT_MAX = 200_000;

/** Elements removed with everything inside them before the text is read (§4.12). */
export const HTML_TEXT_DROPPED = ["script", "style", "noscript", "nav", "header", "footer", "aside", "form"] as const;

/** Inline elements join their neighbours without a space, so "un<b>known</b>" stays one word; every other element is a break. */
const INLINE: ReadonlySet<string> = new Set(`a abbr acronym b bdi bdo big cite code data del dfn em font i ins kbd label mark
nobr q s samp small span strike strong sub sup time tt u var wbr`.split(/\s+/));

/** The node fields the walk reads (cheerio's DOM nodes fit). */
interface DomNode {
  type: string;
  name?: string;
  data?: string;
  children?: DomNode[];
}

function walk(node: DomNode, out: string[]): void {
  if (node.type === "text") {
    out.push(node.data ?? "");
    return;
  }
  // Comments, directives and CDATA carry no page text; script and style elements were removed already.
  if (node.type !== "tag" && node.type !== "root") return;
  const breaks = node.type === "tag" && !INLINE.has((node.name ?? "").toLowerCase());
  if (breaks) out.push(" ");
  for (const child of node.children ?? []) walk(child, out);
  if (breaks) out.push(" ");
}

/** Cuts `text` to at most `max` UTF-16 code units, never leaving a lone high surrogate at the end. */
function capChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let head = text.slice(0, max);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return head.trimEnd();
}

/**
 * The page's text: with cheerio, drop script, style, noscript, nav, header, footer, aside and form; read
 * the outermost `article` elements, else the outermost `main` elements, else `body`; block elements end
 * a word, inline ones do not; then sanitizeChars() (lib/sanitize.ts: the character rules of §4.14 without
 * the 1,000-character cut), whitespace collapsed to single spaces, and at most HTML_TEXT_MAX characters.
 */
export function htmlText(html: string): string {
  const $ = load(html);
  $(HTML_TEXT_DROPPED.join(",")).remove();
  const outermost = (sel: string) => $(sel).filter((_, el) => $(el).parents(sel).length === 0).toArray() as unknown as DomNode[];
  let roots = outermost("article");
  if (roots.length === 0) roots = outermost("main");
  if (roots.length === 0) roots = $("body").toArray() as unknown as DomNode[];
  if (roots.length === 0) roots = $.root().toArray() as unknown as DomNode[];
  const parts: string[] = [];
  for (const r of roots) {
    walk(r, parts);
    parts.push(" ");
  }
  return capChars(sanitizeChars(parts.join("")).replace(/\s+/gu, " ").trim(), HTML_TEXT_MAX);
}

/** sha256Hex of the UTF-8 text: archive-index.json `urls[url].sha256` and a snapshot's `text_sha256`. */
export function textSha256(text: string): string {
  return sha256Hex(text);
}
