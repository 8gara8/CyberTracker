// scripts/color-check.ts, `npm run color:check` (SPEC Appendix A.5): the colour maths against published
// values, the CSS reading and var() resolution, the three checks on app/globals.css (every A.5 and A.3
// figure reproduced), and failing stylesheets (exit 1).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BLOCKS, DEFICIENCIES, EXEMPT, MACHADO, MINIMUM, NO_BLUE_NEUTRALS, PAIRS, PANEL, UNPAIRED, VISION_MIN_DE, ciede2000, contrastRatio, hsl, main,
  over, parseBlocks, parseHex, resolveScope, runColorCheck, scopesOf, simulate, toHex, toLab, type CheckLine, type Lab,
} from "@/scripts/color-check";

const REPO = path.join(__dirname, "..");
const CSS = fs.readFileSync(path.join(REPO, "app", "globals.css"), "utf8");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ct-color-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const hex = (h: string) => parseHex(h)!;
const NIGHT = 'html[data-look="night"]';

/** The stylesheet with one token's value changed inside one top-level block. */
function withToken(css: string, selector: string, token: string, value: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const end = css.indexOf("\n}", start);
  const block = css.slice(start, end);
  const re = new RegExp(`${token}:\\s*[^;]+;`);
  if (!re.test(block)) throw new Error(`no ${token} in ${selector}`);
  return css.slice(0, start) + block.replace(re, `${token}: ${value};`) + css.slice(end);
}

function writeCss(name: string, css: string): string {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, css);
  return file;
}

function runMain(argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, (l) => out.push(l), (l) => err.push(l));
  return { code, out, err };
}

const fails = (lines: CheckLine[]) => lines.filter((l) => l.verdict === "FAIL");

