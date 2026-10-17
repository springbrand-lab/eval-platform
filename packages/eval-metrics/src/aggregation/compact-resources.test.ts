import { describe, expect, it } from "vitest";
import type { JsonValue } from "@eval-platform/eval-contracts";
import { compactResourceCollection, TELEMETRY_PROJECTION_VERSION } from "./compact-resources.js";
import { aggregateResources, type ResourceInput } from "./resources.js";
import { resourceInput, telemetry } from "../test-support.js";

async function compact(inputs: readonly ResourceInput[]): Promise<ResourceInput[]> {
  const result: ResourceInput[] = [];
  for (const input of inputs) result.push({ ...input, collection: input.collection ? await compactResourceCollection(input.collection) : undefined });
  return result;
}

// Exercise the same interpreter on raw and persisted compact inputs, including contradictions in discarded bodies.
describe("body-free telemetry metrics", () => {
  it("preserves all statistics and diagnostics across attempts, wrappers, duplicates and body-only conflicts", async () => {
    const start = telemetry("t-start", "tool.started", "tool", { toolName: "search", input: { b: "é", a: [null, true] } }, 4, "session-1", "turn");
    const finish = telemetry("t-end", "tool.finished", "tool", { toolName: "search", outcome: "completed", output: "[REDACTED]", response: { answer: "你好" } }, 20, "session-1", "turn");
    const conflict = telemetry("conflict", "generation.finished", "conflicting", { outcome: "completed", output: "a" });
    const inputs = [resourceInput({ telemetryEvents: [
      telemetry("turn-start", "turn.started", "turn", {}, 0), start,
      telemetry("empty-start", "turn.started", "empty", {}, 1),
      telemetry("g-start", "generation.started", "generation", { messages: "x".repeat(2_000_000) }, 3, "session-1", "empty"),
      conflict,
    ] }), resourceInput({ telemetryEvents: [
      { event: start, ingestSeq: 7 }, finish,
      telemetry("turn-end", "turn.finished", "turn", { outcome: "completed" }, 30),
      telemetry("empty-end", "turn.finished", "empty", { outcome: "completed" }, 50),
      telemetry("g-end", "generation.finished", "generation", { outcome: "completed", inputTokens: 20, outputTokens: 5, totalTokens: 25 }, 10, "session-1", "empty"),
      { ...conflict, payload: { outcome: "completed", output: "b" } },
      telemetry("bad", "tool.unknown", "unknown", {}),
      { type: "tool.started", payload: {} },
    ] })];
    const before = JSON.stringify(inputs);
    const projected = await compact(inputs);
    expect(aggregateResources(projected)).toEqual(aggregateResources(inputs));
    expect(JSON.stringify(projected).length).toBeLessThan(10_000);
    expect(JSON.stringify(inputs)).toBe(before);
    expect(aggregateResources(projected).duplicateRecords.telemetryEvents).toBe(2);
  });

  it.each([undefined, null, "", "[REDACTED]", "[CONTENT OMITTED]", { b: 2, a: ["é", "\n"] }])(
    "preserves tool lengths and fallback for %j", async (body) => {
      const inputs = [resourceInput({ finalized: false, telemetryEvents: [
        telemetry("s", "tool.started", "t", { toolName: "t", ...(body === undefined ? {} : { input: body }) }),
        telemetry("e", "tool.finished", "t", { toolName: "t", outcome: "failed", response: "fallback", ...(body === undefined ? {} : { output: body }) }),
      ] })];
      expect(aggregateResources(await compact(inputs))).toEqual(aggregateResources(inputs));
    },
  );

  it("does not turn sanitized bodies or old compact projections into complete marker zeros", async () => {
    const inputs = [resourceInput({ telemetryEvents: [
      telemetry("turn-start", "turn.started", "turn"),
      telemetry("turn-end", "turn.finished", "turn", { outcome: "completed", output: "[REDACTED]" }),
    ] })];
    const [projected] = await compact(inputs);
    const collection = projected!.collection;
    if (!collection || collection.status !== "collected") throw new Error("expected compacted collection");
    const event = collection.snapshot.telemetryEvents[1]!;
    expect(event.metricProjection).toMatchObject({ version: TELEMETRY_PROJECTION_VERSION, hasThinking: false, hasContent: false, markersKnown: false });
    const expected = { value: null, coverage: "unavailable" };
    expect(aggregateResources([projected!]).trajectory.thinkingTurns).toEqual(expected);
    expect(aggregateResources([projected!]).trajectory.contentTurns).toEqual(expected);

    const legacyEvents = collection.snapshot.telemetryEvents.map((item) => {
      if (!item.metricProjection) return item;
      const projection = { ...(item.metricProjection as Record<string, JsonValue>) };
      delete projection.hasThinking;
      delete projection.hasContent;
      delete projection.markersKnown;
      projection.version = 1;
      return { ...item, metricProjection: projection };
    });
    const legacy = {
      ownerUserId: projected!.ownerUserId,
      collection: {
        ...collection,
        snapshot: {
          ...collection.snapshot,
          telemetryEvents: legacyEvents,
        },
      },
    };
    expect(aggregateResources([legacy]).trajectory.thinkingTurns).toEqual(expected);
    expect(aggregateResources([legacy]).trajectory.contentTurns).toEqual(expected);
  });
});
