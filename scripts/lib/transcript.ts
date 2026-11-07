import { extractUrls, normalizeUrl } from "../../lib/urls";

// Reads the agent's stream-json transcript (SPEC §8.13). Event shapes checked against Claude Code
// 2.1.319 on 2026-11-08: a {type:"system",subtype:"init"} event carries session_id, model,
// claude_code_version, tools, mcp_servers and permissionMode; tool calls are tool_use blocks inside
// {type:"assistant"} messages; tool output is tool_result blocks inside {type:"user"} messages;
// {type:"rate_limit_event"} carries rate_limit_info; the run ends with a {type:"result"} event whose
// is_error flag (not the exit code, and not its subtype) says whether the run failed. Copied from
// the Europe fork's scripts/lib/transcript.ts and extended.

export interface Transcript {
  sessionId: string | null;
  /** Run log only, never a status file or a committed fixture (SPEC §0.2). */
  model: string | null;
  version: string | null;
  /** URLs the agent asked WebFetch to open. */
  fetched: string[];
  /** Every URL that appeared in a tool result: search results and fetched pages. */
  resultUrls: string[];
  searches: string[];
  toolUses: Record<string, number>;
  isError: boolean | null;
  resultText: string | null;
  numTurns: number | null;
  costUsd: number | null;
  permissionDenials: number;
  authFailed: boolean;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  permissionMode: string | null;
  /** WebFetch inputs whose tool_result is not an error. */
  fetchedOk: string[];
  /** URLs in tool results, keyed by the tool that produced them. */
  urlsByTool: Record<string, string[]>;
  /** Result event usage; cache tokens count as input. */
  usage: { input: number; output: number } | null;
  /** The result event's terminal_reason, else its subtype. */
  terminalReason: string | null;
  /** Any rate_limit_event not "allowed" or "allowed_warning", or a result with api_error_status 429. */
  limitHit: boolean;
  /** The last rate_limit_event's window and utilization. */
  rateLimitUsage: { window: string; utilization: number } | null;
  safetyStops: number;
  /** Every tool_use, in order, with whether its result was an error and the denial ids. */
  calls: ToolCall[];
  /** tool_use_ids listed in the result event's permission_denials. */
  deniedIds: string[];
  /** Assistant text blocks, in order. */
  assistantText: string[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  isError: boolean | null;
  /** The tool_result text, cut to 2,000 characters; for matching restriction messages, never printed. */
  resultText: string | null;
}

type Block = { type?: string; id?: string; tool_use_id?: string; name?: string; input?: Record<string, unknown>; content?: unknown; is_error?: boolean; text?: string };

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : JSON.stringify(c))).join("\n");
  return JSON.stringify(content ?? "");
}

