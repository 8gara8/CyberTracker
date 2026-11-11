// SPEC §6 Route details, `/about`: who writes the brief, how, the data credits, the repo and its audit
// trail, the two siblings and how to report an error. Always the same; no content is read. Owner: pages lane.
import type { Metadata } from "next";
import { PageHeader, Section } from "@/components/layout/chrome";
import { ABOUT_WHAT, DATA_CREDITS, auditTrailUrl, howItIsMade, repoUrl, sourcesDocUrl } from "@/components/pages/site-text";
import { SIBLINGS, SITE_REPO, issueFormUrl } from "@/lib/site";
import { ABOUT_LINE, ANTHROPIC_LINE } from "@/lib/vocab";

export const metadata: Metadata = { title: "About" };

/** ABOUT_LINE verbatim, its final "here" linking the issue form (§6). */
function AboutLine() {
  const at = ABOUT_LINE.lastIndexOf("here");
  if (at < 0) return <>{ABOUT_LINE}</>;
  return (
    <>
      {ABOUT_LINE.slice(0, at)}
      <a href={issueFormUrl()} rel="noopener noreferrer">here</a>
      {ABOUT_LINE.slice(at + "here".length)}
    </>
  );
}

export default function AboutPage() {
  return (
    <>
      <PageHeader title="About" />
      <div className="prose-serif space-y-3">
        <p><AboutLine /></p>
        <p>{ANTHROPIC_LINE}</p>
        <p>{ABOUT_WHAT}</p>
      </div>

      <Section id="how" title="How it is made">
        <dl className="space-y-2 text-[15px]">
          {howItIsMade().map((s) => (
            <div key={s.step}>
              <dt className="inline font-semibold">{s.step}:</dt> <dd className="inline">{s.text}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="data" title="Data">
        <p className="text-[15px]">
          <a href={sourcesDocUrl()} rel="noopener noreferrer">{DATA_CREDITS.join(" · ")}</a>
        </p>
        <p className="mt-2 text-[15px]">
          The code, the config and every edition are in the public repo{" "}
          <a href={repoUrl()} rel="noopener noreferrer" className="font-mono text-[13px]">{SITE_REPO}</a>; its{" "}
          <a href={auditTrailUrl()} rel="noopener noreferrer"><code className="font-mono text-[13px]">content/</code> folder is the audit trail</a>,
          with each brief as published and every correction.
        </p>
      </Section>

      <Section id="siblings" title="Siblings">
        <p className="text-[15px]">
          Two sibling briefs share the paper look and the tab bar: <a href={SIBLINGS.me}>ME Tracker</a>, on the Middle East, and the{" "}
          <a href={SIBLINGS.europe}>Europe tracker</a>.
        </p>
      </Section>

      <Section id="report" title="Reporting an error">
        <p className="text-[15px]">
          Use the <a href={issueFormUrl()} rel="noopener noreferrer">error form</a>. It reads the item id, the edition date, what
          is wrong and one evidence link, nothing else: the run never reads free text, so anything else written in the
          report is ignored. A report that a named victim or an attribution is wrong withholds the item at once while it
          is reviewed. The item id is at the foot of each item.
        </p>
      </Section>
    </>
  );
}
