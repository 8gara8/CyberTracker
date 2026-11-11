// SPEC Appendix A.5, `npm run color:check` (in `npm run check` from P4). Reads the token blocks of
// app/globals.css (BLOCKS), resolves var() per scope as a browser does, and checks:
// (1) contrast: WCAG 2 ratios for every pair in PAIRS (text 4.5:1, non-text 3:1, the Tag's 4.3:1), with the
//     decorative pairs in EXEMPT, each with its reason, and every colour token named by a pair, an exemption or
//     UNPAIRED, so none slips through unlisted;
// (2) colour vision: per scope, --ai against --ink, --ink-soft and --muted, simulated for protanopia,
//     deuteranopia and tritanopia (Machado, Oliveira and Fernandes 2009, severity 1.0, in linear RGB), CIEDE2000
//     at least 10;
// (3) no blue: no --sev-* token with an HSL hue of 190 to 250 degrees and saturation above 25%.
// One line per pair and check, then a summary; exit 1 on any failure, 2 on a usage error. The colour maths is
// written here (no dependency) and tested against published values in tests/color-check.test.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Scopes ───────────────────────────────────────────────────────────────────────────────────────────

/** The token blocks read, in cascade order. JL's pick (A.6) deletes the html[data-look="night"] entry. */
export const BLOCKS: readonly string[] = [":root", 'html[data-look="night"]', ".night"];

/** The Gap panel's scope: nested inside each page look, never a look of its own (A.2). */
export const PANEL = ".night";

export type ScopeKind = "page" | "panel";

export interface Scope {
  /** The selectors as they nest, e.g. `html[data-look="night"] .night`. */
  name: string;
  kind: ScopeKind;
  /** Blocks applied in order, outermost first. */
  chain: string[];
}

/** Every page look (`:root`, plus each other non-panel block over it) and, when PANEL is read, the panel in it. */
export function scopesOf(blocks: readonly string[] = BLOCKS): Scope[] {
  if (blocks[0] !== ":root") throw new Error(`color:check: BLOCKS must start with :root, not ${blocks[0] ?? "nothing"}`);
  const looks = blocks.filter((b) => b !== PANEL);
  const out: Scope[] = [];
  for (const look of looks) {
    const chain = look === ":root" ? [":root"] : [":root", look];
    out.push({ name: look, kind: "page", chain });
    if (blocks.includes(PANEL)) out.push({ name: `${look} ${PANEL}`, kind: "panel", chain: [...chain, PANEL] });
  }
  return out;
}

// ── Pairs ────────────────────────────────────────────────────────────────────────────────────────────

/** text: WCAG 1.4.3 (4.5:1); non-text: WCAG 1.4.11 (3:1); tag: A.5's exception for the Tag label chip (4.3:1). */
export type Need = "text" | "non-text" | "tag";
export const MINIMUM: Record<Need, number> = { text: 4.5, "non-text": 3, tag: 4.3 };

/**
 * A colour is a token name; `--x@30%` is that token at 30% alpha over the pair's background, as
 * `color-mix(in srgb, var(--x) 30%, transparent)` paints it.
 */
export interface Pair {
  fg: string;
  bg: string;
  need: Need;
  /** Scopes of this kind only; every scope when absent. */
  where?: ScopeKind;
  use: string;
}

export interface Exempt {
  fg: string;
  bg: string;
  where?: ScopeKind;
  reason: string;
}

const pairs = (fg: string, bgs: string[], need: Need, use: string, where?: ScopeKind): Pair[] =>
  bgs.map((bg) => ({ fg, bg, need, use, ...(where ? { where } : {}) }));

