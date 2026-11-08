import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evidenceUrls, parseTranscript, scrubModels } from "@/scripts/lib/transcript";

const dir = path.join(__dirname, "..", "fixtures", "agent");
const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
const lines = (events: object[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

describe("the recorded transcript (fixtures/agent/transcript-ok.jsonl)", () => {
  const t = parseTranscript(read("transcript-ok.jsonl"));

  it("reads the init event", () => {
    expect(t.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.version).toBe("2.1.319");
    expect([...t.tools].sort()).toEqual(["Edit", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "Write"]);
    expect(t.mcpServers).toEqual([]);
    expect(t.permissionMode).toBe("dontAsk");
  });
  it("carries the placeholder, never a model identifier", () => {
    expect(t.model).toBe("<model>");
  });
  it("reads the result event", () => {
    expect(t.isError).toBe(false);
    expect(t.authFailed).toBe(false);
    expect(t.resultText).toBe("OK");
    expect(t.numTurns).toBe(1);
    expect(typeof t.costUsd).toBe("number");
    expect(t.permissionDenials).toBe(0);
    expect(t.deniedIds).toEqual([]);
    expect(t.terminalReason).toBe("completed");
    expect(t.safetyStops).toBe(0);
    expect(t.usage).not.toBeNull();
    expect(t.usage!.input).toBeGreaterThan(0);
    expect(t.usage!.output).toBeGreaterThan(0);
  });
  it("reads the rate-limit event", () => {
    expect(t.limitHit).toBe(false);
    expect(t.rateLimitUsage?.window).toBe("seven_day");
    expect(t.rateLimitUsage?.utilization).toBeGreaterThanOrEqual(0);
    expect(t.rateLimitUsage?.utilization).toBeLessThanOrEqual(1);
  });
  it("has no tool calls on a one-word reply", () => {
    expect(t.calls).toEqual([]);
    expect(t.toolUses).toEqual({});
    expect([t.fetched, t.fetchedOk, t.searches, t.resultUrls]).toEqual([[], [], [], []]);
    expect(t.urlsByTool).toEqual({});
    expect(t.assistantText).toEqual(["OK"]);
  });
});

describe("Europe's sign-in failure (fixtures/agent/transcript-auth-failed.jsonl, an older CLI)", () => {
  const t = parseTranscript(read("transcript-auth-failed.jsonl"));
  it("is an auth failure even though the CLI exits 0", () => {
    expect(t.authFailed).toBe(true);
    expect(t.isError).toBe(true);
    expect(t.model).toBe("<model>");
    expect(t.usage).toBeNull();
  });
});

describe("no committed transcript holds a model identifier", () => {
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    it(name, () => {
      const raw = read(name);
      expect(scrubModels(raw)).toBe(raw);
      for (const line of raw.split("\n").filter((l) => l.trim().startsWith("{"))) {
        const e = JSON.parse(line) as Record<string, unknown>;
        if ("model" in e) expect(e.model).toBe("<model>");
        const m = (e.message as { model?: unknown } | undefined)?.model;
        if (m !== undefined) expect(m).toBe("<model>");
        for (const key of ["modelUsage", "model_usage_since_last_result"]) {
          if (e[key] && typeof e[key] === "object") expect(Object.keys(e[key] as object).every((k) => k === "<model>")).toBe(true);
        }
      }
    });
  }
});

describe("a synthetic run with tools, denials and a limit", () => {
  const raw = lines([
    { type: "system", subtype: "init", session_id: "s-1", model: "test-model-7", claude_code_version: "9.9.9", tools: ["WebFetch", "WebSearch", "Read"], mcp_servers: [{ name: "x", status: "connected" }], permissionMode: "default" },
    { type: "assistant", message: { model: "test-model-7", content: [
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "t1", name: "WebSearch", input: { query: "KEV added" } },
      { type: "tool_use", id: "t2", name: "WebFetch", input: { url: "https://www.cisa.gov/a" } },
      { type: "tool_use", id: "t3", name: "WebFetch", input: { url: "https://www.exploit-db.com/" } },
    ] } },
    { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Results: https://therecord.media/a, https://www.securityweek.com/b" }] },
      { type: "tool_result", tool_use_id: "t2", content: "Page text https://www.cisa.gov/known-exploited-vulnerabilities-catalog" },
      { type: "tool_result", tool_use_id: "t3", is_error: true, content: "Claude Code is unable to fetch from www.exploit-db.com" },
    ] } },
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", unifiedWindows: { seven_day: { utilization: 1 } } } },
    { type: "result", subtype: "error_during_execution", is_error: true, result: "stopped", num_turns: 3, total_cost_usd: 0.5, session_id: "s-1",
      permission_denials: [{ tool_use_id: "t3" }], usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 7 },
      api_error_status: 429, safety_stops: 2, modelUsage: { "test-model-7": { inputTokens: 10 } } },
  ]);
  const t = parseTranscript(raw);

  it("matches every result to its call", () => {
    expect(t.calls.map((c) => [c.id, c.name, c.isError])).toEqual([["t1", "WebSearch", false], ["t2", "WebFetch", false], ["t3", "WebFetch", true]]);
    expect(t.toolUses).toEqual({ WebSearch: 1, WebFetch: 2 });
    expect(t.searches).toEqual(["KEV added"]);
    expect(t.fetched).toEqual(["https://www.cisa.gov/a", "https://www.exploit-db.com/"]);
    expect(t.fetchedOk).toEqual(["https://www.cisa.gov/a"]);
    expect(t.urlsByTool.WebSearch).toEqual(["https://therecord.media/a", "https://www.securityweek.com/b"]);
    expect(t.urlsByTool.WebFetch).toEqual(["https://www.cisa.gov/known-exploited-vulnerabilities-catalog"]);
    expect(t.resultUrls).toHaveLength(3);
    expect(t.assistantText).toEqual(["Looking."]);
  });
  it("reads denials, usage, limits and stops", () => {
    expect(t.permissionDenials).toBe(1);
    expect(t.deniedIds).toEqual(["t3"]);
    expect(t.usage).toEqual({ input: 35, output: 7 });
    expect(t.limitHit).toBe(true);
    expect(t.rateLimitUsage).toEqual({ window: "seven_day", utilization: 1 });
    expect(t.terminalReason).toBe("error_during_execution");
    expect(t.safetyStops).toBe(2);
    expect(t.mcpServers).toEqual([{ name: "x", status: "connected" }]);
    expect(t.permissionMode).toBe("default");
  });
  it("prefers terminal_reason over the subtype", () => {
    expect(parseTranscript(lines([{ type: "result", subtype: "success", terminal_reason: "max_turns", is_error: false }])).terminalReason).toBe("max_turns");
  });
  it("scrubs every model identifier, from init, messages and usage keys", () => {
    const scrubbed = scrubModels(raw);
    expect(scrubbed).not.toContain("test-model-7");
    expect(scrubbed.split("<model>").length - 1).toBe(3);
    expect(parseTranscript(scrubbed).model).toBe("<model>");
  });
  it("collects normalised evidence URLs", () => {
    expect(evidenceUrls([t], ["https://www.cisa.gov/a/"])).toEqual([
      "https://cisa.gov/a",
      "https://cisa.gov/known-exploited-vulnerabilities-catalog",
      "https://exploit-db.com",
      "https://securityweek.com/b",
      "https://therecord.media/a",
    ]);
  });
});
