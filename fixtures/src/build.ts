// Writes every generated validator fixture (SPEC §4.12 "Fixtures and tests"), as the fork base's builder
// does: the valid drafts with their contexts, evidence, metrics, packs and regions inputs, and the real CVE
// records they cite; from P2 also the feed fixtures (the KEV catalogs and the two stored-method delta zips,
// compared byte for byte) and fixtures/state/. Each part of the fixtures adds its generator to GENERATORS.
//   tsx fixtures/src/build.ts           write every file, remove any other file in FIXTURE_DIRS, then validate
//   tsx fixtures/src/build.ts --check   write nothing; exit 1 listing stale, missing or added files (fixtures:check)
// Both exit 1 when a valid draft fails validateDraft() with any error or warning.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { jsonText } from "../../lib/json";
import { AgentContext } from "../../lib/schema/context";
import { DraftBrief } from "../../lib/schema/draft-brief";
import { Metrics } from "../../lib/schema/metrics";
import { Evidence } from "../../lib/schema/misc";
import { Pack } from "../../lib/schema/pack";
import { RegionsInputFile, validateDraft, type ValidationIssue } from "../../lib/validate";
import { editionDraft } from "./drafts";
import { cveRecords, draftInputs, editionContext, editionEvidence, editionMetrics, editionPack, editionRegionsInput } from "./inputs";
import { feedOutputs } from "./feeds";
import { cvesGroundingAiCases } from "./invalid/cves-grounding-ai";
import { metaItemsCases } from "./invalid/meta-items";
import { namingSafetyComputedCases } from "./invalid/naming-safety-computed";
import { wordsSourcesCases } from "./invalid/words-sources";
import { siteOutputs } from "./site";
import { softDraftProblems, softOutputs } from "./soft";
import { stateOutputs } from "./state";
import { EDITION_NAMES, REPO_ROOT, type EditionName } from "./world";

// ── JSON ─────────────────────────────────────────────────────────────────────────────────────────

// jsonText() lives in lib/json.ts so scripts write content files exactly as the fixtures do (§4.1).
export { jsonText };

/** Writes `jsonText(value, schema)` to `file` (absolute, or relative to the repo root), creating folders. */
export function writeJson(file: string, value: unknown, schema?: z.ZodType): void {
  const abs = path.resolve(REPO_ROOT, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, jsonText(value, schema));
}

// ── Outputs ──────────────────────────────────────────────────────────────────────────────────────

/** A generated text file: its path relative to the repo root and its exact UTF-8 text. */
export interface TextOutput {
  path: string;
  text: string;
}

/** A generated binary file (a stored-method zip): its path and its exact bytes, compared byte for byte. */
export interface BinaryOutput {
  path: string;
  bytes: Buffer;
}

/** One generated file: text or bytes. */
export type Output = TextOutput | BinaryOutput;

export const isBinaryOutput = (o: Output): o is BinaryOutput => "bytes" in o;

/** The outputs that are text, for the checks that read every generated string. */
export const textOutputs = (outputs: readonly Output[]): TextOutput[] => outputs.filter((o): o is TextOutput => !isBinaryOutput(o));

/** fixtures/<folder>/<name>.json for an edition's input. */
export const inputPath = (folder: "context" | "evidence" | "metrics" | "packs" | "regions-input", name: EditionName) =>
  `fixtures/${folder}/${name}.json`;
export const validDraftPath = (name: EditionName) => `fixtures/drafts/valid-${name}.json`;
export const cveRecordPath = (id: string) => `fixtures/cvelist/records/${id}.json`;

/** The valid drafts, everything they are validated against, and the CVE records they cite. */
export function validOutputs(): Output[] {
  const out: TextOutput[] = [];
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

/**
 * Every generator, in writing order. The invalid, soft and site fixtures add theirs here; P2 adds the feed
 * fixtures (fixtures/src/feeds.ts) and fixtures/state/ (fixtures/src/state.ts), which builds its state in
 * memory from the same inputs and never reads a generated file, so one fixtures:gen pass is enough.
 */
export const GENERATORS: readonly (() => Output[])[] = [validOutputs, invalidOutputs, softOutputs, siteOutputs, feedOutputs, stateOutputs];

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
 * config/, injection/, src/, ai-credit/, cvelist-clone/, and fixtures/feeds/ outside its kev/ and
 * cvelist/zips/ folders) live outside them. fixtures/reference/ is outside too (ruling R53): only the
 * backfill can rebuild it, and tests/reference.test.ts and --check-reference guard it.
 */
export const FIXTURE_DIRS: readonly string[] = [
  "fixtures/drafts", "fixtures/context", "fixtures/evidence", "fixtures/metrics", "fixtures/packs", "fixtures/regions-input",
  "fixtures/cvelist/records", "fixtures/site-content", "fixtures/empty-content",
  "fixtures/feeds/kev", "fixtures/feeds/cvelist/zips", "fixtures/state",
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

/** Whether the file at `abs` holds exactly what `o` would write (bytes for a binary output, UTF-8 text otherwise). */
function sameContent(abs: string, o: Output): boolean {
  return isBinaryOutput(o) ? fs.readFileSync(abs).equals(o.bytes) : fs.readFileSync(abs, "utf8") === o.text;
}

/**
 * The outputs whose file is missing, those whose content differs from what the builder would write (byte
 * for byte for a binary output), and the files in the owned folders that no generator writes (added).
 */
export function compareOutputs(outputs: readonly Output[], root: string = REPO_ROOT): { missing: string[]; stale: string[]; added: string[] } {
  const missing: string[] = [];
  const stale: string[] = [];
  for (const o of outputs) {
    const abs = path.join(root, o.path);
    if (!fs.existsSync(abs)) missing.push(o.path);
    else if (!sameContent(abs, o)) stale.push(o.path);
  }
  const written = new Set(outputs.map((o) => o.path));
  return { missing, stale, added: ownedFiles(root).filter((p) => !written.has(p)) };
}

/** Writes every output under `root`, then removes the files in the owned folders no generator writes; returns those. */
export function writeOutputs(outputs: readonly Output[], root: string = REPO_ROOT): string[] {
  for (const o of outputs) {
    const abs = path.join(root, o.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, isBinaryOutput(o) ? o.bytes : o.text);
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
