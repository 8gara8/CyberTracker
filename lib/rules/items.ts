// Items and sections (SPEC §4.12): ITEM_CAP †, ITEM_ORDER, TOP3_WHY, SEVERITY_NULL_FOR_NONTHREAT,
// SEVERITY_KIND, TAIWAN_LENS_REQUIRED, REGION_RAISE (draft), STANDING_STORY_NEW_FACT (draft), SCOREBOARD_REF
// (the open-claim and judged_by tests draft). Display order is lib/items.ts's orderItems() (§4.6); region
// levels are lib/regions.ts's computeRegions() (§5.11) on the draft's items with first_seen set and the
// run's regionsBase.

import { at, isValidDate } from "../dates";
import { firstOutOfOrder, orderItems, TOP_STORY_COUNT } from "../items";
import { computeRegions, regionItems, type RegionItemInput } from "../regions";
import type { Regions } from "../schema/brief";
import type { Claim } from "../schema/scoreboard";
import { splitSentences } from "../text";
import { normalizeUrl } from "../urls";
import {
  HEADS, KIND_INFO, KINDS, NO_NEWS_ROW, SEVERITY_INFO, TAIWAN_LENS_ROWS, TAIWAN_NO_NEWS, type KindId, type Severity,
} from "../vocab";
import { entriesOf, isBrief, isFullOrPartial } from "./shared";
import { defineRule, error, list, plural, type AnyItem, type AnySource, type Rule, type RuleInput, type ValidationIssue } from "./types";

/** ITEM_CAP's limits (§4.4, §4.12): at most 10 items (run.json budgets.items_max) and 6 Elsewhere rows. */
export const ITEMS_MAX = 10;
export const ELSEWHERE_MAX = 6;

