// scripts/lib/git.ts's syncMain() (SPEC §8.7 step 2: no --autostash, a dirty tree is a SyncError) and
// publish's commit subjects and content layout (§8.7 "Exports", §3, §4.7). The sync cases run on the shared
// harness (tests/helpers/harness.ts): a bare remote standing in for GitHub and its clone. Nothing here
// reaches the network.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STATE_FILES } from "@/lib/schema/metrics";
import { RUN_OUTCOMES } from "@/lib/vocab";
import { git, GitError, SyncError, syncMain } from "@/scripts/lib/git";
import { COMMIT_RE, CONTENT_LAYOUT, commitTitle, type CommitArgs } from "@/scripts/publish";
import { makeHarness, type Harness } from "./helpers/harness";

const T = 60_000;
const made: Harness[] = [];
const harness = () => {
  const h = makeHarness();
  made.push(h);
  return h;
};
afterEach(() => {
  for (const h of made.splice(0)) h.dispose();
});

const write = (h: Harness, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(h.root, rel)), { recursive: true });
  fs.writeFileSync(path.join(h.root, rel), text);
};

describe("syncMain", () => {
  it("G1: a dirty content/ file is a SyncError, never autostashed", async () => {
    const h = harness();
    h.commitOnRemote({ "content/status/2026-10-14.json": "{}\n" }, "status: 2026-10-14 · run 20261014-043702 started");
    const before = h.git("rev-parse", "HEAD");
    // A tracked file changed and an untracked one added, both inside the content layout.
    const kev = path.join(h.root, "content", "state", "kev-index.json");
    fs.appendFileSync(kev, " ");
    write(h, "content/briefs/2026-10-14.json", "{}\n");
    await expect(syncMain(git(h.root), CONTENT_LAYOUT)).rejects.toBeInstanceOf(SyncError);
    // Nothing moved, nothing stashed, the changes are where they were.
    expect(h.git("rev-parse", "HEAD")).toBe(before);
    expect(h.git("stash", "list")).toBe("");
    expect(fs.readFileSync(kev, "utf8").endsWith(" ")).toBe(true);
    expect(fs.existsSync(path.join(h.root, "content", "briefs", "2026-10-14.json"))).toBe(true);
    expect(h.git("status", "--porcelain")).not.toBe("");
  }, T);

  it("G1: an untracked file outside content/ is a SyncError too", async () => {
    const h = harness();
    write(h, "notes.txt", "x\n");
    await expect(syncMain(git(h.root), CONTENT_LAYOUT)).rejects.toThrow(/uncommitted changes: notes\.txt/);
  }, T);

  it("G1: gitignored folders do not count as dirty", async () => {
    const h = harness();
    write(h, "logs/2026-10-14.daily.log", "x\n");
    write(h, "cache/staged/2026-10-14/metrics/2026-10-14.json", "{}\n");
    await expect(syncMain(git(h.root), CONTENT_LAYOUT)).resolves.toEqual({ ahead: 0, moved: false });
  }, T);

  it("G1: with no local commits it fast-forwards to origin's main", async () => {
    const h = harness();
    const sha = h.commitOnRemote({ "scripts/README.txt": "code\n" }, "code: test");
    await expect(syncMain(git(h.root), CONTENT_LAYOUT)).resolves.toEqual({ ahead: 0, moved: false });
    expect(h.git("rev-parse", "HEAD")).toBe(sha);
  }, T);

  it("G1: local content commits are rebased onto origin's newer main (no --autostash)", async () => {
    const h = harness();
    write(h, "content/status/2026-10-14.json", "{}\n");
    h.git("add", "content");
    h.git("commit", "-q", "-m", "status: 2026-10-14 · run 20261014-043702 started");
    const remote = h.commitOnRemote({ "scripts/README.txt": "code\n" }, "code: test");
    const r = await syncMain(git(h.root), CONTENT_LAYOUT);
    expect(r).toEqual({ ahead: 1, moved: true });
    expect(h.git("rev-parse", "HEAD^")).toBe(remote);
    expect(h.git("log", "-1", "--format=%s")).toBe("status: 2026-10-14 · run 20261014-043702 started");
  }, T);

  it("G1: a local commit touching a path outside the layout is a SyncError", async () => {
    const h = harness();
    write(h, "scripts/README.txt", "local code\n");
    h.git("commit", "-q", "-am", "code: local");
    await expect(syncMain(git(h.root), CONTENT_LAYOUT)).rejects.toThrow(/outside the content layout/);
  }, T);

  it("G1: a rebase conflict is aborted and thrown as a SyncError", async () => {
    const h = harness();
    write(h, "content/status/2026-10-14.json", "{\"local\": true}\n");
    h.git("add", "content");
    h.git("commit", "-q", "-m", "status: 2026-10-14 · run 20261014-043702 started");
    h.commitOnRemote({ "content/status/2026-10-14.json": "{\"remote\": true}\n" }, "status: 2026-10-14 · run 20261014-043703 started");
    const head = h.git("rev-parse", "HEAD");
    const err = await syncMain(git(h.root), CONTENT_LAYOUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect(err).toBeInstanceOf(GitError);
    expect(h.git("rev-parse", "HEAD")).toBe(head);
    expect(h.git("status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(h.root, ".git", "rebase-merge"))).toBe(false);
    expect(fs.existsSync(path.join(h.root, ".git", "rebase-apply"))).toBe(false);
  }, T);

  it("G1: the rebase command carries no --autostash", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "lib", "git.ts"), "utf8");
    expect(src).not.toMatch(/"--autostash"/);
    expect(src).toContain('["rebase", "origin/main"]');
  });
});

