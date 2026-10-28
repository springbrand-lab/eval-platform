import { canonicalJsonBytes, type AgentResourceSnapshot } from "@eval-platform/eval-contracts";
import { describe, expect, it } from "vitest";
import { piEvent, piHook, piMessage, piRequest, piResult, resourceInput, settlement, usage } from "../test-support.js";
import { aggregateResources, type ResourceInput } from "./resources.js";

describe("safe Pi-native trajectory metrics", () => {
  it("merges native request/hooks, Pi assistant messages and Tool results across Attempts without counting replay twice", () => {
    const calls = [
      piEvent(1, "turn_start", { turnId: "turn", timestamp: 0 }),
      piHook(2, "before_model", { requestId: "request-1", turnId: "turn", timestamp: 1 }),
      piRequest(3, "start", { requestId: "request-1", turnId: "turn", timestamp: 1 }),
      piMessage(4, {
        role: "assistant", timestamp: 5, stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "hidden", signature: "safe-marker" },
          { type: "text", text: "Searching" },
          { type: "toolCall", id: "call-1", name: "search", arguments: { query: "é" } },
        ], usage: { input: 3, output: 2, totalTokens: 5 },
      }, { requestId: "request-1", turnId: "turn" }),
      piResult(5, { toolCallId: "call-1", turnId: "turn", toolName: "search", isError: false,
        timestamp: 8, content: [{ type: "text", text: "ok" }] }),
      piRequest(6, "end", { requestId: "request-1", turnId: "turn", timestamp: 9, outcome: "completed",
        inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
      piEvent(7, "turn_end", { turnId: "turn", timestamp: 10, outcome: "completed" }),
    ];
    const result = aggregateResources([
      resourceInput({ nativeRecords: calls.slice(0, 4) }),
      resourceInput({ nativeRecords: [calls[3]!, ...calls.slice(4)] }),
    ]);
    expect(result.duplicateRecords.nativeRecords).toBe(1);
    expect(result.trajectory.coverage).toBe("complete");
    expect(result.trajectory.turns).toMatchObject({ count: { value: 1, coverage: "complete" }, completed: 1, durationMs: { total: 10 } });
    expect(result.modelRequests).toMatchObject({ count: { value: 1 }, completed: 1, durationMs: { total: 8 } });
    expect(result.trajectory.tools).toMatchObject({ count: { value: 1 }, completed: 1 });
    expect(result.trajectory.byTool).toEqual([expect.objectContaining({
      toolName: "search", count: { value: 1, coverage: "complete" },
      inputLength: expect.objectContaining({ count: 1, total: canonicalJsonBytes({ query: "é" }).byteLength }),
      outputLength: expect.objectContaining({ count: 1, total: canonicalJsonBytes([{ type: "text", text: "ok" }]).byteLength }),
    })]);
    expect(result.trajectory.thinkingSteps).toEqual({ value: 1, coverage: "complete" });
    expect(result.trajectory.contentSteps).toEqual({ value: 1, coverage: "complete" });
    expect(result.trajectory.thinkingStepTokens.total).toEqual({ value: 5, coverage: "complete" });
    expect(result.trajectory.contentStepTokens.total).toEqual({ value: 5, coverage: "complete" });
    expect(result.trajectory.unlinkedOperations).toEqual({ tools: 0, generations: 0 });
  });

  it("counts each model request Step separately; absent Step tokens are missing, not zero or a second usage bill", () => {
    const result = aggregateResources([resourceInput({
      usageEvents: [usage("billing", { metrics: { totalTokens: 55 } })],
      billingSettlements: [settlement("billing")],
      nativeRecords: [
        piEvent(1, "turn_start", { turnId: "turn" }),
        piRequest(2, "end", { turnId: "turn", requestId: "step-1", outcome: "failed", totalTokens: 5 }),
        piMessage(3, { role: "assistant", timestamp: 2, stopReason: "error",
          content: [{ type: "thinking", thinking: "attempt" }], usage: { totalTokens: 5 } },
        { turnId: "turn", requestId: "step-1" }),
        piRequest(4, "end", { turnId: "turn", requestId: "step-2", outcome: "completed" }),
        piMessage(5, { role: "assistant", timestamp: 3, stopReason: "stop",
          content: [{ type: "text", text: "answer" }] },
        { turnId: "turn", requestId: "step-2" }),
        piEvent(6, "turn_end", { turnId: "turn", outcome: "completed" }),
      ],
    })]);
    expect(result.modelRequests).toMatchObject({ count: { value: 2 }, failed: 1, completed: 1 });
    expect(result.trajectory.thinkingSteps).toEqual({ value: 1, coverage: "complete" });
    expect(result.trajectory.contentSteps).toEqual({ value: 1, coverage: "complete" });
    expect(result.trajectory.thinkingStepTokens.total).toEqual({ value: 5, coverage: "complete" });
    expect(result.trajectory.contentStepTokens.total).toEqual({ value: null, coverage: "unavailable" });
    expect(result.tokens.total.value).toBe(55);
    expect(result.costs.modelDebitedUnits.value).toBe(8);
  });

  it("retains partial delivery, missing Tool results and redacted Pi content as unavailable facts", () => {
    const partial = aggregateResources([{ ...resourceInput({
      coverage: { usageEvents: "complete", nativeRecords: "partial", billingSettlements: "complete" },
      nativeRecords: [
        piEvent(1, "turn_start", { turnId: "turn", timestamp: 1 }),
        piRequest(2, "start", { turnId: "turn", requestId: "step", timestamp: 2 }),
        piMessage(3, { role: "assistant", timestamp: 3, stopReason: "stop", content: "[REDACTED]" },
          { turnId: "turn", requestId: "step" }),
        piEvent(4, "tool_execution_start", { toolCallId: "call", toolName: "search", turnId: "turn",
          timestamp: 4, args: "[CONTENT OMITTED]" }),
      ],
    }), canEmitNativeRecords: false }]);
    expect(partial.trajectory.coverage).toBe("partial");
    expect(partial.modelRequests).toMatchObject({ count: { value: 1, coverage: "partial" }, completed: 1 });
    expect(partial.trajectory.tools).toMatchObject({ count: { value: 1, coverage: "partial" }, unknown: 1 });
    expect(partial.trajectory.byTool[0]).toMatchObject({
      inputLength: { count: 0, missing: 1, total: null, coverage: "unavailable" },
      outputLength: { count: 0, missing: 1, total: null, coverage: "unavailable" },
    });
    expect(partial.trajectory.thinkingSteps).toEqual({ value: null, coverage: "unavailable" });
    expect(partial.trajectory.contentSteps).toEqual({ value: null, coverage: "unavailable" });
  });

  it("counts visible redacted thinking as positive but never treats missing block-completeness as negative evidence", () => {
    const record = piMessage(3, { role: "assistant", timestamp: 3, stopReason: "stop",
      content: [{ type: "thinking", thinking: "[REDACTED]" }], usage: { totalTokens: 4 } },
    { turnId: "turn", requestId: "request" });
    const { contentComplete: _claim, ...onlyKind } = record.record.projection;
    const safeWithoutProof = { ...record, record: { ...record.record, projection: onlyKind } };
    const result = aggregateResources([resourceInput({ nativeRecords: [
      piEvent(1, "turn_start", { turnId: "turn" }),
      piRequest(2, "start", { turnId: "turn", requestId: "request" }),
      safeWithoutProof,
    ] })]);
    expect(result.trajectory.thinkingSteps).toEqual({ value: 1, coverage: "partial" });
    expect(result.trajectory.contentSteps).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.thinkingStepTokens.total).toEqual({ value: 4, coverage: "partial" });
  });

  it("does not decode old event-only snapshots or call `turn.finished` a native Pi message", () => {
    const snapshot = resourceInput({ usageEvents: [usage("old")], billingSettlements: [settlement("old")] }).collection;
    if (!snapshot || snapshot.status !== "collected") throw new Error("missing fixture");
    const { nativeRecords: _native, ...rest } = snapshot.snapshot;
    const old = { ...rest, coverage: { usageEvents: "complete", telemetryEvents: "complete", billingSettlements: "complete" },
      telemetryEvents: [{ eventId: "old", type: "turn.finished", payload: { output: { role: "assistant", content: "false" } } }] };
    const input: ResourceInput = { ownerUserId: "owner-1", collection: { ...snapshot, snapshot: old as unknown as AgentResourceSnapshot } };
    const result = aggregateResources([input]);
    expect(result.trajectory.turns.count).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.thinkingSteps.value).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ stream: "nativeRecords", kind: "unsupported-record" }));
    expect(result.tokens.total.value).toBe(35);
    expect(result.costs.modelDebitedUnits.value).toBe(8);
  });

  it("isolates contradictory source cursors and Tool names rather than choosing one Attempt's version", () => {
    const start = piEvent(2, "tool_execution_start", { toolCallId: "id", toolName: "search", turnId: "turn", args: {} });
    const conflict = piEvent(2, "tool_execution_start", { toolCallId: "id", toolName: "shell", turnId: "turn", args: {} });
    const result = aggregateResources([
      resourceInput({ nativeRecords: [piEvent(1, "turn_start", { turnId: "turn" }), start] }),
      resourceInput({ nativeRecords: [conflict] }),
    ]);
    expect(result.duplicateRecords.nativeRecords).toBe(1);
    expect(result.trajectory.tools.count).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.diagnostics).toContainEqual(expect.objectContaining({ kind: "conflicting-identity", ingestSeq: 2 }));
  });

  it("does not mistake missing IDs or unsupported safe record shapes for a complete empty Tool stream", () => {
    const result = aggregateResources([resourceInput({ nativeRecords: [
      piEvent(1, "tool_execution_start", { toolName: "unknown", args: {} }),
      piEvent(2, "agent_future_event", { toolCallId: "future" }),
    ] })]);
    expect(result.trajectory.tools.count).toEqual({ value: null, coverage: "unavailable" });
    expect(result.diagnostics.map(({ kind }) => kind)).toEqual(["missing-identity", "unsupported-record"]);
  });

  it("does not count a Pi record labelled as another operation's Submission", () => {
    const event = piEvent(1, "tool_execution_start", { toolCallId: "foreign", toolName: "search" });
    const foreign = { ...event, record: { ...event.record, submissionId: "other-submission" } };
    const result = aggregateResources([resourceInput({ nativeRecords: [foreign] })]);
    expect(result.trajectory.tools.count).toEqual({ value: null, coverage: "unavailable" });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      stream: "nativeRecords", kind: "conflicting-identity", ingestSeq: 1,
    }));
  });
});
