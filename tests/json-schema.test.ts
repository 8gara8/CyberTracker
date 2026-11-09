// The agent's JSON Schema (SPEC §4.4, §8.1, §10 P1 item 4): routine/schema/draft-brief.schema.json is
// current, compact (every line under 1,000 characters), closed (an unknown key fails) and accepts a draft
// the validator would accept. No JSON Schema library is installed, so `check` below implements exactly
// the keywords the file uses and throws on any other, so a new keyword can never be skipped silently.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DRAFT_SCHEMA_PATH, SCHEMA_LINE_LIMIT, draftSchema, printJson, renderDraftSchema, schemaFileStats } from "@/lib/json-schema";
import { DraftBrief } from "@/lib/schema/draft-brief";
import { NONE_FOUND, TAIWAN_LENS_ROWS, TAIWAN_NO_NEWS } from "@/lib/vocab";

const root = path.join(__dirname, "..");
const committed = () => fs.readFileSync(path.join(root, DRAFT_SCHEMA_PATH), "utf8");

type Schema = Record<string, unknown>;
const KNOWN = new Set([
  "$schema", "title", "description", "type", "properties", "required", "additionalProperties", "items", "anyOf", "const", "enum",
  "minItems", "maxItems", "minLength", "maxLength", "pattern",
]);

function typeOk(v: unknown, t: string): boolean {
  switch (t) {
    case "null": return v === null;
    case "boolean": return typeof v === "boolean";
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return Number.isInteger(v);
    case "array": return Array.isArray(v);
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    default: throw new Error(`unknown type ${t}`);
  }
}

