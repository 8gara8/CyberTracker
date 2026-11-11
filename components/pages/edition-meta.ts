// SPEC §6 Route details, `/` and `/brief/[date]`: the page metadata both set for an edition. Text only: a
// description (briefDescription()), a text-only openGraph ("CyberTracker, <longDate>", type article) and
// the edition marker <meta name="ct-edition" content="<date> <edition> <published_at>">, which the deploy
// check (§8.2) polls on `${siteUrl()}/` to learn which edition the site shows. Next.js metadata escapes
// every value. Owner: pages lane.
import type { Metadata } from "next";
import { longDate } from "@/lib/format";
import { briefDescription } from "@/lib/page-text";
import type { Brief } from "@/lib/schema/brief";
import { SITE_NAME } from "@/lib/site";

/** The edition marker's content: "2026-11-08 full 2026-11-08T05:12:40+08:00". */
export function editionMarker(brief: Pick<Brief, "date" | "edition" | "published_at">): string {
  return `${brief.date} ${brief.edition} ${brief.published_at}`;
}

/** Description, openGraph and the ct-edition marker for an edition's page (the title is the route's). */
export function editionMetadata(brief: Brief): Metadata {
  const description = briefDescription(brief);
  return {
    description,
    openGraph: { title: `${SITE_NAME}, ${longDate(brief.date)}`, description, type: "article" },
    other: { "ct-edition": editionMarker(brief) },
  };
}
