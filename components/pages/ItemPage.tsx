// SPEC §6 Route details, `/items/[id]`: an item's dated timeline and record links. The route
// (app/items/[id]/page.tsx) decides which ids get a page (itemPageIds()); this renders one from the loaded
// content. Owner: pages lane.
//
// Title: the newest headline. PageHeader kicker "ITEM · <kind label>", then "First seen <date> · in N
// editions". If any edition holds the item withheld, only WITHHELD_HEADLINE, WITHHELD_TEXT, the
// CorrectionBanner and edition links show (no headline, summary, source or record of any copy; while a withhold
// binds the item, the banner shows its other corrections by type word and date only). Otherwise:
// - Timeline (<ol>, oldest first; same-date events in this order): each edition ("<date> · <edition word>
//   edition: <pips> <headline>", linking /brief/DATE#<id>); from the newest CVE blocks: CVE published,
//   vendor advisory, fix available, added to CISA's list and US deadline (both "(US date)"), each
//   exploitation_evidence with its basis word; a release's date with "N fixes, n exploited"; every
//   correction; each qualifying Scoreboard report entry ("SE-NNNN on SB-NN"). Dates are UTC except KEV's.
// - Records per CVE: cve.org, CISA's KEV catalog when on KEV, NVD; per GHSA id its GitHub advisory.
// - Sources of the newest edition holding the item, as SourceList.
import Link from "next/link";
import type { ReactNode } from "react";
import { CorrectionBanner } from "@/components/brief/CorrectionBanner";
import { SourceList } from "@/components/brief/sources";
import { PageHeader, Section } from "@/components/layout/chrome";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { PlainText } from "@/components/ui/PlainText";
import { SeverityPips } from "@/components/ui/SeverityPips";
import type { Content } from "@/lib/content";
import { longDate, shortDate } from "@/lib/format";
import { isWithheld } from "@/lib/items";
import { fmtInt } from "@/lib/metrics/stats";
import type { CveBlock, Item } from "@/lib/schema/item";
import type { Correction } from "@/lib/schema/misc";
import { correctionsFor, heldCorrection, heldItemIds, itemHistory, type ItemEdition } from "@/lib/site-data";
import { normalizeUrl } from "@/lib/urls";
import { EXPLOITATION_BASIS_INFO, KIND_INFO, WITHHELD_HEADLINE, WITHHELD_MARK, WITHHELD_TEXT } from "@/lib/vocab";
import { CORRECTION_WORD } from "@/components/brief/CorrectionBanner";
import { KEV_CATALOG_URL, cveRecordUrl, ghsaRecordUrl, nvdRecordUrl } from "@/lib/record-links";
import { EDITION_WORD } from "./labels";

type ItemContent = Pick<Content, "briefs" | "corrections">;

/** True when any edition holds the item withheld (§4.10: the page then shows the withheld form only). */
export function itemWithheld(history: readonly ItemEdition[]): boolean {
  return history.some((h) => isWithheld(h.item));
}

/** The page title: the newest headline, or WITHHELD_HEADLINE when any edition withholds the item; null with no edition. */
export function itemPageTitle(content: Pick<Content, "briefs">, id: string): string | null {
  const history = itemHistory(content, id);
  const newest = history.at(-1);
  if (!newest) return null;
  return itemWithheld(history) ? WITHHELD_HEADLINE : newest.item.headline;
}

