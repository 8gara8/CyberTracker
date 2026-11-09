// The naming, safety, computed and snapshot rule groups (SPEC §4.12): VICTIM_STATUS, VICTIM_CLAIMED_UNNAMED,
// ATTRIBUTION_NAMED, ATTRIBUTION_CONFIDENCE, NO_LIVE_IOC, NO_EXPLOIT_LINK, SECRET_LIKE, COMPUTED_MISMATCH (a
// T code: named tests on hand-built Briefs) and the SNAP_* soft gates (S fixtures, then dropUnverified()).
// Each rule gets passing and failing cases for its sub-conditions, run with only these four groups so another
// group's rule never masks a result; the F fixtures (fixtures/src/invalid/naming-safety-computed.ts) are
// checked against every registered rule at the end.
// Safety: no test holds a usable exploit, paste, leak-site or scanner URL (blocked hosts appear bare, other
// domains are reserved example domains), every secret-shaped string is joined from pieces at run time, and
// the scanner and payload samples are invented strings no scanner or shell would act on. Sample text is
// invented and marked SAMPLE where it stands alone.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INVALID_CASES, invalidDraft, invalidDraftProblems } from "@/fixtures/src/build";
import { WEEKDAY_ITEMS, weekdayDraft } from "@/fixtures/src/drafts";
import { draftInputs } from "@/fixtures/src/inputs";
import { namingSafetyComputedCases, sampleSecret } from "@/fixtures/src/invalid/naming-safety-computed";
import { NO_TEXT_URL, SOFT_CASES, softDraft, softDraftProblems } from "@/fixtures/src/soft";
import { REPO_ROOT } from "@/fixtures/src/world";
import { dropUnverified } from "@/lib/apply";
import { actorNexusOf, publicExploitOf } from "@/lib/items";
import {
  aiLinkedOf, computedIssues, computedRules, gapMetricsFor, lateOf, manifestFacts, READING_WORDS_PER_MINUTE, vendorConfirmedByOf,
} from "@/lib/rules/computed";
import {
  attributionCues, governmentWording, hasUnnamedClaimWording, namingRules, nexusMentions, unattributedRansom, unnamedClaimText,
} from "@/lib/rules/naming";
import {
  exploitLinkProblem, hasScannerQuery, isListedHost, listedHosts, liveIndicators, payloadsIn, safetyRules, SAFETY_CODES, secretsIn,
} from "@/lib/rules/safety";
import { foldQuote, quoteInText, snapshotRules } from "@/lib/rules/snapshots";
import type { CrossFile, Rule, RuleInput, ValidationIssue } from "@/lib/rules/types";
import { pageWords } from "@/lib/rules/words";
import type { Brief } from "@/lib/schema/brief";
import type { DraftBrief } from "@/lib/schema/draft-brief";
import type { CveBlock, DraftItem } from "@/lib/schema/item";
import type { InputsManifest, Metrics } from "@/lib/schema/metrics";
import { publisherFor } from "@/lib/sources";
import { ARCHIVE_WARNING_CODES, runRules, validateDraft } from "@/lib/validate";
import { UNNAMED_CLAIM } from "@/lib/vocab";

const MINE: readonly Rule[] = [...namingRules, ...safetyRules, ...computedRules, ...snapshotRules];
const I = WEEKDAY_ITEMS;
const config = draftInputs("weekday").config;

/** validateDraft() on a weekday draft with only `rules` (default: this part's). */
function check(draft: unknown, rules: readonly Rule[] = MINE) {
  return validateDraft(draft, { ...draftInputs("weekday"), rules });
}

const only = (r: { errors: ValidationIssue[] }, code: string) => r.errors.filter((e) => e.code === code);
const warns = (r: { warnings: ValidationIssue[] }, code: string) => r.warnings.filter((e) => e.code === code);
const idx = (d: { items: { id: string }[] }, id: string) => d.items.findIndex((it) => it.id === id);
const item = (d: DraftBrief, id: string): DraftItem => d.items[idx(d, id)]!;
const src = (d: { sources: { id: string }[] }, id: string) => d.sources.findIndex((s) => s.id === id);

/** A weekday draft changed by `fn`. */
function draftWith(fn: (d: DraftBrief) => void): DraftBrief {
  const d = weekdayDraft();
  fn(d);
  return d;
}

// ── Hand-built Briefs (published mode) ───────────────────────────────────────────────────────────

/** A CVE block for the Ivanti item, as publish would build it; `over` changes fields. */
function ivantiBlock(over: Partial<CveBlock> = {}): CveBlock {
  return {
    cve_id: "CVE-2026-104935", date_published: "2026-10-13", date_updated: "2026-10-13", assigner: "ivanti",
    vendor: { id: "ivanti", name: "Ivanti", country: "US" }, product: "Connect Secure", title: "SAMPLE: authentication bypass in Connect Secure",
    cvss: null, epss: null, ssvc: null,
    kev: { date_added: "2026-10-13", due_date: "2026-10-16", ransomware: "unknown", catalog_version: "2026.10.13" },
    credits: [], ai_credit: null, discovery_credit: null, advisory_date: "2026-10-13", patch: null, exploitation_evidence: [],
    exploit_reference: false, vendor_confirmed: true, vendor_confirmed_by: "vendor_cna", ghsa_ids: [], captured_at: "2026-10-13T20:30:00Z",
    ...over,
  } as CveBlock;
}

/** 05:12 Taipei on the weekday's date (before stale_after, 08:00). */
const PUBLISHED_AT = "2026-10-14T05:12:00+08:00";

/**
 * The weekday draft as a published Brief: every S field set as publish would (the sources' publisher fields
 * from publisherFor(), each item's actor_nexus and public_exploit, a CVE block on the Ivanti item, the
 * computed counts and word_count from pageWords()). `fn` changes it before `computed` is filled in, so a
 * test that changes the content still starts from matching counts; change `computed` after.
 */
