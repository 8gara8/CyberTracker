// The shared world of the validator fixtures (SPEC §4.12 "Fixtures and tests"): the three editions' dates
// and times, every source the valid drafts cite with the text the run saw there, the real CVE records they
// cite (minimal CVE JSON 5, no references) and the real KEV rows the metrics and region inputs read.
// Prose at invented paths (`/ct-sample/`) is invented and marked SAMPLE; those pages are never fetched,
// so the fixture evidence carries their seen text. Times are Asia/Taipei (+08:00) unless labelled UTC (Z).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addDays, utcDateOf } from "../../lib/dates";
import type { DraftSource, SourceType } from "../../lib/schema/common";
import { KevIndexRow } from "../../lib/schema/metrics";

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(FIXTURES_DIR, "..");

// ── Editions ─────────────────────────────────────────────────────────────────────────────────────

export type EditionName = "weekday" | "monday" | "quiet";
export const EDITION_NAMES: readonly EditionName[] = ["weekday", "monday", "quiet"];

export interface EditionTimes {
  name: EditionName;
  /** The Taipei edition date. */
  date: string;
  /** (D - 1)T04:30:00+08:00 to DT04:30:00+08:00. */
  window: { start: string; end: string };
  /** data_cutoff_utc: D - 2. */
  cutoff: string;
  packAt: string;
  metricsAt: string;
  /** The draft's generated_at, inside [window.end, deadline]. */
  generatedAt: string;
  deadline: string;
  /** The KEV catalog collect read that morning; `since` is the version the previous edition read. */
  kev: { version: string; count: number; released: string; since: string; newIds: string[] };
  cveListRelease: string;
}

function times(name: EditionName, date: string, generated: string, kev: EditionTimes["kev"], cveListRelease: string): EditionTimes {
  return {
    name,
    date,
    window: { start: `${addDays(date, -1)}T04:30:00+08:00`, end: `${date}T04:30:00+08:00` },
    cutoff: addDays(date, -2),
    packAt: `${date}T04:41:05+08:00`,
    metricsAt: `${date}T04:41:12+08:00`,
    generatedAt: `${date}T${generated}+08:00`,
    deadline: `${date}T05:15:00+08:00`,
    kev,
    cveListRelease,
  };
}

// KEV catalog versions (real counts: 1,739 entries through 2026-10-08, 1,741 through 2026-10-13).
const KEV_1008 = { version: "2026.10.08", count: 1739, released: "2026-10-08T17:05:40Z" };
const KEV_1013 = { version: "2026.10.13", count: 1741, released: "2026-10-13T17:02:11Z" };

/** A Sunday with nothing that clears the bar, the Monday after it, and the Wednesday of that week. */
export const EDITIONS: Readonly<Record<EditionName, EditionTimes>> = {
  quiet: times("quiet", "2026-10-11", "04:58:10", { ...KEV_1008, since: "2026.10.08", newIds: [] }, "cve_2026-10-10_2000Z"),
  monday: times("monday", "2026-10-12", "05:04:30", { ...KEV_1008, since: "2026.10.08", newIds: [] }, "cve_2026-10-11_2000Z"),
  weekday: times("weekday", "2026-10-14", "05:06:12", {
    ...KEV_1013, since: "2026.10.08", newIds: ["CVE-2026-96951", "CVE-2026-104935"],
  }, "cve_2026-10-13_2000Z"),
};

// ── KEV rows ─────────────────────────────────────────────────────────────────────────────────────

/** Real KEV entries added 2026-07-13 to 2026-10-14, as state/kev-index.json rows (fixtures/src/kev-rows.json). */
export const KEV_ROWS: readonly KevIndexRow[] = (() => {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "src", "kev-rows.json"), "utf8")) as { entries: unknown[] };
  return raw.entries.map((r) => KevIndexRow.parse(r));
})();

/** Real KEV due dates of the entries the drafts cite (the catalog's dueDate). */
export const KEV_DUE: Readonly<Record<string, string>> = { "CVE-2026-104935": "2026-10-16", "CVE-2026-96951": "2026-10-16" };

// ── CVE records ──────────────────────────────────────────────────────────────────────────────────

