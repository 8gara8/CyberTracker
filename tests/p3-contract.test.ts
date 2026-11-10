// The P3 contract (step S0, plan §1 "S0"): every module the lanes fill loads, the limits SPEC.md states
// keep their values, and every run-log line (scripts/lib/run-lines.ts, amendment A4) reads as the spec
// prints it (RL1). The functions themselves are tested by their owners' files; the integration lane adds
// the check that no "P3 stub" string is left.
import { describe, expect, it } from "vitest";
import { CONTEXT_LINE_MAX, CONTEXT_MAX_BYTES, ContextTooLarge } from "@/lib/context";
import { HTML_TEXT_MAX } from "@/lib/html-text";
import { MIN, P3_LIMITS } from "@/scripts/lib/clock";
import { KEYCHAIN_SERVICE } from "@/scripts/lib/keychain";
import { LINES } from "@/scripts/lib/run-lines";
import { SNAPSHOT_HEADERS, SNAPSHOT_LIMITS } from "@/scripts/lib/snapshot";
import { PreflightFail } from "@/scripts/preflight";
import { PublishError } from "@/scripts/publish";
import { LINKS_LIMITS } from "@/scripts/recheck";

const MODULES = [
  // Written in full by S0.
  "@/scripts/lib/clock", "@/scripts/lib/paths", "@/lib/run-inputs", "@/lib/html-text", "@/scripts/lib/run-lines",
  // Stubbed by S0, filled by their lanes.
  "@/scripts/lib/keychain", "@/scripts/lib/agent", "@/lib/apply", "@/lib/data-only", "@/lib/withhold", "@/lib/context",
  "@/scripts/build-context", "@/scripts/lib/snapshot", "@/scripts/lib/evidence", "@/scripts/lib/cve-fetch",
  "@/scripts/lib/validate-loop", "@/scripts/publish", "@/scripts/lib/cve-facts", "@/scripts/recheck", "@/scripts/lib/status",
  "@/scripts/lib/deploy", "@/scripts/preflight", "@/scripts/lib/prune",
  // Existing files that change in P3.
  "@/scripts/lib/transcript", "@/scripts/lib/git", "@/scripts/agent-check", "@/scripts/backfill", "@/lib/chat", "@/lib/feeds/http",
] as const;

