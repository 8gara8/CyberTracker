// The three valid SAMPLE drafts (SPEC §4.12 "Fixtures and tests"): a weekday with the eight item shapes
// the spec lists, a Monday with the week in review, and a quiet Sunday with no items. Each passes every
// rule with its own context, evidence, metrics, CVE records, regions input and pack (fixtures/src/inputs.ts).
// The invalid and soft fixtures are single mutations of weekdayDraft().

import { DraftBrief, type DraftLensBlock, type DraftLensRow } from "../../lib/schema/draft-brief";
import type { DraftItem } from "../../lib/schema/item";
import { NONE_FOUND, TAIWAN_LENS_ROWS, TAIWAN_NO_NEWS, type TaiwanLensRowId } from "../../lib/vocab";
import { EDITIONS, draftSources, sourceIds, type EditionName, type SourceKey } from "./world";

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

type ItemInput = Pick<DraftItem, "id" | "kind" | "headline" | "summary" | "regions" | "source_ids"> & Partial<DraftItem>;

/** An item with every optional field at its "nothing here" value; DraftBrief.parse() puts the keys in order. */
function item(x: ItemInput): DraftItem {
  return {
    why_it_matters: null, severity: null, landmark: false, ai_role: "none", ai_role_secondary: null, ai_confidence: null,
    ai_claimant: null, ai_evidence: [], claim_type: "independent", topics: [], attribution: [], incident: null, cve_ids: [],
    release_id: null, flaw_evidence: [], exploit_reported_in_sources: null, exposure: null, standing_story: null,
    ...x,
  };
}

type RowInput = { text: string; item_ids?: string[]; source_ids?: string[] };

/** The six Taiwan Lens rows in TAIWAN_LENS_ROWS order; rows not given are null with no ids. */
function lensRows(rows: Partial<Record<TaiwanLensRowId, RowInput>>): DraftLensRow[] {
  return TAIWAN_LENS_ROWS.map((row) => {
    const r = rows[row];
    return { row, text: r?.text ?? null, item_ids: r?.item_ids ?? [], source_ids: r?.source_ids ?? [] };
  });
}

function japan(x: RowInput | null): DraftLensBlock {
  return { text: x?.text ?? null, item_ids: x?.item_ids ?? [], source_ids: x?.source_ids ?? [] };
}

// ── Weekday, Wednesday 2026-10-14 ────────────────────────────────────────────────────────────────

/** The sources the weekday draft cites, in sN order. */
export const WEEKDAY_SOURCE_KEYS = [
  "rec-104935", "ivanti-advisory", "bc-ivanti", "msrc-october", "rec-96951", "sw-microsoft", "teamt5-report", "ft-phishing",
  "rec-108917", "ithome-edimax", "sn-claim", "rec-110036", "reg-aisle", "anthropic-glasswing", "tr-glasswing", "ey-amendment",
  "tt-amendment", "ncsc-review", "nhk-backups",
] as const satisfies readonly SourceKey[];

/** The weekday's item ids, by the shape SPEC §4.12 asks for. */
export const WEEKDAY_ITEMS = {
  criticalExploited: "cve-2026-104935",
  patchBatch: "pt-microsoft-2026-10",
  chinaAxis: "camp-tw-semiconductor-2026-10",
  taiwanVendor: "cve-2026-108917",
  claimedVictim: "inc-transport-jp-2026-10",
  aiConfirmed: "ai-aisle-red-hat-2026-10",
  glasswing: "ai-glasswing-2026-10",
  landmark: "pol-tw-incident-reporting-2026-10",
} as const;

