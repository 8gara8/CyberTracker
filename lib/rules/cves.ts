// CVEs and flaws (SPEC §4.12): CVE_PUBLISHED, CVE_IN_SOURCE, VENDOR_CONFIRMED, EXPLOITED_BASIS, FLAW_EVIDENCE.
// Draft mode reads the morning's CVE List (`cveList`), the KEV index rows in `regionsBase`, the context's
// candidates and the evidence; published mode reads only what the brief froze (each item's CVE blocks), so
// an archived brief is never judged against a config or feed change (§4.12 "Archived briefs"). A source
// missing from its item's `source_ids` is SOURCE_REF's, never FLAW_EVIDENCE's (Close relatives).

import { cnaConfirms, matchVendor, type LoadedConfig } from "../config";
import type { CveBlock } from "../schema/item";
import type { SourceTiersFile, Vendor } from "../schema/config";
import { GITHUB_ADVISORIES, urlOnAnyDomain } from "../sources";
import { hostOf, matchPath } from "../urls";
import { proseFields, quotedFields, inEvidence, seenText, sourcesOfItem, type FieldText } from "./shared";
import {
  defineRule, error, list, plural, warning, type AnyBrief, type AnyItem, type PublisherView, type Rule, type RuleInput, type ValidationIssue,
} from "./types";

// ── CVE ids in text ──────────────────────────────────────────────────────────────────────────────

const CVE_ID_RE = /(?<![\p{L}\p{N}_])CVE-\d{4}-\d{4,}(?!\d)/giu;

/** The CVE ids in a text (`CVE-\d{4}-\d{4,}`, any case), upper-cased, unique, in order of first use. */
export function cveIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(CVE_ID_RE)].map((m) => m[0].toUpperCase()))];
}

/** True when `text` holds `cveId` (any case), not as the start of a longer id. */
export function holdsCveId(text: string, cveId: string): boolean {
  return cveIdsIn(text).includes(cveId.toUpperCase());
}

/** An item's text: its prose and quoted fields (§4.12 Shared definitions), by item index. */
export function itemTextFields(b: AnyBrief): Map<number, FieldText[]> {
  const out = new Map<number, FieldText[]>();
  for (const f of [...proseFields(b), ...quotedFields(b)]) {
    if (f.item === null) continue;
    const list = out.get(f.item) ?? [];
    list.push(f);
    out.set(f.item, list);
  }
  return out;
}

/** The items a Lead sentence, the Angle or a Taiwan Lens block cites, by text path. The Angle cites the items that share one of its sources. */
export function citedItemsByPath(b: AnyBrief): Map<string, AnyItem[]> {
  const items = (b.items ?? []) as AnyItem[];
  const byId = (ids: readonly string[] | undefined) => items.filter((it) => it && (ids ?? []).includes(it.id));
  const out = new Map<string, AnyItem[]>();
  (b.lead ?? []).forEach((s, i) => out.set(`lead[${i}].text`, byId(s?.item_ids)));
  if (b.angle) {
    const sources = [b.angle.source_id, ...(b.angle.counterpoint_source_ids ?? [])].filter((x): x is string => typeof x === "string");
    const cited = items.filter((it) => it && (it.source_ids ?? []).some((id) => sources.includes(id)));
    out.set("angle.text", cited);
    out.set("angle.counterpoint", cited);
  }
  const lens = b.taiwan_lens;
  if (lens) {
    out.set("taiwan_lens.analysis", byId(lens.item_ids));
    (lens.rows ?? []).forEach((r, i) => out.set(`taiwan_lens.rows[${i}].text`, byId(r?.item_ids)));
    out.set("taiwan_lens.japan.text", byId(lens.japan?.item_ids));
  }
  return out;
}

// ── Record pages ─────────────────────────────────────────────────────────────────────────────────