describe("the P3 contract", () => {
  it.each(MODULES)("PC1: %s loads", async (m) => {
    await expect(import(/* @vite-ignore */ m)).resolves.toBeTypeOf("object");
  }, 60_000);

  it("PC2: P3_LIMITS keeps §8.2's TIMEOUTS and the plan's fixed limits", () => {
    expect(MIN).toBe(60_000);
    expect(P3_LIMITS).toEqual({
      gitMs: 60_000,
      collectMs: 300_000,
      metricsMs: 180_000,
      snapshotRoundMs: 180_000,
      snapshotReserveMs: 240_000,
      repairMaxMs: 360_000,
      repairFloorMs: 120_000,
      publishReserveMs: 240_000,
      agentMinMs: 600_000,
      agentMaxMs: 1_800_000,
      agentReserveMs: 600_000,
      contextReserveMs: 300_000,
      deployPollMs: 20_000,
      deployGetMs: 15_000,
      deployReserveMs: 90_000,
      linksMs: 180_000,
      linksMinLeftMs: 360_000,
      dataOnlyPublishMs: 180_000,
      publishFullMarginMs: 30_000,
      finalCommitMs: 60_000,
      lockStaleMs: 7_200_000,
      watchdogGraceMs: 120_000,
      watchdogLateStartMs: 600_000,
      noDeadlineMs: 4_500_000,
      noDeadlineRetryGapMs: 3_000_000,
      cliVersionMs: 30_000,
      keychainMs: 10_000,
      netProbeMs: 10_000,
      lsRemoteMs: 30_000,
      killGraceMs: 10_000,
      confirmMs: 15_000,
    });
  });

  it("PC3: the snapshot, context, link-check and keychain constants keep their values", () => {
    expect(SNAPSHOT_LIMITS).toEqual({ timeoutMs: 15_000, redirects: 5, maxBytes: 3 * 1024 * 1024, concurrency: 6, roundMs: 180_000 });
    expect(SNAPSHOT_HEADERS).toEqual({ accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", acceptLanguage: "en-US,en;q=0.9" });
    expect(CONTEXT_MAX_BYTES).toBe(256_000);
    expect(CONTEXT_LINE_MAX).toBe(1000);
    expect(HTML_TEXT_MAX).toBe(200_000);
    expect(LINKS_LIMITS).toEqual({ maxUrls: 300, concurrency: 8, roundMs: 180_000, minLeftMs: 360_000 });
    expect(KEYCHAIN_SERVICE).toBe("cybertracker-claude-oauth");
  });

  it("PC4: the error classes carry their codes and names", () => {
    const pf = new PreflightFail("E_GIT", "The checkout is not on main.");
    expect(pf).toBeInstanceOf(Error);
    expect([pf.name, pf.code, pf.message]).toEqual(["PreflightFail", "E_GIT", "The checkout is not on main."]);
    const pe = new PublishError("push");
    expect(pe).toBeInstanceOf(Error);
    expect([pe.name, pe.code, pe.message, pe.codes]).toEqual(["PublishError", "push", "push", []]);
    const big = new ContextTooLarge(300_000);
    expect(big).toBeInstanceOf(Error);
    expect([big.name, big.bytes]).toEqual(["ContextTooLarge", 300_000]);
  });
});

describe("the run-log lines (RL1)", () => {
  it("RL1: the first line, scheduled, manual and dry run (the CLI trigger, not dry_run)", () => {
    const base = { date: "2026-10-14", cutoffUtc: "2026-10-13", hardStop: "05:30", retryCutoff: "05:00" };
    expect(LINES.first({ ...base, trigger: "schedule", dryRun: false }))
      .toBe("CyberTracker daily run for 2026-10-14 (schedule); data to 2026-10-13 UTC; hard stop 05:30; retry cutoff 05:00.");
    expect(LINES.first({ ...base, trigger: "manual", dryRun: false }))
      .toBe("CyberTracker daily run for 2026-10-14 (manual); data to 2026-10-13 UTC; hard stop 05:30; retry cutoff 05:00.");
    expect(LINES.first({ ...base, trigger: "manual", dryRun: true }))
      .toBe("CyberTracker daily run for 2026-10-14 (manual) (dry run); data to 2026-10-13 UTC; hard stop 05:30; retry cutoff 05:00.");
    expect(LINES.first({ ...base, trigger: "manual", dryRun: true })).not.toContain("dry_run");
  });

  it("RL1: the CLI version line", () => {
    expect(LINES.cli("2.1.316 (Claude Code)")).toBe("Agent CLI 2.1.316 (Claude Code).");
  });

  it("RL1: the agent line, exited, timed out, stopped and with an error", () => {
    const o = { attempt: 1, exitCode: 0, timedOutMin: null, turns: 23, tools: { WebSearch: 4, WebFetch: 12, Read: 3, Write: 1 }, fetches: 12, budget: 40, isError: false };
    expect(LINES.agent(o))
      .toBe('Attempt 1: agent exited 0 · 23 turns · tools {"WebSearch":4,"WebFetch":12,"Read":3,"Write":1} · fetches 12/40.');
    expect(LINES.agent({ ...o, attempt: 2, timedOutMin: 30, exitCode: null }))
      .toBe('Attempt 2: timed out after 30 min · 23 turns · tools {"WebSearch":4,"WebFetch":12,"Read":3,"Write":1} · fetches 12/40.');
    expect(LINES.agent({ ...o, exitCode: 1, isError: true }))
      .toBe('Attempt 1: agent exited 1 · 23 turns · tools {"WebSearch":4,"WebFetch":12,"Read":3,"Write":1} · fetches 12/40 · reported an error.');
    expect(LINES.agent({ ...o, exitCode: null, turns: 1, tools: {}, fetches: 0 }))
      .toBe("Attempt 1: agent was stopped · 1 turn · tools {} · fetches 0/40.");
  });

  it("RL1: no draft, validation and repair lines", () => {
    expect(LINES.noDraft(2)).toBe("Attempt 2: no draft was written.");
    expect(LINES.validation(1, 3, 2, 1)).toBe("Attempt 1: 3 errors, 2 warnings (1 snapshot).");
    expect(LINES.validation(1, 1, 1, 0)).toBe("Attempt 1: 1 error, 1 warning (0 snapshot).");
    expect(LINES.validation(1, 0, 0, 0)).toBe("Attempt 1: 0 errors, 0 warnings (0 snapshot).");
    expect(LINES.repair(1, 1, 2, 3, ["CVE_PUBLISHED", "SNAP_UNSEEN", "CVE_PUBLISHED"]))
      .toBe("Attempt 1: repair 1 for 2 errors and 3 snapshot warnings (CVE_PUBLISHED, SNAP_UNSEEN).");
    expect(LINES.repair(2, 2, 1, 1, ["SCHEMA"])).toBe("Attempt 2: repair 2 for 1 error and 1 snapshot warning (SCHEMA).");
    expect(LINES.repair(1, 1, 0, 0, [])).toBe("Attempt 1: repair 1 for 0 errors and 0 snapshot warnings.");
  });

  it("RL1: the three no-retry reasons", () => {
    expect(LINES.noRetry("cutoff", "05:00")).toBe("No retry: it is past the retry cutoff (05:00).");
    expect(LINES.noRetry("not_retryable", "05:00")).toBe("No retry: the error is not retryable.");
    expect(LINES.noRetry("too_little_time", "05:00")).toBe("No retry: too little time.");
  });

  it("RL1: dry run, publish, restart, watchdog and end lines", () => {
    expect(LINES.dryRunComplete("2026-10-14")).toBe("Dry run complete: drafts/2026-10-14.json is valid.");
    expect(LINES.fullPublished("05:12", "a1b2c3d")).toBe("Full edition published at 05:12 (a1b2c3d).");
    expect(LINES.restarting("a1b2c3d")).toBe("Restarting on the code synced from main (a1b2c3d).");
    expect(LINES.watchdog("05:32")).toBe("Watchdog: the run passed 05:32; ending.");
    expect(LINES.runEnded("published_full")).toBe("Run ended: published_full.");
    expect(LINES.runEnded("dry_run")).toBe("Run ended: dry_run.");
  });

  it("RL1: every line is one line, ends with a full stop and has no em-dash", () => {
    const lines = [
      LINES.first({ date: "2026-10-14", trigger: "schedule", dryRun: true, cutoffUtc: "2026-10-13", hardStop: "05:30", retryCutoff: "05:00" }),
      LINES.cli("2.1.316"),
      LINES.agent({ attempt: 1, exitCode: 0, timedOutMin: null, turns: 2, tools: { Read: 1 }, fetches: 0, budget: 40, isError: true }),
      LINES.noDraft(1), LINES.validation(1, 2, 2, 2), LINES.repair(1, 1, 1, 0, ["X"]), LINES.noRetry("cutoff", "05:00"),
      LINES.dryRunComplete("2026-10-14"), LINES.fullPublished("05:12", "a1b2c3d"), LINES.restarting("a1b2c3d"),
      LINES.watchdog("05:32"), LINES.runEnded("failed"),
    ];
    expect(Object.keys(LINES)).toHaveLength(lines.length);
    for (const l of lines) {
      expect(l).toMatch(/\.$/);
      expect(l).not.toMatch(/[\n—]/);
    }
  });
});
