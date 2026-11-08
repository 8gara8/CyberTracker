import { afterEach, describe, expect, it } from "vitest";
import {
  addDays, at, dataCutoffFor, daysBetween, inRange, isMonday, isoWeekStart, isValidDate, lastSunday, newestCompleteWeek,
  taipeiDateOf, taipeiTime, taipeiTimestamp, taipeiToday, utcDateOf, weekday, windowEnding,
} from "@/lib/dates";
import { countWords } from "@/lib/text";
import { blockedEntry, defang, extractUrls, hostMatches, hostOf, isHttpsUrl, normalizeUrl, stripArchivePrefix } from "@/lib/urls";
import { BLOCK_REASONS, BLOCKED_HOSTS, blockedHostEntries, CANARY_TOKEN, CANARY_URL_MARK, CANARY_URL_PREFIX } from "@/lib/vocab";
import { fetchFeed } from "@/lib/feeds/http";
import http from "node:http";
import type { AddressInfo } from "node:net";

describe("countWords", () => {
  it("counts whitespace-separated words", () => {
    expect(countWords("Attackers exploited the flaw within days.")).toBe(6);
  });
  it("counts hyphenated words and numbers as one word each", () => {
    expect(countWords("A 13-week window, 1,800 records and 05:58 Taipei")).toBe(8);
  });
  it("ignores URLs, markdown symbols and stray punctuation", () => {
    expect(countWords("**Bold** text, see https://example.org/a/b?c=d and # - >")).toBe(4);
  });
  it("handles empty and null input", () => {
    expect(countWords("")).toBe(0);
    expect(countWords(null)).toBe(0);
    expect(countWords("   \n ")).toBe(0);
  });
  it("counts a Chinese or Japanese run without spaces as one word", () => {
    expect(countWords("資安 漏洞")).toBe(2);
    expect(countWords("ゼロデイ攻撃")).toBe(1);
  });
});

