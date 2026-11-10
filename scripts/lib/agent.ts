import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run, type RunResult } from "./run";
import { parseTranscript, type Transcript } from "./transcript";
import type { AgentContext } from "../../lib/schema/context";
import type { ValidationIssue } from "../../lib/rules/types";

// The sandboxed drafting agent (SPEC §9.5): a headless `claude -p` started as a child process, with no
// shell, no git, no MCP, and writes only under drafts/. Flags checked against Claude Code 2.1.319:
//   --restricted     removes the tools that run commands or code (and WebFetch unless --tools names it),
//                    confines the file tools to the working directory, ignores user, project and local
//                    settings files (--settings still applies)
//   --safe-mode      no CLAUDE.md, skills, plugins, hooks, MCP servers, custom agents or output styles
//   --tools          the complete list of built-in tools that exist in the session
//   --permission-mode dontAsk with --permission-prompts none: anything not allowed is denied, never asked
// No model flag of any kind: the CLI's default model (SPEC §0.2). No --bare: it refuses the
// session's sign-in. Adapted from the Europe fork's scripts/lib/agent.ts.

export const AGENT_TOOLS = ["WebSearch", "WebFetch", "Read", "Glob", "Grep", "Write", "Edit"] as const;
export const AGENT_SETTINGS = "routine/agent-settings.json";
export const AGENT_ALLOWED = ["WebSearch", "WebFetch", "Read", "Glob", "Grep", "Write(drafts/**)", "Edit(drafts/**)"] as const;
export const AGENT_DISALLOWED = ["Bash", "Agent", "Task", "NotebookEdit"] as const;
export const AGENT_PERMISSION_MODE = "dontAsk";

/**
 * Session variables the nested CLI may need to sign in and to reach WebSearch and WebFetch through the
 * session's proxy (names only, SPEC §9.5, Appendix C). `agent-check --find-passthrough` finds the
 * smallest working subset in a fired session.
 */
export const PASSTHROUGH_CANDIDATES = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
  "SESSION_INGRESS_URL",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_WEBFETCH_USE_CCR_PROXY",
  "CLAUDE_CODE_WEBSEARCH_USE_CCR_PROXY",
  "CLAUDE_CODE_ACCOUNT_UUID",
  "CLAUDE_CODE_ORGANIZATION_UUID",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
] as const;

/**
 * The names actually passed. Until P0's fired `agent-check-passthrough` finds the smallest set, this is
 * every candidate (SPEC §9.5); P0 replaces it with the list that firing prints.
 */
export const AGENT_ENV_PASSTHROUGH: readonly string[] = [...PASSTHROUGH_CANDIDATES];

/** Names that must never reach the agent (SPEC §9.5). */
export const FORBIDDEN_ENV = /^(GH_|GITHUB_|GIT_|AWS_|CLOUDSDK_)|(TOKEN|SECRET|_KEY)$|^CLAUDE_CODE_MESSAGING_SOCKET$/;

export const DEFAULT_CONFIG_DIR = "/tmp/ct-agent-config";

export interface AgentConfig {
  /** The CLI binary: CT_CLAUDE_BIN, else `claude` found on PATH. */
  bin: string;
  /** CT_AGENT_CONFIG_DIR, created fresh once per process (prepareConfigDir). */
  configDir: string;
  /** The code checkout; the agent's working directory. */
  repo: string;
  /** Names copied from the session's environment. */
  passthrough: readonly string[];
}

/** The argument list of SPEC §9.4. The prompt comes first because the allow and deny lists are variadic. */
export function agentArgs(prompt: string, session: { sessionId: string } | { resume: string }): string[] {
  return [
    "-p", prompt,
    ...("resume" in session ? ["--resume", session.resume] : ["--session-id", session.sessionId]),
    "--output-format", "stream-json",
    "--verbose",
    "--restricted",
    "--safe-mode",
    "--disable-slash-commands",
    "--tools", AGENT_TOOLS.join(","),
    "--settings", AGENT_SETTINGS,
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--permission-mode", AGENT_PERMISSION_MODE,
    "--permission-prompts", "none",
    "--allowedTools", ...AGENT_ALLOWED,
    "--disallowedTools", ...AGENT_DISALLOWED,
  ];
}

