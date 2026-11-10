// Pruning at the run's finish (scripts/lib/prune.ts; SPEC §9.8). PN1 of the plan, renamed from PR1 so that
// PR1 to PR7 stay the prompts tests, on a temporary root laid out as the run leaves it. PN2 is the cache's
// bodies and snapshots, by modification time.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { KEEP_DAYS, cacheBodyDirs, dateInName, pruneCache, pruneDirs, pruneRunFiles } from "@/scripts/lib/prune";

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
  it("PN1 removes logs, drafts, packs and dry-run copies older than 60 days by the date in the name", () => {
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

  it("PN1 goes by the name, not the file's time, and removes a symlink without following it", () => {
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

  it("PN1 keepDays, a malformed today, missing folders and dateInName", () => {
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

describe("pruneCache", () => {
  const NOW = Date.parse("2026-11-10T05:10:00+08:00");
  const DAY_MS = 86_400_000;
  /** Sets a file's modification time to `days` days before NOW (fractions allowed). */
  const age = (root: string, rel: string, days: number) => {
    const t = new Date(NOW - days * DAY_MS);
    fs.utimesSync(path.join(root, rel), t, t);
  };

  it("PN2 removes cache bodies and snapshots older than 60 days by modification time, never the fixed files, clones, staged, records or logs", () => {
    const gone = [
      "cache/feeds/kev.json", "cache/feeds/old-feed.xml", "cache/feeds/nvd.p1.json", "cache/cvelist/zips/2026-08-01_delta_CVEs_at_0100Z.zip",
      "cache/epss/epss_scores-2026-08-01.csv.gz", "cache/snapshots/0f3a9c.json",
      "cache/check/feeds/therecord.xml", "cache/check/cvelist/zips/old.zip", "cache/check/epss/epss_scores-2026-08-01.csv.gz",
    ];
    const keptOld = [
      // Rewritten by each collect, whatever their age.
      "cache/feeds/index.json", "cache/feeds/inputs.json", "cache/check/feeds/index.json", "cache/check/feeds/inputs.json",
      // The clones, staged files, per-id records and folders pruneCache never reads.
      "cache/cvelistV5/cves/2024/1xxx/CVE-2024-1000.json", "cache/cvelistV5/README.md", "cache/ghsa/advisories/a.json",
      "cache/check/ghsa/advisories/a.json", "cache/check/cvelistV5/README.md",
      "cache/staged/2026-08-01/metrics/2026-08-01.json", "cache/staged/backfill/state/days.json",
      "cache/cvelist/records/CVE-2026-0001.json", "cache/check/cvelist/records/CVE-2026-0001.json",
      "logs/dry-run/tree/content/briefs/2026-08-01.json", "needs-review/2026-08-01/draft.json", "logs/notes.txt", "content/briefs/2026-08-01.json",
      // A subfolder inside a body folder is never entered.
      "cache/feeds/sub/old.xml",
    ];
    const fresh = ["cache/feeds/kev-fresh.json", "cache/snapshots/edge.json", "cache/epss/epss_scores-2026-11-09.csv.gz", "cache/check/feeds/fresh.xml"];
    const root = tree([...gone, ...keptOld, ...fresh]);
    for (const rel of [...gone, ...keptOld]) age(root, rel, 61);
    age(root, "cache/snapshots/edge.json", 59.9);
    const r = pruneCache(root, NOW);
    expect(r.removed).toBe(gone.length);
    for (const rel of gone) expect(exists(root, rel), rel).toBe(false);
    for (const rel of [...keptOld, ...fresh]) expect(exists(root, rel), rel).toBe(true);
    expect(pruneCache(root, NOW)).toEqual({ removed: 0 });
    // The edge file goes once it passes 60 days.
    expect(pruneCache(root, NOW + 0.2 * DAY_MS)).toEqual({ removed: 1 });
    expect(exists(root, "cache/snapshots/edge.json")).toBe(false);
  });

  it("PN2 goes by the file's time, not its name; a symlink is removed as a link; keepDays, a bad clock and a missing cache", () => {
    const root = tree(["cache/feeds/2026-01-01.xml", "cache/snapshots/new.json", "outside/keep.txt"]);
    age(root, "cache/feeds/2026-01-01.xml", 1);   // an old-looking name, a fresh file: kept
    age(root, "cache/snapshots/new.json", 10);
    fs.symlinkSync(path.join(root, "outside", "keep.txt"), path.join(root, "cache", "snapshots", "link.json"));
    fs.lutimesSync(path.join(root, "cache", "snapshots", "link.json"), new Date(NOW - 90 * DAY_MS), new Date(NOW - 90 * DAY_MS));
    expect(pruneCache(root, NOW, Number.NaN)).toEqual({ removed: 1 });
    expect(fs.readFileSync(path.join(root, "outside", "keep.txt"), "utf8")).toBe("x\n");
    expect(pruneCache(root, Number.NaN)).toEqual({ removed: 0 });
    expect(pruneCache(root, NOW, 9)).toEqual({ removed: 1 });
    expect(fs.readdirSync(path.join(root, "cache", "feeds"))).toEqual(["2026-01-01.xml"]);
    expect(fs.readdirSync(path.join(root, "cache", "snapshots"))).toEqual([]);
    expect(pruneCache(tree([]), NOW)).toEqual({ removed: 0 });
    expect(pruneCache(path.join(os.tmpdir(), "ct-prune-missing-root"), NOW)).toEqual({ removed: 0 });

    expect(cacheBodyDirs("/r")).toEqual([
      { dir: "/r/cache/feeds", keep: ["index.json", "inputs.json"] },
      { dir: "/r/cache/cvelist/zips", keep: [] },
      { dir: "/r/cache/epss", keep: [] },
      { dir: "/r/cache/snapshots", keep: [] },
      { dir: "/r/cache/check/feeds", keep: ["index.json", "inputs.json"] },
      { dir: "/r/cache/check/cvelist/zips", keep: [] },
      { dir: "/r/cache/check/epss", keep: [] },
    ]);
  });

  it("PN2 pruneRunFiles leaves the cache alone, and pruneCache the run files: each goes by its own rule", () => {
    const root = tree([`logs/${OLD}.daily.log`, "cache/feeds/kev.json"]);
    age(root, `logs/${OLD}.daily.log`, 1);
    age(root, "cache/feeds/kev.json", 61);
    expect(pruneCache(root, NOW)).toEqual({ removed: 1 });
    expect(exists(root, `logs/${OLD}.daily.log`)).toBe(true);
    expect(pruneRunFiles(root, TODAY)).toEqual({ removed: 1 });
  });
});
