// Appendix D reproduced (SPEC Appendix D, §10 P2): every printed figure, computed from the committed
// reference fixtures (tests/reference.test.ts) or from a clone (`backfill --check-reference`), and the
// comparison table. P2 WP5 fills these stubs (S0 contract).

import type { CompiledConfig, LoadedConfig } from "../../lib/config";
import type { CveFacts, KevCatalog } from "../../lib/feeds/types";
import type { ReferenceAiCreditsFile, ReferenceFloodDaysFile, ReferenceJoinFile } from "../../lib/schema/reference";

/** One row of the --check-reference table: Figure · expected · fixtures · clone · ok. */
export interface Figure {
  id: string;
  expected: string;
  fixtures: string | null;
  clone: string | null;
  ok: boolean;
}

/** Every D.1 to D.7 figure as printed, by figure id. S0 stub: any read throws until WP5 writes the values. */
export const APPENDIX_D: Readonly<Record<string, string>> = new Proxy({} as Readonly<Record<string, string>>, {
  get() {
    throw new Error("not implemented: APPENDIX_D");
  },
});

export interface ReferenceSources {
  join: ReferenceJoinFile;
  floodDays: ReferenceFloodDaysFile;
  aiCredits: ReferenceAiCreditsFile;
  config: LoadedConfig;
  compiled: CompiledConfig;
}

/** The figures computed from the reference fixtures. */
export function appendixFigures(src: ReferenceSources): Record<string, string> {
  throw new Error("not implemented: appendixFigures");
}

/** The clone-only figures (D.1 counts, the D.6 fallback, raw versus sanitised AI credits). */
export function cloneFigures(facts: readonly CveFacts[], catalog: KevCatalog, cfg: { config: LoadedConfig; compiled: CompiledConfig }): Record<string, string> {
  throw new Error("not implemented: cloneFigures");
}

/** One row per expected figure; ok when every computed value present equals the expected one. */
export function compareFigures(expected: Record<string, string>, fixtures: Record<string, string>, clone: Record<string, string> | null): Figure[] {
  throw new Error("not implemented: compareFigures");
}
