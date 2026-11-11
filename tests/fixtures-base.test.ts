// The valid draft-side fixtures (SPEC §4.12 "Fixtures and tests"): every file parses with its schema and
// matches the builder, the weekday draft has the eight item shapes, the Monday and quiet drafts their own,
// each draft validates cleanly against its own inputs, and `fixtures/src/build.ts --check` passes. The
// binary outputs (P2's two delta zips) are compared byte for byte and must parse as zips.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchVendor } from "@/lib/config";
import { isMonday } from "@/lib/dates";
import { orderItems } from "@/lib/items";
import { AgentContext } from "@/lib/schema/context";
import { DraftBrief } from "@/lib/schema/draft-brief";
import { Metrics } from "@/lib/schema/metrics";
import { Evidence } from "@/lib/schema/misc";
import { Pack } from "@/lib/schema/pack";
import { publisherFor } from "@/lib/sources";
import { numbersIn } from "@/lib/text";
import { normalizeUrl } from "@/lib/urls";
import { RegionsInputFile, cveLookupFromDir, validateDraft } from "@/lib/validate";
import { parseDeltaZip } from "@/lib/feeds/zip";
import { FIXTURE_DIRS, allOutputs, compareOutputs, inputPath, isBinaryOutput, jsonText, main, textOutputs, validDraftPath, writeOutputs } from "@/fixtures/src/build";
import { EOD_ZIP_PATH, HOURLY_ZIP_PATH } from "@/fixtures/src/feeds";
import { WEEKDAY_ITEMS, editionDraft, mondayDraft, quietDraft, weekdayDraft } from "@/fixtures/src/drafts";
import {
  CVE_RECORDS_DIR, draftInputs, editionContext, editionEvidence, editionMetrics, editionPack, editionRegionsInput, fixtureConfig,
} from "@/fixtures/src/inputs";
import { EDITION_NAMES, RECORD_IDS } from "@/fixtures/src/world";
import { modelRe } from "./helpers/model-names";

const root = path.join(__dirname, "..");
const read = (rel: string): unknown => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

const INPUTS = [
  ["context", AgentContext, editionContext],
  ["evidence", Evidence, editionEvidence],
  ["metrics", Metrics, editionMetrics],
  ["packs", Pack, editionPack],
  ["regions-input", RegionsInputFile, editionRegionsInput],
] as const;

describe("valid fixture files", () => {
  it.each(EDITION_NAMES)("%s: the draft and every input parse with their schemas and match the builder", (name) => {
    expect(DraftBrief.parse(read(validDraftPath(name)))).toEqual(editionDraft(name));
    for (const [folder, schema, build] of INPUTS) {
      const parsed = (schema as { parse: (v: unknown) => unknown }).parse(read(inputPath(folder, name)));
      expect(parsed, `${folder}/${name}.json`).toEqual(build(name));
    }
  });

  it("holds every cited CVE as a PUBLISHED record, with no references", () => {
    const lookup = cveLookupFromDir(CVE_RECORDS_DIR);
    const cited = new Set(EDITION_NAMES.flatMap((n) => editionDraft(n).items.flatMap((i) => i.cve_ids)));
    for (const id of [...cited, ...RECORD_IDS]) expect(lookup.get(id)?.state, id).toBe("PUBLISHED");
    for (const id of RECORD_IDS) {
      const text = fs.readFileSync(path.join(CVE_RECORDS_DIR, `${id}.json`), "utf8");
      expect(text).not.toMatch(/"references"/);
      expect(lookup.get(id)?.exploit_reference).toBe(false);
    }
  });

  it("marks invented sources SAMPLE and uses no em-dash or model identifier", () => {
    for (const name of EDITION_NAMES) {
      for (const s of editionDraft(name).sources) {
        if (s.source_type !== "cve_record") expect(s.title.startsWith("SAMPLE"), s.url).toBe(true);
        expect(s.url.includes("/ct-sample/") || s.source_type === "cve_record", s.url).toBe(true);
      }
    }
    // Shared with the other scans (tests/helpers/model-names.ts), built from parts as no-europe-strings requires.
    const re = modelRe();
    for (const o of textOutputs(allOutputs())) {
      expect(o.text, o.path).not.toMatch(/\u2014/);
      expect(o.text, o.path).not.toMatch(re);
    }
  });

  it("writes every binary output as a stored-method zip that parseDeltaZip() reads, and every other output as text", () => {
    const outputs = allOutputs();
    const binary = outputs.filter(isBinaryOutput);
    expect(binary.map((o) => o.path).sort()).toEqual([EOD_ZIP_PATH, HOURLY_ZIP_PATH].sort());
    for (const o of binary) {
      expect(o.path.endsWith(".zip"), o.path).toBe(true);
      expect(o.bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), o.path).toBe(true);
      const z = parseDeltaZip(o.bytes);
      expect(z.records.length, o.path).toBeGreaterThan(0);
      expect(z.names.every((n) => /^deltaCves\/CVE-\d{4}-\d{4,}\.json$/.test(n)), o.path).toBe(true);
    }
    for (const o of textOutputs(outputs)) expect(o.path.endsWith(".zip"), o.path).toBe(false);
  });

  it("hands out deep copies", () => {
    const a = weekdayDraft();
    a.items.pop();
    a.lead[0]!.text = "changed.";
    expect(weekdayDraft().items).toHaveLength(8);
    expect(weekdayDraft().lead[0]!.text).not.toBe("changed.");
    const m = editionMetrics("weekday");
    m.headline.quoted = [];
    expect(editionMetrics("weekday").headline.quoted.length).toBeGreaterThan(0);
  });

  it("prints JSON with two-space indent, a trailing newline and the schema's key order", () => {
    const d = weekdayDraft();
    const reversed = Object.fromEntries(Object.entries(d).reverse());
    expect(jsonText(reversed, DraftBrief)).toBe(jsonText(d, DraftBrief));
    expect(jsonText(d, DraftBrief).startsWith('{\n  "schema_version": 1,\n  "date": ')).toBe(true);
    expect(jsonText(d, DraftBrief).endsWith("}\n")).toBe(true);
  });
});

