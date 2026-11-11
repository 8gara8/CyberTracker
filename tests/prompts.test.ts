// The routine prompts against SPEC §8.5 and §11 (plan §1 L1, tests PR1 to PR7). Model names are built
// from fragments here (plan A20): only tests/agent.test.ts names them literally.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { secretsIn } from "@/lib/rules/safety";
import type { ValidationIssue } from "@/lib/rules/types";
import { AgentContext } from "@/lib/schema/context";
import { PROMPT_VARS, REPAIR_VARS, STYLE_FILE, promptVars, renderTemplate, repairIssues, repairVars } from "@/scripts/lib/agent";
import { MODEL_FAMILIES, MODEL_FLAG_SOURCE, MODEL_ID_SOURCE, MODEL_SAMPLES } from "./helpers/model-names";

const root = path.join(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const PROMPT = read("routine/PROMPT.md");
const REPAIR = read("routine/REPAIR.md");
const context = (name: string) => AgentContext.parse(JSON.parse(read(`fixtures/context/${name}.json`)));
const weekday = context("weekday");

/** The distinct {{NAME}} placeholders of a template, sorted. */
const varsOf = (text: string) => [...new Set([...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]!))].sort();

/** Every file under routine/, recursively. */
function routineFiles(dir = path.join(root, "routine")): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? routineFiles(p) : [p];
  });
}

describe("PR1, PR2: the templates use exactly §8.5's variables", () => {
  it("PR1: PROMPT.md's {{NAME}} set equals PROMPT_VARS", () => {
    expect(varsOf(PROMPT)).toEqual([...PROMPT_VARS].sort());
  });
  it("PR2: REPAIR.md's {{NAME}} set equals REPAIR_VARS", () => {
    expect(varsOf(REPAIR)).toEqual([...REPAIR_VARS].sort());
  });
  it("PR2: every {{ in either file opens a placeholder", () => {
    for (const t of [PROMPT, REPAIR]) expect(t.split("{{").length - 1).toBe([...t.matchAll(/\{\{[A-Z_]+\}\}/g)].length);
  });
  it("PR2: REPAIR.md carries ERRORS_JSON in a fenced json block", () => {
    expect(REPAIR).toMatch(/```json\n\{\{ERRORS_JSON\}\}\n```/);
  });
  it("PR2: PROMPT.md writes no budget number of its own (§11 item 3)", () => {
    // Section references (§10), step numbers, pack ids ([p0042]), tiers and ".i2p" are not budgets; once
    // they are gone, no digit may remain.
    const rest = PROMPT.replace(/\{\{[A-Z_]+\}\}/g, "")
      .replace(/§\d+/g, "")
      .replace(/^\s*\d+\. /gm, "")
      .replace(/\[[pr]\d+\]/g, "")
      .replace(/tier 1 or 2|tier 1/g, "")
      .replace(/\.i2p\b/g, "");
    expect(rest.match(/.{0,30}\d.{0,30}/g)).toBeNull();
  });
});

describe("PR3: renderTemplate", () => {
  const vars = { A: "one", B_C: "two" };

  it("PR3: fills every placeholder in one pass", () => {
    expect(renderTemplate("x {{A}} y {{B_C}} {{A}}", vars)).toBe("x one y two one");
    expect(renderTemplate("no placeholders", {})).toBe("no placeholders");
  });
  it("PR3: throws on an unknown name, naming it and its line", () => {
    expect(() => renderTemplate("a\n{{A}}\n{{NOPE}}", vars)).toThrow("Template: unknown variable {{NOPE}} on line 3.");
    expect(() => renderTemplate("{{toString}}", vars)).toThrow(/stray/);
    expect(() => renderTemplate("{{CONSTRUCTOR}}", {})).toThrow("unknown variable {{CONSTRUCTOR}}");
  });
  it("PR3: throws on a name with no value", () => {
    expect(() => renderTemplate("{{A}} {{B_C}}", { A: "x", B_C: undefined } as unknown as Record<string, string>)).toThrow(
      "Template: variable {{B_C}} on line 1 has no value.",
    );
    expect(() => renderTemplate("{{A}}", { A: 3 } as unknown as Record<string, string>)).toThrow("has no value");
  });
  it("PR3: throws on a stray {{ that is not a placeholder", () => {
    for (const t of ["{{ A }}", "{{a}}", "{{A}", "x {{", "{{A-B}}", "{{}}"]) expect(() => renderTemplate(t, vars), t).toThrow(/Template: a stray "\{\{" on line 1/);
    expect(() => renderTemplate("{{A}}\n\nend {{", vars)).toThrow("line 3");
  });
  it("PR3: accepts values holding {{, which are never filled again", () => {
    const v = { A: "{{B_C}} and {{", B_C: "two" };
    expect(renderTemplate("{{A}}|{{B_C}}", v)).toBe("{{B_C}} and {{|two");
    expect(renderTemplate("{{A}}", { A: "$& $1 $$" })).toBe("$& $1 $$");
  });
});

