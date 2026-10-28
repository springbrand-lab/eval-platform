import type { AgentResourceSnapshot } from "@eval-platform/eval-contracts";
import { describe, expect, it } from "vitest";
import { nativeFixture, nativeResourceInput, resourceInput, settlement, usage } from "../test-support.js";
import { aggregateResources, type ResourceInput } from "./resources.js";

describe("actual public UA safe Pi trajectory facts", () => {
  it("does not decode an old event-only resource snapshot as native Pi", () => {
    const collection = resourceInput({ usageEvents: [usage("old")], billingSettlements: [settlement("old")] }).collection;
    if (!collection || collection.status !== "collected") throw new Error("expected collected snapshot");
    const { nativeRecords: _native, ...rest } = collection.snapshot;
    const old = { ...rest, coverage: { usageEvents: "complete", telemetryEvents: "complete", billingSettlements: "complete" },
      telemetryEvents: [{ eventId: "old", type: "turn.finished", payload: { outcome: "completed" } }] };
    const input: ResourceInput = { ownerUserId: "owner-1", collection: {
      ...collection, snapshot: old as unknown as AgentResourceSnapshot,
    } };
    const result = aggregateResources([input]);
    expect(result.trajectory.turns.count).toEqual({ value: null, coverage: "unavailable" });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      kind: "unsupported-record", stream: "nativeRecords",
    }));
    expect(result.tokens.total.value).toBe(35);
    expect(result.costs.modelDebitedUnits.value).toBe(8);
  });

  it("keeps an incomplete delivery partial, rather than proving zero missing Tools or final results", () => {
    const result = aggregateResources([nativeResourceInput([3, 4, 5, 6, 7, 8], {
      finalized: false,
      coverage: { usageEvents: "complete", nativeRecords: "partial", billingSettlements: "complete" },
    })]);
    expect(result.modelRequests.count).toEqual({ value: 1, coverage: "partial" });
    expect(result.trajectory.tools.count).toEqual({ value: 1, coverage: "partial" });
    expect(result.trajectory.byTool[0]!.outputLength.total).toBeNull();
    expect(result.trajectory.turns).toMatchObject({ count: { value: 1, coverage: "partial" }, inProgress: 1 });
  });

  it("uses an actual failed Tool fact even when its Pi Tool Result is missing; output bytes remain missing", () => {
    const result = aggregateResources([nativeResourceInput([3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16])]);
    expect(result.trajectory.tools).toMatchObject({ count: { value: 1 }, failed: 1 });
    expect(result.trajectory.byTool[0]).toMatchObject({
      inputLength: { count: 1, missing: 0 },
      outputLength: { count: 0, missing: 1, total: null, coverage: "unavailable" },
    });
  });

  it("derives tool success from terminal native Tool facts, never from missing or unsettled facts", () => {
    const all = nativeFixture(...Array.from({ length: 16 }, (_, index) => index + 1));
    const failed = aggregateResources([nativeResourceInput([], { nativeRecords: all })]);
    expect(failed.trajectory.tools).toMatchObject({ failed: 1, completed: 0 });
    expect(failed.trajectory.toolSuccessRate).toEqual({ value: 0, coverage: "complete" });

    const completedRows = structuredClone(all);
    const finished = completedRows[10]!.record.record;
    const toolResult = completedRows[9]!.record.record;
    if (finished.type !== "entry" || toolResult.type !== "entry") throw new Error("Expected Pi Tool facts");
    const data = finished.value.data as { event: { payload: { outcome: string } } };
    data.event.payload.outcome = "completed";
    const model = (toolResult.value.model as { isError: boolean }[])[0]!;
    model.isError = false;
    const completed = aggregateResources([nativeResourceInput([], { nativeRecords: completedRows })]);
    expect(completed.trajectory.tools).toMatchObject({ completed: 1, failed: 0 });
    expect(completed.trajectory.toolSuccessRate).toEqual({ value: 1, coverage: "complete" });

    const partial = aggregateResources([nativeResourceInput([], {
      nativeRecords: completedRows, finalized: false,
      coverage: { usageEvents: "complete", nativeRecords: "partial", billingSettlements: "complete" },
    })]);
    expect(partial.trajectory.toolSuccessRate).toEqual({ value: 1, coverage: "partial" });
    const pending = aggregateResources([nativeResourceInput([3, 8])]);
    expect(pending.trajectory.toolSuccessRate.value).toBeNull();
    expect(pending.trajectory.toolSuccessRate.coverage).toBe(pending.trajectory.tools.count.coverage);
    expect(aggregateResources([nativeResourceInput([])]).trajectory.toolSuccessRate)
      .toEqual({ value: null, coverage: "complete" });
    const missing = aggregateResources([{ ownerUserId: "owner-1", submitted: true, collection: undefined }]);
    expect(missing.trajectory.toolSuccessRate).toEqual({ value: null, coverage: "unavailable" });
  });

  it("refuses a contradicted ingest cursor rather than assigning an arbitrary Tool name", () => {
    const source = nativeFixture(8)[0]!;
    const different = structuredClone(source);
    const entry = different.record.record;
    if (entry.type !== "entry") throw new Error("expected Pi entry");
    const data = entry.value.data as { event: { payload: { toolName: string } } };
    data.event.payload.toolName = "shell";
    const result = aggregateResources([
      nativeResourceInput([3, 8]),
      nativeResourceInput([], { nativeRecords: [different] }),
    ]);
    expect(result.duplicateRecords.nativeRecords).toBe(1);
    expect(result.trajectory.tools.count).toEqual({ value: null, coverage: "unavailable" });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      kind: "conflicting-identity", stream: "nativeRecords", ingestSeq: 8,
    }));
  });

  it("does not infer thinking/content absence from a completed generation whose Pi message is undelivered", () => {
    const result = aggregateResources([nativeResourceInput([3, 4, 5, 7])]);
    expect(result.modelRequests).toMatchObject({ count: { value: 1, coverage: "partial" }, completed: 1 });
    expect(result.trajectory.thinkingSteps.value).toBeNull();
    expect(result.trajectory.contentSteps.value).toBeNull();
    expect(result.trajectory.diagnostics).toContainEqual(expect.objectContaining({
      kind: "missing-identity", message: expect.stringContaining("assistant reference"),
    }));
  });

  it("does not assign one Pi assistant to two generations that claim the same public reference", () => {
    const second = structuredClone(nativeFixture(15)[0]!);
    const write = second.record.record;
    if (write.type !== "entry") throw new Error("expected Pi event");
    const data = write.value.data as { refs: { assistantTimestamp: number } };
    data.refs.assistantTimestamp = 255;
    const result = aggregateResources([nativeResourceInput([], { nativeRecords: [
      ...nativeFixture(...Array.from({ length: 14 }, (_, index) => index + 1)), second, ...nativeFixture(16),
    ] })]);
    expect(result.modelRequests).toMatchObject({ count: { value: 2, coverage: "partial" }, completed: 2 });
    expect(result.trajectory.thinkingSteps).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.contentSteps).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.diagnostics).toContainEqual(expect.objectContaining({
      kind: "conflicting-identity", message: expect.stringContaining("assistant reference"),
    }));
  });

  it("keeps Step markers unknown when a Pi assistant's real task ID cannot match the request", () => {
    const assistant = structuredClone(nativeFixture(14)[0]!);
    if (assistant.record.record.type !== "entry") throw new Error("expected Pi assistant");
    Object.assign(assistant.record.record.value, { byTaskId: 999 });
    const result = aggregateResources([nativeResourceInput([], { nativeRecords: [
      ...nativeFixture(3, 12, 13), assistant, ...nativeFixture(15),
    ] })]);
    expect(result.modelRequests).toMatchObject({ count: { value: 1, coverage: "partial" }, completed: 1 });
    expect(result.trajectory.thinkingSteps.value).toBeNull();
    expect(result.trajectory.contentSteps.value).toBeNull();
    expect(result.trajectory.diagnostics).toContainEqual(expect.objectContaining({
      kind: "missing-identity", message: expect.stringContaining("request task"),
    }));
  });

  it("does not infer zero Tool output bytes from a safe but redacted Pi Tool Result", () => {
    const resultRecord = structuredClone(nativeFixture(10)[0]!);
    if (resultRecord.record.record.type !== "entry") throw new Error("expected Pi Tool Result");
    const message = (resultRecord.record.record.value.model as { content: { text: string }[] }[])[0]!;
    message.content[0]!.text = "[REDACTED]";
    const result = aggregateResources([nativeResourceInput([], { nativeRecords: [
      ...nativeFixture(3, 4, 5, 6, 7, 8, 9), resultRecord, ...nativeFixture(11, 12, 13, 14, 15, 16),
    ] })]);
    expect(result.trajectory.tools.failed).toBe(1);
    expect(result.trajectory.byTool[0]!.outputLength).toMatchObject({
      count: 0, missing: 1, total: null, coverage: "unavailable",
    });
  });

  it("cannot interpret a bookkeeping entry carrying Pi model messages as a complete empty source", () => {
    const invalid = structuredClone(nativeFixture(3)[0]!);
    if (invalid.record.record.type !== "entry") throw new Error("expected bookkeeping Entry");
    Object.assign(invalid.record.record.value, { model: [{
      role: "assistant", timestamp: 100, content: [{ type: "text", text: "not bookkeeping" }],
    }] });
    const result = aggregateResources([nativeResourceInput([], { nativeRecords: [invalid] })]);
    expect(result.modelRequests.count).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.diagnostics).toContainEqual(expect.objectContaining({ kind: "unsupported-record" }));
  });

  it("does not count a context-origin native Pi message as an evaluation Step", () => {
    const context = structuredClone(nativeFixture(6)[0]!);
    Object.assign(context.record, { submissionId: null, origin: "context" });
    const result = aggregateResources([nativeResourceInput([], { nativeRecords: [context] })]);
    expect(result.modelRequests.count).toEqual({ value: null, coverage: "unavailable" });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ stream: "nativeRecords" }));
  });
});
