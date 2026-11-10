// composeWithholds() (SPEC §4.10 "The one exception: withholding", §8.9 intake step 4; plan L3, C4 to C6):
// the 2026-10-12 brief as first published, rebuilt with applyDraft() from the Monday world, then withheld
// on D-0001 the way site-content holds it; attribution disputes; marks in later stored briefs.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyDraft, type ApplyInput, type CveFacts } from "@/lib/apply";
import { addDays } from "@/lib/dates";
import { actorNexusOf } from "@/lib/items";
import { sha256Hex } from "@/lib/json";
import { regionsConfig } from "@/lib/regions";
import { Brief } from "@/lib/schema/brief";
import { AgentContext } from "@/lib/schema/context";
import { DraftBrief } from "@/lib/schema/draft-brief";
import { InputsManifest, Metrics, type KevIndexFile } from "@/lib/schema/metrics";
import { ArchiveIndex, CorrectionsFile, Evidence, type Dispute } from "@/lib/schema/misc";
import { ScoreboardFile } from "@/lib/schema/scoreboard";
import { cveLookupFromDir, validatePublished } from "@/lib/validate";
import { WITHHELD_HEADLINE, WITHHELD_MARK } from "@/lib/vocab";
import { WITHHOLD_TEXTS, composeWithholds, type WithholdInput, type WithholdRequest } from "@/lib/withhold";
import { CVE_RECORDS_DIR, editionRegionsInput, fixtureConfig } from "@/fixtures/src/inputs";
import { EDITIONS, FIXTURES_DIR, KEV_DUE, KEV_ROWS, RECORD_IDS, cveRecord } from "@/fixtures/src/world";

const SITE = path.join(FIXTURES_DIR, "site-content");
const read = (p: string): unknown => JSON.parse(fs.readFileSync(p, "utf8"));
const cfg = fixtureConfig();
const BRIEFS = fs.readdirSync(path.join(SITE, "briefs")).sort().map((f) => Brief.parse(read(path.join(SITE, "briefs", f))));
const golden = (date: string) => structuredClone(BRIEFS.find((b) => b.date === date)!);
const GOLDEN_CORRECTIONS = CorrectionsFile.parse(read(path.join(SITE, "corrections.json")));
const GOLDEN_ARCHIVE = ArchiveIndex.parse(read(path.join(SITE, "archive-index.json")));
const metricsFor = (date: string): Metrics | null => {
  const p = path.join(SITE, "metrics", `${date}.json`);
  return fs.existsSync(p) ? Metrics.parse(read(p)) : null;
};
const BREACH = "inc-health-us-2026-10";

function kevIndexAt(version: string): KevIndexFile {
  const through = version.replace(/\./g, "-");
  return { schema_version: 1, updated_at: through, catalog_version: version, entries: KEV_ROWS.filter((r) => r[1] <= through).map((r) => [...r] as KevIndexFile["entries"][number]) };
}

