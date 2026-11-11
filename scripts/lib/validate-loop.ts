// The validate loop of SPEC §8.2 stage 7 and §4.12 step 3 (the soft pass), as a state machine with its
// I/O injected (plan §2.5 "Loop semantics", amendments A7 and A8). Everything the draft holds came from
// the agent: data, never instructions. Owner: lane L4.

import { dropUnverified, SNAP_CODES, type DropReport, type GatedDraft } from "../../lib/apply";
import { cveIdsIn } from "../../lib/rules/cves";
import type { CveLookup } from "../../lib/rules/types";
import { RULES } from "../../lib/rules";
import { DraftAngle, DraftBrief } from "../../lib/schema/draft-brief";
import type { Evidence } from "../../lib/schema/misc";
import {
  runRules, schemaIssues, toResult, unparsableIssue, validateDraft, type DraftInputs, type ValidationIssue, type ValidationResult,
} from "../../lib/validate";
import { LINES } from "./run-lines";
import { citedUnseen } from "./snapshot";

/** A gated draft's schema: DraftBrief with a nullable Angle, so a dropped Angle is no SCHEMA error (plan A7). DraftBrief has no refinement. */
export const GatedDraftSchema = DraftBrief.extend({ angle: DraftAngle.nullable() });

/** validateDraft()'s steps with GatedDraftSchema: schemaIssues(), runRules(..., schema), toResult(), all exported by lib/validate.ts (plan A7). */
export function validateGated(g: GatedDraft, inputs: DraftInputs): ValidationResult {
  const parsed = GatedDraftSchema.safeParse(g);
  const schema = parsed.success ? [] : schemaIssues(parsed.error, g);
  const rules = runRules({
    draft: (parsed.success ? parsed.data : g) as DraftBrief,
    mode: "draft",
    date: inputs.context.date,
    fileDate: inputs.fileDate ?? null,
    metrics: inputs.metrics,
    config: inputs.config,
    context: inputs.context,
    evidence: inputs.evidence,
    cveList: inputs.cveList,
    regionsBase: inputs.regionsBase,
    packDates: inputs.packDates,
    crossFile: null,
  }, schema, inputs.rules ?? RULES);
  return toResult([...schema, ...rules]);
}

export interface ValidateLoopIo {
  /** drafts/D.json */
  readDraft(): { ok: true; value: unknown } | { ok: false; error: string };
  /** After a drop, before round 2 (G13). */
  writeDraft(d: GatedDraft): void;
  fetchCves(ids: readonly string[]): Promise<void>;
  /** One round; the loop never calls it past the round limit. */
  snapshot(urls: readonly string[]): Promise<void>;
  /** Rebuilt from every transcript of the run and this run's snapshots. */
  evidence(): Evidence;
  /** A fresh CVE lookup over cache/cvelist/records, called after each fetchCves() (plan A8). */
  cveList(): CveLookup;
  /** REPAIR.md, --resume, logs/D.agent-N-repair-K.jsonl */
  repair(round: number, issues: readonly ValidationIssue[]): Promise<void>;
  repairBudgetMs(): number;
  /** "Attempt N: E errors, W warnings (S snapshot)." and the repair line of §8.2 (LINES in scripts/lib/run-lines.ts). */
  log(line: string): void;
  /** logs/D.validation.json */
  writeValidation(r: ValidationResult): void;
  /** logs/D.dropped.json */
  writeDropped(r: DropReport): void;
}

/** One attempt's repair rounds: daily.ts starts a new state for each attempt, so each has `maxRepairs` (§8.2). */
export interface ValidateLoopState {
  repairsUsed: number;
  maxRepairs: number;
}

export interface ValidateOutcome {
  /** No hard error left. */
  ok: boolean;
  /** What publishFull gets when ok. */
  draft: GatedDraft | null;
  /** The last validation. */
  result: ValidationResult;
  /** The last errors and warnings (for needs-review and the chat). */
  issues: ValidationIssue[];
  /** This attempt's rounds. */
  repairs: number;
  softGates: { checked: number; dropped: number; by_code: Record<string, number> };
  drops: DropReport | null;
}