/** A CVE record page (§4.12 CVE_IN_SOURCE): cve.org, nvd.nist.gov, or github.com/CVEProject. */
export function isCveRecordPage(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (host === "cve.org" || host.endsWith(".cve.org") || host === "nvd.nist.gov") return true;
  if (host !== "github.com") return false;
  try {
    return matchPath(new URL(url).pathname).startsWith("/cveproject/");
  } catch {
    return false;
  }
}

// ── What the morning knew about a CVE (draft mode) ───────────────────────────────────────────────

type DraftInput = Pick<RuleInput, "cveList" | "regionsBase" | "context" | "config">;

/** The KEV index row for a CVE in `regionsBase`, or undefined. */
function kevRow(input: Pick<RuleInput, "regionsBase">, cve: string) {
  return input.regionsBase?.kevIndex.entries.find((row) => row[0] === cve);
}

/** The context candidate that carries a CVE, or the release a patch batch cites. */
function candidateFor(input: Pick<RuleInput, "context">, cve: string) {
  return input.context?.candidates.find((c) => c.cve_ids.includes(cve));
}

/**
 * True when the morning's KEV knew the CVE (draft mode): a KEV index row in `regionsBase`, the CVE List
 * record's CISA ADP KEV marker, or a context candidate's `kev`.
 */
export function onKevDraft(input: Pick<RuleInput, "cveList" | "regionsBase" | "context">, cve: string): boolean {
  return kevRow(input, cve) !== undefined || Boolean(input.cveList?.get(cve)?.kev_date_added) || Boolean(candidateFor(input, cve)?.kev);
}

/**
 * A CVE's vendor as publish matches it (§4.11, §4.6): vendors.json by the KEV `vendorProject`, else the CVE
 * List record's `affected[].vendor` values, else the candidate's vendor; for a patch batch with none of
 * those, its release candidate's vendor. Null when nothing matches.
 */
export function vendorOfCve(input: DraftInput, item: Pick<AnyItem, "kind" | "release_id">, cve: string): Vendor | null {
  const cfg: Pick<LoadedConfig, "vendors"> = input.config;
  const rec = input.cveList?.get(cve);
  const cand = candidateFor(input, cve);
  const matched = matchVendor(cfg, { kevVendorProject: kevRow(input, cve)?.[2] ?? null, affectedVendors: [...(rec?.vendors ?? []), cand?.vendor ?? null] });
  if (matched) return matched;
  if (item.kind === "patch_batch" && item.release_id) {
    const rel = input.context?.candidates.find((c) => c.release?.release_id === item.release_id)?.release;
    if (rel) return input.config.vendors.vendors.find((v) => v.id === rel.vendor) ?? matchVendor(cfg, { affectedVendors: [rel.vendor] });
  }
  return null;
}

/** A cited GitHub-reviewed advisory page (github.com/advisories/GHSA-...), the only GHSA review draft mode can see. */
function isReviewedGhsaPage(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase() === "github.com" && /^\/advisories\/ghsa-/.test(matchPath(u.pathname));
  } catch {
    return false;
  }
}

export type VendorConfirmedBy = NonNullable<CveBlock["vendor_confirmed_by"]>;

/**
 * Draft mode's `vendor_confirmed_by` for one of an item's CVEs, computed as publish does (§4.6): the
 * assigner is in the matched vendor's `cna` list (`vendor_cna`); else a flaw_evidence entry for the CVE
 * whose source is one of the item's sources, seen in the evidence when there is any, and on one of the
 * vendor's `domains` (`vendor_advisory`); else a cited GitHub-reviewed advisory page (`ghsa_reviewed`).
 */
