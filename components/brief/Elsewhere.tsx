// SPEC §7 "Brief components", Elsewhere: up to six lines, the title linking the source's URL (ExternalLink) ·
// the outlet. After the Taiwan Lens, so nothing here is counted.
import type { Source } from "@/lib/schema/common";
import type { ElsewhereLink } from "@/lib/schema/draft-brief";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { PlainText } from "@/components/ui/PlainText";

export interface ElsewhereProps {
  links: ElsewhereLink[];
  sourcesById: Record<string, Source>;
}

/** §4.4: at most six links. */
const ELSEWHERE_MAX = 6;

export function Elsewhere({ links, sourcesById }: ElsewhereProps) {
  return (
    <ul className="flex flex-col">
      {links.slice(0, ELSEWHERE_MAX).map((l, i) => {
        const source = sourcesById[l.source_id];
        const title = <PlainText text={l.title} />;
        return (
          <li key={`${l.source_id}-${i}`} className="border-b border-dotted border-line py-2 text-[14px] leading-[24px] text-soft">
            {source ? <ExternalLink href={source.url}>{title}</ExternalLink> : title}
            {source ? <span className="text-muted"> · <PlainText text={source.outlet} /></span> : null}
          </li>
        );
      })}
    </ul>
  );
}
