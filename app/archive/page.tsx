// SPEC §6 Route details, `/archive`: "N editions, newest first.", then an <ol> of every edition the site
// loaded (never archive-index.json, so a skipped brief is never linked): longDate(date) linking /brief/DATE;
// a kicker (archiveKicker()); the top story (SeverityPips and items[0].headline), or "No item cleared the
// bar.", or "Data-only edition" when a data-only edition has no items. Empty: "No editions yet."
// Adapted from the siblings' ArchivePage frame (docs/PROVENANCE.md).
import type { Metadata } from "next";
import Link from "next/link";
import { Empty, PageHeader } from "@/components/layout/chrome";
import { archiveKicker, editionsLine, topStoryFallback } from "@/components/pages/archive-text";
import { PlainText } from "@/components/ui/PlainText";
import { SeverityPips } from "@/components/ui/SeverityPips";
import { loadContent } from "@/lib/content";
import { longDate } from "@/lib/format";

export const metadata: Metadata = { title: "Archive" };

export default function ArchivePage() {
  const content = loadContent();
  const briefs = [...content.briefs].reverse();
  return (
    <>
      <PageHeader title="Archive">{briefs.length ? editionsLine(briefs.length) : null}</PageHeader>
      {briefs.length === 0 ? (
        <Empty>No editions yet.</Empty>
      ) : (
        <ol className="divide-y divide-line border-y border-line">
          {briefs.map((b) => {
            const top = b.items[0];
            return (
              <li key={b.date} className="py-3">
                <Link href={`/brief/${b.date}`} className="display block text-[19px] leading-snug">{longDate(b.date)}</Link>
                <p className="kicker mt-1">{archiveKicker(content, b)}</p>
                <p className="mt-1 text-[15px] leading-snug">
                  {top ? (
                    <>
                      <SeverityPips scale="severity" level={top.severity} landmark={top.landmark} kind={top.kind} />{" "}
                      <PlainText text={top.headline} />
                    </>
                  ) : (
                    <span className="text-soft">{topStoryFallback(b)}</span>
                  )}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
