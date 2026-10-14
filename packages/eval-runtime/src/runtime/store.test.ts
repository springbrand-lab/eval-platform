import { describe, expect, it, vi } from "vitest";
import type { EvaluationRecord } from "@eval-platform/eval-contracts";
import type { RetryController } from "./retry.js";
import { RuntimeRecordConflictError, persistRuntimeRecord } from "./store.js";

function makeRecord(): EvaluationRecord {
  return {
    evaluationId: "evaluation-1",
    samplingId: "sampling-1",
    evaluator: { ownerUserId: "user-1", userAgentId: "agent-1" },
    chatId: "chat-1",
    status: { status: "running" },
    attempts: [{
      evaluationAttemptId: "attempt-1",
      evaluationId: "evaluation-1",
      attemptNumber: 1,
      submissionId: "submission-1",
      status: "completed",
      completedAt: "2026-10-08T00:00:00.000Z",
      resources: {
        status: "collected",
        snapshot: {
          scope: { chatId: "chat-1", submissionId: "submission-1", idempotencyKey: "evaluation:sampling-1" },
          observedAt: "2026-10-08T00:00:01.000Z",
          finalized: false,
          coverage: { usageEvents: "partial", telemetryEvents: "complete", billingSettlements: "unavailable" },
          usageEvents: [{ eventId: "event-1", source: { extra: null, rawTokens: 123 } }, { eventId: "event-1" }],
          telemetryEvents: [],
          billingSettlements: [],
        },
      },
    }],
  };
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeys(entry)]));
}

function persistenceInput(record = makeRecord()) {
  return {
    record,
    expected: structuredClone(record),
    write: vi.fn<(record: EvaluationRecord, expected: EvaluationRecord) => Promise<void>>(async () => undefined),
    read: vi.fn<() => Promise<EvaluationRecord | null>>(async () => null),
    retryController: { decide: vi.fn<RetryController["decide"]>(async () => ({ shouldRetry: false })) },
    sleep: vi.fn(async (_milliseconds: number) => undefined),
  };
}

