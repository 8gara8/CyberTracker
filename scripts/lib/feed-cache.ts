// Reads what collect left in cache/ (cache/feeds/inputs.json, index.json and the bodies) for the metrics
// (SPEC §5.10 step 1, §8.3, §8.4). Every body is parsed by the WP1 parser that collect used, so the metrics
// see exactly the facts collect saw. A body that is missing or does not parse makes that feed "failed"
// here; it never throws. Only a missing or foreign inputs.json throws (NoFeedsError).
//
// Layout read (lib/feeds/cache.ts cachePaths()):
//   cache/feeds/inputs.json, cache/feeds/index.json
//   cache/feeds/kev.json                      the KEV catalog body
//   cache/cvelist/zips/<asset>                every zip inputs.json lists
//   cache/cvelist/records/<CVE>.json          every by-id record inputs.json lists as fetched
//   cache/epss/epss_scores-<date>.csv.gz      every EPSS file inputs.json lists, by role
//   cache/ghsa/advisories/github-reviewed/<YYYY>/<MM>/<GHSA id>/<GHSA id>.json, for inputs.json's months
//   cache/feeds/anthropic-cvd.html and anthropic-cvd.payload.json (the payload optional)
// A feed's manifest `version` is what --recompute re-fetches it by: the commit SHA and zip tags (cvelist),
// the commit (kev, ghsa), the EPSS score dates, the dashboard revision. Its `sha256` covers the bytes read
// here: the catalog body; "<asset> <sha256>" lines of the zips; "<role> <date> <sha256>" lines of the EPSS
// files; collect's GHSA tree hash; the dashboard page followed by its payload.

import fs from "node:fs";
import path from "node:path";
import { cachePaths } from "../../lib/feeds/cache";
import { parseAnthropicCvd } from "../../lib/feeds/anthropic-cvd";
import { cveFacts } from "../../lib/feeds/cvelist";
import { parseEpssCsv } from "../../lib/feeds/epss";
import { parseGhsa } from "../../lib/feeds/ghsa";
import { parseKev } from "../../lib/feeds/kev";
import type { CveFacts, CvdDashboard, EpssDay, FeedState, GhsaAdvisory, KevCatalog } from "../../lib/feeds/types";
import { parseDeltaZip } from "../../lib/feeds/zip";
import { byCodeUnit, compareCveIds } from "../../lib/ids";
import { sha256Hex } from "../../lib/json";
import { CollectInputsFile, FeedIndexFile, type FeedIndexEntry } from "../../lib/schema/pack";

/** One feed as the metrics see it. */
export interface FeedRead {
  id: string;
  status: FeedState;
  as_of: string | null;
  version: string | null;
  sha256: string | null;
  records: number;
  fetched_at: string | null;
}

export interface MetricsFeeds {
  inputs: CollectInputsFile;
  index: FeedIndexFile;
  kev: { read: FeedRead; catalog: KevCatalog | null };
  cvelist: {
    read: FeedRead;
    /** Day X with X + 1's copy of a record winning. */
    days: { date: string; ok: boolean; records: CveFacts[] }[];
    zipRecords: CveFacts[];
    /** null = 404. */
    byId: ReadonlyMap<string, CveFacts | null>;
  };
  epss: { read: FeedRead; e: EpssDay | null; e1: EpssDay | null; e7: EpssDay | null };
  ghsa: { read: FeedRead; advisories: GhsaAdvisory[]; headDate: string | null };
  anthropicCvd: { read: FeedRead; dashboard: CvdDashboard | null; sourceUrl: string };
}

/** cache/feeds/inputs.json is absent, or for another date. */
export class NoFeedsError extends Error {
  constructor(message = "no collect cache for this date") {
    super(message);
    this.name = "NoFeedsError";
  }
}

/** The metrics feeds, in the order the manifest and the first line use. */
export const METRICS_FEED_IDS = ["kev", "cvelist", "epss", "ghsa", "anthropic-cvd"] as const;

