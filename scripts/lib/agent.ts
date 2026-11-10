import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { taipeiTimestamp } from "../../lib/dates";
import { DRAFT_SCHEMA_PATH } from "../../lib/json-schema";
import type { ValidationIssue } from "../../lib/rules/types";
import type { AgentContext } from "../../lib/schema/context";
import { P3_LIMITS, hhmm } from "./clock";
import { runPaths } from "./paths";
import { run, type RunResult } from "./run";
import { parseTranscript, type Transcript } from "./transcript";

// The sandboxed drafting agent (SPEC §9.4, §9.5): a headless `claude -p` started as a child process from
// the repo root, with no shell, no git, no MCP, and writes only under drafts/. Every flag below is in the
// `--help` of Claude Code 2.1.316, the pinned version (Appendix C):
//   --restricted     removes the tools that run commands or code (and WebFetch unless --tools names it),
//                    confines the file tools to the working directory, ignores user, project and local
//                    settings files (--settings still applies)
//   --safe-mode      no CLAUDE.md, skills, plugins, hooks, MCP servers, custom agents or output styles
//   --disable-slash-commands  no skills or commands
//   --tools          the complete list of built-in tools that exist in the session
//   --strict-mcp-config with an empty --mcp-config: no MCP server from anywhere
//   --permission-mode dontAsk with --permission-prompts none: anything not allowed is denied, never asked
//   --session-id <uuid> on a first call, --resume <uuid> on a repair
// No model flag of any kind: the CLI's default model (SPEC §0.2). No --bare: it takes only API keys.
// The environment is built from nothing (agentEnv): seven names, the keychain token only as
// CLAUDE_CODE_OAUTH_TOKEN, never a GitHub credential. Adapted from the Europe fork's scripts/lib/agent.ts.

export const AGENT_TOOLS = ["WebSearch", "WebFetch", "Read", "Glob", "Grep", "Write", "Edit"] as const;
export const AGENT_SETTINGS = "routine/agent-settings.json";
export const AGENT_ALLOWED = ["WebSearch", "WebFetch", "Read", "Glob", "Grep", "Write(drafts/**)", "Edit(drafts/**)"] as const;
export const AGENT_DISALLOWED = ["Bash", "Agent", "Task", "NotebookEdit"] as const;
export const AGENT_PERMISSION_MODE = "dontAsk";

/** The pinned CLI on Kobol (§9.4); CT_CLAUDE_BIN overrides it. */
export const DEFAULT_CLAUDE_BIN = "/Users/kobol/.cybertracker/cli/node_modules/.bin/claude";
/** The agent's own config dir on Kobol, mode 700 (§9.4, §9.9); CT_CLAUDE_CONFIG_DIR overrides it. */
export const DEFAULT_CLAUDE_CONFIG_DIR = "/Users/kobol/.cybertracker/claude";
/** The agent's fixed PATH (§9.4). */
export const AGENT_PATH = "/opt/homebrew/bin:/usr/bin:/bin";
/** Exactly the agent's environment names (§9.4). */
export const AGENT_ENV_KEYS = ["HOME", "PATH", "TZ", "LANG", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "DISABLE_AUTOUPDATER"] as const;

export interface AgentConfig {
  /** The CLI binary: CT_CLAUDE_BIN, else DEFAULT_CLAUDE_BIN. */
  bin: string;
  /** The agent's config dir: CT_CLAUDE_CONFIG_DIR, else DEFAULT_CLAUDE_CONFIG_DIR. Repairs reuse it (--resume). */
  configDir: string;
  /** The code checkout; the agent's working directory. */
  repo: string;
  /** The keychain token (§9.6). Held in memory, passed only as CLAUDE_CODE_OAUTH_TOKEN, never logged. */
  token: string;
}

/** CT_CLAUDE_BIN and CT_CLAUDE_CONFIG_DIR read from `env` at call time, else the Kobol defaults (§9.7). */
export function agentConfig(repo: string, token: string, env: Readonly<Record<string, string | undefined>> = process.env): AgentConfig {
  return {
    bin: env.CT_CLAUDE_BIN || DEFAULT_CLAUDE_BIN,
    configDir: env.CT_CLAUDE_CONFIG_DIR || DEFAULT_CLAUDE_CONFIG_DIR,
    repo,
    token,
  };
}

/**
 * The agent's environment, built from nothing, never from process.env (§9.4): exactly AGENT_ENV_KEYS,
 * with HOME the user's home, the fixed PATH, TZ Asia/Taipei, LANG en_US.UTF-8 and DISABLE_AUTOUPDATER 1.
 */
