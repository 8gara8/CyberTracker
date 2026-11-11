// F fixtures for the cves, grounding and ai rule groups (SPEC §4.12 "Fixtures and tests"): one mutation of
// the weekday draft per hard code a draft can trigger, each failing validateDraft() with exactly that code.
// GAP_MATCH and ANTHROPIC_DISCLOSURE_LINE are script-set (T), and the warning form of CVE_IN_SOURCE and every
// other sub-condition are named tests in tests/rules-cves-grounding-ai.test.ts. Sample text is invented.
// A case that changes an item's severity or kind also reorders the items and fits the text of any item that
// moves between the top three and the rows, so ITEM_ORDER, TOP3_WHY and WORDS_OVER stay quiet.

import type { DraftBrief } from "../../../lib/schema/draft-brief";
import type { DraftItem } from "../../../lib/schema/item";
import type { InvalidCase } from "../build";
import { WEEKDAY_ITEMS } from "../drafts";

const I = WEEKDAY_ITEMS;

/** The item with an id; throws when the weekday draft's shape changes, so a case never mutates the wrong item. */
function item(d: DraftBrief, id: string): DraftItem {
  const it = d.items.find((x) => x.id === id);
  if (!it) throw new Error(`The weekday draft has no item ${id}`);
  return it;
}

/** Puts the items in this id order (the cases that change a severity or kind keep the display order valid). */
function reorder(d: DraftBrief, ids: readonly string[]): void {
  d.items = ids.map((id) => item(d, id));
}

export const cvesGroundingAiCases: InvalidCase[] = [
  // ── CVEs and flaws ──
  {
    code: "CVE_PUBLISHED", file: "invalid--CVE_PUBLISHED.json",
    mutate: (d) => {
      item(d, I.criticalExploited).cve_ids.push("CVE-2026-9999999"); // not in the morning's CVE List
    },
  },
  {
    code: "CVE_IN_SOURCE", file: "invalid--CVE_IN_SOURCE.json",
    mutate: (d) => {
      // The Register's page never names the CVE; only its record does.
      const it = item(d, I.aiConfirmed);
      it.summary = "Red Hat rated none of them critical; the newest, CVE-2026-110036, a local crash bug scored 3.3, was published on 13 October.";
    },
  },
  {
    code: "VENDOR_CONFIRMED", file: "invalid--VENDOR_CONFIRMED.json",
    mutate: (d) => {
      // Edimax never confirmed the router flaw (VulDB assigned it), so it can't be above watch. The campaign
      // goes to high so the flaw stays the first Also-today row and the top three don't change.
      item(d, I.taiwanVendor).severity = "elevated";
      item(d, I.chinaAxis).severity = "high";
    },
  },
  {
    code: "EXPLOITED_BASIS", file: "invalid--EXPLOITED_BASIS.json",
    mutate: (d) => {
      // The router flaw is not on KEV and only a CVE record and a newsroom speak of it.
      const flaw = item(d, I.taiwanVendor);
      flaw.kind = "exploited_flaw";
      flaw.severity = "high";
      flaw.why_it_matters = "An end-of-life router that will never get a fix stays exposed for as long as people keep it running.";
      const axis = item(d, I.chinaAxis);
      axis.summary = "TeamT5 says Paper Kestrel sent fake supplier invoices to at least 12 Taiwanese semiconductor equipment makers; Focus Taiwan reports AI wrote the emails.";
      reorder(d, [I.criticalExploited, I.taiwanVendor, I.patchBatch, I.claimedVictim, I.aiConfirmed, I.glasswing, I.chinaAxis, I.landmark]);
    },
  },
  {
    code: "FLAW_EVIDENCE", file: "invalid--FLAW_EVIDENCE.json",
    mutate: (d) => {
      const patched = item(d, I.criticalExploited).flaw_evidence.find((f) => f.kind === "patched")!;
      patched.basis = "vendor_confirmed"; // a fix is a vendor_advisory statement
    },
  },

  // ── Grounding and numbers ──
  {
    code: "LEAD_GROUNDED", file: "invalid--LEAD_GROUNDED.json",
    mutate: (d) => {
      d.lead[2]!.text = "TeamT5 says a China-nexus group phished 18 Taiwanese chip equipment makers with lures that Focus Taiwan reports were written by AI.";
    },
  },
  {
    code: "METRICS_ONLY_NUMBERS", file: "invalid--METRICS_ONLY_NUMBERS.json",
    mutate: (d) => {
      const row = d.taiwan_lens.rows.find((r) => r.row === "home_vendors")!;
      row.text = "Taiwanese vendors had 4 KEV additions this quarter; details of an unfixed Edimax router flaw are public.";
    },
  },
  {
    // A Gap sentence with a wrong ratio glued to x (the display is 5.2): LEAD_GROUNDED reads no number in "9.9x",
    // and 13 is a quoted Gap number (review of the sixth P3 fix pass).
    code: "NUMBER_FORM", file: "invalid--NUMBER_FORM.json",
    mutate: (d) => {
      d.lead.push({ text: "New CVE records arrived at 9.9x the 2023–24 pace in 13 weeks.", item_ids: [], gap: true });
    },
  },

  // ── AI role ──
  {
    code: "AI_EVIDENCE_REQUIRED", file: "invalid--AI_EVIDENCE_REQUIRED.json",
    mutate: (d) => {
      item(d, I.chinaAxis).ai_confidence = null; // an AI-linked role needs a confidence
    },
  },
  {
    code: "AI_CONFIRMED_NONPRESS", file: "invalid--AI_CONFIRMED_NONPRESS.json",
    mutate: (d) => {
      item(d, I.aiConfirmed).ai_evidence[0]!.from_claimant = true; // the only confirming quote now comes from the claimant
    },
  },
  {
    code: "SELF_REPORTED_WORDING", file: "invalid--SELF_REPORTED_WORDING.json",
    mutate: (d) => {
      item(d, I.landmark).claim_type = "self_reported"; // neither headline nor summary says who claims it
    },
  },
];
