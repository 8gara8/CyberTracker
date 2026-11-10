// The morning run end to end (SPEC §8.2 Tests; plan §1 lane I, §4, amendments A1, A2 and A19): the shared
// harness gives a bare remote with a pre-receive hook, a clone as ROOT whose content/ holds only state/, the
// fake agent CLI and a router for the network probe, dispute intake and deploy check. Feeds come from
// fixtures/feeds (CT_FIXTURE_FEEDS); the clock is the harness's test clock. Every case checks that no commit
// the run pushed touches a path outside content/. Offline throughout; everything read back is data.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at } from "@/lib/dates";
import { StatusFile, type RunRecord } from "@/lib/schema/status";
import { attemptBudget, CONFIG, main, repairBudget, type Deps } from "@/scripts/daily";
import { MIN } from "@/scripts/lib/clock";
import { scheduleFor } from "@/scripts/preflight";
import { loadConfig } from "@/lib/config";
import { inRoot, makeHarness, PIPELINE_DATE, REPO, type Harness, type HarnessOptions } from "./helpers/harness";

const D = PIPELINE_DATE;
const AGENT = path.join(REPO, "fixtures", "agent", "drafts");
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(AGENT, file), "utf8"));
const DRAFT = readJson(`${D}.json`);
const INVALID = readJson(`${D}--invalid.json`);
const FETCHES = readJson(`${D}--fetches.json`) as string[];
const TIMEOUT = 240_000;

const harnesses: Harness[] = [];
let logSpy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy?.mockRestore();
  while (harnesses.length) harnesses.pop()!.dispose();
});

function harness(o: HarnessOptions = {}): Harness {
  const h = makeHarness(o);
  harnesses.push(h);
  return h;
}

/** The fake agent writing the pipeline draft and reporting its fetches. */
const okAgent = (h: Harness) => h.fakeAgent({ mode: "ok", draft: DRAFT, fetches: FETCHES });

/** main() in the clone, with a restart that runs main again in-process as the child would (CT_REEXEC=1). */
async function run(h: Harness, argv: string[], extra: Partial<Deps> = {}): Promise<number> {
  const deps: Deps = { ...h.deps, ...extra };
  const reexec = async (args: string[]) => {
    process.env.CT_REEXEC = "1";
    try {
      return await main(args, { ...deps, restart: undefined });
    } finally {
      delete process.env.CT_REEXEC;
    }
  };
  return inRoot(h, () => main(argv, { ...deps, restart: extra.restart ?? reexec }));
}

const subjects = (h: Harness) => h.remoteLog().map((c) => c.subject);
const statusOn = (h: Harness): StatusFile | null => {
  const t = h.remoteFile(`content/status/${D}.json`);
  return t === null ? null : StatusFile.parse(JSON.parse(t));
};
const briefOn = (h: Harness): { edition: string; published_at: string; data_only_published_at: string | null } | null => {
  const t = h.remoteFile(`content/briefs/${D}.json`);
  return t === null ? null : (JSON.parse(t) as { edition: string; published_at: string; data_only_published_at: string | null });
};
const summary = (h: Harness) => fs.readFileSync(path.join(h.root, "logs", `${D}.summary.md`), "utf8");
const dailyLog = (h: Harness) => fs.readFileSync(path.join(h.root, "logs", `${D}.daily.log`), "utf8");
const stageOf = (r: RunRecord, id: string) => r.stages.find((s) => s.id === id)!;
/** Agent calls only (the fake also records --version). */
const agentRuns = (h: Harness) => h.agentCalls().filter((c) => c.argv[0] === "-p");

/** Every case: no pushed commit touches a path outside content/. */
function expectContentOnly(h: Harness): void {
  for (const c of h.remoteLog()) {
    for (const f of c.files) expect(f.startsWith("content/"), `${c.subject}: ${f}`).toBe(true);
  }
}

