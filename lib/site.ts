// Site-wide settings (SPEC §6 "Content loading", §9.7), adapted from the fork's lib/site.ts. Names and
// URLs come from config/run.json; the only variable read is CT_CONTENT_DIR (P4 adds CT_LOOK), never a
// secret. run.json is imported as a module so the site bundles it; lib/config.ts parses the same file with
// its schema (CONFIG_SCHEMA), and contentDir() cannot wait for loadConfig(), which needs isSampleData().

import path from "node:path";
import run from "../config/run.json";

/** run.json site.name. */
export const SITE_NAME: string = run.site.name;
/** run.json site.tagline. */
export const SITE_TAGLINE: string = run.site.tagline;

/** run.json site.url, trailing slashes removed. No variable overrides it. */
export function siteUrl(): string {
  return run.site.url.replace(/\/+$/, "");
}

/** The content folder: CT_CONTENT_DIR, else run.json paths.content_dir ("content"), as given (relative to the repo root). */
export function contentDir(): string {
  return process.env.CT_CONTENT_DIR || run.paths.content_dir;
}

/**
 * True only when the content folder is a folder under `fixtures/` (the sample and the empty folder):
 * the layout then shows the sample banner and loadConfig() reads `fixtures/config/claims.json` (§4.11).
 * `fixtures/` itself and every folder outside it (content/, logs/dry-run/tree, a temporary copy) are not.
 */
export function isSampleData(dir: string = contentDir(), root: string = process.cwd()): boolean {
  const rel = path.relative(path.resolve(root, "fixtures"), path.resolve(root, dir));
  return rel !== "" && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== "..";
}

/**
 * The correction issue form (§4.10, §9.2): https://github.com/<run.json repos.repo>/issues/new?template=correction.yml,
 * pre-filled with the item id and edition date when an item is given.
 */
export function issueFormUrl(item?: { id: string; date: string }): string {
  const base = `https://github.com/${run.repos.repo}/issues/new?template=correction.yml`;
  if (!item) return base;
  return `${base}&item_id=${encodeURIComponent(item.id)}&edition_date=${encodeURIComponent(item.date)}`;
}
