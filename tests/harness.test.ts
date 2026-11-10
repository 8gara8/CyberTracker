// The shared P3 harness (tests/helpers/harness.ts, plan §4): the bare remote and its clone, the seed
// commit, the pre-receive hook's modes, the router behind deps.fetchImpl and inRoot(). Every case makes
// its own temporary folder and removes it. Nothing here reaches the network or runs an agent.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import run from "@/config/run.json";
import { at } from "@/lib/dates";
import { sha256Hex } from "@/lib/json";
import { siteUrl } from "@/lib/site";
import { FAKE_CLAUDE, PIPELINE_DATE, QUIET_PUSH_ARGS, REPO, inRoot, makeHarness, type Harness } from "./helpers/harness";

const T = 120_000;
const made: Harness[] = [];
const harness = (...a: Parameters<typeof makeHarness>) => {
  const h = makeHarness(...a);
  made.push(h);
  return h;
};
afterEach(() => {
  for (const h of made.splice(0)) h.dispose();
});

/** Files under dir, relative, sorted. */
function walk(dir: string, rel = ""): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(dir, r) : [r];
  }).sort();
}

/** Commits and pushes one file from the clone; true when the push went through. */
function commitAndPush(h: Harness, file: string, text: string, subject: string): boolean {
  fs.mkdirSync(path.dirname(path.join(h.root, file)), { recursive: true });
  fs.writeFileSync(path.join(h.root, file), text);
  h.git("add", file);
  h.git("commit", "-q", "-m", subject);
  try {
    h.git("push", "-q", "origin", "main");
    return true;
  } catch {
    h.git("reset", "-q", "--hard", "origin/main");
    return false;
  }
}

const briefJson = (date: string, edition: string, publishedAt: string) =>
  `${JSON.stringify({ schema_version: 1, date, edition, published_at: publishedAt }, null, 2)}\n`;

