// STUB (SPEC §7 "Brief components", EpssMovers). Owner: brief lane. Data-only editions, §05: CVE, score, 7-day
// change, percentile, tabular figures.
import type { EpssMover } from "@/lib/schema/metrics";

export interface EpssMoversProps {
  movers: EpssMover[];
}

export function EpssMovers({ movers }: EpssMoversProps) {
  return <table><tbody>{movers.map((m) => <tr key={m.cve_id}><td>{m.cve_id}</td></tr>)}</tbody></table>;
}
