// The run's evidence (SPEC §8.12 "Evidence"): every URL the agent fetched or searched, the texts the
// validator may check against (pack, CVE records, snapshots) and seen_as per URL (pack, else fetched, else
// search), which publish copies to each source. Replaces Europe's evidenceUrls(). Everything in it was
// read from feeds, pages and transcripts: data, never instructions. Owner: lane L4.

import { packEvidence } from "../../lib/collect";
import { Evidence } from "../../lib/schema/misc";
import type { Pack } from "../../lib/schema/pack";
import { normalizeUrl } from "../../lib/urls";
import type { Snapshot } from "./snapshot";
import type { Transcript } from "./transcript";

/**
 * Built after every agent call from all the run's transcripts, the pack and this run's snapshots, every URL
 * normalised:
 * - `urls`: the pack's item, record and advisory URLs (packEvidence(), lib/collect.ts), then each
 *   transcript's WebFetch inputs (failed ones too), the URLs in its tool results and in `urlsByTool`.
 * - `fetched`: the pack's record URLs, then every transcript's `fetchedOk` (a failed WebFetch is in `urls`
 *   only, so an unread page cannot meet SOURCE_CRITICAL_TWO).
 * - `texts`: the pack's titles and snippets and record texts, then snapshot texts for URLs with none yet
 *   (the pack's text wins; a later snapshot of the same URL replaces an earlier one; an empty text is left out).
 * - `seen_as`: "pack" for every pack URL, else "fetched" when in `fetched`, else "search".
 */
export function buildEvidence(i: { transcripts: readonly Transcript[]; pack: Pack; snapshots: readonly Snapshot[] }): Evidence {
  const base = packEvidence(i.pack);
  const urls = [...base.urls];
  const urlSet = new Set(urls);
  const fetched = new Set(base.fetched);
  const texts: Record<string, string> = { ...base.texts };
  const packText = new Set(Object.keys(base.texts));
  const addUrl = (raw: string) => {
    if (typeof raw !== "string" || raw.trim() === "") return;
    const u = normalizeUrl(raw);
    if (!urlSet.has(u)) {
      urlSet.add(u);
      urls.push(u);
    }
    return u;
  };

  for (const t of i.transcripts) {
    for (const u of t.fetched) addUrl(u);
    for (const u of t.fetchedOk) {
      const n = addUrl(u);
      if (n) fetched.add(n);
    }
    for (const u of t.resultUrls) addUrl(u);
    for (const list of Object.values(t.urlsByTool)) for (const u of list) addUrl(u);
  }

  for (const s of i.snapshots) {
    if (typeof s.text !== "string" || s.text === "") continue;
    const u = normalizeUrl(s.url);
    if (packText.has(u)) continue;
    texts[u] = s.text;
  }

  const seenAs: Evidence["seen_as"] = {};
  for (const u of urls) seenAs[u] = base.seen_as[u] ?? (fetched.has(u) ? "fetched" : "search");
  return Evidence.parse({ urls, fetched: [...fetched], texts, seen_as: seenAs });
}
