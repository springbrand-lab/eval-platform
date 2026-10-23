import { describe, expect, it, vi } from "vitest";
import { summarizeResourceSnapshot, type AgentResourceSnapshot, type AgentResourceState } from "@eval-platform/eval-contracts";
import type { RetryController } from "./retry.js";
import {
  AgentResourceValidationError,
  collectResources,
  createExclusiveRunner,
  validateResourceReadiness,
  validateResourceSnapshot,
  type ResourceSource,
} from "./resources.js";

const SCOPE = { chatId: "chat-1", submissionId: "submission-1", idempotencyKey: "execution:sampling-1" };
const READY = {
  receiptTerminal: true, stateUnreadable: false, pendingTelemetryEvents: 0, pendingRuntimeEvents: 0,
  trajectory: { resource: { agentId: "root", sessionId: SCOPE.chatId }, submissionId: SCOPE.submissionId,
    status: "delivered" as const, requiredClosed: true, pendingRecords: 0, children: [] },
  runtimeBusiness: { actor: { resource: { agentId: "root", sessionId: SCOPE.chatId }, path: [] },
    submissionId: SCOPE.submissionId, status: "delivered" as const, pendingRuntimeEvents: 0, quarantinedRuntimeEvents: 0, children: [] },
  actionCharges: { complete: true, unsettledExecutions: 0, missingExecutionIds: 0 },
};

function snapshot(): AgentResourceSnapshot {
  return {
    scope: SCOPE,
    observedAt: "2026-10-08T00:00:00.000Z",
    finalized: true,
    trajectoryFormat: "pi-trajectory/v1",
    coverage: { usageEvents: "complete", telemetryEvents: "complete", billingSettlements: "complete" },
    usageEvents: [],
    telemetryEvents: [],
    billingSettlements: [],
    readiness: READY,
  };
}

