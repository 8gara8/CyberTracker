// The live captures Kobol's session 1 committed (fixtures/feeds/rss/<registry id>.xml and
// fixtures/feeds/live/*), read with the production parsers: each still parses, holds items or rows, every
// item date reads, and the newest date falls in 2026. A capture the scrubber or a hand edit broke, or a
// parser change that stops reading a real feed's shape, fails here. Offline: the files are read from disk.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { parseEpssCsv } from "@/lib/feeds/epss";
import { parseExchange } from "@/lib/feeds/exchange";
import { parseNvdPage } from "@/lib/feeds/nvd";
import { parseRss } from "@/lib/feeds/rss";

const ROOT = path.join(__dirname, "..");
const RSS_DIR = path.join(ROOT, "fixtures", "feeds", "rss");
const LIVE_DIR = path.join(ROOT, "fixtures", "feeds", "live");
const config = loadConfig({ root: ROOT });
const rssEntries = new Map(config.sources.feeds.flatMap((f) => (f.kind === "rss" ? [[f.id, f] as const] : [])));

const YEAR_START = Date.parse("2026-01-01T00:00:00Z");
const YEAR_END = Date.parse("2027-01-01T00:00:00Z");
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name));

/** Every date reads, and the newest is in 2026 (UTC). */
function checkDates(label: string, dates: readonly (string | null)[]): void {
  expect(dates.length, label).toBeGreaterThan(0);
  const ms = dates.map((d) => (d === null ? Number.NaN : Date.parse(d)));
  for (const [i, t] of ms.entries()) expect(Number.isFinite(t), `${label}: date ${i + 1} (${dates[i]})`).toBe(true);
  const newest = Math.max(...ms);
  expect(newest >= YEAR_START && newest < YEAR_END, `${label}: newest ${new Date(newest).toISOString()}`).toBe(true);
}

/** The RSS, RDF and Atom captures: files named after a registry rss entry (the format fixtures have other names). */
const RSS_CAPTURES = fs.readdirSync(RSS_DIR).filter((f) => f.endsWith(".xml") && rssEntries.has(f.slice(0, -4))).sort();

describe("the committed live captures (Kobol session 1)", () => {
  it("finds the nine feed captures and the four live captures session 1 committed", () => {
    for (const id of ["cert-eu", "cna", "focustaiwan", "ipa", "jpcert", "ncsc-uk", "openai-news", "taipeitimes", "twcert-tvn"]) {
      expect(RSS_CAPTURES, id).toContain(`${id}.xml`);
    }
    expect(fs.readdirSync(LIVE_DIR).sort()).toEqual(["epss.csv.gz", "exchange-tpex.json", "exchange-tw.json", "nvd.json"]);
  });

  it.each(RSS_CAPTURES)("%s parses with parseRss and its registry date_zone: items, every date reads, newest in 2026", async (file) => {
    const entry = rssEntries.get(file.slice(0, -4))!;
    const parsed = await parseRss(read(RSS_DIR, file), entry.date_zone);
    expect(parsed.entries.length, file).toBeGreaterThan(0);
    for (const e of parsed.entries) expect(e.title, file).not.toBe("");
    checkDates(file, parsed.entries.map((e) => e.published_at));
    expect(parsed.newest, file).toBe(parsed.entries.map((e) => e.published_at!).sort().at(-1));
  });

  it("epss.csv.gz parses with parseEpssCsv: rows, the score date reads and is in 2026", () => {
    const { day } = parseEpssCsv(read(LIVE_DIR, "epss.csv.gz"));
    expect(day.scores.size).toBeGreaterThan(0);
    expect(day.model_version).toMatch(/^v\d{4}\.\d{2}\.\d{2}$/);
    checkDates("epss.csv.gz", [day.score_date]);
  });

  it.each([["exchange-tw.json", "twse"], ["exchange-tpex.json", "tpex"]] as const)("%s parses with parseExchange: notices, every date reads, newest in 2026", (file, endpoint) => {
    const parsed = parseExchange(read(LIVE_DIR, file), endpoint);
    expect(parsed.entries.length, file).toBeGreaterThan(0);
    for (const n of parsed.entries) expect(n.company_code, file).toMatch(/^\d{4,6}$/);
    checkDates(file, parsed.entries.map((n) => n.spoken_at));
  });

  it("nvd.json parses with parseNvdPage: vulnerabilities, every published date reads, newest in 2026", () => {
    const body = read(LIVE_DIR, "nvd.json");
    const page = parseNvdPage(body);
    const raw = JSON.parse(body.toString("utf8")) as { vulnerabilities: { cve: { id: string; published: string } }[] };
    expect(page.total).toBe(raw.vulnerabilities.length);
    expect(page.total).toBeGreaterThan(0);
    // NVD writes UTC instants without a zone ("2026-11-07T21:17:00.150", read on Kobol).
    checkDates("nvd.json", raw.vulnerabilities.map((v) => (/(?:Z|[+-]\d{2}:\d{2})$/.test(v.cve.published) ? v.cve.published : `${v.cve.published}Z`)));
    for (const v of raw.vulnerabilities) expect(v.cve.id).toMatch(/^CVE-\d{4}-\d{4,}$/);
  });
});
