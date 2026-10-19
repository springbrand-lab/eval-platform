import { describe, expect, it, vi } from "vitest";
import { summarizeResourceSnapshot, type AgentResourceSnapshot, type AgentResourceState } from "@eval-platform/eval-contracts";
import type { RetryController } from "./retry.js";
import {
  AgentResourceValidationError,
  collectResources,
  validateResourceReadiness,
  validateResourceSnapshot,
  type ResourceSource,
} from "./resources.js";

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
    expect(output).toBe(input);
    expect(output.usageEvents[0]!.metrics).not.toHaveProperty("totalTokens");
    expect(output).not.toHaveProperty("totalCost");
    expect(output).not.toHaveProperty("toolCount");
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

describe("crash-safe resource download", () => {
  const STORED = { status: "pending", scope: SCOPE } as const;

  function setup(collect: () => Promise<unknown>, current: AgentResourceState = STORED, budget = 2) {
    const events: string[] = [];
    const saved: AgentResourceState[] = [];
    const harness = {
      inspectAgentResources: vi.fn(),
      collectAgentResources: vi.fn(async () => {
        events.push("download");
        return collect();
      }),
    };
    const decide = vi.fn<RetryController["decide"]>(async ({ attemptNumber }) => ({ shouldRetry: attemptNumber <= budget, backoffMs: 1 }));
    const download = {
      source: {
        harness: harness as unknown as ResourceSource["harness"],
        handle: { ownerUserId: "user-1", chatId: SCOPE.chatId, samplingId: "sampling-1", role: "subject", framework: "sp" } as const,
        scope: SCOPE,
        retryController: { decide },
        sleep: async () => undefined,
        now: () => "2026-10-08T00:01:00.000Z",
        log: (event: Record<string, unknown>) => { events.push(`log:${String(event.name)}`); },
      },
      current,
      saveSnapshot: vi.fn(async (_snapshot: AgentResourceSnapshot) => { events.push("snapshot"); }),
      save: vi.fn(async (resources: AgentResourceState) => { saved.push(resources); events.push(`save:${resources.status}`); }),
    };
    return { download, harness, decide, events, saved };
  }

  it("counts each download on the Attempt before it starts and logs only after the snapshot and its summary are stored", async () => {
    const { download, events, saved } = setup(async () => snapshot());
    const result = await collectResources(download);
    expect(result).toEqual({ status: "collected", summary: summarizeResourceSnapshot(snapshot()) });
    expect(events).toEqual(["save:pending", "download", "snapshot", "save:collected", "log:resources_collected"]);
    expect(saved[0]).toEqual({ ...STORED, downloads: 1 });
    expect(download.saveSnapshot.mock.calls[0]![0]).toEqual(snapshot());
  });

  it("counts a download a crashed process started against the same retry budget", async () => {
    const { download, decide, harness, saved } = setup(async () => snapshot(), { ...STORED, downloads: 2 });
    await expect(collectResources(download)).resolves.toMatchObject({ status: "collected" });
    expect(decide).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: "resources", attemptNumber: 2 }));
    expect(saved[0]).toEqual({ ...STORED, downloads: 3 });
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(1);
  });

  it("gives up without downloading once crashed downloads spent the budget", async () => {
    const { download, harness, saved } = setup(async () => snapshot(), { ...STORED, downloads: 3 });
    const result = await collectResources(download);
    expect(harness.collectAgentResources).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", scope: SCOPE, downloads: 3, exhausted: true, collectedAt: "2026-10-08T00:01:00.000Z" });
    expect(saved).toEqual([result]);
  });

  it("retries failed downloads within the budget, then keeps an already collected snapshot as given up", async () => {
    const collected: AgentResourceState = { status: "collected", summary: summarizeResourceSnapshot({ ...snapshot(), finalized: false }) };
    const { download, harness, saved } = setup(async () => { throw new Error("SP unavailable"); }, collected);
    const result = await collectResources(download);
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ...collected, downloads: 3, exhausted: true });
    expect(saved.map((item) => item.downloads)).toEqual([1, 2, 3, 3]);
    expect(download.saveSnapshot).not.toHaveBeenCalled();
  });

  it("gives up at once on an unretryable failure", async () => {
    const { download, harness } = setup(async () => ({ ...snapshot(), scope: { ...SCOPE, chatId: "other" } }));
    await expect(collectResources(download)).resolves.toMatchObject({
      status: "failed", downloads: 1, exhausted: true, error: expect.stringContaining("does not match"),
    });
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(1);
  });

  it("downloads and stores one snapshot at a time per process", async () => {
    let active = 0;
    let peak = 0;
    const slow = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return snapshot();
    };
    const first = setup(slow);
    const second = setup(slow);
    await Promise.all([collectResources(first.download), collectResources(second.download)]);
    expect(peak).toBe(1);
  });
});
