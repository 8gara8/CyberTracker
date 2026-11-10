// The shared end-to-end harness of P3 (plan §4; SPEC §8.2 "Tests", §8.7 "Tests"): a temporary folder with a
// bare remote standing in for GitHub and a clone as ROOT, whose content/ holds only state/, copied from
// fixtures/state/. Used by tests/publish.test.ts (through tests/helpers/publish-world.ts), the prepareGit
// cases of tests/preflight.test.ts and tests/daily.test.ts. Nothing here touches the network, the keychain
// or a real agent: pushes go to the bare remote, whose pre-receive hook rejects or slows them on marker
// files; the agent is fixtures/agent/fake-claude.mjs behind a #!/bin/sh wrapper (the agent's PATH has no
// Node on CI); every fetch the stages make outside fetchFeed() goes to the router behind deps.fetchImpl,
// which throws on any URL it does not know. Everything a test reads back from the remote is data.
// Written by step S0 and frozen.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import run from "@/config/run.json";
import { at, isValidDate } from "@/lib/dates";
import { sha256Hex } from "@/lib/json";
import { siteUrl } from "@/lib/site";
import { testClock, type Clock, type TestClock } from "@/scripts/lib/clock";
import type { EditionMeta } from "@/scripts/lib/deploy";
import type { Sleep } from "@/scripts/publish";

/** The fixture morning the pipeline tests run (collect and metrics work in-process on fixtures/feeds for it). */
export const PIPELINE_DATE = "2026-10-14";

/** The repository holding this file: where fixtures/, config/ and routine/ are read from. */
export const REPO = path.resolve(__dirname, "..", "..");

/** fixtures/agent/fake-claude.mjs, the fake agent CLI (lane L1). */
export const FAKE_CLAUDE = path.join(REPO, "fixtures", "agent", "fake-claude.mjs");

/** The test identity: commits the harness makes (the seed, commitOnRemote, h.git) carry it. */
export const TEST_IDENTITY = { name: "ct-test", email: "ct-test@example.invalid" } as const;

/**
 * $CLAUDE_CONFIG_DIR/fake-agent.json, what the fake agent does on its next calls (plan §2.2, A14, A22).
 * The fake appends `{ argv, envKeys, cwd }` (names only) per call to $CLAUDE_CONFIG_DIR/calls.jsonl.
 */
export interface FakeAgentConfig {
  /**
   * ok: writes `draft` on --session-id and `repair ?? draft` on --resume. nodraft: writes nothing, result
   * not an error. auth: an assistant message with error "authentication_failed", then is_error true, exit
   * 0. mcp: init lists mcp__probe__x, then sleeps until killed. limit: a rate_limit_event with
   * rate_limit_info { status: "rejected", rateLimitType: "five_hour", utilization: 1 }, then is_error true.
   * repair: writes `invalidDraft ?? draft` (invalid) first, `repair` on --resume.
   */
  mode: "ok" | "nodraft" | "auth" | "mcp" | "limit" | "repair";
  /** The mode of --resume calls (a repair round); default `mode`. "mcp", "auth" or "limit": a repair the run must stop on. */
  resumeMode?: "ok" | "nodraft" | "auth" | "mcp" | "limit";
  /** The modes of the first, second, ... --session-id calls (one per attempt); default `mode`. */
  attemptModes?: ("ok" | "nodraft" | "auth" | "mcp" | "limit" | "repair")[];
  /** The draft JSON the fake writes (a parsed value, written as JSON). */
  draft?: unknown;
  /**
   * repair mode only: the invalid first draft, written on --session-id in place of `draft` when given
   * (plan §2.2 has repair mode write `draft` first; this name, from the S0 task text, says the same more plainly).
   */
  invalidDraft?: unknown;
  /** The draft written on --resume. */
  repair?: unknown;
  /** URLs reported as WebFetch calls, each with a non-error tool_result. */
  fetches?: string[];
  /** How many WebSearch calls to report. */
  searches?: number;
  /** Sleeps this long before the result event. */
  delayMs?: number;
  /** What --version prints; default "2.1.316 (Claude Code)". */
  version?: string;
  /** Absolute paths the fake creates (empty files) before it writes the draft (A14: switch the push mode mid-run). */
  touch?: string[];
  /** Overrides the draft path the fake takes from the prompt (A22: the canary's own draft file). */
  draftPath?: string;
}

/** One call the fake agent recorded: its argv, the names (never values) of its environment, its cwd. */
export interface AgentCall {
  argv: string[];
  envKeys: string[];
  cwd: string;
}

/** How the stand-in GitHub treats pushes from now on (marker files in base). */
export type PushMode = "accept" | "reject" | "reject-briefs" | { slowSeconds: number; reject?: boolean };

