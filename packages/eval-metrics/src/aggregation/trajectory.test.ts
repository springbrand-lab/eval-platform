import { describe, expect, it } from "vitest";
import type { AgentResourceFact } from "@eval-platform/eval-contracts";
import { resourceInput, telemetry } from "../test-support.js";
import { aggregateResources } from "./resources.js";

const turn = (id: string, outcome?: string, start = 0, end = 1_000, output: AgentResourceFact = { content: "answer" }): AgentResourceFact[] => [
  telemetry(`${id}:start`, "turn.started", id, {}, start),
  ...outcome === undefined ? [] : [telemetry(`${id}:end`, "turn.finished", id, { outcome, output }, end)],
];
const tool = (id: string, parent: string | undefined, name: string, input: AgentResourceFact, finished: AgentResourceFact | null) => [
  telemetry(`${id}:start`, "tool.started", id, { toolName: name, ...input }, 10, "session-1", parent),
  ...finished === null ? [] : [telemetry(`${id}:end`, "tool.finished", id, { toolName: name, durationMs: 5, ...finished }, 20, "session-1", parent)],
];
const generation = (id: string, parent: string | undefined, tokens: AgentResourceFact | null) => [
  telemetry(`${id}:start`, "generation.started", id, { generationId: id }, 1, "session-1", parent),
  ...tokens === null ? [] : [telemetry(`${id}:end`, "generation.finished", id, { generationId: id, outcome: "completed", ...tokens }, 2, "session-1", parent)],
];