describe("dates", () => {
  const keepTz = process.env.TZ;
  afterEach(() => {
    if (keepTz === undefined) delete process.env.TZ;
    else process.env.TZ = keepTz;
  });

  it("validates calendar dates", () => {
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-11-8")).toBe(false);
  });
  it("adds days across months and years", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-10-04", "2026-11-02")).toBe(29);
    expect(daysBetween("2026-11-02", "2026-10-04")).toBe(-29);
  });
  it("gives Taipei's date and time for a moment, whatever the machine's zone", () => {
    for (const tz of [undefined, "UTC", "America/Los_Angeles", "Asia/Taipei"]) {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
      expect(taipeiToday(new Date("2026-11-07T21:47:00Z"))).toBe("2026-11-08");
      expect(taipeiToday(new Date("2026-11-07T15:59:00Z"))).toBe("2026-11-07");
      expect(taipeiDateOf("2026-11-07T23:00:00+01:00")).toBe("2026-11-08");
      expect(taipeiTime("2026-11-07T21:47:00Z")).toBe("05:47");
      expect(taipeiTimestamp(new Date("2026-11-07T21:58:12.345Z"))).toBe("2026-11-08T05:58:12+08:00");
    }
  });
  it("reads HH:MM as Taipei time", () => {
    expect(new Date(at("2026-11-08", "05:47")).toISOString()).toBe("2026-11-07T21:47:00.000Z");
    expect(new Date(at("2026-11-08", "07:40")).toISOString()).toBe("2026-11-07T23:40:00.000Z");
    expect(() => at("2026-11-08", "7:40")).toThrow();
  });
  it("reads CVE timestamps as UTC dates, including the two records without a zone", () => {
    for (const tz of [undefined, "Asia/Taipei", "America/Los_Angeles"]) {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
      expect(utcDateOf("2022-09-05T09:50:09")).toBe("2022-09-05"); // CVE-2022-38369
      expect(utcDateOf("2022-09-05T09:50:10")).toBe("2022-09-05"); // CVE-2022-38370
      expect(utcDateOf("2026-11-06T23:59:59.000Z")).toBe("2026-11-06");
      expect(utcDateOf("2026-11-07T05:00:00+08:00")).toBe("2026-11-06");
      expect(utcDateOf("2026-11-06T20:00:00-0500")).toBe("2026-11-07");
      expect(utcDateOf("2026-11-06")).toBe("2026-11-06");
    }
    expect(() => utcDateOf("not a date")).toThrow();
    expect(() => utcDateOf("2026-02-30T00:00:00")).toThrow();
    for (const bad of ["2026-11-06T25:00:00", "2026-11-06T24:00:00", "2026-11-06T23:60:00", "2026-11-06T23:59:60", "2026-11-06T24:00:00Z", "2026-11-06T12:00:61+08:00"]) {
      expect(() => utcDateOf(bad), bad).toThrow();
    }
    expect(utcDateOf("2026-11-06T23:59:59.999")).toBe("2026-11-06");
  });
  it("puts the data cutoff two days before the edition", () => {
    expect(dataCutoffFor("2026-11-08")).toBe("2026-11-06");
    expect(dataCutoffFor("2027-01-01")).toBe("2026-12-30");
  });
  it("builds closed windows ending at the cutoff (SPEC §5.1 table)", () => {
    expect(windowEnding("2026-11-06", 91)).toEqual({ from: "2026-08-08", to: "2026-11-06" });
    expect(addDays(windowEnding("2026-11-06", 91).from, -364)).toBe("2025-08-09");
    expect(addDays(windowEnding("2026-11-06", 91).to, -364)).toBe("2025-11-07");
    expect([addDays("2026-11-06", -120), addDays("2026-11-06", -30)]).toEqual(["2026-07-09", "2026-10-07"]);
    expect(windowEnding("2026-11-06", 1)).toEqual({ from: "2026-11-06", to: "2026-11-06" });
    expect(() => windowEnding("2026-11-06", 0)).toThrow();
  });
  it("names ISO weeks by their Monday", () => {
    expect(weekday("2026-11-08")).toBe(0);
    expect(isMonday("2026-11-02")).toBe(true);
    expect(isoWeekStart("2026-11-08")).toBe("2026-11-02");
    expect(isoWeekStart("2026-11-02")).toBe("2026-11-02");
    expect(lastSunday("2026-11-06")).toBe("2026-11-01");
    expect(lastSunday("2026-11-08")).toBe("2026-11-08");
    expect(newestCompleteWeek(dataCutoffFor("2026-11-08"))).toBe("2026-10-26");
    expect(addDays(newestCompleteWeek("2026-11-06"), -21)).toBe("2026-10-05");
    expect(addDays(newestCompleteWeek("2026-11-06"), -7 * 103)).toBe("2024-11-04");
  });
  it("checks inclusive ranges", () => {
    expect(inRange("2026-11-06", "2026-08-08", "2026-11-06")).toBe(true);
    expect(inRange("2026-08-07", "2026-08-08", "2026-11-06")).toBe(false);
  });
});