function buildWeekday(): DraftBrief {
  const t = EDITIONS.weekday;
  const s = sourceIds(WEEKDAY_SOURCE_KEYS);
  const I = WEEKDAY_ITEMS;
  const items: DraftItem[] = [
    item({
      id: I.criticalExploited, kind: "exploited_flaw", severity: "critical",
      headline: "Attackers exploit an Ivanti Connect Secure flaw that lets them run commands",
      summary: "Ivanti says attackers exploited CVE-2026-104935, an authentication bypass in Connect Secure that lets an unauthenticated attacker run commands, before it shipped version 25.1.3. CISA listed the flaw as exploited on 13 October.",
      why_it_matters: "Connect Secure gateways sit on the edge of many corporate networks, and Shadowserver counts about 9,000 still unpatched.",
      regions: ["US", "GLOBAL"], cve_ids: ["CVE-2026-104935"],
      flaw_evidence: [
        { cve_id: "CVE-2026-104935", kind: "exploited", basis: "vendor_confirmed", date: "2026-10-13", source_id: s["ivanti-advisory"] },
        { cve_id: "CVE-2026-104935", kind: "patched", basis: "vendor_advisory", date: "2026-10-13", source_id: s["ivanti-advisory"] },
      ],
      exploit_reported_in_sources: false,
      exposure: { text: "about 9,000 internet-facing Connect Secure instances unpatched, as reported by Shadowserver", source_id: s["bc-ivanti"] },
      source_ids: [s["rec-104935"], s["ivanti-advisory"], s["bc-ivanti"]],
    }),
    item({
      id: I.patchBatch, kind: "patch_batch", severity: "high",
      headline: "Microsoft's October update fixes 1,384 flaws, one already exploited",
      summary: "Microsoft's October security update covers 1,384 flaws, 60 of them rated critical. One, CVE-2026-96951, a Windows Shell security feature bypass, was exploited before the fix, and CISA listed it as exploited the same day.",
      why_it_matters: "A batch this large forces triage, and the one flaw already exploited is where patching should start.",
      regions: ["GLOBAL"], cve_ids: ["CVE-2026-96951"], release_id: "rel-microsoft-2026-10",
      flaw_evidence: [
        { cve_id: "CVE-2026-96951", kind: "exploited", basis: "vendor_confirmed", date: "2026-10-13", source_id: s["msrc-october"] },
        { cve_id: "CVE-2026-96951", kind: "patched", basis: "vendor_advisory", date: "2026-10-13", source_id: s["msrc-october"] },
      ],
      source_ids: [s["msrc-october"], s["rec-96951"], s["sw-microsoft"]],
    }),
    item({
      id: I.chinaAxis, kind: "campaign", severity: "elevated",
      headline: "TeamT5 says a China-nexus group phished Taiwanese chip equipment makers",
      summary: "TeamT5 says the group, which it calls Paper Kestrel, has sent fake supplier invoices to at least 12 Taiwanese semiconductor equipment makers since September. Focus Taiwan reports that the phishing emails were drafted with a generative AI model.",
      why_it_matters: "Taiwan's chip supply chain is a standing espionage target, and AI-written lures make such phishing cheaper to run at scale.",
      ai_role: "ai_weapon", ai_confidence: "reported",
      ai_evidence: [{ source_id: s["ft-phishing"], quote: "the phishing emails were drafted with a generative AI model", from_claimant: false }],
      regions: ["TW"], topics: ["semiconductor"],
      attribution: [{
        attributed_by: "TeamT5", basis: "vendor", actor_name_as_used: "Paper Kestrel", sponsor_claimed: "China", nexus: "prc",
        confidence_text: "moderate confidence", confidence_level: "moderate", date: "2026-10-13", source_id: s["teamt5-report"],
      }],
      source_ids: [s["teamt5-report"], s["ft-phishing"]],
    }),
    item({
      id: I.taiwanVendor, kind: "critical_flaw", severity: "watch",
      headline: "Unpatched Edimax router flaw rated 10 will get no fix",
      summary: "Details of a command injection flaw in the end-of-life BR-6208AC router are public; VulDB says Edimax never responded, so no fix is coming.",
      regions: ["TW", "GLOBAL"], cve_ids: ["CVE-2026-108917"], exploit_reported_in_sources: true,
      source_ids: [s["rec-108917"], s["ithome-edimax"]],
    }),
    item({
      id: I.claimedVictim, kind: "breach", severity: "watch", claim_type: "self_reported",
      headline: "Ransomware group claims an attack on a Japanese logistics company",
      summary: "Security NEXT reports a leak-site post naming a Japanese logistics company, claimed by NightCrane, unverified. The company has not confirmed an incident.",
      regions: ["JP"],
      incident: {
        victim: null, description: "a Japanese logistics company", sector: "transport", country: "JP",
        impact: "Data theft claimed; no disruption reported", disruption: false, status: "claimed", claimed_by: "NightCrane",
        status_source_ids: [s["sn-claim"]],
      },
      source_ids: [s["sn-claim"]],
    }),
    item({
      id: I.aiConfirmed, kind: "ai_capability",
      headline: "Red Hat credits AISLE's AI system with 24 Linux flaws so far this month",
      summary: "Red Hat rated none of them critical; the newest, a local crash bug scored 3.3, was published on 13 October.",
      ai_role: "ai_found", ai_confidence: "confirmed",
      ai_evidence: [{ source_id: s["rec-110036"], quote: "This issue was discovered by Found by AISLE in partnership with Red Hat.", from_claimant: false }],
      regions: ["GLOBAL"], cve_ids: ["CVE-2026-110036"],
      source_ids: [s["rec-110036"], s["reg-aisle"]],
    }),
    item({
      id: I.glasswing, kind: "ai_capability", claim_type: "self_reported",
      headline: "Anthropic says Project Glasswing partners have disclosed 4,212 flaws found by Claude",
      summary: "Anthropic says 497 are patched upstream so far; The Record notes that no partner has published its own count.",
      ai_role: "ai_found", ai_confidence: "claimed", ai_claimant: "Anthropic",
      ai_evidence: [{ source_id: s["anthropic-glasswing"], quote: "Project Glasswing partners have now disclosed 4,212 vulnerabilities that Claude found in their code.", from_claimant: true }],
      regions: ["GLOBAL"],
      source_ids: [s["anthropic-glasswing"], s["tr-glasswing"]],
    }),
    item({
      id: I.landmark, kind: "policy", landmark: true, claim_type: "government",
      headline: "Taiwan's Cabinet backs one-hour incident reporting for critical infrastructure",
      summary: "The Executive Yuan approved a draft amendment requiring critical infrastructure operators to report serious incidents within one hour; the legislature must still pass it.",
      regions: ["TW"], topics: ["government"],
      source_ids: [s["ey-amendment"], s["tt-amendment"]],
    }),
  ];

  return DraftBrief.parse({
    schema_version: 1,
    date: t.date,
    generated_at: t.generatedAt,
    lead: [
      { text: "Ivanti and Microsoft each fixed a flaw that attackers were already using, and CISA listed both as exploited on 13 October.",
        item_ids: [I.criticalExploited, I.patchBatch], gap: false },
      { text: "37% of recently disclosed flaws on CISA's exploited list were already being exploited when disclosed, the same share as in 2023–24.",
        item_ids: [], gap: true },
      { text: "TeamT5 says a China-nexus group phished Taiwanese chip equipment makers with lures that Focus Taiwan reports were written by AI.",
        item_ids: [I.chinaAxis], gap: false },
    ],
    angle: {
      text: "Red Hat has credited AISLE with 24 flaws since 1 October.",
      source_id: s["reg-aisle"], metric_path: null, as_of: "2026-10-13",
      counterpoint: "Red Hat rated none of them critical, and most are local bugs that need a user to open a crafted file.",
      counterpoint_source_ids: [s["reg-aisle"]],
      claim_id: "SB-01",
    },
    region_raises: [{
      region: "US", reason: "CISA gave federal agencies three days to patch exploited Ivanti Connect Secure gateways.",
      trigger_class: "agency_alert", item_ids: [I.criticalExploited],
    }],
    items,
    taiwan_lens: {
      analysis: "TeamT5 attributes phishing of Taiwanese chip equipment makers to a China-nexus group with moderate confidence. An Edimax router flaw rated 10 will get no fix, and the Cabinet's one-hour incident reporting draft now goes to the legislature.",
      item_ids: [I.chinaAxis, I.taiwanVendor, I.landmark],
      source_ids: [],
      rows: lensRows({
        gov_infra: { text: "The Cabinet approved a draft requiring critical infrastructure operators to report serious incidents within one hour.", item_ids: [I.landmark] },
        home_vendors: { text: "No new Taiwanese vendor flaw was reported exploited today; details of an unfixed Edimax router flaw are public.", item_ids: [I.taiwanVendor] },
        chips_defence: { text: "Fake supplier invoices reached at least 12 equipment makers, TeamT5 says.", item_ids: [I.chinaAxis] },
        china_axis: { text: "TeamT5 attributes the phishing to a China-nexus group it calls Paper Kestrel, with moderate confidence.", item_ids: [I.chinaAxis] },
      }),
      japan: japan({ text: "A ransomware group claims data from a Japanese logistics company; nothing is confirmed.", item_ids: [I.claimedVictim] }),
    },
    scoreboard_entries: [{
      claim_id: "SB-02",
      summary: "The NCSC's annual review says attackers used AI to speed up reconnaissance against UK organisations, but reports no confirmed AI-powered malware in an attack on critical infrastructure.",
      quote: "We have not yet seen AI-powered malware used in an attack on UK critical national infrastructure.",
      quote_source_id: s["ncsc-review"],
      reported_value: null,
      claim_type: "government",
      meets: null,
    }],
    week_in_review: null,
    corrections: [],
    elsewhere: [{ title: "Japan asks local governments to check their backup systems against ransomware", source_id: s["nhk-backups"] }],
    sources: draftSources(WEEKDAY_SOURCE_KEYS),
  });
}