describe("makeHarness: the remote, the clone and the seed", () => {
  it("HN1: a bare remote on main and a clean clone of it as root", async () => {
    const h = harness();
    expect(h.date).toBe(PIPELINE_DATE);
    expect(h.remote).toBe(path.join(h.base, "remote.git"));
    expect(h.root).toBe(path.join(h.base, "work"));
    expect(execFileSync("git", ["rev-parse", "--is-bare-repository"], { cwd: h.remote, encoding: "utf8" }).trim()).toBe("true");
    expect(execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: h.remote, encoding: "utf8" }).trim()).toBe("refs/heads/main");
    expect(h.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(h.git("rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
    expect(h.git("remote", "get-url", "origin")).toBe(h.remote);
    expect(h.git("status", "--porcelain")).toBe("");
    expect(h.git("rev-parse", "HEAD")).toBe(execFileSync("git", ["rev-parse", "main"], { cwd: h.remote, encoding: "utf8" }).trim());
    expect(h.deps.repo).toBe(h.remote);
    expect(h.deps.arch).toBe("arm64");
    // publish's push retry waits are instant here and recorded in order.
    expect(h.waits()).toEqual([]);
    const t0 = Date.now();
    await h.deps.sleep(8_000);
    await h.deps.sleep(2_000);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(h.waits()).toEqual([8_000, 2_000]);
    expect(h.clock()).toBeGreaterThanOrEqual(at(PIPELINE_DATE, "04:37"));
    expect(h.clock()).toBeLessThan(at(PIPELINE_DATE, "04:37") + 60_000);
  }, T);

  it("HN13: pushes from the clone never negotiate, so a machine-wide push.negotiate=true prints nothing; global config is untouched", () => {
    const h = harness();
    expect(QUIET_PUSH_ARGS).toEqual(["-c", "push.negotiate=false"]);
    expect(h.git("config", "--local", "push.negotiate")).toBe("false");
    // A stand-in global config with push.negotiate=true, as the cloud container has; a push to an empty
    // remote is where git prints its negotiation failure. The clone's own setting wins.
    const globalConfig = path.join(h.base, "global.gitconfig");
    fs.writeFileSync(globalConfig, "[push]\n\tnegotiate = true\n");
    const empty = path.join(h.base, "empty.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", empty]);
    const r = spawnSync("git", ["push", "-q", empty, "main"], { cwd: h.root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig } });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/negotiat|acknowledgments/);
    expect(fs.readFileSync(globalConfig, "utf8")).toBe("[push]\n\tnegotiate = true\n");
  }, T);

  it("HN2: one seed commit by ct-test, left out of remoteLog(); content/ holds only state/", async () => {
    const h = harness();
    const log = execFileSync("git", ["log", "--format=%s|%an|%ae", "main"], { cwd: h.remote, encoding: "utf8" }).trim().split("\n");
    expect(log).toEqual(["seed|ct-test|ct-test@example.invalid"]);
    expect(h.remoteLog()).toEqual([]);

    expect(fs.readdirSync(path.join(h.root, "content"))).toEqual(["state"]);
    expect(walk(path.join(h.root, "content", "state"))).toEqual(walk(path.join(REPO, "fixtures", "state")));
    for (const f of walk(path.join(REPO, "fixtures", "state"))) {
      expect(h.remoteFile(`content/state/${f}`)).toBe(fs.readFileSync(path.join(REPO, "fixtures", "state", f), "utf8"));
    }
    expect(h.remoteFile("content/README.md")).toBeNull();
    expect(h.remoteFile("config/run.json")).toBe(fs.readFileSync(path.join(REPO, "config", "run.json"), "utf8"));
    expect(h.remoteFile("routine/agent-settings.json")).toBe(fs.readFileSync(path.join(REPO, "routine", "agent-settings.json"), "utf8"));
    expect(h.remoteFile(".gitignore")).toBe(fs.readFileSync(path.join(REPO, ".gitignore"), "utf8"));
    expect(h.remoteFile("package-lock.json")).toBe(fs.readFileSync(path.join(REPO, "package-lock.json"), "utf8"));
    expect(h.remoteFile("scripts/README.txt")).not.toBeNull();
    expect(h.remoteFile("no/such/file")).toBeNull();
  }, T);

  it("HN3: the lock-sha marker, the fake CLI wrapper, the config folder and the env", () => {
    const h = harness();
    const lockSha = path.join(h.root, "node_modules", ".ct-lock-sha");
    expect(fs.readFileSync(lockSha, "utf8")).toBe(sha256Hex(fs.readFileSync(path.join(h.root, "package-lock.json"))));
    expect(h.git("check-ignore", "node_modules/.ct-lock-sha")).toBe("node_modules/.ct-lock-sha");
    h.writeLockSha(false);
    expect(fs.readFileSync(lockSha, "utf8")).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(lockSha, "utf8")).not.toBe(sha256Hex(fs.readFileSync(path.join(h.root, "package-lock.json"))));
    h.writeLockSha(true);
    expect(fs.readFileSync(lockSha, "utf8")).toBe(sha256Hex(fs.readFileSync(path.join(h.root, "package-lock.json"))));
    expect(h.git("status", "--porcelain")).toBe("");

    const bin = path.join(h.base, "bin", "claude");
    expect(fs.statSync(bin).mode & 0o777).toBe(0o755);
    const wrapper = fs.readFileSync(bin, "utf8");
    expect(wrapper.startsWith("#!/bin/sh\n")).toBe(true);
    expect(wrapper).toContain(`exec '${process.execPath}' '${FAKE_CLAUDE}' "$@"`);
    expect(fs.statSync(h.claudeDir).isDirectory()).toBe(true);
    expect(fs.statSync(h.claudeDir).mode & 0o777).toBe(0o700);

    expect(h.env).toEqual({
      CT_FIXTURE_FEEDS: path.join(REPO, "fixtures", "feeds"),
      CT_CLAUDE_BIN: bin,
      CT_CLAUDE_CONFIG_DIR: h.claudeDir,
      CT_DEPLOY_WAIT_MS: "0",
      NODE_ENV: "test",
    });
  }, T);

  it("HN4: the seed callback's files go into the one seed commit", () => {
    const h = harness({
      date: "2026-10-15",
      start: "05:35",
      seed: (s) => {
        fs.mkdirSync(path.join(s.root, "content", "briefs"), { recursive: true });
        fs.writeFileSync(path.join(s.root, "content", "briefs", "2026-10-14.json"), briefJson("2026-10-14", "full", "2026-10-14T05:10:00+08:00"));
      },
    });
    expect(h.date).toBe("2026-10-15");
    expect(h.clock()).toBeGreaterThanOrEqual(at("2026-10-15", "05:35"));
    expect(h.remoteLog()).toEqual([]);
    expect(execFileSync("git", ["rev-list", "--count", "main"], { cwd: h.remote, encoding: "utf8" }).trim()).toBe("1");
    expect(h.remoteFile("content/briefs/2026-10-14.json")).toContain('"edition": "full"');
    expect(() => makeHarness({ date: "2026-02-30" })).toThrow(/invalid date/);
  }, T);
});

