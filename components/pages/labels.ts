// Short words the pages show that lib/vocab.ts does not hold (SPEC §6 Route details, §7). A correction's type
// word is CORRECTION_WORD (components/brief/CorrectionBanner.tsx), shared by the brief and the pages.
import type { Edition } from "@/lib/schema/common";
import type { BlockReason, FinderFamily, FinderKind } from "@/lib/vocab";

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