export function parseTranscript(jsonl: string): Transcript {
  const t: Transcript = {
    sessionId: null, model: null, version: null, fetched: [], resultUrls: [], searches: [], toolUses: {},
    isError: null, resultText: null, numTurns: null, costUsd: null, permissionDenials: 0, authFailed: false,
    tools: [], mcpServers: [], permissionMode: null, fetchedOk: [], urlsByTool: {}, usage: null,
    terminalReason: null, limitHit: false, rateLimitUsage: null, safetyStops: 0, calls: [], deniedIds: [],
    assistantText: [],
  };
  const byId = new Map<string, ToolCall>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "system" && e.subtype === "init") {
      t.sessionId ??= (e.session_id as string) ?? null;
      t.model ??= (e.model as string) ?? null;
      t.version ??= (e.claude_code_version as string) ?? null;
      if (Array.isArray(e.tools)) t.tools = (e.tools as unknown[]).map(String);
      if (Array.isArray(e.mcp_servers)) {
        t.mcpServers = (e.mcp_servers as { name?: unknown; status?: unknown }[]).map((s) => ({ name: String(s?.name ?? ""), status: String(s?.status ?? "") }));
      }
      t.permissionMode = typeof e.permissionMode === "string" ? e.permissionMode : null;
    }
    if (e.error === "authentication_failed") t.authFailed = true;
    if (e.type === "rate_limit_event") {
      const info = (e.rate_limit_info ?? {}) as { status?: string; rateLimitType?: string; unifiedWindows?: Record<string, { utilization?: number }> };
      if (info.status && info.status !== "allowed" && info.status !== "allowed_warning") t.limitHit = true;
      const window = info.rateLimitType ?? null;
      const utilization = window ? info.unifiedWindows?.[window]?.utilization : undefined;
      if (window && typeof utilization === "number") t.rateLimitUsage = { window, utilization };
    }
    const content = (e.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const block of content as Block[]) {
        if (e.type === "assistant" && block.type === "text" && typeof block.text === "string") t.assistantText.push(block.text);
        if (block.type === "tool_use" && block.name) {
          t.toolUses[block.name] = (t.toolUses[block.name] ?? 0) + 1;
          const input = block.input ?? {};
          if (block.name === "WebFetch" && typeof input.url === "string") t.fetched.push(input.url);
          if (block.name === "WebSearch" && typeof input.query === "string") t.searches.push(input.query);
          const call: ToolCall = { id: block.id ?? "", name: block.name, input, isError: null, resultText: null };
          t.calls.push(call);
          if (block.id) byId.set(block.id, call);
        }
        if (block.type === "tool_result") {
          const text = blockText(block.content);
          const urls = extractUrls(text);
          t.resultUrls.push(...urls);
          const call = block.tool_use_id ? byId.get(block.tool_use_id) : undefined;
          if (call) {
            call.isError = block.is_error === true;
            call.resultText = text.slice(0, 2_000);
            (t.urlsByTool[call.name] ??= []).push(...urls);
            if (call.name === "WebFetch" && !call.isError && typeof call.input.url === "string") t.fetchedOk.push(call.input.url);
          }
        }
      }
    }
    if (e.type === "result") {
      t.sessionId ??= (e.session_id as string) ?? null;
      t.isError = e.is_error === true;
      t.resultText = typeof e.result === "string" ? e.result : null;
      t.numTurns = typeof e.num_turns === "number" ? e.num_turns : null;
      t.costUsd = typeof e.total_cost_usd === "number" ? e.total_cost_usd : null;
      const denials = Array.isArray(e.permission_denials) ? (e.permission_denials as { tool_use_id?: unknown }[]) : [];
      t.permissionDenials = denials.length;
      t.deniedIds = denials.map((d) => String(d?.tool_use_id ?? "")).filter(Boolean);
      const u = e.usage as Record<string, unknown> | undefined;
      if (u) {
        const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
        t.usage = { input: n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens"), output: n("output_tokens") };
      }
      t.terminalReason = typeof e.terminal_reason === "string" ? e.terminal_reason : typeof e.subtype === "string" ? e.subtype : null;
      if (e.api_error_status === 429) t.limitHit = true;
      t.safetyStops = typeof e.safety_stops === "number" ? e.safety_stops : 0;
    }
  }
  return t;
}

/** Evidence URLs: pack URLs ∪ fetched URLs ∪ URLs in tool results, normalised and unique (P3 replaces this with buildEvidence). */
export function evidenceUrls(transcripts: Transcript[], packUrls: string[]): string[] {
  const all = [...packUrls, ...transcripts.flatMap((t) => [...t.fetched, ...t.resultUrls])];
  return [...new Set(all.map(normalizeUrl))].sort();
}

/**
 * Replaces every model identifier in a raw transcript with "<model>", so a transcript can be committed
 * as a fixture without one (SPEC §0.2, §8.13). The identifiers are read from the transcript itself:
 * the init event's model, every message's model and every model-usage key.
 */
export function scrubModels(jsonl: string): string {
  const ids = new Set<string>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (typeof e.model === "string") ids.add(e.model);
      const m = (e.message as { model?: unknown } | undefined)?.model;
      if (typeof m === "string") ids.add(m);
      for (const key of ["modelUsage", "model_usage_since_last_result"]) {
        const usage = e[key];
        if (usage && typeof usage === "object") for (const k of Object.keys(usage)) ids.add(k);
      }
    } catch { /* not JSON */ }
  }
  let out = jsonl;
  for (const id of [...ids].filter((s) => s && s !== "<model>").sort((a, b) => b.length - a.length)) out = out.split(id).join("<model>");
  return out;
}
