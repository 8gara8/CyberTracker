// The validate loop (SPEC §8.2 stage 7, §4.12 step 3; plan §2.5 "Loop semantics", A7, A8) with fake I/O on
// the weekday fixture inputs: clean at once, a repair, the soft pass and its drop, round 2, the shared
// repair budget, an unparsable draft, a dropped Angle, and a CVE record fetched between checks.
import { describe, expect, it } from "vitest";
import type { DropReport, GatedDraft } from "@/lib/apply";
import type { CveLookup } from "@/lib/rules/types";
import type { DraftBrief } from "@/lib/schema/draft-brief";
import type { Evidence } from "@/lib/schema/misc";
import { cveLookupFromDir, validateDraft, type ValidationIssue, type ValidationResult } from "@/lib/validate";
import { WEEKDAY_ITEMS, editionDraft } from "@/fixtures/src/drafts";
import { CVE_RECORDS_DIR, draftInputs } from "@/fixtures/src/inputs";
import { NO_TEXT_URL, SOFT_CASES, softDraft } from "@/fixtures/src/soft";
import { GatedDraftSchema, validateGated, validateLoop, type ValidateLoopIo, type ValidateLoopState } from "@/scripts/lib/validate-loop";

const I = WEEKDAY_ITEMS;
const UNPARSABLE = Symbol("unparsable");
type Step = DraftBrief | GatedDraft | typeof UNPARSABLE;

const all = draftInputs("weekday");
const { evidence: weekdayEvidence, cveList: weekdayCves, ...inputs } = all;
const soft = (code: string) => softDraft(SOFT_CASES.find((c) => c.code === code)!);
const banned = () => {
  const d = editionDraft("weekday");
  d.items[0]!.summary = d.items[0]!.summary.replace("Ivanti says", "Ivanti says, in an unprecedented step,");
  return d;
};
const angleUnseen = () => {
  const d = editionDraft("weekday");
  d.sources.find((s) => s.id === d.angle.source_id)!.url = NO_TEXT_URL;
  return d;
};

interface Fake {
  io: ValidateLoopIo;
  lines: string[];
  repairs: { round: number; issues: ValidationIssue[] }[];
  written: GatedDraft[];
  validations: ValidationResult[];
  droppedFiles: DropReport[];
  calls: string[];
}

/** `first` is drafts/D.json at the start; each repair writes the next of `after` (or leaves the file as it is). */
function fake(first: Step, after: Step[] = [], o: { budgetMs?: number; cveList?: () => CveLookup; fetchCves?: (ids: readonly string[]) => void } = {}): Fake {
  let current: Step = first;
  const queue = [...after];
  const f: Fake = { lines: [], repairs: [], written: [], validations: [], droppedFiles: [], calls: [], io: undefined as unknown as ValidateLoopIo };
  f.io = {
    readDraft: () => (current === UNPARSABLE ? { ok: false, error: "Unexpected token } in JSON at position 12" } : { ok: true, value: structuredClone(current) }),
    writeDraft: (d) => {
      f.calls.push("writeDraft");
      f.written.push(structuredClone(d));
      current = structuredClone(d);
    },
    fetchCves: async (ids) => {
      f.calls.push("fetchCves");
      o.fetchCves?.(ids);
    },
    snapshot: async () => {
      f.calls.push("snapshot");
    },
    evidence: (): Evidence => weekdayEvidence!,
    cveList: () => {
      f.calls.push("cveList");
      return o.cveList ? o.cveList() : weekdayCves!;
    },
    repair: async (round, issues) => {
      f.calls.push(`repair ${round}`);
      f.repairs.push({ round, issues: [...issues] });
      if (queue.length) current = queue.shift()!;
    },
    repairBudgetMs: () => o.budgetMs ?? 6 * 60_000,
    log: (l) => f.lines.push(l),
    writeValidation: (r) => f.validations.push(r),
    writeDropped: (r) => f.droppedFiles.push(r),
  };
  return f;
}
const st = (repairsUsed = 0, maxRepairs = 2): ValidateLoopState => ({ repairsUsed, maxRepairs });
const codes = (xs: readonly { code: string }[]) => xs.map((x) => x.code);

