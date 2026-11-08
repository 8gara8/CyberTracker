import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, releaseLock, STALE_AFTER_MS } from "@/scripts/lib/lock";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-lock-"));
  file = path.join(dir, "sub", "daily.lock");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (holder: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof holder === "string" ? holder : JSON.stringify(holder));
};

describe("lock", () => {
  it("takes a free lock and leaves no temp file behind", () => {
    const now = Date.parse("2026-11-09T04:37:00+08:00");
    expect(acquireLock(file, now)).toEqual({ acquired: true, replacedStale: null });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ pid: process.pid, started: new Date(now).toISOString() });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["daily.lock"]);
  });
  it("returns the holder instead of throwing when a live run already holds it", () => {
    const holder = { pid: process.ppid, started: new Date().toISOString() };
    write(holder);
    expect(acquireLock(file)).toEqual({ acquired: false, holder });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["daily.lock"]);
  });
  it("loses the race to a run that created the lock first", () => {
    const first = acquireLock(file);
    expect(first.acquired).toBe(true);
    const second = acquireLock(file);
    expect(second).toEqual({ acquired: false, holder: JSON.parse(fs.readFileSync(file, "utf8")) });
  });
  it("replaces a lock whose process is gone, one that is too old, and an unreadable one", () => {
    const now = Date.now();
    write({ pid: 2_147_483_646, started: new Date(now).toISOString() });
    expect(acquireLock(file, now)).toMatchObject({ acquired: true, replacedStale: expect.stringContaining("pid 2147483646") });
    write({ pid: process.ppid, started: new Date(now - STALE_AFTER_MS - 1).toISOString() });
    expect(acquireLock(file, now)).toMatchObject({ acquired: true });
    write("{half");
    expect(acquireLock(file, now)).toEqual({ acquired: true, replacedStale: "an unreadable lock file" });
  });
  it("never deletes a lock another run took after both read the same stale one", () => {
    const now = Date.now();
    write({ pid: 2_147_483_646, started: new Date(now - 60_000).toISOString() });
    let first: ReturnType<typeof acquireLock> | null = null;
    // The second run reads the stale lock; before it replaces it, the first run replaces it and takes
    // the lock. The second run must then lose, not delete the first run's fresh lock.
    const second = acquireLock(file, now + 2, { beforeReap: () => { first ??= acquireLock(file, now + 1); } });
    expect(first).toMatchObject({ acquired: true, replacedStale: expect.stringContaining("pid 2147483646") });
    const held = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(held).toEqual({ pid: process.pid, started: new Date(now + 1).toISOString() });
    expect(second).toEqual({ acquired: false, holder: held });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["daily.lock"]);
  });
  it("clears a reap marker left by a run that died, then replaces the stale lock", () => {
    const now = Date.now();
    const stale = JSON.stringify({ pid: 2_147_483_646, started: new Date(now).toISOString() });
    write(stale);
    const marker = `${file}.reap-${createHash("sha256").update(stale).digest("hex").slice(0, 16)}`;
    fs.writeFileSync(marker, JSON.stringify({ pid: 2_147_483_645, started: new Date(now).toISOString() }));
    expect(acquireLock(file, now)).toMatchObject({ acquired: true, replacedStale: expect.stringContaining("pid 2147483646") });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["daily.lock"]);
  });
  it("releases only its own lock", () => {
    write({ pid: process.ppid, started: new Date().toISOString() });
    releaseLock(file);
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(file);
    acquireLock(file);
    releaseLock(file);
    expect(fs.existsSync(file)).toBe(false);
  });
});
