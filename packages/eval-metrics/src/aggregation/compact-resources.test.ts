import { describe, expect, it } from "vitest";
import type { AgentResourceSnapshot, JsonValue } from "@eval-platform/eval-contracts";
import { compactResourceSnapshot, NATIVE_PROJECTION_VERSION } from "./compact-resources.js";
import { aggregateResources, type ResourceInput } from "./resources.js";
import { piEvent, piMessage, piRequest, piResult, resourceInput } from "../test-support.js";

async function compact(inputs: readonly ResourceInput[]): Promise<ResourceInput[]> {
  return Promise.all(inputs.map(async (input) => {
    const collection = input.collection;
    return { ...input, collection: collection?.status === "collected"
      ? { ...collection, snapshot: await compactResourceSnapshot(collection.snapshot) } : collection };
  }));
}

describe("body-free native Pi metric projections", () => {
  it("preserves metrics and contradictory source hashes while dropping multi-megabyte assistant text", async () => {
    const message = piMessage(3, { role: "assistant", timestamp: 5, stopReason: "stop",
      content: [{ type: "text", text: "x".repeat(2_000_000) }], usage: { input: 3, output: 2, totalTokens: 5 } },
    { requestId: "request", turnId: "turn" });
    const conflict = { ...message, record: {
      ...message.record, message: { role: "assistant", timestamp: 5, stopReason: "stop",
        content: [{ type: "text", text: "different" }], usage: { input: 3, output: 2, totalTokens: 5 } },
    } };
    const inputs = [resourceInput({ nativeRecords: [
      piEvent(1, "turn_start", { turnId: "turn" }), piRequest(2, "start", { requestId: "request", turnId: "turn" }), message,
    ] }), resourceInput({ nativeRecords: [message, conflict, piResult(4,
      { toolCallId: "tool", turnId: "turn", toolName: "search", content: "[REDACTED]", isError: true })] })];
    const before = JSON.stringify(inputs);
    const projected = await compact(inputs);
    expect(JSON.stringify(inputs)).toBe(before);
    expect(JSON.stringify(projected).length).toBeLessThan(5_000);
    expect(aggregateResources(projected)).toEqual(aggregateResources(inputs));
    expect(aggregateResources(projected).duplicateRecords.nativeRecords).toBe(2);
    expect(aggregateResources(projected).diagnostics).toContainEqual(expect.objectContaining({ kind: "conflicting-identity", ingestSeq: 3 }));
  });

  it.each([null, "", "[REDACTED]", "[CONTENT OMITTED]", { redacted: true }, { b: 2, a: ["é", "\n"] }] as readonly JsonValue[])(
    "preserves missing vs real Tool body lengths for %j", async (body) => {
      const inputs = [resourceInput({ nativeRecords: [
        piEvent(1, "turn_start", { turnId: "turn" }),
        piEvent(2, "tool_execution_start", { toolCallId: "tool", turnId: "turn", toolName: "search", args: body }),
        piResult(3, { toolCallId: "tool", turnId: "turn", toolName: "search", isError: false, content: body }),
      ] })];
      expect(aggregateResources(await compact(inputs))).toEqual(aggregateResources(inputs));
    },
  );

  it("does not turn redacted Pi message markers or unknown projection versions into complete zeros", async () => {
    const inputs = [resourceInput({ nativeRecords: [
      piEvent(1, "turn_start", { turnId: "turn" }),
      piRequest(2, "start", { requestId: "request", turnId: "turn" }),
      piMessage(3, { role: "assistant", timestamp: 3, stopReason: "stop", content: "[CONTENT OMITTED]" },
        { requestId: "request", turnId: "turn" }),
    ] })];
    const [projected] = await compact(inputs);
    const collection = projected!.collection;
    if (!collection || collection.status !== "collected") throw new Error("missing collection");
    const item = collection.snapshot.nativeRecords[2]!;
    expect(item.metricProjection).toMatchObject({ version: NATIVE_PROJECTION_VERSION, supported: true,
      facts: [expect.objectContaining({ thinking: null, content: null, contentComplete: false })] });
    expect(aggregateResources([projected!]).trajectory.thinkingSteps).toEqual({ value: null, coverage: "unavailable" });
    const oldProjection = { ...item, metricProjection: { ...item.metricProjection, version: -1 } };
    const snapshot = { ...collection.snapshot, nativeRecords: [oldProjection] };
    const invalid = { ownerUserId: projected!.ownerUserId, collection: { ...collection, snapshot } };
    expect(aggregateResources([invalid]).trajectory.thinkingSteps.value).toBeNull();
    expect(aggregateResources([invalid]).diagnostics).toContainEqual(expect.objectContaining({
      kind: "unsupported-record", stream: "nativeRecords",
    }));
  });

  it("refuses to compact legacy event JSON as a native snapshot", async () => {
    const raw = resourceInput().collection;
    if (!raw || raw.status !== "collected") throw new Error("missing collection");
    const { nativeRecords: _native, ...fields } = raw.snapshot;
    const eventOnly = { ...fields, telemetryEvents: [{ eventId: "old", type: "turn.finished" }] } as unknown as AgentResourceSnapshot;
    await expect(compactResourceSnapshot(eventOnly)).rejects.toThrow(/event-only resource snapshot/u);
  });

  it("preserves unknown safe Pi records in raw evidence while refusing to invent operation zeros", async () => {
    const source = resourceInput({ nativeRecords: [
      { ingestSeq: 1, record: { format: "pi-trajectory/v1", projection: { kind: "safe" },
        futureSafeFact: { name: "x", body: "y".repeat(2_000) } } },
    ] });
    const compacted = await compact([source]);
    const item = compacted[0]!.collection;
    if (!item || item.status !== "collected") throw new Error("missing collection");
    expect(item.snapshot.nativeRecords[0]?.metricProjection).toMatchObject({ supported: false, facts: [] });
    expect(JSON.stringify(item.snapshot)).not.toContain("y".repeat(100));
    expect(aggregateResources(compacted).trajectory.tools.count).toEqual({ value: null, coverage: "unavailable" });
    expect(aggregateResources(compacted).diagnostics).toContainEqual(expect.objectContaining({
      stream: "nativeRecords", kind: "unsupported-record", ingestSeq: 1,
    }));
  });
});
