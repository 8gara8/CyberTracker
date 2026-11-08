import { spawn } from "node:child_process";
import fs from "node:fs";

// Child processes with a hard timeout. Each child gets its own process group, so a timeout kills
// everything it started, and its output can stream straight to a file. Copied from the Europe fork's
// scripts/lib/run.ts; adds the onLine hook the orchestrator's sandbox guard uses (SPEC §8.2, §8.13).

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** True when onLine asked for the child to be stopped. */
  stopped: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  /** Append stdout here instead of keeping it in memory. */
  stdoutFile?: string;
  stderrFile?: string;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  /** Called with each complete stdout line. Returning "stop" kills the child at once. */
  onLine?: (line: string) => void | "stop";
}

const KEEP = 1_000_000; // characters of stdout/stderr kept in memory

export function run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv | undefined, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = opts.stdoutFile ? fs.createWriteStream(opts.stdoutFile, { flags: "a" }) : null;
    const err = opts.stderrFile ? fs.createWriteStream(opts.stderrFile, { flags: "a" }) : null;
    let stdout = "";
    let stderr = "";
    let partial = "";
    let timedOut = false;
    let stopped = false;
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already gone */ }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), opts.killGraceMs ?? 10_000).unref();
    };
    child.stdout.on("data", (d: Buffer) => {
      out?.write(d);
      if (!out && stdout.length < KEEP) stdout += d.toString();
      if (opts.onLine && !stopped) {
        const lines = (partial + d.toString()).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) if (opts.onLine(line) === "stop") { stop(); break; }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      err?.write(d);
      if (stderr.length < KEEP) stderr += d.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), opts.killGraceMs ?? 10_000).unref();
    }, opts.timeoutMs);
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (opts.onLine && partial && !stopped) opts.onLine(partial);
      // Resolve once the output files are flushed, so callers can read them straight away.
      const streams = [out, err].filter((s) => s !== null);
      let open = streams.length;
      const done = () => resolve({ code, signal, timedOut, stopped, durationMs: Date.now() - started, stdout, stderr });
      if (!open) done();
      for (const s of streams) s.end(() => { if (--open === 0) done(); });
    };
    child.on("error", (e) => {
      stderr += String(e);
      finish(127, null);
    });
    child.on("close", finish);
  });
}
