// One-time tool for fixtures/cvelist-clone/ (fixtures plan §3.6, ruling R22), the 50-record CVE List
// clone tests/backfill.test.ts commits into a temp repo and fetches as file://:
//
//   tsx fixtures/src/tools/cvelist-clone.ts <CVE List V5 clone at 67c39b1> <out dir>
//
// It copies the 50 records named in RECORDS from the clone into <out dir>/cves/<YYYY>/<Nxxx>/, trimmed as
// P1's records are: cveMetadata as written; the CNA's providerMetadata, title, affected vendor and product,
// CVSS objects (version, baseScore, baseSeverity, vectorString) and credits; ADP containers only for their
// CVSS objects and credits; no references, problem types, descriptions (one SAMPLE line instead), SSVC or
// x_ fields. Every credit naming a person becomes "SAMPLE Researcher"; organisation and tool names the
// AI-finder list matches are kept (KEEP_CREDITS, CREDIT_TEXT). One ADP credit is invented (ADP_CREDIT): the
// clone at 67c39b1 holds no AI-matching adp.credits, and the fixture needs one. It also writes a two-entry
// cves/delta.json and cves/deltaLog.json naming fixture records.
//
// It refuses (exit 1, nothing written) when a record is missing, when a trimmed record holds a URL or an
// e-mail form, or when trimming changed what the backfill reads (cveFacts' state, date, assigner, score
// and affected list, and the AI-credit match, except where ADP_CREDIT adds one). The input is data: nothing
// in it is followed or run. Not part of fixtures:gen (its input is a 4.6 GB clone). Read the output in
// full before committing it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../../lib/config";
import { cveFacts } from "../../../lib/feeds/cvelist";
import { compareCveIds } from "../../../lib/ids";
import { matchRecord } from "../../../lib/metrics/ai-credit";

