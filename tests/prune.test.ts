// Pruning at the run's finish (scripts/lib/prune.ts; SPEC §9.8). PR1 of the plan, on a temporary root
// laid out as the run leaves it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { KEEP_DAYS, dateInName, pruneDirs, pruneRunFiles } from "@/scripts/lib/prune";

const TODAY = "2026-10-14";
const OLD = addDays(TODAY, -61);    // 2026-08-14: pruned
const EDGE = addDays(TODAY, -60);   // 2026-08-15: kept

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function tree(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-prune-"));
  roots.push(root);
  for (const rel of files) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "x\n");
  }
  return root;
}
const exists = (root: string, rel: string) => fs.existsSync(path.join(root, rel));

describe("pruneRunFiles", () => {
  it("PR1 removes logs, drafts, packs and dry-run copies older than 60 days by the date in the name", () => {
    expect(KEEP_DAYS).toBe(60);
    const gone = [
      `logs/${OLD}.daily.log`, `logs/${OLD}.agent-1.jsonl`, `logs/${OLD}.agent-1-repair-1.jsonl`, `logs/${OLD}.agent-1.stderr`,
      `logs/${OLD}.summary.md`, `logs/${OLD}.status.json`, `logs/2026-01-02.context.json`,
      `logs/dry-run/${OLD}/content/briefs/${OLD}.json`, `logs/dry-run/${OLD}/summary.md`,
      `logs/recompute/${OLD}/metrics/${OLD}.json`, `logs/agent-check/${OLD}.sandbox.jsonl`,
      `drafts/${OLD}.json`, `packs/${OLD}.json`, `packs/${OLD}.md`, `packs/${OLD}.candidates.json`,
    ];
    const kept = [
      // Newer, the edge day, today and a future date.
      `logs/${EDGE}.daily.log`, `logs/${TODAY}.daily.log`, "logs/2026-12-01.daily.log", `drafts/${EDGE}.json`, `packs/${TODAY}.md`,
      `logs/dry-run/${EDGE}/summary.md`, `logs/recompute/${addDays(TODAY, -1)}/metrics/x.json`,
      // Undated names.
      "logs/runs.jsonl", "logs/.lock", "drafts/context.json", "logs/agent-check/canary.jsonl", "logs/notes.txt",
      // The dry-run tree, whatever its files are called.
      `logs/dry-run/tree/content/briefs/${OLD}.json`, `logs/dry-run/tree/${OLD}.json`,
      // Names that only look dated.
      "logs/2026-02-30.daily.log", `logs/${OLD}-notes.txt`, `logs/notes-${OLD}.txt`, `logs/${OLD.replaceAll("-", "")}.log`,
      // Folders pruneRunFiles never reads.
      `needs-review/${OLD}/draft.json`, `content/briefs/${OLD}.json`, `content/status/${OLD}.json`, `cache/feeds/${OLD}.xml`,
      `cache/staged/${OLD}/metrics.json`, `fixtures/${OLD}.json`,
    ];
    const root = tree([...gone, ...kept]);
    const r = pruneRunFiles(root, TODAY);
    // A folder counts once: dry-run/OLD's two files are one removal.
    expect(r.removed).toBe(gone.length - 1);
    for (const rel of gone) expect(exists(root, rel), rel).toBe(false);
    for (const rel of kept) expect(exists(root, rel), rel).toBe(true);
    expect(exists(root, `logs/dry-run/${OLD}`)).toBe(false);
    expect(exists(root, "logs/dry-run/tree")).toBe(true);
    expect(exists(root, `needs-review/${OLD}`)).toBe(true);
    // A second pass finds nothing.
    expect(pruneRunFiles(root, TODAY)).toEqual({ removed: 0 });
  });

  it("PR1 goes by the name, not the file's time, and removes a symlink without following it", () => {
    const root = tree([`logs/${EDGE}.daily.log`, `logs/${OLD}.daily.log`, "outside/keep.txt"]);
    const past = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(path.join(root, `logs/${EDGE}.daily.log`), past, past);   // old mtime, recent name: kept
    fs.utimesSync(path.join(root, `logs/${OLD}.daily.log`), new Date(), new Date());   // fresh mtime, old name: pruned
    fs.symlinkSync(path.join(root, "outside"), path.join(root, `logs/${OLD}.link`));
    fs.symlinkSync(path.join(root, "outside", "keep.txt"), path.join(root, `logs/${OLD}.json`));
    expect(pruneRunFiles(root, TODAY)).toEqual({ removed: 3 });
    expect(exists(root, `logs/${EDGE}.daily.log`)).toBe(true);
    expect(exists(root, `logs/${OLD}.daily.log`)).toBe(false);
    expect(fs.readdirSync(path.join(root, "logs")).sort()).toEqual([`${EDGE}.daily.log`]);
    expect(fs.readFileSync(path.join(root, "outside", "keep.txt"), "utf8")).toBe("x\n");
  });

  it("PR1 keepDays, a malformed today, missing folders and dateInName", () => {
    const root = tree([`logs/${TODAY}.daily.log`, `logs/${addDays(TODAY, -1)}.daily.log`, `packs/${addDays(TODAY, -7)}.json`]);
    expect(pruneRunFiles(root, "2026-13-01")).toEqual({ removed: 0 });
    expect(pruneRunFiles(root, "")).toEqual({ removed: 0 });
    expect(pruneRunFiles(root, TODAY, 7)).toEqual({ removed: 0 });
    expect(pruneRunFiles(root, TODAY, 6)).toEqual({ removed: 1 });
    expect(pruneRunFiles(root, TODAY, 0)).toEqual({ removed: 1 });
    expect(fs.readdirSync(path.join(root, "logs"))).toEqual([`${TODAY}.daily.log`]);
    // Not a number or below zero: the default.
    expect(pruneRunFiles(root, TODAY, Number.NaN)).toEqual({ removed: 0 });
    expect(pruneRunFiles(root, TODAY, -1)).toEqual({ removed: 0 });
    // A root with none of the folders, and one that does not exist.
    expect(pruneRunFiles(tree([]), TODAY)).toEqual({ removed: 0 });
    expect(pruneRunFiles(path.join(os.tmpdir(), "ct-prune-missing-root"), TODAY)).toEqual({ removed: 0 });

    expect(dateInName("2026-10-14.agent-1.jsonl")).toBe("2026-10-14");
    expect(dateInName("2026-10-14")).toBe("2026-10-14");
    for (const n of ["2026-10-14-03", "2026-10-14_x", "x2026-10-14.json", "2026-02-29.json", "runs.jsonl", ".lock", "tree"]) {
      expect(dateInName(n), n).toBeNull();
    }
    expect(pruneDirs("/r", TODAY)).toEqual(["/r/logs", "/r/logs/dry-run", "/r/logs/recompute", "/r/logs/agent-check", "/r/drafts", "/r/packs"]);
  });
});
