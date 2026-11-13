// The morning run end to end (SPEC §8.2 Tests; plan §1 lane I, §4, amendments A1, A2 and A19): the shared
// harness gives a bare remote with a pre-receive hook, a clone as ROOT whose content/ holds only state/, the
// fake agent CLI and a router for the network probe, dispute intake and deploy check. Feeds come from
// fixtures/feeds (CT_FIXTURE_FEEDS); the clock is the harness's test clock. Every case checks that no commit
// the run pushed touches a path outside content/. Offline throughout; everything read back is data.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeError, applyDraft } from "@/lib/apply";
import { NOT_COMPOSED, NOT_VALID, WHAT_HAPPENED, nextStepFor } from "@/lib/chat";
import { at } from "@/lib/dates";
import { jsonText } from "@/lib/json";
import { Brief } from "@/lib/schema/brief";
import { AgentContext } from "@/lib/schema/context";
import { CorrectionsFile } from "@/lib/schema/misc";
import { StatusFile, type RunRecord } from "@/lib/schema/status";
import { validateAll } from "@/lib/validate";
import { DISPUTE_FORM_OPTIONS, WITHHELD_HEADLINE, WITHHELD_MARK } from "@/lib/vocab";
import { attemptBudget, CONFIG, main, repairBudget, type Deps } from "@/scripts/daily";
import { MIN } from "@/scripts/lib/clock";
import { siteUrl } from "@/lib/site";
import { runPaths } from "@/scripts/lib/paths";
import { runMetrics } from "@/scripts/metrics";
import { scheduleFor } from "@/scripts/preflight";
import { publishWithholds } from "@/scripts/publish";
import { loadCheckedConfig, loadConfig } from "@/lib/config";
import { inRoot, makeHarness, PIPELINE_DATE, REPO, type Harness, type HarnessOptions } from "./helpers/harness";
import { beforeEdition, siteBrief, testRecord, victimDispute, worldConfig } from "./helpers/publish-world";

// D30 (A19) makes runMetrics fail once; every other case runs the real one through this pass-through mock.
vi.mock("@/scripts/metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scripts/metrics")>();
  return { ...actual, runMetrics: vi.fn(actual.runMetrics) };
});
// D48 and D49 wrap publishWithholds once (a withhold that fails validation, one whose push is refused);
// every other case runs the real one.
vi.mock("@/scripts/publish", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scripts/publish")>();
  return { ...actual, publishWithholds: vi.fn(actual.publishWithholds) };
});
// D31 makes applyDraft throw ComposeError once; every other case runs the real one.
vi.mock("@/lib/apply", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/apply")>();
  return { ...actual, applyDraft: vi.fn(actual.applyDraft) };
});

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

/** Every case: no pushed commit touches a path outside content/ (`except`: commits the test itself put on the remote). */
function expectContentOnly(h: Harness, except: readonly string[] = []): void {
  for (const c of h.remoteLog()) {
    if (except.includes(c.sha)) continue;
    for (const f of c.files) expect(f.startsWith("content/"), `${c.subject}: ${f}`).toBe(true);
  }
}

