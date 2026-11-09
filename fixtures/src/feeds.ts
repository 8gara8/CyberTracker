// The generated feed fixtures (fixtures plan §3.3): the KEV catalog the fixture mirror serves, a catalog
// whose count is wrong, and the two CVE List delta zips of the 2026-10-14 morning, built from the static
// trimmed records under fixtures/feeds/cvelist/. Not yet in build.ts's GENERATORS (integration adds it);
// until then `tsx fixtures/src/feeds.ts` writes the files and tests/feeds.test.ts compares them.
//
// The KEV world is one list of real rows (P1's kev-rows.json plus kev-extra.json), so the served catalog
// and fixtures/state/kev-index.json can never disagree: the "new KEV" set is their difference. The fixture
// catalog's count is its own length (111 rows dated to 2026-10-13), not the real catalog's 1,741 that
// world.ts's KEV_1013 carries, because parseKev() rejects a count that differs from the list: the two
// fixture worlds differ on purpose. Ids, dates, vendors, products and ransomware use are real; names,
// descriptions and actions are invented; notes point at a vendor /ct-sample/ page and the NVD record.
//
// The static records were trimmed from the CVE List clone at 67c39b1 as each stood when its zip was cut
// (2026-10-12 end of day; 2026-10-13 20:00 UTC): CISA ADP containers dated later removed and dateUpdated
// set back to the record's last change before the cut; the CVE Program container, legacy v4 blocks,
// exploit and timeline blocks dropped; exploit-tagged and code-hosting references dropped and the rest
// rewritten to <host>/ct-sample/<slug>; credits naming a person replaced by "SAMPLE Researcher"; at most 4
// affected entries. Two exceptions are moved, not trimmed: CVE-2022-38369 and CVE-2022-38370 (zone-less
// datePublished) carry a dateUpdated on 2026-10-12 so the end-of-day zip holds them. The P1 records
// (CVE-2026-104935, -96951, -108917, -110036) are world.ts's cveRecord(), and the end-of-day copy of
// CVE-2026-108917 is that record before CISA's 2026-10-13 update.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareCveIds } from "../../lib/ids";
import { addDays } from "../../lib/dates";
import { jsonText } from "../../lib/json";
import { endOfDayAsset, hourlyAsset } from "../../lib/feeds/github";
import { blockedReason } from "../../lib/sources";
import { KevIndexRow } from "../../lib/schema/metrics";
import { FIXTURES_DIR, KEV_DUE, KEV_ROWS, REPO_ROOT } from "./world";
import { storedZip } from "./zip-writer";

/** The morning the feed fixtures describe (shared with fixtures/state and P3's daily test). */
export const FEED_WORLD = {
  date: "2026-10-14",
  cutoff: "2026-10-12",
  runUtcDay: "2026-10-13",
  eodTag: "cve_2026-10-12_at_end_of_day",
  hourlyTag: "cve_2026-10-13_2000Z",
  kev: { version: "2026.10.13", released: "2026-10-13T17:02:11Z" },
  /** The real 2024 KEV row the fixture state leaves unjoined; its record is in cvelist/by-id/. */
  rejoinId: "CVE-2024-38112",
} as const;

/** One generated file: UTF-8 text, or bytes compared byte for byte (the shape build.ts's Output takes in P2). */
export type FeedOutput = { path: string; text: string } | { path: string; bytes: Buffer };

export const FEEDS_DIR = path.join(FIXTURES_DIR, "feeds");
const CVELIST_DIR = path.join(FEEDS_DIR, "cvelist");
export const KEV_CATALOG_PATH = "fixtures/feeds/kev/known_exploited_vulnerabilities.json";
export const KEV_BAD_COUNT_PATH = "fixtures/feeds/kev/bad-count.json";
export const EOD_ZIP_PATH = `fixtures/feeds/cvelist/zips/${endOfDayAsset(FEED_WORLD.cutoff).asset}`;
export const HOURLY_ZIP_PATH = `fixtures/feeds/cvelist/zips/${hourlyAsset(FEED_WORLD.runUtcDay, "2000").asset}`;
/** The static record folders each zip is built from. */
export const ZIP_SOURCES: Readonly<Record<"eod" | "hourly", readonly string[]>> = {
  eod: ["src/eod-2026-10-12"],
  hourly: ["src/hourly-2026-10-13-2000Z", "patch-tuesday"],
};

const byAdded = (a: KevIndexRow, b: KevIndexRow) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : compareCveIds(a[0], b[0]));

/**
 * The fixture KEV world: real rows (P1's kev-rows.json, 2026-07-13 to 2026-10-14, plus kev-extra.json),
 * as KevIndexRow tuples, newest last (date added, then id). One source for the catalog fixture and
 * fixtures/state/kev-index.json.
 */
export function fixtureKevRows(): KevIndexRow[] {
  const extra = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "src", "kev-extra.json"), "utf8")) as { rejoin_id: string; entries: unknown[] };
  if (extra.rejoin_id !== FEED_WORLD.rejoinId) throw new Error("kev-extra.json rejoin_id differs from FEED_WORLD.rejoinId");
  const rows = [...KEV_ROWS, ...extra.entries.map((r) => KevIndexRow.parse(r))];
  const ids = new Set<string>();
  for (const r of rows) {
    if (ids.has(r[0])) throw new Error(`KEV fixture row ${r[0]} appears twice`);
    ids.add(r[0]);
  }
  if (!ids.has(FEED_WORLD.rejoinId)) throw new Error(`kev-extra.json lacks the rejoin row ${FEED_WORLD.rejoinId}`);
  return rows.sort(byAdded);
}

