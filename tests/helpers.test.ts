// The pure P1 helpers: lib/format.ts, lib/text.ts, lib/sources.ts, lib/items.ts and lib/apply.ts's
// dropUnverified() (SPEC §4.6, §4.12, §5.2, §7).
import { afterEach, describe, expect, it } from "vitest";
import { dropUnverified, type SoftIssue } from "@/lib/apply";
import { dayMonth, longDate, monthShort, shortDate, taipeiTime } from "@/lib/format";
import {
  actorNexusOf, compareItems, firstOutOfOrder, hasLowConfidenceMarker, itemRank, orderItems, publicExploitOf, rowsByHead,
  severityAtLeast, TOP_STORY_COUNT,
} from "@/lib/items";
import type { Attribution } from "@/lib/schema/common";
import { SourceTiersFile, VendorsFile } from "@/lib/schema/config";
import { DraftBrief } from "@/lib/schema/draft-brief";
import type { DraftItem } from "@/lib/schema/item";
import { blockedReason, compileTier1Paths, isGithubTier1, publisherFor, urlOnAnyDomain, urlOnDomain, type PublisherConfig } from "@/lib/sources";
import { countWords, jaccard, labelFigures, numberMatches, numbersBesideFigures, numbersIn, splitSentences, wordSet } from "@/lib/text";
import { TAIWAN_LENS_ROWS, type KindId, type Severity } from "@/lib/vocab";

// ── format ───────────────────────────────────────────────────────────────────────────────────────

