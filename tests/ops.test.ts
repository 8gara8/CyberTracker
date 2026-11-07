// The ops plumbing (SPEC §9.4, §8.8 ops mode): the command table, the 60-line report, the probe's host
// list and the ops publish, on a local bare repo (never the network).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { latestReport, OPS_COMMANDS, parseCommand, plan } from "@/scripts/ops";
import { EXTRA_TARGETS, FALLBACK_HOSTS, reachable, refusalClass, targets } from "@/scripts/probe";
import { commitTitle, PublishError, publishOps } from "@/scripts/publish";

const root = path.join(__dirname, "..");
const now = new Date("2026-11-07T21:47:00Z"); // 05:47 Taipei on 2026-11-08

describe("ops commands", () => {
  it("maps each command to a script and a branch (SPEC §9.4)", () => {
    expect(plan("probe", undefined, now, "full")).toEqual({ argv: ["scripts/probe.ts", "--fired", "--hold-minutes", "112"], branch: "ops/probe-20261108-0547", phase: "P0" });
    expect(plan("agent-check", undefined, now, "custom").argv).toEqual(["scripts/agent-check.ts", "--all", "--network", "custom"]);
    expect(plan("agent-check-passthrough", undefined, now, "full").branch).toBe("ops/agent-check-passthrough-20261108-0547");
    expect(plan("dry-run", "2026-11-09", now, "full")).toMatchObject({ branch: "ops/dry-runs", phase: "P3" });
    expect(plan("backfill-publish", undefined, now, "full").branch).toBeNull();
    expect(plan("tools", undefined, now, "full")).toEqual({ argv: null, branch: null, phase: "P0" });
    for (const c of OPS_COMMANDS) {
      const b = plan(c, "2026-11-09", now, "full").branch;
      if (b) expect(b).toMatch(/^ops\/[a-z0-9][a-z0-9-]*$/);
    }
  });
  it("accepts only known commands, and a date where one is needed", () => {
    expect(parseCommand(["probe"])).toEqual({ command: "probe", arg: undefined });
    expect(parseCommand(["dry-run", "2026-11-09"])).toEqual({ command: "dry-run", arg: "2026-11-09" });
    expect(parseCommand(["dry-run"])).toBeNull();
    expect(parseCommand(["dry-run", "tomorrow"])).toBeNull();
    expect(parseCommand(["rm", "-rf"])).toBeNull();
    expect(parseCommand([])).toBeNull();
  });
  it("keeps ops-latest.md to 60 lines", () => {
    const base = { command: "probe", branch: "p0-setup", commit: "abc", started: "s", ended: "e", exit: 0, pushed: "ops/probe-x at 123" };
    const long = latestReport({ ...base, report: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") });
    expect(long.trimEnd().split("\n")).toHaveLength(60);
    expect(long).toContain("line 199");
    expect(long).toContain("(earlier lines are in the ops branch report)");
    expect(latestReport({ ...base, report: "short" }).trimEnd().split("\n")).toHaveLength(7);
  });
});

describe("the probe", () => {
  const list = targets(fs.readFileSync(path.join(root, "config", "sources.yaml"), "utf8"));
  it("checks every registry URL, the 20 fallback hosts and the extras", () => {
    expect(FALLBACK_HOSTS).toHaveLength(20);
    expect(new Set(FALLBACK_HOSTS).size).toBe(20);
    for (const h of FALLBACK_HOSTS) expect(list.some((t) => t.group === "fallback" && t.url === `https://${h}/`)).toBe(true);
    for (const t of EXTRA_TARGETS) expect(list).toContainEqual(t);
    for (const host of ["services.nvd.nist.gov", "krebsonsecurity.com", "techcrunch.com", "api.github.com", "registry.npmjs.org", "www.qnap.com", "epss.cyentia.com"]) {
      expect(list.some((t) => new URL(t.url).hostname === host), host).toBe(true);
    }
    expect(list.filter((t) => t.group === "registry").length).toBeGreaterThan(30);
    for (const t of list) expect(t.url.startsWith("https://"), t.url).toBe(true);
  });
  it("counts a host as reachable when any status came back", () => {
    expect(reachable({ status: 403, error: null })).toBe(true);
    expect(reachable({ status: null, error: "dns" })).toBe(false);
  });
  it("reduces refusals to fixed phrases", () => {
    expect(refusalClass("remote: Permission to 8gara8/CyberTracker.git denied to someone.\nfatal: unable to access")).toBe("permission denied");
    expect(refusalClass("HTTP 403: Resource not accessible (https://api.github.com/x)")).toBe("403 forbidden");
    expect(refusalClass("gh: Not Found (HTTP 404)")).toBe("404 not found");
    expect(refusalClass("")).toBe("no error text");
    expect(refusalClass("something odd http://10.0.0.1:8080 tok_abc")).toBe("refused (other)");
  });
});

describe("publish, ops mode", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-ops-test-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const bare = path.join(tmp, "content.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const from = path.join(tmp, "stage");
  fs.mkdirSync(path.join(from, "ops-reports", "probe-1"), { recursive: true });
  fs.writeFileSync(path.join(from, "ops-reports", "probe-1", "report.md"), "# report\n");

  it("titles commits with the command and Taipei time only", () => {
    expect(commitTitle("ops", { command: "probe", at: now })).toBe("ops: probe 2026-11-08 05:47");
    expect(() => commitTitle("ops", { command: "probe; rm", at: now })).toThrow(PublishError);
  });
  it("refuses main and anything outside ops/", async () => {
    for (const branch of ["main", "refs/heads/main", "ops/", "ops/Upper", "ops/a/b", "feature/x"]) {
      await expect(publishOps({ branch, from, command: "probe", remote: bare })).rejects.toThrow(/refused/);
    }
  });
  it("pushes the folder to a new ops branch on an empty repo, then adds to it", async () => {
    const r1 = await publishOps({ branch: "ops/probe-20261108-0547", from, command: "probe", remote: bare, now });
    expect(r1.files).toEqual(["ops-reports/probe-1/report.md"]);
    const git = (...a: string[]) => execFileSync("git", ["--git-dir", bare, ...a], { encoding: "utf8" }).trim();
    expect(git("rev-parse", "refs/heads/ops/probe-20261108-0547")).toBe(r1.sha);
    expect(git("log", "-1", "--format=%s", r1.sha)).toBe("ops: probe 2026-11-08 05:47");
    expect(() => git("rev-parse", "--verify", "-q", "refs/heads/main")).toThrow();

    fs.writeFileSync(path.join(from, "ops-reports", "probe-1", "meta.json"), "{}\n");
    const r2 = await publishOps({ branch: "ops/probe-20261108-0547", from, command: "probe", remote: bare, now });
    expect(git("rev-parse", `${r2.sha}^`)).toBe(r1.sha);
    expect(git("ls-tree", "-r", "--name-only", r2.sha).split("\n")).toEqual(["ops-reports/probe-1/meta.json", "ops-reports/probe-1/report.md"]);
  });
});