const isKind = (k: unknown): k is KindId => typeof k === "string" && (KINDS as readonly string[]).includes(k);
const isSeverity = (s: unknown): s is Severity => typeof s === "string" && s in SEVERITY_INFO;
const itemsOf = (input: RuleInput) => (input.draft.items ?? []) as AnyItem[];
/** "An ai_capability", "A campaign". */
const AKind = (kind: string) => `${/^[aeiou]/.test(kind) ? "An" : "A"} ${kind}`;
const aKind = (kind: string) => `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;

// ── ITEM_CAP ─────────────────────────────────────────────────────────────────────────────────────

function checkCap(input: RuleInput): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const n = itemsOf(input).length;
  if (n > ITEMS_MAX) {
    out.push(error("ITEM_CAP", "items", `items has ${n} entries; the limit is ${ITEMS_MAX}. Cut at least ${n - ITEMS_MAX}, starting with the lowest-ranked Also-today rows.`));
  }
  const e = (input.draft.elsewhere ?? []).length;
  if (e > ELSEWHERE_MAX) {
    out.push(error("ITEM_CAP", "elsewhere", `elsewhere has ${e} rows; the limit is ${ELSEWHERE_MAX}. Cut at least ${e - ELSEWHERE_MAX}.`));
  }
  return out;
}

// ── ITEM_ORDER ───────────────────────────────────────────────────────────────────────────────────

const ORDER_HINT = `Order: severity (critical, high, elevated, watch; a landmark ranks as elevated; no severity last), then kind (exploited flaw, critical flaw, patch batch, supply chain, breach, campaign, AI capability, ecosystem, policy); the first ${TOP_STORY_COUNT} are the top stories, the rest grouped by head (${HEADS.join(", ")}).`;

function checkOrder(input: RuleInput): ValidationIssue[] {
  const items = itemsOf(input);
  if (!items.every((it) => it && isKind(it.kind) && (it.severity === null || isSeverity(it.severity)))) return [];
  const first = firstOutOfOrder(items);
  if (!first) return [];
  const label = first.id ? ` (${first.id})` : "";
  const expected = orderItems(items).map((it) => it.id);
  return [error("ITEM_ORDER", `items[${first.index}]`,
    `items[${first.index}]${label} is out of display order; it belongs at items[${first.expected_index}]. Reorder items as: ${list(expected)}.`,
    ORDER_HINT)];
}

// ── TOP3_WHY ─────────────────────────────────────────────────────────────────────────────────────

function checkTop3(input: RuleInput): ValidationIssue[] {
  if (!isFullOrPartial(input)) return [];
  const out: ValidationIssue[] = [];
  itemsOf(input).slice(0, TOP_STORY_COUNT).forEach((it, i) => {
    // A withheld item (§4.10) has why_it_matters null by design.
    if (!it || ("withheld" in it && it.withheld)) return;
    const p = `items[${i}].why_it_matters`;
    const why = it.why_it_matters;
    if (typeof why !== "string" || why.trim() === "") {
      out.push(error("TOP3_WHY", p,
        `items[${i}] is a top story with no why_it_matters; write one strategic sentence of at most 25 words on why it matters to defenders.`));
      return;
    }
    const n = splitSentences(why).length;
    if (n !== 1) {
      out.push(error("TOP3_WHY", p, `why_it_matters has ${n} sentences; it must be exactly one. Join them or cut to the strongest.`));
    }
  });
  return out;
}

// ── SEVERITY_NULL_FOR_NONTHREAT, SEVERITY_KIND ───────────────────────────────────────────────────

function checkSeverityNull(input: RuleInput): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  itemsOf(input).forEach((it, i) => {
    if (!it || !isKind(it.kind)) return;
    const need = KIND_INFO[it.kind].severity;
    if (need === "none" && it.severity !== null) {
      out.push(error("SEVERITY_NULL_FOR_NONTHREAT", `items[${i}].severity`,
        `${AKind(it.kind)} item has no severity, but this one is "${it.severity}"; set severity to null${it.kind === "policy" ? " (set landmark true to rank a major policy item as elevated)" : ""}.`));
    } else if (need === "required" && it.severity === null) {
      out.push(error("SEVERITY_NULL_FOR_NONTHREAT", `items[${i}].severity`,
        `${AKind(it.kind)} item needs a severity (critical, high, elevated or watch), but it is null; set one from the severity definitions.`));
    }
    if (need === "required" && it.landmark === true) {
      out.push(error("SEVERITY_NULL_FOR_NONTHREAT", `items[${i}].landmark`,
        `landmark is only for kinds without a severity (ai_capability, ecosystem, policy); ${aKind(it.kind)} item ranks by its severity. Set landmark to false.`));
    }
  });
  return out;
}

function checkSeverityKind(input: RuleInput): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  itemsOf(input).forEach((it, i) => {
    if (!it || !isSeverity(it.severity)) return;
    const rank = SEVERITY_INFO[it.severity].rank;
    if (it.kind === "exploited_flaw" && rank < SEVERITY_INFO.high.rank) {
      out.push(error("SEVERITY_KIND", `items[${i}].severity`,
        `An exploited_flaw item is high or critical, but this one is "${it.severity}". Raise it to high, or use kind critical_flaw if exploitation is not confirmed.`));
    } else if (it.kind === "critical_flaw" && rank > SEVERITY_INFO.elevated.rank) {
      out.push(error("SEVERITY_KIND", `items[${i}].severity`,
        `A critical_flaw item (not exploited) is elevated at most, but this one is "${it.severity}". Lower it to elevated or watch, or use kind exploited_flaw with flaw_evidence of exploitation.`));
    }
  });
  return out;
}

// ── TAIWAN_LENS_REQUIRED ─────────────────────────────────────────────────────────────────────────

function checkLens(input: RuleInput): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const lens = input.draft.taiwan_lens;
  if (!lens) return out;
  const items = input.derived.itemsById;
  const hasIds = (b: { item_ids?: unknown; source_ids?: unknown }) =>
    (Array.isArray(b.item_ids) && b.item_ids.length > 0) || (Array.isArray(b.source_ids) && b.source_ids.length > 0);

  if (typeof lens.analysis !== "string" || lens.analysis.trim() === "") {
    out.push(error("TAIWAN_LENS_REQUIRED", "taiwan_lens.analysis",
      `taiwan_lens.analysis is blank; write 1 to 120 words on what today means for Taiwan, citing items, or exactly "${TAIWAN_NO_NEWS}" when nothing new qualifies.`));
  } else if (lens.analysis !== TAIWAN_NO_NEWS && !hasIds(lens)) {
    out.push(error("TAIWAN_LENS_REQUIRED", "taiwan_lens.analysis",
      `taiwan_lens.analysis cites no item or source; list the items it draws on in taiwan_lens.item_ids (or extra sources in source_ids), or write exactly "${TAIWAN_NO_NEWS}" when nothing new qualifies.`));
  }

  const rows = Array.isArray(lens.rows) ? lens.rows : [];
  const ids = rows.map((r) => r?.row);
  if (ids.length !== TAIWAN_LENS_ROWS.length || ids.some((r, i) => r !== TAIWAN_LENS_ROWS[i])) {
    const missing = TAIWAN_LENS_ROWS.filter((r) => !ids.includes(r));
    out.push(error("TAIWAN_LENS_REQUIRED", "taiwan_lens.rows",
      `taiwan_lens.rows has ${plural(ids.length, "row")} (${ids.map(String).join(", ") || "none"}); it must hold exactly these ${TAIWAN_LENS_ROWS.length}, in order: ${TAIWAN_LENS_ROWS.join(", ")}.${missing.length ? ` Add ${missing.join(", ")} (text null when nothing is new).` : ""}`));
  }
  const textCheck = (p: string, b: { text?: unknown; item_ids?: unknown; source_ids?: unknown } | null | undefined) => {
    if (!b || typeof b.text !== "string") return;
    if (b.text.trim() === NO_NEWS_ROW) {
      out.push(error("TAIWAN_LENS_REQUIRED", `${p}.text`, `${p}.text is "${NO_NEWS_ROW}"; set text to null instead (the page shows "${NO_NEWS_ROW}" for a null row).`));
    } else if (!hasIds(b)) {
      out.push(error("TAIWAN_LENS_REQUIRED", `${p}.text`,
        `${p}.text cites no item or source; add the item ids it draws on (or source ids), or set text to null when nothing is new.`));
    }
  };
  rows.forEach((r, i) => textCheck(`taiwan_lens.rows[${i}]`, r));
  textCheck("taiwan_lens.japan", lens.japan);

  const unknown = (p: string, list: unknown) => {
    if (!Array.isArray(list)) return;
    list.forEach((id, k) => {
      if (typeof id === "string" && !items.has(id)) {
        out.push(error("TAIWAN_LENS_REQUIRED", `${p}[${k}]`, `"${id}" is not an item in this brief; cite only today's item ids, or remove it.`));
      }
    });
  };
  unknown("taiwan_lens.item_ids", lens.item_ids);
  rows.forEach((r, i) => unknown(`taiwan_lens.rows[${i}].item_ids`, r?.item_ids));
  unknown("taiwan_lens.japan.item_ids", lens.japan?.item_ids);
  return out;
}

