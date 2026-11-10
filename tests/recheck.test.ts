// The re-check (SPEC §8.9; plan §2.6, named tests R1 to R19): the correction form parser on real rendered
// bodies, the dispute intake through an injected fetch, and the 14-day flags against the sample content
// with one frozen-against-current pair per flag (fixtures/recheck/). No test reaches GitHub or any feed:
// intake answers come from fixture lists and record reads from a fake fetchFeed. I-R20 (plan A16, the
// integration lane's) runs a victim dispute from intake through composeWithholds and validateAll.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "@/lib/config";
import { addDays, taipeiTimestamp } from "@/lib/dates";
import { cachePaths } from "@/lib/feeds/cache";
import type { fetchFeed, FetchResult } from "@/lib/feeds/http";
import { jsonText, sha256Hex } from "@/lib/json";
import { Brief as BriefSchema, type Brief } from "@/lib/schema/brief";
import { Metrics } from "@/lib/schema/metrics";
import { ArchiveIndex, CorrectionsFile as CorrectionsSchema, type CorrectionsFile, type Dispute } from "@/lib/schema/misc";
import { CollectInputsFile } from "@/lib/schema/pack";
import type { StatusFile } from "@/lib/schema/status";
import { normalizeUrl } from "@/lib/urls";
import { validateAll } from "@/lib/validate";
import { DISPUTE_FORM_OPTIONS, DISPUTE_KINDS, WITHHELD_HEADLINE, WITHHELD_MARK } from "@/lib/vocab";
import { composeWithholds } from "@/lib/withhold";
import { fixtureConfig } from "@/fixtures/src/inputs";
import { RECHECK_DAYS } from "@/fixtures/src/site";
import {
  FORM_LABELS, INTAKE_LIMITS, intakeDisputes, intakeSince, intakeUrl, main, MAX_WITHHOLDS, NO_RESPONSE, parseDisputeForm,
  RECHECK_LIMITS, recheckItems, writeRecheckLog,
} from "@/scripts/recheck";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(REPO, "fixtures", "site-content");
const FIX = path.join(REPO, "fixtures", "recheck");
const config = loadConfig({ root: REPO });
/** The run date: the day after the sample's newest brief, so D − 14 to D − 1 holds every sample brief. */
const D = "2026-10-16";
const CVE = "CVE-2026-104935";
const ISSUES_PREFIX = "https://api.github.com/repos/8gara8/CyberTracker/issues?";

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const write = (file: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

const temps: string[] = [];
const cwd = process.cwd();
afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// ── The world: a copy of the sample content, a cache, a fake record fetch ────────────────────────

interface World {
  root: string;
  content: string;
  logs: string[];
  log: (line: string) => void;
  /** URLs the fake fetchFeed was asked for (CVE records by id). */
  fetched: string[];
  /** fetchFeed answering 404 to every URL: a record not in collect's cache is not published. */
  fetch: typeof fetchFeed;
}

function world(o: { config?: boolean } = {}): World {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-recheck-"));
  temps.push(root);
  const content = path.join(root, "content");
  fs.cpSync(SITE, content, { recursive: true });
  if (o.config) fs.cpSync(path.join(REPO, "config"), path.join(root, "config"), { recursive: true });
  const logs: string[] = [];
  const fetched: string[] = [];
  const fetch = (async (url: string) => {
    fetched.push(url);
    return notFound(url);
  }) as typeof fetchFeed;
  return { root, content, logs, log: (line) => logs.push(line), fetched, fetch };
}

const notFound = (url: string): FetchResult =>
  ({ ok: false, status: 404, finalUrl: url, body: null, contentType: null, error: "http_404", detail: null, durationMs: 0, attempts: 1 });

const briefsOf = (content: string): Brief[] =>
  fs.readdirSync(path.join(content, "briefs")).filter((n) => n.endsWith(".json")).sort().map((n) => readJson<Brief>(path.join(content, "briefs", n)));

/** The dates of every stored brief holding an item id, as intake reads them. */
const datesFor = (content: string) => (id: string) => briefsOf(content).filter((b) => b.items.some((it) => it.id === id)).map((b) => b.date);

/** Items in the briefs dated D − 14 to D − 1 that are not withheld (what the re-check reads). */
const liveItems = (content: string) => briefsOf(content).filter((b) => b.date >= addDays(D, -14) && b.date < D)
  .flatMap((b) => b.items.filter((it) => !it.withheld).map((it) => ({ date: b.date, item: it })));

interface KevRow {
  cveID: string; vendorProject: string; product: string; vulnerabilityName: string; dateAdded: string; shortDescription: string;
  requiredAction: string; dueDate: string; knownRansomwareCampaignUse: string; notes: string; cwes: string[];
}

interface Pair {
  flag: string; edition_date: string; item_id: string; cve_id: string; detail: string;
  current?: unknown; current_kev?: KevRow; source_id?: string; url?: string;
  last_check?: { date: string; result: "ok" | "broken" | "changed" | "unknown"; http: number | null };
  dispute?: Dispute;
}
const pairOf = (flag: string): Pair => readJson<Pair>(path.join(FIX, "pairs", `${flag}.json`));
const TEMPLATE = pairOf("kev_changed").current_kev!;

/** Today's catalog with every frozen KEV block of the live items unchanged (Capitalised as CISA writes it). */
function steadyKev(content: string): KevRow[] {
  const rows = new Map<string, KevRow>();
  for (const { item } of liveItems(content)) {
    for (const c of item.cves) {
      if (!c.kev || rows.has(c.cve_id)) continue;
      rows.set(c.cve_id, {
        ...TEMPLATE, cveID: c.cve_id, vendorProject: c.vendor.name, product: c.product, dateAdded: c.kev.date_added, dueDate: c.kev.due_date,
        knownRansomwareCampaignUse: c.kev.ransomware === "known" ? "Known" : "Unknown",
      });
    }
  }
  return [...rows.values()];
}

/** cache/feeds/kev.json and an inputs.json for `date` naming its SHA-256, as collect leaves them. */
function writeKev(root: string, rows: readonly KevRow[], date = D) {
  const catalog = { title: "SAMPLE KEV catalog", catalogVersion: "2026.10.15", dateReleased: "2026-10-15T17:00:00.000Z", count: rows.length, vulnerabilities: rows };
  const body = Buffer.from(JSON.stringify(catalog));
  const p = cachePaths(root);
  write(p.feedBody("kev", "json"), body);
  const inputs = CollectInputsFile.parse({
    schema_version: 1, date, data_cutoff_utc: addDays(date, -2), generated_at: `${addDays(date, -1)}T20:40:00Z`, run_utc_day: addDays(date, -1),
    record_window: { start: `${addDays(date, -2)}T20:00:00Z`, end: `${addDays(date, -1)}T20:00:00Z` },
    commits: { cvelist: null, kev_data: null, ghsa: null },
    cvelist: { zips: [], days: [], newest_hourly_tag: null, delta_log_newest: null, by_id: { fetched: [], not_found: [], over_cap: 0 } },
    kev: { catalog_version: catalog.catalogVersion, date_released: catalog.dateReleased, count: rows.length, url_used: "https://example.com/ct-sample/kev", sha256: sha256Hex(body), fallback_used: false },
    epss: null, ghsa: null, anthropic_cvd: null,
  });
  write(p.collectInputs, JSON.stringify(inputs));
}

const writeRecord = (root: string, raw: unknown) => write(path.join(cachePaths(root).recordsDir, `${CVE}.json`), JSON.stringify(raw));

function editJson<T>(file: string, edit: (v: T) => void) {
  const v = readJson<T>(file);
  edit(v);
  fs.writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`);
}

function setLastCheck(content: string, url: string, check: NonNullable<Pair["last_check"]>) {
  editJson<{ urls: Record<string, { last_check: unknown }> }>(path.join(content, "archive-index.json"), (ix) => {
    const entry = ix.urls[normalizeUrl(url)];
    if (!entry) throw new Error(`no archive entry for ${url}`);
    entry.last_check = check;
  });
}

const addDispute = (content: string, d: Dispute) =>
  editJson<CorrectionsFile>(path.join(content, "corrections.json"), (c) => { c.disputes.push(d); });

function flagRun(w: World, o: { feedsOk?: { kev: boolean; cvelist: boolean }; disputes?: Dispute[] | null; fetch?: typeof fetchFeed } = {}) {
  return recheckItems({
    root: w.root, date: D, contentDir: w.content, config, feedsOk: o.feedsOk ?? { kev: true, cvelist: true },
    deadline: Date.now() + 120_000, fetch: o.fetch ?? w.fetch, log: w.log, disputes: o.disputes,
  });
}

/** A world in which only `pair` differs from the steady state. */
function pairWorld(pair: Pair): World {
  const w = world();
  const rows = steadyKev(w.content);
  if (pair.current_kev) {
    const i = rows.findIndex((r) => r.cveID === pair.cve_id);
    rows[i] = pair.current_kev;
  }
  writeKev(w.root, rows);
  if (pair.current) writeRecord(w.root, pair.current);
  if (pair.url && pair.last_check) setLastCheck(w.content, pair.url, pair.last_check);
  if (pair.dispute) addDispute(w.content, pair.dispute);
  return w;
}

const flagOf = (pair: Pair) => ({ item_id: pair.item_id, edition_date: pair.edition_date, flag: pair.flag, detail: pair.detail, correction_id: null });

// ── R1 to R7: each flag from its pair ────────────────────────────────────────────────────────────

describe("the 14-day flags (R1 to R7)", () => {
  it("R1-R7 baseline: the steady sample raises no flag, checks every live item and fetches the uncached records by id", async () => {
    const w = world();
    writeKev(w.root, steadyKev(w.content));
    const r = await flagRun(w);
    const live = liveItems(w.content);
    expect(r.record).toEqual({ from: addDays(D, -14), to: addDays(D, -1), items_checked: live.length, flagged: [] });
    expect(r.shown).toEqual([]);
    expect(r.skipped).toEqual([]);
    const cves = new Set(live.flatMap((x) => x.item.cves.map((c) => c.cve_id)));
    expect(w.fetched).toHaveLength(cves.size);
    for (const id of cves) expect(w.fetched.some((u) => u.endsWith(`/${id}.json`)), id).toBe(true);
  });

  const cases: [string, string, Partial<Record<"before" | "after" | "evidence_url", string | null>>][] = [
    ["R1", "cve_rejected", { before: "PUBLISHED", after: "REJECTED", evidence_url: `https://www.cve.org/CVERecord?id=${CVE}` }],
    ["R2", "cve_disputed", { before: "not disputed", after: "disputed", evidence_url: `https://www.cve.org/CVERecord?id=${CVE}` }],
    ["R3", "kev_changed", { before: "unknown", after: "known", evidence_url: `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=${CVE}` }],
    ["R4", "cvss_changed", { before: "8.6 (CVSS 3.1, cna)", after: "7.4 (CVSS 3.1, cna)", evidence_url: `https://www.cve.org/CVERecord?id=${CVE}` }],
    ["R5", "source_missing", { before: "https://www.ivanti.com/ct-sample/connect-secure-security-advisory-cve-2026-104935", after: "HTTP 404 on 2026-10-15", evidence_url: null }],
    ["R6", "source_changed", { before: `https://www.cve.org/CVERecord?id=${CVE}`, after: "page text changed (link check 2026-10-15)", evidence_url: null }],
    ["R7", "reader_report", { before: "", after: "Reader report D-0002 (fact).", evidence_url: null }],
  ];
  for (const [id, flag, shown] of cases) {
    it(`${id} ${flag} from its fixture pair`, async () => {
      const pair = pairOf(flag);
      expect(pair.flag).toBe(flag);
      const w = pairWorld(pair);
      const r = await flagRun(w);
      expect(r.record.flagged).toEqual([flagOf(pair)]);
      expect(r.shown).toEqual([{ date: pair.edition_date, item_id: pair.item_id, check: flag, before: "", after: "", evidence_url: null, ...shown }]);
      expect(r.skipped).toEqual([]);
      // A record in collect's cache is never fetched again.
      if (pair.current) expect(w.fetched.some((u) => u.includes(CVE))).toBe(false);
    });
  }

  it("R2 cve_disputed: a disputed tag on a record not updated since the frozen block raises nothing", async () => {
    const pair = pairOf("cve_disputed");
    const raw = structuredClone(pair.current) as { cveMetadata: { dateUpdated: string } };
    raw.cveMetadata.dateUpdated = "2026-10-13T15:31:07.757Z";
    const w = pairWorld({ ...pair, current: raw });
    expect((await flagRun(w)).record.flagged).toEqual([]);
  });

  it("R3 kev_changed: a removed entry and a moved due date", async () => {
    const w = world();
    writeKev(w.root, steadyKev(w.content).filter((r) => r.cveID !== CVE));
    expect((await flagRun(w)).record.flagged).toEqual([
      { item_id: "cve-2026-104935", edition_date: "2026-10-14", flag: "kev_changed", detail: `${CVE}: removed from the KEV catalog.`, correction_id: null },
    ]);

    const w2 = world();
    writeKev(w2.root, steadyKev(w2.content).map((r) => (r.cveID === CVE ? { ...r, dueDate: "2026-10-30" } : r)));
    const r2 = await flagRun(w2);
    expect(r2.record.flagged.map((f) => f.detail)).toEqual([`${CVE}: KEV due date 2026-10-16 → 2026-10-30.`]);
    expect(r2.shown[0]).toMatchObject({ before: "2026-10-16", after: "2026-10-30" });
  });

  it("R4 cvss_changed: 1.0 or more, or a band change, flags; a smaller move inside the band does not", async () => {
    const pair = pairOf("cvss_changed");
    const withScore = (score: number) => {
      const raw = structuredClone(pair.current) as { containers: { cna: { metrics: { cvssV3_1: { baseScore: number } }[] } } };
      raw.containers.cna.metrics[0]!.cvssV3_1.baseScore = score;
      return raw;
    };
    const details = async (score: number) => (await flagRun(pairWorld({ ...pair, current: withScore(score) }))).record.flagged.map((f) => f.detail);
    expect(await details(9.0)).toEqual([`${CVE}: CVSS 8.6 → 9.0 (cna).`]); // high to critical
    expect(await details(7.6)).toEqual([`${CVE}: CVSS 8.6 → 7.6 (cna).`]); // exactly 1.0
    expect(await details(8.0)).toEqual([]);
    expect(await details(8.6)).toEqual([]);
  });

  it("R6 source_changed: only a tier 1 source; R5 source_missing: no answer at all", async () => {
    const w = world();
    writeKev(w.root, steadyKev(w.content));
    // s3 of the 2026-10-14 brief is tier 2.
    setLastCheck(w.content, "https://www.bleepingcomputer.com/ct-sample/ivanti-connect-secure-flaw-exploited-in-attacks", { date: "2026-10-15", result: "changed", http: 200 });
    setLastCheck(w.content, "https://www.ivanti.com/ct-sample/connect-secure-security-advisory-cve-2026-104935", { date: "2026-10-15", result: "broken", http: null });
    const r = await flagRun(w);
    expect(r.record.flagged).toEqual([
      { item_id: "cve-2026-104935", edition_date: "2026-10-14", flag: "source_missing", detail: "s2 could not be reached on 2026-10-15.", correction_id: null },
    ]);
  });

  it("R7 reader_report: from the list intake returns, and not for another edition", async () => {
    const pair = pairOf("reader_report");
    const w = world();
    writeKev(w.root, steadyKev(w.content));
    const stored = readJson<CorrectionsFile>(path.join(w.content, "corrections.json")).disputes;
    const r = await flagRun(w, { disputes: [...stored, pair.dispute!] });
    expect(r.record.flagged).toEqual([flagOf(pair)]);
    const other = await flagRun(w, { disputes: [...stored, { ...pair.dispute!, edition_date: "2026-10-13" }] });
    expect(other.record.flagged).toEqual([]);
    const closed = await flagRun(w, { disputes: [...stored, { ...pair.dispute!, status: "upheld", resolved_on: D }] });
    expect(closed.record.flagged).toEqual([]);
  });
});