export interface Harness {
  /** mkdtemp */
  base: string;
  /** <base>/remote.git, bare, default branch main; Deps.repo */
  remote: string;
  /** <base>/work, the clone; ROOT for daily.ts and publish */
  root: string;
  /** <base>/claude: CT_CLAUDE_CONFIG_DIR; fake-agent.json and calls.jsonl live here */
  claudeDir: string;
  /** testClock(at(date, start)) */
  clock: TestClock;
  /** The edition date the harness was made for. */
  date: string;
  /**
   * Applied by inRoot(): CT_FIXTURE_FEEDS=<repo>/fixtures/feeds, CT_CLAUDE_BIN=<base>/bin/claude,
   * CT_CLAUDE_CONFIG_DIR=claudeDir, CT_DEPLOY_WAIT_MS=0, NODE_ENV=test; CT_CONTENT_DIR and CT_REEXEC unset.
   */
  env: Record<string, string>;
  /** sleep: publish's push retry waits, instant here, each wait recorded for waits(). */
  deps: { now: Clock; fetchImpl: typeof fetch; readToken: () => Promise<string | null>; repo: string; arch: "arm64"; sleep: Sleep };
  /** The push retry waits deps.sleep was asked for, in ms, oldest first. */
  waits(): number[];
  /** git in root, with the test identity; stdout with its end trimmed. Throws on a non-zero exit. */
  git(...args: string[]): string;
  /** Commits on remote main after the seed, oldest first. */
  remoteLog(): { sha: string; subject: string; files: string[] }[];
  /** `git show main:<path>` in the remote, byte for byte; null when absent. */
  remoteFile(path: string): string | null;
  /** Marker files in base that the pre-receive hook reads. */
  pushes(mode: PushMode): void;
  /** Writes claudeDir/fake-agent.json (replacing it). */
  fakeAgent(cfg: FakeAgentConfig): void;
  /** claudeDir/calls.jsonl, oldest first; [] before any call. */
  agentCalls(): AgentCall[];
  /** What deps.readToken returns (default "test-token"). */
  token(value: string | null): void;
  /** What the router answers for the intake URL (default []; "fail" gives 503). */
  issues(list: unknown[] | "fail"): void;
  /** The router's answer for `${siteUrl()}/` (default "from-remote": built from the remote's briefs/D.json, 404 when absent). */
  site(meta: EditionMeta | null | "from-remote"): void;
  /** Every request the router answered or refused, in order (an addition to plan §4, for assertions). */
  requests(): { method: string; url: string }[];
  /** A commit on remote main through a scratch clone (e.g. a code commit touching scripts/); the hook is not run. Returns its sha. */
  commitOnRemote(files: Record<string, string>, subject: string): string;
  /** node_modules/.ct-lock-sha in root: the SHA-256 of package-lock.json when match, else another value. */
  writeLockSha(match: boolean): void;
  /** Removes base (leaving it first if the process is inside it). */
  dispose(): void;
}

