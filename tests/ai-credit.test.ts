// AI-credited (SPEC §5.5, Appendix D.7): matching on sanitised credit strings, the two credit state files,
// the list-change and ledger rules, and the metrics values. Inline strings carry no person's name; the
// trimmed real records in fixtures/ai-credit/records/ had every name replaced ("SAMPLE Researcher") and
// every link moved to example.com. The D.7 totals themselves are checked from fixtures/reference/ by
// tests/reference.test.ts (P2 WP5). No content/ and no network.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, type CompiledAiFinders } from "@/lib/config";
import { addDays, isoWeekStart, utcDateOf } from "@/lib/dates";
import type { CreditString } from "@/lib/feeds/types";
import { jsonText, sha256Hex } from "@/lib/json";
import {
  AI_NOTES, CREDIT_FIELD_ORDER, GHSA_CREDIT_SOURCE, LEDGER_MATCHED, aiCreditFor, aiCredited, aiFindersOf, aiManifestRows, aiWeekly,
  applyLedger, baseRate, buildCredits, creditListStatus, creditText, creditTexts, matchCredit, matchRecord, prefilterSha256, recomputeCredits,
  updateCredits, type AiFindersRun, type CreditRecord, type CreditState, type GhsaCreditSource,
} from "@/lib/metrics/ai-credit";
import { poissonCi80, round4 } from "@/lib/metrics/stats";
import { sanitize } from "@/lib/sanitize";
import { AiCredited, AiCreditsFile, BaseRate, CreditCandidatesFile, InputsManifest, type AiCreditRow, type DayRow, type KevIndexRow } from "@/lib/schema/metrics";

const root = path.join(__dirname, "..");
const config = loadConfig({ root, fresh: true });
const run: AiFindersRun = aiFindersOf(config, config.compiled);
const cfg: CompiledAiFinders = run.compiled;
const CUTOFF = "2026-11-06";
const NO_LEDGER = { cveIds: [], published: new Map<string, string>() };

/** A CreditRecord from a CVE JSON 5 record: CNA credits in array order, then each ADP entry's. */
function creditRecordOf(raw: unknown): CreditRecord {
  const j = raw as {
    cveMetadata: { cveId: string; state: string; datePublished?: string };
    containers: { cna?: { credits?: { value: string }[] }; adp?: { credits?: { value: string }[] }[] };
  };
  const credits: CreditString[] = [
    ...(j.containers.cna?.credits ?? []).map((c) => ({ field: "cna.credits" as const, value: c.value })),
    ...(j.containers.adp ?? []).flatMap((a) => (a.credits ?? []).map((c) => ({ field: "adp.credits" as const, value: c.value }))),
  ];
  const dp = j.cveMetadata.datePublished;
  return { cve_id: j.cveMetadata.cveId, state: j.cveMetadata.state, date_published: dp ? utcDateOf(dp) : null, credits };
}

function readRecords(dir: string): CreditRecord[] {
  const abs = path.join(root, dir);
  return fs.readdirSync(abs).filter((f) => f.endsWith(".json")).sort()
    .map((f) => creditRecordOf(JSON.parse(fs.readFileSync(path.join(abs, f), "utf8"))));
}

const FIXTURE_RECORDS = readRecords("fixtures/ai-credit/records");
const P1_RECORDS = readRecords("fixtures/cvelist/records");
const fixture = (id: string) => FIXTURE_RECORDS.find((r) => r.cve_id === id)!;

const cna = (...values: string[]): CreditString[] => values.map((value) => ({ field: "cna.credits", value }));
const adp = (...values: string[]): CreditString[] => values.map((value) => ({ field: "adp.credits", value }));
const rec = (cve_id: string, date_published: string | null, credits: CreditString[], state = "PUBLISHED"): CreditRecord =>
  ({ cve_id, state, date_published, credits });
const kevRow = (id: string, added: string, published: string | null): KevIndexRow => [id, added, "Example", "Product", published, "example", "unknown"];
const day = (date: string, n: number): DayRow => [date, n, 0, 0, sha256Hex("")];
const matchOf = (s: string) => matchCredit(sanitize(s), cfg);

// ── Matching ─────────────────────────────────────────────────────────────────────────────────────

