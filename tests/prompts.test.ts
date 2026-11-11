// The routine prompts against SPEC §8.5 and §11 (plan §1 L1, tests PR1 to PR7). Model names are built
// from fragments here (plan A20): only tests/agent.test.ts names them literally.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { CONFIRMING_SOURCE_TYPES } from "@/lib/rules/naming";
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

  it("PR8: the rule covers the record pages there, so a CERT's own notice on a record domain stays a government source", () => {
    // twcert.org.tw carries TVN records and TWCERT/CC's own notices. A notice fits "government", the only
    // type VICTIM_STATUS takes as a CERT's confirmation (the Incident status bullet), so the source-type
    // bullet must not make every page on that domain a "cve_record".
    const cfg = loadConfig({ root });
    const certDomains = cfg.sourceTiers.publishers
      .filter((p) => p.kind === "cert" && p.domains.some((d) => weekday.config.tiers.cve_record.includes(d)))
      .map((p) => p.id);
    expect(certDomains).toContain("twcert");
    const flat = PROMPT.replace(/\s+/g, " ");
    const b = flat.slice(flat.indexOf("- **Source types**")).split(" - **")[0]!;
    expect(b).not.toContain("A page on a domain in the context's");
    expect(b).toContain("record, on a domain in the context's `config.tiers.cve_record`, is a `\"cve_record\"`");
    expect(b).toContain("A CERT's own notice on one of those domains, such as TWCERT/CC's, is a `\"government\"` source.");
  });
});

describe("PR9: the cert_confirmed basis as FLAW_EVIDENCE checks it", () => {
  it("PR9: PROMPT.md says a national CERT's page, a CERT or CISA, and no other government body", () => {
    const flat = PROMPT.replace(/\s+/g, " ");
    expect(flat).toContain('`"cert_confirmed"` a national CERT\'s page, from a CERT');
    expect(flat).toContain("CISA, its KEV catalog included, and no other government body");
  });
});

describe("PR12: a patch batch's release date, as RELEASE_SOURCE checks it (review of row 146)", () => {
  it("PR12: PROMPT.md and STYLE.md ask for the vendor's own advisory, or the release's CVE ids", () => {
    const flat = PROMPT.replace(/\s+/g, " ");
    expect(flat).toContain("- **A patch batch** is dated from the vendor's own advisory for the release: cite it from the pack, with its `published_at`.");
    expect(flat).toContain("a release with no exploited fix needs its CVE ids, from its pack records, in `cve_ids`");
    const style = read("routine/STYLE.md").replace(/\s+/g, " ");
    expect(style).toContain("It cites the vendor's own release page, or names the release's CVE ids, so the release can be dated.");
  });
});

describe("PR10: the incident status and vendor confirmation rules as VICTIM_STATUS and VENDOR_CONFIRMED check them", () => {
  const flat = PROMPT.replace(/\s+/g, " ");
  const bullet = (title: string) => flat.slice(flat.indexOf(`- **${title}**`)).split(" - **")[0]!;

  it("PR10: confirmed needs a tier 1 victim, regulator filing or government source in status_source_ids; else reported or claimed", () => {
    // Kobol dry run 2026-11-11: an incident marked "confirmed" on a newsroom's report alone (VICTIM_STATUS).
    const b = bullet("Incident status");
    expect(b).toContain("`status_source_ids`");
    expect(b).toContain('`"confirmed"` needs a tier 1 confirmation among them');
    for (const t of CONFIRMING_SOURCE_TYPES) expect(b).toContain(`(\`"${t}"\`)`);
    expect(b).toContain('when only newsrooms report the impact, set `"reported"` and cite a newsroom in `status_source_ids`');
    expect(b).toContain('when only the attacker says so, `"claimed"`');
  });

  it("PR10: a critical flaw above watch needs the vendor to confirm its first CVE: its CNA, its own advisory in flaw_evidence, or a reviewed GitHub advisory", () => {
    // Kobol dry run 2026-11-11: repair 2 could not fix VENDOR_CONFIRMED.
    const b = bullet("A critical flaw above `\"watch\"`");
    expect(b).toContain("the first CVE in `cve_ids`");
    expect(b).toContain("assigned by the vendor itself (its CNA)");
    expect(b).toContain("a `flaw_evidence` entry for that CVE cites the vendor's own advisory, on its own domain");
    expect(b).toContain("`github.com/advisories/GHSA-...`");
    expect(b).toContain('set `"watch"`');
  });
});

