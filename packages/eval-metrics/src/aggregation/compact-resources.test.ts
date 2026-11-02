import { readFileSync } from "node:fs";
import {
  canonicalJsonBytes, nativeTrajectoryEntrySchema, sha256Hex,
  type AgentResourceSnapshot, type JsonValue, type NativeTrajectoryEntry,
} from "@eval-platform/eval-contracts";
import { describe, expect, it } from "vitest";
import { nativeFixture, nativeResourceInput, resourceInput } from "../test-support.js";
import {
  compactNativeTrajectoryRecord, compactResourceSnapshot, NATIVE_CHARGE_LINK_VERSION, NATIVE_PROJECTION_VERSION,
} from "./compact-resources.js";
import { NATIVE_TOOL_CALL_KEY_PREFIX } from "./native-record-facts.js";
import { aggregateResources, type ResourceInput } from "./resources.js";

// Generated from UA alpha.15's public canonicalMessageSchema and trajectory export,
// with the actual Responses ID from its OpenRouter protocols.test.ts:325-375.
const responsesFixture = JSON.parse(readFileSync(new URL("./ua-responses-tool-id.fixture.json", import.meta.url), "utf8")) as {
  readonly generator: string;
  readonly records: readonly NativeTrajectoryEntry[];
};
const responsesCall = () => structuredClone(responsesFixture.records[0]!);
const responsesResult = () => structuredClone(responsesFixture.records[1]!);
const toolFact = (entry: NativeTrajectoryEntry) =>
  ((entry.metricProjection?.facts ?? []) as readonly Record<string, JsonValue>[]).find((fact) => fact.type === "tool");