describe("Runtime record persistence", () => {
  it("does not reconcile or retry an acknowledged write", async () => {
    const input = persistenceInput();
    await persistRuntimeRecord(input);
    expect(input.write).toHaveBeenCalledExactlyOnceWith(input.record, input.expected);
    expect(input.write.mock.calls[0]![0]).not.toBe(input.record);
    expect(input.read).not.toHaveBeenCalled();
    expect(input.retryController.decide).not.toHaveBeenCalled();
  });

  it("reuses the same expected and target facts for a conditional write retry", async () => {
    const input = persistenceInput();
    const expected = { ...makeRecord(), status: { status: "queued" as const } };
    input.write.mockRejectedValueOnce(new Error("response lost"));
    input.read.mockResolvedValue(expected);
    input.retryController.decide.mockResolvedValue({ shouldRetry: true });
    await persistRuntimeRecord({ ...input, expected });
    expect(input.write).toHaveBeenCalledTimes(2);
    expect(input.write.mock.calls[0]![0]).toEqual(input.record);
    expect(input.write.mock.calls[0]![1]).toEqual(expected);
    expect(input.write.mock.calls[1]).toEqual(input.write.mock.calls[0]);
    expect(input.write.mock.calls[0]![0]).not.toBe(input.record);
    expect(input.write.mock.calls[0]![1]).not.toBe(expected);
  });

  it("stops stale conditional writes after a Store conflict", async () => {
    const input = persistenceInput();
    input.write.mockRejectedValue(new RuntimeRecordConflictError("newer facts exist"));
    input.read.mockResolvedValue({ ...makeRecord(), status: { status: "failed" } });
    await expect(persistRuntimeRecord(input)).rejects.toMatchObject({
      name: "RuntimeRecordPersistenceError", outcome: "conflict",
    });
    expect(input.write).toHaveBeenCalledTimes(1);
    expect(input.retryController.decide).not.toHaveBeenCalled();
  });

  it("confirms committed facts regardless of JSON object key order", async () => {
    const input = persistenceInput();
    input.write.mockRejectedValue(new Error("response lost"));
    input.read.mockResolvedValue(reverseObjectKeys(makeRecord()) as EvaluationRecord);
    await expect(persistRuntimeRecord(input)).resolves.toBeUndefined();
    expect(input.write).toHaveBeenCalledTimes(1);
    expect(input.read).toHaveBeenCalledTimes(1);
    expect(input.retryController.decide).not.toHaveBeenCalled();
    expect(input.sleep).not.toHaveBeenCalled();
  });

  it.each(["before", "after"] as const)("retries fixed facts when reconciliation fails %s commit", async (failure) => {
    const status: { status: "running" | "failed" } = { status: "running" };
    const input = persistenceInput({ ...makeRecord(), status });
    const original = structuredClone(input.record);
    let committed: EvaluationRecord | null = null;
    input.write.mockImplementation(async (record) => { committed = structuredClone(record); });
    input.write.mockImplementationOnce(async (record) => {
      if (failure === "after") committed = structuredClone(record);
      throw new Error(`${failure} commit failure`);
    });
    input.read.mockImplementation(async () => {
      status.status = "failed";
      throw new Error("read unavailable");
    });
    input.retryController.decide.mockResolvedValue({ shouldRetry: true, backoffMs: 43 });
    await persistRuntimeRecord(input);
    expect(input.write).toHaveBeenCalledTimes(2);
    expect(input.write.mock.calls[0]![0]).toEqual(original);
    expect(input.write.mock.calls[1]![0]).toBe(input.write.mock.calls[0]![0]);
    expect(committed).toEqual(original);
    expect(input.retryController.decide).toHaveBeenCalledExactlyOnceWith({
      operation: "persistence", failureKind: "network", attemptNumber: 1,
    });
    expect(input.sleep).toHaveBeenCalledExactlyOnceWith(43);
  });

  it.each(["status", "attempt", "ordering", "duplicates", "null"] as const)("does not confirm an older or changed %s fact", async (change) => {
    const input = persistenceInput();
    let stale = makeRecord();
    if (change === "status") {
      stale = { ...stale, status: { status: "queued" } };
    } else if (change === "attempt") {
      stale = { ...stale, attempts: [{ ...stale.attempts[0]!, status: "running" }] };
    } else {
      const resources = stale.attempts[0]!.resources;
      if (resources?.status !== "collected") throw new Error("Missing resource snapshot");
      const usageEvents = resources.snapshot.usageEvents;
      const changedEvents = change === "ordering"
        ? usageEvents.toReversed()
        : change === "duplicates"
          ? usageEvents.slice(0, 1)
          : [{ ...usageEvents[0], source: { rawTokens: 123 } }, usageEvents[1]!];
      stale = {
        ...stale,
        attempts: [{
          ...stale.attempts[0]!,
          resources: { status: "collected", snapshot: { ...resources.snapshot, usageEvents: changedEvents } },
        }],
      };
    }
    const error = new Error("write failed");
    input.write.mockRejectedValue(error);
    input.read.mockResolvedValue(stale);
    await expect(persistRuntimeRecord(input)).rejects.toMatchObject({
      name: "RuntimeRecordPersistenceError", message: error.message, outcome: "conflict", cause: error,
    });
    expect(input.retryController.decide).not.toHaveBeenCalled();
    expect(input.write).toHaveBeenCalledTimes(1);
  });

  it("keeps the write error when both reconciliation and retries are exhausted", async () => {
    const input = persistenceInput();
    const error = new Error("write unavailable");
    input.write.mockRejectedValue(error);
    input.read.mockRejectedValue(new Error("read unavailable"));
    input.retryController.decide.mockResolvedValueOnce({ shouldRetry: true, backoffMs: 7 });
    await expect(persistRuntimeRecord(input)).rejects.toMatchObject({
      name: "RuntimeRecordPersistenceError", message: error.message, outcome: "unknown", cause: error,
    });
    expect(input.write).toHaveBeenCalledTimes(2);
    expect(input.retryController.decide.mock.calls.map(([decision]) => decision)).toEqual([
      { operation: "persistence", failureKind: "network", attemptNumber: 1 },
      { operation: "persistence", failureKind: "network", attemptNumber: 2 },
    ]);
    expect(input.sleep).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("reconciles but does not retry an unretryable write", async () => {
    const input = persistenceInput();
    const error = Object.assign(new Error("storage rejected the record"), { retryable: false });
    input.write.mockRejectedValue(error);
    await expect(persistRuntimeRecord(input)).rejects.toMatchObject({
      name: "RuntimeRecordPersistenceError", message: error.message, outcome: "unknown", cause: error,
    });
    expect(input.read).toHaveBeenCalledTimes(1);
    expect(input.retryController.decide).not.toHaveBeenCalled();
    expect(input.sleep).not.toHaveBeenCalled();
  });

  it("does not replace the write error with a synchronous reconciliation exception", async () => {
    const input = persistenceInput();
    const error = new Error("write unavailable");
    input.write.mockRejectedValue(error);
    input.read.mockImplementation(() => { throw new Error("read unavailable"); });
    await expect(persistRuntimeRecord(input)).rejects.toMatchObject({
      name: "RuntimeRecordPersistenceError", message: error.message, outcome: "unknown", cause: error,
    });
    expect(input.retryController.decide).toHaveBeenCalledExactlyOnceWith({
      operation: "persistence", failureKind: "network", attemptNumber: 1,
    });
  });
});