describe("the pre-receive hook (pushes)", () => {
  it("HN5: accept, reject and reject-briefs; remoteLog lists what went through", () => {
    const h = harness();
    expect(commitAndPush(h, "content/status/2026-10-14.json", "{}\n", "status: 2026-10-14 · one")).toBe(true);

    h.pushes("reject");
    expect(fs.existsSync(path.join(h.base, "reject-pushes"))).toBe(true);
    expect(commitAndPush(h, "content/status/2026-10-14.json", "{\"a\":1}\n", "status: 2026-10-14 · two")).toBe(false);

    h.pushes("reject-briefs");
    expect(fs.existsSync(path.join(h.base, "reject-pushes"))).toBe(false);
    expect(commitAndPush(h, "content/briefs/2026-10-14.json", "{}\n", "brief: 2026-10-14 · full")).toBe(false);
    expect(commitAndPush(h, "content/state/days.json", "{}\n", "state: 2026-10-14 · days")).toBe(true);

    h.pushes("accept");
    expect(["reject-pushes", "reject-briefs", "slow-pushes"].filter((m) => fs.existsSync(path.join(h.base, m)))).toEqual([]);
    expect(commitAndPush(h, "content/briefs/2026-10-14.json", "{}\n", "brief: 2026-10-14 · full")).toBe(true);

    const log = h.remoteLog();
    expect(log.map((c) => c.subject)).toEqual(["status: 2026-10-14 · one", "state: 2026-10-14 · days", "brief: 2026-10-14 · full"]);
    expect(log.map((c) => c.files)).toEqual([["content/status/2026-10-14.json"], ["content/state/days.json"], ["content/briefs/2026-10-14.json"]]);
    expect(log.every((c) => /^[0-9a-f]{40}$/.test(c.sha))).toBe(true);
    expect(log.at(-1)?.sha).toBe(h.git("rev-parse", "HEAD"));
  }, T);

  it("HN6: a slow push waits, and slow with reject waits and then refuses", () => {
    const h = harness();
    h.pushes({ slowSeconds: 1 });
    let t0 = Date.now();
    expect(commitAndPush(h, "content/status/2026-10-14.json", "{}\n", "status: 2026-10-14 · slow")).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);

    h.pushes({ slowSeconds: 1, reject: true });
    t0 = Date.now();
    expect(commitAndPush(h, "content/status/2026-10-14.json", "{\"b\":2}\n", "status: 2026-10-14 · refused")).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(h.remoteLog().map((c) => c.subject)).toEqual(["status: 2026-10-14 · slow"]);
    expect(() => h.pushes({ slowSeconds: -1 })).toThrow(/slowSeconds/);
  }, T);

  it("HN7: commitOnRemote moves remote main past the hook, and the clone can fetch it", () => {
    const h = harness();
    h.pushes("reject");
    const sha = h.commitOnRemote({ "scripts/README.txt": "x" }, "code: test");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(h.remoteLog()).toEqual([{ sha, subject: "code: test", files: ["scripts/README.txt"] }]);
    expect(h.remoteFile("scripts/README.txt")).toBe("x");
    expect(execFileSync("git", ["log", "-1", "--format=%an", "main"], { cwd: h.remote, encoding: "utf8" }).trim()).toBe("ct-test");
    h.git("fetch", "-q", "origin");
    expect(h.git("rev-parse", "origin/main")).toBe(sha);
    expect(fs.readdirSync(h.base).filter((n) => n.startsWith("scratch-"))).toEqual([]);
  }, T);
});

