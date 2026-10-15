import { describe, expect, it } from "vitest";
import type { AgentResourceFact } from "@eval-platform/eval-contracts";
import { resourceInput, telemetry } from "../test-support.js";
import { aggregateResources } from "./resources.js";

const turn = (id: string, outcome?: string, start = 0, end = 1_000): AgentResourceFact[] => [
  telemetry(`${id}:start`, "turn.started", id, {}, start),
  ...outcome === undefined ? [] : [telemetry(`${id}:end`, "turn.finished", id, { outcome }, end)],
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
      resourceInput({ telemetryEvents: [...turn("turn-a", "completed"), toolEvents[0]!] }),
      resourceInput({ telemetryEvents: [
        { ingestSeq: 7, event: toolEvents[0]! }, toolEvents[1]!,
        ...tool("tool-2", "tool-1", "shell", { input: "ls" }, { outcome: "failed", response: { x: [1, 2] } }),
        ...turn("turn-b", "completed"), ...generation("gen-b", "turn-b", { inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
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
    expect(trajectory.nonToolTurns).toEqual({ value: 1, coverage: "complete" });
    expect(trajectory.nonToolTurnTokens).toEqual({
      input: { value: 10, coverage: "complete" }, output: { value: 5, coverage: "complete" }, total: { value: 15, coverage: "complete" },
    });
    expect(trajectory.unlinkedOperations).toEqual({ tools: 0, generations: 0 });
    expect(result.modelRequests.count.value).toBe(2);
  });

  it("keeps Turn outcomes distinct", () => {
    const result = aggregateResources([resourceInput({ telemetryEvents: [
      ...turn("completed", "completed"), ...turn("failed", "failed"), telemetry("cancel", "turn.cancelled", "cancelled"),
      ...turn("running"), ...turn("unknown", "mystery"),
    ] })]);
    expect(result.trajectory.turns).toMatchObject({
      count: { value: 5 }, completed: 1, failed: 1, cancelled: 1, inProgress: 1, unknown: 1,
    });
    expect(result.trajectory.nonToolTurns).toEqual({ value: 5, coverage: "complete" });
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
    expect(browser!.inputLength).toEqual({ count: 1, missing: 2, total: 4, min: 4, max: 4, mean: 4, median: 4, coverage: "partial" });
    expect(browser!.outputLength).toMatchObject({ count: 1, missing: 2, total: 5, coverage: "partial" });
  });

  it("reports non-tool Turns and their tokens unavailable when SP events carry no links", () => {
    const result = aggregateResources([resourceInput({ telemetryEvents: [
      ...turn("turn-a", "completed"), ...tool("t1", undefined, "browser", {}, { outcome: "completed" }),
      ...generation("g1", undefined, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    ] })]);
    expect(result.trajectory.nonToolTurns).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.nonToolTurnTokens.total).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.unlinkedOperations).toEqual({ tools: 1, generations: 1 });
  });

  it("marks non-tool counts and tokens partial when only some operations are linked", () => {
    const result = aggregateResources([resourceInput({ telemetryEvents: [
      ...turn("turn-a", "completed"), ...turn("turn-b", "completed"),
      ...tool("t1", "turn-a", "browser", {}, { outcome: "completed" }), ...tool("t2", undefined, "browser", {}, { outcome: "completed" }),
      ...generation("g1", "turn-b", { inputTokens: 4, outputTokens: 2, totalTokens: 6 }), ...generation("g2", undefined, { totalTokens: 99 }),
      ...generation("g3", "turn-b", null),
    ] })]);
    expect(result.trajectory.nonToolTurns).toEqual({ value: 1, coverage: "partial" });
    expect(result.trajectory.nonToolTurnTokens.total).toEqual({ value: 6, coverage: "partial" });
  });

  it("does not claim complete trajectory metrics from an unfinalized or failed collection", () => {
    const events = [...turn("turn-a", "completed")];
    const result = aggregateResources([resourceInput({ finalized: false, telemetryEvents: events })]);
    expect(result.coverage).toBe("partial");
    expect(result.trajectory.coverage).toBe("partial");
    expect(result.trajectory.nonToolTurns).toEqual({ value: 1, coverage: "partial" });
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
    expect(result.trajectory.nonToolTurns.value).toBeNull();
    expect(result.trajectory.diagnostics).toContainEqual(expect.objectContaining({ kind: "conflicting-identity", message: expect.stringContaining("parent") }));
  });
});
