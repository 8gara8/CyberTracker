// STUB (SPEC §7 "Brief components", Elsewhere). Owner: brief lane. Up to six lines, title link (ExternalLink to
// the source's URL) · outlet.
import type { Source } from "@/lib/schema/common";
import type { ElsewhereLink } from "@/lib/schema/draft-brief";

export interface ElsewhereProps {
  links: ElsewhereLink[];
  sourcesById: Record<string, Source>;
}

export function Elsewhere({ links }: ElsewhereProps) {
  return <ul>{links.map((l) => <li key={l.source_id}>{l.title}</li>)}</ul>;
}
