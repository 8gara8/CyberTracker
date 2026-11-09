// AI-credited CVE records (SPEC §5.5): matching credit strings against config/ai-finders.json, the two
// credit state files, and the metrics values that read them. Pure. matchCredit() itself stays in
// lib/config.ts (one implementation, which the config examples check also runs). P2 WP4 fills these
// stubs (S0 contract).

import type { AiCreditMatch, CompiledAiFinders, CompiledConfig, LoadedConfig } from "../config";
import type { CreditString } from "../feeds/types";
import type { AiCredit } from "../schema/item";
import type {
  AiCredited, AiCreditsFile, BaseRate, CreditCandidatesFile, DayRow, InputsManifest, KevIndexRow, Series,
} from "../schema/metrics";

export { matchCredit } from "../config";

/** The parts of the config a credit run needs: compiled regexes, the list version and the file's SHA-256. */
export interface AiFindersRun {
  compiled: CompiledAiFinders;
  version: number;
  sha256: string;
}

export function aiFindersOf(config: LoadedConfig, compiled: CompiledConfig): AiFindersRun {
  throw new Error("not implemented: aiFindersOf");
}

/** Structural, so CveFacts and CveRecord both fit. */
export interface CreditRecord {
  cve_id: string;
  state: string;
  date_published: string | null;
  credits: readonly CreditString[];
}

/** One GitHub-reviewed advisory's credits (REST logins); never built from the git export. */
export interface GhsaCreditSource {
  id: string;
  cve_ids: readonly string[];
  published: string;
  credits: readonly string[];
}

/** §5.5's matchRecord(): the first match over the sanitised credit strings, in field order. */
export function matchRecord(rec: CreditRecord, ghsa: GhsaCreditSource | null, cfg: CompiledAiFinders): (AiCreditMatch & { field: string }) | null {
  throw new Error("not implemented: matchRecord");
}

/** SHA-256 of the prefilter string's UTF-8 bytes (ruling R7). */
export function prefilterSha256(prefilter: string): string {
  throw new Error("not implemented: prefilterSha256");
}

export interface CreditState {
  candidates: CreditCandidatesFile;
  credits: AiCreditsFile;
}

/** Anthropic disclosure-ledger CVE ids and their publication dates (ruling R6). */
export interface LedgerInput {
  cveIds: readonly string[];
  published: ReadonlyMap<string, string>;
}

/** §5.9 step 2: both credit files from every PUBLISHED record with date_published ≤ cutoff. */
export function buildCredits(i: { records: Iterable<CreditRecord>; ghsa: readonly GhsaCreditSource[] }, run: AiFindersRun, cutoff: string): CreditState {
  throw new Error("not implemented: buildCredits");
}

/** A morning's update from the records read; returns the ids whose match changed. */
export function updateCredits(
  prev: CreditState,
  i: { records: Iterable<CreditRecord>; ghsa: readonly GhsaCreditSource[] },
  run: AiFindersRun,
  cutoff: string,
): { state: CreditState; changed: string[] } {
  throw new Error("not implemented: updateCredits");
}

/** "prefilter_changed" when the stored prefilter hash differs; "recompute" when the list version or hash differs; else "current". */
export function creditListStatus(state: CreditState, run: AiFindersRun): "current" | "recompute" | "prefilter_changed" {
  throw new Error("not implemented: creditListStatus");
}

/** §5.5 List changes: rematch every candidate, keep first_matched of ids still matched, then re-apply the ledger. */
export function recomputeCredits(state: CreditState, run: AiFindersRun, cutoff: string, ledger: LedgerInput): CreditState {
  throw new Error("not implemented: recomputeCredits");
}

/** Ledger-only rows (rule and field "cvd_ledger") for ledger ids with no credit match; `missing` lists ids with no known date. */
export function applyLedger(credits: AiCreditsFile, ledger: LedgerInput, run: AiFindersRun, cutoff: string): { credits: AiCreditsFile; missing: string[] } {
  throw new Error("not implemented: applyLedger");
}

/** metrics.ai_credited. */
export function aiCredited(i: { credits: AiCreditsFile; kevIndex: readonly KevIndexRow[]; cutoff: string; findersVersion: number }): AiCredited {
  throw new Error("not implemented: aiCredited");
}

/** The inputs manifest's ai_credited rows. */
export function aiManifestRows(credits: AiCreditsFile, ai: AiCredited): InputsManifest["ai_credited"] {
  throw new Error("not implemented: aiManifestRows");
}

/** metrics.base_rate. */
export function baseRate(i: { credits: AiCreditsFile; days: readonly DayRow[]; kevIndex: readonly KevIndexRow[]; cutoff: string }): BaseRate {
  throw new Error("not implemented: baseRate");
}

/** The series' AI fields for the given Mondays; every week is rewritten each run (ruling R5). */
export function aiWeekly(credits: AiCreditsFile, weeks: readonly string[]): Pick<Series, "ai_weekly" | "ai_ledger_only_weekly"> {
  throw new Error("not implemented: aiWeekly");
}

/** A CVE block's ai_credit (§4.6) from the state: the credit match, else the ledger row, with finders_version. */
export function aiCreditFor(id: string, credits: AiCreditsFile, findersVersion: number): AiCredit | null {
  throw new Error("not implemented: aiCreditFor");
}

/** The AI block's fixed notes (≤ 200 characters). `recomputed` is §5.5's sentence exactly. */
export const AI_NOTES: { recomputed(version: number): string; prefilterChanged: string } = {
  recomputed: (version) => `AI-finder list changed to v${version}; history recomputed.`,
  prefilterChanged: "AI-finder prefilter changed; counts stay at the previous list until the credits rebuild.",
};