/** The Monday world as publish saw it on 12 October (plan C4): no corrections or disputes yet. */
function mondayWorld(): ApplyInput {
  const t = EDITIONS.monday;
  const D = t.date;
  const mText = fs.readFileSync(path.join(SITE, "metrics", `${D}.json`), "utf8");
  const kevIndex = kevIndexAt(t.kev.version);
  const history = BRIEFS.filter((b) => b.date < D).reverse();
  const board = ScoreboardFile.parse(read(path.join(SITE, "scoreboard.json")));
  const entries = board.entries.filter((e) => e.date < D);
  const facts: CveFacts = {
    record: (id) => (RECORD_IDS.includes(id) ? cveRecord(id) : null),
    kev: (id) => {
      const r = kevIndex.entries.find((x) => x[0] === id);
      return r ? { dateAdded: r[1], dueDate: KEV_DUE[id] ?? addDays(r[1], 21), ransomware: r[6], catalogVersion: t.kev.version } : null;
    },
    epss: () => null,
    ghsaIds: () => [],
  };
  const archive: ArchiveIndex = { schema_version: 1, editions: GOLDEN_ARCHIVE.editions.filter((e) => e.date < D), urls: {} };
  for (const [u, e] of Object.entries(GOLDEN_ARCHIVE.urls)) {
    if (e.first_cited < D) archive.urls[u] = { ...structuredClone(e), item_ids: e.item_ids.filter((x) => x.slice(0, 10) < D) };
  }
  const snapshots: Record<string, { sha256: string; fetched_at: string }> = {};
  for (const [u, e] of Object.entries(GOLDEN_ARCHIVE.urls)) {
    if (e.first_cited === D && e.sha256 && e.hashed_at) snapshots[u] = { sha256: e.sha256, fetched_at: e.hashed_at };
  }
  return {
    date: D, config: cfg, metrics: Metrics.parse(JSON.parse(mText)), kevIndex, history,
    regionsBase: { date: D, history, signals: editionRegionsInput("monday").signals, kevIndex, config: regionsConfig(cfg) },
    archiveIndex: archive,
    scoreboard: { ...board, as_of: addDays(D, -1), entries, claims: board.claims.map((c) => ({ ...c, last_entry_id: [...entries].reverse().find((e) => e.claim_id === c.id)?.id ?? null })) },
    corrections: null, feedsStale: [], publishedAt: "2026-10-12T05:05:52+08:00", generatedAt: t.generatedAt,
    edition: "full",
    draft: DraftBrief.parse(read(path.join(FIXTURES_DIR, "drafts", "valid-monday.json"))),
    context: AgentContext.parse(read(path.join(FIXTURES_DIR, "context", "monday.json"))),
    evidence: Evidence.parse(read(path.join(FIXTURES_DIR, "evidence", "monday.json"))),
    cveList: cveLookupFromDir(CVE_RECORDS_DIR),
    snapshots, dataOnlyPublishedAt: "2026-10-12T04:47:55+08:00", disputes: null, recheck: null, facts,
    inputs: InputsManifest.parse(read(path.join(SITE, "metrics", "inputs", `${D}.json`))), metricsSha256: sha256Hex(mText),
  };
}

const MONDAY = applyDraft(mondayWorld());
/** D-0001 as intake records it on 13 October, before the withhold gives it a correction. */
const D1: Dispute = { ...GOLDEN_CORRECTIONS.disputes[0]!, correction_id: null };
const victimRequest: WithholdRequest = { item_id: BREACH, edition_date: "2026-10-12", kind: "victim", dispute_id: "D-0001", since: "2026-10-13" };

function input(briefs: Brief[], requests: WithholdRequest[], disputes: Dispute[] = [D1]): WithholdInput {
  return { date: "2026-10-13", config: cfg, briefs, corrections: null, disputes, archiveIndex: MONDAY.archiveIndex, metricsFor, requests };
}