// ── R8 to R11: the form parser ───────────────────────────────────────────────────────────────────

interface FormTemplate { labels: string[]; body: { type: string; id?: string; attributes: { label?: string; options?: string[] } }[] }
const TEMPLATE_FORM = parseYaml(fs.readFileSync(path.join(REPO, ".github", "ISSUE_TEMPLATE", "correction.yml"), "utf8")) as FormTemplate;

/** A form body as GitHub renders a submitted issue form: "### <label>", a blank line, the answer. */
const formBody = (item: string, edition: string | null, kind: string, evidence: string | null) =>
  [`### ${FORM_LABELS.item_id}`, "", item, "", `### ${FORM_LABELS.edition_date}`, "", edition ?? NO_RESPONSE, "",
    `### ${FORM_LABELS.kind}`, "", kind, "", `### ${FORM_LABELS.evidence_url}`, "", evidence ?? NO_RESPONSE].join("\n");

interface IssueJson { number: number; body: string; state: string; state_reason: string | null; created_at: string; pull_request?: unknown }
const ISSUES = readJson<IssueJson[]>(path.join(FIX, "issues.json"));
const issueBody = (n: number) => ISSUES.find((i) => i.number === n)!.body;

describe("the correction form parser (R8 to R11)", () => {
  const briefs = datesFor(SITE);

  it("R8 the labels and options equal .github/ISSUE_TEMPLATE/correction.yml", () => {
    const fields = TEMPLATE_FORM.body.filter((b) => b.type !== "markdown");
    expect(Object.fromEntries(fields.map((f) => [f.id, f.attributes.label]))).toEqual(FORM_LABELS);
    const dropdown = fields.find((f) => f.id === "kind")!;
    expect(dropdown.attributes.options).toEqual(DISPUTE_KINDS.map((k) => DISPUTE_FORM_OPTIONS[k]));
    expect(TEMPLATE_FORM.labels).toContain("correction");
  });

  it("R8 parses a real rendered body, with LF or CRLF line ends", () => {
    const body = fs.readFileSync(path.join(FIX, "body-rendered.md"), "utf8");
    const want = { item_id: "inc-transport-jp-2026-10", edition_date: "2026-10-14", kind: "victim", evidence_url: null };
    expect(parseDisputeForm(body, briefs)).toEqual(want);
    expect(parseDisputeForm(body.replace(/\n/g, "\r\n"), briefs)).toEqual(want);
    expect(parseDisputeForm(formBody(want.item_id, want.edition_date, DISPUTE_FORM_OPTIONS.victim, null), briefs)).toEqual(want);
  });

  it("R8 the edition: empty means the newest brief holding the item; a date that does not hold it is not parseable", () => {
    const opt = DISPUTE_FORM_OPTIONS.fact;
    expect(parseDisputeForm(formBody("cve-2026-108917", null, opt, null), briefs)?.edition_date).toBe("2026-10-14");
    expect(parseDisputeForm(formBody("cve-2026-108917", "2026-10-13", opt, null), briefs)?.edition_date).toBe("2026-10-13");
    expect(parseDisputeForm(formBody("cve-2026-108917", "2026-10-12", opt, null), briefs)).toBeNull();
    expect(parseDisputeForm(formBody("cve-2026-108917", "14 October", opt, null), briefs)).toBeNull();
    expect(parseDisputeForm(formBody("not-an-item-anywhere", null, opt, null), briefs)).toBeNull();
    expect(parseDisputeForm(formBody("Bad Id!", null, opt, null), briefs)).toBeNull();
    expect(parseDisputeForm(issueBody(8), briefs)).toBeNull(); // prose, no form
    // A label given twice is not parseable.
    expect(parseDisputeForm(`${formBody("cve-2026-108917", null, opt, null)}\n\n### Item id\n\ncve-2026-104935`, briefs)).toBeNull();
  });

  it("R9 extra prose before, inside and after the blocks, and under another heading, is ignored", () => {
    expect(parseDisputeForm(issueBody(10), briefs)).toEqual({
      item_id: "pt-microsoft-2026-10", edition_date: "2026-10-14", kind: "link", evidence_url: "https://msrc.microsoft.com/ct-sample/october-2026-security-update",
    });
  });

  it("R10 an answer that is not exactly one of the options is not parseable", () => {
    expect(parseDisputeForm(issueBody(9), briefs)).toBeNull();
    expect(parseDisputeForm(formBody("cve-2026-108917", null, DISPUTE_FORM_OPTIONS.fact.toLowerCase(), null), briefs)).toBeNull();
    expect(parseDisputeForm(formBody("cve-2026-108917", null, NO_RESPONSE, null), briefs)).toBeNull();
  });

  it("R11 an http:, blocked, over-long or spaced evidence link gives evidence_url null; an https one is normalised", () => {
    const at = (evidence: string) => parseDisputeForm(formBody("cve-2026-104935", "2026-10-14", DISPUTE_FORM_OPTIONS.fact, evidence), briefs);
    // Built here, not in fixtures: fixture-safety allows no http: or blocked link in fixtures/.
    expect(at(`${"http"}://www.ivanti.com/ct-sample/connect-secure-security-advisory-cve-2026-104935`)).toMatchObject({ kind: "fact", evidence_url: null });
    expect(at("https://news.google.com/ct-sample/redirect-wrapper")?.evidence_url).toBeNull(); // a redirect wrapper on BLOCKED_HOSTS
    expect(at("https://bit.ly/ct-sample")?.evidence_url).toBeNull(); // a shortener
    expect(at(`https://www.ivanti.com/ct-sample/${"a".repeat(500)}`)?.evidence_url).toBeNull();
    expect(at("https://www.ivanti.com/ct-sample/a b")?.evidence_url).toBeNull();
    expect(at("https://WWW.Ivanti.com/ct-sample/connect-secure-security-advisory-cve-2026-104935/?utm_source=x")?.evidence_url)
      .toBe("https://ivanti.com/ct-sample/connect-secure-security-advisory-cve-2026-104935");
  });

  it("R11 an evidence link whose path holds an exploit word is dropped on any host, so it never reaches the context or corrections.json", () => {
    const at = (evidence: string) => parseDisputeForm(formBody("cve-2026-104935", "2026-10-14", DISPUTE_FORM_OPTIONS.fact, evidence), briefs);
    // Built here, not in fixtures: a reader's link is checked as a tier 3 page, whatever its host.
    expect(at("https://example.net/ct-sample/cve-2026-104935-poc")).toMatchObject({ kind: "fact", evidence_url: null });
    expect(at("https://example.net/ct-sample/PoC/notes")?.evidence_url).toBeNull();
    expect(at("https://www.ivanti.com/ct-sample/exploit")?.evidence_url).toBeNull();
    expect(at("https://www.ivanti.com/ct-sample/payload_notes")?.evidence_url).toBeNull();
    // A word that only contains one of them is fine.
    expect(at("https://www.ivanti.com/ct-sample/exploitation-status")?.evidence_url).toBe("https://ivanti.com/ct-sample/exploitation-status");
  });
});

