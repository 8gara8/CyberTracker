// Taiwan Lens KEV lines (SPEC §5.7): KEV additions whose matched vendor is headquartered in Taiwan or
// Japan, any lag (an old flaw counts here, not for region levels, §5.11), over the 30 and 90 days ending
// at the data cutoff. Pure; the KEV entries and the vendor list come in as parameters.

import { matchVendor } from "../config";
import { inRange, windowEnding } from "../dates";
import type { KevLine } from "../schema/brief";
import type { VendorsFile } from "../schema/config";
import type { HomeVendorKev, HomeVendorRow, Metrics } from "../schema/metrics";
import { fmtDate, fmtInt } from "./stats";

/** The two home-vendor keys and the vendor country each counts. */
export const HOME_VENDOR_COUNTRIES = { tw: "TW", jp: "JP" } as const;
export type HomeVendorKey = keyof typeof HOME_VENDOR_COUNTRIES;
const HOME_KEYS = Object.keys(HOME_VENDOR_COUNTRIES) as HomeVendorKey[];

/** The adjective each line uses. */
const HOME_VENDOR_ADJECTIVE: Record<HomeVendorKey, string> = { tw: "Taiwanese", jp: "Japanese" };

/**
 * One KEV entry as homeVendorKev() reads it: the CVE id, `dateAdded` (a US date, compared as a plain
 * calendar date), KEV's `vendorProject` as written, and optionally the CVE record's CNA `affected[].vendor`
 * values, matchVendor()'s fallback (§4.11).
 */
export interface KevVendorEntry {
  cve_id: string;
  date_added: string;
  vendor_project: string;
  affected_vendors?: readonly (string | null | undefined)[];
}

/**
 * `metrics.home_vendors` (§4.7): for `tw` and `jp`, the KEV entries with `date_added` in the 30 and 90 days
 * ending at `cutoff` whose matched vendor's `country` is TW (or JP). `cve_ids_90` lists the 90-day entries
 * with their vendor id, sorted by `date_added`, then CVE id; the inputs manifest's `home_vendors` takes
 * the same rows. Entries after the cutoff are not counted.
 */
export function homeVendorKev(
  entries: readonly KevVendorEntry[],
  config: { vendors: VendorsFile },
  cutoff: string,
): Record<HomeVendorKey, HomeVendorKev> {
  const d30 = windowEnding(cutoff, 30);
  const d90 = windowEnding(cutoff, 90);
  const rows: Record<HomeVendorKey, HomeVendorRow[]> = { tw: [], jp: [] };
  for (const e of entries) {
    if (!inRange(e.date_added, d90.from, d90.to)) continue;
    const vendor = matchVendor(config, { kevVendorProject: e.vendor_project, affectedVendors: e.affected_vendors ?? [] });
    if (!vendor) continue;
    for (const key of HOME_KEYS) {
      if (vendor.country === HOME_VENDOR_COUNTRIES[key]) rows[key].push({ cve_id: e.cve_id, vendor_id: vendor.id, date_added: e.date_added });
    }
  }
  const out = {} as Record<HomeVendorKey, HomeVendorKev>;
  for (const key of HOME_KEYS) {
    const list = rows[key].sort((a, b) => (a.date_added === b.date_added ? compareCveIds(a.cve_id, b.cve_id) : a.date_added < b.date_added ? -1 : 1));
    out[key] = {
      to: cutoff,
      d30_from: d30.from,
      d30_n: list.filter((r) => inRange(r.date_added, d30.from, d30.to)).length,
      d90_from: d90.from,
      d90_n: list.length,
      cve_ids_90: list,
    };
  }
  return out;
}

/** CVE ids in numeric order: year, then sequence number ("CVE-2026-999" before "CVE-2026-1000"). */
function compareCveIds(a: string, b: string): number {
  const pa = /^CVE-(\d+)-(\d+)$/i.exec(a);
  const pb = /^CVE-(\d+)-(\d+)$/i.exec(b);
  if (pa && pb) {
    const y = Number(pa[1]) - Number(pb[1]);
    if (y !== 0) return y;
    const s = Number(pa[2]) - Number(pb[2]);
    if (s !== 0) return s;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * §5.7's line, exactly: "KEV additions for Taiwanese vendors: {d30_n} in 30 days, {d90_n} in 90, to
 * {fmtDate(to)} (US date)." (Japanese for `jp`). Numbers are digits, 0 included. `editionDate` decides
 * whether fmtDate() shows the year.
 */
export function kevLine(key: HomeVendorKey, hv: Pick<HomeVendorKev, "d30_n" | "d90_n" | "to">, editionDate: string): string {
  return `KEV additions for ${HOME_VENDOR_ADJECTIVE[key]} vendors: ${fmtInt(hv.d30_n)} in 30 days, ${fmtInt(hv.d90_n)} in 90, to ${fmtDate(hv.to, editionDate)} (US date).`;
}

/** The line when the home_vendors block failed with no earlier value (metrics.home_vendors null). */
export function kevLineUnavailable(key: HomeVendorKey): string {
  return `KEV additions for ${HOME_VENDOR_ADJECTIVE[key]} vendors: not available today.`;
}

/**
 * The brief's `taiwan_lens.kev_lines` (§4.5) from the same-date metrics: `{ d30_n, d90_n, text }` for TW
 * and JP. With `home_vendors` null the counts are 0 and the text is kevLineUnavailable(). GAP_MATCH, the
 * data-only composer and publish all build the lines here, so they cannot drift.
 */
export function kevLines(metrics: Pick<Metrics, "date" | "home_vendors">): Record<HomeVendorKey, KevLine> {
  const out = {} as Record<HomeVendorKey, KevLine>;
  for (const key of HOME_KEYS) {
    const hv = metrics.home_vendors?.[key] ?? null;
    out[key] = hv
      ? { d30_n: hv.d30_n, d90_n: hv.d90_n, text: kevLine(key, hv, metrics.date) }
      : { d30_n: 0, d90_n: 0, text: kevLineUnavailable(key) };
  }
  return out;
}
