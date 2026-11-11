// SPEC §7 "Brief components", ItemDetails: a <dl> of every §4.6 field the item has, each dated and linked. Per
// CVE block: id and title; vendor (country) and product; CVSS with its scorer; EPSS with percentile and date;
// CISA SSVC; KEV added and due dates (US dates) and ransomware use; credits; AI credit; discovery credit; vendor
// confirmation; fix; exploitation evidence with basis words; GHSA ids. Then the release block, the AI role with
// its evidence, the attributions, the incident, exposure, topics, the standing story and when it was first seen.
// Every URL goes through ExternalLink; the CVE and GHSA pages are built from the stored, validated ids. The
// exposure text is counted here (§4.12 word table) unless the item is withheld; nothing else here is.
import type { ReactNode } from "react";
import { Fragment } from "react";
import type { Source } from "@/lib/schema/common";
import type { CveBlock, Item, ReleaseBlock } from "@/lib/schema/item";
import { shortDate } from "@/lib/format";
import { fmt1, fmt2, fmtInt, fmtPct } from "@/lib/metrics/stats";
import { cveRecordUrl, ghsaRecordUrl } from "@/lib/record-links";
import {
  ACTOR_NEXUS_INFO, AI_CONFIDENCE_INFO, AI_ROLE_INFO, ATTRIBUTION_BASIS_INFO, CLAIM_TYPE_INFO, DISCOVERY_CREDIT_INFO,
  EXPLOITATION_BASIS_INFO, INCIDENT_STATUS_INFO, KIND_INFO, NOT_VENDOR_CONFIRMED, SECTORS, TOPIC_INFO,
} from "@/lib/vocab";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { PlainText } from "@/components/ui/PlainText";
import { Tag } from "@/components/ui/Tag";
import { upperWord } from "./brief-parts";
import { Text } from "./item-parts";
import { SourceRefs, type SourceIndex } from "./sources";

export interface ItemDetailsProps {
  item: Item;
  editionDate: string;
  index: SourceIndex;
  sourcesById: Record<string, Source>;
}


const SCORER: Record<NonNullable<CveBlock["cvss"]>["scorer"], (assigner: string) => string> = {
  cna: (assigner) => `the CNA (${assigner})`,
  cisa_adp: () => "CISA",
  nvd: () => "NVD",
};

const CONFIRMED_BY: Record<NonNullable<CveBlock["vendor_confirmed_by"]>, string> = {
  vendor_cna: "the vendor's own CNA",
  vendor_advisory: "the vendor's own advisory",
  ghsa_reviewed: "a GitHub-reviewed advisory",
};

const PATCH_BASIS: Record<NonNullable<CveBlock["patch"]>["basis"], string> = {
  vendor_advisory: "the vendor's advisory",
  ghsa_fixed_version: "a GitHub-reviewed advisory's fixed version",
};

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** One row of the list. */
function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted sm:pt-[3px]">{term}</dt>
      <dd className="min-w-0 pb-1.5 text-[13px] leading-[24px] text-soft [overflow-wrap:anywhere] sm:pb-[3px]">{children}</dd>
    </>
  );
}

/** Items joined with " · ". */
function Dotted({ children }: { children: ReactNode[] }) {
  const parts = children.filter((c) => c !== null && c !== false && c !== undefined);
  return <>{parts.map((c, i) => <Fragment key={i}>{i ? " · " : ""}{c}</Fragment>)}</>;
}