export function draftVendorConfirmedBy(input: DraftInput & Pick<RuleInput, "derived" | "evidence">, item: AnyItem, cve: string): VendorConfirmedBy | null {
  const vendor = vendorOfCve(input, item, cve);
  if (vendor && cnaConfirms(vendor, input.cveList?.get(cve)?.assigner)) return "vendor_cna";
  if (vendor) {
    for (const f of item.flaw_evidence ?? []) {
      if (f.cve_id !== cve || !(item.source_ids ?? []).includes(f.source_id)) continue;
      const s = input.derived.sourcesById.get(f.source_id);
      if (s && (!input.evidence || inEvidence(input, s.url)) && urlOnAnyDomain(s.url, vendor.domains)) return "vendor_advisory";
    }
  }
  for (const s of sourcesOfItem(item, input.derived)) {
    if (input.derived.publisherBySourceId.get(s.id)?.publisher === GITHUB_ADVISORIES && isReviewedGhsaPage(s.url)) return "ghsa_reviewed";
  }
  return null;
}

/** The CVE block a published item holds for a CVE id, or undefined. */
function blockOf(item: AnyItem, cve: string): CveBlock | undefined {
  return "cves" in item && Array.isArray(item.cves) ? item.cves.find((c) => c.cve_id === cve) : undefined;
}

// ── CVE_PUBLISHED ────────────────────────────────────────────────────────────────────────────────

/** Why a CVE id fails the PUBLISHED test in draft mode, or null when it passes (or there is no CVE List to read). */
function notPublished(input: Pick<RuleInput, "cveList">, cve: string): string | null {
  if (!input.cveList) return null;
  const rec = input.cveList.get(cve);
  if (!rec) return `${cve} is not in the CVE List as collect fetched it this morning (an unknown or mistyped id)`;
  if (rec.state !== "PUBLISHED") return `${cve} is ${rec.state} in the CVE List, not PUBLISHED`;
  return null;
}

const UNPUBLISHED_HINT = "Check the id against the CVE record. Cite only PUBLISHED CVEs: correct a mistyped id, else remove it and the claims that rest on it.";

/**
 * CVE_PUBLISHED †: every CVE id in a prose field, a quoted field or `cve_ids` is PUBLISHED (draft: the
 * morning's CVE List; published: the item's stored CVE block); an item's text cites only its own
 * `cve_ids`; a Lead sentence, the Angle or a Taiwan Lens block cites only CVEs of the items it cites.
 */