describe("the weekday draft (SPEC §4.12: eight items)", () => {
  const cfg = fixtureConfig();
  const d = weekdayDraft();
  const byId = (id: string) => d.items.find((i) => i.id === id)!;
  const source = (id: string) => d.sources.find((s) => s.id === id)!;
  const info = (id: string) => publisherFor(source(id).url, source(id).source_type, { sourceTiers: cfg.sourceTiers, vendors: cfg.vendors });

  it("is a weekday after the sample claims open, with eight items in display order", () => {
    expect(isMonday(d.date)).toBe(false);
    expect(d.date > "2026-10-01").toBe(true);
    expect(d.items).toHaveLength(8);
    expect(d.items.map((i) => i.id)).toEqual(orderItems(d.items).map((i) => i.id));
    expect(new Set(d.items.map((i) => i.id))).toEqual(new Set(Object.values(WEEKDAY_ITEMS)));
  });

  it("has a Critical exploited flaw with two publishers, one of tier 1", () => {
    const it = byId(WEEKDAY_ITEMS.criticalExploited);
    expect([it.kind, it.severity]).toEqual(["exploited_flaw", "critical"]);
    const pubs = it.source_ids.map(info).filter((p) => p.tier <= 2);
    expect(new Set(pubs.map((p) => p.publisher)).size).toBeGreaterThanOrEqual(2);
    expect(pubs.some((p) => p.tier === 1)).toBe(true);
  });

  it("has a Taiwanese-vendor flaw", () => {
    const it = byId(WEEKDAY_ITEMS.taiwanVendor);
    expect(it.kind).toBe("critical_flaw");
    const rec = cveLookupFromDir(CVE_RECORDS_DIR).get(it.cve_ids[0]!)!;
    expect(matchVendor(cfg, { affectedVendors: rec.vendors })?.country).toBe("TW");
  });

  it("has a confirmed AI-found item backed by a CVE record credit", () => {
    const it = byId(WEEKDAY_ITEMS.aiConfirmed);
    expect([it.ai_role, it.ai_confidence]).toEqual(["ai_found", "confirmed"]);
    expect(it.ai_evidence.some((e) => !e.from_claimant && source(e.source_id).source_type === "cve_record")).toBe(true);
  });

  it("has a Glasswing item claimed by Anthropic", () => {
    const it = byId(WEEKDAY_ITEMS.glasswing);
    expect(it.headline).toContain("Project Glasswing");
    expect([it.ai_confidence, it.ai_claimant, it.claim_type]).toEqual(["claimed", "Anthropic", "self_reported"]);
    expect(it.source_ids.some((id) => info(id).publisher === "anthropic")).toBe(true);
  });

  it("has a claimed victim shown unnamed in a row", () => {
    const it = byId(WEEKDAY_ITEMS.claimedVictim);
    expect(d.items.indexOf(it)).toBeGreaterThanOrEqual(3);
    expect([it.kind, it.severity, it.incident?.status, it.incident?.victim]).toEqual(["breach", "watch", "claimed", null]);
    expect(it.summary).toContain(`${it.incident!.description}, claimed by ${it.incident!.claimed_by}, unverified`);
  });

  it("has a China-axis item with a named attributor", () => {
    const it = byId(WEEKDAY_ITEMS.chinaAxis);
    const a = it.attribution[0]!;
    expect([it.kind, a.nexus, a.confidence_level]).toEqual(["campaign", "prc", "moderate"]);
    expect(it.headline).toContain(a.attributed_by);
    expect(d.taiwan_lens.rows.find((r) => r.row === "china_axis")?.item_ids).toEqual([it.id]);
  });

  it("has a policy Landmark and a patch batch", () => {
    const pol = byId(WEEKDAY_ITEMS.landmark);
    expect([pol.kind, pol.landmark, pol.severity]).toEqual(["policy", true, null]);
    const pt = byId(WEEKDAY_ITEMS.patchBatch);
    expect([pt.kind, pt.release_id]).toEqual(["patch_batch", "rel-microsoft-2026-10"]);
  });
});

