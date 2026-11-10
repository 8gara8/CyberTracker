// The drafting agent's harness and sandbox, pinned (SPEC §9.4, §9.5, §8.13; plan §2.2, tests A1 to A9).
// This file and no-europe-strings.test.ts are the two allowed to name the strings the scan forbids,
// because they assert their absence. No test here reads the keychain or starts the real CLI: the agent
// is fixtures/agent/fake-claude.mjs behind a #!/bin/sh wrapper, and readSecret always gets its binary
// injected.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { BLOCKED_HOSTS, blockedHostEntries } from "@/lib/vocab";
import {
  AGENT_ALLOWED, AGENT_DISALLOWED, AGENT_ENV_KEYS, AGENT_PATH, AGENT_SETTINGS, AGENT_TOOLS, DEFAULT_CLAUDE_BIN, DEFAULT_CLAUDE_CONFIG_DIR,
  agentArgs, agentConfig, agentEnv, cliVersion, fetchBudgetLeft, runAgent, sandboxViolations, type AgentConfig,
} from "@/scripts/lib/agent";
import { KEYCHAIN_SERVICE, readSecret } from "@/scripts/lib/keychain";
import { parseTranscript } from "@/scripts/lib/transcript";
import { FAKE_CLAUDE, type FakeAgentConfig } from "./helpers/harness";

const root = path.join(__dirname, "..");
const settings = JSON.parse(fs.readFileSync(path.join(root, AGENT_SETTINGS), "utf8")) as {
  permissions: { defaultMode: string; allow: string[]; deny: string[] };
  disableAllHooks: boolean;
  env: Record<string, string>;
};
const SID = "11111111-2222-3333-4444-555555555555";

