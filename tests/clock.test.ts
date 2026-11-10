// The run's clock (scripts/lib/clock.ts; plan §3.2, SPEC §8.2 "Clock rules, times and budgets"):
// realDeadline() converts a deadline on Deps.now for code that measures Date.now(), testClock() starts at
// a chosen Taipei time and advances with real time, hhmm() prints Taipei "HH:MM". Date.now is stubbed in
// each case, so nothing here waits.
import { afterEach, describe, expect, it, vi } from "vitest";
import { at } from "@/lib/dates";
import { MIN, hhmm, realDeadline, testClock } from "@/scripts/lib/clock";

const REAL = Date.UTC(2026, 10, 10, 1, 0, 0); // 2026-11-10 09:00 Taipei (01:00 UTC)
let now = REAL;
const tick = (ms: number) => {
  now += ms;
};

afterEach(() => {
  vi.restoreAllMocks();
  now = REAL;
});
const stubDateNow = () => vi.spyOn(Date, "now").mockImplementation(() => now);

describe("realDeadline", () => {
  it("CK1: keeps the time left on the run clock and moves it onto Date.now()", () => {
    stubDateNow();
    const logicalNow = at("2026-10-14", "04:37");
    const clock = () => logicalNow;
    expect(realDeadline(clock, logicalNow + 5 * MIN)).toBe(REAL + 5 * MIN);
    expect(realDeadline(clock, logicalNow)).toBe(REAL);
    // A deadline already passed on the run clock is already passed on the real one.
    expect(realDeadline(clock, logicalNow - 2 * MIN)).toBe(REAL - 2 * MIN);
    expect(realDeadline(clock, at("2026-10-14", "05:30"))).toBe(REAL + 53 * MIN);
  });

  it("CK2: an infinite deadline stays infinite; on Date.now itself it changes nothing", () => {
    stubDateNow();
    expect(realDeadline(() => 0, Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(realDeadline(() => 0, Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
    expect(realDeadline(Date.now, REAL + 90_000)).toBe(REAL + 90_000);
  });
});

describe("testClock", () => {
  it("CK3: starts at the given time and advances with real time", () => {
    stubDateNow();
    const start = at("2026-10-14", "04:37");
    const c = testClock(start);
    expect(c()).toBe(start);
    tick(1_500);
    expect(c()).toBe(start + 1_500);
    expect(hhmm(c())).toBe("04:37");
    tick(MIN);
    expect(hhmm(c())).toBe("04:38");
  });

  it("CK4: jump moves it forward and set puts it at a time; both keep advancing after", () => {
    stubDateNow();
    const c = testClock(at("2026-10-14", "04:37"));
    c.jump(20 * MIN);
    expect(c()).toBe(at("2026-10-14", "04:57"));
    tick(10_000);
    expect(c()).toBe(at("2026-10-14", "04:57") + 10_000);
    c.jump(0);
    expect(c()).toBe(at("2026-10-14", "04:57") + 10_000);
    c.set(at("2026-10-14", "10:59") + 58_000);
    expect(c()).toBe(at("2026-10-14", "10:59") + 58_000);
    tick(2_000);
    expect(hhmm(c())).toBe("11:00");
    // set may also move it back (a case that starts a second stage at an earlier time).
    c.set(at("2026-10-14", "04:30"));
    expect(hhmm(c())).toBe("04:30");
  });

  it("CK5: jump refuses a negative or non-finite step, set a non-finite time", () => {
    const c = testClock(at("2026-10-14", "04:37"));
    expect(() => c.jump(-1)).toThrow(/jump/);
    expect(() => c.jump(Number.NaN)).toThrow(/jump/);
    expect(() => c.jump(Number.POSITIVE_INFINITY)).toThrow(/jump/);
    expect(() => c.set(Number.NaN)).toThrow(/set/);
  });

  it("CK6: two clocks are independent, and realDeadline on a test clock matches its offset", () => {
    stubDateNow();
    const a = testClock(at("2026-10-14", "04:37"));
    const b = testClock(at("2026-10-15", "05:35"));
    a.jump(MIN);
    expect(hhmm(a())).toBe("04:38");
    expect(hhmm(b())).toBe("05:35");
    expect(realDeadline(a, at("2026-10-14", "05:30"))).toBe(REAL + 52 * MIN);
  });

  it("CK7: without a stub it still follows the real clock", async () => {
    const c = testClock(at("2026-10-14", "04:37"));
    const t0 = c();
    await new Promise((r) => setTimeout(r, 30));
    expect(c() - t0).toBeGreaterThanOrEqual(20);
    expect(c() - t0).toBeLessThan(60_000);
  });
});

describe("hhmm", () => {
  it("CK8: prints Taipei hours and minutes (UTC+8, no daylight saving)", () => {
    expect(hhmm(Date.UTC(2026, 9, 13, 20, 37, 59))).toBe("04:37");
    expect(hhmm(Date.UTC(2026, 9, 14, 16, 0, 0))).toBe("00:00");
    expect(hhmm(at("2026-10-14", "23:59"))).toBe("23:59");
  });
});
