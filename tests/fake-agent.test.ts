// The fake agent CLI (fixtures/agent/fake-claude.mjs) that every pipeline test stands on (plan §2.2,
// A14, A22; tests FA1 to FA5). It runs here as `node fake-claude.mjs ...`, with a temp config dir and a
// temp repo as its cwd; no network and no keychain.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AGENT_TOOLS, agentArgs, sandboxViolations } from "@/scripts/lib/agent";
import { parseTranscript } from "@/scripts/lib/transcript";
import { FAKE_CLAUDE, type AgentCall, type FakeAgentConfig } from "./helpers/harness";

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TOKEN = "fake-token-value-not-real-0001";
const PROMPT = "Write `drafts/2026-10-14.json` as the schema says, then reply DONE.";

// realpath: on macOS os.tmpdir() is a symlink into /private, and the fake agent reports real paths.
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ct-fake-agent-")));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
let worlds = 0;

/** A fresh config dir and repo. */
function world(cfg?: FakeAgentConfig) {
  const dir = path.join(base, `w${++worlds}`);
  const configDir = path.join(dir, "claude");
  const repo = path.join(dir, "repo");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  if (cfg) fs.writeFileSync(path.join(configDir, "fake-agent.json"), JSON.stringify(cfg));
  return {
    dir, configDir, repo,
    calls: (): AgentCall[] => fs.readFileSync(path.join(configDir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as AgentCall),
    draft: (rel = "drafts/2026-10-14.json") => {
      const f = path.join(repo, rel);
      return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as unknown) : undefined;
    },
  };
}

