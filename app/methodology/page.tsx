// SPEC §6 Route details, `/methodology`: renders from lib/vocab.ts, config/ and the content folder (current,
// not frozen), with prose from routine/STYLE.md through the siblings' section(md, n) and
// components/Markdown.tsx. The only importer of lib/markdown.ts and components/Markdown.tsx (§7 Untrusted
// text item 1, tested). Anchors: severity, ai-roles, regions (rule rows id="rule-<id>"), gap, ai-finders,
// sources, naming, feeds, corrections.
import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Markdown } from "@/components/Markdown";
import { PageHeader, Section } from "@/components/layout/chrome";
import { CORRECTION_WORD } from "@/components/brief/CorrectionBanner";
import { BLOCK_REASON_LABEL, FINDER_FAMILY_LABEL, FINDER_KIND_LABEL } from "@/components/pages/labels";
import { FEED_DAYS, STYLE_SECTIONS, correctionsNewestFirst, feedRows, lastStatusDays, newestMetrics } from "@/components/pages/methodology-data";
import { PlainText } from "@/components/ui/PlainText";
import { loadConfig } from "@/lib/config";
import { loadContent } from "@/lib/content";
import { shortDate } from "@/lib/format";
import { parseBlocks, section } from "@/lib/markdown";
import { heldCorrection, heldItemIds } from "@/lib/site-data";
import { fmtDays, fmtInt, pct } from "@/lib/metrics/stats";
import type { Metrics } from "@/lib/schema/metrics";
import {
  AI_CONFIDENCE, AI_CONFIDENCE_INFO, AI_CREDIT_CAPTION, AI_ROLES, AI_ROLE_INFO, ANTHROPIC_LINE, ATTRIBUTION_BASIS,
  ATTRIBUTION_BASIS_INFO, BASELINE_TOOLTIP, BLOCKED_HOSTS, BLOCK_REASONS, CLAIM_TYPES, CLAIM_TYPE_INFO, FIX_SIDE_CAPTION,
  INCIDENT_STATUS, INCIDENT_STATUS_INFO, KINDS, KIND_INFO, HEAD_INFO, LANDMARK_RANK, MIN_N, REGION_INFO, REGION_LEVELS,
  REGION_LEVEL_INFO, SEVERITIES, SEVERITY_INFO, TIERS, TIER_INFO, WINDOW_LABEL, WITHHELD_MARK,
} from "@/lib/vocab";

export const metadata: Metadata = { title: "Methodology" };

/** A routine/STYLE.md section ("## N. Title"), parsed for <Markdown>; null when the outline lacks it. */
function style(n: number): { title: string; blocks: ReturnType<typeof parseBlocks> } | null {
  // turbopackIgnore: STYLE.md is read at build time, never bundled (SPEC §6).
  const md = fs.readFileSync(path.join(/*turbopackIgnore: true*/ process.cwd(), "routine", "STYLE.md"), "utf8");
  const s = section(md, n);
  return s ? { title: s.title, blocks: parseBlocks(s.body) } : null;
}

const th = "border-b border-rule py-1.5 pr-3 text-left align-bottom font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-muted";
const td = "border-b border-line py-1.5 pr-3 align-top";
const sub = "kicker mb-1 mt-5 text-fg";