describe("daily.ts budgets", () => {
  it("D25 repairBudget is 6, 3 and 0 minutes at the hard stop less 20, 7 and 5 minutes; attemptBudget is 22 minutes at 04:58", () => {
    const stop = at(D, "05:30");
    expect(repairBudget(stop, stop - 20 * MIN)).toBe(6 * MIN);
    expect(repairBudget(stop, stop - 7 * MIN)).toBe(3 * MIN);
    expect(repairBudget(stop, stop - 5 * MIN)).toBe(0);
    expect(attemptBudget(stop, at(D, "04:58"))).toBe(22 * MIN);
    expect(attemptBudget(stop, at(D, "04:37"))).toBe(CONFIG.budgets.agent_minutes * MIN);
  });

  it("D26 --trigger schedule --no-deadline at 08:30 sets the hard stop to 09:45", async () => {
    const config = loadConfig({ root: REPO });
    const s = scheduleFor({ date: D, start: at(D, "08:30"), config, noDeadline: true, dryRun: false });
    expect(s.hardStop).toBe(at(D, "09:45"));
    expect(s.retryCutoff).toBe(at(D, "08:55"));
    const h = harness({ start: "08:30" });
    h.fakeAgent({ mode: "nodraft" });
    const code = await run(h, ["--trigger", "schedule", "--no-deadline"]);
    expect([0, 3]).toContain(code);
    expect(dailyLog(h)).toContain(`CyberTracker daily run for ${D} (schedule); data to 2026-10-12 UTC; hard stop 09:45; retry cutoff 08:55.`);
    const runs = statusOn(h)!.runs;
    expect(runs[0]!.trigger).toBe("schedule");
    expectContentOnly(h);
  }, TIMEOUT);
});

describe("scripts/daily.sh", () => {
  it("DS1 is SPEC §8.2's block byte for byte, committed with mode 100755", () => {
    const spec = fs.readFileSync(path.join(REPO, "SPEC.md"), "utf8");
    const from = spec.indexOf("**`scripts/daily.sh`**");
    expect(from).toBeGreaterThan(0);
    const block = /```zsh\n([\s\S]*?)```/.exec(spec.slice(from));
    expect(block).not.toBeNull();
    expect(fs.readFileSync(path.join(REPO, "scripts", "daily.sh"), "utf8")).toBe(block![1]);
    const entry = execFileSync("git", ["ls-files", "-s", "scripts/daily.sh"], { cwd: REPO, encoding: "utf8" });
    expect(entry.split(/\s+/)[0]).toBe("100755");
  });
});