/** The 50 records, by what each one exercises in tests/backfill.test.ts. */
export const RECORDS: readonly (readonly [string, string])[] = [
  // The last three days before the clone's commit (2026-11-07T17:28:47Z): cutoffs 2026-11-04 to 2026-11-06.
  ["CVE-2026-100235", "2026-11-04, CNA CVSS 4.0"],
  ["CVE-2026-100407", "2026-11-04, CNA CVSS 3.1"],
  ["CVE-2026-62662", "2026-11-04, CNA CVSS 3.0"],
  ["CVE-2026-101165", "2026-11-04, CISA-ADP score only"],
  ["CVE-2026-103582", "2026-11-04, unscored"],
  ["CVE-2026-121803", "2026-11-04, REJECTED"],
  ["CVE-2026-100109", "2026-11-05, CNA CVSS 3.0"],
  ["CVE-2026-100144", "2026-11-05, CISA-ADP score only, the invented adp.credits AI match"],
  ["CVE-2026-100358", "2026-11-05, CNA CVSS 4.0"],
  ["CVE-2026-100359", "2026-11-05, CNA CVSS 3.1"],
  ["CVE-2026-100168", "2026-11-05, unscored"],
  ["CVE-2026-100080", "2026-11-06, Linux kernel, unscored"],
  ["CVE-2026-100081", "2026-11-06, Linux kernel, unscored"],
  ["CVE-2026-102650", "2026-11-06, CNA CVSS 3.1"],
  ["CVE-2026-103674", "2026-11-06, CNA CVSS 4.0"],
  ["CVE-2026-107154", "2026-11-06, CISA-ADP score only"],
  ["CVE-2026-107492", "2026-11-06, REJECTED"],
  ["CVE-2026-19868", "2026-11-06, KEV 2026-11-06 (lag 0)"],
  // KEV-joined.
  ["CVE-2026-118527", "2026-11-03, KEV 2026-10-30 (a negative lag, -4 days)"],
  ["CVE-2026-119977", "2026-10-31, KEV 2026-11-03 (lag 3)"],
  // AI-credit matches (cna.credits), one by lab_context.
  ["CVE-2026-93302", "2026-09-27, anthropic-claude by lab_context"],
  ["CVE-2026-2763", "2026-02-24, anthropic-claude by pattern"],
  ["CVE-2025-6965", "2025-07-15, google-big-sleep"],
  ["CVE-2025-27888", "2025-03-20, xbow"],
  ["CVE-2026-91928", "2026-09-23, anthropic-claude-code (ai_assisted)"],
  ["CVE-2026-6385", "2026-04-15, openai-codex"],
  // Zone-less datePublished (read as UTC), before DAYS_FROM.
  ["CVE-2022-38369", "2022-09-05, zone-less time"],
  ["CVE-2022-38370", "2022-09-05, zone-less time"],
  // Scored under CVSS 2.0 only: unscored for §5.4.
  ["CVE-2024-7824", "2024-10-03, CVSS 2.0 only"],
  // Around 2023-05-13, a calendar day with no record at 67c39b1.
  ["CVE-2023-0038", "2023-01-03, CNA CVSS 3.1"],
  ["CVE-2023-0039", "2023-01-03, REJECTED"],
  ["CVE-2023-1934", "2023-05-12, CNA CVSS 3.1"],
  ["CVE-2023-20877", "2023-05-12, CISA-ADP score only"],
  ["CVE-2023-2689", "2023-05-14, CNA CVSS 3.1, 3.0 and 2.0"],
  // Spread over the two years, Linux kernel ones included.
  ["CVE-2024-26622", "2024-03-04, Linux kernel"],
  ["CVE-2024-0155", "2024-03-04, CNA CVSS 3.1"],
  ["CVE-2024-6050", "2024-07-01, CNA CVSS 4.0"],
  ["CVE-2024-36476", "2025-01-15, Linux kernel, CNA and CISA-ADP CVSS 3.1"],
  ["CVE-2024-10775", "2025-01-15, CNA CVSS 3.1"],
  ["CVE-2024-11857", "2025-06-02, CNA CVSS 3.1 and 4.0"],
  ["CVE-2024-1440", "2025-06-02, CNA CVSS 3.1"],
  ["CVE-2024-50337", "2026-03-02, CNA CVSS 3.1"],
  ["CVE-2025-10350", "2026-03-02, CNA CVSS 4.0"],
  ["CVE-2026-68083", "2026-08-10, Linux kernel, CNA CVSS 3.1"],
  ["CVE-2026-68084", "2026-08-10, Linux kernel, unscored"],
  ["CVE-2026-11809", "2026-08-10, CNA CVSS 3.1"],
  ["CVE-2026-100164", "2026-10-27, CNA CVSS 3.1"],
  ["CVE-2024-58399", "2026-10-27, CNA CVSS 4.0 and 3.1"],
  ["CVE-2026-98165", "2026-10-06, Linux kernel, REJECTED"],
  ["CVE-2026-113670", "2026-10-20, REJECTED"],
];

/** Credit values kept as written: organisations and tools, no person. */
const KEEP_CREDITS: ReadonlySet<string> = new Set(["Anthropic OSS program", "XBOW", "The Apache Software Foundation", "Claude Code"]);

/** Credit values that name people next to the AI finder: the people become SAMPLE, the finder text stays. */
const CREDIT_TEXT: Readonly<Record<string, string>> = {
  "CVE-2026-2763#0": "SAMPLE Researcher and SAMPLE Researcher using Claude from Anthropic",
  "CVE-2025-6965#0": "SAMPLE Researcher of Google's Threat Analysis Group, with assistance from Google Big Sleep",
  "CVE-2026-6385#0": "Red Hat would like to thank SAMPLE Researcher (SAMPLE Lab in collaboration with OpenAI Codex) for reporting this issue.",
};

/** The invented adp.credits match: no real ADP container at 67c39b1 carries an AI-finder credit. */
const ADP_CREDIT = { id: "CVE-2026-100144", credit: { lang: "en", type: "finder", value: "SAMPLE Researcher using XBOW" } } as const;