export const CISA_ADP = { orgId: "134c704f-9b21-4f2e-91b3-4a467353bcc0", shortName: "CISA-ADP" } as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface RecordSpec {
  id: string;
  orgId: string;
  assigner: string;
  reserved: string;
  published: string;
  /** The real dateUpdated, or datePublished when the real update came after the editions that cite it. */
  updated: string;
  title: string | null;
  description: string;
  affected: Json[];
  cwe: { id: string; description: string };
  cvss: { version: "3.1"; score: number; severity: string; vector: string };
  credits: string[];
  /** CISA-ADP vulnrichment as it stood before the runs that cite the record; null when it came later. */
  adp: { updated: string; ssvc: { exploitation: string; automatable: string; impact: string; timestamp: string }; kevAdded: string | null } | null;
}

const RECORD_SPECS: readonly RecordSpec[] = [
  {
    id: "CVE-2026-104935", orgId: "3c1d8aa1-5a33-4ea4-8992-aadd6440af75", assigner: "ivanti",
    reserved: "2026-10-02T17:07:30.656Z", published: "2026-10-13T15:31:07.757Z", updated: "2026-10-13T19:58:23.946Z",
    title: null,
    description: "Authentication bypass by spoofing in ICS before version 25.1.3.0 allows a remote unauthenticated attacker to execute arbitrary commands. This does not impact ICS version 22.7R2.14 or prior.",
    affected: [{ vendor: "Ivanti", product: "Connect Secure", defaultStatus: "affected", versions: [
      { version: "25.1.3.0", status: "unaffected", versionType: "custom" },
      { version: "22.7R2.14", status: "unaffected", versionType: "custom" },
    ] }],
    cwe: { id: "CWE-290", description: "CWE-290 Authentication bypass by spoofing" },
    cvss: { version: "3.1", score: 8.6, severity: "HIGH", vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:L" },
    credits: [],
    adp: {
      updated: "2026-10-13T19:58:23.946Z",
      ssvc: { exploitation: "active", automatable: "yes", impact: "total", timestamp: "2026-10-13T15:42:16.582526Z" },
      kevAdded: "2026-10-13",
    },
  },
  {
    id: "CVE-2026-96951", orgId: "f38d906d-7342-40ea-92c1-6c4a2c6478c8", assigner: "microsoft",
    reserved: "2026-09-23T20:35:19.928Z", published: "2026-10-13T19:01:26.801Z", updated: "2026-10-13T19:01:26.801Z",
    title: "Windows Shell Security Feature Bypass Vulnerability",
    description: "Improper neutralization of special elements used in a command ('command injection') in Windows Shell allows an unauthorized attacker to bypass a security feature over a network.",
    affected: [
      { vendor: "Microsoft", product: "Windows 11 Version 25H2", platforms: ["ARM64-based Systems", "x64-based Systems"],
        versions: [{ version: "10.0.26200.0", lessThan: "10.0.26200.9711", versionType: "custom", status: "affected" }] },
      { vendor: "Microsoft", product: "Windows Server 2025", platforms: ["x64-based Systems"],
        versions: [{ version: "10.0.26100.0", lessThan: "10.0.26100.33650", versionType: "custom", status: "affected" }] },
    ],
    cwe: { id: "CWE-77", description: "CWE-77: Improper Neutralization of Special Elements used in a Command ('Command Injection')" },
    cvss: { version: "3.1", score: 8.8, severity: "HIGH", vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H/E:F/RL:O/RC:C" },
    credits: [],
    adp: null,
  },
  {
    id: "CVE-2026-108917", orgId: "1af790b2-7ee1-4545-860a-a788eba489b5", assigner: "VulDB",
    reserved: "2026-10-11T15:51:40.725Z", published: "2026-10-12T17:45:15.881Z", updated: "2026-10-13T16:04:13.730Z",
    title: "Edimax BR-6208AC formAutoFWupgrade command injection",
    description: "A vulnerability was determined in Edimax BR-6208AC 1.32 that can lead to command injection. The attack may be performed from remote. The exploit has been publicly disclosed. The vendor was contacted early about this disclosure but did not respond in any way. This vulnerability only affects products that are no longer supported by the maintainer.",
    affected: [{ vendor: "Edimax", product: "BR-6208AC", versions: [{ version: "1.32", status: "affected" }] }],
    cwe: { id: "CWE-77", description: "Command Injection" },
    cvss: { version: "3.1", score: 10, severity: "CRITICAL", vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H/E:P/RL:X/RC:R" },
    credits: [],
    adp: {
      updated: "2026-10-13T16:04:13.730Z",
      ssvc: { exploitation: "poc", automatable: "yes", impact: "total", timestamp: "2026-10-13T16:03:40.017470Z" },
      kevAdded: null,
    },
  },
  {
    id: "CVE-2026-110036", orgId: "53f830b8-0a3f-465b-8143-3b8a9948e749", assigner: "redhat",
    reserved: "2026-10-13T15:33:45.629Z", published: "2026-10-13T18:45:47.168Z", updated: "2026-10-13T18:45:47.168Z",
    title: "Device-mapper-persistent-data: device-mapper-persistent-data: denial of service via crafted block indices",
    description: "A flaw was found in device-mapper-persistent-data. A local attacker can cause a Denial of Service (DoS) by inducing a user or system tool to process crafted device metadata containing an excessively large block index. An arithmetic error in the synchronous block reading logic causes the application to panic and unexpectedly terminate.",
    affected: [
      { vendor: "Red Hat", product: "Red Hat Enterprise Linux 10", packageName: "device-mapper-persistent-data", defaultStatus: "affected" },
      { vendor: "Red Hat", product: "Red Hat Enterprise Linux 8", packageName: "device-mapper-persistent-data", defaultStatus: "affected" },
    ],
    cwe: { id: "CWE-190", description: "Integer Overflow or Wraparound" },
    cvss: { version: "3.1", score: 3.3, severity: "LOW", vector: "CVSS:3.1/AV:L/AC:L/PR:N/UI:R/S:U/C:N/I:N/A:L" },
    credits: ["This issue was discovered by Found by AISLE in partnership with Red Hat."],
    adp: null,
  },
  {
    id: "CVE-2026-107466", orgId: "53f830b8-0a3f-465b-8143-3b8a9948e749", assigner: "redhat",
    reserved: "2026-10-08T06:59:41.785Z", published: "2026-10-08T07:54:03.370Z", updated: "2026-10-08T07:54:03.370Z",
    title: "Flatpak-builder: local file exfiltration via `file",
    description: "A flaw was found in flatpak-builder. This vulnerability allows an attacker to cause information disclosure by convincing a user or continuous integration (CI) system to process a crafted build manifest. By specifying local file Uniform Resource Identifiers (URIs) within source download definitions, the builder bypasses directory confinement checks. As a result, sensitive host files accessible to the build process can be read and incorporated into the build artifacts.",
    affected: [
      { vendor: "Red Hat", product: "Red Hat Enterprise Linux 10", packageName: "flatpak-builder", defaultStatus: "affected" },
      { vendor: "Red Hat", product: "Red Hat Enterprise Linux 9", packageName: "flatpak-builder", defaultStatus: "affected" },
    ],
    cwe: { id: "CWE-22", description: "Improper Limitation of a Pathname to a Restricted Directory" },
    cvss: { version: "3.1", score: 6.1, severity: "MEDIUM", vector: "CVSS:3.1/AV:L/AC:L/PR:N/UI:R/S:U/C:H/I:L/A:N" },
    credits: ["This issue was discovered by Found by AISLE in partnership with Red Hat."],
    adp: {
      updated: "2026-10-08T17:54:16.536Z",
      ssvc: { exploitation: "none", automatable: "no", impact: "partial", timestamp: "2026-10-08T15:26:05.988656Z" },
      kevAdded: null,
    },
  },
];

export const RECORD_IDS: readonly string[] = RECORD_SPECS.map((r) => r.id);

function recordSpec(id: string): RecordSpec {
  const r = RECORD_SPECS.find((x) => x.id === id);
  if (!r) throw new Error(`No fixture CVE record ${id}`);
  return r;
}

/** The record in CVE JSON 5 shape, as fixtures/cvelist/records/<id>.json holds it. */
export function cveRecord(id: string): Json {
  const r = recordSpec(id);
  const cna: { [key: string]: Json } = {
    providerMetadata: { orgId: r.orgId, shortName: r.assigner, dateUpdated: r.published },
    ...(r.title ? { title: r.title } : {}),
    descriptions: [{ lang: "en", value: r.description }],
    affected: r.affected,
    problemTypes: [{ descriptions: [{ lang: "en", type: "CWE", cweId: r.cwe.id, description: r.cwe.description }] }],
    metrics: [{ format: "CVSS", scenarios: [{ lang: "en", value: "GENERAL" }],
      cvssV3_1: { version: r.cvss.version, baseScore: r.cvss.score, baseSeverity: r.cvss.severity, vectorString: r.cvss.vector } }],
    ...(r.credits.length ? { credits: r.credits.map((value) => ({ lang: "en", value })) } : {}),
  };
  const adp: Json[] = r.adp ? [{
    providerMetadata: { ...CISA_ADP, dateUpdated: r.adp.updated },
    title: "CISA ADP Vulnrichment",
    metrics: [
      { other: { type: "ssvc", content: {
        id: r.id, role: "CISA Coordinator", version: "2.0.3", timestamp: r.adp.ssvc.timestamp,
        options: [{ Exploitation: r.adp.ssvc.exploitation }, { Automatable: r.adp.ssvc.automatable }, { "Technical Impact": r.adp.ssvc.impact }],
      } } },
      ...(r.adp.kevAdded ? [{ other: { type: "kev", content: {
        dateAdded: r.adp.kevAdded, reference: `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=${r.id}`,
      } } }] : []),
    ],
  }] : [];
  return {
    dataType: "CVE_RECORD",
    dataVersion: "5.2",
    cveMetadata: {
      cveId: r.id, assignerOrgId: r.orgId, state: "PUBLISHED", assignerShortName: r.assigner,
      dateReserved: r.reserved, datePublished: r.published, dateUpdated: r.updated,
    },
    containers: adp.length ? { cna, adp } : { cna },
  };
}

/** What collect's pack record (and the evidence's seen text) holds for a CVE record. */
export interface RecordView {
  id: string;
  title: string;
  text: string;
  /** datePublished as a UTC date. */
  date: string;
  vendor: string;
  product: string;
  cvss: { score: number; version: string; scorer: "cna" };
  ssvc: { exploitation: string; automatable: string; technical_impact: string } | null;
  kevAdded: string | null;
  credits: string[];
}

export function recordView(id: string): RecordView {
  const r = recordSpec(id);
  const first = r.affected[0] as { vendor: string; product: string };
  const ssvc = r.adp ? { exploitation: r.adp.ssvc.exploitation, automatable: r.adp.ssvc.automatable, technical_impact: r.adp.ssvc.impact } : null;
  const kevAdded = r.adp?.kevAdded ?? null;
  const text = [
    r.description,
    `CVSS ${r.cvss.version} ${r.cvss.score.toFixed(1)} (cna).`,
    ssvc ? `CISA SSVC: exploitation ${ssvc.exploitation}, automatable ${ssvc.automatable}, technical impact ${ssvc.technical_impact}.` : null,
    kevAdded ? `CISA KEV: added ${kevAdded}.` : null,
    r.credits.length ? `Credits: ${r.credits.join(" ")}` : null,
  ].filter((s): s is string => s !== null).join(" ");
  return {
    id,
    title: (r.title ?? `${first.vendor} ${first.product}: ${r.description.split(". ")[0]}`).slice(0, 200),
    text: text.slice(0, 1000),
    date: utcDateOf(r.published),
    vendor: first.vendor,
    product: first.product,
    cvss: { score: r.cvss.score, version: r.cvss.version, scorer: "cna" },
    ssvc,
    kevAdded,
    credits: [...r.credits],
  };
}

// ── Sources ──────────────────────────────────────────────────────────────────────────────────────

export interface SourceSpec {
  url: string;
  title: string;
  title_en: string | null;
  language: string;
  outlet: string;
  source_type: SourceType;
  /** As the draft writes it: a Taipei timestamp, or a bare date when the page gives only the day. */
  published_at: string | null;
  /** A news item in the morning's pack: its registry feed and snippet. */
  pack?: { feed_id: string; snippet: string };
  /** A CVE record page: the record's id. Its seen text is the record's title and text. */
  record?: string;
  /** The page text the run read (a deep read or a snapshot). */
  page?: string;
}

/** https://www.cve.org/CVERecord?id=<id>, the canonical record page. */
export const cveRecordUrl = (id: string) => `https://www.cve.org/CVERecord?id=${id}`;

/** A UTC timestamp written in Taipei time, seconds kept: 2026-10-13T15:31:07.757Z gives 2026-10-13T23:31:07+08:00. */
export function toTaipei(utc: string): string {
  const d = new Date(Date.parse(utc) + 8 * 3600_000);
  return `${d.toISOString().slice(0, 19)}+08:00`;
}

function recordSource(id: string): SourceSpec {
  return {
    url: cveRecordUrl(id), title: `CVE Record: ${id}`, title_en: null, language: "en", outlet: "CVE Program",
    source_type: "cve_record", published_at: toTaipei(recordSpec(id).published), record: id,
  };
}

const SOURCE_TABLE = {
  // Weekday, 2026-10-14
  "rec-104935": recordSource("CVE-2026-104935"),
  "ivanti-advisory": {
    url: "https://www.ivanti.com/ct-sample/connect-secure-security-advisory-cve-2026-104935",
    title: "SAMPLE: Security Advisory: Ivanti Connect Secure (CVE-2026-104935)", title_en: null, language: "en", outlet: "Ivanti",
    source_type: "vendor_advisory", published_at: "2026-10-13T22:00:00+08:00",
    page: "SAMPLE advisory text. Ivanti is aware of a limited number of customers whose Connect Secure appliances have been exploited through CVE-2026-104935, an authentication bypass by spoofing that lets a remote unauthenticated attacker execute arbitrary commands. Connect Secure 25.1.3.0 fixes the issue and is available now. Version 22.7R2.14 and earlier are not affected.",
  },
  "bc-ivanti": {
    url: "https://www.bleepingcomputer.com/ct-sample/ivanti-connect-secure-flaw-exploited-in-attacks",
    title: "SAMPLE: Ivanti warns of Connect Secure flaw exploited in attacks", title_en: null, language: "en", outlet: "BleepingComputer",
    source_type: "press", published_at: "2026-10-14T00:40:00+08:00",
    pack: { feed_id: "bleepingcomputer", snippet: "SAMPLE text. Ivanti says attackers exploited CVE-2026-104935 in Connect Secure before a fix. Shadowserver counts about 9,000 unpatched instances online. CISA gave federal agencies three days to patch. No public proof-of-concept exploit is known yet." },
  },
  "msrc-october": {
    url: "https://msrc.microsoft.com/ct-sample/october-2026-security-update",
    title: "SAMPLE: October 2026 security update", title_en: null, language: "en", outlet: "Microsoft Security Response Center",
    source_type: "vendor_advisory", published_at: "2026-10-14T01:00:00+08:00",
    page: "SAMPLE summary. Microsoft's October 2026 security update addresses 1,384 vulnerabilities, 60 of them rated Critical. CVE-2026-96951, a Windows Shell security feature bypass, was exploited before the update was released. Install the update.",
  },
  "rec-96951": recordSource("CVE-2026-96951"),
  "sw-microsoft": {
    url: "https://www.securityweek.com/ct-sample/microsoft-october-2026-patch-tuesday",
    title: "SAMPLE: Microsoft patches 1,384 flaws, one exploited before the fix", title_en: null, language: "en", outlet: "SecurityWeek",
    source_type: "press", published_at: "2026-10-14T03:40:00+08:00",
    pack: { feed_id: "securityweek", snippet: "SAMPLE text. Microsoft's October update fixes 1,384 vulnerabilities, 60 of them critical. CVE-2026-96951 in Windows Shell was exploited before the fix, and CISA added it to its catalog the same day." },
  },
  "teamt5-report": {
    url: "https://teamt5.org/ct-sample/paper-kestrel-invoice-phishing",
    title: "SAMPLE: Paper Kestrel targets Taiwan's semiconductor equipment makers", title_en: null, language: "en", outlet: "TeamT5",
    source_type: "research", published_at: "2026-10-13T16:00:00+08:00",
    page: "SAMPLE report. TeamT5 assesses with moderate confidence that Paper Kestrel, a China-nexus threat group, has targeted at least 12 Taiwanese semiconductor equipment makers since September 2026. The group sends fake supplier invoices that carry a remote access tool.",
  },
  "ft-phishing": {
    url: "https://focustaiwan.tw/ct-sample/chip-equipment-makers-phishing",
    title: "SAMPLE: Taiwan chip equipment makers targeted with AI-written phishing, TeamT5 says", title_en: null, language: "en",
    outlet: "Focus Taiwan", source_type: "press", published_at: "2026-10-13T19:20:00+08:00",
    pack: { feed_id: "focustaiwan", snippet: "SAMPLE text. TeamT5 said at least 12 equipment makers received fake supplier invoices. Its analysts believe the phishing emails were drafted with a generative AI model, the security firm said." },
  },
  "rec-108917": recordSource("CVE-2026-108917"),
  "ithome-edimax": {
    url: "https://www.ithome.com.tw/ct-sample/edimax-br-6208ac-command-injection",
    title: "SAMPLE：Edimax BR-6208AC 路由器命令注入漏洞 CVSS 達 10 分，原廠未回應",
    title_en: "SAMPLE: Edimax BR-6208AC router command injection flaw rated CVSS 10, vendor silent", language: "zh-Hant", outlet: "iThome",
    source_type: "press", published_at: "2026-10-13T11:30:00+08:00",
    pack: { feed_id: "ithome-security", snippet: "（SAMPLE 範例）研究人員公開 Edimax BR-6208AC 路由器命令注入漏洞細節，CVSS 評分 10 分。VulDB 表示 Edimax 未回應，該型號已停止支援，不會修補。" },
  },
  "sn-claim": {
    url: "https://www.security-next.com/ct-sample/logistics-ransomware-claim",
    title: "SAMPLE：物流会社のデータ窃取を主張、ランサムウェアグループ「NightCrane」",
    title_en: "SAMPLE: Ransomware group NightCrane claims data theft from a logistics company", language: "ja", outlet: "Security NEXT",
    source_type: "press", published_at: "2026-10-13T14:10:00+08:00",
    pack: { feed_id: "security-next", snippet: "（SAMPLE）ランサムウェアグループ「NightCrane」が、国内物流会社から窃取したとするデータをリークサイトで公開すると主張した。同社は被害を確認していない。" },
  },
  "rec-110036": recordSource("CVE-2026-110036"),
  "reg-aisle": {
    url: "https://www.theregister.com/ct-sample/red-hat-aisle-ai-bug-credits",
    title: "SAMPLE: Red Hat keeps crediting an AI bug hunter", title_en: null, language: "en", outlet: "The Register",
    source_type: "press", published_at: "2026-10-13T21:00:00+08:00",
    page: "SAMPLE article. Red Hat has credited AISLE, an AI vulnerability-finding system, with 24 flaws in its Linux packages since 1 October. Red Hat rated none of them critical: the highest scores 7.5, and the newest, published on 13 October, is a low-severity local crash bug scored 3.3. Most are local bugs that need a user to open a crafted file.",
  },
  "anthropic-glasswing": {
    url: "https://red.anthropic.com/ct-sample/glasswing-partner-update",
    title: "SAMPLE: Project Glasswing: an update from our partners", title_en: null, language: "en", outlet: "Anthropic",
    source_type: "finder_writeup", published_at: "2026-10-13T09:00:00+08:00",
    page: "SAMPLE update. Project Glasswing partners have now disclosed 4,212 vulnerabilities that Claude found in their code. Maintainers have shipped patches for 497 of them so far, and we expect that number to rise as coordinated disclosure windows close.",
  },
  "tr-glasswing": {
    url: "https://therecord.media/ct-sample/anthropic-glasswing-disclosures",
    title: "SAMPLE: Anthropic says Glasswing partners disclosed 4,212 flaws found by its AI", title_en: null, language: "en",
    outlet: "The Record", source_type: "press", published_at: "2026-10-13T22:15:00+08:00",
    pack: { feed_id: "therecord", snippet: "SAMPLE text. Anthropic says 497 of the flaws found through Project Glasswing are patched upstream so far. No partner has published its own count." },
  },
  "ey-amendment": {
    url: "https://www.ey.gov.tw/ct-sample/cyber-security-act-amendment-one-hour-reporting",
    title: "SAMPLE：行政院會通過資通安全管理法修正草案，關鍵基礎設施重大資安事件須一小時內通報",
    title_en: "SAMPLE: Cabinet approves draft amendment requiring one-hour reporting of serious incidents at critical infrastructure",
    language: "zh-Hant", outlet: "行政院", source_type: "government", published_at: "2026-10-13",
    page: "（SAMPLE 範例內容）行政院會通過「資通安全管理法」部分條文修正草案，要求關鍵基礎設施提供者於知悉重大資安事件後一小時內通報主管機關。草案將送請立法院審議。",
  },
  "tt-amendment": {
    url: "https://www.taipeitimes.com/ct-sample/cabinet-backs-one-hour-incident-reporting",
    title: "SAMPLE: Cabinet backs one-hour incident reporting rule", title_en: null, language: "en", outlet: "Taipei Times",
    source_type: "press", published_at: "2026-10-14T02:00:00+08:00",
    pack: { feed_id: "taipeitimes", snippet: "SAMPLE text. The Executive Yuan approved a draft amendment requiring critical infrastructure operators to report serious incidents within one hour. The legislature must still pass it." },
  },
  "ncsc-review": {
    url: "https://www.ncsc.gov.uk/ct-sample/annual-review-2026",
    title: "SAMPLE: NCSC Annual Review 2026", title_en: null, language: "en", outlet: "NCSC",
    source_type: "government", published_at: "2026-10-13T17:00:00+08:00",
    pack: { feed_id: "ncsc-uk", snippet: "SAMPLE text. Attackers used AI to speed up reconnaissance against UK organisations this year. We have not yet seen AI-powered malware used in an attack on UK critical national infrastructure." },
  },
  "nhk-backups": {
    url: "https://www3.nhk.or.jp/news/ct-sample/local-government-backup-checks",
    title: "SAMPLE：総務省 自治体にバックアップ体制の点検を要請",
    title_en: "SAMPLE: Internal affairs ministry asks local governments to check backup systems", language: "ja", outlet: "NHK",
    source_type: "press", published_at: "2026-10-13T20:00:00+08:00",
    pack: { feed_id: "nhk", snippet: "（SAMPLE）総務省は全国の自治体に対し、ランサムウェア被害に備えてバックアップ体制を点検するよう要請した。" },
  },

  // Monday, 2026-10-12. The breach item is withheld on 13 Oct; §4.10 keeps its source URLs, so they name no one.
  "sec-8k": {
    url: "https://www.sec.gov/ct-sample/form-8-k-item-1-05-2026-10-10",
    title: "SAMPLE: Example Health Group, Form 8-K, Item 1.05 Material Cybersecurity Incidents", title_en: null, language: "en",
    outlet: "US SEC", source_type: "regulator_filing", published_at: "2026-10-10",
    page: "SAMPLE filing. Example Health Group detected unauthorized access to its billing systems in early October 2026. An unauthorized third party copied files containing patient records. Hospital services were not disrupted. The company is notifying affected individuals and regulators.",
  },
  "tr-health": {
    url: "https://therecord.media/ct-sample/us-hospital-operator-breach",
    title: "SAMPLE: Example Health Group says hackers copied patient records", title_en: null, language: "en", outlet: "The Record",
    source_type: "press", published_at: "2026-10-11T06:20:00+08:00",
    pack: { feed_id: "therecord", snippet: "SAMPLE text. Example Health Group, a US hospital operator, told the SEC an intruder copied patient records from its billing systems. It is notifying about 410,000 people. Services were not disrupted." },
  },
  "cverc-claim": {
    url: "https://www.cverc.org.cn/ct-sample/national-time-service-network-report",
    title: "SAMPLE：关于美国情报机构入侵国家授时服务网络的调查报告",
    title_en: "SAMPLE: Investigation report on US intelligence agencies breaking into a national time service network",
    language: "zh-Hans", outlet: "国家计算机病毒应急处理中心 (CVERC)", source_type: "government", published_at: "2026-10-11T10:00:00+08:00",
    page: "（SAMPLE 示例内容）国家计算机病毒应急处理中心（CVERC）发布报告称，美国情报机构在 2023 年至 2025 年间多次入侵国家授时服务网络。报告未公布可供第三方验证的技术细节。",
  },
  "scmp-claim": {
    url: "https://www.scmp.com/ct-sample/cverc-time-service-network-claim",
    title: "SAMPLE: State agency says US agencies broke into a national time service network", title_en: null, language: "en",
    outlet: "South China Morning Post", source_type: "press", published_at: "2026-10-11T15:30:00+08:00",
    page: "SAMPLE article. CVERC, a state virus response centre, said US intelligence agencies broke into a national time service network between 2023 and 2025. The report included no technical details that others could verify. US officials did not respond to requests for comment.",
  },
  "npa-guidelines": {
    url: "https://www.npa.go.jp/ct-sample/active-cyber-defence-guidelines",
    title: "SAMPLE：アクティブ・サイバー・ディフェンスに係るアクセス・無害化措置の運用指針",
    title_en: "SAMPLE: Operating guidelines for access and neutralisation measures under active cyber defence", language: "ja",
    outlet: "警察庁", source_type: "government", published_at: "2026-10-11",
    page: "（SAMPLE）警察庁は、重要電子計算機に対する攻撃に用いられるサーバ等へのアクセス・無害化措置の運用指針を公表した。改正法は 2027 年に全面施行される。",
  },
  "jt-guidelines": {
    url: "https://www.japantimes.co.jp/ct-sample/police-rules-for-disabling-attack-servers",
    title: "SAMPLE: Police set rules for disabling attack servers", title_en: null, language: "en", outlet: "The Japan Times",
    source_type: "press", published_at: "2026-10-11T19:00:00+08:00",
    page: "SAMPLE article. The National Police Agency published guidelines on when officers may access and disable servers used in attacks on Japan, under the active cyber defence law that takes full effect in 2027.",
  },
  "rec-107466": recordSource("CVE-2026-107466"),
} satisfies Record<string, SourceSpec>;

export type SourceKey = keyof typeof SOURCE_TABLE;
/** Every source a valid draft cites, by key. */
export const SOURCES: Readonly<Record<SourceKey, SourceSpec>> = SOURCE_TABLE;

export function sourceSpec(key: SourceKey): SourceSpec {
  return SOURCES[key];
}

/** The text the run saw at a source: a record's title and text; else the title, the pack snippet and the page text read. */
export function seenText(key: SourceKey): string {
  const s = SOURCES[key];
  if (s.record) {
    const r = recordView(s.record);
    return `${r.title}\n${r.text}`;
  }
  return [s.title, s.title_en, s.pack?.snippet, s.page].filter((x): x is string => typeof x === "string").join("\n");
}

/** The draft's sources for `keys`, with ids s1, s2, ... in that order. */
export function draftSources(keys: readonly SourceKey[]): DraftSource[] {
  return keys.map((key, i) => {
    const s = SOURCES[key];
    return {
      id: `s${i + 1}`, title: s.title, title_en: s.title_en, language: s.language, outlet: s.outlet, url: s.url,
      source_type: s.source_type, published_at: s.published_at,
    };
  });
}

/** key → "sN" for a draft citing `keys` in that order. */
export function sourceIds<K extends SourceKey>(keys: readonly K[]): Record<K, string> {
  return Object.fromEntries(keys.map((k, i) => [k, `s${i + 1}`])) as Record<K, string>;
}