/** JSON Schema 2020-12 for the keywords above; returns "path: message" strings, [] when valid. */
function check(schema: Schema, v: unknown, at = "$"): string[] {
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`keyword ${k} at ${at} is not handled by this test`);
  const errs: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => typeOk(v, t))) return [`${at}: expected ${types.join(" or ")}`];
  }
  if ("const" in schema && JSON.stringify(v) !== JSON.stringify(schema.const)) errs.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !(schema.enum as unknown[]).some((e) => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${at}: not in enum`);
  if (schema.anyOf && !(schema.anyOf as Schema[]).some((s) => check(s, v, at).length === 0)) errs.push(`${at}: matches no anyOf branch`);
  if (typeof v === "string") {
    const n = [...v].length;
    if (typeof schema.minLength === "number" && n < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && n > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(v)) errs.push(`${at}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(v)) {
    if (typeof schema.minItems === "number" && v.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && v.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) v.forEach((x, i) => errs.push(...check(schema.items as Schema, x, `${at}[${i}]`)));
  }
  if (typeOk(v, "object")) {
    const o = v as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const r of (schema.required ?? []) as string[]) if (!(r in o)) errs.push(`${at}: missing ${r}`);
    for (const [k, x] of Object.entries(o)) {
      if (props[k]) errs.push(...check(props[k], x, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unknown key ${k}`);
    }
  }
  return errs;
}

/** Every object schema in the file, with its JSON path. */
function objectSchemas(s: unknown, at = "$", out: { at: string; s: Schema }[] = []): { at: string; s: Schema }[] {
  if (Array.isArray(s)) s.forEach((x, i) => objectSchemas(x, `${at}[${i}]`, out));
  else if (s && typeof s === "object") {
    const o = s as Schema;
    if (o.type === "object") out.push({ at, s: o });
    for (const [k, x] of Object.entries(o)) objectSchemas(x, `${at}.${k}`, out);
  }
  return out;
}

/** A minimal draft for a Tuesday data-light morning (SAMPLE): no items, a Gap-only Lead, a metric Angle. */
function minimalDraft(): Record<string, unknown> {
  return {
    schema_version: 1,
    date: "2026-11-10",
    generated_at: "2026-11-10T04:52:00+08:00",
    lead: [{ text: "SAMPLE: the Gap held at 41% this week.", item_ids: [], gap: true }],
    angle: {
      text: "SAMPLE: 41% of KEV additions were exploited at disclosure.",
      source_id: null,
      metric_path: "window.w26.at_disclosure_share",
      as_of: "2026-11-09",
      counterpoint: NONE_FOUND,
      counterpoint_source_ids: [],
      claim_id: null,
    },
    region_raises: [],
    items: [],
    taiwan_lens: {
      analysis: TAIWAN_NO_NEWS,
      item_ids: [],
      source_ids: [],
      rows: TAIWAN_LENS_ROWS.map((row) => ({ row, text: null, item_ids: [], source_ids: [] })),
      japan: { text: null, item_ids: [], source_ids: [] },
    },
    scoreboard_entries: [],
    week_in_review: null,
    corrections: [],
    elsewhere: [],
    sources: [],
  };
}

/** The minimal draft plus one SAMPLE item and its source, so the item and source subtrees are exercised. */
function draftWithItem(): Record<string, unknown> {
  const d = minimalDraft();
  d.sources = [{
    id: "s1",
    title: "SAMPLE advisory for an example appliance",
    title_en: null,
    language: "en",
    outlet: "Example Vendor",
    url: "https://vendor.example/security/advisory-2026-0001",
    source_type: "vendor_advisory",
    published_at: "2026-11-09T09:00:00+08:00",
  }];
  d.items = [{
    id: "cve-2026-104935",
    kind: "exploited_flaw",
    headline: "SAMPLE: example appliance flaw exploited before a fix",
    summary: "SAMPLE summary of an invented flaw.",
    why_it_matters: "SAMPLE: attackers moved before defenders could patch.",
    severity: "high",
    landmark: false,
    ai_role: "none",
    ai_role_secondary: null,
    ai_confidence: null,
    ai_claimant: null,
    ai_evidence: [],
    claim_type: "independent",
    regions: ["US", "TW"],
    topics: [],
    attribution: [],
    incident: null,
    cve_ids: ["CVE-2026-104935"],
    release_id: null,
    flaw_evidence: [{ cve_id: "CVE-2026-104935", kind: "exploited", basis: "vendor_confirmed", date: "2026-11-09", source_id: "s1" }],
    exploit_reported_in_sources: null,
    exposure: null,
    standing_story: null,
    source_ids: ["s1"],
  }];
  return d;
}

describe("draft JSON Schema file", () => {
  const text = renderDraftSchema();
  const stats = schemaFileStats(text);

  it("is current: the committed file equals the generated one", () => {
    expect(committed()).toBe(text);
  });

  it("keeps every line under 1,000 characters", () => {
    const long = text.split("\n").map((l, i) => [i + 1, l.length] as const).filter(([, n]) => n >= SCHEMA_LINE_LIMIT);
    expect(long).toEqual([]);
    expect(stats.longestLine).toBeLessThan(SCHEMA_LINE_LIMIT);
  });

  it("reports its size for the PR", () => {
    console.log(`${DRAFT_SCHEMA_PATH}: ${stats.bytes} bytes, ${stats.lines} lines, longest line ${stats.longestLine} characters (line ${stats.longestLineNo})`);
    expect(stats.bytes).toBe(fs.statSync(path.join(root, DRAFT_SCHEMA_PATH)).size);
    expect(stats.lines).toBe(text.trimEnd().split("\n").length);
  });

  it("is draft 2020-12 JSON, titled, with no em-dash", () => {
    const parsed = JSON.parse(text) as Schema;
    expect(parsed).toEqual(draftSchema());
    expect(parsed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(parsed.title).toBe("CyberTracker DraftBrief");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });

  it("closes every object and requires every key (explicit nulls, never missing)", () => {
    const objects = objectSchemas(draftSchema());
    expect(objects.length).toBeGreaterThan(10);
    for (const { at, s } of objects) {
      expect(s.additionalProperties, at).toBe(false);
      expect([...((s.required ?? []) as string[])].sort(), at).toEqual(Object.keys((s.properties ?? {}) as Schema).sort());
    }
  });

  it("holds no S or C key of the Brief or Item", () => {
    const schema = draftSchema() as { properties: Record<string, Schema> };
    const top = Object.keys(schema.properties);
    for (const k of ["published_at", "regions", "gap", "computed", "kev_lines", "scoreboard"]) expect(top).not.toContain(k);
    const item = (schema.properties.items!.items as Schema).properties as Schema;
    for (const k of ["actor_nexus", "first_seen", "vendor", "cves", "release", "public_exploit", "anthropic_disclosure", "withheld"]) {
      expect(Object.keys(item)).not.toContain(k);
    }
    const source = (schema.properties.sources!.items as Schema).properties as Schema;
    for (const k of ["publisher", "publisher_name", "tier", "state_label", "seen_as"]) expect(Object.keys(source)).not.toContain(k);
  });
});

describe("draft JSON Schema against hand-built drafts", () => {
  const schema = draftSchema();

  it("accepts a minimal valid draft, as Zod does", () => {
    const d = minimalDraft();
    expect(DraftBrief.safeParse(d).success).toBe(true);
    expect(check(schema, d)).toEqual([]);
  });

  it("accepts a draft with one item and one source, as Zod does", () => {
    const d = draftWithItem();
    expect(DraftBrief.safeParse(d).error?.issues ?? []).toEqual([]);
    expect(check(schema, d)).toEqual([]);
  });

  it("rejects an unknown top-level key", () => {
    const d = { ...minimalDraft(), gap: { quoted: [] } };
    expect(DraftBrief.safeParse(d).success).toBe(false);
    expect(check(schema, d)).toEqual(["$: unknown key gap"]);
  });

  it("rejects an S key on an item (cves) and on a source (tier)", () => {
    const withCves = draftWithItem();
    (withCves.items as Record<string, unknown>[])[0]!.cves = [];
    expect(DraftBrief.safeParse(withCves).success).toBe(false);
    expect(check(schema, withCves)).toEqual(["$.items[0]: unknown key cves"]);

    const withTier = draftWithItem();
    (withTier.sources as Record<string, unknown>[])[0]!.tier = 1;
    expect(DraftBrief.safeParse(withTier).success).toBe(false);
    expect(check(schema, withTier)).toEqual(["$.sources[0]: unknown key tier"]);
  });

  it("rejects a missing key, a wrong enum and a too-long headline", () => {
    const missing = minimalDraft();
    delete missing.week_in_review;
    expect(check(schema, missing)).toEqual(["$: missing week_in_review"]);

    const badRow = minimalDraft();
    ((badRow.taiwan_lens as { rows: { row: string }[] }).rows[0]!).row = "taiwan";
    expect(check(schema, badRow)).toEqual(["$.taiwan_lens.rows[0].row: not in enum"]);

    const long = draftWithItem();
    (long.items as Record<string, unknown>[])[0]!.headline = "x".repeat(91);
    expect(check(schema, long)).toEqual(["$.items[0].headline: longer than 90"]);
  });
});

describe("printJson", () => {
  it("keeps short values on one line and breaks long ones, round-tripping exactly", () => {
    expect(printJson({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
    const big = { list: Array.from({ length: 40 }, (_, i) => `value-${i}`), nested: { k: "v".repeat(120) }, n: null };
    const out = printJson(big);
    expect(out.split("\n").length).toBeGreaterThan(3);
    expect(JSON.parse(out)).toEqual(big);
    // A long array breaks one entry per line; a long string is never split.
    expect(out.split("\n").filter((l) => /^ {4}"value-\d+",?$/.test(l))).toHaveLength(40);
    expect(out).toContain(`\n    "k": "${"v".repeat(120)}"\n`);
    expect(out).toContain('\n  "n": null\n}');
  });
});

describe("scripts/gen-json-schema.ts", () => {
  it("--check fails on a missing or stale file and passes once written", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-schema-"));
    const run = (...args: string[]) => {
      try {
        const out = execFileSync(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "scripts/gen-json-schema.ts"), ...args], {
          cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, out };
      } catch (e) {
        const err = e as { status: number; stderr: string };
        return { code: err.status, out: err.stderr };
      }
    };
    try {
      expect(run("--check").code).toBe(1);
      expect(fs.existsSync(path.join(tmp, DRAFT_SCHEMA_PATH))).toBe(false);
      expect(run().code).toBe(0);
      expect(fs.readFileSync(path.join(tmp, DRAFT_SCHEMA_PATH), "utf8")).toBe(renderDraftSchema());
      expect(run("--check").code).toBe(0);
      fs.appendFileSync(path.join(tmp, DRAFT_SCHEMA_PATH), " ");
      const stale = run("--check");
      expect(stale.code).toBe(1);
      expect(stale.out).toContain("is stale");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