/** Finds `name` on PATH, or returns it unchanged. */
export function whichBin(name: string, envPath = process.env.PATH ?? ""): string {
  if (name.includes("/")) return name;
  for (const dir of envPath.split(":")) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* keep looking */ }
  }
  return name;
}

/**
 * The agent's environment, built from nothing, never from process.env (SPEC §9.5): HOME, PATH (the
 * CLI's directory, then /usr/bin:/bin), LANG, CLAUDE_CONFIG_DIR and DISABLE_AUTOUPDATER, plus the
 * passthrough names that are set. A passthrough name that matches FORBIDDEN_ENV is refused.
 */
export function agentEnv(cfg: Pick<AgentConfig, "bin" | "configDir" | "passthrough">, source: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {
    HOME: source.HOME ?? "/root",
    PATH: `${path.dirname(cfg.bin.includes("/") ? cfg.bin : whichBin(cfg.bin, source.PATH))}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    CLAUDE_CONFIG_DIR: cfg.configDir,
    DISABLE_AUTOUPDATER: "1",
  };
  for (const name of cfg.passthrough) {
    if (FORBIDDEN_ENV.test(name)) throw new Error(`Refusing to pass ${name} to the agent.`);
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Creates the isolated config dir fresh, mode 700 (SPEC §9.5). Called once per process, never inside runAgent. */
export function prepareConfigDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export function agentConfig(repo: string, env: Readonly<Record<string, string | undefined>> = process.env, passthrough: readonly string[] = AGENT_ENV_PASSTHROUGH): AgentConfig {
  return {
    bin: whichBin(env.CT_CLAUDE_BIN || "claude", env.PATH),
    configDir: env.CT_AGENT_CONFIG_DIR || DEFAULT_CONFIG_DIR,
    repo,
    passthrough,
  };
}

export interface AgentRun {
  run: RunResult;
  transcript: Transcript;
  raw: string;
  sessionId: string;
}

/** Runs one agent call. Its outcome is the transcript's result event, never the exit code (SPEC §9.5). */
export async function runAgent(
  prompt: string,
  cfg: AgentConfig,
  opts: { timeoutMs: number; transcriptFile: string; sessionId?: string; resume?: string; onLine?: (line: string) => void | "stop"; env?: Record<string, string> },
): Promise<AgentRun> {
  fs.mkdirSync(path.dirname(opts.transcriptFile), { recursive: true });
  fs.rmSync(opts.transcriptFile, { force: true });
  fs.rmSync(`${opts.transcriptFile}.stderr`, { force: true });
  const sessionId = opts.resume ?? opts.sessionId ?? randomUUID();
  const r = await run(cfg.bin, agentArgs(prompt, opts.resume ? { resume: opts.resume } : { sessionId }), {
    cwd: cfg.repo,
    env: opts.env ?? agentEnv(cfg),
    timeoutMs: opts.timeoutMs,
    stdoutFile: opts.transcriptFile,
    stderrFile: `${opts.transcriptFile}.stderr`,
    onLine: opts.onLine,
  });
  const raw = fs.existsSync(opts.transcriptFile) ? fs.readFileSync(opts.transcriptFile, "utf8") : "";
  return { run: r, transcript: parseTranscript(raw), raw, sessionId };
}

/**
 * What is wrong with an agent's init event against the sandbox (SPEC §8.12): tools other than exactly
 * `allowed`, any MCP tool or server, and a permission mode other than dontAsk. Empty when it is right.
 * The orchestrator's sandbox guard and agent-check's `tools` test both use it.
 */
export function sandboxViolations(init: Pick<Transcript, "tools" | "mcpServers" | "permissionMode">, allowed: readonly string[] = AGENT_TOOLS): string[] {
  const v: string[] = [];
  const tools = new Set(init.tools);
  for (const t of init.tools) if (!allowed.includes(t)) v.push(`unexpected tool ${t}`);
  for (const t of allowed) if (!tools.has(t)) v.push(`missing tool ${t}`);
  if (init.tools.some((t) => t.startsWith("mcp__"))) v.push("an MCP tool is present");
  if (init.mcpServers.length) v.push(`${init.mcpServers.length} MCP server(s) present`);
  if (init.permissionMode !== AGENT_PERMISSION_MODE) v.push(`permission mode ${init.permissionMode ?? "unknown"}`);
  return v;
}

/** Fills {{NAME}} placeholders and refuses to leave any unfilled. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, name: string) => (name in vars ? vars[name]! : m));
  const left = out.match(/\{\{[A-Z_]+\}\}/g);
  if (left) throw new Error(`Unfilled template variables: ${[...new Set(left)].join(", ")}`);
  return out;
}

// ── P3 exports (SPEC §9.4, §8.5; plan §2.2 and amendment A9) ─────────────────────────────────────
// Step S0 added these so lanes L6 and I typecheck against them; constants are final, functions are stubs.
// Lane L1 rewrites this file to §9.4 from here: it removes PASSTHROUGH_CANDIDATES, AGENT_ENV_PASSTHROUGH,
// FORBIDDEN_ENV, DEFAULT_CONFIG_DIR, prepareConfigDir and whichBin, and gives AgentConfig, agentConfig(),
// agentEnv(), AgentRun and renderTemplate() the §2.2 signatures (S0 kept the P2 ones above, which
// scripts/agent-check.ts and tests/agent.test.ts still use).

/** The pinned CLI on Kobol (§9.4); CT_CLAUDE_BIN overrides it. */
export const DEFAULT_CLAUDE_BIN = "/Users/kobol/.cybertracker/cli/node_modules/.bin/claude";
/** The agent's own config dir on Kobol, mode 700 (§9.5); CT_CLAUDE_CONFIG_DIR overrides it. */
export const DEFAULT_CLAUDE_CONFIG_DIR = "/Users/kobol/.cybertracker/claude";
/** The agent's fixed PATH (§9.4). */
export const AGENT_PATH = "/opt/homebrew/bin:/usr/bin:/bin";
/** Exactly the agent's environment names (§9.5). */
export const AGENT_ENV_KEYS = ["HOME", "PATH", "TZ", "LANG", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "DISABLE_AUTOUPDATER"] as const;

/** `<bin> --version` within timeoutMs (default 30 s): ok when exit 0; version is the first line. */
export async function cliVersion(bin: string, timeoutMs?: number): Promise<{ ok: boolean; version: string | null }> {
  throw new Error("P3 stub: cliVersion (lane L1)");
}

/** The {{NAME}} variables of routine/PROMPT.md (§8.5). */
export const PROMPT_VARS = ["DATE", "WINDOW_START", "WINDOW_END", "WEEKLY", "DEADLINE_LOCAL", "DRAFT_PATH", "CONTEXT_PATH",
  "PACK_MD_PATH", "SCHEMA_PATH", "STYLE_PATH", "FETCH_BUDGET", "MAX_ITEMS"] as const;
/** The {{NAME}} variables of routine/REPAIR.md (§8.5). */
export const REPAIR_VARS = ["DATE", "DEADLINE_LOCAL", "DRAFT_PATH", "CONTEXT_PATH", "SCHEMA_PATH", "STYLE_PATH", "FETCH_BUDGET",
  "ERRORS_JSON"] as const;

/**
 * §8.5's values: paths absolute under root; WINDOW_* "YYYY-MM-DD HH:MM" Taipei from context.window;
 * DEADLINE_LOCAL HH:MM of context.deadline; WEEKLY "true"|"false". `paths` replaces the draft, context and
 * pack paths derived from the date (the canary's own files, plan A22).
 */
export function promptVars(o: {
  root: string; date: string; context: AgentContext; fetchBudget: number; maxItems: number;
  paths?: Partial<{ draft: string; context: string; packMd: string }>;
}): Record<(typeof PROMPT_VARS)[number], string> {
  throw new Error("P3 stub: promptVars (lane L1)");
}

/** REPAIR.md's values; ERRORS_JSON lists the errors first, then the SNAP_* warnings, as pretty-printed ValidationIssue[]. */
export function repairVars(o: {
  root: string; date: string; context: AgentContext; fetchBudget: number; issues: readonly ValidationIssue[];
}): Record<(typeof REPAIR_VARS)[number], string> {
  throw new Error("P3 stub: repairVars (lane L1)");
}

/** budgets.web_fetches minus WebFetch calls in these transcripts (never below 0). */
export function fetchBudgetLeft(budget: number, transcripts: readonly Transcript[]): number {
  throw new Error("P3 stub: fetchBudgetLeft (lane L1)");
}
