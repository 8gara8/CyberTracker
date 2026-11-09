// F fixtures for the meta, ids and items rule groups (SPEC §4.12 "Fixtures and tests"): one mutation of
// the weekday draft per hard code a draft can trigger, each failing validateDraft() with exactly that
// code. SCHEMA has two (§4.4: a `tier` key on a source, a `cves` key on an item). METRICS_MISSING (a
// warning) and the other sub-conditions are named tests in tests/rules-meta-items.test.ts.

import type { DraftBrief } from "../../../lib/schema/draft-brief";
import { CANARY_TOKEN, NONE_FOUND } from "../../../lib/vocab";
import type { InvalidCase } from "../build";
import { WEEKDAY_ITEMS } from "../drafts";

const I = WEEKDAY_ITEMS;

/** The index of a weekday item by id; throws when the shape changes, so a fixture never mutates the wrong item. */
function at(d: DraftBrief, id: string): number {
  const i = d.items.findIndex((it) => it.id === id);
  if (i < 0) throw new Error(`The weekday draft has no item ${id}`);
  return i;
}

export const metaItemsCases: InvalidCase[] = [
  // ── Shape, dates, editions ──
  {
    code: "SCHEMA", file: "invalid--SCHEMA.json",
    mutate: (d) => {
      (d.sources[0] as Record<string, unknown>).tier = 1; // an S field the agent never writes
    },
  },
  {
    code: "SCHEMA", file: "invalid--SCHEMA--item-cves.json",
    mutate: (d) => {
      (d.items[at(d, I.criticalExploited)] as Record<string, unknown>).cves = [];
    },
  },
  {
    code: "DATE_MISMATCH", file: "invalid--DATE_MISMATCH.json",
    mutate: (d) => {
      d.generated_at = "2026-10-14T05:40:00+08:00"; // after the 05:15 deadline
    },
  },
  {
    code: "WEEKLY_FLAG", file: "invalid--WEEKLY_FLAG.json",
    mutate: (d) => {
      d.week_in_review = {
        text: "SAMPLE. A week in review belongs to Monday's edition only.",
        strongest_against: { text: NONE_FOUND, claim_id: null, source_ids: [] },
      };
    },
  },
  {
    code: "AI_UNASSESSED", file: "invalid--AI_UNASSESSED.json",
    mutate: (d) => {
      d.items[at(d, I.landmark)]!.ai_role = "unassessed";
    },
  },
  {
    code: "CANARY", file: "invalid--CANARY.json",
    mutate: (d) => {
      const s = d.sources[d.sources.length - 1]!;
      s.outlet = `${s.outlet} ${CANARY_TOKEN}`;
    },
  },

  // ── Ids ──
  {
    code: "ID_FORMAT", file: "invalid--ID_FORMAT.json",
    mutate: (d) => {
      d.items[at(d, I.aiConfirmed)]!.id = "eco-aisle-red-hat-2026-10"; // an ai_capability item takes "ai-"
    },
  },
  {
    code: "ID_SEQUENCE", file: "invalid--ID_SEQUENCE.json",
    mutate: (d) => {
      const n = d.sources.length;
      [d.sources[n - 2], d.sources[n - 1]] = [d.sources[n - 1]!, d.sources[n - 2]!]; // s19 before s18
    },
  },
  {
    code: "ID_DUPLICATE", file: "invalid--ID_DUPLICATE.json",
    mutate: (d) => {
      d.items[at(d, I.glasswing)]!.id = I.aiConfirmed;
    },
  },

  // ── Items and sections ──
  {
    code: "ITEM_CAP", file: "invalid--ITEM_CAP.json",
    mutate: (d) => {
      const row = d.elsewhere[0]!;
      d.elsewhere = Array.from({ length: 7 }, () => ({ ...row }));
    },
  },
  {
    code: "ITEM_ORDER", file: "invalid--ITEM_ORDER.json",
    mutate: (d) => {
      const a = at(d, I.taiwanVendor);
      const b = at(d, I.claimedVictim);
      [d.items[a], d.items[b]] = [d.items[b]!, d.items[a]!]; // the breach row before the exploits row
    },
  },
  {
    code: "TOP3_WHY", file: "invalid--TOP3_WHY.json",
    mutate: (d) => {
      d.items[1]!.why_it_matters = null;
    },
  },
  {
    code: "SEVERITY_NULL_FOR_NONTHREAT", file: "invalid--SEVERITY_NULL_FOR_NONTHREAT.json",
    mutate: (d) => {
      d.items[at(d, I.chinaAxis)]!.landmark = true; // landmark is only for kinds without a severity
    },
  },
  {
    code: "SEVERITY_KIND", file: "invalid--SEVERITY_KIND.json",
    mutate: (d) => {
      // The exploited flaw at elevated, moved behind the high patch batch so the display order still holds.
      const a = at(d, I.criticalExploited);
      const b = at(d, I.patchBatch);
      d.items[a]!.severity = "elevated";
      [d.items[a], d.items[b]] = [d.items[b]!, d.items[a]!];
    },
  },
  {
    code: "TAIWAN_LENS_REQUIRED", file: "invalid--TAIWAN_LENS_REQUIRED.json",
    mutate: (d) => {
      d.taiwan_lens.rows = d.taiwan_lens.rows.filter((r) => r.row !== "cables_telecom"); // five rows
    },
  },
  {
    code: "REGION_RAISE", file: "invalid--REGION_RAISE.json",
    mutate: (d) => {
      d.region_raises[0]!.item_ids = [I.patchBatch]; // a GLOBAL item cited for the US raise
    },
  },
  {
    code: "STANDING_STORY_NEW_FACT", file: "invalid--STANDING_STORY_NEW_FACT.json",
    mutate: (d) => {
      d.items[at(d, I.chinaAxis)]!.standing_story = "taiwan-chip-espionage"; // not a standing story
    },
  },
  {
    code: "SCOREBOARD_REF", file: "invalid--SCOREBOARD_REF.json",
    mutate: (d) => {
      d.scoreboard_entries[0]!.claim_id = "SB-01"; // judged by script, so it takes no reported entry
    },
  },
];
