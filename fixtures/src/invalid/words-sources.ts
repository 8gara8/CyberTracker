// F fixtures for the words and sources rule groups (SPEC §4.12 "Fixtures and tests"): one mutation of the
// weekday draft per hard code a draft can trigger, each failing validateDraft() with exactly that code.
// SOURCE_ORPHAN and the warning forms of SOURCE_UNSEEN and SOURCE_TIER, and every other sub-condition, are
// named tests in tests/rules-words-sources.test.ts. The SOURCE_URL case wraps a SAMPLE page in an archive URL; no case cites
// an exploit, paste or scanner URL.

import type { DraftBrief } from "../../../lib/schema/draft-brief";
import type { InvalidCase } from "../build";
import { WEEKDAY_ITEMS, WEEKDAY_SOURCE_KEYS } from "../drafts";
import { STATE_MEDIA_PAGE } from "../inputs";
import { sourceIds } from "../world";

const I = WEEKDAY_ITEMS;
const S = sourceIds(WEEKDAY_SOURCE_KEYS);

/** The index of an item by id; throws when the draft's shape changes, so a case never mutates the wrong item. */
function at(d: DraftBrief, id: string): number {
  const i = d.items.findIndex((it) => it.id === id);
  if (i < 0) throw new Error(`The draft has no item ${id}`);
  return i;
}

/** The index of a source by id. */
function src(d: DraftBrief, id: string): number {
  const i = d.sources.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`The draft has no source ${id}`);
  return i;
}

const SOURCE_ID_KEYS = new Set(["source_ids", "source_id", "status_source_ids", "counterpoint_source_ids", "quote_source_id"]);

/**
 * Removes sources no field cites any more and renumbers the rest s1, s2, ... in order, rewriting every
 * source-id field, so ID_SEQUENCE and SOURCE_ORPHAN stay quiet. The caller removes the citations first.
 */
export function dropSources(d: DraftBrief, drop: readonly string[]): void {
  const keep = d.sources.filter((s) => !drop.includes(s.id));
  const map = new Map(keep.map((s, i) => [s.id, `s${i + 1}`]));
  const remap = (x: unknown) => (typeof x === "string" ? map.get(x) ?? x : x);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    for (const [k, x] of Object.entries(o)) {
      if (SOURCE_ID_KEYS.has(k)) o[k] = Array.isArray(x) ? x.map(remap) : remap(x);
      else walk(x);
    }
  };
  walk(d.items);
  walk(d.angle);
  walk(d.taiwan_lens);
  walk(d.scoreboard_entries);
  walk(d.week_in_review);
  walk(d.corrections);
  walk(d.elsewhere);
  d.sources = keep.map((s) => ({ ...s, id: map.get(s.id)! }));
}