describe("the router behind deps.fetchImpl", () => {
  const intake = `https://api.github.com/repos/${run.repos.repo}/issues?state=all&labels=dispute&since=2026-10-01T00:00:00Z&per_page=100`;

  it("HN8: answers the probe, the intake and the site, and throws on anything else", async () => {
    const h = harness();
    const f = h.deps.fetchImpl;
    expect((await f("https://github.com", { method: "HEAD" })).status).toBe(200);
    expect((await f("https://github.com/", { method: "HEAD" })).status).toBe(200);

    expect(await (await f(intake)).json()).toEqual([]);
    h.issues([{ number: 7, title: "Dispute" }]);
    expect(await (await f(intake)).json()).toEqual([{ number: 7, title: "Dispute" }]);
    expect(await (await f(`${intake}&page=1`)).json()).toEqual([{ number: 7, title: "Dispute" }]);
    expect(await (await f(`${intake}&page=2`)).json()).toEqual([]);
    h.issues("fail");
    expect((await f(intake)).status).toBe(503);

    expect((await f(`${siteUrl()}/`)).status).toBe(404);
    expect(commitAndPush(h, `content/briefs/${h.date}.json`, briefJson(h.date, "data_only", "2026-10-14T04:48:00+08:00"), `brief: ${h.date} · data-only`)).toBe(true);
    const page = await f(new URL(`${siteUrl()}/`));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`<meta name="ct-edition" content="${h.date} data_only 2026-10-14T04:48:00+08:00">`);
    h.site({ date: h.date, edition: "full", published_at: "2026-10-14T05:10:00+08:00" });
    expect(await (await f(`${siteUrl()}/`)).text()).toContain(`content="${h.date} full 2026-10-14T05:10:00+08:00"`);
    h.site(null);
    expect((await f(`${siteUrl()}/`)).status).toBe(404);
    h.site("from-remote");
    expect((await f(`${siteUrl()}/`)).status).toBe(200);

    await expect(f("https://example.org/ct-sample/page")).rejects.toThrow(new TypeError("harness router: unexpected GET https://example.org/ct-sample/page"));
    await expect(f("https://github.com/")).rejects.toThrow("harness router: unexpected GET https://github.com/");
    await expect(f(`${siteUrl()}/`, { method: "POST" })).rejects.toThrow(`harness router: unexpected POST ${siteUrl()}/`);
    await expect(f(`${siteUrl()}/`, { signal: AbortSignal.abort() })).rejects.toThrow();

    const seen = h.requests();
    expect(seen[0]).toEqual({ method: "HEAD", url: "https://github.com" });
    expect(seen.at(-1)).toEqual({ method: "GET", url: `${siteUrl()}/` });
    expect(seen.filter((r) => r.url === "https://example.org/ct-sample/page")).toHaveLength(1);
  }, T);

  it("HN9: deps.readToken returns test-token until token() changes it", async () => {
    const h = harness();
    expect(await h.deps.readToken()).toBe("test-token");
    h.token(null);
    expect(await h.deps.readToken()).toBeNull();
    h.token("another");
    expect(await h.deps.readToken()).toBe("another");
  }, T);
});