// ── REGION_RAISE ─────────────────────────────────────────────────────────────────────────────────

/** A draft item's first_seen (§4.6): the earliest earlier edition holding its id (recent_items, history), else today. */
export function draftFirstSeen(input: Pick<RuleInput, "date" | "context" | "regionsBase">, id: string): string {
  const dates: string[] = [];
  for (const r of input.context?.recent_items ?? []) if (r.id === id && r.date < input.date) dates.push(r.date);
  for (const h of input.regionsBase?.history ?? []) {
    if (h.date >= input.date) continue;
    for (const it of h.items) if (it.id === id) dates.push(it.first_seen && it.first_seen < h.date ? it.first_seen : h.date);
  }
  return dates.length ? dates.sort()[0]! : input.date;
}

/** The region levels computeRegions() gives the draft's items with no raises (REGION_RAISE), or null without a regionsBase. */
export function draftRegions(input: RuleInput): Regions | null {
  const base = input.regionsBase;
  if (!base) return null;
  const items = itemsOf(input).map((it) => ({ ...it, first_seen: draftFirstSeen(input, it.id) }) as RegionItemInput);
  return computeRegions({ ...base, items: regionItems(items, input.draft.sources ?? [], base.config), raises: [] });
}

function checkRaises(input: RuleInput): ValidationIssue[] {
  if (isBrief(input.draft)) return [];
  const raises = input.draft.region_raises ?? [];
  if (!raises.length) return [];
  const out: ValidationIssue[] = [];
  const regions = draftRegions(input);
  const seen = new Map<string, number>();
  raises.forEach((r, i) => {
    if (!r) return;
    const p = `region_raises[${i}]`;
    const prev = seen.get(r.region);
    if (prev !== undefined) {
      out.push(error("REGION_RAISE", `${p}.region`,
        `${r.region} is raised twice (region_raises[${prev}] and [${i}]); a region takes at most one raise of one step. Keep one.`));
      return;
    }
    seen.set(r.region, i);
    const ids = Array.isArray(r.item_ids) ? r.item_ids : [];
    if (ids.length === 0) {
      out.push(error("REGION_RAISE", `${p}.item_ids`, `The ${r.region} raise cites no item; list at least one item in this brief whose regions include ${r.region}.`));
    }
    ids.forEach((id, k) => {
      const it = input.derived.itemsById.get(id);
      if (!it) {
        out.push(error("REGION_RAISE", `${p}.item_ids[${k}]`, `"${id}" is not an item in this brief; a raise cites today's items that carry ${r.region}.`));
      } else if (!(it.regions ?? []).includes(r.region)) {
        out.push(error("REGION_RAISE", `${p}.item_ids[${k}]`,
          `${id} has regions ${list(it.regions ?? [])}, not ${r.region}; cite an item that carries ${r.region}, or remove the raise.`));
      }
    });
    const row = regions?.rows.find((x) => x.code === r.region);
    if (row && row.computed_level === "critical") {
      out.push(error("REGION_RAISE", p,
        `${r.region} is already critical by the rules (${row.rule_id ?? "no rule"}), so a raise can't be one step above it; remove the raise.`));
    }
  });
  return out;
}

