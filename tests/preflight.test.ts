// Preflight's step functions (scripts/preflight.ts; SPEC §8.2 "Clock rules" and "Preflight"; plan §2.7, §3.2,
// A3). PF1 to PF8 of the plan. prepareGit runs on the shared harness (a bare remote and a clone, nothing on
// the network) with the real syncMain and fakes for publish's dropPendingEditions and pushPending; the
// network probe and the CLI check take injected fetch and cliVersion functions. No keychain is read.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type LoadedConfig } from "@/lib/config";
import { at } from "@/lib/dates";
import { sha256Hex } from "@/lib/json";
import { MIN } from "@/scripts/lib/clock";
import { GitError, SyncError } from "@/scripts/lib/git";
import { NOTES } from "@/scripts/lib/status";
import {
  MIN_NODE_MAJOR, PreflightFail, checkCliAndToken, checkNetwork, checkPlatform, clockRule, depsChanged, githubRepoOf, idempotency,
  loadRunConfig, originMatches, prepareGit, redactRemotes, scheduleFor, type Schedule,
} from "@/scripts/preflight";
import { PublishError } from "@/scripts/publish";
import { makeHarness, type Harness } from "./helpers/harness";

const ROOT = path.resolve(__dirname, "..");
const SITE_CONTENT = path.join(ROOT, "fixtures", "site-content");
const config = loadConfig({ root: ROOT });
const D = "2026-10-14";
const GIT_MS = 60_000;

/** The PreflightFail a call throws (sync or async), or null. */
async function failOf(fn: () => unknown): Promise<PreflightFail | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof PreflightFail) return e;
    throw e;
  }
}

