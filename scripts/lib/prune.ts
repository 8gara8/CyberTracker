// Pruning at the run's finish (SPEC §9.8): logs, drafts, packs and dry-run copies older than 60 days by the
// date in the name; logs/dry-run/tree/, needs-review/ and anything newer are kept. Owner: lane L6. Step S0
// wrote the exports; L6 replaces the stub body.

export const KEEP_DAYS = 60;

export function pruneRunFiles(root: string, today: string, keepDays?: number): { removed: number } {
  throw new Error("P3 stub: pruneRunFiles (lane L6)");
}
