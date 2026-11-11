// scripts/screenshots.mjs (SPEC §9.9 item 6, §10 P4 item 3): the argument parsing, the setup messages when
// playwright-core or Chrome is missing, and one run against a fake playwright-core written into a temporary
// folder (no browser in tests). The script runs as a child process with NODE_PATH and HOME cleared, so
// only the package given resolves.
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = path.join(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "screenshots.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ct-shots-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

interface Parsed {
  help: boolean;
  base?: URL;
  out?: string;
  wait?: number;
  playwright?: string;
  channel?: string | null;
}
interface ScreenshotsModule {
  TOOLS_PACKAGE: string;
  SETUP_STEP: string;
  PAGES: { name: string; path: string }[];
  WIDTHS: number[];
  SCALE: number;
  DEFAULT_WAIT_SECONDS: number;
  USAGE: string;
  parseArgs(argv: readonly string[]): Parsed;
  setupHint(pkg?: string): string;
}

let mod: ScreenshotsModule;
beforeAll(async () => {
  // A computed specifier: the .mjs has no type declarations, so the interface above types it.
  mod = (await import(pathToFileURL(SCRIPT).href)) as ScreenshotsModule;
});

const run = promisify(execFile);
async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, NODE_PATH: "", HOME: TMP };
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], { cwd: TMP, env, timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, stdout: x.stdout, stderr: x.stderr };
  }
}

/** A fake playwright-core under <dir>/node_modules that logs every call to <dir>/calls.json. */
function fakePlaywright(name: string, opts: { launchError?: string } = {}): string {
  const dir = path.join(TMP, name);
  const pkgDir = path.join(dir, "node_modules", "playwright-core");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "tools", private: true }));
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "playwright-core", version: "0.0.0-fake", main: "index.js" }));
  const log = path.join(dir, "calls.json");
  fs.writeFileSync(
    path.join(pkgDir, "index.js"),
    `const fs = require("node:fs");
const LOG = ${JSON.stringify(log)};
const calls = [];
const save = (c) => { calls.push(c); fs.writeFileSync(LOG, JSON.stringify(calls)); };
const LAUNCH_ERROR = ${JSON.stringify(opts.launchError ?? null)};
exports.chromium = {
  async launch(o) {
    save({ launch: o });
    if (LAUNCH_ERROR) throw new Error(LAUNCH_ERROR);
    return {
      async newContext(c) {
        save({ context: c });
        let handler = null;
        return {
          async route(pattern, h) { handler = h; save({ route: pattern }); },
          async newPage() {
            return {
              on() {},
              async goto(url) {
                for (const u of [url, "https://fonts.example.net/a.woff2"]) {
                  await handler({ request: () => ({ url: () => u }), continue: async () => save({ allowed: u }), abort: async () => save({ aborted: u }) });
                }
                save({ goto: url });
                return { status: () => (url.endsWith("/archive") && process.env.FAKE_404 ? 404 : 200) };
              },
              async evaluate() { return true; },
              async screenshot(s) { save({ shot: s }); fs.writeFileSync(s.path, "png"); },
            };
          },
          async close() {},
        };
      },
      async close() { save({ closed: true }); },
    };
  },
};
`,
  );
  return path.join(dir, "package.json");
}