const tmp: string[] = [];
let h: Harness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("steps 1, 3 and the clock", () => {
  it("PF1 checkPlatform: arm64 and Node 22 or newer pass; the arch is checked first", async () => {
    for (const nodeVersion of ["22.0.0", "22.11.0", "v24.1.0", "23.3.1"]) expect(() => checkPlatform({ arch: "arm64", nodeVersion })).not.toThrow();
    expect(MIN_NODE_MAJOR).toBe(22);
    const arch = await failOf(() => checkPlatform({ arch: "x64", nodeVersion: "22.11.0" }));
    expect(arch?.code).toBe("E_ARCH");
    expect(arch?.message).toBe("Not native arm64 (x64): put /opt/homebrew/bin first on the PATH (SPEC Appendix C).");
    expect((await failOf(() => checkPlatform({ arch: "x64", nodeVersion: "18.20.0" })))?.code).toBe("E_ARCH");
    for (const nodeVersion of ["20.18.0", "21.7.3", "", "not a version"]) {
      expect((await failOf(() => checkPlatform({ arch: "arm64", nodeVersion })))?.code, nodeVersion).toBe("E_NODE");
    }
  });

  it("PF1 loadRunConfig: the repo's config loads; a broken file is E_CONFIG naming the first problem", async () => {
    expect(loadRunConfig(ROOT).run.repos.repo).toBe("8gara8/CyberTracker");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-config-"));
    tmp.push(dir);
    fs.cpSync(path.join(ROOT, "config"), path.join(dir, "config"), { recursive: true });
    expect(loadRunConfig(dir).run.schedule.hard_stop).toBe("05:30");
    fs.writeFileSync(path.join(dir, "config", "run.json"), "{ not json");
    const f = await failOf(() => loadRunConfig(dir));
    expect(f?.code).toBe("E_CONFIG");
    expect(f?.message).toMatch(/^config\/ fails its checks: 1 problem, first CONFIG_SCHEMA at config\/run\.json\.$/);
    fs.rmSync(path.join(dir, "config", "claims.json"));
    expect((await failOf(() => loadRunConfig(dir)))?.message).toMatch(/^config\/ fails its checks: 2 problems/);
  });

  it("PF2 scheduleFor: a normal morning, --no-deadline (non-dry capped at 11:00, dry not), late starts and the watchdog", () => {
    const s = (start: string, o: { noDeadline?: boolean; dryRun?: boolean } = {}) =>
      scheduleFor({ date: D, start: at(D, start), config, noDeadline: o.noDeadline ?? false, dryRun: o.dryRun ?? false });
    expect(s("04:37")).toEqual({
      hardStop: at(D, "05:30"), retryCutoff: at(D, "05:00"), publishUntil: at(D, "11:00"), staleAfter: at(D, "08:00"),
      endLimit: at(D, "05:30"), watchdogAt: at(D, "05:32"), windowEnd: at(D, "04:30"),
    });
    // --no-deadline at 08:30: hardStop 09:45, retryCutoff 08:55.
    expect(s("08:30", { noDeadline: true })).toMatchObject({ hardStop: at(D, "09:45"), retryCutoff: at(D, "08:55"), endLimit: at(D, "09:45"),
      watchdogAt: at(D, "09:47"), publishUntil: at(D, "11:00") });
    // Capped at 11:00 unless a dry run.
    expect(s("10:30", { noDeadline: true })).toMatchObject({ hardStop: at(D, "11:00"), retryCutoff: at(D, "10:10"), watchdogAt: at(D, "11:02") });
    expect(s("10:30", { noDeadline: true, dryRun: true })).toMatchObject({ hardStop: at(D, "11:45"), retryCutoff: at(D, "10:55"),
      publishUntil: Number.POSITIVE_INFINITY, endLimit: at(D, "11:45"), watchdogAt: at(D, "11:47") });
    // A dry run has no publish limit.
    expect(s("04:37", { dryRun: true })).toMatchObject({ publishUntil: Number.POSITIVE_INFINITY, endLimit: at(D, "05:30"), watchdogAt: at(D, "05:32") });
    // Started after the hard stop: bounded by 11:00, the watchdog at 11:02.
    expect(s("05:35")).toMatchObject({ hardStop: at(D, "05:30"), endLimit: at(D, "11:00"), watchdogAt: at(D, "11:02") });
    // Started after 11:00: the watchdog ten minutes after the start.
    expect(s("11:05")).toMatchObject({ endLimit: at(D, "11:00"), watchdogAt: at(D, "11:15") });
    expect(s("11:05", { noDeadline: true })).toMatchObject({ hardStop: at(D, "11:00"), endLimit: at(D, "11:00"), watchdogAt: at(D, "11:15") });
    // A dry run started after the hard stop without --no-deadline keeps hardStop as its end limit, and a
    // watchdog that has not passed already.
    expect(s("05:35", { dryRun: true })).toMatchObject({ endLimit: at(D, "05:30"), watchdogAt: at(D, "05:35") + 77 * MIN });
  });

  it("PF3 clockRule: the E_CLOCK boundary at 08:00 Taipei on D-1, too early, too late, after the hard stop", async () => {
    const rule = (now: number, o: { dryRun?: boolean; noDeadline?: boolean; schedule?: Schedule } = {}) => clockRule({
      date: D, now, dryRun: o.dryRun ?? false, noDeadline: o.noDeadline ?? false,
      schedule: o.schedule ?? scheduleFor({ date: D, start: now, config, noDeadline: o.noDeadline ?? false, dryRun: o.dryRun ?? false }),
    });
    const boundary = at("2026-10-13", "08:00");
    expect(boundary).toBe(Date.parse("2026-10-13T00:00:00Z"));
    const early = await failOf(() => rule(boundary - 1, { dryRun: true }));
    expect(early?.code).toBe("E_CLOCK");
    expect(rule(boundary, { dryRun: true })).toBe("normal");
    // §0.4 row 185: more than 15 min before the news window ends (04:30) is too early, --no-deadline or
    // not; from 04:15 the run is normal (daily.ts waits for 04:30); a dry run is never too early.
    expect(rule(boundary)).toBe("too_early");
    expect(rule(at(D, "00:05"))).toBe("too_early");
    expect(rule(at(D, "00:05"), { noDeadline: true })).toBe("too_early");
    expect(rule(at(D, "04:15") - 1)).toBe("too_early");
    expect(rule(at(D, "04:15"))).toBe("normal");
    expect(rule(at(D, "04:29"), { noDeadline: true })).toBe("normal");
    expect(rule(at(D, "00:05"), { dryRun: true })).toBe("normal");
    expect(scheduleFor({ date: D, start: at(D, "04:37"), config, noDeadline: false, dryRun: false }).windowEnd).toBe(at(D, "04:30"));
    expect(rule(at(D, "04:37"))).toBe("normal");
    expect(rule(at(D, "05:30"))).toBe("normal");
    expect(rule(at(D, "05:30") + 1)).toBe("after_hard_stop");
    expect(rule(at(D, "05:35"), { dryRun: true })).toBe("normal");
    expect(rule(at(D, "08:30"), { noDeadline: true })).toBe("normal");
    expect(rule(at(D, "11:00"))).toBe("after_hard_stop");
    expect(rule(at(D, "11:00") + 1)).toBe("too_late");
    expect(rule(at(D, "11:05"), { noDeadline: true })).toBe("too_late");
    expect(rule(at(D, "11:05"), { dryRun: true })).toBe("normal");
    // A past-date dry run on a later day.
    expect(rule(at("2026-11-10", "14:00"), { dryRun: true, noDeadline: true })).toBe("normal");
  });

  it("PF4 checkNetwork: HEAD https://github.com; 200 and 404 pass, 503, an error and a timeout are E_NET", async () => {
    const seen: { url: string; method: string | undefined }[] = [];
    const answer = (status: number) => (async (u: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(u), method: init?.method });
      return new Response(null, { status });
    }) as typeof fetch;
    await expect(checkNetwork(answer(200))).resolves.toBeUndefined();
    await expect(checkNetwork(answer(404))).resolves.toBeUndefined();
    await expect(checkNetwork(answer(499))).resolves.toBeUndefined();
    expect(seen.every((r) => r.url === "https://github.com" && r.method === "HEAD")).toBe(true);
    for (const status of [500, 503]) {
      const f = await failOf(() => checkNetwork(answer(status)));
      expect(f?.code).toBe("E_NET");
      expect(f?.message).toBe(`github.com answered HTTP ${status}.`);
    }
    const thrown = await failOf(() => checkNetwork((async () => { throw new TypeError("fetch failed"); }) as typeof fetch));
    expect(thrown?.message).toBe("github.com did not answer (the request failed).");
    // A fetch that never answers and ignores its signal is cut at the timeout.
    const t0 = Date.now();
    const slow = await failOf(() => checkNetwork((() => new Promise<Response>(() => {})) as typeof fetch, 50));
    expect(slow?.code).toBe("E_NET");
    expect(Date.now() - t0).toBeLessThan(5_000);
    // The default is 10 s.
    vi.useFakeTimers();
    let signal: AbortSignal | null = null;
    let settled = false;
    const p = checkNetwork(((_: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? null;
      return new Promise<Response>(() => {});
    }) as typeof fetch).catch((e: unknown) => { settled = true; return e; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(signal!.aborted).toBe(true);
    expect(((await p) as PreflightFail).code).toBe("E_NET");
    // The harness router answers the probe.
    h = makeHarness();
    await expect(checkNetwork(h.deps.fetchImpl)).resolves.toBeUndefined();
  });
});