interface Called { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

/** Runs the fake with argv in cwd; onLine may return "kill" to end it with SIGTERM. */
function callFake(argv: string[], w: { configDir: string; repo: string } | null, onLine?: (line: string) => "kill" | void): Promise<Called> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_CODE_OAUTH_TOKEN: TOKEN, TZ: "Asia/Taipei" };
    if (w) env.CLAUDE_CONFIG_DIR = w.configDir;
    const child = spawn(process.execPath, [FAKE_CLAUDE, ...argv], { cwd: w?.repo ?? base, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      pending += chunk;
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (onLine?.(line) === "kill") child.kill("SIGTERM");
      }
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const draft = { schema_version: 1, date: "2026-10-14", items: [] };

describe("FA1: every mode yields the expected transcript", () => {
  it("FA1: ok: init, the fetches and searches, the Write, then DONE; the draft is written", async () => {
    const w = world({ mode: "ok", draft, fetches: ["https://example.org/ct-sample/a", "https://example.org/ct-sample/b"], searches: 1 });
    const r = await callFake(agentArgs(PROMPT, { sessionId: SID }), w);
    expect(r.code).toBe(0);
    const t = parseTranscript(r.stdout);
    expect(t.sessionId).toBe(SID);
    expect(t.version).toBe("2.1.316");
    expect(t.model).toBe("<model>");
    expect(t.tools).toEqual([...AGENT_TOOLS]);
    expect(sandboxViolations(t)).toEqual([]);
    expect(t.isError).toBe(false);
    expect(t.authFailed).toBe(false);
    expect(t.limitHit).toBe(false);
    expect(t.resultText).toBe("DONE");
    expect(t.terminalReason).toBe("completed");
    expect(t.toolUses).toEqual({ WebFetch: 2, WebSearch: 1, Write: 1 });
    expect(t.fetchedOk).toEqual(["https://example.org/ct-sample/a", "https://example.org/ct-sample/b"]);
    expect(t.searches).toEqual(["sample search 1"]);
    expect(t.calls.find((c) => c.name === "Write")?.input).toEqual({ file_path: path.join(w.repo, "drafts", "2026-10-14.json") });
    expect(t.numTurns).toBe(5);
    expect(t.usage).toEqual({ input: 1000, output: 200 });
    expect(t.permissionDenials).toBe(0);
    expect(w.draft()).toEqual(draft);
    expect(fs.readFileSync(path.join(w.repo, "drafts", "2026-10-14.json"), "utf8")).toBe(`${JSON.stringify(draft, null, 2)}\n`);
  });
  it("FA1: ok with no config at all: a clean run that writes nothing", async () => {
    const w = world();
    const t = parseTranscript((await callFake(agentArgs(PROMPT, { sessionId: SID }), w)).stdout);
    expect([t.isError, t.resultText, t.toolUses]).toEqual([false, "DONE", {}]);
    expect(w.draft()).toBeUndefined();
  });
  it("FA1: the smoke prompts get OK", async () => {
    const w = world({ mode: "ok" });
    for (const p of ["Reply with the single word OK.", "Reply OK.", "Reply OK"]) {
      expect(parseTranscript((await callFake(["-p", p, "--session-id", SID], w)).stdout).resultText, p).toBe("OK");
    }
    expect(parseTranscript((await callFake(["-p", "Reply OK. Then read a file.", "--session-id", SID], w)).stdout).resultText).toBe("DONE");
  });
  it("FA1: nodraft: a clean run with no Write", async () => {
    const w = world({ mode: "nodraft", draft });
    const r = await callFake(agentArgs(PROMPT, { sessionId: SID }), w);
    const t = parseTranscript(r.stdout);
    expect(r.code).toBe(0);
    expect([t.isError, t.resultText]).toEqual([false, "DONE"]);
    expect(t.toolUses.Write).toBeUndefined();
    expect(w.draft()).toBeUndefined();
  });
  it("FA1: auth: a sign-in failure that still exits 0", async () => {
    const w = world({ mode: "auth", draft });
    const r = await callFake(agentArgs(PROMPT, { sessionId: SID }), w);
    const t = parseTranscript(r.stdout);
    expect(r.code).toBe(0);
    expect(t.authFailed).toBe(true);
    expect(t.isError).toBe(true);
    expect(t.terminalReason).toBe("api_error");
    expect(t.toolUses).toEqual({});
    expect(w.draft()).toBeUndefined();
  });
  it("FA1: limit: a rejected five-hour window, an error result and exit 1", async () => {
    const w = world({ mode: "limit", draft });
    const r = await callFake(agentArgs(PROMPT, { sessionId: SID }), w);
    const t = parseTranscript(r.stdout);
    expect(r.code).toBe(1);
    expect(t.limitHit).toBe(true);
    expect(t.rateLimitUsage).toEqual({ window: "five_hour", utilization: 1 });
    expect(t.isError).toBe(true);
    expect(t.authFailed).toBe(false);
    expect(w.draft()).toBeUndefined();
  });
  it("FA1: mcp: init lists an MCP tool, then it waits until a signal ends it", async () => {
    const w = world({ mode: "mcp", draft });
    let initAt = 0;
    const r = await callFake(agentArgs(PROMPT, { sessionId: SID }), w, (line) => {
      if (line.includes('"init"')) {
        initAt = Date.now();
        return "kill";
      }
    });
    expect(initAt).toBeGreaterThan(0);
    expect(r.signal).toBe("SIGTERM");
    const t = parseTranscript(r.stdout);
    expect(t.tools).toContain("mcp__probe__x");
    expect(sandboxViolations(t)).toEqual(["unexpected tool mcp__probe__x", "an MCP tool is present"]);
    expect(t.isError).toBeNull();
    expect(w.draft()).toBeUndefined();
  }, 40_000);
  it("FA1: delayMs holds the result back", async () => {
    const w = world({ mode: "nodraft", delayMs: 400 });
    const t0 = Date.now();
    await callFake(["-p", "x", "--session-id", SID], w);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });
});

describe("FA2: calls.jsonl", () => {
  it("FA2: records each call's argv, environment names and cwd, never a value", async () => {
    const w = world({ mode: "nodraft" });
    const argv = agentArgs(PROMPT, { sessionId: SID });
    await callFake(argv, w);
    await callFake(["--version"], w);
    const calls = w.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.argv).toEqual(argv);
    expect(calls[1]!.argv).toEqual(["--version"]);
    for (const c of calls) {
      expect(c.envKeys).toEqual([...c.envKeys].sort());
      for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "PATH", "TZ"]) expect(c.envKeys).toContain(k);
      expect(fs.realpathSync(c.cwd)).toBe(fs.realpathSync(w.repo));
      expect(Object.keys(c).sort()).toEqual(["argv", "cwd", "envKeys"]);
    }
    const raw = fs.readFileSync(path.join(w.configDir, "calls.jsonl"), "utf8");
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain("Asia/Taipei");
  });
  it("FA2: writes nothing when CLAUDE_CONFIG_DIR is unset or missing", async () => {
    const r = await callFake(["-p", "x", "--session-id", SID], null);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(base, "calls.jsonl"))).toBe(false);
    const w = world();
    fs.rmSync(w.configDir, { recursive: true });
    await callFake(["-p", "x", "--session-id", SID], w);
    expect(fs.existsSync(w.configDir)).toBe(false);
  });
});