describe("daily.ts end to end", () => {
  it("D1 a 04:37 normal morning publishes four commits in order and exits 0", async () => {
    const h = harness({ start: "04:37" });
    okAgent(h);
    const code = await run(h, ["--trigger", "schedule"]);
    if (code !== 0) console.error(dailyLog(h));
    expect(code).toBe(0);
    const s = subjects(h);
    expect(s).toHaveLength(4);
    expect(s[0]).toMatch(new RegExp(`^status: ${D} · run \\d{8}-\\d{6} started$`));
    expect(s[1]).toMatch(new RegExp(`^brief: ${D} · data-only edition$`));
    expect(s[2]).toMatch(new RegExp(`^brief: ${D} · full edition`));
    expect(s[3]).toMatch(new RegExp(`^status: ${D} · run \\d{8}-\\d{6} ended: published_full$`));
    const runs = statusOn(h)!.runs;
    expect(runs).toHaveLength(1);
    const r = runs[0]!;
    expect(r.outcome).toBe("published_full");
    expect(r.edition).toBe("full");
    expect(r.error_code).toBeNull();
    expect(r.budgets.repair_rounds).toBe(0);
    for (const st of r.stages) expect(`${st.id} ${st.status}`).toBe(`${st.id} ok`);
    expect(r.data_only_published_at).not.toBeNull();
    expect(r.full_published_at).not.toBeNull();
    expect(r.deploy.triggered).toBe(true);
    expect(r.links?.broken).toEqual([]);
    expect(briefOn(h)!.edition).toBe("full");
    expect(summary(h)).toMatch(new RegExp(`^\\*\\*CyberTracker ${D} · full edition, published \\d\\d:\\d\\d\\*\\*\\n`));
    const calls = agentRuns(h);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toContain("--session-id");
    expect(calls[0]!.envKeys).not.toContain("CT_FIXTURE_FEEDS");
    const runsJsonl = fs.readFileSync(path.join(h.root, "logs", "runs.jsonl"), "utf8").trim().split("\n");
    expect(runsJsonl).toHaveLength(1);
    expect(JSON.parse(runsJsonl[0]!)).toMatchObject({ date: D, trigger: "schedule", outcome: "published_full", edition: "full", attempts: 1, repairs: 0, error_code: null });
    expect(dailyLog(h)).toContain("Attempt 1: 0 errors, 0 warnings (0 snapshot).");
    expect(dailyLog(h)).toMatch(/Full edition published at \d\d:\d\d \([0-9a-f]{7}\)\./);
    expect(dailyLog(h).trimEnd().split("\n").at(-1)).toMatch(/ Run ended: published_full\.$/);
    expect(fs.existsSync(path.join(h.root, "logs", ".lock"))).toBe(false);
    expect(fs.existsSync(path.join(h.root, "needs-review", D))).toBe(false);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D2 no draft twice gives exit 3, a schedule and a retry record, and the data-only summary with (E_AGENT)", async () => {
    const h = harness();
    h.fakeAgent({ mode: "nodraft" });
    expect(await run(h, ["--trigger", "schedule"])).toBe(3);
    const s = subjects(h);
    expect(s).toHaveLength(4);
    expect(s[2]).toMatch(new RegExp(`^status: ${D} · run (\\d{8}-\\d{6}) ended: published_data_only; retry \\d{8}-\\d{6} started$`));
    const runs = statusOn(h)!.runs;
    expect(runs.map((r) => [r.trigger, r.attempt, r.outcome, r.error_code])).toEqual([
      ["schedule", 1, "published_data_only", "E_AGENT"],
      ["retry", 2, "published_data_only", "E_AGENT"],
    ]);
    for (const st of ["preflight", "collect", "metrics", "data_only", "recheck"]) {
      expect(stageOf(runs[1]!, st).status).toBe("skipped");
      expect(stageOf(runs[1]!, st).note).toBe(`Reused from run ${runs[0]!.run_id}.`);
    }
    expect(runs[1]!.feeds).toEqual(runs[0]!.feeds);
    expect(runs[1]!.data_only_published_at).toBeNull();
    expect(agentRuns(h)).toHaveLength(2);
    expect(dailyLog(h)).toContain("Attempt 1: no draft was written.");
    expect(dailyLog(h)).toContain("Attempt 2: no draft was written.");
    expect(summary(h).split("\n")[0]).toMatch(new RegExp(`^\\*\\*CyberTracker ${D} · data-only edition, published \\d\\d:\\d\\d\\*\\* \\(E_AGENT\\)$`));
    expect(fs.existsSync(path.join(h.root, "needs-review", D, `${D}.daily.log`))).toBe(true);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D3 an agent that is not signed in gives E_AUTH after one attempt", async () => {
    const h = harness();
    h.fakeAgent({ mode: "auth" });
    expect(await run(h, ["--trigger", "schedule"])).toBe(3);
    const r = statusOn(h)!.runs;
    expect(r).toHaveLength(1);
    expect(r[0]!.outcome).toBe("published_data_only");
    expect(r[0]!.error_code).toBe("E_AUTH");
    expect(stageOf(r[0]!, "draft").status).toBe("failed");
    expect(agentRuns(h)).toHaveLength(1);
    expect(summary(h).split("\n")[0]).toContain("(E_AUTH)");
    expectContentOnly(h);
  }, TIMEOUT);

  it("D4 no keychain token gives E_AUTH at preflight; the data-only edition still publishes, exit 3", async () => {
    const h = harness();
    okAgent(h);
    h.token(null);
    expect(await run(h, ["--trigger", "schedule"])).toBe(3);
    const r = statusOn(h)!.runs[0]!;
    expect(r.outcome).toBe("published_data_only");
    expect(r.error_code).toBe("E_AUTH");
    expect(stageOf(r, "preflight").status).toBe("degraded");
    for (const st of ["draft", "validate", "publish"]) {
      expect(stageOf(r, st).status).toBe("skipped");
      expect(stageOf(r, st).note).toBe("Not run: the agent CLI or its sign-in token is missing.");
    }
    expect(briefOn(h)!.edition).toBe("data_only");
    expect(agentRuns(h)).toEqual([]);
    expect(subjects(h)).toHaveLength(3);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D5 an agent whose tools break the sandbox is stopped: E_SANDBOX, no retry", async () => {
    const h = harness();
    h.fakeAgent({ mode: "mcp" });
    expect(await run(h, ["--trigger", "schedule"])).toBe(3);
    const r = statusOn(h)!.runs;
    expect(r).toHaveLength(1);
    expect(r[0]!.error_code).toBe("E_SANDBOX");
    expect(agentRuns(h)).toHaveLength(1);
    expect(dailyLog(h)).toMatch(/Attempt 1: agent was stopped · /);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D6 an invalid draft repaired on --resume is published with repair_rounds 1", async () => {
    const h = harness();
    h.fakeAgent({ mode: "repair", invalidDraft: INVALID, repair: DRAFT, fetches: FETCHES });
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const r = statusOn(h)!.runs;
    expect(r).toHaveLength(1);
    expect(r[0]!.outcome).toBe("published_full");
    expect(r[0]!.budgets.repair_rounds).toBe(1);
    const calls = agentRuns(h);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.argv).toContain("--resume");
    expect(dailyLog(h)).toContain("Attempt 1: repair 1 for 1 error and 0 snapshot warnings (BANNED_WORDS).");
    expect(fs.existsSync(path.join(h.root, "logs", `${D}.agent-1-repair-1.jsonl`))).toBe(true);
    expect(subjects(h)).toHaveLength(4);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D7 the usage limit stops the agent: E_LIMIT, no retry", async () => {
    const h = harness();
    h.fakeAgent({ mode: "limit" });
    expect(await run(h, ["--trigger", "schedule"])).toBe(3);
    const r = statusOn(h)!.runs;
    expect(r).toHaveLength(1);
    expect(r[0]!.error_code).toBe("E_LIMIT");
    expect(r[0]!.budgets.usage).toEqual({ window: "five_hour", utilization: 1 });
    expect(agentRuns(h)).toHaveLength(1);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D8 a start at 05:35 publishes the data-only edition only", async () => {
    const h = harness({ start: "05:35" });
    okAgent(h);
    expect(await run(h, ["--trigger", "schedule"])).toBe(3);
    const r = statusOn(h)!.runs[0]!;
    expect(r.outcome).toBe("published_data_only");
    expect(r.error_code).toBeNull();
    for (const st of ["draft", "validate", "publish"]) expect(stageOf(r, st).note).toBe("Started after 05:30: no editorial pass today.");
    expect(h.agentCalls()).toEqual([]);
    expect(briefOn(h)!.edition).toBe("data_only");
    expect(subjects(h)).toHaveLength(3);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D9 a start at 11:05 is skipped with one status: commit", async () => {
    const h = harness({ start: "11:05" });
    okAgent(h);
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const s = subjects(h);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatch(new RegExp(`^status: ${D} · run \\d{8}-\\d{6} ended: skipped$`));
    const r = statusOn(h)!.runs;
    expect(r).toHaveLength(1);
    expect(r[0]!.outcome).toBe("skipped");
    expect(stageOf(r[0]!, "preflight").note).toBe("Too late: nothing is published after 11:00.");
    expect(h.agentCalls()).toEqual([]);
    expect(briefOn(h)).toBeNull();
    expect(summary(h)).toContain("skipped.**");
    expectContentOnly(h);
  }, TIMEOUT);

  it("D10 D11 D12 a full edition already on GitHub skips the next run; --force replaces it; no data-only commit follows a full one", async () => {
    const h = harness();
    okAgent(h);
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const first = briefOn(h)!;
    expect(first.edition).toBe("full");

    // D10: a second morning run is skipped, with exactly one status: commit.
    h.clock.set(h.clock() + 2 * MIN);
    expect(await run(h, ["--trigger", "manual"])).toBe(0);
    let s = subjects(h);
    expect(s).toHaveLength(5);
    expect(s[4]).toMatch(/ ended: skipped$/);
    let runs = statusOn(h)!.runs;
    expect(runs.at(-1)!.outcome).toBe("skipped");
    expect(stageOf(runs.at(-1)!, "preflight").note).toMatch(/^The full edition was already published at \d\d:\d\d\.$/);
    expect(agentRuns(h)).toHaveLength(1);

    // D11: --force drafts again and replaces the edition.
    h.clock.set(h.clock() + 2 * MIN);
    expect(await run(h, ["--trigger", "manual", "--force"])).toBe(0);
    s = subjects(h);
    expect(s).toHaveLength(8);
    expect(s[5]).toMatch(/ started$/);
    expect(s[6]).toMatch(new RegExp(`^brief: ${D} · full edition`));
    expect(s[7]).toMatch(/ ended: published_full$/);
    runs = statusOn(h)!.runs;
    const forced = runs.at(-1)!;
    expect(forced.outcome).toBe("published_full");
    expect(stageOf(forced, "data_only").status).toBe("skipped");
    expect(stageOf(forced, "metrics").note).toBe(`Reused metrics/${D}.json.`);
    expect(stageOf(forced, "publish").note).toContain("(--force).");
    const second = briefOn(h)!;
    expect(second.published_at).not.toBe(first.published_at);
    expect(second.data_only_published_at).toBe(first.data_only_published_at);
    expect(agentRuns(h)).toHaveLength(2);

    // D12: after the first full edition, no data-only commit ever lands.
    const firstFull = s.findIndex((x) => x.startsWith(`brief: ${D} · full edition`));
    expect(s.slice(firstFull).filter((x) => x === `brief: ${D} · data-only edition`)).toEqual([]);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D13 rejected pushes at the start give E_PUSH and nothing else is tried", async () => {
    const h = harness();
    okAgent(h);
    h.pushes("reject");
    expect(await run(h, ["--trigger", "schedule"])).toBe(1);
    expect(h.remoteLog()).toEqual([]);
    expect(agentRuns(h)).toEqual([]);
    expect(fs.existsSync(path.join(h.root, "packs", `${D}.json`))).toBe(false);
    expect(summary(h).split("\n")[0]).toBe(`**CyberTracker ${D} · failed** (E_PUSH)`);
    const line = JSON.parse(fs.readFileSync(path.join(h.root, "logs", "runs.jsonl"), "utf8").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ outcome: "failed", error_code: "E_PUSH" });
    expectContentOnly(h);
  }, TIMEOUT);

  it("D14 rejected pushes after the data-only commit give E_PUBLISH and exit 3", async () => {
    const h = harness();
    h.fakeAgent({ mode: "ok", draft: DRAFT, fetches: FETCHES, touch: [path.join(h.base, "reject-pushes")] });
    expect(await run(h, ["--trigger", "schedule"])).toBe(3);
    const s = subjects(h);
    expect(s).toHaveLength(2);
    expect(s[1]).toBe(`brief: ${D} · data-only edition`);
    expect(briefOn(h)!.edition).toBe("data_only");
    expect(summary(h).split("\n")[0]).toContain("(E_PUBLISH)");
    expect(summary(h)).toContain("status not saved");
    expect(fs.existsSync(path.join(h.root, "needs-review", D, `${D}.json`))).toBe(true);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D15 rejected brief commits after the data-only commit give E_PUBLISH; the final status commit lands and records data_only", async () => {
    const h = harness();
    h.fakeAgent({ mode: "ok", draft: DRAFT, fetches: FETCHES, touch: [path.join(h.base, "reject-briefs")] });
    expect(await run(h, ["--trigger", "schedule"])).toBe(3);
    const s = subjects(h);
    expect(s).toHaveLength(3);
    expect(s[1]).toBe(`brief: ${D} · data-only edition`);
    expect(s[2]).toMatch(/ ended: published_data_only$/);
    expect(briefOn(h)!.edition).toBe("data_only");
    const r = statusOn(h)!.runs[0]!;
    expect(r.outcome).toBe("published_data_only");
    expect(r.error_code).toBe("E_PUBLISH");
    expect(r.edition).toBe("data_only");
    expect(r.full_published_at).toBeNull();
    expect(stageOf(r, "publish").status).toBe("failed");
    expect(summary(h).split("\n")[0]).toContain("(E_PUBLISH)");
    expectContentOnly(h);
  }, TIMEOUT);
});