const runsJsonl = (h: Harness): Record<string, unknown>[] => {
  const file = path.join(h.root, "logs", "runs.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
};

/** A brief: commit made by hand and never pushed, as a run killed between its commit and its push leaves it. */
function localBriefCommit(h: Harness, date: string, brief: Brief): string {
  const file = path.join(h.root, "content", "briefs", `${date}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonText(brief, Brief));
  h.git("add", "content");
  h.git("commit", "-q", "-m", `brief: ${date} · data-only edition`);
  return h.git("rev-parse", "HEAD");
}

/** A rendered correction issue, as GitHub's issue form writes it (fixtures/recheck/body-rendered.md). */
const correctionIssue = (o: { number: number; itemId: string; edition: string; option: string; createdAt: string }) => ({
  number: o.number, title: "Correction", labels: [{ name: "correction" }], state: "open", state_reason: null, comments: 0,
  created_at: o.createdAt, updated_at: o.createdAt, closed_at: null,
  body: `### Item id\n\n${o.itemId}\n\n### Edition date\n\n${o.edition}\n\n### What is wrong\n\n${o.option}\n\n### Evidence link\n\n_No response_`,
});

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
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
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
    // logs/D.recheck.json carries the flags the agent was shown, so the build-context CLI rebuilds its context (§8.5).
    const recheckLog = JSON.parse(fs.readFileSync(path.join(h.root, "logs", `${D}.recheck.json`), "utf8")) as Record<string, unknown>;
    const contextLog = JSON.parse(fs.readFileSync(path.join(h.root, "logs", `${D}.context.json`), "utf8")) as { corrections: { flagged: unknown } };
    expect(Object.keys(recheckLog)).toEqual(["intake", "flagged", "shown", "reports", "links"]);
    expect(recheckLog.shown).toEqual(contextLog.corrections.flagged);
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
    expect(dailyLog(h)).toContain("No retry: the error is not retryable.");
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
    expect(dailyLog(h)).toContain("No retry: the error is not retryable.");
    expectContentOnly(h);
  }, TIMEOUT);

  it("D36 a repair round stopped by the usage limit, the sandbox or a lost sign-in ends the attempt with that code: no second repair, no retry, nothing published past the data-only edition", async () => {
    // Before the repair call was checked, the run validated the unchanged draft again, spent its second round and
    // retried: E_VALIDATION twice, with nothing saying the sandbox broke.
    for (const [resumeMode, code] of [["limit", "E_LIMIT"], ["mcp", "E_SANDBOX"], ["auth", "E_AUTH"]] as const) {
      const h = harness();
      h.fakeAgent({ mode: "repair", resumeMode, invalidDraft: INVALID, repair: DRAFT, fetches: FETCHES });
      expect(await run(h, ["--trigger", "schedule"]), code).toBe(3);
      const r = statusOn(h)!.runs;
      expect(r, code).toHaveLength(1);
      expect(r[0]).toMatchObject({ outcome: "published_data_only", error_code: code });
      expect(r[0]!.budgets.repair_rounds).toBe(1);
      expect(stageOf(r[0]!, "validate").status).toBe("failed");
      expect(stageOf(r[0]!, "publish").status).toBe("skipped");
      const calls = agentRuns(h);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.argv).toContain("--resume");
      const log = dailyLog(h);
      expect(log).toContain("Attempt 1: repair 1 for 1 error and 0 snapshot warnings (BANNED_WORDS).");
      // The stopped repair call gets its own agent line; a sandbox breach kills it, so it reads "agent was stopped".
      expect(log).toMatch(resumeMode === "mcp" ? /Attempt 1: repair 1: agent was stopped · / : /Attempt 1: repair 1: agent (exited|was stopped)/);
      expect(log).not.toContain("repair 2");
      expect(log).not.toContain("Attempt 2");
      expect(log).toContain("No retry: the error is not retryable.");
      if (resumeMode === "limit") expect(r[0]!.budgets.usage).toEqual({ window: "five_hour", utilization: 1 });
      expect(summary(h).split("\n")[0]).toContain(`(${code})`);
      expect(briefOn(h)!.edition).toBe("data_only");
      expectContentOnly(h);
    }
  }, TIMEOUT);

  it("D37 a retry that fails before validating: the failed format lists no issues of attempt 1's draft", async () => {
    const h = harness();
    h.pushes("reject-briefs");
    h.fakeAgent({ mode: "repair", attemptModes: ["repair", "nodraft"], invalidDraft: INVALID, repair: INVALID, fetches: FETCHES });
    expect(await run(h, ["--trigger", "schedule"])).toBe(1);
    const runs = statusOn(h)!.runs;
    expect(runs.map((r) => [r.trigger, r.outcome, r.error_code])).toEqual([["schedule", "failed", "E_VALIDATION"], ["retry", "failed", "E_AGENT"]]);
    const lines = summary(h).split("\n");
    expect(lines[0]).toBe(`**CyberTracker ${D} · failed** (E_AGENT)`);
    expect(lines).not.toContain("First errors:");
    expect(lines.some((l) => l.includes("BANNED_WORDS"))).toBe(false);
    expect(briefOn(h)).toBeNull();
    expectContentOnly(h);
  }, TIMEOUT);

  it("D46 attempt 1 uses both repairs and fails, and attempt 2 is repaired to valid and publishes the full edition, with the fake agent", async () => {
    // The Kobol dry run of 2026-11-11: the run's two repair rounds were shared across both attempts, so attempt 2
    // had none left and its draft, one repair from valid, failed E_VALIDATION unrepaired.
    const h = harness();
    h.fakeAgent({ mode: "repair", invalidDraft: INVALID, repairs: [INVALID, INVALID, DRAFT], fetches: FETCHES });
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const runs = statusOn(h)!.runs;
    expect(runs.map((r) => [r.trigger, r.attempt, r.outcome, r.error_code, r.budgets.repair_rounds])).toEqual([
      ["schedule", 1, "published_data_only", "E_VALIDATION", 2],
      ["retry", 2, "published_full", null, 1],
    ]);
    const calls = agentRuns(h);
    expect(calls.map((c) => (c.argv.includes("--resume") ? "resume" : "new"))).toEqual(["new", "resume", "resume", "new", "resume"]);
    const log = dailyLog(h);
    expect(log).toContain("Attempt 1: repair 1 for 1 error and 0 snapshot warnings (BANNED_WORDS).");
    expect(log).toContain("Attempt 1: repair 2 for 1 error and 0 snapshot warnings (BANNED_WORDS).");
    expect(log).toContain("Attempt 2: repair 1 for 1 error and 0 snapshot warnings (BANNED_WORDS).");
    expect(log).not.toContain("Attempt 2: repair 2");
    expect(fs.existsSync(path.join(h.root, "logs", `${D}.agent-2-repair-1.jsonl`))).toBe(true);
    expect(briefOn(h)!.edition).toBe("full");
    // The run's repairs, across both attempts: the chat line sums each record's rounds, runs.jsonl counts them too.
    expect(summary(h)).toContain("2 attempts, 3 repairs");
    expect(runsJsonl(h).at(-1)).toMatchObject({ outcome: "published_full", attempts: 2, repairs: 3, error_code: null });
    expectContentOnly(h);
  }, TIMEOUT);

  it("D38 a start at 05:21 leaves too little time for attempt 1: E_TIMEOUT with the no-retry line, the data-only edition stands", async () => {
    const h = harness({ start: "05:21" });
    okAgent(h);
    expect(await run(h, ["--trigger", "schedule"])).toBe(3);
    const r = statusOn(h)!.runs;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ outcome: "published_data_only", error_code: "E_TIMEOUT" });
    expect(stageOf(r[0]!, "draft")).toMatchObject({ status: "failed", note: "The run had too little time left for an editorial pass before 05:30." });
    expect(dailyLog(h)).toContain("No retry: it is past the retry cutoff (05:00).");
    expect(agentRuns(h)).toEqual([]);
    expect(summary(h).split("\n")[0]).toMatch(/\(E_TIMEOUT\)$/);
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

  it("D52 a start at 00:05 is too early: skipped with one status: commit, nothing published, --no-deadline too (§0.4 row 185)", async () => {
    for (const extra of [[], ["--no-deadline"]]) {
      const h = harness({ start: "00:05" });
      okAgent(h);
      expect(await run(h, ["--trigger", "manual", ...extra])).toBe(0);
      const s = subjects(h);
      expect(s).toHaveLength(1);
      expect(s[0]).toMatch(new RegExp(`^status: ${D} · run \\d{8}-\\d{6} ended: skipped$`));
      const r = statusOn(h)!.runs;
      expect(r).toHaveLength(1);
      expect(r[0]!.outcome).toBe("skipped");
      expect(stageOf(r[0]!, "preflight").note).toBe("Too early: the news window ends at 04:30; start the run then.");
      expect(h.agentCalls()).toEqual([]);
      expect(briefOn(h)).toBeNull();
      expect(summary(h)).toContain(`skipped.** Too early: the news window ends at 04:30; start the run then.`);
      expect(h.waits()).toEqual([]);
      expectContentOnly(h);
    }
  }, TIMEOUT);

  it("D53 a start at 04:20 waits until 04:30, then publishes the full edition (§0.4 row 185)", async () => {
    const h = harness({ start: "04:20" });
    okAgent(h);
    const waited: number[] = [];
    const sleep = async (ms: number) => {
      waited.push(ms);
      h.clock.jump(ms);
    };
    expect(await run(h, ["--trigger", "schedule"], { sleep })).toBe(0);
    expect(waited[0]).toBeGreaterThan(9 * MIN);
    expect(waited[0]).toBeLessThanOrEqual(10 * MIN);
    expect(dailyLog(h)).toContain("Waiting until 04:30, when the news window ends.");
    const r = statusOn(h)!.runs;
    expect(r).toHaveLength(1);
    expect(r[0]!.outcome).toBe("published_full");
    expect(briefOn(h)!.edition).toBe("full");
    const full = JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!) as { generated_at: string };
    expect(Date.parse(full.generated_at)).toBeGreaterThanOrEqual(at(D, "04:30"));
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

  it("D34 --data-only --force after a full edition is skipped as already published: exit 0, one status: commit, the edition untouched", async () => {
    const h = harness();
    okAgent(h);
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const before = h.remoteFile(`content/briefs/${D}.json`);
    h.clock.set(h.clock() + 2 * MIN);
    expect(await run(h, ["--trigger", "manual", "--data-only", "--force"])).toBe(0);
    const s = subjects(h);
    expect(s).toHaveLength(5);
    expect(s[4]).toMatch(/ ended: skipped$/);
    const last = statusOn(h)!.runs.at(-1)!;
    expect(last).toMatchObject({ outcome: "skipped", error_code: null });
    expect(stageOf(last, "preflight").note).toMatch(/^The full edition was already published at \d\d:\d\d\.$/);
    expect(h.remoteFile(`content/briefs/${D}.json`)).toBe(before);
    expect(runsJsonl(h).at(-1)).toMatchObject({ outcome: "skipped", error_code: null });
    expect(fs.existsSync(path.join(h.root, "needs-review", D))).toBe(false);
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

  it("D31 a draft the composer cannot freeze (ComposeError) gives E_PUBLISH with the not-composed note; the data-only edition stands, exit 3", async () => {
    const h = harness();
    okAgent(h);
    vi.mocked(applyDraft).mockImplementationOnce(() => {
      throw new ComposeError("No release date for rel-microsoft-2026-10: no vendor source with a date and no bundled record");
    });
    expect(await run(h, ["--trigger", "schedule"])).toBe(3);
    expect(vi.mocked(applyDraft)).toHaveBeenCalled();
    const s = subjects(h);
    expect(s[1]).toBe(`brief: ${D} · data-only edition`);
    expect(s.filter((x) => x.startsWith("brief: "))).toHaveLength(1);
    expect(s.at(-1)).toMatch(/ ended: published_data_only$/);
    expect(briefOn(h)!.edition).toBe("data_only");
    const r = statusOn(h)!.runs[0]!;
    expect(r.error_code).toBe("E_PUBLISH");
    expect(stageOf(r, "publish").status).toBe("failed");
    expect(stageOf(r, "publish").note).toContain("Not composed: a release or CVE block lacks its date, page or record facts (see the daily log).");
    expect(fs.readFileSync(path.join(h.root, "logs", `${D}.daily.log`), "utf8")).toContain("The full edition could not be composed: No release date for rel-microsoft-2026-10");
    expect(summary(h).split("\n")[0]).toContain("(E_PUBLISH)");
    // Publishing the same draft again fails the same way: the chat edition says to edit it first.
    expect(summary(h)).toContain(`\nWhat happened: ${NOT_COMPOSED.what}\n`);
    expect(summary(h)).toContain(`\nNext step: ${NOT_COMPOSED.nextStep.replaceAll("{date}", D)}\n`);
    expect(summary(h)).not.toContain(nextStepFor("E_PUBLISH", D));
    expect(fs.existsSync(path.join(h.root, "drafts", `${D}.json`))).toBe(true);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D32 a same-day victim dispute on a data-only item the draft re-reports: the full edition withholds it too, the dispute stays linked, exit 0", async () => {
    // Before a withhold bound later editions, the full brief re-reported the item unmasked: XREF_CORRECTION and E_PUBLISH.
    const h = harness();
    okAgent(h);
    const ITEM = "cve-2026-104935";
    h.issues([correctionIssue({ number: 5, itemId: ITEM, edition: D, option: DISPUTE_FORM_OPTIONS.victim, createdAt: "2026-10-13T20:45:00Z" })]);
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const s = subjects(h);
    expect(s.slice(1, 3)).toEqual([`brief: ${D} · data-only edition`, `correction: ${D} · withheld ${ITEM}`]);
    expect(s.some((x) => x.startsWith(`brief: ${D} · full edition`))).toBe(true);
    const stored = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
    expect(stored.edition).toBe("full");
    expect(stored.items.find((x) => x.id === ITEM)).toMatchObject({ headline: WITHHELD_HEADLINE, why_it_matters: null, withheld: { correction_id: "C-0001", since: D } });
    expect(stored.lead.some((l) => l.item_ids.includes(ITEM))).toBe(true);
    for (const l of stored.lead) if (l.item_ids.includes(ITEM)) expect(l.text).toBe(WITHHELD_MARK);
    for (const row of stored.regions.rows) {
      if (row.item_ids.includes(ITEM)) expect(row.reason).toBe(WITHHELD_MARK);
      if (row.raised?.item_ids.includes(ITEM)) expect(row.raised.reason).toBe(WITHHELD_MARK);
    }
    expect(stored.corrections.map((c) => c.id)).toEqual(["C-0001"]);
    // Intake's list predates the withhold commit; the edition still writes the dispute linked to its correction.
    const cf = CorrectionsFile.parse(JSON.parse(h.remoteFile("content/corrections.json")!));
    expect(cf.corrections).toMatchObject([{ id: "C-0001", date: D, item_id: ITEM, edition_date: D, type: "name_removed", dispute_id: "D-0001" }]);
    expect(cf.disputes).toMatchObject([{ id: "D-0001", item_id: ITEM, kind: "victim", status: "open", correction_id: "C-0001" }]);
    const r = statusOn(h)!.runs[0]!;
    expect(r.outcome).toBe("published_full");
    expect(r.error_code).toBeNull();
    expect(stageOf(r, "recheck").note).toContain("Withheld 1 item on reader disputes.");
    expect(stageOf(r, "publish").note).toContain("Withheld 1 re-reported item under reader disputes.");
    expect(dailyLog(h)).toContain(`Withheld ${ITEM} in this edition: it re-reports the item C-0001 withholds (id match).`);
    expect(validateAll(path.join(h.root, "content"), { config: loadCheckedConfig({ root: h.root }) }).errors).toEqual([]);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D48 a victim dispute whose withhold fails validation: no editorial pass, E_WITHHOLD, exit 3, the dispute stored; the rerun withholds the item even with intake down, then drafts", async () => {
    // Codex review of PR #5, round 2: the run logged the failed withhold and went on to draft and publish a full
    // edition with no correction to mask the item, so the disputed name could be printed again (§0.4 row 149).
    // The review of that fix: nothing stored the dispute, so a rerun whose intake could not read GitHub published
    // the item unmasked; the end record's commit now stores intake's disputes.
    const h = harness();
    okAgent(h);
    const ITEM = "cve-2026-104935";
    h.issues([correctionIssue({ number: 5, itemId: ITEM, edition: D, option: DISPUTE_FORM_OPTIONS.victim, createdAt: "2026-10-13T20:45:00Z" })]);
    const actual = await vi.importActual<typeof import("@/scripts/publish")>("@/scripts/publish");
    const { composeWithholds } = await vi.importActual<typeof import("@/lib/withhold")>("@/lib/withhold");
    vi.mocked(publishWithholds).mockImplementationOnce((o) => actual.publishWithholds(o, {
      composeWithholds: (i) => {
        const ch = composeWithholds(i);
        ch.corrections!.corrections.at(-1)!.dispute_id = "D-0999";
        return ch;
      },
    }));
    expect(await run(h, ["--trigger", "schedule"])).toBe(3);
    let s = subjects(h);
    expect(s.filter((x) => x.startsWith("correction: "))).toEqual([]);
    expect(s.filter((x) => x.startsWith("brief: "))).toEqual([`brief: ${D} · data-only edition`]);
    expect(s.at(-1)).toMatch(/ ended: published_data_only$/);
    expect(agentRuns(h)).toEqual([]);
    // The end record's commit stores the waiting dispute, with no correction.
    const ended = h.remoteLog().at(-1)!;
    expect(ended.subject).toMatch(/ ended: published_data_only$/);
    expect(ended.files).toEqual(expect.arrayContaining(["content/corrections.json", `content/status/${D}.json`]));
    expect(CorrectionsFile.parse(JSON.parse(h.remoteFile("content/corrections.json")!))).toMatchObject({
      corrections: [], disputes: [{ id: "D-0001", issue_number: 5, item_id: ITEM, kind: "victim", status: "open", correction_id: null }],
    });
    let r = statusOn(h)!.runs[0]!;
    expect([r.outcome, r.error_code]).toEqual(["published_data_only", "E_WITHHOLD"]);
    expect(stageOf(r, "recheck").status).toBe("failed");
    expect(stageOf(r, "recheck").note).toContain("Could not withhold 1 item on reader disputes, so no full edition is drafted until the withhold is made (see the daily log).");
    expect(stageOf(r, "recheck").note).not.toContain("Withheld 1 item on reader disputes.");
    for (const st of ["draft", "validate", "publish"]) {
      expect(stageOf(r, st)).toMatchObject({ status: "skipped", note: "Not run: a reader dispute's withhold was not made." });
    }
    expect(dailyLog(h)).toContain("Validation: XREF_CORRECTION at ");
    expect(dailyLog(h)).toContain(`Not withheld: ${ITEM}; no editorial pass today.`);
    expect(summary(h).split("\n")[0]).toContain("(E_WITHHOLD)");
    expect(summary(h)).toContain(`\nWhat happened: ${WHAT_HAPPENED.E_WITHHOLD({ date: D, errors: 0, repairs: 0, attempts: 0, agentMinutes: null, hardStop: "05:30", publishUntil: "11:00" })}\n`);
    expect(summary(h)).toContain(`\nNext step: ${nextStepFor("E_WITHHOLD", D)}\n`);
    expect(fs.existsSync(path.join(h.root, "needs-review", D))).toBe(true);

    // The next step's rerun, with GitHub's issues unreadable: intake builds its withholds from the stored
    // dispute, the withhold lands, and the full edition masks the item.
    h.issues("fail");
    h.clock.set(h.clock() + 2 * MIN);
    expect(await run(h, ["--trigger", "manual", "--no-deadline"])).toBe(0);
    s = subjects(h);
    expect(s.filter((x) => x.startsWith("correction: "))).toEqual([`correction: ${D} · withheld ${ITEM}`]);
    expect(s.some((x) => x.startsWith(`brief: ${D} · full edition`))).toBe(true);
    expect(agentRuns(h)).toHaveLength(1);
    const stored = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
    expect(stored.items.find((x) => x.id === ITEM)).toMatchObject({ headline: WITHHELD_HEADLINE, withheld: { correction_id: "C-0001", since: D } });
    r = statusOn(h)!.runs.at(-1)!;
    expect([r.outcome, r.error_code]).toEqual(["published_full", null]);
    expect(stageOf(r, "recheck")).toMatchObject({ status: "ok" });
    expect(stageOf(r, "recheck").note).toContain("Dispute intake unavailable today.");
    expect(stageOf(r, "recheck").note).toContain("Withheld 1 item on reader disputes.");
    expect(CorrectionsFile.parse(JSON.parse(h.remoteFile("content/corrections.json")!)).disputes).toMatchObject([{ id: "D-0001", correction_id: "C-0001" }]);
    expect(validateAll(path.join(h.root, "content"), { config: loadCheckedConfig({ root: h.root }) }).errors).toEqual([]);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D49 a withhold whose push GitHub refuses stays local and still binds: the full edition drafts, masks the item and carries the commit, exit 0", async () => {
    // The tree holds the correction, so §0.4 row 149's check passes and the edition's push takes the withhold with it.
    const h = harness();
    okAgent(h);
    const ITEM = "cve-2026-104935";
    h.issues([correctionIssue({ number: 5, itemId: ITEM, edition: D, option: DISPUTE_FORM_OPTIONS.victim, createdAt: "2026-10-13T20:45:00Z" })]);
    const actual = await vi.importActual<typeof import("@/scripts/publish")>("@/scripts/publish");
    vi.mocked(publishWithholds).mockImplementationOnce(async (o) => {
      h.pushes("reject");
      try {
        return await actual.publishWithholds(o);
      } finally {
        h.pushes("accept");
      }
    });
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const s = subjects(h);
    const withhold = s.indexOf(`correction: ${D} · withheld ${ITEM}`);
    expect(withhold).toBeGreaterThan(0);
    expect(s.findIndex((x) => x.startsWith(`brief: ${D} · full edition`))).toBeGreaterThan(withhold);
    expect(dailyLog(h)).toMatch(/[0-9a-f]{7} stays local; the next push carries it\./);
    expect(dailyLog(h)).not.toContain("Not withheld:");
    const stored = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
    expect(stored.edition).toBe("full");
    expect(stored.items.find((x) => x.id === ITEM)).toMatchObject({ headline: WITHHELD_HEADLINE, withheld: { correction_id: "C-0001", since: D } });
    const r = statusOn(h)!.runs[0]!;
    expect([r.outcome, r.error_code]).toEqual(["published_full", null]);
    expect(stageOf(r, "recheck")).toMatchObject({ status: "ok" });
    expect(stageOf(r, "recheck").note).toContain("Withheld 1 item on reader disputes.");
    expect(stageOf(r, "recheck").note).not.toContain("Could not withhold");
    expect(agentRuns(h)).toHaveLength(1);
    expect(validateAll(path.join(h.root, "content"), { config: loadCheckedConfig({ root: h.root }) }).errors).toEqual([]);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D50 after a full edition, a --force run whose withhold fails ends E_WITHHOLD, exit 1, and its next step reruns with --force, which withholds the item", async () => {
    // The review of the Codex round 2 fix: the next step's plain rerun stops at preflight step 6 (the full edition
    // is up), so intake never asked for the withhold again that day (§0.4 row 149).
    const h = harness();
    okAgent(h);
    const ITEM = "cve-2026-104935";
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    expect(briefOn(h)!.edition).toBe("full");
    h.issues([correctionIssue({ number: 5, itemId: ITEM, edition: D, option: DISPUTE_FORM_OPTIONS.victim, createdAt: "2026-10-13T22:00:00Z" })]);
    const actual = await vi.importActual<typeof import("@/scripts/publish")>("@/scripts/publish");
    vi.mocked(publishWithholds).mockImplementationOnce((o) => actual.publishWithholds(o, { composeWithholds: () => { throw new Error("simulated compose failure"); } }));
    h.clock.set(h.clock() + 2 * MIN);
    expect(await run(h, ["--trigger", "manual", "--force"])).toBe(1);
    const r = statusOn(h)!.runs.at(-1)!;
    expect([r.outcome, r.error_code]).toEqual(["failed", "E_WITHHOLD"]);
    expect(agentRuns(h)).toHaveLength(1);
    const rerun = "zsh /Users/kobol/Projects/CyberTracker/scripts/daily.sh --no-deadline";
    expect(summary(h)).toContain(`\nNext step: ${nextStepFor("E_WITHHOLD", D).replace(rerun, `${rerun} --force`)}\n`);
    // As the next step says: the withhold lands and the forced full edition masks the item.
    h.clock.set(h.clock() + 2 * MIN);
    expect(await run(h, ["--trigger", "manual", "--no-deadline", "--force"])).toBe(0);
    expect(subjects(h).filter((x) => x.startsWith("correction: "))).toEqual([`correction: ${D} · withheld ${ITEM}`]);
    const stored = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
    expect(stored.items.find((x) => x.id === ITEM)).toMatchObject({ headline: WITHHELD_HEADLINE, withheld: { correction_id: "C-0001", since: D } });
    expect([statusOn(h)!.runs.at(-1)!.outcome, statusOn(h)!.runs.at(-1)!.error_code]).toEqual(["published_full", null]);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D51 a withhold that fails on an item another edition's binding withhold of the same kind already masks stops nothing: the editorial pass runs", async () => {
    // The review of the Codex round 2 fix: a blank-edition dispute on an item already withheld under another
    // edition asks for a withhold of its own; when that one fails, the binding one still masks the item by id
    // in every brief, so the gate must not stop the morning (§0.4 row 149).
    const D0 = "2026-10-13";
    const D2 = "2026-10-15";
    const h = harness({ date: D0 });
    h.fakeAgent({ mode: "nodraft" });
    expect(await run(h, ["--trigger", "schedule", "--data-only"])).toBe(3);
    const X = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D0}.json`)!)).items.map((x) => x.id)
      .find((id) => (DRAFT as { items: { id: string }[] }).items.some((x) => x.id === id))!;
    expect(X).toBeTruthy();
    // Day D: a victim dispute on X in the D0 edition; the withhold lands and the full edition masks X by id.
    okAgent(h);
    h.issues([correctionIssue({ number: 6, itemId: X, edition: D0, option: DISPUTE_FORM_OPTIONS.victim, createdAt: "2026-10-13T13:00:00Z" })]);
    h.clock.set(at(D, "04:37"));
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    expect(Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!)).items.find((x) => x.id === X)?.withheld?.correction_id).toBe("C-0001");
    // Day D2: a second victim dispute on X with the edition left blank (resolved to D, the newest holding X); its own withhold fails.
    h.issues([
      correctionIssue({ number: 6, itemId: X, edition: D0, option: DISPUTE_FORM_OPTIONS.victim, createdAt: "2026-10-13T13:00:00Z" }),
      correctionIssue({ number: 7, itemId: X, edition: "_No response_", option: DISPUTE_FORM_OPTIONS.victim, createdAt: "2026-10-14T13:00:00Z" }),
    ]);
    vi.mocked(publishWithholds).mockImplementationOnce(async () => { throw new Error("simulated: the commit failed"); });
    h.fakeAgent({ mode: "nodraft" });
    const before = agentRuns(h).length;
    h.clock.set(at(D2, "04:37"));
    await run(h, ["--trigger", "schedule"]);
    const r = StatusFile.parse(JSON.parse(h.remoteFile(`content/status/${D2}.json`)!)).runs[0]!;
    expect(r.error_code).not.toBe("E_WITHHOLD");
    expect(stageOf(r, "recheck").status).toBe("ok");
    expect(stageOf(r, "recheck").note ?? "").not.toContain("Could not withhold");
    expect(stageOf(r, "draft").note ?? "").not.toContain("withhold was not made");
    expect(agentRuns(h).length).toBeGreaterThan(before);
    expect(fs.readFileSync(path.join(h.root, "logs", `${D2}.daily.log`), "utf8")).toContain("simulated: the commit failed");
    expect(fs.readFileSync(path.join(h.root, "logs", `${D2}.daily.log`), "utf8")).not.toContain("Not withheld:");
    expectContentOnly(h);
  }, TIMEOUT);

  it("D44 a full edition that fails whole-tree validation gives E_PUBLISH with the not-valid note and lines that read the Validation lines, exit 3", async () => {
    // Before T4 the chat edition said the draft was valid and to publish it again by hand, which fails the same way.
    const h = harness();
    okAgent(h);
    const actual = await vi.importActual<typeof import("@/lib/apply")>("@/lib/apply");
    vi.mocked(applyDraft).mockImplementationOnce((i) => {
      const ch = actual.applyDraft(i);
      ch.brief!.computed.word_count += 1;
      return ch;
    });
    expect(await run(h, ["--trigger", "schedule"])).toBe(3);
    expect(subjects(h).filter((x) => x.startsWith("brief: "))).toEqual([`brief: ${D} · data-only edition`]);
    expect(briefOn(h)!.edition).toBe("data_only");
    const r = statusOn(h)!.runs[0]!;
    expect([r.outcome, r.error_code]).toEqual(["published_data_only", "E_PUBLISH"]);
    expect(stageOf(r, "publish")).toMatchObject({ status: "failed" });
    expect(stageOf(r, "publish").note).toContain("Not valid: the full edition failed whole-tree validation (see the Validation lines in the daily log).");
    expect(dailyLog(h)).toContain(`Validation: COMPUTED_MISMATCH at briefs/${D}.json: computed.word_count`);
    expect(summary(h)).toContain(`\nWhat happened: ${NOT_VALID.what}\n`);
    expect(summary(h)).toContain(`\nNext step: ${NOT_VALID.nextStep.replaceAll("{date}", D)}\n`);
    expect(summary(h)).not.toContain(nextStepFor("E_PUBLISH", D));
    expect(fs.existsSync(path.join(h.root, "drafts", `${D}.json`))).toBe(true);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D45 a --force rerun whose full edition fails whole-tree validation: the earlier full edition stands and the hand publish command takes --force, exit 1", async () => {
    // Before the review of the third fix pass the next step gave the command without --force, which publish refuses
    // while a full edition of D stands ("already published").
    const h = harness();
    okAgent(h);
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const first = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
    const actual = await vi.importActual<typeof import("@/lib/apply")>("@/lib/apply");
    vi.mocked(applyDraft).mockImplementationOnce((i) => {
      const ch = actual.applyDraft(i);
      ch.brief!.computed.word_count += 1;
      return ch;
    });
    h.clock.set(h.clock() + 2 * MIN);
    expect(await run(h, ["--trigger", "manual", "--force"])).toBe(1);
    expect(Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!)).published_at).toBe(first.published_at);
    const r = statusOn(h)!.runs.at(-1)!;
    expect([r.outcome, r.error_code]).toEqual(["failed", "E_PUBLISH"]);
    const cmd = `npm run publish -- --date ${D}`;
    expect(summary(h)).toContain(`\nNext step: ${NOT_VALID.nextStep.replaceAll("{date}", D).replaceAll(cmd, `${cmd} --force`)}\n`);
    expect(summary(h)).toContain(`${cmd} --force before 11:00`);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D40 a same-day victim dispute on a data-only item the draft re-reports as another kind: the kept item takes the re-report's slot, the story shows once, exit 0", async () => {
    // Before W1, the draft's brief lacked the item C-0001 names in this edition: XREF_UNRESOLVED and E_PUBLISH. Before
    // T2 the edition kept the item at the end and masked the patch batch, which cites its record page, in place: the
    // story showed twice, both masked.
    const h = harness();
    okAgent(h);
    const ITEM = "cve-2026-96951";
    const PATCHES = "pt-microsoft-2026-10";
    const draftIds = (DRAFT as { items: { id: string }[] }).items.map((x) => x.id);
    expect(draftIds).not.toContain(ITEM);
    h.issues([correctionIssue({ number: 7, itemId: ITEM, edition: D, option: DISPUTE_FORM_OPTIONS.victim, createdAt: "2026-10-13T20:45:00Z" })]);
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const s = subjects(h);
    expect(s.slice(1, 3)).toEqual([`brief: ${D} · data-only edition`, `correction: ${D} · withheld ${ITEM}`]);
    expect(s.some((x) => x.startsWith(`brief: ${D} · full edition`))).toBe(true);
    const stored = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
    expect(stored.edition).toBe("full");
    // The story appears once, masked under its own id in the patch batch's slot; the patch batch is gone.
    expect(stored.items.map((x) => x.id)).toEqual(draftIds.map((id) => (id === PATCHES ? ITEM : id)));
    const kept = stored.items.find((x) => x.id === ITEM)!;
    expect(kept).toMatchObject({ headline: WITHHELD_HEADLINE, why_it_matters: null, withheld: { correction_id: "C-0001", since: D } });
    expect(stored.sources.filter((x) => kept.source_ids.includes(x.id)).map((x) => x.title)).toEqual(kept.source_ids.map(() => WITHHELD_MARK));
    for (const l of stored.lead) if (l.item_ids.includes(ITEM)) expect(l.text).toBe(WITHHELD_MARK);
    expect(JSON.stringify(stored)).not.toContain(PATCHES);
    expect(stored.corrections.map((c) => [c.id, c.item_id])).toEqual([["C-0001", ITEM]]);
    const r = statusOn(h)!.runs[0]!;
    expect(r.outcome).toBe("published_full");
    expect(r.error_code).toBeNull();
    const note = stageOf(r, "publish").note;
    expect(note).toContain("Kept 1 withheld item in the slot of the draft item that re-reports it.");
    expect(note).not.toContain("re-reported item under reader disputes");
    expect(dailyLog(h)).toContain(
      `Kept ${ITEM} in this edition, withheld, in the slot of ${PATCHES}: C-0001 names it in this edition, and ${PATCHES} re-reports it (url match) but cannot take its id.`,
    );
    // The agent was told: brief D's withheld item is in recent_items, marked, with the withheld headline only.
    const context = AgentContext.parse(JSON.parse(fs.readFileSync(path.join(h.root, "drafts", "context.json"), "utf8")));
    expect(context.recent_items.filter((x) => x.date === D)).toMatchObject([{ id: ITEM, headline: WITHHELD_HEADLINE, withheld: true, dispute_kind: "victim" }]);
    // The chat edition's top stories hold the kept item in the patch batch's slot: the withheld headline, no AI chip.
    const slot = draftIds.indexOf(PATCHES);
    expect(slot).toBeLessThan(3);
    expect(summary(h)).toMatch(new RegExp(`\\n${slot + 1}\\. [^\\n]* · ${WITHHELD_HEADLINE} · \\S+#${ITEM}\\n`));
    expect(summary(h)).not.toMatch(/unassessed|\bnull\b/);
    expect(validateAll(path.join(h.root, "content"), { config: loadCheckedConfig({ root: h.root }) }).errors).toEqual([]);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D41 D40's morning, then --force: the replacing edition keeps the withheld item in the patch batch's slot again, with every page it cites masked", async () => {
    // The synced archive index lists the first full edition's references, the patch batch's pages under the kept
    // item, so the rerun's patch batch is a re-report of it again and never prints in the clear.
    const h = harness();
    okAgent(h);
    const ITEM = "cve-2026-96951";
    const PATCHES = "pt-microsoft-2026-10";
    h.issues([correctionIssue({ number: 7, itemId: ITEM, edition: D, option: DISPUTE_FORM_OPTIONS.victim, createdAt: "2026-10-13T20:45:00Z" })]);
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const first = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
    h.clock.set(h.clock() + 2 * MIN);
    expect(await run(h, ["--trigger", "manual", "--force"])).toBe(0);
    const second = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
    expect(second.published_at).not.toBe(first.published_at);
    expect(second.items.map((x) => x.id)).toEqual(first.items.map((x) => x.id));
    expect(JSON.stringify(second)).not.toContain(PATCHES);
    const kept = second.items.find((x) => x.id === ITEM)!;
    expect(kept).toMatchObject({ headline: WITHHELD_HEADLINE, why_it_matters: null, withheld: { correction_id: "C-0001", since: D } });
    expect(second.sources.filter((x) => kept.source_ids.includes(x.id)).map((x) => x.title)).toEqual(kept.source_ids.map(() => WITHHELD_MARK));
    const r = statusOn(h)!.runs.at(-1)!;
    expect([r.outcome, r.error_code]).toEqual(["published_full", null]);
    expect(stageOf(r, "publish").note).toContain("Kept 1 withheld item in the slot of the draft item that re-reports it.");
    expect(validateAll(path.join(h.root, "content"), { config: loadCheckedConfig({ root: h.root }) }).errors).toEqual([]);
    expectContentOnly(h);
  }, TIMEOUT);

  /**
   * The pipeline draft without the Ivanti item: its Lead sentence names Microsoft alone, the US raise that cited it
   * goes, and the landmark policy item becomes the third top story, with a why_it_matters and a 33-word summary
   * (over the rows' 25).
   */
  const draftWithoutIvanti = (): { items: { id: string }[] } => {
    type Item = { id: string; summary: string; why_it_matters: string | null };
    const d = structuredClone(DRAFT) as { items: Item[]; lead: { text: string; item_ids: string[] }[]; region_raises: unknown[] };
    d.items = d.items.filter((x) => x.id !== "cve-2026-104935");
    const pol = d.items.findIndex((x) => x.id === "pol-tw-incident-reporting-2026-10");
    const policy = d.items.splice(pol, 1)[0]!;
    policy.summary = `${policy.summary} Operators would also have to say which systems were hit.`;
    policy.why_it_matters = "Faster reports would give the government an earlier view of attacks on the island's power and water operators.";
    d.items.splice(2, 0, policy);
    d.lead[0] = { ...d.lead[0]!, text: "Microsoft fixed a flaw that attackers were already using, and CISA listed it as exploited on 13 October.", item_ids: ["pt-microsoft-2026-10"] };
    d.region_raises = [];
    return d;
  };

  it("D42 a same-day withhold on a Critical item of the full edition, then --force with a draft that leaves it out: the kept item sits after every draft item, exit 0", async () => {
    // Before T1 the kept item ranked by its stored Critical severity, pushed the campaign (38-word summary) from the
    // top stories into the rows, whose 25-word limit failed WORDS_OVER: E_PUBLISH, and the first full edition stood.
    const h = harness();
    okAgent(h);
    const ITEM = "cve-2026-104935";
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const first = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
    expect(first.items.find((x) => x.id === ITEM)!.severity).toBe("critical");
    h.issues([correctionIssue({ number: 8, itemId: ITEM, edition: D, option: DISPUTE_FORM_OPTIONS.victim, createdAt: "2026-10-13T21:20:00Z" })]);
    h.fakeAgent({ mode: "ok", draft: draftWithoutIvanti(), fetches: FETCHES });
    h.clock.set(h.clock() + 2 * MIN);
    expect(await run(h, ["--trigger", "manual", "--force"])).toBe(0);
    const second = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
    expect(second.published_at).not.toBe(first.published_at);
    const kept = second.items.at(-1)!;
    expect(kept).toMatchObject({ id: ITEM, severity: "critical", headline: WITHHELD_HEADLINE, withheld: { correction_id: "C-0001", since: D } });
    // The draft's items keep the slots the draft gave them: the campaign is still a top story.
    expect(second.items.slice(0, -1).map((x) => x.id)).toEqual((draftWithoutIvanti() as { items: { id: string }[] }).items.map((x) => x.id));
    const r = statusOn(h)!.runs.at(-1)!;
    expect([r.outcome, r.error_code]).toEqual(["published_full", null]);
    expect(stageOf(r, "publish").note).toContain("Kept 1 withheld item the draft left out, so its correction resolves.");
    expect(validateAll(path.join(h.root, "content"), { config: loadCheckedConfig({ root: h.root }) }).errors).toEqual([]);
    expectContentOnly(h);
  }, TIMEOUT);

  /** Plain filler words for the page-total case: no number, name, cue or banned word. */
  const filler = (n: number): string => {
    const words = "the cited pages give more detail on this item for readers who want it".split(" ");
    const out = Array.from({ length: n }, (_, i) => words[i % words.length]!);
    out[0] = out[0]![0]!.toUpperCase() + out[0]!.slice(1);
    return `${out.join(" ")}.`;
  };
  type PadText = { text: string | null };
  type PadDraft = {
    items: { id: string; source_ids: string[]; why_it_matters: string | null }[];
    taiwan_lens: { analysis: string; rows: PadText[]; japan: PadText };
  };
  /**
   * The pipeline draft with `n` more counted words: the Taiwan Lens analysis to its 120, each written Lens row to its
   * 30 and the Japan block to its 40, then a why_it_matters of up to 25 on each Also-today row. The patch batch no
   * longer cites CVE-2026-96951's record page (s5), so no draft item re-reports the data-only item withheld below.
   */
  const paddedDraft = (n: number): PadDraft => {
    const d = structuredClone(DRAFT) as PadDraft;
    d.items.find((x) => x.id === "pt-microsoft-2026-10")!.source_ids = ["s4", "s6"];
    let left = n;
    const grow = (text: string, max: number): string => {
      const k = Math.min(left, max - text.split(/\s+/).length);
      if (k <= 0) return text;
      left -= k;
      return `${text} ${filler(k)}`;
    };
    const lens = d.taiwan_lens;
    lens.analysis = grow(lens.analysis, 120);
    for (const row of lens.rows) if (row.text !== null) row.text = grow(row.text, 30);
    lens.japan.text = grow(lens.japan.text!, 40);
    for (const it of d.items.slice(3)) {
      if (left <= 0) break;
      const k = Math.min(left, 25);
      it.why_it_matters = filler(k);
      left -= k;
    }
    expect(left).toBe(0);
    return d;
  };

  it("D43 a draft at 1,295 counted words and a same-day withheld data-only item it leaves out: the kept item adds no words, exit 0", async () => {
    // Before T1 the kept item's headline, summary, kicker and timeline counted toward the page total, so the edition
    // went over the 1,300 cap: WORDS_OVER at (root), E_PUBLISH, and the data-only edition stood.
    const ITEM = "cve-2026-96951";
    const scratch = harness();
    scratch.fakeAgent({ mode: "ok", draft: paddedDraft(0), fetches: FETCHES });
    expect(await run(scratch, ["--trigger", "schedule"])).toBe(0);
    const base = Brief.parse(JSON.parse(scratch.remoteFile(`content/briefs/${D}.json`)!)).computed.word_count;
    const draft = paddedDraft(1295 - base);

    const h = harness();
    h.fakeAgent({ mode: "ok", draft, fetches: FETCHES });
    h.issues([correctionIssue({ number: 7, itemId: ITEM, edition: D, option: DISPUTE_FORM_OPTIONS.victim, createdAt: "2026-10-13T20:45:00Z" })]);
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const stored = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
    expect(stored.edition).toBe("full");
    expect(stored.items.at(-1)).toMatchObject({ id: ITEM, headline: WITHHELD_HEADLINE, withheld: { correction_id: "C-0001", since: D } });
    expect(stored.computed.word_count).toBe(1295);
    const r = statusOn(h)!.runs[0]!;
    expect([r.outcome, r.error_code]).toEqual(["published_full", null]);
    expect(stageOf(r, "publish").note).toContain("Kept 1 withheld item the draft left out, so its correction resolves.");
    expect(validateAll(path.join(h.root, "content"), { config: loadCheckedConfig({ root: h.root }) }).errors).toEqual([]);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D33 a withhold on an earlier edition, then a full edition the same morning: the regions history the edition and its files read is the rewritten one", async () => {
    // Morning one (D-1) publishes its data-only edition; a victim dispute on one of its items arrives; morning two withholds it, then drafts.
    const D0 = "2026-10-13";
    const h = harness({ date: D0 });
    h.fakeAgent({ mode: "nodraft" });
    expect(await run(h, ["--trigger", "schedule", "--data-only"])).toBe(3);
    const earlier = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D0}.json`)!));
    const item = earlier.items[0]!;
    h.issues([correctionIssue({ number: 6, itemId: item.id, edition: D0, option: DISPUTE_FORM_OPTIONS.victim, createdAt: "2026-10-13T13:00:00Z" })]);
    okAgent(h);
    h.clock.set(at(D, "04:37"));
    vi.mocked(applyDraft).mockClear();
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    expect(subjects(h)).toContain(`correction: ${D} · withheld ${item.id}`);
    expect(briefOn(h)!.edition).toBe("full");
    // Stage 3 read the history before the withhold; the full edition must not compose from that copy.
    const input = vi.mocked(applyDraft).mock.calls.at(-1)![0];
    const copies = input.regionsBase.history.flatMap((b) => b.items.filter((x) => x.id === item.id));
    expect(copies.length).toBeGreaterThan(0);
    for (const x of copies) expect(x.headline).toBe(WITHHELD_HEADLINE);
    // The publish CLI's full mode reads logs/D.regions-input.json: it holds the rewritten history too.
    for (const f of [`logs/${D}.regions-input.json`, `logs/${D}.context.json`]) {
      expect(fs.readFileSync(path.join(h.root, f), "utf8"), f).not.toContain(item.headline);
    }
    expect(h.remoteFile(`content/briefs/${D}.json`)).not.toContain(item.headline);
    expect(validateAll(path.join(h.root, "content"), { config: loadCheckedConfig({ root: h.root }) }).errors).toEqual([]);
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

  it("D16 a 10:58 start with reject-briefs: the data-only stage fails with E_DATA_ONLY and only status: commits land", async () => {
    const h = harness({ start: "10:58" });
    okAgent(h);
    h.pushes("reject-briefs");
    expect(await run(h, ["--trigger", "schedule"])).toBe(1);
    const s = subjects(h);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatch(/ started$/);
    expect(s[1]).toMatch(/ ended: failed$/);
    for (const x of s) expect(x).toMatch(/^status: /);
    expect(briefOn(h)).toBeNull();
    const r = statusOn(h)!.runs;
    expect(r).toHaveLength(1);
    expect(r[0]!.outcome).toBe("failed");
    expect(r[0]!.error_code).toBe("E_DATA_ONLY");
    expect(stageOf(r[0]!, "data_only")).toMatchObject({ status: "failed", note: "Data-only edition not published." });
    expect(stageOf(r[0]!, "recheck")).toMatchObject({ status: "skipped", note: "Not run: under 6 minutes left before 11:00." });
    for (const st of ["draft", "validate", "publish"]) expect(stageOf(r[0]!, st).note).toBe("Started after 05:30: no editorial pass today.");
    expect(h.agentCalls()).toEqual([]);
    const lines = summary(h).split("\n");
    expect(lines[0]).toBe(`**CyberTracker ${D} · failed** (E_DATA_ONLY)`);
    // Not E_PUBLISH's lines: no draft exists, so publish's full mode is never the next step.
    expect(lines).toContain("What happened: The data-only edition could not be composed, validated or pushed, and no full edition followed.");
    expect(summary(h)).not.toContain("npm run publish");
    expect(runsJsonl(h)).toMatchObject([{ outcome: "failed", error_code: "E_DATA_ONLY" }]);
    expect(h.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(h.git("rev-parse", "HEAD")).toBe(h.remoteLog().at(-1)!.sha);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D39 a start at 10:59:57 whose start record lands after 11:00: the data-only stage is skipped as too late, E_TOO_LATE, exit 1", async () => {
    const h = harness({ start: "10:59" });
    okAgent(h);
    h.pushes({ slowSeconds: 4 });
    h.clock.set(at(D, "10:59") + 57_000);
    expect(await run(h, ["--trigger", "manual"])).toBe(1);
    const s = subjects(h);
    expect(s).toEqual([expect.stringMatching(/ started$/), expect.stringMatching(/ ended: failed$/)]);
    const r = statusOn(h)!.runs;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ outcome: "failed", error_code: "E_TOO_LATE" });
    expect(stageOf(r[0]!, "data_only")).toMatchObject({ status: "skipped", note: "Too late: nothing is published after 11:00." });
    const lines = summary(h).split("\n");
    expect(lines[0]).toBe(`**CyberTracker ${D} · failed** (E_TOO_LATE)`);
    expect(lines).toContain("Next step: nothing: nothing is published after 11:00; the next morning's run will publish");
    expect(summary(h)).not.toContain("unexpected error");
    expect(briefOn(h)).toBeNull();
    expect(h.agentCalls()).toEqual([]);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D17 --dry-run on a feature branch with an uncommitted file: no commit or branch change, exit 0, the copy and its mirror", async () => {
    const h = harness();
    okAgent(h);
    h.git("checkout", "-q", "-b", "feature");
    const head = h.git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(h.root, "notes.txt"), "an uncommitted file\n");
    expect(await run(h, ["--dry-run"])).toBe(0);
    expect(h.remoteLog()).toEqual([]);
    expect(h.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
    expect(h.git("rev-parse", "HEAD")).toBe(head);
    expect(h.git("status", "--porcelain")).toBe("?? notes.txt");
    expect(fs.existsSync(path.join(h.root, "content", "briefs"))).toBe(false);
    const P = runPaths(h.root, D);
    const mirror = fs.readFileSync(P.statusMirror, "utf8");
    expect(fs.readFileSync(path.join(P.dryRunCopy, "status", `${D}.json`), "utf8")).toBe(mirror);
    const runs = StatusFile.parse(JSON.parse(mirror)).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "dry_run", outcome: "dry_run", error_code: null, edition: "full" });
    expect(stageOf(runs[0]!, "preflight").note).toContain("Dry run: the branch and uncommitted files were left as they were.");
    for (const st of ["deploy", "links"]) expect(stageOf(runs[0]!, st)).toMatchObject({ status: "skipped", note: "Not run in a dry run." });
    const b = Brief.parse(JSON.parse(fs.readFileSync(path.join(P.dryRunCopy, "briefs", `${D}.json`), "utf8")));
    expect(b.edition).toBe("full");
    expect(b.data_only_published_at).not.toBeNull();
    expect(b.data_only_published_at).toBe(runs[0]!.data_only_published_at);
    const config = loadCheckedConfig({ root: h.root });
    expect(validateAll(P.dryRunCopy, { publishing: D, config }).errors).toEqual([]);
    expect(dailyLog(h)).toContain(`Dry run complete: drafts/${D}.json is valid.`);
    expect(summary(h).split("\n")[0]).toBe(`**CyberTracker ${D} · dry run (full edition)**`);
    expect(runsJsonl(h)).toMatchObject([{ trigger: "dry_run", outcome: "dry_run" }]);
    expect(fs.existsSync(P.needsReview)).toBe(false);
  }, TIMEOUT);

  it("D47 --dry-run that ends E_VALIDATION: the summary's next step names the dry run's files, with no rerun command or needs-review path", async () => {
    // Kobol dry run 2026-11-11: the summary said "rerun before 10:00: zsh .../daily.sh --no-deadline; the draft is
    // in needs-review/2026-11-11/", and a dry run writes no needs-review folder.
    const h = harness();
    h.fakeAgent({ mode: "repair", invalidDraft: INVALID, repair: INVALID, fetches: FETCHES });
    expect(await run(h, ["--dry-run"])).toBe(0);
    expect(h.remoteLog()).toEqual([]);
    const P = runPaths(h.root, D);
    const runs = StatusFile.parse(JSON.parse(fs.readFileSync(P.statusMirror, "utf8"))).runs;
    expect(runs.at(-1)).toMatchObject({ outcome: "dry_run", error_code: "E_VALIDATION", edition: "data_only" });
    const text = summary(h);
    const lines = text.split("\n");
    expect(lines[0]).toBe(`**CyberTracker ${D} · dry run (data-only edition)** (E_VALIDATION)`);
    expect(lines).toContain(`Next step: this was a dry run, so nothing needs rerunning: what it wrote is in logs/${D}.daily.log, drafts/${D}.json, logs/${D}.validation.json and logs/dry-run/${D}/`);
    expect(lines).toContain(`Dry run: nothing was published; files in logs/dry-run/${D}/`);
    expect(text).not.toMatch(/needs-review|zsh |--no-deadline|npm run publish|rerun before/);
    // The files it names are there, and the folder it no longer names is not.
    for (const f of [P.draft, P.validation, P.dryRunCopy]) expect(fs.existsSync(f), f).toBe(true);
    expect(fs.existsSync(P.needsReview)).toBe(false);
  }, TIMEOUT);

  it("D35 --dry-run that fails at preflight step 4 (no network): exit 0, outcome dry_run with E_NET, the dry-run failed chat format", async () => {
    const h = harness();
    okAgent(h);
    const offline = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://github.com")) throw new TypeError("fetch failed");
      return h.deps.fetchImpl(input, init);
    }) as typeof fetch;
    expect(await run(h, ["--dry-run"], { fetchImpl: offline })).toBe(0);
    expect(h.remoteLog()).toEqual([]);
    const lines = summary(h).split("\n");
    expect(lines[0]).toBe(`**CyberTracker ${D} · dry run (failed)** (E_NET)`);
    expect(lines).toContain("Dry run: nothing was published.");
    expect(lines.some((l) => l.startsWith("Site shows"))).toBe(false);
    expect(runsJsonl(h)).toMatchObject([{ trigger: "dry_run", outcome: "dry_run", error_code: "E_NET" }]);
    expect(dailyLog(h).trimEnd().split("\n").at(-1)).toMatch(/ Run ended: dry_run\.$/);
    expect(fs.existsSync(path.join(h.root, "needs-review", D))).toBe(false);
    expect(agentRuns(h)).toEqual([]);
  }, TIMEOUT);

  it("D18 --dry-run --simulate-failure: exit 0, dry_run, E_SIMULATED, the dry-run data-only chat format", async () => {
    const h = harness();
    okAgent(h);
    expect(await run(h, ["--dry-run", "--simulate-failure"])).toBe(0);
    expect(h.remoteLog()).toEqual([]);
    const P = runPaths(h.root, D);
    const runs = StatusFile.parse(JSON.parse(fs.readFileSync(P.statusMirror, "utf8"))).runs;
    expect(runs.at(-1)).toMatchObject({ trigger: "dry_run", outcome: "dry_run", error_code: "E_SIMULATED", edition: "data_only" });
    expect(stageOf(runs.at(-1)!, "validate")).toMatchObject({ status: "failed", note: "Simulated failure (--simulate-failure)." });
    const lines = summary(h).split("\n");
    expect(lines[0]).toBe(`**CyberTracker ${D} · dry run (data-only edition)** (E_SIMULATED)`);
    expect(lines).toContain(`Dry run: nothing was published; files in logs/dry-run/${D}/`);
    const b = Brief.parse(JSON.parse(fs.readFileSync(path.join(P.dryRunCopy, "briefs", `${D}.json`), "utf8")));
    expect(b.edition).toBe("data_only");
    expect(validateAll(P.dryRunCopy, { publishing: D, config: loadCheckedConfig({ root: h.root }) }).errors).toEqual([]);
    expect(fs.existsSync(P.needsReview)).toBe(false);
  }, TIMEOUT);

  it("D19 a code commit on GitHub's main: one restart, both notes logged, code_commit the new HEAD; the parent returns the child's code and writes nothing (A2)", async () => {
    const h = harness();
    okAgent(h);
    const sha = h.commitOnRemote({ "scripts/README.txt": "x\n" }, "code: test");
    const sha7 = sha.slice(0, 7);
    let restarts = 0;
    const deps: Deps = { ...h.deps };
    const restart = async (args: string[]) => {
      restarts += 1;
      process.env.CT_REEXEC = "1";
      try {
        return await main(args, { ...deps, restart: async () => { restarts += 1; return 99; } });
      } finally {
        delete process.env.CT_REEXEC;
      }
    };
    expect(await inRoot(h, () => main(["--trigger", "schedule"], { ...deps, restart }))).toBe(0);
    expect(restarts).toBe(1);
    const log = dailyLog(h);
    expect(log).toContain(`Restarting on the code synced from main (${sha7}).`);
    expect(log).toContain(`Restarted on the code synced from main (${sha7}).`);
    const ours = h.remoteLog().filter((c) => c.sha !== sha);
    expect(h.remoteLog()[0]!.sha).toBe(sha);
    expect(ours.map((c) => c.subject)).toHaveLength(4);
    expect(ours.filter((c) => / started$/.test(c.subject))).toHaveLength(1);
    expect(ours.filter((c) => / ended: /.test(c.subject))).toHaveLength(1);
    const runs = statusOn(h)!.runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.code_commit).toBe(sha);
    expect(runs[0]!.outcome).toBe("published_full");
    expect(stageOf(runs[0]!, "preflight").note).toContain(`Restarted on the code synced from main (${sha7}).`);
    expect(runsJsonl(h)).toHaveLength(1);
    expectContentOnly(h, [sha]);

    // The parent alone: it returns whatever the child returned and leaves no summary, runs.jsonl line, record or lock.
    const p = harness();
    okAgent(p);
    const psha = p.commitOnRemote({ "scripts/README.txt": "y\n" }, "code: test");
    expect(await inRoot(p, () => main(["--trigger", "schedule"], { ...p.deps, restart: async () => 42 }))).toBe(42);
    expect(p.remoteLog().map((c) => c.sha)).toEqual([psha]);
    expect(runsJsonl(p)).toEqual([]);
    expect(fs.existsSync(path.join(p.root, "logs", `${D}.summary.md`))).toBe(false);
    expect(fs.existsSync(path.join(p.root, "logs", ".lock"))).toBe(false);
    expect(dailyLog(p)).toContain(`Restarting on the code synced from main (${psha.slice(0, 7)}).`);
    expect(p.agentCalls()).toEqual([]);
  }, TIMEOUT);

  it("D20 off main with a clean tree: main is checked out and the run publishes", async () => {
    const h = harness();
    okAgent(h);
    h.git("checkout", "-q", "-b", "side");
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    expect(h.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(dailyLog(h)).toContain("Checked out main.");
    expect(subjects(h)).toHaveLength(4);
    expect(briefOn(h)!.edition).toBe("full");
    expectContentOnly(h);
  }, TIMEOUT);

  it("D21 a dirty path outside content/ gives E_GIT with no record and nothing pushed", async () => {
    const h = harness();
    okAgent(h);
    fs.appendFileSync(path.join(h.root, "scripts", "README.txt"), "a local edit\n");
    expect(await run(h, ["--trigger", "schedule"])).toBe(1);
    expect(h.remoteLog()).toEqual([]);
    expect(h.agentCalls()).toEqual([]);
    expect(h.git("status", "--porcelain")).toBe(" M scripts/README.txt");
    expect(summary(h).split("\n")[0]).toBe(`**CyberTracker ${D} · failed** (E_GIT)`);
    expect(runsJsonl(h)).toMatchObject([{ outcome: "failed", error_code: "E_GIT" }]);
    expect(dailyLog(h)).toContain("The working tree has changes outside content/: scripts/README.txt.");
    expect(fs.existsSync(path.join(h.root, "logs", ".lock"))).toBe(false);
  }, TIMEOUT);

  it("D22 files left under content/ are restored and noted, and the run publishes", async () => {
    const h = harness();
    okAgent(h);
    fs.appendFileSync(path.join(h.root, "content", "state", "days.json"), "\n");
    fs.writeFileSync(path.join(h.root, "content", "stray.json"), "{}\n");
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    expect(fs.existsSync(path.join(h.root, "content", "stray.json"))).toBe(false);
    expect(fs.readFileSync(path.join(h.root, "content", "state", "days.json"), "utf8")).toBe(h.remoteFile("content/state/days.json"));
    const r = statusOn(h)!.runs[0]!;
    expect(stageOf(r, "preflight").note).toContain("Restored content/ left by an earlier run.");
    expect(r.outcome).toBe("published_full");
    expect(subjects(h)).toHaveLength(4);
    expect(h.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expectContentOnly(h);
  }, TIMEOUT);

  it("D23 a stale node_modules/.ct-lock-sha: the Notes line warns and the run publishes", async () => {
    const h = harness();
    okAgent(h);
    h.writeLockSha(false);
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const r = statusOn(h)!.runs[0]!;
    expect(stageOf(r, "preflight").note).toContain("Dependencies changed since the last npm ci.");
    expect(r.outcome).toBe("published_full");
    const notes = summary(h).split("\n").find((l) => l.startsWith("Notes: "));
    expect(notes).toContain("Dependencies changed since the last npm ci");
    expectContentOnly(h);
  }, TIMEOUT);

  it("D24 a victim dispute served by the router: a correction: commit before the agent, the item withheld in the stored brief", async () => {
    // Morning one publishes the full edition; the dispute arrives that evening; morning two withholds the item.
    const h = harness();
    okAgent(h);
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const D2 = "2026-10-15";
    const ITEM = "inc-transport-jp-2026-10";
    h.issues([correctionIssue({ number: 4, itemId: ITEM, edition: D, option: DISPUTE_FORM_OPTIONS.victim, createdAt: "2026-10-14T13:00:00Z" })]);
    h.fakeAgent({ mode: "nodraft" });
    h.clock.set(at(D2, "04:37"));
    expect(await run(h, ["--trigger", "schedule"])).toBe(3);
    const s = subjects(h).slice(4);
    const withheld = s.indexOf(`correction: ${D2} · withheld ${ITEM}`);
    expect(withheld).toBeGreaterThan(0);
    expect(s.slice(0, 2)).toEqual([expect.stringMatching(new RegExp(`^status: ${D2} · run \\d{8}-\\d{6} started$`)), `brief: ${D2} · data-only edition`]);
    // The retry record opens only after attempt 1's agent ended: the withhold came before it.
    const retry = s.findIndex((x) => / retry \d{8}-\d{6} started$/.test(x));
    expect(retry).toBeGreaterThan(withheld);
    const stored = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
    const it = stored.items.find((x) => x.id === ITEM)!;
    expect(it.withheld).toEqual({ correction_id: "C-0001", since: D2 });
    expect(it.headline).toBe(WITHHELD_HEADLINE);
    for (const row of stored.regions.rows) if (row.item_ids.includes(ITEM)) expect(row.reason).toBe(WITHHELD_MARK);
    const cf = CorrectionsFile.parse(JSON.parse(h.remoteFile("content/corrections.json")!));
    expect(cf.corrections).toMatchObject([{ id: "C-0001", date: D2, item_id: ITEM, edition_date: D, type: "name_removed", trigger: "reader_report", dispute_id: "D-0001" }]);
    expect(cf.disputes).toMatchObject([{ id: "D-0001", issue_number: 4, item_id: ITEM, kind: "victim", correction_id: "C-0001" }]);
    // The context the agent read already held the withheld headline.
    const context = AgentContext.parse(JSON.parse(fs.readFileSync(path.join(h.root, "drafts", "context.json"), "utf8")));
    expect(context.date).toBe(D2);
    expect(context.recent_items.find((x) => x.id === ITEM)?.headline).toBe(WITHHELD_HEADLINE);
    const runs = StatusFile.parse(JSON.parse(h.remoteFile(`content/status/${D2}.json`)!)).runs;
    expect(stageOf(runs[0]!, "recheck").note).toContain("Withheld 1 item on reader disputes.");
    expect(h.requests().some((r) => r.method === "GET" && r.url.startsWith("https://api.github.com/repos/8gara8/CyberTracker/issues?"))).toBe(true);
    expect(validateAll(path.join(h.root, "content"), { config: loadCheckedConfig({ root: h.root }) }).errors).toEqual([]);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D27 an unpushed local brief: commit, then a run at 11:05: skipped, one status: commit lands, the brief commit gone and noted", async () => {
    const h = harness({ start: "11:05" });
    okAgent(h);
    localBriefCommit(h, D, siteBrief(D));
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const s = subjects(h);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatch(new RegExp(`^status: ${D} · run \\d{8}-\\d{6} ended: skipped$`));
    expect(briefOn(h)).toBeNull();
    expect(h.git("rev-list", "--count", "origin/main..HEAD")).toBe("0");
    expect(h.git("log", "--format=%s").split("\n").filter((x) => x.startsWith("brief: "))).toEqual([]);
    expect(fs.existsSync(path.join(h.root, "content", "briefs", `${D}.json`))).toBe(false);
    const r = statusOn(h)!.runs;
    expect(r).toHaveLength(1);
    expect(r[0]!.outcome).toBe("skipped");
    const note = stageOf(r[0]!, "preflight").note!;
    expect(note).toContain("Dropped 1 unpushed edition commit left by an earlier run.");
    expect(note).toContain("Too late: nothing is published after 11:00.");
    expect(h.agentCalls()).toEqual([]);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D27 an unpushed local brief: commit, then a run at 04:40: dropped, and the run publishes its own data-only edition", async () => {
    const h = harness({ start: "04:40" });
    okAgent(h);
    const local = localBriefCommit(h, D, siteBrief(D));
    expect(await run(h, ["--trigger", "schedule", "--data-only"])).toBe(3);
    const log = h.remoteLog();
    expect(log.map((c) => c.sha)).not.toContain(local);
    expect(log.map((c) => c.subject)).toEqual([
      expect.stringMatching(/ started$/), `brief: ${D} · data-only edition`, expect.stringMatching(/ ended: published_data_only$/),
    ]);
    const b = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
    expect(b.edition).toBe("data_only");
    expect(b.published_at).toMatch(new RegExp(`^${D}T04:4\\d:\\d\\d\\+08:00$`));
    expect(b.items.map((x) => x.id)).not.toEqual(siteBrief(D).items.map((x) => x.id));
    const r = statusOn(h)!.runs;
    expect(r).toHaveLength(1);
    expect(r[0]!.outcome).toBe("published_data_only");
    expect(stageOf(r[0]!, "preflight").note).toContain("Dropped 1 unpushed edition commit left by an earlier run.");
    expect(h.agentCalls()).toEqual([]);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D28 a local correction: under a local brief:, run at 11:05: GitHub gains a correction: withholding the same item and a status:, no brief:", async () => {
    const D2 = "2026-10-15";
    const ITEM = "inc-transport-jp-2026-10";
    const h = harness({ date: D2, start: "04:37", seed: (x) => { beforeEdition(x, D2); } });
    okAgent(h);
    // The earlier run's withhold, refused by GitHub and left local; then its data-only brief, never pushed.
    h.pushes("reject");
    const config = worldConfig(h);
    const cf = CorrectionsFile.parse(JSON.parse(fs.readFileSync(path.join(h.root, "content", "corrections.json"), "utf8")));
    await inRoot(h, async () => {
      await expect(publishWithholds({
        root: h.root, date: D2, deadline: h.clock() + 5_000, now: h.clock, dryRun: false, repo: h.remote, config,
        records: [testRecord(D2, `${D2}T04:37:02+08:00`)],
        requests: [{ item_id: ITEM, edition_date: D, kind: "victim", dispute_id: "D-0002", since: D2 }], disputes: [...cf.disputes, victimDispute()],
      })).rejects.toMatchObject({ code: "push" });
    });
    expect(h.git("log", "-1", "--format=%s")).toBe(`correction: ${D2} · withheld ${ITEM}`);
    localBriefCommit(h, D2, siteBrief(D2));
    h.pushes("accept");
    h.clock.set(at(D2, "11:05"));
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    const s = subjects(h);
    expect(s).toEqual([`correction: ${D2} · withheld ${ITEM}`, expect.stringMatching(new RegExp(`^status: ${D2} · run \\d{8}-\\d{6} ended: skipped$`))]);
    expect(s.filter((x) => x.startsWith("brief: "))).toEqual([]);
    expect(h.remoteFile(`content/briefs/${D2}.json`)).toBeNull();
    const remote = CorrectionsFile.parse(JSON.parse(h.remoteFile("content/corrections.json")!));
    const c = remote.corrections.find((x) => x.item_id === ITEM && x.type === "name_removed");
    expect(c).toMatchObject({ date: D2, edition_date: D, dispute_id: "D-0002", trigger: "reader_report" });
    const stored = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
    expect(stored.items.find((x) => x.id === ITEM)!.withheld).toEqual({ correction_id: c!.id, since: D2 });
    const r = StatusFile.parse(JSON.parse(h.remoteFile(`content/status/${D2}.json`)!)).runs;
    expect(r).toHaveLength(1);
    expect(r[0]!.outcome).toBe("skipped");
    const note = stageOf(r[0]!, "preflight").note!;
    expect(note).toContain("Dropped 2 unpushed edition commits left by an earlier run.");
    expect(note).toContain("Remade 1 withhold from the dropped commits.");
    expect(h.git("rev-list", "--count", "origin/main..HEAD")).toBe("0");
    expect(validateAll(path.join(h.root, "content"), { config }).errors).toEqual([]);
    expectContentOnly(h);
  }, TIMEOUT);

  it("D29 a lock held by a live pid: exit 0, no commit, logs/D.summary.md written only when absent", async () => {
    const h = harness();
    okAgent(h);
    const lock = path.join(h.root, "logs", ".lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const holder = JSON.stringify({ pid: process.pid, started: new Date(h.clock() - 60_000).toISOString() });
    fs.writeFileSync(lock, holder);
    const held = `CyberTracker ${D}: another run is in progress (started 04:36); nothing done.`;
    expect(await run(h, ["--trigger", "schedule"])).toBe(0);
    expect(summary(h)).toBe(`${held}\n`);
    expect(logSpy!.mock.calls.flat()).toContain(held);
    // A summary already there (the holder's) is left alone.
    fs.writeFileSync(path.join(h.root, "logs", `${D}.summary.md`), "the holder's summary\n");
    expect(await run(h, ["--trigger", "manual"])).toBe(0);
    expect(summary(h)).toBe("the holder's summary\n");
    expect(fs.readFileSync(lock, "utf8")).toBe(holder);
    expect(h.remoteLog()).toEqual([]);
    expect(h.agentCalls()).toEqual([]);
    expect(runsJsonl(h)).toEqual([]);
    expect(fs.existsSync(path.join(h.root, "packs"))).toBe(false);
  }, TIMEOUT);

  it("D30 runMetrics fails with nothing staged: E_METRICS, deploy skipped, links ran, exit 1, only status: commits (A19)", async () => {
    const h = harness();
    okAgent(h);
    vi.mocked(runMetrics).mockResolvedValueOnce({ code: 1, firstLine: "Metrics failed: SAMPLE.", lines: ["Metrics failed: SAMPLE."], wrote: [] });
    expect(await run(h, ["--trigger", "schedule"])).toBe(1);
    expect(vi.mocked(runMetrics)).toHaveBeenCalled();
    const s = subjects(h);
    expect(s).toHaveLength(2);
    for (const x of s) expect(x).toMatch(/^status: /);
    expect(s[1]).toMatch(/ ended: failed$/);
    const r = statusOn(h)!.runs;
    expect(r).toHaveLength(1);
    expect(r[0]!.outcome).toBe("failed");
    expect(r[0]!.error_code).toBe("E_METRICS");
    expect(stageOf(r[0]!, "metrics").status).toBe("failed");
    for (const st of ["data_only", "draft", "validate", "publish", "deploy"]) {
      expect(stageOf(r[0]!, st), st).toMatchObject({ status: "skipped", note: "Not run: no metrics file." });
    }
    expect(r[0]!.deploy.triggered).toBe(false);
    expect(stageOf(r[0]!, "recheck").status).toBe("ok");
    expect(stageOf(r[0]!, "links").status).toBe("ok");
    expect(r[0]!.links).not.toBeNull();
    expect(h.requests().some((x) => x.url === `${siteUrl()}/`)).toBe(false);
    expect(agentRuns(h)).toEqual([]);
    expect(briefOn(h)).toBeNull();
    expect(summary(h).split("\n")[0]).toBe(`**CyberTracker ${D} · failed** (E_METRICS)`);
    expect(fs.existsSync(path.join(h.root, "needs-review", D, `${D}.daily.log`))).toBe(true);
    expectContentOnly(h);
  }, TIMEOUT);
});