// ── Monday, 2026-10-12 ───────────────────────────────────────────────────────────────────────────

export const MONDAY_SOURCE_KEYS = [
  "sec-8k", "tr-health", "cverc-claim", "scmp-claim", "npa-guidelines", "jt-guidelines", "rec-107466",
] as const satisfies readonly SourceKey[];

export const MONDAY_ITEMS = {
  confirmedBreach: "inc-health-us-2026-10",
  stateClaim: "camp-prc-state-claim-2026-10",
  policy: "pol-jp-active-cyber-defence-2026-10",
} as const;

function buildMonday(): DraftBrief {
  const t = EDITIONS.monday;
  const s = sourceIds(MONDAY_SOURCE_KEYS);
  const I = MONDAY_ITEMS;
  const items: DraftItem[] = [
    item({
      id: I.confirmedBreach, kind: "breach", severity: "high",
      headline: "Example Health Group says an intruder copied patient records",
      summary: "In an SEC filing, Example Health Group says an intruder copied patient records from its billing systems in early October; hospital services kept running. The Record reports the company is notifying about 410,000 people.",
      why_it_matters: "A regulator filing gives a firmer record than any leak-site claim, and stolen health records usually feed fraud for years.",
      regions: ["US"],
      incident: {
        victim: "Example Health Group", description: "a US hospital operator", sector: "health", country: "US",
        impact: "Patient records copied; hospital services not disrupted", disruption: false, status: "confirmed", claimed_by: null,
        status_source_ids: [s["sec-8k"]],
      },
      source_ids: [s["sec-8k"], s["tr-health"]],
    }),
    item({
      id: I.stateClaim, kind: "campaign", severity: "watch", claim_type: "government",
      headline: "PRC state claim: CVERC says US agencies broke into a national time service network",
      summary: "CVERC, a PRC state source, says US agencies broke into a national time service network between 2023 and 2025. It released no technical detail that others can verify, and US officials have not responded.",
      why_it_matters: "State sources now answer Western naming with counter-claims, so this stays at Watch until independent evidence appears.",
      regions: ["GLOBAL"],
      attribution: [{
        attributed_by: "CVERC", basis: "government", actor_name_as_used: "US intelligence agencies", sponsor_claimed: "United States",
        nexus: "other_state", confidence_text: null, confidence_level: "unstated", date: "2026-10-11", source_id: s["cverc-claim"],
      }],
      source_ids: [s["cverc-claim"], s["scmp-claim"]],
    }),
    item({
      id: I.policy, kind: "policy", claim_type: "government",
      headline: "Japan's police set rules for disabling attack servers under the new cyber defence law",
      summary: "The National Police Agency published guidelines on when officers may access and disable servers used in attacks on Japan, under the active cyber defence law that takes full effect in 2027.",
      why_it_matters: "It moves Japan from watching attackers towards disrupting their infrastructure, a shift its allies and Taiwan will study closely.",
      regions: ["JP"], topics: ["government"],
      source_ids: [s["npa-guidelines"], s["jt-guidelines"]],
    }),
  ];

  return DraftBrief.parse({
    schema_version: 1,
    date: t.date,
    generated_at: t.generatedAt,
    lead: [
      { text: "Example Health Group told US regulators that an intruder copied patient records from its billing systems.",
        item_ids: [I.confirmedBreach], gap: false },
      { text: "CVERC, a PRC state source, says US agencies broke into a national time service network, and it offered nothing others can check.",
        item_ids: [I.stateClaim], gap: false },
      { text: "For flaws not exploited at disclosure, CISA confirmed exploitation after a median 17 days, against 21 in 2023–24.",
        item_ids: [], gap: true },
    ],
    angle: {
      text: "Flaws not exploited at disclosure reached CISA's list a median 17 days after it.",
      source_id: null, metric_path: "window.w26.after_disclosure_median_days", as_of: t.cutoff,
      counterpoint: NONE_FOUND, counterpoint_source_ids: [], claim_id: null,
    },
    region_raises: [],
    items,
    taiwan_lens: {
      analysis: "Nothing today targets Taiwan directly. CVERC's claim against US agencies is today's China-axis item: a PRC state source, with no evidence others can check.",
      item_ids: [I.stateClaim],
      source_ids: [],
      rows: lensRows({
        china_axis: { text: "CVERC, a PRC state source, says US agencies broke into a national time service network.", item_ids: [I.stateClaim] },
      }),
      japan: japan({ text: "Police published guidelines for disabling attack servers under the active cyber defence law.", item_ids: [I.policy] }),
    },
    scoreboard_entries: [],
    week_in_review: {
      text: "The week to Sunday was heavy on old flaws and light on new exploitation. On Thursday CISA listed five long-known flaws as exploited, including Apache Struts and ISC BIND bugs disclosed years ago, a reminder that old exposure lingers. Red Hat kept crediting AISLE's AI system with Linux flaws, mostly rated moderate or low. No Taiwanese or Japanese vendor flaw was reported exploited.",
      strongest_against: {
        text: "The AISLE credits so far are modest: the flatpak-builder flaw Red Hat published on 8 October scores 6.1 and needs a user to process a crafted manifest.",
        claim_id: "SB-01",
        source_ids: [s["rec-107466"]],
      },
    },
    corrections: [],
    elsewhere: [],
    sources: draftSources(MONDAY_SOURCE_KEYS),
  });
}