const cvePublished = defineRule({
  code: "CVE_PUBLISHED",
  scope: "brief",
  dataOnly: true,
  check: (input) => {
    const { draft, mode } = input;
    const out: ValidationIssue[] = [];
    const items = (draft.items ?? []) as AnyItem[];
    const published = mode === "published";

    // Each item: its cve_ids, then the ids its own text cites.
    const texts = itemTextFields(draft);
    items.forEach((it, i) => {
      if (!it) return;
      const ids = (it.cve_ids ?? []).map((c) => String(c).toUpperCase());
      (it.cve_ids ?? []).forEach((raw, k) => {
        const cve = String(raw).toUpperCase();
        if (published) {
          // §4.6: one CVE block per cve_ids entry, in the same order; readers take cves[0] as the item's own.
          const at = "cves" in it && Array.isArray(it.cves) ? it.cves[k] : undefined;
          if (at?.cve_id === cve) return;
          const elsewhere = "cves" in it && Array.isArray(it.cves) ? it.cves.findIndex((c) => c.cve_id === cve) : -1;
          out.push(error("CVE_PUBLISHED", `items[${i}].cve_ids[${k}]`,
            elsewhere >= 0
              ? `items[${i}] (${it.id}) holds the CVE block for ${cve} at cves[${elsewhere}], not at cves[${k}]: the blocks must follow cve_ids in order.`
              : `items[${i}] (${it.id}) lists ${cve} in cve_ids but holds no CVE block for it, so it was not PUBLISHED when the brief was built.`,
            "Publish builds one CVE block per cve_ids entry, in the same order; rebuild the brief, or remove the id."));
          return;
        }
        const why = notPublished(input, cve);
        if (why) out.push(error("CVE_PUBLISHED", `items[${i}].cve_ids[${k}]`, `items[${i}] (${it.id}) lists ${cve} in cve_ids, but ${why}.`, UNPUBLISHED_HINT));
      });
      if (published && "cves" in it && Array.isArray(it.cves)) {
        it.cves.slice(ids.length).forEach((c, j) => {
          out.push(error("CVE_PUBLISHED", `items[${i}].cves[${ids.length + j}]`,
            `items[${i}] (${it.id}) holds a CVE block for ${c?.cve_id ?? "an unknown id"} beyond its ${ids.length} cve_ids entr${ids.length === 1 ? "y" : "ies"}.`,
            "Publish builds one CVE block per cve_ids entry, in the same order; rebuild the brief."));
        });
      }
      for (const f of texts.get(i) ?? []) {
        for (const cve of cveIdsIn(f.text)) {
          if (ids.includes(cve)) continue; // checked above, at its cve_ids entry
          const why = published ? null : notPublished(input, cve);
          out.push(error("CVE_PUBLISHED", f.path,
            why
              ? `${f.path} cites ${cve}, which is not in items[${i}].cve_ids, and ${why}.`
              : `${f.path} cites ${cve}, which is not in items[${i}].cve_ids (${ids.length ? list(ids) : "empty"}). Add it to cve_ids if the item is about it, else remove it from the text.`,
            why ? UNPUBLISHED_HINT : null));
        }
      }
    });

    // The Lead, the Angle and the Taiwan Lens: only CVEs of the items they cite.
    const cited = citedItemsByPath(draft);
    const handled = new Set<string>();
    for (const f of proseFields(draft)) {
      const by = cited.get(f.path);
      if (!by) continue;
      handled.add(f.path);
      for (const cve of cveIdsIn(f.text)) {
        const why = published ? null : notPublished(input, cve);
        if (why) {
          out.push(error("CVE_PUBLISHED", f.path, `${f.path} cites ${cve}, but ${why}.`, UNPUBLISHED_HINT));
          continue;
        }
        if (by.some((it) => (it.cve_ids ?? []).some((c) => String(c).toUpperCase() === cve))) continue;
        const what = f.path.startsWith("angle.") ? "the items that share the Angle's sources" : "the items it cites";
        out.push(error("CVE_PUBLISHED", f.path,
          `${f.path} cites ${cve}, which is not in the cve_ids of ${what} (${by.length ? list(by.map((it) => it.id)) : "none"}). Cite the item that covers ${cve} in item_ids, or remove the id.`));
      }
    }

    // Every other prose or quoted field: PUBLISHED only. Published mode can check only ids some item froze.
    for (const f of [...proseFields(draft), ...quotedFields(draft)]) {
      if (f.item !== null || handled.has(f.path)) continue;
      for (const cve of cveIdsIn(f.text)) {
        if (published) continue; // nothing frozen to compare against; an id some item holds was checked at that item
        const why = notPublished(input, cve);
        if (why) out.push(error("CVE_PUBLISHED", f.path, `${f.path} cites ${cve}, but ${why}.`, UNPUBLISHED_HINT));
      }
    }

    // Draft mode without a CVE List: say the PUBLISHED test was skipped, as SOURCE_UNSEEN does without evidence.
    if (!published && !input.cveList
      && (items.some((it) => (it?.cve_ids ?? []).length > 0) || [...proseFields(draft), ...quotedFields(draft)].some((f) => cveIdsIn(f.text).length > 0))) {
      out.push(warning("CVE_PUBLISHED", "(cveList)", "Skipped the PUBLISHED test: no CVE List was given, so the draft's CVE ids were not checked against the CVE records.",
        "Pass the morning's CVE records (--cve-cache) and validate again."));
    }
    return out;
  },
});

// ── CVE_IN_SOURCE ────────────────────────────────────────────────────────────────────────────────

/**
 * CVE_IN_SOURCE (draft): a CVE id in an item's text must be in the URL or the seen text of one of the
 * item's sources other than CVE record pages; a warning when none of those sources has seen text.
 */
