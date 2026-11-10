// The T cases of SPEC §4.12 ("Fixtures and tests") on temporary copies of fixtures/site-content/: every
// validateAll() cross-file code, GAP_MATCH, COMPUTED_MISMATCH, METRICS_MISSING, SOURCE_ORPHAN, the file-date
// form of DATE_MISMATCH, a repeat of a sample item for STANDING_STORY_NEW_FACT, the Archived briefs
// downgrade of the safety codes, and a config change that must not fail the archive. Each case changes one
// thing in a fresh copy and checks the exact codes and paths. The sample itself (fixtures/src/site.ts) must
// pass whole and as the edition being published on each date. Rule-level cases for these codes live in the
// tests/rules-*.test.ts files and tests/validate-engine.test.ts; nothing here repeats them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig, type LoadedConfig } from "@/lib/config";
import { READING_WORDS_PER_MINUTE, aiLinkedOf } from "@/lib/rules/computed";
import { pageWords } from "@/lib/rules/words";
import { Brief } from "@/lib/schema/brief";
import type { InputsManifest, Metrics } from "@/lib/schema/metrics";
import type { ArchiveIndex, CorrectionsFile } from "@/lib/schema/misc";
import type { ScoreboardFile } from "@/lib/schema/scoreboard";
import type { StatusFile } from "@/lib/schema/status";
import { publisherFor } from "@/lib/sources";
import { validateAll, validateDraft, validatePublished, type AllResult, type ValidationResult } from "@/lib/validate";
import { WITHHELD_HEADLINE, WITHHELD_MARK } from "@/lib/vocab";
import { composeWithholds } from "@/lib/withhold";
import { WEEKDAY_ITEMS, editionDraft } from "@/fixtures/src/drafts";
import { CLAIMS_FILE, draftInputs, fixtureConfig } from "@/fixtures/src/inputs";
import { EMPTY_CONTENT_DIR, SITE_CONTENT_DIR, SITE_EDITIONS, SITE_FAILED_DATE } from "@/fixtures/src/site";
import { REPO_ROOT } from "@/fixtures/src/world";

const SITE = path.join(REPO_ROOT, SITE_CONTENT_DIR);
const DATES = Object.keys(SITE_EDITIONS);
const WED = "2026-10-14";
const config = fixtureConfig();

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-site-copy-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let copies = 0;

/** A fresh copy of the sample content folder, outside fixtures/ (so tests pass the sample claims explicitly). */
function copy(): string {
  const dir = path.join(tmp, `c${(copies += 1)}`);
  fs.cpSync(SITE, dir, { recursive: true });
  return dir;
}

function read<T = Record<string, unknown>>(dir: string, file: string): T {
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as T;
}

