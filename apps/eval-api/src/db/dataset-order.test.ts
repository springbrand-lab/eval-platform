import { describe, expect, it } from "vitest";
import { resolveDatasetMemberOrder } from "./dataset-order.js";

const OWNER = "owner-A";
const DATASET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// Deliberately the reverse of UUID order: the file's first row is SECOND.
const FIRST = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SECOND = "11111111-1111-4111-8111-111111111111";
const THIRD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const dataset = { datasetId: DATASET, kind: "prompt" as const, originalOrderIntact: true };
const members = [
  { dataId: SECOND, position: null },
  { dataId: FIRST, position: null },
];

function completedPlan(dataIds: readonly string[] = [FIRST, SECOND]) {
  return {
    ownerUserId: OWNER, kind: "prepare", status: "completed",
    plan: { version: 1, datasetId: DATASET, dataIds, name: "Uploaded", description: "Rows",
      format: "jsonl", promptUploadRef: THIRD, cases: dataIds.map(() => ({})), assets: [] },
    stages: {
      dataset: { status: "confirmed", receipt: { datasetId: DATASET, dataIds } },
      ...Object.fromEntries(dataIds.map((dataId) => [`data:${dataId}`, { status: "confirmed", receipt: { dataId } }])),
    },
  };
}

describe("one authoritative Dataset membership order", () => {
  it("uses verified per-Dataset positions before UUIDs or an old completed plan", () => {
    const ordered = resolveDatasetMemberOrder(OWNER, dataset, [
      { dataId: SECOND, position: 7 },
      { dataId: FIRST, position: 2 },
    ], [completedPlan([SECOND, FIRST])]);
    expect(ordered).toEqual({ order: "upload", members: [
      { dataId: FIRST, position: 2 }, { dataId: SECOND, position: 7 },
    ] });
  });

  it("does not claim the original row after a detach/reattach even with two unique positions", () => {
    const reattached = [
      { dataId: FIRST, position: 2 },
      { dataId: SECOND, position: 1 },
    ];
    expect(resolveDatasetMemberOrder(OWNER, { ...dataset, originalOrderIntact: false }, reattached,
      [completedPlan()])).toEqual({
      order: "unknown", members: [reattached[1], reattached[0]],
    });
    // Removing *all* members resets position allocation to zero; dense positions are not proof either.
    expect(resolveDatasetMemberOrder(OWNER, { ...dataset, originalOrderIntact: false }, [
      { dataId: SECOND, position: 0 }, { dataId: FIRST, position: 1 },
    ], [completedPlan()]).order).toBe("unknown");
  });

  it("recovers an old Moss preparation only from a completed, owned plan proving the entire membership", () => {
    expect(resolveDatasetMemberOrder(OWNER, { ...dataset, originalOrderIntact: null }, members,
      [completedPlan()])).toEqual({
      order: "upload", members: [members[1], members[0]],
    });
    expect(resolveDatasetMemberOrder(OWNER, { ...dataset, originalOrderIntact: false }, members,
      [completedPlan()]).order).toBe("unknown");
    // 0011 positions on a pre-0012 Dataset may have survived a detach-all/readd in reverse order.
    expect(resolveDatasetMemberOrder(OWNER, { ...dataset, originalOrderIntact: null }, [
      { dataId: FIRST, position: 0 }, { dataId: SECOND, position: 1 },
    ], [completedPlan()]).order).toBe("unknown");
  });

  it("does not infer the first uploaded row of a legacy UI Dataset from UUID order", () => {
    expect(resolveDatasetMemberOrder(OWNER, { ...dataset, kind: "general", originalOrderIntact: null },
      [...members].reverse(), [])).toEqual({
      order: "unknown", members,
    });
    expect(resolveDatasetMemberOrder(OWNER, { ...dataset, originalOrderIntact: null },
      [...members].reverse(), [])).toEqual({
      order: "unknown", members,
    });
  });

  it("rejects pending, foreign, mismatched, ambiguous or incomplete preparation proofs", () => {
    const valid = completedPlan();
    const cases = [
      [{ ...valid, status: "pending" }],
      [{ ...valid, ownerUserId: "other-owner" }],
      [{ ...valid, plan: { ...valid.plan, datasetId: THIRD } }],
      [{ ...valid, stages: { ...valid.stages, dataset: { status: "attempted" } } }],
      [{ ...valid, stages: { ...valid.stages, [`data:${FIRST}`]: { status: "attempted" } } }],
      [{ ...valid, stages: { ...valid.stages, dataset: {
        status: "confirmed", receipt: { datasetId: DATASET, dataIds: [SECOND, FIRST] },
      } } }],
      [{ ...valid, plan: { ...valid.plan, dataIds: [FIRST, FIRST] } }],
      [valid, completedPlan([SECOND, FIRST])],
    ];
    for (const plans of cases) {
      expect(resolveDatasetMemberOrder(OWNER, { ...dataset, originalOrderIntact: null }, members, plans).order)
        .toBe("unknown");
    }
    expect(resolveDatasetMemberOrder(OWNER, { ...dataset, originalOrderIntact: null },
      [...members, { dataId: THIRD, position: null }], [valid]).order).toBe("unknown");
  });

  it("keeps legacy rows deterministic and known new additions in insertion order without claiming upload order", () => {
    const mixed = [...members, { dataId: THIRD, position: 1 }, { dataId: crypto.randomUUID(), position: 0 }];
    const result = resolveDatasetMemberOrder(OWNER, { ...dataset, originalOrderIntact: null },
      mixed, [completedPlan()]);
    expect(result.order).toBe("unknown");
    expect(result.members.map((member) => member.dataId)).toEqual([
      SECOND, FIRST, mixed[3]!.dataId, THIRD,
    ]);
  });
});