describe("composeWithholds", { timeout: 120_000 }, () => {
  it("C4: a victim dispute on the 2026-10-12 item reproduces that brief, C-0001 and D-0001", () => {
    const before = MONDAY.brief!;
    expect(before.items.find((it) => it.id === BREACH)!.incident!.victim).not.toBeNull();
    const out = composeWithholds(input([before], [victimRequest]));
    expect(out.brief).toBeNull();
    expect(out.scoreboard).toBeNull();
    expect(out.rewritten).toEqual([golden("2026-10-12")]);
    const c1 = GOLDEN_CORRECTIONS.corrections.find((c) => c.id === "C-0001")!;
    // The sample's reason is SAMPLE text; publish writes the fixed victim reason.
    expect(out.corrections!.corrections).toEqual([{ ...c1, reason: WITHHOLD_TEXTS.victim.reason }]);
    expect(out.corrections!.disputes).toEqual(GOLDEN_CORRECTIONS.disputes);
    expect(out.archiveIndex.editions.find((e) => e.date === "2026-10-12")?.corrected).toBe(true);
    expect(validatePublished(out.rewritten[0], { metrics: metricsFor("2026-10-12"), config: cfg }).errors).toEqual([]);
    // The input briefs are never changed.
    expect(before.items.find((it) => it.id === BREACH)!.headline).not.toBe(WITHHELD_HEADLINE);
  });

  it("C4: correction ids continue after the stored ones; an unknown item is skipped", () => {
    const stored = { ...GOLDEN_CORRECTIONS, corrections: GOLDEN_CORRECTIONS.corrections.filter((c) => c.id === "C-0002") };
    const out = composeWithholds({ ...input([MONDAY.brief!], [victimRequest, { ...victimRequest, item_id: "no-such-item", dispute_id: "D-0009" }]), corrections: stored });
    expect(out.corrections!.corrections.map((c) => c.id)).toEqual(["C-0002", "C-0003"]);
    expect(out.corrections!.disputes[0]!.correction_id).toBe("C-0003");
    expect(composeWithholds(input([MONDAY.brief!], [{ ...victimRequest, item_id: "no-such-item" }])).corrections).toBeNull();
  });

  it("C5: an attribution withhold empties attribution, nulls actor_nexus, drops the actor chip and keeps the victim", () => {
    const b = structuredClone(MONDAY.brief!);
    const camp = b.items.find((it) => it.attribution.length > 0)!;
    const req: WithholdRequest = { item_id: camp.id, edition_date: "2026-10-12", kind: "attribution", dispute_id: "D-0002", since: "2026-10-13" };
    const d2: Dispute = { ...D1, id: "D-0002", issue_number: 4, item_id: camp.id, kind: "attribution" };
    const out = composeWithholds(input([b], [req], [D1, d2]));
    const it = out.rewritten[0]!.items.find((x) => x.id === camp.id)!;
    expect([it.attribution, it.actor_nexus, it.headline, it.why_it_matters]).toEqual([[], null, WITHHELD_HEADLINE, null]);
    expect(it.withheld).toEqual({ correction_id: "C-0001", since: "2026-10-13" });
    expect(it.incident).toEqual(camp.incident);
    expect(out.rewritten[0]!.actors_seen.some((a) => a.item_ids.includes(camp.id))).toBe(false);
    expect(out.corrections!.corrections[0]).toMatchObject({ field: "attribution", type: "name_removed", before: "[name removed]", after: WITHHOLD_TEXTS.attribution.after, dispute_id: "D-0002" });
    expect(out.corrections!.disputes.map((d) => [d.id, d.correction_id])).toEqual([["D-0001", null], ["D-0002", "C-0001"]]);
    expect(validatePublished(out.rewritten[0], { metrics: metricsFor("2026-10-12"), config: cfg }).errors).toEqual([]);

    // An item with both a named victim and an attribution keeps the victim.
    const both = structuredClone(MONDAY.brief!);
    const breach = both.items.find((x) => x.id === BREACH)!;
    breach.attribution = structuredClone(camp.attribution);
    breach.actor_nexus = actorNexusOf(breach.attribution);
    const victim = breach.incident!.victim;
    const kept = composeWithholds(input([both], [{ ...req, item_id: BREACH }])).rewritten[0]!.items.find((x) => x.id === BREACH)!;
    expect([kept.attribution, kept.actor_nexus, kept.incident!.victim]).toEqual([[], null, victim]);
  });

  it("C6: a withhold marks region and raise reasons in later stored briefs and rewrites every brief holding the item", () => {
    const later = [golden("2026-10-13"), golden("2026-10-14"), golden("2026-10-15")];
    const us = (b: Brief) => b.regions.rows.find((r) => r.code === "US")!;
    for (const b of later) expect(us(b).reason).toBe("Confirmed breach in United States: Item under review");
    // A raise that lists the item gets its reason marked too.
    const raised = us(later[0]!);
    raised.raised = { from: "high", to: "critical", reason: "SAMPLE raise naming the breach.", trigger_class: "confirmed_breach", item_ids: [BREACH] };
    const out = composeWithholds(input([MONDAY.brief!, ...later], [victimRequest]));
    expect(out.rewritten.map((b) => b.date)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]);
    for (const b of out.rewritten.slice(1)) {
      expect(us(b).reason).toBe(WITHHELD_MARK);
      expect(b.items.find((it) => it.id === BREACH)).toBeUndefined();
    }
    expect(us(out.rewritten[1]!).raised!.reason).toBe(WITHHELD_MARK);
    // A raise that does not list the item keeps its reason.
    expect(us(out.rewritten[2]!).raised!.reason).toBe(us(golden("2026-10-14")).raised!.reason);
    expect(out.rewritten[0]).toEqual(golden("2026-10-12"));
    for (const b of out.rewritten.slice(2)) {
      expect(validatePublished(b, { metrics: metricsFor(b.date), config: cfg }).errors).toEqual([]);
    }
    // A brief neither holding nor listing the item is not rewritten.
    expect(composeWithholds(input([MONDAY.brief!, golden("2026-10-11")], [victimRequest])).rewritten.map((b) => b.date)).toEqual(["2026-10-12"]);
  });
});