const cveInSource = defineRule({
  code: "CVE_IN_SOURCE",
  scope: "draft",
  check: (input) => {
    const { draft, derived, evidence } = input;
    const out: ValidationIssue[] = [];
    const items = (draft.items ?? []) as AnyItem[];
    const texts = itemTextFields(draft);
    let unchecked = 0;
    items.forEach((it, i) => {
      if (!it) return;
      const pages = sourcesOfItem(it, derived).filter((s) => !isCveRecordPage(s.url));
      const seen = pages.map((s) => ({ id: s.id, url: s.url, text: seenText(input, s.url) }));
      const reported = new Set<string>();
      for (const f of texts.get(i) ?? []) {
        for (const cve of cveIdsIn(f.text)) {
          if (reported.has(cve)) continue;
          reported.add(cve);
          if (seen.some((s) => holdsCveId(s.url, cve) || holdsCveId(s.text, cve))) continue;
          if (!evidence) {
            unchecked += 1;
            continue;
          }
          if (seen.every((s) => s.text === "")) {
            out.push(warning("CVE_IN_SOURCE", f.path,
              `${f.path} cites ${cve}, but none of items[${i}]'s sources other than CVE record pages (${seen.length ? list(seen.map((s) => s.id)) : "none"}) has seen text, so it could not be checked.`,
              "Cite an advisory or report that names the CVE."));
            continue;
          }
          out.push(error("CVE_IN_SOURCE", f.path,
            `${f.path} cites ${cve}, but neither the URL nor the text of any of items[${i}]'s sources other than CVE record pages (${seen.length ? list(seen.map((s) => s.id)) : "none"}) names it. A CVE record alone doesn't tie the CVE to this story.`,
            `Cite a vendor advisory or report that names ${cve}, or remove the id if the sources are about another flaw.`));
        }
      }
    });
    if (unchecked) {
      out.push(warning("CVE_IN_SOURCE", "(evidence)",
        `Skipped: no evidence file was given, so ${plural(unchecked, "CVE id")} in item text could not be checked against the sources' seen text.`,
        "Pass the run's evidence (logs/D.evidence.json, or --evidence) to check them."));
    }
    return out;
  },
});

// ── VENDOR_CONFIRMED ─────────────────────────────────────────────────────────────────────────────

/**
 * VENDOR_CONFIRMED (the confirmation source draft only): a `critical_flaw` item whose first CVE is not
 * vendor-confirmed is at `watch`. Published mode reads the stored `vendor_confirmed_by` of that CVE's
 * block (§7: the page's NOT_VENDOR_CONFIRMED chip reads the first CVE block); draft mode computes it as
 * publish does (draftVendorConfirmedBy()). An item with no CVE id has no block to confirm.
 */
const vendorConfirmed = defineRule({
  code: "VENDOR_CONFIRMED",
  scope: "brief",
  check: (input) => {
    const out: ValidationIssue[] = [];
    ((input.draft.items ?? []) as AnyItem[]).forEach((it, i) => {
      if (!it || it.kind !== "critical_flaw" || it.severity === null || it.severity === undefined || it.severity === "watch") return;
      const first = it.cve_ids?.[0] ? String(it.cve_ids[0]).toUpperCase() : null;
      let by: VendorConfirmedBy | null = null;
      let why: string;
      if (!first) {
        why = "it has no CVE id, so no CVE block can carry a vendor confirmation";
      } else if (input.mode === "published") {
        by = (blockOf(it, first) ?? ("cves" in it ? it.cves?.[0] : undefined))?.vendor_confirmed_by ?? null;
        why = `its CVE block for ${first} has vendor_confirmed_by null`;
      } else {
        by = draftVendorConfirmedBy(input, it, first);
        const vendor = vendorOfCve(input, it, first);
        const assigner = input.cveList?.get(first)?.assigner ?? null;
        why = vendor
          ? `${vendor.name} has not confirmed ${first}: the assigner ${assigner ? `"${assigner}"` : "(unknown)"} is not in its cna list, no cited flaw_evidence entry is on ${list(vendor.domains)}, and no GitHub-reviewed advisory is cited`
          : `no vendor in vendors.json matches ${first}, so nothing confirms it`;
      }
      if (by) return;
      out.push(error("VENDOR_CONFIRMED", `items[${i}].severity`,
        `items[${i}] (${it.id}) is a critical_flaw at "${it.severity}", but ${why}. An unconfirmed critical flaw is at most "watch".`,
        `Set severity to "watch" (the page labels it "not confirmed by vendor"), or add a flaw_evidence entry citing the vendor's own advisory.`));
    });
    return out;
  },
});

