// The CISA KEV catalog (SPEC §8.3, §5.3): the parser, the advisory URLs in `notes`, and kevBaseline(),
// the one "new on KEV" for collect, the data-only edition and the candidates. The parser keeps §8.3's
// fields and strips the rest (§4.1's feed rule). Every string is raw feed data.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { addDays, dataCutoffFor, isValidDate } from "../dates";
import { compareCveIds } from "../ids";
import { sha256Hex } from "../json";
import { CveId } from "../schema/common";
import { KevIndexFile, type Metrics } from "../schema/metrics";
import { FeedParseError, type KevCatalog, type KevEntry, type Parsed } from "./types";

const CVE_RE = /^CVE-\d{4}-\d{4,}$/i;
const text = z.string().catch("");

const KevEntrySchema = z.object({
  cveID: z.string().trim().regex(CVE_RE).transform((s) => s.toUpperCase()),
  vendorProject: text,
  product: text,
  vulnerabilityName: text,
  dateAdded: z.string().trim().refine(isValidDate),
  shortDescription: text,
  requiredAction: text,
  dueDate: text,
  knownRansomwareCampaignUse: text,
  forensicTriage: z.string().nullish().catch(null).transform((v) => v ?? null),
  notes: text,
  cwes: z.array(z.string()).catch([]),
});

const KevCatalogSchema = z.object({
  catalogVersion: z.string().trim().min(1),
  dateReleased: z.string().trim().min(1),
  count: z.int().min(0),
  vulnerabilities: z.array(KevEntrySchema),
});

/**
 * The catalog. `count` must equal the entries and every entry must carry a CVE-form cveID and a dateAdded
 * date, else FeedParseError "schema"; not JSON is "parse", no entries "empty". cveIDs come back upper case.
 * `newest` is dateReleased, `version` catalogVersion.
 */
export function parseKev(body: Buffer): Parsed<KevEntry> & { catalog: KevCatalog } {
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    throw new FeedParseError("parse", "KEV catalog is not JSON");
  }
  const parsed = KevCatalogSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FeedParseError("schema", `KEV catalog: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unreadable"}`);
  }
  const catalog: KevCatalog = parsed.data;
  if (catalog.count !== catalog.vulnerabilities.length) {
    throw new FeedParseError("schema", `KEV catalog: count ${catalog.count} but ${catalog.vulnerabilities.length} entries`);
  }
  if (catalog.vulnerabilities.length === 0) throw new FeedParseError("empty", "KEV catalog has no entries");
  return {
    newest: catalog.dateReleased,
    entries: catalog.vulnerabilities,
    version: catalog.catalogVersion,
    sha256: sha256Hex(body),
    total: catalog.vulnerabilities.length,
    catalog,
  };
}

/**
 * The URLs in a KEV `notes` field: split on ";", trimmed, the first http(s) URL of each part (a part may
 * carry a label, "BOD 26-04: https://…"), raw. Parts without a URL are skipped; collect filters the rest.
 */
export function kevNoteUrls(notes: string): string[] {
  const out: string[] = [];
  for (const part of notes.split(";")) {
    const m = /https?:\/\/\S+/i.exec(part.trim());
    if (m) out.push(m[0]);
  }
  return out;
}

export interface NewKevIdsInput {
  date: string;
  catalog: KevCatalog;
  /** Past-date dry runs (P3): the catalog is cut to dateAdded ≤ D − 1 and the ids added on D − 1 are new. */
  asOf: boolean;
  committedMetrics: Pick<Metrics, "kev"> | null;
  kevIndex: Pick<KevIndexFile, "entries"> | null;
}

export interface NewKevIdsResult {
  newKevIds: string[];
  source: "as-of" | "metrics" | "kev-index" | "recent-7-days";
  /** The catalog as used (cut when asOf). */
  catalog: KevCatalog;
}

/** KEV order: dateAdded, then CVE number (newest last, as `new_since_last_edition.cve_ids`). */
const byAdded = (a: KevEntry, b: KevEntry) => (a.dateAdded < b.dateAdded ? -1 : a.dateAdded > b.dateAdded ? 1 : compareCveIds(a.cveID, b.cveID));

/**
 * §8.3 kevBaseline(), pure core, for the Taipei edition date D:
 * (0) asOf: the catalog cut to dateAdded ≤ D − 1 (its count follows), new = the entries added on D − 1;
 * (1) a committed metrics file for D: its `kev.new_since_last_edition.cve_ids`, as written;
 * (2) a kev-index: the catalog entries not in it;
 * (3) neither: the entries added on or after cutoff − 6 (the 7 days ending on the cutoff, D − 2, and later).
 * Ids from (0), (2) and (3) come in KEV order (dateAdded, then CVE number).
 */
export function newKevIds(i: NewKevIdsInput): NewKevIdsResult {
  if (!isValidDate(i.date)) throw new Error(`newKevIds: invalid date ${i.date}`);
  if (i.asOf) {
    const dayBefore = addDays(i.date, -1);
    const kept = i.catalog.vulnerabilities.filter((v) => v.dateAdded <= dayBefore);
    const catalog: KevCatalog = { ...i.catalog, count: kept.length, vulnerabilities: kept };
    const ids = kept.filter((v) => v.dateAdded === dayBefore).sort(byAdded).map((v) => v.cveID);
    return { newKevIds: ids, source: "as-of", catalog };
  }
  const committed = i.committedMetrics?.kev?.new_since_last_edition.cve_ids;
  if (committed) return { newKevIds: [...committed], source: "metrics", catalog: i.catalog };
  if (i.kevIndex) {
    const known = new Set(i.kevIndex.entries.map((r) => r[0]));
    const ids = i.catalog.vulnerabilities.filter((v) => !known.has(v.cveID)).sort(byAdded).map((v) => v.cveID);
    return { newKevIds: ids, source: "kev-index", catalog: i.catalog };
  }
  const from = addDays(dataCutoffFor(i.date), -6);
  const ids = i.catalog.vulnerabilities.filter((v) => v.dateAdded >= from).sort(byAdded).map((v) => v.cveID);
  return { newKevIds: ids, source: "recent-7-days", catalog: i.catalog };
}

/** Only what kevBaseline() reads from a committed metrics file. */
const CommittedKev = z.object({
  kev: z.object({ new_since_last_edition: z.object({ cve_ids: z.array(CveId) }) }).nullable(),
});

function readJson(file: string): unknown {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The file wrapper: reads `<contentDir>/metrics/D.json` and `<contentDir>/state/kev-index.json`. A file
 * that is missing or does not parse counts as absent, so the next rule applies.
 */
export function kevBaseline(a: { contentDir: string; date: string; catalog: KevCatalog; asOf: boolean }): ReturnType<typeof newKevIds> {
  if (!isValidDate(a.date)) throw new Error(`kevBaseline: invalid date ${a.date}`);
  const metrics = CommittedKev.safeParse(readJson(path.join(a.contentDir, "metrics", `${a.date}.json`)));
  const index = KevIndexFile.safeParse(readJson(path.join(a.contentDir, "state", "kev-index.json")));
  return newKevIds({
    date: a.date,
    catalog: a.catalog,
    asOf: a.asOf,
    committedMetrics: metrics.success ? (metrics.data as Pick<Metrics, "kev">) : null,
    kevIndex: index.success ? index.data : null,
  });
}