/** A two-column definition list: term in bold, then its meaning. */
function Defs({ rows }: { rows: { term: ReactNode; text: ReactNode; key: string }[] }) {
  return (
    <dl className="space-y-1.5 text-[15px]">
      {rows.map((r) => (
        <div key={r.key}>
          {/* A term that holds a colon itself ("AI: unassessed", the chip's own words) takes " ·", never a second colon. */}
          <dt className="inline font-semibold">{r.term}{typeof r.term === "string" && r.term.includes(":") ? " ·" : ":"}</dt>{" "}
          <dd className="inline">{r.text}</dd>
        </div>
      ))}
    </dl>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, "-");
const words = (id: string) => id.replace(/_/g, " ");
/** "A, B and C". */
const listWords = (xs: readonly string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

function GapParameters({ metrics }: { metrics: Metrics | null }) {
  if (!metrics) return <p className="mt-3 text-[15px] text-soft">No metrics file yet.</p>;
  const p = metrics.provenance;
  const w = metrics.window;
  const ref = w?.reference ?? null;
  const rows: { key: string; term: string; text: string }[] = [];
  if (w) {
    rows.push({ key: "w26", term: "26-week window", text: `${shortDate(w.w26.from)} to ${shortDate(w.w26.to)} (UTC)` });
    rows.push({ key: "w13", term: "13-week window", text: `${shortDate(w.w13.from)} to ${shortDate(w.w13.to)} (UTC)` });
  }
  const refFigures = ref
    ? [
        ref.cohort_n >= 1 ? `${pct(ref.at_disclosure_n, ref.cohort_n)}% of ${fmtInt(ref.cohort_n)} recent flaws already exploited at disclosure` : null,
        ref.after_disclosure_median_days !== null ? `a median ${fmtDays(ref.after_disclosure_median_days)} days to CISA listing for the rest` : null,
      ].filter(Boolean).join("; ")
    : "";
  rows.push({
    key: "ref",
    term: "2023 to 2024 reference",
    text: `${shortDate(p.reference.from)} to ${shortDate(p.reference.to)}${refFigures ? `: ${refFigures}` : ""}`,
  });
  rows.push({ key: "min-n", term: "Smallest count shown", text: `${MIN_N} cases; below it a figure reads "n too small"` });
  rows.push({ key: "cutoff", term: "Data cutoff", text: `${shortDate(metrics.data_cutoff_utc)} (UTC), for the ${shortDate(metrics.date)} edition` });
  rows.push({ key: "kev", term: "KEV catalog version", text: p.kev_catalog_version });
  rows.push({ key: "cve", term: "CVE List release", text: p.cve_list_release });
  rows.push({ key: "finders", term: "AI-finder list version", text: String(metrics.ai_credited?.finders_version ?? p.config_versions.ai_finders) });
  return (
    <>
      <h3 className={sub}>Live parameters, from the newest metrics file</h3>
      <Defs rows={rows.map((r) => ({ key: r.key, term: r.term, text: <span className="tabular-nums">{r.text}</span> }))} />
    </>
  );
}

export default function MethodologyPage() {
  const content = loadContent();
  const config = loadConfig();
  const publisherName = new Map(config.sourceTiers.publishers.map((p) => [p.id, p.name]));
  const nameOf = (id: string) => publisherName.get(id) ?? id;
  const gap = style(STYLE_SECTIONS.gap);
  const sources = style(STYLE_SECTIONS.sources);
  const naming = style(STYLE_SECTIONS.naming);
  const corrections = style(STYLE_SECTIONS.corrections);
  const regions = config.regions;
  const finders = config.aiFinders;
  const statusDays = lastStatusDays(content.status);
  const rows = feedRows(content.status, config.sources);
  const log = correctionsNewestFirst(content.corrections.corrections);
  const held = heldItemIds(content);
  const loaded = new Set(content.briefs.map((b) => b.date));
  const kindsByRank = [...KINDS].sort((a, b) => KIND_INFO[a].rank - KIND_INFO[b].rank);
  const unlevelled = kindsByRank.filter((k) => KIND_INFO[k].severity === "none").map((k) => KIND_INFO[k].label);

  return (
    <>
      <PageHeader title="Methodology">
        How CyberTracker sorts, counts and sources each morning&apos;s brief. The definitions here come from the same
        vocabularies and config files the validator enforces on every edition.
      </PageHeader>

      <Section id="severity" title="Severity and kinds">
        <ul className="space-y-1.5 text-[15px]">
          {SEVERITIES.map((s) => (
            <li key={s}>
              <span className="pips" aria-hidden="true">{SEVERITY_INFO[s].pips}</span>{" "}
              <span className="font-mono text-[13px] font-semibold">{SEVERITY_INFO[s].word}</span>
              <span className="sr-only">, {SEVERITY_INFO[s].rank} of {SEVERITIES.length}</span>: {SEVERITY_INFO[s].means}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[15px]">
          <span className="font-mono text-[13px] font-semibold">LANDMARK</span>: {listWords(unlevelled)} items carry no severity. One that changes what defenders or attackers can do is marked Landmark, shows
          &quot;LANDMARK · &lt;kind&gt;&quot; and sorts as {SEVERITY_INFO[SEVERITIES.find((s) => SEVERITY_INFO[s].rank === LANDMARK_RANK)!].word.toLowerCase()}.
        </p>
        <h3 className={sub}>What clears the bar, by kind</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead><tr><th className={th}>Kind</th><th className={th}>Head</th><th className={th}>Bar</th></tr></thead>
            <tbody>
              {kindsByRank.map((k) => (
                <tr key={k}><td className={`${td} font-semibold`}>{KIND_INFO[k].label}</td><td className={td}>{HEAD_INFO[KIND_INFO[k].head].label}</td><td className={td}>{KIND_INFO[k].bar}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="ai-roles" title="AI roles">
        <Defs rows={AI_ROLES.map((r) => ({ key: r, term: AI_ROLE_INFO[r].chip ?? "None", text: AI_ROLE_INFO[r].means }))} />
        <h3 className={sub}>Confidence</h3>
        <Defs rows={AI_CONFIDENCE.map((c) => ({ key: c, term: capital(c), text: AI_CONFIDENCE_INFO[c] }))} />
        <h3 className={sub}>Claim type</h3>
        <Defs rows={CLAIM_TYPES.map((c) => ({ key: c, term: capital(c), text: CLAIM_TYPE_INFO[c] }))} />
        <p className="mt-3 text-[15px]">{ANTHROPIC_LINE}</p>
      </Section>

      <Section id="regions" title="Regions">
        <ul className="space-y-1.5 text-[15px]">
          {REGION_LEVELS.map((l) => (
            <li key={l}>
              <span className="pips" aria-hidden="true">{REGION_LEVEL_INFO[l].pips}</span>{" "}
              <span className="font-mono text-[13px] font-semibold">{REGION_LEVEL_INFO[l].word}</span>
              <span className="sr-only">, level {REGION_LEVEL_INFO[l].rank} of {REGION_LEVELS.length}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[15px]">{BASELINE_TOOLTIP} Levels come from the named rules below, never from item counts; Global shows only an item count.</p>
        <h3 className={sub}>Rules (regions.json version {regions.version}, updated {shortDate(regions.updated)})</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead><tr><th className={th}>Rule</th><th className={th}>Level</th><th className={th}>Regions</th><th className={th}>Type</th></tr></thead>
            <tbody>
              {regions.rules.map((r) => (
                <tr key={r.id} id={`rule-${r.id}`}>
                  <td className={td}><span className="font-semibold">{r.label}</span> <span className="block font-mono text-[11px] text-muted">{r.id}</span></td>
                  <td className={`${td} font-mono text-[12px]`}>{REGION_LEVEL_INFO[r.level].word}</td>
                  <td className={`${td} font-mono text-[12px]`}>{r.regions.join(" · ")}</td>
                  <td className={td}>{words(r.type)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 className={sub}>Agencies whose alerts count</h3>
        <Defs
          rows={regions.regions.map((d) => ({
            key: d.code,
            term: `${d.code} · ${REGION_INFO[d.code].label}`,
            text: (
              <>
                {d.agencies.length ? d.agencies.map(nameOf).join(", ") : "none"}
                {d.certs.length ? `; exploitation notices from ${d.certs.map(nameOf).join(", ")}` : ""}
              </>
            ),
          }))}
        />
        <p className="mt-3 text-[13px] text-muted">The rules are next reviewed by {shortDate(regions.review_due)}.</p>
      </Section>

      <Section id="gap" title={gap?.title ?? "The Gap"}>
        {gap ? <Markdown blocks={gap.blocks} /> : null}
        <GapParameters metrics={newestMetrics(content)} />
        <h3 className={sub}>Captions</h3>
        <ul className="space-y-1.5 text-[15px]">
          <li>{WINDOW_LABEL}</li>
          <li>{AI_CREDIT_CAPTION}</li>
          <li>{FIX_SIDE_CAPTION}</li>
        </ul>
      </Section>

      <Section id="ai-finders" title="AI finders">
        <p className="text-[15px]">Version {finders.version}, updated {shortDate(finders.updated)}.</p>
        <ul className="mt-2 space-y-1.5 text-[15px]">
          {finders.finders.map((f) => (
            <li key={f.id}>
              <span className="font-semibold">{f.name}</span> · {FINDER_FAMILY_LABEL[f.family]} · {FINDER_KIND_LABEL[f.kind]}
              {f.note ? <span className="block text-[13px] text-soft">{f.note}</span> : null}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[15px]">Bare lab names count only beside a tool name; only credit fields are read.</p>
      </Section>

      <Section id="sources" title={sources?.title ?? "Sources and tiers"}>
        <Defs rows={TIERS.map((t) => ({ key: String(t), term: `Tier ${t}, ${TIER_INFO[t].label}`, text: TIER_INFO[t].means }))} />
        <h3 className={sub}>Publishers by tier (source-tiers.json version {config.sourceTiers.version})</h3>
        {TIERS.map((t) => {
          const pubs = config.sourceTiers.publishers.filter((p) => p.tier === t);
          return (
            <details key={t} className="mt-2 border-t border-line pt-2">
              <summary className="min-h-10 cursor-pointer py-2 text-[15px] font-semibold">Tier {t}, {TIER_INFO[t].label}: {fmtInt(pubs.length)} publishers</summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-[14px]">
                  <thead><tr><th className={th}>Publisher</th><th className={th}>Kind</th><th className={th}>Country</th><th className={th}>Label</th></tr></thead>
                  <tbody>
                    {pubs.map((p) => (
                      <tr key={p.id}>
                        <td className={td}>{p.name}</td>
                        <td className={td}>{words(p.kind)}</td>
                        <td className={`${td} font-mono text-[12px]`}>{p.country ?? ""}</td>
                        <td className={td}>{p.state_label ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          );
        })}
        <h3 className={sub}>Never cited or linked</h3>
        <ul className="space-y-1.5 text-[15px]">
          {BLOCK_REASONS.map((r) => (
            <li key={r}>
              <span className="font-semibold">{BLOCK_REASON_LABEL[r]}:</span>{" "}
              <span className="font-mono text-[12px] [overflow-wrap:anywhere]">{BLOCKED_HOSTS.filter((b) => b.reason === r).map((b) => b.pattern).join(", ")}</span>
            </li>
          ))}
        </ul>
        {sources ? <div className="mt-4"><Markdown blocks={sources.blocks} /></div> : null}
      </Section>

      <Section id="naming" title={naming?.title ?? "Naming victims and attackers"}>
        {naming ? <Markdown blocks={naming.blocks} /> : null}
        <h3 className={sub}>Incident status</h3>
        <Defs rows={INCIDENT_STATUS.map((s) => ({ key: s, term: capital(s), text: INCIDENT_STATUS_INFO[s] }))} />
        <h3 className={sub}>Who an attribution comes from</h3>
        <ul className="space-y-1 text-[15px]">
          {ATTRIBUTION_BASIS.map((b) => <li key={b}>{ATTRIBUTION_BASIS_INFO[b]}</li>)}
        </ul>
      </Section>

      <Section id="feeds" title="Feed status">
        {statusDays.length === 0 ? (
          <p className="text-[15px] text-soft">No status files yet.</p>
        ) : (
          <>
            <p className="text-[15px]">
              Each feed in the registry, from the last feed check of each of the last {fmtInt(statusDays.length)} days with a status file
              ({shortDate(statusDays[0]!.date)} to {shortDate(statusDays.at(-1)!.date)}).
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[14px]">
                <thead><tr><th className={th}>Feed</th><th className={th}>{shortDate(statusDays.at(-1)!.date)}</th><th className={th}>Days ok</th><th className={th}>Stale since</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className={td}>{r.name}</td>
                      <td className={`${td} font-mono text-[12px] uppercase`}>{r.latest?.status ?? "not run"}</td>
                      <td className={`${td} tabular whitespace-nowrap text-[12px]`}>{fmtInt(r.okDays)} of {fmtInt(r.days)} days ok</td>
                      <td className={`${td} tabular whitespace-nowrap text-[12px]`}>{r.latest?.stale_since ? shortDate(r.latest.stale_since) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {statusDays.length < FEED_DAYS ? <p className="mt-2 text-[13px] text-muted">Fewer than {FEED_DAYS} days of status so far.</p> : null}
          </>
        )}
      </Section>

      <Section id="corrections" title={corrections?.title ?? "Corrections"}>
        {corrections ? <Markdown blocks={corrections.blocks} /> : null}
        <h3 className={sub}>Every correction, newest first</h3>
        {log.length === 0 ? (
          <p className="text-[15px] text-soft">No corrections so far. Corrections are listed here openly, never made silently.</p>
        ) : (
          <ol className="space-y-2 text-[15px]">
            {log.map((c) => (
              <li key={c.id}>
                <time dateTime={c.date} className="tabular text-[13px] text-muted">{shortDate(c.date)}</time> · {c.id} ·{" "}
                {loaded.has(c.edition_date) ? (
                  <Link href={`/brief/${c.edition_date}#${c.item_id}`}>{shortDate(c.edition_date)} · {c.item_id}</Link>
                ) : (
                  <>{shortDate(c.edition_date)} · {c.item_id}</>
                )}{" "}
                · <span className="font-mono text-[12px] font-semibold">{CORRECTION_WORD[c.type]}</span> · {heldCorrection(c, held) ? WITHHELD_MARK : <PlainText text={c.reason} />}
              </li>
            ))}
          </ol>
        )}
      </Section>
    </>
  );
}
