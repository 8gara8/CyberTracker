import { z } from "zod";
import { CORRECTION_TRIGGERS, CORRECTION_TYPES } from "../vocab";
import {
  Count, CorrectionId, DisputeId, DisputeKind, Edition, IsoDate, IsoTimestamp, SeenAs, Sha256, words,
} from "./common";

// Corrections, disputes and the archive index (SPEC §4.10), written only by publish; and the run's
// evidence file (§4.12), which stays on Kobol and in fixtures/evidence/.

export const CorrectionType = z.enum(CORRECTION_TYPES);
export const CorrectionTrigger = z.enum(CORRECTION_TRIGGERS);

export const Correction = z.strictObject({
  id: CorrectionId,
  date: IsoDate.describe('The edition that lists it (the "Corrected" banner date)'),
  item_id: z.string().min(1),
  edition_date: IsoDate.describe("The archived brief that holds the item"),
  type: CorrectionType,
  field: z.string().min(1).max(60).describe("Dotted path inside the item"),
  before: z.string().max(300).describe('Copied by publish; "[name removed]" for name_removed'),
  after: z.string().max(300),
  reason: words("At most 40 words"),
  source_url: z.string().min(1).nullable(),
  trigger: CorrectionTrigger,
  dispute_id: DisputeId.nullable(),
});

/** From this repo's correction issue form (§8.9); free text is never read or stored. */
export const Dispute = z.strictObject({
  id: DisputeId,
  received: IsoTimestamp,
  issue_number: z.int().min(1),
  item_id: z.string().min(1),
  edition_date: IsoDate.nullable(),
  kind: DisputeKind,
  evidence_url: z.string().min(1).max(500).nullable(),
  status: z.enum(["open", "upheld", "rejected", "withdrawn"]),
  resolved_on: IsoDate.nullable(),
  correction_id: CorrectionId.nullable(),
});

/** content/corrections.json. */
export const CorrectionsFile = z.strictObject({
  schema_version: z.literal(1),
  corrections: z.array(Correction),
  disputes: z.array(Dispute),
});

export const ArchiveEdition = z.strictObject({
  date: IsoDate,
  edition: Edition,
  published_at: IsoTimestamp,
  item_count: Count,
  corrected: z.boolean(),
});

export const ArchiveUrl = z.strictObject({
  first_cited: IsoDate,
  item_ids: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}\/[a-z0-9][a-z0-9-]*$/, { error: 'Expected "YYYY-MM-DD/<item id>"' })).max(20)
    .describe("At most 20, newest last"),
  sha256: Sha256.nullable().describe("Of the page text when first cited; the snapshot stays in cache/"),
  hashed_at: IsoTimestamp.nullable(),
  last_check: z.strictObject({
    date: IsoDate,
    result: z.enum(["ok", "broken", "changed", "unknown"]),
    http: z.int().nullable(),
  }).nullable(),
});

/** content/archive-index.json. */
export const ArchiveIndex = z.strictObject({
  schema_version: z.literal(1),
  editions: z.array(ArchiveEdition).describe("Newest first; drives the Archive page"),
  urls: z.record(z.string().min(1), ArchiveUrl).describe("Key: normalizeUrl() of every URL any brief cites"),
});

/** logs/D.evidence.json and fixtures/evidence/<name>.json (§4.12, §8.12); never committed to content/. */
export const Evidence = z.strictObject({
  urls: z.array(z.string()),
  fetched: z.array(z.string()),
  texts: z.record(z.string(), z.string()),
  seen_as: z.record(z.string(), SeenAs),
});

export type CorrectionType = z.infer<typeof CorrectionType>;
export type CorrectionTrigger = z.infer<typeof CorrectionTrigger>;
export type Correction = z.infer<typeof Correction>;
export type Dispute = z.infer<typeof Dispute>;
export type CorrectionsFile = z.infer<typeof CorrectionsFile>;
export type ArchiveEdition = z.infer<typeof ArchiveEdition>;
export type ArchiveUrl = z.infer<typeof ArchiveUrl>;
export type ArchiveIndex = z.infer<typeof ArchiveIndex>;
export type Evidence = z.infer<typeof Evidence>;
