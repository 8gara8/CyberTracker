// The agent's context (SPEC §4.15, §8.5): built in memory for each attempt from the pack, the candidates,
// the metrics, the config and the stored briefs. The validator uses only this in-memory copy, never the
// file the agent can write. Pure: every input is passed in, nothing is read or written here. Printed with
// the compact printJson() (lib/json-schema.ts); past CONTEXT_MAX_BYTES it is trimmed in §8.5's order
// (recent_items older than 7 days, candidates ranked 31 to 40, standing-story match_terms beyond 5), each
// trim logged as `CONTEXT_TRIMMED <what>`; metrics, corrections and the first 30 candidates are never
// trimmed. Everything that came from a feed is data, already sanitised and wrapped by collect. Owner: lane L4.

import type { LoadedConfig } from "./config";
import { addDays, isMonday, taipeiTimestamp } from "./dates";
import { printJson } from "./json-schema";
import { kevLines, quotableRows } from "./metrics/headline";
import { previewRegions, regionsPreviewRows } from "./regions";
import { finderNames } from "./rules/shared";
import { fittingType } from "./rules/sources";
import type { RegionsBase } from "./rules/types";
import type { Brief } from "./schema/brief";
import { AgentContext } from "./schema/context";
import type { Metrics } from "./schema/metrics";
import type { CorrectionsFile, Dispute } from "./schema/misc";
import type { CandidatesFile, Pack } from "./schema/pack";
import type { ScoreboardFile, Threshold } from "./schema/scoreboard";
import { BANNED_WORDS, PARTIAL_FEED_IDS, WITHHELD_HEADLINE } from "./vocab";
import { bindingWithholds, itemRef, withheldRefs, withholdsOn } from "./withhold-mask";

/** The context's size limit (§8.5): past it, after every trim, buildContext() throws ContextTooLarge. */
export const CONTEXT_MAX_BYTES = 250 * 1024;
/** No line of the printed context is longer (§8.5). */
export const CONTEXT_LINE_MAX = 1000;

/** The context is still over CONTEXT_MAX_BYTES after every trim (§8.5): E_INTERNAL for that attempt. */
export class ContextTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`The agent context is ${bytes} bytes after trimming, over the ${CONTEXT_MAX_BYTES}-byte limit.`);
    this.name = "ContextTooLarge";
  }
}

export interface ContextInput {
  date: string;
  /** Epoch ms on the run's clock. */
  now: number;
  /** Epoch ms → AgentContext.deadline (+08:00). */
  deadline: number;
  pack: Pack;
  /** packs/D.candidates.json */
  candidates: CandidatesFile;
  metrics: Metrics;
  config: LoadedConfig;
  /** readHistory(content, D, 14) */
  history: readonly Brief[];
  /**
   * readBrief(content, D): brief D as stored this morning (the data-only edition, after intake's withholds).
   * Only its withheld items enter recent_items, so the draft leaves them out; absent or null: none.
   */
  today?: Brief | null;
  corrections: CorrectionsFile | null;
  /** Intake's updated disputes, whose statuses decide which withholds still bind; absent or null: corrections' own. */
  disputes?: readonly Dispute[] | null;
  scoreboard: ScoreboardFile | null;
  /** regions_preview = regionsPreviewRows(previewRegions(regionsBase)) */
  regionsBase: RegionsBase;
  recheck: { flagged: AgentContext["corrections"]["flagged"]; reports: AgentContext["corrections"]["reports"] } | null;
  /**
   * standingLast(content, D) (lib/run-inputs.ts): each tagged story's newest date and item over every
   * stored brief; a story absent here gets its seed_last_development and a null last_item_id (plan A15).
   */
  standingLast: Readonly<Record<string, { date: string; item_id: string }>>;
}

export interface BuiltContext {
  /** AgentContext.parse()d */
  context: AgentContext;
  /** printJson() from lib/json-schema.ts plus "\n"; every line ≤ 1,000 characters. */
  text: string;
  /** The CONTEXT_TRIMMED <what> entries, in order. */
  trimmed: string[];
}