function write(dir: string, file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

/** Changes one JSON file in place. */
function edit<T>(dir: string, file: string, fn: (v: T) => void): void {
  const v = read<T>(dir, file);
  fn(v);
  write(dir, file, v);
}

/** Changes a brief, then recounts its computed block as publish would (so only the intended code fires). */
function editBrief(dir: string, date: string, fn: (b: Brief) => void): void {
  edit<Brief>(dir, `briefs/${date}.json`, (b) => {
    fn(b);
    b.computed = recount(b, read<Metrics>(dir, `metrics/${date}.json`));
  });
}

function recount(b: Brief, m: Metrics): Brief["computed"] {
  const words = pageWords(b, m);
  return {
    word_count: words, reading_minutes: Math.ceil(words / READING_WORDS_PER_MINUTE), item_count: b.items.length,
    ai_linked: aiLinkedOf(b.items), source_count: b.sources.length, publisher_count: new Set(b.sources.map((s) => s.publisher)).size,
  };
}

const all = (dir: string, opts: { publishing?: string; config?: LoadedConfig } = {}) => validateAll(dir, { config, ...opts });
const codes = (xs: readonly { code: string }[]) => [...new Set(xs.map((i) => i.code))].sort();
const paths = (r: AllResult | ValidationResult, code: string, kind: "errors" | "warnings" = "errors") =>
  r[kind].filter((i) => i.code === code).map((i) => i.path);
const itemIndex = (b: Brief, id: string) => b.items.findIndex((it) => it.id === id);
const sample = (dir: string, date: string) => Brief.parse(read(dir, `briefs/${date}.json`));

// ── The sample ───────────────────────────────────────────────────────────────────────────────────

describe("fixtures/site-content", () => {
  it("passes validateAll in sample mode (the folder is under fixtures/, so loadConfig reads the SAMPLE claims)", () => {
    const r = validateAll(SITE);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it.each(DATES)("passes as the edition being published on %s (config-derived fields included)", (date) => {
    const r = all(SITE, { publishing: date });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("holds what the sample needs (SPEC §6): consecutive dates, a Monday, data-only, partial and no-items editions, a withheld, a corrected and a repeated item", () => {
    const briefs = DATES.map((d) => sample(SITE, d));
    // At least ten consecutive dates (§6).
    expect(briefs.map((b) => b.date)).toEqual(Array.from({ length: 10 }, (_, i) => `2026-10-${String(6 + i).padStart(2, "0")}`));
    expect(briefs.map((b) => b.edition)).toEqual(DATES.map((d) => SITE_EDITIONS[d]));
    const by = (d: string) => briefs.find((b) => b.date === d)!;

    expect(by("2026-10-12").week_in_review?.strongest_against.claim_id).toBe("SB-01");
    expect(briefs.filter((b) => b.date !== "2026-10-12").every((b) => b.week_in_review === null)).toBe(true);
    for (const d of ["2026-10-06", "2026-10-09", "2026-10-15"]) {
      const b = by(d);
      expect(b.items.length).toBeGreaterThan(0);
      expect(b.items.every((it) => it.kind === "exploited_flaw" && it.ai_role === "unassessed" && it.cves[0]?.kev !== null)).toBe(true);
      expect(b.lead).toEqual([]);
      expect(b.angle).toBeNull();
    }
    expect(by("2026-10-13").feeds_stale.map((f) => f.id)).toEqual(["ithome-security"]);
    expect(briefs.filter((b) => b.items.length === 0).map((b) => b.date)).toEqual(["2026-10-07", "2026-10-08", "2026-10-10", "2026-10-11"]);

    const withheld = by("2026-10-12").items.find((it) => it.withheld !== null)!;
    expect(withheld).toMatchObject({ headline: WITHHELD_HEADLINE, why_it_matters: null, withheld: { correction_id: "C-0001", since: "2026-10-13" } });
    expect(withheld.incident?.victim).toBeNull();
    expect(by("2026-10-12").regions.rows.filter((r) => r.item_ids.includes(withheld.id)).map((r) => r.reason)).toEqual([WITHHELD_MARK]);
    // No stored file names the victim or carries the item's original headline (SPEC §4.10, §7 Withholding):
    // not the archived brief's region reason, nor an edition built after the withhold from that history.
    const original = editionDraft("monday").items.find((it) => it.id === withheld.id)!;
    for (const f of [...DATES.map((d) => `briefs/${d}.json`), "archive-index.json", "corrections.json"]) {
      const text = fs.readFileSync(path.join(SITE, f), "utf8");
      expect(text, f).not.toContain(original.headline);
      expect(text, f).not.toContain(original.incident!.victim!);
    }
    expect(by("2026-10-13").corrections.map((c) => [c.id, c.type, c.item_id])).toEqual([
      ["C-0001", "name_removed", withheld.id], ["C-0002", "clarification", "pol-jp-active-cyber-defence-2026-10"],
    ]);

    const edimax = WEEKDAY_ITEMS.taiwanVendor;
    expect(briefs.filter((b) => b.items.some((it) => it.id === edimax)).map((b) => b.date)).toEqual(["2026-10-13", WED]);
    expect(by(WED).items[itemIndex(by(WED), edimax)]!.first_seen).toBe("2026-10-13");

    expect(read<ScoreboardFile>(SITE, "scoreboard.json").entries.map((e) => [e.id, e.claim_id, e.origin])).toEqual([
      ["SE-0001", "SB-01", "metric"], ["SE-0002", "SB-02", "report"],
    ]);
    expect(fs.existsSync(path.join(SITE, "status", `${SITE_FAILED_DATE}.json`))).toBe(true);
    expect(fs.existsSync(path.join(SITE, "briefs", `${SITE_FAILED_DATE}.json`))).toBe(false);
  });

  it("fixtures/empty-content holds only README.md and passes", () => {
    const dir = path.join(REPO_ROOT, EMPTY_CONTENT_DIR);
    expect(fs.readdirSync(dir)).toEqual(["README.md"]);
    expect(validateAll(dir)).toMatchObject({ ok: true, errors: [], warnings: [] });
  });

  it("a data-only brief with three new KEV items passes validatePublished (SPEC §4.5)", () => {
    const b = sample(SITE, "2026-10-15");
    const m = read<Metrics>(SITE, "metrics/2026-10-15.json");
    b.items = b.items.slice(0, 3);
    b.sources = b.sources.slice(0, 3);
    b.computed = recount(b, m);
    const r = validatePublished(b, { metrics: m, config, fileDate: "2026-10-15" });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

// ── validateAll() cross-file rules ───────────────────────────────────────────────────────────────

describe("validateAll() on a changed copy of the sample", () => {
  it("FILE_NAME: a dated file without a real YYYY-MM-DD.json name", () => {
    const dir = copy();
    fs.copyFileSync(path.join(dir, "briefs", `${WED}.json`), path.join(dir, "briefs", "2026-10-1.json"));
    write(dir, "status/2026-02-30.json", read(dir, `status/${WED}.json`));
    const r = all(dir);
    expect(codes(r.errors)).toEqual(["FILE_NAME"]);
    expect(paths(r, "FILE_NAME")).toEqual(["briefs/2026-10-1.json: (file)", "status/2026-02-30.json: (file)"]);
  });

  it("FILE_UNEXPECTED: a file outside the content layout", () => {
    const dir = copy();
    write(dir, "notes.txt", "SAMPLE\n");
    write(dir, "state/other.json", {});
    const r = all(dir);
    expect(codes(r.errors)).toEqual(["FILE_UNEXPECTED"]);
    expect(paths(r, "FILE_UNEXPECTED")).toEqual(["notes.txt: (file)", "state/other.json: (file)"]);
  });

  it("DATE_MISMATCH: a metrics manifest or status file whose date differs from its name", () => {
    const dir = copy();
    edit<InputsManifest>(dir, `metrics/inputs/${WED}.json`, (m) => { m.date = "2026-10-13"; });
    edit<StatusFile>(dir, "status/2026-10-10.json", (s) => { s.date = "2026-10-11"; });
    const r = all(dir);
    expect(codes(r.errors)).toEqual(["DATE_MISMATCH"]);
    expect(paths(r, "DATE_MISMATCH")).toEqual([`metrics/inputs/${WED}.json: date`, "status/2026-10-10.json: date"]);
  });

  it("XREF_UNRESOLVED: a brief without its status file, a correction aimed at no item, a claim not in claims.json", () => {
    const dir = copy();
    fs.rmSync(path.join(dir, "status", `${WED}.json`));
    edit<CorrectionsFile>(dir, "corrections.json", (c) => { c.corrections[1]!.item_id = "pol-jp-no-such-item-2026-10"; });
    edit<ScoreboardFile>(dir, "scoreboard.json", (s) => { s.entries[1]!.claim_id = "SB-09"; });
    const r = all(dir);
    expect(codes(r.errors)).toEqual(["XREF_UNRESOLVED"]);
    expect(paths(r, "XREF_UNRESOLVED")).toEqual([
      `briefs/${WED}.json: (root)`, "corrections.json: corrections[1].item_id", "scoreboard.json: entries[1].claim_id",
    ]);
  });

  it("XREF_FIRST_SEEN: an item's first_seen later than the first brief that holds it", () => {
    const dir = copy();
    let i = -1;
    editBrief(dir, WED, (b) => {
      i = itemIndex(b, WEEKDAY_ITEMS.taiwanVendor);
      b.items[i]!.first_seen = WED;
    });
    const r = all(dir);
    expect(codes(r.errors)).toEqual(["XREF_FIRST_SEEN"]);
    expect(paths(r, "XREF_FIRST_SEEN")).toEqual([`briefs/${WED}.json: items[${i}].first_seen`]);
  });

  it("XREF_KIND: one item id with two kinds in two briefs", () => {
    const dir = copy();
    let i = -1;
    editBrief(dir, WED, (b) => {
      i = itemIndex(b, WEEKDAY_ITEMS.taiwanVendor);
      b.items[i]!.kind = "exploited_flaw";
    });
    const r = all(dir);
    expect(paths(r, "XREF_KIND")).toEqual([`briefs/${WED}.json: items[${i}].kind`]);
    // An exploited flaw at Watch with no KEV entry also breaks the item rules; nothing else in the folder fails.
    expect(r.errors.every((e) => e.path.startsWith(`briefs/${WED}.json: items[${i}]`))).toBe(true);
  });

  it("XREF_STATUS: a status file's publish time, or an edition recorded with no brief", () => {
    const dir = copy();
    edit<StatusFile>(dir, `status/${WED}.json`, (s) => { s.runs[0]!.full_published_at = `${WED}T05:20:00+08:00`; });
    edit<StatusFile>(dir, `status/${SITE_FAILED_DATE}.json`, (s) => { s.runs[0]!.edition = "full"; });
    const r = all(dir);
    expect(codes(r.errors)).toEqual(["XREF_STATUS"]);
    expect(paths(r, "XREF_STATUS")).toEqual([`status/${WED}.json: runs[0].full_published_at`, `status/${SITE_FAILED_DATE}.json: runs[0].edition`]);
  });

  it("NO_EXPLOIT_LINK: a dispute's evidence link on a blocked host or with an exploit word in its path", () => {
    for (const [url, says] of [["https://example.net/ct-sample/cve-2026-104935-poc", 'path holds "poc"'], ["https://bit.ly/ct-sample", "link shortener"]] as const) {
      const dir = copy();
      edit<CorrectionsFile>(dir, "corrections.json", (c) => { c.disputes[0]!.evidence_url = url; });
      const r = all(dir);
      expect(codes(r.errors), url).toEqual(["NO_EXPLOIT_LINK"]);
      expect(paths(r, "NO_EXPLOIT_LINK")).toEqual(["corrections.json: disputes[0].evidence_url"]);
      expect(r.errors[0]!.message).toContain(says);
    }
  });

  it("XREF_CORRECTION: a name_removed correction whose archived item still names the victim", () => {
    const dir = copy();
    editBrief(dir, "2026-10-12", (b) => { b.items[0]!.incident!.victim = "Example Health Group"; });
    const r = all(dir);
    expect(codes(r.errors)).toEqual(["XREF_CORRECTION"]);
    expect(paths(r, "XREF_CORRECTION")).toEqual(["corrections.json: corrections[0]"]);
    expect(r.errors[0]!.message).toContain("incident.victim is not null after a victim dispute");
  });

  it("XREF_CORRECTION: a withheld item's archived region reason still holds its rule's text (the item's headline)", () => {
    const dir = copy();
    let k = -1;
    editBrief(dir, "2026-10-12", (b) => {
      k = b.regions.rows.findIndex((r) => r.item_ids.includes(b.items[0]!.id));
      b.regions.rows[k]!.reason = "Confirmed breach in United States: SAMPLE named company says an intruder copied patient records";
    });
    const r = all(dir);
    expect(codes(r.errors)).toEqual(["XREF_CORRECTION"]);
    expect(paths(r, "XREF_CORRECTION")).toEqual(["corrections.json: corrections[0]"]);
    expect(r.errors[0]!.message).toContain(`regions.rows[${k}].reason is not "${WITHHELD_MARK}"`);
  });

  it("XREF_CORRECTION: while its dispute is open or upheld, a withhold covers a later brief holding the item; once rejected, it does not", () => {
    const FLAW = "cve-2026-108917";
    const later = (dir: string, through: string, status: "open" | "rejected") => {
      const briefs = DATES.filter((d) => d >= "2026-10-13" && d <= through).map((d) => sample(dir, d));
      const cf = read<CorrectionsFile>(dir, "corrections.json");
      const dispute = {
        id: "D-0002", received: "2026-10-14T20:00:00+08:00", issue_number: 8, item_id: FLAW, edition_date: "2026-10-13",
        kind: "victim" as const, evidence_url: null, status: "open" as const, resolved_on: null, correction_id: null,
      };
      const ch = composeWithholds({
        date: "2026-10-15", config, briefs, corrections: cf, disputes: [...cf.disputes, dispute], archiveIndex: read<ArchiveIndex>(dir, "archive-index.json"),
        metricsFor: (d) => read<Metrics>(dir, `metrics/${d}.json`),
        requests: [{ item_id: FLAW, edition_date: "2026-10-13", kind: "victim", dispute_id: "D-0002", since: "2026-10-15" }],
      });
      for (const b of ch.rewritten) write(dir, `briefs/${b.date}.json`, b);
      const out = ch.corrections!;
      if (status === "rejected") out.disputes = out.disputes.map((d) => (d.id === "D-0002" ? { ...d, status: "rejected", resolved_on: "2026-10-15" } : d));
      write(dir, "corrections.json", out);
      write(dir, "archive-index.json", ch.archiveIndex);
    };
    // Every brief holding the item rewritten, as publishWithholds() writes it: valid.
    const whole = copy();
    later(whole, "2026-10-15", "open");
    expect(all(whole).errors).toEqual([]);
    // The 14 October brief still holds the item as first published: it would print the name again.
    const open = copy();
    later(open, "2026-10-13", "open");
    const r = all(open);
    expect(codes(r.errors)).toEqual(["XREF_CORRECTION"]);
    expect(paths(r, "XREF_CORRECTION")).toEqual(["corrections.json: corrections[2]"]);
    expect(r.errors[0]!.message).toContain(`briefs/${WED}.json items[${itemIndex(sample(open, WED), FLAW)}] is not rewritten: withheld is not set`);
    // Rejected, the withhold binds no later brief: the 14 October copy may stand.
    const rejected = copy();
    later(rejected, "2026-10-13", "rejected");
    expect(all(rejected).errors).toEqual([]);
  });

  it("XREF_CORRECTION: correction ids repeated or with a gap", () => {
    const repeated = copy();
    edit<CorrectionsFile>(repeated, "corrections.json", (c) => { c.corrections[1]!.id = "C-0001"; });
    expect(paths(all(repeated), "XREF_CORRECTION")).toEqual(["corrections.json: corrections[1].id"]);
    const gap = copy();
    edit<CorrectionsFile>(gap, "corrections.json", (c) => { c.corrections[1]!.id = "C-0003"; });
    const r = all(gap);
    expect(codes(r.errors)).toEqual(["XREF_CORRECTION"]);
    expect(r.errors[0]!.message).toContain("C-0002 is missing");
  });

  it("XREF_CORRECTION: a correction's dispute and a dispute's correction must name each other's records (§4.10, §8.9)", () => {
    const linked = (f: (c: CorrectionsFile) => void) => {
      const dir = copy();
      edit<CorrectionsFile>(dir, "corrections.json", f);
      const r = all(dir);
      return { codes: codes(r.errors), paths: paths(r, "XREF_CORRECTION"), messages: r.errors.map((e) => e.message) };
    };
    // A correction naming a dispute that does not exist, or one linked to another correction.
    const missing = linked((c) => { c.corrections[0]!.dispute_id = "D-0009"; });
    expect(missing.codes).toEqual(["XREF_CORRECTION"]);
    expect(missing.paths).toEqual(["corrections.json: corrections[0].dispute_id"]);
    expect(missing.messages[0]).toContain("C-0001 answers D-0009, which is not a dispute in corrections.json");
    const unlinked = linked((c) => { c.disputes[0]!.correction_id = null; });
    expect(unlinked.paths).toEqual(["corrections.json: corrections[0].dispute_id"]);
    expect(unlinked.messages[0]).toContain("C-0001 answers D-0001, but D-0001's correction_id is null");
    // A dispute naming a correction that does not exist, or one on another item.
    const absent = linked((c) => { c.disputes[0]!.correction_id = "C-0009"; });
    expect(absent.paths).toEqual(["corrections.json: corrections[0].dispute_id", "corrections.json: disputes[0].correction_id"]);
    expect(absent.messages[1]).toContain("D-0001 names C-0009, which is not a correction in corrections.json");
    const other = linked((c) => {
      c.disputes.push({ ...c.disputes[0]!, id: "D-0002", issue_number: c.disputes[0]!.issue_number + 1, correction_id: "C-0002" });
    });
    expect(other.paths).toEqual(["corrections.json: disputes[1].correction_id"]);
    expect(other.messages[0]).toContain(`D-0002 names C-0002, which corrects pol-jp-active-cyber-defence-2026-10 in 2026-10-12, not inc-health-us-2026-10 in 2026-10-12`);
    // A dispute naming a correction that answers no dispute (a re-check correction).
    const recheck = linked((c) => {
      c.disputes.push({ ...c.disputes[0]!, id: "D-0002", issue_number: c.disputes[0]!.issue_number + 1, item_id: c.corrections[1]!.item_id, correction_id: "C-0002" });
    });
    expect(recheck.paths).toEqual(["corrections.json: disputes[1].correction_id"]);
    expect(recheck.messages[0]).toContain("D-0002 names C-0002, which answers no dispute");
    // Intake's "already answered" path: a later dispute on the same item and edition takes the stored correction's id. Valid.
    const answered = linked((c) => {
      c.disputes.push({ ...c.disputes[0]!, id: "D-0002", issue_number: c.disputes[0]!.issue_number + 1, received: "2026-10-13T21:00:00+08:00" });
    });
    expect(answered.codes).toEqual([]);
  });

  it("XREF_ARCHIVE: a brief missing from archive-index.json, or listed with another publish time", () => {
    const dir = copy();
    edit<ArchiveIndex>(dir, "archive-index.json", (a) => {
      a.editions.shift();
      a.editions[0]!.published_at = `${WED}T05:30:00+08:00`;
    });
    const r = all(dir);
    expect(codes(r.errors)).toEqual(["XREF_ARCHIVE"]);
    expect(paths(r, "XREF_ARCHIVE")).toEqual(["archive-index.json: editions[0]", "archive-index.json: editions"]);
  });

  it("FILE_ORDER: archive editions oldest first, corrections out of order, claims unsorted", () => {
    const dir = copy();
    edit<ArchiveIndex>(dir, "archive-index.json", (a) => { a.editions.reverse(); });
    edit<CorrectionsFile>(dir, "corrections.json", (c) => { c.corrections.reverse(); });
    edit<ScoreboardFile>(dir, "scoreboard.json", (s) => { s.claims.reverse(); });
    const r = all(dir);
    expect(codes(r.errors)).toEqual(["FILE_ORDER"]);
    expect(paths(r, "FILE_ORDER")).toEqual([
      ...DATES.slice(1).map((_, i) => `archive-index.json: editions[${i + 1}]`), "corrections.json: corrections[1]", "scoreboard.json: claims[1]",
    ]);
  });

  it("MANIFEST_MISMATCH: a window row dropped from the manifest, and a metrics file without its manifest", () => {
    const dir = copy();
    edit<InputsManifest>(dir, `metrics/inputs/${WED}.json`, (m) => {
      const id = m.window.w13.pop()!.cve_id;
      m.window.w26 = m.window.w26.filter((r) => r.cve_id !== id);
    });
    fs.rmSync(path.join(dir, "metrics", "inputs", "2026-10-11.json"));
    const r = all(dir);
    expect(codes(r.errors)).toEqual(["MANIFEST_MISMATCH"]);
    const p = paths(r, "MANIFEST_MISMATCH");
    expect(p).toContain("metrics/2026-10-11.json: provenance.inputs_file");
    expect(p).toContain(`metrics/${WED}.json: window.w13.kev_added_n`);
    expect(p).toContain(`metrics/${WED}.json: window.w26.kev_added_n`);
  });

  it("GAP_MATCH: a brief whose metrics file is missing, and a Gap or Lens line that differs from its metrics", () => {
    const dir = copy();
    fs.rmSync(path.join(dir, "metrics", "2026-10-13.json"));
    editBrief(dir, WED, (b) => {
      b.gap.headline = `${b.gap.headline} SAMPLE`;
      b.taiwan_lens.kev_lines.tw.d30_n += 1;
    });
    const r = all(dir);
    expect(paths(r, "GAP_MATCH")).toEqual([
      "briefs/2026-10-13.json: gap", `briefs/${WED}.json: gap.headline`, `briefs/${WED}.json: taiwan_lens.kev_lines.tw.d30_n`,
    ]);
    expect(codes(r.errors)).toEqual(["GAP_MATCH", "XREF_UNRESOLVED"]);
    expect(paths(r, "XREF_UNRESOLVED")).toEqual(["briefs/2026-10-13.json: (root)"]);
    expect(paths(r, "METRICS_MISSING", "warnings").every((p) => p.startsWith("briefs/2026-10-13.json: "))).toBe(true);
  });
});

// ── Script-set fields and warnings ───────────────────────────────────────────────────────────────

describe("COMPUTED_MISMATCH on the sample", () => {
  it("fails a stored count, on any brief", () => {
    const dir = copy();
    edit<Brief>(dir, "briefs/2026-10-11.json", (b) => { b.computed.word_count += 1; });
    const r = all(dir);
    expect(codes(r.errors)).toEqual(["COMPUTED_MISMATCH"]);
    expect(paths(r, "COMPUTED_MISMATCH")).toEqual(["briefs/2026-10-11.json: computed.word_count"]);
  });

  it("fails a CVE block field the same-date inputs manifest lists differently", () => {
    const dir = copy();
    edit<InputsManifest>(dir, `metrics/inputs/${WED}.json`, (m) => {
      const row = m.window.w13.at(-1)!;
      const w26 = m.window.w26.find((r) => r.cve_id === row.cve_id)!;
      row.cve_id = "CVE-2026-104935";
      w26.cve_id = "CVE-2026-104935";
    });
    const r = all(dir);
    expect(codes(r.errors)).toEqual(["COMPUTED_MISMATCH"]);
    expect(paths(r, "COMPUTED_MISMATCH")).toEqual([`briefs/${WED}.json: items[0].cves[0].kev.date_added`, `briefs/${WED}.json: items[0].cves[0].date_published`]);
  });

  it("checks late only on the brief being published", () => {
    const dir = copy();
    // The late label is page text, so the word count is recounted with it.
    editBrief(dir, WED, (b) => { b.late = true; });
    expect(all(dir).errors).toEqual([]);
    expect(paths(all(dir, { publishing: WED }), "COMPUTED_MISMATCH")).toEqual([`briefs/${WED}.json: late`]);
  });
});

describe("METRICS_MISSING and SOURCE_ORPHAN on the sample", () => {
  it("METRICS_MISSING: validatePublished() with no metrics warns once and skips the metrics rules", () => {
    const b = sample(SITE, WED);
    const r = validatePublished(b, { metrics: null, config, fileDate: WED });
    expect(r.errors).toEqual([]);
    expect(codes(r.warnings)).toEqual(["METRICS_MISSING"]);
  });

  it("SOURCE_ORPHAN: a source no field cites is a warning, and the folder still passes", () => {
    const dir = copy();
    let n = 0;
    editBrief(dir, WED, (b) => {
      const url = "https://www.bleepingcomputer.com/ct-sample/page-nothing-cites";
      const p = publisherFor(url, "press", config);
      n = b.sources.length;
      b.sources.push({
        id: `s${n + 1}`, title: "SAMPLE page nothing cites", title_en: null, language: "en", outlet: "BleepingComputer", url, source_type: "press",
        published_at: "2026-10-13", publisher: p.publisher, publisher_name: p.publisher_name, tier: p.tier, state_label: p.state_label, seen_as: "fetched",
      });
    });
    const r = all(dir);
    expect(r.errors).toEqual([]);
    expect(codes(r.warnings)).toEqual(["SOURCE_ORPHAN"]);
    expect(paths(r, "SOURCE_ORPHAN", "warnings")).toEqual([`briefs/${WED}.json: sources[${n}]`]);
  });
});

describe("STANDING_STORY_NEW_FACT with the sample's history", () => {
  /** The weekday draft's inputs, with the partial edition of 13 October in the context's recent items. */
  function withHistory() {
    const inputs = draftInputs("weekday");
    const b = sample(SITE, "2026-10-13");
    inputs.context.recent_items.push(...b.items.map((it) => ({
      date: b.date, id: it.id, kind: it.kind, headline: it.headline, severity: it.severity,
      source_urls: it.source_ids.map((id) => b.sources.find((s) => s.id === id)!.url),
    })));
    return inputs;
  }

  it("passes the Edimax repeat on 14 October: iThome's later report was not cited on the 13th", () => {
    const r = validateDraft(editionDraft("weekday"), withHistory());
    expect(r.errors).toEqual([]);
  });

  it("fails the repeat when it cites only the CVE record the 13 October edition already cited", () => {
    const d = editionDraft("weekday");
    const i = d.items.findIndex((it) => it.id === WEEKDAY_ITEMS.taiwanVendor);
    const record = d.items[i]!.source_ids[0]!;
    d.items[i]!.source_ids = [record];
    const r = validateDraft(d, withHistory());
    expect(r.errors.filter((e) => e.code === "STANDING_STORY_NEW_FACT").map((e) => e.path)).toEqual([`items[${i}].source_ids`]);
  });
});

// ── Archived briefs ──────────────────────────────────────────────────────────────────────────────

describe("Archived briefs (SPEC §4.12)", () => {
  // A secret-shaped sample joined from pieces, so no such literal sits in this file.
  const secret = ["AK", "IA", "CTSAMPLE", "00000000"].join("");

  it("downgrades NO_EXPLOIT_LINK to a warning on an archived brief, keeps it an error on the brief being published, and keeps SECRET_LIKE an error", () => {
    const dir = copy();
    let s = -1;
    editBrief(dir, WED, (b) => {
      const url = "https://www.exploit-db.com/";
      const p = publisherFor(url, "other", config);
      s = b.sources.length;
      b.sources.push({
        id: `s${s + 1}`, title: "SAMPLE bare blocked host", title_en: null, language: "en", outlet: "SAMPLE", url, source_type: "other",
        published_at: null, publisher: p.publisher, publisher_name: p.publisher_name, tier: p.tier, state_label: p.state_label, seen_as: "fetched",
      });
      // Cited beside the policy item's own sources (an Elsewhere link would need tier 1 or 2).
      b.items[itemIndex(b, "pol-tw-incident-reporting-2026-10")]!.source_ids.push(`s${s + 1}`);
    });
    const archived = all(dir);
    expect(archived.errors).toEqual([]);
    expect(paths(archived, "NO_EXPLOIT_LINK", "warnings")).toEqual([`briefs/${WED}.json: sources[${s}].url`]);
    const publishing = all(dir, { publishing: WED });
    expect(paths(publishing, "NO_EXPLOIT_LINK")).toEqual([`briefs/${WED}.json: sources[${s}].url`]);

    editBrief(dir, "2026-10-12", (b) => { b.sources[2]!.outlet += ` ${secret}`; });
    const r = all(dir);
    expect(codes(r.errors)).toEqual(["SECRET_LIKE"]);
    expect(paths(r, "SECRET_LIKE")).toEqual(["briefs/2026-10-12.json: sources[2].outlet"]);
  });

  it("a config change after publish (a publisher's tier, a vendor's cna list, an actor alias, a claim's status) never fails the archive", () => {
    const base = fixtureConfig();
    const tiers = structuredClone(base.sourceTiers);
    tiers.publishers.find((p) => p.id === "bleepingcomputer")!.tier = 3;
    const vendors = structuredClone(base.vendors);
    vendors.vendors.find((v) => v.id === "ivanti")!.cna = [];
    const actors = structuredClone(base.actors);
    // An alias that is a word of the 14 October Lead's first sentence ("... already using, ...") and of none
    // of the items it cites, so it is a known name LEAD_GROUNDED would fail in draft mode.
    actors.actors[0]!.aliases.push({ name: "using", by: "SAMPLE", source_url: "https://example.org/sample/paper-kestrel" });
    const claims = JSON.parse(fs.readFileSync(CLAIMS_FILE, "utf8")) as { claims: { id: string; resolution: unknown }[] };
    claims.claims.find((c) => c.id === "SB-01")!.resolution = { status: "void", date: "2026-10-15", note: "SAMPLE void", source_url: null };
    const changed = loadConfig({ root: REPO_ROOT, overrides: { sourceTiers: tiers, vendors, actors, claims } });

    // Control: each change bites in draft mode (the cna list only when publishing, below), so the archive passing
    // below shows published mode ignores it, not that the change was inert.
    const draft = validateDraft(editionDraft("weekday"), { ...draftInputs("weekday"), config: changed });
    expect(draft.errors.map((e) => `${e.code} ${e.path}`).sort()).toEqual([
      "LEAD_GROUNDED lead[0].text", "SCOREBOARD_REF angle.claim_id", `SOURCE_TIER sources[${editionDraft("weekday").sources.findIndex((s) => s.url.includes("bleepingcomputer.com"))}].source_type`,
    ]);
    const banned = editionDraft("weekday");
    banned.items[0]!.summary = banned.items[0]!.summary.replace("Ivanti says", "Ivanti says, in an unprecedented step,");
    expect(codes(validateDraft(banned, draftInputs("weekday")).errors)).toEqual(["BANNED_WORDS"]);

    const dir = copy();
    // Banned words live in lib/vocab.ts, not config/: a word added to the list after publish is planted here instead.
    editBrief(dir, WED, (b) => { b.items[0]!.summary = b.items[0]!.summary.replace("Ivanti says", "Ivanti says, in an unprecedented step,"); });

    const r = all(dir, { config: changed });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);

    // The same change does fail the edition being published, whose config-derived fields must match the config.
    const b = sample(dir, WED);
    const bc = b.sources.findIndex((s) => s.publisher === "bleepingcomputer");
    const pub = all(dir, { config: changed, publishing: WED });
    expect(codes(pub.errors)).toEqual(["COMPUTED_MISMATCH"]);
    expect(paths(pub, "COMPUTED_MISMATCH")).toEqual([`briefs/${WED}.json: items[0].cves[0].vendor_confirmed_by`, `briefs/${WED}.json: sources[${bc}].tier`]);
  });
});
