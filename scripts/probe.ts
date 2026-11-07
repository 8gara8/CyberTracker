// npm run probe -- --fired [--hold-minutes N] [--out DIR] [--branch ops/...]: P0's reachability and
// trust-boundary probe (SPEC §9.3, §9.4, §9.6), run through `ops: probe` in a fired session of the ops
// task, because only a fired session has the morning run's attachments and network.
//
// It records machine facts, which repositories this session can write, that a push and an API write to
// the code repo are refused, that the content repo accepts a push, what a pushed workflow file does,
// and a reachability table of every host the run needs. Then it holds for N minutes, so the report shows
// whether a background command outlives the turn. Before the hold it pushes an interim copy of the
// report to --branch; ops.ts pushes the final one.
//
// The report is public (it lands on an ops/ branch of the content repo), so it holds status codes,
// error classes and fixed phrases only: never raw error text, environment values or tokens.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { taipeiTimestamp } from "../lib/dates";
import { fetchFeed, type FetchResult } from "../lib/feeds/http";
import { publishOps } from "./publish";

const repo = process.cwd();

interface RunJson { repos: { code: string; content: string; code_clone_url: string; content_clone_url: string } }

export interface ProbeTarget { label: string; url: string; group: "registry" | "fallback" | "extra" }

/** The 20 hosts of the Custom fallback list (SPEC §9.3), in order. */
export const FALLBACK_HOSTS = [
  "raw.githubusercontent.com", "www.cisa.gov", "api.first.org", "www.twcert.org.tw", "www.jpcert.or.jp", "jvndb.jvn.jp",
  "red.anthropic.com", "msrc.microsoft.com", "www.ncsc.gov.uk", "therecord.media", "www.bleepingcomputer.com",
  "www.securityweek.com", "epss.empiricalsecurity.com", "release-assets.githubusercontent.com", "focustaiwan.tw",
  "www.taipeitimes.com", "www.cna.com.tw", "www.ithome.com.tw", "www.security-next.com", "cybertracker.vercel.app",
] as const;

/** Extra checks SPEC §9.3 and §10 P0 name beyond the registry and the fallback list. */
export const EXTRA_TARGETS: ProbeTarget[] = [
  { label: "nvd", url: "https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=1", group: "extra" },
  { label: "krebs", url: "https://krebsonsecurity.com/", group: "extra" },
  { label: "techcrunch", url: "https://techcrunch.com/", group: "extra" },
  { label: "github advisories api", url: "https://api.github.com/advisories?per_page=1", group: "extra" },
  { label: "npm registry", url: "https://registry.npmjs.org/", group: "extra" },
  { label: "epss csv (cyentia)", url: "https://epss.cyentia.com/epss_scores-current.csv.gz", group: "extra" },
  { label: "nhk", url: "https://www3.nhk.or.jp/", group: "extra" },
  { label: "qnap (off-list vendor)", url: "https://www.qnap.com/en/security-advisories", group: "extra" },
  { label: "content repo issues api", url: "https://api.github.com/repos/8gara8/CyberTracker-content/issues?state=all&labels=correction&per_page=1", group: "extra" },
];

export function targets(registryYaml: string): ProbeTarget[] {
  const reg = YAML.parse(registryYaml) as { feeds: { id: string; kind: string; url?: string; fallback_url?: string }[] };
  const out: ProbeTarget[] = [];
  for (const f of reg.feeds) {
    if (f.kind === "search" || !f.url) continue;
    out.push({ label: f.id, url: f.url, group: "registry" });
    if (f.fallback_url) out.push({ label: `${f.id} (fallback)`, url: f.fallback_url, group: "registry" });
  }
  for (const h of FALLBACK_HOSTS) out.push({ label: h, url: `https://${h}/`, group: "fallback" });
  out.push(...EXTRA_TARGETS);
  return out;
}

/** A host answered when any HTTP status came back; an error class means the request never got one. */
export function reachable(r: Pick<FetchResult, "status" | "error">): boolean {
  return r.status !== null;
}

/** Reduces git or gh stderr to a fixed phrase, so no raw text reaches the public report. */
export function refusalClass(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes("not enabled for this session")) return "not enabled for this session";
  if (/\b403\b|forbidden/.test(s)) return "403 forbidden";
  if (/\b404\b|not found/.test(s)) return "404 not found";
  if (s.includes("permission") || s.includes("denied")) return "permission denied";
  if (s.includes("protected") || s.includes("rule")) return "rejected by a rule";
  if (s.includes("could not read username") || s.includes("authentication")) return "no credential";
  if (s.includes("timed out") || s.includes("timeout")) return "timeout";
  return stderr.trim() ? "refused (other)" : "no error text";
}

function cmd(file: string, args: string[], cwd = repo): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return { code: 0, out, err: "" };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return { code: x.status ?? 1, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
}

