// The KEV catalog the backfill joins (SPEC §5.9 step 3, §8.4 `--kev-commit`; ruling R27): the catalog at a
// cisagov/kev-data commit, fetched from raw.githubusercontent.com through fetchFeed() and parsed by
// parseKev(). With no commit given, the default is collect's cached catalog when collect's cache is for the
// cutoff's edition date E (so the state and E's metrics join one catalog even if `develop` moves between the
// milestone's two runs), else the tip of `develop` from ls-remote. The same rule picks the default CVE List
// commit: the commit collect read for E, else the tip of `main`.

import fs from "node:fs";
import { loadConfig } from "../../lib/config";
import { cachePaths } from "../../lib/feeds/cache";
import { REPOS, rawAtCommit } from "../../lib/feeds/github";
import { fetchFeed, FEED_MAX_BYTES, FEED_TIMEOUTS } from "../../lib/feeds/http";
import { parseKev } from "../../lib/feeds/kev";
import type { KevCatalog } from "../../lib/feeds/types";
import { sha256Hex } from "../../lib/json";
import { CollectInputsFile } from "../../lib/schema/pack";
import type { GitSource } from "./git-source";

export interface KevRead {
  catalog: KevCatalog;
  commit: string;
  /** SHA-256 of the catalog file's bytes. */
  sha256: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;

/** The registry's `kev` URL (config/sources.yaml), the branch URL rawAtCommit() pins to a commit. */
export function kevRegistryUrl(root: string): string {
  const entry = loadConfig({ root, fresh: true }).sources.feeds.find((f) => f.id === "kev");
  if (!entry || !("url" in entry)) throw new Error("config/sources.yaml has no kev entry with a url.");
  return entry.url;
}

/** Parses a catalog body read at `commit`. Throws FeedParseError on a bad body. */
export function kevReadOf(body: Buffer, commit: string): KevRead {
  return { catalog: parseKev(body).catalog, commit, sha256: sha256Hex(body) };
}

/** The catalog at a kev-data commit, from raw.githubusercontent.com. */
export async function fetchKevAt(registryUrl: string, commit: string, fetch: typeof fetchFeed = fetchFeed): Promise<KevRead> {
  if (!SHA_RE.test(commit)) throw new Error(`Not a full kev-data commit SHA: ${JSON.stringify(commit)}`);
  const url = rawAtCommit(registryUrl, commit);
  const r = await fetch(url, { timeoutMs: FEED_TIMEOUTS.kev, maxBytes: FEED_MAX_BYTES.kev, accept: "application/json" });
  if (!r.ok || !r.body) throw new Error(`KEV catalog at ${commit.slice(0, 7)} could not be read (${r.error ?? `status ${r.status}`}).`);
  return kevReadOf(r.body, commit);
}

/** The tip of a branch of `repo` from ls-remote, or null. */
export async function branchTip(gitSource: GitSource, repo: string, branch: string): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const refs = await gitSource.lsRemote(repo, [ref]);
  const sha = refs?.get(ref) ?? null;
  return sha !== null && SHA_RE.test(sha) ? sha : null;
}

/** What collect cached for edition date `date`: its CVE List and kev-data commits and the catalog body, or null. */
export interface CachedRun {
  cvelistCommit: string | null;
  kevCommit: string | null;
  /** cache/feeds/kev.json when it is the catalog collect read at kevCommit (not the cisa.gov fallback). */
  kevBody: Buffer | null;
}

export function cachedRun(root: string, date: string): CachedRun | null {
  const p = cachePaths(root);
  let inputs: CollectInputsFile;
  try {
    inputs = CollectInputsFile.parse(JSON.parse(fs.readFileSync(p.collectInputs, "utf8")));
  } catch {
    return null;
  }
  if (inputs.date !== date) return null;
  let kevBody: Buffer | null = null;
  const kevCommit = inputs.kev && !inputs.kev.fallback_used ? inputs.commits.kev_data : null;
  if (kevCommit && inputs.kev) {
    try {
      const body = fs.readFileSync(p.feedBody("kev", "json"));
      if (sha256Hex(body) === inputs.kev.sha256) kevBody = body;
    } catch {
      kevBody = null;
    }
  }
  return { cvelistCommit: inputs.commits.cvelist, kevCommit: kevBody ? kevCommit : null, kevBody };
}

/**
 * BackfillDeps.fetchKev for a run whose cutoff's edition date is `editionDate`: the commit asked for; else
 * collect's cached catalog for that date; else the tip of `develop`. `source` says which, for the stdout line.
 */
export function kevSource(root: string, gitSource: GitSource, editionDate: string, fetch: typeof fetchFeed = fetchFeed) {
  let source = "";
  const fn = async (commit: string | null): Promise<KevRead> => {
    if (commit !== null) {
      source = "--kev-commit";
      return fetchKevAt(kevRegistryUrl(root), commit, fetch);
    }
    const cached = cachedRun(root, editionDate);
    if (cached?.kevCommit && cached.kevBody) {
      source = `collect's cache for ${editionDate}`;
      return kevReadOf(cached.kevBody, cached.kevCommit);
    }
    const tip = await branchTip(gitSource, REPOS.kev, "develop");
    if (tip === null) throw new Error("git ls-remote could not read the tip of cisagov/kev-data develop.");
    source = "the tip of develop";
    return fetchKevAt(kevRegistryUrl(root), tip, fetch);
  };
  return Object.assign(fn, { source: () => source });
}
