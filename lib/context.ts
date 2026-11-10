// The agent's context (SPEC §4.15, §8.5): built in memory for each attempt from the pack, the candidates,
// the metrics, the config and the stored briefs. The validator uses only this in-memory copy, never the
// file the agent can write. Pure: every input is passed in. Owner: lane L4. Step S0 wrote the exports; L4
// replaces the stub body.

import type { LoadedConfig } from "./config";
import type { RegionsBase } from "./rules/types";
import type { Brief } from "./schema/brief";
import type { AgentContext } from "./schema/context";
import type { Metrics } from "./schema/metrics";
import type { CorrectionsFile } from "./schema/misc";
import type { CandidatesFile, Pack } from "./schema/pack";
import type { ScoreboardFile } from "./schema/scoreboard";

/** The context's size limit (§8.5): past it, after every trim, buildContext() throws ContextTooLarge. */
export const CONTEXT_MAX_BYTES = 250 * 1024;
/** No line of the printed context is longer (§8.5). */
export const CONTEXT_LINE_MAX = 1000;

/** The context is still over CONTEXT_MAX_BYTES after every trim (§8.5): E_INTERNAL for that attempt. */
export class ContextTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`The agent context is ${bytes} bytes after trimming, over the ${CONTEXT_MAX_BYTES}-byte limit.`);
    this.name = "ContextTooLarge";
  }
}

export interface ContextInput {
  date: string;
  /** Epoch ms on the run's clock. */
  now: number;
  /** Epoch ms → AgentContext.deadline (+08:00). */
  deadline: number;
  pack: Pack;
  /** packs/D.candidates.json */
  candidates: CandidatesFile;
  metrics: Metrics;
  config: LoadedConfig;
  /** readHistory(content, D, 14) */
  history: readonly Brief[];
  corrections: CorrectionsFile | null;
  scoreboard: ScoreboardFile | null;
  /** regions_preview = regionsPreviewRows(previewRegions(regionsBase)) */
  regionsBase: RegionsBase;
  recheck: { flagged: AgentContext["corrections"]["flagged"]; reports: AgentContext["corrections"]["reports"] } | null;
  /**
   * standingLast(content, D) (lib/run-inputs.ts): each tagged story's newest date and item over every
   * stored brief; a story absent here gets its seed_last_development and a null last_item_id (plan A15).
   */
  standingLast: Readonly<Record<string, { date: string; item_id: string }>>;
}

export interface BuiltContext {
  /** AgentContext.parse()d */
  context: AgentContext;
  /** printJson() from lib/json-schema.ts plus "\n"; every line ≤ 1,000 characters. */
  text: string;
  /** The CONTEXT_TRIMMED <what> entries, in order. */
  trimmed: string[];
}

export function buildContext(i: ContextInput, log?: (line: string) => void): BuiltContext {
  throw new Error("P3 stub: buildContext (lane L4)");
}
