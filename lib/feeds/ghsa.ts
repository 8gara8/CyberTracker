// GitHub-reviewed advisories from the advisory-database git export (OSV JSON, SPEC §8.3, §5.6). The
// folder `advisories/github-reviewed/YYYY/MM/` is the `published` month. Credits are not read from the
// git export (§5.5: it carries none). Every string is raw feed data.

import { addDays, isValidDate } from "../dates";
import { recordInstant } from "./cvelist";
import type { GhsaAdvisory } from "./types";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** A GHSA id: three groups of four characters from GitHub's alphabet (lower case after "GHSA-"). */
export const GHSA_ID_RE = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;
const CVE_RE = /^CVE-\d{4}-\d{4,}$/;

/** True when some affected[].ranges[].events[] entry has a `fixed` key; last_affected alone is unfixed. */
export function ghsaIsFixed(osv: unknown): boolean {
  return arr(obj(osv).affected).some((a) =>
    arr(obj(a).ranges).some((r) => arr(obj(r).events).some((e) => Object.prototype.hasOwnProperty.call(obj(e), "fixed"))));
}

/**
 * One OSV advisory file; null when it is not a readable advisory (no GHSA id or no readable `published`).
 * `cve_ids` are the CVE aliases, upper case, first-seen order; `published` is the UTC date of
 * `published_at`; `reviewed` is `database_specific.github_reviewed`; `severity` its upper-cased severity.
 */
export function parseGhsa(raw: unknown): GhsaAdvisory | null {
  const o = obj(raw);
  const id = str(o.id);
  if (id === null || !GHSA_ID_RE.test(id)) return null;
  const published_at = recordInstant(o.published);
  if (published_at === null) return null;
  const aliases = arr(o.aliases).filter((a): a is string => typeof a === "string" && a.trim() !== "").map((a) => a.trim());
  const cve_ids = [...new Set(aliases.map((a) => a.toUpperCase()).filter((a) => CVE_RE.test(a)))];
  const db = obj(o.database_specific);
  const severity = str(db.severity);
  const seen = new Set<string>();
  const packages: GhsaAdvisory["packages"] = [];
  for (const a of arr(o.affected)) {
    const p = obj(obj(a).package);
    const ecosystem = str(p.ecosystem);
    const name = str(p.name);
    if (ecosystem === null || name === null) continue;
    const key = `${ecosystem}\u0000${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    packages.push({ ecosystem, name });
  }
  const summary = typeof o.summary === "string" && o.summary.trim() !== "" ? o.summary : null;
  return {
    id,
    aliases,
    cve_ids,
    published_at,
    published: published_at.slice(0, 10),
    modified: recordInstant(o.modified) ?? published_at,
    withdrawn: recordInstant(o.withdrawn),
    severity: severity ? severity.toUpperCase() : null,
    reviewed: db.github_reviewed === true,
    fixed: ghsaIsFixed(raw),
    summary,
    packages,
  };
}

/**
 * The "YYYY/MM" months spanning [cutoff − 120 days, cutoff + 1 day] (ruling R15), oldest first, for the
 * sparse checkout of `advisories/github-reviewed/YYYY/MM`.
 */
export function ghsaMonths(cutoff: string): string[] {
  if (!isValidDate(cutoff)) throw new Error(`ghsaMonths: invalid cutoff ${cutoff}`);
  const last = addDays(cutoff, 1).slice(0, 7);
  const out: string[] = [];
  let y = Number(addDays(cutoff, -120).slice(0, 4));
  let m = Number(addDays(cutoff, -120).slice(5, 7));
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    out.push(ym.replace("-", "/"));
    if (ym >= last) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** An advisory's page on github.com/advisories (the pack record URL). Throws for a non-GHSA id. */
export function ghsaRecordUrl(id: string): string {
  if (!GHSA_ID_RE.test(id)) throw new Error(`Not a GHSA id: ${JSON.stringify(id)}`);
  return `https://github.com/advisories/${id}`;
}
