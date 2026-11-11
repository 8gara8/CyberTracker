// SPEC §6 Route table, `/`: the newest valid brief through BriefView (which shows StaleBanner when isLatest),
// or the empty state. "Today" is content.briefs.at(-1): if today's brief was skipped, `/` shows yesterday's
// and the stale banner appears after 08:00 Taipei. Static: built from the content folder, nothing per request.
import type { Metadata } from "next";
import { BriefView } from "@/components/brief/BriefView";
import { briefPropsFor } from "@/components/brief/props";
import { Empty, PageHeader } from "@/components/layout/chrome";
import { editionMetadata } from "@/components/pages/edition-meta";
import { noEditionYet } from "@/components/pages/site-text";
import { loadContent } from "@/lib/content";

export function generateMetadata(): Metadata {
  const content = loadContent();
  const latest = content.briefs.at(-1);
  return latest ? editionMetadata(latest, !content.gapFailed.has(latest.date)) : {};
}

export default function TodayPage() {
  const content = loadContent();
  const latest = content.briefs.at(-1);
  if (!latest) {
    return (
      <>
        <PageHeader title="Today" />
        <Empty>{noEditionYet()}</Empty>
      </>
    );
  }
  return <BriefView {...briefPropsFor(content, latest.date)!} />;
}
