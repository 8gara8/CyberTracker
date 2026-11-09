import { z } from "zod";
import { ConfigId, Count, Coverage, CveId, ID_PATTERNS, IsoDate, IsoTimestamp, Language, PublisherId, RegionCode, Sha256, Tier, TimeWindow } from "./common";

// The daily source pack, `packs/D.json` (SPEC §4.14), written by scripts/collect.ts. Every string from
// outside the project has been through sanitize() (lib/sanitize.ts) before it lands here.

export const PACK_ITEMS_MAX = 200;
export const PACK_RECORDS_MAX = 400;

export const PackFlag = z.enum(["injection_like"]);
export const PackRecordSource = z.enum(["kev", "cvelist", "epss", "ghsa", "nvd", "twcert-tvn", "jpcert", "myjvn", "anthropic-cvd", "exchange-tw"]);

export const PackFeed = z.strictObject({
  id: ConfigId,
  kind: z.string().min(1),
  ok: z.boolean(),
  stale: z.boolean(),
  newest: z.string().min(1).nullable(),
  items_total: Count,
  items_kept: Count,
  error: z.string().min(1).nullable(),
  sha256: Sha256.nullable(),
});

export const PackItem = z.strictObject({
  id: z.string().regex(ID_PATTERNS.packItem, { error: 'Expected a pack item id like "p0001"' }),
  feed_id: ConfigId,
  outlet: z.string().min(1),
  publisher: PublisherId,
  tier: Tier,
  language: Language,
  region: RegionCode,
  coverage: z.array(Coverage).min(1),
  title: z.string().max(200).describe("Sanitised, in the original language"),
  snippet: z.string().max(300).describe("Sanitised"),
  url: z.string().min(1).describe("The item's own link, normalised"),
  published_at: IsoTimestamp.describe("UTC"),
  cve_ids: z.array(CveId).describe("Found in title or snippet"),
  alert: z.boolean().describe("URL matches an alert_patterns entry of a region whose agencies include its publisher"),
  flags: z.array(PackFlag),
  score: z.number(),
});

export const PackRecord = z.strictObject({
  id: z.string().regex(ID_PATTERNS.packRecord, { error: 'Expected a pack record id like "r0001"' }),
  source: PackRecordSource,
  record_id: z.string().min(1).describe("CVE, GHSA, JVNDB or TVN id, or a notice number"),
  url: z.string().min(1).describe("Canonical record page"),
  advisory_urls: z.array(z.string().min(1)).describe("Never exploit-tagged or blocked hosts"),
  title: z.string().max(200),
  text: z.string().max(1000),
  date: IsoDate.describe("Event date (KEV dateAdded is a US date)"),
  vendor: z.string().min(1).nullable(),
  product: z.string().min(1).nullable(),
  cve_ids: z.array(CveId),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  flags: z.array(PackFlag),
});

/** packs/D.json (gitignored). */
export const Pack = z.strictObject({
  schema_version: z.literal(1),
  date: IsoDate.describe("Taipei edition date"),
  window: TimeWindow.describe("(D - 1)T04:30:00+08:00 to DT04:30:00+08:00"),
  generated_at: IsoTimestamp,
  data_cutoff_utc: IsoDate,
  degraded: z.boolean(),
  feeds: z.array(PackFeed),
  items: z.array(PackItem).max(PACK_ITEMS_MAX).describe("News and agency headlines, sorted by score"),
  records: z.array(PackRecord).max(PACK_RECORDS_MAX).describe("Structured records relevant today"),
  injection_flags: Count,
});

export type PackFlag = z.infer<typeof PackFlag>;
export type PackRecordSource = z.infer<typeof PackRecordSource>;
export type PackFeed = z.infer<typeof PackFeed>;
export type PackItem = z.infer<typeof PackItem>;
export type PackRecord = z.infer<typeof PackRecord>;
export type Pack = z.infer<typeof Pack>;