describe("PR11: the Angle's one number and the Gap sentences, as WORDS_OVER and LEAD_GROUNDED check them (row 145)", () => {
  const flatPrompt = PROMPT.replace(/\s+/g, " ");
  const STYLE = read("routine/STYLE.md");
  const flatStyle = STYLE.replace(/\s+/g, " ");
  const styleSection = (n: number) => {
    const from = flatStyle.indexOf(`## ${n}. `);
    return flatStyle.slice(from, flatStyle.indexOf(" ## ", from + 4));
  };
  const schema = JSON.parse(read("routine/schema/draft-brief.schema.json")) as {
    properties: { angle: { properties: { text: { description: string } } }; lead: { items: { properties: { item_ids: { description: string }; gap: { description: string } } } } };
  };

  it("PR11: PROMPT.md keeps quotable values verbatim with their denominators, but the Angle names its window and date instead", () => {
    // Kobol canary 2026-11-11: an Angle that held its denominator ("37% of the 157 flaws") had two numbers (WORDS_OVER).
    const b = flatPrompt.slice(flatPrompt.indexOf("- **Numbers**")).split(" - **")[0]!;
    expect(b).toContain("`quotable` values, verbatim, with their denominators and dates");
    expect(b).toContain("The Angle holds one number, so it names its window and date, not its denominator (`STYLE.md` §12)");
    expect(flatPrompt).toContain('- [ ] A Lead sentence that cites no item has `"gap": true` and quotes only Gap headline numbers.');
    // Review of row 145: a label figure counts the second time, "1.9x" is no number, and an hour count is no Gap number.
    // Review of the sixth pass: the label figures are optional, at most once, and only a Gap sentence that names the day uses dates.
    // Review of the seventh pass: a ratio in words is no number either, so ratios are written in digits.
    expect(flatPrompt).toContain('- [ ] Angle label figures at most once; ratios in digits with "times", not "x"; a Gap sentence that names the day uses dates, not hours. - [ ] ');
    expect(flatPrompt).not.toContain("label figures appear once");
  });

  it("PR11: STYLE.md §12 lets a metric Angle repeat its label's figures, and names the window and date, not the count", () => {
    const s12 = styleSection(12);
    expect(s12).toContain("With a metrics path you may repeat the figures its quotable label prints, as the label writes them");
    expect(s12).toContain('("26 weeks", "within 7 days", "80% interval"), once each, and they are not counted. '
      + "Any other number counts, a label figure written a second time included");
    expect(s12).toContain('name the window and date, not the count ("37% in the 26 weeks to 6 Nov", not "37% of the 157 flaws")');
    expect(s12).toContain('Write a ratio as the Gap does, "1.9 times", never "1.9x".');
    expect(s12).not.toContain("no other window length may appear"); // row 145's first wording, replaced
  });

  it("PR11: STYLE.md §6 sends the Angle to §12 for its denominator, and makes every Lead sentence citing no item a Gap sentence", () => {
    const s6 = styleSection(6);
    expect(s6).toContain("The Angle holds exactly one number, so it names its window and date instead of a denominator");
    expect(s6).toContain("A Lead sentence that cites no item is a Gap sentence: `gap: true` with `item_ids` empty, quoting only the Gap headline's numbers, or none.");
    expect(s6).toContain("On a day with no items, every Lead sentence is one.");
    expect(s6).toContain('When a Gap sentence names the day, it names it by its dates ("13 to 14 Oct"), never as a length of hours ("the 24 hours to 04:30"), which is not a Gap number.');
    // Review of the seventh pass: a verbatim quote keeps the source's words ("10x"), and a ratio in words is not read either.
    expect(s6).toContain('A ratio is written as the Gap writes it, in digits, "1.9 times", never "1.9x" or "ten times the pace", even where a source '
      + 'writes it so, in every field but a verbatim quote, which keeps the source\'s words: the validator cannot read a ratio glued to x or in '
      + "words, so it fails any it finds.");
    // Review of the eighth pass: "2 times" for the Gap's "more than twice" fails LEAD_GROUNDED, as "two times" fails NUMBER_FORM.
    expect(s6).toContain('The Gap\'s own "twice" stays in words, as the Gap prints it ("more than twice the 2023–24 pace"), never "2 times".');
    expect(flatStyle).not.toContain("so it fails one");
    expect(flatStyle).not.toContain("in every field, even where");
    expect(styleSection(2)).toContain("a day with nothing that clears a bar has no items at all, and a Lead of Gap sentences only (§6)");
    expect(styleSection(2)).toContain('Gap sentences only (§6); when a Gap sentence names the day, it names it by its dates ("13 to 14 Oct"), never as a length of hours.');
    // Said only of a Gap sentence that names the day, never as a rule for every Gap sentence (review of the sixth pass).
    expect(flatStyle).not.toMatch(/A Gap sentence names the day|which name the day/);
    // §6 and §12 give the Angle's example the same date.
    expect(s6).toContain('("37% in the 26 weeks to 6 Nov", §12)');
    expect(flatStyle).not.toContain("9 Nov");
  });

  it("PR11: the schema says the same to the agent", () => {
    expect(schema.properties.angle.properties.text.description).toContain('the figures its quotable label prints ("26 weeks", "within 7 days", "80% interval") are not counted');
    expect(schema.properties.angle.properties.text.description).toContain("name the window and date, not a denominator");
    expect(schema.properties.angle.properties.text.description).toContain("are not counted the first time each is written");
    expect(schema.properties.angle.properties.text.description).toContain('Write a ratio as the Gap does, "1.9 times", never "1.9x"');
    expect(schema.properties.lead.items.properties.gap.description).toContain("or cites no item");
    expect(schema.properties.lead.items.properties.gap.description).toContain('so when it names the day, it names it by its dates ("13 to 14 Oct"), never as a length of hours');
    expect(schema.properties.lead.items.properties.item_ids.description).toContain("as every sentence is on a day with no items");
  });
});
