// No EuropeTracker leftovers in the fork (SPEC §10 Foundation). Kobol paths, the keychain, arm64 and
// the pinned CLI are CyberTracker's own since SPEC v2.0, so they are no longer patterns. Scans the tracked (and not ignored)
// files under the code folders, never SPEC.md, AGENTS.md, docs/, package-lock.json or saved and
// generated data. This file and tests/agent.test.ts are skipped, because they name the patterns.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_ID_SOURCE, MODEL_SAMPLES } from "./helpers/model-names";

const root = path.join(__dirname, "..");
const DIRS = ["app/", "components/", "lib/", "scripts/", "config/", "routine/", "fixtures/src/", "fixtures/injection/", ".github/", "tests/"];
const FILES = ["package.json", "next.config.ts", "tsconfig.json", "vitest.config.ts", "postcss.config.mjs"];
const SKIP = new Set(["tests/no-europe-strings.test.ts", "tests/agent.test.ts"]);

const PATTERNS: { name: string; re: RegExp; only?: string }[] = [
  { name: "EuropeTracker", re: /EuropeTracker/ },
  { name: "europetracker (except siblings.europe)", re: /europetracker/ },
  { name: "ET_ variable", re: /\bET_[A-Z]/ },
  { name: "Kyiv", re: /Kyiv/ },
  { name: "rung", re: /\brungs?\b/ },
  { name: "pathway", re: /\bpathway\b/ },
  { name: "model flags", re: /--model\b|--fallback-model\b/ },
  { name: "model identifiers", re: new RegExp(MODEL_ID_SOURCE) },
  { name: "Telegram web previews", re: /t\.me\/s\// },
  { name: "Google News RSS", re: /news\.google\.com\/rss/ },
  { name: "Telegram in the registry", re: /t\.me\/|telegram/i, only: "config/sources.yaml" },
];

function files(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
  const all = [...new Set(out.split("\0").filter(Boolean))];
  return all
    .filter((f) => (DIRS.some((d) => f.startsWith(d)) || FILES.includes(f)) && !SKIP.has(f) && fs.existsSync(path.join(root, f)))
    .sort();
}

function text(file: string): string {
  const raw = fs.readFileSync(path.join(root, file), "utf8");
  if (file !== "config/run.json") return raw;
  // The one allowed mention: the sibling link in config/run.json.
  const cfg = JSON.parse(raw) as { siblings?: Record<string, string> };
  if (cfg.siblings?.europe) cfg.siblings.europe = "";
  return JSON.stringify(cfg, null, 2);
}

describe("no Europe strings", () => {
  const list = files();
  const bodies = new Map(list.map((f) => [f, text(f)]));

  it("scans the code folders", () => {
    expect(list).toContain("lib/dates.ts");
    expect(list).toContain("scripts/lib/agent.ts");
    expect(list).toContain("config/run.json");
    expect(list.some((f) => f.startsWith("docs/") || f === "SPEC.md" || f === "AGENTS.md" || f === "package-lock.json")).toBe(false);
  });

  it("the model patterns catch every planted family, the generic form and both flags", () => {
    const model = PATTERNS.filter((p) => p.name.startsWith("model "));
    for (const sample of MODEL_SAMPLES) expect(model.some((p) => p.re.test(`see ${sample} here`)), sample).toBe(true);
    expect(model.some((p) => p.re.test("npm install @anthropic-ai/claude-code@2.1.316"))).toBe(false);
  });

  it("finds no hit for any pattern", () => {
    const report: string[] = [];
    const hits: string[] = [];
    for (const p of PATTERNS) {
      let n = 0;
      for (const [file, body] of bodies) {
        if (p.only && file !== p.only) continue;
        body.split("\n").forEach((line, i) => {
          if (p.re.test(line)) {
            n += 1;
            hits.push(`${p.name}: ${file}:${i + 1}`);
          }
        });
      }
      report.push(`${String(n).padStart(3)}  ${p.name}`);
    }
    console.log(`no-europe-strings over ${bodies.size} files:\n${report.join("\n")}`);
    expect(hits).toEqual([]);
  });
});
