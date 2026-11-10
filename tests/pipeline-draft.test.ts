// The pipeline draft (plan §2.5 L4, risk 2; SPEC §8.2 stage 7, §4.12) and the missing-CVE fetch.
// PD1 and PD2: fixtures/agent/drafts/2026-10-14.json, the draft the fake agent writes in the integration
// tests, against the inputs the real code builds for 2026-10-14 at 04:37 from fixtures/state and
// fixtures/feeds (collect and runMetrics in a temp root, regionsBaseFor, buildContext with daily's
// deadline for a 04:37 start, buildEvidence with a transcript written from --fetches.json, snapshots of
// the cited pages from fixtures/feeds/pages through fetchFeed's fixture mode, and the cached CVE records).
// CF1: fetchMissingCveRecords() caps at 50, skips cached records and writes each record as collect does,
// with a fake fetchFeed. Offline throughout; everything read from the fixtures is data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildContext } from "@/lib/context";
import { loadConfig } from "@/lib/config";
import { at } from "@/lib/dates";
import { cachePaths } from "@/lib/feeds/cache";
import { cveRecordRawUrl } from "@/lib/feeds/github";
import type { fetchFeed, FetchResult } from "@/lib/feeds/http";
import { jsonText } from "@/lib/json";
import { cveIdsIn } from "@/lib/rules/cves";
import type { AgentContext } from "@/lib/schema/context";
import { normalizeUrl } from "@/lib/urls";
import { cveLookupFromDir, packDatesOf, validateDraft, type DraftInputs, type ValidationResult } from "@/lib/validate";
import { CVE_FETCH_MAX, fetchMissingCveRecords } from "@/scripts/lib/cve-fetch";
import { buildEvidence } from "@/scripts/lib/evidence";
import { citedUnseen, snapshotUrls, type Snapshot } from "@/scripts/lib/snapshot";
import { parseTranscript } from "@/scripts/lib/transcript";
import { validateLoop, type ValidateLoopIo } from "@/scripts/lib/validate-loop";
import { REPO } from "./helpers/harness";
import { buildPipelineWorld, transcriptJsonl, type PipelineWorld } from "./helpers/pipeline-world";

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

const AGENT = path.join(REPO, "fixtures", "agent", "drafts");
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(AGENT, file), "utf8"));
const draft = readJson("2026-10-14.json") as { generated_at: string; sources: { url: string; source_type: string }[] };
const invalid = readJson("2026-10-14--invalid.json");
const fetches = readJson("2026-10-14--fetches.json") as string[];
const FEEDS = path.join(REPO, "fixtures", "feeds");
const index = JSON.parse(fs.readFileSync(path.join(FEEDS, "index.json"), "utf8")) as Record<string, { file?: string; content_type?: string; status?: number }>;
const transcript = parseTranscript(transcriptJsonl({ fetches }));
const codes = (r: ValidationResult) => ({ errors: r.errors.map((i) => `${i.code} ${i.path}`), warnings: r.warnings.map((i) => `${i.code} ${i.path}`) });

