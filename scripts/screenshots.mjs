// SPEC §9.9 item 6 and §10 P4 item 3: full-page screenshots of a running build of the site, for a PR's
// visual check (P4's side-by-side look pick used them; JL picked paper). playwright-core lives outside
// the repo, in /Users/kobol/.cybertracker/tools (nothing is added to the project's dependencies), and
// drives Kobol's installed Google Chrome. Node's ES module resolver ignores NODE_PATH, so the package is
// loaded with createRequire. Waits until --base answers 200, then shoots each page of PAGES at each width
// of WIDTHS, full page at deviceScaleFactor 2, into <out>/<page>-<width>.png. The browser reaches nothing
// but --base: every other request is aborted.
//
//   node scripts/screenshots.mjs --base http://localhost:3000 --out docs/screenshots/p4/paper
//
// Exit 0 every screenshot written, 1 playwright-core or Chrome missing, --base not answering 200 or a page
// failing, 2 a usage error.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOOLS_PACKAGE = "/Users/kobol/.cybertracker/tools/package.json";
export const MODULE = "playwright-core";
export const SETUP_STEP = "SPEC §9.9 item 6";

/** The pages shot, as <name>-<width>.png (§10 P4 item 3). */
export const PAGES = [
  { name: "index", path: "/" },
  { name: "brief-2026-10-14", path: "/brief/2026-10-14" },
  { name: "archive", path: "/archive" },
  { name: "methodology", path: "/methodology" },
];
export const WIDTHS = [375, 1280];
/** The viewport height at each width; the screenshots are full page, so it only sets the first screen. */
export const HEIGHTS = { 375: 812, 1280: 800 };
/** Device pixels per CSS pixel in the committed images. */
export const SCALE = 2;
export const DEFAULT_WAIT_SECONDS = 60;
export const PAGE_TIMEOUT_MS = 60_000;

export const USAGE = `Usage: node scripts/screenshots.mjs --base URL --out DIR [options]

  --base URL           the running site, an http or https origin such as http://localhost:3000;
                       the script waits until it answers 200 and lets the browser reach nothing else
  --out DIR            where <page>-<width>.png go (created if missing)
  --wait SECONDS       how long to wait for --base to answer 200 (default ${DEFAULT_WAIT_SECONDS})
  --playwright FILE    the package.json to load playwright-core from (default ${TOOLS_PACKAGE})
  --channel NAME       the browser channel to launch (default chrome, Kobol's Google Chrome);
                       none launches the browser playwright-core installed itself
  --help               this text

Pages: ${PAGES.map((p) => `${p.name} (${p.path})`).join(", ")}. Widths: ${WIDTHS.join(" and ")} px, full page, at ${SCALE}x.
Exit 0 written, 1 setup missing, site not answering or a page failing (not 200, or an uncaught page
error), 2 usage.`;

export class UsageError extends Error {}
export class SetupError extends Error {}

/**
 * @param {readonly string[]} argv
 * @returns {{ help: true } | { help: false; base: URL; out: string; wait: number; playwright: string; channel: string | null }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const got = {};
  const NAMES = new Set(["--base", "--out", "--wait", "--playwright", "--channel"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!NAMES.has(name)) throw new UsageError(`unknown argument ${a}`);
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) throw new UsageError(`${name} needs a value`);
    if (name in got) throw new UsageError(`${name} given twice`);
    got[name] = value;
  }
  if (!got["--base"]) throw new UsageError("--base is required");
  if (!got["--out"]) throw new UsageError("--out is required");
  let base;
  try {
    base = new URL(got["--base"]);
  } catch {
    throw new UsageError(`--base ${got["--base"]} is not a URL`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new UsageError(`--base must be http or https, not ${base.protocol}`);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new UsageError(`--base must be an origin such as http://localhost:3000, not ${got["--base"]}`);
  }
  const wait = got["--wait"] === undefined ? DEFAULT_WAIT_SECONDS : Number(got["--wait"]);
  if (!Number.isFinite(wait) || wait <= 0) throw new UsageError(`--wait must be a number of seconds above 0, not ${got["--wait"]}`);
  const playwright = path.resolve(got["--playwright"] ?? TOOLS_PACKAGE);
  const channelArg = got["--channel"] ?? "chrome";
  const channel = channelArg === "none" ? null : channelArg;
  return { help: false, base, out: path.resolve(got["--out"]), wait, playwright, channel };
}

/** The one-time setup line every setup message ends with. */
export function setupHint(pkg = TOOLS_PACKAGE) {
  const dir = path.dirname(pkg);
  return `One-time setup, ${SETUP_STEP}: /opt/homebrew/bin/npm install --prefix ${dir} ${MODULE}@<version> (the version in SPEC Appendix C), driving Kobol's Google Chrome; nothing goes into the project's dependencies.`;
}