describe("trajectory metrics", () => {
  it("merges Attempts and pages, deduplicates events and links nested tools to their Turn", () => {
    const toolEvents = tool("tool-1", "turn-a", "browser", { input: { b: 1, a: "é" } }, { outcome: "completed", output: "ok" });
    const result = aggregateResources([
      resourceInput({ telemetryEvents: [...turn("turn-a", "completed", 0, 1_000, { thinking: "hidden", content: "tool request" }), toolEvents[0]!] }),
      resourceInput({ telemetryEvents: [
        { ingestSeq: 7, event: toolEvents[0]! }, toolEvents[1]!,
        ...tool("tool-2", "tool-1", "shell", { input: "ls" }, { outcome: "failed", response: { x: [1, 2] } }),
        ...turn("turn-b", "completed", 0, 1_000, { signature: "sig", content: "answer" }), ...generation("gen-b", "turn-b", { inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
        ...generation("gen-a", "turn-a", { inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
      ] }),
    ]);
    const { trajectory } = result;
    expect(result.duplicateRecords.telemetryEvents).toBe(1);
    expect(trajectory.coverage).toBe("complete");
    expect(trajectory.turns).toMatchObject({ count: { value: 2, coverage: "complete" }, completed: 2 });
    expect(trajectory.tools).toMatchObject({ count: { value: 2, coverage: "complete" }, completed: 1, failed: 1 });
    expect(trajectory.byTool.map((item) => item.toolName)).toEqual(["browser", "shell"]);
    expect(trajectory.byTool[0]).toMatchObject({
      count: { value: 1 }, completed: 1, durationMs: { total: 5 },
      inputLength: { count: 1, missing: 0, total: 16, coverage: "complete" },
      outputLength: { count: 1, total: 4, coverage: "complete" },
    });
    expect(trajectory.byTool[1]).toMatchObject({ failed: 1, inputLength: { total: 4 }, outputLength: { total: 11 } });
    expect(trajectory.thinkingTurns).toEqual({ value: 2, coverage: "complete" });
    expect(trajectory.thinkingTurnOperations).toMatchObject({ count: { value: 2, coverage: "complete" }, completed: 2, failed: 0 });
    expect(trajectory.contentTurns).toEqual({ value: 2, coverage: "complete" });
    expect(trajectory.contentTurnOperations).toMatchObject({ count: { value: 2, coverage: "complete" }, completed: 2, failed: 0 });
    expect(trajectory.contentTurnTokens).toEqual({
      input: { value: 110, coverage: "complete" }, output: { value: 55, coverage: "complete" }, total: { value: 165, coverage: "complete" },
    });
    expect(trajectory.thinkingTurnTokens).toEqual({
      input: { value: 110, coverage: "complete" }, output: { value: 55, coverage: "complete" }, total: { value: 165, coverage: "complete" },
    });
    expect(trajectory.unlinkedOperations).toEqual({ tools: 0, generations: 0 });
    expect(result.modelRequests.count.value).toBe(2);
  });

  it("attributes generation tokens to thinking and content Turns independently", () => {
    const result = aggregateResources([resourceInput({ telemetryEvents: [
      ...turn("thinking-turn", "completed", 0, 1_000, { thinking: "hidden" }),
      ...turn("content-turn", "completed", 0, 1_000, { content: "answer" }),
      ...generation("thinking-generation", "thinking-turn", { inputTokens: 10, outputTokens: 4, totalTokens: 14 }),
      ...generation("content-generation", "content-turn", { inputTokens: 20, outputTokens: 8, totalTokens: 28 }),
    ] })]);
    expect(result.trajectory.thinkingTurns).toEqual({ value: 1, coverage: "complete" });
    expect(result.trajectory.contentTurns).toEqual({ value: 1, coverage: "complete" });
    expect(result.trajectory.thinkingTurnTokens).toEqual({
      input: { value: 10, coverage: "complete" }, output: { value: 4, coverage: "complete" }, total: { value: 14, coverage: "complete" },
    });
    expect(result.trajectory.contentTurnTokens).toEqual({
      input: { value: 20, coverage: "complete" }, output: { value: 8, coverage: "complete" }, total: { value: 28, coverage: "complete" },
    });
  });

  it("keeps Turn outcomes distinct", () => {
    const result = aggregateResources([resourceInput({ telemetryEvents: [
      ...turn("completed", "completed"), ...turn("failed", "failed"), telemetry("cancel", "turn.cancelled", "cancelled"),
      ...turn("running"), ...turn("unknown", "mystery"),
    ] })]);
    expect(result.trajectory.turns).toMatchObject({
      count: { value: 5 }, completed: 1, failed: 1, cancelled: 1, inProgress: 1, unknown: 1,
    });
    expect(result.trajectory.thinkingTurns).toEqual({ value: 0, coverage: "complete" });
    expect(result.trajectory.thinkingTurnOperations).toMatchObject({ count: { value: 0, coverage: "complete" }, completed: 0, failed: 0 });
    expect(result.trajectory.contentTurns).toEqual({ value: 3, coverage: "complete" });
    expect(result.trajectory.contentTurnOperations).toMatchObject({ count: { value: 3, coverage: "complete" }, completed: 1, failed: 1, inProgress: 0, unknown: 1 });
  });

  it("treats missing or sanitizer-omitted bodies as missing, never zero, and never adds output and response", () => {
    const result = aggregateResources([resourceInput({ telemetryEvents: [
      ...turn("turn-a", "completed"),
      ...tool("t1", "turn-a", "browser", { input: "[CONTENT OMITTED]" }, { outcome: "completed", output: "[REDACTED]" }),
      ...tool("t2", "turn-a", "browser", {}, { outcome: "completed", output: "abc", response: "ignored response" }),
      ...tool("t3", "turn-a", "browser", { input: null }, null),
    ] })]);
    const [browser] = result.trajectory.byTool;
    expect(browser).toMatchObject({ count: { value: 3 }, inProgress: 1 });
    expect(browser!.inputLength).toEqual({ count: 1, missing: 2, total: 4, min: 4, max: 4, mean: 4, variance: 0, median: 4, coverage: "partial" });
    expect(browser!.outputLength).toMatchObject({ count: 1, missing: 2, total: 5, coverage: "partial" });
  });

  it("classifies turns from output markers while keeping unlinked operation diagnostics", () => {
    const result = aggregateResources([resourceInput({ telemetryEvents: [
      ...turn("turn-a", "completed"), ...tool("t1", undefined, "browser", {}, { outcome: "completed" }),
      ...generation("g1", undefined, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    ] })]);
    expect(result.trajectory.thinkingTurns).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.contentTurns).toEqual({ value: 1, coverage: "partial" });
    expect(result.trajectory.thinkingTurnTokens.total).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.contentTurnTokens.total).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.unlinkedOperations).toEqual({ tools: 1, generations: 1 });
  });

  it("does not claim a marked-turn count is complete when an unlinked generation may carry the marker", () => {
    const result = aggregateResources([resourceInput({ telemetryEvents: [
      ...turn("turn-a", "completed", 0, 1_000, {}),
      ...generation("unlinked-thinking", undefined, { output: { thinking: "hidden" }, totalTokens: 2 }),
    ] })]);
    expect(result.trajectory.thinkingTurns).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.contentTurns).toEqual({ value: null, coverage: "unavailable" });
  });

  it("marks content tokens partial when only some generations are linked", () => {
    const result = aggregateResources([resourceInput({ telemetryEvents: [
      ...turn("turn-a", "completed"), ...turn("turn-b", "completed"),
      ...tool("t1", "turn-a", "browser", {}, { outcome: "completed" }), ...tool("t2", undefined, "browser", {}, { outcome: "completed" }),
      ...generation("g1", "turn-b", { inputTokens: 4, outputTokens: 2, totalTokens: 6 }), ...generation("g2", undefined, { totalTokens: 99 }),
      ...generation("g3", "turn-b", null),
    ] })]);
    expect(result.trajectory.thinkingTurns).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.contentTurns).toEqual({ value: 2, coverage: "partial" });
    expect(result.trajectory.thinkingTurnTokens.total).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.contentTurnTokens.total).toEqual({ value: 6, coverage: "partial" });
  });

  it("does not claim complete trajectory metrics from an unfinalized or failed collection", () => {
    const events = [...turn("turn-a", "completed")];
    const result = aggregateResources([resourceInput({ finalized: false, telemetryEvents: events })]);
    expect(result.coverage).toBe("partial");
    expect(result.trajectory.coverage).toBe("partial");
    expect(result.trajectory.contentTurns).toEqual({ value: 1, coverage: "partial" });
    const missing = aggregateResources([{ ownerUserId: "owner-1", collection: undefined, submitted: true }]);
    expect(missing).toMatchObject({ coverage: "unavailable", collections: { uncollected: 1 } });
    expect(missing.trajectory.turns.count).toEqual({ value: null, coverage: "unavailable" });
    const withGap = aggregateResources([resourceInput({ telemetryEvents: events }), { ownerUserId: "owner-1", collection: undefined, submitted: true }]);
    expect(withGap.trajectory.turns.count).toEqual({ value: 1, coverage: "partial" });
    const unsubmitted = aggregateResources([resourceInput({ telemetryEvents: events }), { ownerUserId: "owner-1", collection: undefined }]);
    expect(unsubmitted.trajectory.turns.count).toEqual({ value: 1, coverage: "complete" });
    expect(unsubmitted.coverage).toBe("complete");
  });

  it("diagnoses contradictory parent links instead of picking one", () => {
    const result = aggregateResources([resourceInput({ telemetryEvents: [
      ...turn("turn-a", "completed"), ...turn("turn-b", "completed"),
      telemetry("t:start", "tool.started", "t", { toolName: "browser" }, 1, "session-1", "turn-a"),
      telemetry("t:end", "tool.finished", "t", { toolName: "browser", outcome: "completed" }, 2, "session-1", "turn-b"),
    ] })]);
    expect(result.trajectory.unlinkedOperations.tools).toBe(1);
    expect(result.trajectory.thinkingTurns).toEqual({ value: 0, coverage: "partial" });
    expect(result.trajectory.contentTurns).toEqual({ value: 2, coverage: "partial" });
    expect(result.trajectory.diagnostics).toContainEqual(expect.objectContaining({ kind: "conflicting-identity", message: expect.stringContaining("parent") }));
  });
});
