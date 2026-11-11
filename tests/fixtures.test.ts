// The draft fixtures as files (SPEC §4.12 "Fixtures and tests", §10 P1): every fixtures/drafts/invalid--<CODE>.json
// fails with exactly its own code and no warning, every soft--<CODE>.json gives no error and exactly that
// warning, and the valid drafts pass clean, each read from disk and run through `npm run validate`'s main()
// with the weekday inputs the P1 milestone passes. Then the coverage check: CASE_TYPES lists every §4.12 code
// (the rule table, the cross-file table, the snapshot table and the CONFIG_* codes) with its case type, and
// fails when a registered code is missing from it, when an F code has no invalid fixture, an S code no soft
// fixture, or a T code no named case in its test file.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SNAP_CODES } from "@/lib/apply";
import { CONFIG_CODES } from "@/lib/config";
import { ruleCodes } from "@/lib/rules";
import { ENGINE_CODES, type ValidationIssue } from "@/lib/validate";
import { main } from "@/scripts/validate";
import { INVALID_CASES } from "@/fixtures/src/build";
import { SOFT_CASES } from "@/fixtures/src/soft";
import { EDITION_NAMES, REPO_ROOT } from "@/fixtures/src/world";

const DRAFTS = path.join(REPO_ROOT, "fixtures", "drafts");
const files = fs.readdirSync(DRAFTS).filter((f) => f.endsWith(".json")).sort();
const invalidFiles = files.filter((f) => f.startsWith("invalid--"));
const softFiles = files.filter((f) => f.startsWith("soft--"));

/** "invalid--SCHEMA--item-cves.json" → "SCHEMA". */
const codeOf = (file: string) => file.replace(/\.json$/, "").split("--")[1]!;

/** The P1 milestone's `V` flags (SPEC §10 P1): the weekday inputs, for every draft fixture. */
const inputsFor = (edition: string) => [
  "--context", `fixtures/context/${edition}.json`, "--evidence", `fixtures/evidence/${edition}.json`,
  "--metrics", `fixtures/metrics/${edition}.json`, "--cve-cache", "fixtures/cvelist/records",
  "--regions-input", `fixtures/regions-input/${edition}.json`, "--pack", `fixtures/packs/${edition}.json`,
].map((a) => (a.startsWith("fixtures/") ? path.join(REPO_ROOT, a) : a));

interface CliResult { exit: number; errors: ValidationIssue[]; warnings: ValidationIssue[] }

/** `npm run -s validate -- <file> <inputs> --json`, in process. */
function validateFile(file: string, edition = "weekday"): CliResult {
  const out: string[] = [];
  const err: string[] = [];
  const exit = main([path.join(DRAFTS, file), ...inputsFor(edition), "--json"], { out: (s) => out.push(s), err: (s) => err.push(s), root: REPO_ROOT });
  if (exit === 2) throw new Error(`${file}: usage error: ${err.join("\n")}`);
  const r = JSON.parse(out.join("\n")) as { errors: ValidationIssue[]; warnings: ValidationIssue[] };
  return { exit, ...r };
}

const codes = (xs: readonly ValidationIssue[]) => [...new Set(xs.map((i) => i.code))].sort();

// ── The files ────────────────────────────────────────────────────────────────────────────────────

describe("fixtures/drafts", () => {
  it("holds only the valid, invalid and soft drafts the builder writes", () => {
    expect(files.filter((f) => !f.startsWith("invalid--") && !f.startsWith("soft--"))).toEqual(EDITION_NAMES.map((n) => `valid-${n}.json`).sort());
    expect(invalidFiles).toEqual(INVALID_CASES.map((c) => c.file).sort());
    expect(softFiles).toEqual(SOFT_CASES.map((c) => c.file).sort());
    // The milestone validates every invalid draft with the weekday inputs: each is a mutation of the weekday draft.
    expect(INVALID_CASES.filter((c) => (c.edition ?? "weekday") !== "weekday").map((c) => c.file)).toEqual([]);
    for (const c of INVALID_CASES) expect(codeOf(c.file), c.file).toBe(c.code);
  });

  it.each(EDITION_NAMES)("valid-%s.json passes with no error and no warning", (name) => {
    const r = validateFile(`valid-${name}.json`, name);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.exit).toBe(0);
  });

  it.each(invalidFiles)("%s fails with exactly its code", (file) => {
    const r = validateFile(file);
    expect(r.exit).toBe(1);
    expect(codes(r.errors)).toEqual([codeOf(file)]);
    expect(r.warnings).toEqual([]);
  });

  it.each(softFiles)("%s gives no error and exactly its warning", (file) => {
    const r = validateFile(file);
    expect(r.errors).toEqual([]);
    expect(codes(r.warnings)).toEqual([codeOf(file)]);
    expect(r.exit).toBe(0);
  });
});

