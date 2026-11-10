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
