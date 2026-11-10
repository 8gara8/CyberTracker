// scripts/publish.ts (SPEC §8.7; plan §1 L2, amendments A5, A17 and A18) on the shared harness
// (tests/helpers/harness.ts): a bare remote with a pre-receive hook standing in for GitHub, and its clone
// seeded with fixtures/site-content as it stood before an edition (tests/helpers/publish-world.ts). The
// composers are fakes that return site-content's own files, so validateAll() inside publish is the real
// one. P1 to P14 are §8.7's fourteen tests; CF2 is plan A5's facts check; PW checks the world itself; G4 is
// publishState's own test. The integration lane reruns P3b and P13 with the real composers (I-P3, I-P13)
// and the CLI's full mode (I-P15, plan A18) on the fixture morning the pipeline builds: collect, metrics,
// context, evidence, snapshots and the pipeline draft fixtures/agent/drafts/2026-10-14.json.
// Nothing here reaches the network.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeError, applyDraft, cveBlockOf, type ApplyInput, type ContentChanges, type GatedDraft } from "@/lib/apply";
import { buildContext } from "@/lib/context";
import { composeDataOnly, type DataOnlyInput } from "@/lib/data-only";
import { loadCheckedConfig, type LoadedConfig } from "@/lib/config";
import { at } from "@/lib/dates";
import { jsonText } from "@/lib/json";
import {
  firstSeenBefore, kevIndexFor, metricsFor, readCorrections, readHistory, readScoreboard, regionsBaseFor, standingLast, withheldBefore,
} from "@/lib/run-inputs";
import { CandidatesFile, Pack } from "@/lib/schema/pack";
import type { CveLookup, RegionsBase } from "@/lib/rules/types";
import { Brief } from "@/lib/schema/brief";
import type { AgentContext } from "@/lib/schema/context";
import { STATE_SCHEMAS } from "@/lib/schema/metrics";
import { CorrectionsFile, type Evidence } from "@/lib/schema/misc";
import { StatusFile, type RunRecord } from "@/lib/schema/status";
import { cveLookupFromDir, packDatesOf, regionsInputFile, validateAll } from "@/lib/validate";
import { WITHHELD_HEADLINE, WITHHELD_MARK } from "@/lib/vocab";
import { composeWithholds, type WithholdRequest } from "@/lib/withhold";
import { collect } from "@/scripts/collect";
import { MIN } from "@/scripts/lib/clock";
import { cveFactsFor } from "@/scripts/lib/cve-facts";
import { buildEvidence } from "@/scripts/lib/evidence";
import { citedUnseen, snapshotHashes, snapshotUrls } from "@/scripts/lib/snapshot";
import { parseTranscript } from "@/scripts/lib/transcript";
import { GatedDraftSchema, validateGated } from "@/scripts/lib/validate-loop";
import { runMetrics } from "@/scripts/metrics";
import { git, SyncError } from "@/scripts/lib/git";
import { runPaths } from "@/scripts/lib/paths";
import {
  COMMIT_RE, NOT_ARM64, PublishError, dropPendingEditions, main, originMatches, publishDataOnly, publishFull, publishState, publishStatus,
  PUSH_RETRY_MS, publishWithholds, pushPending, tooLateLine, type PublishDeps, type PublishOptions, type StatusEvent,
} from "@/scripts/publish";
import { REPO, inRoot, makeHarness, type Harness } from "./helpers/harness";
import { transcriptJsonl } from "./helpers/pipeline-world";
import {
  WORLD_DATES, beforeEdition, fakeComposers, siteBrief, stagedFiles, statusText, testRecord, treeBefore, victimDispute, worldConfig,
  type FakeComposers,
} from "./helpers/publish-world";

const T = 120_000;
const made: Harness[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of made.splice(0)) h.dispose();
});

interface World {
  h: Harness;
  D: string;
  config: LoadedConfig;
  fakes: FakeComposers;
  site: ContentChanges;
  logs: string[];
}

/** A harness seeded with site-content as it stood before edition D, and fake composers for D. */
function world(D: string, start = "04:37"): World {
  let site: ContentChanges | null = null;
  const h = makeHarness({ date: D, start, seed: (x) => { site = beforeEdition(x, D); } });
  made.push(h);
  return { h, D, config: worldConfig(h), fakes: fakeComposers(D), site: site!, logs: [] };
}

const rec = (w: World, hhmmss = "04:37:02", over: Partial<RunRecord> = {}) => testRecord(w.D, `${w.D}T${hhmmss}+08:00`, over);

/** The push retries wait through the harness's instant sleep, unless `over` says otherwise (P16). */
function base(w: World, records: readonly RunRecord[], over: Partial<PublishOptions> = {}): PublishOptions {
  return {
    root: w.h.root, date: w.D, deadline: w.h.clock() + 60_000, now: w.h.clock, dryRun: false, repo: w.h.remote, config: w.config, records,
    log: (l) => w.logs.push(l), sleep: w.h.deps.sleep, ...over,
  };
}

const composers = (w: World): PublishDeps => ({ composeDataOnly: w.fakes.composeDataOnly, applyDraft: w.fakes.applyDraft, composeWithholds: w.fakes.composeWithholds });

const dataOnly = (w: World, records: readonly RunRecord[], over: Partial<PublishOptions> = {}, deps: PublishDeps = composers(w)) =>
  publishDataOnly({ ...base(w, records, over), feedsStale: [], generatedAt: `${w.D}T04:40:00+08:00` }, deps);

const NO_CVES: CveLookup = { get: () => undefined };
const full = (w: World, records: readonly RunRecord[], over: Partial<PublishOptions> = {}, force = false) =>
  publishFull({
    ...base(w, records, over), force, edition: "full",
    // The fake applyDraft returns site-content's brief; publish reads only the draft's generated_at.
    draft: { generated_at: `${w.D}T05:04:00+08:00` } as unknown as GatedDraft,
    context: {} as AgentContext, evidence: {} as Evidence, cveList: NO_CVES, regionsBase: {} as RegionsBase, snapshots: {},
    feedsStale: [], disputes: null, recheck: null,
  }, composers(w));

const status = (w: World, records: readonly RunRecord[], event: StatusEvent, over: Partial<PublishOptions> = {}, updateArchive?: Parameters<typeof publishStatus>[0]["updateArchive"]) =>
  publishStatus({ ...base(w, records, over), event, updateArchive });

/** The victim withhold of the 2026-10-14 breach item, on top of the disputes GitHub holds. */
const REQUEST = (w: World): WithholdRequest => ({ item_id: "inc-transport-jp-2026-10", edition_date: "2026-10-14", kind: "victim", dispute_id: "D-0002", since: w.D });
function withhold(w: World, records: readonly RunRecord[], over: Partial<PublishOptions> = {}) {
  const cf = CorrectionsFile.parse(JSON.parse(fs.readFileSync(path.join(w.h.root, "content", "corrections.json"), "utf8")));
  return publishWithholds({ ...base(w, records, over), requests: [REQUEST(w)], disputes: [...cf.disputes, victimDispute()] }, composers(w));
}

const subjects = (h: Harness) => h.remoteLog().map((c) => c.subject);
const read = (file: string) => fs.readFileSync(file, "utf8");
const contentFile = (w: World, rel: string) => path.join(w.h.root, "content", rel);
const contentFileOf = (h: Harness, rel: string) => path.join(h.root, "content", rel);

/** A brief: commit made by hand, as a run killed between its commit and its push leaves it. */
function localBriefCommit(w: World): void {
  fs.writeFileSync(contentFile(w, `briefs/${w.D}.json`), jsonText(siteBrief(w.D), Brief));
  w.h.git("add", "content");
  w.h.git("commit", "-q", "-m", `brief: ${w.D} · data-only edition`);
}

/** Captures process.stderr and process.stdout writes (the CLI's lines). */
function captureOutput() {
  const err: string[] = [];
  const out: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (err.push(String(chunk)), true));
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => (out.push(String(chunk)), true));
  return { err, out, clear: () => { err.length = 0; out.length = 0; } };
}