/** A.5's pairs and every chip foreground on its background (A.3), in each scope where it applies. */
export const PAIRS: readonly Pair[] = [
  // Text, in every scope (paper, full dark and the Gap panel in each).
  ...pairs("--ink", ["--bg", "--card", "--bg-deep"], "text", "text-fg on the page, cards (bg-panel) and bg-deep (tab hover)"),
  ...pairs("--bg", ["--ink"], "text", "bg-fg text-bg: active tab, stale banner, skip link"),
  ...pairs("--fg", ["--panel"], "text", "the siblings' aliases --fg on --panel"),
  ...pairs("--ink-soft", ["--bg", "--card"], "text", "text-soft"),
  ...pairs("--ink-mute", ["--bg", "--card"], "text", "text-muted and .kicker"),
  ...pairs("--muted", ["--bg", "--card"], "text", "chart axis text, CLAIMED_CHIP, AI: unassessed (text and outline)"),
  ...pairs("--ai", ["--bg", "--card"], "text", "claimed AI chip (violet outline and text), chart C"),
  ...pairs("--ai-on", ["--ai"], "text", "filled AI chip, confirmed or reported"),
  // Page surfaces and chips (A.3), on the page looks only.
  ...pairs("--ink-mute", ["--badge-neutral"], "tag", "Tag label chip: muted text and its 6px square", "page"),
  ...pairs("--ink", ["--badge-mix"], "text", "edition notice (data-only, partial)", "page"),
  ...pairs("--sample-fg", ["--sample-bg"], "text", "SampleBanner", "page"),
  ...pairs("--sev-critical-fg", ["--sev-critical-bg"], "text", "CRITICAL chip", "page"),
  ...pairs("--sev-critical-bg", ["--bg", "--card"], "non-text", "CRITICAL chip fill", "page"),
  ...pairs("--sev-high-fg", ["--sev-high-bg"], "text", "HIGH chip", "page"),
  ...pairs("--sev-high-border", ["--bg", "--card"], "non-text", "HIGH chip border", "page"),
  ...pairs("--sev-elevated-fg", ["--bg", "--card"], "text", "ELEVATED chip", "page"),
  ...pairs("--sev-elevated-border", ["--bg", "--card"], "non-text", "ELEVATED chip outline", "page"),
  ...pairs("--sev-watch-fg", ["--bg", "--card"], "text", "WATCH, BASELINE, LANDMARK, kind words, UNRATED", "page"),
  ...pairs("--rule", ["--bg", "--card"], "non-text", "border-rule: section rules, Dateline, notice bar"),
  // Focus ring (§7 Accessibility): --focus on every surface, at least 3:1.
  ...pairs("--focus", ["--bg", "--card", "--bg-deep"], "non-text", "focus ring"),
  ...pairs("--focus", ["--badge-neutral", "--badge-mix", "--sample-bg"], "non-text", "focus ring", "page"),
];

/** Decorative pairs: printed with their ratio and reason, never failed. */
export const EXEMPT: readonly Exempt[] = [
  { fg: "--ink-mute", bg: "--bg-deep", reason: "tab hover only, where the text is ink (A.5)" },
  { fg: "--border", bg: "--card", reason: "chart gridlines, decorative: the axis text and table carry the values (A.2)" },
  { fg: "--border", bg: "--bg", reason: "gridlines; in full dark also the Gap panel's 1px #33424F border, decorative" },
  { fg: "--rule-soft", bg: "--bg", reason: "border-line hairlines and link underlines (the text is ink); the Gap's panel border (A.5)" },
  { fg: "--rule-soft", bg: "--card", reason: "border-line hairlines on cards, decorative" },
  { fg: "--sev-high-bg", bg: "--bg", where: "page", reason: "HIGH chip tint: its box is the 1px --sev-high-border" },
  { fg: "--ink-mute@30%", bg: "--badge-neutral", where: "page", reason: "Tag border, a 30% color-mix: the word and square carry the Tag" },
];

/** Colour tokens no pair needs, each with its reason (the coverage check reads this). */
export const UNPAIRED: Readonly<Record<string, string>> = {
  "--accent": "parity token, unused (A.1)",
  "--amber": "parity token, unused (A.1)",
  "--green": "parity token, unused (A.1)",
  "--badge-esc": "parity token, unused (A.1)",
  "--badge-ok": "parity token, unused (A.1)",
};

/** Colour vision (2): --ai against these, per scope and simulation. */
export const VISION_TOKENS = ["--ink", "--ink-soft", "--muted"] as const;
export const VISION_MIN_DE = 10;
/** No blue (3): --sev-* tokens with a hue in this range and saturation above NO_BLUE_MAX_SAT fail. */
export const NO_BLUE_HUE: readonly [number, number] = [190, 250];
export const NO_BLUE_MAX_SAT = 25;
/**
 * Near-neutrals exempt from the no-blue rule by value, each with its reason: HSL saturation runs high at the
 * ends of the lightness scale, so these read as 29% to 35% "saturated" though their chroma is about 4%.
 */