function handBrief(fn?: (b: Brief) => void): Brief {
  const d = weekdayDraft();
  const { region_raises: _r, scoreboard_entries: _e, ...rest } = d;
  const sources = d.sources.map((s) => {
    const p = publisherFor(s.url, s.source_type, config);
    return { ...s, publisher: p.publisher, publisher_name: p.publisher_name, tier: p.tier, state_label: p.state_label, seen_as: "fetched" };
  });
  const items = d.items.map((it) => {
    const cves = it.id === I.criticalExploited ? [ivantiBlock()] : [];
    return {
      ...it, actor_nexus: actorNexusOf(it.attribution), first_seen: d.date, vendor: null, cves, release: null,
      public_exploit: publicExploitOf({ ...it, cves }), anthropic_disclosure: false, withheld: null,
    };
  });
  const lens = d.taiwan_lens;
  const b = {
    ...rest, edition: "full", published_at: PUBLISHED_AT, data_only_published_at: null, late: false, data_cutoff_utc: "2026-10-13",
    regions: { rows: [], global: { item_count: 0 }, signals: [] },
    gap: { headline: "SAMPLE gap headline", second_line: "SAMPLE second line", status: "missing", metrics_file: null, metrics_sha256: null, as_of: null },
    items, actors_seen: [],
    taiwan_lens: lens && {
      ...lens, kev_lines: { tw: { d30_n: 0, d90_n: 0, text: "SAMPLE" }, jp: { d30_n: 0, d90_n: 0, text: "SAMPLE" } },
      kev_note: "SAMPLE", watch_windows: [],
    },
    scoreboard: { entries: [], last: null }, epss_movers: [], feeds_stale: [], sources,
    computed: { word_count: 0, reading_minutes: 0, item_count: 0, ai_linked: { linked: 0, total: 0 }, source_count: 0, publisher_count: 0 },
  } as unknown as Brief;
  fn?.(b);
  b.computed = matchingComputed(b);
  return b;
}

/** The computed block code would write for `b` (its Gap shows no metrics file, or `metrics`). */
function matchingComputed(b: Brief, metrics: Metrics | null = null): Brief["computed"] {
  const words = pageWords(b, metrics);
  return {
    word_count: words, reading_minutes: Math.ceil(words / READING_WORDS_PER_MINUTE), item_count: b.items.length,
    ai_linked: aiLinkedOf(b.items), source_count: b.sources.length, publisher_count: new Set(b.sources.map((s) => s.publisher)).size,
  };
}

/** runRules() in published mode on a hand-built Brief. */
function runPublished(b: Brief, rules: readonly Rule[] = MINE, crossFile: CrossFile | null = null, metrics: Metrics | null = null) {
  const input: Omit<RuleInput, "derived"> = {
    draft: b, mode: "published", date: b.date, fileDate: b.date, metrics, config,
    context: null, evidence: null, cveList: null, regionsBase: null, packDates: null, crossFile,
  };
  const issues = runRules(input, [], rules);
  return { errors: issues.filter((i) => i.severity === "error"), warnings: issues.filter((i) => i.severity === "warning") };
}

/** computedIssues() on its own. */
const computed = (b: Brief, crossFile: CrossFile | null = null, metrics: Metrics | null = null) =>
  computedIssues(b, { metrics, config, crossFile });

const cross = (over: Partial<CrossFile> = {}): CrossFile => ({ publishing: false, inputs: null, briefs: [], ...over });
const paths = (xs: readonly ValidationIssue[]) => xs.map((x) => x.path);

// ── The valid drafts ─────────────────────────────────────────────────────────────────────────────