// ── EXPLOITED_BASIS ──────────────────────────────────────────────────────────────────────────────

const EXPLOITED_BASES: readonly string[] = ["vendor_confirmed", "cert_confirmed"];

/**
 * EXPLOITED_BASIS: an `exploited_flaw` item none of whose CVEs is on KEV (draft: the morning's KEV;
 * published: a CVE block with `kev`) needs a flaw_evidence entry of kind `exploited` with basis
 * `vendor_confirmed` or `cert_confirmed`.
 */
const exploitedBasis = defineRule({
  code: "EXPLOITED_BASIS",
  scope: "brief",
  check: (input) => {
    const out: ValidationIssue[] = [];
    ((input.draft.items ?? []) as AnyItem[]).forEach((it, i) => {
      if (!it || it.kind !== "exploited_flaw") return;
      const cves = (it.cve_ids ?? []).map((c) => String(c).toUpperCase());
      const onKev = input.mode === "published"
        ? ("cves" in it ? it.cves ?? [] : []).some((b) => b.kev !== null)
        : cves.some((c) => onKevDraft(input, c));
      if (onKev) return;
      if ((it.flaw_evidence ?? []).some((f) => f.kind === "exploited" && EXPLOITED_BASES.includes(f.basis))) return;
      const news = (it.flaw_evidence ?? []).some((f) => f.kind === "exploited" && f.basis === "news_reported");
      out.push(error("EXPLOITED_BASIS", `items[${i}].flaw_evidence`,
        `items[${i}] (${it.id}) is an exploited_flaw, but ${cves.length ? `${list(cves)} ${cves.length === 1 ? "is" : "are"} not on CISA's KEV list` : "it has no CVE id on CISA's KEV list"} and no flaw_evidence entry of kind "exploited" has basis "vendor_confirmed" or "cert_confirmed"${news ? " (news_reported is not enough)" : ""}.`,
        `Add a flaw_evidence entry citing the vendor's or a national CERT's statement that it is exploited, or make the item a critical_flaw (at most "elevated").`));
    });
    return out;
  },
});

// ── FLAW_EVIDENCE ────────────────────────────────────────────────────────────────────────────────

/**
 * True when a publisher's page can carry basis `cert_confirmed` (§4.12 FLAW_EVIDENCE): a publisher of kind
 * `cert`, or a source-tiers entry of another kind flagged `national_cert` (CISA, kind government, runs the
 * US national CERT function). Draft mode only: published mode freezes no kind.
 */
export function certConfirms(view: Pick<PublisherView, "publisher" | "kind"> | undefined, sourceTiers: Pick<SourceTiersFile, "publishers">): boolean {
  if (!view) return false;
  return view.kind === "cert" || sourceTiers.publishers.some((p) => p.id === view.publisher && p.national_cert === true);
}

const BASES_FOR_KIND: Readonly<Record<string, readonly string[]>> = {
  exploited: ["vendor_confirmed", "cert_confirmed", "news_reported"],
  patched: ["vendor_advisory"],
};

