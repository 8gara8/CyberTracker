// Candidate ranking (SPEC §5.12, §8.3): turns the pack's records and items into at most 40 ranked
// candidates before the agent reads anything. Pure: no clock, file or network. P2 WP2 fills these stubs
// (S0 contract).

import type { CompiledConfig, LoadedConfig } from "./config";
import type { CveRecord, EpssDay, GhsaAdvisory, KevCatalog } from "./feeds/types";
import type { TimeWindow } from "./schema/common";
import type { WatchWindow, WatchWindowsFile } from "./schema/config";
import type { Candidate } from "./schema/context";
import type { CutEntry, PackItem, PackRecord, RankLogEntry } from "./schema/pack";

/** §5.12's weights: `base` (the highest that applies) plus each `bonus` that applies, once. */
export interface RankWeights {
  readonly base: {
    readonly new_kev: number; readonly release_exploited: number; readonly cert_alert: number; readonly critical_widely_deployed: number;
    readonly release: number; readonly ghsa_critical: number; readonly cert_note: number;
  };
  readonly bonus: {
    readonly kev_ransomware_known: number; readonly home_vendor: number; readonly ai_credit: number; readonly epss_crossed_99: number;
    readonly epss_rose_010: number; readonly ssvc_automatable_total: number; readonly public_exploit_reported: number; readonly watch_window: number;
  };
}

/** §5.12 verbatim. S0 stub: any read throws until WP2 writes the values. */
export const RANK_WEIGHTS: RankWeights = new Proxy({} as RankWeights, {
  get() {
    throw new Error("not implemented: RANK_WEIGHTS");
  },
});

export interface RankInput {
  date: string;
  /** The pack window. */
  window: TimeWindow;
  /** The pack window with both ends floored to the hour (ruling R37): CVE-record membership. */
  recordWindow: TimeWindow;
  pack: { items: readonly PackItem[]; records: readonly PackRecord[] };
  catalog: KevCatalog | null;
  newKevIds: readonly string[];
  /** Zip and per-id records. */
  records: readonly CveRecord[];
  epss: { e: EpssDay | null; e1: EpssDay | null; e7: EpssDay | null };
  ghsa: readonly GhsaAdvisory[];
  /** release_id of every earlier brief item (for the -DD suffix). */
  earlierReleaseIds: readonly string[];
  config: { loaded: LoadedConfig; compiled: CompiledConfig; watchWindows: readonly WatchWindow[] };
}

/** Steps 1 to 3 of §5.12: record candidates, release bundles, notes and news merged in. */
export function buildCandidates(input: RankInput): {
  candidates: Omit<Candidate, "rank" | "score" | "deep_read">[];
  merges: CutEntry[];
  bundled: CutEntry[];
} {
  throw new Error("not implemented: buildCandidates");
}

/** Steps 1 to 6 of §5.12: the kept candidates, the cuts and the ranking log. */
export function rankCandidates(input: RankInput): { kept: Candidate[]; cut: CutEntry[]; log: RankLogEntry[]; ranked: number } {
  throw new Error("not implemented: rankCandidates");
}

/** The watch-windows.json entries active on `date`. */
export function activeWatchWindows(file: WatchWindowsFile, date: string): WatchWindow[] {
  throw new Error("not implemented: activeWatchWindows");
}