describe("valid drafts", () => {
  it("the weekday draft passes every rule in this part, with no warning", () => {
    const r = check(weekdayDraft());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("the hand-built weekday Brief passes every rule in this part in published mode, publishing or not", () => {
    expect(runPublished(handBrief()).errors).toEqual([]);
    expect(runPublished(handBrief(), MINE, cross({ publishing: true })).errors).toEqual([]);
  });
});

// ── VICTIM_STATUS ────────────────────────────────────────────────────────────────────────────────

describe("VICTIM_STATUS", () => {
  const status = (fn: (it: DraftItem, d: DraftBrief) => void) => only(check(draftWith((d) => fn(item(d, I.claimedVictim), d))), "VICTIM_STATUS");

  it("fails a breach with a null incident", () => {
    const e = status((it) => { it.incident = null; });
    expect(paths(e)).toEqual([`items[${idx(weekdayDraft(), I.claimedVictim)}].incident`]);
    expect(e[0]!.message).toMatch(/breach but incident is null/);
  });

  it("fails a confirmed incident backed only by a tier 2 newsroom", () => {
    const e = status((it) => { it.incident!.status = "confirmed"; });
    expect(e).toHaveLength(1);
    expect(e[0]!.path).toMatch(/\.incident\.status_source_ids$/);
    expect(e[0]!.message).toContain("s11");
  });

  it("fails a confirmed incident whose tier 1 source is not a victim, regulator or government source", () => {
    expect(status((it) => { it.incident!.status = "confirmed"; it.incident!.status_source_ids = ["s1"]; })).toHaveLength(1);
  });

  it("passes a confirmed incident with a tier 1 government source", () => {
    expect(status((it) => { it.incident!.status = "confirmed"; it.incident!.status_source_ids = ["s11", "s16"]; })).toEqual([]);
    expect(status((it) => { it.incident!.status = "confirmed"; it.incident!.status_source_ids = ["s18"]; })).toEqual([]);
  });

  it("passes a reported incident with a tier 2 newsroom and fails one without", () => {
    expect(status((it) => { it.incident!.status = "reported"; })).toEqual([]);
    const e = status((it) => { it.incident!.status = "reported"; it.incident!.status_source_ids = ["s1"]; });
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toMatch(/no tier 2 newsroom/);
  });

  it("leaves unknown status source ids to SOURCE_REF", () => {
    expect(status((it) => { it.incident!.status = "confirmed"; it.incident!.status_source_ids = ["s99"]; })).toEqual([]);
  });

  it("reads the stored tier in published mode", () => {
    const at = idx(weekdayDraft(), I.claimedVictim);
    const reported = (b: Brief) => { b.items[at]!.incident!.status = "reported"; };
    expect(only(runPublished(handBrief(reported)), "VICTIM_STATUS")).toEqual([]);
    const demoted = handBrief((b) => { reported(b); b.sources[src(b, "s11")]!.tier = 3; });
    expect(paths(only(runPublished(demoted), "VICTIM_STATUS"))).toEqual([`items[${at}].incident.status_source_ids`]);
  });

  it("fails a ransom amount nobody is said to report, and passes an attributed one", () => {
    const e = status((it) => { it.summary += " The group demands a ransom of $5 million."; });
    expect(e).toHaveLength(1);
    expect(e[0]!.path).toMatch(/\.summary$/);
    expect(e[0]!.message).toMatch(/ransom amount without saying who reports it/);
    expect(status((it) => { it.summary += " The group demands a ransom of $5 million, Security NEXT says."; })).toEqual([]);
  });

  it("matches ransom words, currency amounts and attributions", () => {
    expect(unattributedRansom("The group asked for a ransom of US$2.5m.")).toBe(true);
    expect(unattributedRansom("Ransomware operators want 40 bitcoin.")).toBe(true);
    expect(unattributedRansom("The attackers demanded NT$30 million in ransom.")).toBe(true);
    expect(unattributedRansom("The company paid a ransom of €2 million, according to Nikkei.")).toBe(false);
    expect(unattributedRansom("Police say the group asked for 2 million dollars in ransom.")).toBe(false);
    expect(unattributedRansom("The group posted a ransom note.")).toBe(false);
    expect(unattributedRansom("The breach cost $5 million to fix.")).toBe(false);
  });

  it("skips a withheld item's prose in published mode", () => {
    const at = idx(weekdayDraft(), I.claimedVictim);
    const ransom = (b: Brief) => { b.items[at]!.summary += " The group demands a ransom of $5 million."; };
    expect(only(runPublished(handBrief(ransom)), "VICTIM_STATUS")).toHaveLength(1);
    const withheld = handBrief((b) => { ransom(b); b.items[at]!.withheld = { correction_id: "C-0001", since: "2026-10-14" } as never; });
    expect(only(runPublished(withheld), "VICTIM_STATUS")).toEqual([]);
  });
});

// ── VICTIM_CLAIMED_UNNAMED ───────────────────────────────────────────────────────────────────────

describe("VICTIM_CLAIMED_UNNAMED", () => {
  const at = idx(weekdayDraft(), I.claimedVictim);
  const claimed = (fn: (d: DraftBrief) => void) => only(check(draftWith(fn)), "VICTIM_CLAIMED_UNNAMED");

  it("fails a claimed incident that names its victim", () => {
    const e = claimed((d) => { item(d, I.claimedVictim).incident!.victim = "SAMPLE Logistics Co."; });
    expect(paths(e)).toEqual([`items[${at}].incident.victim`]);
    expect(e[0]!.message).toContain("Set incident.victim to null");
  });

  it("fails a claimed incident among the top three stories", () => {
    const e = claimed((d) => {
      const [x] = d.items.splice(at, 1);
      d.items.splice(2, 0, x!);
    });
    expect(paths(e)).toEqual(["items[2]"]);
    expect(e[0]!.message).toMatch(/top story 3/);
  });

  it("fails a claimed incident above watch, and passes one at watch", () => {
    for (const sev of ["elevated", "high", "critical"] as const) {
      const e = claimed((d) => { item(d, I.claimedVictim).severity = sev; });
      expect(paths(e)).toEqual([`items[${at}].severity`]);
      expect(e[0]!.message).toContain(`"${sev}"`);
    }
    expect(claimed((d) => { item(d, I.claimedVictim).severity = "watch"; })).toEqual([]);
  });

  it("fails a claimed incident with no claimed_by", () => {
    const e = claimed((d) => { item(d, I.claimedVictim).incident!.claimed_by = null; });
    expect(paths(e)).toEqual([`items[${at}].incident.claimed_by`]);
  });

  it("fails a summary without the unnamed-claim wording and gives the wording to use", () => {
    const e = claimed((d) => { item(d, I.claimedVictim).summary = "Security NEXT reports a leak-site post naming a Japanese logistics company."; });
    expect(paths(e)).toEqual([`items[${at}].summary`]);
    expect(e[0]!.message).toContain("a Japanese logistics company, claimed by NightCrane, unverified");
  });

  it("leaves a reported or confirmed incident alone", () => {
    expect(claimed((d) => {
      const inc = item(d, I.claimedVictim).incident!;
      inc.status = "reported";
      inc.victim = "SAMPLE Logistics Co.";
    })).toEqual([]);
  });

  it("fills and recognises the UNNAMED_CLAIM wording", () => {
    expect(UNNAMED_CLAIM).toContain("{description}");
    expect(unnamedClaimText("a Japanese logistics company", "NightCrane")).toBe("a Japanese logistics company, claimed by NightCrane, unverified");
    expect(hasUnnamedClaimWording("A leak-site post names a firm, claimed by NightCrane, unverified.", "NightCrane")).toBe(true);
    expect(hasUnnamedClaimWording("A leak-site post names a firm, claimed by NightCrane.", "NightCrane")).toBe(false);
    expect(hasUnnamedClaimWording("A firm, claimed by another group, unverified.", "NightCrane")).toBe(false);
  });
});

// ── ATTRIBUTION_NAMED ────────────────────────────────────────────────────────────────────────────

describe("ATTRIBUTION_NAMED", () => {
  const at = idx(weekdayDraft(), I.chinaAxis);
  const named = (fn: (d: DraftBrief) => void) => only(check(draftWith(fn)), "ATTRIBUTION_NAMED");

  it("fails a nexus with a cue that doesn't name the attributor", () => {
    const e = named((d) => { item(d, I.chinaAxis).headline = "A China-nexus group phished Taiwanese chip equipment makers with fake invoices"; });
    expect(paths(e)).toEqual([`items[${at}].headline`]);
    expect(e[0]!.message).toContain("(TeamT5)");
    expect(e[0]!.message).toContain("China-nexus");
    expect(e[0]!.message).not.toMatch(/China, China-nexus/);
  });

  it("passes the same sentence naming the attributor, and a nexus word with no cue", () => {
    expect(named((d) => { item(d, I.chinaAxis).headline = "TeamT5 says a China-nexus group phished chip equipment makers"; })).toEqual([]);
    expect(named((d) => { item(d, I.chinaAxis).summary += " Chinese suppliers' invoice templates were copied."; })).toEqual([]);
  });

  it("treats a known actor name as a cue", () => {
    const e = named((d) => { item(d, I.chinaAxis).summary += " Paper Kestrel is tied to China."; });
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toContain('"Paper Kestrel"');
  });

  it("fails a nexus no attribution entry on the item supports", () => {
    const e = named((d) => { item(d, I.criticalExploited).summary += " Ivanti says a Russia-linked group was behind it."; });
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toMatch(/no attribution entry on this item has nexus "russia"/);
  });

  it("reads a Lead sentence against the items it cites", () => {
    const e = named((d) => { d.lead[0]!.text = "A China-nexus group exploited the Ivanti flaw, TeamT5 says."; });
    expect(paths(e)).toEqual(["lead[0].text"]);
    expect(e[0]!.message).toMatch(/on an item it cites/);
    expect(named((d) => { d.lead[0]!.item_ids.push(I.chinaAxis); d.lead[0]!.text = "A China-nexus group exploited the Ivanti flaw, TeamT5 says."; })).toEqual([]);
  });

  it("reads a raise reason against its item_ids", () => {
    const e = named((d) => { d.region_raises[0]!.reason = "TeamT5 says a China-nexus group exploited Ivanti gateways."; });
    expect(paths(e)).toEqual(["region_raises[0].reason"]);
  });

  it("reads a field tied to no item against every entry in the brief", () => {
    expect(named((d) => { d.angle.counterpoint = "TeamT5 says a China-nexus group is active too."; })).toEqual([]);
    expect(paths(named((d) => { d.angle.counterpoint = "A China-nexus group is active too."; }))).toEqual(["angle.counterpoint"]);
  });

  it("covers the generic state words with any state nexus", () => {
    expect(named((d) => { item(d, I.chinaAxis).summary += " TeamT5 calls the group state-sponsored."; })).toEqual([]);
    expect(named((d) => { item(d, I.chinaAxis).summary += " The group is state-sponsored."; })).toHaveLength(1);
  });

  it("needs \"<government> attributes\" or \"<government> says\" for a government's attribution", () => {
    const gov = (headline: string) => named((d) => {
      const it = item(d, I.chinaAxis);
      it.attribution[0]!.attributed_by = "SAMPLE Investigation Bureau";
      it.attribution[0]!.basis = "government";
      it.headline = headline;
    }).filter((e) => e.path === `items[${at}].headline`);
    expect(gov("SAMPLE Investigation Bureau attributes chip phishing to a China-nexus group")).toEqual([]);
    expect(gov("SAMPLE Investigation Bureau says a China-nexus group phished chip makers")).toEqual([]);
    const e = gov("A China-nexus group phished chip makers, per SAMPLE Investigation Bureau");
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toContain('"SAMPLE Investigation Bureau attributes"');
  });

  it("finds nexus words and cues", () => {
    expect(nexusMentions("a China nexus group").map((m) => m.term)).toContain("China-nexus");
    expect(nexusMentions("the north korean operators").map((m) => m.nexus)).toEqual(["dprk"]);
    expect(nexusMentions("a nation-state actor")[0]!.nexus).toBe("state");
    expect(nexusMentions("Chinatown")).toEqual([]);
    expect(attributionCues("APT41 hit them")).toEqual(["APT"]);
    expect(attributionCues("an apt reply")).toEqual([]);
    expect(attributionCues("the hackers attacked")).toEqual(["hacker", "attack"]);
    expect(attributionCues("Paper Kestrel struck", [{ name: "Paper Kestrel", forms: ["Paper Kestrel"] }])).toEqual(["Paper Kestrel"]);
    expect(governmentWording("The FBI says a group did it", "FBI")).toBe(true);
    expect(governmentWording("The FBI report names a group", "FBI")).toBe(false);
  });
});

// ── ATTRIBUTION_CONFIDENCE ───────────────────────────────────────────────────────────────────────

describe("ATTRIBUTION_CONFIDENCE", () => {
  const at = idx(weekdayDraft(), I.chinaAxis);
  const p = `items[${at}].attribution[0]`;
  const conf = (fn: (a: DraftItem["attribution"][number]) => void) =>
    only(check(draftWith((d) => fn(item(d, I.chinaAxis).attribution[0]!))), "ATTRIBUTION_CONFIDENCE");

  it("fails a low-confidence entry that names a sponsor and a nexus", () => {
    expect(paths(conf((a) => { a.confidence_level = "low"; }))).toEqual([`${p}.sponsor_claimed`, `${p}.nexus`]);
  });

  it("treats a low-confidence marker in confidence_text as low", () => {
    const e = conf((a) => { a.confidence_text = "low confidence"; });
    expect(paths(e)).toEqual([`${p}.sponsor_claimed`, `${p}.nexus`]);
    expect(e[0]!.message).toContain('confidence_text "low confidence"');
  });

  it("passes a low-confidence entry with no sponsor and nexus unknown", () => {
    expect(conf((a) => { a.confidence_level = "low"; a.confidence_text = "low confidence"; a.sponsor_claimed = null; a.nexus = "unknown"; })).toEqual([]);
  });

  it("fails a nexus with no sponsor", () => {
    expect(paths(conf((a) => { a.sponsor_claimed = null; }))).toEqual([`${p}.sponsor_claimed`]);
  });

  it("fails a stated confidence level with no confidence_text, and passes unstated", () => {
    expect(paths(conf((a) => { a.confidence_text = null; }))).toEqual([`${p}.confidence_text`]);
    expect(conf((a) => { a.confidence_text = null; a.confidence_level = "unstated"; })).toEqual([]);
  });
});

// ── NO_LIVE_IOC ──────────────────────────────────────────────────────────────────────────────────

describe("NO_LIVE_IOC", () => {
  const hosts = listedHosts(config);
  const kinds = (t: string) => liveIndicators(t, hosts).map((x) => x.kind);

  it("finds each live indicator kind once", () => {
    expect(kinds("lures from https://update.example.org/x.")).toEqual(["url"]);
    expect(kinds("mail sent from ops@example.com today")).toEqual(["email"]);
    expect(kinds("a site at ctsample.onion went up")).toEqual(["onion"]);
    expect(kinds("traffic to 192.0.2.10 was seen")).toEqual(["ipv4"]);
    expect(kinds("lures from update.example.org")).toEqual(["domain"]);
    expect(kinds("ftp://files.example.net and 198.51.100.7")).toEqual(["url", "ipv4"]);
  });

  it("passes defanged forms, listed domains, capitalised names and version numbers", () => {
    expect(kinds("hxxps://update[.]example[.]org, ops[@]example[.]com and 192[.]0[.]2[.]10")).toEqual([]);
    expect(kinds("BleepingComputer at bleepingcomputer.com and www.bleepingcomputer.com")).toEqual([]);
    expect(kinds("a flaw in support.microsoft.com pages")).toEqual([]);
    expect(kinds("Booking.com said so")).toEqual([]);
    expect(kinds("fixed in version 10.0.2.15 and firmware build 1.2.3.4")).toEqual([]);
    expect(kinds("an odd 999.1.1.1 string")).toEqual([]);
  });

  it("lists hosts from source-tiers.json and vendors.json without paths", () => {
    expect(hosts).toContain("edimax.com");
    expect(hosts.every((h) => !h.includes("/"))).toBe(true);
    expect(isListedHost("www3.nhk.or.jp", ["nhk.or.jp"])).toBe(true);
    expect(isListedHost("nhk.or.jp.example.org", ["nhk.or.jp"])).toBe(false);
  });

  it("fails a live domain in prose and shows it only defanged", () => {
    const at = idx(weekdayDraft(), I.claimedVictim);
    const e = only(check(draftWith((d) => { item(d, I.claimedVictim).summary += " The post links to leaks.example.org."; })), "NO_LIVE_IOC");
    expect(paths(e)).toEqual([`items[${at}].summary`]);
    expect(e[0]!.message).toContain("leaks[.]example[.]org");
    expect(e[0]!.message).not.toContain("leaks.example.org");
  });

  it("reads quoted fields and titles too", () => {
    const e = only(check(draftWith((d) => {
      d.scoreboard_entries[0]!.quote += " See 203.0.113.9.";
      d.sources[src(d, "s19")]!.title += " update.example.org";
    })), "NO_LIVE_IOC");
    expect(paths(e)).toEqual(["scoreboard_entries[0].quote", "sources[18].title"]);
  });

  it("runs on a published data-only brief, where the naming rules don't", () => {
    const b = handBrief((x) => {
      (x as { edition: string }).edition = "data_only";
      x.items[idx(x, I.chinaAxis)]!.headline = "A China-nexus group phished chip makers via update.example.org";
    });
    const r = runPublished(b);
    expect(only(r, "NO_LIVE_IOC")).toHaveLength(1);
    expect(only(r, "ATTRIBUTION_NAMED")).toEqual([]);
  });
});

// ── NO_EXPLOIT_LINK ──────────────────────────────────────────────────────────────────────────────

describe("NO_EXPLOIT_LINK", () => {
  const st = config.sourceTiers;

  it("names blocked hosts, code repositories and tier 3 exploit paths", () => {
    expect(exploitLinkProblem("https://www.exploit-db.com/", 3, st)).toMatch(/exploit archive or code host/);
    expect(exploitLinkProblem("https://pastebin.com/", 3, st)).toMatch(/paste or raw-file host/);
    expect(exploitLinkProblem("https://t.me/", 3, st)).toMatch(/messaging service/);
    expect(exploitLinkProblem("https://github.com/", 3, st)).toMatch(/code repositories are never cited/);
    expect(exploitLinkProblem("https://medium.com/ct-sample/poc", 3, st)).toMatch(/path holds "poc"/);
    expect(exploitLinkProblem("https://medium.com/ct-sample/exploits/notes", 3, st)).toMatch(/path holds "exploits"/);
  });

  it("passes advisory paths, tier 1 and 2 pages, other segments, redirects and archives", () => {
    expect(exploitLinkProblem("https://github.com/advisories/GHSA-ct00-samp-le00", 1, st)).toBeNull();
    expect(exploitLinkProblem("https://www.bleepingcomputer.com/ct-sample/poc", 2, st)).toBeNull();
    expect(exploitLinkProblem("https://medium.com/ct-sample/poc-notes", 3, st)).toBeNull();
    expect(exploitLinkProblem("https://news.google.com/", 3, st)).toBeNull();
    expect(exploitLinkProblem("https://web.archive.org/", 3, st)).toBeNull();
  });

  it("fails a cited source on a blocked host", () => {
    const e = only(check(draftWith((d) => { d.sources[src(d, "s13")]!.url = "https://www.exploit-db.com/"; })), "NO_EXPLOIT_LINK");
    expect(paths(e)).toEqual(["sources[12].url"]);
    expect(e[0]!.message).toContain("Remove s13");
  });

  it("finds code-like text and scanner queries, by pattern name only", () => {
    const fence = "`".repeat(3);
    expect(payloadsIn(`a ${fence} block`)).toEqual(["code fence"]);
    expect(payloadsIn(["..", "..", "etc"].join("/"))).toEqual(["path traversal"]);
    expect(payloadsIn("a plain sentence about a path traversal flaw")).toEqual([]);
    const query = ["SAMPLE: Shodan", "ctsample:none"].join(" ");
    expect(hasScannerQuery(query)).toBe(true);
    expect(hasScannerQuery("Shodan counts about 9,000 exposed hosts.")).toBe(false);
    expect(hasScannerQuery("Shodan counts hosts. See https://www.example.org/")).toBe(false);

    const at = idx(weekdayDraft(), I.taiwanVendor);
    const e = only(check(draftWith((d) => {
      const it = item(d, I.taiwanVendor);
      it.summary += ` Writers pasted a ${fence} block.`;
      it.headline = `${query} finds the routers`;
    })), "NO_EXPLOIT_LINK");
    expect(paths(e)).toEqual([`items[${at}].headline`, `items[${at}].summary`]);
    expect(e.find((x) => x.path.endsWith("summary"))!.message).toContain("(code fence)");
    expect(e.map((x) => x.message).join(" ")).not.toContain("ctsample:none");
  });

  it("checks a published Brief's other URL fields", () => {
    const b = handBrief((x) => { x.items[0]!.cves[0]!.patch = { date: "2026-10-13", basis: "vendor_advisory", source_url: "https://www.exploit-db.com/" }; });
    expect(paths(only(runPublished(b), "NO_EXPLOIT_LINK"))).toEqual(["items[0].cves[0].patch.source_url"]);
  });
});

// ── SECRET_LIKE ──────────────────────────────────────────────────────────────────────────────────

describe("SECRET_LIKE", () => {
  // Each sample is joined from pieces so no secret-shaped literal sits in this file.
  const join = (...parts: string[]) => parts.join("");
  const SAMPLES: [string, string][] = [
    ["an AWS access key id", join("AK", "IA", "CTSAMPLE", "00000000")],
    ["a GitHub token", join("gh", "p_", "CTSAMPLE".repeat(5))],
    ["a GitHub fine-grained token", join("github", "_pat_", "CTSAMPLE".repeat(3))],
    ["a Slack token", join("xo", "xb-", "CTSAMPLE-0000")],
    ["a Google API key", join("AI", "za", "CTSAMPLE".repeat(4), "000")],
    ["an sk- secret key", sampleSecret()],
    ["a private key block", join("-----BEGIN ", "PRIVATE", " KEY-----")],
  ];

  it.each(SAMPLES)("matches %s", (name, sample) => {
    expect(secretsIn(`SAMPLE text ${sample} here`)).toEqual([name]);
  });

  it("passes ordinary text", () => {
    expect(secretsIn("ask-me-anything and AKIA are words; risk-based triage")).toEqual([]);
  });

  it("fails any string, names the path and pattern, and never shows the match", () => {
    const secret = SAMPLES[0]![1];
    const e = only(check(draftWith((d) => { d.sources[src(d, "s13")]!.outlet += ` ${secret}`; })), "SECRET_LIKE");
    expect(paths(e)).toEqual(["sources[12].outlet"]);
    expect(e[0]!.message).toContain("an AWS access key id");
    expect(e[0]!.message).not.toContain(secret);
  });

  it("stays an error on archived briefs, where NO_LIVE_IOC and NO_EXPLOIT_LINK become warnings", () => {
    expect(SAFETY_CODES).toEqual(["NO_LIVE_IOC", "NO_EXPLOIT_LINK", "SECRET_LIKE"]);
    expect(ARCHIVE_WARNING_CODES).toEqual(expect.arrayContaining(["NO_LIVE_IOC", "NO_EXPLOIT_LINK"]));
    expect(ARCHIVE_WARNING_CODES).not.toContain("SECRET_LIKE");
  });

  it("keeps the fixture source free of the secret it generates", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, "fixtures/src/invalid/naming-safety-computed.ts"), "utf8");
    expect(secretsIn(text)).toEqual([]);
    expect(secretsIn(sampleSecret())).toEqual(["an sk- secret key"]);
  });
});

