import { canonicalJsonBytes, sha256Hex, type AgentResourceSnapshot, type JsonValue } from "@eval-platform/eval-contracts";
import { describe, expect, it } from "vitest";
import { nativeFixture, nativeResourceInput, resourceInput } from "../test-support.js";
import { compactResourceSnapshot, NATIVE_PROJECTION_VERSION } from "./compact-resources.js";
import { aggregateResources, type ResourceInput } from "./resources.js";

async function compact(inputs: readonly ResourceInput[]): Promise<ResourceInput[]> {
  return Promise.all(inputs.map(async (input) => {
    const collection = input.collection;
    return { ...input, collection: collection?.status === "collected"
      ? { ...collection, snapshot: await compactResourceSnapshot(collection.snapshot) } : collection };
  }));
}

function assistantWithText(text: string) {
  const item = nativeFixture(14)[0]!;
  if (item.record.record.type !== "entry") throw new Error("Expected publicly projected Pi assistant Entry");
  const message = (item.record.record.value.model as { content: { type: string; text?: string }[] }[])[0]!;
  message.content = [{ type: "text", text }];
  return item;
}

describe("body-free native Pi metric projections", () => {
  it("hashes the full source record, drops multi-megabyte Pi text and preserves raw/compact conflicts", async () => {
    const large = assistantWithText("x".repeat(2_000_000));
    const conflict = assistantWithText("different");
    const first = nativeResourceInput([], { nativeRecords: [
      ...nativeFixture(...Array.from({ length: 13 }, (_, index) => index + 1)), large, ...nativeFixture(15, 16),
    ] });
    const inputs = [
      first, nativeResourceInput([], { nativeRecords: [large] }), nativeResourceInput([], { nativeRecords: [conflict] }),
    ];
    const before = JSON.stringify(inputs);
    const projected = await compact(inputs);
    expect(JSON.stringify(inputs)).toBe(before);
    expect(JSON.stringify(projected).length).toBeLessThan(20_000);
    const collection = projected[0]!.collection;
    if (!collection || collection.status !== "collected") throw new Error("Expected compacted snapshot");
    const fingerprint = collection.snapshot.nativeRecords.find((entry) => entry.ingestSeq === 14)?.metricProjection?.fingerprint;
    expect(fingerprint).toBe(await sha256Hex(canonicalJsonBytes(large.record)));
    expect(aggregateResources(projected)).toEqual(aggregateResources(inputs));
    expect(aggregateResources(projected).duplicateRecords.nativeRecords).toBe(2);
    expect(aggregateResources(projected).diagnostics).toContainEqual(expect.objectContaining({
      kind: "conflicting-identity", stream: "nativeRecords", ingestSeq: 14,
    }));
  });

  it.each([
    [null, null],
    ["[REDACTED]", "[CONTENT OMITTED]"],
    [{ query: "é" }, "safe result"],
  ] as readonly (readonly [JsonValue, string | null])[])(
    "keeps absent, redacted and present native Tool bodies distinct: %j", async (argumentsValue, output) => {
      const call = nativeFixture(6)[0]!;
      const result = nativeFixture(10)[0]!;
      if (call.record.record.type !== "entry" || result.record.record.type !== "entry") throw new Error("Expected Pi messages");
      const message = (call.record.record.value.model as { content: { type: string; arguments?: JsonValue }[] }[])[0]!;
      const block = message.content.find((part) => part.type === "toolCall")!;
      block.arguments = argumentsValue;
      const piResult = (result.record.record.value.model as { content: JsonValue }[])[0]!;
      piResult.content = output === null ? null : [{ type: "text", text: output }];
      const input = nativeResourceInput([], { nativeRecords: [
        ...nativeFixture(3, 4, 5), call, ...nativeFixture(7, 8, 9), result, ...nativeFixture(11, 12, 13, 14, 15, 16),
      ] });
      expect(aggregateResources(await compact([input]))).toEqual(aggregateResources([input]));
      const length = aggregateResources([input]).trajectory.byTool[0]!;
      expect(length.inputLength.total).toBe(argumentsValue === null || argumentsValue === "[REDACTED]"
        ? null : canonicalJsonBytes(argumentsValue).byteLength);
      expect(length.outputLength.total).toBe(output === null || output === "[CONTENT OMITTED]"
        ? null : canonicalJsonBytes([{ type: "text", text: output }]).byteLength);
    },
  );

  it("keeps an excessively wide safe Pi Tool body unknown instead of treating it as zero bytes", async () => {
    const call = nativeFixture(6)[0]!;
    if (call.record.record.type !== "entry") throw new Error("Expected Pi assistant");
    const message = (call.record.record.value.model as { content: { type: string; arguments?: JsonValue }[] }[])[0]!;
    message.content.find((part) => part.type === "toolCall")!.arguments = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [`key-${index}`, index]),
    );
    const input = nativeResourceInput([], { nativeRecords: [
      ...nativeFixture(3, 4, 5), call, ...nativeFixture(7, 8, 9, 10, 11, 12, 13, 14, 15, 16),
    ] });
    const raw = aggregateResources([input]);
    expect(raw.trajectory.tools.failed).toBe(1);
    expect(raw.trajectory.byTool[0]!.inputLength).toMatchObject({
      count: 0, missing: 1, total: null, coverage: "unavailable",
    });
    expect(aggregateResources(await compact([input]))).toEqual(raw);
  });

  it("rejects unsupported projection versions, future Pi kinds and event-only snapshots without inventing zero", async () => {
    const future = nativeFixture(2)[0]!;
    if (future.record.record.type !== "entry") throw new Error("Expected native Pi Entry");
    const value = future.record.record.value as Record<string, unknown>;
    value.kind = "future.native";
    delete value.model;
    value.data = { note: "private body" };
    const source = nativeResourceInput([], { nativeRecords: [future] });
    const [projected] = await compact([source]);
    const collection = projected!.collection;
    if (!collection || collection.status !== "collected") throw new Error("Expected compacted snapshot");
    const item = collection.snapshot.nativeRecords[0]!;
    expect(item.metricProjection).toMatchObject({ version: NATIVE_PROJECTION_VERSION, supported: false, facts: [] });
    expect(JSON.stringify(collection.snapshot)).not.toContain("private body");
    expect(aggregateResources([projected!]).trajectory.tools.count).toEqual({ value: null, coverage: "unavailable" });
    const oldVersion = { ...item, metricProjection: { ...item.metricProjection, version: -1 } };
    const invalid = { ...projected!, collection: { ...collection, snapshot: {
      ...collection.snapshot, nativeRecords: [oldVersion],
    } } };
    expect(aggregateResources([invalid]).diagnostics).toContainEqual(expect.objectContaining({
      kind: "unsupported-record", stream: "nativeRecords",
    }));

    const raw = resourceInput().collection;
    if (!raw || raw.status !== "collected") throw new Error("Expected resource snapshot");
    const { nativeRecords: _native, ...fields } = raw.snapshot;
    const legacy = { ...fields, telemetryEvents: [{ eventId: "old", type: "turn.finished" }] } as unknown as AgentResourceSnapshot;
    await expect(compactResourceSnapshot(legacy)).rejects.toThrow(/event-only resource snapshot/u);
    const foreign = nativeFixture(3)[0]!;
    Object.assign(foreign.record, { submissionId: "foreign",
      parent: { resource: { agentId: "agent-1", sessionId: "chat-1" }, submissionId: "unrelated" } });
    const outside = nativeResourceInput([], { nativeRecords: [foreign] }).collection;
    if (!outside || outside.status !== "collected") throw new Error("Expected collected snapshot");
    await expect(compactResourceSnapshot(outside.snapshot))
      .rejects.toThrow(/invalid native trajectory record/u);
  });
});