// ── Coverage ─────────────────────────────────────────────────────────────────────────────────────

type CaseType = "F" | "S" | "T";

/**
 * Every §4.12 code and its case type, written out from the spec's tables: F is an invalid draft fixture, S a
 * soft one, T a named case in a test file (T_FILES). P1 is done only when each has its case.
 */
const CASE_TYPES: Record<string, readonly CaseType[]> = {
  // Shape, dates, editions
  SCHEMA: ["F"], DATE_MISMATCH: ["F", "T"], WEEKLY_FLAG: ["F"], AI_UNASSESSED: ["F"], CANARY: ["F"], METRICS_MISSING: ["T"],
  CONFIG_SCHEMA: ["T"], CONFIG_DUP: ["T"], CONFIG_REF: ["T"], CONFIG_REGEX: ["T"],
  // Ids
  ID_FORMAT: ["F"], ID_SEQUENCE: ["F"], ID_DUPLICATE: ["F"],
  // Items and sections
  ITEM_CAP: ["F"], ITEM_ORDER: ["F"], TOP3_WHY: ["F"], SEVERITY_NULL_FOR_NONTHREAT: ["F"], SEVERITY_KIND: ["F"],
  TAIWAN_LENS_REQUIRED: ["F"], REGION_RAISE: ["F"], STANDING_STORY_NEW_FACT: ["F", "T"], SCOREBOARD_REF: ["F"],
  // Words and limits
  WORDS_OVER: ["F"], WORDS_UNDER: ["F"], QUOTE_MAX_25: ["F"], BANNED_WORDS: ["F"],
  // Sources
  SOURCE_REF: ["F"], SOURCE_DUP: ["F"], SOURCE_URL: ["F"], SOURCE_UNSEEN: ["F"], SOURCE_TIER: ["F"], SOURCE_CRITICAL_TWO: ["F"],
  SOURCE_SYNDICATED: ["F"], SOURCE_STATE_LABEL: ["F"], RELEASE_SOURCE: ["T"], SOURCE_ORPHAN: ["T"],
  // CVEs and flaws
  CVE_PUBLISHED: ["F"], CVE_IN_SOURCE: ["F"], VENDOR_CONFIRMED: ["F"], EXPLOITED_BASIS: ["F"], FLAW_EVIDENCE: ["F"],
  // Grounding and numbers
  LEAD_GROUNDED: ["F"], GAP_MATCH: ["T"], METRICS_ONLY_NUMBERS: ["F"], NUMBER_FORM: ["F"],
  // AI role
  AI_EVIDENCE_REQUIRED: ["F"], AI_CONFIRMED_NONPRESS: ["F"], SELF_REPORTED_WORDING: ["F"], ANTHROPIC_DISCLOSURE_LINE: ["T"],
  // Victims and attribution
  VICTIM_STATUS: ["F"], VICTIM_CLAIMED_UNNAMED: ["F"], ATTRIBUTION_NAMED: ["F"], ATTRIBUTION_CONFIDENCE: ["F"],
  // Dangerous material
  NO_LIVE_IOC: ["F"], NO_EXPLOIT_LINK: ["F"], SECRET_LIKE: ["F"],
  // Script-set fields
  COMPUTED_MISMATCH: ["T"],
  // Cross-file (validateAll)
  FILE_NAME: ["T"], FILE_UNEXPECTED: ["T"], XREF_UNRESOLVED: ["T"], XREF_FIRST_SEEN: ["T"], XREF_KIND: ["T"], XREF_STATUS: ["T"],
  XREF_CORRECTION: ["T"], XREF_ARCHIVE: ["T"], MANIFEST_MISMATCH: ["T"], FILE_ORDER: ["T"],
  // Snapshot checks
  SNAP_NUMBER: ["S"], SNAP_NAME: ["S"], SNAP_QUOTE: ["S"], SNAP_MISSING: ["S"],
};

