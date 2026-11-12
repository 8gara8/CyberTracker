// SPEC §6 Route table, `/brief/[date]`: one edition through BriefView (StaleBanner only on the newest, which
// BriefView decides from isLatest). Static params: each valid brief's date; dynamicParams false, so any other
// date renders app/not-found.tsx. Next.js 16 passes params as a Promise. Title longDate(date) ("Sunday 8
// November 2026 · CyberTracker" through the layout's template); description, openGraph and the ct-edition
// marker as on `/` (components/pages/edition-meta.ts).
// Adapted from the siblings' BriefPage (docs/PROVENANCE.md).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BriefView } from "@/components/brief/BriefView";
import { briefPropsFor } from "@/components/brief/props";
import { editionMetadata } from "@/components/pages/edition-meta";
import { loadContent } from "@/lib/content";
import { longDate } from "@/lib/format";

export const dynamicParams = false;

export function generateStaticParams(): { date: string }[] {
  return loadContent().briefs.map((b) => ({ date: b.date }));
}

type Props = { params: Promise<{ date: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { date } = await params;
  const content = loadContent();
  const brief = content.briefs.find((b) => b.date === date);
  if (!brief) return {};
  return { title: longDate(brief.date), ...editionMetadata(brief, !content.gapFailed.has(brief.date)) };
}

export default async function BriefPage({ params }: Props) {
  const { date } = await params;
  const props = briefPropsFor(loadContent(), date);
  if (!props) notFound();
  return <BriefView {...props} />;
}
