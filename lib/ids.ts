// Explicit comparators for ids (SPEC §4.1: no localeCompare anywhere). Every sorted list of CVE ids in a
// state, metrics or manifest file uses compareCveIds(); lists that mix CVE and GHSA ids use compareIds().

const CVE_RE = /^CVE-(\d+)-(\d+)$/i;

/** Plain UTF-16 code-unit order, the same on every platform and locale. Never localeCompare. */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * CVE ids in numeric order: year, then sequence number ("CVE-2026-999" before "CVE-2026-1000"). Ties
 * (and anything that is not a CVE id) fall back to code-unit order, so distinct strings never compare equal.
 */
export function compareCveIds(a: string, b: string): number {
  const pa = CVE_RE.exec(a);
  const pb = CVE_RE.exec(b);
  if (pa && pb) {
    const y = Number(pa[1]) - Number(pb[1]);
    if (y !== 0) return y;
    const s = Number(pa[2]) - Number(pb[2]);
    if (s !== 0) return s;
  }
  return byCodeUnit(a, b);
}

/** CVE ids first, in compareCveIds() order; every other id (GHSA and the like) after them, in code-unit order. */
export function compareIds(a: string, b: string): number {
  const ca = CVE_RE.test(a);
  const cb = CVE_RE.test(b);
  if (ca && cb) return compareCveIds(a, b);
  if (ca !== cb) return ca ? -1 : 1;
  return byCodeUnit(a, b);
}
