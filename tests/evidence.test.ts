// The run's evidence (SPEC §8.12 "Evidence"; plan §2.5 L4): buildEvidence() from the pack, every
// transcript of the run and this run's snapshots. seen_as is pack, else fetched, else search; a failed
// WebFetch is in urls and not in fetched; texts come from the pack, the records and the snapshots, the
// pack's first. Offline: the pack is fixtures/packs/weekday.json and the transcripts are written here.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packEvidence } from "@/lib/collect";
import { Evidence } from "@/lib/schema/misc";
import { Pack } from "@/lib/schema/pack";
import { normalizeUrl } from "@/lib/urls";
import { buildEvidence } from "@/scripts/lib/evidence";
import type { Snapshot } from "@/scripts/lib/snapshot";
import { parseTranscript } from "@/scripts/lib/transcript";
import { REPO } from "./helpers/harness";
import { transcriptJsonl } from "./helpers/pipeline-world";

const pack = Pack.parse(JSON.parse(fs.readFileSync(path.join(REPO, "fixtures", "packs", "weekday.json"), "utf8")));
const item = pack.items[0]!;
const record = pack.records[0]!;
const snap = (url: string, text: string): Snapshot => ({
  url, final_url: url, status: 200, fetched_at: "2026-10-14T04:58:00+08:00", content_type: "text/html", text_sha256: "0".repeat(64), text,
});

describe("buildEvidence", () => {
  const fetchedPage = "https://www.jpcert.or.jp/ct-sample/at260021.html#top";
  const failedPage = "https://www.cisa.gov/ct-sample/advisory-403";
  const searchHit = "https://www.twcert.org.tw/ct-sample/search-hit";
  const t1 = parseTranscript(transcriptJsonl({ fetches: [fetchedPage, item.url], failed: [failedPage], searches: [{ query: "sample", urls: [searchHit] }] }));
  const t2 = parseTranscript(transcriptJsonl({ fetches: [failedPage] }));

  it("E1 seen_as is pack, else fetched, else search; a failed WebFetch is in urls, not fetched", () => {
    const ev = buildEvidence({ transcripts: [t1], pack, snapshots: [] });
    expect(Evidence.parse(ev)).toEqual(ev);
    const n = normalizeUrl;
    const base = packEvidence(pack);
    expect(ev.urls.slice(0, base.urls.length)).toEqual(base.urls);
    for (const u of [fetchedPage, failedPage, searchHit, item.url, record.url]) expect(ev.urls).toContain(n(u));
    expect(ev.fetched).toEqual(expect.arrayContaining([n(record.url), n(fetchedPage), n(item.url)]));
    expect(ev.fetched).not.toContain(n(failedPage));
    expect(ev.fetched).not.toContain(n(searchHit));
    expect(ev.seen_as[n(item.url)]).toBe("pack"); // fetched too, but the pack wins
    expect(ev.seen_as[n(record.url)]).toBe("pack");
    expect(ev.seen_as[n(fetchedPage)]).toBe("fetched");
    expect(ev.seen_as[n(failedPage)]).toBe("search");
    expect(ev.seen_as[n(searchHit)]).toBe("search");
    expect(Object.keys(ev.seen_as).sort()).toEqual([...ev.urls].sort());
    expect(new Set(ev.urls).size).toBe(ev.urls.length);
  });

  it("E1 builds from every transcript of the run: a page that failed once and was read later counts as fetched", () => {
    const ev = buildEvidence({ transcripts: [t1, t2], pack, snapshots: [] });
    expect(ev.fetched).toContain(normalizeUrl(failedPage));
    expect(ev.seen_as[normalizeUrl(failedPage)]).toBe("fetched");
  });

  it("E1 texts come from pack items and records, then snapshots; the pack's text wins and an empty snapshot adds nothing", () => {
    const pdf = "https://www.security-next.com/ct-sample/empty-page";
    const ev = buildEvidence({
      transcripts: [t1], pack,
      snapshots: [snap(fetchedPage, "SAMPLE JPCERT page text."), snap(item.url, "A snapshot of a pack page."), snap(pdf, "")],
    });
    expect(ev.texts[normalizeUrl(item.url)]).toBe(`${item.title}\n${item.snippet}`);
    expect(ev.texts[normalizeUrl(record.url)]).toBe(`${record.title}\n${record.text}`);
    expect(ev.texts[normalizeUrl(fetchedPage)]).toBe("SAMPLE JPCERT page text.");
    expect(Object.hasOwn(ev.texts, normalizeUrl(pdf))).toBe(false);
    expect(Object.hasOwn(ev.texts, normalizeUrl(failedPage))).toBe(false);
    // Snapshots give seen text but not "seen": only the agent's calls and the pack add URLs.
    expect(ev.urls).not.toContain(normalizeUrl(pdf));
  });
});
