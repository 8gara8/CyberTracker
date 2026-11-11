// SPEC §6 Route details, `/feed.xml`: the siblings' RSS 2.0 route, built once at build time (force-static;
// nothing runs per request). The body is components/pages/feed.ts's feedXml() over every loaded brief.
import { feedXml } from "@/components/pages/feed";
import { loadContent } from "@/lib/content";
import { siteUrl } from "@/lib/site";

export const dynamic = "force-static";

export function GET(): Response {
  const content = loadContent();
  const xml = feedXml(content.briefs, siteUrl(), content.gapFailed);
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}
