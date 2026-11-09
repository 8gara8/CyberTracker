// Sources (SPEC §4.12): SOURCE_REF, SOURCE_DUP, SOURCE_URL, SOURCE_UNSEEN, SOURCE_TIER, SOURCE_CRITICAL_TWO,
// SOURCE_SYNDICATED, SOURCE_STATE_LABEL, SOURCE_ORPHAN. Publishers and tiers come from `derived` (shared.ts):
// publisherFor() on the current config in draft mode, each source's frozen fields in published mode, so an
// archived brief is never judged against a config change (§4.12 "Archived briefs"). SOURCE_URL reads only the
// `redirect` and `archive` entries of BLOCKED_HOSTS; the rest are NO_EXPLOIT_LINK's (safety.ts).

import type { SourceTiersFile } from "../schema/config";
import type { SourceType, Tier } from "../schema/common";
import { blockedReason, GITHUB_ADVISORIES } from "../sources";
import { blockedEntry, hostOf, isHttpsUrl, normalizeUrl } from "../urls";
import { exploitLinkProblem } from "./safety";
import { entriesOf, isBrief, sourceIdFields } from "./shared";
import {
  defineRule, error, list, plural, warning, type AnyItem, type AnySource, type PublisherView, type Rule, type RuleInput, type ValidationIssue,
} from "./types";

const ids = (xs: readonly string[]) => list(xs);

/** "s3 [BleepingComputer]" for messages. */
function named(input: Pick<RuleInput, "derived">, id: string): string {
  const v = input.derived.publisherBySourceId.get(id);
  return v ? `${id} [${v.publisher_name}]` : id;
}

// ── SOURCE_REF ───────────────────────────────────────────────────────────────────────────────────

/** The source-id fields that must also appear in their item's `source_ids` (§4.12 SOURCE_REF, §4.6 flaw evidence check). */
const MUST_BE_IN_ITEM = /^items\[\]\.(ai_evidence\[\]\.source_id|attribution\[\]\.source_id|incident\.status_source_ids\[\]|flaw_evidence\[\]\.source_id)$/;

/** SOURCE_REF †: an unknown source id in any source-id field; an evidence, attribution, incident or flaw source missing from its item's `source_ids`; an item with no source ids. */
const sourceRef = defineRule({
  code: "SOURCE_REF",
  scope: "brief",
  dataOnly: true,
  check: ({ draft, derived }) => {
    const out: ValidationIssue[] = [];
    const known = [...derived.sourcesById.keys()];
    const range = known.length ? `${known[0]} to ${known[known.length - 1]}` : "none";
    const items = (draft.items ?? []) as AnyItem[];
    for (const ref of sourceIdFields(draft)) {
      if (!derived.sourcesById.has(ref.id)) {
        out.push(error("SOURCE_REF", ref.path, `${ref.path} cites ${ref.id}, which is not in sources (${range}). Add the source or fix the id.`));
        continue;
      }
      if (ref.item !== null && MUST_BE_IN_ITEM.test(ref.field)) {
        const it = items[ref.item];
        if (it && !(it.source_ids ?? []).includes(ref.id)) {
          out.push(error("SOURCE_REF", ref.path, `${ref.path} cites ${ref.id}, which is not in items[${ref.item}].source_ids. Add ${ref.id} to the item's source_ids, or cite one of its sources.`));
        }
      }
    }
    items.forEach((it, i) => {
      if (it && (it.source_ids ?? []).length === 0) {
        out.push(error("SOURCE_REF", `items[${i}].source_ids`, `items[${i}] (${it.id}) cites no sources. List at least one, of tier 1 or 2, in source_ids.`));
      }
    });
    return out;
  },
});

// ── SOURCE_DUP ───────────────────────────────────────────────────────────────────────────────────