describe("validateGated", () => {
  it("validates a draft whose Angle was dropped with no SCHEMA issue, and a full draft as validateDraft does", () => {
    const d = editionDraft("weekday");
    expect(validateGated(d, all)).toEqual((({ ok, errors, warnings }) => ({ ok, errors, warnings }))(validateDraft(d, all)));
    const g = { ...soft("SNAP_NUMBER"), angle: null } as GatedDraft;
    expect(GatedDraftSchema.safeParse(g).success).toBe(true);
    expect(codes(validateGated(g, all).errors)).not.toContain("SCHEMA");
    expect(codes(validateDraft(g, all).errors)).toContain("SCHEMA");
  });
});

describe("validateLoop", () => {
  it("V1 a clean draft passes at once with no repair and no drop", async () => {
    const f = fake(editionDraft("weekday"));
    const state = st();
    const out = await validateLoop(1, inputs, f.io, state);
    expect(out).toMatchObject({ ok: true, repairs: 0, drops: null, softGates: { checked: 8, dropped: 0, by_code: {} } });
    expect(out.draft).toEqual(editionDraft("weekday"));
    expect(out.result.errors).toEqual([]);
    expect(out.issues).toEqual([...out.result.errors, ...out.result.warnings]);
    expect(out.result.warnings).toEqual([]);
    expect(f.lines).toEqual(["Attempt 1: 0 errors, 0 warnings (0 snapshot)."]);
    expect(f.repairs).toEqual([]);
    expect(f.written).toEqual([]);
    expect(f.validations).toEqual([out.result]);
    expect(state.repairsUsed).toBe(0);
  });

  it("V2 errors, one repair, then clean", async () => {
    const f = fake(banned(), [editionDraft("weekday")]);
    const state = st();
    const out = await validateLoop(1, inputs, f.io, state);
    expect(out.ok).toBe(true);
    expect(out.repairs).toBe(1);
    expect(state.repairsUsed).toBe(1);
    expect(f.repairs.map((r) => [r.round, codes(r.issues)])).toEqual([[1, ["BANNED_WORDS"]]]);
    expect(f.lines).toEqual([
      "Attempt 1: 1 error, 0 warnings (0 snapshot).",
      "Attempt 1: repair 1 for 1 error and 0 snapshot warnings (BANNED_WORDS).",
      "Attempt 1: 0 errors, 0 warnings (0 snapshot).",
    ]);
    expect(f.validations).toHaveLength(2);
  });

  it("V3 SNAP warnings only: round 1, then the drop, then clean", async () => {
    const d = soft("SNAP_NUMBER");
    const f = fake(d, [d]); // the repair leaves the number as it was
    const state = st();
    const out = await validateLoop(1, inputs, f.io, state);
    expect(out.ok).toBe(true);
    expect(out.repairs).toBe(1);
    expect(f.repairs.map((r) => [r.round, codes(r.issues)])).toEqual([[1, ["SNAP_NUMBER"]]]);
    expect(out.draft!.items.map((it) => it.id)).not.toContain(I.aiConfirmed);
    expect(out.drops!.items.map((x) => [x.id, x.codes])).toEqual([[I.aiConfirmed, ["SNAP_NUMBER"]]]);
    expect(f.droppedFiles.at(-1)).toEqual(out.drops);
    expect(out.softGates).toEqual({ checked: 8, dropped: 1, by_code: { SNAP_NUMBER: 1 } });
    expect(codes(out.result.warnings)).toEqual(["SOURCE_ORPHAN"]);
    expect(f.written).toEqual([]); // no round 2, so the gated draft is not written back
    expect(f.lines).toEqual([
      "Attempt 1: 0 errors, 1 warning (1 snapshot).",
      "Attempt 1: repair 1 for 0 errors and 1 snapshot warning (SNAP_NUMBER).",
      "Attempt 1: 0 errors, 1 warning (1 snapshot).",
      `Attempt 1: the soft pass dropped 1 unverified item (${I.aiConfirmed}).`,
      "Attempt 1: 0 errors, 1 warning (0 snapshot).",
    ]);
  });

  it("V4 a drop that breaks a hard rule goes to round 2, and the gates drop again", async () => {
    const name = soft("SNAP_NAME"); // dropping the Edimax item leaves a Taiwan Lens row with nothing to cite
    const f = fake(name, [name, soft("SNAP_NUMBER")]);
    const out = await validateLoop(1, inputs, f.io, st());
    expect(out.ok).toBe(true);
    expect(out.repairs).toBe(2);
    expect(f.calls.filter((c) => c === "writeDraft" || c.startsWith("repair"))).toEqual(["repair 1", "writeDraft", "repair 2"]);
    expect(f.written[0]!.items.map((it) => it.id)).not.toContain(I.taiwanVendor);
    expect(f.repairs.map((r) => [r.round, codes(r.issues)])).toEqual([[1, ["SNAP_NAME"]], [2, ["TAIWAN_LENS_REQUIRED"]]]);
    // Round 2 put the Edimax item back with its name supported, so only the second drop counts.
    expect(out.draft!.items.map((it) => it.id)).toContain(I.taiwanVendor);
    expect(out.draft!.items.map((it) => it.id)).not.toContain(I.aiConfirmed);
    expect(out.drops!.items.map((x) => [x.id, x.codes])).toEqual([[I.aiConfirmed, ["SNAP_NUMBER"]]]);
    expect(out.softGates).toEqual({ checked: 8, dropped: 1, by_code: { SNAP_NUMBER: 1 } });
    expect(f.droppedFiles.at(-1)).toEqual(out.drops);
    // The run log keeps both drops as they happened.
    expect(f.lines.filter((l) => l.includes("the soft pass dropped"))).toEqual([
      `Attempt 1: the soft pass dropped 1 unverified item (${I.taiwanVendor}).`,
      `Attempt 1: the soft pass dropped 1 unverified item (${I.aiConfirmed}).`,
    ]);
  });

  it("V4 an id dropped in both rounds counts once", async () => {
    const name = soft("SNAP_NAME");
    const f = fake(name, [name, name]); // round 2 puts the Edimax item back, still unsupported
    const out = await validateLoop(1, inputs, f.io, st());
    expect(out.repairs).toBe(2);
    expect(f.lines.filter((l) => l.includes("the soft pass dropped"))).toHaveLength(2);
    expect(out.drops!.items.map((x) => x.id)).toEqual([I.taiwanVendor]);
    expect(out.softGates).toMatchObject({ dropped: 1, by_code: { SNAP_NAME: 1 } });
    expect(f.droppedFiles.at(-1)).toEqual(out.drops);
  });

  it("V4 fails when round 2 does not fix what the drop broke", async () => {
    const name = soft("SNAP_NAME");
    const f = fake(name, [name]); // both repairs leave the file as it was
    const out = await validateLoop(1, inputs, f.io, st());
    expect(out.ok).toBe(false);
    expect(out.draft).toBeNull();
    expect(out.repairs).toBe(2);
    expect(codes(out.result.errors)).toEqual(["TAIWAN_LENS_REQUIRED"]);
    expect(out.issues).toEqual([...out.result.errors, ...out.result.warnings]);
  });

  it("V5 with no round left the drop comes at once", async () => {
    const f = fake(soft("SNAP_NUMBER"));
    const state = st(2, 2);
    const out = await validateLoop(2, inputs, f.io, state);
    expect(out.ok).toBe(true);
    expect(out.repairs).toBe(0);
    expect(f.repairs).toEqual([]);
    expect(out.drops!.items.map((x) => x.id)).toEqual([I.aiConfirmed]);
    expect(state.repairsUsed).toBe(2);
    expect(f.lines[0]).toBe("Attempt 2: 0 errors, 1 warning (1 snapshot).");
  });

  it("V5 with no round left, a Lead sentence citing only the dropped item goes with it (Kobol dry run, 2026-11-11)", async () => {
    const d = soft("SNAP_NUMBER"); // the soft pass drops the AISLE item
    d.lead.push({ text: "A security firm says its AI tool found new flaws in open source code.", item_ids: [I.aiConfirmed], gap: false });
    const k = d.lead.length - 1;
    const f = fake(d);
    const out = await validateLoop(2, inputs, f.io, st(2, 2));
    expect(out.ok).toBe(true);
    expect(codes(out.result.errors)).toEqual([]);
    expect(out.draft!.lead).toHaveLength(k);
    expect(out.drops!.removed).toEqual([{ path: `lead[${k}]`, text: d.lead[k]!.text }]);
    expect(f.droppedFiles.at(-1)).toEqual(out.drops);
    expect(f.lines).toEqual([
      "Attempt 2: 0 errors, 1 warning (1 snapshot).",
      `Attempt 2: the soft pass dropped 1 unverified item (${I.aiConfirmed}).`,
      `Attempt 2: the soft pass removed lead[${k}], left citing no item.`,
      "Attempt 2: 0 errors, 1 warning (0 snapshot).",
    ]);
  });

  it("V6 repairsUsed is shared across attempts", async () => {
    const state = st(0, 2);
    const first = fake(banned(), [banned(), banned()]);
    const a1 = await validateLoop(1, inputs, first.io, state);
    expect(a1).toMatchObject({ ok: false, repairs: 2 });
    expect(state.repairsUsed).toBe(2);
    const second = fake(banned(), [editionDraft("weekday")]);
    const a2 = await validateLoop(2, inputs, second.io, state);
    expect(a2).toMatchObject({ ok: false, repairs: 0 });
    expect(second.repairs).toEqual([]);

    const shared = st(0, 2);
    await validateLoop(1, inputs, fake(banned(), [editionDraft("weekday")]).io, shared);
    expect(shared.repairsUsed).toBe(1);
    const third = fake(banned(), [banned(), editionDraft("weekday")]);
    const a3 = await validateLoop(2, inputs, third.io, shared);
    expect(a3).toMatchObject({ ok: false, repairs: 1 });
    expect(third.repairs.map((r) => r.round)).toEqual([1]);
    expect(shared.repairsUsed).toBe(2);
  });

  it("V7 a repair budget of 0 means no repair", async () => {
    const f = fake(banned(), [editionDraft("weekday")], { budgetMs: 0 });
    const state = st();
    const out = await validateLoop(1, inputs, f.io, state);
    expect(out).toMatchObject({ ok: false, repairs: 0, draft: null });
    expect(f.repairs).toEqual([]);
    expect(state.repairsUsed).toBe(0);
    expect(codes(out.result.errors)).toEqual(["BANNED_WORDS"]);
  });

  it("V8 an unparsable draft gives one SCHEMA issue at (file)", async () => {
    const f = fake(UNPARSABLE);
    const out = await validateLoop(1, inputs, f.io, st(0, 0));
    expect(out.ok).toBe(false);
    expect(out.issues).toEqual([{
      code: "SCHEMA", severity: "error", path: "(file)",
      message: "drafts/2026-10-14.json is not valid JSON (Unexpected token } in JSON at position 12); rewrite the whole file as valid JSON.",
      ...(out.issues[0]!.hint !== undefined ? { hint: out.issues[0]!.hint } : {}),
    }]);
    expect(out.softGates).toEqual({ checked: 0, dropped: 0, by_code: {} });
    expect(f.lines).toEqual(["Attempt 1: 1 error, 0 warnings (0 snapshot)."]);
    expect(f.calls).not.toContain("fetchCves");

    const fixed = fake(UNPARSABLE, [editionDraft("weekday")]);
    const again = await validateLoop(1, inputs, fixed.io, st());
    expect(again.ok).toBe(true);
    expect(fixed.repairs.map((r) => [r.round, r.issues.map((i) => `${i.code} ${i.path}`)])).toEqual([[1, ["SCHEMA (file)"]]]);
  });

  it("V9 a SNAP_MISSING drop of the Angle gives ok, with no SCHEMA issue and angle null", async () => {
    const f = fake(angleUnseen());
    const out = await validateLoop(1, inputs, f.io, st(2, 2));
    expect(out.ok).toBe(true);
    expect(out.draft!.angle).toBeNull();
    expect(out.drops!.angle!.codes).toEqual(["SNAP_MISSING"]);
    expect(codes(out.result.errors)).toEqual([]);
    expect(codes(out.issues)).not.toContain("SCHEMA");
    expect(out.softGates.by_code.SNAP_MISSING).toBe(1);
  });

  it("V9 a null Angle written back before round 2 stays a gated draft in the next check", async () => {
    // The Angle and the Edimax item both drop; the Lens row the Edimax drop broke goes to round 2, whose
    // repair restores the row and keeps the Angle null.
    const d = angleUnseen();
    const nameIdx = d.items.findIndex((it) => it.id === I.taiwanVendor);
    d.items[nameIdx]!.summary = soft("SNAP_NAME").items[nameIdx]!.summary;
    const f = fake(d);
    const io: ValidateLoopIo = { ...f.io, repair: async (round, issues) => {
      f.repairs.push({ round, issues: [...issues] });
      if (round === 2) f.io.writeDraft({ ...editionDraft("weekday"), angle: null });
    } };
    const out = await validateLoop(1, inputs, io, st());
    expect(f.repairs.map((r) => r.round)).toEqual([1, 2]);
    expect(f.written[0]!.angle).toBeNull();
    expect(codes(f.repairs[1]!.issues)).toEqual(["TAIWAN_LENS_REQUIRED"]);
    expect(codes(out.issues)).not.toContain("SCHEMA");
    expect(out.ok).toBe(true);
    expect(out.draft!.angle).toBeNull();
    expect(out.drops!.angle!.codes).toContain("SNAP_MISSING");
  });

  it("V10 a CVE record missing at the first check and fetched before round 1's check clears CVE_PUBLISHED", async () => {
    const cve = "CVE-2026-108917";
    let fetched = false;
    let fetches = 0;
    const base = cveLookupFromDir(CVE_RECORDS_DIR);
    const lookup = (): CveLookup => {
      const have = fetched;
      return { get: (id) => (id === cve && !have ? undefined : base.get(id)) };
    };
    const f = fake(editionDraft("weekday"), [editionDraft("weekday")], {
      cveList: lookup,
      fetchCves: (ids) => {
        expect(ids).toContain(cve);
        if (++fetches === 2) fetched = true; // the first fetch fails, the second finds it
      },
    });
    const out = await validateLoop(1, inputs, f.io, st());
    expect(codes(f.validations[0]!.errors)).toContain("CVE_PUBLISHED");
    expect(f.repairs.map((r) => r.round)).toEqual([1]);
    expect(out.ok).toBe(true);
    expect(codes(out.result.errors)).not.toContain("CVE_PUBLISHED");
    // io.cveList() is read after each fetchCves (plan A8).
    expect(f.calls.filter((c) => c === "fetchCves" || c === "cveList")).toEqual(["fetchCves", "cveList", "fetchCves", "cveList"]);
  });

  it("snapshots only the cited URLs with no seen text, then rebuilds the evidence", async () => {
    const d = editionDraft("weekday");
    const unseen = "https://www.ithome.com.tw/ct-sample/not-yet-seen";
    d.sources.find((s) => s.id === "s3")!.url = unseen;
    let built = 0;
    const urls: string[][] = [];
    const f = fake(d);
    const io: ValidateLoopIo = {
      ...f.io,
      evidence: () => {
        built++;
        return weekdayEvidence!;
      },
      snapshot: async (u) => {
        urls.push([...u]);
      },
    };
    await validateLoop(1, inputs, io, st(2, 2));
    expect(urls).toEqual([[unseen]]);
    expect(built).toBe(2);
  });
});