describe("PF5 prepareGit on the harness", () => {
  const noop = () => ({
    dropPendingEditions: vi.fn(async () => ({ dropped: 0, remade: 0, failed: [] as string[] })),
    pushPending: vi.fn(async () => ({ pushed: 0 })),
  });

  function setup(): { h: Harness; cfg: LoadedConfig; lines: string[]; base: (o?: { dryRun?: boolean; reexec?: boolean; repo?: string }) => Parameters<typeof prepareGit>[0] } {
    h = makeHarness();
    const harness = h;
    const cfg = loadRunConfig(harness.root);
    const lines: string[] = [];
    return {
      h: harness, cfg, lines,
      base: (o = {}) => ({
        root: harness.root, repo: "repo" in o ? o.repo : harness.remote, config: cfg, dryRun: o.dryRun ?? false, now: harness.clock,
        reexec: o.reexec ?? false, log: (l: string) => lines.push(l),
      }),
    };
  }
  const write = (h: Harness, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(h.root, rel)), { recursive: true });
    fs.writeFileSync(path.join(h.root, rel), text);
  };
  const read = (h: Harness, rel: string) => fs.readFileSync(path.join(h.root, rel), "utf8");

  it("PF5 a clean main with nothing to sync: no notes, codeCommit HEAD, the fakes called in order", async () => {
    const { h, base, cfg } = setup();
    const order: string[] = [];
    const fns = {
      dropPendingEditions: vi.fn(async () => { order.push("drop"); return { dropped: 0, remade: 0, failed: [] as string[] }; }),
      pushPending: vi.fn(async () => { order.push("push"); return { pushed: 3 }; }),
      syncMain: vi.fn(async (...a: Parameters<typeof import("@/scripts/lib/git").syncMain>) => {
        order.push("sync");
        return (await import("@/scripts/lib/git")).syncMain(...a);
      }),
    };
    const gp = await prepareGit(base(), fns);
    expect(gp).toEqual({ codeCommit: h.git("rev-parse", "HEAD"), restartSha7: null, notes: [], dropped: 0, remade: 0, pushed: 3 });
    expect(order).toEqual(["drop", "sync", "push"]);
    const [, opts] = fns.dropPendingEditions.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(opts).toMatchObject({ root: h.root, config: cfg, repo: h.remote });
    expect(opts.now).toBe(h.clock);
  }, GIT_MS);

  it("PF5 content/ restored and noted: a changed, an untracked and a staged file", async () => {
    const { h, base, lines } = setup();
    const days = read(h, "content/state/days.json");
    write(h, "content/state/days.json", "{}\n");
    write(h, "content/briefs/2026-10-14.json", "{}\n");
    write(h, "content/status/2026-10-14.json", "{}\n");
    h.git("add", "content/status/2026-10-14.json");
    const gp = await prepareGit(base(), noop());
    expect(gp.notes).toEqual([NOTES.restored]);
    expect(lines).toContain("Restored content/ left by an earlier run.");
    expect(read(h, "content/state/days.json")).toBe(days);
    expect(fs.existsSync(path.join(h.root, "content/briefs/2026-10-14.json"))).toBe(false);
    expect(fs.existsSync(path.join(h.root, "content/status/2026-10-14.json"))).toBe(false);
    expect(h.git("status", "--porcelain")).toBe("");
    // Ignored files outside content/ (logs/, node_modules/) do not count and stay.
    write(h, "logs/2026-10-14.daily.log", "x\n");
    expect((await prepareGit(base(), noop())).notes).toEqual([]);
    expect(fs.existsSync(path.join(h.root, "logs/2026-10-14.daily.log"))).toBe(true);
  }, GIT_MS);

  it("PF5 a dirty path outside content/ is E_GIT, and nothing is synced", async () => {
    const { h, base } = setup();
    write(h, "scripts/x.ts", "export {};\n");
    const fns = noop();
    const f = await failOf(() => prepareGit(base(), fns));
    expect(f?.code).toBe("E_GIT");
    expect(f?.message).toBe("The working tree has changes outside content/: scripts/x.ts.");
    expect(fns.dropPendingEditions).not.toHaveBeenCalled();
    fs.rmSync(path.join(h.root, "scripts/x.ts"));
    write(h, "config/run.json", `${read(h, "config/run.json")}\n`);
    expect((await failOf(() => prepareGit(base(), noop())))?.code).toBe("E_GIT");
  }, GIT_MS);

  it("PF5 off main with a clean tree: main is checked out; a branch holding other code asks for a restart", async () => {
    const { h, base, lines } = setup();
    const main = h.git("rev-parse", "HEAD");
    h.git("checkout", "-q", "-b", "feature");
    const gp = await prepareGit(base(), noop());
    expect(h.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(gp).toMatchObject({ codeCommit: main, restartSha7: null, notes: [] });
    expect(lines).toContain("Checked out main.");

    h.git("checkout", "-q", "feature");
    write(h, "scripts/feature.txt", "x\n");
    h.git("add", "-A");
    h.git("commit", "-q", "-m", "code: feature");
    const again = await prepareGit(base(), noop());
    expect(h.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(again).toMatchObject({ codeCommit: main, restartSha7: h.git("rev-parse", "--short=7", "HEAD") });
  }, GIT_MS);

  it("PF5 a sync bringing scripts/x gives restartSha7; one touching only content/ does not", async () => {
    const { h, base } = setup();
    const sha = h.commitOnRemote({ "scripts/x.txt": "x\n" }, "code: test");
    const gp = await prepareGit(base(), noop());
    expect(h.git("rev-parse", "HEAD")).toBe(sha);
    expect(gp).toEqual({ codeCommit: sha, restartSha7: sha.slice(0, 7), notes: [], dropped: 0, remade: 0, pushed: 0 });

    const status = h.commitOnRemote({ "content/status/2026-10-13.json": "{}\n" }, "status: 2026-10-13 · run 20261013-043702 ended: failed");
    const next = await prepareGit(base(), noop());
    expect(next).toMatchObject({ codeCommit: status, restartSha7: null, notes: [] });
  }, GIT_MS);

  it("PF5 CT_REEXEC=1 gives the restarted note and no restart, with or without new code (A3)", async () => {
    const { h, base, lines } = setup();
    const sha = h.commitOnRemote({ "scripts/x.txt": "x\n" }, "code: test");
    const gp = await prepareGit(base({ reexec: true }), noop());
    expect(gp).toMatchObject({ codeCommit: sha, restartSha7: null, notes: [NOTES.restarted(sha.slice(0, 7))] });
    expect(gp.notes[0]).toBe(`Restarted on the code synced from main (${sha.slice(0, 7)}).`);
    expect(lines).toContain(gp.notes[0]);
    // The child's own sync finds nothing new: the note still names HEAD.
    const child = await prepareGit(base({ reexec: true }), noop());
    expect(child).toMatchObject({ codeCommit: sha, restartSha7: null, notes: [NOTES.restarted(sha.slice(0, 7))] });
  }, GIT_MS);

  it("PF5 a dry run only probes: any branch and a dirty tree are left as they were, and noted", async () => {
    const { h, base } = setup();
    expect(await prepareGit(base({ dryRun: true }), noop())).toEqual({
      codeCommit: h.git("rev-parse", "HEAD"), restartSha7: null, notes: [], dropped: 0, remade: 0, pushed: 0 });
    h.git("checkout", "-q", "-b", "feature");
    write(h, "scripts/x.ts", "export {};\n");
    write(h, "content/state/days.json", "{}\n");
    h.commitOnRemote({ "scripts/new.txt": "x\n" }, "code: test");
    const fns = { ...noop(), syncMain: vi.fn() };
    const before = h.git("status", "--porcelain");
    const gp = await prepareGit(base({ dryRun: true }), fns);
    expect(gp).toEqual({ codeCommit: h.git("rev-parse", "HEAD"), restartSha7: null, notes: [NOTES.dryRunTree], dropped: 0, remade: 0, pushed: 0 });
    expect(h.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
    expect(h.git("status", "--porcelain")).toBe(before);
    expect(read(h, "content/state/days.json")).toBe("{}\n");
    expect(fns.dropPendingEditions).not.toHaveBeenCalled();
    expect(fns.pushPending).not.toHaveBeenCalled();
    expect(fns.syncMain).not.toHaveBeenCalled();
  }, GIT_MS);

  it("PF5 an origin that is not the repo is E_GIT, and so is a probe that fails", async () => {
    const { h, base } = setup();
    const other = await failOf(() => prepareGit(base({ repo: path.join(h.base, "other.git") }), noop()));
    expect(other?.code).toBe("E_GIT");
    expect(other?.message).toBe("origin does not point at 8gara8/CyberTracker.");
    expect((await failOf(() => prepareGit(base({ repo: undefined }), noop())))?.code).toBe("E_GIT");
    // Deps.repo given in another spelling of the same local path still matches.
    expect((await prepareGit(base({ repo: `${h.remote}/` }), noop())).notes).toEqual([]);
    // The probe: origin names a path with no repository.
    const missing = path.join(h.base, "missing.git");
    h.git("remote", "set-url", "origin", missing);
    const probe = await failOf(() => prepareGit(base({ repo: missing }), noop()));
    expect(probe?.code).toBe("E_GIT");
    expect(probe?.message).toMatch(/^git ls-remote --heads origin main failed/);
    // A dry run probes too.
    expect((await failOf(() => prepareGit(base({ repo: missing, dryRun: true }), noop())))?.code).toBe("E_GIT");
    h.git("remote", "remove", "origin");
    expect((await failOf(() => prepareGit(base(), noop())))?.message).toBe("The checkout has no origin remote.");
  }, GIT_MS);

  it("PF5 main that cannot sync is E_GIT: a local commit outside content/, or a SyncError from syncMain", async () => {
    const { h, base } = setup();
    expect((await failOf(() => prepareGit(base(), { ...noop(), syncMain: async () => { throw new SyncError("cannot sync"); } })))?.code).toBe("E_GIT");
    // git's stderr can quote the remote, credentials and all: the message never carries a URL.
    const quoted = await failOf(() => prepareGit(base(), { ...noop(), syncMain: async () => {
      throw new GitError("git fetch -q origin main failed (exit 128): fatal: unable to access 'https://user:example-secret@github.com/8gara8/CyberTracker.git/': x");
    } }));
    expect(quoted?.message).toBe("git fetch -q origin main failed (exit 128): fatal: unable to access '<remote>': x");
    expect(redactRemotes("fatal: 'git@github.com:8gara8/CyberTracker.git' and ssh://git@github.com/8gara8/x.git")).toBe("fatal: '<remote>' and <remote>");
    expect(redactRemotes("main has 1 local commit(s) touching scripts/a.ts, outside the content layout.")).toBe(
      "main has 1 local commit(s) touching scripts/a.ts, outside the content layout.");
    write(h, "scripts/local.txt", "x\n");
    h.git("add", "-A");
    h.git("commit", "-q", "-m", "code: local");
    h.commitOnRemote({ "scripts/remote.txt": "y\n" }, "code: remote");
    const f = await failOf(() => prepareGit(base(), noop()));
    expect(f?.code).toBe("E_GIT");
    expect(f?.message).toMatch(/outside the content layout/);
  }, GIT_MS);

  it("PF5 dropped and remade commits are noted; a PublishError from pushPending is a note; a GitError is E_GIT", async () => {
    const { h, base, lines } = setup();
    const gp = await prepareGit(base(), {
      dropPendingEditions: async () => ({ dropped: 2, remade: 1, failed: ["2026-10-12-03"] }),
      pushPending: async () => { throw new PublishError("pending edition"); },
    });
    expect(gp.notes).toEqual([NOTES.droppedPending(2), NOTES.remadeWithholds(1), NOTES.pendingNotPushed]);
    expect(gp).toMatchObject({ dropped: 2, remade: 1, pushed: 0, restartSha7: null });
    expect(gp.notes.join(" ")).toBe("Dropped 2 unpushed edition commits left by an earlier run. Remade 1 withhold from the dropped commits. "
      + "Commits left unpushed by an earlier run could not be pushed; the next run tries again.");
    expect(lines).toContain("Withholds not remade, left for the next intake: 2026-10-12-03.");
    const pushFail = await failOf(() => prepareGit(base(), { ...noop(), pushPending: async () => { throw new GitError("git push failed (exit 1)"); } }));
    expect(pushFail?.code).toBe("E_GIT");
    const dropFail = await failOf(() => prepareGit(base(), { ...noop(), dropPendingEditions: async () => { throw new PublishError("validation", ["SCHEMA"]); } }));
    expect(dropFail?.code).toBe("E_GIT");
    expect(dropFail?.message).toBe("Unpushed edition commits could not be dropped (validation).");
    // Anything else is not a preflight code: daily.ts records E_INTERNAL.
    await expect(prepareGit(base(), { ...noop(), pushPending: async () => { throw new RangeError("boom"); } })).rejects.toThrow(RangeError);
    expect(h.git("status", "--porcelain")).toBe("");
  }, GIT_MS);

  it("PF5 originMatches and githubRepoOf: GitHub URLs in every form name repos.repo; nothing else does", () => {
    for (const url of [
      "https://github.com/8gara8/CyberTracker.git", "https://github.com/8gara8/CyberTracker", "https://github.com/8gara8/cybertracker/",
      "https://x-access@github.com/8gara8/CyberTracker.git", "git@github.com:8gara8/CyberTracker.git", "ssh://git@github.com/8gara8/CyberTracker.git",
      "github.com:8gara8/CyberTracker",
    ]) {
      expect(githubRepoOf(url)?.toLowerCase(), url).toBe("8gara8/cybertracker");
      expect(originMatches(url, { configRepo: "8gara8/CyberTracker" }), url).toBe(true);
    }
    for (const url of [
      "https://github.com/8gara8/OtherTracker.git", "https://gitlab.com/8gara8/CyberTracker.git", "https://github.com.evil.example/8gara8/CyberTracker",
      "https://github.com/8gara8/CyberTracker/extra", "/srv/git/CyberTracker.git", "",
    ]) {
      expect(originMatches(url, { configRepo: "8gara8/CyberTracker" }), url).toBe(false);
    }
    expect(originMatches("/tmp/x/remote.git", { repo: "/tmp/x/remote.git", configRepo: "8gara8/CyberTracker" })).toBe(true);
    expect(originMatches("/tmp/x/../x/remote.git", { repo: "/tmp/x/remote.git", configRepo: "8gara8/CyberTracker" })).toBe(true);
    expect(originMatches("/tmp/y/remote.git", { repo: "/tmp/x/remote.git", configRepo: "8gara8/CyberTracker" })).toBe(false);
    expect(originMatches("https://github.com/8gara8/CyberTracker.git", { repo: "/tmp/x/remote.git", configRepo: "8gara8/CyberTracker" })).toBe(true);
  });
});

describe("steps 5 (dependencies), 6 and 7", () => {
  it("PF6 depsChanged: missing, equal and different lock hashes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-deps-"));
    tmp.push(dir);
    const lock = '{ "name": "sample", "lockfileVersion": 3 }\n';
    fs.writeFileSync(path.join(dir, "package-lock.json"), lock);
    expect(depsChanged(dir)).toBe(true);                                   // no node_modules/.ct-lock-sha
    fs.mkdirSync(path.join(dir, "node_modules"));
    const file = path.join(dir, "node_modules", ".ct-lock-sha");
    fs.writeFileSync(file, sha256Hex(lock));                               // as postinstall writes it, no newline
    expect(depsChanged(dir)).toBe(false);
    fs.writeFileSync(file, `${sha256Hex(lock).toUpperCase()}\n`);          // white space and case do not matter
    expect(depsChanged(dir)).toBe(false);
    fs.writeFileSync(file, sha256Hex("an older lock"));
    expect(depsChanged(dir)).toBe(true);
    fs.writeFileSync(file, sha256Hex(lock));
    fs.writeFileSync(path.join(dir, "package-lock.json"), `${lock}\n`);    // package-lock.json changed since npm ci
    expect(depsChanged(dir)).toBe(true);
    fs.rmSync(path.join(dir, "package-lock.json"));
    expect(depsChanged(dir)).toBe(true);
  });

  it("PF6 depsChanged on the harness clone, whose lock sha writeLockSha sets", () => {
    h = makeHarness();
    expect(depsChanged(h.root)).toBe(false);
    h.writeLockSha(false);
    expect(depsChanged(h.root)).toBe(true);
  });

  it("PF7 idempotency for every state", () => {
    const at10 = (date: string) => ({ contentDir: SITE_CONTENT, date });
    const run = (date: string, clock: "normal" | "after_hard_stop" | "too_late" | "too_early", force = false) => idempotency({ ...at10(date), clock, force });
    // None: a normal run, forced or not, after the hard stop too.
    for (const [clock, force] of [["normal", false], ["normal", true], ["after_hard_stop", false]] as const) {
      expect(run("2026-10-16", clock, force)).toEqual({ state: "new", existing: null, note: null });
    }
    // Data-only: resume; --force never lets a data-only edition replace anything.
    for (const force of [false, true]) {
      const r = run("2026-10-15", "normal", force);
      expect(r.state).toBe("resume");
      expect(r.existing?.edition).toBe("data_only");
      expect(r.note).toBeNull();
    }
    expect(run("2026-10-15", "after_hard_stop").state).toBe("resume");
    // Full and partial: skipped with the publish time; --force replaces.
    expect(run("2026-10-14", "normal")).toMatchObject({ state: "skip_published", note: "The full edition was already published at 05:07." });
    expect(run("2026-10-13", "normal")).toMatchObject({ state: "skip_published", note: "The full edition was already published at 04:58." });
    const forced = run("2026-10-14", "normal", true);
    expect(forced).toMatchObject({ state: "replace", note: null });
    expect(forced.existing?.published_at).toBe("2026-10-14T05:07:44+08:00");
    expect(run("2026-10-13", "normal", true).state).toBe("replace");
    // After the hard stop no full edition can be drafted, so --force cannot replace: still skipped.
    expect(run("2026-10-14", "after_hard_stop", true)).toMatchObject({ state: "skip_published", note: NOTES.alreadyPublished("05:07") });
    // --data-only --force drafts nothing, and a data-only edition never replaces a full one: still skipped.
    expect(idempotency({ ...at10("2026-10-14"), clock: "normal", force: true, dataOnly: true })).toMatchObject({ state: "skip_published", note: NOTES.alreadyPublished("05:07") });
    expect(idempotency({ ...at10("2026-10-15"), clock: "normal", force: true, dataOnly: true }).state).toBe("resume");
    // Too late skips whatever GitHub holds, --force or not.
    for (const date of ["2026-10-16", "2026-10-15", "2026-10-14"]) {
      for (const force of [false, true]) {
        const r = run(date, "too_late", force);
        expect(r.state, `${date} ${force}`).toBe("skip_late");
        expect(r.note).toBe("Too late: nothing is published after 11:00.");
        expect(r.existing?.date ?? null).toBe(date === "2026-10-16" ? null : date);
      }
    }
    // Too early skips the same way, a data-only edition included (§0.4 row 185).
    for (const date of ["2026-10-16", "2026-10-15", "2026-10-14"]) {
      for (const force of [false, true]) {
        const r = run(date, "too_early", force);
        expect(r.state, `${date} ${force}`).toBe("skip_early");
        expect(r.note).toBe("Too early: the news window ends at 04:30; start the run then.");
      }
    }
    // A brief that does not parse counts as none.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-idem-"));
    tmp.push(dir);
    fs.mkdirSync(path.join(dir, "briefs"));
    fs.writeFileSync(path.join(dir, "briefs", `${D}.json`), "{ broken");
    expect(idempotency({ contentDir: dir, date: D, clock: "normal", force: false }).state).toBe("new");
  });

  it("PF8 checkCliAndToken: E_CLI and E_AUTH, the token trimmed and only read when the CLI is there", async () => {
    const bin = process.execPath;   // an executable file; cliVersion is injected, so it is never run
    const ok = vi.fn(async () => ({ ok: true, version: "2.1.316 (Claude Code)" }));
    const token = vi.fn(async () => "  test-token\n");
    expect(await checkCliAndToken({ readToken: token, bin, cliVersion: ok })).toEqual({ code: null, token: "test-token", version: "2.1.316 (Claude Code)" });
    expect(ok).toHaveBeenCalledWith(bin, 30_000);

    const noRead = vi.fn(async () => "never");
    expect(await checkCliAndToken({ readToken: noRead, bin, cliVersion: async () => ({ ok: false, version: null }) })).toEqual({ code: "E_CLI", token: null, version: null });
    expect(await checkCliAndToken({ readToken: noRead, bin, cliVersion: async () => { throw new Error("spawn failed"); } })).toMatchObject({ code: "E_CLI" });
    const notRun = vi.fn(async () => ({ ok: true, version: "x" }));
    expect(await checkCliAndToken({ readToken: noRead, bin: path.join(os.tmpdir(), "ct-no-such-claude"), cliVersion: notRun })).toMatchObject({ code: "E_CLI" });
    expect(await checkCliAndToken({ readToken: noRead, bin: os.tmpdir(), cliVersion: notRun })).toMatchObject({ code: "E_CLI" });   // a folder
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-cli-"));
    tmp.push(dir);
    const plain = path.join(dir, "claude");
    fs.writeFileSync(plain, "#!/bin/sh\n", { mode: 0o644 });
    expect(await checkCliAndToken({ readToken: noRead, bin: plain, cliVersion: notRun })).toMatchObject({ code: "E_CLI" });   // not executable
    expect(notRun).not.toHaveBeenCalled();
    expect(noRead).not.toHaveBeenCalled();

    for (const t of [async () => null, async () => "", async () => "   ", async () => { throw new Error("keychain locked"); }]) {
      expect(await checkCliAndToken({ readToken: t, bin, cliVersion: ok })).toEqual({ code: "E_AUTH", token: null, version: "2.1.316 (Claude Code)" });
    }
  });
});