/** A temp world: a wrapper at bin/claude that execs this Node on the fake, a config dir and a repo. */
function fakeWorld() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ct-agent-test-"));
  const bin = path.join(base, "bin", "claude");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o755 });
  const configDir = path.join(base, "claude");
  fs.mkdirSync(configDir, { mode: 0o700 });
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  const cfg: AgentConfig = { bin, configDir, repo, token: "test-token-value-0001" };
  return {
    base, bin, cfg,
    fake: (c: FakeAgentConfig) => fs.writeFileSync(path.join(configDir, "fake-agent.json"), JSON.stringify(c)),
    calls: () => fs.readFileSync(path.join(configDir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; envKeys: string[]; cwd: string }),
    dispose: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

/** Names the shell and macOS add to every process, even with an empty environment (seen on Kobol). */
const OS_ADDED = new Set(["PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"]);

describe("A1: agentArgs (SPEC §9.4)", () => {
  const args = agentArgs("PROMPT", { sessionId: SID });

  it("A1: is exactly the pinned list, prompt first, with --session-id", () => {
    expect(args).toEqual([
      "-p", "PROMPT",
      "--session-id", SID,
      "--output-format", "stream-json",
      "--verbose",
      "--restricted",
      "--safe-mode",
      "--disable-slash-commands",
      "--tools", "WebSearch,WebFetch,Read,Glob,Grep,Write,Edit",
      "--settings", "routine/agent-settings.json",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--permission-mode", "dontAsk",
      "--permission-prompts", "none",
      "--allowedTools", "WebSearch", "WebFetch", "Read", "Glob", "Grep", "Write(drafts/**)", "Edit(drafts/**)",
      "--disallowedTools", "Bash", "Agent", "Task", "NotebookEdit",
    ]);
    expect(args[args.length - 4]).toBe("Bash");
  });
  it("A1: a repair has the same flags with --resume in place of --session-id", () => {
    const r = agentArgs("P", { resume: SID });
    expect(r.slice(0, 4)).toEqual(["-p", "P", "--resume", SID]);
    expect(r).not.toContain("--session-id");
    expect(r.slice(4)).toEqual(args.slice(4));
  });
  it("A1: never names a model, a bypass mode, skipped permissions, --bare or --add-dir", () => {
    for (const a of [args, agentArgs("P", { resume: SID })]) {
      expect(a.join(" ")).not.toMatch(/--model\b|--fallback-model\b|bypassPermissions|--dangerously|--bare\b|--add-dir/);
    }
  });
  it("A1: every flag is in the pinned CLI's help (2.1.316, captured in P3)", () => {
    const flags = [...new Set(args.filter((a) => a.startsWith("-")))];
    expect(flags).toEqual([
      "-p", "--session-id", "--output-format", "--verbose", "--restricted", "--safe-mode", "--disable-slash-commands", "--tools",
      "--settings", "--strict-mcp-config", "--mcp-config", "--permission-mode", "--permission-prompts", "--allowedTools", "--disallowedTools",
    ]);
  });
});

describe("A2: the agent's environment (SPEC §9.4)", () => {
  it("A2: agentEnv has exactly the seven keys, the fixed PATH and the token only as CLAUDE_CODE_OAUTH_TOKEN", () => {
    const env = agentEnv({ configDir: "/c/claude", token: "tok-123456789" });
    expect(Object.keys(env)).toEqual([...AGENT_ENV_KEYS]);
    expect(env).toEqual({
      HOME: os.homedir(), PATH: "/opt/homebrew/bin:/usr/bin:/bin", TZ: "Asia/Taipei", LANG: "en_US.UTF-8",
      CLAUDE_CONFIG_DIR: "/c/claude", CLAUDE_CODE_OAUTH_TOKEN: "tok-123456789", DISABLE_AUTOUPDATER: "1",
    });
    expect(AGENT_PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(Object.entries(env).filter(([, v]) => v.includes("tok-123456789")).map(([k]) => k)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });
  it("A2: is built from nothing: no session variable, proxy or GitHub credential gets through", () => {
    const before = { ...process.env };
    process.env.GH_TOKEN = "x";
    process.env.HTTPS_PROXY = "http://proxy.invalid:1";
    try {
      const env = agentEnv({ configDir: "/c", token: "t" });
      expect(Object.keys(env).sort()).toEqual([...AGENT_ENV_KEYS].sort());
    } finally {
      process.env = before;
    }
  });

  const w = fakeWorld();
  afterAll(() => w.dispose());
  it("A2: the child sees exactly those names, and the token is in no argument", async () => {
    w.fake({ mode: "nodraft" });
    const r = await runAgent("Say OK", w.cfg, { timeoutMs: 30_000, transcriptFile: path.join(w.base, "logs", "t.jsonl"), sessionId: SID });
    expect(r.transcript.isError).toBe(false);
    const call = w.calls().at(-1)!;
    expect(call.envKeys.filter((k) => !OS_ADDED.has(k)).sort()).toEqual([...AGENT_ENV_KEYS].sort());
    expect(call.argv).toEqual(agentArgs("Say OK", { sessionId: SID }));
    expect(JSON.stringify(call.argv)).not.toContain(w.cfg.token);
    expect(fs.readFileSync(path.join(w.cfg.configDir, "calls.jsonl"), "utf8")).not.toContain(w.cfg.token);
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(w.cfg.repo));
  });
});

describe("A3: agentConfig (SPEC §9.7)", () => {
  const saved = { bin: process.env.CT_CLAUDE_BIN, dir: process.env.CT_CLAUDE_CONFIG_DIR };
  afterEach(() => {
    for (const [k, v] of [["CT_CLAUDE_BIN", saved.bin], ["CT_CLAUDE_CONFIG_DIR", saved.dir]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("A3: defaults to the Kobol paths", () => {
    expect(agentConfig("/repo", "tok", {})).toEqual({ bin: DEFAULT_CLAUDE_BIN, configDir: DEFAULT_CLAUDE_CONFIG_DIR, repo: "/repo", token: "tok" });
    expect(DEFAULT_CLAUDE_BIN).toBe("/Users/kobol/.cybertracker/cli/node_modules/.bin/claude");
    expect(DEFAULT_CLAUDE_CONFIG_DIR).toBe("/Users/kobol/.cybertracker/claude");
  });
  it("A3: CT_CLAUDE_BIN and CT_CLAUDE_CONFIG_DIR override them, read at call time", () => {
    expect(agentConfig("/r", "t", { CT_CLAUDE_BIN: "/x/claude", CT_CLAUDE_CONFIG_DIR: "/x/config" })).toMatchObject({ bin: "/x/claude", configDir: "/x/config" });
    process.env.CT_CLAUDE_BIN = "/first/claude";
    process.env.CT_CLAUDE_CONFIG_DIR = "/first/config";
    expect(agentConfig("/r", "t")).toMatchObject({ bin: "/first/claude", configDir: "/first/config" });
    process.env.CT_CLAUDE_BIN = "/second/claude";
    delete process.env.CT_CLAUDE_CONFIG_DIR;
    expect(agentConfig("/r", "t")).toMatchObject({ bin: "/second/claude", configDir: DEFAULT_CLAUDE_CONFIG_DIR });
  });
  it("A3: the old variable CT_AGENT_CONFIG_DIR is ignored", () => {
    expect(agentConfig("/r", "t", { CT_AGENT_CONFIG_DIR: "/tmp/elsewhere" }).configDir).toBe(DEFAULT_CLAUDE_CONFIG_DIR);
  });
});

describe("A4: routine/agent-settings.json (SPEC §9.5)", () => {
  const deny = settings.permissions.deny;

  it("A4: denies by default and allows only the drafting tools", () => {
    expect(settings.permissions.defaultMode).toBe("dontAsk");
    expect(settings.permissions.allow).toEqual([...AGENT_ALLOWED]);
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.env).toEqual({ DISABLE_AUTOUPDATER: "1" });
    expect(Object.keys(settings).sort()).toEqual(["disableAllHooks", "env", "permissions"]);
  });
  it("A4: starts with the fixed deny entries", () => {
    expect(deny.slice(0, 21)).toEqual([
      "Bash", "Agent", "Task", "NotebookEdit",
      "Read(**/.git/**)", "Read(cache/**)", "Read(logs/**)", "Read(needs-review/**)", "Read(content/**)",
      "Write(content/**)", "Edit(content/**)", "Write(config/**)", "Edit(config/**)",
      "Write(routine/**)", "Edit(routine/**)", "Write(scripts/**)", "Edit(scripts/**)",
      "Write(lib/**)", "Edit(lib/**)", "Write(packs/**)", "Edit(packs/**)",
    ]);
    for (const t of AGENT_DISALLOWED) expect(deny).toContain(t);
  });
  it("A4: then holds both domain forms of every BLOCKED_HOSTS host entry, in order, then the two suffixes", () => {
    const hosts = blockedHostEntries();
    const expected = [...hosts.flatMap((h) => [`WebFetch(domain:${h})`, `WebFetch(domain:*.${h})`]), "WebFetch(domain:*.onion)", "WebFetch(domain:*.i2p)"];
    expect(deny.slice(21)).toEqual(expected);
    expect(hosts.length).toBe(BLOCKED_HOSTS.filter((b) => !b.pattern.includes("/") && !b.pattern.startsWith(".")).length);
  });
  it("A4: is never in .claude/settings.json, and there are no hooks or MCP servers in the repo", () => {
    expect(fs.existsSync(path.join(root, ".claude", "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".mcp.json"))).toBe(false);
    expect(JSON.stringify(settings)).not.toMatch(/"hooks"|mcpServers|enableAllProjectMcpServers/);
  });
});

describe("A5, A6: runAgent on the fake CLI", () => {
  const w = fakeWorld();
  afterAll(() => w.dispose());

  it("A5: ok mode: the transcript is parsed, the session id echoed and the sandbox clean", async () => {
    const draft = { schema_version: 1, date: "2026-10-14" };
    w.fake({ mode: "ok", draft, fetches: ["https://example.org/ct-sample/a"], searches: 2 });
    const lines: string[] = [];
    const file = path.join(w.base, "logs", "2026-10-14.agent-1.jsonl");
    const r = await runAgent("Write `drafts/2026-10-14.json` now.", w.cfg, { timeoutMs: 30_000, transcriptFile: file, sessionId: SID, onLine: (l) => { lines.push(l); } });
    expect(r.sessionId).toBe(SID);
    expect(r.transcript.sessionId).toBe(SID);
    expect(r.sandbox).toEqual([]);
    expect(r.transcript.isError).toBe(false);
    expect(r.transcript.toolUses).toEqual({ WebFetch: 1, WebSearch: 2, Write: 1 });
    expect(r.transcript.fetchedOk).toEqual(["https://example.org/ct-sample/a"]);
    expect(r.transcript.usage).toEqual({ input: 1000, output: 200 });
    expect(r.raw).toBe(fs.readFileSync(file, "utf8"));
    expect(lines.filter((l) => l.trim()).length).toBe(r.raw.trim().split("\n").length);
    expect(fs.existsSync(`${file}.stderr`)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(w.cfg.repo, "drafts", "2026-10-14.json"), "utf8"))).toEqual(draft);
  });
  it("A5: a call without a session id gets a fresh UUID; --resume echoes the given id", async () => {
    w.fake({ mode: "nodraft" });
    const a = await runAgent("Reply OK.", w.cfg, { timeoutMs: 30_000, transcriptFile: path.join(w.base, "logs", "u.jsonl") });
    expect(a.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.transcript.sessionId).toBe(a.sessionId);
    const b = await runAgent("Reply OK.", w.cfg, { timeoutMs: 30_000, transcriptFile: path.join(w.base, "logs", "u.jsonl"), resume: a.sessionId });
    expect(b.sessionId).toBe(a.sessionId);
    expect(w.calls().at(-1)!.argv.slice(2, 4)).toEqual(["--resume", a.sessionId]);
  });
  it("A6: mcp mode: the guard stops the child within 2 s of init with SIGTERM, and sandbox names the tool", async () => {
    w.fake({ mode: "mcp" });
    let initAt = 0;
    const r = await runAgent("Write `drafts/2026-10-15.json`.", w.cfg, {
      timeoutMs: 60_000, transcriptFile: path.join(w.base, "logs", "m.jsonl"), sessionId: SID,
      onLine: (l) => { if (!initAt && l.includes('"init"')) initAt = Date.now(); },
    });
    const stoppedAfter = Date.now() - initAt;
    expect(initAt).toBeGreaterThan(0);
    expect(stoppedAfter).toBeLessThan(2_000);
    expect(r.run.stopped).toBe(true);
    expect(r.run.timedOut).toBe(false);
    expect(r.run.signal).toBe("SIGTERM");
    expect(r.sandbox).toEqual(["unexpected tool mcp__probe__x", "an MCP tool is present"]);
    expect(r.transcript.isError).toBeNull();
    expect(fs.existsSync(path.join(w.cfg.repo, "drafts", "2026-10-15.json"))).toBe(false);
  }, 30_000);
  it("A6: a caller's onLine returning stop also stops the child", async () => {
    w.fake({ mode: "ok", draft: { a: 1 }, delayMs: 20_000 });
    const r = await runAgent("Hello", w.cfg, { timeoutMs: 60_000, transcriptFile: path.join(w.base, "logs", "s.jsonl"), onLine: (l) => (l.includes('"init"') ? "stop" : undefined) });
    expect(r.run.stopped).toBe(true);
    expect(r.sandbox).toEqual([]);
  }, 30_000);
});

describe("A7: cliVersion", () => {
  const w = fakeWorld();
  afterAll(() => w.dispose());
  const script = (name: string, body: string) => {
    const p = path.join(w.base, "bin", name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  };

  it("A7: ok: the first line of --version", async () => {
    expect(await cliVersion(w.bin)).toEqual({ ok: true, version: "2.1.316 (Claude Code)" });
    expect(await cliVersion(script("multi", 'printf "\\n  9.9.9 (Claude Code)\\nmore\\n"'))).toEqual({ ok: true, version: "9.9.9 (Claude Code)" });
  });
  it("A7: a missing binary is not ok", async () => {
    expect(await cliVersion(path.join(w.base, "bin", "missing"))).toEqual({ ok: false, version: null });
  });
  it("A7: exit 1 is not ok", async () => {
    expect(await cliVersion(script("fails", "echo 2.1.316; exit 1"))).toEqual({ ok: false, version: null });
  });
  it("A7: a timeout is not ok", async () => {
    const t0 = Date.now();
    expect(await cliVersion(script("hangs", "sleep 20"), 300)).toEqual({ ok: false, version: null });
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);
  it("A7: an explicit config dir is the one the CLI sees", async () => {
    const other = path.join(w.base, "other-config");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "fake-agent.json"), JSON.stringify({ mode: "ok", version: "4.0.0 (Claude Code)" }));
    expect(await cliVersion(w.bin, undefined, other)).toEqual({ ok: true, version: "4.0.0 (Claude Code)" });
    expect(fs.readFileSync(path.join(other, "calls.jsonl"), "utf8")).toContain('"--version"');
  });
  it("A7: runs with the agent's environment but never the token", async () => {
    const saved = process.env.CT_CLAUDE_CONFIG_DIR;
    process.env.CT_CLAUDE_CONFIG_DIR = w.cfg.configDir;
    try {
      w.fake({ mode: "ok", version: "3.0.0 (Claude Code)" });
      expect(await cliVersion(w.bin)).toEqual({ ok: true, version: "3.0.0 (Claude Code)" });
      const call = w.calls().at(-1)!;
      expect(call.argv).toEqual(["--version"]);
      expect(call.envKeys.filter((k) => !OS_ADDED.has(k)).sort()).toEqual(AGENT_ENV_KEYS.filter((k) => k !== "CLAUDE_CODE_OAUTH_TOKEN").sort());
    } finally {
      if (saved === undefined) delete process.env.CT_CLAUDE_CONFIG_DIR;
      else process.env.CT_CLAUDE_CONFIG_DIR = saved;
    }
  });
});

describe("A8: readSecret (the keychain binary is always injected here)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-keychain-test-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = (name: string, body: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  };

  it("A8: returns null when the command fails, is missing, prints nothing or times out", () => {
    expect(readSecret(KEYCHAIN_SERVICE, { bin: bin("fail", "echo nope >&2; exit 44") })).toBeNull();
    expect(readSecret(KEYCHAIN_SERVICE, { bin: path.join(dir, "missing") })).toBeNull();
    expect(readSecret(KEYCHAIN_SERVICE, { bin: bin("empty", 'printf "  \\n"') })).toBeNull();
    expect(readSecret(KEYCHAIN_SERVICE, { bin: bin("slow", "sleep 5; echo late"), timeoutMs: 200 })).toBeNull();
  });
  it("A8: returns the value trimmed, and asks for exactly the service with -w", () => {
    const echo = bin("echo", 'printf "  %s|%s|%s|%s  \\n" "$1" "$2" "$3" "$4"');
    expect(readSecret("cybertracker-claude-oauth", { bin: echo })).toBe("find-generic-password|-s|cybertracker-claude-oauth|-w");
    expect(KEYCHAIN_SERVICE).toBe("cybertracker-claude-oauth");
  });
});

describe("A9: sandboxViolations and fetchBudgetLeft", () => {
  it("A9: passes the recorded init event", () => {
    const t = parseTranscript(fs.readFileSync(path.join(root, "fixtures", "agent", "transcript-ok.jsonl"), "utf8"));
    expect(sandboxViolations(t)).toEqual([]);
  });
  it("A9: flags extra tools, MCP and the wrong mode", () => {
    const v = sandboxViolations({ tools: [...AGENT_TOOLS.filter((t) => t !== "Edit"), "Bash", "mcp__x__y"], mcpServers: [{ name: "x", status: "connected" }], permissionMode: "default" });
    expect(v).toEqual([
      "unexpected tool Bash", "unexpected tool mcp__x__y", "missing tool Edit", "an MCP tool is present", "1 MCP server(s) present", "permission mode default",
    ]);
  });
  it("A9: fetchBudgetLeft subtracts every WebFetch call of the run and never goes below 0", () => {
    const t = (n: number) => parseTranscript(JSON.stringify({ type: "assistant", message: { content: Array.from({ length: n }, (_, i) => ({ type: "tool_use", id: `t${i}`, name: "WebFetch", input: { url: `https://example.org/ct-sample/${i}` } })) } }));
    expect(fetchBudgetLeft(40, [])).toBe(40);
    expect(fetchBudgetLeft(40, [t(12), t(3)])).toBe(25);
    expect(fetchBudgetLeft(10, [t(7), t(9)])).toBe(0);
  });
});
