// Ids (SPEC §4.12, §4.3): ID_FORMAT † (the reuse check draft only), ID_SEQUENCE †, ID_DUPLICATE †. Item ids
// are CVE ids or slugs: these rules check their format and uniqueness only. Correction ids are publish's
// (validateAll() checks C-NNNN, §4.10).

import { ITEM_ID_MAX } from "../schema/common";
import { KIND_INFO, KINDS, type KindId } from "../vocab";
import { defineRule, error, type AnyItem, type Rule, type RuleInput, type ValidationIssue } from "./types";

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const SLUG_RE = new RegExp(`^${SLUG}$`);
const CVE_ITEM_RE = /^cve-\d{4}-\d{4,}$/;
const RELEASE_RE = /^rel-([a-z0-9-]+-\d{4}-\d{2}(?:-\d{2})?)$/;

const isKind = (k: unknown): k is KindId => typeof k === "string" && (KINDS as readonly string[]).includes(k);

/** "an ai_capability", "a campaign". */
const aKind = (kind: string) => `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;

/** A suggested slug from a bad id: lower case, every run of other characters a hyphen, the prefix dropped. */
function suggestSlug(id: string): string {
  const rest = id.toLowerCase().replace(/^(?:cve|vuln|pt|inc|sc|camp|pol|ai|eco)-/, "");
  return rest.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "event-yyyy-mm";
}

/**
 * The id an item must have, or the shape it must take, by §4.3: a flaw item with CVE ids uses `cve_ids[0]`
 * lower-cased; a patch batch `pt-` plus its release_id after `rel-`; everything else (a flaw without a CVE
 * id: `vuln`) its KIND_INFO slug prefix plus a slug. Returns the problem as a sentence, or null.
 */
export function idProblem(item: Pick<AnyItem, "id" | "kind" | "cve_ids" | "release_id">): string | null {
  const { id, kind } = item;
  if (!isKind(kind) || typeof id !== "string") return null;
  const cves = Array.isArray(item.cve_ids) ? item.cve_ids : [];
  if (id.length > ITEM_ID_MAX) {
    return `id "${id}" has ${id.length} characters; the limit is ${ITEM_ID_MAX}. Shorten the slug by at least ${id.length - ITEM_ID_MAX}.`;
  }
  if (kind === "patch_batch") {
    const m = typeof item.release_id === "string" ? RELEASE_RE.exec(item.release_id) : null;
    if (!m) {
      return `a patch_batch item needs release_id from its release candidate (rel-<vendor id>-YYYY-MM), and its id is that with "pt-" for "rel-"; release_id is ${JSON.stringify(item.release_id ?? null)}. Copy both from the candidate.`;
    }
    const want = `pt-${m[1]}`;
    return id === want ? null : `id "${id}" must be "${want}": a patch batch takes its release candidate's id (release_id ${item.release_id} with "pt-" for "rel-").`;
  }
  if (kind === "exploited_flaw" || kind === "critical_flaw") {
    if (cves.length > 0 && typeof cves[0] === "string") {
      const want = cves[0].toLowerCase();
      return id === want ? null : `id "${id}" must be "${want}": a flaw item with CVE ids takes its first CVE id, cve_ids[0], in lower case.`;
    }
    if (id.startsWith("cve-")) {
      return `id "${id}" starts "cve-" but cve_ids is empty; list the CVE id in cve_ids (its first entry, upper case, gives the id), or use "vuln-" plus a slug for a flaw with no CVE id.`;
    }
    return new RegExp(`^vuln-${SLUG}$`).test(id) ? null
      : `id "${id}" breaks the format: a flaw item with no CVE id is "vuln-" plus a slug of lower-case letters and digits joined by single hyphens, e.g. "vuln-${suggestSlug(id)}".`;
  }
  const prefix = KIND_INFO[kind].slug;
  if (id.startsWith("cve-") || CVE_ITEM_RE.test(id)) {
    return `id "${id}" starts "cve-", which only a flaw item (exploited_flaw, critical_flaw) with CVE ids uses; ${aKind(kind)} item's id is "${prefix}-" plus a slug, e.g. "${prefix}-${suggestSlug(id)}".`;
  }
  if (id.startsWith(`${prefix}-`) && SLUG_RE.test(id.slice(prefix.length + 1))) return null;
  return `id "${id}" breaks the format: ${aKind(kind)} item's id is "${prefix}-" plus a slug of lower-case letters and digits joined by single hyphens, e.g. "${prefix}-${suggestSlug(id)}".`;
}

/** ID_FORMAT † (brief; the reuse check draft): the §4.3 format; in draft mode, an id the last 14 days used for another kind. */
function checkIdFormat(input: RuleInput): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const items = (input.draft.items ?? []) as AnyItem[];
  const recent = input.mode === "draft" ? input.context?.recent_items ?? [] : [];
  items.forEach((it, i) => {
    if (!it) return;
    const problem = idProblem(it);
    if (problem) {
      out.push(error("ID_FORMAT", `items[${i}].id`, problem, "A flaw with CVE ids takes cve_ids[0] lower-cased; a patch batch pt- plus its release; others the kind's prefix plus a slug. An inc- slug never names a victim."));
      return;
    }
    const other = recent.find((r) => r.id === it.id && r.kind !== it.kind && r.date < input.date);
    if (other) {
      out.push(error("ID_FORMAT", `items[${i}].id`,
        `id "${it.id}" was ${aKind(other.kind)} item on ${other.date} but is ${aKind(it.kind)} item here; an item keeps its id and kind in every edition. Use kind ${other.kind} if it is the same event, else give it a new id.`));
    }
  });
  return out;
}

/** ID_SEQUENCE † (brief): `sources[i].id` isn't `s${i + 1}`. The first break is reported, with the count of ids out of place. */
function checkIdSequence(input: RuleInput): ValidationIssue[] {
  const sources = input.draft.sources ?? [];
  const bad = sources.flatMap((s, i) => (s && s.id !== `s${i + 1}` ? [i] : []));
  if (!bad.length) return [];
  const i = bad[0]!;
  const found = sources[i]?.id;
  const more = bad.length > 1 ? ` ${bad.length} of the ${sources.length} sources are out of place.` : "";
  return [error("ID_SEQUENCE", `sources[${i}].id`,
    `sources[${i}].id is ${JSON.stringify(found ?? null)} but must be "s${i + 1}": source ids run s1, s2, s3 in array order with no gaps or repeats.${more} Renumber the sources and every reference to them.`)];
}

/** ID_DUPLICATE † (brief): two items share an id. */
function checkIdDuplicate(input: RuleInput): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const first = new Map<string, number>();
  (input.draft.items ?? []).forEach((it, i) => {
    if (!it || typeof it.id !== "string") return;
    const j = first.get(it.id);
    if (j === undefined) {
      first.set(it.id, i);
      return;
    }
    out.push(error("ID_DUPLICATE", `items[${i}].id`,
      `items[${i}] and items[${j}] share the id "${it.id}"; each item has its own id. Merge them if they are one event, else give this one a new id.`));
  });
  return out;
}

export const idRules: Rule[] = [
  defineRule({ code: "ID_FORMAT", scope: "brief", dataOnly: true, check: checkIdFormat }),
  defineRule({ code: "ID_SEQUENCE", scope: "brief", dataOnly: true, check: checkIdSequence }),
  defineRule({ code: "ID_DUPLICATE", scope: "brief", dataOnly: true, check: checkIdDuplicate }),
];
