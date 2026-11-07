// npm run ops -- <command>: the ops task's command runner (SPEC §9.4). It maps one ops command to a
// script, runs it, writes logs/ops-latest.md (at most 60 lines) and pushes the outputs to a short-lived
// `ops/*` branch of the content repo through publish's ops mode. The ops task's prompt
// (routine/OPS.md) validates the command line before this runs.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { taipeiTimestamp } from "../lib/dates";
import { contentRemote, publishOps } from "./publish";
import { run } from "./lib/run";

export const OPS_COMMANDS = ["probe", "agent-check", "agent-check-passthrough", "sources", "backfill", "backfill-publish", "dry-run", "dry-run-fail", "tools"] as const;
export type OpsCommand = (typeof OPS_COMMANDS)[number];

const repo = process.cwd();
const MAX_LINES = 60;
const TIMEOUT_MS = 118 * 60_000;

export interface OpsPlan {
  /** The script and its arguments, or null when the command runs nothing here. */
  argv: string[] | null;
  /** The content-repo branch the outputs go to, or null for none. */
  branch: string | null;
  /** The phase that builds the script, when it is not in this checkout yet. */
  phase: string;
}

function stamp(now: Date): string {
  const t = taipeiTimestamp(now);
  return `${t.slice(0, 4)}${t.slice(5, 7)}${t.slice(8, 10)}-${t.slice(11, 13)}${t.slice(14, 16)}`;
}

/** The SPEC §9.4 table: what each command runs and where its outputs go. */
export function plan(command: OpsCommand, arg: string | undefined, now: Date, network: string): OpsPlan {
  const s = stamp(now);
  switch (command) {
    case "probe":
      return { argv: ["scripts/probe.ts", "--fired", "--network", network, "--hold-minutes", "112"], branch: `ops/probe-${s}`, phase: "P0" };
    case "agent-check":
      return { argv: ["scripts/agent-check.ts", "--all", "--network", network], branch: `ops/agent-check-${s}`, phase: "P0" };
    case "agent-check-passthrough":
      return { argv: ["scripts/agent-check.ts", "--find-passthrough"], branch: `ops/agent-check-passthrough-${s}`, phase: "P0" };
    case "sources":
      return { argv: ["scripts/collect.ts", "--check-feeds"], branch: `ops/sources-${s}`, phase: "P2" };
    case "backfill":
      return { argv: ["scripts/backfill.ts", "--commit", "67c39b124fe4a56018212b4e6f62bd078058e76c", "--cutoff", "2026-11-06", "--check-reference"], branch: `ops/backfill-${s}`, phase: "P2" };
    case "backfill-publish":
      return { argv: ["scripts/backfill.ts", "--push"], branch: null, phase: "P2" };
    case "dry-run":
      return { argv: ["scripts/daily.ts", "--dry-run", "--date", arg ?? "", "--no-deadline"], branch: "ops/dry-runs", phase: "P3" };
    case "dry-run-fail":
      return { argv: ["scripts/daily.ts", "--dry-run", "--date", arg ?? "", "--no-deadline", "--simulate-failure"], branch: "ops/dry-runs-fail", phase: "P3" };
    case "tools":
      return { argv: null, branch: null, phase: "P0" };
  }
}

export function parseCommand(args: string[]): { command: OpsCommand; arg?: string } | null {
  const [command, arg] = args;
  if (!command || !(OPS_COMMANDS as readonly string[]).includes(command)) return null;
  if ((command === "dry-run" || command === "dry-run-fail") && !/^\d{4}-\d{2}-\d{2}$/.test(arg ?? "")) return null;
  return { command: command as OpsCommand, arg };
}

function codeCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim().slice(0, 12);
  } catch {
    return "unknown";
  }
}

function codeBranch(): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * The ops-latest.md text, never more than 60 lines: header lines, then the report. A longer report keeps
 * its head (the probe and agent-check put their verdicts first) and its last lines, with a marker between.
 */
