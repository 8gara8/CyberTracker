// Text helpers (SPEC §4.1, §4.12, §8.3). countWords() is copied from the Europe fork unchanged; the rest
// are CyberTracker's: jaccard() for syndicated copies and near-duplicate titles, splitSentences() and
// numbersIn() for the rules, numberMatches() for §4.12's matching rule. All pure.

import { ABBREVIATIONS } from "./vocab";

// ── Words (§4.1) ─────────────────────────────────────────────────────────────────────────────────

// Word counting, copied from the Europe fork unchanged. URLs are removed, the rest is split on
// whitespace, and a token counts when it contains at least one letter or digit, so markdown symbols and
// stray dashes never count. Hyphenated words and numbers such as "1,800" each count as one word. A
// Chinese or Japanese run without spaces counts as one word.

const URL_RE = /\bhttps?:\/\/\S+/gi;
const WORDISH_RE = /[\p{L}\p{N}]/u;

export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  let n = 0;
  for (const token of text.replace(URL_RE, " ").split(/\s+/)) {
    if (WORDISH_RE.test(token)) n += 1;
  }
  return n;
}

// ── Similarity (§4.12 syndicated copies, §8.3 dedupe) ────────────────────────────────────────────

const HAN_KANA = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u30FC";
const RUN_RE = new RegExp(`[${HAN_KANA}]+|[^${HAN_KANA}]+`, "gu");
const HAN_KANA_START = new RegExp(`^[${HAN_KANA}]`, "u");

/**
 * The lower-cased word set jaccard() compares: NFKC, punctuation to spaces, split on whitespace. A Han
 * or Kana run (no spaces in Chinese or Japanese) becomes its character bigrams, or the character itself
 * when the run is one character long, so two titles one character apart still share most of the set.
 */
export function wordSet(text: string): Set<string> {
  const out = new Set<string>();
  const cleaned = text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
  for (const token of cleaned.split(/\s+/)) {
    if (!token) continue;
    for (const run of token.match(RUN_RE) ?? []) {
      if (!HAN_KANA_START.test(run)) {
        out.add(run);
        continue;
      }
      const chars = Array.from(run);
      if (chars.length === 1) out.add(run);
      for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i]! + chars[i + 1]!);
    }
  }
  return out;
}