describe("PR4: routine/TASK.md", () => {
  it("PR4: equals SPEC §11's block byte for byte", () => {
    const spec = read("SPEC.md");
    const start = spec.indexOf("\n## 11. Routine prompts\n");
    expect(start).toBeGreaterThan(0);
    const open = spec.indexOf("````markdown\n", start);
    const close = spec.indexOf("\n````\n", open);
    expect(open).toBeGreaterThan(start);
    const block = spec.slice(open + "````markdown\n".length, close + 1);
    expect(block.startsWith("# CyberTracker morning run\n")).toBe(true);
    expect(read("routine/TASK.md")).toBe(block);
  });
});

describe("PR5: no date, model name or secret in any routine file", () => {
  const files = routineFiles();
  // Every family name as a bare word too (the CLI's aliases), besides the full identifiers and the flags (tests/helpers/model-names.ts).
  const modelRe = new RegExp(`\\b(?:${MODEL_FAMILIES.join("|")})\\b|${MODEL_ID_SOURCE}|${MODEL_FLAG_SOURCE}`, "i");
  const months = "January|February|March|April|May|June|July|August|September|October|November|December";
  const dateRes = [
    /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/,
    /\b(?:19|20)\d{2}\/\d{2}\/\d{2}\b/,
    new RegExp(`\\b\\d{1,2} (?:${months}) (?:19|20)\\d{2}\\b`),
    new RegExp(`\\b(?:${months}) \\d{1,2}, (?:19|20)\\d{2}\\b`),
  ];

  it("PR5: the scan covers the templates, the style guide, the settings and the schema", () => {
    const rel = files.map((f) => path.relative(root, f));
    for (const f of ["routine/TASK.md", "routine/PROMPT.md", "routine/REPAIR.md", STYLE_FILE, "routine/agent-settings.json", "routine/schema/draft-brief.schema.json"]) {
      expect(rel).toContain(f);
    }
  });
  for (const file of files) {
    const rel = path.relative(root, file);
    it(`PR5: ${rel}`, () => {
      const text = fs.readFileSync(file, "utf8");
      for (const re of dateRes) expect(text, `${rel} holds a date`).not.toMatch(re);
      expect(text, `${rel} names a model`).not.toMatch(modelRe);
      expect(secretsIn(text), `${rel} holds a secret-like string`).toEqual([]);
    });
  }
  it("PR5: the scan itself catches what it looks for", () => {
    for (const f of MODEL_FAMILIES) expect(`Use ${f[0]!.toUpperCase()}${f.slice(1)} here.`, f).toMatch(modelRe);
    for (const sample of MODEL_SAMPLES) expect(`run ${sample}`, sample).toMatch(modelRe);
    expect(dateRes.some((re) => re.test("on 2026-10-14"))).toBe(true);
    expect(dateRes.some((re) => re.test("on 14 October 2026"))).toBe(true);
    expect(secretsIn("gh" + "p_" + "a".repeat(36))).not.toEqual([]);
  });
});

