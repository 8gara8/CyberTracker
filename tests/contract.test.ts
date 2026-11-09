// The P2 contract (step S0): every module the work packages fill loads, and the constants whose values
// SPEC.md states keep them. The functions themselves are tested by their owners' test files.
import { describe, expect, it } from "vitest";
import { FEED_MAX_BYTES, FEED_TIMEOUTS } from "@/lib/feeds/http";
import { REPOS } from "@/lib/feeds/github";
import { EXCHANGE_TERMS } from "@/lib/feeds/exchange";
import { JOIN_FROM } from "@/lib/metrics/window";
import { SERIES_FROM } from "@/lib/metrics/series";
import { CVD_STALE_DAYS, GHSA_UNFIXED_KEPT } from "@/lib/metrics/fix-side";
import { AI_NOTES, matchCredit } from "@/lib/metrics/ai-credit";
import { matchCredit as configMatchCredit } from "@/lib/config";
import { REFERENCE_JOIN_SHA256 } from "@/lib/metrics/reference";

const MB = 1024 * 1024;

const MODULES = [
  "@/lib/feeds/types", "@/lib/feeds/cache", "@/lib/feeds/http", "@/lib/feeds/github", "@/lib/feeds/zip", "@/lib/feeds/kev",
  "@/lib/feeds/cvelist", "@/lib/feeds/epss", "@/lib/feeds/ghsa", "@/lib/feeds/anthropic-cvd", "@/lib/feeds/nvd", "@/lib/feeds/myjvn",
  "@/lib/feeds/rss", "@/lib/feeds/exchange", "@/lib/rank", "@/lib/regions", "@/lib/metrics/window", "@/lib/metrics/kev-index",
  "@/lib/metrics/flood", "@/lib/metrics/series", "@/lib/metrics/index", "@/lib/metrics/ai-credit", "@/lib/metrics/fix-side",
  "@/lib/metrics/reference", "@/lib/schema/reference", "@/scripts/lib/git-source", "@/scripts/lib/feed-cache",
  "@/scripts/lib/cvelist-clone", "@/scripts/lib/appendix-d", "@/scripts/collect", "@/scripts/metrics", "@/scripts/backfill",
] as const;

describe("the P2 contract", () => {
  it.each(MODULES)("%s loads", async (m) => {
    await expect(import(/* @vite-ignore */ m)).resolves.toBeTypeOf("object");
  });

  it("keeps the harness limits of §8.3", () => {
    expect(FEED_TIMEOUTS).toEqual({ default: 15_000, kev: 30_000, nvd: 30_000, myjvn: 30_000, epss: 60_000, deltaLog: 90_000, zip: 90_000 });
    expect(FEED_MAX_BYTES).toEqual({ default: 5 * MB, kev: 20 * MB, epss: 20 * MB, deltaLog: 64 * MB, zip: 64 * MB, snapshot: 3 * MB });
  });

  it("keeps the values the spec states", () => {
    expect(REPOS).toEqual({ cvelist: "CVEProject/cvelistV5", kev: "cisagov/kev-data", ghsa: "github/advisory-database" });
    expect(EXCHANGE_TERMS).toEqual(["資安", "網路攻擊", "駭客", "勒索"]);
    expect(JOIN_FROM).toBe("2023-01-01");
    expect(SERIES_FROM).toBe("2023-01-02");
    expect(GHSA_UNFIXED_KEPT).toBe(true);
    expect(CVD_STALE_DAYS).toBe(14);
    expect(AI_NOTES.recomputed(2)).toBe("AI-finder list changed to v2; history recomputed.");
    expect(AI_NOTES.prefilterChanged.length).toBeLessThanOrEqual(200);
    expect(matchCredit).toBe(configMatchCredit);
    expect(REFERENCE_JOIN_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});
