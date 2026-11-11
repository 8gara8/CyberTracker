// Fixed site strings and links the page frame and the pages share (SPEC §6 Route details, §7 Page frame),
// built from run.json through lib/site.ts so a change there reaches every page. Owner: pages lane.
import run from "@/config/run.json";
import { SITE_REPO, STALE_AFTER } from "@/lib/site";

/** "@8gara8": the repo owner (run.json repos.repo), the handle the masthead and footer show. */
export function ownerHandle(): string {
  return `@${SITE_REPO.split("/")[0]}`;
}

/** The repo on GitHub, https://github.com/<repos.repo>. */
export function repoUrl(): string {
  return `https://github.com/${SITE_REPO}`;
}

/** The audit trail (§7 Footer): the content folder on main, https://github.com/<repos.repo>/tree/main/content. */
export function auditTrailUrl(): string {
  return `${repoUrl()}/tree/main/content`;
}

/** The data credits page (§6 /about): docs/SOURCES.md on main. */
export function sourcesDocUrl(): string {
  return `${repoUrl()}/blob/main/docs/SOURCES.md`;
}

/** "Daily before 08:00 Taipei · @8gara8" (§7 Masthead), with run.json schedule.stale_after. */
export function dailyLine(): string {
  return `Daily before ${STALE_AFTER} Taipei · ${ownerHandle()}`;
}

/** The empty-state line of `/` (§6 Route table). */
export function noEditionYet(): string {
  return `No edition yet. Each morning's brief is ready before ${STALE_AFTER} Taipei.`;
}

/**
 * What CyberTracker is, for /about (§6: §1's first paragraph, at most 80 words). §1's paragraph runs to about
 * 150 words, so this keeps its first four sentences and its last, and folds the metrics sentence into one clause.
 */
export const ABOUT_WHAT =
  "CyberTracker publishes one brief every morning, on Taipei time, on the AI-era cyber threat across the US, " +
  "Europe, Taiwan, Japan and the wider world. It asks two questions. Is AI flooding defenders with flaws faster " +
  "than they can fix them? Are attackers exploiting those flaws faster? It measures what public data can show, " +
  "against a fixed pre-AI reference period, 2023 and 2024. It is not a news roundup and not a vulnerability " +
  "database: it links out for everything else.";

/** "How it is made" on /about (§6): one sentence each for collect, draft, validate and publish, timed from run.json. */
export function howItIsMade(): { step: string; text: string }[] {
  const s = run.schedule;
  const rounds = run.budgets.repair_rounds;
  // §8.2's retry: after a draft fails validation, the next attempt opens when there is time before the cutoff.
  const fresh = run.budgets.attempts_max - 1;
  const retry = fresh > 0
    ? `, and if it still fails, Claude writes ${fresh === 1 ? "one fresh draft with its own" : `up to ${fresh} fresh drafts, each with its own`} ${rounds} rounds when there is time before ${s.retry_cutoff} Taipei; if no draft passes, the data-only edition stands.`
    : ", and if it still fails the data-only edition stands.";
  return [
    {
      step: "Collect",
      text: `At ${s.start} Taipei, scripts read the public feeds and compute the Gap from CISA's catalog and the CVE List, and publish a data-only edition by about ${s.data_only_target}.`,
    },
    {
      step: "Draft",
      text: "Claude, running in a sandbox on that morning's collected sources, picks the stories and writes the draft.",
    },
    {
      step: "Validate",
      text: `Scripts check every source, number and label in the draft against the published rules; a failing draft gets at most ${rounds} repair rounds${retry}`,
    },
    {
      step: "Publish",
      text: `A valid draft is published as the full edition by about ${s.full_target} Taipei, as JSON in the public repo, and this site rebuilds from it; nothing is published after ${s.publish_until}.`,
    },
  ];
}

/** The data credits on /about (§6), in this order, linking sourcesDocUrl(). */
export const DATA_CREDITS = [
  "CISA Known Exploited Vulnerabilities catalog",
  "CVE List (CVE.org)",
  "FIRST EPSS",
  "GitHub Advisory Database",
] as const;