/** Every correction shown for the item in any edition (correctionsFor() per edition), once each, oldest first. */
function itemCorrections(content: ItemContent, id: string, history: readonly ItemEdition[]): Correction[] {
  const byId = new Map<string, Correction>();
  for (const c of content.corrections.corrections) if (c.item_id === id) byId.set(c.id, c);
  for (const h of history) for (const c of correctionsFor(content, id, h.date)) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** "Listed by CISA" → "listed by CISA", as cveTimeline() words the basis. */
const basisWord = (basis: keyof typeof EXPLOITATION_BASIS_INFO) => {
  const w = EXPLOITATION_BASIS_INFO[basis];
  return w.charAt(0).toLowerCase() + w.slice(1);
};

const plural = (n: number, one: string, many: string) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/** One timeline line: its date, its place among same-date events, and what it says. */
interface TimelineEvent {
  date: string;
  /** The §6 order of same-date events: edition 0, CVE steps 1 to 6, release 7, correction 8, Scoreboard 9. */
  rank: number;
  key: string;
  body: ReactNode;
}

function cveEvents(cve: CveBlock): TimelineEvent[] {
  const id = cve.cve_id;
  const out: TimelineEvent[] = [{ date: cve.date_published, rank: 1, key: `${id}-published`, body: <>{id} published</> }];
  if (cve.advisory_date) out.push({ date: cve.advisory_date, rank: 2, key: `${id}-advisory`, body: <>{id}: vendor advisory</> });
  if (cve.patch) out.push({ date: cve.patch.date, rank: 3, key: `${id}-fix`, body: <>{id}: fix available</> });
  if (cve.kev) {
    out.push({ date: cve.kev.date_added, rank: 4, key: `${id}-kev`, body: <>{id} added to CISA&apos;s list (US date)</> });
    out.push({ date: cve.kev.due_date, rank: 5, key: `${id}-due`, body: <>{id}: US deadline (US date)</> });
  }
  cve.exploitation_evidence.forEach((e, i) => {
    out.push({ date: e.date, rank: 6, key: `${id}-ev-${i}`, body: <>{id} exploited ({basisWord(e.basis)})</> });
  });
  return out;
}

function timeline(content: ItemContent, id: string, history: readonly ItemEdition[], corrections: readonly Correction[], held: ReadonlySet<string>): TimelineEvent[] {
  const newest = history.at(-1)!.item;
  const events: TimelineEvent[] = history.map((h) => ({
    date: h.date,
    rank: 0,
    key: `edition-${h.date}`,
    body: (
      <>
        <Link href={`/brief/${h.date}#${id}`} aria-label={`${longDate(h.date)}, ${EDITION_WORD[h.edition]} edition`}>{EDITION_WORD[h.edition]} edition</Link>:{" "}
        <SeverityPips scale="severity" level={h.item.severity} landmark={h.item.landmark} kind={h.item.kind} />{" "}
        <PlainText text={h.item.headline} />
      </>
    ),
  }));
  for (const cve of newest.cves) events.push(...cveEvents(cve));
  if (newest.release) {
    const r = newest.release;
    events.push({ date: r.date, rank: 7, key: `release-${r.release_id}`, body: <>Release: {plural(r.fixes_n, "fix", "fixes")}, {fmtInt(r.exploited_n)} exploited</> });
  }
  for (const c of corrections) {
    events.push({
      date: c.date,
      rank: 8,
      key: `correction-${c.id}`,
      body: heldCorrection(c, held)
        ? <>{c.id} · {CORRECTION_WORD[c.type]} · {WITHHELD_MARK}</>
        : <>{c.id} · {CORRECTION_WORD[c.type]} · {c.field}: <PlainText text={c.reason} /></>,
    });
  }
  for (const h of history) {
    const brief = content.briefs.find((b) => b.date === h.date);
    if (!brief) continue;
    const cited = new Set(h.sources.map((s) => normalizeUrl(s.url)));
    for (const e of brief.scoreboard.entries) {
      if (e.origin !== "report" || e.source_url === null || !cited.has(normalizeUrl(e.source_url))) continue;
      events.push({
        date: e.date,
        rank: 9,
        key: `scoreboard-${h.date}-${e.id}`,
        body: <Link href={`/brief/${h.date}#scoreboard`}>{e.id} on {e.claim_id}</Link>,
      });
    }
  }
  return events
    .map((e, seq) => ({ e, seq }))
    .sort((a, b) => (a.e.date !== b.e.date ? (a.e.date < b.e.date ? -1 : 1) : a.e.rank - b.e.rank || a.seq - b.seq))
    .map((x) => x.e);
}

/** The editions holding the item, oldest first, each linking its card: "13 Oct 2026 · partial edition". */
function EditionLinks({ id, history }: { id: string; history: readonly ItemEdition[] }) {
  return (
    <ol className="space-y-1 text-[15px]">
      {history.map((h) => (
        <li key={h.date}>
          <Link href={`/brief/${h.date}#${id}`}>{shortDate(h.date)} · {EDITION_WORD[h.edition]} edition</Link>
        </li>
      ))}
    </ol>
  );
}

function Records({ item }: { item: Item }) {
  const blocks = new Map(item.cves.map((c) => [c.cve_id, c]));
  const cveIds = [...new Set([...item.cve_ids, ...item.cves.map((c) => c.cve_id)])];
  const ghsaIds = [...new Set(item.cves.flatMap((c) => c.ghsa_ids))];
  if (!cveIds.length && !ghsaIds.length) return <p className="text-[15px] text-soft">No CVE or GitHub advisory records.</p>;
  return (
    <ul className="space-y-1.5 text-[15px]">
      {cveIds.map((cve) => (
        <li key={cve}>
          <span className="font-mono text-[13px]">{cve}</span>:{" "}
          <ExternalLink href={cveRecordUrl(cve)}>CVE record</ExternalLink>
          {blocks.get(cve)?.kev ? <> · <ExternalLink href={KEV_CATALOG_URL}>CISA KEV catalog</ExternalLink></> : null}
          {" · "}<ExternalLink href={nvdRecordUrl(cve)}>NVD</ExternalLink>
        </li>
      ))}
      {ghsaIds.map((ghsa) => (
        <li key={ghsa}>
          <span className="font-mono text-[13px]">{ghsa}</span>: <ExternalLink href={ghsaRecordUrl(ghsa)}>GitHub advisory</ExternalLink>
        </li>
      ))}
    </ul>
  );
}

export interface ItemPageProps {
  content: ItemContent;
  id: string;
}

/** The item page's body; null when no loaded edition holds `id`. */
export function ItemPage({ content, id }: ItemPageProps) {
  const history = itemHistory(content, id);
  const newest = history.at(-1);
  if (!newest) return null;
  const n = history.length;
  const firstSeen = history.reduce((min, h) => (h.item.first_seen < min ? h.item.first_seen : min), newest.item.first_seen);
  const corrections = itemCorrections(content, id, history);
  const held = heldItemIds(content);
  const header = (title: string) => (
    <PageHeader title={title} kicker={`ITEM · ${KIND_INFO[newest.item.kind].label}`}>
      First seen {shortDate(firstSeen)} · in {plural(n, "edition", "editions")}
    </PageHeader>
  );

  if (itemWithheld(history)) {
    const since = history.map((h) => h.item.withheld?.since).filter((d): d is string => !!d).sort()[0]!;
    return (
      <>
        {header(WITHHELD_HEADLINE)}
        <p className="prose-serif">{WITHHELD_TEXT.replace("{date}", longDate(since))}</p>
        <div className="mt-4">
          <CorrectionBanner corrections={corrections} held={held} />
        </div>
        <Section id="editions" title="Editions">
          <EditionLinks id={id} history={history} />
        </Section>
      </>
    );
  }

  const events = timeline(content, id, history, corrections, held);
  return (
    <>
      {header(newest.item.headline)}
      <Section id="timeline" title="Timeline">
        <ol className="space-y-1.5 text-[15px]">
          {events.map((e) => (
            <li key={e.key} className="[overflow-wrap:anywhere]">
              <time dateTime={e.date} className="tabular text-[13px] text-muted">{shortDate(e.date)}</time> · {e.body}
            </li>
          ))}
        </ol>
      </Section>
      <Section id="records" title="Records">
        <Records item={newest.item} />
      </Section>
      <Section id="sources" title="Sources">
        {newest.sources.length ? <SourceList sources={newest.sources} /> : <p className="text-[15px] text-soft">No sources.</p>}
      </Section>
    </>
  );
}