function CveRows({ cve }: { cve: CveBlock }) {
  const v = cve.vendor;
  return (
    <>
      <Row term="CVE">
        <ExternalLink href={cveRecordUrl(cve.cve_id)} className="font-mono">{cve.cve_id}</ExternalLink>
        {" · "}<PlainText text={cve.title} />
        {" · "}published {shortDate(cve.date_published)}, updated {shortDate(cve.date_updated)}
      </Row>
      <Row term="Vendor and product">
        <PlainText text={v.country ? `${v.name} (${v.country})` : v.name} />
        {cve.product ? <>{" · "}<PlainText text={cve.product} /></> : null}
      </Row>
      <Row term="CVSS">
        {cve.cvss ? (
          <>
            {fmt1(cve.cvss.score)} (CVSS {cve.cvss.version}, scored by <PlainText text={SCORER[cve.cvss.scorer](cve.assigner)} />)
            {" · "}<span className="font-mono text-[12px]"><PlainText text={cve.cvss.vector} /></span>
          </>
        ) : "No score from the CNA, CISA or NVD"}
      </Row>
      {cve.epss ? (
        <Row term="EPSS">{fmt2(cve.epss.score)}, percentile {fmtPct(cve.epss.percentile)}, {shortDate(cve.epss.date)}</Row>
      ) : null}
      {cve.ssvc ? (
        <Row term="CISA SSVC">
          exploitation {cve.ssvc.exploitation} · automatable {cve.ssvc.automatable} · technical impact {cve.ssvc.technical_impact}, {shortDate(cve.ssvc.date)}
        </Row>
      ) : null}
      <Row term="CISA's list (KEV)">
        {cve.kev ? (
          <>added {shortDate(cve.kev.date_added)} (US date) · due {shortDate(cve.kev.due_date)} (US date) · ransomware use: {cve.kev.ransomware} · catalog <PlainText text={cve.kev.catalog_version} /></>
        ) : "not on CISA's list"}
      </Row>
      {cve.credits.length ? (
        <Row term="Credits"><Dotted>{cve.credits.map((c, i) => <PlainText key={i} text={c} />)}</Dotted></Row>
      ) : null}
      {cve.ai_credit ? (
        <Row term="AI credit">
          <PlainText text={`${cve.ai_credit.finder_id} (${cve.ai_credit.family}), matched '${cve.ai_credit.matched}'`} />
        </Row>
      ) : null}
      <Row term="Discovery credit"><span title={DISCOVERY_CREDIT_INFO[cve.discovery_credit]}>{upperWord(cve.discovery_credit).toLowerCase()}</span></Row>
      <Row term="Vendor confirmation">{cve.vendor_confirmed_by ? `confirmed by ${CONFIRMED_BY[cve.vendor_confirmed_by]}` : NOT_VENDOR_CONFIRMED}</Row>
      <Row term="Fix">
        {cve.patch ? (
          <>
            {shortDate(cve.patch.date)}, from {PATCH_BASIS[cve.patch.basis]}{" · "}
            <ExternalLink href={cve.patch.source_url}>source</ExternalLink>
          </>
        ) : "none cited"}
        {cve.advisory_date ? <>{" · "}advisory {shortDate(cve.advisory_date)}</> : null}
      </Row>
      {cve.exploitation_evidence.length ? (
        <Row term="Exploitation evidence">
          <Dotted>
            {cve.exploitation_evidence.map((e, i) => (
              <ExternalLink key={i} href={e.source_url}>{EXPLOITATION_BASIS_INFO[e.basis]} {shortDate(e.date)}{e.basis === "kev_listed" ? " (US date)" : ""}</ExternalLink>
            ))}
          </Dotted>
        </Row>
      ) : null}
      {cve.ghsa_ids.length ? (
        <Row term="GitHub advisories">
          <Dotted>{cve.ghsa_ids.map((g) => <ExternalLink key={g} href={ghsaRecordUrl(g)} className="font-mono">{g}</ExternalLink>)}</Dotted>
        </Row>
      ) : null}
    </>
  );
}

function ReleaseRows({ release: r }: { release: ReleaseBlock }) {
  return (
    <>
      <Row term="Release">
        <ExternalLink href={r.source_url}><PlainText text={r.title} /></ExternalLink>
        {" · "}<PlainText text={r.vendor.country ? `${r.vendor.name} (${r.vendor.country})` : r.vendor.name} />
        {" · "}released {shortDate(r.date)}
      </Row>
      <Row term="Fixes">
        {fmtInt(r.fixes_n)} {r.fixes_n === 1 ? "fix" : "fixes"} · {fmtInt(r.exploited_n)} exploited
        {r.exploited_cve_ids.length ? <> (<span className="font-mono">{r.exploited_cve_ids.join(", ")}</span>)</> : null}
        {" · "}{r.critical_n === null ? "no vendor severity rating" : `${fmtInt(r.critical_n)} critical`}
        {" · "}counted from {r.counted_from === "cve_list" ? "CVE List records" : "the vendor's release API"}
      </Row>
    </>
  );
}

