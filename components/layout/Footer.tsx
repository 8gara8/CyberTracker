// SPEC §7 "Page frame", Footer: the siblings' mono footer. "CyberTracker · @8gara8" · "Written by Claude each
// morning; ready before 08:00 Taipei" · "Data: CISA KEV · CVE List · FIRST EPSS · GitHub advisories" ·
// "Audit trail" (the content folder on GitHub); then links RSS, Methodology, Corrections, About, Report an
// error (issueFormUrl()). Names, times and the repo come from run.json (lib/site.ts). Owner: pages lane.
import Link from "next/link";
import { auditTrailUrl, ownerHandle } from "@/components/pages/site-text";
import { SITE_NAME, STALE_AFTER, issueFormUrl } from "@/lib/site";

export function Footer() {
  return (
    <footer className="mt-14 border-t border-line pt-4 font-mono text-[10px] uppercase leading-[2.4] tracking-[0.12em] text-muted">
      <div className="flex flex-wrap items-center gap-x-4">
        <span>{SITE_NAME} · {ownerHandle()}</span>
        <span aria-hidden="true">·</span>
        <span>Written by Claude each morning; ready before {STALE_AFTER} Taipei</span>
        <span aria-hidden="true">·</span>
        <span>Data: CISA KEV · CVE List · FIRST EPSS · GitHub advisories</span>
        <span aria-hidden="true">·</span>
        <a href={auditTrailUrl()} rel="noopener noreferrer">Audit trail</a>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4">
        <a href="/feed.xml">RSS</a>
        <Link href="/methodology">Methodology</Link>
        <Link href="/methodology#corrections">Corrections</Link>
        <Link href="/about">About</Link>
        <a href={issueFormUrl()} rel="noopener noreferrer">Report an error</a>
      </div>
    </footer>
  );
}
