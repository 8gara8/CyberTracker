// routine/STYLE.md (SPEC §11): the fifteen fixed sections, agreement with lib/vocab.ts where it restates
// a vocabulary, and the routine-file rules (no date, no model name, no secret, no link, no em-dash).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AI_ROLE_INFO, BANNED_WORDS, KIND_INFO, NONE_FOUND, NO_NEWS_ROW, SEVERITY_INFO, TAIWAN_LENS_ROW_INFO, TAIWAN_LENS_ROWS,
  TAIWAN_NO_NEWS, TIER_INFO, WITHHELD_HEADLINE,
} from "@/lib/vocab";

const md = fs.readFileSync(path.join(__dirname, "..", "routine", "STYLE.md"), "utf8");
const flat = md.replace(/\s+/g, " ").toLowerCase();
const has = (text: string) => flat.includes(text.replace(/\s+/g, " ").toLowerCase());

/** §11's outline: Methodology renders sections 6, 7, 8 and 14 by number (STYLE_SECTIONS, §6). */
const TITLES = [
  "The question and the reader", "What counts", "Severity and Landmark", "The AI role", "Regions and actors",
  "Numbers and the Gap", "Sources and tiers", "Naming victims and attackers", "Dangerous material", "Voice and length",
  "Taiwan Lens and the Japan block", "The Angle and the Scoreboard", "Week in review", "Corrections", "Untrusted text",
];

/** Europe's section(md, n), as the Methodology page will read it. */
function section(n: number): { title: string; body: string } | null {
  const m = new RegExp(`^## ${n}\\. (.+)$`, "m").exec(md);
  if (!m) return null;
  const rest = md.slice(m.index + m[0].length);
  const end = rest.search(/^## /m);
  return { title: m[1]!.trim(), body: (end === -1 ? rest : rest.slice(0, end)).trim() };
}

describe("routine/STYLE.md", () => {
  it("has the fifteen sections of §11, numbered and titled in order, each with a body", () => {
    expect([...md.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2]}`)).toEqual(TITLES.map((t, i) => `${i + 1}. ${t}`));
    for (let n = 1; n <= TITLES.length; n += 1) expect(section(n)!.body.length).toBeGreaterThan(100);
    expect(section(6)!.title).toBe("Numbers and the Gap");
    expect(section(7)!.title).toBe("Sources and tiers");
    expect(section(8)!.title).toBe("Naming victims and attackers");
    expect(section(14)!.title).toBe("Corrections");
  });

  // Model identifiers and flags are tests/no-europe-strings.test.ts's, which scans routine/ too.
  it("holds no date, link, secret-like string, emoji or em-dash", () => {
    expect(md).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(md).not.toMatch(/https?:\/\//i);
    expect(md).not.toMatch(/AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|PRIVATE KEY/);
    expect(md).not.toMatch(/\u2014/);
    expect(md).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("agrees with lib/vocab.ts where it restates it", () => {
    for (const info of Object.values(KIND_INFO)) expect(has(info.bar), info.bar).toBe(true);
    for (const info of Object.values(SEVERITY_INFO)) {
      expect(has(info.means), info.means).toBe(true);
      expect(md).toContain(info.pips);
    }
    for (const info of Object.values(TIER_INFO)) expect(has(info.means), info.means).toBe(true);
    for (const id of TAIWAN_LENS_ROWS) {
      const label = TAIWAN_LENS_ROW_INFO[id].label.split(":")[0]!;
      expect(has(label), label).toBe(true);
    }
    for (const info of Object.values(AI_ROLE_INFO)) if (info.chip && info.chip !== "AI: unassessed") expect(md).toContain(info.chip);
    for (const word of BANNED_WORDS) expect(has(word), word).toBe(true);
    for (const fixed of [TAIWAN_NO_NEWS, NO_NEWS_ROW, NONE_FOUND, WITHHELD_HEADLINE]) expect(has(fixed), fixed).toBe(true);
  });
});