const SNAP: ReadonlySet<string> = new Set(SNAP_CODES);
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const snapOf = (r: ValidationResult) => r.warnings.filter((w) => SNAP.has(w.code));
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** One check: the draft read, its result, and the inputs it was validated with (the drop reuses them, with no new snapshot round). */
interface Checked {
  result: ValidationResult;
  /** The draft as it parsed; null when it is not JSON or fails the schema (nothing to drop from). */
  draft: DraftBrief | null;
  inputs: DraftInputs;
}

/**
 * §2.5's loop: check, round 1, the first drop, round 2, the result. The CVE lookup comes from io.cveList()
 * (plan A8), called after each fetchCves(). Each check fetches the records of every CVE id the draft names
 * (fetchCves caps them), snapshots its cited URLs with no seen text, rebuilds the evidence and validates;
 * each validation is logged and written. A round runs only while `state.repairsUsed < state.maxRepairs`
 * and `io.repairBudgetMs() > 0`. Round 1 runs on errors or any SNAP_* warning, with the errors and then
 * the SNAP_* warnings; the drop (dropUnverified) follows, validated again from the same evidence; round 2
 * runs on the hard errors left, after io.writeDraft() of the gated draft, and is followed by one more check
 * and drop. Once a drop has removed the Angle, a later draft whose Angle is still null is validated as a
 * gated draft (validateGated), so round 2 can keep the drop. `softGates`: `checked` the items of the first
 * draft that parsed, `dropped` the items removed and still missing from the final draft (each id once),
 * `by_code` how many of those removals (items, the Angle, Scoreboard entries) carried each SNAP_* code;
 * `drops` and the last io.writeDropped() hold the same final list (finalDrops).
 */