/** Jaccard similarity of two titles' word sets (`wordSet()`), 0 to 1. Two empty titles score 1. */
export function jaccard(a: string, b: string): number {
  const A = wordSet(a);
  const B = wordSet(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

// ── Sentences (§4.12) ────────────────────────────────────────────────────────────────────────────

const BREAK_RE = /[.!?]+["'”’)\]]*(?=\s)/gu;
const ABBREVIATION_SET: ReadonlySet<string> = new Set(ABBREVIATIONS);

/**
 * Splits prose into sentences after `.`, `!` or `?` (and any closing quote or bracket) followed by
 * whitespace, except after an `ABBREVIATIONS` entry (case as written, so "no." still ends a sentence
 * while "No. 5" does not). Sentences come back trimmed; empty ones are dropped.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(BREAK_RE)) {
    const end = m.index + m[0].length;
    const before = text.slice(start, end);
    const lastToken = before.trimEnd().split(/\s+/).pop()?.replace(/^[("'“‘[]+/u, "") ?? "";
    if (ABBREVIATION_SET.has(lastToken)) continue;
    const sentence = before.trim();
    if (sentence) out.push(sentence);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

// ── Numbers (§4.12) ──────────────────────────────────────────────────────────────────────────────

/** One number read from text by `numbersIn()`. */
export interface NumberToken {
  /** The digits as written, with any unit word: "1,393", "37%", "4.5 million". */
  raw: string;
  /** The value with its multiplier applied; a magnitude (a leading minus sign is not read). */
  value: number;
  /** Digits after the decimal point as written. */
  decimals: number;
  /** The place value of the last digit written, times the multiplier: "1,400" 1, "4.5 million" 100,000. */
  step: number;
  /** The place value of the last non-zero digit written, times the multiplier: "1,400" 100. */
  approx_step: number;
  /** Written with %, "per cent" or "percent". */
  percent: boolean;
  /** Written after "about", "around", "nearly", "almost", "roughly", "more than", "over" or "~". */
  approx: boolean;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];
const MONTH_FORMS = [...new Set(MONTH_NAMES.flatMap((m) => {
  const forms = [m, m.slice(0, 3)];
  if (m === "September") forms.push("Sept");
  return forms.flatMap((f) => [f, f.toUpperCase()]);
}))].sort((a, b) => b.length - a.length);
const MONTH = `(?:${MONTH_FORMS.join("|")})`;
const ORDINAL = "(?:st|nd|rd|th)?";
const YEAR = "(?:199\\d|20\\d\\d)";

/** The hyphen, U+2010 and U+2011 (NFKC makes U+2011 a U+2010) and the en dash. */
const DASHES = "\\-\\u2010\\u2011\\u2013";

/**
 * A day range in one month, read as one date (§0.4 row 145): the first day, then " to " (with "the"
 * allowed before the second day), a hyphen or an en dash, or, after "between", " and ". Ordinals allowed.
 */
const DAY_RANGE = (d1: string, d2: string): string =>
  `(?:[Bb]etween\\s+(?:the\\s+)?${d1}${ORDINAL}\\s+and\\s+(?:the\\s+)?|${d1}${ORDINAL}(?:\\s+to\\s+(?:the\\s+)?|\\s?[${DASHES}]\\s?))${d2}${ORDINAL}`;
/** "13 to 14 Oct", "13–14 Oct", "between 13 and 14 Oct", "13th to the 14th of October". */
const DAY_RANGE_MONTH_RE = new RegExp(
  `(?<![\\p{L}\\p{N}.,])${DAY_RANGE("(\\d{1,2})", "(\\d{1,2})")}\\s+(?:of\\s+)?${MONTH}\\.?(?![\\p{L}])`, "gu");
/** "Oct 13 to 14", "Oct 13–14", "between Oct 13 and 14": the second day is not a percentage, decimal or count in millions. */
const MONTH_DAY_RANGE_RE = new RegExp(
  `(?:(?<![\\p{L}])([Bb]etween\\s+))?(?<![\\p{L}])${MONTH}\\.?\\s+(?:the\\s+)?(\\d{1,2})${ORDINAL}` +
  `(?:\\s+to\\s+(?:the\\s+)?|\\s?[${DASHES}]\\s?|\\s+and\\s+(?:the\\s+)?)(\\d{1,2})${ORDINAL}` +
  "(?![\\p{L}\\p{N}])(?![.,]\\d)(?!\\s?(?:%|per\\s?cent|percent))(?!\\s+(?:thousand|million|billion)(?![\\p{L}]))", "gu");

/** A day range's days are 1 to 31, the first before the second; anything else is left for the other patterns. */
const isDayRange = (a: string, b: string): boolean => {
  const [x, y] = [Number(a), Number(b)];
  return x >= 1 && x < y && y <= 31;
};

/** GHSA ids, whose alphabet holds digits and x ("GHSA-683x-4444-jxh8"): never numbers, never ratios. */
const GHSA_RE = /\bGHSA(?:-[0-9a-z]{4}){3}\b/giu;

/** What numbersIn() removes before reading digits, in order (§4.12): a pattern, or a function that removes what it reads. */
const NOT_NUMBERS: readonly (RegExp | ((s: string) => string))[] = [
  /\bCVE-\d{4}-\d{4,}\b/giu,
  GHSA_RE,
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?![\d])/giu, // ISO dates and timestamps
  /(?<![\p{L}\p{N}])[vV]\d+(?:\.\d+)*(?![\p{L}\p{N}])/gu, // v-prefixed versions
  /(?<![\p{L}\p{N}.])\d+(?:\.\d+){2,}[\p{L}\p{N}+-]*/gu, // versions with two or more dots (and dotted quads)
  /(?<![\p{L}\p{N}])\d{1,2}:\d{2}(?::\d{2})?(?:\s?[aApP]\.?[mM]\.?)?(?![\p{L}\p{N}])/gu, // clock times
  /(?<![\p{L}\p{N}])\d{1,2}\s?[aApP]\.?[mM]\.?(?![\p{L}\p{N}])/gu, // "5 pm"
  // Day ranges before the single dates, so neither day of "13 to 14 Oct" or "Oct 13 to 14" is read.
  (s) => s.replace(DAY_RANGE_MONTH_RE, (m, a1?: string, a2?: string, b?: string) => (isDayRange(a1 ?? a2!, b!) ? " " : m)),
  (s) => s.replace(MONTH_DAY_RANGE_RE, (m, between: string | undefined, a: string, b: string) => {
    // "and" joins two days only after "between", as in a label figure's range ("Oct 13 and 14" alone is not one).
    if (!between && /\sand\s/u.test(m.slice(m.search(/\d/u)))) return m;
    return isDayRange(a, b) ? " " : m;
  }),
  new RegExp(`(?<![\\p{L}\\p{N}])\\d{1,2}${ORDINAL}\\s+(?:of\\s+)?${MONTH}\\.?(?![\\p{L}])`, "gu"), // "21 Oct", "21st October"
  new RegExp(`(?<![\\p{L}])${MONTH}\\.?\\s+\\d{1,2}${ORDINAL}(?![\\p{L}\\p{N}])`, "gu"), // "Oct 21", "October 21st"
  new RegExp(`(?<![\\p{L}\\p{N}.,])${YEAR}\\s?[-–]\\s?(?:${YEAR}|\\d{2})(?!\\d|[.,]\\d)`, "gu"), // "2023-24", "2023–2024"
  new RegExp(`(?<![\\p{L}\\p{N}.,])${YEAR}(?!\\d|[.,]\\d)`, "gu"), // years 1990 to 2099, "2020s" included
  /§\s*\d+(?:\.\d+)*/gu, // section marks
];

const SMALL_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const TENS_WORDS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const UNIT_WORD = "(one|two|three|four|five|six|seven|eight|nine)";
const COMPOUND_RE = new RegExp(`\\b(${Object.keys(TENS_WORDS).join("|")})[-\\s]${UNIT_WORD}\\b`, "giu");
// "one" is not read on its own: §4.12 reads two to twenty and the tens.
const WORD_RE = new RegExp(`\\b(${[...Object.keys(SMALL_WORDS).filter((w) => w !== "one"), ...Object.keys(TENS_WORDS)].join("|")})\\b`, "giu");

const NUMBER_RE = new RegExp(
  "(?<![\\p{L}\\p{N}_])(?<!\\p{L}-)(?<!\\p{N}[.,])" + // not glued to a word, not inside "COVID-19" or "1,2"
  "(\\d{1,3}(?:,\\d{3})+(?!\\d)|\\d+)(?:\\.(\\d+))?(?![.,]\\d)" + // digits, thousands separators, decimals
  "(?:(\\s?(?:%|per\\s?cent\\b|percent\\b))|(\\s(?:thousand|million|billion)\\b)|(\\s?(?:bn|BN|Bn))(?![\\p{L}\\p{N}])|([mM])(?![\\p{L}\\p{N}]))?" +
  "(?![\\p{L}\\p{N}])",
  "gu",
);
const APPROX_RE = /(?:\b(?:about|around|nearly|almost|roughly|more\s+than|over)|~)\s*(?:[A-Z]{0,3}[$€£¥])?\s*$/iu;
const MULTIPLIERS: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, bn: 1e9, m: 1e6 };

/**
 * The numbers in a piece of text (§4.12). First removes what is not a quantity: CVE and GHSA ids, ISO
 * dates and timestamps, clock times, day-month dates ("21 Oct", "October 21") and day ranges in one month
 * ("13 to 14 Oct", "13–14 Oct", "between 13 and 14 Oct", "Oct 13 to 14", "Oct 13-14", days 1 to 31, the
 * first before the second; a range across months is two dates, "30 Oct to 2 Nov"), years 1990 to 2099 and
 * year ranges ("2023-24", "2023–24"), version strings (two or more dots, or a leading v) and section
 * marks. Then reads each digit token (thousands separators dropped) with its unit: %, "per cent" or
 * "percent" make a percentage; a following "thousand", "million", "billion", "bn" or an attached "m"
 * multiplies. A digit run glued to letters ("2FA", "x86", "5G", "3rd", "COVID-19") is not a number.
 * With `words: true` (a source's seen text, never our own prose) two to twenty and the tens, and
 * compounds such as "twenty-one", are read as digits.
 */
export function numbersIn(text: string, opts: { words?: boolean } = {}): NumberToken[] {
  let s = text.normalize("NFKC");
  for (const re of NOT_NUMBERS) s = typeof re === "function" ? re(s) : s.replace(re, " ");
  if (opts.words) {
    s = s.replace(COMPOUND_RE, (_m, tens: string, unit: string) => String(TENS_WORDS[tens.toLowerCase()]! + SMALL_WORDS[unit.toLowerCase()]!));
    s = s.replace(WORD_RE, (w: string) => String(SMALL_WORDS[w.toLowerCase()] ?? TENS_WORDS[w.toLowerCase()]!));
  }
  const out: NumberToken[] = [];
  for (const m of s.matchAll(NUMBER_RE)) {
    const [raw, intPart, frac = "", pct, word, bn, m1] = m as unknown as [string, string, string | undefined, string?, string?, string?, string?];
    const multiplierKey = word?.trim().toLowerCase() ?? (bn ? "bn" : m1 ? "m" : null);
    const multiplier = multiplierKey ? MULTIPLIERS[multiplierKey]! : 1;
    const digits = intPart.replace(/,/g, "");
    const decimals = frac.length;
    const value = Number(`${digits}${decimals ? `.${frac}` : ""}`) * multiplier;
    const step = 10 ** -decimals * multiplier;
    const all = digits + frac;
    const trailingZeros = all.length - all.replace(/0+$/, "").length;
    const approxStep = all.replace(/0/g, "") === "" ? step : step * 10 ** trailingZeros;
    out.push({
      raw: raw.trim(),
      value: tidy(value),
      decimals,
      step: tidy(step),
      approx_step: tidy(approxStep),
      percent: Boolean(pct),
      approx: APPROX_RE.test(s.slice(Math.max(0, m.index - 30), m.index)),
    });
  }
  return out;
}

/** Words that make a ratio of the number before them: "10x faster", "five times more". */
const COMPARATIVES = "more|less|fewer|higher|lower|faster|slower|larger|bigger|greater|smaller|quicker|longer|shorter|wider";

/**
 * A digit run, with any decimals or thousands separators, glued to x or X ("9.9x", "10X", "1,000x"), with
 * no letter, digit, "_", ".", ",", hyphen, en dash, "/", "#" or "%" before it ("DIR-823X", "370/XP/38x") and
 * after it only whitespace, sentence punctuation and then whitespace, the end, or a hyphen and a
 * comparative ("10x-faster"; "3x-ui" is a name): a ratio unless gluedRatios() reads it as a name.
 */
const GLUED_RATIO_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_.,/#%${DASHES}])(\\d+(?:[.,]\\d+)*)([xX])` +
  `(?=$|\\s|[.,;:!?…)\\]}"'”’»]+(?:\\s|$)|[${DASHES}](?:${COMPARATIVES})(?![\\p{L}]))`, "gu");