describe("urls", () => {
  it("folds scheme, host case, www, fragments, tracking parameters and trailing slashes", () => {
    expect(normalizeUrl("http://WWW.CISA.gov/known-exploited-vulnerabilities-catalog/#top")).toBe("https://cisa.gov/known-exploited-vulnerabilities-catalog");
    expect(normalizeUrl("https://a.org/x?utm_source=t&b=2&fbclid=z&a=1&gclid=q")).toBe("https://a.org/x?a=1&b=2");
    expect(normalizeUrl("https://example.org/")).toBe("https://example.org");
    expect(normalizeUrl("https://a.org/%e8%b3%87")).toBe(normalizeUrl("https://a.org/資"));
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
  it("strips a Wayback prefix", () => {
    expect(stripArchivePrefix("https://web.archive.org/web/20261106000000/https://example.org/a")).toBe("https://example.org/a");
    expect(normalizeUrl("https://web.archive.org/web/20261106000000/https://www.example.org/a/")).toBe("https://example.org/a");
  });
  it("recognises https URLs and hosts", () => {
    expect(isHttpsUrl("https://www.twcert.org.tw/tw/lp-132-1.html")).toBe(true);
    expect(isHttpsUrl("http://example.org/a")).toBe(false);
    expect(isHttpsUrl("example.org/a")).toBe(false);
    expect(hostOf("https://WWW.JPCERT.or.jp./at/")).toBe("www.jpcert.or.jp");
    expect(hostOf("nope")).toBeNull();
    expect(hostMatches("www.exploit-db.com", "exploit-db.com")).toBe(true);
    expect(hostMatches("notexploit-db.com", "exploit-db.com")).toBe(false);
  });
  it("extracts URLs from text without trailing punctuation", () => {
    expect(extractUrls("See https://a.org/x, and (https://b.org/y). Done.")).toEqual(["https://a.org/x", "https://b.org/y"]);
  });
  it("defangs indicators but keeps version numbers", () => {
    expect(defang("http://evil.example.com:8443/x")).toBe("hxxp://evil[.]example[.]com[:]8443/x");
    expect(defang("contact ops@evil.example")).toBe("contact ops[@]evil[.]example");
    expect(defang("203.0.113.7")).toBe("203[.]0[.]113[.]7");
    expect(defang("fixed in 2.1.319 and 10.4")).toBe("fixed in 2.1.319 and 10.4");
  });
  it("matches blocked hosts, subdomains, paths and suffixes (Appendix B.3)", () => {
    // Bare hosts and non-actionable paths only: no exploit, query, channel or leak-site link (SPEC §0.2).
    expect(blockedEntry("https://www.exploit-db.com/")?.reason).toBe("exploit_code");
    expect(blockedEntry("https://web.archive.org/web/2026/https://a.org")?.reason).toBe("archive");
    expect(blockedEntry("https://t.me/")?.reason).toBe("messaging");
    expect(blockedEntry("https://www.google.com/url?q=https://a.org")?.reason).toBe("redirect");
    expect(blockedEntry("https://www.google.com/search?q=x")).toBeNull();
    expect(blockedEntry("https://shodan.io/search")?.reason).toBe("scan_query");
    expect(blockedEntry("https://shodan.io/")).toBeNull();
    expect(blockedEntry("http://example.onion/")?.reason).toBe("leak_site");
    expect(blockedEntry("https://www.cisa.gov/kev")).toBeNull();
    expect(blockedEntry("not a url")).toBeNull();
  });
});

describe("vocab", () => {
  it("keeps every blocked entry well formed and unique", () => {
    const patterns = BLOCKED_HOSTS.map((b) => b.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
    for (const b of BLOCKED_HOSTS) {
      expect(BLOCK_REASONS).toContain(b.reason);
      expect(b.pattern).toBe(b.pattern.toLowerCase());
    }
    expect(blockedHostEntries()).not.toContain("google.com/url");
    expect(blockedHostEntries()).not.toContain(".onion");
    expect(blockedHostEntries()[0]).toBe("exploit-db.com");
  });
  it("keeps the canary harmless and recognisable", () => {
    expect(CANARY_TOKEN).toMatch(/^CT-CANARY-[0-9A-F]{8}-[A-Z]+-[A-Z]+$/);
    expect(CANARY_URL_PREFIX.startsWith("https://example.org/")).toBe(true);
    expect(CANARY_URL_PREFIX.endsWith(CANARY_URL_MARK)).toBe(true);
    expect(CANARY_URL_MARK).toBe(CANARY_URL_MARK.toLowerCase());
  });
});

describe("fetchFeed never throws", () => {
  it("turns a redirect with an unparseable Location into a result", async () => {
    const server = http.createServer((_req, res) => { res.writeHead(302, { Location: "http://[not-a-host" }); res.end(); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const r = await fetchFeed(`http://127.0.0.1:${port}/feed`, { retryDelayMs: 0, timeoutMs: 5_000, userAgent: "CyberTracker test" });
      expect(r.ok).toBe(false);
      expect(r.error).toBe("redirects");
      expect(r.status).toBe(302);
    } finally {
      server.close();
    }
  });
  it("turns an unusable URL into a result", async () => {
    const r = await fetchFeed("not a url", { retryDelayMs: 0, userAgent: "CyberTracker test" });
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
  });
});