function machineFacts(): string[] {
  const v = (file: string, args: string[]) => cmd(file, args).out.trim().split("\n")[0] ?? "?";
  const df = cmd("df", ["-Pk", os.tmpdir()]).out.trim().split("\n")[1]?.split(/\s+/);
  const freeGb = df ? (Number(df[3]) / 1024 / 1024).toFixed(1) : "?";
  return [
    `| Node | ${process.version} |`,
    `| npm | ${v("npm", ["--version"])} |`,
    `| Claude CLI | ${v(process.env.CT_CLAUDE_BIN || "claude", ["--version"])} |`,
    `| git | ${v("git", ["--version"]).replace("git version ", "")} |`,
    `| gh | ${v("gh", ["--version"]).replace(/^gh version /, "").split(" ")[0]} |`,
    `| CPUs, memory | ${os.cpus().length} vCPU, ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB |`,
    `| Free disk (${os.tmpdir()}) | ${freeGb} GB |`,
    `| Platform | ${os.platform()} ${os.arch()} |`,
    `| TZ set | ${process.env.TZ ? "yes" : "no"} · machine offset ${-new Date().getTimezoneOffset()} min |`,
  ];
}

function apiCheck(label: string, args: string[], expect: string): string {
  const r = cmd("gh", ["api", ...args]);
  const found = r.code === 0 ? `ok: ${r.out.trim().slice(0, 40) || "(empty)"}` : `refused: ${refusalClass(r.err)}`;
  return `| ${label} | ${expect} | ${found} |`;
}

