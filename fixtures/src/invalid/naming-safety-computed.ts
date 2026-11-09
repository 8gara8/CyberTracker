// F fixtures for the naming and safety rule groups (SPEC §4.12 "Fixtures and tests"): one mutation of the
// weekday draft per hard code a draft can trigger, each failing validateDraft() with exactly that code.
// COMPUTED_MISMATCH is a T code (a draft has no script-set fields) and the SNAP_* warnings have S fixtures
// (fixtures/src/soft.ts); the other sub-conditions are named tests in tests/rules-naming-safety-computed.test.ts.
// No case cites a usable exploit, paste or scanner URL: the NO_EXPLOIT_LINK case cites an invented tier 3
// page whose path holds "poc", the NO_LIVE_IOC case a reserved example domain, and the SECRET_LIKE case a
// SAMPLE string built here from pieces, so the source holds no secret-shaped literal.

import type { DraftBrief } from "../../../lib/schema/draft-brief";
import type { InvalidCase } from "../build";
import { WEEKDAY_ITEMS } from "../drafts";

const I = WEEKDAY_ITEMS;

/** The index of a weekday item by id; throws when the shape changes, so a case never mutates the wrong item. */
function at(d: DraftBrief, id: string): number {
  const i = d.items.findIndex((it) => it.id === id);
  if (i < 0) throw new Error(`The weekday draft has no item ${id}`);
  return i;
}

/** The index of a source by id. */
function src(d: DraftBrief, id: string): number {
  const i = d.sources.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`The draft has no source ${id}`);
  return i;
}

/**
 * A SAMPLE string shaped like SECRET_LIKE's `sk-` pattern, joined at run time so no secret-shaped literal
 * sits in the repo's source; the generated JSON holds it. It matches no provider's real key format.
 */
export function sampleSecret(): string {
  return ["s", "k", "-"].join("") + "CTSAMPLE".repeat(3);
}

export const namingSafetyComputedCases: InvalidCase[] = [
  // ── Victims and attribution ──
  {
    // The claimed incident marked confirmed, with only a tier 2 newsroom (Security NEXT) behind it.
    code: "VICTIM_STATUS", file: "invalid--VICTIM_STATUS.json",
    mutate: (d) => {
      d.items[at(d, I.claimedVictim)]!.incident!.status = "confirmed";
    },
  },
  {
    // The claimed incident names its victim (a SAMPLE company, in the incident field only).
    code: "VICTIM_CLAIMED_UNNAMED", file: "invalid--VICTIM_CLAIMED_UNNAMED.json",
    mutate: (d) => {
      d.items[at(d, I.claimedVictim)]!.incident!.victim = "SAMPLE Logistics Co.";
    },
  },
  {
    // The China-axis headline states the China nexus without naming TeamT5, who attributes it.
    code: "ATTRIBUTION_NAMED", file: "invalid--ATTRIBUTION_NAMED.json",
    mutate: (d) => {
      d.items[at(d, I.chinaAxis)]!.headline = "A China-nexus group phished Taiwanese chip equipment makers with fake invoices";
    },
  },
  {
    // TeamT5's attribution marked low confidence while it still names China as the sponsor and nexus.
    code: "ATTRIBUTION_CONFIDENCE", file: "invalid--ATTRIBUTION_CONFIDENCE.json",
    mutate: (d) => {
      d.items[at(d, I.chinaAxis)]!.attribution[0]!.confidence_level = "low";
    },
  },

  // ── Dangerous material ──
  {
    // A live domain (a reserved example domain) in the Elsewhere link's title.
    code: "NO_LIVE_IOC", file: "invalid--NO_LIVE_IOC.json",
    mutate: (d) => {
      d.elsewhere[0]!.title = "Japan asks local governments to check backups after lures sent from update.example.org";
    },
  },
  {
    // A new source on a reserved example domain (unlisted, so tier 3) whose path holds "poc", cited beside
    // the policy item's tier 1 and 2 sources (§4.12 F: blocked-URL cases use a reserved example domain).
    code: "NO_EXPLOIT_LINK", file: "invalid--NO_EXPLOIT_LINK.json",
    mutate: (d) => {
      const id = `s${d.sources.length + 1}`;
      d.sources.push({
        id, title: "SAMPLE: notes on the incident-reporting draft", title_en: null, language: "en", outlet: "SAMPLE",
        url: "https://example.org/sample/poc", source_type: "other", published_at: null,
      });
      d.items[at(d, I.landmark)]!.source_ids.push(id);
    },
  },
  {
    // A SAMPLE sk- string pasted into a source's outlet (any string counts).
    code: "SECRET_LIKE", file: "invalid--SECRET_LIKE.json",
    mutate: (d) => {
      const s = d.sources[src(d, "s13")]!;
      s.outlet = `${s.outlet} ${sampleSecret()}`;
    },
  },
];
