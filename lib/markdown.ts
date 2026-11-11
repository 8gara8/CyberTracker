// A small Markdown reader for the subset routine/STYLE.md uses (copied from the siblings' lib/markdown.ts):
// ## headings, paragraphs, nested bullet and numbered lists, and tables, with **bold**, `code` and
// [links](url) inline. The methodology page renders STYLE.md sections through it, so the prose has one
// source (SPEC §6 /methodology). It renders only routine/STYLE.md, and only app/methodology/page.tsx
// imports it or components/Markdown.tsx (SPEC §7 "Untrusted text" item 1, tested).

export type Inline = { kind: "text" | "bold" | "code"; text: string } | { kind: "link"; text: string; href: string };
export type ListItem = { content: Inline[]; children: Block | null };
export type Block =
  | { kind: "paragraph"; content: Inline[] }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "table"; head: Inline[][]; rows: Inline[][][] };

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "bold", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "code", text: m[2] });
    else out.push({ kind: "link", text: m[3]!, href: m[4]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

const ITEM_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function parseList(lines: string[]): Block {
  const indentOf = (l: string) => l.match(/^\s*/)![0].length;
  const base = indentOf(lines[0]!);
  const ordered = /^\s*\d+\./.test(lines[0]!);
  const items: ListItem[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = ITEM_RE.exec(lines[i]!)!;
    let text = m[3]!;
    i += 1;
    const nested: string[] = [];
    while (i < lines.length && (indentOf(lines[i]!) > base || !ITEM_RE.test(lines[i]!))) {
      if (ITEM_RE.test(lines[i]!)) nested.push(lines[i]!);
      else if (nested.length) nested[nested.length - 1] += ` ${lines[i]!.trim()}`;
      else text += ` ${lines[i]!.trim()}`;
      i += 1;
    }
    items.push({ content: parseInline(text), children: nested.length ? parseList(nested) : null });
  }
  return { kind: "list", ordered, items };
}

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of markdown.split(/\n\s*\n/)) {
    const lines = chunk.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    if (ITEM_RE.test(lines[0]!)) blocks.push(parseList(lines));
    else if (lines[0]!.trim().startsWith("|") && lines.length >= 2) {
      blocks.push({ kind: "table", head: cells(lines[0]!).map(parseInline), rows: lines.slice(2).map((l) => cells(l).map(parseInline)) });
    } else blocks.push({ kind: "paragraph", content: parseInline(lines.map((l) => l.trim()).join(" ")) });
  }
  return blocks;
}

/** The body of the "## N. Title" section of a Markdown document, without its heading. */
export function section(markdown: string, number: number): { title: string; body: string } | null {
  const re = new RegExp(`^## ${number}\\. (.+)$`, "m");
  const m = re.exec(markdown);
  if (!m) return null;
  const rest = markdown.slice(m.index + m[0].length);
  const end = rest.search(/^## /m);
  return { title: m[1]!.trim(), body: (end === -1 ? rest : rest.slice(0, end)).trim() };
}