/** SOURCE_DUP: two sources share a normalised URL (§4.1 normalizeUrl()). */
const sourceDup = defineRule({
  code: "SOURCE_DUP",
  scope: "brief",
  check: ({ draft }) => {
    const out: ValidationIssue[] = [];
    const first = new Map<string, string>();
    (draft.sources ?? []).forEach((s, i) => {
      if (!s || typeof s.url !== "string") return;
      const key = normalizeUrl(s.url);
      const prev = first.get(key);
      if (prev) {
        out.push(error("SOURCE_DUP", `sources[${i}].url`, `${s.id} has the same URL as ${prev} (${key}). Cite ${prev} wherever ${s.id} is cited, remove ${s.id} and renumber the ids.`));
      } else {
        first.set(key, s.id);
      }
    });
    return out;
  },
});

// ── SOURCE_URL ───────────────────────────────────────────────────────────────────────────────────

/** True when a URL parses with a user name or password (`https://name:pass@host/`), which can hide the real host. */
function hasUserInfo(url: string): boolean {
  try {
    const u = new URL(url);
    return u.username !== "" || u.password !== "";
  } catch {
    return false;
  }
}

/**
 * SOURCE_URL's finding for a URL, or null: not https, malformed, carrying user info (`name:pass@`), or on a
 * BLOCKED_HOSTS entry with reason `redirect` or `archive` (read on the URL as written: normalizeUrl() would
 * strip a Wayback prefix).
 */
