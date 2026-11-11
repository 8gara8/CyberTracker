// The model identifiers no committed file may hold (AGENTS.md rule 11, SPEC §0.2), shared by every scan that
// guards the rule: fixture-safety, no-europe-strings, fixtures-base and PR5 in prompts.test.ts. Built from
// fragments, so this file never matches those scans (plan A20). The pinned CLI's own --help names 'fable',
// 'opus' and 'sonnet' as aliases for the latest model; the generic form catches a family not listed yet.

/** The model families, written as their aliases are. */
export const MODEL_FAMILIES: readonly string[] = [["fa", "ble"], ["op", "us"], ["son", "net"], ["hai", "ku"]].map((p) => p.join(""));

/**
 * A full model identifier: the vendor prefix and a hyphen, then a family name, or then any lower-case words and
 * a version digit (MODEL_SAMPLES shows each form). Package and service names such as the CLI's npm name or the
 * keychain item carry no digit after their words, so they do not match.
 */
export const MODEL_ID_SOURCE = `${"clau"}de-(?:${MODEL_FAMILIES.join("|")})|${"clau"}de-(?:[a-z]+-)*\\d`;

/** The two model flags. */
export const MODEL_FLAG_SOURCE = `${"-".repeat(2)}(?:fallback-)?mod${"el"}\\b`;

/** A model identifier or a model flag. */
export const modelRe = (flags = ""): RegExp => new RegExp(`${MODEL_ID_SOURCE}|${MODEL_FLAG_SOURCE}`, flags);

/** Planted samples every scan's self-test checks it still catches: one per family, the generic form and both flags. */
export const MODEL_SAMPLES: readonly string[] = [
  ...MODEL_FAMILIES.map((f) => `${"clau"}de-${f}-5-1`),
  `${"clau"}de-${["new", "family"].join("")}-6`,
  `${"clau"}de-7`,
  `${"-".repeat(2)}mod${"el"} x`,
  `${"-".repeat(2)}fallback-mod${"el"} x`,
];
