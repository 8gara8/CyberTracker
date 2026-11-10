// The validate loop of SPEC §8.2 stage 7 and §4.12 step 3 (the soft pass), as a state machine with its
// I/O injected (plan §2.5 "Loop semantics", amendments A7 and A8). Owner: lane L4. Step S0 wrote the
// exports; L4 replaces the stub bodies.

import type { DropReport, GatedDraft } from "../../lib/apply";
import type { CveLookup } from "../../lib/rules/types";
import { DraftAngle, DraftBrief } from "../../lib/schema/draft-brief";
import type { Evidence } from "../../lib/schema/misc";
import type { DraftInputs, ValidationIssue, ValidationResult } from "../../lib/validate";

/** A gated draft's schema: DraftBrief with a nullable Angle, so a dropped Angle is no SCHEMA error (plan A7). DraftBrief has no refinement. */
export const GatedDraftSchema = DraftBrief.extend({ angle: DraftAngle.nullable() });

/** validateDraft()'s steps with GatedDraftSchema: schemaIssues(), runRules(..., schema), toResult(), all exported by lib/validate.ts (plan A7). */
export function validateGated(g: GatedDraft, inputs: DraftInputs): ValidationResult {
  throw new Error("P3 stub: validateGated (lane L4)");
}

export interface ValidateLoopIo {
  /** drafts/D.json */
  readDraft(): { ok: true; value: unknown } | { ok: false; error: string };
  /** After a drop, before round 2 (G13). */
  writeDraft(d: GatedDraft): void;
  fetchCves(ids: readonly string[]): Promise<void>;
  /** One round; the loop never calls it past the round limit. */
  snapshot(urls: readonly string[]): Promise<void>;
  /** Rebuilt from every transcript of the run and this run's snapshots. */
  evidence(): Evidence;
  /** A fresh CVE lookup over cache/cvelist/records, called after each fetchCves() (plan A8). */
  cveList(): CveLookup;
  /** REPAIR.md, --resume, logs/D.agent-N-repair-K.jsonl */
  repair(round: number, issues: readonly ValidationIssue[]): Promise<void>;
  repairBudgetMs(): number;
  /** "Attempt N: E errors, W warnings (S snapshot)." and the repair line of §8.2 (LINES in scripts/lib/run-lines.ts). */
  log(line: string): void;
  /** logs/D.validation.json */
  writeValidation(r: ValidationResult): void;
  /** logs/D.dropped.json */
  writeDropped(r: DropReport): void;
}

/** Shared across attempts. */
export interface ValidateLoopState {
  repairsUsed: number;
  maxRepairs: number;
}

export interface ValidateOutcome {
  /** No hard error left. */
  ok: boolean;
  /** What publishFull gets when ok. */
  draft: GatedDraft | null;
  /** The last validation. */
  result: ValidationResult;
  /** The last errors and warnings (for needs-review and the chat). */
  issues: ValidationIssue[];
  /** This attempt's rounds. */
  repairs: number;
  softGates: { checked: number; dropped: number; by_code: Record<string, number> };
  drops: DropReport | null;
}

/** §2.5's loop: check, round 1, the first drop, round 2, the result. The CVE lookup comes from io.cveList() (plan A8). */
export function validateLoop(
  attempt: number,
  inputs: Omit<DraftInputs, "evidence" | "cveList">,
  io: ValidateLoopIo,
  state: ValidateLoopState,
): Promise<ValidateOutcome> {
  throw new Error("P3 stub: validateLoop (lane L4)");
}
