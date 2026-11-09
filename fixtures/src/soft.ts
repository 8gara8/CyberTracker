// S fixtures (SPEC §4.12 "Fixtures and tests"): fixtures/drafts/soft--<CODE>.json, one per SNAP_* code, each
// a single mutation of the weekday draft that validates against the weekday inputs with no error and exactly
// that warning. Three cite text the weekday evidence's snapshot texts don't hold (a number, a name, a quote);
// SNAP_MISSING cites a page the evidence lists with no seen text (EVIDENCE_EXTRAS, fixtures/src/inputs.ts).
// tests/rules-naming-safety-computed.test.ts applies dropUnverified() to each and checks what goes.

import type { DraftBrief } from "../../lib/schema/draft-brief";
import { validateDraft } from "../../lib/validate";
import { DraftBrief as DraftBriefSchema } from "../../lib/schema/draft-brief";
import type { Output } from "./build";
import { WEEKDAY_ITEMS, editionDraft } from "./drafts";
import { EVIDENCE_EXTRAS, draftInputs } from "./inputs";

const I = WEEKDAY_ITEMS;

/** One S fixture: a mutation of the weekday draft giving no error and only warnings with `code`. */
export interface SoftCase {
  code: "SNAP_NUMBER" | "SNAP_NAME" | "SNAP_QUOTE" | "SNAP_MISSING";
  /** "soft--<CODE>.json", written to fixtures/drafts/. */
  file: string;
  /** The issue path the warning carries. */
  path: (d: DraftBrief) => string;
  mutate: (d: DraftBrief) => void;
}

function at(d: DraftBrief, id: string): number {
  const i = d.items.findIndex((it) => it.id === id);
  if (i < 0) throw new Error(`The weekday draft has no item ${id}`);
  return i;
}

/** The weekday's page cited with no seen text (EVIDENCE_EXTRAS: a PDF, which gets no snapshot). */
export const NO_TEXT_URL = EVIDENCE_EXTRAS.weekday.find((x) => x.text === null)!.url;

export const SOFT_CASES: readonly SoftCase[] = [
  {
    // The AISLE headline says 27 flaws; Red Hat's record and The Register say 24.
    code: "SNAP_NUMBER", file: "soft--SNAP_NUMBER.json",
    path: (d) => `items[${at(d, I.aiConfirmed)}].headline`,
    mutate: (d) => {
      d.items[at(d, I.aiConfirmed)]!.headline = "Red Hat credits AISLE's AI system with 27 Linux flaws so far this month";
    },
  },
  {
    // The Edimax row names Zyxel (a vendors.json name) where neither the record nor iThome does.
    code: "SNAP_NAME", file: "soft--SNAP_NAME.json",
    path: (d) => `items[${at(d, I.taiwanVendor)}].summary`,
    mutate: (d) => {
      const it = d.items[at(d, I.taiwanVendor)]!;
      it.summary = it.summary.replace("VulDB says Edimax never responded", "VulDB says Zyxel never responded");
    },
  },
  {
    // The China-axis AI evidence paraphrases Focus Taiwan ("written", not "drafted").
    code: "SNAP_QUOTE", file: "soft--SNAP_QUOTE.json",
    path: (d) => `items[${at(d, I.chinaAxis)}].ai_evidence[0].quote`,
    mutate: (d) => {
      d.items[at(d, I.chinaAxis)]!.ai_evidence[0]!.quote = "the phishing emails were written with a generative AI model";
    },
  },
  {
    // The claimed-victim row's only source moved to a PDF copy on the same host, which has no snapshot.
    code: "SNAP_MISSING", file: "soft--SNAP_MISSING.json",
    path: (d) => `items[${at(d, I.claimedVictim)}].source_ids`,
    mutate: (d) => {
      const it = d.items[at(d, I.claimedVictim)]!;
      const s = d.sources.find((x) => x.id === it.source_ids[0])!;
      s.url = NO_TEXT_URL;
    },
  },
];

/** The draft a soft case produces: a fresh weekday draft, mutated. */
export function softDraft(c: SoftCase): DraftBrief {
  const d = editionDraft("weekday");
  c.mutate(d);
  return d;
}

export const softDraftPath = (file: string) => `fixtures/drafts/${file}`;

export function softOutputs(): Output[] {
  return SOFT_CASES.map((c) => ({ path: softDraftPath(c.file), text: `${JSON.stringify(DraftBriefSchema.parse(softDraft(c)), null, 2)}\n` }));
}

/** Every soft case that doesn't give exactly its own warning (and no error), as "soft--X.json: ...". */
export function softDraftProblems(): string[] {
  const out: string[] = [];
  for (const c of SOFT_CASES) {
    const d = softDraft(c);
    const r = validateDraft(d, draftInputs("weekday"));
    if (!r.warnings.some((w) => w.code === c.code && w.path === c.path(d))) out.push(`${c.file}: no ${c.code} warning at ${c.path(d)}`);
    for (const i of [...r.errors, ...r.warnings.filter((w) => w.code !== c.code)]) {
      out.push(`${c.file}: unexpected ${i.severity.toUpperCase()} ${i.code} ${i.path}: ${i.message}`);
    }
  }
  return out;
}