/** A sentence's first word may be one of these before a ratio ("Nearly 10x more"); any other capitalised word is a name. */
const RATIO_LEAD_INS: ReadonlySet<string> = new Set(["a", "about", "almost", "also", "an", "and", "approximately", "around", "at",
  "but", "by", "close", "down", "even", "for", "from", "in", "just", "less", "more", "nearly", "now", "of", "on", "only", "or",
  "over", "roughly", "so", "some", "still", "than", "the", "then", "to", "under", "up", "with"]);
/** A version range after the token: "4.3x before 5.1". */
const VERSION_AFTER_RE = /^\s+(?:before|through|until|prior\s+to)\s+v?\d+\.\d/u;

/**
 * The word right before a glued token names a product, standard or release, so the token is a model
 * number, not a ratio: it holds a digit ("Ryzen 9 7950X", "4K 12X") or a capital letter ("Catalyst 9300X",
 * "Windows 9x", "iPhone 16x", "HTTP 30x"), unless it ends a clause ("October,"), is a possessive ("KEV's")
 * or opens a sentence as one of RATIO_LEAD_INS ("Nearly 10x more").
 */
function nameBefore(before: string): boolean {
  const m = /(\S+)\s+$/u.exec(before);
  if (!m) return false;
  const opener = /^[(\["'“‘]+/u.exec(m[1]!);
  const word = opener ? m[1]!.slice(opener[0].length) : m[1]!;
  if (!/[\p{L}\p{N}]$/u.test(word) || /['’]s$/u.test(word)) return false;
  if (/\p{N}/u.test(word)) return true;
  if (!/\p{Lu}/u.test(word)) return false;
  const opensSentence = opener !== null || /(?:^|[.!?:;]["'”’)\]]*)\s*$/u.test(before.slice(0, m.index));
  return !opensSentence || !RATIO_LEAD_INS.has(word.toLowerCase());
}

/**
 * The ratios a text writes glued to x, as written, in order (§4.12 NUMBER_FORM, §0.4 rows 145 and 147):
 * "9.9x the 2023–24 pace", "10x faster", "rose 5x.", "a 3x jump". Not a name: a GHSA id, a token glued to
 * a hyphen, "/" or a letter ("DIR-823X", "3x-ui", "0x1F", "x86"), a version or standard ("6.0.0x",
 * "802.1X", "4.3x before 5.1"), a hex prefix ("0x"), three or more digits before a capital X ("9300X",
 * "7950X"), or a token after a name word (nameBefore(): "Windows 9x", "SAP NetWeaver 7.5x", "HTTP 30x")
 * or before a capitalised one ("10x Genomics").
 */
export function gluedRatios(text: string): string[] {
  const s = text.normalize("NFKC").replace(GHSA_RE, (m) => " ".repeat(m.length));
  const out: string[] = [];
  for (const m of s.matchAll(GLUED_RATIO_RE)) {
    const [raw, num, x] = m as unknown as [string, string, string];
    if ((num.match(/\./gu)?.length ?? 0) > 1 || /^\d{3,}\./u.test(num)) continue; // "6.0.0x", "802.1X"
    if (/^0+$/u.test(num) || (x === "X" && /^\d{3,}$/u.test(num))) continue; // "0x", "9300X"
    const after = s.slice(m.index + raw.length);
    if (nameBefore(s.slice(0, m.index)) || /^\s+\p{Lu}/u.test(after) || VERSION_AFTER_RE.test(after)) continue;
    out.push(raw);
  }
  return out;
}

/** A number word from two up: "ten", "twenty-one", "a hundred", "two thousand"; never "one", "once" or "twice". */
const NUMBER_WORD = (() => {
  const units = "one|two|three|four|five|six|seven|eight|nine";
  const teens = "ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen";
  const tens = "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";
  const big = "hundred|thousand|million";
  return `(?:(?:a|${units}|${teens}|${tens})\\s+(?:${big})|(?:${big})|(?:${tens})(?:[\\s${DASHES}](?:${units}))?|${teens}|two|three|four|five|six|seven|eight|nine)`;
})();
/**
 * What follows "N times" when it is a ratio: a comparative, "as" (not "as of", "as well", "as part"),
 * "the" (not "the following", "the same", "the past" and other spans of time), "over" (not a span of time
 * or a number), "than", "that of", "those of", "what", "its" or "their". "Three times in October" and
 * "updated three times this year" are counts of occurrences.
 */
const RATIO_FOLLOWER =
  `(?:${COMPARATIVES}|than|that\\s+of|those\\s+of|what|its|their` +
  "|as(?!\\s+(?:of|well|part|a|an|in|on|at|for)(?![\\p{L}]))" +
  "|the(?!\\s+(?:following|same|past|last|next|previous|first|second|third|other|whole|entire|course|day|days|week|weeks|weekend" +
  "|month|months|year|years|quarter|night|morning|evening|afternoon|period)(?![\\p{L}]))" +
  "|over(?!\\s+(?:the\\s+|a\\s+|an\\s+)?(?:past|last|next|previous|first|same|whole|entire|course|weekend|period|days?|weeks?" +
  "|months?|years?|quarters?|nights?|summer|winter|spring|autumn|holidays?)(?![\\p{L}]))(?!\\s+\\d))(?![\\p{L}])";
/** "ten times the 2023–24 pace", "twenty-one times more": a ratio in words. */
const WORD_TIMES_RE = new RegExp(`(?<![\\p{L}\\p{N}${DASHES}])${NUMBER_WORD}\\s+times(?=\\s+${RATIO_FOLLOWER})`, "giu");
/** "tenfold", "ten-fold", "a hundredfold", but not "twofold: ..." or "a threefold approach", which name parts, not a ratio. */
const WORD_FOLD_RE = new RegExp(
  `(?<![\\p{L}\\p{N}${DASHES}])${NUMBER_WORD}[${DASHES}]?fold(?![\\p{L}\\p{N}])(?!\\s*:)` +
  "(?!\\s+(?:aim|answer|approach|benefit|challenge|concern|effect|goal|impact|issue|mission|nature|objective|plan|problem|process" +
  "|purpose|question|reason|response|risk|role|strategy|task|test|threat)s?(?![\\p{L}]))", "giu");
/** "is twofold", "are threefold": a thing of two or three parts. */
const PARTS_FOLD_RE = /(?:^|[^\p{L}])(?:is|are|was|were|be|been)\s+$/iu;

/**
 * The ratios a text writes in words, as written, in order (§4.12 NUMBER_FORM, §0.4 row 147): a number word
 * from two up, or a compound ("twenty-one", "a hundred"), then "times" and a comparison (RATIO_FOLLOWER:
 * "nearly ten times the 2023–24 pace", "five times more"), or "-fold" in one word or hyphenated ("tenfold",
 * "ten-fold"). Not "once", "twice" (the Gap headline prints "more than twice"), a count of occurrences
 * ("three times in October"), or "twofold" or "threefold" for a thing of two or three parts.
 */
export function wordRatios(text: string): string[] {
  const s = text.normalize("NFKC");
  const out: { at: number; raw: string }[] = [];
  for (const m of s.matchAll(WORD_TIMES_RE)) out.push({ at: m.index, raw: m[0] });
  for (const m of s.matchAll(WORD_FOLD_RE)) {
    if (/^(?:two|three)/iu.test(m[0]) && PARTS_FOLD_RE.test(s.slice(0, m.index))) continue;
    out.push({ at: m.index, raw: m[0] });
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.raw);
}

// ── Label figures (§4.12, §0.4 row 145) ──────────────────────────────────────────────────────────

/** A figure a quotable label prints with its unit word: "26 weeks", "2 to 30 days", "80% interval". */
export interface LabelFigure {
  /** As the label writes it. */
  text: string;
  /** Its number, or a range's two. */
  values: readonly number[];
  unit: "week" | "day" | "% interval";
  /** The label writes it as an age ("more than 365 days old"), so the prose may follow it with "old" too. */
  old: boolean;
}

/** Between a range's two numbers: " to ", or a hyphen or en dash with or without spaces. */
const RANGE_JOIN = `(?:\\s+to\\s+|\\s?[${DASHES}]\\s?)`;
const LABEL_FIGURE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}.,${DASHES}])(\\d+)(?:${RANGE_JOIN}(\\d+))?(?:\\s+(weeks?|days?)(?:(?:\\s+|[${DASHES}])(old))?|%\\s+(interval))(?![\\p{L}\\p{N}])`, "giu");

const YEAR_ONLY_RE = new RegExp(`^${YEAR}$`, "u");

/**
 * The figures a quotable label prints, in order: a number or a range ("2 to 30 days") with its unit word,
 * weeks or days, and the "80% interval" of an interval bound. Years and "2023–24" are not figures, nor is
 * a unit word without a number ("median days").
 */
export function labelFigures(label: string): LabelFigure[] {
  const out: LabelFigure[] = [];
  for (const m of label.normalize("NFKC").matchAll(LABEL_FIGURE_RE)) {
    const [text, a, b, unit, old, interval] = m as unknown as [string, string, string | undefined, string | undefined, string | undefined, string | undefined];
    if ([a, b].some((x) => x !== undefined && YEAR_ONLY_RE.test(x))) continue; // a year, as numbersIn() reads it
    out.push({
      text,
      values: b === undefined ? [Number(a)] : [Number(a), Number(b)],
      unit: interval ? "% interval" : unit!.toLowerCase().startsWith("week") ? "week" : "day",
      old: old !== undefined,
    });
  }
  return out;
}

/** The unit words in prose: "wk" and "wks" for weeks; "confidence" or "credible" may come before "interval". */
const UNIT_RES: Readonly<Record<LabelFigure["unit"], string>> = {
  week: "(?:weeks?|wks?)", day: "days?", "% interval": `(?:(?:confidence|credible)(?:\\s+|[${DASHES}]))?intervals?`,
};
/**
 * The unit word ends there, and is not followed by "long" ("26 weeks long") or, unless the label writes the
 * figure as an age, by "old" ("26-week-old"; "365 days old" when the label says "more than 365 days old").
 */
const unitEnd = (f: LabelFigure): string =>
  `(?![\\p{L}\\p{N}])(?!(?:\\s+|[${DASHES}])(?:${f.old ? "long" : "old|long"})(?![\\p{L}\\p{N}]))`;
/** Not glued to a word or a number, and not the end of a range ("13-26 weeks", "13 to 26 weeks", "between 13 and 26 weeks"). */
const FIGURE_START = `(?<![\\p{L}\\p{N}.,]|\\p{N}\\s?[${DASHES}]\\s?|\\p{N}\\s+to\\s+|between\\s+\\p{N}+(?:[.,]\\p{N}+)?\\s+and\\s+)`;

/**
 * A figure written as one in prose: any case, a space or a hyphen or dash before its unit, singular or plural.
 * A range is joined as the label joins it, or written "between 2 and 30 days"; "2 and 30 days" without the
 * "between" is two numbers.
 */
function figureRe(f: LabelFigure): RegExp {
  const [a, b] = f.values.map((v) => String(v));
  const num = b === undefined ? a : `(?:between\\s+${a}\\s+and\\s+${b}|${a}${RANGE_JOIN}${b})`;
  const pct = f.unit === "% interval" ? "(?:\\s?%|\\s?per\\s?cent|\\s?percent)" : "";
  return new RegExp(`${FIGURE_START}${num}${pct}(?=(?:\\s+|[${DASHES}])${UNIT_RES[f.unit]}${unitEnd(f)})`, "giu");
}

/**
 * numbersIn() of `text` without the given label figures where they are written as figures (§4.12, §0.4
 * row 145): "26 weeks", "26-week", "26–week", "26 wks", "26 Weeks"; "2 to 30 days", "2-30 days",
 * "2–30 days", "between 2 and 30 days"; "80% interval", "80% confidence interval", "80% credible
 * interval". Each entry of `figures` leaves out one written occurrence, the first in
 * text order, so a figure given once and written twice counts the second time ("within 7 days, 7 days
 * sooner"). A figure followed by "long" ("26 weeks long"), or by "old" ("26-week-old flaws") unless its
 * label writes it as an age ("more than 365 days old"), still counts, as does any other number, and any
 * figure not given. A metric Angle reads its text this way with the figures of its path's quotable labels
 * (lib/rules/grounding.ts angleNumbers()).
 */
export function numbersBesideFigures(text: string, figures: readonly LabelFigure[]): NumberToken[] {
  let s = text.normalize("NFKC");
  const times = new Map<string, { f: LabelFigure; n: number }>();
  for (const f of figures) {
    const t = times.get(f.text);
    if (t) t.n += 1;
    else times.set(f.text, { f, n: 1 });
  }
  // Ranges first, so a range's own end is never read as a figure on its own.
  for (const { f, n } of [...times.values()].sort((x, y) => y.f.values.length - x.f.values.length)) {
    let left = n;
    s = s.replace(figureRe(f), (m) => (left-- > 0 ? " " : m));
  }
  return numbersIn(s);
}

/** Removes binary noise from a product of a decimal and a power of ten (0.1 * 1e6 is 100000.00000000001). */
function tidy(x: number): number {
  return Number(x.toPrecision(15));
}

/** Half away from zero, with a tolerance so a binary representation cannot move a half (0.145 / 0.01). */
function roundHalfAway(q: number): number {
  const a = Math.abs(q);
  const r = Math.floor(a + 0.5 + 1e-9 + 1e-12 * a);
  return q < 0 ? -r : r;
}

/**
 * §4.12's matching rule: `value` matches our number when, rounded to our number's decimal places (its
 * `step`), it equals our number; after an approximation word, rounded at our number's last non-zero
 * digit ("about 1,400" matches 1,393). Units are the caller's business (compare `percent` first). Against
 * the metrics, matching is exact equality instead: `ours.value === theirs.value`.
 */
export function numberMatches(ours: NumberToken, value: number): boolean {
  const step = ours.approx ? ours.approx_step : ours.step;
  return roundHalfAway(Math.abs(value) / step) === roundHalfAway(ours.value / step);
}
