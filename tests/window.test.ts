// lib/metrics/window.ts's pure helpers (SPEC §5.3): shareDirection(), speedDirection() and pacePhrase().
// P2 adds joinKev() and windowStats() here, with the CVE-2026-118527 re-join case.
import { describe, expect, it } from "vitest";
import { REFERENCE, REFERENCE_PACE_26W } from "@/lib/metrics/reference";
import { mannWhitneyZ, newcombe80, poissonCi80, Z80 } from "@/lib/metrics/stats";
import { MULTIPLES, pacePhrase, shareDirection, speedDirection } from "@/lib/metrics/window";
import { MIN_N } from "@/lib/vocab";

describe("shareDirection (two-sample, newcombe80 against 104 of 282)", () => {
  it("calls D.3's w26 (58 of 157) no clear change", () => {
    expect(shareDirection({ cohort_n: 157, at_disclosure_n: 58 })).toBe("no_clear_change");
  });

  it("calls a clearly higher or lower share", () => {
    expect(shareDirection({ cohort_n: 157, at_disclosure_n: 90 })).toBe("higher");
    expect(shareDirection({ cohort_n: 157, at_disclosure_n: 30 })).toBe("lower");
  });

  it("says n_too_small below MIN_N, and decides at MIN_N", () => {
    expect(shareDirection({ cohort_n: MIN_N - 1, at_disclosure_n: MIN_N - 1 })).toBe("n_too_small");
    expect(shareDirection({ cohort_n: MIN_N, at_disclosure_n: MIN_N })).toBe("higher");
  });

  it("agrees with the sign of the interval's bounds at the edges", () => {
    for (let k = 0; k <= 157; k += 1) {
      const [lo, hi] = newcombe80(k, 157, 104, 282);
      const want = lo > 0 ? "higher" : hi < 0 ? "lower" : "no_clear_change";
      expect(shareDirection({ cohort_n: 157, at_disclosure_n: k })).toBe(want);
    }
  });
});

describe("speedDirection (Mann-Whitney against REFERENCE.after_lags)", () => {
  const ref: readonly number[] = REFERENCE.after_lags;

  it("calls the reference against itself no clear change", () => {
    expect(speedDirection({ after_disclosure_n: ref.length }, ref)).toBe("no_clear_change");
  });

  it("calls shorter lags faster and longer lags slower", () => {
    const short = Array.from({ length: 60 }, (_, i) => 2 + (i % 10));
    const long = Array.from({ length: 60 }, (_, i) => 60 + i * 4);
    expect(mannWhitneyZ(short, ref)).toBeLessThan(-Z80);
    expect(speedDirection({ after_disclosure_n: 60 }, short)).toBe("faster");
    expect(mannWhitneyZ(long, ref)).toBeGreaterThan(Z80);
    expect(speedDirection({ after_disclosure_n: 60 }, long)).toBe("slower");
  });

  it("says n_too_small below MIN_N and refuses lags that don't match the count", () => {
    expect(speedDirection({ after_disclosure_n: MIN_N - 1 }, [])).toBe("n_too_small");
    expect(() => speedDirection({ after_disclosure_n: 40 }, ref.slice(0, 39))).toThrow(/39 lags/);
  });
});

describe("pacePhrase (§5.3 Volume)", () => {
  it("gives D.3's 'more than twice' for 157 (Poisson 80% interval 141.2 to 174.3 excludes 70.21)", () => {
    const [lo, hi] = poissonCi80(157);
    expect(lo > REFERENCE_PACE_26W || hi < REFERENCE_PACE_26W).toBe(true);
    expect(pacePhrase(157)).toBe("more than twice");
  });

  it("says 'in line with' while the interval holds the reference pace", () => {
    expect(pacePhrase(70)).toBe("in line with");
    expect(pacePhrase(60)).toBe("in line with");
    expect(pacePhrase(80)).toBe("in line with");
    expect(pacePhrase(82)).toBe("17% above"); // its interval starts above 70.21
  });

  it("gives a percentage from the stored ratio in basis points, capped at 99", () => {
    expect(pacePhrase(85)).toBe("21% above"); // 85 / 70.21 = 1.2106
    expect(pacePhrase(55)).toBe("22% below"); // 0.7834
    expect(pacePhrase(140)).toBe("99% above"); // 1.9940: under twice, capped
    expect(pacePhrase(0)).toBe("99% below");
  });

  it("names multiples from twice to ten times", () => {
    expect(MULTIPLES[2]).toBe("twice");
    expect(MULTIPLES[10]).toBe("ten times");
    expect(pacePhrase(141)).toBe("more than twice");
    expect(pacePhrase(250)).toBe("more than three times");
    expect(pacePhrase(700)).toBe("more than nine times");
    expect(pacePhrase(2000)).toBe("more than ten times");
  });
});