// ── Intake: R12 to R19 ───────────────────────────────────────────────────────────────────────────

/** A fake issues API: `pages[N - 1]` for page N (an empty list past them), or a function answering each URL. */
function issuesApi(pages: unknown[][] | ((url: string) => Response | Promise<Response>)) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (typeof pages === "function") return pages(url);
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    return Response.json(pages[page - 1] ?? []);
  }) as typeof fetch;
  return { impl, calls };
}

const issue = (n: number, body: string, createdAt: string, extra: Partial<IssueJson> = {}): IssueJson =>
  ({ number: n, body, state: "open", state_reason: null, created_at: createdAt, ...extra });

const intake = (w: World, fetchImpl: typeof fetch, date = D) =>
  intakeDisputes({ root: w.root, date, contentDir: w.content, config, now: Date.now, fetchImpl, log: w.log });

describe("suppression (R12)", () => {
  const pair = pairOf("cvss_changed");
  const flag = flagOf(pair);

  function statusWith(content: string, date: string, flags: unknown[]) {
    editJson<StatusFile>(path.join(content, "status", `${date}.json`), (s) => {
      s.runs[0]!.recheck!.flagged = flags as never;
    });
  }

  it("R12 a flag already shown in two status files without a correction is recorded but not shown", async () => {
    const w = pairWorld(pair);
    statusWith(w.content, "2026-10-15", [flag]);
    let r = await flagRun(w);
    expect(r.record.flagged).toEqual([flag]);
    expect(r.shown).toHaveLength(1); // one silent edition: still shown
    statusWith(w.content, "2026-10-14", [flag]);
    r = await flagRun(w);
    expect(r.record.flagged).toEqual([flag]);
    expect(r.shown).toEqual([]);
    // Another detail (the score moved again) is a new flag and shows.
    const again = pairWorld({ ...pair, current: (() => {
      const raw = structuredClone(pair.current) as { containers: { cna: { metrics: { cvssV3_1: { baseScore: number } }[] } } };
      raw.containers.cna.metrics[0]!.cvssV3_1.baseScore = 6.1;
      return raw;
    })() });
    statusWith(again.content, "2026-10-15", [flag]);
    statusWith(again.content, "2026-10-14", [flag]);
    expect((await flagRun(again)).shown).toHaveLength(1);
  });

  it("R12 a correction for the item and field dated on or after the flag first appeared suppresses it", async () => {
    const correction = (date: string, field: string) => ({
      id: "C-0003", date, item_id: pair.item_id, edition_date: pair.edition_date, type: "update", field, before: "8.6", after: "7.4",
      reason: "SAMPLE. The CNA lowered the score.", source_url: `https://www.cve.org/CVERecord?id=${CVE}`, trigger: "recheck", dispute_id: null,
    });
    const run = async (date: string, field: string) => {
      const w = pairWorld(pair);
      statusWith(w.content, "2026-10-15", [flag]); // first appeared on 2026-10-15
      editJson<CorrectionsFile>(path.join(w.content, "corrections.json"), (c) => { c.corrections.push(correction(date, field) as never); });
      return flagRun(w);
    };
    expect((await run("2026-10-15", "cves.0.cvss")).shown).toEqual([]);
    expect((await run("2026-10-16", "cves.0.cvss.score")).shown).toEqual([]);
    expect((await run("2026-10-15", "cves.0")).shown).toEqual([]);
    const early = await run("2026-10-14", "cves.0.cvss");
    expect(early.shown).toHaveLength(1);
    expect(early.record.flagged).toEqual([flag]);
    expect((await run("2026-10-15", "summary")).shown).toHaveLength(1);
  });
});