/** Push tests (SPEC §9.6 item 2). Returns table rows; never throws. */
function pushTests(cfg: RunJson, branch: string | null): string[] {
  const rows: string[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-probe-"));
  try {
    // 1. A real push of an empty commit to the code repo: must be refused.
    const code = path.join(tmp, "code");
    const clone = cmd("git", ["clone", "-q", "--depth", "1", cfg.repos.code_clone_url, code], tmp);
    if (clone.code !== 0) rows.push(`| Code repo: anonymous clone | works | failed: ${refusalClass(clone.err)} |`);
    else {
      cmd("git", ["-c", "user.name=CyberTracker probe", "-c", "user.email=probe@invalid", "commit", "-q", "--allow-empty", "-m", "p0 push probe"], code);
      const push = cmd("git", ["push", "origin", "HEAD:refs/heads/p0-push-probe"], code);
      rows.push(`| Code repo: git push to p0-push-probe | refused | ${push.code === 0 ? "ACCEPTED (branch created; delete it)" : `refused: ${refusalClass(push.err)}`} |`);
    }
    // 2. A REST write to the code repo: must be refused.
    const blob = cmd("gh", ["api", "-X", "POST", `repos/${cfg.repos.code}/git/blobs`, "-f", "content=probe", "-f", "encoding=utf-8"]);
    rows.push(`| Code repo: REST POST git/blobs | refused | ${blob.code === 0 ? "ACCEPTED (a dangling blob)" : `refused: ${refusalClass(blob.err)}`} |`);
    // 3. Read the code repo's permissions.
    rows.push(apiCheck("Code repo: GET repo, permissions.push", [`repos/${cfg.repos.code}`, "--jq", ".permissions.push"], "refused, or false"));
    rows.push(apiCheck("Content repo: GET repo, permissions.push", [`repos/${cfg.repos.content}`, "--jq", ".permissions.push"], "true"));
    // 4. A dry-run push to the content repo: must be accepted (the real push is the report itself).
    const content = path.join(tmp, "content");
    fs.mkdirSync(content);
    cmd("git", ["init", "-q"], content);
    cmd("git", ["remote", "add", "origin", cfg.repos.content_clone_url], content);
    cmd("git", ["-c", "user.name=CyberTracker probe", "-c", "user.email=probe@invalid", "commit", "-q", "--allow-empty", "-m", "dry run"], content);
    const dry = cmd("git", ["push", "--dry-run", "origin", `HEAD:refs/heads/${branch ?? "ops/probe-dry-run"}`], content);
    rows.push(`| Content repo: git push --dry-run | accepted | ${dry.code === 0 ? "accepted" : `refused: ${refusalClass(dry.err)}`} |`);
    // 5. The workflow-file test (SPEC §9.6 item 3): push ops/p0-workflow-probe holding a harmless workflow.
    const wf = path.join(tmp, "wf");
    fs.mkdirSync(path.join(wf, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(wf, ".github", "workflows", "probe.yml"), [
      "name: probe", "on:", "  push:", "    branches: ['ops/p0-workflow-probe']", "permissions: {}", "jobs:", "  probe:",
      "    runs-on: ubuntu-latest", "    timeout-minutes: 2", "    steps:", "      - run: echo ok", "",
    ].join("\n"));
    cmd("git", ["init", "-q"], wf);
    cmd("git", ["remote", "add", "origin", cfg.repos.content_clone_url], wf);
    cmd("git", ["checkout", "-q", "--orphan", "probe"], wf);
    cmd("git", ["add", "."], wf);
    cmd("git", ["-c", "user.name=CyberTracker probe", "-c", "user.email=probe@invalid", "commit", "-q", "-m", "ops: workflow-probe"], wf);
    const wfPush = cmd("git", ["push", "origin", "HEAD:refs/heads/ops/p0-workflow-probe"], wf);
    rows.push(`| Content repo: push a workflow file (ops/p0-workflow-probe) | either; recorded | ${wfPush.code === 0 ? "accepted (check the Actions tab for its run)" : `refused: ${refusalClass(wfPush.err)}`} |`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return rows;
}

async function reachability(list: ProbeTarget[]): Promise<string[]> {
  const rows: string[] = [];
  const results = await Promise.all(list.map(async (t) => ({ t, r: await fetchFeed(t.url, { timeoutMs: 20_000, maxBytes: 25 * 1024 * 1024, retryDelayMs: 0 }) })));
  for (const { t, r } of results) {
    const host = (() => { try { return new URL(t.url).hostname; } catch { return t.url; } })();
    rows.push(`| ${t.group} | ${t.label} | ${host} | ${reachable(r) ? "yes" : "NO"} | ${r.status ?? "-"} | ${r.error ?? "-"} | ${r.body ? r.body.length : 0} | ${r.durationMs} |`);
  }
  return rows;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { fired: { type: "boolean" }, "hold-minutes": { type: "string" }, out: { type: "string" }, branch: { type: "string" }, "no-push-tests": { type: "boolean" } } });
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, "config", "run.json"), "utf8")) as RunJson;
  const out = path.resolve(values.out ?? path.join(repo, "logs", "probe"));
  fs.mkdirSync(out, { recursive: true });
  const reportFile = path.join(out, "report.md");
  const hold = Math.max(0, Number(values["hold-minutes"] ?? "0"));
  const started = taipeiTimestamp();

  const lines: string[] = [`# P0 probe ${started.slice(0, 16).replace("T", " ")} Taipei`, "", `Mode: ${values.fired ? "fired session" : "coding session"} · hold ${hold} min`, ""];
  lines.push("## Machine", "", "| Fact | Value |", "|---|---|", ...machineFacts(), "");
  lines.push("## Repositories and push denial", "", "| Check | Must be | Found |", "|---|---|---|");
  lines.push(...(values["no-push-tests"] ? ["| (skipped with --no-push-tests) | | |"] : pushTests(cfg, values.branch ?? null)));
  lines.push(apiCheck("GitHub /advisories through gh", ["advisories?per_page=1", "--jq", "length"], "recorded (403 expected)"));
  lines.push(apiCheck("Content repo issues through gh", [`repos/${cfg.repos.content}/issues?state=all&per_page=1`, "--jq", "length"], "ok"), "");
  const list = targets(fs.readFileSync(path.join(repo, "config", "sources.yaml"), "utf8"));
  lines.push("## Reachability", "", "A host is reachable when any HTTP status came back.", "", "| Group | Target | Host | Reachable | HTTP | Error | Bytes | ms |", "|---|---|---|---|---|---|---|---|");
  lines.push(...(await reachability(list)), "");
  fs.writeFileSync(reportFile, lines.join("\n") + "\n");

  if (hold > 0) {
    const holdStart = taipeiTimestamp();
    fs.appendFileSync(reportFile, `## Hold\n\nHold started ${holdStart} for ${hold} min.\n`);
    if (values.branch) {
      // An interim copy before the hold, so the checks survive even if the session stops during it.
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ct-probe-stage-"));
      const rel = path.relative(path.dirname(path.dirname(out)), out);
      fs.mkdirSync(path.join(stage, rel), { recursive: true });
      fs.copyFileSync(reportFile, path.join(stage, rel, "report.md"));
      await publishOps({ branch: values.branch, from: stage, command: "probe", remote: cfg.repos.content_clone_url }).then(
        (r) => fs.appendFileSync(reportFile, `Interim report pushed at ${r.sha.slice(0, 12)}.\n`),
        () => fs.appendFileSync(reportFile, "Interim push failed.\n"),
      );
      fs.rmSync(stage, { recursive: true, force: true });
    }
    await sleep(hold * 60_000);
    fs.appendFileSync(reportFile, `Hold ended ${taipeiTimestamp()}.\n`);
  }
  fs.appendFileSync(reportFile, `\nProbe ended ${taipeiTimestamp()}.\n`);
  process.stdout.write(fs.readFileSync(reportFile, "utf8"));
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) main().then((code) => { process.exitCode = code; }, (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