export function ItemDetails({ item, index }: ItemDetailsProps) {
  const counted = !item.withheld;
  const role = AI_ROLE_INFO[item.ai_role];
  return (
    <dl className="mt-3 grid grid-cols-1 gap-x-4 border-t border-dotted border-line pt-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <Row term="Kind">
        {KIND_INFO[item.kind].label}
        {item.landmark ? " · landmark" : ""}
        {" · "}first seen {shortDate(item.first_seen)}
      </Row>
      {item.cves.map((cve) => <CveRows key={cve.cve_id} cve={cve} />)}
      {item.release ? <ReleaseRows release={item.release} /> : null}
      <Row term="AI role">
        {role.chip ?? "none"}
        {item.ai_confidence ? <>{" · "}<span title={AI_CONFIDENCE_INFO[item.ai_confidence]}>{item.ai_confidence}</span></> : null}
        {item.ai_claimant ? <>{" · "}claimed by <PlainText text={item.ai_claimant} /></> : null}
        {" · "}claim type: <span title={CLAIM_TYPE_INFO[item.claim_type]}>{item.claim_type.replace(/_/g, "-")}</span>
      </Row>
      {item.ai_evidence.length ? (
        <Row term="AI evidence">
          <ul className="flex flex-col gap-1">
            {item.ai_evidence.map((e, i) => (
              <li key={i}>
                “<PlainText text={e.quote} />” <SourceRefs ids={[e.source_id]} index={index} />
                {e.from_claimant ? " (from the claimant)" : ""}
              </li>
            ))}
          </ul>
        </Row>
      ) : null}
      {item.attribution.length ? (
        <Row term="Attribution">
          <ul className="flex flex-col gap-1">
            {item.attribution.map((a, i) => (
              <li key={i}>
                <PlainText text={a.attributed_by} /> ({lowerFirst(ATTRIBUTION_BASIS_INFO[a.basis])}) names <PlainText text={a.actor_name_as_used} />;
                sponsor stated: <PlainText text={a.sponsor_claimed ?? "none"} />
                {a.confidence_text ? <>; their words: &apos;<PlainText text={a.confidence_text} />&apos;</> : null}
                {" "}({shortDate(a.date)}) <SourceRefs ids={[a.source_id]} index={index} />
              </li>
            ))}
          </ul>
          {item.actor_nexus ? <p className="mt-1">Actor nexus: {ACTOR_NEXUS_INFO[item.actor_nexus]}</p> : null}
        </Row>
      ) : null}
      {item.incident ? (
        <Row term="Incident">
          <PlainText text={item.incident.victim ?? item.incident.description} />
          {" · "}sector: {SECTORS.includes(item.incident.sector) ? item.incident.sector : "other"}
          {item.incident.country ? <>{" · "}{item.incident.country}</> : null}
          {" · "}<span title={INCIDENT_STATUS_INFO[item.incident.status]}>{item.incident.status}</span>
          {item.incident.claimed_by ? <>{" "}by <PlainText text={item.incident.claimed_by} /></> : null}
          {" · "}{item.incident.disruption ? "services disrupted" : "no disruption reported"}
          {" "}<SourceRefs ids={item.incident.status_source_ids} index={index} />
        </Row>
      ) : null}
      {item.exposure ? (
        <Row term="Exposure">
          <Text text={item.exposure.text} counted={counted} /> <SourceRefs ids={[item.exposure.source_id]} index={index} />
        </Row>
      ) : null}
      {item.topics.length ? (
        <Row term="Topics">
          <span className="flex flex-wrap gap-1.5">{item.topics.map((t) => <Tag key={t}>{TOPIC_INFO[t].label}</Tag>)}</span>
        </Row>
      ) : null}
      {item.standing_story ? <Row term="Standing story"><PlainText text={item.standing_story} /></Row> : null}
      {item.withheld ? (
        <Row term="Withheld">since {shortDate(item.withheld.since)} ({item.withheld.correction_id})</Row>
      ) : null}
    </dl>
  );
}