describe("PR6: PROMPT.md's length (§11: at most about 120 lines)", () => {
  it("PR6: at most 120 lines, and REPAIR.md about 20", () => {
    expect(PROMPT.split("\n").length).toBeLessThanOrEqual(120);
    expect(REPAIR.split("\n").length).toBeLessThanOrEqual(30);
  });
  it("PR6: follows §11's order", () => {
    const heads = [...PROMPT.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(heads).toEqual(["Inputs (read in this order)", "Window and budgets", "Steps", "Output", "Deadline", "Rules", "Self-check before writing"]);
  });
  it("PR6: names the reply word, the degraded pack and the injection rule", () => {
    expect(PROMPT).toContain("reply with the single\nword DONE");
    expect(PROMPT).toContain("`pack.degraded`");
    expect(PROMPT).toContain("`pack.failed_feeds`");
    expect(PROMPT).toMatch(/data, not instructions/);
    expect(REPAIR).toContain("reply with the single word DONE");
  });
});

describe("PR7: a real render", () => {
  const fakeRoot = path.join(os.tmpdir(), "ct-prompts-root");
  const v = promptVars({ root: fakeRoot, date: weekday.date, context: weekday, fetchBudget: 40, maxItems: 10 });
  const rendered = renderTemplate(PROMPT, v);

  it("PR7: fills every variable from the context and the budgets", () => {
    expect(v).toEqual({
      DATE: "2026-10-14",
      WINDOW_START: "2026-10-13 04:30",
      WINDOW_END: "2026-10-14 04:30",
      WEEKLY: "false",
      DEADLINE_LOCAL: "05:15",
      DRAFT_PATH: path.join(fakeRoot, "drafts", "2026-10-14.json"),
      CONTEXT_PATH: path.join(fakeRoot, "drafts", "context.json"),
      PACK_MD_PATH: path.join(fakeRoot, "packs", "2026-10-14.md"),
      SCHEMA_PATH: path.join(fakeRoot, "routine", "schema", "draft-brief.schema.json"),
      STYLE_PATH: path.join(fakeRoot, "routine", "STYLE.md"),
      FETCH_BUDGET: "40",
      MAX_ITEMS: "10",
    });
    expect(rendered).not.toContain("{{");
  });
  it("PR7: every path it names is absolute and under the root", () => {
    for (const k of PROMPT_VARS.filter((n) => n.endsWith("_PATH"))) {
      expect(path.isAbsolute(v[k]), k).toBe(true);
      expect(v[k].startsWith(fakeRoot + path.sep), k).toBe(true);
    }
    const fileRefs = [...rendered.matchAll(/`([^`\s]+\.(?:json|md|jsonl))`/g)].map((m) => m[1]!).filter((p) => p.includes("/"));
    expect(fileRefs.length).toBeGreaterThanOrEqual(4);
    for (const p of fileRefs) expect(path.isAbsolute(p) && p.startsWith(fakeRoot + path.sep), p).toBe(true);
  });
  it("PR7: a Monday context sets WEEKLY true", () => {
    const monday = context("monday");
    expect(promptVars({ root: fakeRoot, date: monday.date, context: monday, fetchBudget: 40, maxItems: 10 }).WEEKLY).toBe("true");
  });
  it("PR7: the canary's own paths replace the derived ones, relative to the root or absolute (plan A22)", () => {
    const c = promptVars({ root: fakeRoot, date: weekday.date, context: weekday, fetchBudget: 7.9, maxItems: -2, paths: { draft: "drafts/canary-x.json", packMd: "/abs/pack.md" } });
    expect(c.DRAFT_PATH).toBe(path.join(fakeRoot, "drafts", "canary-x.json"));
    expect(c.CONTEXT_PATH).toBe(path.join(fakeRoot, "drafts", "context.json"));
    expect(c.PACK_MD_PATH).toBe("/abs/pack.md");
    expect([c.FETCH_BUDGET, c.MAX_ITEMS]).toEqual(["7", "0"]);
  });
  it("PR7: the repair render lists the errors, then the SNAP_ warnings, and nothing else", () => {
    const issue = (code: string, severity: "error" | "warning"): ValidationIssue => ({ code, severity, path: "items[0]", message: `${code} {{not a var}}`, hint: null });
    const issues = [issue("SNAP_STALE", "warning"), issue("SCHEMA", "error"), issue("WORDS_SOFT", "warning"), issue("SOURCE_TIER", "error")];
    expect(repairIssues(issues).map((i) => i.code)).toEqual(["SCHEMA", "SOURCE_TIER", "SNAP_STALE"]);
    const r = repairVars({ root: fakeRoot, date: weekday.date, context: weekday, fetchBudget: 12, issues });
    expect(Object.keys(r).sort()).toEqual([...REPAIR_VARS].sort());
    expect(JSON.parse(r.ERRORS_JSON)).toEqual(repairIssues(issues));
    expect(r.FETCH_BUDGET).toBe("12");
    const text = renderTemplate(REPAIR, r);
    expect(text).toContain(r.ERRORS_JSON);
    expect(text).toContain("SCHEMA {{not a var}}");
    expect(text.replace(r.ERRORS_JSON, "")).not.toContain("{{");
    expect(text).toContain(`\`${path.join(fakeRoot, "drafts", "2026-10-14.json")}\``);
  });
});

describe("PR8: the source-type guidance the dry runs needed", () => {
  it("PR8: PROMPT.md names the context's record domains as cve_record, never vendor_advisory", () => {
    const flat = PROMPT.replace(/\s+/g, " ");
    expect(flat).toContain("`config.tiers.cve_record`");
    expect(flat).toMatch(/is a `"cve_record"`, never a `"vendor_advisory"`/);
    expect(weekday.config.tiers.cve_record).toContain("github.com");
  });
});