describe("FA3: --version", () => {
  it("FA3: prints the pinned version by default and exits 0", async () => {
    const r = await callFake(["--version"], world());
    expect([r.code, r.stdout]).toEqual([0, "2.1.316 (Claude Code)\n"]);
  });
  it("FA3: prints the configured version, which also goes into init", async () => {
    const w = world({ mode: "ok", version: "2.1.400 (Claude Code)" });
    expect((await callFake(["--version"], w)).stdout).toBe("2.1.400 (Claude Code)\n");
    expect(parseTranscript((await callFake(["-p", "x", "--session-id", SID], w)).stdout).version).toBe("2.1.400");
  });
  it("FA3: a prompt that says --version is still a prompt", async () => {
    const t = parseTranscript((await callFake(["-p", "--version", "--session-id", SID], world({ mode: "ok" }))).stdout);
    expect(t.resultText).toBe("DONE");
  });
});

describe("FA4: repair mode", () => {
  it("FA4: writes the invalid draft first, then the repaired one on --resume with the same session", async () => {
    const invalid = { schema_version: 1, date: "2026-10-14", items: "not a list" };
    const fixed = { ...draft, lead: "fixed" };
    const w = world({ mode: "repair", draft, invalidDraft: invalid, repair: fixed });
    const first = parseTranscript((await callFake(agentArgs(PROMPT, { sessionId: SID }), w)).stdout);
    expect(first.sessionId).toBe(SID);
    expect(w.draft()).toEqual(invalid);
    const second = parseTranscript((await callFake(agentArgs("Fix `drafts/2026-10-14.json`.", { resume: SID }), w)).stdout);
    expect(second.sessionId).toBe(SID);
    expect(second.isError).toBe(false);
    expect(w.draft()).toEqual(fixed);
    expect(w.calls().map((c) => c.argv.slice(2, 4))).toEqual([["--session-id", SID], ["--resume", SID]]);
  });
  it("FA4: without invalidDraft it writes draft first; ok mode writes draft again on --resume when no repair is set", async () => {
    const w = world({ mode: "repair", draft, repair: { fixed: true } });
    await callFake(agentArgs(PROMPT, { sessionId: SID }), w);
    expect(w.draft()).toEqual(draft);
    await callFake(agentArgs(PROMPT, { resume: SID }), w);
    expect(w.draft()).toEqual({ fixed: true });
    const ok = world({ mode: "ok", draft });
    await callFake(agentArgs(PROMPT, { resume: SID }), ok);
    expect(ok.draft()).toEqual(draft);
  });
  it("FA4: resumeMode sets the mode of --resume calls; attemptModes the mode of each --session-id call in turn", async () => {
    const invalid = { schema_version: 1, date: "2026-10-14", items: "not a list" };
    const w = world({ mode: "repair", resumeMode: "limit", invalidDraft: invalid, repair: draft });
    await callFake(agentArgs(PROMPT, { sessionId: SID }), w);
    expect(w.draft()).toEqual(invalid);
    const limited = await callFake(agentArgs(PROMPT, { resume: SID }), w);
    expect(limited.code).toBe(1);
    expect(parseTranscript(limited.stdout).limitHit).toBe(true);
    expect(w.draft()).toEqual(invalid);

    const a = world({ mode: "ok", attemptModes: ["repair", "nodraft"], invalidDraft: invalid, draft });
    await callFake(agentArgs(PROMPT, { sessionId: SID }), a);
    expect(a.draft()).toEqual(invalid);
    fs.rmSync(path.join(a.repo, "drafts"), { recursive: true });
    const second = parseTranscript((await callFake(agentArgs(PROMPT, { sessionId: SID }), a)).stdout);
    expect(second.toolUses.Write ?? 0).toBe(0);
    expect(a.draft()).toBeUndefined();
    // Past the list: mode.
    await callFake(agentArgs(PROMPT, { sessionId: SID }), a);
    expect(a.draft()).toEqual(draft);
  });
});

