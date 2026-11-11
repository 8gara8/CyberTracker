// The fixture morning as the pipeline sees it before the agent runs (SPEC §8.2 stages 2 to 5; plan §2.5 L4):
// a temporary root holding config/, routine/ and content/state/ from fixtures/state/, a git repo for the
// metrics' code_commit, then collect() on fixtures/feeds/ at 04:37 Taipei and runMetrics() staging into
// cache/staged/D/ (as the morning does before publish), four minutes later. Shared by tests/context.test.ts
// and tests/pipeline-draft.test.ts. Offline: the feeds come from CT_FIXTURE_FEEDS and git runs only on the
// temporary repo. Everything read back is data.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type LoadedConfig } from "@/lib/config";
import { at } from "@/lib/dates";
import { metricsFor, readHistory, regionsBaseFor, standingLast } from "@/lib/run-inputs";
import type { RegionsBase } from "@/lib/rules/types";
import type { Brief } from "@/lib/schema/brief";
import type { Metrics } from "@/lib/schema/metrics";
import { CandidatesFile, Pack } from "@/lib/schema/pack";
import { collect } from "@/scripts/collect";
import { runPaths, type RunPaths } from "@/scripts/lib/paths";
import { runMetrics } from "@/scripts/metrics";
import { PIPELINE_DATE, REPO, TEST_IDENTITY } from "./harness";

export interface PipelineWorld {
  root: string;
  date: string;
  /** at(D, "04:37"): when collect ran. */
  start: number;
  paths: RunPaths;
  config: LoadedConfig;
  pack: Pack;
  candidates: CandidatesFile;
  metrics: Metrics;
  metricsText: string;
  regionsBase: RegionsBase;
  history: Brief[];
  standingLast: Record<string, { date: string; item_id: string }>;
  /** Restores the environment and removes the root. */
  dispose(): void;
}

/** collect at 04:37 Taipei, metrics at 04:41 (staged), for PIPELINE_DATE. About two seconds. */
export async function buildPipelineWorld(): Promise<PipelineWorld> {
  const date = PIPELINE_DATE;
  const start = at(date, "04:37");
  const keys = ["CT_FIXTURE_FEEDS", "CT_CONTENT_DIR", "NODE_ENV"] as const;
  const saved = new Map(keys.map((k) => [k, process.env[k]] as const));
  const env = process.env as Record<string, string | undefined>;
  const restore = () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  };
  env.CT_FIXTURE_FEEDS = path.join(REPO, "fixtures", "feeds");
  env.NODE_ENV = "test";
  delete env.CT_CONTENT_DIR;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ct-pipeline-world-")));
  try {
    fs.cpSync(path.join(REPO, "config"), path.join(root, "config"), { recursive: true });
    fs.cpSync(path.join(REPO, "routine"), path.join(root, "routine"), { recursive: true });
    fs.cpSync(path.join(REPO, "fixtures", "state"), path.join(root, "content", "state"), { recursive: true });
    fs.writeFileSync(path.join(root, ".gitignore"), "/cache/\n/packs/\n/logs/\n/drafts/\n");
    const sh = (...args: string[]) => execFileSync("git", [
      "-c", `user.name=${TEST_IDENTITY.name}`, "-c", `user.email=${TEST_IDENTITY.email}`, "-c", "commit.gpgsign=false", ...args,
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    sh("init", "-q", "-b", "main");
    sh("add", "-A");
    sh("commit", "-q", "-m", "fixture state", "--date", "2026-10-13T12:00:00Z");

    let clock = start;
    await collect({ date, deadline: start + 300_000, root, deps: { now: () => clock } });
    clock += 4 * 60_000;
    const r = await runMetrics({ date, root, now: new Date(clock) });
    if (r.code !== 0) throw new Error(`buildPipelineWorld: runMetrics exited ${r.code}: ${r.lines.join(" | ")}`);

    const paths = runPaths(root, date);
    const config = loadConfig({ root, fresh: true });
    const pack = Pack.parse(JSON.parse(fs.readFileSync(paths.pack, "utf8")));
    const candidates = CandidatesFile.parse(JSON.parse(fs.readFileSync(paths.packCandidates, "utf8")));
    const m = metricsFor(root, paths.content, date);
    if (!m) throw new Error("buildPipelineWorld: no staged metrics");
    return {
      root, date, start, paths, config, pack, candidates,
      metrics: m.metrics,
      metricsText: m.text,
      regionsBase: regionsBaseFor({ root, contentDir: paths.content, date, pack, config }),
      history: readHistory(paths.content, date, 14),
      standingLast: standingLast(paths.content, date),
      dispose: () => {
        restore();
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (e) {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

/**
 * A stream-json transcript in the shape scripts/lib/transcript.ts reads (SPEC §8.12), as the fake agent
 * reports one: each `fetches` URL a WebFetch call with a non-error result, each `failed` URL a WebFetch
 * call whose result is an error, and each `searches` entry a WebSearch call whose result lists its URLs.
 * No model field. For tests/evidence.test.ts and tests/pipeline-draft.test.ts.
 */
export function transcriptJsonl(o: { fetches?: readonly string[]; failed?: readonly string[]; searches?: readonly { query: string; urls: readonly string[] }[] }): string {
  const lines: unknown[] = [{ type: "system", subtype: "init", session_id: "ct-test-session", tools: ["Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"], mcp_servers: [] }];
  let n = 0;
  const call = (name: string, input: Record<string, unknown>, result: string, isError: boolean) => {
    const id = `toolu_ct_${++n}`;
    lines.push({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
    lines.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: result, is_error: isError }] } });
  };
  for (const url of o.fetches ?? []) call("WebFetch", { url, prompt: "Summarise the page." }, "SAMPLE page summary.", false);
  for (const url of o.failed ?? []) call("WebFetch", { url, prompt: "Summarise the page." }, "Request failed with status code 403", true);
  for (const s of o.searches ?? []) call("WebSearch", { query: s.query }, s.urls.map((u, k) => `${k + 1}. SAMPLE result ${u}`).join("\n"), false);
  lines.push({ type: "result", subtype: "success", is_error: false, num_turns: n + 1, result: "Draft written." });
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}
