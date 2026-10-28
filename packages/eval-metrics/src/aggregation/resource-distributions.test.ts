import { describe, expect, it } from "vitest";
import { piEvent, piResult, resourceInput, settlement, usage } from "../test-support.js";
import { aggregateAgentResources } from "./resource-distributions.js";

function agent(id: string, cache: number, calls: readonly { input: string; outcome: string; duration: number }[]) {
  return [resourceInput({
    scope: { chatId: id, idempotencyKey: id, submissionId: id },
    usageEvents: [usage(`usage-${id}`, { metrics: { inputTokens: 0, outputTokens: 0, cacheReadTokens: cache, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: cache } })],
    billingSettlements: [settlement(`debit-${id}`, { ratedUnits: cache, debitedUnits: cache, shortfallUnits: 0, platformOwned: { units: 0 } })],
    nativeRecords: calls.flatMap((call, index) => [
      piEvent(index * 2 + 1, "tool_execution_start", { toolCallId: `${id}-${index}`, toolName: "write_file", args: call.input, timestamp: 0 }),
      piResult(index * 2 + 2, { toolCallId: `${id}-${index}`, toolName: "write_file", isError: call.outcome === "failed",
        timestamp: call.duration, content: "ok", durationMs: call.duration }),
    ]),
  })];
}