export interface HarnessOptions {
  /** Edition date; default PIPELINE_DATE. */
  date?: string;
  /** Taipei "HH:MM" the test clock starts at; default "04:37". */
  start?: string;
  /**
   * Writes more files into h.root before the seed commit (it must not commit): they become part of the one
   * `seed` commit, so remoteLog() leaves them out.
   */
  seed?: (h: Harness) => void;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ID_ARGS = ["-c", `user.name=${TEST_IDENTITY.name}`, "-c", `user.email=${TEST_IDENTITY.email}`, "-c", "commit.gpgsign=false"];
/**
 * Every harness git call, and the clone's own config, turn push negotiation off: a machine's global
 * push.negotiate=true makes each push to the bare remote print a negotiation failure. Global config is
 * never changed.
 */
export const QUIET_PUSH_ARGS = ["-c", "push.negotiate=false"] as const;

function gitRaw(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...QUIET_PUSH_ARGS, ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** Only the end is trimmed: `status --porcelain` lines start with a meaningful space. */
const gitIn = (cwd: string, args: readonly string[]) => gitRaw(cwd, args).replace(/\s+$/, "");

/** The pre-receive hook: sleeps on slow-pushes, rejects on reject-pushes, rejects a range with a `brief: ` subject on reject-briefs. Fixed text only. */
function hookScript(base: string): string {
  return [
    "#!/bin/sh",
    "# The stand-in GitHub of the P3 tests (tests/helpers/harness.ts). Prints only fixed text.",
    `base=${shq(base)}`,
    'if [ -f "$base/slow-pushes" ]; then sleep "$(cat "$base/slow-pushes")"; fi',
    'if [ -f "$base/reject-pushes" ]; then echo "harness: pushes are rejected" >&2; exit 1; fi',
    'if [ -f "$base/reject-briefs" ]; then',
    "  while read -r old new ref; do",
    '    case "$new" in *[!0]*) ;; *) continue ;; esac',
    '    case "$old" in *[!0]*) range="$old..$new" ;; *) range="$new" ;; esac',
    `    if git log --format=%s "$range" | grep -q '^brief: '; then echo "harness: brief commits are rejected" >&2; exit 1; fi`,
    "  done",
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

const MARKERS = ["reject-pushes", "reject-briefs", "slow-pushes"] as const;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function editionHtml(meta: EditionMeta): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta name="ct-edition" content="${meta.date} ${meta.edition} ${meta.published_at}">`,
    "<title>CyberTracker</title></head><body><p>Harness site.</p></body></html>",
    "",
  ].join("\n");
}

export function makeHarness(o: HarnessOptions = {}): Harness {
  const date = o.date ?? PIPELINE_DATE;
  const start = o.start ?? "04:37";
  if (!isValidDate(date)) throw new Error(`makeHarness: invalid date ${date}`);
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ct-harness-")));
  const remote = path.join(base, "remote.git");
  const root = path.join(base, "work");
  const claudeDir = path.join(base, "claude");
  const bin = path.join(base, "bin", "claude");
  const clock = testClock(at(date, start));

  let token: string | null = "test-token";
  let issueList: unknown[] | "fail" = [];
  let siteMode: EditionMeta | null | "from-remote" = "from-remote";
  let seedSha = "";
  const seen: { method: string; url: string }[] = [];
  const waits: number[] = [];
  const sleep: Sleep = async (ms) => {
    waits.push(ms);
  };

  const remoteFile = (p: string): string | null => {
    try {
      return gitRaw(remote, ["show", `main:${p}`]);
    } catch {
      return null;
    }
  };

  const intakePrefix = `https://api.github.com/repos/${run.repos.repo}/issues?`;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    seen.push({ method, url });
    if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    if (method === "HEAD" && (url === "https://github.com" || url === "https://github.com/")) return new Response(null, { status: 200 });
    if (method === "GET" && url.startsWith(intakePrefix)) {
      if (issueList === "fail") return new Response("unavailable", { status: 503, headers: { "Content-Type": "text/plain" } });
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      return Response.json(page >= 2 ? [] : issueList);
    }
    if (method === "GET" && url === `${siteUrl()}/`) {
      let meta: EditionMeta | null = null;
      if (siteMode === "from-remote") {
        const text = remoteFile(`content/briefs/${date}.json`);
        if (text !== null) {
          try {
            const b = JSON.parse(text) as { date?: unknown; edition?: unknown; published_at?: unknown };
            if (typeof b.date === "string" && typeof b.edition === "string" && typeof b.published_at === "string") {
              meta = { date: b.date, edition: b.edition as EditionMeta["edition"], published_at: b.published_at };
            }
          } catch {
            meta = null;
          }
        }
      } else {
        meta = siteMode;
      }
      if (!meta) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
      return new Response(editionHtml(meta), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    throw new TypeError(`harness router: unexpected ${method} ${url}`);
  }) as typeof fetch;

  const h: Harness = {
    base,
    remote,
    root,
    claudeDir,
    clock,
    date,
    env: {
      CT_FIXTURE_FEEDS: path.join(REPO, "fixtures", "feeds"),
      CT_CLAUDE_BIN: bin,
      CT_CLAUDE_CONFIG_DIR: claudeDir,
      CT_DEPLOY_WAIT_MS: "0",
      NODE_ENV: "test",
    },
    deps: { now: clock, fetchImpl, readToken: async () => token, repo: remote, arch: "arm64", sleep },
    waits: () => [...waits],
    git: (...args) => gitIn(root, [...ID_ARGS, ...args]),
    remoteLog() {
      const out = gitIn(remote, ["log", "--reverse", "--format=%H%x1f%s", `${seedSha}..main`]);
      if (!out) return [];
      return out.split("\n").map((line) => {
        const [sha, subject] = line.split("\x1f") as [string, string];
        const files = gitIn(remote, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha]).split("\n").filter(Boolean);
        return { sha, subject, files };
      });
    },
    remoteFile,
    pushes(mode) {
      for (const m of MARKERS) fs.rmSync(path.join(base, m), { force: true });
      if (mode === "accept") return;
      if (mode === "reject") fs.writeFileSync(path.join(base, "reject-pushes"), "");
      else if (mode === "reject-briefs") fs.writeFileSync(path.join(base, "reject-briefs"), "");
      else {
        if (!Number.isFinite(mode.slowSeconds) || mode.slowSeconds < 0) throw new Error(`pushes: invalid slowSeconds ${mode.slowSeconds}`);
        fs.writeFileSync(path.join(base, "slow-pushes"), `${mode.slowSeconds}\n`);
        if (mode.reject) fs.writeFileSync(path.join(base, "reject-pushes"), "");
      }
    },
    fakeAgent(cfg) {
      fs.writeFileSync(path.join(claudeDir, "fake-agent.json"), `${JSON.stringify(cfg, null, 2)}\n`);
    },
    agentCalls() {
      const file = path.join(claudeDir, "calls.jsonl");
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AgentCall);
    },
    token(value) {
      token = value;
    },
    issues(list) {
      issueList = list;
    },
    site(meta) {
      siteMode = meta;
    },
    requests: () => seen.map((r) => ({ ...r })),
    commitOnRemote(files, subject) {
      const dir = fs.mkdtempSync(path.join(base, "scratch-"));
      try {
        gitIn(base, ["clone", "-q", "--branch", "main", remote, dir]);
        for (const [rel, text] of Object.entries(files)) {
          const file = path.join(dir, rel);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, text);
        }
        gitIn(dir, ["add", "-A"]);
        gitIn(dir, [...ID_ARGS, "commit", "-q", "-m", subject]);
        const sha = gitIn(dir, ["rev-parse", "HEAD"]);
        // A fetch into the bare repository moves main without running its pre-receive hook.
        gitIn(remote, ["fetch", "-q", dir, "refs/heads/main:refs/heads/main"]);
        return sha;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    writeLockSha(match) {
      const lock = fs.readFileSync(path.join(root, "package-lock.json"));
      const file = path.join(root, "node_modules", ".ct-lock-sha");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, match ? sha256Hex(lock) : sha256Hex("a package-lock.json from an earlier npm ci"));
    },
    dispose() {
      const rel = path.relative(base, process.cwd());
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) process.chdir(REPO);
      fs.rmSync(base, { recursive: true, force: true });
    },
  };