// ── COMPUTED_MISMATCH (T) ────────────────────────────────────────────────────────────────────────

describe("COMPUTED_MISMATCH", () => {
  it("never runs on a draft", () => {
    expect(check(weekdayDraft(), computedRules).errors).toEqual([]);
  });

  it("runs on a data-only brief", () => {
    const b = handBrief((x) => { (x as { edition: string }).edition = "data_only"; });
    b.computed.item_count += 1;
    expect(paths(only(runPublished(b, computedRules), "COMPUTED_MISMATCH"))).toEqual(["computed.item_count"]);
  });

  it("checks word_count against pageWords() and reading_minutes against it", () => {
    const b = handBrief();
    const words = b.computed.word_count;
    b.computed.word_count = words + 1;
    const e = computed(b);
    expect(paths(e)).toEqual(["computed.word_count"]);
    expect(e[0]!.message).toBe(`computed.word_count is ${words + 1} but code computes ${words} (pageWords(): the counted written fields plus the script-written page text).`);
    const c = handBrief();
    c.computed.reading_minutes += 1;
    expect(paths(computed(c))).toEqual(["computed.reading_minutes"]);
  });

  it("skips word_count when the Gap shows a metrics file it doesn't have, and checks reading_minutes against the stored count", () => {
    const b = handBrief((x) => { x.gap.metrics_file = "metrics/2026-10-13.json"; });
    b.computed.word_count = 476;
    b.computed.reading_minutes = 2;
    expect(computed(b)).toEqual([]);
    b.computed.reading_minutes = 3;
    expect(paths(computed(b))).toEqual(["computed.reading_minutes"]);
    const same = handBrief((x) => { x.gap.metrics_file = "metrics/2026-10-14.json"; });
    same.computed.word_count = 1;
    same.computed.reading_minutes = 1;
    expect(computed(same, null, null)).toEqual([]);
  });

  it("checks the counts and the AI-linked share", () => {
    const b = handBrief();
    b.computed.item_count = 7;
    b.computed.source_count = 18;
    b.computed.publisher_count = 19;
    b.computed.ai_linked = { linked: 0, total: 9 };
    expect(paths(computed(b))).toEqual([
      "computed.item_count", "computed.source_count", "computed.publisher_count", "computed.ai_linked.linked", "computed.ai_linked.total",
    ]);
    expect(aiLinkedOf(handBrief().items)).toEqual({ linked: 3, total: 8 });
  });

  it("checks each item's actor_nexus and public_exploit", () => {
    const china = idx(weekdayDraft(), I.chinaAxis);
    const edimax = idx(weekdayDraft(), I.taiwanVendor);
    const policy = idx(weekdayDraft(), I.landmark);
    const b = handBrief();
    b.items[china]!.actor_nexus = "russia";
    b.items[edimax]!.public_exploit = "no";
    b.items[policy]!.public_exploit = "no";
    const e = computed(b);
    expect(paths(e)).toEqual([`items[${china}].actor_nexus`, `items[${edimax}].public_exploit`, `items[${policy}].public_exploit`]);
    expect(e[0]!.message).toContain('is "russia" but code computes "prc"');
    expect(e[2]!.message).toContain("but code computes null");
  });

  it("counts an exploit reference in a CVE block as a public exploit", () => {
    const b = handBrief();
    b.items[0]!.cves[0]!.exploit_reference = true;
    expect(paths(computed(b))).toEqual(["items[0].public_exploit"]);
  });

  it("fails a first_seen after the brief's date only when validated alone", () => {
    const b = handBrief();
    b.items[1]!.first_seen = "2026-10-15";
    expect(paths(computed(b))).toEqual(["items[1].first_seen"]);
    expect(computed(b, cross())).toEqual([]);
  });

  it("checks vendor_confirmed against vendor_confirmed_by on every brief", () => {
    const b = handBrief();
    b.items[0]!.cves[0]!.vendor_confirmed = false;
    expect(paths(computed(b))).toEqual(["items[0].cves[0].vendor_confirmed"]);
  });

  it("checks late and vendor_confirmed_by only on the brief being published", () => {
    const b = handBrief((x) => { x.published_at = "2026-10-14T08:30:00+08:00"; });
    b.items[0]!.cves[0]!.vendor_confirmed_by = "vendor_advisory";
    expect(computed(b)).toEqual([]);
    const e = computed(b, cross({ publishing: true }));
    expect(paths(e)).toEqual(["late", "items[0].cves[0].vendor_confirmed_by"]);
    expect(e[1]!.message).toContain('is "vendor_advisory" but code computes "vendor_cna"');
  });

  it("computes vendor_confirmed_by from the cna list, then the vendor's domains, then accepts a reviewed GHSA", () => {
    const b = handBrief();
    const it0 = b.items[0]!;
    expect(vendorConfirmedByOf(b, it0, ivantiBlock(), config)).toBe("vendor_cna");
    expect(vendorConfirmedByOf(b, it0, ivantiBlock({ assigner: "mitre" }), config)).toBe("vendor_advisory");
    expect(vendorConfirmedByOf(b, { ...it0, flaw_evidence: [] }, ivantiBlock({ assigner: "mitre" }), config)).toBeNull();
    expect(vendorConfirmedByOf(b, it0, ivantiBlock({ vendor: { id: null, name: "SAMPLE", country: null } }), config)).toBeNull();

    const publishing = cross({ publishing: true });
    const ghsa = handBrief((x) => {
      x.items[0]!.flaw_evidence = [];
      x.items[0]!.cves[0] = ivantiBlock({ assigner: "mitre", vendor_confirmed_by: "ghsa_reviewed" });
    });
    expect(paths(computed(ghsa, publishing))).toEqual(["items[0].cves[0].vendor_confirmed_by"]);
    ghsa.items[0]!.cves[0]!.ghsa_ids = ["GHSA-ct00-samp-le00"];
    expect(computed(ghsa, publishing)).toEqual([]);
  });

  it("decides late against 08:00 Taipei on the brief's date", () => {
    const at = (t: string) => lateOf({ date: "2026-10-14", published_at: t }, config);
    expect(at("2026-10-14T08:00:00+08:00")).toBe(false);
    expect(at("2026-10-14T00:01:00Z")).toBe(true);
  });

  it("checks that sources sharing a publisher agree, on every brief", () => {
    const b = handBrief();
    const s5 = src(b, "s5");
    b.sources[s5]!.tier = 2;
    b.sources[s5]!.publisher_name = "SAMPLE";
    const e = computed(b);
    expect(paths(e)).toEqual([`sources[${s5}].publisher_name`, `sources[${s5}].tier`]);
    expect(e[1]!.message).toContain("s1 has the same publisher cve-org");
  });

  it("checks each source's publisher fields against the config only on the brief being published", () => {
    const b = handBrief();
    const s3 = src(b, "s3");
    b.sources[s3]!.tier = 1;
    b.sources[s3]!.state_label = "SAMPLE state media";
    expect(computed(b)).toEqual([]);
    expect(paths(computed(b, cross({ publishing: true })))).toEqual([`sources[${s3}].tier`, `sources[${s3}].state_label`]);
  });

  it("checks CVE block fields against the same-date inputs manifest", () => {
    const row = { cve_id: "CVE-2026-104935", kev_date_added: "2026-10-13", date_published: "2026-10-13", lag_days: 0, band: "at_disclosure" as const };
    const credit = {
      id: "CVE-2026-104935", published: "2026-10-13", finder_id: "ct-sample-finder", family: "other", kind: "lab", field: "credits",
      matched: "SAMPLE finder", rule: "credit",
    };
    const manifest = (over: Partial<InputsManifest> = {}) => ({
      window: { w26: [row], w13: [], reference_sha256: "0".repeat(64) },
      home_vendors: { tw: [], jp: [] },
      ai_credited: [],
      ...over,
    }) as unknown as InputsManifest;

    expect(computed(handBrief(), cross({ inputs: manifest() }))).toEqual([]);

    // Mutated before computed is filled in: the page shows the KEV date and the published date.
    const kev = handBrief((x) => { x.items[0]!.cves[0]!.kev = null; });
    expect(paths(computed(kev, cross({ inputs: manifest() })))).toEqual(["items[0].cves[0].kev"]);

    const pub = handBrief((x) => { x.items[0]!.cves[0]!.date_published = "2026-10-12"; });
    expect(paths(computed(pub, cross({ inputs: manifest() })))).toEqual(["items[0].cves[0].date_published"]);

    const homes = manifest({ home_vendors: { tw: [{ cve_id: "CVE-2026-104935", vendor_id: "edimax", date_added: "2026-10-13" }], jp: [] } as never });
    expect(paths(computed(handBrief(), cross({ inputs: homes })))).toEqual(["items[0].cves[0].vendor.id"]);

    const ai = manifest({ ai_credited: [credit] as never });
    expect(paths(computed(handBrief(), cross({ inputs: ai })))).toEqual(["items[0].cves[0].ai_credit"]);

    const facts = manifestFacts(ai, "CVE-2026-104935");
    expect(facts.kev_date_added).toEqual([{ value: "2026-10-13", from: "window.w26" }]);
    expect(facts.date_published.map((x) => x.from)).toEqual(["window.w26", "ai_credited"]);
    expect(manifestFacts(ai, "CVE-2026-00001").ai_credit).toEqual([]);
  });

  it("maps the Gap's metrics file to the metrics the page counts against", () => {
    const m = {} as Metrics;
    const gap = (f: string | null) => ({ date: "2026-10-14", gap: { metrics_file: f } }) as unknown as Brief;
    expect(gapMetricsFor(gap(null), m)).toBeNull();
    expect(gapMetricsFor(gap("metrics/2026-10-14.json"), m)).toBe(m);
    expect(gapMetricsFor(gap("metrics/2026-10-14.json"), null)).toBeUndefined();
    expect(gapMetricsFor(gap("metrics/2026-10-13.json"), m)).toBeUndefined();
  });
});

