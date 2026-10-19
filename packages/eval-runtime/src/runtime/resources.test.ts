import { describe, expect, it } from "vitest";
import type { AgentResourceSnapshot } from "@eval-platform/eval-contracts";
import { AgentResourceValidationError, validateResourceReadiness, validateResourceSnapshot } from "./resources.js";

const SCOPE = { chatId: "chat-1", submissionId: "submission-1", idempotencyKey: "execution:sampling-1" };
const READY = {
  receiptTerminal: true, stateUnreadable: false, pendingTelemetryEvents: 0, pendingRuntimeEvents: 0,
  actionCharges: { complete: true, unsettledExecutions: 0, missingExecutionIds: 0 },
};

function snapshot(): AgentResourceSnapshot {
  return {
    scope: SCOPE,
    observedAt: "2026-10-08T00:00:00.000Z",
    finalized: true,
    coverage: { usageEvents: "complete", telemetryEvents: "complete", billingSettlements: "complete" },
    usageEvents: [],
    telemetryEvents: [],
    billingSettlements: [],
    readiness: READY,
  };
}

describe("raw resource snapshot validation", () => {
  it("accepts a pre-dispatch Chat/key scope while requiring the snapshot's real Submission ID", () => {
    const input = snapshot();
    expect(validateResourceSnapshot(input, {
      chatId: SCOPE.chatId,
      idempotencyKey: SCOPE.idempotencyKey,
    })).toEqual(input);
  });

  it("preserves source shapes, missing/null values, order, repeats and signed adjustments without processing", () => {
    const usage = {
      eventId: "usage-1",
      kind: "subagent",
      metrics: { inputTokens: 100, outputTokens: 10, cacheReadTokens: null, vendorSpecificTokens: 7 },
      providerCostUsd: { total: 0.25 },
      parentRunId: "parent-1",
      unknownSourceField: [true, null, { custom: "native" }],
    };
    const started = { eventId: "start-1", operationId: "tool-1", type: "tool.started", occurredAt: 20 };
    const finished = { eventId: "finish-1", operationId: "tool-1", type: "tool.finished", occurredAt: 30 };
    const input = {
      ...snapshot(),
      usageEvents: [usage, usage],
      telemetryEvents: [finished, started, finished],
      billingSettlements: [{ accountId: "user-1", eventId: "usage-1", adjustment: -3.5, ratedUnits: null }],
    };

    const output = validateResourceSnapshot(input, SCOPE);

    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(output.usageEvents[0]).not.toBe(usage);
    expect(output.usageEvents[0]!.metrics).not.toHaveProperty("totalTokens");
    expect(output).not.toHaveProperty("totalCost");
    expect(output).not.toHaveProperty("toolCount");
    usage.metrics.inputTokens = 999;
    expect(output.usageEvents[0]!.metrics).toMatchObject({ inputTokens: 100 });
  });

  it("preserves incomplete/unfinalized source declarations without interpreting their records", () => {
    const input = {
      ...snapshot(),
      finalized: false,
      coverage: { usageEvents: "partial", telemetryEvents: "complete", billingSettlements: "unavailable" },
      telemetryEvents: [{ type: "generation.started", status: "provider-native-running" }],
    };
    expect(validateResourceSnapshot(input, SCOPE)).toEqual(input);
  });

  it("keeps SP's readiness diagnostics and requires them on a freshly read snapshot", () => {
    const readiness = {
      receiptTerminal: true, stateUnreadable: false, pendingTelemetryEvents: 3, pendingRuntimeEvents: 0,
      actionCharges: { complete: false, unsettledExecutions: 1, missingExecutionIds: 0 },
    };
    const input = { ...snapshot(), finalized: false, readiness };
    expect(validateResourceSnapshot(input, SCOPE)).toEqual(input);
    const { readiness: _readiness, ...withoutReadiness } = snapshot();
    expect(() => validateResourceSnapshot(withoutReadiness, SCOPE)).toThrow(AgentResourceValidationError);
  });

  it.each([
    { readiness: null },
    { readiness: { receiptTerminal: true } },
    { readiness: {
      receiptTerminal: true, stateUnreadable: false, pendingTelemetryEvents: -1, pendingRuntimeEvents: 0,
      actionCharges: { complete: true, unsettledExecutions: 0, missingExecutionIds: 0 },
    } },
    { readiness: {
      receiptTerminal: true, stateUnreadable: false, pendingTelemetryEvents: 0, pendingRuntimeEvents: 0,
      actionCharges: { complete: true, unsettledExecutions: 0, missingExecutionIds: 0 }, extra: 1,
    } },
  ])("rejects malformed readiness %j", (patch) => {
    expect(() => validateResourceSnapshot({ ...snapshot(), ...patch }, SCOPE)).toThrow(AgentResourceValidationError);
  });

  it.each(["chatId", "submissionId", "idempotencyKey"] as const)("rejects a different %s", (field) => {
    expect(() => validateResourceSnapshot({
      ...snapshot(), scope: { ...SCOPE, [field]: "other-operation" },
    }, SCOPE)).toThrow("does not match the requested operation scope");
  });

  it.each([
    null,
    [],
    "source-text",
    { invalid: undefined },
    { invalid: NaN },
    { invalid: Infinity },
    { invalid: -Infinity },
    { invalid: Number.MAX_SAFE_INTEGER + 1 },
    { invalid: -(Number.MAX_SAFE_INTEGER + 1) },
    { invalid: 1n },
    { invalid: () => "discarded" },
    { invalid: Symbol("discarded") },
    { invalid: new Date("2026-10-08") },
    { invalid: new Map() },
    { invalid: new Set() },
    { invalid: new Array(2) },
    { invalid: Object.assign([1], { sourceField: "discarded" }) },
    { [Symbol("discarded")]: 1 },
    { invalid: Object.defineProperty({}, "hidden", { value: 1 }) },
    { invalid: { get mutated() { return 1; } } },
    { invalid: { toJSON: () => ({ changed: true }) } },
  ])("rejects non-JSON or lossy original record %#", (record) => {
    const invalid = { ...snapshot(), usageEvents: [record] };
    expect(() => validateResourceSnapshot(invalid, SCOPE)).toThrow(AgentResourceValidationError);
  });

  it("rejects cyclic records but allows shared values without altering them", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateResourceSnapshot({ ...snapshot(), usageEvents: [cyclic] }, SCOPE))
      .toThrow(AgentResourceValidationError);
    const shared = { tokens: null };
    const input = { ...snapshot(), usageEvents: [{ first: shared, second: shared }] };
    expect(validateResourceSnapshot(input, SCOPE)).toEqual(input);
  });

  it.each([
    { scope: [] },
    { scope: { ...SCOPE, idempotencyKey: " " } },
    { observedAt: "not-a-date" },
    { coverage: [] },
    { coverage: { usageEvents: "complete" } },
    { usageEvents: {} },
    { telemetryEvents: null },
    { billingSettlements: "raw" },
  ])("rejects an invalid collection envelope %j", (patch) => {
    expect(() => validateResourceSnapshot({ ...snapshot(), ...patch }, SCOPE))
      .toThrow(AgentResourceValidationError);
  });

  it("marks validation failures unretryable", () => {
    try {
      validateResourceSnapshot(null, SCOPE);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentResourceValidationError);
      expect(error).toHaveProperty("retryable", false);
    }
  });
});

describe("resource readiness validation", () => {
  const readiness = {
    receiptTerminal: true, stateUnreadable: false, pendingTelemetryEvents: 1, pendingRuntimeEvents: 0,
    actionCharges: { complete: false, unsettledExecutions: 1, missingExecutionIds: 0 },
  };

  it("accepts a report for the requested operation and rejects one for another Submission or with events", () => {
    const report = { scope: SCOPE, observedAt: "2026-10-08T00:00:00.000Z", finalized: false, readiness };
    expect(validateResourceReadiness(report, { chatId: SCOPE.chatId, idempotencyKey: SCOPE.idempotencyKey })).toEqual(report);
    expect(() => validateResourceReadiness({ ...report, scope: { ...SCOPE, submissionId: "other" } }, SCOPE))
      .toThrow("Resource readiness does not match the requested operation scope");
    expect(() => validateResourceReadiness({ ...report, usageEvents: [] }, SCOPE)).toThrow(AgentResourceValidationError);
  });
});