/** recent_items covers this many days of editions (§4.15); the first trim keeps only the last RECENT_KEEP_DAYS. */
export const RECENT_DAYS = 14;
const RECENT_KEEP_DAYS = 7;
/** The second trim keeps candidates ranked 1 to this. */
const CANDIDATES_KEPT = 30;
/** The third trim keeps this many match_terms per standing story. */
const MATCH_TERMS_KEPT = 5;
/** A recent item's source URL longer than this is left out, as the pack leaves out a long advisory link, so no line runs past CONTEXT_LINE_MAX. */
const RECENT_URL_MAX = 500;

/** The three trims of §8.5, in order: what each logs after `CONTEXT_TRIMMED `. */
export const CONTEXT_TRIMS = [
  `recent_items older than ${RECENT_KEEP_DAYS} days`,
  `candidates ranked ${CANDIDATES_KEPT + 1} to 40`,
  `standing_stories match_terms beyond ${MATCH_TERMS_KEPT}`,
] as const;

const PARTIAL_FEEDS: ReadonlySet<string> = new Set(PARTIAL_FEED_IDS);

/**
 * metrics.quotable (§4.15): quotableRows() (lib/metrics/headline.ts), every number the Gap headline and
 * second line quote, then every Gap data table display, then the Taiwan Lens KEV counts, each with its
 * exact display string and the data cutoff as `as_of`; a key and display pair is listed once.
 */
export function quotableOf(m: Metrics): AgentContext["metrics"]["quotable"] {
  return quotableRows(m).map((r) => ({ ...r, as_of: m.data_cutoff_utc }));
}

/**
 * `config.tiers.cve_record` (§4.15): the domains of the publishers whose fitting source_type is
 * "cve_record" (SOURCE_TIER's fittingType()), in config order, each once. The prompt tells the agent to cite
 * a page on one as a CVE record, never as a vendor advisory.
 */
export function cveRecordDomains(sourceTiers: Pick<LoadedConfig["sourceTiers"], "publishers">): string[] {
  return [...new Set(sourceTiers.publishers
    .filter((p) => fittingType({ tier: p.tier, publisher: p.id, kind: p.kind }) === "cve_record")
    .flatMap((p) => p.domains))];
}

/** A claim threshold as one line of text (§4.15 scoreboard support and challenge). */
export function thresholdText(th: Threshold): string {
  if (th.kind === "event") return th.text;
  const bound = th.bound === "value" ? "value" : th.bound === "ci80_lo" ? "80% interval low" : "80% interval high";
  return `${bound} ${th.op} ${th.value}`;
}

/** A watch-window search term's language tag: Japanese when it holds kana, Traditional Chinese when it holds Han, else English. */
function termLanguage(term: string): string {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term)) return "ja";
  if (/\p{Script=Han}/u.test(term)) return "zh-Hant-TW";
  return "en";
}

