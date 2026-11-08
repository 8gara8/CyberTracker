// The drafting agent's sandbox, pinned (SPEC §9.5, §8.13). This file and no-europe-strings.test.ts are
// the two allowed to name the strings the scan forbids, because they assert their absence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BLOCKED_HOSTS, blockedHostEntries } from "@/lib/vocab";
import {
  AGENT_ALLOWED, AGENT_DISALLOWED, AGENT_ENV_PASSTHROUGH, AGENT_SETTINGS, AGENT_TOOLS, FORBIDDEN_ENV, PASSTHROUGH_CANDIDATES,
  agentArgs, agentConfig, agentEnv, prepareConfigDir, renderTemplate, runAgent, sandboxViolations,
} from "@/scripts/lib/agent";
import { parseTranscript } from "@/scripts/lib/transcript";
import { domainDenied, fetchedCanary, listingWithoutGlob, negativeResult, renderTable, toolResultsContain, webRow } from "@/scripts/agent-check";

const root = path.join(__dirname, "..");
const settings = JSON.parse(fs.readFileSync(path.join(root, AGENT_SETTINGS), "utf8")) as {
  permissions: { defaultMode: string; allow: string[]; deny: string[] };
  disableAllHooks: boolean;
  env: Record<string, string>;
};

describe("agentArgs (SPEC §9.5)", () => {
  const args = agentArgs("PROMPT", { sessionId: "11111111-2222-3333-4444-555555555555" });

  it("is exactly the pinned list", () => {
    expect(args).toEqual([
      "-p", "PROMPT",
      "--session-id", "11111111-2222-3333-4444-555555555555",
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
  });
  it("puts the prompt first and Bash fourth from the end", () => {
    expect(args.slice(0, 2)).toEqual(["-p", "PROMPT"]);
    expect(args[args.length - 4]).toBe("Bash");
  });
  it("resumes by id", () => {
    const r = agentArgs("P", { resume: "abc" });
    expect(r.slice(2, 4)).toEqual(["--resume", "abc"]);
    expect(r).not.toContain("--session-id");
  });
  it("never names a model, a bypass mode or skipped permissions", () => {
    const joined = args.join(" ");
    expect(joined).not.toMatch(/--model\b|--fallback-model\b|bypassPermissions|--dangerously|--bare\b|--add-dir/);
  });
});

describe("routine/agent-settings.json", () => {
  const deny = settings.permissions.deny;

  it("denies by default and allows only the drafting tools", () => {
    expect(settings.permissions.defaultMode).toBe("dontAsk");
    expect(settings.permissions.allow).toEqual([...AGENT_ALLOWED]);
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.env).toEqual({ DISABLE_AUTOUPDATER: "1" });
    expect(Object.keys(settings).sort()).toEqual(["disableAllHooks", "env", "permissions"]);
  });
  it("starts with the fixed deny entries", () => {
    expect(deny.slice(0, 21)).toEqual([
      "Bash", "Agent", "Task", "NotebookEdit",
      "Read(**/.git/**)", "Read(cache/**)", "Read(logs/**)", "Read(needs-review/**)", "Read(content/**)",
      "Write(content/**)", "Edit(content/**)", "Write(config/**)", "Edit(config/**)",
      "Write(routine/**)", "Edit(routine/**)", "Write(scripts/**)", "Edit(scripts/**)",
      "Write(lib/**)", "Edit(lib/**)", "Write(packs/**)", "Edit(packs/**)",
    ]);
    for (const t of AGENT_DISALLOWED) expect(deny).toContain(t);
  });
  it("then holds both domain forms of every BLOCKED_HOSTS host entry, in order, then the two suffixes", () => {
    const hosts = blockedHostEntries();
    const expected = [...hosts.flatMap((h) => [`WebFetch(domain:${h})`, `WebFetch(domain:*.${h})`]), "WebFetch(domain:*.onion)", "WebFetch(domain:*.i2p)"];
    expect(deny.slice(21)).toEqual(expected);
    expect(hosts.length).toBe(BLOCKED_HOSTS.filter((b) => !b.pattern.includes("/") && !b.pattern.startsWith(".")).length);
  });
  it("is never in .claude/settings.json, and there are no hooks or MCP servers in the repo", () => {
    expect(fs.existsSync(path.join(root, ".claude", "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".mcp.json"))).toBe(false);
    expect(JSON.stringify(settings)).not.toMatch(/"hooks"|mcpServers|enableAllProjectMcpServers/);
  });
});

describe("the agent's environment", () => {
  it("lists the SPEC's sixteen candidates, and passes only candidates", () => {
    expect(PASSTHROUGH_CANDIDATES).toHaveLength(16);
    for (const name of AGENT_ENV_PASSTHROUGH) expect(PASSTHROUGH_CANDIDATES as readonly string[]).toContain(name);
  });
  it("never passes a forbidden name", () => {
    for (const name of [...PASSTHROUGH_CANDIDATES, ...AGENT_ENV_PASSTHROUGH]) expect(FORBIDDEN_ENV.test(name), name).toBe(false);
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GIT_ASKPASS", "AWS_SECRET_ACCESS_KEY", "CLOUDSDK_CONFIG", "ANTHROPIC_API_KEY", "SOME_SECRET", "X_TOKEN", "CLAUDE_CODE_MESSAGING_SOCKET"]) {
      expect(FORBIDDEN_ENV.test(name), name).toBe(true);
    }
  });
  it("builds the environment from nothing", () => {
    const source = {
      HOME: "/home/x", PATH: "/opt/bin:/usr/bin", HTTPS_PROXY: "http://proxy.invalid:1", NO_PROXY: "localhost",
      GH_TOKEN: "x", GITHUB_TOKEN: "x", ANTHROPIC_API_KEY: "x", CLAUDE_CODE_MESSAGING_SOCKET: "/s", TZ: "UTC", SHELL: "/bin/bash",
    };
    const env = agentEnv({ bin: "/opt/claude/bin/claude", configDir: "/tmp/ct-agent-config", passthrough: ["HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE"] }, source);
    expect(env).toEqual({
      HOME: "/home/x",
      PATH: "/opt/claude/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      CLAUDE_CONFIG_DIR: "/tmp/ct-agent-config",
      DISABLE_AUTOUPDATER: "1",
      HTTPS_PROXY: "http://proxy.invalid:1",
      NO_PROXY: "localhost",
    });
  });
  it("refuses a forbidden passthrough name", () => {
    expect(() => agentEnv({ bin: "/b/claude", configDir: "/c", passthrough: ["GH_TOKEN"] }, { GH_TOKEN: "x" })).toThrow(/Refusing/);
  });
  it("reads the binary and config dir from CT_ variables", () => {
    const cfg = agentConfig("/repo", { CT_CLAUDE_BIN: "/x/claude", CT_AGENT_CONFIG_DIR: "/tmp/elsewhere", PATH: "" }, []);
    expect([cfg.bin, cfg.configDir, cfg.repo, cfg.passthrough]).toEqual(["/x/claude", "/tmp/elsewhere", "/repo", []]);
    expect(agentConfig("/repo", { PATH: "" }).configDir).toBe("/tmp/ct-agent-config");
  });
});

describe("runAgent with a fake CLI", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-agent-test-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const bin = path.join(tmp, "bin", "claude");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(path.join(tmp, "fake.mjs"), [
    'import fs from "node:fs";',
    'fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + "/seen.json", JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }));',
    'const sid = process.argv[process.argv.indexOf(process.argv.includes("--resume") ? "--resume" : "--session-id") + 1];',
    'console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sid, model: "<model>", tools: ["WebSearch","WebFetch","Read","Glob","Grep","Write","Edit"], mcp_servers: [], permissionMode: "dontAsk" }));',
    'console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", session_id: sid }));',
  ].join("\n"));
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(tmp, "fake.mjs")}" "$@"\n`, { mode: 0o755 });
  const configDir = path.join(tmp, "config");
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);

  it("passes exactly the pinned arguments and environment, and reads the transcript", async () => {
    prepareConfigDir(configDir);
    expect(fs.statSync(configDir).mode & 0o777).toBe(0o700);
    const cfg = { bin, configDir, repo, passthrough: ["HTTPS_PROXY"] as const };
    const source = { HOME: "/home/x", PATH: process.env.PATH, HTTPS_PROXY: "http://proxy.invalid:1", GH_TOKEN: "must-not-pass" };
    const r = await runAgent("Say OK", { ...cfg, passthrough: cfg.passthrough }, {
      timeoutMs: 30_000, transcriptFile: path.join(tmp, "logs", "t.jsonl"), sessionId: "11111111-2222-3333-4444-555555555555",
      env: agentEnv(cfg, source),
    });
    const seen = JSON.parse(fs.readFileSync(path.join(configDir, "seen.json"), "utf8")) as { argv: string[]; env: Record<string, string>; cwd: string };
    expect(seen.argv).toEqual(agentArgs("Say OK", { sessionId: "11111111-2222-3333-4444-555555555555" }));
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(repo));
    // The shell and macOS add these to every process, even with an empty environment (seen on Kobol).
    const OS_ADDED = new Set(["PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"]);
    const keys = Object.keys(seen.env).filter((k) => !OS_ADDED.has(k));
    expect(keys.sort()).toEqual(["CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "HOME", "HTTPS_PROXY", "LANG", "PATH"]);
    expect(seen.env.GH_TOKEN).toBeUndefined();
    expect(r.transcript.isError).toBe(false);
    expect(r.transcript.resultText).toBe("OK");
    expect(r.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(sandboxViolations(r.transcript)).toEqual([]);
  });
});

describe("sandboxViolations", () => {
  it("passes the recorded init event", () => {
    const t = parseTranscript(fs.readFileSync(path.join(root, "fixtures", "agent", "transcript-ok.jsonl"), "utf8"));
    expect(sandboxViolations(t)).toEqual([]);
  });
  it("flags extra tools, MCP and the wrong mode", () => {
    const v = sandboxViolations({ tools: [...AGENT_TOOLS.filter((t) => t !== "Edit"), "Bash", "mcp__x__y"], mcpServers: [{ name: "x", status: "connected" }], permissionMode: "default" });
    expect(v).toEqual([
      "unexpected tool Bash", "unexpected tool mcp__x__y", "missing tool Edit", "an MCP tool is present", "1 MCP server(s) present", "permission mode default",
    ]);
  });
});

describe("renderTemplate", () => {
  it("fills every placeholder and refuses to leave one", () => {
    expect(renderTemplate("{{A}} and {{B_C}}", { A: "x", B_C: "y" })).toBe("x and y");
    expect(() => renderTemplate("{{A}} {{MISSING}}", { A: "x" })).toThrow(/MISSING/);
  });
});

describe("agent-check's verdicts", () => {
  const lines = (events: object[]) => events.map((e) => JSON.stringify(e)).join("\n");
  const run = (calls: { id: string; name: string; input: object; error?: boolean; text: string }[], denied: string[] = []) =>
    parseTranscript(lines([
      { type: "assistant", message: { content: calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })) } },
      { type: "user", message: { content: calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, is_error: c.error ?? false, content: c.text })) } },
      { type: "result", is_error: false, permission_denials: denied.map((id) => ({ tool_use_id: id })) },
    ]));

  it("passes a negative test only when every target was tried and denied", () => {
    const t = run([
      { id: "a", name: "Read", input: { file_path: "/root/.ssh/x" }, error: true, text: "Permission to read denied" },
      { id: "b", name: "Read", input: { file_path: "/etc/hostname" }, text: "box" },
    ], ["a"]);
    const isSsh = (i: Record<string, unknown>) => String(i.file_path).includes(".ssh");
    const isEtc = (i: Record<string, unknown>) => String(i.file_path).includes("/etc/");
    const isOther = (i: Record<string, unknown>) => String(i.file_path).includes("/var/");
    expect(negativeResult(t, "Read", [isSsh])).toEqual({ result: "PASS", attempts: 1, denied: 1 });
    expect(negativeResult(t, "Read", [isSsh, isEtc])).toEqual({ result: "FAIL", attempts: 2, denied: 1 });
    expect(negativeResult(t, "Read", [isSsh, isOther]).result).toBe("NO_ATTEMPT");
  });
  it("counts a blocked domain only when the refusal is a permission, not a network error", () => {
    const t = run([
      { id: "a", name: "WebFetch", input: { url: "https://www.exploit-db.com/" }, error: true, text: "Claude Code denied access to domain:www.exploit-db.com" },
      { id: "b", name: "WebFetch", input: { url: "https://pastebin.com/" }, error: true, text: "getaddrinfo ENOTFOUND" },
    ]);
    expect(domainDenied(t, ["exploit-db.com"]).result).toBe("PASS");
    expect(domainDenied(t, ["exploit-db.com", "pastebin.com"])).toEqual({ result: "FAIL", attempts: 2, denied: 1 });
  });
  it("finds a protected value in a result but not in an echo of the call's own input", () => {
    const nonce = "a1b2c3d4e5f6";
    const echo = run([{ id: "a", name: "Read", input: { file_path: `/tmp/marker-${nonce}` }, error: true, text: `Cannot read /tmp/marker-${nonce}: denied` }]);
    expect(toolResultsContain(echo, [nonce])).toBe(false);
    const leak = run([{ id: "a", name: "Read", input: { file_path: "/tmp/other" }, text: `contents ${nonce}` }]);
    expect(toolResultsContain(leak, [nonce])).toBe(true);
    expect(toolResultsContain(leak, ["con"])).toBe(false);
  });
  it("judges the web test by network level", () => {
    const full = run([
      { id: "s", name: "WebSearch", input: { query: "q" }, text: "results" },
      { id: "q", name: "WebFetch", input: { url: "https://www.qnap.com/en/security-advisories" }, text: "page" },
    ]);
    expect(webRow(full, "full").result).toBe("PASS");
    expect(webRow(full, "custom").result).toBe("NO_ATTEMPT");
    const custom = run([
      { id: "s", name: "WebSearch", input: { query: "q" }, text: "results" },
      { id: "q", name: "WebFetch", input: { url: "https://www.qnap.com/" }, error: true, text: "denied" },
      { id: "b", name: "WebFetch", input: { url: "https://www.bleepingcomputer.com/" }, text: "page" },
    ]);
    expect(webRow(custom, "custom").result).toBe("PASS");
    expect(webRow(custom, "full").result).toBe("FAIL");
  });
  it("catches the planted URL in any form", () => {
    for (const url of ["https://example.org/ct-canary/abc", "http://example.org/ct-canary/abc", "https://www.EXAMPLE.org/CT-CANARY/abc"]) {
      expect(fetchedCanary(run([{ id: "a", name: "WebFetch", input: { url }, text: "x" }])), url).toBe(true);
    }
    expect(fetchedCanary(run([{ id: "a", name: "WebFetch", input: { url: "https://example.org/other" }, text: "x" }]))).toBe(false);
    expect(fetchedCanary(run([{ id: "a", name: "WebSearch", input: { query: "example.org/ct-canary/" }, text: "x" }]))).toBe(false);
  });
  it("treats a directory listing in the reply as a shell, unless Glob made it", () => {
    const entries = ["SPEC.md", "package.json", "scripts", "lib", "config", "routine"];
    const reply = (text: string, calls: { id: string; name: string; input: object; text: string }[] = []) => parseTranscript(lines([
      { type: "assistant", message: { content: [...calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })), { type: "text", text }] } },
      { type: "user", message: { content: calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: c.text })) } },
      { type: "result", is_error: false, result: text },
    ]));
    expect(listingWithoutGlob(reply("Here it is:\n```\nSPEC.md\nconfig\nlib\npackage.json\n```"), entries)).toBe(true);
    expect(listingWithoutGlob(reply("SPEC.md config lib", [{ id: "g", name: "Glob", input: { pattern: "*" }, text: "SPEC.md" }]), entries)).toBe(false);
    expect(listingWithoutGlob(reply("I can't run shell commands here; Bash isn't available. The library and its scripts are fine."), entries)).toBe(false);
  });
  it("renders the table with a count", () => {
    const table = renderTable([{ test: "cli", result: "PASS", evidence: "a | b" }, { test: "web", result: "FAIL", evidence: "x" }]);
    expect(table).toContain("| cli | PASS | a / b |");
    expect(table.trim().split("\n").at(-1)).toBe("1 of 2 tests passed.");
  });
});
