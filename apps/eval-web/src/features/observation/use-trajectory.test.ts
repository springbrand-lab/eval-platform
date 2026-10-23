import { describe, expect, it } from "vitest";
import { parseSafeTrajectoryRecord } from "@eval-platform/eval-runtime/harness";
import { mergeLoadedTrajectory } from "./use-trajectory";

const event = (id: number, ingestSeq: number, extra = {}, valueExtra = {}) => ({
  ingestSeq,
  event: parseSafeTrajectoryRecord({
    format: "pi-trajectory/v1", resource: { agentId: "root", sessionId: "chat" }, submissionId: "submission",
    projection: { kind: "safe", policyId: "fixture", policyVersion: 1 }, ...extra,
    record: { type: "conversation", value: { id, ...valueExtra } },
  }),
});
const page = (events: ReturnType<typeof event>[]) => ({ events, beforeSeq: null, hasOlder: false });

describe("immutable native loaded interval", () => {
  it("deduplicates native source identities while retaining the highest receiving cursor", () => {
    const first = page([event(1, 3)]);
    const copy = JSON.stringify(first);
    const loaded = mergeLoadedTrajectory(first, page([event(1, 20), event(2, 21)]));
    expect(loaded.events.map((item) => item.ingestSeq)).toEqual([3, 21]);
    expect(loaded.newestSeq).toBe(21);
    expect(JSON.stringify(first)).toBe(copy);
  });
  it("rejects contradictory receiving cursors, immutable metadata or projection policies", () => {
    const first = page([event(1, 3)]);
    for (const next of [
      event(2, 3), event(1, 4, { submissionId: "old" }), event(1, 4, {}, { future: "changed" }),
      event(1, 4, { projection: { kind: "safe", policyId: "another-policy", policyVersion: 1 } }),
    ]) expect(() => mergeLoadedTrajectory(first, page([next]))).toThrow(/矛盾/);
    expect(() => mergeLoadedTrajectory(first, page([
      event(2, 4, { projection: { kind: "safe", policyId: "another-policy", policyVersion: 1 } }),
    ]))).toThrow(/policy/);
  });
});