/** Where each T code's named case lives; tests/validate.test.ts unless listed. */
const T_FILES: Record<string, string> = {
  CONFIG_SCHEMA: "tests/config.test.ts", CONFIG_DUP: "tests/config.test.ts", CONFIG_REF: "tests/config.test.ts",
  CONFIG_REGEX: "tests/config.test.ts", ANTHROPIC_DISCLOSURE_LINE: "tests/rules-cves-grounding-ai.test.ts",
  RELEASE_SOURCE: "tests/rules-words-sources.test.ts",
};

/**
 * True when a describe(), it() or test() title in `text` (`.each(...)` and the like allowed) names `code`: a code
 * in a comment, an assertion or a table row doesn't count as a named case.
 */
function titled(text: string, code: string): boolean {
  return new RegExp(`\\b(?:describe|it|test)(?:\\.\\w+(?:\\([^()]*\\))?)*\\(\\s*(["'\`])(?:(?!\\1).)*\\b${code}\\b`, "u").test(text);
}

describe("§4.12 coverage", () => {
  const registered = [...new Set([...ruleCodes(), ...ENGINE_CODES, ...CONFIG_CODES, ...SNAP_CODES])].sort();

  it("lists every registered code, and no code nothing reports", () => {
    expect(Object.keys(CASE_TYPES).sort()).toEqual(registered);
  });

  it("gives every F code an invalid fixture, and no invalid fixture a code without F", () => {
    const fixtured = new Set(invalidFiles.map(codeOf));
    const f = Object.keys(CASE_TYPES).filter((c) => CASE_TYPES[c]!.includes("F"));
    expect(f.filter((c) => !fixtured.has(c))).toEqual([]);
    expect([...fixtured].filter((c) => !f.includes(c))).toEqual([]);
  });

  it("gives every S code a soft fixture, and no soft fixture a code without S", () => {
    const fixtured = new Set(softFiles.map(codeOf));
    const s = Object.keys(CASE_TYPES).filter((c) => CASE_TYPES[c]!.includes("S"));
    expect(s.filter((c) => !fixtured.has(c))).toEqual([]);
    expect([...fixtured].filter((c) => !s.includes(c))).toEqual([]);
  });

  it("counts a T code only in a test title", () => {
    expect(titled(`it("GAP_MATCH: a Gap line that differs", () => {});`, "GAP_MATCH")).toBe(true);
    expect(titled(`describe("broken copies (CONFIG_SCHEMA, CONFIG_DUP)", () => {});`, "CONFIG_DUP")).toBe(true);
    expect(titled(`it.each(DATES)("SOURCE_ORPHAN on %s", (d) => {});`, "SOURCE_ORPHAN")).toBe(true);
    expect(titled(`// GAP_MATCH (T) runs on a stored brief\nit("another case", () => {});`, "GAP_MATCH")).toBe(false);
    expect(titled(`it("another case", () => { expect(codes(r)).toEqual(["GAP_MATCH"]); });`, "GAP_MATCH")).toBe(false);
    expect(titled(`it("XREF_STATUS_OLD case", () => {});`, "XREF_STATUS")).toBe(false);
  });

  it("gives every T code a named case in its test file", () => {
    const text = new Map<string, string>();
    const missing = Object.keys(CASE_TYPES).filter((c) => CASE_TYPES[c]!.includes("T")).filter((c) => {
      const file = T_FILES[c] ?? "tests/validate.test.ts";
      if (!text.has(file)) text.set(file, fs.readFileSync(path.join(REPO_ROOT, file), "utf8"));
      return !titled(text.get(file)!, c);
    });
    expect(missing).toEqual([]);
  });
});