export function agentEnv(cfg: Pick<AgentConfig, "configDir" | "token">): Record<string, string> {
  return {
    HOME: os.homedir(),
    PATH: AGENT_PATH,
    TZ: "Asia/Taipei",
    LANG: "en_US.UTF-8",
    CLAUDE_CONFIG_DIR: cfg.configDir,
    CLAUDE_CODE_OAUTH_TOKEN: cfg.token,
    DISABLE_AUTOUPDATER: "1",
  };
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

/**
 * What is wrong with an agent's init event against the sandbox (SPEC §8.12): tools other than exactly
 * `allowed`, any MCP tool or server, and a permission mode other than dontAsk. Empty when it is right.
 * The orchestrator's sandbox guard (runAgent) and agent-check's `tools` test both use it.
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

/** The parsed init event of one stream-json line, or null when the line is something else. */
function initEvent(line: string): Transcript | null {
  if (!line.includes('"init"')) return null;
  try {
    const e = JSON.parse(line) as { type?: unknown; subtype?: unknown };
    if (e.type !== "system" || e.subtype !== "init") return null;
  } catch {
    return null;
  }
  return parseTranscript(line);
}

export interface AgentRun {
  run: RunResult;
  transcript: Transcript;
  raw: string;
  /** The session the call ran in: --resume's id, else --session-id's (made here when not given). */
  sessionId: string;
  /** sandboxViolations() of the first system/init event; non-empty means the child was stopped (SIGTERM, then SIGKILL after 10 s). */
  sandbox: string[];
}

/**
 * Runs one agent call (§9.4): cwd cfg.repo, stdin ignored, stdout to transcriptFile, stderr to
 * `${transcriptFile}.stderr`, exactly agentArgs() and agentEnv(). The sandbox guard reads the first
 * system/init event as it streams and stops the child when sandboxViolations() finds anything; `onLine`
 * sees every line too and may stop the child by returning "stop". The outcome is the transcript's result
 * event and whether the draft exists, never the exit code (the CLI exits 0 when sign-in fails).
 */
export async function runAgent(prompt: string, cfg: AgentConfig, opts: {
  timeoutMs: number; transcriptFile: string; sessionId?: string; resume?: string; onLine?: (line: string) => void | "stop";
}): Promise<AgentRun> {
  fs.mkdirSync(path.dirname(opts.transcriptFile), { recursive: true });
  fs.rmSync(opts.transcriptFile, { force: true });
  fs.rmSync(`${opts.transcriptFile}.stderr`, { force: true });
  const sessionId = opts.resume ?? opts.sessionId ?? randomUUID();
  let sawInit = false;
  let sandbox: string[] = [];
  const onLine = (line: string): void | "stop" => {
    const caller = opts.onLine?.(line);
    if (!sawInit) {
      const init = initEvent(line);
      if (init) {
        sawInit = true;
        sandbox = sandboxViolations(init);
        if (sandbox.length) return "stop";
      }
    }
    return caller;
  };
  const r = await run(cfg.bin, agentArgs(prompt, opts.resume ? { resume: opts.resume } : { sessionId }), {
    cwd: cfg.repo,
    env: agentEnv(cfg),
    timeoutMs: opts.timeoutMs,
    stdoutFile: opts.transcriptFile,
    stderrFile: `${opts.transcriptFile}.stderr`,
    killGraceMs: P3_LIMITS.killGraceMs,
    onLine,
  });
  const raw = fs.existsSync(opts.transcriptFile) ? fs.readFileSync(opts.transcriptFile, "utf8") : "";
  return { run: r, transcript: parseTranscript(raw), raw, sessionId, sandbox };
}

/**
 * `<bin> --version` within timeoutMs (default 30 s): ok when it exits 0; version is the first line of its
 * output, null when it is not ok. The environment is the agent's without the token, so the check starts
 * the CLI exactly as runAgent does and never reads JL's own config.
 */
export async function cliVersion(bin: string, timeoutMs: number = P3_LIMITS.cliVersionMs): Promise<{ ok: boolean; version: string | null }> {
  const full = agentEnv({ configDir: agentConfig("", "").configDir, token: "" });
  const env = Object.fromEntries(Object.entries(full).filter(([k]) => k !== "CLAUDE_CODE_OAUTH_TOKEN"));
  const r = await run(bin, ["--version"], { timeoutMs, env, killGraceMs: 1_000 });
  const ok = r.code === 0 && !r.timedOut;
  const first = r.stdout.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null;
  return { ok, version: ok ? first : null };
}

// ── Prompts (§8.5, §11) ─────────────────────────────────────────────────────────────────────────────

/** The {{NAME}} variables of routine/PROMPT.md (§8.5). */
export const PROMPT_VARS = ["DATE", "WINDOW_START", "WINDOW_END", "WEEKLY", "DEADLINE_LOCAL", "DRAFT_PATH", "CONTEXT_PATH",
  "PACK_MD_PATH", "SCHEMA_PATH", "STYLE_PATH", "FETCH_BUDGET", "MAX_ITEMS"] as const;
/** The {{NAME}} variables of routine/REPAIR.md (§8.5). */
export const REPAIR_VARS = ["DATE", "DEADLINE_LOCAL", "DRAFT_PATH", "CONTEXT_PATH", "SCHEMA_PATH", "STYLE_PATH", "FETCH_BUDGET",
  "ERRORS_JSON"] as const;

/** The style guide the prompts name (§11). */
export const STYLE_FILE = "routine/STYLE.md";

/**
 * Fills a routine template (§8.5, §11). The template is scanned first: every "{{" must open a
 * `{{NAME}}` placeholder with NAME in [A-Z_]+ and a string value in `vars`. Then every placeholder is
 * filled in one pass, so a value may itself hold "{{" (ERRORS_JSON quotes the agent's text). Throws
 * Error("Template: ...") naming the first problem and its line.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const lineOf = (i: number) => template.slice(0, i).split("\n").length;
  for (let i = template.indexOf("{{"); i !== -1; i = template.indexOf("{{", i + 2)) {
    const m = /^\{\{([A-Z_]+)\}\}/.exec(template.slice(i));
    if (!m) throw new Error(`Template: a stray "{{" on line ${lineOf(i)} that is not a {{NAME}} placeholder.`);
    const name = m[1]!;
    if (!Object.hasOwn(vars, name)) throw new Error(`Template: unknown variable {{${name}}} on line ${lineOf(i)}.`);
    if (typeof vars[name] !== "string") throw new Error(`Template: variable {{${name}}} on line ${lineOf(i)} has no value.`);
    i += m[0].length - 2;
  }
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, name: string) => vars[name]!);
}

/** "YYYY-MM-DD HH:MM" in Taipei of an ISO timestamp. */
function taipeiMinute(ts: string): string {
  return taipeiTimestamp(new Date(Date.parse(ts))).slice(0, 16).replace("T", " ");
}

function absUnder(root: string, p: string): string {
  return path.resolve(root, p);
}

/**
 * §8.5's values for routine/PROMPT.md: paths absolute under root (from runPaths()); WINDOW_* as
 * "YYYY-MM-DD HH:MM" Taipei from context.window; DEADLINE_LOCAL the HH:MM Taipei of context.deadline;
 * WEEKLY "true" or "false" from context.weekly. `paths` replaces the draft, context and pack paths derived
 * from the date (agent-check's canary uses its own files, plan A22); a relative one resolves against root.
 */
export function promptVars(o: {
  root: string; date: string; context: AgentContext; fetchBudget: number; maxItems: number;
  paths?: Partial<{ draft: string; context: string; packMd: string }>;
}): Record<(typeof PROMPT_VARS)[number], string> {
  const p = runPaths(o.root, o.date);
  return {
    DATE: o.date,
    WINDOW_START: taipeiMinute(o.context.window.start),
    WINDOW_END: taipeiMinute(o.context.window.end),
    WEEKLY: o.context.weekly ? "true" : "false",
    DEADLINE_LOCAL: hhmm(Date.parse(o.context.deadline)),
    DRAFT_PATH: o.paths?.draft ? absUnder(p.root, o.paths.draft) : p.draft,
    CONTEXT_PATH: o.paths?.context ? absUnder(p.root, o.paths.context) : p.contextCopy,
    PACK_MD_PATH: o.paths?.packMd ? absUnder(p.root, o.paths.packMd) : p.packMd,
    SCHEMA_PATH: absUnder(p.root, DRAFT_SCHEMA_PATH),
    STYLE_PATH: absUnder(p.root, STYLE_FILE),
    FETCH_BUDGET: String(Math.max(0, Math.floor(o.fetchBudget))),
    MAX_ITEMS: String(Math.max(0, Math.floor(o.maxItems))),
  };
}

/** The issues REPAIR.md lists (§8.5): every error, then the SNAP_* warnings, each in its original order. */
export function repairIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return [
    ...issues.filter((i) => i.severity === "error"),
    ...issues.filter((i) => i.severity === "warning" && i.code.startsWith("SNAP_")),
  ];
}