const nativeEntry = (id: number, data: object = {}) => ({
  format: "pi-trajectory/v1", resource: { agentId: "root", sessionId: SCOPE.chatId }, submissionId: SCOPE.submissionId,
  projection: { kind: "safe", policyId: "fixture", policyVersion: 1 },
  record: { type: "entry", value: { id, conversationId: 1, kind: "future.source.entry", data } },
});

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
    const started = nativeEntry(2, { sourceFact: "started", occurredAt: 20 });
    const finished = nativeEntry(3, { sourceFact: "finished", occurredAt: 30 });
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

  it("preserves incomplete/unfinalized declarations and native extension fields", () => {
    const input = {
      ...snapshot(),
      finalized: false,
      coverage: { usageEvents: "partial", telemetryEvents: "complete", billingSettlements: "unavailable" },
      telemetryEvents: [nativeEntry(2, { status: "provider-native-running" })],
    };
    expect(validateResourceSnapshot(input, SCOPE)).toEqual(input);
  });

  it("preserves a public partial snapshot whose runtime could not bind a root resource", () => {
    const input: AgentResourceSnapshot = { ...snapshot(), finalized: false,
      coverage: { usageEvents: "partial", telemetryEvents: "partial", billingSettlements: "partial" },
      readiness: { ...READY, stateUnreadable: true, pendingTelemetryEvents: null, pendingRuntimeEvents: null,
        trajectory: { ...READY.trajectory, resource: null, status: "unreadable", requiredClosed: false, pendingRecords: null },
        runtimeBusiness: { ...READY.runtimeBusiness, actor: { resource: null, path: [] },
          status: "unreadable", pendingRuntimeEvents: null, quarantinedRuntimeEvents: null },
        actionCharges: { complete: false, unsettledExecutions: 0, missingExecutionIds: 0 } },
    };
    const bytes = JSON.stringify(input);
    expect(validateResourceSnapshot(input, SCOPE)).toBe(input);
    expect(JSON.stringify(input)).toBe(bytes);
    expect(() => validateResourceSnapshot({ ...input, finalized: true }, SCOPE)).toThrow(AgentResourceValidationError);
  });

  it("keeps SP's readiness diagnostics and requires them on a freshly read snapshot", () => {
    const readiness = {
      ...READY,
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
    ...READY,
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

  it("preserves unknown delivery and nullable counts rather than making them finalized or empty", () => {
    const unknown = {
      ...READY, pendingTelemetryEvents: null, pendingRuntimeEvents: null,
      trajectory: { ...READY.trajectory, status: "unreadable", pendingRecords: null,
        children: [{ ...READY.trajectory, resource: null, submissionId: null, status: "missing", pendingRecords: null }] },
      runtimeBusiness: { ...READY.runtimeBusiness, status: "unreadable", pendingRuntimeEvents: null, quarantinedRuntimeEvents: null },
    };
    const report = { scope: SCOPE, observedAt: snapshot().observedAt, finalized: false, readiness: unknown };
    expect(validateResourceReadiness(report, SCOPE)).toBe(report);
    expect(validateResourceSnapshot({ ...snapshot(), ...report }, SCOPE)).toEqual({ ...snapshot(), ...report });
    expect(() => validateResourceReadiness({ ...report, finalized: true }, SCOPE)).toThrow(AgentResourceValidationError);
  });

  it("does not accept absent native or business delivery, a wrong native root, or an unsafe record", () => {
    const { trajectory: _trajectory, ...withoutTrajectory } = READY;
    const { runtimeBusiness: _business, ...withoutBusiness } = READY;
    for (const readiness of [
      withoutTrajectory, withoutBusiness, { ...READY, trajectory: { ...READY.trajectory, submissionId: "old-submission" } },
      { ...READY, runtimeBusiness: { ...READY.runtimeBusiness, actor: { resource: { agentId: "other", sessionId: SCOPE.chatId }, path: [] } } },
    ]) expect(() => validateResourceSnapshot({ ...snapshot(), readiness }, SCOPE)).toThrow(AgentResourceValidationError);
    const { projection: _projection, ...unsafe } = nativeEntry(2);
    for (const event of [unsafe, { ...nativeEntry(2), ingestSeq: 1 }]) {
      expect(() => validateResourceSnapshot({ ...snapshot(), telemetryEvents: [event] }, SCOPE)).toThrow(AgentResourceValidationError);
    }
  });

  it("rejects cyclic readiness before recursive wire validation can overflow", () => {
    const trajectory: Record<string, unknown> = { ...READY.trajectory };
    trajectory.children = [trajectory];
    expect(() => validateResourceSnapshot({ ...snapshot(), readiness: { ...READY, trajectory } }, SCOPE))
      .toThrow(AgentResourceValidationError);
  });
});

describe("crash-safe resource download", () => {
  const STORED = { status: "pending", scope: SCOPE } as const;

  function setup(collect: () => Promise<unknown>, current: AgentResourceState = STORED, budget = 2, exclusively = createExclusiveRunner()) {
    const events: string[] = [];
    const saved: AgentResourceState[] = [];
    const harness = {
      inspectAgentResources: vi.fn(async () => ({ scope: SCOPE, observedAt: snapshot().observedAt, finalized: true, readiness: READY })),
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
        onError: vi.fn(),
      },
      current,
      exclusively,
      readinessDelays: [0],
      allowUnfinalized: false,
      save: vi.fn(async (resources: AgentResourceState, stored?: AgentResourceSnapshot) => {
        saved.push(resources);
        events.push(`save:${resources.status}${stored ? "+snapshot" : ""}`);
      }),
    };
    return { download, harness, decide, events, saved };
  }

  it("counts each download on the Attempt before it starts and logs only after the snapshot is stored with its summary", async () => {
    const { download, events, saved } = setup(async () => snapshot());
    const result = await collectResources(download);
    expect(result).toEqual({});
    expect(events).toEqual(["log:resource_wait", "save:pending", "download", "save:collected+snapshot", "log:resources_collected"]);
    expect(saved[0]).toEqual({ ...STORED, downloads: 1 });
    expect(download.save.mock.calls[1]).toEqual([{ status: "collected", summary: summarizeResourceSnapshot(snapshot()) }, snapshot()]);
  });

  it("counts a download a crashed process started against the same retry budget", async () => {
    const { download, decide, harness, saved } = setup(async () => snapshot(), { ...STORED, downloads: 2 });
    await expect(collectResources(download)).resolves.toEqual({});
    expect(decide).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: "resources", attemptNumber: 2 }));
    expect(saved[0]).toEqual({ ...STORED, downloads: 3 });
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(1);
  });

  it("gives up without downloading once crashed downloads spent the budget", async () => {
    const { download, harness, saved } = setup(async () => snapshot(), { ...STORED, downloads: 3 });
    await collectResources(download);
    expect(harness.inspectAgentResources).not.toHaveBeenCalled();
    expect(harness.collectAgentResources).not.toHaveBeenCalled();
    expect(saved).toEqual([expect.objectContaining({ status: "failed", scope: SCOPE, downloads: 3, exhausted: true, collectedAt: "2026-10-08T00:01:00.000Z" })]);
    expect(download.source.onError).toHaveBeenCalledOnce();
  });

  it("retries failed downloads within the budget, then keeps an already collected snapshot as given up", async () => {
    const collected: AgentResourceState = { status: "collected", summary: summarizeResourceSnapshot({ ...snapshot(), finalized: false }) };
    const { download, harness, saved } = setup(async () => { throw new Error("SP unavailable"); }, collected);
    await collectResources(download);
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(3);
    expect(saved.at(-1)).toEqual({ ...collected, downloads: 3, exhausted: true });
    expect(saved.map((item) => item.downloads)).toEqual([1, 2, 3, 3]);
    expect(download.save.mock.calls.every(([, stored]) => stored === undefined)).toBe(true);
  });

  it("records each retried failure on a failed Attempt with its count, and gives up with the last one", async () => {
    const failed: AgentResourceState = { status: "failed", scope: SCOPE, collectedAt: "2026-10-08T00:00:00.000Z", error: "old" };
    let calls = 0;
    const { download, saved } = setup(async () => { calls += 1; throw new Error(`SP unavailable ${calls}`); }, failed);
    await collectResources(download);
    expect(saved.at(-1)).toEqual({ ...failed, error: "SP unavailable 3", collectedAt: "2026-10-08T00:01:00.000Z", downloads: 3, exhausted: true });
    expect(download.save.mock.calls.map(([resources]) => resources.status === "failed" && [resources.downloads, resources.error])).toEqual([
      [1, "old"], [2, "SP unavailable 1"], [3, "SP unavailable 2"], [3, "SP unavailable 3"],
    ]);
  });

  it("gives up at once on an unretryable failure", async () => {
    const { download, harness, saved } = setup(async () => ({ ...snapshot(), scope: { ...SCOPE, chatId: "other" } }));
    await collectResources(download);
    expect(saved.at(-1)).toMatchObject({
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
    const exclusively = createExclusiveRunner();
    const first = setup(slow, STORED, 2, exclusively);
    const second = setup(slow, STORED, 2, exclusively);
    await Promise.all([collectResources(first.download), collectResources(second.download)]);
    expect(peak).toBe(1);
  });

  it("does not count queued downloads and holds the slot through the count save", async () => {
    const exclusively = createExclusiveRunner();
    let release!: () => void;
    const counting = new Promise<void>((resolve) => { release = resolve; });
    const blocked = setup(async () => snapshot(), STORED, 2, exclusively);
    blocked.download.save.mockImplementationOnce(() => counting);
    const other = setup(async () => snapshot(), STORED, 2, exclusively);
    const pending = collectResources(blocked.download);
    await vi.waitFor(() => expect(blocked.download.save).toHaveBeenCalledOnce());
    const queued = collectResources(other.download);
    await vi.waitFor(() => expect(other.harness.inspectAgentResources).toHaveBeenCalledOnce());
    expect(other.download.save).not.toHaveBeenCalled();
    expect(other.harness.collectAgentResources).not.toHaveBeenCalled();
    expect(blocked.harness.collectAgentResources).not.toHaveBeenCalled();
    release();
    await Promise.all([pending, queued]);
    expect(other.saved[0]).toEqual({ ...STORED, downloads: 1 });
  });
});
