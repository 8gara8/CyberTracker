// The rule registry (SPEC §4.12): every rule module, one per group, in the rule table's order. The engine
// (lib/validate.ts) runs RULES in this order and filters by scope, † and metrics. A new group file gets a
// line here; a new rule inside a group needs nothing here.

import { aiRules } from "./ai";
import { computedRules } from "./computed";
import { cveRules } from "./cves";
import { groundingRules } from "./grounding";
import { idRules } from "./ids";
import { itemRules } from "./items";
import { metaRules } from "./meta";
import { namingRules } from "./naming";
import { safetyRules } from "./safety";
import { snapshotRules } from "./snapshots";
import { sourceRules } from "./sources";
import type { Rule } from "./types";
import { wordRules } from "./words";

export interface RuleGroup {
  /** The group file under lib/rules/, without ".ts". */
  group: string;
  rules: readonly Rule[];
}

export const RULE_GROUPS: readonly RuleGroup[] = [
  { group: "meta", rules: metaRules },           // Shape, dates, editions
  { group: "ids", rules: idRules },              // Ids
  { group: "items", rules: itemRules },          // Items and sections
  { group: "words", rules: wordRules },          // Words and limits
  { group: "sources", rules: sourceRules },      // Sources
  { group: "cves", rules: cveRules },            // CVEs and flaws
  { group: "grounding", rules: groundingRules }, // Grounding and numbers
  { group: "ai", rules: aiRules },               // AI role
  { group: "naming", rules: namingRules },       // Victims and attribution
  { group: "safety", rules: safetyRules },       // Dangerous material
  { group: "computed", rules: computedRules },   // Script-set fields
  { group: "snapshots", rules: snapshotRules },  // Snapshot soft gates
];

/** Every rule, in registry order. */
export const RULES: readonly Rule[] = RULE_GROUPS.flatMap((g) => g.rules);

/** Every code some registered rule reports, in registry order (the engine's own codes are not included). */
export function ruleCodes(rules: readonly Rule[] = RULES): string[] {
  return [...new Set(rules.flatMap((r) => r.codes))];
}

export { SAFETY_CODES, type SafetyCode } from "./safety";
