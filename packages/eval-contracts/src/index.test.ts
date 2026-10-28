import { describe, expect, it } from "vitest";
import {
  AGENT_STATUSES,
  DEFAULT_EVIDENCE_LIMITS,
  EVIDENCE_SCHEMA_VERSION,
  SP_PI_TRAJECTORY_FORMAT,
  EVIDENCE_EXPORT_MAX_PASSES,
  OBSERVATION_MAX_PASSES,
  PENDING_SAMPLING_STATUSES,
  RECOLLECT_TARGETS,
  RESOURCE_WAIT_MS,
  SAMPLING_STATUSES,
  TERMINAL_AGENT_STATUSES,
  isIdentifier,
  isPendingSamplingStatus,
  isStageRecoveryPending,
  isTerminalAgentStatus,
  jsonObjectArrayInPlaceSchema,
  jsonObjectInPlaceSchema,
  jsonObjectSchema,
  jsonValueSchema,
  summarizeResourceSnapshot,
  type AgentResourceSnapshot,
} from "./index.js";

describe("@eval-platform/eval-contracts", () => {
  it("classifies every Sampling status against the single pending set", () => {
    expect(SAMPLING_STATUSES.filter(isPendingSamplingStatus)).toEqual(PENDING_SAMPLING_STATUSES);
  });

  it("owes work for a pending status or a finished stage still waiting for its resources", () => {
    const resourcesPending = { deadline: "2026-10-20T00:10:00.000Z" };
    for (const status of SAMPLING_STATUSES) {
      const pending = isPendingSamplingStatus(status);
      expect(isStageRecoveryPending({ status })).toBe(pending);
      expect(isStageRecoveryPending({ status, resourcesPending })).toBe(true);
      expect(isStageRecoveryPending({ status, observationPending: { passes: 1 } })).toBe(pending);
      expect(isStageRecoveryPending({ status, evidencePending: true, collectionPending: true })).toBe(pending);
    }
  });

  it("bounds pass-counted recoveries by the same number of passes and resources by ten minutes", () => {
    expect(OBSERVATION_MAX_PASSES).toBe(5);
    expect(EVIDENCE_EXPORT_MAX_PASSES).toBe(OBSERVATION_MAX_PASSES);
    expect(RESOURCE_WAIT_MS).toBe(600_000);
    expect(RECOLLECT_TARGETS).toEqual(["output", "resources"]);
    expect(DEFAULT_EVIDENCE_LIMITS.maxFileBytes).toBe(95_000_000);
    expect(EVIDENCE_SCHEMA_VERSION).toBe(2);
    expect(SP_PI_TRAJECTORY_FORMAT).toBe("sp-pi-trajectory/v1");
  });

  it("classifies every Agent status against the single terminal set", () => {
    expect(AGENT_STATUSES.filter(isTerminalAgentStatus)).toEqual(TERMINAL_AGENT_STATUSES);
  });

  it.each(["id", "a b"])("accepts identifier %j", (value) => expect(isIdentifier(value)).toBe(true));
  it.each(["", " ", " id", "id ", 1, null])("rejects identifier %j", (value) => expect(isIdentifier(value)).toBe(false));

  it("accepts acyclic plain JSON with shared values and returns a detached copy", () => {
    const shared = { tokens: [1, 0.5, null] };
    const input = { first: shared, second: shared, nested: [[{ ok: true }]] };
    const parsed = jsonValueSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(input));
  });

  it.each([
    undefined,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
    1n,
    new Date(),
    new Array(2),
    Object.assign([1], { extra: true }),
    { [Symbol("key")]: 1 },
    Object.defineProperty({}, "hidden", { value: 1 }),
    { get computed() { return 1; } },
    { toJSON: () => "converted" },
  ])("rejects non-JSON value %#", (value) => {
    expect(jsonValueSchema.safeParse(value).success).toBe(false);
  });

  it("rejects cycles and deep nesting without stack overflow", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonValueSchema.safeParse(cyclic).success).toBe(false);
    let deep: unknown = 1;
    for (let depth = 0; depth < 100_000; depth += 1) deep = [deep];
    expect(jsonValueSchema.safeParse(deep).success).toBe(true);
  });

  it.each([null, [], "text"])("requires a top-level JSON object: %j", (value) => {
    expect(jsonObjectSchema.safeParse(value).success).toBe(false);
    expect(jsonObjectInPlaceSchema.safeParse(value).success).toBe(false);
  });

  it("validates a large raw object in place by the same rules, without copying it", () => {
    const shared = { tokens: [1, null] };
    const input = { first: shared, second: shared, nested: [[{ ok: true }]] };
    expect(jsonObjectInPlaceSchema.parse(input)).toBe(input);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const invalid of [cyclic, { value: Number.NaN }, { value: new Date() }, { get computed() { return 1; } }]) {
      expect(jsonObjectInPlaceSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates a large array of raw objects in place, returning the original array", () => {
    const input = [{ eventId: "a" }, { eventId: "b", nested: [null] }];
    expect(jsonObjectArrayInPlaceSchema.parse(input)).toBe(input);
    for (const invalid of [{}, [null], [[]], [{ value: Number.NaN }], Object.assign([{}], { extra: true }), new Array(1)]) {
      expect(jsonObjectArrayInPlaceSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("summarizes a native resource snapshot without its records", () => {
    const snapshot: AgentResourceSnapshot = {
      scope: { chatId: "chat", idempotencyKey: "key", submissionId: "submission" },
      observedAt: "2026-10-20T00:00:00.000Z",
      finalized: true,
      coverage: { usageEvents: "complete", nativeRecords: "partial", billingSettlements: "complete" },
      usageEvents: [{ eventId: "u" }],
      nativeRecords: [1, 2].map((ingestSeq) => ({ ingestSeq,
        record: { format: "pi-trajectory/v1", projection: { kind: "safe" }, kind: "event",
          event: { type: "agent_start" } } })),
      billingSettlements: [],
    };
    expect(summarizeResourceSnapshot(snapshot)).toEqual({
      scope: snapshot.scope, observedAt: snapshot.observedAt, finalized: true, coverage: snapshot.coverage,
      counts: { usageEvents: 1, nativeRecords: 2, billingSettlements: 0 },
    });
  });
});
