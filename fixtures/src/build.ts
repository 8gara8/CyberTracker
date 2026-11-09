// Writes every generated validator fixture (SPEC §4.12 "Fixtures and tests"), as the fork base's builder
// does: the valid drafts with their contexts, evidence, metrics, packs and regions inputs, and the real CVE
// records they cite. Each part of the fixtures adds its generator to GENERATORS.
//   tsx fixtures/src/build.ts           write every file, remove any other file in FIXTURE_DIRS, then validate
//   tsx fixtures/src/build.ts --check   write nothing; exit 1 listing stale, missing or added files (fixtures:check)
// Both exit 1 when a valid draft fails validateDraft() with any error or warning.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { AgentContext } from "../../lib/schema/context";
import { DraftBrief } from "../../lib/schema/draft-brief";
import { Metrics } from "../../lib/schema/metrics";
import { Evidence } from "../../lib/schema/misc";
import { Pack } from "../../lib/schema/pack";
import { RegionsInputFile, validateDraft, type ValidationIssue } from "../../lib/validate";
import { editionDraft } from "./drafts";
import { cveRecords, draftInputs, editionContext, editionEvidence, editionMetrics, editionPack, editionRegionsInput } from "./inputs";
import { cvesGroundingAiCases } from "./invalid/cves-grounding-ai";
import { metaItemsCases } from "./invalid/meta-items";
import { namingSafetyComputedCases } from "./invalid/naming-safety-computed";
import { wordsSourcesCases } from "./invalid/words-sources";
import { siteOutputs } from "./site";
import { softDraftProblems, softOutputs } from "./soft";
import { EDITION_NAMES, REPO_ROOT, type EditionName } from "./world";

// ── JSON ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The fixture text of a value: parsed with `schema` when given (so keys follow the schema's order and a
 * bad value throws), printed with two-space indent and a trailing newline.
 */
export function jsonText(value: unknown, schema?: z.ZodType): string {
  return `${JSON.stringify(schema ? schema.parse(value) : value, null, 2)}\n`;
}

/** Writes `jsonText(value, schema)` to `file` (absolute, or relative to the repo root), creating folders. */
export function writeJson(file: string, value: unknown, schema?: z.ZodType): void {
  const abs = path.resolve(REPO_ROOT, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, jsonText(value, schema));
}

// ── Outputs ──────────────────────────────────────────────────────────────────────────────────────

/** One generated file: its path relative to the repo root and its exact text. */
export interface Output {
  path: string;
  text: string;
}

/** fixtures/<folder>/<name>.json for an edition's input. */
export const inputPath = (folder: "context" | "evidence" | "metrics" | "packs" | "regions-input", name: EditionName) =>
  `fixtures/${folder}/${name}.json`;
export const validDraftPath = (name: EditionName) => `fixtures/drafts/valid-${name}.json`;
export const cveRecordPath = (id: string) => `fixtures/cvelist/records/${id}.json`;

/** The valid drafts, everything they are validated against, and the CVE records they cite. */
export function validOutputs(): Output[] {
  const out: Output[] = [];
  for (const name of EDITION_NAMES) {
    out.push(
      { path: validDraftPath(name), text: jsonText(editionDraft(name), DraftBrief) },
      { path: inputPath("context", name), text: jsonText(editionContext(name), AgentContext) },
      { path: inputPath("evidence", name), text: jsonText(editionEvidence(name), Evidence) },
      { path: inputPath("metrics", name), text: jsonText(editionMetrics(name), Metrics) },
      { path: inputPath("packs", name), text: jsonText(editionPack(name), Pack) },
      { path: inputPath("regions-input", name), text: jsonText(editionRegionsInput(name), RegionsInputFile) },
    );
  }
  for (const [id, record] of Object.entries(cveRecords())) out.push({ path: cveRecordPath(id), text: jsonText(record) });
  return out;
}

// ── Invalid drafts (F) ───────────────────────────────────────────────────────────────────────────

/**
 * One F fixture (SPEC §4.12 "Fixtures and tests"): a mutation of an edition's valid draft that fails
 * validateDraft() with exactly `code` and no other error. Each file in fixtures/src/invalid/ exports an
 * array of these, listed in INVALID_CASES below.
 */
export interface InvalidCase {
  code: string;
  /** "invalid--<CODE>.json", written to fixtures/drafts/. */
  file: string;
  /** The valid draft mutated, and whose inputs validate it; default "weekday". */
  edition?: EditionName;
  /** Changes the fresh draft in place, or returns a replacement (a value past the schema is written as is). */
  mutate: (draft: DraftBrief) => unknown;
}

/** Every invalid case, one spread per file in fixtures/src/invalid/. */
export const INVALID_CASES: readonly InvalidCase[] = [
  ...metaItemsCases,
  ...wordsSourcesCases,
  ...cvesGroundingAiCases,
  ...namingSafetyComputedCases,
];

/** The draft a case produces (a fresh copy of its edition's valid draft, mutated). */
export function invalidDraft(c: InvalidCase): unknown {
  const draft = editionDraft(c.edition ?? "weekday");
  const out = c.mutate(draft);
  return out === undefined ? draft : out;
}

export const invalidDraftPath = (file: string) => `fixtures/drafts/${file}`;

export function invalidOutputs(): Output[] {
  return INVALID_CASES.map((c) => {
    const d = invalidDraft(c);
    return { path: invalidDraftPath(c.file), text: DraftBrief.safeParse(d).success ? jsonText(d, DraftBrief) : jsonText(d) };
  });
}

