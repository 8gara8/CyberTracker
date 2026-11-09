// GitHub-hosted feeds (SPEC §8.3): the three repositories collect and the backfill read, `git ls-remote`
// output, raw URLs pinned to a commit and the CVE List release assets. Pure: URLs and names only.
// P2 WP1 fills these stubs (S0 contract).

/** The repositories read through git or raw.githubusercontent.com. */
export const REPOS = { cvelist: "CVEProject/cvelistV5", kev: "cisagov/kev-data", ghsa: "github/advisory-database" } as const;

/** A CVE List release asset: its tag, file name and download URL. */
export interface ReleaseAsset {
  tag: string;
  asset: string;
  url: string;
}

/** `git ls-remote` stdout as ref → sha. */
export function parseLsRemote(stdout: string): Map<string, string> {
  throw new Error("not implemented: parseLsRemote");
}

/** A registry raw.githubusercontent.com URL with its ref segment swapped for `sha` (§8.3's fixed pattern). */
export function rawAtCommit(url: string, sha: string): string {
  throw new Error("not implemented: rawAtCommit");
}

/** The raw URL of one CVE record at a commit: cves/<year>/<n div 1000>xxx/<id>.json. */
export function cveRecordRawUrl(sha: string, cveId: string): string {
  throw new Error("not implemented: cveRecordRawUrl");
}

/** UTC day X's end-of-day delta asset (tag cve_X_at_end_of_day). */
export function endOfDayAsset(day: string): ReleaseAsset {
  throw new Error("not implemented: endOfDayAsset");
}

/** UTC day T's hourly delta asset at HHMM (tag cve_T_HHMMZ). */
export function hourlyAsset(day: string, hhmm: string): ReleaseAsset {
  throw new Error("not implemented: hourlyAsset");
}

/** The newest hourly tag of `day` among `refs` (from parseLsRemote()), or null. */
export function newestHourlyTag(refs: ReadonlyMap<string, string>, day: string): string | null {
  throw new Error("not implemented: newestHourlyTag");
}

/** A tag's instant: "cve_2026-10-13_2000Z" gives "2026-10-13T20:00:00Z"; null for anything else. */
export function tagTime(tag: string): string | null {
  throw new Error("not implemented: tagTime");
}