export const NO_BLUE_NEUTRALS: Readonly<Record<string, string>> = {
  "#E6EDF3": "the dark ink, a near-white neutral (Critical fill, High text and border, Elevated in full dark, A.3)",
  "#0B0F14": "the night desk's background, a near-black neutral (Critical text in full dark, A.3)",
};

// ── Colour maths ─────────────────────────────────────────────────────────────────────────────────────

/** sRGB channels 0 to 255. */
export type Rgb = readonly [number, number, number];
export type Lab = readonly [number, number, number];
export type Matrix = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function parseHex(value: string): Rgb | null {
  const m = HEX_RE.exec(value.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function toHex(rgb: Rgb): string {
  return "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** sRGB 0 to 255 to linear 0 to 1 (IEC 61966-2-1). */
export function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2 relative luminance. */
export function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, 1 to 21, either order. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` at `alpha` over an opaque `bg`, composited in sRGB as browsers paint it. */
export function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => fg[i]! * alpha + bg[i]! * (1 - alpha)) as unknown as Rgb;
}

/**
 * Machado, Oliveira and Fernandes (2009), "A Physiologically-based Model for Simulation of Color Vision
 * Deficiency", IEEE TVCG 15(6), table of matrices at severity 1.0. They act on linear RGB.
 */
export const MACHADO: Readonly<Record<"protanopia" | "deuteranopia" | "tritanopia", Matrix>> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};
export type Deficiency = keyof typeof MACHADO;
export const DEFICIENCIES = Object.keys(MACHADO) as Deficiency[];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Linear 0 to 1 to sRGB 0 to 255, unrounded. */
export function fromLinear(l: number): number {
  const v = clamp01(l);
  return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
}

/**
 * The colour as someone with the deficiency sees it: the matrix applied in linear RGB, clipped to the gamut
 * and shown as an 8-bit sRGB colour, as a simulator draws it on screen.
 */
export function simulate(rgb: Rgb, kind: Deficiency): Rgb {
  const lin = rgb.map(toLinear);
  return MACHADO[kind].map((row) => Math.round(fromLinear(row[0] * lin[0]! + row[1] * lin[1]! + row[2] * lin[2]!))) as unknown as Rgb;
}

/** D65 reference white for CIELAB (2 degree observer). */
const WHITE = [0.95047, 1, 1.08883] as const;
const SRGB_TO_XYZ: Matrix = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];

/** Linear RGB 0 to 1 to CIELAB (D65). */
export function linearToLab(lin: readonly [number, number, number]): Lab {
  const xyz = SRGB_TO_XYZ.map((row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]);
  const f = (t: number) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  const [fx, fy, fz] = xyz.map((v, i) => f(v / WHITE[i]!)) as [number, number, number];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export const toLab = (rgb: Rgb): Lab => linearToLab(rgb.map(toLinear) as [number, number, number]);

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** CIEDE2000 colour difference, kL = kC = kH = 1 (Sharma, Wu and Dalal 2005). */
export function ciede2000(lab1: Lab, lab2: Lab): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => (a === 0 && b === 0 ? 0 : (deg(Math.atan2(b, a)) + 360) % 360);
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
    else hbarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hbarp - 30)) + 0.24 * Math.cos(rad(2 * hbarp)) + 0.32 * Math.cos(rad(3 * hbarp + 6)) - 0.2 * Math.cos(rad(4 * hbarp - 63));
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp7 = Cbarp ** 7;
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(rad(2 * dTheta)) * RC;
  const l = dLp / SL;
  const c = dCp / SC;
  const h = dHp / SH;
  return Math.sqrt(l * l + c * c + h * h + RT * c * h);
}

/** HSL of an sRGB colour: hue 0 to 360 degrees, saturation and lightness 0 to 100. */
export function hsl(rgb: Rgb): { h: number; s: number; l: number } {
  const [r, g, b] = rgb.map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

// ── CSS ──────────────────────────────────────────────────────────────────────────────────────────────

const norm = (selector: string) => selector.replace(/\s+/g, " ").replace(/'/g, '"').trim();

/**
 * The custom properties declared in each top-level rule whose selector is one of `selectors` (comments
 * stripped; rules inside at-rules such as @theme and @layer are not read). A selector that is missing is
 * left out of the map. Later declarations win, as in the cascade.
 */
export function parseBlocks(css: string, selectors: readonly string[]): Map<string, Map<string, string>> {
  const wanted = new Set(selectors.map(norm));
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, Map<string, string>>();
  let depth = 0;
  let start = 0;
  let prelude = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) {
        prelude = norm(text.slice(start, i));
        start = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth < 0) throw new Error("color:check: unbalanced } in the CSS");
      if (depth === 0) {
        if (wanted.has(prelude)) {
          const decls = out.get(prelude) ?? new Map<string, string>();
          for (const part of text.slice(start, i).split(";")) {
            const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]*?)\s*$/.exec(part);
            if (m) decls.set(m[1]!, m[2]!);
          }
          out.set(prelude, decls);
        }
        start = i + 1;
      }
    } else if (ch === ";" && depth === 0) {
      start = i + 1; // a top-level statement such as @import
    }
  }
  if (depth !== 0) throw new Error("color:check: unbalanced { in the CSS");
  return out;
}

const VAR_RE = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/;

/**
 * The computed custom properties of a scope, as CSS resolves them: each level's declarations are resolved
 * against that level (its own declarations over what it inherits), so a var() resolves where it is declared
 * (A.1) and a child scope that does not redeclare an alias inherits the parent's resolved value.
 */
export function resolveScope(blocks: Map<string, Map<string, string>>, chain: readonly string[]): Map<string, string> {
  let computed = new Map<string, string>();
  for (const selector of chain) {
    const declared = blocks.get(norm(selector)) ?? new Map<string, string>();
    const parent = computed;
    const done = new Map<string, string | null>();
    const resolve = (name: string, seen: Set<string>): string | null => {
      if (!declared.has(name)) return parent.get(name) ?? null;
      if (done.has(name)) return done.get(name)!;
      if (seen.has(name)) return null; // a cycle: invalid at computed-value time
      seen.add(name);
      const raw = declared.get(name)!;
      const m = VAR_RE.exec(raw);
      const value = m ? resolve(m[1]!, seen) ?? (m[2] !== undefined ? m[2].trim() : null) : raw;
      seen.delete(name);
      done.set(name, value);
      return value;
    };
    const next = new Map(parent);
    for (const name of declared.keys()) {
      const v = resolve(name, new Set());
      if (v === null) next.delete(name);
      else next.set(name, v);
    }
    computed = next;
  }
  return computed;
}

// ── The check ────────────────────────────────────────────────────────────────────────────────────────

export type Verdict = "ok" | "FAIL" | "exempt";

export interface CheckLine {
  check: "contrast" | "vision" | "no-blue" | "coverage" | "blocks";
  scope: string;
  verdict: Verdict;
  text: string;
  /** Contrast ratio, delta E, or HSL saturation. */
  value?: number;
}

export interface CheckResult {
  lines: CheckLine[];
  failures: number;
  /** The smallest colour-vision delta E and where it is. */
  smallestVision: { de: number; scope: string; token: string; kind: Deficiency } | null;
}

export interface CheckSpec {
  blocks?: readonly string[];
  pairs?: readonly Pair[];
  exempt?: readonly Exempt[];
  unpaired?: Readonly<Record<string, string>>;
}

const fix = (n: number, d = 2) => n.toFixed(d);
const tokenOf = (spec: string) => spec.split("@")[0]!;

/** A pair side's colour in a scope: a token, or `--x@NN%` over `bg`. */
function colourOf(spec: string, values: Map<string, string>, bg?: Rgb): { rgb: Rgb | null; error?: string } {
  const [token, pct] = spec.split("@") as [string, string | undefined];
  const raw = values.get(token);
  if (raw === undefined) return { rgb: null, error: `${token} is not declared in this scope` };
  const rgb = parseHex(raw);
  if (!rgb) return { rgb: null, error: `${token} is ${raw}, not a #hex colour` };
  if (pct === undefined) return { rgb };
  const alpha = Number(pct.replace(/%$/, "")) / 100;
  if (!bg || !(alpha >= 0 && alpha <= 1)) return { rgb: null, error: `${spec} is not a token at an alpha over its background` };
  return { rgb: over(rgb, alpha, bg) };
}

const applies = (where: ScopeKind | undefined, scope: Scope) => where === undefined || where === scope.kind;

/** Runs the three checks on a stylesheet's text. */
export function runColorCheck(css: string, spec: CheckSpec = {}): CheckResult {
  const blockList = spec.blocks ?? BLOCKS;
  const pairList = spec.pairs ?? PAIRS;
  const exemptList = spec.exempt ?? EXEMPT;
  const unpaired = spec.unpaired ?? UNPAIRED;
  const lines: CheckLine[] = [];
  const parsed = parseBlocks(css, blockList);
  for (const b of blockList) {
    if (!parsed.has(norm(b))) lines.push({ check: "blocks", scope: b, verdict: "FAIL", text: `no top-level ${b} block in the stylesheet` });
  }
  const scopes = scopesOf(blockList);
  const resolved: Map<string, string>[] = [];
  let smallestVision: CheckResult["smallestVision"] = null;

  for (const scope of scopes) {
    const values = resolveScope(parsed, scope.chain);
    resolved.push(values);
    // (1) Contrast.
    const rows: { fg: string; bg: string; label: string; min: number | null; note: string }[] = [
      ...pairList.filter((p) => applies(p.where, scope)).map((p) => ({ fg: p.fg, bg: p.bg, label: p.need, min: MINIMUM[p.need], note: p.use })),
      ...exemptList.filter((e) => applies(e.where, scope)).map((e) => ({ fg: e.fg, bg: e.bg, label: "exempt", min: null, note: e.reason })),
    ];
    for (const row of rows) {
      const bg = colourOf(row.bg, values);
      const fg = colourOf(row.fg, values, bg.rgb ?? undefined);
      const what = `${row.fg} on ${row.bg}`;
      if (!fg.rgb || !bg.rgb) {
        lines.push({ check: "contrast", scope: scope.name, verdict: "FAIL", text: `${what}: ${fg.error ?? bg.error}` });
        continue;
      }
      const ratio = contrastRatio(fg.rgb, bg.rgb);
      const colours = `${toHex(fg.rgb)} on ${toHex(bg.rgb)}`;
      if (row.min === null) {
        lines.push({ check: "contrast", scope: scope.name, verdict: "exempt", value: ratio, text: `${what} (${colours}) ${fix(ratio)}:1, exempt: ${row.note}` });
      } else {
        const verdict: Verdict = ratio >= row.min ? "ok" : "FAIL";
        lines.push({ check: "contrast", scope: scope.name, verdict, value: ratio, text: `${what} (${colours}) ${fix(ratio)}:1, ${row.label} needs ${row.min}:1; ${row.note}` });
      }
    }
    // (2) Colour vision.
    const ai = colourOf("--ai", values);
    for (const token of VISION_TOKENS) {
      const other = colourOf(token, values);
      if (!ai.rgb || !other.rgb) {
        lines.push({ check: "vision", scope: scope.name, verdict: "FAIL", text: `--ai against ${token}: ${ai.error ?? other.error}` });
        continue;
      }
      for (const kind of DEFICIENCIES) {
        const [seenAi, seenOther] = [simulate(ai.rgb, kind), simulate(other.rgb, kind)];
        const de = ciede2000(toLab(seenAi), toLab(seenOther));
        const verdict: Verdict = de >= VISION_MIN_DE ? "ok" : "FAIL";
        const text = `--ai (${toHex(ai.rgb)}, seen ${toHex(seenAi)}) against ${token} (${toHex(other.rgb)}, seen ${toHex(seenOther)}), ${kind}: delta E ${fix(de, 1)}, needs ${VISION_MIN_DE}`;
        lines.push({ check: "vision", scope: scope.name, verdict, value: de, text });
        if (!smallestVision || de < smallestVision.de) smallestVision = { de, scope: scope.name, token, kind };
      }
    }
    // (3) No blue, with the near-neutrals of NO_BLUE_NEUTRALS exempt by value.
    for (const [name, raw] of values) {
      if (!name.startsWith("--sev-")) continue;
      const rgb = parseHex(raw);
      if (!rgb) {
        lines.push({ check: "no-blue", scope: scope.name, verdict: "FAIL", text: `${name} is ${raw}, not a #hex colour` });
        continue;
      }
      const { h, s, l } = hsl(rgb);
      const blue = h >= NO_BLUE_HUE[0] && h <= NO_BLUE_HUE[1] && s > NO_BLUE_MAX_SAT;
      const neutral = NO_BLUE_NEUTRALS[toHex(rgb)];
      const chroma = ((Math.max(...rgb) - Math.min(...rgb)) / 255) * 100;
      const hslText = `hsl(${fix(h, 0)}, ${fix(s, 0)}%, ${fix(l, 0)}%), chroma ${fix(chroma, 0)}%`;
      const verdict: Verdict = !blue ? "ok" : neutral ? "exempt" : "FAIL";
      const tail = !blue ? "not blue" : neutral ? `exempt: ${neutral}` : `blue: hue ${NO_BLUE_HUE[0]} to ${NO_BLUE_HUE[1]} with saturation above ${NO_BLUE_MAX_SAT}%`;
      lines.push({ check: "no-blue", scope: scope.name, verdict, value: s, text: `${name} (${toHex(rgb)}) ${hslText}, ${tail}` });
    }
  }

  // Coverage: every custom property of every block is a #hex colour named by a pair, an exemption or UNPAIRED.
  const named = new Set([...pairList, ...exemptList].flatMap((p) => [tokenOf(p.fg), tokenOf(p.bg)]));
  const declared = new Set<string>();
  for (const decls of parsed.values()) for (const [name] of decls) declared.add(name);
  for (const name of [...declared].sort()) {
    const why = unpaired[name];
    const notHex = resolved.map((v) => v.get(name)).find((v) => v !== undefined && parseHex(v) === null);
    if (why) lines.push({ check: "coverage", scope: "all", verdict: "exempt", text: `${name}: ${why}` });
    else if (notHex !== undefined) lines.push({ check: "coverage", scope: "all", verdict: "FAIL", text: `${name} is ${notHex}, not a #hex colour` });
    else if (!named.has(name)) lines.push({ check: "coverage", scope: "all", verdict: "FAIL", text: `${name} is in no pair, exemption or UNPAIRED entry` });
  }

  return { lines, failures: lines.filter((l) => l.verdict === "FAIL").length, smallestVision };
}

export function formatLine(line: CheckLine): string {
  return `${line.verdict.padEnd(6)} ${line.check.padEnd(8)} ${line.scope.padEnd(31)} ${line.text}`;
}

export function summaryLine(result: CheckResult): string {
  const n = result.lines.length;
  const exempt = result.lines.filter((l) => l.verdict === "exempt").length;
  const v = result.smallestVision;
  const smallest = v ? `; smallest colour-vision delta E ${fix(v.de, 1)} (${v.scope}, --ai against ${v.token}, ${v.kind})` : "";
  return `color:check: ${n} lines, ${result.failures} failed, ${exempt} exempt${smallest}`;
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CSS = path.join(REPO, "app", "globals.css");
export const USAGE = "Usage: npm run color:check [-- --css FILE]   (default app/globals.css)";

/** The CLI: 0 every check passed, 1 a failure or unreadable stylesheet, 2 a usage error. */
export function main(argv: readonly string[] = process.argv.slice(2), out: (line: string) => void = console.log, err: (line: string) => void = console.error): number {
  let file = DEFAULT_CSS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--css" && argv[i + 1] !== undefined) file = path.resolve(argv[++i]!);
    else if (a === "--help" || a === "-h") {
      out(USAGE);
      return 0;
    } else {
      err(`color:check: unknown argument ${a}\n${USAGE}`);
      return 2;
    }
  }
  let css: string;
  try {
    css = fs.readFileSync(file, "utf8");
  } catch {
    err(`color:check: cannot read ${file}`);
    return 1;
  }
  let result: CheckResult;
  try {
    result = runColorCheck(css);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
  for (const line of result.lines) out(formatLine(line));
  out(summaryLine(result));
  return result.failures === 0 ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main();