/** The context before any trim, as a plain object (parsed at the end). */
function assemble(i: ContextInput): AgentContext {
  const cfg = i.config;
  const b = cfg.run.budgets;
  const m = i.metrics;
  const lines = kevLines(m);
  const tiers = cfg.sourceTiers.publishers;
  const domains = (pred: (p: (typeof tiers)[number]) => boolean) => [...new Set(tiers.filter(pred).flatMap((p) => p.domains))];
  const families = [...new Set(cfg.aiFinders.finders.map((f) => f.family))];
  const active = cfg.watchWindows.windows.filter((w) => w.start <= i.date && i.date <= w.end);
  const partialFeeds = i.pack.feeds.filter((f) => PARTIAL_FEEDS.has(f.id));
  const yesterday = i.history.find((h) => h.date === addDays(i.date, -1)) ?? null;
  const states = new Map((i.scoreboard?.claims ?? []).map((c) => [c.id, c] as const));
  // A withhold binds later editions (lib/withhold-mask.ts): its items are marked, with the withheld headline only.
  // One made this morning names brief D, which applyDraft() masks whatever the dispute's status.
  const binding = bindingWithholds(i.corrections, i.disputes);
  const sameDay = withholdsOn(i.corrections, i.date, i.disputes).filter((x) => !binding.some((y) => y.correction_id === x.correction_id));
  const today = i.today && i.today.date === i.date ? [i.today] : [];
  const held = withheldRefs([...binding, ...sameDay], [...i.history, ...today]);

  return {
    date: i.date,
    window: { start: i.pack.window.start, end: i.pack.window.end },
    weekly: isMonday(i.date),
    deadline: taipeiTimestamp(new Date(i.deadline)),
    data_cutoff_utc: i.pack.data_cutoff_utc,
    budgets: {
      max_items: b.items_max,
      typical_items: [b.typical_items[0], b.typical_items[1]],
      deep_reads: b.deep_read_max,
      page_fetches: b.web_fetches,
      words: { target: b.words_target, max: b.words_max },
    },
    candidates: i.candidates.kept.map((c) => structuredClone(c)),
    cut: { count: i.candidates.cut.count, by_reason: { ...i.candidates.cut.by_reason } },
    metrics: {
      gap_headline: m.headline.text,
      quotable: quotableOf(m),
      home_vendor_kev: { tw: { d30_n: lines.tw.d30_n, d90_n: lines.tw.d90_n }, jp: { d30_n: lines.jp.d30_n, d90_n: lines.jp.d90_n } },
      // The feeds a partial edition names (PARTIAL_FEED_IDS) that are stale or failed: their figures show an older date.
      stale: partialFeeds.filter((f) => f.stale || !f.ok).map((f) => f.id),
    },
    regions_preview: regionsPreviewRows(previewRegions(i.regionsBase)),
    standing_stories: cfg.standingStories.stories.map((s) => {
      const last = i.standingLast[s.id];
      return {
        id: s.id, title: s.title, match_terms: [...s.match_terms],
        last_development: last?.date ?? s.seed_last_development, last_item_id: last?.item_id ?? null,
      };
    }),
    watch_windows: active.map((w) => ({ id: w.id, title: w.title, start: w.start, end: w.end, search_terms: [...w.search_terms] })),
    watch_searches: [
      ...cfg.sources.feeds.flatMap((f) => (f.kind === "search"
        ? [{ id: f.id, name: f.name, query: f.query, language: f.language, region: f.region }] : [])),
      ...active.flatMap((w) => w.search_terms.map((term, k) => ({
        id: `w-${w.id}-${k + 1}`, name: w.title, query: term, language: termLanguage(term),
        region: w.regions.length === 1 ? w.regions[0]! : "GLOBAL" as const,
      }))),
    ],
    recent_items: [...today, ...i.history.filter((h) => h.date < i.date && h.date >= addDays(i.date, -RECENT_DAYS))]
      .sort((a, c) => (a.date < c.date ? 1 : a.date > c.date ? -1 : 0))
      .flatMap((h) => {
        const urlOf = new Map(h.sources.map((s) => [s.id, s.url] as const));
        return h.items.flatMap((it) => {
          const w = held.get(itemRef(h.date, it.id))?.[0];
          // Brief D itself: only its withheld items (every rule reading recent_items looks at dates before D).
          if (h.date === i.date && !w) return [];
          return [{
            date: h.date, id: it.id, kind: it.kind, headline: w ? WITHHELD_HEADLINE : it.headline, severity: it.severity,
            source_urls: [...new Set(it.source_ids.map((id) => urlOf.get(id)).filter((u): u is string => !!u && u.length <= RECENT_URL_MAX))],
            ...(w ? { withheld: true as const, dispute_kind: w.kind } : {}),
          }];
        });
      }),
    yesterday: yesterday
      ? { date: yesterday.date, edition: yesterday.edition, lead: yesterday.lead.map((l) => l.text), item_ids: yesterday.items.map((it) => it.id) }
      : null,
    scoreboard: cfg.claims.claims.map((c) => {
      const st = states.get(c.id);
      return {
        id: c.id, text: c.text, judged_by: c.judged_by, metric_path: c.metric_path,
        support: thresholdText(c.support), challenge: thresholdText(c.challenge), deadline: c.deadline,
        status: c.resolution?.status ?? st?.status ?? "open",
        reading: st?.reading_text ?? null, reading_as_of: st?.reading_as_of ?? null,
      };
    }),
    corrections: {
      flagged: (i.recheck?.flagged ?? []).map((f) => ({ ...f })),
      reports: (i.recheck?.reports ?? []).map((r) => ({ ...r })),
    },
    config: {
      tiers: {
        t1: domains((p) => p.tier === 1),
        t2: domains((p) => p.tier === 2),
        not_sole_newsroom: domains((p) => !p.sole_newsroom_for_critical),
        state_labelled: domains((p) => p.state_label !== null),
        cve_record: cveRecordDomains(cfg.sourceTiers),
      },
      home_vendors: {
        tw: cfg.vendors.vendors.filter((v) => v.country === "TW").map((v) => v.name),
        jp: cfg.vendors.vendors.filter((v) => v.country === "JP").map((v) => v.name),
      },
      actors: cfg.actors.actors.map((a) => ({ name: a.name, aliases: a.aliases.map((x) => x.name), related_tracker: a.related_tracker })),
      ai_finders: families.map((family) => ({
        family, names: [...new Set(cfg.aiFinders.finders.filter((f) => f.family === family).flatMap((f) => finderNames(f)))],
      })),
      banned_words: [...BANNED_WORDS],
    },
    pack: {
      md: `${cfg.run.paths.packs}/${i.date}.md`,
      json: `${cfg.run.paths.packs}/${i.date}.json`,
      degraded: i.pack.degraded,
      // A failed feed of PARTIAL_FEED_IDS makes the edition partial (§4.12 Word budgets); packs/D.md's header names every failed feed.
      failed_feeds: partialFeeds.filter((f) => !f.ok).map((f) => f.id),
    },
  };
}