const failedRead = (id: string): FeedRead => ({ id, status: "failed", as_of: null, version: null, sha256: null, records: 0, fetched_at: null });

/** The FeedRead for an index row (absent row: failed). */
function readOf(id: string, entry: FeedIndexEntry | undefined): FeedRead {
  if (!entry) return failedRead(id);
  return { id, status: entry.status, as_of: entry.newest, version: entry.version, sha256: entry.sha256, records: entry.records, fetched_at: entry.fetched_at };
}

/** A read that could not be used here: failed, keeping the time collect fetched it. */
const unusable = (r: FeedRead): FeedRead => ({ ...r, status: "failed", sha256: null, version: null, records: 0 });

const usable = (r: FeedRead): boolean => r.status === "ok" || r.status === "stale";

function readFile(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** Facts from one zip and the SHA-256 of its bytes, or null when it is missing or does not parse. */
function zipFacts(file: string): { facts: CveFacts[]; sha256: string } | null {
  const buf = readFile(file);
  if (!buf) return null;
  try {
    return { facts: parseDeltaZip(buf).records.map((r) => cveFacts(r)).filter((f): f is CveFacts => f !== null), sha256: sha256Hex(buf) };
  } catch {
    return null;
  }
}

/** One copy per id, the later list winning, in CVE order. */
function merged(lists: readonly CveFacts[][]): CveFacts[] {
  const out = new Map<string, CveFacts>();
  for (const list of lists) for (const f of list) out.set(f.cve_id, f);
  return [...out.values()].sort((a, b) => compareCveIds(a.cve_id, b.cve_id));
}

/** When a zip's content ends: an end-of-day zip at the next day's 00:00 UTC, an hourly one at its tag's hour. */
function zipEnd(z: CollectInputsFile["cvelist"]["zips"][number]): string {
  if (z.kind === "end_of_day") return `${z.utc_day}T24:00`;
  const m = /_(\d{2})(\d{2})Z$/.exec(z.tag);
  return `${z.utc_day}T${m ? `${m[1]}:${m[2]}` : "00:00"}`;
}

function cvelistFeed(p: ReturnType<typeof cachePaths>, inputs: CollectInputsFile, entry: FeedIndexEntry | undefined): MetricsFeeds["cvelist"] {
  const read = readOf("cvelist", entry);
  const zips = [...inputs.cvelist.zips].sort((a, b) => byCodeUnit(zipEnd(a), zipEnd(b)) || byCodeUnit(a.tag, b.tag));
  const byAsset = new Map<string, { facts: CveFacts[]; sha256: string } | null>();
  for (const z of zips) byAsset.set(z.asset, zipFacts(p.zip(z.asset)));
  const loaded = zips.filter((z) => byAsset.get(z.asset));

  const days = inputs.cvelist.days.map((d) => {
    const a = byAsset.get(d.zips[0]);
    const b = byAsset.get(d.zips[1]);
    return { date: d.date, ok: d.ok && !!a && !!b, records: a && b ? merged([a.facts, b.facts]) : [] };
  });
  const zipRecords = merged(loaded.map((z) => byAsset.get(z.asset)!.facts));

  const byId = new Map<string, CveFacts | null>();
  for (const id of [...inputs.cvelist.by_id.not_found].sort(compareCveIds)) byId.set(id, null);
  for (const id of [...inputs.cvelist.by_id.fetched].sort(compareCveIds)) {
    const buf = readFile(path.join(p.recordsDir, `${id}.json`));
    if (!buf) continue;
    try {
      const f = cveFacts(JSON.parse(buf.toString("utf8")) as unknown);
      if (f) byId.set(id, f);
    } catch {
      // An unparsable record is left out: the row stays as it was.
    }
  }

  const commit = inputs.commits.cvelist;
  const out: FeedRead = !usable(read) && loaded.length === 0 ? unusable(read) : {
    ...read,
    status: usable(read) ? read.status : "stale",
    version: [commit ?? "branch", ...loaded.map((z) => z.tag)].join(" "),
    sha256: loaded.length ? sha256Hex(loaded.map((z) => `${z.asset} ${byAsset.get(z.asset)!.sha256}\n`).join("")) : read.sha256,
    records: loaded.reduce((n, z) => n + z.records, 0) + inputs.cvelist.by_id.fetched.length,
  };
  return { read: out, days, zipRecords, byId };
}

function kevFeed(p: ReturnType<typeof cachePaths>, inputs: CollectInputsFile, entry: FeedIndexEntry | undefined): MetricsFeeds["kev"] {
  const read = readOf("kev", entry);
  if (!usable(read)) return { read: unusable(read), catalog: null };
  const body = readFile(p.feedBody("kev", "json"));
  if (!body) return { read: unusable(read), catalog: null };
  try {
    const parsed = parseKev(body);
    return {
      read: { ...read, version: inputs.commits.kev_data ?? parsed.catalog.catalogVersion, sha256: parsed.sha256, records: parsed.catalog.count },
      catalog: parsed.catalog,
    };
  } catch {
    return { read: unusable(read), catalog: null };
  }
}

function epssFeed(p: ReturnType<typeof cachePaths>, inputs: CollectInputsFile, entry: FeedIndexEntry | undefined): MetricsFeeds["epss"] {
  const read = readOf("epss", entry);
  const days: Record<"e" | "e1" | "e7", EpssDay | null> = { e: null, e1: null, e7: null };
  const files = [...(inputs.epss?.files ?? [])].sort((a, b) => byCodeUnit(a.role, b.role));
  const used: { role: string; date: string; sha256: string }[] = [];
  if (inputs.epss?.source === "csv") {
    for (const f of files) {
      const buf = readFile(p.epssFile(f.date));
      if (!buf) continue;
      try {
        const parsed = parseEpssCsv(buf);
        days[f.role] = parsed.day;
        used.push({ role: f.role, date: f.date, sha256: parsed.sha256 });
      } catch {
        // A file that does not parse is left out.
      }
    }
  }
  if (!used.length) return { read: usable(read) ? read : unusable(read), ...days };
  return {
    read: {
      ...read,
      version: used.map((f) => `${f.role}=${f.date}`).join(" "),
      sha256: sha256Hex(used.map((f) => `${f.role} ${f.date} ${f.sha256}\n`).join("")),
      records: days.e?.scores.size ?? 0,
    },
    ...days,
  };
}

function ghsaFeed(p: ReturnType<typeof cachePaths>, inputs: CollectInputsFile, entry: FeedIndexEntry | undefined): MetricsFeeds["ghsa"] {
  const read = readOf("ghsa", entry);
  const g = inputs.ghsa;
  if (!g || !usable(read)) return { read: unusable(read), advisories: [], headDate: null };
  const base = path.join(p.ghsaDir, "advisories", "github-reviewed");
  const advisories: GhsaAdvisory[] = [];
  for (const month of [...g.months].sort(byCodeUnit)) {
    const dir = path.join(base, ...month.split("/"));
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort(byCodeUnit);
    } catch {
      continue;
    }
    for (const name of names) {
      const buf = readFile(path.join(dir, name, `${name}.json`));
      if (!buf) continue;
      try {
        const a = parseGhsa(JSON.parse(buf.toString("utf8")) as unknown);
        if (a) advisories.push(a);
      } catch {
        // An advisory that does not parse is left out.
      }
    }
  }
  advisories.sort((a, b) => byCodeUnit(a.id, b.id));
  return {
    read: { ...read, version: g.commit ?? inputs.commits.ghsa ?? read.version, sha256: g.tree_sha256, records: advisories.length },
    advisories,
    headDate: g.head_date,
  };
}