describe("format", () => {
  const keepTz = process.env.TZ;
  afterEach(() => {
    if (keepTz === undefined) delete process.env.TZ;
    else process.env.TZ = keepTz;
  });

  it("writes the §7 forms", () => {
    expect(longDate("2026-11-08")).toBe("Sunday 8 November 2026");
    expect(shortDate("2026-11-07")).toBe("7 Nov 2026");
    expect(shortDate("2026-11-06")).toBe("6 Nov 2026");
    expect(dayMonth("2026-11-03")).toBe("3 Nov");
    expect(taipeiTime("2026-11-07T21:12:00Z")).toBe("05:12");
    expect(taipeiTime("2026-11-08T05:12:30+08:00")).toBe("05:12");
  });

  it("never reads the machine's time zone", () => {
    for (const tz of ["UTC", "Asia/Taipei", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      expect(longDate("2026-01-01")).toBe("Thursday 1 January 2026");
      expect(shortDate("2025-12-31")).toBe("31 Dec 2025");
      expect(taipeiTime("2026-11-07T20:37:00Z")).toBe("04:37");
    }
  });

  it("names every month and rejects invalid dates", () => {
    expect(Array.from({ length: 12 }, (_, i) => monthShort(i + 1)).join(" ")).toBe("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec");
    expect(dayMonth("2026-09-30")).toBe("30 Sep");
    for (const bad of ["2026-02-30", "2026-13-01", "8 Nov 2026", ""]) expect(() => longDate(bad)).toThrow();
    expect(() => monthShort(13)).toThrow();
  });
});

// ── text ─────────────────────────────────────────────────────────────────────────────────────────

describe("countWords (kept)", () => {
  it("still counts as Europe's did", () => {
    expect(countWords("A 13-week window, 1,800 records and 05:58 Taipei")).toBe(8);
  });
});

describe("jaccard", () => {
  it("compares lower-cased word sets", () => {
    expect(jaccard("a b c d e", "a b c d f")).toBeCloseTo(4 / 6);
    expect(jaccard("Microsoft patches Exchange", "MICROSOFT patches exchange!")).toBe(1);
    expect(jaccard("one two", "three four")).toBe(0);
    expect(jaccard("", "")).toBe(1);
    expect(jaccard("", "x")).toBe(0);
  });

  it("reads Han and Kana runs as character bigrams", () => {
    expect([...wordSet("資安漏洞")]).toEqual(["資安", "安漏", "漏洞"]);
    expect([...wordSet("ゼロデイ攻撃 CVE")]).toEqual(["ゼロ", "ロデ", "デイ", "イ攻", "攻撃", "cve"]);
    expect([...wordSet("中 華")]).toEqual(["中", "華"]);
  });

  it("scores two iThome-style titles one character apart at 0.8 or more", () => {
    const a = "微軟修補Exchange零時差漏洞，已遭駭客鎖定大規模攻擊企業用戶";
    const b = "微軟修補Exchange零時差漏洞，已被駭客鎖定大規模攻擊企業用戶";
    expect(jaccard(a, b)).toBeGreaterThanOrEqual(0.8);
    expect(jaccard("台積電遭勒索軟體攻擊，供應商資料外洩", "日本電信業者遭勒索軟體攻擊，用戶資料外洩")).toBeLessThan(0.8);
  });
});

describe("splitSentences", () => {
  it("splits after . ! or ? and whitespace, never after an abbreviation", () => {
    expect(splitSentences("The U.S. agency said so. Inc. was not. It ended “here.” Next (e.g. this) one! And no. Then? Done"))
      .toEqual(["The U.S. agency said so.", "Inc. was not.", "It ended “here.”", "Next (e.g. this) one!", "And no.", "Then?", "Done"]);
    expect(splitSentences("Patched in 4.2.7 on Nov. 5. Exploited since Jan. 3, per Acme Corp. officials.")).toEqual([
      "Patched in 4.2.7 on Nov. 5.", "Exploited since Jan. 3, per Acme Corp. officials.",
    ]);
    expect(splitSentences("One sentence only")).toEqual(["One sentence only"]);
    expect(splitSentences("  ")).toEqual([]);
  });

  it("ends a sentence on May. (no abbreviation) but not on No.", () => {
    expect(splitSentences("It was fixed in May. Then it broke.")).toEqual(["It was fixed in May.", "Then it broke."]);
    expect(splitSentences("Advisory No. 5 lists it.")).toEqual(["Advisory No. 5 lists it."]);
  });
});

describe("labelFigures and numbersBesideFigures (row 145)", () => {
  const figs = (label: string) => labelFigures(label).map((f) => [f.text, f.values, f.unit]);
  it("reads each figure a quotable label prints, with its unit word; years, 2023–24 and bare unit words are not figures", () => {
    expect(figs("share already exploited at disclosure, 26 weeks")).toEqual([["26 weeks", [26], "week"]]);
    expect(figs("AI-credited records excluding Anthropic, 13 weeks")).toEqual([["13 weeks", [13], "week"]]);
    expect(figs("share listed within 7 days, 26 weeks")).toEqual([["7 days", [7], "day"], ["26 weeks", [26], "week"]]);
    expect(figs("n-day race (listed 2 to 30 days after), 26 weeks")).toEqual([["2 to 30 days", [2, 30], "day"], ["26 weeks", [26], "week"]]);
    expect(figs("listed 31 to 365 days after, 2023–24")).toEqual([["31 to 365 days", [31, 365], "day"]]);
    expect(figs("old flaws newly listed (more than 365 days old), 13 weeks")).toEqual([["365 days old", [365], "day"], ["13 weeks", [13], "week"]]);
    expect(figs("80% interval low, listed within 7 days, 26 weeks")).toEqual([["80% interval", [80], "% interval"], ["7 days", [7], "day"], ["26 weeks", [26], "week"]]);
    expect(figs("KEV additions for Taiwanese vendors, 30 days")).toEqual([["30 days", [30], "day"]]);
    expect(figs("KEV additions for Japanese vendors, 90 days")).toEqual([["90 days", [90], "day"]]);
    expect(figs("2023–24 pace of old flaws newly listed, 26 weeks")).toEqual([["26 weeks", [26], "week"]]);
    expect(figs("KEV additions, pace vs 2023–24, 26 weeks")).toEqual([["26 weeks", [26], "week"]]);
    for (const none of ["median days to listing for the rest, 2023–24", "weeks in the window", "share already exploited at disclosure, 2023–24",
      "KEV additions, 2023 weeks", "2023–24 days"]) expect(figs(none), none).toEqual([]);
  });

  const raw = (t: string, label: string) => numbersBesideFigures(t, labelFigures(label)).map((n) => n.raw);
  const W26 = "share already exploited at disclosure, 26 weeks";
  it("leaves out a figure written as one: any case, singular or plural, a space or any hyphen or dash, wk and wks", () => {
    for (const t of ["37% over the last 26 weeks.", "In the 26-week Window, 37% were exploited.", "37% (26 Weeks).", "37% IN 26 WEEKS.",
      "37% in the 26\u2010week view.", "37% in the 26\u2011week view.", "37% in the 26–week view.", "37% over 26 week.", "37% over 26 wks.",
      "37% over 26-wk.", "37% in 26  weeks.", "37% in 26 weeks’ data.", "37% in ２６ weeks."]) expect(raw(t, W26), t).toEqual(["37%"]);
    // A range: "N to M", or a hyphen or en dash, with or without spaces.
    const nDay = "n-day race (listed 2 to 30 days after), 26 weeks";
    for (const t of ["39% were listed 2 to 30 days after, in 26 weeks.", "39% were listed 2-30 days after.", "39% were listed 2–30 days after.",
      "39% were listed 2 – 30 days after.", "39% were listed 2 TO 30 DAYS after."]) expect(raw(t, nDay), t).toEqual(["39%"]);
    expect(raw("The 80% interval of the 26-week share starts at 32%.", "80% interval low, at disclosure, 26 weeks")).toEqual(["32%"]);
    expect(raw("The 80 per cent interval starts at 32%.", "80% interval low, at disclosure, 26 weeks")).toEqual(["32%"]);
    expect(raw("CISA listed 1 in the past 30 days.", "KEV additions for Taiwanese vendors, 30 days")).toEqual(["1"]);
    expect(raw("55% were listed within 7 days, a 7-day window.", "share listed within 7 days, 26 weeks")).toEqual(["55%"]);
  });
  it("counts the figure when its unit runs on into old or long, or it is part of another number or range", () => {
    expect(raw("37% of 26-week-old flaws.", W26)).toEqual(["37%", "26"]);
    expect(raw("37%, in a window 26 weeks long.", W26)).toEqual(["37%", "26"]);
    expect(raw("37%, in a 26-week-long window.", W26)).toEqual(["37%", "26"]);
    expect(raw("37% in 13 weeks.", W26)).toEqual(["37%", "13"]);
    expect(raw("37% of 26 flaws in 26 days.", W26)).toEqual(["37%", "26", "26"]);
    expect(raw("37% over 126 weeks or 26.5 weeks or 1,26 weeks.", W26)).toEqual(["37%", "126", "26.5"]);
    expect(raw("37% over 26 weekdays.", W26)).toEqual(["37%", "26"]);
    expect(raw("37% over 13-26 weeks, or 13 to 26 weeks, or 26 to 52 weeks.", W26)).toEqual(["37%", "13", "26", "13", "26", "26", "52"]);
    // A range's ends are not figures on their own, and the label's 80% is only "80% interval".
    const nDay = "n-day race (listed 2 to 30 days after), 26 weeks";
    expect(raw("39% were listed 30 days after.", nDay)).toEqual(["39%", "30"]);
    expect(raw("80% of flaws, 32%.", "80% interval low, at disclosure, 26 weeks")).toEqual(["80%", "32%"]);
  });
  it("lets a figure run on into old when its label writes it as an age, and only then", () => {
    const OLD = "old flaws newly listed (more than 365 days old), 26 weeks";
    for (const t of ["CISA newly listed 22 flaws more than 365 days old in the last 26 weeks.", "22 flaws over 365 days old, in 26 weeks.",
      "22 365-day-old flaws in 26 weeks.", "22 flaws older than 365 days in 26 weeks."]) expect(raw(t, OLD), t).toEqual(["22"]);
    // The label's 26 weeks is a window, not an age, and "long" never labels.
    expect(raw("22 flaws, 26 weeks old.", OLD)).toEqual(["22", "26"]);
    expect(raw("22 flaws, a 365 days long wait.", OLD)).toEqual(["22", "365"]);
    // A label that prints 365 days without "old" lets no "365 days old" through.
    expect(raw("37 flaws 365 days old.", "listed 31 to 365 days after, 26 weeks")).toEqual(["37", "365"]);
    expect(raw("22 flaws 365 days old.", "old flaws newly listed (more than 365 days), 26 weeks")).toEqual(["22", "365"]);
  });
  it("with no figures, or for a label without any, is numbersIn()", () => {
    expect(numbersBesideFigures("37% in 26 weeks.", [])).toEqual(numbersIn("37% in 26 weeks."));
    expect(raw("37% in 26 weeks.", "share already exploited at disclosure, 2023–24")).toEqual(["37%", "26"]);
  });
});

describe("numbersIn", () => {
  const read = (text: string, words = false) => numbersIn(text, { words }).map((n) => [n.raw, n.value, n.percent, n.approx]);

  it("reads the Gap headline's numbers and skips the reference years", () => {
    expect(read("37% of recently disclosed flaws on CISA's exploited list were already being exploited when disclosed (2023–24: 37%, no clear change)."))
      .toEqual([["37%", 37, true, false], ["37%", 37, true, false]]);
    expect(read("Flood: 44,944 new CVE records in 13 weeks, 5.2 times the 2023–24 pace (5.0 times excluding the Linux kernel)."))
      .toEqual([["44,944", 44944, false, false], ["13", 13, false, false], ["5.2", 5.2, false, false], ["5.0", 5, false, false]]);
    expect(read("KEV additions for Taiwanese vendors: 0 in 30 days, 1 in 90, to 6 Nov (US date). Too few (n=12)."))
      .toEqual([["0", 0, false, false], ["30", 30, false, false], ["1", 1, false, false], ["90", 90, false, false], ["12", 12, false, false]]);
  });

  it("removes ids, dates, times, years, versions and section marks", () => {
    const text = "CVE-2026-104935 and GHSA-abcd-efgh-ijkl on 2026-11-05T04:50:12+08:00, 2026-11-05, at 05:12 and 9 pm, "
      + "on 21 Oct, 21st October, October 21 and Nov. 3, in 2024, the 2020s, 2023-24, 2023–2024, version 4.2.7, v2.1, 10.0.0.1, §4.12.";
    expect(read(text)).toEqual([]);
  });

  it("reads units and multipliers, and skips digits glued to words", () => {
    expect(read("$4.5m, 2.3bn, 12 million, 3 thousand, 40 per cent, 7 percent, 15 %")).toEqual([
      ["4.5m", 4_500_000, false, false], ["2.3bn", 2_300_000_000, false, false], ["12 million", 12_000_000, false, false],
      ["3 thousand", 3000, false, false], ["40 per cent", 40, true, false], ["7 percent", 7, true, false], ["15 %", 15, true, false],
    ]);
    expect(read("COVID-19, 2FA, x86, 5G, 3rd, 1.5x, H1, 10-15 days, 13-week window")).toEqual([
      ["10", 10, false, false], ["15", 15, false, false], ["13", 13, false, false],
    ]);
  });

  it("marks approximations and reads number words only in seen text", () => {
    expect(read("about 1,400 hosts, ~300 victims, more than 2 million records, nearly 40%")).toEqual([
      ["1,400", 1400, false, true], ["300", 300, false, true], ["2 million", 2_000_000, false, true], ["40%", 40, true, true],
    ]);
    expect(read("three hosts and twenty-one victims, one flaw")).toEqual([]);
    expect(read("three hosts and twenty-one victims, one flaw, Ninety", true)).toEqual([
      ["3", 3, false, false], ["21", 21, false, false], ["90", 90, false, false],
    ]);
  });

  it("matches at our number's decimal places, or its last non-zero digit after an approximation", () => {
    const [about] = numbersIn("about 1,400");
    expect(numberMatches(about!, 1393)).toBe(true);
    expect(numberMatches(about!, 1449)).toBe(true);
    expect(numberMatches(about!, 1450)).toBe(false);
    const [exact] = numbersIn("1,400");
    expect(numberMatches(exact!, 1400)).toBe(true);
    expect(numberMatches(exact!, 1393)).toBe(false);
    const [share] = numbersIn("0.15");
    expect(numberMatches(share!, 0.145)).toBe(true);
    expect(numberMatches(share!, 0.144)).toBe(false);
    const [ratio] = numbersIn("5.2 times");
    expect(numberMatches(ratio!, 5.2498)).toBe(true);
    expect(numberMatches(ratio!, 5.25)).toBe(false);
    const [big] = numbersIn("4.5 million");
    expect(numberMatches(big!, 4_460_000)).toBe(true);
    expect(numberMatches(big!, 4_440_000)).toBe(false);
  });
});

// ── sources ──────────────────────────────────────────────────────────────────────────────────────

const publisher = (id: string, name: string, tier: 1 | 2 | 3, kind: string, domains: string[], extra: Record<string, unknown> = {}) => ({
  id, name, tier, kind, country: "US", domains, state_label: null, sole_newsroom_for_critical: true, ...extra,
});

const sourceTiers = SourceTiersFile.parse({
  schema_version: 1, version: 1, updated: "2026-11-08",
  publishers: [
    publisher("cve-org", "CVE Program", 1, "other", ["cve.org", "cve.mitre.org"]),
    publisher("github-advisories", "GitHub Advisory Database", 1, "other", ["github.com"]),
    publisher("cisa", "CISA", 1, "government", ["cisa.gov"]),
    publisher("cisa-kev", "CISA KEV catalog", 1, "government", ["cisa.gov/known-exploited-vulnerabilities-catalog"]),
    publisher("microsoft-threat-intelligence", "Microsoft Threat Intelligence", 1, "research", ["microsoft.com/en-us/security/blog"]),
    publisher("fortiguard-labs", "FortiGuard Labs", 1, "research", ["fortiguard.com"]),
    publisher("bleepingcomputer", "BleepingComputer", 2, "newsroom", ["bleepingcomputer.com"]),
    publisher("the-hacker-news", "The Hacker News", 2, "newsroom", ["thehackernews.com"], { sole_newsroom_for_critical: false }),
    publisher("xinhua", "Xinhua", 3, "state_media", ["xinhuanet.com", "news.cn"], { country: "CN", state_label: "PRC state media" }),
  ],
  github: { tier1_paths: ["^/advisories/GHSA-[\\w-]+", "^/[^/]+/[^/]+/security/advisories/GHSA-[\\w-]+", "^/CVEProject/", "^/cisagov/", "^/github/advisory-database/"] },
});

const vendor = (id: string, name: string, country: string | null, domains: string[]) => ({
  id, name, country, widely_deployed: true, aliases: [], cna: [], domains, note: null,
});

const vendors = VendorsFile.parse({
  schema_version: 1, version: 1, updated: "2026-11-08",
  vendors: [
    vendor("microsoft", "Microsoft", "US", ["microsoft.com", "msrc.microsoft.com"]),
    vendor("qnap", "QNAP", "TW", ["qnap.com"]),
    vendor("fortinet", "Fortinet", "US", ["fortinet.com", "fortiguard.com"]),
  ],
});

const cfg: PublisherConfig = { sourceTiers, vendors };
const who = (url: string, type: Parameters<typeof publisherFor>[1] = "press") => {
  const p = publisherFor(url, type, cfg);
  return `${p.publisher} t${p.tier} ${p.kind}`;
};

describe("publisherFor", () => {
  it("finds listed publishers on the host or a parent, www or not", () => {
    expect(who("https://www.cve.org/CVERecord?id=CVE-2026-104935", "cve_record")).toBe("cve-org t1 other");
    expect(who("https://www.bleepingcomputer.com/ct-sample/qnap")).toBe("bleepingcomputer t2 newsroom");
    expect(who("https://english.news.cn/ct-sample/x")).toBe("xinhua t3 state_media");
    expect(publisherFor("https://english.news.cn/ct-sample/x", "press", cfg).state_label).toBe("PRC state media");
    expect(publisherFor("https://thehackernews.com/ct-sample/x", "press", cfg).sole_newsroom_for_critical).toBe(false);
  });

  it("takes the longest matching domain, a path entry before its host entry", () => {
    expect(who("https://www.cisa.gov/known-exploited-vulnerabilities-catalog")).toBe("cisa-kev t1 government");
    expect(who("https://www.cisa.gov/Known-Exploited-Vulnerabilities-Catalog/")).toBe("cisa-kev t1 government");
    expect(who("https://www.cisa.gov/known-exploited-vulnerabilities-catalogue")).toBe("cisa t1 government");
    expect(who("https://www.cisa.gov/news-events/alerts/ct-sample")).toBe("cisa t1 government");
    expect(who("https://www.microsoft.com/en-us/security/blog/2026/11/05/ct-sample")).toBe("microsoft-threat-intelligence t1 research");
    expect(who("https://msrc.microsoft.com/update-guide/vulnerability/CVE-2026-104935")).toBe("vendor:microsoft t1 vendor");
    expect(who("https://www.microsoft.com/en-us/download")).toBe("vendor:microsoft t1 vendor");
  });

  it("makes vendor domains implicit tier 1 publishers unless source-tiers.json lists the same domain", () => {
    const qnap = publisherFor("https://www.qnap.com/en/security-advisory/qsa-26-01", "vendor_advisory", cfg);
    expect(qnap).toEqual({ tier: 1, publisher: "vendor:qnap", publisher_name: "QNAP", kind: "vendor", state_label: null, sole_newsroom_for_critical: true });
    expect(who("https://sub.qnap.com/x")).toBe("vendor:qnap t1 vendor");
    expect(who("https://www.fortiguard.com/psirt/ct-sample")).toBe("fortiguard-labs t1 research");
    expect(who("https://www.fortinet.com/blog/ct-sample")).toBe("vendor:fortinet t1 vendor");
    expect(who("https://notqnap.com/x")).toBe("host:notqnap.com t3 other");
  });

  it("gives github.com tier 1 only on a tier1_paths path, compared lower-cased", () => {
    expect(who("https://github.com/advisories/GHSA-abcd-efgh-ijkl", "cve_record")).toBe("github-advisories t1 other");
    expect(who("https://github.com/CVEProject/cvelistV5", "cve_record")).toBe("github-advisories t1 other");
    expect(who("https://github.com/%43VEProject/cvelistV5", "cve_record")).toBe("github-advisories t1 other");
    expect(who("https://github.com/example/example/security/advisories/GHSA-abcd-efgh-ijkl")).toBe("github-advisories t1 other");
    expect(who("https://github.com/example/example", "victim")).toBe("host:github.com t3 other");
    expect(who("https://docs.github.com/en")).toBe("host:docs.github.com t3 other");
    expect(isGithubTier1("https://github.com/cisagov/kev-data", sourceTiers)).toBe(true);
    expect(isGithubTier1("https://github.com/example/example", sourceTiers)).toBe(false);
    expect(isGithubTier1("https://www.cve.org/", sourceTiers)).toBe(false);
    expect(compileTier1Paths(sourceTiers).every((re) => re.flags === "iu")).toBe(true);
  });

  it("makes an unlisted host tier 3, or tier 1 for a victim's own statement", () => {
    expect(publisherFor("https://example.org/sample/notice", "press", cfg))
      .toEqual({ tier: 3, publisher: "host:example.org", publisher_name: "example.org", kind: "other", state_label: null, sole_newsroom_for_critical: true });
    expect(who("https://www.example.org/sample/notice", "victim")).toBe("host:example.org t1 other");
    expect(who("not a url")).toBe("host:invalid t3 other");
  });

  it("follows a config copy: a changed tier is read, not cached across objects", () => {
    const copy = structuredClone(sourceTiers);
    copy.publishers.find((p) => p.id === "bleepingcomputer")!.tier = 3;
    expect(publisherFor("https://www.bleepingcomputer.com/x", "press", { sourceTiers: copy, vendors }).tier).toBe(3);
    expect(publisherFor("https://www.bleepingcomputer.com/x", "press", cfg).tier).toBe(2);
  });
});

describe("blockedReason and domain checks", () => {
  it("reads BLOCKED_HOSTS and blocks github.com paths outside tier1_paths", () => {
    expect(blockedReason("https://www.exploit-db.com/", sourceTiers)).toBe("exploit_code");
    expect(blockedReason("https://news.google.com/", sourceTiers)).toBe("redirect");
    expect(blockedReason("https://github.com/example/example", sourceTiers)).toBe("exploit_code");
    expect(blockedReason("https://github.com/advisories/GHSA-abcd-efgh-ijkl", sourceTiers)).toBeNull();
    expect(blockedReason("https://www.bleepingcomputer.com/", sourceTiers)).toBeNull();
    expect(blockedReason("not a url", sourceTiers)).toBeNull();
  });

  it("checks a URL against config domain entries (vendor_confirmed and vendor_advisory evidence)", () => {
    expect(urlOnAnyDomain("https://www.qnap.com/en/security-advisory/qsa-26-01", ["qnap.com"])).toBe(true);
    expect(urlOnAnyDomain("https://qnap.com.example.org/x", ["qnap.com"])).toBe(false);
    expect(urlOnDomain("https://www.microsoft.com/en-us/security/blog/x", "microsoft.com/en-us/security/blog")).toBe(true);
    expect(urlOnDomain("https://www.microsoft.com/en-us/download", "microsoft.com/en-us/security/blog")).toBe(false);
  });
});

// ── items ────────────────────────────────────────────────────────────────────────────────────────

function item(id: string, kind: KindId, severity: Severity | null, extra: Partial<DraftItem> = {}): DraftItem {
  return {
    id, kind, headline: `SAMPLE headline ${id}`, summary: "SAMPLE summary.", why_it_matters: null, severity, landmark: false,
    ai_role: "none", ai_role_secondary: null, ai_confidence: null, ai_claimant: null, ai_evidence: [], claim_type: "independent",
    regions: ["GLOBAL"], topics: [], attribution: [], incident: null, cve_ids: [], release_id: null, flaw_evidence: [],
    exploit_reported_in_sources: null, exposure: null, standing_story: null, source_ids: ["s1"], ...extra,
  };
}

describe("orderItems", () => {
  const items = [
    item("pol-a", "policy", null),
    item("inc-retail-nl-2026-10", "breach", "high"),
    item("cve-2026-104935", "exploited_flaw", "high"),
    item("ai-landmark", "ai_capability", null, { landmark: true }),
    item("camp-x", "campaign", "elevated"),
    item("pt-microsoft-2026-11", "patch_batch", "elevated"),
    item("vuln-x", "critical_flaw", "critical"),
    item("eco-x", "ecosystem", null),
  ];

  it("ranks by severity (a landmark as Elevated, other severity-less items 0), then kind", () => {
    expect(items.map(itemRank)).toEqual([0, 3, 3, 2, 2, 2, 4, 0]);
    expect(compareItems(items[2]!, items[1]!)).toBeLessThan(0); // exploited flaw before breach at equal severity
    expect(severityAtLeast("high", "elevated")).toBe(true);
    expect(severityAtLeast(null, "watch")).toBe(false);
  });

  it("puts the top three first and groups the rows by head in HEADS order", () => {
    const ordered = orderItems(items).map((i) => i.id);
    expect(ordered).toEqual([
      "vuln-x", "cve-2026-104935", "inc-retail-nl-2026-10",
      "pt-microsoft-2026-11", // exploits
      "ai-landmark", "eco-x", // ai_frontier
      "camp-x", "pol-a", // policy_actors
    ]);
    expect(TOP_STORY_COUNT).toBe(3);
    expect(rowsByHead(orderItems(items)).map((g) => [g.head, g.items.map((i) => i.id)])).toEqual([
      ["exploits", ["pt-microsoft-2026-11"]], ["ai_frontier", ["ai-landmark", "eco-x"]], ["policy_actors", ["camp-x", "pol-a"]],
    ]);
  });

  it("keeps the agent's order on ties and reports the first item out of place", () => {
    const ties = [item("cve-2026-1001", "exploited_flaw", "high"), item("cve-2026-1002", "exploited_flaw", "high")];
    expect(orderItems(ties).map((i) => i.id)).toEqual(["cve-2026-1001", "cve-2026-1002"]);
    expect(firstOutOfOrder(orderItems(items))).toBeNull();
    expect(firstOutOfOrder(items)).toEqual({ index: 0, expected_index: 7, id: "pol-a" });
    expect(orderItems([])).toEqual([]);
  });
});

describe("actor_nexus and public_exploit", () => {
  const entry = (nexus: Attribution["nexus"], level: Attribution["confidence_level"], basis: Attribution["basis"] = "vendor", text: string | null = "high confidence") =>
    ({ nexus, confidence_level: level, basis, confidence_text: text });

  it("takes the nexus every qualifying entry agrees on, else unknown", () => {
    expect(actorNexusOf([])).toBeNull();
    expect(actorNexusOf([entry("prc", "high")])).toBe("prc");
    expect(actorNexusOf([entry("prc", "high"), entry("prc", "moderate", "media", "moderate confidence")])).toBe("prc");
    expect(actorNexusOf([entry("prc", "high"), entry("russia", "high")])).toBe("unknown");
    expect(actorNexusOf([entry("prc", "high"), entry("russia", "low", "vendor", "low confidence")])).toBe("prc");
    expect(actorNexusOf([entry("prc", "low", "vendor", "low confidence")])).toBe("unknown");
    expect(actorNexusOf([entry("dprk", "unstated", "government", null)])).toBe("dprk");
    expect(actorNexusOf([entry("dprk", "unstated", "vendor", null)])).toBe("unknown");
    expect(actorNexusOf([entry("iran", "high", "vendor", "high confidence, possibly linked")])).toBe("unknown");
  });

  it("finds low-confidence markers as whole words, a hyphen and a space alike", () => {
    expect(hasLowConfidenceMarker("assessed with low-confidence")).toBe(true);
    expect(hasLowConfidenceMarker("Low Confidence")).toBe(true);
    expect(hasLowConfidenceMarker("a suspected link")).toBe(true);
    expect(hasLowConfidenceMarker("it is impossible to say")).toBe(false);
    expect(hasLowConfidenceMarker(null)).toBe(false);
  });

  it("sets public_exploit for flaw kinds only", () => {
    expect(publicExploitOf({ kind: "exploited_flaw", exploit_reported_in_sources: null, cves: [{ exploit_reference: true }] })).toBe("yes");
    expect(publicExploitOf({ kind: "critical_flaw", exploit_reported_in_sources: true, cves: [] })).toBe("yes");
    expect(publicExploitOf({ kind: "patch_batch", exploit_reported_in_sources: false, cves: [{ exploit_reference: false }] })).toBe("no");
    expect(publicExploitOf({ kind: "breach", exploit_reported_in_sources: true, cves: [] })).toBeNull();
  });
});

// ── apply: dropUnverified ────────────────────────────────────────────────────────────────────────

function draft(): DraftBrief {
  return DraftBrief.parse({
    schema_version: 1, date: "2026-11-08", generated_at: "2026-11-08T05:01:00+08:00",
    lead: [
      { text: "SAMPLE lead about the critical flaw.", item_ids: ["vuln-a"], gap: false },
      { text: "SAMPLE lead about two items.", item_ids: ["cve-2026-104935", "inc-retail-nl-2026-10"], gap: false },
    ],
    angle: {
      text: "SAMPLE angle with 37% in it.", source_id: "s1", metric_path: null, as_of: "2026-11-06", counterpoint: "none found",
      counterpoint_source_ids: [], claim_id: null,
    },
    region_raises: [{ region: "TW", reason: "SAMPLE raise.", trigger_class: "confirmed_breach", item_ids: ["inc-retail-nl-2026-10"] }],
    items: [
      item("vuln-a", "critical_flaw", "critical"),
      item("cve-2026-104935", "exploited_flaw", "high"),
      item("inc-retail-nl-2026-10", "breach", "high"),
      item("pol-b", "policy", null),
    ],
    taiwan_lens: {
      analysis: "SAMPLE analysis.", item_ids: ["vuln-a", "pol-b"], source_ids: [],
      rows: TAIWAN_LENS_ROWS.map((row) => ({ row, text: row === "gov_infra" ? "SAMPLE row." : null, item_ids: row === "gov_infra" ? ["inc-retail-nl-2026-10"] : [], source_ids: [] })),
      japan: { text: "SAMPLE Japan.", item_ids: ["cve-2026-104935"], source_ids: [] },
    },
    scoreboard_entries: [
      { claim_id: "SB-01", summary: "SAMPLE.", quote: "SAMPLE quote", quote_source_id: "s1", reported_value: null, claim_type: "independent", meets: null },
      { claim_id: "SB-02", summary: "SAMPLE.", quote: "SAMPLE quote two", quote_source_id: "s1", reported_value: null, claim_type: "independent", meets: null },
    ],
    week_in_review: null, corrections: [], elsewhere: [],
    sources: [{ id: "s1", title: "SAMPLE", title_en: null, language: "en", outlet: "SAMPLE", url: "https://example.org/sample/a", source_type: "press", published_at: null }],
  });
}

describe("dropUnverified", () => {
  const issues: SoftIssue[] = [
    { code: "SNAP_MISSING", path: "items[0]" }, // Critical: dropped
    { code: "SNAP_NUMBER", path: "items[1].summary" }, // dropped
    { code: "SNAP_MISSING", path: "items[2]" }, // High: kept
    { code: "SOURCE_ORPHAN", path: "sources[0]" }, // not a soft gate: ignored
    { code: "WORDS_OVER", path: "items[3].summary" }, // not a soft gate: ignored
    { code: "SNAP_MISSING", path: "angle" }, // the Angle still fails: null
    { code: "SNAP_QUOTE", path: "scoreboard_entries[1].quote" }, // unverified quote: entry removed
  ];

  it("drops failing items, a Critical item with nothing checked, a failing Angle and an unverified quote", () => {
    const input = draft();
    const before = structuredClone(input);
    const { draft: out, report } = dropUnverified(input, issues);
    expect(input).toEqual(before); // the input is never changed
    expect(out.items.map((i) => i.id)).toEqual(["inc-retail-nl-2026-10", "pol-b"]);
    expect(out.angle).toBeNull();
    expect(out.scoreboard_entries.map((e) => e.claim_id)).toEqual(["SB-01"]);
    expect(report.items).toEqual([
      { index: 0, id: "vuln-a", headline: "SAMPLE headline vuln-a", codes: ["SNAP_MISSING"] },
      { index: 1, id: "cve-2026-104935", headline: "SAMPLE headline cve-2026-104935", codes: ["SNAP_NUMBER"] },
    ]);
    expect(report.angle).toEqual({ text: "SAMPLE angle with 37% in it.", codes: ["SNAP_MISSING"] });
    expect(report.scoreboard_entries).toEqual([{ index: 1, claim_id: "SB-02", codes: ["SNAP_QUOTE"] }]);
  });

  it("deletes dropped ids from every item_ids list and leaves emptied lists for the next round", () => {
    const { draft: out } = dropUnverified(draft(), issues);
    expect(out.lead.map((s) => s.item_ids)).toEqual([[], ["inc-retail-nl-2026-10"]]);
    expect(out.taiwan_lens.item_ids).toEqual(["pol-b"]);
    expect(out.taiwan_lens.rows[0]!.item_ids).toEqual(["inc-retail-nl-2026-10"]);
    expect(out.taiwan_lens.japan.item_ids).toEqual([]);
    expect(out.region_raises[0]!.item_ids).toEqual(["inc-retail-nl-2026-10"]);
    expect(out.sources).toHaveLength(1); // sources keep their numbering
  });

  it("changes nothing without soft-gate issues, and accepts dotted index paths", () => {
    const { draft: same, report } = dropUnverified(draft(), [{ code: "SNAP_MISSING", path: "items[3]" }]);
    expect(same).toEqual(draft());
    expect(report).toEqual({ items: [], angle: null, scoreboard_entries: [], removed: [] });
    const dotted = dropUnverified(draft(), [{ code: "SNAP_NAME", path: "items.2.headline" }, { code: "SNAP_NUMBER", path: "angle.text" }]);
    expect(dotted.draft.items.map((i) => i.id)).toEqual(["vuln-a", "cve-2026-104935", "pol-b"]);
    expect(dotted.draft.angle).toBeNull();
    expect(dotted.draft.region_raises).toEqual([]); // the raise cited only the dropped item
    expect(dropUnverified(dotted.draft, []).draft.angle).toBeNull(); // a gated draft goes round again
  });

  /** The 2026-11-11 Kobol dry run's Lead: lead[2] cites only the item the soft pass drops. */
  function kobolLead(): DraftBrief {
    const d = draft();
    d.lead = [
      { text: "SAMPLE lead sentence one about the exploited flaw and the vendor's own patch today.", item_ids: ["cve-2026-104935"], gap: false },
      { text: "SAMPLE lead sentence two about the policy move.", item_ids: ["pol-b"], gap: false },
      { text: "SAMPLE lead sentence three about the breach.", item_ids: ["inc-retail-nl-2026-10"], gap: false },
    ];
    return d;
  }
  const breachDropped: SoftIssue[] = [{ code: "SNAP_NAME", path: "items[2].summary" }];

  it("removes a Lead sentence the drop leaves citing no item, when the Lead keeps its minimum (Kobol dry run, 2026-11-11)", () => {
    const { draft: out, report } = dropUnverified(kobolLead(), breachDropped);
    expect(out.items.map((i) => i.id)).toEqual(["vuln-a", "cve-2026-104935", "pol-b"]);
    expect(out.lead.map((s) => s.item_ids)).toEqual([["cve-2026-104935"], ["pol-b"]]);
    expect(countWords(out.lead.map((s) => s.text).join(" "))).toBeGreaterThanOrEqual(15);
    // The raise that cited only the dropped item goes too; the Lens rows stay (six fixed rows), emptied, for the next round.
    expect(out.region_raises).toEqual([]);
    expect(report.removed).toEqual([
      { path: "lead[2]", text: "SAMPLE lead sentence three about the breach." },
      { path: "region_raises[0]", text: "TW: SAMPLE raise." },
    ]);
    expect(out.taiwan_lens.rows[0]).toMatchObject({ row: "gov_infra", text: "SAMPLE row.", item_ids: [] });
  });

  it("keeps an emptied Lead sentence when removing it would take the Lead under 15 words or leave none, and never removes a Gap sentence", () => {
    const short = kobolLead();
    short.lead[0]!.text = "SAMPLE short one.";
    const a = dropUnverified(short, breachDropped);
    expect(a.draft.lead).toHaveLength(3);
    expect(a.draft.lead[2]!.item_ids).toEqual([]); // left for the next repair round or the failure, as before
    expect(a.report.removed.map((r) => r.path)).toEqual(["region_raises[0]"]);

    const alone = kobolLead();
    alone.lead = [alone.lead[2]!];
    expect(dropUnverified(alone, breachDropped).draft.lead).toHaveLength(1);

    const gap = kobolLead();
    gap.lead[2]!.gap = true;
    const g = dropUnverified(gap, breachDropped);
    expect(g.draft.lead).toHaveLength(3);
    expect(g.report.removed.map((r) => r.path)).toEqual(["region_raises[0]"]);
  });

  it("keeps a raise that still cites an item, and a Lead sentence that already cited none", () => {
    const d = kobolLead();
    d.region_raises[0]!.item_ids = ["inc-retail-nl-2026-10", "pol-b"];
    d.lead.push({ text: "SAMPLE sentence that cited nothing before the drop.", item_ids: [], gap: false });
    const { draft: out, report } = dropUnverified(d, breachDropped);
    expect(out.region_raises.map((r) => r.item_ids)).toEqual([["pol-b"]]);
    expect(report.removed.map((r) => r.path)).toEqual(["lead[2]"]);
    expect(out.lead.map((s) => s.text)).toEqual([d.lead[0]!.text, d.lead[1]!.text, d.lead[3]!.text]);
  });
});