// ── Snapshot soft gates (S) ──────────────────────────────────────────────────────────────────────

describe("snapshot soft gates", () => {
  it("each S fixture gives no error and exactly its own warning", () => {
    expect(softDraftProblems()).toEqual([]);
    for (const c of SOFT_CASES) {
      const d = softDraft(c);
      const r = check(d);
      expect(r.errors).toEqual([]);
      expect(r.warnings.map((w) => `${w.code} ${w.path}`)).toEqual([`${c.code} ${c.path(d)}`]);
    }
  });

  it("SNAP_NUMBER checks the Angle's text against its sources, and skips NONE_FOUND", () => {
    const r = check(draftWith((d) => { d.angle.text = "Red Hat has credited AISLE with 25 flaws since 1 October."; }));
    const w = warns(r, "SNAP_NUMBER");
    expect(paths(w)).toEqual(["angle.text"]);
    expect(w[0]!.message).toContain("holds 25");
  });

  it("SNAP_MISSING marks an Angle whose source has no seen text", () => {
    const r = check(draftWith((d) => { d.sources[src(d, "s13")]!.url = NO_TEXT_URL; }));
    expect(paths(warns(r, "SNAP_MISSING"))).toContain("angle.source_id");
  });

  it("SNAP_MISSING on a Critical item says it will be dropped", () => {
    const r = check(draftWith((d) => {
      for (const id of item(d, I.criticalExploited).source_ids) d.sources[src(d, id)]!.url = `https://www.example.org/ct-sample/not-fetched-${id}`;
    }));
    const w = warns(r, "SNAP_MISSING").filter((x) => x.path === "items[0].source_ids");
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toMatch(/A Critical item is dropped/);
    expect(warns(r, "SNAP_NUMBER").filter((x) => x.path.startsWith("items[0]"))).toEqual([]);
  });

  it("SNAP_QUOTE checks a Scoreboard entry's quote against its own source", () => {
    const r = check(draftWith((d) => { d.scoreboard_entries[0]!.quote = d.scoreboard_entries[0]!.quote.replace("not yet", "never"); }));
    expect(paths(warns(r, "SNAP_QUOTE"))).toEqual(["scoreboard_entries[0].quote"]);
  });

  it("folds quotes for comparison", () => {
    expect(foldQuote("  “Moderate   Confidence”  ")).toBe("moderate confidence");
    expect(foldQuote("「ＡＢＣ」 it's")).toBe("abc its");
    expect(quoteInText("We HAVE not yet seen", "Officials said: “we have not yet seen it”.")).toBe(true);
    expect(quoteInText("", "anything")).toBe(false);
    expect(quoteInText("we have seen", "we have not yet seen")).toBe(false);
  });

  it("does not run on a published brief", () => {
    expect(runPublished(handBrief(), snapshotRules).warnings).toEqual([]);
  });
});