export function sourceUrlProblem(url: string): string | null {
  const entry = blockedEntry(url);
  if (entry?.reason === "redirect") return `is a redirect link (${entry.pattern}); open the original page and cite its own URL`;
  if (entry?.reason === "archive") return `is an archive copy (${hostOf(url) ?? entry.pattern}); cite the original page`;
  if (hasUserInfo(url)) return "carries a user name or password before the host (user:password@); cite the plain https address of the page";
  if (isHttpsUrl(url)) return null;
  if (/^http:\/\//i.test(url) && isHttpsUrl(url.replace(/^http:/i, "https:"))) return "uses http; cite the https address of the same page";
  return "is not a valid absolute https URL; copy the page's full address";
}

/** SOURCE_URL †: a source URL that isn't https, is malformed, or is a redirect or archive wrapper. */
const sourceUrl = defineRule({
  code: "SOURCE_URL",
  scope: "brief",
  dataOnly: true,
  check: ({ draft }) => (draft.sources ?? []).flatMap((s, i) => {
    if (!s || typeof s.url !== "string") return [];
    const problem = sourceUrlProblem(s.url);
    return problem ? [error("SOURCE_URL", `sources[${i}].url`, `${s.id}'s URL ${problem}. Found: ${s.url}`)] : [];
  }),
});

// ── SOURCE_UNSEEN ────────────────────────────────────────────────────────────────────────────────

/**
 * NO_EXPLOIT_LINK's URL checks (§4.12), read through safety.ts's exploitLinkProblem() so the two never
 * drift, plus the redirect and archive entries (SOURCE_URL's): true for any blocked host or github.com
 * path outside the advisory paths, or an exploit-like path on a tier 3 or unlisted publisher.
 */
export function exploitLinkUrl(url: string, tier: Tier | undefined, sourceTiers: Pick<SourceTiersFile, "github">, publisher?: string | null): boolean {
  return blockedReason(url, sourceTiers) !== null || exploitLinkProblem(url, tier, sourceTiers, publisher) !== null;
}

/** The ids of sources a flaw_evidence entry cites from its own item: FLAW_EVIDENCE owns them when unseen (§4.12 Close relatives). */
function flawEvidenceSourceIds(items: readonly AnyItem[]): Set<string> {
  const out = new Set<string>();
  for (const it of items) {
    for (const f of it?.flaw_evidence ?? []) {
      if (f && (it.source_ids ?? []).includes(f.source_id)) out.add(f.source_id);
    }
  }
  return out;
}

/**
 * SOURCE_UNSEEN (draft; a warning when there is no evidence file): a normalised source URL isn't in
 * `evidence.urls`. A source a flaw_evidence entry cites is left to FLAW_EVIDENCE (§4.12 Close relatives).
 */
const sourceUnseen = defineRule({
  code: "SOURCE_UNSEEN",
  scope: "draft",
  check: ({ draft, evidence, derived, config }) => {
    if (!evidence) {
      return [warning("SOURCE_UNSEEN", "sources", "Skipped: no evidence file was given, so cited URLs were not checked against what the run saw.",
        "Pass the run's evidence (logs/D.evidence.json, or --evidence) to check them.")];
    }
    const seen = new Set(evidence.urls.map((u) => normalizeUrl(u)));
    const flawOwned = flawEvidenceSourceIds((draft.items ?? []) as AnyItem[]);
    const out: ValidationIssue[] = [];
    (draft.sources ?? []).forEach((s, i) => {
      if (!s || typeof s.url !== "string" || flawOwned.has(s.id)) return;
      if (sourceUrlProblem(s.url) !== null
        || exploitLinkUrl(s.url, derived.tierBySourceId.get(s.id), config.sourceTiers, derived.publisherBySourceId.get(s.id)?.publisher)) return;
      if (!seen.has(normalizeUrl(s.url))) {
        out.push(error("SOURCE_UNSEEN", `sources[${i}].url`,
          `${s.id}'s URL ${s.url} is not in the source pack, a page you fetched or a search result you saw. Cite only URLs you actually saw, or remove ${s.id}.`,
          "Copy the URL exactly as the pack, the fetch or the search result gave it."));
      }
    });
    return out;
  },
});

// ── SOURCE_TIER ──────────────────────────────────────────────────────────────────────────────────

/** The publishers whose pages are CVE, GHSA, JVN and TVN records (§4.12 SOURCE_TIER). TVN notes are TWCERT's. */
export const RECORD_PUBLISHERS: readonly string[] = ["cve-org", "nvd", GITHUB_ADVISORIES, "jvn", "twcert"];

/** True for a publisher no config file lists (publisherFor() step 3 or 4). */
const unlisted = (v: PublisherView) => v.publisher.startsWith("host:");

/** Whether a source_type fits its publisher (§4.12 SOURCE_TIER), or why not. Needs the publisher's kind (draft mode). */
export function sourceTypeFits(type: SourceType, v: PublisherView): boolean {
  switch (type) {
    case "cve_record": return RECORD_PUBLISHERS.includes(v.publisher);
    case "vendor_advisory": return v.kind === "vendor";
    case "government": return v.kind === "government" || v.kind === "cert" || v.kind === "regulator";
    case "regulator_filing": return v.kind === "regulator";
    case "press": return v.tier === 2 && v.kind === "newsroom";
    case "victim": case "finder_writeup": case "research": return v.tier <= 2;
    case "other": return v.tier === 3;
  }
}

const TYPE_NEEDS: Record<SourceType, string> = {
  cve_record: "a record publisher (CVE.org, NVD, GitHub advisories, JVN or TVN)",
  vendor_advisory: "a vendor's own domain",
  government: "a government body, CERT or regulator",
  regulator_filing: "a regulator",
  press: "a tier 2 newsroom",
  victim: "a tier 1 or 2 publisher",
  finder_writeup: "a tier 1 or 2 publisher",
  research: "a tier 1 or 2 publisher",
  other: "a tier 3 publisher",
};

/** The source_type that fits a publisher best, for the message. */
function fittingType(v: PublisherView): SourceType {
  if (v.tier === 3) return "other";
  if (RECORD_PUBLISHERS.includes(v.publisher)) return "cve_record";
  if (v.kind === "vendor") return "vendor_advisory";
  if (v.kind === "government" || v.kind === "cert") return "government";
  if (v.kind === "regulator") return "regulator_filing";
  if (v.kind === "newsroom" && v.tier === 2) return "press";
  return "research";
}

/** "s5 (example.org, tier 3)". */
function tiered(input: Pick<RuleInput, "derived">, id: string): string {
  const v = input.derived.publisherBySourceId.get(id);
  return v ? `${id} (${v.publisher_name}, tier ${v.tier})` : id;
}

/**
 * SOURCE_TIER: an item, the Angle (when it cites a source) or an Elsewhere link without a tier 1 or 2
 * source, error; a source on an unlisted domain, warning (not when SOURCE_URL or NO_EXPLOIT_LINK already
 * fails its URL); draft mode: a `source_type` that doesn't fit its
 * publisher. Unknown ids are SOURCE_REF's and are left out; a scoreboard entry's quote source is
 * SCOREBOARD_REF's (it names that field's tier).
 */
const sourceTier = defineRule({
  code: "SOURCE_TIER",
  scope: "brief",
  check: (input) => {
    const { draft, derived, mode } = input;
    const out: ValidationIssue[] = [];
    const tier = (id: string) => derived.tierBySourceId.get(id);
    ((draft.items ?? []) as AnyItem[]).forEach((it, i) => {
      const known = [...new Set(it?.source_ids ?? [])].filter((id) => tier(id) !== undefined);
      if (known.length === 0 || known.some((id) => tier(id)! <= 2)) return;
      out.push(error("SOURCE_TIER", `items[${i}].source_ids`,
        `items[${i}] (${it.id}) cites only tier 3 sources: ${known.map((id) => tiered(input, id)).join(", ")}. Tier 3 is never cited for facts on its own; cite a tier 1 or 2 source for this item, or drop it.`));
    });
    const angleId = draft.angle?.source_id ?? null;
    if (angleId !== null && tier(angleId) === 3) {
      out.push(error("SOURCE_TIER", "angle.source_id",
        `The Angle's number comes from ${tiered(input, angleId)}; it needs a tier 1 or 2 source. Cite one that gives the number, or use a metric_path.`));
    }
    (draft.elsewhere ?? []).forEach((e, i) => {
      if (e && tier(e.source_id) === 3) {
        out.push(error("SOURCE_TIER", `elsewhere[${i}].source_id`,
          `elsewhere[${i}] links ${tiered(input, e.source_id)}; an Elsewhere link needs a tier 1 or 2 source. Link a newsroom or primary source instead.`));
      }
    });
    (draft.sources ?? []).forEach((s, i) => {
      const v = s ? derived.publisherBySourceId.get(s.id) : undefined;
      if (!s || !v || derived.sourcesById.get(s.id) !== s) return;
      // A URL SOURCE_URL or NO_EXPLOIT_LINK already fails is theirs (one code per problem, as SOURCE_UNSEEN).
      const urlFails = () => typeof s.url !== "string" || sourceUrlProblem(s.url) !== null
        || exploitLinkUrl(s.url, v.tier, input.config.sourceTiers, v.publisher);
      if (v.tier === 3 && unlisted(v) && !urlFails()) {
        out.push(warning("SOURCE_TIER", `sources[${i}].url`,
          `${s.id} is on ${v.publisher.slice("host:".length)}, which source-tiers.json and vendors.json don't list, so it counts as tier 3: cite it only beside a tier 1 or 2 source.`,
          "If this publisher does its own reporting, propose adding it to config/source-tiers.json in a PR."));
      }
      if (mode === "draft" && v.kind !== null && !sourceTypeFits(s.source_type, v)) {
        out.push(error("SOURCE_TIER", `sources[${i}].source_type`,
          `${s.id} has source_type "${s.source_type}", which needs ${TYPE_NEEDS[s.source_type]}, but ${v.publisher_name} is ${v.kind === "other" ? "an unlisted publisher" : `a ${v.kind} publisher`} of tier ${v.tier}. Use "${fittingType(v)}", or cite a source that fits.`));
      }
    });
    return out;
  },
});

// ── SOURCE_CRITICAL_TWO and SOURCE_SYNDICATED ────────────────────────────────────────────────────

interface Unit {
  publishers: string[];
  tier: Tier;
}

/** Why a set of publishers misses the Critical bar (§4.12), or null when it meets it. */
function missedBar(units: readonly Unit[], soleFalse: (publisher: string) => boolean, draftMode: boolean,
  nameOf: (publisher: string) => string): string | null {
  if (units.length < 2) return `has ${plural(units.length, "publisher")}`;
  if (!units.some((u) => u.tier === 1)) return "has no tier 1 publisher";
  if (draftMode) {
    const counted = units.filter((u) => !u.publishers.every(soleFalse));
    const weak = units.filter((u) => u.publishers.every(soleFalse)).flatMap((u) => u.publishers.map(nameOf));
    if (counted.length < 2) return `reaches two publishers only with ${list(weak)}, which can't be a Critical item's only newsroom`;
  }
  return null;
}

/**
 * SOURCE_CRITICAL_TWO (the sole-newsroom and fetched checks draft only) and SOURCE_SYNDICATED: a Critical
 * item needs two publishers, one of tier 1, syndicated copies folded; a newsroom with
 * `sole_newsroom_for_critical: false` doesn't count towards the two; in draft mode one of its sources must be
 * in `evidence.fetched`. SOURCE_SYNDICATED fires instead when the bar is met before folding and missed after.
 */
const sourceCritical = defineRule({
  code: ["SOURCE_CRITICAL_TWO", "SOURCE_SYNDICATED"],
  scope: "brief",
  check: (input) => {
    const { draft, derived, mode, evidence } = input;
    const out: ValidationIssue[] = [];
    const draftMode = mode === "draft";
    const fetched = evidence ? new Set(evidence.fetched.map((u) => normalizeUrl(u))) : null;
    ((draft.items ?? []) as AnyItem[]).forEach((it, i) => {
      if (!it || it.severity !== "critical") return;
      const views = [...new Set(it.source_ids ?? [])].flatMap((id) => {
        const v = derived.publisherBySourceId.get(id);
        return v && v.tier <= 2 ? [{ id, v }] : [];
      });
      const soleFalse = (p: string) => views.some((x) => x.v.publisher === p && x.v.sole_newsroom_for_critical === false);
      const distinct = new Map<string, Unit>();
      for (const { v } of views) {
        const u = distinct.get(v.publisher);
        if (!u) distinct.set(v.publisher, { publishers: [v.publisher], tier: v.tier });
        else if (v.tier < u.tier) u.tier = v.tier;
      }
      const groups = derived.publishersByIndex[i]?.groups ?? [];
      const nameOf = (p: string) => views.find((x) => x.v.publisher === p)?.v.publisher_name ?? p;
      const groupText = groups.map((g) => g.publishers.map(nameOf).join(" = ")).join("; ") || "none";
      const after = missedBar(groups, soleFalse, draftMode, nameOf);
      if (after !== null) {
        const before = missedBar([...distinct.values()], soleFalse, draftMode, nameOf);
        if (before === null) {
          out.push(error("SOURCE_SYNDICATED", `items[${i}].source_ids`,
            `items[${i}] (${it.id}) is Critical and counts ${plural(distinct.size, "publisher")} only by counting syndicated copies separately: after folding copies of one story (the same publisher, or near-identical titles) it ${after} (${groupText}). Cite an independent second publisher, one of tier 1, or lower the severity.`));
        } else {
          out.push(error("SOURCE_CRITICAL_TWO", `items[${i}].source_ids`,
            `items[${i}] (${it.id}) is Critical but ${after} (${groupText}); a Critical item needs two independent publishers, one of them tier 1. Cite another publisher or lower the severity.`));
        }
      }
      if (draftMode && fetched) {
        const own = [...new Set(it.source_ids ?? [])].flatMap((id) => {
          const s = derived.sourcesById.get(id);
          return s ? [s] : [];
        });
        if (own.length && !own.some((s) => fetched.has(normalizeUrl(s.url)))) {
          out.push(error("SOURCE_CRITICAL_TWO", `items[${i}].source_ids`,
            `items[${i}] (${it.id}) is Critical but none of its sources (${ids(own.map((s) => s.id))}) was fetched or read as a record. Fetch at least one of them (WebFetch) before keeping it Critical.`));
        }
      }
    });
    return out;
  },
});

// ── SOURCE_STATE_LABEL ───────────────────────────────────────────────────────────────────────────

/** The "<country> state claim" form of a state label: "PRC state source" gives "PRC state claim". */
export function stateClaimPhrase(label: string): string {
  return `${label.trim().split(/\s+/)[0]} state claim`;
}

const containsCi = (text: string | null | undefined, phrase: string) => typeof text === "string" && text.toLowerCase().includes(phrase.toLowerCase());

/** SOURCE_STATE_LABEL (draft: labels come from the current config): an item citing a state-labelled publisher must say so and be a government claim. */
const sourceStateLabel = defineRule({
  code: "SOURCE_STATE_LABEL",
  scope: "draft",
  check: (input) => {
    const { draft, derived } = input;
    const out: ValidationIssue[] = [];
    ((draft.items ?? []) as AnyItem[]).forEach((it, i) => {
      if (!it) return;
      const labelled = new Map<string, string[]>();
      for (const id of new Set(it.source_ids ?? [])) {
        const label = derived.publisherBySourceId.get(id)?.state_label;
        if (label) labelled.set(label, [...(labelled.get(label) ?? []), id]);
      }
      for (const [label, srcs] of labelled) {
        const phrase = stateClaimPhrase(label);
        const says = [it.headline, it.summary].some((t) => containsCi(t, label) || containsCi(t, phrase));
        if (!says) {
          out.push(error("SOURCE_STATE_LABEL", `items[${i}].headline`,
            `items[${i}] (${it.id}) cites ${srcs.map((id) => named(input, id)).join(", ")}, labelled "${label}", but neither its headline nor its summary says "${label}" or "${phrase}". Add the label where the source is first named.`));
        }
      }
      if (labelled.size && it.claim_type !== "government") {
        out.push(error("SOURCE_STATE_LABEL", `items[${i}].claim_type`,
          `items[${i}] (${it.id}) cites a state-labelled source (${[...labelled.keys()].join(", ")}) but its claim_type is "${it.claim_type}". Set claim_type to "government".`));
      }
    });
    return out;
  },
});

// ── SOURCE_ORPHAN ────────────────────────────────────────────────────────────────────────────────

/** SOURCE_ORPHAN (warning): a source no source-id field references (a Brief's Scoreboard entries and corrections cite by URL). */
const sourceOrphan = defineRule({
  code: "SOURCE_ORPHAN",
  severity: "warning",
  scope: "brief",
  check: ({ draft }) => {
    const cited = new Set(sourceIdFields(draft).map((r) => r.id));
    const citedUrls = new Set<string>();
    if (isBrief(draft)) {
      for (const e of entriesOf(draft)) if (e.source_url) citedUrls.add(normalizeUrl(e.source_url));
      for (const c of draft.corrections ?? []) if (c?.source_url) citedUrls.add(normalizeUrl(c.source_url));
    }
    return ((draft.sources ?? []) as AnySource[]).flatMap((s, i) => {
      if (!s || cited.has(s.id) || (typeof s.url === "string" && citedUrls.has(normalizeUrl(s.url)))) return [];
      return [warning("SOURCE_ORPHAN", `sources[${i}]`, `${s.id} (${s.url}) is never cited. Cite it where it supports a claim, or remove it and renumber the ids.`)];
    });
  },
});

export const sourceRules: Rule[] = [sourceRef, sourceDup, sourceUrl, sourceUnseen, sourceTier, sourceCritical, sourceStateLabel, sourceOrphan];
