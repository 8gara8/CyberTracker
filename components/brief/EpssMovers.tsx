// SPEC §7 "Brief components", EpssMovers: data-only editions, §05. CVE, score, 7-day change and percentile,
// in tabular figures. Labels and numbers only; not counted.
import type { EpssMover } from "@/lib/schema/metrics";
import { fmt2, fmtPct } from "@/lib/metrics/stats";
import { cveRecordUrl } from "@/lib/record-links";
import { ExternalLink } from "@/components/ui/ExternalLink";

export interface EpssMoversProps {
  movers: EpssMover[];
}


/** A signed two-decimal change: "+0.12", "-0.05", "+0.00". */
const signed2 = (x: number) => (fmt2(x).startsWith("-") ? fmt2(x) : `+${fmt2(x)}`);

const TH = "border-b border-rule py-1.5 pr-3 text-left font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-muted";
const TD = "border-b border-dotted border-line py-1.5 pr-3 font-mono text-[12px] tabular-nums";

export function EpssMovers({ movers }: EpssMoversProps) {
  if (!movers.length) return null;
  return (
    <div className="mt-6">
      <h3 className="kicker mb-2">EPSS movers</h3>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-soft">
          <caption className="sr-only">Exploit prediction (EPSS) scores that moved most in 7 days</caption>
          <thead>
            <tr>
              <th scope="col" className={TH}>CVE</th>
              <th scope="col" className={`${TH} text-right`}>Score</th>
              <th scope="col" className={`${TH} text-right`}>7-day change</th>
              <th scope="col" className={`${TH} text-right`}>Percentile</th>
            </tr>
          </thead>
          <tbody>
            {movers.map((m) => (
              <tr key={m.cve_id}>
                <td className={TD}><ExternalLink href={cveRecordUrl(m.cve_id)}>{m.cve_id}</ExternalLink></td>
                <td className={`${TD} text-right`}>{fmt2(m.score)}</td>
                <td className={`${TD} text-right`}>{signed2(m.delta_7d)}</td>
                <td className={`${TD} text-right`}>{fmtPct(m.percentile)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