// ── dropUnverified() on the S fixtures ───────────────────────────────────────────────────────────

describe("dropUnverified() on the S fixtures", () => {
  const dropped = (code: string) => {
    const c = SOFT_CASES.find((x) => x.code === code)!;
    const d = softDraft(c);
    return { before: d, ...dropUnverified(d, check(d).warnings) };
  };

  it.each([
    ["SNAP_NUMBER", I.aiConfirmed],
    ["SNAP_NAME", I.taiwanVendor],
    ["SNAP_QUOTE", I.chinaAxis],
  ])("%s drops the item it is on, and its ids everywhere", (code, id) => {
    const { before, draft, report } = dropped(code);
    expect(draft.items.map((it) => it.id)).toEqual(before.items.map((it) => it.id).filter((x) => x !== id));
    expect(report.items.map((x) => x.id)).toEqual([id]);
    expect(report.items[0]!.codes).toEqual([code]);
    const ids = [...draft.lead.flatMap((l) => l.item_ids), ...draft.taiwan_lens.item_ids, ...draft.region_raises.flatMap((r) => r.item_ids)];
    expect(ids).not.toContain(id);
    expect(draft.sources).toHaveLength(before.sources.length);
    expect(draft.angle).not.toBeNull();
  });

  it("SNAP_MISSING keeps a non-critical item", () => {
    const { before, draft, report } = dropped("SNAP_MISSING");
    expect(draft.items).toHaveLength(before.items.length);
    expect(report.items).toEqual([]);
  });

  it("SNAP_MISSING drops a Critical item", () => {
    const d = weekdayDraft();
    const { draft, report } = dropUnverified(d, [{ code: "SNAP_MISSING", path: "items[0].source_ids" }]);
    expect(draft.items.map((it) => it.id)).not.toContain(I.criticalExploited);
    expect(report.items.map((x) => x.id)).toEqual([I.criticalExploited]);
  });

  it("drops the Angle for any SNAP code on it, and a Scoreboard entry for SNAP_QUOTE", () => {
    const d = draftWith((x) => {
      x.angle.text = "Red Hat has credited AISLE with 25 flaws since 1 October.";
      x.scoreboard_entries[0]!.quote = x.scoreboard_entries[0]!.quote.replace("not yet", "never");
    });
    const { draft, report } = dropUnverified(d, check(d).warnings);
    expect(draft.angle).toBeNull();
    expect(report.angle?.codes).toEqual(["SNAP_NUMBER"]);
    expect(draft.scoreboard_entries).toEqual([]);
    expect(report.scoreboard_entries.map((x) => x.claim_id)).toEqual(["SB-02"]);
    expect(draft.items).toHaveLength(d.items.length);
  });
});

