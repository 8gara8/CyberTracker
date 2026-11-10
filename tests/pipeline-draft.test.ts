// The missing-CVE fetch (SPEC §8.2 stage 7; plan §2.5 L4): fetchMissingCveRecords() caps at 50, skips
// cached records and writes each record as collect does. Offline: a fake fetchFeed answers every request.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { cachePaths } from "@/lib/feeds/cache";
import { cveRecordRawUrl } from "@/lib/feeds/github";
import type { fetchFeed, FetchResult } from "@/lib/feeds/http";
import { jsonText } from "@/lib/json";
import { cveLookupFromDir } from "@/lib/validate";
import { CVE_FETCH_MAX, fetchMissingCveRecords } from "@/scripts/lib/cve-fetch";
import { REPO } from "./helpers/harness";

const config = loadConfig({ root: REPO });
const TEMPLATE = JSON.parse(fs.readFileSync(path.join(REPO, "fixtures", "feeds", "cvelist", "by-id", "CVE-2026-104935.json"), "utf8")) as {
  cveMetadata: { cveId: string };
};
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const answer = (url: string, status: number, body: string | null): FetchResult => ({
  ok: status >= 200 && status < 300, status, finalUrl: url, body: body === null ? null : Buffer.from(body), contentType: "application/json",
  error: status >= 200 && status < 300 ? null : `http_${status}`, detail: null, durationMs: 1, attempts: 1,
});

describe("fetchMissingCveRecords", () => {
  it("CF1 fetches at most 50 records in CVE order, skips cached ones and writes each as collect does", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-cve-fetch-"));
    roots.push(root);
    const dir = cachePaths(root).recordsDir;
    fs.mkdirSync(dir, { recursive: true });
    const cached = "CVE-2026-90001";
    fs.writeFileSync(path.join(dir, `${cached}.json`), "cached\n");
    const calls: string[] = [];
    const record = (id: string) => ({ ...TEMPLATE, cveMetadata: { ...TEMPLATE.cveMetadata, cveId: id } });
    const fake = (async (url: string) => {
      calls.push(url);
      const id = /\/(CVE-\d{4}-\d+)\.json$/.exec(url)![1]!;
      if (id === "CVE-2026-90003") return answer(url, 404, null);
      if (id === "CVE-2026-90004") return answer(url, 200, "not json");
      return answer(url, 200, JSON.stringify(record(id)));
    }) as typeof fetchFeed;
    const ids = Array.from({ length: 60 }, (_, k) => `CVE-2026-${90060 - k}`); // newest first: the cap keeps CVE order
    const log: string[] = [];
    const r = await fetchMissingCveRecords({
      root, cveIds: [...ids, cached, "cve-2026-90002", "not-a-cve", cached], deadline: Date.now() + 30_000, config, fetch: fake, log: (l) => log.push(l),
    });
    const inOrder = [...ids].reverse().filter((id) => id !== cached); // 90002 .. 90060 (59 ids)
    const asked = inOrder.slice(0, CVE_FETCH_MAX);
    expect(CVE_FETCH_MAX).toBe(50);
    expect(calls).toHaveLength(50);
    expect(calls.sort()).toEqual(asked.map((id) => cveRecordRawUrl("0".repeat(40), id).replace(`/${"0".repeat(40)}/`, "/main/")).sort());
    expect(r.fetched).toEqual(asked.filter((id) => id !== "CVE-2026-90003" && id !== "CVE-2026-90004"));
    expect(r.missing).toEqual(["CVE-2026-90003", "CVE-2026-90004", ...inOrder.slice(CVE_FETCH_MAX)]);
    expect(fs.readFileSync(path.join(dir, `${cached}.json`), "utf8")).toBe("cached\n");
    expect(fs.readFileSync(path.join(dir, "CVE-2026-90002.json"), "utf8")).toBe(jsonText(record("CVE-2026-90002")));
    expect(fs.existsSync(path.join(dir, "CVE-2026-90003.json"))).toBe(false);
    expect(log).toContain("cvelist: 9 more CVE records named in the draft, over the cap of 50, not fetched.");
    // The validator's lookup reads what was written.
    expect(cveLookupFromDir(dir).get("CVE-2026-90002")?.cve_id).toBe("CVE-2026-90002");

    // A second call skips everything now cached and asks only for what is still missing.
    calls.length = 0;
    const again = await fetchMissingCveRecords({ root, cveIds: ["CVE-2026-90002", "CVE-2026-90003"], deadline: Date.now() + 30_000, config, fetch: fake });
    expect(calls).toHaveLength(1);
    expect(again).toEqual({ fetched: [], missing: ["CVE-2026-90003"] });
  });

  it("CF1 reads at the commit collect read, and starts nothing past the deadline", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-cve-fetch-"));
    roots.push(root);
    const sha = "a".repeat(40);
    const p = cachePaths(root);
    fs.mkdirSync(p.feedsDir, { recursive: true });
    fs.writeFileSync(p.collectInputs, JSON.stringify({ commits: { cvelist: sha } }));
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return answer(url, 404, null);
    }) as typeof fetchFeed;
    // An inputs file that does not parse falls back to main.
    await fetchMissingCveRecords({ root, cveIds: ["CVE-2026-90010"], deadline: Date.now() + 30_000, config, fetch: fake });
    expect(calls).toEqual([cveRecordRawUrl("0".repeat(40), "CVE-2026-90010").replace(`/${"0".repeat(40)}/`, "/main/")]);
    calls.length = 0;
    const late = await fetchMissingCveRecords({ root, cveIds: ["CVE-2026-90011"], deadline: Date.now() - 1, config, fetch: fake });
    expect(calls).toEqual([]);
    expect(late).toEqual({ fetched: [], missing: ["CVE-2026-90011"] });
  });
});