/** playwright-core from beside `pkg`, or a SetupError naming the setup step. */
export function loadPlaywright(pkg = TOOLS_PACKAGE) {
  const dir = path.dirname(pkg);
  if (!fs.existsSync(dir)) throw new SetupError(`${MODULE} is not installed: there is no ${dir}. ${setupHint(pkg)}`);
  let mod;
  try {
    mod = createRequire(pkg)(MODULE);
  } catch (e) {
    const why = e && typeof e === "object" && "code" in e && e.code === "MODULE_NOT_FOUND" ? "not found" : String(e instanceof Error ? e.message : e).split("\n")[0];
    throw new SetupError(`cannot load ${MODULE} from ${dir} (${why}). ${setupHint(pkg)}`);
  }
  if (!mod || !mod.chromium || typeof mod.chromium.launch !== "function") throw new SetupError(`${MODULE} from ${dir} has no chromium.launch. ${setupHint(pkg)}`);
  return mod;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `base` until it answers 200; throws with the last answer after `seconds`. */
export async function waitFor200(base, seconds, log = () => {}) {
  const end = Date.now() + seconds * 1000;
  let last = "no answer";
  let said = false;
  for (;;) {
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(5000), redirect: "manual" });
      await res.body?.cancel();
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      const cause = e && typeof e === "object" && "cause" in e && e.cause && typeof e.cause === "object" && "code" in e.cause ? e.cause.code : null;
      last = cause ? String(cause) : e instanceof Error ? e.name : String(e);
    }
    if (Date.now() >= end) throw new Error(`${base.href} did not answer 200 within ${seconds} s (last: ${last})`);
    if (!said) {
      log(`screenshots: waiting for ${base.href} to answer 200 (${last})`);
      said = true;
    }
    await sleep(500);
  }
}

/** Launches the browser, or a SetupError naming Chrome and the setup step. */
export async function launch(playwright, channel, pkg = TOOLS_PACKAGE) {
  try {
    return await playwright.chromium.launch(channel ? { channel, headless: true } : { headless: true });
  } catch (e) {
    const first = String(e instanceof Error ? e.message : e).split("\n").find((l) => l.trim()) ?? "unknown error";
    const which = channel === "chrome" ? "Google Chrome" : channel ? `the ${channel} browser` : "its own browser";
    throw new SetupError(`${MODULE} could not start ${which}${channel ? ` (channel "${channel}")` : ""}: ${first.trim()}. ${setupHint(pkg)}`);
  }
}

/**
 * Shoots every page at every width; returns the files written. A page answering anything but 200 stops the
 * run at once; an uncaught page error is collected, every image is still written, and then the run throws, so
 * a broken client component (StaleBanner, TabBar) fails it (exit 1).
 */
export async function shoot(browser, base, out, log = console.log) {
  fs.mkdirSync(out, { recursive: true });
  const blocked = new Set();
  const problems = [];
  const files = [];
  for (const width of WIDTHS) {
    const mobile = width < 768;
    const context = await browser.newContext({
      viewport: { width, height: HEIGHTS[width] },
      deviceScaleFactor: SCALE,
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: "reduce",
      serviceWorkers: "block",
      locale: "en-US",
      timezoneId: "Asia/Taipei",
    });
    try {
      // No network but --base: every other request is aborted and named at the end.
      await context.route("**/*", (route) => {
        const url = route.request().url();
        let origin = null;
        try {
          origin = new URL(url).origin;
        } catch {}
        if (origin === base.origin) return route.continue();
        blocked.add(origin ?? url.slice(0, 40));
        return route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      let current = "";
      page.on("pageerror", (err) => problems.push(`${current} at ${width} px: ${String(err && err.message ? err.message : err).split("\n")[0]}`));
      for (const p of PAGES) {
        current = p.path;
        const url = new URL(p.path, base).href;
        const res = await page.goto(url, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT_MS });
        const status = res ? res.status() : null;
        if (status !== 200) throw new Error(`${p.path} answered ${status ?? "nothing"} at ${width} px, not 200`);
        await page.evaluate(() => document.fonts.ready.then(() => true));
        const file = path.join(out, `${p.name}-${width}.png`);
        await page.screenshot({ path: file, fullPage: true, animations: "disabled", caret: "hide" });
        files.push(file);
        log(`screenshots: wrote ${file}`);
      }
    } finally {
      await context.close();
    }
  }
  if (blocked.size > 0) log(`screenshots: blocked requests to ${[...blocked].sort().join(", ")} (only ${base.origin} is allowed)`);
  if (problems.length > 0) {
    const n = problems.length;
    throw new Error(`${n} uncaught page error${n === 1 ? "" : "s"}, so the run fails (the ${files.length} images were written):\n${problems.map((l) => `  ${l}`).join("\n")}`);
  }
  return files;
}

/** The CLI. */
export async function main(argv = process.argv.slice(2), log = console.log, err = console.error) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`screenshots: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  let browser = null;
  try {
    const playwright = loadPlaywright(opts.playwright);
    await waitFor200(opts.base, opts.wait, log);
    browser = await launch(playwright, opts.channel, opts.playwright);
    const files = await shoot(browser, opts.base, opts.out, log);
    log(`screenshots: ${files.length} screenshots in ${opts.out}`);
    return 0;
  } catch (e) {
    err(`screenshots: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().then((code) => { process.exitCode = code; });