describe("the Monday and quiet drafts", () => {
  it("Monday carries the week in review; the quiet day has no items or sources", () => {
    const m = mondayDraft();
    expect(isMonday(m.date)).toBe(true);
    expect(m.week_in_review).not.toBeNull();
    expect(editionContext("monday").weekly).toBe(true);
    const q = quietDraft();
    expect(isMonday(q.date)).toBe(false);
    expect([q.items, q.sources, q.week_in_review]).toEqual([[], [], null]);
  });
});

describe("each draft against its own inputs", () => {
  it.each(EDITION_NAMES)("%s validates with no errors and no warnings", (name) => {
    const r = validateDraft(editionDraft(name), draftInputs(name));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it.each(EDITION_NAMES)("%s: the evidence holds every cited URL with seen text", (name) => {
    const ev = editionEvidence(name);
    for (const s of editionDraft(name).sources) {
      const u = normalizeUrl(s.url);
      expect(ev.urls, u).toContain(u);
      expect(ev.fetched, u).toContain(u);
      expect(ev.texts[u], u).toBeTruthy();
      expect(ev.seen_as[u], u).toBeDefined();
    }
  });

  it.each(EDITION_NAMES)("%s: Gap sentences and the metric Angle quote the metrics' display strings", (name) => {
    const d = editionDraft(name);
    const m = editionMetrics(name);
    const quoted = m.headline.quoted.flatMap((q) => numbersIn(q.display).map((n) => `${n.value}${n.percent ? "%" : ""}`));
    for (const l of d.lead.filter((x) => x.gap)) {
      for (const n of numbersIn(l.text)) expect(quoted, l.text).toContain(`${n.value}${n.percent ? "%" : ""}`);
    }
    expect(editionContext(name).metrics.gap_headline).toBe(m.headline.text);
    if (d.angle.metric_path) {
      const display = editionContext(name).metrics.quotable.filter((q) => q.key === d.angle.metric_path).map((q) => q.display);
      expect(numbersIn(d.angle.text).map((n) => n.raw)).toEqual([display[0]]);
    }
  });
});

describe("fixtures/src/build.ts --check", () => {
  it("finds no stale, missing or added file", () => {
    expect(compareOutputs(allOutputs())).toEqual({ missing: [], stale: [], added: [] });
  });

  it("writes only inside the folders it owns, so an added file anywhere it writes is found", () => {
    expect(allOutputs().filter((o) => !FIXTURE_DIRS.some((d) => o.path.startsWith(`${d}/`))).map((o) => o.path)).toEqual([]);
  });

  it("fails --check on a file no generator writes, and fixtures:gen removes it (SPEC §8.1: any added file)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-fixtures-"));
    try {
      const outputs = allOutputs();
      expect(writeOutputs(outputs, tmp)).toEqual([]);
      const strays = ["fixtures/drafts/invalid--RETIRED_CODE.json", "fixtures/site-content/status/2026-10-17.json"];
      for (const p of strays) {
        fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
        fs.writeFileSync(path.join(tmp, p), "{}\n");
      }
      fs.rmSync(path.join(tmp, outputs[0]!.path));
      expect(compareOutputs(outputs, tmp)).toEqual({ missing: [outputs[0]!.path], stale: [], added: strays });
      const log: string[] = [];
      expect(main(["--check"], (s) => log.push(s), tmp)).toBe(1);
      expect(log.filter((l) => l.startsWith("added: "))).toEqual(strays.map((p) => `added: ${p} (no generator writes it)`));
      expect(writeOutputs(outputs, tmp)).toEqual(strays);
      expect(compareOutputs(outputs, tmp)).toEqual({ missing: [], stale: [], added: [] });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it("exits 0 from the command line", () => {
    const tsx = path.join(root, "node_modules", ".bin", "tsx");
    const out = execFileSync(tsx, ["fixtures/src/build.ts", "--check"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    expect(out).toMatch(/fixture files are up to date/);
  }, 90_000);
});
