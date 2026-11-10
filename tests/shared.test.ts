// The P2 shared helpers every package builds on: lib/json.ts (one way to print a file, one SHA-256),
// lib/ids.ts (explicit id comparators, never localeCompare), lib/feeds/cache.ts (every cache path) and
// lib/feeds/types.ts's FeedParseError. Values are invented.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cachePaths } from "@/lib/feeds/cache";
import { FeedParseError } from "@/lib/feeds/types";
import { byCodeUnit, compareCveIds, compareIds } from "@/lib/ids";
import { jsonText, sha256Hex } from "@/lib/json";
import { jsonText as fixtureJsonText } from "@/fixtures/src/build";

describe("lib/json.ts", () => {
  const Sample = z.strictObject({ b: z.number(), a: z.string() });

  it("prints schema key order, two-space indent, LF and a trailing newline", () => {
    expect(jsonText({ a: "x", b: 1 }, Sample)).toBe('{\n  "b": 1,\n  "a": "x"\n}\n');
    expect(jsonText({ z: [1, 2] })).toBe('{\n  "z": [\n    1,\n    2\n  ]\n}\n');
    expect(() => jsonText({ a: 1, b: "x" }, Sample)).toThrow();
  });

  it("is the function the fixtures builder re-exports", () => {
    expect(fixtureJsonText).toBe(jsonText);
  });

  it("hashes strings as UTF-8 and buffers as bytes, in lower-case hex", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(Buffer.from("abc"))).toBe(sha256Hex("abc"));
    expect(sha256Hex("台灣")).toBe(sha256Hex(Buffer.from("台灣", "utf8")));
  });
});

describe("lib/ids.ts", () => {
  it("byCodeUnit is plain code-unit order", () => {
    expect(["b", "B", "a", "_", "10", "9"].sort(byCodeUnit)).toEqual(["10", "9", "B", "_", "a", "b"]);
    expect(byCodeUnit("x", "x")).toBe(0);
  });

  it("compareCveIds orders by year, then sequence number, numerically", () => {
    const ids = ["CVE-2026-1000", "CVE-2025-99999", "CVE-2026-999", "CVE-2026-10000", "CVE-2024-0001"];
    expect(ids.sort(compareCveIds)).toEqual(["CVE-2024-0001", "CVE-2025-99999", "CVE-2026-999", "CVE-2026-1000", "CVE-2026-10000"]);
    expect(compareCveIds("CVE-2026-0999", "CVE-2026-999")).not.toBe(0);
    expect(compareCveIds("CVE-2026-1", "CVE-2026-1")).toBe(0);
  });

  it("compareIds puts CVE ids first, then everything else in code-unit order", () => {
    const ids = ["GHSA-xxxx-yyyy-zzzz", "CVE-2026-1000", "GHSA-aaaa-bbbb-cccc", "CVE-2026-999", "ANT-2026-SAMPLE"];
    expect(ids.sort(compareIds)).toEqual(["CVE-2026-999", "CVE-2026-1000", "ANT-2026-SAMPLE", "GHSA-aaaa-bbbb-cccc", "GHSA-xxxx-yyyy-zzzz"]);
  });

  it("gives one order whatever order the input arrives in", () => {
    const ids = ["CVE-2023-5", "GHSA-2222-3333-4444", "CVE-2023-40", "CVE-2022-100", "GHSA-2222-3333-4443", "CVE-2023-040"];
    const a = [...ids].sort(compareIds);
    const b = [...ids].reverse().sort(compareIds);
    expect(b).toEqual(a);
  });
});

describe("lib/feeds/cache.ts", () => {
  const root = path.join(path.sep, "repo");
  const p = cachePaths(root);
  const at = (...parts: string[]) => path.join(root, ...parts);

  it("names every cache path under the root", () => {
    expect(p.feedsDir).toBe(at("cache", "feeds"));
    expect(p.feedIndex).toBe(at("cache", "feeds", "index.json"));
    expect(p.collectInputs).toBe(at("cache", "feeds", "inputs.json"));
    expect(p.feedBody("kev", "json")).toBe(at("cache", "feeds", "kev.json"));
    expect(p.feedBody("cvelist", "deltaLog.json")).toBe(at("cache", "feeds", "cvelist.deltaLog.json"));
    expect(p.feedBody("anthropic-cvd", "payload.json")).toBe(at("cache", "feeds", "anthropic-cvd.payload.json"));
    expect(p.zipsDir).toBe(at("cache", "cvelist", "zips"));
    expect(p.zip("2026-10-12_all_CVEs_at_end_of_day.zip")).toBe(at("cache", "cvelist", "zips", "2026-10-12_all_CVEs_at_end_of_day.zip"));
    expect(p.recordsDir).toBe(at("cache", "cvelist", "records"));
    expect(p.epssFile("2026-10-12")).toBe(at("cache", "epss", "epss_scores-2026-10-12.csv.gz"));
    expect(p.ghsaDir).toBe(at("cache", "ghsa"));
    expect(p.cvelistClone).toBe(at("cache", "cvelistV5"));
    expect(p.stagedMetrics("2026-10-14")).toBe(at("cache", "staged", "2026-10-14"));
    expect(p.stagedBackfill).toBe(at("cache", "staged", "backfill"));
    expect(p.recompute("2026-10-14")).toBe(at("logs", "recompute", "2026-10-14"));
  });

  it("refuses a name that could leave its folder", () => {
    expect(() => p.feedBody("../kev", "json")).toThrow(/feed id/);
    expect(() => p.feedBody("kev", "json/../../x")).toThrow(/extension/);
    expect(() => p.feedBody("Kev", "json")).toThrow(/feed id/);
    expect(() => p.zip("../evil.zip")).toThrow(/zip asset/);
    expect(() => p.zip(".hidden.zip")).toThrow(/zip asset/);
    expect(() => p.epssFile("2026-10-1")).toThrow(/date/);
    expect(() => p.stagedMetrics("../2026-10-14")).toThrow(/date/);
    expect(() => p.recompute("today")).toThrow(/date/);
  });
});

describe("lib/feeds/types.ts", () => {
  it("FeedParseError carries its class and message", () => {
    const e = new FeedParseError("schema", "count does not match");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("FeedParseError");
    expect(e.errorClass).toBe("schema");
    expect(e.message).toBe("count does not match");
  });
});
