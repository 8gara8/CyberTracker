// `npm run sources:check` (SPEC §8.10): checkFeeds() on fixtures/feeds through CT_FIXTURE_FEEDS, in a
// temp root, with the clock at the 2026-10-14 morning run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../lib/config";
import { checkFeeds, formatCheckTable, main, type CheckRow } from "../scripts/collect";

const ROOT = path.resolve(__dirname, "..");
const FEEDS = path.join(ROOT, "fixtures", "feeds");
const T0 = Date.parse("2026-10-13T20:37:00Z");
const cfg = loadConfig({ root: ROOT });
const fetched = cfg.sources.feeds.filter((f) => f.kind !== "search");

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};
function tempRoot(): string {
  const root = tmp("ct-check-");
  fs.cpSync(path.join(ROOT, "config"), path.join(root, "config"), { recursive: true });
  return root;
}
function feedsVariant(edit: (index: Record<string, { file?: string; status?: number; error?: string; content_type?: string }>) => void): string {
  const dir = tmp("ct-check-feeds-");
  fs.cpSync(FEEDS, dir, { recursive: true });
  const index = JSON.parse(fs.readFileSync(path.join(FEEDS, "index.json"), "utf8"));
  edit(index);
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index));
  return dir;
}

let saved: string | undefined;
beforeAll(() => {
  saved = process.env.CT_FIXTURE_FEEDS;
  process.env.CT_FIXTURE_FEEDS = FEEDS;
});
afterAll(() => {
  if (saved === undefined) delete process.env.CT_FIXTURE_FEEDS;
  else process.env.CT_FIXTURE_FEEDS = saved;
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("checkFeeds on the fixture feeds", () => {
  let rows: CheckRow[];
  let exitCode: 0 | 1;
  let root: string;
  beforeAll(async () => {
    root = tempRoot();
    ({ rows, exitCode } = await checkFeeds({ now: T0, root }));
  });

  it("has one row per registry entry, in registry order, with search rows SKIP", () => {
    expect(rows.map((r) => r.id)).toEqual(cfg.sources.feeds.map((f) => f.id));
    for (const r of rows.filter((x) => x.kind === "search")) expect(r).toMatchObject({ status: "SKIP", items: 0, newest: null, fresh: "-", error: null });
  });

  it("labels the fixture's failures, stale feeds and fresh feeds", () => {
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get("krebs")).toMatchObject({ status: "FAIL", error: "timeout", fresh: "-" });
    expect(by.get("gtig")).toMatchObject({ status: "FAIL", error: "http_503" });
    expect(by.get("unit42")).toMatchObject({ status: "STALE", fresh: "no (64 d)", error: null });
    expect(by.get("google-security")).toMatchObject({ status: "NODATE", newest: null, fresh: "-" });
    expect(by.get("kev")).toMatchObject({ status: "OK", items: 111, newest: "2026-10-13T17:02:11Z", fresh: "yes", priority: 1 });
    expect(by.get("nvd")).toMatchObject({ status: "OK", items: 2, fresh: "-" });
    expect(by.get("bleepingcomputer")).toMatchObject({ status: "OK", items: 40, fresh: "yes" });
    expect(exitCode).toBe(0);
  });

  it("keeps the raw bodies in cache/feeds/ for scrub-feed.ts and writes no pack", () => {
    expect(fs.existsSync(path.join(root, "cache", "feeds", "therecord.xml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "packs"))).toBe(false);
    expect(fs.existsSync(path.join(root, "content"))).toBe(false);
  });

  it("prints the table and the summary line over fetched entries", () => {
    const text = formatCheckTable(rows);
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("id\tkind\tstatus\titems\tnewest\tfresh\tpriority\terror");
    expect(lines.length).toBe(rows.length + 2);
    expect(lines.find((l) => l.startsWith("krebs\t"))).toBe("krebs\trss\tFAIL\t0\t-\t-\t2\ttimeout");
    const ok = rows.filter((r) => r.status === "OK").length;
    expect(lines.at(-1)).toBe(`${ok} of ${fetched.length} entries ok; 0 priority-1 problems.`);
    expect(ok).toBe(fetched.length - 4);
  });
});

describe("checkFeeds exit codes and options", () => {
  it("exits 1 when a priority-1 entry is STALE", async () => {
    process.env.CT_FIXTURE_FEEDS = feedsVariant((idx) => {
      idx["https://therecord.media/feed"] = { file: "rss/stale.xml", content_type: "application/rss+xml" };
    });
    try {
      const r = await checkFeeds({ now: T0, root: tempRoot() });
      expect(r.rows.find((x) => x.id === "therecord")).toMatchObject({ status: "STALE", priority: 1 });
      expect(r.exitCode).toBe(1);
      expect(formatCheckTable(r.rows).trimEnd().split("\n").at(-1)).toMatch(/; 1 priority-1 problems\.$/);
    } finally {
      process.env.CT_FIXTURE_FEEDS = FEEDS;
    }
  });

  it("exits 1 when a priority-1 entry fails, and 0 when only lower priorities do", async () => {
    process.env.CT_FIXTURE_FEEDS = feedsVariant((idx) => {
      idx["https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json"] = { status: 503 };
      idx["https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"] = { error: "timeout" };
    });
    try {
      const r = await checkFeeds({ now: T0, root: tempRoot() });
      expect(r.rows.find((x) => x.id === "kev")).toMatchObject({ status: "FAIL", error: "timeout" });
      expect(r.exitCode).toBe(1);
    } finally {
      process.env.CT_FIXTURE_FEEDS = FEEDS;
    }
  });

  it("--id checks one entry, and an unknown id is an error", async () => {
    const r = await checkFeeds({ id: "jpcert", now: T0, root: tempRoot() });
    expect(r.rows).toEqual([{ id: "jpcert", kind: "rss", status: "OK", items: 4, newest: "2026-10-13T18:00:00Z", fresh: "yes", priority: 1, error: null }]);
    await expect(checkFeeds({ id: "no-such-feed", now: T0, root: tempRoot() })).rejects.toThrow(/no registry entry/);
  });

  it("the command line prints JSON with --json and exits 2 for an unknown --id", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
    const code = await main(["--check-feeds", "--id", "jpcert", "--json"], { io, root: tempRoot(), env: process.env });
    const rows = JSON.parse(out.join("\n")) as CheckRow[];
    expect(rows.map((r) => r.id)).toEqual(["jpcert"]);
    // The command line reads the real clock, so the fixture's 2026-10-13 feed is OK or STALE by then.
    expect(code).toBe(rows[0]!.status === "OK" ? 0 : 1);
    expect(await main(["--check-feeds", "--id", "no-such-feed"], { io, root: tempRoot(), env: process.env })).toBe(2);
    expect(err.join("\n")).toContain("no registry entry");
  });
});