function cvdFeed(p: ReturnType<typeof cachePaths>, inputs: CollectInputsFile, entry: FeedIndexEntry | undefined): MetricsFeeds["anthropicCvd"] {
  const read = readOf("anthropic-cvd", entry);
  const sourceUrl = entry?.url_used ?? "";
  const body = usable(read) && sourceUrl ? readFile(p.feedBody("anthropic-cvd", "html")) : null;
  if (!body) return { read: unusable(read), dashboard: null, sourceUrl };
  try {
    const payload = readFile(p.feedBody("anthropic-cvd", "payload.json"));
    const dashboard = parseAnthropicCvd(body, "text/html", payload);
    return {
      read: { ...read, version: dashboard.revision, sha256: sha256Hex(payload ? Buffer.concat([body, payload]) : body), records: dashboard.ledger_ids.length },
      dashboard,
      sourceUrl,
    };
  } catch {
    return { read: unusable(read), dashboard: null, sourceUrl };
  }
}

/** Throws NoFeedsError when inputs.json is absent or for another date. */
export function loadFeedCache(root: string, date: string): MetricsFeeds {
  const p = cachePaths(root);
  const rawInputs = readFile(p.collectInputs);
  if (!rawInputs) throw new NoFeedsError(`No feeds for ${date} in cache/: run npm run collect -- --date ${date} first.`);
  const inputs = CollectInputsFile.parse(JSON.parse(rawInputs.toString("utf8")));
  if (inputs.date !== date) throw new NoFeedsError(`cache/feeds/inputs.json is for ${inputs.date}, not ${date}: run npm run collect -- --date ${date} first.`);
  const rawIndex = readFile(p.feedIndex);
  if (!rawIndex) throw new NoFeedsError(`cache/feeds/index.json is missing: run npm run collect -- --date ${date} first.`);
  const index = FeedIndexFile.parse(JSON.parse(rawIndex.toString("utf8")));
  const entry = (id: string) => index.feeds.find((f) => f.id === id);
  return {
    inputs,
    index,
    kev: kevFeed(p, inputs, entry("kev")),
    cvelist: cvelistFeed(p, inputs, entry("cvelist")),
    epss: epssFeed(p, inputs, entry("epss")),
    ghsa: ghsaFeed(p, inputs, entry("ghsa")),
    anthropicCvd: cvdFeed(p, inputs, entry("anthropic-cvd")),
  };
}

