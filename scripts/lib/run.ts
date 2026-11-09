import { spawn } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

// Child processes with a hard timeout. Each child gets its own process group, so a timeout kills
// everything it started, and its output can stream straight to a file. Copied from the Europe fork's
// scripts/lib/run.ts; adds the onLine hook the orchestrator's sandbox guard uses (SPEC §8.2, §8.13), and a
// per-call stdout limit: output past it is cut and flagged (`stdoutCut`), so a caller that parses it can
// refuse it. Output is kept as bytes and decoded once, so a character split across two reads stays whole.

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** True when onLine asked for the child to be stopped. */
  stopped: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** True when stdout ran past `maxStdoutBytes`: `stdout` then holds only its first `maxStdoutBytes` bytes. */
  stdoutCut: boolean;
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
  /** Bytes of stdout kept in memory (default KEEP_BYTES); past it the rest is dropped and `stdoutCut` set. */
  maxStdoutBytes?: number;
}

/** Bytes of stdout and stderr kept in memory unless a call asks for more. */
export const KEEP_BYTES = 1_000_000;

/** Keeps the first `max` bytes of a stream, as chunks, and whether more came. */
function keeper(max: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let cut = false;
  return {
    add(d: Buffer) {
      if (size >= max) {
        if (d.length) cut = true;
        return;
      }
      const room = max - size;
      if (d.length > room) cut = true;
      const part = d.length > room ? d.subarray(0, room) : d;
      chunks.push(part);
      size += part.length;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    get cut() {
      return cut;
    },
  };
}

export function run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv | undefined, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = opts.stdoutFile ? fs.createWriteStream(opts.stdoutFile, { flags: "a" }) : null;
    const err = opts.stderrFile ? fs.createWriteStream(opts.stderrFile, { flags: "a" }) : null;
    const stdout = keeper(opts.maxStdoutBytes ?? KEEP_BYTES);
    const stderr = keeper(KEEP_BYTES);
    let spawnError = "";
    const lineDecoder = new StringDecoder("utf8");
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
      if (!out) stdout.add(d);
      if (opts.onLine && !stopped) {
        const lines = (partial + lineDecoder.write(d)).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) if (opts.onLine(line) === "stop") { stop(); break; }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      err?.write(d);
      stderr.add(d);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), opts.killGraceMs ?? 10_000).unref();
    }, opts.timeoutMs);
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      partial += lineDecoder.end();
      if (opts.onLine && partial && !stopped) opts.onLine(partial);
      // Resolve once the output files are flushed, so callers can read them straight away.
      const streams = [out, err].filter((s) => s !== null);
      let open = streams.length;
      const done = () => resolve({
        code, signal, timedOut, stopped, durationMs: Date.now() - started, stdout: stdout.text(), stderr: stderr.text() + spawnError,
        stdoutCut: stdout.cut,
      });
      if (!open) done();
      for (const s of streams) s.end(() => { if (--open === 0) done(); });
    };
    child.on("error", (e) => {
      spawnError += String(e);
      finish(127, null);
    });
    child.on("close", finish);
  });
}
