// The metrics run (SPEC §5.10, §8.4): `tsx scripts/metrics.ts --date D [--out DIR] [--recompute]` stages
// content/metrics/D.json, its inputs manifest and the updated state. P2 WP3 fills this stub and adds the
// command line (S0 contract).

export interface RunMetricsOptions {
  date: string;
  out?: string;
  recompute?: boolean;
  /** Epoch ms. */
  deadline?: number;
  reconstructed?: boolean;
  root?: string;
  stateDir?: string;
  /** Inside a backfill build (ruling R28). */
  frozenState?: boolean;
  /** The one clock read (injectable). */
  now?: Date;
}

export async function runMetrics(o: RunMetricsOptions): Promise<{ code: 0 | 1; firstLine: string; lines: string[]; wrote: string[] }> {
  throw new Error("not implemented: runMetrics");
}
