// lib/stale.ts (SPEC §7 "StaleBanner", Site tests "Stale"): isStale(), taipeiClock() and staleText(). The
// cases in tests/helpers/stale-cases.ts run here in the test process and again in child processes started
// with TZ=America/New_York and TZ=UTC (set before anything is imported, as on a reader's device), which must
// give the same results: the banner reads Taipei's clock, never the device's.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { taipeiTime, taipeiToday } from "@/lib/dates";
import { isStale, staleText, taipeiClock } from "@/lib/stale";
import { STALE_AFTER as RUN_STALE_AFTER } from "@/lib/site";
import { STALE_AFTER, STALE_CASES, runStaleCases, type StaleRun } from "@/tests/helpers/stale-cases";

const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

/** The cases run in a fresh process with TZ set before start. */
function runUnder(tz: string): StaleRun {
  const out = execFileSync(process.execPath, [TSX, path.join(ROOT, "tests", "helpers", "stale-cases.ts"), "--print"], {
    cwd: ROOT, env: { ...process.env, TZ: tz }, encoding: "utf8", timeout: 60_000,
  });
  return JSON.parse(out) as StaleRun;
}

describe("isStale (SPEC §7 Stale)", () => {
  it("uses run.json's schedule.stale_after, 08:00", () => {
    expect(RUN_STALE_AFTER).toBe(STALE_AFTER);
  });

  for (const c of STALE_CASES) {
    it(`${c.name}: ${c.stale ? "stale" : "not stale"}`, () => {
      expect(isStale(new Date(c.now), c.lastDate, STALE_AFTER)).toBe(c.stale);
    });
  }

  it("the newest edition dated 8 Nov is not stale at any minute of 8 Nov in Taipei", () => {
    const start = Date.parse("2026-11-07T16:00:00Z");
    for (let m = 0; m < 24 * 60; m += 1) expect(isStale(new Date(start + m * 60_000), "2026-11-08", STALE_AFTER)).toBe(false);
  });

  for (const tz of ["America/New_York", "UTC"]) {
    it(`gives the same results under TZ=${tz} (a child process)`, () => {
      const run = runUnder(tz);
      expect(run.tz).toBe(tz);
      // 8 Nov 2026 00:00 UTC is 19:00 the day before in New York (EST, UTC-5): the child really ran in that zone.
      expect(run.offset).toBe(tz === "UTC" ? 0 : 300);
      expect(run).toEqual({ ...runStaleCases(), tz, offset: run.offset });
      expect(run.results.map((r) => r.stale)).toEqual(STALE_CASES.map((c) => c.stale));
    });
  }
});

describe("taipeiClock and staleText", () => {
  it("reads Taipei's date and 24-hour time", () => {
    expect(taipeiClock(new Date("2026-11-07T23:59:00Z"))).toEqual({ date: "2026-11-08", time: "07:59" });
    expect(taipeiClock(new Date("2026-11-07T16:00:00Z"))).toEqual({ date: "2026-11-08", time: "00:00" });
    expect(taipeiClock(new Date("2026-11-08T15:59:00Z"))).toEqual({ date: "2026-11-08", time: "23:59" });
  });

  it("agrees with lib/dates.ts every 7 minutes for two days", () => {
    const start = Date.parse("2026-12-30T00:00:00Z");
    for (let m = 0; m < 2 * 24 * 60; m += 7) {
      const now = new Date(start + m * 60_000);
      expect(taipeiClock(now)).toEqual({ date: taipeiToday(now), time: taipeiTime(now) });
    }
  });

  it("staleText fills STALE_BANNER with the short date and the Taipei time", () => {
    expect(staleText("2026-11-07", "2026-11-07T05:12:00+08:00")).toBe("Not updated today. Last edition: 7 Nov 2026, 05:12");
    expect(staleText("2026-11-07", "2026-11-06T21:12:00Z")).toBe("Not updated today. Last edition: 7 Nov 2026, 05:12");
  });
});
