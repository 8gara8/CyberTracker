// SPEC §6 Route table, `/items/[id]`: an item's dated timeline and record links (components/pages/ItemPage.tsx).
// Static params: itemPageIds(content) (an id in two or more editions, or one citing a Scoreboard report
// entry's source); dynamicParams false, so any other id renders app/not-found.tsx. Next.js 16 passes params
// as a Promise. Title: the newest headline, or WITHHELD_HEADLINE when any edition withholds the item.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ItemPage, itemPageTitle } from "@/components/pages/ItemPage";
import { loadContent } from "@/lib/content";
import { itemPageIds } from "@/lib/site-data";

export const dynamicParams = false;

export function generateStaticParams(): { id: string }[] {
  return [...itemPageIds(loadContent())].sort().map((id) => ({ id }));
}

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const content = loadContent();
  if (!itemPageIds(content).has(id)) return {};
  const title = itemPageTitle(content, id);
  return title ? { title } : {};
}

export default async function ItemRoute({ params }: Props) {
  const { id } = await params;
  const content = loadContent();
  if (!itemPageIds(content).has(id)) notFound();
  return <ItemPage content={content} id={id} />;
}