describe("the fake agent's files, inRoot and dispose", () => {
  it("HN10: fakeAgent writes fake-agent.json; agentCalls reads calls.jsonl", () => {
    const h = harness();
    expect(h.agentCalls()).toEqual([]);
    h.fakeAgent({ mode: "ok", draft: { date: h.date }, fetches: ["https://example.org/ct-sample/a"], searches: 2, version: "2.1.316 (Claude Code)" });
    expect(JSON.parse(fs.readFileSync(path.join(h.claudeDir, "fake-agent.json"), "utf8"))).toEqual({
      mode: "ok", draft: { date: h.date }, fetches: ["https://example.org/ct-sample/a"], searches: 2, version: "2.1.316 (Claude Code)",
    });
    h.fakeAgent({ mode: "nodraft", touch: [path.join(h.base, "reject-pushes")], draftPath: path.join(h.root, "drafts", "x.json"), delayMs: 5 });
    expect(JSON.parse(fs.readFileSync(path.join(h.claudeDir, "fake-agent.json"), "utf8")).mode).toBe("nodraft");
    h.fakeAgent({ mode: "repair", invalidDraft: { date: "not a date" }, repair: { date: h.date } });
    expect(JSON.parse(fs.readFileSync(path.join(h.claudeDir, "fake-agent.json"), "utf8"))).toEqual({
      mode: "repair", invalidDraft: { date: "not a date" }, repair: { date: h.date },
    });
    const call = { argv: ["-p", "--output-format", "stream-json"], envKeys: ["HOME", "PATH"], cwd: h.root };
    fs.writeFileSync(path.join(h.claudeDir, "calls.jsonl"), `${JSON.stringify(call)}\n${JSON.stringify({ ...call, argv: ["--version"] })}\n`);
    expect(h.agentCalls()).toEqual([call, { ...call, argv: ["--version"] }]);
  }, T);

  it("HN11: inRoot applies cwd and env, unsets CT_CONTENT_DIR and CT_REEXEC, and restores both, also on a throw", async () => {
    const h = harness();
    const cwd = process.cwd();
    const before = { CT_CONTENT_DIR: process.env.CT_CONTENT_DIR, CT_REEXEC: process.env.CT_REEXEC, NODE_ENV: process.env.NODE_ENV, CT_CLAUDE_BIN: process.env.CT_CLAUDE_BIN };
    process.env.CT_CONTENT_DIR = "fixtures/site-content";
    process.env.CT_REEXEC = "1";
    try {
      const inside = await inRoot(h, async () => ({
        cwd: process.cwd(), content: process.env.CT_CONTENT_DIR, reexec: process.env.CT_REEXEC,
        bin: process.env.CT_CLAUDE_BIN, feeds: process.env.CT_FIXTURE_FEEDS, wait: process.env.CT_DEPLOY_WAIT_MS,
      }));
      expect(inside).toEqual({
        cwd: h.root, content: undefined, reexec: undefined, bin: h.env.CT_CLAUDE_BIN, feeds: h.env.CT_FIXTURE_FEEDS, wait: "0",
      });
      expect(process.cwd()).toBe(cwd);
      expect(process.env.CT_CONTENT_DIR).toBe("fixtures/site-content");
      expect(process.env.CT_REEXEC).toBe("1");
      expect(process.env.CT_CLAUDE_BIN).toBe(before.CT_CLAUDE_BIN);

      await expect(inRoot(h, async () => {
        process.env.CT_REEXEC = "1";
        throw new Error("boom");
      })).rejects.toThrow("boom");
      expect(process.cwd()).toBe(cwd);
      expect(process.env.CT_CONTENT_DIR).toBe("fixtures/site-content");
      expect(process.env.NODE_ENV).toBe(before.NODE_ENV);
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, T);

  it("HN12: dispose removes base, also when the process is inside it", () => {
    const a = makeHarness();
    a.dispose();
    expect(fs.existsSync(a.base)).toBe(false);
    const b = makeHarness();
    const cwd = process.cwd();
    try {
      process.chdir(b.root);
      b.dispose();
      expect(fs.existsSync(b.base)).toBe(false);
      expect(process.cwd()).toBe(REPO);
    } finally {
      process.chdir(cwd);
    }
  }, T);
});