// ── Quiet, Sunday 2026-10-11 ─────────────────────────────────────────────────────────────────────

function buildQuiet(): DraftBrief {
  const t = EDITIONS.quiet;
  return DraftBrief.parse({
    schema_version: 1,
    date: t.date,
    generated_at: t.generatedAt,
    lead: [
      { text: "37% of recently disclosed flaws on CISA's exploited list were already being exploited when disclosed, unchanged from 2023–24.",
        item_ids: [], gap: true },
      { text: "For the rest, CISA confirmed exploitation after a median 17 days, against 21 in 2023–24.", item_ids: [], gap: true },
    ],
    angle: {
      text: "New CVE records are arriving at 5.2 times the 2023–24 pace.",
      source_id: null, metric_path: "flood.vs_reference_ratio", as_of: t.cutoff,
      counterpoint: NONE_FOUND, counterpoint_source_ids: [], claim_id: null,
    },
    region_raises: [],
    items: [],
    taiwan_lens: { analysis: TAIWAN_NO_NEWS, item_ids: [], source_ids: [], rows: lensRows({}), japan: japan(null) },
    scoreboard_entries: [],
    week_in_review: null,
    corrections: [],
    elsewhere: [],
    sources: [],
  });
}

// ── Exports ──────────────────────────────────────────────────────────────────────────────────────

const BUILDERS: Record<EditionName, () => DraftBrief> = { weekday: buildWeekday, monday: buildMonday, quiet: buildQuiet };
const cache = new Map<EditionName, DraftBrief>();

/** The valid draft of an edition: a fresh deep copy on every call, so callers may mutate it. */
export function editionDraft(name: EditionName): DraftBrief {
  let d = cache.get(name);
  if (!d) {
    d = BUILDERS[name]();
    cache.set(name, d);
  }
  return structuredClone(d);
}

export const weekdayDraft = (): DraftBrief => editionDraft("weekday");
export const mondayDraft = (): DraftBrief => editionDraft("monday");
export const quietDraft = (): DraftBrief => editionDraft("quiet");

/** The source keys each draft cites, in sN order. */
export const SOURCE_KEYS: Readonly<Record<EditionName, readonly SourceKey[]>> = {
  weekday: WEEKDAY_SOURCE_KEYS,
  monday: MONDAY_SOURCE_KEYS,
  quiet: [],
};