const render = (c: AgentContext) => `${printJson(c)}\n`;
const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * Builds the agent context for one attempt (§4.15, §8.5): AgentContext.parse()d, printed, and trimmed in
 * order while over CONTEXT_MAX_BYTES. Throws ContextTooLarge when still over after every trim, and an
 * Error when a printed line is longer than CONTEXT_LINE_MAX (a string printJson keeps whole).
 */
export function buildContext(i: ContextInput, log?: (line: string) => void): BuiltContext {
  let context = AgentContext.parse(assemble(i));
  let text = render(context);
  const trimmed: string[] = [];
  const trims: ((c: AgentContext) => AgentContext)[] = [
    (c) => ({ ...c, recent_items: c.recent_items.filter((r) => r.date >= addDays(i.date, -RECENT_KEEP_DAYS)) }),
    (c) => {
      const kept = c.candidates.filter((x) => x.rank <= CANDIDATES_KEPT);
      const gone = c.candidates.length - kept.length;
      if (gone === 0) return c;
      const by = { ...c.cut.by_reason, context_trimmed: (c.cut.by_reason.context_trimmed ?? 0) + gone };
      return { ...c, candidates: kept, cut: { count: c.cut.count + gone, by_reason: by } };
    },
    (c) => ({ ...c, standing_stories: c.standing_stories.map((s) => ({ ...s, match_terms: s.match_terms.slice(0, MATCH_TERMS_KEPT) })) }),
  ];
  for (let k = 0; k < trims.length && bytesOf(text) > CONTEXT_MAX_BYTES; k++) {
    context = AgentContext.parse(trims[k]!(context));
    text = render(context);
    const line = `CONTEXT_TRIMMED ${CONTEXT_TRIMS[k]}`;
    trimmed.push(line);
    log?.(line);
  }
  const bytes = bytesOf(text);
  if (bytes > CONTEXT_MAX_BYTES) throw new ContextTooLarge(bytes);
  const long = text.split("\n").findIndex((l) => l.length > CONTEXT_LINE_MAX);
  if (long >= 0) throw new Error(`The agent context's line ${long + 1} is longer than ${CONTEXT_LINE_MAX} characters.`);
  return { context, text, trimmed };
}