export function latestReport(o: { command: string; branch: string; commit: string; started: string; ended: string; exit: number | null; pushed: string; report: string }): string {
  const head = [
    `# CyberTracker ops: ${o.command}`,
    "",
    `Command ${o.command} · code branch ${o.branch} · code ${o.commit}`,
    `Started ${o.started} · ended ${o.ended} · exit ${o.exit ?? "none"}`,
    `Outputs: ${o.pushed}`,
    "",
  ];
  const body = o.report.trim().split("\n");
  const room = MAX_LINES - head.length;
  const TAIL = 6;
  const kept = body.length > room
    ? [...body.slice(0, room - TAIL - 1), "(more lines are in the ops branch report)", ...body.slice(body.length - TAIL)]
    : body;
  return [...head, ...kept].join("\n") + "\n";
}

async function main(): Promise<number> {
  const parsed = parseCommand(process.argv.slice(2));
  const logs = path.join(repo, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const latest = path.join(logs, "ops-latest.md");
  if (!parsed) {
    fs.writeFileSync(latest, "CyberTracker ops: no valid command.\n");
    console.error("CyberTracker ops: no valid command.");
    return 2;
  }
  const now = new Date();
  const started = taipeiTimestamp(now);
  const network = (() => {
    try { return String(JSON.parse(fs.readFileSync(path.join(repo, "config", "run.json"), "utf8")).network ?? "full"); } catch { return "full"; }
  })();
  const p = plan(parsed.command, parsed.arg, now, network);
  const base = { command: [parsed.command, parsed.arg].filter(Boolean).join(" "), branch: codeBranch(), commit: codeCommit(), started };

  if (!p.argv) {
    fs.writeFileSync(latest, latestReport({ ...base, ended: taipeiTimestamp(), exit: 0, pushed: "none", report: "Nothing to run: the session replies with its tool names." }));
    return 0;
  }
  if (!fs.existsSync(path.join(repo, p.argv[0]!))) {
    fs.writeFileSync(latest, latestReport({ ...base, ended: taipeiTimestamp(), exit: 1, pushed: "none", report: `${parsed.command} is not built in this checkout yet (SPEC §10 ${p.phase}).` }));
    return 1;
  }
  if (!p.branch) {
    fs.writeFileSync(latest, latestReport({ ...base, ended: taipeiTimestamp(), exit: 1, pushed: "none", report: `${parsed.command} publishes to main and arrives in ${p.phase}.` }));
    return 1;
  }

  const reportName = `${parsed.command}-${stamp(now)}`;
  const stage = path.join(logs, "ops-stage");
  const reportDir = path.join(stage, "ops-reports", reportName);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(reportDir, { recursive: true });
  const reportFile = path.join(reportDir, "report.md");
  const extra = parsed.command === "probe" ? ["--out", reportDir, "--branch", p.branch] : [];
  const tsx = path.join(repo, "node_modules", ".bin", "tsx");
  const r = await run(tsx, [...p.argv, ...extra], { cwd: repo, env: process.env, timeoutMs: TIMEOUT_MS, stdoutFile: path.join(logs, `ops-${reportName}.out`), stderrFile: path.join(logs, `ops-${reportName}.err`) });
  const out = fs.existsSync(path.join(logs, `ops-${reportName}.out`)) ? fs.readFileSync(path.join(logs, `ops-${reportName}.out`), "utf8") : "";
  // The probe writes its own report.md; other commands' stdout is the report. Stderr is never pushed.
  if (!fs.existsSync(reportFile)) fs.writeFileSync(reportFile, out || "(no output)\n");
  fs.writeFileSync(path.join(reportDir, "meta.json"), JSON.stringify({ ...base, ended: taipeiTimestamp(), exit: r.code, timed_out: r.timedOut }, null, 2) + "\n");

  let pushed: string;
  try {
    const res = await publishOps({ branch: p.branch, from: stage, command: parsed.command, remote: contentRemote(repo) });
    pushed = `${p.branch} at ${res.sha.slice(0, 12)}`;
  } catch (e) {
    pushed = `push to ${p.branch} failed (${(e as Error).message.split("\n")[0]!.slice(0, 120)})`;
  }
  const report = fs.readFileSync(reportFile, "utf8");
  fs.writeFileSync(latest, latestReport({ ...base, ended: taipeiTimestamp(), exit: r.code, pushed, report }));
  return r.code === 0 && pushed.startsWith(p.branch) ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) main().then((code) => { process.exitCode = code; }, (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