const EDITION_FILES = (D: string) => [
  `content/briefs/${D}.json`, `content/metrics/${D}.json`, `content/metrics/inputs/${D}.json`, `content/archive-index.json`, `content/status/${D}.json`,
];
const isState = (f: string) => /^content\/state\/[a-z-]+\.json$/.test(f);

describe("the publish world", () => {
  it.each(WORLD_DATES)("PW: the tree before %s passes validateAll, and so does a data-only edition composed on it", async (D) => {
    const w = world(D);
    expect(validateAll(path.join(w.h.root, "content"), { config: w.config }).errors).toEqual([]);
    expect(fs.existsSync(contentFile(w, `briefs/${D}.json`))).toBe(false);
    expect(fs.existsSync(contentFile(w, `metrics/${D}.json`))).toBe(false);
    await inRoot(w.h, async () => {
      await dataOnly(w, [rec(w, "04:37:02", { trigger: "dry_run" })], { dryRun: true, freshCopy: true });
    });
    expect(validateAll(runPaths(w.h.root, D).dryRunCopy, { publishing: D, config: w.config }).errors).toEqual([]);
  }, T);
});

describe("publish (§8.7)", () => {
  it("P1, P6: the morning's calls write only their listed paths, and every subject matches COMMIT_RE", async () => {
    const w = world("2026-10-14");
    const D = w.D;
    await inRoot(w.h, async () => {
      const r0 = rec(w);
      await status(w, [r0], { kind: "started" });
      const d = await dataOnly(w, [r0]);
      w.h.clock.jump(15 * MIN);
      const f = await full(w, [d.record]);
      const closed: RunRecord = { ...f.record, outcome: "published_full", finished_at: `${D}T05:20:00+08:00` };
      await status(w, [closed], { kind: "ended", outcome: "published_full" }, {}, (ix) => {
        const url = Object.keys(ix.urls).sort()[0]!;
        ix.urls[url]!.last_check = { date: D, result: "ok", http: 200 };
        return ix;
      });
    });
    const log = w.h.remoteLog();
    expect(log.map((c) => c.subject)).toEqual([
      `status: ${D} · run 20261014-043702 started`,
      `brief: ${D} · data-only edition`,
      `brief: ${D} · full edition, ${siteBrief(D).items.length} items`,
      `status: ${D} · run 20261014-043702 ended: published_full`,
    ]);
    for (const c of log) expect(c.subject).toMatch(COMMIT_RE);
    expect(log[0]!.files).toEqual([`content/status/${D}.json`]);
    // The data-only commit carries the staged metrics, inputs and state; the full one does not repeat them.
    for (const f of log[1]!.files) expect(EDITION_FILES(D).includes(f) || isState(f), f).toBe(true);
    expect(log[1]!.files).toEqual(expect.arrayContaining([`content/briefs/${D}.json`, `content/metrics/${D}.json`, `content/metrics/inputs/${D}.json`, `content/status/${D}.json`]));
    const fullAllowed = [`content/briefs/${D}.json`, "content/scoreboard.json", "content/corrections.json", "content/archive-index.json", `content/status/${D}.json`];
    for (const f of log[2]!.files) expect(fullAllowed, f).toContain(f);
    expect(log[2]!.files).toEqual(expect.arrayContaining([`content/briefs/${D}.json`, `content/status/${D}.json`]));
    expect([...log[3]!.files].sort()).toEqual(["content/archive-index.json", `content/status/${D}.json`]);
    expect(w.h.git("status", "--porcelain")).toBe("");
  }, T);

  it("P1: a withhold writes corrections.json, the rewritten briefs, archive-index.json and status/D.json only", async () => {
    const w = world("2026-10-15");
    await inRoot(w.h, async () => {
      await withhold(w, [rec(w)]);
    });
    const [c] = w.h.remoteLog();
    expect(c!.subject).toBe("correction: 2026-10-15 · withheld inc-transport-jp-2026-10");
    expect(c!.subject).toMatch(COMMIT_RE);
    for (const f of c!.files) expect(/^content\/(corrections\.json|archive-index\.json|status\/2026-10-15\.json|briefs\/\d{4}-\d{2}-\d{2}\.json)$/.test(f), f).toBe(true);
    expect(c!.files).toEqual(expect.arrayContaining(["content/corrections.json", "content/briefs/2026-10-14.json", "content/status/2026-10-15.json"]));
  }, T);

  it("P2: a content folder other than <root>/content, a branch other than main or another origin is the wrong repository; a dirty tree is a SyncError", async () => {
    const w = world("2026-10-15");
    const head = w.h.git("rev-parse", "HEAD");
    await inRoot(w.h, async () => {
      const r0 = rec(w);
      process.env.CT_CONTENT_DIR = "fixtures/site-content";
      await expect(status(w, [r0], { kind: "started" })).rejects.toMatchObject({ code: "wrong repository" });
      process.env.CT_CONTENT_DIR = path.join(w.h.root, "content");
      await expect(status(w, [r0], { kind: "started" }, { deadline: w.h.clock() + 5_000, repo: path.join(w.h.base, "elsewhere.git") }))
        .rejects.toMatchObject({ code: "wrong repository" });
      delete process.env.CT_CONTENT_DIR;
      w.h.git("checkout", "-q", "-b", "side");
      await expect(dataOnly(w, [r0])).rejects.toMatchObject({ code: "wrong repository" });
      w.h.git("checkout", "-q", "main");
      expect(fs.existsSync(contentFile(w, "status/2026-10-15.json"))).toBe(false);

      fs.appendFileSync(contentFile(w, "scoreboard.json"), " ");
      const err = await status(w, [r0], { kind: "started" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SyncError);
      expect(fs.existsSync(contentFile(w, "status/2026-10-15.json"))).toBe(false);
      expect(w.h.git("status", "--porcelain")).toBe(" M content/scoreboard.json");
    });
    expect(w.h.git("rev-parse", "HEAD")).toBe(head);
    expect(w.h.remoteLog()).toEqual([]);
    // Origin URLs that count as the content repository (run.json repos.repo), and ones that do not.
    for (const u of ["https://github.com/8gara8/CyberTracker.git", "https://github.com/8gara8/CyberTracker", "git@github.com:8gara8/cybertracker.git", "ssh://git@github.com/8gara8/CyberTracker.git"]) {
      expect(originMatches(u, "8gara8/CyberTracker"), u).toBe(true);
    }
    for (const u of ["https://github.com/8gara8/OtherTracker.git", "https://example.org/8gara8/CyberTracker.git", "/tmp/remote.git", "https://github.com/8gara8/CyberTracker/x"]) {
      expect(originMatches(u, "8gara8/CyberTracker"), u).toBe(false);
    }
    expect(originMatches("/tmp/remote.git/", "8gara8/CyberTracker", "/tmp/remote.git")).toBe(true);
  }, T);

  it("P3a, P3b: data-only after an edition is refused; full after data-only replaces it and keeps data_only_published_at", async () => {
    const w = world("2026-10-14");
    const D = w.D;
    await inRoot(w.h, async () => {
      const d = await dataOnly(w, [rec(w)]);
      await expect(dataOnly(w, [d.record])).rejects.toMatchObject({ code: "already published" });
      w.h.clock.jump(20 * MIN);
      const f = await full(w, [d.record]);
      // The spy: applyDraft got the stored brief's data_only_published_at.
      expect(w.fakes.calls.apply).toHaveLength(1);
      expect(w.fakes.calls.apply[0]!.dataOnlyPublishedAt).toBe(d.publishedAt);
      const b = Brief.parse(JSON.parse(w.h.remoteFile(`content/briefs/${D}.json`)!));
      expect(b.edition).toBe("full");
      expect(b.published_at).toBe(f.publishedAt);
      expect(b.data_only_published_at).toBe(d.publishedAt);
      const s = StatusFile.parse(JSON.parse(w.h.remoteFile(`content/status/${D}.json`)!));
      expect(s.runs).toHaveLength(1);
      expect(s.runs[0]).toMatchObject({ edition: "full", data_only_published_at: d.publishedAt, full_published_at: f.publishedAt });
      expect(f.record).toEqual(s.runs[0]);

      // P3a: after a full edition, both a data-only and an unforced full call are refused.
      await expect(dataOnly(w, [f.record])).rejects.toMatchObject({ code: "already published" });
      await expect(full(w, [f.record])).rejects.toMatchObject({ code: "already published" });
      w.h.clock.jump(5 * MIN);
      const again = await full(w, [f.record], {}, true);
      expect(w.fakes.calls.apply[1]!.dataOnlyPublishedAt).toBe(d.publishedAt);
      expect(Brief.parse(JSON.parse(w.h.remoteFile(`content/briefs/${D}.json`)!)).published_at).toBe(again.publishedAt);
    });
    expect(subjects(w.h)).toHaveLength(3);
    expect(w.h.git("status", "--porcelain")).toBe("");
  }, T);

  it("P4: a composed brief that fails validateAll leaves the tree clean and GitHub unchanged", async () => {
    const w = world("2026-10-15");
    const head = w.h.git("rev-parse", "HEAD");
    await inRoot(w.h, async () => {
      const broken: PublishDeps["composeDataOnly"] = (i) => {
        const ch = w.fakes.composeDataOnly(i);
        return { ...ch, brief: { ...ch.brief!, computed: { ...ch.brief!.computed, word_count: ch.brief!.computed.word_count + 7 } } };
      };
      const err = await dataOnly(w, [rec(w)], {}, { composeDataOnly: broken }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PublishError);
      expect((err as PublishError).code).toBe("validation");
      expect((err as PublishError).message).toBe("validation");
      expect((err as PublishError).codes).toContain("COMPUTED_MISMATCH");
    });
    expect(w.h.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(w.h.git("rev-parse", "HEAD")).toBe(head);
    expect(w.h.remoteLog()).toEqual([]);
    for (const rel of ["briefs/2026-10-15.json", "metrics/2026-10-15.json", "status/2026-10-15.json"]) expect(fs.existsSync(contentFile(w, rel)), rel).toBe(false);
    expect(read(contentFile(w, "archive-index.json"))).toBe(treeBefore("2026-10-15").get("archive-index.json"));
  }, T);

  it("P5: a rejected status or withhold commit stays local and lands with pushPending() or a later status commit, after 11:00 too", async () => {
    const w = world("2026-10-15");
    const D = w.D;
    await inRoot(w.h, async () => {
      const r0 = rec(w);
      w.h.pushes("reject");
      await expect(status(w, [r0], { kind: "started" }, { deadline: w.h.clock() + 5_000 })).rejects.toMatchObject({ code: "push" });
      expect(w.h.git("log", "-1", "--format=%s")).toBe(`status: ${D} · run 20261015-043702 started`);
      expect(w.h.remoteLog()).toEqual([]);
      w.h.pushes("accept");
      await expect(pushPending(git(w.h.root), { sleep: w.h.deps.sleep })).resolves.toEqual({ pushed: 1 });
      expect(subjects(w.h)).toEqual([`status: ${D} · run 20261015-043702 started`]);
      await expect(pushPending(git(w.h.root), { sleep: w.h.deps.sleep })).resolves.toEqual({ pushed: 0 });

      w.h.pushes("reject");
      await expect(withhold(w, [r0], { deadline: w.h.clock() + 5_000 })).rejects.toMatchObject({ code: "push" });
      expect(subjects(w.h)).toHaveLength(1);
      w.h.clock.set(at(D, "11:30"));
      w.h.pushes("accept");
      const closed: RunRecord = { ...r0, outcome: "failed", error_code: "E_PUSH", finished_at: `${D}T11:30:00+08:00` };
      await status(w, [closed], { kind: "ended", outcome: "failed" });
    });
    expect(subjects(w.h)).toEqual([
      `status: ${D} · run 20261015-043702 started`,
      `correction: ${D} · withheld inc-transport-jp-2026-10`,
      `status: ${D} · run 20261015-043702 ended: failed`,
    ]);
    expect(w.h.git("rev-parse", "HEAD")).toBe(w.h.remoteLog().at(-1)!.sha);
  }, T);

  it("P16: the push retries wait 2, 4 and 8 s, in that order, through o.sleep; without one they are real waits", async () => {
    const w = world("2026-10-15");
    const D = w.D;
    expect(PUSH_RETRY_MS).toEqual([2_000, 4_000, 8_000]);
    await inRoot(w.h, async () => {
      const r0 = rec(w);
      w.h.pushes("reject");
      // Four pushes, three waits, then the commit stays local.
      await expect(status(w, [r0], { kind: "started" })).rejects.toMatchObject({ code: "push" });
      expect(w.h.waits()).toEqual([2_000, 4_000, 8_000]);
      expect(w.logs.filter((l) => l.startsWith("Push of "))).toHaveLength(1);
      // pushPending and dropPendingEditions take the same wait.
      const seen: number[] = [];
      await expect(pushPending(git(w.h.root), { sleep: async (ms) => void seen.push(ms) })).rejects.toMatchObject({ code: "push" });
      expect(seen).toEqual([2_000, 4_000, 8_000]);
      // No sleep given: realSleep, so the first retry really waits 2 s (the 4 s one would pass the 5 s deadline).
      const closed: RunRecord = { ...r0, outcome: "failed", error_code: "E_PUSH", finished_at: `${D}T04:40:00+08:00` };
      const t0 = Date.now();
      await expect(status(w, [closed], { kind: "ended", outcome: "failed" }, { sleep: undefined, deadline: w.h.clock() + 5_000 })).rejects.toMatchObject({ code: "push" });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(2_000);
      expect(w.h.waits()).toEqual([2_000, 4_000, 8_000]);
      w.h.pushes("accept");
      await expect(pushPending(git(w.h.root), { sleep: w.h.deps.sleep })).resolves.toEqual({ pushed: 2 });
    });
    expect(subjects(w.h)).toEqual([`status: ${D} · run 20261015-043702 started`, `status: ${D} · run 20261015-043702 ended: failed`]);
  }, T);

  it("P17: a ComposeError from either composer is PublishError(\"compose\"), logged, with nothing written or pushed", async () => {
    const w = world("2026-10-15");
    const head = w.h.git("rev-parse", "HEAD");
    const archive = read(contentFile(w, "archive-index.json"));
    const noDate = () => { throw new ComposeError("No release date for rel-microsoft-2026-10: no vendor source with a date and no bundled record"); };
    await inRoot(w.h, async () => {
      const err = await dataOnly(w, [rec(w)], {}, { ...composers(w), composeDataOnly: noDate }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PublishError);
      expect([(err as PublishError).code, (err as PublishError).message, (err as PublishError).codes]).toEqual(["compose", "compose", []]);
      const full2 = publishFull({
        ...base(w, [rec(w)]), force: false, edition: "full", draft: { generated_at: `${w.D}T05:04:00+08:00` } as unknown as GatedDraft,
        context: {} as AgentContext, evidence: {} as Evidence, cveList: NO_CVES, regionsBase: {} as RegionsBase, snapshots: {},
        feedsStale: [], disputes: null, recheck: null,
      }, { ...composers(w), applyDraft: noDate });
      await expect(full2).rejects.toMatchObject({ code: "compose" });
      // Any other throw is not a compose failure and passes through unchanged.
      await expect(dataOnly(w, [rec(w)], {}, { ...composers(w), composeDataOnly: () => { throw new TypeError("a bug"); } })).rejects.toBeInstanceOf(TypeError);
    });
    expect(w.logs.filter((l) => l.includes("could not be composed"))).toEqual([
      "The data-only edition could not be composed: No release date for rel-microsoft-2026-10: no vendor source with a date and no bundled record",
      "The full edition could not be composed: No release date for rel-microsoft-2026-10: no vendor source with a date and no bundled record",
    ]);
    expect(w.h.git("rev-parse", "HEAD")).toBe(head);
    expect(w.h.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(read(contentFile(w, "archive-index.json"))).toBe(archive);
    expect(w.h.remoteLog()).toEqual([]);
  }, T);

  it("P18: a withhold rewrites every stored brief holding the item, editions before the disputed one included; validateAll refuses one that does not", async () => {
    const w = world("2026-10-15");
    const ITEM = "cve-2026-108917";
    // The item is in both the 2026-10-13 and the 2026-10-14 briefs; the reader disputes the newest (§8.9 step 2).
    const holding = [...treeBefore(w.D).keys()].filter((k) => k.startsWith("briefs/"))
      .filter((rel) => Brief.parse(JSON.parse(read(contentFile(w, rel)))).items.some((it) => it.id === ITEM));
    expect(holding).toEqual(["briefs/2026-10-13.json", "briefs/2026-10-14.json"]);
    const dispute = { ...victimDispute({ id: "D-0002", issue: 5 }), item_id: ITEM, kind: "attribution" as const };
    const request: WithholdRequest = { item_id: ITEM, edition_date: "2026-10-14", kind: "attribution", dispute_id: "D-0002", since: w.D };
    const cf = CorrectionsFile.parse(JSON.parse(read(contentFile(w, "corrections.json"))));
    const head = w.h.git("rev-parse", "HEAD");
    await inRoot(w.h, async () => {
      const o = { ...base(w, [rec(w)]), requests: [request], disputes: [...cf.disputes, dispute] };
      // Given only the briefs from the disputed edition on, the 2026-10-13 copy keeps the attribution: XREF_CORRECTION.
      const fromEdition: PublishDeps["composeWithholds"] = (i) => composeWithholds({ ...i, briefs: i.briefs.filter((b) => b.date >= request.edition_date) });
      const err = await publishWithholds(o, { composeWithholds: fromEdition }).catch((e: unknown) => e);
      expect([(err as PublishError).code, (err as PublishError).codes]).toEqual(["validation", ["XREF_CORRECTION"]]);
      expect(w.logs).toContain("Validation: XREF_CORRECTION at corrections.json: corrections[2]");
      expect(w.h.git("rev-parse", "HEAD")).toBe(head);
      // The real composer, so the briefs publish hands it are what is rewritten; runPlan's validateAll passes.
      await publishWithholds(o, {});
    });
    const [c] = w.h.remoteLog();
    expect(c!.files).toEqual(expect.arrayContaining(["content/briefs/2026-10-13.json", "content/briefs/2026-10-14.json"]));
    const after = CorrectionsFile.parse(JSON.parse(w.h.remoteFile("content/corrections.json")!));
    const correction = after.corrections.find((x) => x.dispute_id === "D-0002")!;
    for (const rel of holding) {
      const b = Brief.parse(JSON.parse(w.h.remoteFile(`content/${rel}`)!));
      const it = b.items.find((x) => x.id === ITEM)!;
      expect(it.withheld, rel).toEqual({ correction_id: correction.id, since: w.D });
      expect([it.headline, it.attribution, it.actor_nexus], rel).toEqual([WITHHELD_HEADLINE, [], null]);
      for (const r of b.regions.rows) if (r.item_ids.includes(ITEM)) expect(r.reason, rel).toBe(WITHHELD_MARK);
    }
  }, T);

  it("P7: with staged files and GitHub one status commit ahead, publishDataOnly commits the staged files byte for byte", async () => {
    const w = world("2026-10-15");
    const D = w.D;
    const r0 = rec(w);
    w.h.commitOnRemote({ [`content/status/${D}.json`]: statusText(D, [r0]) }, `status: ${D} · run ${r0.run_id} started`);
    await inRoot(w.h, async () => {
      await dataOnly(w, [r0]);
    });
    const log = w.h.remoteLog();
    expect(log.map((c) => c.subject)).toEqual([`status: ${D} · run ${r0.run_id} started`, `brief: ${D} · data-only edition`]);
    for (const [rel, text] of stagedFiles(D)) expect(w.h.remoteFile(`content/${rel}`), rel).toBe(text);
    expect(log[1]!.files).toEqual(expect.arrayContaining([`content/metrics/${D}.json`, `content/metrics/inputs/${D}.json`]));
    const s = StatusFile.parse(JSON.parse(w.h.remoteFile(`content/status/${D}.json`)!));
    expect(s.runs.map((r) => r.run_id)).toEqual([r0.run_id]);
    expect(s.runs[0]!.edition).toBe("data_only");
  }, T);

  it("P8: with reject-briefs both edition calls throw push and leave HEAD and git status as before; a status commit then lands alone", async () => {
    const w = world("2026-10-14");
    const D = w.D;
    await inRoot(w.h, async () => {
      const r0 = rec(w);
      await status(w, [r0], { kind: "started" });
      w.h.pushes("reject-briefs");
      const head = w.h.git("rev-parse", "HEAD");
      await expect(dataOnly(w, [r0], { deadline: w.h.clock() + 5_000 })).rejects.toMatchObject({ code: "push" });
      expect(w.h.git("rev-parse", "HEAD")).toBe(head);
      expect(w.h.git("status", "--porcelain", "--untracked-files=all")).toBe("");
      await expect(full(w, [r0], { deadline: w.h.clock() + 5_000 })).rejects.toMatchObject({ code: "push" });
      expect(w.h.git("rev-parse", "HEAD")).toBe(head);
      expect(w.h.git("status", "--porcelain", "--untracked-files=all")).toBe("");
      const closed: RunRecord = { ...r0, outcome: "failed", error_code: "E_PUBLISH", finished_at: `${D}T05:30:00+08:00` };
      await status(w, [closed], { kind: "ended", outcome: "failed" });
    });
    const log = w.h.remoteLog();
    expect(log.map((c) => c.subject)).toEqual([`status: ${D} · run 20261014-043702 started`, `status: ${D} · run 20261014-043702 ended: failed`]);
    expect(log[1]!.files).toEqual([`content/status/${D}.json`]);
    expect(w.h.remoteFile(`content/briefs/${D}.json`)).toBeNull();
  }, T);

  it("step 8: a non-fast-forward rejection rebases once over a code commit, validates again and pushes; one that touches the commit's paths is not rebased", async () => {
    const w = world("2026-10-15");
    const D = w.D;
    let calls = 0;
    // GitHub's main moves between this call's sync and its push: a merged code PR.
    const moving: PublishDeps["validateTree"] = (dir, opts) => {
      calls += 1;
      if (calls === 1) w.h.commitOnRemote({ "scripts/README.txt": "a merged code change\n" }, "code: a merged change");
      return validateAll(dir, opts);
    };
    await inRoot(w.h, async () => {
      await dataOnly(w, [rec(w)], {}, { ...composers(w), validateTree: moving });
    });
    expect(calls).toBe(2);
    const log = w.h.remoteLog();
    expect(log.map((c) => c.subject)).toEqual(["code: a merged change", `brief: ${D} · data-only edition`]);
    expect(w.h.git("rev-parse", "HEAD^")).toBe(log[0]!.sha);
    expect(w.h.git("rev-parse", "HEAD")).toBe(log[1]!.sha);

    // Now GitHub's newer main writes this call's own status file: no rebase, the edition is reset away.
    const v = world("2026-10-15");
    const head = v.h.git("rev-parse", "HEAD");
    let n = 0;
    const clashing: PublishDeps["validateTree"] = (dir, opts) => {
      n += 1;
      if (n === 1) v.h.commitOnRemote({ [`content/status/${D}.json`]: statusText(D, [rec(v, "04:30:00")]) }, `status: ${D} · run 20261015-043000 started`);
      return validateAll(dir, opts);
    };
    await inRoot(v.h, async () => {
      await expect(dataOnly(v, [rec(v)], {}, { ...composers(v), validateTree: clashing })).rejects.toMatchObject({ code: "push" });
    });
    expect(n).toBe(1);
    expect(v.h.git("rev-parse", "HEAD")).toBe(head);
    expect(v.h.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(v.h.remoteLog().map((c) => c.subject)).toEqual([`status: ${D} · run 20261015-043000 started`]);
  }, T);

  it("P9: after publishUntil both edition calls are refused as too late, force included, and the CLI exits 1 with the message", async () => {
    const w = world("2026-10-15");
    const D = w.D;
    w.h.clock.set(at(D, "11:00") + 1_000);
    const io = captureOutput();
    await inRoot(w.h, async () => {
      await expect(dataOnly(w, [rec(w)], { deadline: at(D, "12:00") })).rejects.toMatchObject({ code: "too late" });
      await expect(full(w, [rec(w)], {}, true)).rejects.toMatchObject({ code: "too late" });
      for (const mode of [["--data-only"], [], ["--force"]]) {
        io.clear();
        expect(await main(["--date", D, ...mode], { arch: "arm64", now: w.h.clock, repo: w.h.remote })).toBe(1);
        expect(io.err.join("")).toBe("Too late: nothing is published after 11:00.\n");
      }
      expect(tooLateLine("11:00")).toBe("Too late: nothing is published after 11:00.");
      expect(fs.existsSync(runPaths(w.h.root, D).lock)).toBe(false);
    });
    expect(w.h.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(w.h.remoteLog()).toEqual([]);
  }, T);

  it("P10: at 10:59:58 with deadline 12:00 against a hook that sleeps 5 s and rejects, the push is killed at 11:00 and push thrown within about 3 s", async () => {
    const w = world("2026-10-15");
    const D = w.D;
    const head = w.h.git("rev-parse", "HEAD");
    w.h.pushes({ slowSeconds: 5, reject: true });
    w.h.clock.set(at(D, "10:59") + 58_000);
    await inRoot(w.h, async () => {
      const t0 = Date.now();
      const err = await dataOnly(w, [rec(w)], { deadline: at(D, "12:00") }).catch((e: unknown) => e);
      const took = Date.now() - t0;
      expect(err).toBeInstanceOf(PublishError);
      expect((err as PublishError).code).toBe("push");
      // Killed at the deadline, not answered by the hook (which sleeps 5 s before it rejects).
      expect(took).toBeGreaterThan(1_000);
      expect(took).toBeLessThan(4_500);
    });
    // No receive-pack or hook of this remote outlives the call (they share the push's process group).
    const lingering = () => execFileSync("ps", ["-eo", "args"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(w.h.remote));
    for (let i = 0; i < 10 && lingering().length; i++) await new Promise((r) => setTimeout(r, 100));
    expect(lingering()).toEqual([]);
    expect(w.h.remoteLog()).toEqual([]);
    expect(w.h.git("rev-parse", "HEAD")).toBe(head);
    expect(w.h.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  }, T);

  it("P11: a local brief: above a local status: makes pushPending() refuse; after dropPendingEditions() one status: commit lands", async () => {
    const w = world("2026-10-15");
    const D = w.D;
    await inRoot(w.h, async () => {
      const r0 = rec(w);
      w.h.pushes("reject");
      await expect(status(w, [r0], { kind: "started" }, { deadline: w.h.clock() + 5_000 })).rejects.toMatchObject({ code: "push" });
      localBriefCommit(w);
      w.h.pushes("accept");
      await expect(pushPending(git(w.h.root))).rejects.toMatchObject({ code: "pending edition" });
      expect(w.h.remoteLog()).toEqual([]);
      const dropped = await dropPendingEditions(git(w.h.root), { root: w.h.root, config: w.config, now: w.h.clock, repo: w.h.remote });
      expect(dropped).toEqual({ dropped: 2, remade: 0, failed: [] });
      expect(w.h.git("rev-list", "--count", "origin/main..HEAD")).toBe("0");
      await status(w, [r0], { kind: "started" });
    });
    const log = w.h.remoteLog();
    expect(log.map((c) => c.subject)).toEqual([`status: ${D} · run 20261015-043702 started`]);
    expect(w.h.remoteFile(`content/briefs/${D}.json`)).toBeNull();
  }, T);

  it("P12: a local correction: below a local brief: are both dropped, the withhold is made again, and every stored brief holding the item marks it withheld (A17)", async () => {
    const w = world("2026-10-15");
    const D = w.D;
    const ITEM = "inc-transport-jp-2026-10";
    await inRoot(w.h, async () => {
      const r0 = rec(w);
      w.h.pushes("reject");
      await expect(withhold(w, [r0], { deadline: w.h.clock() + 5_000 })).rejects.toMatchObject({ code: "push" });
      localBriefCommit(w);
      w.h.pushes("accept");
      const dropped = await dropPendingEditions(git(w.h.root), { root: w.h.root, config: w.config, now: w.h.clock, repo: w.h.remote }, composers(w));
      expect(dropped).toEqual({ dropped: 2, remade: 1, failed: [] });
      await status(w, [r0], { kind: "started" });
    });
    expect(subjects(w.h)).toEqual([`correction: ${D} · withheld ${ITEM}`, `status: ${D} · run 20261015-043702 started`]);
    expect(w.h.remoteFile(`content/briefs/${D}.json`)).toBeNull();
    const cf = CorrectionsFile.parse(JSON.parse(w.h.remoteFile("content/corrections.json")!));
    const c = cf.corrections.find((x) => x.item_id === ITEM && x.type === "name_removed");
    expect(c).toMatchObject({ date: D, edition_date: "2026-10-14", dispute_id: "D-0002" });
    expect(cf.disputes.find((d) => d.id === "D-0002")!.correction_id).toBe(c!.id);
    // A17: the item is withheld in every stored brief that holds it, and every region row naming it is marked.
    let holding = 0;
    for (const rel of [...treeBefore(D).keys()].filter((k) => k.startsWith("briefs/"))) {
      const b = Brief.parse(JSON.parse(w.h.remoteFile(`content/${rel}`)!));
      const it = b.items.find((x) => x.id === ITEM);
      if (it) {
        holding += 1;
        expect(it.withheld, rel).toEqual({ correction_id: c!.id, since: D });
        expect(it.headline).toBe(WITHHELD_HEADLINE);
      }
      for (const r of b.regions.rows) if (r.item_ids.includes(ITEM)) expect(r.reason, rel).toBe(WITHHELD_MARK);
    }
    expect(holding).toBeGreaterThan(0);
  }, T);

  it("P12b: a dropped withhold is made again when GitHub's name_removed correction on the item no longer binds (its dispute rejected)", async () => {
    const w = world("2026-10-15");
    const D = w.D;
    const ITEM = "inc-health-us-2026-10";
    const cfPath = contentFile(w, "corrections.json");
    // GitHub: D-0001 rejected, so C-0001 withholds nothing more; intake gave the new dispute D-0002 its own withhold.
    const cf = CorrectionsFile.parse(JSON.parse(read(cfPath)));
    const rejected = { ...cf, disputes: cf.disputes.map((d) => (d.id === "D-0001" ? { ...d, status: "rejected" as const, resolved_on: "2026-10-14" } : d)) };
    w.h.commitOnRemote({ "content/corrections.json": jsonText(rejected, CorrectionsFile) }, `status: 2026-10-14 · run 20261014-043702 ended: published_full`);
    w.h.git("pull", "-q", "--ff-only", "origin", "main");
    const D2 = { ...rejected.disputes[0]!, id: "D-0002", issue_number: rejected.disputes[0]!.issue_number + 1, received: `${D}T01:00:00+08:00`, status: "open" as const, resolved_on: null, correction_id: null };
    const request: WithholdRequest = { item_id: ITEM, edition_date: "2026-10-12", kind: "victim", dispute_id: "D-0002", since: D };
    await inRoot(w.h, async () => {
      const r0 = rec(w);
      w.h.pushes("reject");
      await expect(publishWithholds({ ...base(w, [r0], { deadline: w.h.clock() + 5_000 }), requests: [request], disputes: [...rejected.disputes, D2] }, { composeWithholds }))
        .rejects.toMatchObject({ code: "push" });
      localBriefCommit(w);
      w.h.pushes("accept");
      const dropped = await dropPendingEditions(git(w.h.root), { root: w.h.root, config: w.config, now: w.h.clock, repo: w.h.remote }, { composeWithholds });
      expect(dropped).toEqual({ dropped: 2, remade: 1, failed: [] });
    });
    const after = CorrectionsFile.parse(JSON.parse(w.h.remoteFile("content/corrections.json")!));
    const made = after.corrections.filter((x) => x.item_id === ITEM && x.type === "name_removed");
    expect(made.map((x) => [x.id, x.dispute_id])).toEqual([["C-0001", "D-0001"], ["C-0003", "D-0002"]]);
    expect(after.disputes.find((d) => d.id === "D-0002")).toMatchObject({ status: "open", correction_id: "C-0003" });
  }, T);

  it("P13: a dry run leaves HEAD and content/ unchanged; the fresh copy replaces an older one and later calls reuse it; its status file is mirrored", async () => {
    const w = world("2026-10-14");
    const D = w.D;
    const head = w.h.git("rev-parse", "HEAD");
    const P = runPaths(w.h.root, D);
    fs.mkdirSync(P.dryRunCopy, { recursive: true });
    fs.writeFileSync(path.join(P.dryRunCopy, "older.txt"), "an older copy\n");
    await inRoot(w.h, async () => {
      const r0 = rec(w, "04:37:02", { trigger: "dry_run" });
      const d = await dataOnly(w, [r0], { dryRun: true, freshCopy: true });
      expect(d.sha).toBeNull();
      expect(fs.existsSync(path.join(P.dryRunCopy, "older.txt"))).toBe(false);
      w.h.clock.jump(20 * MIN);
      const f = await full(w, [d.record], { dryRun: true });
      expect(f.sha).toBeNull();
      const b = Brief.parse(JSON.parse(read(path.join(P.dryRunCopy, "briefs", `${D}.json`))));
      expect(b).toMatchObject({ edition: "full", published_at: f.publishedAt, data_only_published_at: d.publishedAt });
      expect(read(P.statusMirror)).toBe(read(path.join(P.dryRunCopy, "status", `${D}.json`)));
      const s = StatusFile.parse(JSON.parse(read(P.statusMirror)));
      expect(s.runs.at(-1)).toMatchObject({ trigger: "dry_run", edition: "full", data_only_published_at: d.publishedAt, full_published_at: f.publishedAt });
      expect(validateAll(P.dryRunCopy, { publishing: D, config: w.config }).errors).toEqual([]);
      // Neither the cap nor the too-late refusal applies to a dry run.
      w.h.clock.set(at(D, "11:30"));
      await expect(full(w, [f.record], { dryRun: true }, true)).resolves.toMatchObject({ sha: null });
    });
    expect(w.h.git("rev-parse", "HEAD")).toBe(head);
    expect(w.h.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(fs.existsSync(contentFile(w, `briefs/${D}.json`))).toBe(false);
    expect(fs.existsSync(contentFile(w, `status/${D}.json`))).toBe(false);
    expect(w.h.remoteLog()).toEqual([]);
  }, T);

  it("P14: the CLI refuses every mode while a live pid holds logs/.lock, and on a non-arm64 arch, with nothing written", async () => {
    const w = world("2026-10-15");
    const D = w.D;
    const head = w.h.git("rev-parse", "HEAD");
    const io = captureOutput();
    const modes = [[], ["--data-only"], ["--state"], ["--dry-run"], ["--data-only", "--dry-run"], ["--force"]];
    await inRoot(w.h, async () => {
      const lock = runPaths(w.h.root, D).lock;
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      const holder = JSON.stringify({ pid: process.pid, started: new Date(w.h.clock()).toISOString() });
      fs.writeFileSync(lock, holder);
      for (const mode of modes) {
        io.clear();
        expect(await main(["--date", D, ...mode], { arch: "arm64", now: w.h.clock, repo: w.h.remote }), mode.join(" ")).toBe(1);
        expect(io.err.join("")).toBe(`CyberTracker ${D}: another run is in progress (started 04:37); nothing done.\n`);
      }
      expect(read(lock)).toBe(holder);
      fs.rmSync(lock);
      for (const mode of modes) {
        io.clear();
        expect(await main(["--date", D, ...mode], { arch: "x64", now: w.h.clock, repo: w.h.remote }), mode.join(" ")).toBe(1);
        expect(io.err.join("")).toBe("Not native arm64: put /opt/homebrew/bin first on the PATH (SPEC Appendix C).\n");
      }
      expect(NOT_ARM64).toBe("Not native arm64: put /opt/homebrew/bin first on the PATH (SPEC Appendix C).");
      expect(fs.existsSync(lock)).toBe(false);
      io.clear();
      expect(await main(["--date", D, "--data-only", "--state"], { arch: "arm64", now: w.h.clock })).toBe(2);
      expect(io.err.join("")).toMatch(/^--data-only and --state cannot be used together\.\nUsage: tsx scripts\/publish\.ts /);
      expect(fs.existsSync(runPaths(w.h.root, D).dryRunCopy)).toBe(false);
    });
    expect(w.h.git("rev-parse", "HEAD")).toBe(head);
    expect(w.h.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(fs.existsSync(contentFile(w, `briefs/${D}.json`))).toBe(false);
    expect(w.h.remoteLog()).toEqual([]);
  }, T);
});

describe("publishState", () => {
  /** Stages state files in cache/staged/backfill/state/: days.json and kev-index.json a day newer, series.json as committed. */
  function stage(h: Harness): string {
    const dir = path.join(h.root, "cache", "staged", "backfill");
    fs.mkdirSync(path.join(dir, "state"), { recursive: true });
    for (const name of ["days.json", "kev-index.json"] as const) {
      const v = STATE_SCHEMAS[name].parse(JSON.parse(read(path.join(h.root, "content", "state", name))));
      fs.writeFileSync(path.join(dir, "state", name), jsonText({ ...v, updated_at: "2026-10-12" }, STATE_SCHEMAS[name]));
    }
    fs.copyFileSync(path.join(h.root, "content", "state", "series.json"), path.join(dir, "state", "series.json"));
    // A staged metrics file is never published by publishState.
    fs.mkdirSync(path.join(dir, "metrics"), { recursive: true });
    fs.writeFileSync(path.join(dir, "metrics", "2026-10-14.json"), "{}\n");
    return dir;
  }
  const call = (h: Harness, config: LoadedConfig, stagedDir: string, mode: "catch-up" | "backfill") =>
    publishState({ root: h.root, date: h.date, deadline: h.clock() + 60_000, now: h.clock, dryRun: false, repo: h.remote, config, mode, stagedDir, cutoff: "2026-10-12" });

  it("G4: commits only the changed staged state files, and kev-index.json only while no brief exists", async () => {
    const empty = makeHarness();
    made.push(empty);
    const dir = stage(empty);
    await inRoot(empty, async () => {
      const r = await call(empty, worldConfig(empty), dir, "backfill");
      expect([...r.files].sort()).toEqual(["content/state/days.json", "content/state/kev-index.json"]);
      expect(r.sha).toBe(empty.remoteLog()[0]!.sha);
      await expect(call(empty, worldConfig(empty), dir, "backfill")).resolves.toEqual({ sha: null, files: [] });
    });
    expect(empty.remoteLog().map((c) => [c.subject, [...c.files].sort()])).toEqual([
      ["state: 2026-10-12 · backfill", ["content/state/days.json", "content/state/kev-index.json"]],
    ]);
    for (const name of ["days.json", "kev-index.json"]) expect(empty.remoteFile(`content/state/${name}`)).toBe(read(path.join(dir, "state", name)));

    const w = world("2026-10-15");
    const kev = read(contentFile(w, "state/kev-index.json"));
    const staged = stage(w.h);
    await inRoot(w.h, async () => {
      const r = await call(w.h, w.config, staged, "catch-up");
      expect(r.files).toEqual(["content/state/days.json"]);
    });
    expect(w.h.remoteLog().map((c) => [c.subject, c.files])).toEqual([["state: 2026-10-12 · catch-up", ["content/state/days.json"]]]);
    expect(read(contentFile(w, "state/kev-index.json"))).toBe(kev);
    expect(w.h.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  }, T);
});

describe("cveFactsFor (A5)", () => {
  it("CF2: after collect on the fixture world, the facts give the fixture KEV catalog's due date and catalog version", async () => {
    const h = makeHarness();
    made.push(h);
    const D = h.date;
    const catalog = JSON.parse(read(path.join(REPO, "fixtures", "feeds", "kev", "known_exploited_vulnerabilities.json"))) as {
      catalogVersion: string; vulnerabilities: { cveID: string; vulnerabilityName: string; dateAdded: string; dueDate: string; knownRansomwareCampaignUse: string }[];
    };
    const row = catalog.vulnerabilities[0]!;
    await inRoot(h, async () => {
      expect(cveFactsFor(h.root, D).kev(row.cveID)).toBeNull();
      await collect({ date: D, deadline: h.clock() + 300_000, root: h.root, deps: { now: h.clock } });
      const facts = cveFactsFor(h.root, D);
      expect(facts.kev(row.cveID)).toEqual({
        dateAdded: row.dateAdded, dueDate: row.dueDate, catalogVersion: catalog.catalogVersion,
        ransomware: row.knownRansomwareCampaignUse.toLowerCase() === "known" ? "known" : "unknown",
        vulnerabilityName: row.vulnerabilityName,
      });
      for (const v of catalog.vulnerabilities.slice(0, 20)) expect(facts.kev(v.cveID)?.dueDate, v.cveID).toBe(v.dueDate);
      expect(facts.kev("CVE-2026-0000001")).toBeNull();
      expect(facts.record("../x")).toBeNull();
      expect(facts.ghsaIds("CVE-2026-0000001")).toEqual([]);
      expect(facts.ghsaAdvisories?.("CVE-2026-0000001")).toEqual([]);
    });
  }, T);

  it("CF3: the production facts reach the frozen block: KEV's vulnerabilityName is the title, a reviewed GHSA gives ids and the advisory date", async () => {
    const h = makeHarness();
    made.push(h);
    const D = h.date;
    const catalog = JSON.parse(read(path.join(REPO, "fixtures", "feeds", "kev", "known_exploited_vulnerabilities.json"))) as {
      vulnerabilities: { cveID: string; vulnerabilityName: string }[];
    };
    await inRoot(h, async () => {
      await collect({ date: D, deadline: h.clock() + 300_000, root: h.root, deps: { now: h.clock } });
      const facts = cveFactsFor(h.root, D);
      const config = worldConfig(h);
      const kevIndex = kevIndexFor(h.root, path.join(h.root, "content"), D)!;
      const x = { config, facts, cveList: cveLookupFromDir(runPaths(h.root, D).cveRecords), kevIndex, inputs: null, findersVersion: 2, capturedAt: `${D}T04:45:00+08:00` };
      const listed = catalog.vulnerabilities.find((v) => v.cveID === "CVE-2026-104935")!;
      expect(cveBlockOf(listed.cveID, { flaw_evidence: [] }, [], x).title).toBe(listed.vulnerabilityName);
      // GHSA-2f8c-wq4h-r7jm (reviewed, published 2026-10-13, no fixed version) aliases CVE-2026-107460.
      expect(facts.ghsaIds("CVE-2026-107460")).toEqual(["GHSA-2f8c-wq4h-r7jm"]);
      expect(facts.ghsaAdvisories?.("CVE-2026-107460")).toEqual([{ id: "GHSA-2f8c-wq4h-r7jm", published: "2026-10-13", fixed: false }]);
      const b = cveBlockOf("CVE-2026-107460", { flaw_evidence: [] }, [], x);
      expect(b).toMatchObject({ advisory_date: "2026-10-13", patch: null, ghsa_ids: ["GHSA-2f8c-wq4h-r7jm"] });
    });
  }, T);
});

// The integration lane: the real composers on the fixture morning (I-P3, I-P13, I-P15).

type FullInputs = Omit<Parameters<typeof publishFull>[0], keyof PublishOptions | "force">;

interface Morning {
  h: Harness;
  D: string;
  config: LoadedConfig;
  generatedAt: string;
  /** publishFull's inputs as daily.ts builds them for the pipeline draft. */
  full: FullInputs;
  /** The pipeline draft's item count. */
  items: number;
}

/**
 * The fixture morning in the harness clone, built as daily.ts builds it before publish: collect at 04:37,
 * runMetrics staging at 04:41, the context, the evidence from a transcript of the draft's fetches and the
 * snapshots of its unseen cited pages, then the pipeline draft gated with 0 errors. The files the publish
 * CLI's full mode reads (drafts/D.json, logs/D.context.json, logs/D.evidence.json, logs/D.regions-input.json)
 * are written too.
 */
async function morning(): Promise<Morning> {
  const h = makeHarness();
  made.push(h);
  const D = h.date;
  const P = runPaths(h.root, D);
  const agent = path.join(REPO, "fixtures", "agent", "drafts");
  const raw: unknown = JSON.parse(read(path.join(agent, `${D}.json`)));
  const fetches = JSON.parse(read(path.join(agent, `${D}--fetches.json`))) as string[];
  return inRoot(h, async () => {
    await collect({ date: D, deadline: h.clock() + 5 * MIN, root: h.root, deps: { now: h.clock } });
    h.clock.jump(4 * MIN);
    const m = await runMetrics({ date: D, root: h.root, now: new Date(h.clock()) });
    expect(m.code, m.lines.join(" | ")).toBe(0);
    const config = loadCheckedConfig({ root: h.root });
    const pack = Pack.parse(JSON.parse(read(P.pack)));
    const candidates = CandidatesFile.parse(JSON.parse(read(P.packCandidates)));
    const mf = metricsFor(h.root, P.content, D)!;
    const regionsBase = regionsBaseFor({ root: h.root, contentDir: P.content, date: D, pack, config });
    const built = buildContext({
      date: D, now: h.clock(), deadline: h.clock() + 25 * MIN, pack, candidates, metrics: mf.metrics, config,
      history: readHistory(P.content, D, 14), corrections: readCorrections(P.content), scoreboard: readScoreboard(P.content), regionsBase,
      recheck: { flagged: [], reports: [] }, standingLast: standingLast(P.content, D),
    });
    const transcript = parseTranscript(transcriptJsonl({ fetches }));
    const unseen = citedUnseen(raw, buildEvidence({ transcripts: [transcript], pack, snapshots: [] }));
    const snaps = (await snapshotUrls({ root: h.root, urls: unseen, deadline: Date.now() + 60_000, config, now: h.clock })).taken;
    expect(snaps.length).toBe(unseen.length);
    const evidence = buildEvidence({ transcripts: [transcript], pack, snapshots: snaps });
    fs.mkdirSync(P.cveRecords, { recursive: true });
    const draft = GatedDraftSchema.parse(raw);
    const v = validateGated(draft, {
      context: built.context, evidence, metrics: mf.metrics, config, cveList: cveLookupFromDir(P.cveRecords), regionsBase,
      packDates: packDatesOf(pack), fileDate: D,
    });
    expect(v.errors).toEqual([]);
    for (const [file, text] of [
      [P.draft, `${JSON.stringify(raw, null, 2)}\n`], [P.contextLog, built.text], [P.evidence, jsonText(evidence)], [P.regionsInput, jsonText(regionsInputFile(regionsBase))],
    ] as const) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    return {
      h, D, config, generatedAt: pack.generated_at, items: draft.items.length,
      full: {
        edition: "full", draft, context: built.context, evidence, cveList: cveLookupFromDir(P.cveRecords), regionsBase,
        snapshots: snapshotHashes(snaps), feedsStale: [], disputes: null, recheck: null,
      },
    };
  });
}

const morningBase = (m: Morning, records: readonly RunRecord[], over: Partial<PublishOptions> = {}): PublishOptions => ({
  root: m.h.root, date: m.D, deadline: m.h.clock() + 3 * MIN, now: m.h.clock, dryRun: false, repo: m.h.remote, config: m.config, records, ...over,
});

describe("publish with the real composers (integration)", () => {
  it("I-P3: data-only, then a full edition that replaces it with data_only_published_at kept, through the real composers and validateAll", async () => {
    const m = await morning();
    const { h, D } = m;
    const calls: ApplyInput[] = [];
    const dataOnlyCalls: DataOnlyInput[] = [];
    const spy: PublishDeps = { applyDraft: (i) => { calls.push(i); return applyDraft(i); } };
    await inRoot(h, async () => {
      const r0 = testRecord(D, `${D}T04:37:02+08:00`);
      const d = await publishDataOnly({ ...morningBase(m, [r0]), feedsStale: [], generatedAt: m.generatedAt }, {
        composeDataOnly: (i) => { dataOnlyCalls.push(i); return composeDataOnly(i); },
      });
      // Withheld references come from every stored brief, as for first_seen (§0.4 row 128).
      expect(dataOnlyCalls[0]!.withheldBriefs).toEqual(withheldBefore(path.join(h.root, "content"), D));
      expect(Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!)).edition).toBe("data_only");
      expect(validateAll(path.join(h.root, "content"), { publishing: D, config: m.config }).errors).toEqual([]);
      await expect(publishDataOnly({ ...morningBase(m, [d.record]), feedsStale: [], generatedAt: m.generatedAt })).rejects.toMatchObject({ code: "already published" });

      h.clock.jump(15 * MIN);
      const f = await publishFull({ ...morningBase(m, [d.record]), force: false, ...m.full }, spy);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.dataOnlyPublishedAt).toBe(d.publishedAt);
      // first_seen comes from every stored brief, as XREF_FIRST_SEEN reads them.
      expect(calls[0]!.firstSeen).toEqual(firstSeenBefore(path.join(h.root, "content"), D));
      expect(calls[0]!.withheldBriefs).toEqual(withheldBefore(path.join(h.root, "content"), D));
      const b = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
      expect(b).toMatchObject({ edition: "full", published_at: f.publishedAt, data_only_published_at: d.publishedAt });
      expect(b.items.map((x) => x.id)).toEqual(m.full.draft.items.map((x) => x.id));
      const st = StatusFile.parse(JSON.parse(h.remoteFile(`content/status/${D}.json`)!));
      expect(st.runs).toHaveLength(1);
      expect(st.runs[0]).toMatchObject({ edition: "full", data_only_published_at: d.publishedAt, full_published_at: f.publishedAt });
      expect(f.record).toEqual(st.runs[0]);
      expect(validateAll(path.join(h.root, "content"), { publishing: D, config: m.config }).errors).toEqual([]);

      // P3a with the real composers: after the full edition both a data-only and an unforced full call are refused.
      await expect(publishDataOnly({ ...morningBase(m, [f.record]), feedsStale: [], generatedAt: m.generatedAt })).rejects.toMatchObject({ code: "already published" });
      await expect(publishFull({ ...morningBase(m, [f.record]), force: false, ...m.full })).rejects.toMatchObject({ code: "already published" });
    });
    expect(subjects(h)).toEqual([`brief: ${D} · data-only edition`, `brief: ${D} · full edition, ${m.items} items`]);
    expect(h.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  }, T);

  it("I-P13: a data-only then a full dry-run call with the real composers: the copy passes validateAll, its status is mirrored, HEAD and content/ unchanged", async () => {
    const m = await morning();
    const { h, D } = m;
    const P = runPaths(h.root, D);
    const head = h.git("rev-parse", "HEAD");
    await inRoot(h, async () => {
      const r0 = testRecord(D, `${D}T04:37:02+08:00`, { trigger: "dry_run" });
      const d = await publishDataOnly({ ...morningBase(m, [r0], { dryRun: true, freshCopy: true }), feedsStale: [], generatedAt: m.generatedAt });
      expect(d.sha).toBeNull();
      expect(validateAll(P.dryRunCopy, { publishing: D, config: m.config }).errors).toEqual([]);
      h.clock.jump(15 * MIN);
      const f = await publishFull({ ...morningBase(m, [d.record], { dryRun: true }), force: false, ...m.full });
      expect(f.sha).toBeNull();
      const b = Brief.parse(JSON.parse(read(path.join(P.dryRunCopy, "briefs", `${D}.json`))));
      expect(b).toMatchObject({ edition: "full", published_at: f.publishedAt, data_only_published_at: d.publishedAt });
      expect(read(P.statusMirror)).toBe(read(path.join(P.dryRunCopy, "status", `${D}.json`)));
      expect(StatusFile.parse(JSON.parse(read(P.statusMirror))).runs.at(-1)).toMatchObject({
        trigger: "dry_run", edition: "full", data_only_published_at: d.publishedAt, full_published_at: f.publishedAt,
      });
      expect(validateAll(P.dryRunCopy, { publishing: D, config: m.config }).errors).toEqual([]);
    });
    expect(h.git("rev-parse", "HEAD")).toBe(head);
    expect(h.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(fs.existsSync(contentFileOf(h, `briefs/${D}.json`))).toBe(false);
    expect(fs.existsSync(contentFileOf(h, `status/${D}.json`))).toBe(false);
    expect(h.remoteLog()).toEqual([]);
  }, T);

  it("I-P15: the CLI publishes the data-only edition, then the full one from drafts/D.json and the run's logs; manual records; validateAll passes (A18)", async () => {
    const m = await morning();
    const { h, D } = m;
    const io = captureOutput();
    await inRoot(h, async () => {
      expect(await main(["--date", D, "--data-only"], { arch: "arm64", now: h.clock, repo: h.remote })).toBe(0);
      h.clock.jump(10 * MIN);
      io.clear();
      expect(await main(["--date", D], { arch: "arm64", now: h.clock, repo: h.remote })).toBe(0);
      expect(io.err.join("")).toBe("");
    });
    const log = h.remoteLog();
    expect(log.map((c) => c.subject)).toEqual([`brief: ${D} · data-only edition`, `brief: ${D} · full edition, ${m.items} items`]);
    expect(io.out.join("")).toContain(`Full edition for ${D} published (${log[1]!.sha.slice(0, 7)}).`);
    const st = StatusFile.parse(JSON.parse(h.remoteFile(`content/status/${D}.json`)!));
    expect(st.runs.map((r) => [r.trigger, r.outcome, r.edition])).toEqual([["manual", "published_data_only", "data_only"], ["manual", "published_full", "full"]]);
    const last = st.runs.at(-1)!;
    expect(last.finished_at).toBe(last.started_at);
    expect(last.stages.find((x) => x.id === "publish")!.status).toBe("ok");
    expect(last.validation).toMatchObject({ errors: 0 });
    const b = Brief.parse(JSON.parse(h.remoteFile(`content/briefs/${D}.json`)!));
    expect(b.edition).toBe("full");
    expect(b.data_only_published_at).toBe(st.runs[0]!.data_only_published_at);
    expect(validateAll(path.join(h.root, "content"), { publishing: D, config: m.config }).errors).toEqual([]);
    expect(h.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    for (const c of log) for (const f of c.files) expect(f.startsWith("content/"), f).toBe(true);
  }, T);
});
