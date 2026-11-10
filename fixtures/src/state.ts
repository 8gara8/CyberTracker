// fixtures/state/ (SPEC §10 P2 item 2; ruling R51): content/state/ as the edition before the fixture
// morning left it, so a run for 2026-10-14 on fixtures/feeds/ adds exactly UTC day 2026-10-12 and the two
// KEV entries of catalog 2026.10.13. Built in memory with the production builders, never by hand and never
// from a generated file on disk, so one fixtures:gen pass writes it:
//
//   kev-index.json          buildKevIndex() over the fixture KEV catalog (fixtures/src/feeds.ts) cut at
//                           2026-10-08 (catalog 2026.10.08), with join facts from the rows' own columns,
//                           except FEED_WORLD.rejoinId, left unjoined so the morning re-joins it from
//                           fixtures/feeds/cvelist/by-id/.
//   days.json               fixtures/reference/flood-days.json rows 2023-01-01 to 2026-10-11 (real counts at
//                           CVE List 67c39b1). Their ids are in no fixture, so ids_sha256 is a placeholder:
//                           sha256Hex("fixture " + date).
//   credit-candidates.json  buildCredits() over fixtures/reference/ai-credits.json matches published to
//                           2026-10-11, each as a record whose only credit is the matched tool name (so no
//                           person's name). A lab_context match does not rematch from the tool name alone
//   ai-credits.json         and drops out: the fixture world is its own, not the reference.
//   anthropic-cvd.json      the empty seed (nulls and []), so the morning reads the fixture dashboard as new.
//   series.json             weeklySeries() over the four above, live_from = liveFromAfter(2026-10-11).
//
// Every file's updated_at is 2026-10-11, the previous edition's cutoff.

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../lib/config";
import { parseKev } from "../../lib/feeds/kev";
import type { CreditString, KevCatalog } from "../../lib/feeds/types";
import { jsonText, sha256Hex } from "../../lib/json";
import { aiFindersOf, buildCredits, type CreditRecord } from "../../lib/metrics/ai-credit";
import { dayMap } from "../../lib/metrics/flood";
import { buildKevIndex, indexEntries, indexFacts } from "../../lib/metrics/kev-index";
import { liveFromAfter, weeklySeries } from "../../lib/metrics/series";
import { joinKev, type JoinFacts } from "../../lib/metrics/window";
import { STATE_FILES, STATE_SCHEMAS, type AnthropicCvdFile, type DayRow, type StateFiles } from "../../lib/schema/metrics";
import { ReferenceAiCreditsFile, ReferenceFloodDaysFile } from "../../lib/schema/reference";
import type { Output } from "./build";
import { FEED_WORLD, fixtureKevCatalog, fixtureKevRows } from "./feeds";
import { FIXTURES_DIR, REPO_ROOT } from "./world";

/** The state the fixture morning starts from. */
export const STATE_WORLD = {
  /** updated_at of every file: the cutoff of the edition before FEED_WORLD.date. */
  cutoff: "2026-10-11",
  /** The KEV catalog the previous edition read (world.ts's KEV_1008). */
  kevAsOf: { version: "2026.10.08", lastDateAdded: "2026-10-08", released: "2026-10-08T17:05:40Z" },
  /** The KEV row left unjoined (date_published null); its record is in fixtures/feeds/cvelist/by-id/. */
  rejoinId: FEED_WORLD.rejoinId,
} as const;

export type FixtureState = StateFiles;

export const STATE_DIR = "fixtures/state";
export const statePath = (name: (typeof STATE_FILES)[number]) => `${STATE_DIR}/${name}`;

const REFERENCE_DIR = path.join(FIXTURES_DIR, "reference");
const readReference = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(REFERENCE_DIR, name), "utf8"));

/** The placeholder ids_sha256 of a reference day (its ids are in no fixture). */
export const placeholderIdsSha256 = (date: string): string => sha256Hex(`fixture ${date}`);