describe("FA6: resumeMode", () => {
  it("FA6: a --resume call takes resumeMode; the first call keeps mode", async () => {
    const w = world({ mode: "repair", draft, repair: { fixed: true }, resumeMode: "limit" });
    const first = parseTranscript((await callFake(agentArgs(PROMPT, { sessionId: SID }), w)).stdout);
    expect(first.isError).toBe(false);
    expect(w.draft()).toEqual(draft);
    const second = parseTranscript((await callFake(agentArgs(PROMPT, { resume: SID }), w)).stdout);
    expect(second.limitHit).toBe(true);
    expect(w.draft()).toEqual(draft);
    const auth = world({ mode: "ok", draft, resumeMode: "auth" });
    expect(parseTranscript((await callFake(agentArgs(PROMPT, { resume: SID }), auth)).stdout).authFailed).toBe(true);
  });
});

describe("FA5: touch and draftPath (plan A14, A22)", () => {
  it("FA5: creates every touch file, with its folders, before it writes the draft", async () => {
    const w = world();
    const markers = [path.join(w.dir, "reject-pushes"), path.join(w.dir, "deep", "er", "reject-briefs")];
    fs.writeFileSync(path.join(w.configDir, "fake-agent.json"), JSON.stringify({ mode: "ok", draft, fetches: ["https://example.org/ct-sample/a"], touch: markers } satisfies FakeAgentConfig));
    const seenAtWrite: boolean[] = [];
    const seenAtFetch: boolean[] = [];
    await callFake(agentArgs(PROMPT, { sessionId: SID }), w, (line) => {
      if (line.includes('"tool_use"') && line.includes('"Write"')) seenAtWrite.push(...markers.map((m) => fs.existsSync(m)));
      if (line.includes('"tool_use"') && line.includes('"WebFetch"')) seenAtFetch.push(markers.every((m) => fs.existsSync(m)));
    });
    expect(seenAtWrite).toEqual([true, true]);
    for (const m of markers) expect(fs.readFileSync(m, "utf8")).toBe("");
    expect(w.draft()).toEqual(draft);
    expect(seenAtFetch).toHaveLength(1);
  });
  it("FA5: touch runs even in nodraft mode, and not in auth, limit or mcp mode", async () => {
    const w = world();
    const m = path.join(w.dir, "marker-nodraft");
    fs.writeFileSync(path.join(w.configDir, "fake-agent.json"), JSON.stringify({ mode: "nodraft", touch: [m] }));
    await callFake(["-p", "x", "--session-id", SID], w);
    expect(fs.existsSync(m)).toBe(true);
    for (const mode of ["auth", "limit"] as const) {
      const n = path.join(w.dir, `marker-${mode}`);
      fs.writeFileSync(path.join(w.configDir, "fake-agent.json"), JSON.stringify({ mode, touch: [n] }));
      await callFake(["-p", "x", "--session-id", SID], w);
      expect(fs.existsSync(n), mode).toBe(false);
    }
  });
  it("FA5: draftPath replaces the path in the prompt, absolute or relative to the cwd", async () => {
    const w = world();
    const abs = path.join(w.repo, "drafts", "canary-abc123.json");
    fs.writeFileSync(path.join(w.configDir, "fake-agent.json"), JSON.stringify({ mode: "ok", draft, draftPath: abs }));
    const t = parseTranscript((await callFake(agentArgs(PROMPT, { sessionId: SID }), w)).stdout);
    expect(w.draft("drafts/canary-abc123.json")).toEqual(draft);
    expect(w.draft()).toBeUndefined();
    expect(t.calls.find((c) => c.name === "Write")?.input).toEqual({ file_path: abs });
    fs.writeFileSync(path.join(w.configDir, "fake-agent.json"), JSON.stringify({ mode: "ok", draft: { n: 2 }, draftPath: "drafts/canary-rel.json" }));
    await callFake(["-p", "no path named here", "--session-id", SID], w);
    expect(w.draft("drafts/canary-rel.json")).toEqual({ n: 2 });
  });
  it("FA5: without draftPath, a prompt that names no draft file gets no Write", async () => {
    const w = world({ mode: "ok", draft });
    const t = parseTranscript((await callFake(["-p", "Write `drafts/canary-x.json`.", "--session-id", SID], w)).stdout);
    expect(t.toolUses.Write).toBeUndefined();
    expect(fs.existsSync(path.join(w.repo, "drafts"))).toBe(false);
  });
});