const sourceMessage = (entry: NativeTrajectoryEntry) => {
  if (entry.record.record.type !== "entry") throw new Error("Expected Pi entry");
  return (entry.record.record.value.model as Record<string, JsonValue>[])[0]!;
};
const responsesScope = { chatId: "chat-1", submissionId: "submission-1", idempotencyKey: "fixture" };

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
  it("correlates the public UA Responses composite Call/Result ID as one opaque, non-reversible key", async () => {
    expect(NATIVE_TOOL_CALL_KEY_PREFIX).toBe(`tck${NATIVE_CHARGE_LINK_VERSION}_`);
    expect(responsesFixture.generator).toContain("@springbrand/agent-runtime@0.3.1-alpha.15");
    expect(responsesFixture.records).toHaveLength(2);
    for (const entry of responsesFixture.records) expect(nativeTrajectoryEntrySchema.safeParse(entry).success).toBe(true);
    expect((sourceMessage(responsesCall()).content as Record<string, JsonValue>[])[0]!.id).toBe("call_1|fc_1");
    expect(sourceMessage(responsesResult()).toolCallId).toBe("call_1|fc_1");

    const raw = nativeResourceInput([], { nativeRecords: responsesFixture.records }).collection;
    if (!raw || raw.status !== "collected") throw new Error("Expected native snapshot");
    const compacted = await compactResourceSnapshot(raw.snapshot);
    const [call, result] = compacted.nativeRecords.map(toolFact);
    const expected = `tck2_${await sha256Hex(JSON.stringify([
      "eval-platform.pi-tool-call-id/v2", "agent-1", "chat-1", "submission-1", "call_1|fc_1",
    ]))}`;
    expect(call).toMatchObject({ fromPiCall: true, agentId: "agent-1", submissionId: "submission-1",
      toolCallKey: expected, toolName: "lookup" });
    expect(result).toMatchObject({ fromPiResult: true, agentId: "agent-1", submissionId: "submission-1",
      toolCallKey: expected, toolName: "lookup", executionId: "execution-1" });
    expect(call?.id).toBe(result?.id);
    expect(compacted.nativeRecords.map((entry) => entry.metricProjection?.chargeLinkVersion)).toEqual([2, 2]);
    expect(JSON.stringify(compacted)).not.toMatch(/call_1\|fc_1|capability-1|private-business-result|private-credential|toolCallId/u);
    expect(aggregateResources([nativeResourceInput([], { nativeRecords: responsesFixture.records })]))
      .toEqual(aggregateResources([nativeResourceInput([], { ...compacted })]));
  });

  it("keeps attributed Context as supported, zero-fact evidence beside the selected Tool pair", async () => {
    const original = responsesCall();
    if (original.record.record.type !== "entry") throw new Error("Expected Pi entry");
    const context: NativeTrajectoryEntry = {
      ...original, ingestSeq: responsesResult().ingestSeq + 1,
      record: { ...original.record, submissionId: null, origin: "context",
        parent: { resource: { agentId: "agent-1", sessionId: "chat-1" }, submissionId: "submission-1" },
        record: { ...original.record.record, value: { ...original.record.record.value, id: 999 } } },
    };
    const input = nativeResourceInput([], {
      nativeRecords: [responsesCall(), responsesResult(), context],
    }).collection;
    if (!input || input.status !== "collected") throw new Error("Expected native snapshot");
    const compacted = await compactResourceSnapshot(input.snapshot);
    expect(compacted.nativeRecords[2]?.metricProjection)
      .toMatchObject({ version: 1, chargeLinkVersion: 2, supported: true, facts: [] });
    expect(toolFact(compacted.nativeRecords[0]!)).toMatchObject({ fromPiCall: true });
    expect(toolFact(compacted.nativeRecords[1]!)).toMatchObject({ fromPiResult: true });
  });

  it("retains only body-free Pi Result milliseconds and outcome, distinguishing zero from missing", async () => {
    for (const { duration, failed } of [
      { duration: 0, failed: false }, { duration: 13, failed: true }, { duration: undefined, failed: false },
    ]) {
      const result = responsesResult();
      const message = sourceMessage(result);
      message.isError = failed;
      if (duration === undefined) delete message.durationMs;
      else message.durationMs = duration;
      const compact = await compactNativeTrajectoryRecord(result, responsesScope);
      expect(toolFact(compact)).toMatchObject({
        type: "tool", phase: "result", status: failed ? "failed" : "completed",
        durationMs: duration ?? null, fromPiResult: true,
      });
      expect(JSON.stringify(compact)).not.toMatch(/call_1\|fc_1|private-business-result|capabilityId|details/u);
    }
  });

  it("retains two distinct SAFE Pi Tool Call facts from one assistant message, in content order", async () => {
    const assistant = responsesCall();
    const content = sourceMessage(assistant).content as Record<string, JsonValue>[];
    content.push({ type: "toolCall", id: "call_2|fc_2", name: "read_only",
      arguments: { privateInput: "private-business-body" } });
    const compact = await compactNativeTrajectoryRecord(assistant, responsesScope);
    const calls = (compact.metricProjection?.facts as Record<string, JsonValue>[]).filter((fact) =>
      fact.fromPiCall === true);
    expect(calls).toMatchObject([
      { type: "tool", phase: "start", toolName: "lookup", fromPiCall: true },
      { type: "tool", phase: "start", toolName: "read_only", fromPiCall: true },
    ]);
    expect(calls[0]?.toolCallKey).toMatch(/^tck2_[0-9a-f]{64}$/u);
    expect(calls[1]?.toolCallKey).toMatch(/^tck2_[0-9a-f]{64}$/u);
    expect(calls[0]?.toolCallKey).not.toBe(calls[1]?.toolCallKey);
    expect(JSON.stringify(compact)).not.toMatch(/call_[12]\|fc_[12]|private-business-body|privateInput/u);
  });

  it("keeps actor/Submission and Tool-name collisions apart even with the same UA ID", async () => {
    const baseCall = toolFact(await compactNativeTrajectoryRecord(responsesCall(), responsesScope))!;
    const baseResult = toolFact(await compactNativeTrajectoryRecord(responsesResult(), responsesScope))!;
    expect(baseResult.toolCallKey).toBe(baseCall.toolCallKey);

    const otherActor = responsesResult();
    (otherActor.record.resource as { agentId: string }).agentId = "agent-2";
    const actorResult = toolFact(await compactNativeTrajectoryRecord(otherActor, responsesScope))!;
    expect(actorResult.toolCallKey).not.toBe(baseCall.toolCallKey);
    expect(actorResult.agentId).toBe("agent-2");

    const otherSubmission = responsesResult();
    Object.assign(otherSubmission.record, { submissionId: "child-submission",
      parent: { resource: { agentId: "agent-1", sessionId: "chat-1" }, submissionId: "submission-1" } });
    const submissionResult = toolFact(await compactNativeTrajectoryRecord(otherSubmission, responsesScope))!;
    expect(submissionResult.toolCallKey).not.toBe(baseCall.toolCallKey);
    expect(submissionResult.submissionId).toBe("child-submission");

    const otherName = responsesResult();
    sourceMessage(otherName).toolName = "other";
    const nameResult = toolFact(await compactNativeTrajectoryRecord(otherName, responsesScope))!;
    expect(nameResult.toolCallKey).toBe(baseCall.toolCallKey); // SQL must also require the same name.
    expect(nameResult.toolName).not.toBe(baseCall.toolName);
    for (const fact of [baseCall, baseResult, actorResult, submissionResult, nameResult]) {
      expect(fact.toolCallKey).toMatch(/^tck2_[0-9a-f]{64}$/u);
      expect(JSON.stringify(fact)).not.toContain("call_1|fc_1");
    }
  });

  it("keeps only parent scope proof, not an opaque parent Tool Call ID or other private metadata", async () => {
    const child = responsesResult();
    Object.assign(child.record, { submissionId: "child-submission",
      parent: { resource: { agentId: "agent-1", sessionId: "chat-1" }, submissionId: "submission-1",
        toolCallId: "call_1|fc_1", requestId: "Bearer private-request", runId: "private-run" } });
    const projected = await compactNativeTrajectoryRecord(child, responsesScope);
    expect(projected.record.parent).toEqual({
      resource: { agentId: "agent-1", sessionId: "chat-1" }, submissionId: "submission-1",
    });
    expect(toolFact(projected)).toMatchObject({ submissionId: "child-submission",
      toolCallKey: expect.stringMatching(/^tck2_[0-9a-f]{64}$/u), executionId: "execution-1" });
    expect(JSON.stringify(projected)).not.toMatch(/call_1\|fc_1|Bearer private-request|private-run/u);
  });

  it("uses the same composite Tool operation ID in Pi Call, events, hook and Result (raw/compact parity)", async () => {
    const records = nativeFixture(...Array.from({ length: 16 }, (_, index) => index + 1));
    const value = (seq: number) => {
      const write = records[seq - 1]!.record.record;
      if (write.type !== "entry") throw new Error("Expected a Pi entry");
      return write.value;
    };
    ((value(6).model as Record<string, JsonValue>[])[0]!.content as Record<string, JsonValue>[])
      .find((block) => block.type === "toolCall")!.id = "call_1|fc_1";
    (value(10).model as Record<string, JsonValue>[])[0]!.toolCallId = "call_1|fc_1";
    for (const seq of [8, 11]) {
      const data = value(seq).data as { event: { toolCallId: string } };
      data.event.toolCallId = "call_1|fc_1";
    }
    (value(9).data as { toolCallId: string }).toolCallId = "call_1|fc_1";
    const input = nativeResourceInput([], { nativeRecords: records });
    const raw = aggregateResources([input]);
    expect(raw.trajectory.tools).toMatchObject({ count: { value: 1, coverage: "complete" }, failed: 1 });
    const collection = input.collection;
    if (!collection || collection.status !== "collected") throw new Error("Expected native snapshot");
    const compacted = await compactResourceSnapshot(collection.snapshot);
    expect(aggregateResources([nativeResourceInput([], { ...compacted })])).toEqual(raw);
    const key = toolFact(compacted.nativeRecords[5]!)!.id;
    for (const seq of [8, 10, 11]) expect(toolFact(compacted.nativeRecords[seq - 1]!)?.id).toBe(key);
    expect(((compacted.nativeRecords[8]!.metricProjection?.facts ?? []) as readonly Record<string, JsonValue>[])[0]!.toolCallId)
      .toBe(key);
    expect(JSON.stringify(compacted)).not.toContain("call_1|fc_1");
  });

  it("never copies malformed, withheld or credential-like Call/Result IDs into compact facts", async () => {
    for (const [id, linkable] of [
      ["", false], [null, false], [17, false], ["[REDACTED]", false],
      ["[CONTENT OMITTED]", false], ["[Action business data withheld from telemetry]", false],
      [" ", true], ["\u0000", true], ["x".repeat(200), true],
      ["Bearer private-call-credential/from-safe-source", true],
    ] as const) {
      const call = responsesCall();
      const result = responsesResult();
      (sourceMessage(call).content as Record<string, JsonValue>[])[0]!.id = id;
      sourceMessage(result).toolCallId = id;
      const compacted = await compactResourceSnapshot({
        scope: responsesScope, observedAt: "2026-11-02T00:00:00Z", finalized: true,
        coverage: { usageEvents: "complete", nativeRecords: "complete", billingSettlements: "complete" },
        usageEvents: [], billingSettlements: [], nativeRecords: [call, result],
      });
      const [callFact, resultFact] = compacted.nativeRecords.map(toolFact);
      for (const fact of [callFact, resultFact]) {
        if (linkable) expect(fact?.toolCallKey).toMatch(/^tck2_[0-9a-f]{64}$/u);
        else {
          expect(fact).not.toHaveProperty("toolCallKey");
          expect(fact?.id).toBeNull();
        }
      }
      if (linkable) expect(resultFact).toHaveProperty("executionId", "execution-1");
      else expect(resultFact).not.toHaveProperty("executionId");
      const saved = JSON.stringify(compacted);
      if (typeof id === "string" && id.length > 1) expect(saved).not.toContain(id);
      expect(saved).not.toContain("toolCallId");
    }
    const surrogate = responsesCall();
    const replacement = responsesCall();
    (sourceMessage(surrogate).content as Record<string, JsonValue>[])[0]!.id = "\ud83e";
    (sourceMessage(replacement).content as Record<string, JsonValue>[])[0]!.id = "\ufffd";
    expect(toolFact(await compactNativeTrajectoryRecord(surrogate, responsesScope))?.toolCallKey)
      .not.toBe(toolFact(await compactNativeTrajectoryRecord(replacement, responsesScope))?.toolCallKey);
  });

  it.each(["pi.toolResult", "pi.tool-result"])("keeps validated Tool Call and %s Result charge links", async (kind) => {
    const call = nativeFixture(6)[0]!;
    const result = nativeFixture(10)[0]!;
    if (call.record.record.type !== "entry" || result.record.record.type !== "entry") throw new Error("Expected Pi entries");
    (result.record.record.value as { kind: string }).kind = kind;
    const message = (result.record.record.value.model as Record<string, JsonValue>[])[0]!;
    message.details = {
      executionId: "execution-1", capabilityId: "capability-1",
      arguments: { secret: "private-argument" }, response: "private-business-body", apiKey: "private-key",
    };
    const snapshot = nativeResourceInput([], { nativeRecords: [call, result] }).collection;
    if (!snapshot || snapshot.status !== "collected") throw new Error("Expected native snapshot");
    const projected = await compactResourceSnapshot(snapshot.snapshot);
    const expectedKey = `tck2_${await sha256Hex(JSON.stringify([
      "eval-platform.pi-tool-call-id/v2", "agent-1", "chat-1", "submission-1", "call-1",
    ]))}`;
    expect(projected.nativeRecords[0]!.metricProjection).toMatchObject({
      chargeLinkVersion: 2, facts: expect.arrayContaining([
        expect.objectContaining({ type: "tool", fromPiCall: true, agentId: "agent-1", submissionId: "submission-1",
          toolCallKey: expectedKey, toolName: "search" }),
      ]),
    });
    expect(projected.nativeRecords[1]!.metricProjection).toMatchObject({
      chargeLinkVersion: 2, facts: [{
        type: "tool", phase: "result", fromPiResult: true, agentId: "agent-1",
        submissionId: "submission-1", toolCallKey: expectedKey, toolName: "search",
        executionId: "execution-1",
      }],
    });
    expect(JSON.stringify(projected)).not.toMatch(/call-1|capability-1|private-argument|private-business-body|private-key|apiKey|details/u);
    expect(aggregateResources([nativeResourceInput([], { nativeRecords: [call, result] })]))
      .toEqual(aggregateResources([nativeResourceInput([], { ...projected })]));
  });

  it("ignores Tool Result capabilityId for Action identity without losing a safe optional execution link", async () => {
    const source = nativeFixture(10)[0]!;
    if (source.record.record.type !== "entry") throw new Error("Expected Pi result");
    const message = (source.record.record.value.model as Record<string, JsonValue>[])[0]!;
    const collection = nativeResourceInput([], { nativeRecords: [source] }).collection;
    if (!collection || collection.status !== "collected") throw new Error("Expected native snapshot");
    for (const details of [
      { executionId: "https://private.test/secret", capabilityId: "capability-1" },
      { executionId: "[REDACTED]", capabilityId: "capability-1" },
    ]) {
      message.details = details;
      const compacted = await compactResourceSnapshot(collection.snapshot);
      const fact = compacted.nativeRecords[0]!.metricProjection!.facts as Record<string, unknown>[];
      expect(fact[0]).not.toHaveProperty("executionId");
      expect(fact[0]).not.toHaveProperty("capabilityId");
      expect(JSON.stringify(compacted)).not.toContain(details.capabilityId);
    }
    message.details = { executionId: "execution-1", capabilityId: "Bearer private-key" };
    message.toolCallId = "https://private.test/call";
    const opaqueCall = await compactResourceSnapshot(collection.snapshot);
    expect(toolFact(opaqueCall.nativeRecords[0]!)).toMatchObject({
      executionId: "execution-1", toolCallKey: expect.stringMatching(/^tck2_[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(opaqueCall)).not.toMatch(/https:\/\/private\.test\/call|Bearer private-key|capabilityId/u);
    const bookkeeping = nativeFixture(8)[0]!;
    if (bookkeeping.record.record.type !== "entry") throw new Error("Expected a Tool event");
    const event = (bookkeeping.record.record.value.data as { event: { payload: { toolName: string } } }).event;
    event.payload.toolName = "sk-private-credential";
    const eventCollection = nativeResourceInput([], { nativeRecords: [bookkeeping] }).collection;
    if (!eventCollection || eventCollection.status !== "collected") throw new Error("Expected native snapshot");
    expect(JSON.stringify(await compactResourceSnapshot(eventCollection.snapshot))).not.toContain("sk-private-credential");
  });

  it.each(["\ud83e", "\udd16", "\u0000", "\u4e2d\u6587 \u00e9 \ud83e\udd16"])(
    "keeps a SAFE Tool name %j in Metrics without using it as a charge-link identity", async (name) => {
      const call = nativeFixture(6)[0]!;
      const event = nativeFixture(8)[0]!;
      const result = nativeFixture(10)[0]!;
      if (call.record.record.type !== "entry" || event.record.record.type !== "entry"
        || result.record.record.type !== "entry") throw new Error("Expected Pi entries");
      const assistant = (call.record.record.value.model as Record<string, JsonValue>[])[0]!;
      (assistant.content as Record<string, JsonValue>[]).find((block) => block.type === "toolCall")!.name = name;
      (event.record.record.value.data as { event: { payload: { toolName: string } } }).event.payload.toolName = name;
      const tool = (result.record.record.value.model as Record<string, JsonValue>[])[0]!;
      tool.toolName = name;
      tool.details = { executionId: "execution-1", capabilityId: "capability-1" };
      const collection = nativeResourceInput([], { nativeRecords: [call, event, result] }).collection;
      if (!collection || collection.status !== "collected") throw new Error("Expected native snapshot");

      const compacted = await compactResourceSnapshot(collection.snapshot);
      for (const entry of compacted.nativeRecords) {
        const fact = (entry.metricProjection!.facts as Record<string, unknown>[])
          .find((item) => item.type === "tool");
        expect(fact?.toolName).toBe(name);
        expect(fact).not.toHaveProperty("executionId");
        expect(fact).not.toHaveProperty("capabilityId");
      }
    },
  );

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
    expect(await compact(projected)).toEqual(projected);
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
