// fixtures/reference/ and Appendix D offline (SPEC §5.9 steps 5 and 6, rulings R22 to R24): every figure
// Appendix D prints is recomputed from the three committed files with the committed config, and the files
// are checked against the constants and the config they were built with. The clone half of the check is
// `npm run backfill -- --check-reference` with the clone (P2 report); this file never reads a clone.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCheckedConfig } from "@/lib/config";
import { jsonText, sha256Hex } from "@/lib/json";
import { REFERENCE, REFERENCE_JOIN_SHA256 } from "@/lib/metrics/reference";
import { ReferenceAiCreditsFile, ReferenceFloodDaysFile, ReferenceJoinFile } from "@/lib/schema/reference";
import {
  APPENDIX_D, appendixFigures, CLONE_ONLY, compareFigures, d6Text, expectedFigures, formatFigures, REFERENCE_FILES, REFERENCE_INPUTS,
} from "@/scripts/lib/appendix-d";
import { D6_JP, D6_TW } from "./helpers/d6";

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "fixtures", "reference");
const config = loadCheckedConfig({ root: ROOT });
const text = (f: string) => fs.readFileSync(path.join(DIR, f), "utf8");
const join = ReferenceJoinFile.parse(JSON.parse(text("kev-cve-join.json")));
const floodDays = ReferenceFloodDaysFile.parse(JSON.parse(text("flood-days.json")));
const aiCredits = ReferenceAiCreditsFile.parse(JSON.parse(text("ai-credits.json")));
const src = { join, floodDays, aiCredits, config, compiled: config.compiled };

describe("fixtures/reference/", () => {
  it("holds the three files, each as jsonText writes it through its schema", () => {
    expect(fs.readdirSync(DIR).sort()).toEqual([...REFERENCE_FILES].sort());
    expect(text("kev-cve-join.json")).toBe(jsonText(join, ReferenceJoinFile));
    expect(text("flood-days.json")).toBe(jsonText(floodDays, ReferenceFloodDaysFile));
    expect(text("ai-credits.json")).toBe(jsonText(aiCredits, ReferenceAiCreditsFile));
  });

  it("REFERENCE_JOIN_SHA256 is the SHA-256 of kev-cve-join.json's bytes (ruling R24)", () => {
    expect(REFERENCE_JOIN_SHA256).toBe(sha256Hex(fs.readFileSync(path.join(DIR, "kev-cve-join.json"))));
  });

  it("records the reference's commit, catalog and cutoff", () => {
    for (const f of [join, floodDays, aiCredits]) {
      expect(f.cve_list_commit).toBe(REFERENCE.flood.cve_list_commit);
      expect(f.cutoff).toBe(REFERENCE_INPUTS.cutoff);
    }
    expect(join.kev_catalog_version).toBe(REFERENCE_INPUTS.kevCatalogVersion);
    expect(join.kev_data_commit).toBe(REFERENCE_INPUTS.kevDataCommit);
  });

  it("was built with the committed AI-finder list (a list change fails here until --fixtures reruns)", () => {
    expect(aiCredits.finders_sha256).toBe(config.sha256.aiFinders);
    expect(aiCredits.finders_version).toBe(config.aiFinders.version);
  });

  it("holds ids, dates, counts and tool names only: no URL and no e-mail form", () => {
    for (const f of REFERENCE_FILES) {
      expect(text(f)).not.toMatch(/https?:\/\//);
      expect(text(f)).not.toMatch(/[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i);
    }
  });
});

describe("Appendix D from the committed fixtures", () => {
  const figures = appendixFigures(src);
  const rows = compareFigures(expectedFigures(config), figures, null);

  it("every figure equals the printed value", () => {
    const bad = rows.filter((r) => !r.ok);
    expect(bad.map((r) => `${r.id}: expected ${r.expected}, got ${r.fixtures}`)).toEqual([]);
  });

  it("every figure but the clone-only ones is computed", () => {
    const expected = Object.keys(expectedFigures(config));
    const missing = expected.filter((id) => !CLONE_ONLY.has(id) && !(id in figures));
    expect(missing).toEqual([]);
    expect(Object.keys(figures).filter((id) => !expected.includes(id))).toEqual([]);
    for (const id of CLONE_ONLY) expect(APPENDIX_D[id]).toBeTypeOf("string");
  });

  it("the table marks a changed count as a difference", () => {
    const altered = { ...figures, "D.1 rows": figures["D.1 rows"]!.replace("903", "902") };
    const table = compareFigures(expectedFigures(config), altered, null);
    const row = table.find((r) => r.id === "D.1 rows")!;
    expect(row.ok).toBe(false);
    expect(formatFigures([row])[1]).toMatch(/· DIFFERS$/);
  });

  it("D.6's strings are the printed rows of tests/helpers/d6.ts", () => {
    expect(d6Text(D6_TW, config.vendors)).toBe(APPENDIX_D["D.6 TW dates"]);
    expect(d6Text(D6_JP, config.vendors)).toBe(APPENDIX_D["D.6 JP dates"]);
    expect(APPENDIX_D["D.6 TW dates"]).not.toMatch(/unmatched:/);
    expect(APPENDIX_D["D.6 JP dates"]).not.toMatch(/unmatched:/);
  });

  it("the REFERENCE constants agree with the fixtures", () => {
    expect(figures["REFERENCE_JOIN_SHA256"]).toBe(REFERENCE_JOIN_SHA256);
    expect(figures["REFERENCE.flood"]).toBe(APPENDIX_D["REFERENCE.flood"]);
    expect(figures["REFERENCE.window"]).toBe(APPENDIX_D["REFERENCE.window"]);
  });
});
