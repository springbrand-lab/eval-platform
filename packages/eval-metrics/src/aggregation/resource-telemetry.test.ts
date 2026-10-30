import { describe, expect, it } from "vitest";
import type { JsonRecord } from "../json.js";
import { NATIVE_PROJECTION_VERSION } from "./compact-resources.js";
import { ResourceDiagnostics, type FactEntry, type FactStream } from "./resource-facts.js";
import { aggregateTelemetry } from "./resource-telemetry.js";

/** Body-free, already-validated native/Pi metric facts: exercise only the Metrics aggregation boundary. */
function projectedTools() {
  let ingestSeq = 0;
  const entry = (fact: JsonRecord, canEmitNativeRecords: boolean): FactEntry => ({
    ownerUserId: "owner-1",
    scope: { chatId: "chat-1", submissionId: "submission-1", idempotencyKey: "operation-1" },
    canEmitNativeRecords, ingestSeq: ++ingestSeq, fact: {},
    metricProjection: { version: NATIVE_PROJECTION_VERSION, supported: true, facts: [fact] },
  });
  const tool = (id: string, toolName: string | null,
    status: "completed" | "failed" | "cancelled" | "inProgress" | "unknown"): FactEntry[] => {
    const base = { type: "tool", id, scopeKey: "agent-1", toolName };
    const active = status === "inProgress";
    return [
      entry({ ...base, phase: "start", fromPiCall: true }, active),
      entry({ ...base, phase: "start", fromEvent: true }, active),
      ...(status === "inProgress" || status === "unknown" ? []
        : [entry({ ...base, phase: "end", status, fromEvent: true }, active)]),
    ];
  };
  const stream = (entries: readonly FactEntry[], complete: boolean): FactStream =>
    ({ entries, complete, duplicates: 0 });
  return { tool, stream };
}

describe("native per-Tool success rates", () => {
  it("uses one terminal-only rule per name and overall, excluding in-progress/unknown from denominators", () => {
    const { tool, stream } = projectedTools();
    const entries = [
      ...tool("browser-completed-1", "browser", "completed"),
      ...tool("browser-completed-2", "browser", "completed"),
      ...tool("browser-failed", "browser", "failed"),
      ...tool("browser-cancelled", "browser", "cancelled"),
      ...tool("browser-active", "browser", "inProgress"),
      ...tool("browser-unknown", "browser", "unknown"),
      ...tool("shell-completed", "shell", "completed"),
    ];
    const result = aggregateTelemetry(stream(entries, false), new ResourceDiagnostics(), ["not-observed"]);
    const byName = (name: string | null) => result.trajectory.byTool.find((item) => item.toolName === name)!;
    expect(byName("browser")).toMatchObject({
      count: { value: 6, coverage: "partial" },
      completed: 2, failed: 1, cancelled: 1, inProgress: 1, unknown: 1,
      toolSuccessRate: { value: 0.5, coverage: "partial" },
    });
    expect(byName("shell")).toMatchObject({
      count: { value: 1, coverage: "partial" }, completed: 1,
      toolSuccessRate: { value: 1, coverage: "partial" },
    });
    expect(result.trajectory.tools).toMatchObject({ completed: 3, failed: 1, cancelled: 1, inProgress: 1, unknown: 1 });
    expect(result.trajectory.toolSuccessRate).toEqual({ value: 3 / 5, coverage: "partial" });
    expect(byName("not-observed")).toMatchObject({
      count: { value: null, coverage: "unavailable" },
      toolSuccessRate: { value: null, coverage: "unavailable" },
    });
    for (const item of result.trajectory.byTool) {
      expect(item.toolSuccessRate.coverage).toBe(item.count.coverage);
    }
  });

  it("returns null, never 0%, when a Tool has no terminal call under complete, partial or unavailable coverage", () => {
    const { tool, stream } = projectedTools();
    const noCalls = aggregateTelemetry(stream([], true), new ResourceDiagnostics(), ["idle"]).trajectory.byTool[0]!;
    expect(noCalls.count).toEqual({ value: 0, coverage: "complete" });
    expect(noCalls.toolSuccessRate).toEqual({ value: null, coverage: "complete" });
    const active = aggregateTelemetry(stream(tool("active", "idle", "inProgress"), false), new ResourceDiagnostics())
      .trajectory.byTool[0]!;
    expect(active).toMatchObject({ count: { value: 1, coverage: "partial" }, inProgress: 1,
      toolSuccessRate: { value: null, coverage: "partial" } });
    const missing = aggregateTelemetry(stream([], false), new ResourceDiagnostics(), ["idle"]).trajectory.byTool[0]!;
    expect(missing).toMatchObject({ count: { value: null, coverage: "unavailable" },
      toolSuccessRate: { value: null, coverage: "unavailable" } });
  });

  it("keeps an unnamed native Tool separate from known names and retains each row's own coverage", () => {
    const { tool, stream } = projectedTools();
    const result = aggregateTelemetry(stream([
      ...tool("known", "browser", "completed"),
      ...tool("unnamed", null, "failed"),
    ], false), new ResourceDiagnostics());
    expect(result.trajectory.byTool).toEqual([
      expect.objectContaining({ toolName: null, toolSuccessRate: { value: 0, coverage: "partial" } }),
      expect.objectContaining({ toolName: "browser", toolSuccessRate: { value: 1, coverage: "partial" } }),
    ]);
    expect(result.trajectory.toolSuccessRate).toEqual({ value: 0.5, coverage: "partial" });
  });
});
