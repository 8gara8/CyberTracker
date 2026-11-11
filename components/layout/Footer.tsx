// STUB (SPEC §7 "Page frame", Footer). Owner: pages lane. Reads run.json; the siblings' frame: "CyberTracker
// · @8gara8" · "Written by Claude each morning; ready before 08:00 Taipei" · "Data: CISA KEV · CVE List ·
// FIRST EPSS · GitHub advisories" · "Audit trail"; links RSS, Methodology, Corrections, About, Report an
// error (issueFormUrl()). No props.
import { SITE_NAME } from "@/lib/site";

export function Footer() {
  return <footer className="mt-14 border-t border-line pt-4 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{SITE_NAME}</footer>;
}
