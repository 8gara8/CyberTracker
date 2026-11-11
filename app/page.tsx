// STUB (SPEC §6 Route table, `/`). Owner: pages lane. The newest valid brief through BriefView (which shows
// StaleBanner when isLatest), or the empty state. The pages lane adds generateMetadata (description,
// openGraph, the ct-edition marker).
import { BriefView } from "@/components/brief/BriefView";
import { briefPropsFor } from "@/components/brief/props";
import { Empty, PageHeader } from "@/components/layout/chrome";
import { loadContent } from "@/lib/content";

export default function TodayPage() {
  const content = loadContent();
  const latest = content.briefs.at(-1);
  if (!latest) {
    return (
      <>
        <PageHeader title="Today" />
        <Empty>No edition yet. Each morning&apos;s brief is ready before 08:00 Taipei.</Empty>
      </>
    );
  }
  return <BriefView {...briefPropsFor(content, latest.date)!} />;
}