  try {
    // The stand-in GitHub: bare, default branch main, its hooks read from its own hooks folder whatever
    // the machine's global core.hooksPath says.
    gitIn(base, ["init", "-q", "--bare", "-b", "main", remote]);
    gitIn(remote, ["config", "core.hooksPath", path.join(remote, "hooks")]);

    // The clone and its seed commit: .gitignore, config/, routine/, package-lock.json, content/state/ from
    // fixtures/state/ and a placeholder scripts/README.txt; no content/README.md.
    fs.mkdirSync(root);
    gitIn(root, ["init", "-q", "-b", "main"]);
    gitIn(root, ["config", "commit.gpgsign", "false"]);
    // publish's own pushes from the clone read this, not the harness's -c.
    gitIn(root, ["config", "push.negotiate", "false"]);
    gitIn(root, ["remote", "add", "origin", remote]);
    fs.copyFileSync(path.join(REPO, ".gitignore"), path.join(root, ".gitignore"));
    fs.cpSync(path.join(REPO, "config"), path.join(root, "config"), { recursive: true });
    fs.cpSync(path.join(REPO, "routine"), path.join(root, "routine"), { recursive: true });
    fs.copyFileSync(path.join(REPO, "package-lock.json"), path.join(root, "package-lock.json"));
    fs.cpSync(path.join(REPO, "fixtures", "state"), path.join(root, "content", "state"), { recursive: true });
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "README.txt"), "A placeholder, so a test can make a code commit touching scripts/.\n");
    o.seed?.(h);
    gitIn(root, ["add", "-A"]);
    gitIn(root, [...ID_ARGS, "commit", "-q", "-m", "seed"]);
    gitIn(root, ["push", "-q", "-u", "origin", "main"]);
    seedSha = gitIn(root, ["rev-parse", "HEAD"]);

    fs.writeFileSync(path.join(remote, "hooks", "pre-receive"), hookScript(base), { mode: 0o755 });
    h.writeLockSha(true);

    // The agent's PATH has no Node on CI, so the fake CLI starts through a wrapper that execs this Node.
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(FAKE_CLAUDE)} "$@"\n`, { mode: 0o755 });
    fs.mkdirSync(claudeDir, { mode: 0o700 });
  } catch (e) {
    fs.rmSync(base, { recursive: true, force: true });
    throw e;
  }
  return h;
}

/** Runs fn with the process in h.root and h.env applied (CT_CONTENT_DIR and CT_REEXEC unset); both restored after, also on a throw. */
export async function inRoot<T>(h: Harness, fn: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  const keys = [...new Set([...Object.keys(h.env), "CT_CONTENT_DIR", "CT_REEXEC"])];
  const saved = new Map(keys.map((k) => [k, process.env[k]] as const));
  process.chdir(h.root);
  for (const [k, v] of Object.entries(h.env)) process.env[k] = v;
  delete process.env.CT_CONTENT_DIR;
  delete process.env.CT_REEXEC;
  try {
    return await fn();
  } finally {
    process.chdir(cwd);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
