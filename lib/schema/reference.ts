import { z } from "zod";
import { AiCreditRule, CommitSha, ConfigId, Count, CreditField, CveId, FinderFamily, IsoDate, Sha256 } from "./common";

// The reference fixtures, `fixtures/reference/*.json` (SPEC §5.9 step 5, Appendix D): the KEV join, the
// daily Flood counts and the AI-credit matches at the pinned CVE List commit, from which Appendix D is
// reproduced offline. Written only by `npm run backfill -- --fixtures`; ids, dates, counts, vendor names and
// matched tool names only (no URLs, no descriptions, no person's name).

const RefHead = { schema_version: z.literal(1), cve_list_commit: CommitSha, cutoff: IsoDate };

/** fixtures/reference/kev-cve-join.json: rows [cve_id, date_added, vendor_project, date_published (UTC date) | null]. */
export const ReferenceJoinFile = z.strictObject({
  ...RefHead,
  kev_catalog_version: z.string(),
  kev_data_commit: CommitSha,
  rows: z.array(z.tuple([CveId, IsoDate, z.string(), IsoDate.nullable()])),
});

/** fixtures/reference/flood-days.json: rows [date, n, kernel_n, unscored_n], every calendar day (§5.9's four columns). */
export const ReferenceFloodDaysFile = z.strictObject({
  ...RefHead,
  days: z.array(z.tuple([IsoDate, Count, Count, Count])),
});

/** fixtures/reference/ai-credits.json: rows [id, date_published, finder_id, family, rule, field, matched]. */
export const ReferenceAiCreditsFile = z.strictObject({
  ...RefHead,
  finders_version: Count,
  finders_sha256: Sha256,
  matches: z.array(z.tuple([z.string(), IsoDate, ConfigId, FinderFamily, AiCreditRule, CreditField, z.string().max(120)])),
});

export type ReferenceJoinFile = z.infer<typeof ReferenceJoinFile>;
export type ReferenceFloodDaysFile = z.infer<typeof ReferenceFloodDaysFile>;
export type ReferenceAiCreditsFile = z.infer<typeof ReferenceAiCreditsFile>;