// ── The F fixtures ───────────────────────────────────────────────────────────────────────────────

describe("F fixtures (naming, safety)", () => {
  it("lists one case per hard code a draft can trigger, each registered in the builder", () => {
    expect(namingSafetyComputedCases.map((c) => c.code)).toEqual([
      "VICTIM_STATUS", "VICTIM_CLAIMED_UNNAMED", "ATTRIBUTION_NAMED", "ATTRIBUTION_CONFIDENCE", "NO_LIVE_IOC", "NO_EXPLOIT_LINK", "SECRET_LIKE",
    ]);
    for (const c of namingSafetyComputedCases) {
      expect(c.file).toBe(`invalid--${c.code}.json`);
      expect(INVALID_CASES).toContain(c);
    }
  });

  it.each(namingSafetyComputedCases.map((c) => [c.code, c] as const))("%s fails with exactly its own code against every rule", (code, c) => {
    const r = validateDraft(invalidDraft(c), draftInputs("weekday"));
    expect(r.errors.length).toBeGreaterThan(0);
    expect([...new Set(r.errors.map((e) => e.code))]).toEqual([code]);
    expect(r.warnings).toEqual([]);
  });

  it("the builder reports no problem with them", () => {
    const mine = new Set(namingSafetyComputedCases.map((c) => c.file));
    expect(invalidDraftProblems().filter((p) => mine.has(p.split(":")[0]!))).toEqual([]);
  });
});
