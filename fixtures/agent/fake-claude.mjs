#!/usr/bin/env node
// Test stand-in for the Claude CLI (SPEC §8.2 Tests; plan §2.2, A14, A22). tests/helpers/harness.ts runs it
// through a POSIX sh wrapper script at CT_CLAUDE_BIN, because the agent's PATH has no Node on CI. It never touches
// the network or the keychain. It prints stream-json events in the shapes of fixtures/agent/transcript-ok.jsonl
// and writes the draft the prompt names from its config. The agent's environment is minimal by design, so
// the config comes from $CLAUDE_CONFIG_DIR/fake-agent.json (FakeAgentConfig in tests/helpers/harness.ts):
//   mode        "ok" | "nodraft" | "auth" | "mcp" | "limit" | "repair" (default "ok")
//   draft       the JSON value written as the draft (ok: on --session-id; on --resume when no repair)
//   invalidDraft  repair mode: written on --session-id in place of draft when given
//   repair      the JSON value written on --resume
//   fetches     URLs reported as WebFetch calls, each with a non-error tool_result
//   searches    how many WebSearch calls to report
//   delayMs     sleep before the result event
//   version     what --version prints (default "2.1.316 (Claude Code)")
//   touch       absolute paths created (empty) just before the draft step
//   draftPath   the draft path, in place of the one found in the prompt
//   resumeMode  the mode of a --resume call, in place of mode ("mcp", "auth" or "limit": a repair the run must stop on)
// The result text is "OK" for agent-check's smoke prompts and "DONE" for every other prompt.
// Every call, --version included, appends { argv, envKeys, cwd } (environment names only, never values) to
// $CLAUDE_CONFIG_DIR/calls.jsonl. Adapted from the Europe fork's fixtures/agent/fake-claude.mjs.
import fs from "node:fs";
import path from "node:path";

const TOOLS = ["WebSearch", "WebFetch", "Read", "Glob", "Grep", "Write", "Edit"];
const DEFAULT_VERSION = "2.1.316 (Claude Code)";
const DRAFT_RE = /[^\s`'"()<>]*drafts\/\d{4}-\d{2}-\d{2}\.json/;

const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR ?? null;
const cfgFile = configDir ? path.join(configDir, "fake-agent.json") : null;
const cfg = cfgFile && fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : {};

if (configDir && fs.existsSync(configDir)) {
  const call = { argv: args, envKeys: Object.keys(process.env).sort(), cwd: process.cwd() };
  fs.appendFileSync(path.join(configDir, "calls.jsonl"), `${JSON.stringify(call)}\n`);
}

if (!args.includes("-p") && (args.includes("--version") || args.includes("-v"))) {
  process.stdout.write(`${cfg.version ?? DEFAULT_VERSION}\n`);
  process.exit(0);
}

const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] ?? null : null);
const prompt = after("-p") ?? "";
const resume = after("--resume");
const sessionId = resume ?? after("--session-id") ?? "00000000-0000-4000-8000-000000000000";
const mode = (resume && cfg.resumeMode) || (cfg.mode ?? "ok");
const version = String(cfg.version ?? DEFAULT_VERSION).split(/\s+/)[0];

const emit = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let turns = 1;
let toolId = 0;

function toolCall(name, input, resultText) {
  const id = `toolu_fake_${String(++toolId).padStart(3, "0")}`;
  emit({ type: "assistant", message: { model: "<model>", role: "assistant", content: [{ type: "tool_use", id, name, input }] }, session_id: sessionId });
  emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: resultText }] }, session_id: sessionId });
  turns += 1;
}

function result(isError, text) {
  emit({
    type: "result", subtype: "success", is_error: isError, result: text, num_turns: turns, session_id: sessionId,
    total_cost_usd: 0, permission_denials: [], terminal_reason: isError ? "api_error" : "completed",
    usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200 },
  });
}

/** The value to write as the draft on this call, or undefined for none. */
function draftValue() {
  if (mode === "nodraft") return undefined;
  if (mode === "repair") return resume ? cfg.repair : (cfg.invalidDraft ?? cfg.draft);
  return resume ? (cfg.repair ?? cfg.draft) : cfg.draft;
}

async function main() {
  const tools = mode === "mcp" ? [...TOOLS, "mcp__probe__x"] : TOOLS;
  emit({
    type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId, tools, mcp_servers: [], model: "<model>",
    permissionMode: "dontAsk", claude_code_version: version, apiKeySource: "none",
  });

  if (mode === "mcp") {
    // The sandbox guard must stop this call: stay alive until a signal ends the process.
    setInterval(() => {}, 1_000);
    return;
  }
  if (mode === "auth") {
    emit({ type: "assistant", error: "authentication_failed", message: { model: "<model>", role: "assistant", content: [{ type: "text", text: "Not logged in · Please run /login" }] }, session_id: sessionId });
    result(true, "Not logged in · Please run /login");
    process.exit(0);
  }
  if (mode === "limit") {
    emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: 1 }, session_id: sessionId });
    emit({ type: "assistant", message: { model: "<model>", role: "assistant", content: [{ type: "text", text: "Usage limit reached." }] }, session_id: sessionId });
    result(true, "Usage limit reached.");
    process.exit(1);
  }

  for (const url of cfg.fetches ?? []) toolCall("WebFetch", { url, prompt: "Read the page." }, "SAMPLE page text.");
  for (let i = 1; i <= (cfg.searches ?? 0); i += 1) toolCall("WebSearch", { query: `sample search ${i}` }, "SAMPLE search results.");

  for (const p of cfg.touch ?? []) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "");
  }

  const value = draftValue();
  const target = cfg.draftPath ?? prompt.match(DRAFT_RE)?.[0] ?? null;
  if (value !== undefined && target) {
    const file = path.resolve(process.cwd(), target);
    toolCall("Write", { file_path: file }, `File created successfully at: ${file}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  // agent-check's smoke prompts ("Reply with the single word OK.", "Reply OK.") get OK, every other prompt DONE.
  const reply = /^Reply (?:with the single word )?OK\.?$/.test(prompt.trim()) ? "OK" : "DONE";
  emit({ type: "assistant", message: { model: "<model>", role: "assistant", content: [{ type: "text", text: reply }] }, session_id: sessionId });
  if (cfg.delayMs) await sleep(cfg.delayMs);
  result(false, reply);
}

main().catch((e) => {
  process.stderr.write(`fake-claude: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
