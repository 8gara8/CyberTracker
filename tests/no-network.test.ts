// The offline guard (SPEC §8.1 "No test touches the network"; ruling R56): tests/setup/offline.ts, loaded
// by vitest.config.ts before every test file, lets fetch reach only localhost and git only file:// remotes.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fetchFeed } from "@/lib/feeds/http";
import { offlineGuard } from "./setup/offline";

/** Runs `probe`, then takes the URLs it got blocked on out of the guard, so this file's afterAll stays green. */
async function blockedBy(probe: () => Promise<unknown>): Promise<string[]> {
  const before = offlineGuard.blocked.length;
  await probe();
  return offlineGuard.blocked.splice(before);
}

describe("tests/setup/offline.ts", () => {
  it("is loaded before every test file (vitest.config.ts setupFiles)", () => {
    const config = fs.readFileSync(path.join(__dirname, "..", "vitest.config.ts"), "utf8");
    expect(config).toMatch(/setupFiles:\s*\["tests\/setup\/offline\.ts"\]/);
    expect(globalThis.fetch).not.toBe(offlineGuard.realFetch);
  });

  it("rejects fetch to any other host, and records it", async () => {
    let error: unknown = null;
    const blocked = await blockedBy(() => fetch("https://example.org/ct-sample/probe").catch((e: unknown) => { error = e; }));
    expect(String(error)).toMatch(/A test tried the network: example\.org/);
    expect(blocked).toEqual(["https://example.org/ct-sample/probe"]);
  });

  it("turns fetchFeed() to a remote host into a network failure, recorded all the same", async () => {
    const blocked = await blockedBy(async () => {
      const r = await fetchFeed("https://example.com/ct-sample/feed.xml", { retryDelayMs: 0, timeoutMs: 2_000 });
      expect(r).toMatchObject({ ok: false });
    });
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((u) => u === "https://example.com/ct-sample/feed.xml")).toBe(true);
  });

  it("lets fetch reach a server on 127.0.0.1", async () => {
    const server = http.createServer((_req, res) => res.end("local"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe("local");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(offlineGuard.blocked).toEqual([]);
  });

  it("limits git children to file:// remotes", () => {
    expect(process.env.GIT_ALLOW_PROTOCOL).toBe("file");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-offline-"));
    try {
      const r = spawnSync("git", ["ls-remote", "https://github.com/CVEProject/cvelistV5.git", "refs/heads/main"], {
        cwd: tmp, encoding: "utf8", timeout: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/transport 'https' not allowed/);
      const repo = path.join(tmp, "repo");
      expect(spawnSync("git", ["init", "-q", repo], { encoding: "utf8" }).status).toBe(0);
      const local = spawnSync("git", ["ls-remote", `file://${repo}`], { encoding: "utf8", timeout: 20_000 });
      expect(local.status).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