describe("the pipeline draft against the fixture morning", () => {
  let w: PipelineWorld;
  let context: AgentContext;
  let base: Omit<DraftInputs, "evidence" | "cveList">;
  /** One snapshot round of the cited pages with no seen text, as the loop's first check runs it. */
  const snapshotRound = async (value: unknown) => {
    const unseen = citedUnseen(value, buildEvidence({ transcripts: [transcript], pack: w.pack, snapshots: [] }));
    const r = await snapshotUrls({ root: w.root, urls: unseen, deadline: Date.now() + 60_000, config: w.config });
    return { unseen, ...r };
  };
  /** The loop's real I/O over the world: fetchMissingCveRecords, snapshotUrls, buildEvidence and the records directory. */
  const realIo = (drafts: unknown[]) => {
    const snaps: Snapshot[] = [];
    const lines: string[] = [];
    const results: ValidationResult[] = [];
    let k = 0;
    const io: ValidateLoopIo = {
      readDraft: () => ({ ok: true, value: drafts[Math.min(k, drafts.length - 1)] }),
      writeDraft: () => {
        throw new Error("no round 2 expected");
      },
      fetchCves: async (ids) => {
        await fetchMissingCveRecords({ root: w.root, cveIds: ids, deadline: Date.now() + 60_000, config: w.config });
      },
      snapshot: async (urls) => {
        snaps.push(...(await snapshotUrls({ root: w.root, urls, deadline: Date.now() + 60_000, config: w.config })).taken);
      },
      evidence: () => buildEvidence({ transcripts: [transcript], pack: w.pack, snapshots: snaps }),
      cveList: () => cveLookupFromDir(w.paths.cveRecords),
      repair: async () => {
        k++;
      },
      repairBudgetMs: () => 10 * 60_000,
      log: (l) => lines.push(l),
      writeValidation: (r) => results.push(r),
      writeDropped: () => {
        throw new Error("nothing should be dropped");
      },
    };
    return { io, snaps, lines, results };
  };

  beforeAll(async () => {
    w = await buildPipelineWorld();
    // daily's deadline for a 04:37 start: now + attemptBudget (30 agent minutes) - 5 min = 05:02 Taipei.
    context = buildContext({
      date: w.date, now: w.start, deadline: w.start + 25 * 60_000, pack: w.pack, candidates: w.candidates, metrics: w.metrics, config: w.config,
      history: w.history, corrections: null, scoreboard: null, regionsBase: w.regionsBase, recheck: null, standingLast: w.standingLast,
    }).context;
    base = { context, metrics: w.metrics, config: w.config, regionsBase: w.regionsBase, packDates: packDatesOf(w.pack), fileDate: w.date };
  }, 120_000);
  afterAll(() => w?.dispose());

  it("PD1 names only CVEs whose records that morning's collect cached, so the missing-CVE fetch asks for nothing", async () => {
    const ids = cveIdsIn(JSON.stringify(draft));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(fs.existsSync(path.join(w.paths.cveRecords, `${id}.json`)), id).toBe(true);
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return answer(url, 404, null);
    }) as typeof fetchFeed;
    const r = await fetchMissingCveRecords({ root: w.root, cveIds: ids, deadline: Date.now() + 60_000, config: w.config, fetch: fake });
    expect(calls).toEqual([]);
    expect(r).toEqual({ fetched: [], missing: [] });
  }, 120_000);

  it("PD1 every cited URL the pack does not hold has a fixture page, --fetches.json lists them, and each snapshot has text", async () => {
    const r = await snapshotRound(draft);
    expect([...r.unseen].sort()).toEqual([...fetches].sort());
    const pack = new Set(buildEvidence({ transcripts: [], pack: w.pack, snapshots: [] }).urls);
    for (const s of draft.sources) {
      if (pack.has(normalizeUrl(s.url))) continue;
      expect(fetches, s.url).toContain(s.url);
      expect(index[s.url]?.file, s.url).toMatch(/^pages\/[a-z0-9-]+\.html$/);
      expect(index[s.url]?.content_type, s.url).toBe("text/html; charset=utf-8");
    }
    expect(r.failed).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.taken.map((s) => s.url).sort()).toEqual([...fetches].sort());
    for (const s of r.taken) {
      expect(s.status, s.url).toBe(200);
      expect(s.text.length, s.url).toBeGreaterThan(40);
      expect(s.text, s.url).not.toMatch(/SAMPLE (?:site menu|footer)/); // nav and footer dropped, article read
    }
  }, 120_000);

  it("PD1 the data-only edition's two CVE record pages answer 200 in fixture mode", () => {
    for (const id of ["CVE-2026-104935", "CVE-2026-96951"]) {
      const e = index[`https://www.cve.org/CVERecord?id=${id}`];
      expect(e?.status ?? 200, id).toBe(200);
      expect(e?.file && fs.existsSync(path.join(FEEDS, e.file)), id).toBe(true);
    }
  });

  it("PD1 validates with 0 errors and 0 warnings against the real context, evidence, snapshots, metrics, records and regions base", async () => {
    // generated_at sits inside [window end, deadline], 04:30 to 05:02, for any start from 04:31 on.
    expect(draft.generated_at).toBe("2026-10-14T04:55:00+08:00");
    expect(Date.parse(draft.generated_at)).toBeGreaterThanOrEqual(Date.parse(context.window.end));
    expect(Date.parse(draft.generated_at)).toBeLessThanOrEqual(at(w.date, "05:02"));
    const r = await snapshotRound(draft);
    const evidence = buildEvidence({ transcripts: [transcript], pack: w.pack, snapshots: r.taken });
    const v = validateDraft(draft, { ...base, evidence, cveList: cveLookupFromDir(w.paths.cveRecords) });
    expect(codes(v)).toEqual({ errors: [], warnings: [] });
    expect(v.draft).not.toBeNull();
  }, 120_000);

  it("PD1 the validate loop with the real I/O is clean at once: no repair, nothing dropped", async () => {
    const t = realIo([draft]);
    const out = await validateLoop(1, base, t.io, { repairsUsed: 0, maxRepairs: config.run.budgets.repair_rounds });
    expect(codes(out.result)).toEqual({ errors: [], warnings: [] });
    expect(out.ok).toBe(true);
    expect(out.repairs).toBe(0);
    expect(out.drops).toBeNull();
    expect(out.softGates).toEqual({ checked: 8, dropped: 0, by_code: {} });
    expect(t.lines).toEqual(["Attempt 1: 0 errors, 0 warnings (0 snapshot)."]);
    expect(t.snaps.map((s) => s.url).sort()).toEqual([...fetches].sort());
  }, 120_000);

  it("PD2 the invalid twin gives exactly one error, BANNED_WORDS, and nothing else", async () => {
    const r = await snapshotRound(invalid);
    const evidence = buildEvidence({ transcripts: [transcript], pack: w.pack, snapshots: r.taken });
    const v = validateDraft(invalid, { ...base, evidence, cveList: cveLookupFromDir(w.paths.cveRecords) });
    expect(codes(v)).toEqual({ errors: ["BANNED_WORDS items[0].summary"], warnings: [] });
  }, 120_000);

  it("PD2 in the loop, round 1 turns the invalid twin into the pipeline draft and the result is clean", async () => {
    const t = realIo([invalid, draft]);
    const state = { repairsUsed: 0, maxRepairs: config.run.budgets.repair_rounds };
    const out = await validateLoop(1, base, t.io, state);
    expect(out.ok).toBe(true);
    expect(out.repairs).toBe(1);
    expect(state.repairsUsed).toBe(1);
    expect(codes(out.result)).toEqual({ errors: [], warnings: [] });
    expect(t.lines).toEqual([
      "Attempt 1: 1 error, 0 warnings (0 snapshot).",
      "Attempt 1: repair 1 for 1 error and 0 snapshot warnings (BANNED_WORDS).",
      "Attempt 1: 0 errors, 0 warnings (0 snapshot).",
    ]);
  }, 120_000);
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
