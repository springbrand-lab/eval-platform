import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, sha256Hex, type AgentResourceFact, type JsonValue } from "@eval-platform/eval-contracts";
import { compactResourceSnapshot } from "../index.js";
import { telemetryBodyLength, telemetryContentFlags, telemetryOutputLength } from "./telemetry-content.js";
import { record } from "../json.js";
import { aggregateResources, type ResourceInput } from "./resources.js";
import { resourceInput, telemetry } from "../test-support.js";

async function historicalCacheFixture(inputs: readonly ResourceInput[]): Promise<ResourceInput[]> {
  const result: ResourceInput[] = [];
  for (const input of inputs) {
    const collection = input.collection;
    if (collection?.status !== "collected") { result.push(input); continue; }
    const events: AgentResourceFact[] = [];
    for (const raw of collection.snapshot.telemetryEvents) {
      const event = record(raw.event) ?? raw;
      const payload = record(event.payload);
      const flags = telemetryContentFlags(event);
      const pick = (value: AgentResourceFact | undefined, fields: readonly string[]): AgentResourceFact =>
        Object.fromEntries(fields.flatMap((key) => value?.[key] === undefined ? [] : [[key, value[key]!]]));
      events.push({
        event: { ...pick(event, ["eventId", "type", "operationId", "parentOperationId", "occurredAt"]),
          resource: pick(record(event.resource), ["sessionId"]),
          payload: pick(payload, ["outcome", "durationMs", "toolName", "inputTokens", "outputTokens", "totalTokens"]) },
        metricProjection: { version: 3, fingerprint: await sha256Hex(canonicalJsonBytes(event)),
          hasThinking: flags.thinking, hasContent: flags.content, thinkingKnown: flags.thinkingKnown, contentKnown: flags.contentKnown,
          inputLength: event.type === "tool.started" ? telemetryBodyLength(payload?.input) : null,
          outputLength: event.type === "tool.finished" ? telemetryOutputLength(payload) : null },
      });
    }
    result.push({ ...input, collection: { ...collection, snapshot: { ...collection.snapshot, telemetryEvents: events } } });
  }
  return result;
}

// Exercise the same interpreter on raw and persisted compact inputs, including contradictions in discarded bodies.
describe("immutable historical compact projection readers", () => {
  it("does not write or upgrade historical snapshots", async () => {
    const original = resourceInput().collection;
    if (original?.status !== "collected") throw new Error("missing historical snapshot");
    expect(await compactResourceSnapshot(original.snapshot)).toBe(original.snapshot);
  });
  it.each([1, 2, 3])("keeps archived metric version %s immutable while reading it", async (version) => {
    const [input] = await historicalCacheFixture([resourceInput({ telemetryEvents: [
      telemetry("start", "generation.started", "request"),
      telemetry("end", "generation.finished", "request", { outcome: "completed" }),
    ] })]);
    if (input?.collection?.status !== "collected") throw new Error("fixture");
    const snapshot = { ...input.collection.snapshot, telemetryEvents: input.collection.snapshot.telemetryEvents.map((event) => ({
      ...event, metricProjection: { ...event.metricProjection as Record<string, JsonValue>, version },
    })) };
    const before = JSON.stringify(snapshot);
    expect(await compactResourceSnapshot(snapshot)).toBe(snapshot);
    expect(aggregateResources([{ ...input, collection: { ...input.collection, snapshot } }]).modelRequests.count.value).toBe(1);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
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
    const projected = await historicalCacheFixture(inputs);
    expect(aggregateResources(projected)).toEqual(aggregateResources(inputs));
    expect(JSON.stringify(projected).length).toBeLessThan(10_000);
    expect(JSON.stringify(inputs)).toBe(before);
    expect(aggregateResources(projected).duplicateRecords.telemetryEvents).toBe(2);
  });

  it.each([undefined, null, "", "[REDACTED]", "[CONTENT OMITTED]", { redacted: true }, { b: 2, a: ["é", "\n"] }])(
    "preserves tool lengths and fallback for %j", async (body) => {
      const inputs = [resourceInput({ finalized: false, telemetryEvents: [
        telemetry("s", "tool.started", "t", { toolName: "t", ...(body === undefined ? {} : { input: body }) }),
        telemetry("e", "tool.finished", "t", { toolName: "t", outcome: "failed", response: "fallback", ...(body === undefined ? {} : { output: body }) }),
      ] })];
      expect(aggregateResources(await historicalCacheFixture(inputs))).toEqual(aggregateResources(inputs));
    },
  );

  it("does not turn sanitized bodies or old compact projections into complete marker zeros", async () => {
    const inputs = [resourceInput({ telemetryEvents: [
      telemetry("turn-start", "turn.started", "turn"),
      telemetry("turn-end", "turn.finished", "turn", { outcome: "completed", output: "[REDACTED]" }),
    ] })];
    const [projected] = await historicalCacheFixture(inputs);
    const collection = projected!.collection;
    if (!collection || collection.status !== "collected") throw new Error("expected compacted collection");
    const event = collection.snapshot.telemetryEvents[1]!;
    expect(event.metricProjection).toMatchObject({ version: 3, hasThinking: false, hasContent: false, thinkingKnown: false, contentKnown: false });
    const expected = { value: null, coverage: "unavailable" };
    expect(aggregateResources([projected!]).trajectory.thinkingSteps).toEqual(expected);
    expect(aggregateResources([projected!]).trajectory.contentSteps).toEqual(expected);

    const legacyEvents = collection.snapshot.telemetryEvents.map((item) => {
      if (!item.metricProjection) return item;
      const projection = { ...(item.metricProjection as Record<string, JsonValue>) };
      delete projection.hasThinking;
      delete projection.hasContent;
      delete projection.thinkingKnown;
      delete projection.contentKnown;
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
    expect(aggregateResources([legacy]).trajectory.thinkingSteps).toEqual(expected);
    expect(aggregateResources([legacy]).trajectory.contentSteps).toEqual(expected);
  });
});
