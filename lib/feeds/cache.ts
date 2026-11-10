// Where collect, the metrics and the backfill keep their local files (SPEC §9.8 `cache/`, gitignored):
// one function, so no module spells a cache path itself. Pure: it builds paths and touches no file. A
// name that could leave its folder (a slash, a leading dot, a malformed date) throws.

import path from "node:path";

export interface CachePaths {
  /** cache/feeds */
  feedsDir: string;
  /** cache/feeds/index.json: FeedIndexFile (collect writes; status and metrics read). */
  feedIndex: string;
  /** cache/feeds/inputs.json: CollectInputsFile (collect writes; metrics and the backfill read). */
  collectInputs: string;
  /**
   * cache/feeds/<id>.<ext>: kev.json, cvelist.deltaLog.json, nvd.p1.json, myjvn.p1.xml, anthropic-cvd.html
   * (and anthropic-cvd.payload.json), exchange-tw.json, <rss id>.xml.
   */
  feedBody(id: string, ext: string): string;
  /** cache/cvelist/zips: delta zips, kept 60 days and reused by name. */
  zipsDir: string;
  /** cache/cvelist/zips/<asset> */
  zip(asset: string): string;
  /** cache/cvelist/records: per-id records (<CVE>.json), emptied at the start of each collect. */
  recordsDir: string;
  /** cache/epss/epss_scores-YYYY-MM-DD.csv.gz */
  epssFile(date: string): string;
  /** cache/ghsa: the sparse checkout of github/advisory-database. */
  ghsaDir: string;
  /** cache/cvelistV5: the backfill's clone. */
  cvelistClone: string;
  /** cache/staged/<date>: metrics files staged before publish. */
  stagedMetrics(date: string): string;
  /** cache/staged/backfill */
  stagedBackfill: string;
  /** logs/recompute/<date>: a --recompute run's output. */
  recompute(date: string): string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const EXT_RE = /^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*$/;
const ASSET_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checked(re: RegExp, value: string, what: string): string {
  if (!re.test(value)) throw new Error(`cachePaths: not a valid ${what}: ${JSON.stringify(value)}`);
  return value;
}

/** Every cache path under the repo root `root`. */
export function cachePaths(root: string): CachePaths {
  const cache = path.join(root, "cache");
  const feedsDir = path.join(cache, "feeds");
  const zipsDir = path.join(cache, "cvelist", "zips");
  return {
    feedsDir,
    feedIndex: path.join(feedsDir, "index.json"),
    collectInputs: path.join(feedsDir, "inputs.json"),
    feedBody: (id, ext) => path.join(feedsDir, `${checked(ID_RE, id, "feed id")}.${checked(EXT_RE, ext, "extension")}`),
    zipsDir,
    zip: (asset) => path.join(zipsDir, checked(ASSET_RE, asset, "zip asset name")),
    recordsDir: path.join(cache, "cvelist", "records"),
    epssFile: (date) => path.join(cache, "epss", `epss_scores-${checked(DATE_RE, date, "date")}.csv.gz`),
    ghsaDir: path.join(cache, "ghsa"),
    cvelistClone: path.join(cache, "cvelistV5"),
    stagedMetrics: (date) => path.join(cache, "staged", checked(DATE_RE, date, "date")),
    stagedBackfill: path.join(cache, "staged", "backfill"),
    recompute: (date) => path.join(root, "logs", "recompute", checked(DATE_RE, date, "date")),
  };
}
