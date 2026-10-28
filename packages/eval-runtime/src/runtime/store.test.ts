import { describe, expect, it, vi } from "vitest";
import type { RetryController } from "./retry.js";
import { RuntimeRecordConflictError } from "./errors.js";
import { persistRuntimeRecord, type EvaluationState } from "./store.js";

function makeRecord(revision = 3): EvaluationState {
  return {
    revision,
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
        summary: {
          scope: { chatId: "chat-1", submissionId: "submission-1", idempotencyKey: "evaluation:sampling-1" },
          observedAt: "2026-10-08T00:00:01.000Z",
          finalized: false,
          coverage: { usageEvents: "partial", nativeRecords: "complete", billingSettlements: "unavailable" },
          counts: { usageEvents: 2, nativeRecords: 0, billingSettlements: 0 },
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

/** The record as committed over `makeRecord()`. */
function written(record = makeRecord()): EvaluationState {
  return { ...record, revision: 4 };
}

function persistenceInput(record = makeRecord()) {
  return {
    record,
    expected: makeRecord(),
    write: vi.fn<(record: EvaluationState, expected: EvaluationState) => Promise<void>>(async () => undefined),
    read: vi.fn<() => Promise<EvaluationState | null>>(async () => null),
    retryController: { decide: vi.fn<RetryController["decide"]>(async () => ({ shouldRetry: false })) },
    sleep: vi.fn(async (_milliseconds: number) => undefined),
  };
}

describe("Runtime record persistence", () => {
  it("writes the record at the next revision without copying its facts, and does not reconcile an acknowledged write", async () => {
    const input = persistenceInput();
    await expect(persistRuntimeRecord(input)).resolves.toEqual(written());
    expect(input.write).toHaveBeenCalledExactlyOnceWith(written(), input.expected);
    expect(input.write.mock.calls[0]![0].attempts).toBe(input.record.attempts);
    expect(input.write.mock.calls[0]![1]).toBe(input.expected);
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
    expect(input.write.mock.calls[0]![0]).toEqual(written());
    expect(input.write.mock.calls[0]![1]).toBe(expected);
    expect(input.write.mock.calls[1]).toEqual(input.write.mock.calls[0]);
  });

  it("stops stale conditional writes after a Store conflict", async () => {
    const input = persistenceInput();
    input.write.mockRejectedValue(new RuntimeRecordConflictError("newer facts exist"));
    input.read.mockResolvedValue({ ...makeRecord(4), status: { status: "failed" } });
    await expect(persistRuntimeRecord(input)).rejects.toMatchObject({
      name: "RuntimeRecordPersistenceError", outcome: "conflict",
    });
    expect(input.write).toHaveBeenCalledTimes(1);
    expect(input.retryController.decide).not.toHaveBeenCalled();
  });

  it("confirms committed facts regardless of JSON object key order", async () => {
    const input = persistenceInput();
    input.write.mockRejectedValue(new Error("response lost"));
    input.read.mockResolvedValue(reverseObjectKeys(written()) as EvaluationState);
    await expect(persistRuntimeRecord(input)).resolves.toEqual(written());
    expect(input.write).toHaveBeenCalledTimes(1);
    expect(input.read).toHaveBeenCalledTimes(1);
    expect(input.retryController.decide).not.toHaveBeenCalled();
    expect(input.sleep).not.toHaveBeenCalled();
  });

  it.each(["before", "after"] as const)("retries fixed facts when reconciliation fails %s commit", async (failure) => {
    const input = persistenceInput();
    const original = written();
    let committed: EvaluationState | null = null;
    input.write.mockImplementation(async (record) => { committed = record; });
    input.write.mockImplementationOnce(async (record) => {
      if (failure === "after") committed = record;
      throw new Error(`${failure} commit failure`);
    });
    input.read.mockRejectedValue(new Error("read unavailable"));
    input.retryController.decide.mockResolvedValue({ shouldRetry: true, backoffMs: 43 });
    await persistRuntimeRecord(input);
    expect(input.write).toHaveBeenCalledTimes(2);
    expect(input.write.mock.calls[0]![0]).toEqual(original);
    expect(input.write.mock.calls[1]![0]).toBe(input.write.mock.calls[0]![0]);
    expect(committed).toEqual(original);
    expect(input.retryController.decide).toHaveBeenCalledExactlyOnceWith({
      operation: "persistence", failureKind: "network", attemptNumber: 1, error: expect.any(String),
    });
    expect(input.sleep).toHaveBeenCalledExactlyOnceWith(43);
  });

  it.each(["status", "attempt"] as const)("does not confirm a record another writer changed: %s", async (change) => {
    const input = persistenceInput();
    const base = makeRecord(4);
    const stale = change === "status"
      ? { ...base, status: { status: "queued" as const } }
      : { ...base, attempts: [{ ...base.attempts[0]!, status: "running" as const }] };
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
      { operation: "persistence", failureKind: "network", attemptNumber: 1, error: "write unavailable" },
      { operation: "persistence", failureKind: "network", attemptNumber: 2, error: "write unavailable" },
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
      operation: "persistence", failureKind: "network", attemptNumber: 1, error: expect.any(String),
    });
  });
});