/**
 * Each vendor's first domain from config/vendors.json, by name or alias (lower-cased), skipping a vendor
 * whose first domain is on a blocked host (a code-hosting vendor such as GitLab), which gets example.com.
 */
function vendorDomains(): Map<string, string> {
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "config", f), "utf8")) as unknown;
  const file = read("vendors.json") as { vendors: { name: string; aliases: string[]; domains: string[] }[] };
  const tiers = read("source-tiers.json") as { github: { tier1_paths: string[] } };
  const out = new Map<string, string>();
  for (const v of file.vendors) {
    const domain = v.domains[0];
    if (!domain || blockedReason(`https://${domain}/ct-sample/x`, tiers) !== null) continue;
    for (const n of [v.name, ...v.aliases]) if (!out.has(n.toLowerCase())) out.set(n.toLowerCase(), domain);
  }
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * The catalog the fixture mirror serves: catalogVersion 2026.10.13, count = rows, rows dated ≤ 2026-10-13,
 * newest first; real cveID, vendorProject, product, dateAdded, knownRansomwareCampaignUse; invented
 * vulnerabilityName ("<vendor> <product> Vulnerability (SAMPLE)"), shortDescription and requiredAction
 * ("SAMPLE …"); dueDate = KEV_DUE where world.ts has it, else dateAdded + 21; notes = a vendor
 * /ct-sample/ URL (example.com for a vendor not in config/vendors.json or on a blocked host) and the NVD
 * record URL; cwes []; one unknown extra key on the newest entry.
 */
export function fixtureKevCatalog(): unknown {
  const domains = vendorDomains();
  const rows = fixtureKevRows().filter((r) => r[1] <= FEED_WORLD.runUtcDay).reverse();
  const vulnerabilities = rows.map(([cveID, dateAdded, vendorProject, product, , , ransomware], i) => {
    const id = cveID.toLowerCase();
    const domain = domains.get(vendorProject.toLowerCase());
    const vendorUrl = domain ? `https://${domain}/ct-sample/${id}` : `https://example.com/ct-sample/${slug(vendorProject)}-${id}`;
    return {
      cveID,
      vendorProject,
      product,
      vulnerabilityName: `${vendorProject} ${product} Vulnerability (SAMPLE)`,
      dateAdded,
      shortDescription: `SAMPLE description, invented for the fixture: ${vendorProject} ${product} contains a vulnerability that an attacker could use.`,
      requiredAction: "SAMPLE action, invented for the fixture: apply mitigations per vendor instructions, or discontinue use of the product if mitigations are unavailable.",
      dueDate: KEV_DUE[cveID] ?? addDays(dateAdded, 21),
      knownRansomwareCampaignUse: ransomware === "known" ? "Known" : "Unknown",
      notes: `${vendorUrl} ; https://nvd.nist.gov/vuln/detail/${cveID}`,
      cwes: [] as string[],
      ...(i === 0 ? { sampleExtraField: "SAMPLE: a key the catalog schema does not know; parseKev() drops it" } : {}),
    };
  });
  return {
    title: "CISA Catalog of Known Exploited Vulnerabilities",
    catalogVersion: FEED_WORLD.kev.version,
    dateReleased: FEED_WORLD.kev.released,
    count: vulnerabilities.length,
    vulnerabilities,
  };
}

/** The deltaCves/<id>.json entries of one zip, sorted by id, from its static record folders. */
export function zipEntries(which: "eod" | "hourly"): { name: string; data: Buffer }[] {
  const seen = new Map<string, Buffer>();
  for (const folder of ZIP_SOURCES[which]) {
    const dir = path.join(CVELIST_DIR, folder);
    for (const file of fs.readdirSync(dir).filter((f) => /^CVE-\d{4}-\d{4,}\.json$/.test(f))) {
      const id = file.slice(0, -".json".length);
      if (seen.has(id)) throw new Error(`${id} is in two of the ${which} zip's folders`);
      seen.set(id, fs.readFileSync(path.join(dir, file)));
    }
  }
  return [...seen.keys()].sort(compareCveIds).map((id) => ({ name: `deltaCves/${id}.json`, data: seen.get(id)! }));
}

/**
 * Every generated feed file: the KEV catalog, the bad-count catalog (count = length + 1) and the two
 * stored-method delta zips (deltaCves/<id>.json, entries sorted by id). A pure function of the committed
 * fixtures/src/ and fixtures/feeds/cvelist/ files and config/vendors.json.
 */
export function feedOutputs(): FeedOutput[] {
  const catalog = fixtureKevCatalog() as { count: number };
  return [
    { path: KEV_CATALOG_PATH, text: jsonText(catalog) },
    { path: KEV_BAD_COUNT_PATH, text: jsonText({ ...catalog, count: catalog.count + 1 }) },
    { path: EOD_ZIP_PATH, bytes: storedZip(zipEntries("eod")) },
    { path: HOURLY_ZIP_PATH, bytes: storedZip(zipEntries("hourly")) },
  ];
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  for (const o of feedOutputs()) {
    const abs = path.join(REPO_ROOT, o.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "bytes" in o ? o.bytes : o.text);
    console.log(`wrote ${o.path}`);
  }
}