/** The fixture KEV catalog as parseKev() reads it from the mirror, cut to the entries the previous edition saw. */
function previousCatalog(): KevCatalog {
  const served = parseKev(Buffer.from(jsonText(fixtureKevCatalog()))).catalog;
  const vulnerabilities = served.vulnerabilities.filter((v) => v.dateAdded <= STATE_WORLD.kevAsOf.lastDateAdded);
  return {
    catalogVersion: STATE_WORLD.kevAsOf.version,
    dateReleased: STATE_WORLD.kevAsOf.released,
    count: vulnerabilities.length,
    vulnerabilities,
  };
}

/** Join facts from the fixture KEV rows' own columns, without the re-join row. */
function kevFacts(): Map<string, JoinFacts> {
  const out = new Map<string, JoinFacts>();
  for (const r of fixtureKevRows()) {
    if (r[0] === STATE_WORLD.rejoinId || r[4] === null) continue;
    out.set(r[0], { state: "PUBLISHED", date_published: r[4], assigner: r[5] });
  }
  return out;
}

/** The reference day counts to the cutoff, each with its placeholder ids_sha256. */
function days(): DayRow[] {
  const ref = ReferenceFloodDaysFile.parse(readReference("flood-days.json"));
  return ref.days.filter((d) => d[0] <= STATE_WORLD.cutoff).map(([date, n, kernel, unscored]) => [date, n, kernel, unscored, placeholderIdsSha256(date)]);
}

/** One record per reference AI match published to the cutoff, its only credit the matched tool name. */
function creditRecords(): CreditRecord[] {
  const ref = ReferenceAiCreditsFile.parse(readReference("ai-credits.json"));
  const out: CreditRecord[] = [];
  for (const [id, published, , , , field, matched] of ref.matches) {
    if (published > STATE_WORLD.cutoff) continue;
    if (field !== "cna.credits" && field !== "adp.credits") throw new Error(`fixtures/reference/ai-credits.json: ${id} has field ${field}, not a CVE record credit`);
    const credits: CreditString[] = [{ field, value: matched }];
    out.push({ cve_id: id, state: "PUBLISHED", date_published: published, credits });
  }
  return out;
}

const emptyCvd = (cutoff: string): AnthropicCvdFile => ({
  schema_version: 1, updated_at: cutoff, revision: null, as_of: null, fetched_at: null, source_url: null,
  found_n: null, disclosed_n: null, patched_n: null, ledger_ids: [],
});

let built: FixtureState | null = null;

function build(): FixtureState {
  const cutoff = STATE_WORLD.cutoff;
  const config = loadConfig({ root: REPO_ROOT });
  const run = aiFindersOf(config, config.compiled);
  const index = buildKevIndex(previousCatalog(), kevFacts(), cutoff);
  const dayRows = days();
  const credits = buildCredits({ records: creditRecords(), ghsa: [] }, run, cutoff);
  const rows = joinKev(indexEntries(index), indexFacts(index));
  const series = weeklySeries({ days: dayMap(dayRows), rows, credits: credits.credits, dataOnlyDates: [] }, cutoff, liveFromAfter(cutoff));
  return {
    "kev-index.json": index,
    "days.json": { schema_version: 1, updated_at: cutoff, days: dayRows },
    "ai-credits.json": credits.credits,
    "credit-candidates.json": credits.candidates,
    "anthropic-cvd.json": emptyCvd(cutoff),
    "series.json": series,
  };
}

/** The six state files of the fixture world (a fresh deep copy each call). */
export function fixtureState(): FixtureState {
  built ??= build();
  return structuredClone(built);
}

/** fixtures/state/<file>, each written through its schema. */
export function stateOutputs(): Output[] {
  const state = fixtureState();
  return STATE_FILES.map((name) => ({ path: statePath(name), text: jsonText(state[name], STATE_SCHEMAS[name]) }));
}