describe("commitTitle", () => {
  const D = "2026-10-14";
  const cases: { [K in keyof CommitArgs]: [CommitArgs[K], string][] } = {
    data_only: [[{ date: D }, "brief: 2026-10-14 · data-only edition"]],
    full: [
      [{ date: D, edition: "full", items: 8 }, "brief: 2026-10-14 · full edition, 8 items"],
      [{ date: D, edition: "partial", items: 1 }, "brief: 2026-10-14 · partial edition, 1 item"],
      [{ date: D, edition: "full", items: 0 }, "brief: 2026-10-14 · full edition, 0 items"],
    ],
    withhold: [
      [{ date: D, itemIds: ["inc-health-us-2026-10"] }, "correction: 2026-10-14 · withheld inc-health-us-2026-10"],
      [{ date: D, itemIds: ["a", "b"] }, "correction: 2026-10-14 · withheld a, b"],
    ],
    status_started: [[{ date: D, runId: "20261014-043702" }, "status: 2026-10-14 · run 20261014-043702 started"]],
    status_ended: RUN_OUTCOMES.map((outcome) => [{ date: D, runId: "20261014-043702", outcome }, `status: 2026-10-14 · run 20261014-043702 ended: ${outcome}`]),
    status_retry: [[
      { date: D, runId: "20261014-043702", outcome: "published_data_only", retryId: "20261014-045812" },
      "status: 2026-10-14 · run 20261014-043702 ended: published_data_only; retry 20261014-045812 started",
    ]],
    state: [
      [{ cutoff: "2026-11-08", mode: "catch-up" }, "state: 2026-11-08 · catch-up"],
      [{ cutoff: "2026-11-08", mode: "backfill" }, "state: 2026-11-08 · backfill"],
    ],
  };

  it("G2: every kind gives §8.7's subject, and each matches COMMIT_RE", () => {
    for (const kind of Object.keys(cases) as (keyof CommitArgs)[]) {
      for (const [args, title] of cases[kind] as [CommitArgs[typeof kind], string][]) {
        const got = commitTitle(kind, args);
        expect(got).toBe(title);
        expect(got).toMatch(COMMIT_RE);
        expect(got).not.toMatch(/\u2014/);
      }
    }
  });

  it("G2: a bad date, a negative count or an empty withhold is refused", () => {
    expect(() => commitTitle("data_only", { date: "2026-13-01" })).toThrow(/not a valid date/);
    expect(() => commitTitle("full", { date: D, edition: "full", items: -1 })).toThrow(/item count/);
    expect(() => commitTitle("withhold", { date: D, itemIds: [] })).toThrow(/at least one item/);
  });

  it("G2: COMMIT_RE refuses subjects publish never makes", () => {
    for (const s of ["seed", "code: test", "brief: 2026-10-14 - data-only edition", "brief 2026-10-14 · x", "status: 26-10-14 · run"]) {
      expect(s).not.toMatch(COMMIT_RE);
    }
  });
});

describe("CONTENT_LAYOUT", () => {
  it("G3: accepts the §3 and §4.7 paths", () => {
    const ok = [
      "content/briefs/2026-10-14.json",
      "content/metrics/2026-10-14.json",
      "content/metrics/inputs/2026-10-14.json",
      "content/status/2026-10-16.json",
      ...STATE_FILES.map((f) => `content/state/${f}`),
      "content/scoreboard.json",
      "content/corrections.json",
      "content/archive-index.json",
    ];
    expect(STATE_FILES.length).toBe(6);
    for (const p of ok) expect(CONTENT_LAYOUT(p), p).toBe(true);
  });

  it("G3: refuses everything else", () => {
    const bad = [
      "content/README.md",
      "content/briefs/2026-02-30.json",
      "content/briefs/2026-10-14.json.bak",
      "content/briefs/latest.json",
      "content/briefs/2026/10-14.json",
      "content/metrics/inputs/extra/2026-10-14.json",
      "content/status/2026-10-14.md",
      "content/state/other.json",
      "content/state/kev-index.json.tmp",
      "content/snapshots/x.json",
      "content/scoreboard.json/x",
      "content",
      "content/",
      "briefs/2026-10-14.json",
      "./content/briefs/2026-10-14.json",
      "scripts/publish.ts",
      "config/run.json",
      "logs/2026-10-14.status.json",
      "cache/staged/2026-10-14/metrics/2026-10-14.json",
      "fixtures/site-content/briefs/2026-10-14.json",
    ];
    for (const p of bad) expect(CONTENT_LAYOUT(p), p).toBe(false);
  });
});