describe("withholds, failures, pages, closures and since (R13 to R19)", () => {
  it("R13 at most 10 victim or attribution disputes are withheld in a run; the rest wait, oldest first", async () => {
    const w = world();
    const items = liveItems(w.content).slice(0, 12);
    const list = items.map(({ date, item }, i) =>
      issue(20 + i, formBody(item.id, date, i % 2 ? DISPUTE_FORM_OPTIONS.attribution : DISPUTE_FORM_OPTIONS.victim, null), `2026-10-15T0${Math.floor(i / 6)}:${String((i % 6) * 10).padStart(2, "0")}:00Z`));
    // A second report on the first item, edition and kind takes no second place.
    list.push(issue(40, formBody(items[0]!.item.id, items[0]!.date, DISPUTE_FORM_OPTIONS.victim, null), "2026-10-15T03:00:00Z"));
    const api = issuesApi([list]);
    const r = await intake(w, api.impl);
    expect(r.ok).toBe(true);
    expect(MAX_WITHHOLDS).toBe(10);
    expect(r.withhold).toHaveLength(10);
    expect(r.waiting).toBe(2);
    expect(r.withhold.map((x) => x.item_id)).toEqual(items.slice(0, 10).map((x) => x.item.id));
    expect(r.withhold.map((x) => x.dispute_id)).toEqual(Array.from({ length: 10 }, (_, i) => `D-${String(i + 2).padStart(4, "0")}`));
    expect(r.withhold.every((x) => x.since === D)).toBe(true);
    expect(r.disputes).toHaveLength(1 + 13);
  });

  it("R14 an intake failure gives ok false, keeps the stored list, and the flags still run", async () => {
    const w = world({ config: true });
    const failing = issuesApi(() => { throw new TypeError("fetch failed"); });
    const r = await intake(w, failing.impl);
    expect(r.ok).toBe(false);
    expect(r.disputes).toEqual(readJson<CorrectionsFile>(path.join(w.content, "corrections.json")).disputes);
    expect(r.withhold).toEqual([]); // D-0001 already has its correction
    expect(w.logs).toContain("Dispute intake unavailable today.");
    const http500 = await intake(world(), issuesApi(() => new Response("{}", { status: 500 })).impl);
    expect(http500.ok).toBe(false);
    const notList = await intake(world(), issuesApi(() => Response.json({ message: "SAMPLE" })).impl);
    expect(notList.ok).toBe(false);

    // The CLI: exit 1, and the flags are still in its output.
    writeKev(w.root, steadyKev(w.content));
    process.chdir(w.root);
    vi.stubEnv("CT_CONTENT_DIR", w.content);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { out.push(String(s)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await main(["--date", D, "--json", "--dry-run"], { fetchImpl: failing.impl, fetch: w.fetch });
    expect(code).toBe(1);
    const json = JSON.parse(out.join("")) as { intake: { ok: boolean }; flagged: { items_checked: number } };
    expect(json.intake.ok).toBe(false);
    expect(json.flagged.items_checked).toBe(liveItems(w.content).length);
  });

  it("R15 at most 3 pages are read, each with per_page=100, and pull requests are skipped", async () => {
    const w = world();
    const page = (p: number) => Array.from({ length: 100 }, (_, i) => issue(1000 + p * 100 + i, "SAMPLE text, not a form.", "2026-10-15T01:00:00Z"));
    const api = issuesApi([page(0), page(1), page(2), page(3)]);
    const r = await intake(w, api.impl);
    expect(r.ok).toBe(true);
    expect(api.calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual([null, "2", "3"]);
    expect(api.calls.every((c) => new URL(c.url).searchParams.get("per_page") === "100")).toBe(true);
    expect(INTAKE_LIMITS.maxPages).toBe(3);
    expect(r.ignored).toHaveLength(300);
    expect(w.logs.some((l) => l.includes("3 full pages read"))).toBe(true);

    // A short page ends the read; a pull request with a valid form body becomes no dispute.
    const w2 = world();
    const api2 = issuesApi([ISSUES]);
    const r2 = await intake(w2, api2.impl);
    expect(api2.calls).toHaveLength(1);
    expect(r2.disputes.some((d) => d.issue_number === 7)).toBe(false);
    expect(r2.ignored).not.toContain(7);
  });

  it("R16 not_planned becomes rejected and completed upheld, with resolved_on set to the run date", async () => {
    const w = world();
    addDispute(w.content, {
      id: "D-0002", received: "2026-10-12T18:00:00+08:00", issue_number: 2, item_id: "pol-jp-active-cyber-defence-2026-10", edition_date: "2026-10-12",
      kind: "fact", evidence_url: null, status: "open", resolved_on: null, correction_id: null,
    });
    const closed = readJson<IssueJson[]>(path.join(FIX, "issues-closed.json"));
    const r = await intake(w, issuesApi([closed]).impl);
    expect(r.ok).toBe(true);
    const byId = new Map(r.disputes.map((d) => [d.id, d]));
    expect(byId.get("D-0001")).toMatchObject({ status: "rejected", resolved_on: D, correction_id: "C-0001" });
    expect(byId.get("D-0002")).toMatchObject({ status: "upheld", resolved_on: D });
    expect(r.disputes).toHaveLength(2);
    // The rejected victim dispute's item is still withheld with no update since: the agent hears of it.
    expect(r.reports).toEqual([{ item_id: "inc-health-us-2026-10", type: "victim", evidence_url: null }]);
    // A dispute already closed keeps its first resolution.
    editJson<CorrectionsFile>(path.join(w.content, "corrections.json"), (c) => { c.disputes = r.disputes; });
    const later = await intake(w, issuesApi([closed]).impl, addDays(D, 1));
    expect(later.disputes.find((d) => d.id === "D-0001")).toMatchObject({ status: "rejected", resolved_on: D });
  });

  it("R17 since is the newest dispute's received in UTC, else D minus 30 days at 00:00 UTC; GET with no token", async () => {
    expect(intakeSince([{ received: "2026-10-12T21:14:05+08:00" }, { received: "2026-10-01T09:00:00+08:00" }], D)).toBe("2026-10-12T13:14:05Z");
    expect(intakeSince([], D)).toBe("2026-09-16T00:00:00Z");
    expect(intakeUrl("8gara8/CyberTracker", "2026-09-16T00:00:00Z", 2))
      .toBe(`${ISSUES_PREFIX}state=all&labels=correction&since=2026-09-16T00:00:00Z&per_page=100&page=2`);

    const w = world();
    const api = issuesApi([[]]);
    await intake(w, api.impl);
    expect(api.calls.map((c) => c.url)).toEqual([`${ISSUES_PREFIX}state=all&labels=correction&since=2026-10-12T13:14:05Z&per_page=100`]);
    const init = api.calls[0]!.init!;
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(config.run.user_agent);
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");

    const empty = world();
    fs.writeFileSync(path.join(empty.content, "corrections.json"), `${JSON.stringify({ schema_version: 1, corrections: [], disputes: [] }, null, 2)}\n`);
    const api2 = issuesApi([[]]);
    await intake(empty, api2.impl);
    expect(api2.calls[0]!.url).toContain("&since=2026-09-16T00:00:00Z&");
  });

  it("R18 with kev or cvelist failed, their flags are skipped with a note", async () => {
    const kevPair = pairOf("kev_changed");
    const w = pairWorld(kevPair);
    let r = await flagRun(w, { feedsOk: { kev: false, cvelist: true } });
    expect(r.skipped).toEqual(["kev"]);
    expect(r.record.flagged).toEqual([]);
    expect(w.logs).toContain("recheck: flags from kev skipped: the feed failed.");

    const cvssPair = pairOf("cvss_changed");
    const w2 = pairWorld(cvssPair);
    r = await flagRun(w2, { feedsOk: { kev: true, cvelist: false } });
    expect(r.skipped).toEqual(["cvelist"]);
    expect(r.record.flagged).toEqual([]);
    expect(w2.fetched).toEqual([]); // no record is fetched by id either
    expect(w2.logs).toContain("recheck: flags from cvelist skipped: the feed failed.");

    // KEV read ok but the cache holds another day's catalog: skipped too, and said so.
    const w3 = world();
    writeKev(w3.root, steadyKev(w3.content).filter((x) => x.cveID !== CVE), addDays(D, -1));
    r = await flagRun(w3);
    expect(r.skipped).toEqual(["kev"]);
    expect(r.record.flagged).toEqual([]);
    expect(w3.logs.some((l) => l.includes("flags from kev skipped"))).toBe(true);

    // The source and reader flags still run.
    const both = pairWorld(pairOf("source_missing"));
    r = await flagRun(both, { feedsOk: { kev: false, cvelist: false } });
    expect(r.skipped).toEqual(["kev", "cvelist"]);
    expect(r.record.flagged.map((f) => f.flag)).toEqual(["source_missing"]);
    expect(both.logs).toContain("recheck: flags from kev and cvelist skipped: the feed failed.");
  });

  it("R19 a victim dispute becomes a WithholdRequest with a new D-NNNN; fact and link disputes become reports", async () => {
    const w = world();
    const api = issuesApi([ISSUES]);
    const r = await intake(w, api.impl);
    expect(r.ok).toBe(true);
    expect(r.ignored).toEqual([8, 9]);
    expect(w.logs).toContain("issue #8: form not parseable");
    const fresh = r.disputes.filter((d) => d.id !== "D-0001");
    expect(fresh).toEqual([
      { id: "D-0002", received: taipeiTimestamp(new Date("2026-10-15T01:10:00Z")), issue_number: 4, item_id: "inc-transport-jp-2026-10", edition_date: "2026-10-14", kind: "victim", evidence_url: null, status: "open", resolved_on: null, correction_id: null },
      { id: "D-0003", received: "2026-10-15T10:00:00+08:00", issue_number: 5, item_id: "camp-tw-semiconductor-2026-10", edition_date: "2026-10-14", kind: "attribution", evidence_url: "https://teamt5.org/ct-sample/paper-kestrel-invoice-phishing", status: "open", resolved_on: null, correction_id: null },
      { id: "D-0004", received: "2026-10-15T11:00:00+08:00", issue_number: 6, item_id: "cve-2026-104935", edition_date: "2026-10-14", kind: "fact", evidence_url: "https://ivanti.com/ct-sample/connect-secure-security-advisory-cve-2026-104935", status: "open", resolved_on: null, correction_id: null },
      { id: "D-0005", received: "2026-10-15T15:00:00+08:00", issue_number: 10, item_id: "pt-microsoft-2026-10", edition_date: "2026-10-14", kind: "link", evidence_url: "https://msrc.microsoft.com/ct-sample/october-2026-security-update", status: "open", resolved_on: null, correction_id: null },
    ]);
    expect(r.withhold).toEqual([
      { item_id: "inc-transport-jp-2026-10", edition_date: "2026-10-14", kind: "victim", dispute_id: "D-0002", since: D },
      { item_id: "camp-tw-semiconductor-2026-10", edition_date: "2026-10-14", kind: "attribution", dispute_id: "D-0003", since: D },
    ]);
    expect(r.waiting).toBe(0);
    expect(r.reports).toEqual([
      { item_id: "cve-2026-104935", type: "fact", evidence_url: "https://ivanti.com/ct-sample/connect-secure-security-advisory-cve-2026-104935" },
      { item_id: "pt-microsoft-2026-10", type: "link", evidence_url: "https://msrc.microsoft.com/ct-sample/october-2026-security-update" },
    ]);
    // Issues already recorded are not added twice.
    editJson<CorrectionsFile>(path.join(w.content, "corrections.json"), (c) => { c.disputes = r.disputes; });
    const again = await intake(w, issuesApi([ISSUES]).impl);
    expect(again.disputes).toEqual(r.disputes);
    // The open fact dispute raises a reader_report flag on its item.
    writeKev(w.root, steadyKev(w.content));
    const flags = await flagRun(w, { disputes: r.disputes });
    expect(flags.record.flagged.filter((f) => f.flag === "reader_report").map((f) => [f.item_id, f.detail])).toEqual([
      ["cve-2026-104935", "Reader report D-0004 (fact)."],
      ["pt-microsoft-2026-10", "Reader report D-0005 (link)."],
    ]);
  });

  it("R19 a victim dispute already answered by a name_removed correction is not withheld again", async () => {
    const w = world();
    // D-0001's item: a second, new report on it takes the stored correction's id.
    const body = formBody("inc-health-us-2026-10", "2026-10-12", DISPUTE_FORM_OPTIONS.victim, null);
    const r = await intake(w, issuesApi([[issue(11, body, "2026-10-15T01:00:00Z")]]).impl);
    expect(r.withhold).toEqual([]);
    expect(r.disputes.find((d) => d.issue_number === 11)).toMatchObject({ id: "D-0002", status: "open", correction_id: "C-0001" });
  });

  it("R19 a stored correction whose own dispute was rejected answers no new dispute: the new one is withheld again", async () => {
    // C-0001 no longer binds later editions once D-0001 is rejected, so reusing it would leave the new dispute open
    // with nothing withholding the name (§4.10).
    const w = world();
    editJson<CorrectionsFile>(path.join(w.content, "corrections.json"), (c) => {
      c.disputes = c.disputes.map((d) => (d.id === "D-0001" ? { ...d, status: "rejected", resolved_on: "2026-10-14" } : d));
    });
    const body = formBody("inc-health-us-2026-10", "2026-10-12", DISPUTE_FORM_OPTIONS.victim, null);
    const r = await intake(w, issuesApi([[issue(11, body, "2026-10-15T01:00:00Z")]]).impl);
    expect(r.withhold).toEqual([{ item_id: "inc-health-us-2026-10", edition_date: "2026-10-12", kind: "victim", dispute_id: "D-0002", since: D }]);
    expect(r.disputes.find((d) => d.issue_number === 11)).toMatchObject({ id: "D-0002", status: "open", correction_id: null });
    // While the new dispute is open, the agent is not told it may restore the text for the rejected one: an update
    // correction would print the name in the corrections list.
    expect(r.reports).toEqual([]);
    // Once nothing else disputes the item, the rejected dispute's report comes back.
    const alone = await intake(w, issuesApi([[]]).impl);
    expect(alone.reports).toEqual([{ item_id: "inc-health-us-2026-10", type: "victim", evidence_url: null }]);
  });
});

describe("the CLI and the run log", () => {
  it("usage errors exit 2; a dry run writes nothing; a real run writes logs/D.recheck.json only", async () => {
    const w = world({ config: true });
    writeKev(w.root, steadyKev(w.content));
    process.chdir(w.root);
    vi.stubEnv("CT_CONTENT_DIR", w.content);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { out.push(String(s)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["--date", "16 October"])).toBe(2);
    expect(await main(["--nope"])).toBe(2);
    expect(await main(["--date", D, "stray"])).toBe(2);

    const api = issuesApi([ISSUES]);
    const before = fs.readFileSync(path.join(w.content, "corrections.json"), "utf8");
    expect(await main(["--date", D, "--dry-run"], { fetchImpl: api.impl, fetch: w.fetch })).toBe(0);
    expect(fs.existsSync(path.join(w.root, "logs"))).toBe(false);
    expect(out.join("")).toContain("Intake: 5 disputes, 2 to withhold");

    out.length = 0;
    expect(await main(["--date", D, "--json"], { fetchImpl: issuesApi([ISSUES]).impl, fetch: w.fetch })).toBe(0);
    const log = readJson<Record<string, unknown>>(path.join(w.root, "logs", `${D}.recheck.json`));
    expect(Object.keys(log)).toEqual(["intake", "flagged", "shown", "reports"]);
    expect(log.flagged).not.toBeNull();
    expect(log.shown).toEqual(expect.any(Array)); // the flags the context shows (build-context reads them)
    expect(JSON.parse(out.join(""))).toEqual(log);
    // Intake never writes corrections.json and never withholds: publish does.
    expect(fs.readFileSync(path.join(w.content, "corrections.json"), "utf8")).toBe(before);

    // --flags alone reads no issue.
    const none = issuesApi([[]]);
    out.length = 0;
    expect(await main(["--date", D, "--flags", "--json", "--dry-run"], { fetchImpl: none.impl, fetch: w.fetch })).toBe(0);
    expect(none.calls).toEqual([]);
    expect(JSON.parse(out.join(""))).toMatchObject({ intake: null, reports: [] });
  });

  it("writeRecheckLog writes the three keys, and shown and links when given", () => {
    const w = world();
    writeRecheckLog(w.root, D, { intake: null, flagged: { from: addDays(D, -14), to: addDays(D, -1), items_checked: 0, flagged: [] }, reports: [] });
    const file = path.join(w.root, "logs", `${D}.recheck.json`);
    expect(readJson(file)).toEqual({ intake: null, flagged: { from: "2026-10-02", to: "2026-10-15", items_checked: 0, flagged: [] }, reports: [] });
    writeRecheckLog(w.root, D, { intake: null, flagged: null, reports: [], links: null });
    expect(readJson(file)).toEqual({ intake: null, flagged: null, reports: [], links: null });
    // `shown`, the context's flag list, goes between flagged and reports when given (the build-context CLI reads it).
    const shown = [{ date: addDays(D, -3), item_id: "cve-2026-104935", check: "cvss_changed" as const, before: "9.1", after: "9.8", evidence_url: null }];
    writeRecheckLog(w.root, D, { intake: null, flagged: null, shown, reports: [] });
    expect(Object.keys(readJson(file) as object)).toEqual(["intake", "flagged", "shown", "reports"]);
    expect((readJson(file) as { shown: unknown }).shown).toEqual(shown);
    expect(fs.readdirSync(path.dirname(file))).toEqual([`${D}.recheck.json`]);
    expect(RECHECK_LIMITS.days).toBe(14);
  });
});

describe("the sample's re-check window", () => {
  it("R21 every site-content status record checks D − 14 to D − 1, as recheckItems does (fixtures/src/site.ts RECHECK_DAYS)", () => {
    expect(RECHECK_DAYS).toBe(RECHECK_LIMITS.days);
    let seen = 0;
    for (const f of fs.readdirSync(path.join(SITE, "status")).sort()) {
      const s = readJson<StatusFile>(path.join(SITE, "status", f));
      for (const r of s.runs) {
        if (!r.recheck) continue;
        seen += 1;
        expect([r.recheck.from, r.recheck.to], `${f} ${r.run_id}`).toEqual([addDays(s.date, -RECHECK_LIMITS.days), addDays(s.date, -1)]);
      }
    }
    expect(seen).toBeGreaterThan(5);
  });
});

describe("the §8.9 rewrite end to end (I-R20, plan A16)", () => {
  it("I-R20 a victim dispute from intake, withheld by composeWithholds in a copy of site-content, passes validateAll", async () => {
    const w = world();
    const victim = ISSUES.find((i) => i.number === 4)!;
    const r = await intake(w, issuesApi([[victim]]).impl);
    expect(r.ok).toBe(true);
    const ITEM = "inc-transport-jp-2026-10";
    expect(r.withhold).toEqual([{ item_id: ITEM, edition_date: "2026-10-14", kind: "victim", dispute_id: "D-0002", since: D }]);

    // What publishWithholds() hands the composer: every stored brief from the earliest edition_date on, and
    // every earlier one holding the item.
    const cfg = fixtureConfig();
    const briefs = briefsOf(w.content).map((b) => BriefSchema.parse(b)).filter((b) => b.date >= "2026-10-14" || b.items.some((x) => x.id === ITEM));
    const metricsFor = (date: string) => {
      const file = path.join(w.content, "metrics", `${date}.json`);
      return fs.existsSync(file) ? Metrics.parse(readJson(file)) : null;
    };
    const ch = composeWithholds({
      date: D, config: cfg, briefs, corrections: CorrectionsSchema.parse(readJson(path.join(w.content, "corrections.json"))), disputes: r.disputes,
      archiveIndex: ArchiveIndex.parse(readJson(path.join(w.content, "archive-index.json"))), metricsFor, requests: r.withhold,
    });
    expect(ch.brief).toBeNull();
    expect(ch.rewritten.map((b) => b.date)).toContain("2026-10-14");
    for (const b of ch.rewritten) write(path.join(w.content, "briefs", `${b.date}.json`), jsonText(b, BriefSchema));
    write(path.join(w.content, "corrections.json"), jsonText(ch.corrections!, CorrectionsSchema));
    write(path.join(w.content, "archive-index.json"), jsonText(ch.archiveIndex, ArchiveIndex));

    const all = validateAll(w.content, { config: cfg });
    expect(all.errors).toEqual([]);
    const stored = BriefSchema.parse(readJson(path.join(w.content, "briefs", "2026-10-14.json")));
    const it2 = stored.items.find((x) => x.id === ITEM)!;
    const correction = ch.corrections!.corrections.find((c) => c.dispute_id === "D-0002")!;
    expect(correction).toMatchObject({ id: "C-0003", date: D, item_id: ITEM, edition_date: "2026-10-14", type: "name_removed", field: "incident.victim", trigger: "reader_report" });
    expect(it2.withheld).toEqual({ correction_id: correction.id, since: D });
    expect(it2.headline).toBe(WITHHELD_HEADLINE);
    expect(it2.incident?.victim ?? null).toBeNull();
    for (const row of stored.regions.rows) if (row.item_ids.includes(ITEM)) expect(row.reason).toBe(WITHHELD_MARK);
    expect(ch.corrections!.disputes.find((d) => d.id === "D-0002")!.correction_id).toBe(correction.id);
    expect(ch.archiveIndex.editions.find((e) => e.date === "2026-10-14")!.corrected).toBe(true);
  });
});
