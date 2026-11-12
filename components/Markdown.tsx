// SPEC §6 /methodology, §7 "Untrusted text" item 1: the siblings' Markdown renderer for routine/STYLE.md
// sections, imported only by app/methodology/page.tsx. React text only. A link keeps its href only when it
// is a site path ("/..." or "#...") or passes safeHref(); anything else renders as plain text.
import type { Block, Inline } from "@/lib/markdown";
import { safeHref } from "@/lib/urls";

function linkHref(href: string): string | null {
  if (/^\/(?!\/)|^#/.test(href)) return href;
  return safeHref(href);
}

function Inlines({ content }: { content: Inline[] }) {
  return (
    <>
      {content.map((x, i) => {
        if (x.kind === "bold") return <strong key={i}>{x.text}</strong>;
        if (x.kind === "code") return <code key={i} className="bg-panel px-1 text-[0.9em]">{x.text}</code>;
        if (x.kind === "link") {
          const href = linkHref(x.href);
          return href ? <a key={i} href={href} rel="noopener noreferrer">{x.text}</a> : <span key={i}>{x.text}</span>;
        }
        return <span key={i}>{x.text}</span>;
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  if (block.kind === "paragraph") return <p className="mt-2"><Inlines content={block.content} /></p>;
  if (block.kind === "list") {
    const List = block.ordered ? "ol" : "ul";
    return (
      <List className={`mt-2 space-y-1 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}>
        {block.items.map((item, i) => (
          <li key={i}>
            <Inlines content={item.content} />
            {item.children ? <BlockView block={item.children} /> : null}
          </li>
        ))}
      </List>
    );
  }
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr>{block.head.map((h, i) => <th key={i} className="border-b border-line py-1 pr-3 text-left font-semibold"><Inlines content={h} /></th>)}</tr></thead>
        <tbody>
          {block.rows.map((r, i) => (
            <tr key={i} className="border-b border-line align-top">{r.map((c, j) => <td key={j} className="py-1 pr-3"><Inlines content={c} /></td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Markdown({ blocks, skipTables = false }: { blocks: Block[]; skipTables?: boolean }) {
  return (
    <div className="text-sm">
      {blocks.filter((b) => !(skipTables && b.kind === "table")).map((b, i) => <BlockView key={i} block={b} />)}
    </div>
  );
}