const DELTA_TIME = "2026-11-07T17:28:42.976Z";
const SAMPLE_DESCRIPTION = "SAMPLE description, trimmed from the CVE List record for the backfill tests.";
const SCORE_KEYS = ["cvssV4_0", "cvssV3_1", "cvssV3_0", "cvssV2_0"] as const;
const SCORE_FIELDS = ["version", "baseScore", "baseSeverity", "vectorString"] as const;
const URL_OR_EMAIL = /https?:\/\/|www\.|[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The clone-relative path of a record: cves/<YYYY>/<Nxxx>/<id>.json. */
export function recordPath(id: string): string {
  const [, year, num] = /^CVE-(\d{4})-(\d+)$/.exec(id)!;
  return `cves/${year}/${Math.floor(Number(num) / 1000)}xxx/${id}.json`;
}

function trimMetrics(metrics: unknown): Obj[] {
  const out: Obj[] = [];
  for (const m of arr(metrics)) {
    const kept: Obj = {};
    if (typeof obj(m).format === "string") kept.format = obj(m).format;
    for (const k of SCORE_KEYS) {
      const c = obj(obj(m)[k]);
      if (!Object.keys(c).length) continue;
      kept[k] = Object.fromEntries(SCORE_FIELDS.filter((f) => f in c).map((f) => [f, c[f]]));
    }
    if (SCORE_KEYS.some((k) => k in kept)) out.push(kept);
  }
  return out;
}

function trimCredits(id: string, credits: unknown, start: number): Obj[] {
  return arr(credits).map((c, i) => {
    const v = obj(c).value;
    const value = CREDIT_TEXT[`${id}#${start + i}`] ?? (typeof v === "string" && KEEP_CREDITS.has(v) ? v : "SAMPLE Researcher");
    return { lang: "en", ...(typeof obj(c).type === "string" ? { type: obj(c).type } : {}), value };
  });
}

/** One record trimmed for the fixture (see the header). */
export function trimRecord(raw: unknown): Obj {
  const r = obj(raw);
  const meta = obj(r.cveMetadata);
  const id = String(meta.cveId);
  const cna = obj(obj(r.containers).cna);
  const outCna: Obj = { providerMetadata: cna.providerMetadata };
  if (typeof cna.title === "string") outCna.title = cna.title;
  if (meta.state === "REJECTED") {
    outCna.rejectedReasons = arr(cna.rejectedReasons).map((x) => ({ lang: "en", value: URL_OR_EMAIL.test(String(obj(x).value)) ? "SAMPLE rejected reason." : obj(x).value }));
  } else {
    outCna.descriptions = [{ lang: "en", value: SAMPLE_DESCRIPTION }];
    outCna.affected = arr(cna.affected).map((a) => {
      const o: Obj = {};
      for (const k of ["vendor", "product", "defaultStatus"]) if (typeof obj(a)[k] === "string") o[k] = obj(a)[k];
      return o;
    });
    const metrics = trimMetrics(cna.metrics);
    if (metrics.length) outCna.metrics = metrics;
    const credits = trimCredits(id, cna.credits, 0);
    if (credits.length) outCna.credits = credits;
  }
  let adpCredits = arr(cna.credits).length;
  const adp: Obj[] = [];
  for (const a of arr(obj(r.containers).adp)) {
    const metrics = trimMetrics(obj(a).metrics);
    const credits = trimCredits(id, obj(a).credits, adpCredits);
    adpCredits += credits.length;
    if (id === ADP_CREDIT.id && obj(obj(a).providerMetadata).shortName === "CISA-ADP") credits.push({ ...ADP_CREDIT.credit });
    if (!metrics.length && !credits.length) continue;
    const o: Obj = { providerMetadata: obj(a).providerMetadata };
    if (typeof obj(a).title === "string") o.title = obj(a).title;
    if (metrics.length) o.metrics = metrics;
    if (credits.length) o.credits = credits;
    adp.push(o);
  }
  return {
    dataType: r.dataType, dataVersion: r.dataVersion, cveMetadata: meta,
    containers: { cna: outCna, ...(adp.length ? { adp } : {}) },
  };
}

function deltaRef(id: string, dateUpdated: string): Obj {
  return {
    cveId: id,
    cveOrgLink: `https://www.cve.org/CVERecord?id=${id}`,
    githubLink: `https://raw.githubusercontent.com/CVEProject/cvelistV5/main/${recordPath(id)}`,
    dateUpdated,
  };
}

const jsonOut = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** What the backfill reads from a record, to check trimming changed none of it. */
function readsOf(raw: unknown, compiled: ReturnType<typeof loadConfig>["compiled"]): string {
  const f = cveFacts(raw);
  if (!f) return "unreadable";
  const hit = matchRecord(f, null, compiled.aiFinders);
  return JSON.stringify([f.state, f.date_published, f.assigner, f.scored, f.affected, hit && [hit.finder_id, hit.rule, hit.field]]);
}

/** Builds every output file in memory; throws on any refusal. */
export function buildCloneFixture(cloneDir: string, root: string): Map<string, string> {
  const { compiled } = loadConfig({ root });
  const files = new Map<string, string>();
  const ids = RECORDS.map(([id]) => id);
  if (new Set(ids).size !== 50 || ids.length !== 50) throw new Error(`RECORDS must name 50 distinct ids (${new Set(ids).size}).`);
  const updated = new Map<string, string>();
  for (const id of [...ids].sort(compareCveIds)) {
    const file = path.join(cloneDir, recordPath(id));
    if (!fs.existsSync(file)) throw new Error(`${recordPath(id)} is not in the clone.`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const trimmed = trimRecord(raw);
    const text = jsonOut(trimmed);
    if (URL_OR_EMAIL.test(text)) throw new Error(`${id}: the trimmed record still holds a URL or an e-mail form.`);
    const before = readsOf(raw, compiled);
    const after = readsOf(trimmed, compiled);
    if (id === ADP_CREDIT.id) {
      if (!/"xbow","pattern","adp.credits"/.test(after)) throw new Error(`${id}: the invented ADP credit does not match xbow in adp.credits.`);
    } else if (before !== after) {
      throw new Error(`${id}: trimming changed what the backfill reads:\n  ${before}\n  ${after}`);
    }
    updated.set(id, String(obj(obj(raw).cveMetadata).dateUpdated));
    files.set(recordPath(id), text);
  }
  const newest = { fetchTime: DELTA_TIME, numberOfChanges: 2, new: [deltaRef("CVE-2026-100080", updated.get("CVE-2026-100080")!)],
    updated: [deltaRef("CVE-2026-19868", updated.get("CVE-2026-19868")!)], error: [] };
  const earlier = { fetchTime: "2026-11-07T17:23:39.104Z", numberOfChanges: 2, new: [deltaRef("CVE-2026-100081", updated.get("CVE-2026-100081")!)],
    updated: [deltaRef("CVE-2026-107154", updated.get("CVE-2026-107154")!)], error: [] };
  files.set("cves/delta.json", jsonOut(newest));
  files.set("cves/deltaLog.json", jsonOut([newest, earlier]));
  return files;
}

export function main(argv: readonly string[]): number {
  if (argv.length !== 2) {
    process.stderr.write("Usage: tsx fixtures/src/tools/cvelist-clone.ts <CVE List V5 clone> <out dir>\n");
    return 2;
  }
  const [cloneDir, outDir] = argv.map((p) => path.resolve(p!)) as [string, string];
  let files: Map<string, string>;
  try {
    files = buildCloneFixture(cloneDir, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\nNothing was written.\n`);
    return 1;
  }
  fs.rmSync(path.join(outDir, "cves"), { recursive: true, force: true });
  for (const [rel, text] of files) {
    fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(outDir, rel), text);
  }
  process.stdout.write(`Wrote ${files.size} files to ${outDir}.\n`);
  return 0;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main(process.argv.slice(2));