/**
 * FLAW_EVIDENCE (the source fit and evidence set draft only): an entry's `cve_id` is one of the item's
 * `cve_ids`; its basis fits its kind; its source fits its basis (vendor_*: on the matched vendor's own
 * `domains`; cert_confirmed: a national CERT, certConfirms(); news_reported: a tier 2 newsroom); its URL is in
 * `evidence.urls`. A source that is unknown or missing from `source_ids` is SOURCE_REF's.
 */
const flawEvidence = defineRule({
  code: "FLAW_EVIDENCE",
  scope: "brief",
  check: (input) => {
    const { derived, mode, evidence } = input;
    const out: ValidationIssue[] = [];
    ((input.draft.items ?? []) as AnyItem[]).forEach((it, i) => {
      if (!it) return;
      const cves = (it.cve_ids ?? []).map((c) => String(c).toUpperCase());
      (it.flaw_evidence ?? []).forEach((f, j) => {
        if (!f) return;
        const p = `items[${i}].flaw_evidence[${j}]`;
        const cve = String(f.cve_id).toUpperCase();
        if (!cves.includes(cve)) {
          out.push(error("FLAW_EVIDENCE", `${p}.cve_id`,
            `${p} is about ${cve}, which is not in items[${i}].cve_ids (${cves.length ? list(cves) : "empty"}). Use one of the item's CVE ids, or add ${cve} to cve_ids.`));
        }
        const fits = BASES_FOR_KIND[f.kind] ?? [];
        if (!fits.includes(f.basis)) {
          out.push(error("FLAW_EVIDENCE", `${p}.basis`,
            `${p} has kind "${f.kind}" with basis "${f.basis}"; kind "${f.kind}" takes only ${list(fits.map((b) => `"${b}"`))}. Fix the kind or the basis.`));
        }
        if (mode !== "draft") return;
        const s = derived.sourcesById.get(f.source_id);
        if (!s || !(it.source_ids ?? []).includes(f.source_id)) return; // SOURCE_REF's
        const view = derived.publisherBySourceId.get(f.source_id);
        let misfit: string | null = null;
        if (f.basis === "vendor_confirmed" || f.basis === "vendor_advisory") {
          const vendor = cves.includes(cve) ? vendorOfCve(input, it, cve) : undefined; // a foreign CVE fails above
          if (vendor === null) misfit = `no vendor in vendors.json matches ${cve}, so a vendor statement can't be checked; use basis "cert_confirmed" or "news_reported" if a CERT or newsroom says it`;
          else if (vendor && !urlOnAnyDomain(s.url, vendor.domains)) misfit = `basis "${f.basis}" needs a page on ${vendor.name}'s own domains (${list(vendor.domains)}), but ${f.source_id} is ${s.url}`;
        } else if (f.basis === "cert_confirmed") {
          if (!certConfirms(view, input.config.sourceTiers)) misfit = `basis "cert_confirmed" needs a national CERT's page, but ${f.source_id} is published by ${view?.publisher_name ?? "an unknown publisher"} (kind ${view?.kind ?? "unknown"})`;
        } else if (f.basis === "news_reported") {
          if (!(view?.tier === 2 && view.kind === "newsroom")) misfit = `basis "news_reported" needs a tier 2 newsroom, but ${f.source_id} is ${view ? `${view.publisher_name} (tier ${view.tier}, kind ${view.kind})` : "unknown"}`;
        }
        if (misfit) out.push(error("FLAW_EVIDENCE", `${p}.source_id`, `${p}: ${misfit}.`, "Cite the source that fits the basis, or change the basis to match the source."));
        if (evidence && !inEvidence(input, s.url)) {
          out.push(error("FLAW_EVIDENCE", `${p}.source_id`,
            `${p} cites ${f.source_id} (${s.url}), which is not in the evidence set (the pack, a page you fetched or a search result you saw). Publish can't check a statement nobody read.`,
            "Cite a page you actually read for this statement."));
        }
      });
    });
    return out;
  },
});

export const cveRules: Rule[] = [cvePublished, cveInSource, vendorConfirmed, exploitedBasis, flawEvidence];