// ── STANDING_STORY_NEW_FACT ──────────────────────────────────────────────────────────────────────

const termRes = new Map<string, RegExp>();

/** A match term in a headline: any case; on word boundaries at an ASCII letter or digit (Han terms match anywhere). */
export function termIn(text: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  let re = termRes.get(t);
  if (!re) {
    const body = t.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const pre = /^[A-Za-z0-9]/.test(t) ? "(?<![\\p{L}\\p{N}])" : "";
    const post = /[A-Za-z0-9]$/.test(t) ? "(?![\\p{L}\\p{N}])" : "";
    re = new RegExp(`${pre}${body}${post}`, "iu");
    termRes.set(t, re);
  }
  return re.test(text);
}

/** A source's date for the new-fact tests: its pack date (packDates, by normalised URL), else its published_at. */
function sourceDate(input: RuleInput, s: AnySource): string | null {
  return input.packDates?.[normalizeUrl(s.url)] ?? s.published_at ?? null;
}

/**
 * True when a source date falls after an edition: a bare date after the edition date; a timestamp after
 * that edition's news window closed (run.json pack.window_end, 04:30 Taipei, on the edition date).
 */
export function datedAfter(when: string | null, editionDate: string, windowEnd: string): boolean {
  if (!when) return false;
  if (isValidDate(when)) return when > editionDate;
  const t = Date.parse(when);
  return !Number.isNaN(t) && t > at(editionDate, windowEnd);
}

