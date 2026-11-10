// GitHub-hosted feeds (SPEC §8.3): the three repositories collect and the backfill read, `git ls-remote`
// output, raw URLs pinned to a commit and the CVE List release assets. Pure: URLs and names only. These
// are §8.3's "fixed patterns": collect fetches only URLs built here or written in the registry.

import { isValidDate } from "../dates";

/** The repositories read through git or raw.githubusercontent.com. */
export const REPOS = { cvelist: "CVEProject/cvelistV5", kev: "cisagov/kev-data", ghsa: "github/advisory-database" } as const;

/** A CVE List release asset: its tag, file name and download URL. */
export interface ReleaseAsset {
  tag: string;
  asset: string;
  url: string;
}

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HHMM_RE = /^(?:[01]\d|2[0-3])[0-5]\d$/;
const CVE_RE = /^CVE-(\d{4})-(\d{4,})$/;
const HOURLY_TAG_RE = /^cve_(\d{4}-\d{2}-\d{2})_((?:[01]\d|2[0-3])[0-5]\d)Z$/;
const RAW_HOST = "raw.githubusercontent.com";
const RELEASES = `https://github.com/${REPOS.cvelist}/releases/download`;

function checkSha(sha: string): string {
  if (!SHA_RE.test(sha)) throw new Error(`Not a commit SHA: ${JSON.stringify(sha)}`);
  return sha;
}

function checkDay(day: string): string {
  if (!isValidDate(day)) throw new Error(`Not a UTC day: ${JSON.stringify(day)}`);
  return day;
}

/**
 * `git ls-remote` stdout as ref → sha. A peeled line (`<sha>\trefs/tags/x^{}`, the commit an annotated tag
 * points at) replaces the tag object's sha under `refs/tags/x`. Blank and malformed lines are skipped.
 */
export function parseLsRemote(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    const [, sha, ref] = m;
    if (ref!.endsWith("^{}")) peeled.set(ref!.slice(0, -3), sha!);
    else out.set(ref!, sha!);
  }
  for (const [ref, sha] of peeled) out.set(ref, sha);
  return out;
}

/**
 * A registry raw.githubusercontent.com URL with its ref segment swapped for `sha` (§8.3's fixed pattern):
 * `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`, where <ref> is a branch, a tag, a sha or
 * `refs/heads/<branch>` (`refs/tags/<tag>`). Throws for any other URL.
 */
export function rawAtCommit(url: string, sha: string): string {
  checkSha(sha);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not a raw GitHub URL: ${url}`);
  }
  const parts = u.pathname.split("/").filter((p) => p !== "");
  if (u.protocol !== "https:" || u.hostname !== RAW_HOST || parts.length < 4) throw new Error(`Not a raw GitHub URL: ${url}`);
  const refLength = parts[2] === "refs" && (parts[3] === "heads" || parts[3] === "tags") ? 3 : 1;
  const rest = parts.slice(2 + refLength);
  if (rest.length === 0) throw new Error(`No file path in raw GitHub URL: ${url}`);
  return `https://${RAW_HOST}/${parts[0]}/${parts[1]}/${sha}/${rest.join("/")}`;
}

/** The raw URL of one CVE record at a commit: cves/<year>/<n div 1000>xxx/<id>.json (CVE-2026-0842 → 2026/0xxx). */
export function cveRecordRawUrl(sha: string, cveId: string): string {
  checkSha(sha);
  const id = cveId.toUpperCase();
  const m = CVE_RE.exec(id);
  if (!m) throw new Error(`Not a CVE id: ${JSON.stringify(cveId)}`);
  const bucket = `${Math.floor(Number(m[2]) / 1000)}xxx`;
  return `https://${RAW_HOST}/${REPOS.cvelist}/${sha}/cves/${m[1]}/${bucket}/${id}.json`;
}

/** UTC day X's end-of-day delta asset (tag cve_X_at_end_of_day, asset X_delta_CVEs_at_end_of_day.zip). */
export function endOfDayAsset(day: string): ReleaseAsset {
  checkDay(day);
  const tag = `cve_${day}_at_end_of_day`;
  const asset = `${day}_delta_CVEs_at_end_of_day.zip`;
  return { tag, asset, url: `${RELEASES}/${tag}/${asset}` };
}

/** UTC day T's hourly delta asset at HHMM (tag cve_T_HHMMZ, asset T_delta_CVEs_at_HHMMZ.zip). */
export function hourlyAsset(day: string, hhmm: string): ReleaseAsset {
  checkDay(day);
  if (!HHMM_RE.test(hhmm)) throw new Error(`Not an HHMM time: ${JSON.stringify(hhmm)}`);
  const tag = `cve_${day}_${hhmm}Z`;
  const asset = `${day}_delta_CVEs_at_${hhmm}Z.zip`;
  return { tag, asset, url: `${RELEASES}/${tag}/${asset}` };
}

/** The tag name of a ref (`refs/tags/x` or `refs/tags/x^{}` → x), else the ref as given. */
const tagName = (ref: string) => ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");

/** The newest hourly tag of `day` among `refs` (from parseLsRemote(); `refs/tags/…` keys or bare tag names), or null. */
export function newestHourlyTag(refs: ReadonlyMap<string, string>, day: string): string | null {
  checkDay(day);
  let best: string | null = null;
  for (const ref of refs.keys()) {
    const tag = tagName(ref);
    const m = HOURLY_TAG_RE.exec(tag);
    if (!m || m[1] !== day) continue;
    if (best === null || tag > best) best = tag;
  }
  return best;
}

/** A tag's instant: "cve_2026-10-13_2000Z" gives "2026-10-13T20:00:00Z"; null for anything else (an end-of-day tag included). */
export function tagTime(tag: string): string | null {
  const m = HOURLY_TAG_RE.exec(tag);
  if (!m || !isValidDate(m[1]!)) return null;
  return `${m[1]}T${m[2]!.slice(0, 2)}:${m[2]!.slice(2)}:00Z`;
}