/** REPAIR.md's values; ERRORS_JSON lists the errors first, then the SNAP_* warnings, as pretty-printed ValidationIssue[]. */
export function repairVars(o: {
  root: string; date: string; context: AgentContext; fetchBudget: number; issues: readonly ValidationIssue[];
}): Record<(typeof REPAIR_VARS)[number], string> {
  const v = promptVars({ root: o.root, date: o.date, context: o.context, fetchBudget: o.fetchBudget, maxItems: 0 });
  return {
    DATE: v.DATE,
    DEADLINE_LOCAL: v.DEADLINE_LOCAL,
    DRAFT_PATH: v.DRAFT_PATH,
    CONTEXT_PATH: v.CONTEXT_PATH,
    SCHEMA_PATH: v.SCHEMA_PATH,
    STYLE_PATH: v.STYLE_PATH,
    FETCH_BUDGET: v.FETCH_BUDGET,
    ERRORS_JSON: JSON.stringify(repairIssues(o.issues), null, 2),
  };
}

/** budgets.web_fetches minus the WebFetch calls in these transcripts (never below 0). */
export function fetchBudgetLeft(budget: number, transcripts: readonly Transcript[]): number {
  const used = transcripts.reduce((n, t) => n + (t.toolUses.WebFetch ?? 0), 0);
  return Math.max(0, budget - used);
}