function checkStanding(input: RuleInput): ValidationIssue[] {
  const ctx = input.context;
  if (!ctx) return [];
  const out: ValidationIssue[] = [];
  const stories = ctx.standing_stories ?? [];
  const known = new Set([...stories.map((s) => s.id), ...input.config.standingStories.stories.map((s) => s.id)]);
  const windowEnd = input.config.run.pack.window_end;
  const tier12 = (it: AnyItem) => [...new Set(it.source_ids ?? [])].flatMap((id) => {
    const s = input.derived.sourcesById.get(id);
    return s && (input.derived.tierBySourceId.get(id) ?? 3) <= 2 ? [s] : [];
  });

  itemsOf(input).forEach((it, i) => {
    if (!it) return;
    const p = `items[${i}]`;
    if (it.standing_story === null) {
      const hit = stories.find((s) => s.match_terms.some((t) => typeof it.headline === "string" && termIn(it.headline, t)));
      if (hit) {
        const term = hit.match_terms.find((t) => termIn(it.headline, t))!;
        out.push(error("STANDING_STORY_NEW_FACT", `${p}.standing_story`,
          `The headline contains "${term}", a match term of the standing story "${hit.id}" (${hit.title}); set standing_story to "${hit.id}" and make sure the item reports a new fact.`));
      }
    } else if (typeof it.standing_story === "string") {
      if (!known.has(it.standing_story)) {
        out.push(error("STANDING_STORY_NEW_FACT", `${p}.standing_story`,
          `standing_story "${it.standing_story}" is not a standing story; use an id from the context's standing_stories (${list([...known])}) or null.`));
      } else {
        const story = stories.find((s) => s.id === it.standing_story);
        const last = story?.last_development ?? null;
        const fresh = tier12(it).filter((s) => last === null || datedAfter(sourceDate(input, s), last, windowEnd));
        if (!fresh.length) {
          out.push(error("STANDING_STORY_NEW_FACT", `${p}.source_ids`,
            last === null
              ? `The item tags standing story "${it.standing_story}" but cites no tier 1 or 2 source; cite one that reports today's development.`
              : `The item tags standing story "${it.standing_story}", last developed on ${last}, but cites no tier 1 or 2 source dated after that edition; cite one that reports a new fact, or drop the item (background goes in the story, not the brief).`));
        }
      }
    }

    // A repeat of an item from the last 14 days needs a newer tier 1 or 2 source not cited for it then.
    const earlier = (ctx.recent_items ?? []).filter((r) => r.id === it.id && r.date < input.date);
    if (!earlier.length) return;
    const lastDate = earlier.map((r) => r.date).sort().pop()!;
    const cited = new Set(earlier.flatMap((r) => r.source_urls.map(normalizeUrl)));
    const fresh = tier12(it).filter((s) => !cited.has(normalizeUrl(s.url)) && datedAfter(sourceDate(input, s), lastDate, windowEnd));
    if (!fresh.length) {
      out.push(error("STANDING_STORY_NEW_FACT", `${p}.source_ids`,
        `${it.id} already ran on ${lastDate}; repeating it needs a tier 1 or 2 source dated after that edition and not cited for it then. Cite the new development, or drop the item.`));
    }
  });
  return out;
}

// ── SCOREBOARD_REF ───────────────────────────────────────────────────────────────────────────────

/** Open (§4.9): no resolution, and the edition date on or before the deadline. */
export function claimOpen(claim: Pick<Claim, "resolution" | "deadline">, date: string): boolean {
  return claim.resolution === null && date <= claim.deadline;
}