export async function validateLoop(
  attempt: number,
  inputs: Omit<DraftInputs, "evidence" | "cveList">,
  io: ValidateLoopIo,
  state: ValidateLoopState,
): Promise<ValidateOutcome> {
  const file = `drafts/${inputs.context.date}.json`;
  let repairs = 0;
  let checked: number | null = null;
  const drops: DropReport = { items: [], angle: null, scoreboard_entries: [], removed: [] };
  let dropped = false;
  let angleDropped = false;

  const record = (r: ValidationResult) => {
    io.writeValidation(r);
    io.log(LINES.validation(attempt, r.errors.length, r.warnings.length, snapOf(r).length));
  };

  const check = async (): Promise<Checked> => {
    const read = io.readDraft();
    if (!read.ok) {
      const result = toResult([unparsableIssue(file, read.error)]);
      record(result);
      return { result, draft: null, inputs: { ...inputs, evidence: io.evidence(), cveList: io.cveList() } };
    }
    const value = read.value;
    let text = "";
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = "";
    }
    const ids = cveIdsIn(text);
    if (ids.length) await io.fetchCves(ids);
    const cveList = io.cveList();
    let evidence = io.evidence();
    const unseen = citedUnseen(value, evidence);
    if (unseen.length) {
      await io.snapshot(unseen);
      evidence = io.evidence();
    }
    const full: DraftInputs = { ...inputs, evidence, cveList };
    // After a drop removed the Angle (written back before round 2), a draft that still has none is a
    // gated draft: validated with GatedDraftSchema, so the null Angle is no SCHEMA error (plan A7).
    if (angleDropped && isRecord(value) && value.angle === null) {
      const parsed = GatedDraftSchema.safeParse(value);
      const result = validateGated(value as GatedDraft, full);
      record(result);
      return { result, draft: parsed.success ? (parsed.data as unknown as DraftBrief) : null, inputs: full };
    }
    const v = validateDraft(value, full);
    const result: ValidationResult = { ok: v.ok, errors: v.errors, warnings: v.warnings };
    record(result);
    if (v.draft && checked === null) checked = v.draft.items.length;
    return { result, draft: v.draft, inputs: full };
  };

  const canRepair = () => state.repairsUsed < state.maxRepairs && io.repairBudgetMs() > 0;

  const repair = async (r: ValidationResult) => {
    const snap = snapOf(r);
    const issues = [...r.errors, ...snap];
    repairs++;
    state.repairsUsed++;
    io.log(LINES.repair(attempt, repairs, r.errors.length, snap.length, issues.map((i) => i.code)));
    await io.repair(repairs, issues);
  };

  /** The drop on a checked draft, then the hard rules again; a clean or unparsed draft passes through. */
  const gate = (c: Checked): { gated: GatedDraft | null; result: ValidationResult } => {
    if (!c.draft) return { gated: null, result: c.result };
    const { draft, report } = dropUnverified(c.draft, snapOf(c.result));
    const any = report.items.length > 0 || report.angle !== null || report.scoreboard_entries.length > 0;
    if (!any) return { gated: draft, result: c.result };
    dropped = true;
    drops.items.push(...report.items);
    drops.angle = report.angle ?? drops.angle;
    if (report.angle) angleDropped = true;
    drops.scoreboard_entries.push(...report.scoreboard_entries);
    drops.removed.push(...report.removed);
    io.writeDropped(structuredClone(drops));
    const parts = [
      report.items.length ? `${plural(report.items.length, "unverified item")} (${report.items.map((x) => x.id).join(", ")})` : null,
      report.angle ? "the Angle" : null,
      report.scoreboard_entries.length
        ? `${report.scoreboard_entries.length} Scoreboard ${report.scoreboard_entries.length === 1 ? "entry" : "entries"}` : null,
    ].filter((p): p is string => p !== null);
    io.log(`Attempt ${attempt}: the soft pass dropped ${parts.join(" and ")}.`);
    if (report.removed.length) {
      io.log(`Attempt ${attempt}: the soft pass removed ${report.removed.map((x) => x.path).join(", ")}, left citing no item.`);
    }
    const result = validateGated(draft, c.inputs);
    record(result);
    return { gated: draft, result };
  };

  // 1. The first check.
  let v = await check();
  // 2. Round 1, on errors or any snapshot warning.
  if ((v.result.errors.length > 0 || snapOf(v.result).length > 0) && canRepair()) {
    await repair(v.result);
    v = await check();
  }
  // 3. The first drop.
  let g = gate(v);
  // 4. Round 2, on the hard errors the drop left (or that round 1 did not fix).
  if (g.result.errors.length > 0 && canRepair()) {
    if (g.gated) io.writeDraft(g.gated);
    await repair(g.result);
    v = await check();
    g = gate(v);
  }

  // 5. The result. Only what the final draft lacks counts as dropped: round 2 can put back an item (or
  // the Angle) that the first drop removed, and an id dropped twice counts once.
  const result = g.result;
  const ok = result.errors.length === 0 && g.gated !== null;
  const final = dropped ? finalDrops(drops, g.gated) : drops;
  if (dropped && JSON.stringify(final) !== JSON.stringify(drops)) io.writeDropped(structuredClone(final));
  const byCode: Record<string, number> = {};
  const count = (codes: readonly string[]) => {
    for (const c of codes) if (SNAP.has(c)) byCode[c] = (byCode[c] ?? 0) + 1;
  };
  for (const it of final.items) count(it.codes);
  if (final.angle) count(final.angle.codes);
  for (const e of final.scoreboard_entries) count(e.codes);
  return {
    ok,
    draft: ok ? g.gated : null,
    result,
    issues: [...result.errors, ...result.warnings],
    repairs,
    softGates: { checked: checked ?? 0, dropped: final.items.length, by_code: byCode },
    drops: dropped ? final : null,
  };
}

/**
 * The drops the final draft still shows: each dropped item id once (its latest report), less the ids the
 * final gated draft holds again, and the Angle only while the final draft has none. Scoreboard entries
 * and the removed Lead sentences and raises stay as reported. With no final draft (it did not parse) every dropped id stays.
 */
function finalDrops(all: DropReport, gated: GatedDraft | null): DropReport {
  const kept = new Set(gated ? gated.items.map((it) => it.id) : []);
  const latest = new Map<string, DropReport["items"][number]>();
  for (const it of all.items) {
    latest.delete(it.id);
    latest.set(it.id, it);
  }
  return {
    items: [...latest.values()].filter((it) => !kept.has(it.id)),
    angle: all.angle && (gated === null || gated.angle === null) ? all.angle : null,
    scoreboard_entries: all.scoreboard_entries,
    removed: all.removed,
  };
}