describe("matchCredit on sanitised strings (§5.5, B.2 examples)", () => {
  const finders = config.aiFinders.finders;

  it("matches every examples.match string to its own finder and no examples.no_match string, sanitised", () => {
    for (const f of finders) {
      for (const s of f.examples.match) expect(matchRecord(rec("CVE-2026-1000", CUTOFF, cna(s)), null, cfg)?.finder_id, s).toBe(f.id);
      for (const s of f.examples.no_match) expect(matchRecord(rec("CVE-2026-1000", CUTOFF, cna(s)), null, cfg), s).toBeNull();
    }
  });

  it("prefilter accepts every examples.match string (raw and sanitised)", () => {
    for (const s of finders.flatMap((f) => f.examples.match)) {
      expect(cfg.prefilterRe.test(s), s).toBe(true);
      expect(cfg.prefilterRe.test(sanitize(s)), s).toBe(true);
    }
  });

  it("gives every example the same result raw and sanitised (ruling R3)", () => {
    for (const s of finders.flatMap((f) => [...f.examples.match, ...f.examples.no_match])) {
      expect(matchCredit(sanitize(s), cfg), s).toEqual(matchCredit(s, cfg));
    }
  });

  it("matches none of D.7's must-not-match credits", () => {
    for (const s of ["OpenAI", "Wiz", "hacktron.ai", "Hacktron AI", "Horizon3.ai", "striga.ai", "Google Threat Intelligence Group", "Google/Mandiant",
      "Anthropic", "SAMPLE Researcher of OpenAI", "Protect AI", "huntr.dev"]) {
      expect(matchOf(s), s).toBeNull();
    }
    expect(matchRecord(fixture("CVE-2026-109618"), null, cfg)).toBeNull(); // the PHP2Shell credit list: "OpenAI" alone, "Wiz"
  });

  it("keeps the strip fix: Claude Security, Claude Security Scans and Claude Agents match; a person called Claude does not", () => {
    for (const s of ["Claude Security", "Claude Security Scans", "The ASF using Claude Agents"]) {
      expect(matchOf(s), s).toMatchObject({ finder_id: "anthropic-claude", family: "anthropic", rule: "pattern", matched: "Claude" });
    }
    expect(matchOf("Claude Dupont of Example Labs")).toBeNull();
    expect(matchOf("Jean-Claude Martin")).toBeNull();
    expect(matchRecord(fixture("CVE-2026-102731"), null, cfg)).toMatchObject({ finder_id: "anthropic-claude", matched: "Claude", field: "cna.credits" });
    expect(matchRecord(fixture("CVE-2026-82427"), null, cfg)).toMatchObject({ finder_id: "anthropic-claude", matched: "Claude" });
  });

  it("matches list v2's additions (ruling R2): Aisle Research, Aisle.com and Team-Atlanta, case-sensitive for AISLE", () => {
    expect(matchOf("Aisle Research")).toMatchObject({ finder_id: "aisle", family: "other", matched: "Aisle Research" });
    expect(matchOf("SAMPLE Researcher (Aisle.com)")).toMatchObject({ finder_id: "aisle", matched: "Aisle.com" });
    expect(matchOf("Found by AISLE")).toMatchObject({ finder_id: "aisle", matched: "AISLE" });
    expect(matchOf("SAMPLE Researcher (Team-Atlanta and Example University)")).toMatchObject({ finder_id: "aixcc", matched: "Team-Atlanta" });
    expect(matchOf("Team Atlanta (AIxCC)")).toMatchObject({ finder_id: "aixcc" });
    expect(matchOf("aisle research")).toBeNull();
    expect(matchRecord(fixture("CVE-2026-109832"), null, cfg)).toMatchObject({ finder_id: "aisle", matched: "Aisle Research" });
  });

  it("matches the lab only beside a tool word, and Anthropic disclosure ids by the case-sensitive pattern", () => {
    expect(matchRecord(fixture("CVE-2026-93302"), null, cfg)).toMatchObject({ finder_id: "anthropic-claude", rule: "lab_context", matched: "Anthropic" });
    expect(matchOf("Anthropic Research")).toBeNull();
    const ant = matchRecord(fixture("CVE-2026-119776"), null, cfg);
    expect(ant).toMatchObject({ finder_id: "anthropic-claude", rule: "pattern", matched: "ANT-2026-N0E1INIV", field: "cna.credits" });
    expect(matchOf("ant-2026-n0e1iniv")).toBeNull();
  });

  it("does not match a credit that is only a URL once sanitised (ruling R1), though the raw string would", () => {
    const r = fixture("CVE-2026-59774");
    expect(r.credits.every((c) => /^https:\/\/example\.com\//.test(c.value))).toBe(true);
    expect(matchCredit(r.credits[1]!.value, cfg)).toMatchObject({ finder_id: "xbow" }); // raw: "xbow" in the path
    expect(creditTexts(r, null).map((t) => t.text)).toEqual(["[link]", "[link]", "[link]"]);
    expect(matchRecord(r, null, cfg)).toBeNull();
  });

  it("finds CVE-2026-111497's Codex Security credit (D.7 in_kev)", () => {
    expect(matchRecord(fixture("CVE-2026-111497"), null, cfg)).toEqual({
      finder_id: "openai-codex", family: "openai", kind: "ai_system", rule: "pattern", matched: "Codex Security", field: "cna.credits",
    });
  });

  it("stores only the matched substring, never the credit line", () => {
    for (const r of FIXTURE_RECORDS) {
      const h = matchRecord(r, null, cfg);
      if (!h) continue;
      expect(h.matched).not.toMatch(/SAMPLE|@|https?:/);
      expect(r.credits.some((c) => sanitize(c.value).includes(h.matched))).toBe(true);
    }
  });
});

describe("matchRecord field and string order (§5.5)", () => {
  it("takes CNA before ADP whatever the array position, and the first matching string within a field", () => {
    const r = rec("CVE-2026-1001", CUTOFF, [...adp("XBOW"), ...cna("SAMPLE Researcher", "found with Claude Code", "Claude")]);
    expect(matchRecord(r, null, cfg)).toMatchObject({ finder_id: "anthropic-claude-code", field: "cna.credits", matched: "Claude Code" });
    expect(matchRecord(rec("CVE-2026-1002", CUTOFF, [...adp("XBOW"), ...cna("SAMPLE Researcher")]), null, cfg))
      .toMatchObject({ finder_id: "xbow", field: "adp.credits" });
  });

  it("follows cfg.fields: with ADP listed first, the ADP credit wins", () => {
    const flipped = { ...cfg, fields: ["adp.credits", "cna.credits", "ghsa.credits"] as CompiledAiFinders["fields"] };
    const r = rec("CVE-2026-1003", CUTOFF, [...cna("Claude"), ...adp("XBOW")]);
    expect(matchRecord(r, null, flipped)).toMatchObject({ finder_id: "xbow", field: "adp.credits" });
  });

  it("reads GHSA credits only when a source is given, and after the CVE fields", () => {
    expect(GHSA_CREDIT_SOURCE).toBe("git");
    expect(CREDIT_FIELD_ORDER).toEqual(["cna.credits", "adp.credits", "ghsa.credits"]);
    const g: GhsaCreditSource = { id: "GHSA-aaaa-bbbb-cccc", cve_ids: ["CVE-2026-1004"], published: "2026-10-01", credits: ["sample-xbow-bot"] };
    const r = rec("CVE-2026-1004", "2026-10-01", cna("SAMPLE Researcher"));
    expect(matchRecord(r, null, cfg)).toBeNull();
    expect(matchRecord(r, g, cfg)).toMatchObject({ finder_id: "xbow", field: "ghsa.credits" });
    expect(matchRecord(rec("CVE-2026-1004", "2026-10-01", cna("Claude")), g, cfg)).toMatchObject({ field: "cna.credits" });
    expect(matchRecord(r, g, { ...cfg, fields: ["cna.credits", "adp.credits"] })).toBeNull();
  });
});

// ── State files ──────────────────────────────────────────────────────────────────────────────────

const ALL_FIXTURES = [...FIXTURE_RECORDS, ...P1_RECORDS];

describe("buildCredits (§5.9 step 2, §4.7)", () => {
  it("equals matchRecord() for every fixture record, and a rematch from its candidates gives the same rows", () => {
    const s = buildCredits({ records: ALL_FIXTURES, ghsa: [] }, run, CUTOFF);
    const rows = new Map(s.credits.matches.map((m) => [m[0], m]));
    for (const r of ALL_FIXTURES) {
      const h = matchRecord(r, null, cfg);
      const row = rows.get(r.cve_id);
      if (!h) { expect(row, r.cve_id).toBeUndefined(); continue; }
      expect(row, r.cve_id).toEqual([r.cve_id, r.date_published, h.finder_id, h.family, h.kind, h.field, h.matched, h.rule, CUTOFF]);
    }
    const bumped = { ...run, version: run.version + 1, sha256: "f".repeat(64) };
    const re = recomputeCredits(s, bumped, CUTOFF, NO_LEDGER);
    expect(re.credits.matches).toEqual(s.credits.matches);
    expect(s.credits.matches.map((m) => m[0])).toEqual([
      "CVE-2026-82427", "CVE-2026-93302", "CVE-2026-102731", "CVE-2026-107466", "CVE-2026-109832", "CVE-2026-110036", "CVE-2026-111497", "CVE-2026-119776",
    ]);
  });

  it("stores each record's sanitised prefilter-passing strings in field order, with the prefilter hash", () => {
    const s = buildCredits({ records: ALL_FIXTURES, ghsa: [] }, run, CUTOFF);
    expect(s.candidates.prefilter_sha256).toBe(sha256Hex(config.aiFinders.prefilter));
    expect(s.credits).toMatchObject({ schema_version: 1, updated_at: CUTOFF, finders_version: 2, finders_sha256: config.sha256.aiFinders });
    expect(s.candidates.candidates.filter((c) => c[0] === "CVE-2026-119776")).toEqual([
      ["CVE-2026-119776", "2026-11-04", "cna.credits", "Anthropic OSS-scanner (re-report, ANT-2026-N0E1INIV)"],
    ]);
    expect(s.candidates.candidates.some((c) => c[0] === "CVE-2026-59774")).toBe(false); // "[link]" fails the prefilter
    expect(s.candidates.candidates.filter((c) => c[0] === "CVE-2026-109618").map((c) => c[3])).toEqual(["OpenAI"]);
    expect(() => jsonText(s.candidates, CreditCandidatesFile)).not.toThrow();
    expect(() => jsonText(s.credits, AiCreditsFile)).not.toThrow();
  });

  it("stores no e-mail address, plain or spelt out, and matches as before (§0.4 row 64)", () => {
    const strings = [
      "SAMPLE Researcher (sample@example.com) using Claude Code",
      "sample-ai@example.com",
      "SAMPLE Researcher <sample.researcher@example.org>",
      "SAMPLE Researcher \u2039sampleATexampleDOTcom\u203a with OpenAI",
      "SAMPLE Researcher, sample[at]example[dot]com, AI-assisted",
    ];
    const s = buildCredits({ records: [rec("CVE-2026-1003", CUTOFF, cna(...strings))], ghsa: [] }, run, CUTOFF);
    expect(s.candidates.candidates.map((c) => c[3])).toEqual([
      "SAMPLE Researcher [email] using Claude Code", // the parentheses go with the address, as strip rule 1 takes them
      "SAMPLE Researcher [email] with OpenAI",
      "SAMPLE Researcher, [email] AI-assisted",
    ]);
    for (const c of s.candidates.candidates) expect(c[3]).not.toMatch(/@|\bAT\w*DOT|\[at\]/);
    expect(s.credits.matches.map((m) => m[6])).toEqual(["Claude Code"]);
    // The replacement changes no match: B.2's examples, D.7's must-not-match credits and the strings above.
    const examples = config.aiFinders.finders.flatMap((f) => [...f.examples.match, ...f.examples.no_match]);
    for (const x of [...examples, ...strings]) expect(matchCredit(creditText(x), cfg), x).toEqual(matchCredit(sanitize(x), cfg));
    // A bare handle stays; one with a character before its @ goes, as strip rule 1 already takes it.
    expect(creditText("SAMPLE Researcher @handle of Team-Atlanta")).toBe("SAMPLE Researcher @handle of Team-Atlanta");
    expect(creditText("SAMPLE Researcher (@handle) of Team-Atlanta")).toBe("SAMPLE Researcher [email] of Team-Atlanta");
  });

  it("counts only PUBLISHED records dated on or before the cutoff, with no lower bound (ruling R4)", () => {
    const s = buildCredits({ records: [
      rec("CVE-2019-0001", "2019-05-01", cna("Claude")),
      rec("CVE-2026-2001", CUTOFF, cna("Claude")),
      rec("CVE-2026-2002", addDays(CUTOFF, 1), cna("Claude")),
      rec("CVE-2026-2003", null, cna("Claude")),
      rec("CVE-2026-2004", "2026-10-01", cna("Claude"), "REJECTED"),
    ], ghsa: [] }, run, CUTOFF);
    expect(s.credits.matches.map((m) => m[0])).toEqual(["CVE-2019-0001", "CVE-2026-2001"]);
    expect(s.candidates.candidates.map((c) => c[0])).toEqual(["CVE-2019-0001", "CVE-2026-2001"]);
  });

  it("writes byte-identical files from shuffled input, sorted by date then id (candidates by id)", () => {
    const records = [...ALL_FIXTURES, rec("CVE-2026-999", "2026-10-02", cna("XBOW")), rec("CVE-2026-1000", "2026-10-02", cna("XBOW"))];
    const a = buildCredits({ records, ghsa: [] }, run, CUTOFF);
    const b = buildCredits({ records: [...records].reverse(), ghsa: [] }, run, CUTOFF);
    expect(jsonText(b.credits, AiCreditsFile)).toBe(jsonText(a.credits, AiCreditsFile));
    expect(jsonText(b.candidates, CreditCandidatesFile)).toBe(jsonText(a.candidates, CreditCandidatesFile));
    const ids = a.credits.matches.filter((m) => m[1] === "2026-10-02").map((m) => m[0]);
    expect(ids).toEqual(["CVE-2026-999", "CVE-2026-1000", "CVE-2026-102731"]);
  });

  it("files a GitHub-only REST credit under its CVE alias, or under its own id without one", () => {
    const ghsa: GhsaCreditSource[] = [
      { id: "GHSA-xxxx-0000-0001", cve_ids: ["CVE-2026-3001"], published: "2026-10-03", credits: ["sample-xbow-bot"] },
      { id: "GHSA-xxxx-0000-0002", cve_ids: [], published: "2026-10-04", credits: ["sample-xbow-bot"] },
    ];
    const s = buildCredits({ records: [rec("CVE-2026-3001", "2026-10-02", cna("SAMPLE Researcher"))], ghsa }, run, CUTOFF);
    expect(s.credits.matches.map((m) => [m[0], m[1], m[5]])).toEqual([
      ["CVE-2026-3001", "2026-10-02", "ghsa.credits"], ["GHSA-xxxx-0000-0002", "2026-10-04", "ghsa.credits"],
    ]);
  });
});

describe("updateCredits (§5.5 Keeping matches current)", () => {
  const base = (): CreditState => buildCredits({ records: [
    rec("CVE-2026-4001", "2026-10-01", cna("SAMPLE Researcher", "Claude")),
    rec("CVE-2026-4002", "2026-10-02", cna("XBOW")),
    rec("CVE-2026-4003", "2026-10-03", cna("SAMPLE Researcher")),
  ], ghsa: [] }, run, "2026-10-10");

  it("upserts a new record, removes a vanished string, drops a REJECTED record and keeps first_matched", () => {
    const prev = base();
    const { state, changed } = updateCredits(prev, { records: [
      rec("CVE-2026-4001", "2026-10-01", cna("SAMPLE Researcher", "found with Claude Code")), // finder changes: first_matched kept
      rec("CVE-2026-4002", "2026-10-02", cna("SAMPLE Researcher")),                           // the AI string is gone
      rec("CVE-2026-4003", "2026-10-03", cna("SAMPLE Researcher"), "REJECTED"),
      rec("CVE-2026-4004", "2026-10-11", cna("Found by AISLE")),                              // new
    ], ghsa: [] }, run, "2026-10-12");
    expect(changed).toEqual(["CVE-2026-4001", "CVE-2026-4002", "CVE-2026-4004"]);
    expect(state.credits.matches).toEqual([
      ["CVE-2026-4001", "2026-10-01", "anthropic-claude-code", "anthropic", "ai_assisted", "cna.credits", "Claude Code", "pattern", "2026-10-10"],
      ["CVE-2026-4004", "2026-10-11", "aisle", "other", "ai_system", "cna.credits", "AISLE", "pattern", "2026-10-12"],
    ]);
    expect(state.candidates.candidates.map((c) => [c[0], c[3]])).toEqual([
      ["CVE-2026-4001", "found with Claude Code"], ["CVE-2026-4004", "Found by AISLE"],
    ]);
    expect(state.credits.updated_at).toBe("2026-10-12");
    expect(state.candidates.updated_at).toBe("2026-10-12");
  });

  it("is idempotent, and an unchanged record changes nothing", () => {
    const prev = base();
    const same = [rec("CVE-2026-4001", "2026-10-01", cna("SAMPLE Researcher", "Claude")), rec("CVE-2026-4002", "2026-10-02", cna("XBOW"))];
    const once = updateCredits(prev, { records: same, ghsa: [] }, run, "2026-10-10");
    expect(once.changed).toEqual([]);
    expect(jsonText(once.state.credits, AiCreditsFile)).toBe(jsonText(prev.credits, AiCreditsFile));
    expect(jsonText(once.state.candidates, CreditCandidatesFile)).toBe(jsonText(prev.candidates, CreditCandidatesFile));
    const input = { records: [rec("CVE-2026-4005", "2026-10-09", cna("ZeroPath"))], ghsa: [] };
    const a = updateCredits(prev, input, run, "2026-10-10").state;
    const b = updateCredits(a, input, run, "2026-10-10");
    expect(b.changed).toEqual([]);
    expect(jsonText(b.state.credits, AiCreditsFile)).toBe(jsonText(a.credits, AiCreditsFile));
  });

  it("leaves a record dated after the cutoff for a later run, and keeps the stored list hashes", () => {
    const prev = base();
    const bumped = { ...run, version: 9, sha256: "e".repeat(64) };
    const { state } = updateCredits(prev, { records: [rec("CVE-2026-4006", "2026-10-11", cna("Claude"))], ghsa: [] }, bumped, "2026-10-10");
    expect(state.credits.matches.some((m) => m[0] === "CVE-2026-4006")).toBe(false);
    expect(state.credits.finders_version).toBe(prev.credits.finders_version);
    expect(state.credits.finders_sha256).toBe(prev.credits.finders_sha256);
    expect(state.candidates.prefilter_sha256).toBe(prev.candidates.prefilter_sha256);
    expect(creditListStatus(state, bumped)).toBe("recompute");
  });

  it("replaces a ledger-only row when the id gains a credit match", () => {
    const prev = applyLedger(base().credits, { cveIds: ["CVE-2026-4003"], published: new Map([["CVE-2026-4003", "2026-10-03"]]) }, run, "2026-10-10");
    const state: CreditState = { candidates: base().candidates, credits: prev.credits };
    expect(state.credits.matches.find((m) => m[0] === "CVE-2026-4003")?.[7]).toBe("cvd_ledger");
    const up = updateCredits(state, { records: [rec("CVE-2026-4003", "2026-10-03", cna("Claude"))], ghsa: [] }, run, "2026-10-12");
    expect(up.state.credits.matches.filter((m) => m[0] === "CVE-2026-4003")).toEqual([
      ["CVE-2026-4003", "2026-10-03", "anthropic-claude", "anthropic", "ai_system", "cna.credits", "Claude", "pattern", "2026-10-10"],
    ]);
  });
});

describe("creditListStatus and recomputeCredits (§5.5 List changes)", () => {
  const state = buildCredits({ records: [
    rec("CVE-2026-5001", "2026-08-12", cna("Aisle Research")),
    rec("CVE-2026-5002", "2026-08-20", cna("Claude")),
  ], ghsa: [] }, run, "2026-09-01");

  it("gives all three outcomes", () => {
    expect(creditListStatus(state, run)).toBe("current");
    expect(creditListStatus(state, { ...run, version: run.version + 1 })).toBe("recompute");
    expect(creditListStatus(state, { ...run, sha256: "0".repeat(64) })).toBe("recompute");
    const prefilter = loadConfig({ root, fresh: true, overrides: { aiFinders: { ...config.aiFinders, prefilter: `${config.aiFinders.prefilter}|\\bExampleBot\\b` } } });
    expect(creditListStatus(state, aiFindersOf(prefilter, prefilter.compiled))).toBe("prefilter_changed");
    expect(prefilterSha256(config.aiFinders.prefilter)).not.toBe(prefilterSha256(prefilter.aiFinders.prefilter));
  });

  it("rematches every candidate under a new list, keeps first_matched, writes the list's version and hash, and every week follows", () => {
    // v1 without the Aisle Research pattern: CVE-2026-5001 is unmatched there.
    const v1Finders = config.aiFinders.finders.map((f) => (f.id === "aisle" ? { ...f, patterns_case_sensitive: ["\\bAISLE\\b"], examples: { match: ["AISLE Research"], no_match: ["Aisle Smith"] } } : f));
    const v1 = loadConfig({ root, fresh: true, overrides: { aiFinders: { ...config.aiFinders, version: 1, finders: v1Finders } } });
    const v1Run = aiFindersOf(v1, v1.compiled);
    const atV1 = recomputeCredits(state, v1Run, "2026-09-01", NO_LEDGER);
    expect(atV1.credits.matches.map((m) => m[0])).toEqual(["CVE-2026-5002"]);
    expect(atV1.credits).toMatchObject({ finders_version: 1, finders_sha256: v1Run.sha256 });
    const weeks = ["2026-08-10", "2026-08-17"];
    expect(aiWeekly(atV1.credits, weeks).ai_weekly.other).toEqual([0, 0]);

    const atV2 = recomputeCredits(atV1, run, "2026-09-08", NO_LEDGER);
    expect(atV2.credits.matches).toEqual([
      ["CVE-2026-5001", "2026-08-12", "aisle", "other", "ai_system", "cna.credits", "Aisle Research", "pattern", "2026-09-08"],
      ["CVE-2026-5002", "2026-08-20", "anthropic-claude", "anthropic", "ai_system", "cna.credits", "Claude", "pattern", "2026-09-01"],
    ]);
    expect(atV2.credits).toMatchObject({ finders_version: 2, finders_sha256: config.sha256.aiFinders, updated_at: "2026-09-08" });
    expect(creditListStatus(atV2, run)).toBe("current");
    expect(aiWeekly(atV2.credits, weeks)).toEqual({
      ai_weekly: { anthropic: [0, 1], openai: [0, 0], google: [0, 0], other: [1, 0] }, ai_ledger_only_weekly: [0, 0],
    });
  });

  it("has the fixed notes", () => {
    expect(AI_NOTES.recomputed(2)).toBe("AI-finder list changed to v2; history recomputed.");
    expect(AI_NOTES.prefilterChanged.length).toBeLessThanOrEqual(200);
    expect(AI_NOTES.prefilterChanged).not.toMatch(/\u2014/);
  });
});

describe("applyLedger (ruling R6)", () => {
  const credits = buildCredits({ records: [rec("CVE-2026-6001", "2026-09-01", cna("Claude"))], ghsa: [] }, run, "2026-10-01").credits;

  it("adds a ledger-only row, counts a ledger id with a credit match as the match, and lists ids without a date", () => {
    const ledger = {
      cveIds: ["CVE-2026-6001", "cve-2026-6002", "CVE-2026-6003", "GHSA-xxxx-yyyy-zzzz", "CVE-2026-6004", "CVE-2026-6002"],
      published: new Map([["CVE-2026-6002", "2026-09-02"], ["CVE-2026-6004", "2026-10-05"]]),
    };
    const { credits: out, missing } = applyLedger(credits, ledger, run, "2026-10-01");
    expect(out.matches).toEqual([
      ["CVE-2026-6001", "2026-09-01", "anthropic-claude", "anthropic", "ai_system", "cna.credits", "Claude", "pattern", "2026-10-01"],
      ["CVE-2026-6002", "2026-09-02", "anthropic-claude", "anthropic", "ai_system", "cvd_ledger", LEDGER_MATCHED, "cvd_ledger", "2026-10-01"],
    ]);
    expect(missing).toEqual(["CVE-2026-6003"]);
    expect(() => jsonText(out, AiCreditsFile)).not.toThrow();

    // The next day: the id leaves the ledger, so its row goes; a kept row keeps its first_matched and date.
    const later = applyLedger(out, { cveIds: ["CVE-2026-6002"], published: new Map() }, run, "2026-10-08");
    expect(later.credits.matches.find((m) => m[0] === "CVE-2026-6002")?.[8]).toBe("2026-10-01");
    expect(later.missing).toEqual([]);
    expect(applyLedger(out, NO_LEDGER, run, "2026-10-08").credits.matches.map((m) => m[0])).toEqual(["CVE-2026-6001"]);
  });

  it("never lets a ledger row reach total, a family or in_kev", () => {
    const { credits: out } = applyLedger(credits, { cveIds: ["CVE-2026-6002"], published: new Map([["CVE-2026-6002", "2026-09-02"]]) }, run, "2026-10-01");
    const ai = aiCredited({ credits: out, kevIndex: [kevRow("CVE-2026-6002", "2026-09-20", "2026-09-02")], cutoff: "2026-10-01", findersVersion: 2 });
    expect(ai.w13).toEqual({ total: 1, by_family: { anthropic: 1, openai: 0, google: 0, other: 0 }, ex_anthropic: 0, ledger_only_anthropic: 1 });
    expect(ai.in_kev).toEqual({ since: "2025-01-01", n: 0, entries: [] });
    const br = baseRate({ credits: out, days: [day("2026-06-01", 100)], kevIndex: [], cutoff: "2026-10-01" });
    expect(br.ai_credited_n).toBe(0);
    expect(aiWeekly(out, [isoWeekStart("2026-09-02")])).toEqual({
      ai_weekly: { anthropic: [1], openai: [0], google: [0], other: [0] }, ai_ledger_only_weekly: [1],
    });
    expect(aiCreditFor("CVE-2026-6002", out, 2)).toEqual({
      finder_id: "anthropic-claude", family: "anthropic", kind: "ai_system", field: "cvd_ledger", matched: LEDGER_MATCHED, rule: "cvd_ledger", finders_version: 2,
    });
  });
});

// ── Metrics values ───────────────────────────────────────────────────────────────────────────────

describe("aiCredited and aiManifestRows (§4.7, §5.5)", () => {
  const credits: AiCreditsFile = {
    schema_version: 1, updated_at: CUTOFF, finders_version: 2, finders_sha256: config.sha256.aiFinders,
    matches: [
      ["CVE-2025-7001", "2025-03-01", "xbow", "other", "ai_system", "cna.credits", "XBOW", "pattern", "2026-11-06"],
      ["CVE-2026-7002", "2026-08-07", "aisle", "other", "ai_system", "cna.credits", "AISLE", "pattern", "2026-11-06"],
      ["CVE-2026-7003", "2026-08-08", "anthropic-claude", "anthropic", "ai_system", "cna.credits", "Claude", "pattern", "2026-11-06"],
      ["CVE-2026-7004", "2026-10-22", "openai-codex", "openai", "ai_system", "cna.credits", "Codex Security", "pattern", "2026-11-06"],
      ["CVE-2026-7005", "2026-10-30", "anthropic-claude", "anthropic", "ai_system", "cvd_ledger", LEDGER_MATCHED, "cvd_ledger", "2026-11-06"],
      ["CVE-2026-7006", "2026-11-06", "google-big-sleep", "google", "ai_system", "cna.credits", "Big Sleep", "pattern", "2026-11-06"],
    ],
  };
  const kevIndex: KevIndexRow[] = [
    kevRow("CVE-2026-7004", "2026-10-27", "2026-10-22"),
    kevRow("CVE-2025-7001", "2025-04-02", "2025-03-01"),
    kevRow("CVE-2026-7005", "2026-11-01", "2026-10-30"),
    kevRow("CVE-2026-7006", "2026-11-07", "2026-11-06"),
    kevRow("CVE-2024-7000", "2025-02-01", "2024-12-01"),
  ];
  const ai = aiCredited({ credits, kevIndex, cutoff: CUTOFF, findersVersion: 2 });

  it("counts w13 by family on the publication date, both ends in, and lists in_kev by date added", () => {
    expect(AiCredited.parse(ai)).toEqual(ai);
    expect(ai).toEqual({
      finders_version: 2, from: "2026-08-08", to: "2026-11-06",
      w13: { total: 3, by_family: { anthropic: 1, openai: 1, google: 1, other: 0 }, ex_anthropic: 2, ledger_only_anthropic: 1 },
      provisional_from: "2026-10-05",
      in_kev: { since: "2025-01-01", n: 2, entries: [
        { cve_id: "CVE-2025-7001", finder_id: "xbow", family: "other", kev_date_added: "2025-04-02", matched: "XBOW" },
        { cve_id: "CVE-2026-7004", finder_id: "openai-codex", family: "openai", kev_date_added: "2026-10-27", matched: "Codex Security" },
      ] },
    });
  });

  it("puts every window row, ledger rows included, and every in_kev row in the manifest, by date then id", () => {
    const rows = aiManifestRows(credits, ai);
    expect(rows.map((r) => r.id)).toEqual(["CVE-2025-7001", "CVE-2026-7003", "CVE-2026-7004", "CVE-2026-7005", "CVE-2026-7006"]);
    expect(rows[3]).toEqual({ id: "CVE-2026-7005", published: "2026-10-30", finder_id: "anthropic-claude", family: "anthropic", kind: "ai_system", field: "cvd_ledger", matched: LEDGER_MATCHED, rule: "cvd_ledger" });
    expect(() => InputsManifest.shape.ai_credited.parse(rows)).not.toThrow();
  });

  it("aiCreditFor agrees with every manifest row", () => {
    for (const r of aiManifestRows(credits, ai)) {
      expect(aiCreditFor(r.id, credits, 2)).toEqual({ finder_id: r.finder_id, family: r.family, kind: r.kind, field: r.field, matched: r.matched, rule: r.rule, finders_version: 2 });
    }
    expect(aiCreditFor("CVE-2026-9999", credits, 2)).toBeNull();
  });

  it("aiWeekly counts each row in its ISO week and leaves other weeks at zero", () => {
    expect(aiWeekly(credits, ["2026-08-03", "2026-10-19", "2026-10-26", "2026-11-02"])).toEqual({
      ai_weekly: { anthropic: [1, 0, 0, 0], openai: [0, 1, 0, 0], google: [0, 0, 0, 1], other: [1, 0, 0, 0] },
      ai_ledger_only_weekly: [0, 0, 1, 0],
    });
  });
});

describe("baseRate (§5.5)", () => {
  const credits = (rows: AiCreditRow[]): AiCreditsFile => ({ schema_version: 1, updated_at: CUTOFF, finders_version: 2, finders_sha256: "a".repeat(64), matches: rows });
  const row = (id: string, date: string): AiCreditRow => [id, date, "xbow", "other", "ai_system", "cna.credits", "XBOW", "pattern", CUTOFF];

  it("compares like with like month by month, listing within 90 days (negative lags in)", () => {
    const br = baseRate({
      credits: credits([row("CVE-2025-8001", "2025-01-10"), row("CVE-2025-8002", "2025-02-10"), row("CVE-2026-8003", "2026-08-09")]),
      days: [day("2024-12-31", 50), day("2025-01-10", 100), day("2025-01-20", 100), day("2025-02-10", 100), day("2026-08-08", 10), day("2026-08-09", 40)],
      kevIndex: [
        kevRow("CVE-2025-8001", "2025-01-05", "2025-01-10"),   // negative lag: listed
        kevRow("CVE-2025-8010", "2025-04-20", "2025-01-20"),   // 90 days: listed
        kevRow("CVE-2025-8011", "2025-05-12", "2025-02-10"),   // 91 days: not listed
        kevRow("CVE-2025-8002", "2025-02-11", "2025-02-10"),
        kevRow("CVE-2026-8003", "2026-08-10", "2026-08-09"),   // after to_published
        kevRow("CVE-2024-8012", "2025-01-02", "2024-12-31"),   // before the span
      ],
      cutoff: CUTOFF,
    });
    expect(BaseRate.parse(br)).toEqual(br);
    // January: ai 1 of 200, 2 listed; February: ai 1 of 100, 1 listed; August 1 to 8: 10, none.
    expect(br).toEqual({
      since: "2025-01-01", to_published: "2026-08-08", to: CUTOFF, follow_up_days: 90,
      ai_credited_n: 2, ai_credited_in_kev_n: 2, ai_rate: 1, all_n: 310, all_in_kev_n: 3, all_rate: round4(3 / 310),
      expected: round4((1 * 2) / 200 + (1 * 1) / 100), ratio: null, ratio_ci80: null,
    });
  });

  it("gives the ratio and its interval only from 30 AI-credited records and an expected count of 5", () => {
    const ai = Array.from({ length: 40 }, (_, k) => row(`CVE-2025-${9000 + k}`, "2025-03-15"));
    const kev = [
      ...Array.from({ length: 3 }, (_, k) => kevRow(`CVE-2025-${9000 + k}`, "2025-03-20", "2025-03-15")),
      ...Array.from({ length: 50 }, (_, k) => kevRow(`CVE-2025-${9500 + k}`, "2025-04-01", "2025-03-15")),
    ];
    const br = baseRate({ credits: credits(ai), days: [day("2025-03-15", 200)], kevIndex: kev, cutoff: CUTOFF });
    const expected = (40 * 53) / 200; // 10.6
    const [lo, hi] = poissonCi80(3);
    expect(br).toMatchObject({ ai_credited_n: 40, ai_credited_in_kev_n: 3, all_n: 200, all_in_kev_n: 53, expected: 10.6, ratio: round4(3 / expected) });
    expect(br.ratio_ci80).toEqual([round4(lo / expected), round4(hi / expected)]);
    const few = baseRate({ credits: credits(ai.slice(0, 29)), days: [day("2025-03-15", 200)], kevIndex: kev, cutoff: CUTOFF });
    expect(few.ratio).toBeNull();
    expect(few.ratio_ci80).toBeNull();
  });

  it("is empty but valid before the span opens", () => {
    const br = baseRate({ credits: credits([]), days: [], kevIndex: [], cutoff: "2025-02-01" });
    expect(br).toMatchObject({ to_published: "2024-11-03", ai_credited_n: 0, all_n: 0, ai_rate: null, all_rate: null, expected: 0, ratio: null });
    expect(BaseRate.parse(br)).toEqual(br);
  });
});

describe("aiFindersOf and prefilterSha256", () => {
  it("takes the compiled list, its version and the file's SHA-256", () => {
    expect(run.version).toBe(2);
    expect(run.sha256).toBe(sha256Hex(fs.readFileSync(path.join(root, "config", "ai-finders.json"))));
    expect(run.compiled).toBe(config.compiled.aiFinders);
  });

  it("hashes the prefilter string's UTF-8 bytes (ruling R7)", () => {
    expect(prefilterSha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(prefilterSha256("\\bAI\u2019s\\b")).toBe(sha256Hex(Buffer.from("\\bAI\u2019s\\b", "utf8")));
  });
});