/**
 * Every metrics feed failed: what the metrics see when collect left nothing for `date` (outside a
 * backfill build, runMetrics then carries every block's earlier value, §8.4). `generatedAt` stamps the
 * placeholder inputs; nothing reads it.
 */
export function noFeeds(date: string, cutoff: string, generatedAt: string): MetricsFeeds {
  const inputs: CollectInputsFile = {
    schema_version: 1, date, data_cutoff_utc: cutoff, generated_at: generatedAt, run_utc_day: cutoff,
    record_window: { start: `${cutoff}T00:00:00Z`, end: `${cutoff}T00:00:00Z` },
    commits: { cvelist: null, kev_data: null, ghsa: null },
    cvelist: { zips: [], days: [], newest_hourly_tag: null, delta_log_newest: null, by_id: { fetched: [], not_found: [], over_cap: 0 } },
    kev: null, epss: null, ghsa: null, anthropic_cvd: null,
  };
  return {
    inputs,
    index: { schema_version: 1, date, generated_at: generatedAt, feeds: [] },
    kev: { read: failedRead("kev"), catalog: null },
    cvelist: { read: failedRead("cvelist"), days: [], zipRecords: [], byId: new Map() },
    epss: { read: failedRead("epss"), e: null, e1: null, e7: null },
    ghsa: { read: failedRead("ghsa"), advisories: [], headDate: null },
    anthropicCvd: { read: failedRead("anthropic-cvd"), dashboard: null, sourceUrl: "" },
  };
}