export const wordsSourcesCases: InvalidCase[] = [
  // ── Words and limits ──
  {
    // A raise reason of 23 words (limit 20); no new number or name, so no grounding rule notices.
    code: "WORDS_OVER", file: "invalid--WORDS_OVER.json",
    mutate: (d) => {
      d.region_raises[0]!.reason = "CISA gave federal agencies three days to patch exploited Ivanti Connect Secure gateways, an unusually short deadline that signals active and widespread exploitation.";
    },
  },
  {
    // §4.12: the Lead cut to one 10-word sentence with no number, so LEAD_GROUNDED can't fire.
    code: "WORDS_UNDER", file: "invalid--WORDS_UNDER.json",
    mutate: (d) => {
      d.lead = [{ text: "Ivanti fixed a Connect Secure flaw attackers were already using.", item_ids: [I.criticalExploited], gap: false }];
    },
  },
  {
    // A 29-word quotation inside the Scoreboard entry's summary (a prose field; the snapshot gates don't read it).
    code: "QUOTE_MAX_25", file: "invalid--QUOTE_MAX_25.json",
    mutate: (d) => {
      d.scoreboard_entries[0]!.summary = "The NCSC's annual review says “attackers used AI to speed up reconnaissance against UK organisations this year, but we have not yet seen AI-powered malware used in an attack on UK critical national infrastructure.”";
    },
  },
  {
    code: "BANNED_WORDS", file: "invalid--BANNED_WORDS.json",
    mutate: (d) => {
      d.taiwan_lens.japan.text = "A ransomware group claims a massive data theft from a Japanese logistics company; nothing is confirmed.";
    },
  },

  // ── Sources ──
  {
    code: "SOURCE_REF", file: "invalid--SOURCE_REF.json",
    mutate: (d) => {
      d.taiwan_lens.source_ids = [`s${d.sources.length + 1}`]; // one past the last source
    },
  },
  {
    // A second source for the BleepingComputer page: the same URL once tracking parameters and www. go.
    code: "SOURCE_DUP", file: "invalid--SOURCE_DUP.json",
    mutate: (d) => {
      const bc = d.sources[src(d, S["bc-ivanti"])]!;
      const id = `s${d.sources.length + 1}`;
      d.sources.push({ ...bc, id, url: `${bc.url.replace("://www.", "://")}?utm_source=rss` });
      d.items[at(d, I.criticalExploited)]!.source_ids.push(id);
    },
  },
  {
    // The Elsewhere link cited through an archive copy of its (SAMPLE) page: cite the original.
    code: "SOURCE_URL", file: "invalid--SOURCE_URL.json",
    mutate: (d) => {
      const s = d.sources[src(d, S["nhk-backups"])]!;
      s.url = `https://web.archive.org/web/20261013120000/${s.url}`;
    },
  },
  {
    // The Elsewhere link's URL changed to a page the run never saw.
    code: "SOURCE_UNSEEN", file: "invalid--SOURCE_UNSEEN.json",
    mutate: (d) => {
      const s = d.sources[src(d, S["nhk-backups"])]!;
      s.url = `${s.url}-follow-up`;
    },
  },
  {
    // BleepingComputer, a tier 2 newsroom, typed as a government source.
    code: "SOURCE_TIER", file: "invalid--SOURCE_TIER.json",
    mutate: (d) => {
      d.sources[src(d, S["bc-ivanti"])]!.source_type = "government";
    },
  },
  {
    // The Critical item left with Ivanti's advisory alone: one publisher. The CVE record and
    // BleepingComputer go (and the exposure figure and number that came from BleepingComputer).
    code: "SOURCE_CRITICAL_TWO", file: "invalid--SOURCE_CRITICAL_TWO.json",
    mutate: (d) => {
      const it = d.items[at(d, I.criticalExploited)]!;
      it.source_ids = [S["ivanti-advisory"]];
      it.exposure = null;
      it.why_it_matters = "Connect Secure gateways sit on the edge of many corporate networks, so an unpatched one is an open door.";
      dropSources(d, [S["rec-104935"], S["bc-ivanti"]]);
    },
  },
  {
    // The Critical item cites Ivanti's advisory and a BleepingComputer copy of it under the same title:
    // two publishers before folding, one after.
    code: "SOURCE_SYNDICATED", file: "invalid--SOURCE_SYNDICATED.json",
    mutate: (d) => {
      const it = d.items[at(d, I.criticalExploited)]!;
      it.source_ids = it.source_ids.filter((id) => id !== S["rec-104935"]);
      d.sources[src(d, S["bc-ivanti"])]!.title = d.sources[src(d, S["ivanti-advisory"])]!.title;
      dropSources(d, [S["rec-104935"]]);
    },
  },
  {
    // The China-axis item also cites a Global Times page (PRC state media, a fetched page in the weekday
    // evidence) without the label in its headline or summary, and stays an independent claim.
    code: "SOURCE_STATE_LABEL", file: "invalid--SOURCE_STATE_LABEL.json",
    mutate: (d) => {
      const id = `s${d.sources.length + 1}`;
      d.sources.push({
        id, title: "SAMPLE: Island hypes 'phishing threat' to chip makers", title_en: null, language: "en", outlet: "Global Times",
        url: STATE_MEDIA_PAGE.url, source_type: "other", published_at: "2026-10-13T20:00:00+08:00",
      });
      d.items[at(d, I.chinaAxis)]!.source_ids.push(id);
    },
  },
];