describe("per-Agent resource distributions", () => {
  it("proves an unused model is zero independently of another model's missing numbers", () => {
    const result = aggregateAgentResources([
      [resourceInput({ usageEvents: [usage("a", { providerMetadata: { provider: "p", model: "a" }, metrics: { totalTokens: 10 } })] })],
      [resourceInput({ usageEvents: [usage("b", { providerMetadata: { provider: "p", model: "b" }, metrics: { inputTokens: 1 } })] })],
    ]);
    expect(result.distribution.byModel.find((model) => model.model === "a")!.tokens.total)
      .toMatchObject({ count: 2, missing: 0, mean: 5, median: 5, variance: 25, min: 0, max: 10, coverage: "complete" });
    expect(result.distribution.byModel.find((model) => model.model === "b")!.tokens.total)
      .toMatchObject({ count: 1, missing: 1, mean: 0, variance: 0, coverage: "partial" });
  });

  it("does not invent unused-model zero when incomplete metadata could belong to that model", () => {
    const result = aggregateAgentResources([
      [resourceInput({ usageEvents: [usage("a", { providerMetadata: { provider: "p", model: "a" }, metrics: { totalTokens: 10 } })] })],
      [resourceInput({ usageEvents: [usage("unattributed", { providerMetadata: {}, metrics: { totalTokens: 30 } })] })],
      [resourceInput({ usageEvents: [usage("different", { providerMetadata: { model: "b" }, metrics: { totalTokens: 20 } })] })],
    ]);
    expect(result.distribution.byModel.find((model) => model.model === "a")!.tokens.total)
      .toMatchObject({ count: 2, missing: 1, mean: 5, variance: 25, coverage: "partial" });
    const mixed = aggregateAgentResources([[resourceInput({ usageEvents: [
      usage("a", { providerMetadata: { provider: "p", model: "a" }, metrics: { totalTokens: 10 } }),
      usage("unattributed", { providerMetadata: {}, metrics: { totalTokens: 30 } }),
    ] })]]);
    expect(mixed.byModel.find((model) => model.model === "a")!.tokens.total).toEqual({ value: 10, coverage: "partial" });
    expect(mixed.distribution.byModel.find((model) => model.model === "a")!.tokens.total)
      .toMatchObject({ count: 1, missing: 0, mean: 10, variance: 0, coverage: "partial" });
  });

  it("keeps unknown tool names separate from proven unused tools", () => {
    const known = agent("known", 10, [{ input: "a", outcome: "completed", duration: 10 }]);
    const unknown = resourceInput({ nativeRecords: [
      piEvent(1, "tool_execution_start", { toolCallId: "unknown", args: {} }),
      piResult(2, { toolCallId: "unknown", isError: false, durationMs: 10, content: {} }),
    ] });
    const result = aggregateAgentResources([known, [unknown], [resourceInput()]]);
    expect(result.distribution.trajectory.byTool.find((tool) => tool.toolName === "write_file")!.operations.count)
      .toMatchObject({ count: 2, missing: 1, mean: 0.5, variance: 0.25, coverage: "partial" });
    expect(result.distribution.trajectory.byTool.find((tool) => tool.toolName === null)!.operations.count)
      .toMatchObject({ count: 3, missing: 0, mean: 1 / 3, coverage: "complete" });
    const mixed = aggregateAgentResources([[...known, unknown]]);
    expect(mixed.trajectory.byTool.find((tool) => tool.toolName === "write_file")!.count).toEqual({ value: 1, coverage: "partial" });
  });

  it("uses available Agent N for cache, credits, models and tool counts, and per-call N for lengths/durations", () => {
    const result = aggregateAgentResources([
      agent("a", 10, [{ input: "a", outcome: "completed", duration: 10 }]),
      agent("b", 30, [{ input: "abc", outcome: "failed", duration: 20 }, { input: "é", outcome: "completed", duration: 30 }]),
      [{ ownerUserId: "owner-1", submitted: true, collection: undefined }],
      [resourceInput()],
    ]);
    const distribution = result.distribution;
    expect(distribution.records).toBe(4);
    for (const metric of [distribution.tokens.cacheRead, distribution.costs.chargedUnits, distribution.byModel[0]!.tokens.total]) {
      expect(metric).toMatchObject({ count: 3, missing: 1, min: 0, max: 30, median: 10, coverage: "partial" });
      expect(metric.mean).toBeCloseTo(40 / 3);
      expect(metric.variance).toBeCloseTo(1400 / 9);
    }
    expect(distribution.trajectory.byTool[0]!.operations.count).toMatchObject({ count: 3, missing: 1, mean: 1, variance: 2 / 3, min: 0, max: 2 });
    expect(distribution.trajectory.byTool[0]!.operations.failed.mean).toBeCloseTo(1 / 3);
    const tool = result.trajectory.byTool[0]!;
    expect(tool.inputLength).toMatchObject({ count: 3, missing: 0, min: 3, max: 5, mean: 4, variance: 2 / 3 });
    expect(tool.durationMs).toMatchObject({ count: 3, missing: 0, min: 10, max: 30, mean: 20, variance: 200 / 3 });
  });

  it("deduplicates/restarts within one Agent before creating its one observation", () => {
    const first = resourceInput({ usageEvents: [usage("one", { metrics: { totalTokens: 10 } })] });
    const restart = resourceInput({ usageEvents: [usage("one", { metrics: { totalTokens: 10 } }), usage("two", { metrics: { totalTokens: 20 } })] });
    const result = aggregateAgentResources([[first, restart]]);
    expect(result.tokens.total.value).toBe(30);
    expect(result.distribution.tokens.total).toMatchObject({ count: 1, missing: 0, mean: 30, variance: 0, min: 30, max: 30 });
    expect(result.duplicateRecords.usageEvents).toBe(1);
  });

  it("keeps unavailable and partial facts distinct from complete empty zero", () => {
    const empty = aggregateAgentResources([]).distribution.tokens.total;
    expect(empty).toMatchObject({ count: 0, missing: 0, mean: null, variance: null, min: null, max: null, coverage: "unavailable" });
    const result = aggregateAgentResources([
      [resourceInput({ finalized: false, usageEvents: [usage("partial", { metrics: { totalTokens: 10 } })] })],
      [],
    ]).distribution.tokens.total;
    expect(result).toMatchObject({ count: 1, missing: 1, mean: 10, variance: 0, min: 10, max: 10, coverage: "partial" });
    expect(aggregateAgentResources([[resourceInput()]]).distribution.tokens.total).toMatchObject({ count: 1, missing: 0, mean: 0, variance: 0, coverage: "complete" });
  });
});
