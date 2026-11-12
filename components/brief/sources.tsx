// SPEC §7 "Brief components", Sources: the siblings' sourceIndex, SourceRefs and SourceList, adapted (ink
// refs, ExternalLink titles with lang, tier line, state label). Owner: brief lane (S0 wrote a working port;
// the brief lane may restyle it but keeps these exports and props). The foot's closed
// <details id="sources"><summary>Sources (N) · M publishers</summary> is BriefView's.
import { ID_PATTERNS, type Source } from "@/lib/schema/common";
import { shortDate } from "@/lib/format";
import { TIER_INFO, WITHHELD_MARK } from "@/lib/vocab";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { PlainText } from "@/components/ui/PlainText";

/** The source id when it matches its §4.3 pattern ("s1", "s12"), for `id` and `#` hrefs; else undefined. */
export function sourceAnchor(id: string): string | undefined {
  return ID_PATTERNS.source.test(id) ? id : undefined;
}

/** Source id → its number in the brief's source list (1-based, the brief's `sources` order). */
export type SourceIndex = Record<string, number>;

export function sourceIndex(sources: readonly Pick<Source, "id">[]): SourceIndex {
  return Object.fromEntries(sources.map((s, i) => [s.id, i + 1]));
}

export interface SourceRefsProps {
  ids: readonly string[];
  index: SourceIndex;
}

/** Bracketed links to the numbered source list: [1][4], each `#src-<id>` with aria-label "Source n". */
export function SourceRefs({ ids, index }: SourceRefsProps) {
  const nums = [...new Set(ids)].filter((id) => index[id] && sourceAnchor(id)).map((id) => ({ id, n: index[id]! }));
  if (!nums.length) return null;
  return (
    <span className="whitespace-nowrap font-mono text-[10px]">
      {nums.map(({ id, n }) => (
        <a key={id} href={`#src-${id}`} className="ml-0.5 align-super text-fg no-underline hover:underline" aria-label={`Source ${n}`}>[{n}]</a>
      ))}
    </span>
  );
}

function published(at: string | null): string | null {
  return at ? shortDate(at.slice(0, 10)) : null;
}

export interface SourceListProps {
  sources: readonly Source[];
  /**
   * The ids of the sources only withheld items cite (withheldOnlySources(), §4.10). The rewrite masks only their
   * titles, and the outlet or URL of a victim's own statement names the disputed party, so each shows its number
   * and WITHHELD_MARK as plain text: no outlet, no link, no title_en, no state label.
   */
  withheld?: ReadonlySet<string>;
}

/** The numbered list: each <li id="src-<id>"> with [01], outlet, title (lang), title_en, tier line and state label. */
export function SourceList({ sources, withheld }: SourceListProps) {
  return (
    <ol>
      {sources.map((s, i) => {
        const held = withheld?.has(s.id) || s.title === WITHHELD_MARK;
        return (
          <li key={s.id} id={sourceAnchor(s.id) ? `src-${s.id}` : undefined} className="flex gap-2.5 border-b border-dotted border-line py-2 text-[13px] leading-[24px]">
            <span className="tabular shrink-0 pt-px text-[11px] text-muted">[{String(i + 1).padStart(2, "0")}]</span>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {held ? (
                <span className="text-soft">{WITHHELD_MARK}</span>
              ) : (
                <>
                  <span className="font-semibold text-fg"><PlainText text={s.outlet} /></span>{" "}
                  <ExternalLink href={s.url} lang={s.language} className="text-soft"><PlainText text={s.title} /></ExternalLink>
                  {s.title_en ? <span className="block text-soft"><PlainText text={s.title_en} /></span> : null}
                </>
              )}
              <span className="kicker mt-0.5 block normal-case tracking-[0.06em]">
                ↳ Tier {s.tier} {TIER_INFO[s.tier].label} · {s.language}
                {published(s.published_at) ? ` · ${published(s.published_at)}` : ""}
                {s.state_label && !held ? <> · <PlainText text={s.state_label} /></> : null}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