const calls = (pkg: string) => JSON.parse(fs.readFileSync(path.join(path.dirname(pkg), "calls.json"), "utf8")) as Record<string, unknown>[];

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("arguments", () => {
  it("the pages, widths and scale of §10 P4 item 3 and the tools package of §9.9 item 6", () => {
    expect(mod.PAGES).toEqual([
      { name: "index", path: "/" },
      { name: "brief-2026-10-14", path: "/brief/2026-10-14" },
      { name: "archive", path: "/archive" },
      { name: "methodology", path: "/methodology" },
    ]);
    expect(mod.WIDTHS).toEqual([375, 1280]);
    expect(mod.SCALE).toBe(2);
    expect(mod.TOOLS_PACKAGE).toBe("/Users/kobol/.cybertracker/tools/package.json");
    expect(mod.SETUP_STEP).toBe("SPEC §9.9 item 6");
  });

  it("parses --base, --out and the defaults", () => {
    const p = mod.parseArgs(["--base", "http://localhost:3000", "--out", "docs/screenshots/p4/paper"]);
    expect(p.help).toBe(false);
    expect(p.base!.origin).toBe("http://localhost:3000");
    expect(p.out).toBe(path.resolve("docs/screenshots/p4/paper"));
    expect(p.wait).toBe(mod.DEFAULT_WAIT_SECONDS);
    expect(p.playwright).toBe(mod.TOOLS_PACKAGE);
    expect(p.channel).toBe("chrome");
    const q = mod.parseArgs(["--base=http://127.0.0.1:3000/", "--out=x", "--wait", "5", "--playwright", "/opt/tools/package.json", "--channel", "none"]);
    expect([q.base!.href, q.wait, q.playwright, q.channel]).toEqual(["http://127.0.0.1:3000/", 5, "/opt/tools/package.json", null]);
    expect(mod.parseArgs(["--out", "x", "--help"]).help).toBe(true);
  });

  it("refuses a missing, malformed or non-origin --base, a missing --out and unknown arguments", () => {
    const bad: [string[], RegExp][] = [
      [["--out", "x"], /--base is required/],
      [["--base", "http://localhost:3000"], /--out is required/],
      [["--base", "localhost:3000", "--out", "x"], /must be http or https/],
      [["--base", "not a url", "--out", "x"], /is not a URL/],
      [["--base", "file:///tmp", "--out", "x"], /must be http or https/],
      [["--base", "http://localhost:3000/brief", "--out", "x"], /must be an origin/],
      [["--base", "http://user:pw@localhost:3000", "--out", "x"], /must be an origin/],
      [["--base", "http://localhost:3000/?a=1", "--out", "x"], /must be an origin/],
      [["--base", "--out", "x"], /--base needs a value/],
      [["--base", "http://localhost:3000", "--out", "x", "--wait", "0"], /--wait must be/],
      [["--base", "http://localhost:3000", "--out", "x", "--base", "http://localhost:3001"], /given twice/],
      [["--base", "http://localhost:3000", "--out", "x", "--look", "night"], /unknown argument --look/],
    ];
    for (const [argv, re] of bad) expect(() => mod.parseArgs(argv), argv.join(" ")).toThrow(re);
  });

  it("the CLI prints the usage for --help (exit 0) and for a usage error (exit 2)", async () => {
    const help = await cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: node scripts/screenshots.mjs --base URL --out DIR");
    const bad = await cli(["--out", "x"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/^screenshots: --base is required\n/);
  });
});

describe("setup messages", () => {
  it("no tools folder: exit 1 naming playwright-core and the setup step", async () => {
    // A folder that never exists, never the default: on Kobol the §9.9 item 6 install puts playwright-core there.
    const dir = path.join(TMP, "no-tools");
    const r = await cli(["--base", base, "--out", path.join(TMP, "none"), "--playwright", path.join(dir, "package.json")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`playwright-core is not installed: there is no ${dir}.`);
    expect(r.stderr).toContain(`One-time setup, SPEC §9.9 item 6: /opt/homebrew/bin/npm install --prefix ${dir} playwright-core@<version>`);
    // The default path's wording, checked without touching the machine's real tools folder.
    expect(mod.setupHint()).toContain("One-time setup, SPEC §9.9 item 6: /opt/homebrew/bin/npm install --prefix /Users/kobol/.cybertracker/tools playwright-core@<version>");
    expect(fs.existsSync(path.join(TMP, "none"))).toBe(false);
  });

  it("a tools folder without the package: exit 1 naming the folder and the step", async () => {
    const dir = path.join(TMP, "empty-tools");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const r = await cli(["--base", base, "--out", path.join(TMP, "none"), "--playwright", path.join(dir, "package.json")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`cannot load playwright-core from ${dir} (not found).`);
    expect(r.stderr).toContain(`SPEC §9.9 item 6: /opt/homebrew/bin/npm install --prefix ${dir} playwright-core@<version>`);
  });

  it("Chrome missing: exit 1 naming Google Chrome and the step", async () => {
    const pkg = fakePlaywright("no-chrome", { launchError: "browserType.launch: Chromium distribution 'chrome' is not found at /Applications/Google Chrome.app\nRun \"npx playwright install chrome\"" });
    const r = await cli(["--base", base, "--out", path.join(TMP, "none"), "--playwright", pkg]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`playwright-core could not start Google Chrome (channel "chrome"): browserType.launch: Chromium distribution 'chrome' is not found`);
    expect(r.stderr).toContain("One-time setup, SPEC §9.9 item 6");
    expect(r.stderr).not.toContain("npx playwright install");
    expect(calls(pkg)).toEqual([{ launch: { channel: "chrome", headless: true } }]);
  });
});

describe("a run on a fake playwright-core", () => {
  it("waits for --base, then writes <page>-<width>.png at both widths, 2x, reaching only --base", async () => {
    const pkg = fakePlaywright("ok");
    const out = path.join(TMP, "shots", "paper");
    const r = await cli(["--base", base, "--out", out, "--playwright", pkg]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const names = mod.WIDTHS.flatMap((w) => mod.PAGES.map((p) => `${p.name}-${w}.png`));
    expect(fs.readdirSync(out).sort()).toEqual([...names].sort());
    expect(r.stdout).toContain(`screenshots: 8 screenshots in ${out}`);
    expect(r.stdout).toContain(`screenshots: blocked requests to https://fonts.example.net (only ${base} is allowed)`);
    const log = calls(pkg);
    expect(log[0]).toEqual({ launch: { channel: "chrome", headless: true } });
    const contexts = log.filter((c) => "context" in c).map((c) => c.context as { viewport: { width: number }; deviceScaleFactor: number; isMobile: boolean });
    expect(contexts.map((c) => [c.viewport.width, c.deviceScaleFactor, c.isMobile])).toEqual([[375, 2, true], [1280, 2, false]]);
    expect(log.filter((c) => "goto" in c).map((c) => c.goto)).toEqual(mod.WIDTHS.flatMap(() => mod.PAGES.map((p) => new URL(p.path, base).href)));
    expect(log.filter((c) => "aborted" in c).every((c) => c.aborted === "https://fonts.example.net/a.woff2")).toBe(true);
    expect(log.filter((c) => "allowed" in c).every((c) => String(c.allowed).startsWith(`${base}/`))).toBe(true);
    for (const c of log.filter((x) => "shot" in x)) expect(c.shot).toMatchObject({ fullPage: true });
    expect(log.at(-1)).toEqual({ closed: true });
  });

  it("--channel none launches without a channel", async () => {
    const pkg = fakePlaywright("bundled");
    const r = await cli(["--base", base, "--out", path.join(TMP, "shots", "bundled"), "--playwright", pkg, "--channel", "none"]);
    expect(r.code).toBe(0);
    expect(calls(pkg)[0]).toEqual({ launch: { headless: true } });
  });

  it("a page that does not answer 200 fails the run (exit 1)", async () => {
    const pkg = fakePlaywright("404");
    const out = path.join(TMP, "shots", "404");
    const env = { ...process.env, NODE_PATH: "", HOME: TMP, FAKE_404: "1" };
    let code = 0;
    let stderr = "";
    try {
      await run(process.execPath, [SCRIPT, "--base", base, "--out", out, "--playwright", pkg], { cwd: TMP, env, timeout: 30_000 });
    } catch (e) {
      code = (e as { code: number }).code;
      stderr = (e as { stderr: string }).stderr;
    }
    expect(code).toBe(1);
    expect(stderr).toContain("screenshots: /archive answered 404 at 375 px, not 200");
    expect(calls(pkg).at(-1)).toEqual({ closed: true });
  });

  it("a --base that never answers 200 fails after --wait (exit 1), before the browser starts", async () => {
    const pkg = fakePlaywright("down");
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const r = await cli(["--base", `http://127.0.0.1:${port}`, "--out", path.join(TMP, "shots", "down"), "--playwright", pkg, "--wait", "1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(new RegExp(`http://127\\.0\\.0\\.1:${port}/ did not answer 200 within 1 s \\(last: ECONNREFUSED\\)`));
    expect(fs.existsSync(path.join(path.dirname(pkg), "calls.json"))).toBe(false);
  });
});