/** Every invalid case that doesn't fail with exactly its own code, as "invalid--X.json: ...". */
export function invalidDraftProblems(): string[] {
  const out: string[] = [];
  for (const c of INVALID_CASES) {
    const r = validateDraft(invalidDraft(c), draftInputs(c.edition ?? "weekday"));
    const others = r.errors.filter((i) => i.code !== c.code);
    if (!r.errors.some((i) => i.code === c.code)) out.push(`${c.file}: no ${c.code} error`);
    // Exactly that code and no other (§4.12 F): any warning is a problem too.
    for (const i of [...others, ...r.warnings]) out.push(`${c.file}: unexpected ${i.severity.toUpperCase()} ${i.code} ${i.path}: ${i.message}`);
  }
  return out;
}

/** Every generator, in writing order. The invalid, soft and site fixtures add theirs here. */
export const GENERATORS: readonly (() => Output[])[] = [validOutputs, invalidOutputs, softOutputs, siteOutputs];

export function allOutputs(): Output[] {
  const out = GENERATORS.flatMap((g) => g());
  const seen = new Set<string>();
  for (const o of out) {
    if (seen.has(o.path)) throw new Error(`Two generators write ${o.path}`);
    seen.add(o.path);
  }
  return out;
}

/**
 * The folders the builder owns (SPEC §8.1): every file in them is one a generator writes, so any other file
 * there is "added" (fixtures:check fails; fixtures:gen removes it). Hand-made fixtures (fixtures/agent/,
 * config/, injection/, feeds/, src/) live outside them.
 */
export const FIXTURE_DIRS: readonly string[] = [
  "fixtures/drafts", "fixtures/context", "fixtures/evidence", "fixtures/metrics", "fixtures/packs", "fixtures/regions-input",
  "fixtures/cvelist/records", "fixtures/site-content", "fixtures/empty-content",
];

/** Every file under the owned folders of `root`, as repo-relative paths with "/". */
function ownedFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  for (const d of FIXTURE_DIRS) walk(d);
  return out.sort();
}

/**
 * The outputs whose file is missing, those whose text differs from what the builder would write, and the
 * files in the owned folders that no generator writes (added).
 */
export function compareOutputs(outputs: readonly Output[], root: string = REPO_ROOT): { missing: string[]; stale: string[]; added: string[] } {
  const missing: string[] = [];
  const stale: string[] = [];
  for (const o of outputs) {
    const abs = path.join(root, o.path);
    if (!fs.existsSync(abs)) missing.push(o.path);
    else if (fs.readFileSync(abs, "utf8") !== o.text) stale.push(o.path);
  }
  const written = new Set(outputs.map((o) => o.path));
  return { missing, stale, added: ownedFiles(root).filter((p) => !written.has(p)) };
}

/** Writes every output under `root`, then removes the files in the owned folders no generator writes; returns those. */
export function writeOutputs(outputs: readonly Output[], root: string = REPO_ROOT): string[] {
  for (const o of outputs) {
    const abs = path.join(root, o.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, o.text);
  }
  const { added } = compareOutputs(outputs, root);
  for (const p of added) fs.rmSync(path.join(root, p));
  return added;
}

// ── Validation ───────────────────────────────────────────────────────────────────────────────────

/** Every issue validateDraft() reports on the valid drafts, as "valid-<name>.json: SEVERITY CODE path: message". */
export function validDraftProblems(): string[] {
  const out: string[] = [];
  for (const name of EDITION_NAMES) {
    const r = validateDraft(editionDraft(name), draftInputs(name));
    const line = (i: ValidationIssue) => `${path.basename(validDraftPath(name))}: ${i.severity.toUpperCase()} ${i.code} ${i.path}: ${i.message}`;
    out.push(...r.errors.map(line), ...r.warnings.map(line));
  }
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

export function main(argv: string[] = process.argv.slice(2), log: (s: string) => void = (s) => console.log(s), root: string = REPO_ROOT): number {
  const unknown = argv.filter((a) => a !== "--check");
  if (unknown.length) {
    log(`Unknown argument: ${unknown.join(" ")}. Usage: tsx fixtures/src/build.ts [--check]`);
    return 2;
  }
  const check = argv.includes("--check");
  const outputs = allOutputs();
  let code = 0;
  if (check) {
    const { missing, stale, added } = compareOutputs(outputs, root);
    for (const p of missing) log(`missing: ${p}`);
    for (const p of stale) log(`stale: ${p}`);
    for (const p of added) log(`added: ${p} (no generator writes it)`);
    if (missing.length || stale.length || added.length) {
      log(`Fixture files differ from what the builder writes: ${missing.length} missing, ${stale.length} stale, ${added.length} added. Run npm run fixtures:gen.`);
      return 1;
    }
    log(`All ${outputs.length} fixture files are up to date.`);
  } else {
    const removed = writeOutputs(outputs, root);
    for (const p of removed) log(`removed: ${p} (no generator writes it)`);
    log(`Wrote ${outputs.length} fixture files.`);
  }
  const problems = validDraftProblems();
  for (const p of problems) log(p);
  if (problems.length) {
    log(`${problems.length} validation issues in the valid drafts.`);
    code = 1;
  }
  const invalid = invalidDraftProblems();
  for (const p of invalid) log(p);
  if (invalid.length) {
    log(`${invalid.length} problems in the invalid drafts (each must fail with exactly its own code).`);
    code = 1;
  }
  const soft = softDraftProblems();
  for (const p of soft) log(p);
  if (soft.length) {
    log(`${soft.length} problems in the soft drafts (each must give no error and only its own warning).`);
    code = 1;
  }
  return code;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main();
