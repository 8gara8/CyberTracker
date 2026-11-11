// Short words the pages show that lib/vocab.ts does not hold yet (SPEC §6 Route details, §7). Owner: pages
// lane. The integration step may move them into lib/vocab.ts (the items lane's CorrectionBanner shows the
// same type words).
import type { Edition } from "@/lib/schema/common";
import type { CorrectionType } from "@/lib/schema/misc";
import type { BlockReason, FinderFamily, FinderKind } from "@/lib/vocab";

/** A correction's type word (§7 CorrectionBanner: CORRECTED, CLARIFIED, UPDATED or NAME REMOVED). */
export const CORRECTION_TYPE_WORD: Record<CorrectionType, string> = {
  correction: "CORRECTED",
  clarification: "CLARIFIED",
  update: "UPDATED",
  name_removed: "NAME REMOVED",
};

/** The edition word of an item page's timeline: "<date> · <edition word> edition". */
export const EDITION_WORD: Record<Edition, string> = {
  full: "full",
  partial: "partial",
  data_only: "data-only",
};

/** The blocked-host groups on Methodology (§6 `sources`: blocked hosts by BlockReason, as plain text). */
export const BLOCK_REASON_LABEL: Record<BlockReason, string> = {
  exploit_code: "Exploit code and code hosts",
  paste: "Paste sites and raw file hosts",
  messaging: "Messaging",
  shortener: "Link shorteners",
  redirect: "Redirect wrappers",
  archive: "Web archives",
  leak_site: "Leak sites",
  scan_query: "Scanner searches",
};

/** AI-finder families and kinds as Methodology names them (§6 `ai-finders`). */
export const FINDER_FAMILY_LABEL: Record<FinderFamily, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", other: "Other" };
export const FINDER_KIND_LABEL: Record<FinderKind, string> = { ai_system: "AI system", ai_assisted: "AI-assisted" };
