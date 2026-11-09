// computeMetrics() (SPEC §5.10): the metrics file, its inputs manifest and the updated state from the
// state files, collect's feeds and the history. Pure: scripts/metrics.ts reads everything and passes it in.
// P2 WP3 fills this stub (S0 contract).

import type { CompiledConfig, LoadedConfig } from "../config";
import type { InputsManifest, KevIndexFile, Metrics, StateFiles } from "../schema/metrics";
import type { MetricsFeeds } from "../../scripts/lib/feed-cache";

export interface MetricsInputs {
  date: string;
  generatedAt: string;
  codeCommit: string;
  reconstructed: boolean;
  /** Inside a backfill build (ruling R28): read the built state, count no days, re-join nothing, write no state. */
  frozenState: boolean;
  config: LoadedConfig;
  compiled: CompiledConfig;
  state: StateFiles;
  feeds: MetricsFeeds;
  history: {
    previous: Metrics | null;
    kevBaseline: Pick<KevIndexFile, "entries" | "catalog_version"> | null;
    dataOnlyDates: string[];
  };
}

export interface ComputeResult {
  metrics: Metrics;
  manifest: InputsManifest;
  /** The state files this run changed. */
  state: Partial<StateFiles>;
  log: string[];
  firstLine: string;
  catchUpLine: string | null;
}

export function computeMetrics(i: MetricsInputs): ComputeResult {
  throw new Error("not implemented: computeMetrics");
}