function checkScoreboard(input: RuleInput): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const draftMode = input.mode === "draft";
  const claims = new Map(input.config.claims.claims.map((c) => [c.id, c]));
  const ids = () => list([...claims.keys()]) || "none";

  const angleClaim = input.draft.angle?.claim_id;
  if (typeof angleClaim === "string") {
    const c = claims.get(angleClaim);
    if (!c) {
      out.push(error("SCOREBOARD_REF", "angle.claim_id", `angle.claim_id "${angleClaim}" is not a claim in config/claims.json (${ids()}); use an open claim's id or null.`));
    } else if (draftMode && !claimOpen(c, input.date)) {
      out.push(error("SCOREBOARD_REF", "angle.claim_id",
        `angle.claim_id "${angleClaim}" is not open (${c.resolution ? `resolved ${c.resolution.status}` : `its deadline ${c.deadline} has passed`}); use an open claim's id or null.`));
    }
  }

  const against = input.draft.week_in_review?.strongest_against?.claim_id;
  if (typeof against === "string" && !claims.has(against)) {
    out.push(error("SCOREBOARD_REF", "week_in_review.strongest_against.claim_id",
      `strongest_against.claim_id "${against}" is not a claim in config/claims.json (${ids()}); use a claim's id or null.`));
  }

  const byUrl = new Map<string, { id: string; source: AnySource }>();
  for (const [id, s] of input.derived.sourcesById) {
    const key = normalizeUrl(String(s.url ?? ""));
    if (!byUrl.has(key)) byUrl.set(key, { id, source: s });
  }
  for (const e of entriesOf(input.draft)) {
    const c = claims.get(e.claim_id);
    if (!c) {
      out.push(error("SCOREBOARD_REF", `${e.path}.claim_id`, `claim_id "${e.claim_id}" is not a claim in config/claims.json (${ids()}).`));
    } else if (draftMode && c.judged_by !== "report") {
      out.push(error("SCOREBOARD_REF", `${e.path}.claim_id`,
        `${e.claim_id} is judged by script from the metrics, so it takes no reported entry; enter reports only for claims judged by report, or drop the entry.`));
    }
    // The quote's source: a draft cites it by id; a Brief stores its URL.
    const ref = e.quote_source_id !== null
      ? (input.derived.sourcesById.has(e.quote_source_id) ? { id: e.quote_source_id, source: input.derived.sourcesById.get(e.quote_source_id)! } : null)
      : e.source_url !== null ? byUrl.get(normalizeUrl(e.source_url)) ?? null : null;
    if (!ref) continue;
    const tier = input.derived.tierBySourceId.get(ref.id) ?? 3;
    const field = e.quote_source_id !== null ? `${e.path}.quote_source_id` : `${e.path}.source_url`;
    if (tier > 2) {
      out.push(error("SCOREBOARD_REF", field, `The entry's quote comes from ${ref.id}, a tier ${tier} source; a Scoreboard entry quotes a tier 1 or 2 source. Cite one, or drop the entry.`));
    }
    if (ref.source.source_type === "finder_writeup" && e.claim_type !== "self_reported") {
      out.push(error("SCOREBOARD_REF", `${e.path}.claim_type`,
        `The quote comes from ${ref.id}, an AI lab writing about its own system (finder_writeup), so claim_type must be "self_reported", not "${e.claim_type}".`));
    }
  }
  return out;
}

export const itemRules: Rule[] = [
  defineRule({ code: "ITEM_CAP", scope: "brief", dataOnly: true, check: checkCap }),
  defineRule({ code: "ITEM_ORDER", scope: "brief", check: checkOrder }),
  defineRule({ code: "TOP3_WHY", scope: "brief", check: checkTop3 }),
  defineRule({ code: "SEVERITY_NULL_FOR_NONTHREAT", scope: "brief", check: checkSeverityNull }),
  defineRule({ code: "SEVERITY_KIND", scope: "brief", check: checkSeverityKind }),
  defineRule({ code: "TAIWAN_LENS_REQUIRED", scope: "brief", check: checkLens }),
  defineRule({ code: "REGION_RAISE", scope: "draft", check: checkRaises }),
  defineRule({ code: "STANDING_STORY_NEW_FACT", scope: "draft", check: checkStanding }),
  defineRule({ code: "SCOREBOARD_REF", scope: "brief", check: checkScoreboard }),
];
