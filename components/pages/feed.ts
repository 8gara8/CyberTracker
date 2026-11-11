// The RSS 2.0 body of `/feed.xml` (SPEC §6 Route details, `/feed.xml`), kept out of the route file, which
// may export only what Next.js allows. escape() on every value; channel SITE_NAME, siteUrl(), SITE_TAGLINE,
// en. The last FEED_SIZE valid briefs, newest first, data-only included: title "<longDate>: <items[0].headline
// or 'No item cleared the bar'>" plus " (data-only edition)" for a data-only edition; link and guid
// <base>/brief/DATE (a full edition replacing the data-only one keeps the guid); pubDate
// rfc822(published_at); description briefDescription(). With no briefs, a valid channel with no items.
// Owner: pages lane.
import { longDate, rfc822 } from "@/lib/format";
import { briefDescription } from "@/lib/page-text";
import type { Brief } from "@/lib/schema/brief";
import { SITE_NAME, SITE_TAGLINE } from "@/lib/site";

/** How many editions the feed carries. */
export const FEED_SIZE = 30;

/** XML text: the five-character escapes the siblings use, and no character XML 1.0 forbids. */
export function escapeXml(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "<longDate>: <items[0].headline or 'No item cleared the bar'>", plus " (data-only edition)" when data-only. */
export function feedItemTitle(b: Pick<Brief, "date" | "edition" | "items">): string {
  const top = b.items[0]?.headline ?? "No item cleared the bar";
  return `${longDate(b.date)}: ${top}${b.edition === "data_only" ? " (data-only edition)" : ""}`;
}

/** The whole feed for the loaded briefs (oldest first, as loadContent() lists them) and the site address. */
export function feedXml(briefs: readonly Brief[], base: string): string {
  const items = briefs.slice(-FEED_SIZE).reverse().map((b) => {
    const link = escapeXml(`${base}/brief/${b.date}`);
    return `    <item>
      <title>${escapeXml(feedItemTitle(b))}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${escapeXml(rfc822(b.published_at))}</pubDate>
      <description>${escapeXml(briefDescription(b))}</description>
    </item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(SITE_NAME)}</title>
    <link>${escapeXml(base)}</link>
    <description>${escapeXml(SITE_TAGLINE)}</description>
    <language>en</language>
${items.length ? `${items.join("\n")}\n` : ""}  </channel>
</rss>
`;
}