describe("colour maths", () => {
  it("WCAG 2 contrast: black on white is 21, a colour on itself 1, either order the same", () => {
    expect(contrastRatio(hex("#000000"), hex("#ffffff"))).toBeCloseTo(21, 10);
    expect(contrastRatio(hex("#ffffff"), hex("#000000"))).toBeCloseTo(21, 10);
    expect(contrastRatio(hex("#6b6a62"), hex("#6b6a62"))).toBe(1);
    // The usual reference greys on white: #767676 is the lightest grey at 4.5:1, #777777 just under.
    expect(contrastRatio(hex("#767676"), hex("#ffffff"))).toBeCloseTo(4.54, 2);
    expect(contrastRatio(hex("#777777"), hex("#ffffff"))).toBeCloseTo(4.48, 2);
  });

  it("parses #rgb and #rrggbb, and nothing else", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("#6D28D9")).toEqual([0x6d, 0x28, 0xd9]);
    expect(parseHex("var(--ink)")).toBeNull();
    expect(parseHex("rgb(0 0 0)")).toBeNull();
    expect(toHex([0x6d, 0x28, 0xd9])).toBe("#6D28D9");
  });

  it("alpha over a background is the sRGB mix color-mix(..., transparent) paints", () => {
    expect(over(hex("#000000"), 0.3, hex("#ffffff"))).toEqual([178.5, 178.5, 178.5]);
    expect(toHex(over(hex("#6b6a62"), 0.3, hex("#ece6d8")))).toBe("#C5C1B5");
  });

  it("CIELAB (D65) of white, black and sRGB red", () => {
    const [L, a, b] = toLab(hex("#ffffff"));
    expect(L).toBeCloseTo(100, 3);
    expect(Math.abs(a)).toBeLessThan(0.01);
    expect(Math.abs(b)).toBeLessThan(0.01);
    expect(toLab(hex("#000000"))[0]).toBeCloseTo(0, 6);
    const red = toLab(hex("#ff0000"));
    expect(red[0]).toBeCloseTo(53.24, 1);
    expect(red[1]).toBeCloseTo(80.09, 1);
    expect(red[2]).toBeCloseTo(67.2, 1);
  });

  // Sharma, Wu and Dalal (2005), "The CIEDE2000 color-difference formula: implementation notes,
  // supplementary test data, and mathematical observations", Table 1: pairs 1, 7, 8, 9, 11, 13, 15, 17, 18,
  // 19, 20, 25, 30, 33 and 34 (the hue-wrap, mean-hue and near-neutral cases among them).
  const SHARMA: [Lab, Lab, number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, -1, 2], [50, 0, 0], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
    [[50, -0.001, 2.49], [50, 0.0009, -2.49], 4.8045],
    [[50, -0.001, 2.49], [50, 0.0011, -2.49], 4.7461],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[50, 2.5, 0], [56, -27, -3], 31.903],
    [[50, 2.5, 0], [58, 24, 15], 19.4535],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
    [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];

  it("CIEDE2000 reproduces Sharma et al.'s test pairs to 4 decimals, either order", () => {
    for (const [a, b, want] of SHARMA) {
      expect(ciede2000(a, b), `${a} / ${b}`).toBeCloseTo(want, 4);
      expect(ciede2000(b, a), `${b} / ${a}`).toBeCloseTo(want, 4);
    }
    expect(ciede2000([50, 10, 10], [50, 10, 10])).toBe(0);
  });

  it("the Machado severity-1.0 matrices' rows each sum to about 1, so greys stay grey", () => {
    expect(DEFICIENCIES).toEqual(["protanopia", "deuteranopia", "tritanopia"]);
    for (const kind of DEFICIENCIES) {
      for (const row of MACHADO[kind]) expect(Math.abs(row[0] + row[1] + row[2] - 1), kind).toBeLessThan(1e-5);
      for (const grey of ["#000000", "#404040", "#808080", "#c0c0c0", "#ffffff"]) {
        const seen = simulate(hex(grey), kind);
        const g = hex(grey);
        for (let i = 0; i < 3; i++) expect(Math.abs(seen[i]! - g[i]!), `${kind} ${grey}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("the simulations lose the red-green and blue-yellow axes as they should", () => {
    // A red and a green that differ widely look alike to a protanope and a deuteranope, not to a tritanope.
    const de = (a: string, b: string, kind: (typeof DEFICIENCIES)[number]) => ciede2000(toLab(simulate(hex(a), kind)), toLab(simulate(hex(b), kind)));
    const normal = ciede2000(toLab(hex("#b8860b")), toLab(hex("#5e9e3a")));
    expect(de("#b8860b", "#5e9e3a", "deuteranopia")).toBeLessThan(normal / 3);
    expect(de("#b8860b", "#5e9e3a", "protanopia")).toBeLessThan(normal / 3);
    // Tritanopia collapses blue against green far more than deuteranopia does.
    expect(de("#3b82f6", "#10b981", "tritanopia")).toBeLessThan(de("#3b82f6", "#10b981", "deuteranopia"));
  });

  it("HSL hue, saturation and lightness", () => {
    expect(hsl(hex("#0000ff"))).toEqual({ h: 240, s: 100, l: 50 });
    expect(hsl(hex("#808080")).s).toBe(0);
    const ink = hsl(hex("#E6EDF3"));
    expect(Math.round(ink.h)).toBe(208);
    expect(Math.round(ink.s)).toBe(35);
    const high = hsl(hex("#3A4757"));
    expect(Math.round(high.h)).toBe(213);
    expect(Math.round(high.s)).toBe(20);
  });
});

describe("reading the stylesheet", () => {
  it("reads only top-level rules with the exact selectors, skipping comments and at-rules", () => {
    const css = `@import "x";
/* :root { --ink: #ff0000; } */
@theme { --font-sans: x; }
@layer base { :root { --ink: #00ff00; } }
:root { --ink: #111111; --bg: #eeeeee; color-scheme: light }
.night { --ink: #eeeeee; }
html[data-look="night"] .night { border: 1px solid #333; }
:root { --bg: #f0f0f0; }`;
    const blocks = parseBlocks(css, [":root", ".night", NIGHT]);
    expect([...blocks.keys()]).toEqual([":root", ".night"]);
    expect(Object.fromEntries(blocks.get(":root")!)).toEqual({ "--ink": "#111111", "--bg": "#f0f0f0" });
    expect(() => parseBlocks(":root { --a: #000;", [":root"])).toThrow(/unbalanced/);
  });

  it("resolves var() where it is declared, as the cascade does (A.1: every scope redeclares the aliases)", () => {
    const css = `:root { --ink: #000000; --fg: var(--ink); --soft: var(--missing, #123456); --x: var(--y); --y: var(--x); }
.night { --ink: #ffffff; }
.alias { --ink: #ffffff; --fg: var(--ink); }`;
    const blocks = parseBlocks(css, [":root", ".night", ".alias"]);
    const night = resolveScope(blocks, [":root", ".night"]);
    expect(night.get("--ink")).toBe("#ffffff");
    expect(night.get("--fg")).toBe("#000000"); // inherited resolved, not re-resolved against .night's --ink
    expect(resolveScope(blocks, [":root", ".alias"]).get("--fg")).toBe("#ffffff");
    expect(night.get("--soft")).toBe("#123456");
    expect(night.has("--x")).toBe(false); // a cycle is invalid
  });

  it("the scopes: each page look and the Gap panel inside it; the pick removes one BLOCKS entry", () => {
    expect(BLOCKS).toContain(":root");
    expect(BLOCKS).toContain(PANEL);
    const names = scopesOf(BLOCKS).map((s) => s.name);
    expect(names.slice(0, 2)).toEqual([":root", ":root .night"]);
    if (BLOCKS.includes(NIGHT)) expect(names).toEqual([":root", ":root .night", NIGHT, `${NIGHT} .night`]);
    const picked = scopesOf(BLOCKS.filter((b) => b !== NIGHT));
    expect(picked.map((s) => [s.name, s.kind, s.chain])).toEqual([
      [":root", "page", [":root"]],
      [":root .night", "panel", [":root", ".night"]],
    ]);
    expect(() => scopesOf([".night"])).toThrow(/start with :root/);
  });
});

describe("app/globals.css", () => {
  const result = runColorCheck(CSS);
  const scopes = new Set(scopesOf(BLOCKS).map((s) => s.name));
  const ratio = (scope: string, fg: string, bg: string) => {
    const line = result.lines.find((l) => l.check === "contrast" && l.scope === scope && l.text.startsWith(`${fg} on ${bg} `));
    if (!line?.value) throw new Error(`no ${fg} on ${bg} in ${scope}`);
    return line.value.toFixed(2);
  };

  it("passes every check", () => {
    expect(fails(result.lines).map((l) => `${l.scope} ${l.text}`)).toEqual([]);
    expect(result.failures).toBe(0);
    expect(runMain([]).code).toBe(0);
  });

  // [scope, fg, bg, the A.5 or A.3 figure]
  const FIGURES: [string, string, string, string][] = [
    [":root", "--ink", "--bg", "15.65"], [":root", "--ink", "--card", "17.07"],
    [":root", "--ink-soft", "--bg", "9.26"], [":root", "--ink-soft", "--card", "10.09"],
    [":root", "--ink-mute", "--bg", "4.70"], [":root", "--ink-mute", "--card", "5.12"],
    [":root", "--ink-mute", "--bg-deep", "4.22"], [":root", "--ink-mute", "--badge-neutral", "4.37"],
    [":root", "--ai", "--bg", "6.14"], [":root", "--ai", "--card", "6.69"], [":root", "--ai-on", "--ai", "6.69"],
    [":root", "--sample-fg", "--sample-bg", "5.63"], [":root", "--focus", "--bg-deep", "14.05"],
    [":root", "--sev-critical-fg", "--sev-critical-bg", "17.07"], [":root", "--sev-high-fg", "--sev-high-bg", "9.92"],
    [":root", "--sev-watch-fg", "--bg", "4.70"], [":root", "--border", "--card", "1.72"],
    [":root .night", "--ink", "--bg", "16.27"], [":root .night", "--ink", "--card", "15.08"],
    [":root .night", "--ink-soft", "--bg", "11.83"], [":root .night", "--ink-soft", "--card", "10.97"],
    [":root .night", "--ink-mute", "--bg", "6.53"], [":root .night", "--ink-mute", "--card", "6.05"],
    [":root .night", "--ai", "--bg", "7.06"], [":root .night", "--ai", "--card", "6.55"],
    [":root .night", "--border", "--card", "1.73"], [":root .night", "--rule-soft", "--bg", "1.32"],
    [":root .night", "--rule-soft", "--card", "1.23"],
    [NIGHT, "--ink-mute", "--card", "5.37"], [NIGHT, "--ai", "--card", "5.81"], [NIGHT, "--sample-fg", "--sample-bg", "9.67"],
    [NIGHT, "--focus", "--card", "13.39"], [NIGHT, "--sev-critical-fg", "--sev-critical-bg", "16.27"],
    [NIGHT, "--sev-high-fg", "--sev-high-bg", "8.01"], [NIGHT, "--sev-watch-fg", "--bg", "6.05"],
    [NIGHT, "--ai-on", "--ai", "7.06"], [NIGHT, "--border", "--bg", "1.73"],
  ];

  it("reproduces every A.5 and A.3 ratio (to 2 decimals) in the scopes that are read", () => {
    for (const [scope, fg, bg, want] of FIGURES) {
      if (!scopes.has(scope)) continue;
      expect(ratio(scope, fg, bg), `${scope} ${fg} on ${bg}`).toBe(want);
    }
  });

  it("the focus ring is at least 14.05 on any paper surface and 13.39 on the dark neutrals (A.5)", () => {
    const focus = result.lines.filter((l) => l.check === "contrast" && l.text.startsWith("--focus on "));
    expect(focus.length).toBeGreaterThan(0);
    for (const l of focus) {
      // Full dark's amber notice and banner surface (#3A2E12) is the exception: 11.25, still far over 3.
      const amber = l.scope === NIGHT && /--focus on --(badge-mix|sample-bg) /.test(l.text);
      const min = l.scope === ":root" ? 14.05 : amber ? 11.25 : 13.39;
      expect(Number(l.value!.toFixed(2)), `${l.scope} ${l.text}`).toBeGreaterThanOrEqual(min);
    }
  });

  it("the smallest colour-vision delta E is 12.5, night violet against muted, tritan (A.5)", () => {
    const v = result.smallestVision!;
    expect(v.de.toFixed(1)).toBe("12.5");
    expect([v.token, v.kind]).toEqual(["--muted", "tritanopia"]);
    expect(v.scope).toContain(".night");
    const vision = result.lines.filter((l) => l.check === "vision");
    expect(vision).toHaveLength(scopes.size * 3 * 3);
    for (const l of vision) expect(l.value!).toBeGreaterThanOrEqual(VISION_MIN_DE);
  });

  it("no --sev-* token is blue; the two dark near-neutrals are the only exemptions", () => {
    const noBlue = result.lines.filter((l) => l.check === "no-blue");
    expect(noBlue.length).toBeGreaterThan(0);
    const exempt = noBlue.filter((l) => l.verdict === "exempt").map((l) => /\((#[0-9A-F]{6})\)/.exec(l.text)![1]);
    expect(new Set(exempt)).toEqual(new Set(scopes.has(NIGHT) ? Object.keys(NO_BLUE_NEUTRALS) : []));
    expect(noBlue.find((l) => l.scope === NIGHT && l.text.startsWith("--sev-high-bg "))?.verdict ?? "ok").toBe("ok");
  });

  it("every pair has a known need and use, every exemption a reason, the Tag uses 4.3", () => {
    expect(MINIMUM).toEqual({ text: 4.5, "non-text": 3, tag: 4.3 });
    for (const p of PAIRS) expect(p.use.length, `${p.fg} on ${p.bg}`).toBeGreaterThan(5);
    for (const e of EXEMPT) expect(e.reason.length, `${e.fg} on ${e.bg}`).toBeGreaterThan(10);
    expect(PAIRS.filter((p) => p.need === "tag").map((p) => `${p.fg} on ${p.bg}`)).toEqual(["--ink-mute on --badge-neutral"]);
    const keys = [...PAIRS, ...EXEMPT].map((p) => `${p.fg} on ${p.bg} ${p.where ?? "all"}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("prints a line per pair and check, and the summary", () => {
    const { out } = runMain([]);
    expect(out.length).toBe(result.lines.length + 1);
    expect(out.at(-1)).toMatch(/^color:check: \d+ lines, 0 failed, \d+ exempt; smallest colour-vision delta E 12\.5 /);
    expect(out.some((l) => /^ok +contrast +:root +--ink on --bg \(#14161A on #F3EEE3\) 15\.65:1/.test(l))).toBe(true);
    expect(out.some((l) => /^exempt +contrast +:root +--border on --card .* 1\.72:1, exempt: /.test(l))).toBe(true);
    expect(out.every((l) => !l.includes("—"))).toBe(true);
  });

  it("after the pick (BLOCKS without the full-dark look) the same file still passes", () => {
    const picked = runColorCheck(CSS, { blocks: BLOCKS.filter((b) => b !== NIGHT) });
    expect(fails(picked.lines)).toEqual([]);
    expect(new Set(picked.lines.map((l) => l.scope))).toEqual(new Set([":root", ":root .night", "all"]));
  });
});

describe("failing stylesheets", () => {
  it("a muted text too light for 4.5:1 fails, and the CLI exits 1", () => {
    const file = writeCss("light-mute.css", withToken(CSS, ":root", "--ink-mute", "#8a897f"));
    const { code, out } = runMain(["--css", file]);
    expect(code).toBe(1);
    expect(out.some((l) => /^FAIL +contrast +:root +--ink-mute on --bg \(#8A897F on #F3EEE3\) 3\.\d\d:1, text needs 4\.5:1/.test(l))).toBe(true);
    expect(out.at(-1)).toMatch(/color:check: \d+ lines, [1-9]\d* failed/);
    // The real process too: tsx runs the script and its exit code is 1.
    let status = 0;
    try {
      execFileSync(process.execPath, [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), path.join(REPO, "scripts", "color-check.ts"), "--css", file], { cwd: REPO, stdio: "pipe" });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(1);
  });

  it("the Tag exception is 4.3, not lower", () => {
    // #6b6a62 on #ddd5c3 is under 4.3:1, so even the Tag fails.
    const r = runColorCheck(withToken(CSS, ":root", "--badge-neutral", "#ddd5c3"));
    const tag = r.lines.find((l) => l.scope === ":root" && l.text.startsWith("--ink-mute on --badge-neutral "))!;
    expect(tag.verdict).toBe("FAIL");
    expect(tag.value!).toBeLessThan(4.3);
  });

  it("a non-text pair under 3:1 fails (the focus ring on the dark card)", () => {
    const r = runColorCheck(withToken(CSS, NIGHT, "--focus", "#2a3546"));
    expect(fails(r.lines).some((l) => l.scope === NIGHT && l.text.startsWith("--focus on --card "))).toBe(true);
  });

  it("violet too close to muted for a tritanope fails the colour-vision check", () => {
    const r = runColorCheck(withToken(CSS, ".night", "--ai", "#8f8fb8"));
    const bad = fails(r.lines).filter((l) => l.check === "vision");
    expect(bad.some((l) => l.scope === ":root .night" && l.text.includes("--muted") && l.text.includes("tritanopia"))).toBe(true);
  });

  it("a blue severity token fails; a near-neutral not on the list does too", () => {
    const blue = runColorCheck(withToken(CSS, ":root", "--sev-high-bg", "#9ec5f0"));
    expect(fails(blue.lines).some((l) => l.check === "no-blue" && l.text.startsWith("--sev-high-bg (#9EC5F0)"))).toBe(true);
    const nearWhite = runColorCheck(withToken(CSS, ":root", "--sev-critical-fg", "#E6EDF4"));
    expect(fails(nearWhite.lines).some((l) => l.check === "no-blue" && l.text.startsWith("--sev-critical-fg (#E6EDF4)"))).toBe(true);
  });

  it("a new token no pair names fails coverage, and a non-hex value fails too", () => {
    const added = runColorCheck(withToken(CSS, ":root", "--badge-ok", "#d9e3d3; --link-new: #335577"));
    expect(fails(added.lines).map((l) => l.text)).toEqual(["--link-new is in no pair, exemption or UNPAIRED entry"]);
    const named = runColorCheck(withToken(CSS, ":root", "--badge-ok", "#d9e3d3; --link-new: #335577"), { unpaired: { ...UNPAIRED, "--link-new": "test" } });
    expect(fails(named.lines)).toEqual([]);
    const keyword = runColorCheck(withToken(CSS, ":root", "--ink-soft", "darkslategray"));
    expect(fails(keyword.lines).some((l) => l.check === "coverage" && l.text === "--ink-soft is darkslategray, not a #hex colour")).toBe(true);
    expect(fails(keyword.lines).some((l) => l.check === "contrast" && l.text.includes("not a #hex colour"))).toBe(true);
  });

  it("a missing block or an undeclared token fails", () => {
    const noNight = runColorCheck(CSS.replace("\n.night {", "\n.night-x {"));
    expect(fails(noNight.lines).some((l) => l.check === "blocks" && l.scope === ".night")).toBe(true);
    const r = runColorCheck(CSS, { pairs: [{ fg: "--nope", bg: "--bg", need: "text", use: "test" }] });
    expect(fails(r.lines).some((l) => l.text === "--nope on --bg: --nope is not declared in this scope")).toBe(true);
  });

  it("usage: --help exits 0, an unknown argument 2, an unreadable file 1", () => {
    expect(runMain(["--help"]).code).toBe(0);
    const bad = runMain(["--bogus"]);
    expect(bad.code).toBe(2);
    expect(bad.err.join("\n")).toMatch(/unknown argument --bogus/);
    const missing = runMain(["--css", path.join(TMP, "none.css")]);
    expect(missing.code).toBe(1);
    expect(missing.err.join("\n")).toMatch(/cannot read/);
  });
});
