// Git, the one non-HTTP way collect reaches the network (ruling R39): `git ls-remote` for tags and
// commits, and the sparse checkout of github/advisory-database. With CT_FIXTURE_FEEDS set, fixtureGit()
// answers both from fixtures/feeds/. P2 WP2 fills these stubs (S0 contract).

export interface GitSource {
  /** ref → sha for the patterns, or null on any failure (30 s). */
  lsRemote(repo: string, patterns: readonly string[]): Promise<Map<string, string> | null>;
  /** Checks out the months' advisories under `dir` (120 s); null on any failure. */
  syncGhsa(dir: string, months: readonly string[]): Promise<{ commit: string; headDate: string; treeSha256: string } | null>;
}

/** The live runner, through scripts/lib/run.ts. */
export function liveGit(root: string): GitSource {
  throw new Error("not implemented: liveGit");
}

/** Answers from fixtures/feeds/git-refs.json and fixtures/feeds/ghsa/repo. */
export function fixtureGit(feedsDir: string): GitSource {
  throw new Error("not implemented: fixtureGit");
}
