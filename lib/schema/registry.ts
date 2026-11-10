import { z } from "zod";
import { Coverage, ConfigId, Language, RegionCode, uniqueArray } from "./common";

// The source registry, `config/sources.yaml` (SPEC §4.13). Every key is written out, never optional
// (§4.1): fetched entries carry `fallback_url: null`, `must_match: false` and `date_zone: null` where unused. It holds no
// tiers: a URL's tier, publisher and kind always come from publisherFor(). Counts and coverage minimums
// are tests/config.test.ts's requirements, not schema facts.

/** Kinds collect fetches, each parsed by lib/feeds/<kind>.ts; `search` entries are never fetched. */
export const FETCHED_FEED_KINDS = ["rss", "kev", "cvelist", "epss", "ghsa", "nvd", "myjvn", "anthropic-cvd", "exchange"] as const;
export const FEED_KINDS = [...FETCHED_FEED_KINDS, "search"] as const;
export type FetchedFeedKind = (typeof FETCHED_FEED_KINDS)[number];
export type FeedKind = (typeof FEED_KINDS)[number];

const HttpsUrl = z.url({
  protocol: /^https$/,
  error: (iss) => (iss.code === "invalid_format" ? "Expected an https URL" : undefined),
});

/** A UTC offset as "+08:00" or "-05:00" (never "Z": null stands for UTC). */
const UtcOffset = z.string().regex(/^[+-](?:0\d|1[0-4]):[0-5]\d$/, "Expected an offset like +08:00");

const entryHead = {
  id: ConfigId,
  name: z.string().min(1),
};
const entryTail = {
  language: Language.describe("BCP 47: en, zh-Hant-TW, ja, zh-Hans-CN, de, fr"),
  region: RegionCode.describe("The region it mainly covers"),
  coverage: uniqueArray(Coverage, "coverage").min(1),
  priority: z.literal([1, 2, 3]).describe("1 high, 2 normal, 3 low"),
};

export const FetchedFeed = z.strictObject({
  ...entryHead,
  kind: z.enum(FETCHED_FEED_KINDS),
  url: HttpsUrl,
  fallback_url: HttpsUrl.nullable(),
  ...entryTail,
  fresh_days: z.int().min(1).describe("The newest entry must be younger"),
  must_match: z.boolean().describe("true keeps only items that hit a keyword"),
  date_zone: UtcOffset.nullable().describe("The zone of the feed's zone-less dates when its channel gives no offset (+08:00 for iThome); null reads them as UTC"),
});

export const SearchFeed = z.strictObject({
  ...entryHead,
  kind: z.literal("search"),
  query: z.string().min(1),
  ...entryTail,
});

export const FeedEntry = z.discriminatedUnion("kind", [FetchedFeed, SearchFeed]);

/** config/sources.yaml. */
export const SourcesFile = z.strictObject({
  schema_version: z.literal(1),
  keywords: z.array(z.string().min(1)).min(40).describe("At least 40, in English, Traditional Chinese and Japanese"),
  feeds: z.array(FeedEntry),
});

export type FetchedFeed = z.infer<typeof FetchedFeed>;
export type SearchFeed = z.infer<typeof SearchFeed>;
export type FeedEntry = z.infer<typeof FeedEntry>;
export type SourcesFile = z.infer<typeof SourcesFile>;
