// Git, the one non-HTTP way collect reaches the network (ruling R39): `git ls-remote` for tags and
// commits, and the sparse checkout of github/advisory-database. With CT_FIXTURE_FEEDS set, fixtureGit()
// answers both from fixtures/feeds/. Every command runs through scripts/lib/run.ts with a hard timeout and
// GIT_TERMINAL_PROMPT=0, so an unattended run never waits on a prompt; any failure is null, never a throw.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { utcDateOf } from "../../lib/dates";
import { parseLsRemote } from "../../lib/feeds/github";
import { byCodeUnit } from "../../lib/ids";
import { sha256Hex } from "../../lib/json";
import { run } from "./run";

export interface GitSource {
  /** ref → sha for the patterns, or null on any failure (30 s). */
  lsRemote(repo: string, patterns: readonly string[]): Promise<Map<string, string> | null>;
  /** Checks out the months' advisories under `dir` (120 s); null on any failure. */
  syncGhsa(dir: string, months: readonly string[]): Promise<{ commit: string; headDate: string; treeSha256: string } | null>;
}

export const LS_REMOTE_TIMEOUT_MS = 30_000;
export const GHSA_SYNC_TIMEOUT_MS = 120_000;
const GHSA_REPO = "github/advisory-database";
const MONTH_RE = /^\d{4}\/\d{2}$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** The sparse paths of the months ("2026/10" → advisories/github-reviewed/2026/10). */
export const ghsaMonthPaths = (months: readonly string[]) => months.map((m) => {
  if (!MONTH_RE.test(m)) throw new Error(`Not a GHSA month: ${JSON.stringify(m)}`);
  return `advisories/github-reviewed/${m}`;
});

/** SHA-256 of the sorted "<path> <blob oid>\n" lines (CollectInputsFile.ghsa.tree_sha256). */
export function treeSha256(rows: readonly { path: string; oid: string }[]): string {
  return sha256Hex([...rows].sort((a, b) => byCodeUnit(a.path, b.path)).map((r) => `${r.path} ${r.oid}\n`).join(""));
}

/** Git's blob id of a file's bytes (sha1 of "blob <size>\0" + bytes), as `git ls-tree` prints it. */
export function blobOid(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** "*" in a ls-remote pattern matches any run of characters; a pattern matches a ref equal to it or ending in "/<pattern>". */
function patternMatches(ref: string, pattern: string): boolean {
  const re = new RegExp(`(?:^|/)${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(ref);
}

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", LC_ALL: "C" });

/** The live runner, through scripts/lib/run.ts. */
export function liveGit(root: string): GitSource {
  const git = async (args: string[], cwd: string, timeoutMs: number) => {
    if (timeoutMs <= 0) return null;
    const r = await run("git", args, { cwd, timeoutMs, env: gitEnv(), killGraceMs: 2_000 });
    return r.code === 0 && !r.timedOut ? r.stdout : null;
  };
  return {
    async lsRemote(repo, patterns) {
      if (!REPO_RE.test(repo)) return null;
      const out = await git(["ls-remote", `https://github.com/${repo}.git`, ...patterns], root, LS_REMOTE_TIMEOUT_MS);
      return out === null ? null : parseLsRemote(out);
    },
    async syncGhsa(dir, months) {
      const deadline = Date.now() + GHSA_SYNC_TIMEOUT_MS;
      const left = () => deadline - Date.now();
      const paths = ghsaMonthPaths(months);
      try {
        if (!fs.existsSync(path.join(dir, ".git"))) {
          fs.rmSync(dir, { recursive: true, force: true });
          fs.mkdirSync(path.dirname(dir), { recursive: true });
          if (await git(["clone", "--depth", "1", "--filter=blob:none", "--sparse", `https://github.com/${GHSA_REPO}.git`, dir], root, left()) === null) return null;
        } else {
          if (await git(["fetch", "--depth", "1", "origin", "main"], dir, left()) === null) return null;
          if (await git(["reset", "--hard", "FETCH_HEAD"], dir, left()) === null) return null;
        }
        if (await git(["sparse-checkout", "set", ...paths], dir, left()) === null) return null;
        const commit = (await git(["rev-parse", "HEAD"], dir, left()))?.trim();
        const when = (await git(["log", "-1", "--format=%cI"], dir, left()))?.trim();
        const tree = await git(["ls-tree", "-r", "HEAD", "--", ...paths], dir, left());
        if (!commit || !when || tree === null) return null;
        const rows = tree.split("\n").flatMap((line) => {
          const m = /^\d+ blob ([0-9a-f]{40,64})\t(.+)$/.exec(line);
          return m ? [{ path: m[2]!, oid: m[1]! }] : [];
        });
        return { commit, headDate: utcDateOf(when), treeSha256: treeSha256(rows) };
      } catch {
        return null;
      }
    },
  };
}

/** fixtures/feeds/git-refs.json: per repo, its refs (or null for a repo whose ls-remote fails), and the GHSA head. */
interface GitRefsFile {
  repos: Record<string, Record<string, string> | null>;
  ghsa: { commit: string; head_date: string } | null;
}

/** Answers from fixtures/feeds/git-refs.json and fixtures/feeds/ghsa/repo (the months' folders are copied into `dir`). */
export function fixtureGit(feedsDir: string): GitSource {
  const read = (): GitRefsFile => JSON.parse(fs.readFileSync(path.join(feedsDir, "git-refs.json"), "utf8")) as GitRefsFile;
  return {
    async lsRemote(repo, patterns) {
      const refs = read().repos[repo];
      if (!refs) return null;
      return new Map(Object.entries(refs).filter(([ref]) => patterns.some((p) => patternMatches(ref, p))).sort(([a], [b]) => byCodeUnit(a, b)));
    },
    async syncGhsa(dir, months) {
      const head = read().ghsa;
      if (!head) return null;
      const src = path.join(feedsDir, "ghsa", "repo");
      fs.rmSync(dir, { recursive: true, force: true });
      const rows: { path: string; oid: string }[] = [];
      for (const rel of ghsaMonthPaths(months)) {
        const from = path.join(src, rel);
        if (!fs.existsSync(from)) continue;
        fs.cpSync(from, path.join(dir, rel), { recursive: true });
        const walk = (d: string): void => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else rows.push({ path: path.relative(dir, p).split(path.sep).join("/"), oid: blobOid(fs.readFileSync(p)) });
          }
        };
        walk(path.join(dir, rel));
      }
      return { commit: head.commit, headDate: head.head_date, treeSha256: treeSha256(rows) };
    },
  };
}
