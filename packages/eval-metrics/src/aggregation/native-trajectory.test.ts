import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { jsonObjectArrayInPlaceSchema, jsonObjectInPlaceSchema, summarizeResourceSnapshot, type AgentResourceCollection, type AgentResourceSnapshot,
  type AgentRuntimeBusinessDeliveryState, type AgentTrajectoryDeliveryState } from "@eval-platform/eval-contracts";
import { compactResourceSnapshot, createMetrics, type ResourceStatistics } from "../index.js";
import { telemetry, resourceInput, facts, plan, dataset, projectSample, sampling, settlement, PROJECT } from "../test-support.js";

interface ResourceInput {
  readonly ownerUserId: string;
  readonly canEmitTelemetry?: boolean;
  readonly collection?: AgentResourceCollection | undefined;
}

async function statistics(inputs: readonly ResourceInput[]): Promise<ResourceStatistics> {
  const base = sampling();
  const subject = { ...base, subjectChatId: "chat", executionAttempts: inputs.map((input, index) => ({
    executionAttemptId: `attempt-${index}`, samplingId: base.samplingId, attemptNumber: index + 1,
    status: input.canEmitTelemetry ? "running" as const : index === 0 ? "failed" as const : "completed" as const,
    submissionId: input.collection?.status === "collected" ? input.collection.snapshot.scope.submissionId ?? "submission" : "submission",
    ...(input.collection === undefined ? {} : { resources: input.collection }),
  })) };
  const metrics = createMetrics({ source: { read: async () => facts({
    plan: plan([dataset("dataset", ["ps-1"])], false), projectSamples: [projectSample("ps-1", ["dataset"])], samplings: [subject],
  }) } });
  return (await metrics.getSamplingDetail({ projectId: PROJECT.projectId, samplingId: base.samplingId })).subject.resources;
}

const resource = { agentId: "root", sessionId: "chat" };
const delivery = (agentId = "root", children: ReturnType<typeof childDelivery>[] = []) => ({
  resource: { agentId, sessionId: "chat" }, submissionId: "submission", status: "delivered" as const,
  requiredClosed: true, pendingRecords: 0, children,
});
const childDelivery = () => ({ resource: { agentId: "child", sessionId: "chat" }, submissionId: "submission",
  status: "delivered" as const, requiredClosed: true, pendingRecords: 0, children: [] });
const business = (node: AgentTrajectoryDeliveryState): AgentRuntimeBusinessDeliveryState => ({
  actor: { resource: node.resource, path: [] }, submissionId: node.submissionId,
  status: node.status, pendingRuntimeEvents: node.pendingRecords === null ? null : 0, quarantinedRuntimeEvents: 0,
  children: node.children.map(business),
});
const readiness = (trajectory: AgentTrajectoryDeliveryState = delivery()) => ({
  receiptTerminal: true, stateUnreadable: false, pendingTelemetryEvents: 0, pendingRuntimeEvents: 0,
  actionCharges: { complete: true, unsettledExecutions: 0, missingExecutionIds: 0 }, trajectory, runtimeBusiness: business(trajectory),
});
const usage = { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
function stream(actor = "root", extra: object = {}) {
  const record = <T extends object>(type: string, value: T) => ({
    format: "pi-trajectory/v1", resource: { ...resource, agentId: actor }, submissionId: "submission",
    projection: { kind: "safe", policyId: "fixture", policyVersion: 1 }, ...extra, record: { type, value },
  });
  const entry = (id: number, kind: string, fields: object) => record("entry", { id, conversationId: 1, kind, ...fields });
  const fact = (id: number, data: object) => entry(id, "springbrand.trajectory", { data });
  return { record, entry, fact, records: [
    record("conversation", { id: 1 }),
    fact(2, { type: "host_turn", phase: "admitted", requestId: "host", submissionId: "submission", recordedAt: 0 }),
    fact(3, { type: "request", requestId: "request", taskId: 10, cutoff: 2, attempt: 1, purpose: "generation",
      method: "streamSimple", inputs: [], dispatched: true, startedAt: 5,
      model: { provider: "openrouter", modelId: "model", api: "openai-completions" } }),
    entry(4, "pi.assistant", { byTaskId: 10, model: [{
      role: "assistant", provider: "openrouter", api: "openai-completions", model: "model", stopReason: "toolUse", timestamp: 5, durationMs: 10,
      content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "content" },
        { type: "toolCall", id: "call", name: "delegate", arguments: { query: "é" } }], usage,
    }] }),
    fact(5, { type: "request_end", requestId: "request", taskId: 10, endedAt: 15, result: { type: "entry", entryId: 4 } }),
    entry(6, "pi.toolResult", { byTaskId: 11, model: [{
      role: "toolResult", toolCallId: "call", toolName: "delegate", content: [{ type: "text", text: "result" }],
      isError: false, timestamp: 20, durationMs: 4,
    }], data: { diagnostics: [] } }),
    fact(7, { type: "host_turn", phase: "terminal", status: "completed", submissionId: "submission", childRegistrationClosed: true, recordedAt: 30 }),
  ] };
}
function input(events: readonly object[], patch: Partial<AgentResourceSnapshot> = {}): ResourceInput {
  const snapshot: AgentResourceSnapshot = {
    scope: { chatId: "chat", idempotencyKey: "key", submissionId: "submission" }, observedAt: "2026-10-22T00:00:00Z",
    finalized: true, trajectoryFormat: "pi-trajectory/v1", readiness: readiness(),
    coverage: { usageEvents: "complete", telemetryEvents: "complete", billingSettlements: "complete" },
    telemetryEvents: jsonObjectArrayInPlaceSchema.parse(events), usageEvents: [], billingSettlements: [], ...patch,
  };
  return { ownerUserId: "owner", canEmitTelemetry: false,
    collection: { status: "collected", summary: summarizeResourceSnapshot(snapshot), snapshot } };
}

describe("native resource statistics through the aggregation interface", () => {
  it.each([
    { decision: "allow_once", status: "approved" },
    { decision: "deny", status: "rejected", reason: "User declined" },
  ])("keeps native $decision approval evidence out of calls, tools, tokens and charged credits", async (decision) => {
    const source = stream();
    const baseline = await statistics([input(source.records)]);
    const records = [
      ...source.records.slice(0, -1),
      source.fact(7, {
        type: "approval_decision", submissionId: "submission", requestId: "request",
        executionId: "approval-execution", toolCallId: "call", toolName: "delegate",
        decidedAt: 25, recordedAt: 25, ...decision,
      }),
      source.fact(8, {
        type: "host_turn", phase: "terminal", status: "completed", submissionId: "submission",
        childRegistrationClosed: true, recordedAt: 30,
      }),
    ];
    const original = input(records);
    const bytes = JSON.stringify(original);
    expect(await statistics([original])).toEqual(baseline);
    expect(JSON.stringify(original)).toBe(bytes);
  });

  it("keeps a public unreadable-root partial snapshot unavailable instead of throwing or inventing identity", async () => {
    const trajectory: AgentTrajectoryDeliveryState = {
      resource: null, submissionId: "submission", status: "unreadable", requiredClosed: false,
      pendingRecords: null, children: [], error: "runtime_initialization_failed",
    };
    const original = input([], { finalized: false,
      coverage: { usageEvents: "partial", telemetryEvents: "partial", billingSettlements: "partial" },
      readiness: { ...readiness(trajectory), stateUnreadable: true, pendingTelemetryEvents: null, pendingRuntimeEvents: null,
        runtimeBusiness: { ...business(trajectory), quarantinedRuntimeEvents: null },
        actionCharges: { complete: false, unsettledExecutions: 0, missingExecutionIds: 0 } },
    });
    const result = await statistics([original]);
    expect(result.tokens.total).toEqual({ value: null, coverage: "unavailable" });
    expect(result.modelRequests.count).toEqual({ value: null, coverage: "unavailable" });
    expect(result.costs.chargedUnits).toEqual({ value: null, coverage: "unavailable" });
    expect(result.diagnostics.some((diagnostic) => /root execution.*(identity|scope)/i.test(diagnostic.message))).toBe(true);
  });

  it("does not turn an identity-less required admission into complete root-only coverage", async () => {
    const child: AgentTrajectoryDeliveryState = {
      resource: null, submissionId: null, status: "pending", requiredClosed: false, pendingRecords: null,
      children: [], error: "child_admission_unknown:launch",
    };
    const trajectory: AgentTrajectoryDeliveryState = {
      ...delivery(), status: "pending", requiredClosed: false, children: [child],
    };
    const result = await statistics([input(stream().records, { finalized: false,
      coverage: { usageEvents: "partial", telemetryEvents: "partial", billingSettlements: "partial" },
      readiness: { ...readiness(trajectory), stateUnreadable: true, pendingTelemetryEvents: null, pendingRuntimeEvents: null,
        actionCharges: { complete: false, unsettledExecutions: 0, missingExecutionIds: 0 } },
    })]);
    expect(result.modelRequests.count).toEqual({ value: 1, coverage: "partial" });
    expect(result.tokens.total).toEqual({ value: 6, coverage: "partial" });
    expect(result.costs.chargedUnits).toEqual({ value: null, coverage: "unavailable" });
    expect(result.diagnostics.some((diagnostic) => /membership.*incomplete/i.test(diagnostic.message))).toBe(true);
  });

  it.each([1, 2, 3, 4, 5, 7, 99])("explicitly rejects unsupported native v%s without fallback or input mutation", async (version) => {
    const original = input(stream().records).collection;
    if (original?.status !== "collected") throw new Error("missing snapshot");
    const raw = original.snapshot;
    const compact = await compactResourceSnapshot(raw);
    const metadata = jsonObjectInPlaceSchema.parse(compact).metricProjection;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("missing cache metadata");
    for (const telemetryEvents of [compact.telemetryEvents, raw.telemetryEvents, []]) {
      const unsupported = { ...compact, telemetryEvents, metricProjection: { ...metadata, version } };
      const bytes = JSON.stringify(unsupported);
      const error = `Unsupported native telemetry projection version: ${version}`;
      await expect(compactResourceSnapshot(unsupported)).rejects.toThrow(error);
      await expect(statistics([input([], unsupported)])).rejects.toThrow(error);
      expect(JSON.stringify(unsupported)).toBe(bytes);
    }
    const event = compact.telemetryEvents[0]!;
    const projection = jsonObjectInPlaceSchema.parse(event.metricProjection);
    const unsupportedEvent = { ...compact, telemetryEvents: [{ metricProjection: { ...projection, version } }] };
    await expect(compactResourceSnapshot(unsupportedEvent)).rejects.toThrow(`Unsupported native telemetry projection version: ${version}`);
  });

  it("derives current native v6 from source and validates it without replacing source or cache", async () => {
    const original = input(stream().records).collection;
    if (original?.status !== "collected") throw new Error("missing snapshot");
    const raw = original.snapshot;
    const compact = await compactResourceSnapshot(raw);
    const metadata = jsonObjectInPlaceSchema.parse(compact).metricProjection;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("missing cache metadata");
    const bytes = JSON.stringify({ raw, compact });
    expect(metadata).toMatchObject({ version: 6, sourceFormat: "pi-trajectory/v1", complete: true });
    expect(await compactResourceSnapshot(compact)).toBe(compact);
    expect(await compactResourceSnapshot(raw)).toEqual(compact);
    expect(await statistics([input([], compact)])).toEqual(await statistics([input([], raw)]));
    expect(JSON.stringify({ raw, compact })).toBe(bytes);
  });

  it("rejects absent native declarations and impossible finalized delivery instead of reporting known zero", async () => {
    const collection = input(stream().records).collection!;
    if (collection.status !== "collected") throw new Error("fixture");
    const snapshot = collection.snapshot;
    const { trajectoryFormat: _format, ...withoutFormat } = snapshot;
    const { readiness: _readiness, ...withoutReadiness } = snapshot;
    const { trajectory: _trajectory, ...withoutTrajectory } = readiness();
    const { runtimeBusiness: _business, ...withoutBusiness } = readiness();
    for (const invalid of [
      withoutFormat, { ...snapshot, trajectoryFormat: "sp-trajectory/v1" }, withoutReadiness, { ...snapshot, readiness: withoutTrajectory },
      { ...snapshot, readiness: withoutBusiness },
      { ...snapshot, readiness: { ...readiness(), pendingRuntimeEvents: null } },
      { ...snapshot, readiness: { ...readiness(), runtimeBusiness: { ...business(delivery()), status: "missing" } } },
      { ...snapshot, readiness: { ...readiness(delivery("root", [childDelivery()])), runtimeBusiness: business(delivery()) } },
    ]) await expect(compactResourceSnapshot(invalid as AgentResourceSnapshot)).rejects.toThrow();
    const partial = await statistics([input([], {
      finalized: false, readiness: { ...readiness(), pendingRuntimeEvents: null },
    })]);
    expect(partial.costs.chargedUnits).toEqual({ value: null, coverage: "unavailable" });
    expect(partial.trajectory.generationTasks).toEqual({ value: null, coverage: "unavailable" });
  });

  it("isolates old executions and unrelated actors, retaining current-scope dispatches on every branch", async () => {
    const current = (actor: string) => {
      const source = stream(actor);
      const old = source.records.map((record) => ({
        ...record, submissionId: "old",
        record: record.record.type === "entry" && "data" in record.record.value &&
          (record.record.value.data as { type?: string }).type === "host_turn"
          ? { ...record.record, value: { ...record.record.value, data: { ...record.record.value.data as object, submissionId: "old" } } }
          : record.record,
      }));
      const fresh = source.records.map((record) => {
        const value = record.record.value;
        if (record.record.type === "conversation") return {
          ...record, record: { type: "conversation", value: { id: 11, parent: { conversationId: 1, at: 7 } } },
        };
        const data = "data" in value ? value.data as Record<string, unknown> : undefined;
        return { ...record, record: { type: "entry", value: {
          ...value, id: Number(value.id) + 10, conversationId: 11,
          ...(data ? { data: { ...data, ...(data.type === "request" ? { requestId: "current", cutoff: 7 } : {}),
            ...(data.type === "request_end" ? { requestId: "current", result: { type: "entry", entryId: 14 } } : {}) } } : {}),
        } } };
      });
      const branch = [
        source.record("conversation", { id: 21, parent: { conversationId: 11, at: 12 } }),
        source.record("entry", { id: 22, conversationId: 21, kind: "springbrand.trajectory", data: {
            type: "request", requestId: "fork", taskId: 30, cutoff: 12, attempt: 1, purpose: "generation",
            method: "streamSimple", inputs: [], dispatched: true, startedAt: 50,
            model: { provider: "openrouter", modelId: "fork-model", api: "openai-completions" },
        } }),
      ];
      return [...old, ...fresh, ...branch];
    };
    const records = [...current("root"), ...current("child"), ...stream("unrelated").records].toReversed();
    const result = await statistics([input(records, { readiness: readiness(delivery("root", [childDelivery()])) })]);
    expect(result.modelRequests.count).toEqual({ value: 4, coverage: "complete" });
    expect(result.modelRequests.unknown).toBe(2);
    expect(result.tokens.total).toEqual({ value: 12, coverage: "partial" });
    expect(result.trajectory.tools.count.value).toBe(2);
    expect(result.byModel.map((model) => model.model)).toEqual(["model"]);
  });
  it("keeps fixed historical bytes and their pre-existing hash unchanged", async () => {
    const bytes = '{"scope":{"chatId":"old-chat","idempotencyKey":"old-key","submissionId":"old-submission"},"observedAt":"2026-01-01T00:00:00.000Z","finalized":true,"coverage":{"usageEvents":"complete","telemetryEvents":"complete","billingSettlements":"complete"},"usageEvents":[],"telemetryEvents":[{"eventId":"old-event","type":"turn.finished","runId":"old-run","payload":{"durationMs":1}}],"billingSettlements":[]}';
    const historical = JSON.parse(bytes) as AgentResourceSnapshot;
    const result = await compactResourceSnapshot(historical);
    expect(result).toBe(historical);
    expect(JSON.stringify(result)).toBe(bytes);
    expect(createHash("sha256").update(JSON.stringify(result)).digest("hex"))
      .toBe("9e897408becdab189fb5f634c09d3a833fd687ed5b0f0653a17c41a0a107094c");
  });

  it("reads context dependencies but counts executed records only by explicit execution membership", async () => {
    const current = stream();
    const child = stream("child");
    const imported = stream("imported-child", { origin: "execution" });
    const context = current.records.map((record) => record.record.type === "conversation" ||
      ("kind" in record.record.value && record.record.value.kind === "pi.user")
      ? { ...record, submissionId: null, origin: "context" } : record);
    const result = await statistics([input([...context, ...child.records, ...imported.records], {
      readiness: readiness(delivery("root", [childDelivery()])),
    })]);
    expect(result.modelRequests.count).toEqual({ value: 2, coverage: "complete" });
    expect(result.trajectory.thinkingSteps.value).toBe(2);
    expect(result.trajectory.modelInvocations.count.value).toBe(2);
    expect(result.trajectory.generationTasks.value).toBe(2);
    expect(result.tokens.total.value).toBe(12);
  });

  it("keeps missing required-child membership partial rather than reporting a complete root total", async () => {
    const result = await statistics([input(stream().records, {
      finalized: false,
      readiness: { ...readiness(), trajectory: { ...delivery(), children: [{
        ...childDelivery(), resource: null, submissionId: null, status: "missing", pendingRecords: null,
      }] } },
    })]);
    expect(result.modelRequests.count).toEqual({ value: 1, coverage: "partial" });
    expect(result.trajectory.diagnostics.some((item) => /membership is incomplete/.test(item.message))).toBe(true);
    expect(result.costs.chargedUnits.value).toBeNull();
  });

  it("rejects a cached projection under another scope or version, and preserves native extension fields", async () => {
    const snapshot = input(stream().records).collection!;
    if (snapshot.status !== "collected") throw new Error("fixture");
    const projection = await compactResourceSnapshot(snapshot.snapshot);
    await expect(compactResourceSnapshot({ ...projection, scope: { ...projection.scope, idempotencyKey: "another" } }))
      .rejects.toThrow(/scope/);
    await expect(compactResourceSnapshot({ ...projection, metricProjection: {
      ...(projection as unknown as { metricProjection: object }).metricProjection, version: 99,
    } } as AgentResourceSnapshot)).rejects.toThrow();
    const { trajectoryFormat: _format, ...withoutFormat } = projection;
    await expect(compactResourceSnapshot(withoutFormat)).rejects.toThrow(/format/);
    const projected = projection.telemetryEvents[0]!.metricProjection as Record<string, unknown>;
    for (const patch of [
      { fingerprint: undefined },
      { native: { ...projected.native as object, sourceIdentity: "" } },
      { native: { ...projected.native as object, sourceIdentity: "forged" } },
      { native: { ...projected.native as object, selected: true, submissionId: "old" } },
    ]) await expect(compactResourceSnapshot({ ...projection, telemetryEvents: [
      { metricProjection: { ...projected, ...patch } },
    ] } as AgentResourceSnapshot)).rejects.toThrow();
    const raw = stream().records.map((record) => ({
      ...record, record: { ...record.record, value: { ...record.record.value, futureSDKField: { metricProjection: true } } },
    }));
    await expect(compactResourceSnapshot({
      ...snapshot.snapshot, telemetryEvents: jsonObjectArrayInPlaceSchema.parse(raw),
    })).resolves.toBeDefined();
  });

  it("reads requests, Host Turns, tools, markers, native usage and actual durations", async () => {
    const result = await statistics([input(stream().records)]);
    expect(result.modelRequests.count).toEqual({ value: 1, coverage: "complete" });
    expect(result.trajectory.turns.count.value).toBe(1);
    expect(result.trajectory.turns.durationMs.total).toBe(30);
    expect(result.modelRequests.durationMs.total).toBe(10);
    expect(result.trajectory.tools.count.value).toBe(1);
    expect(result.trajectory.byTool[0]?.durationMs.total).toBe(4);
    expect(result.trajectory.byTool[0]?.inputLength.total).toBe(new TextEncoder().encode('{"query":"é"}').byteLength);
    expect(result.trajectory.thinkingSteps.value).toBe(1);
    expect(result.trajectory.contentSteps.value).toBe(1);
    expect(result.tokens.total).toEqual({ value: 6, coverage: "complete" });
    expect(result.tokens.reasoning).toEqual({ value: null, coverage: "unavailable" });
    expect(result.costs.chargedUnits.value).toBe(0);
  });

  it("keeps actor-local IDs distinct and deduplicates receiving-order retries and cross-attempt repeats", async () => {
    const root = stream().records;
    const child = stream("child", { parent: { resource, submissionId: "submission", toolCallId: "call" } }).records;
    const repeated = root.map((record, index) => ({ ...record, ingestSeq: index + 100 }));
    const inputs = [input([...root, ...child], { readiness: readiness(delivery("root", [childDelivery()])) }), input(repeated)];
    const result = await statistics(inputs);
    expect(result.modelRequests.count.value).toBe(2);
    expect(result.tokens.total.value).toBe(12);
    expect(result.duplicateRecords.telemetryEvents).toBe(root.length);
    const compacted = await Promise.all(inputs.map(async (item) => {
      if (item.collection?.status !== "collected") throw new Error("missing snapshot");
      return input([], await compactResourceSnapshot(item.collection.snapshot));
    }));
    expect(await statistics(compacted)).toEqual(result);
    expect(await statistics([inputs[0]!, compacted[1]!])).toEqual(result);
  });

  it("separates retry attempts and compaction, ignores hooks and imported execution context", async () => {
    const { records, fact, entry } = stream();
    const extra = [
      fact(8, { type: "hook", hook: "afterResponse", extension: "x", taskId: 10, requestId: "request", startedAt: 15, endedAt: 16, result: { type: "none" } }),
      fact(9, { type: "request", requestId: "retry", taskId: 10, cutoff: 2, attempt: 2, purpose: "generation", method: "streamSimple",
        inputs: [], dispatched: true, startedAt: 31, model: { provider: "openrouter", modelId: "model", api: "openai-completions" } }),
      fact(10, { type: "request_end", requestId: "retry", taskId: 10, endedAt: 32, result: { type: "error", error: { message: "failed" } } }),
      fact(12, { type: "request", requestId: "compact", taskId: 12, cutoff: 2, attempt: 1, purpose: "compaction", method: "completeSimple",
        compaction: { firstKept: 2, reason: "manual" }, inputs: [], dispatched: true, startedAt: 33,
        model: { provider: "openrouter", modelId: "model", api: "openai-completions" } }),
      fact(13, { type: "request_end", requestId: "compact", taskId: 12, endedAt: 34,
        result: { type: "response", message: { role: "assistant", provider: "openrouter", api: "openai-completions", model: "model",
          stopReason: "stop", timestamp: 33, content: [{ type: "text", text: "summary" }], usage } } }),
      { ...entry(14, "pi.assistant", { model: [{ role: "assistant", provider: "openrouter", api: "openai-completions", model: "model",
        stopReason: "stop", timestamp: 0, content: [{ type: "text", text: "old" }], usage }] }), submissionId: null, origin: "context" },
    ];
    const result = await statistics([input([...records.slice(0, -1), ...extra,
      fact(20, { type: "host_turn", phase: "terminal", status: "completed", submissionId: "submission",
        childRegistrationClosed: true, recordedAt: 40 })])]);
    expect(result.modelRequests.count.value).toBe(2);
    expect(result.modelRequests.failed).toBe(1);
    expect(result.trajectory.compactions.count.value).toBe(1);
    expect(result.trajectory.requestRetries).toEqual({
      generation: { value: 1, coverage: "complete" }, compaction: { value: 0, coverage: "complete" },
    });
    expect(result.tokens.total.value).toBe(12);
    expect(result.tokens.total.coverage).toBe("partial");
  });

  it("keeps immutable historical statistics readable in mixed-format scopes and rejects unknown formats", async () => {
    const historical = resourceInput({ telemetryEvents: [
      telemetry("start", "generation.started", "generation", {}, 0),
      telemetry("end", "generation.finished", "generation", { outcome: "completed" }, 10),
    ] });
    expect((await statistics([historical, input(stream().records)])).modelRequests.count.value).toBe(2);
    const original = historical.collection;
    if (original?.status !== "collected") throw new Error("missing snapshot");
    expect(await compactResourceSnapshot(original.snapshot)).toBe(original.snapshot);
    await expect(statistics([input([], { trajectoryFormat: "future/v2" })])).rejects.toThrow(/format/i);
  });

  it("suppresses child usage once per covered metric and bills only deduplicated settlements", async () => {
    const root = stream();
    const child = stream("child", { parent: { resource, submissionId: "submission", toolCallId: "call" } });
    const summary = root.entry(6, "pi.toolResult", { model: [{
      role: "toolResult", toolCallId: "call", toolName: "delegate", content: [{ type: "text", text: "done" }],
      isError: false, timestamp: 20, durationMs: 4,
      usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: usage.cost },
    }] });
    const records = [...root.records.filter((record) => record !== root.records[5]), summary, ...child.records];
    const bills = [settlement("model-charge"), {
      executionId: "action", accountId: "account", status: "succeeded", chargedCredits: 7,
    }];
    const result = await statistics([
      input(records, { billingSettlements: bills, readiness: readiness(delivery("root", [childDelivery()])) }),
      input(child.records, { billingSettlements: bills, readiness: readiness(delivery("child")) }),
    ]);
    expect(result.tokens.total).toEqual({ value: 12, coverage: "complete" });
    expect(result.overlappingUsageRecords).toBe(1);
    expect(result.costs.modelDebitedUnits.value).toBe(8);
    expect(result.costs.actionChargedUnits.value).toBe(7);
    expect(result.costs.chargedUnits).toEqual({ value: 15, coverage: "complete" });
    expect(result.duplicateRecords.billingSettlements).toBe(2);
  });

  it("preserves body-only conflicts and bounded native projections without dropping source identity", async () => {
    const source = stream();
    const request = source.records[2]!;
    const changed = { ...request, record: { ...request.record, value: { ...request.record.value, sourceExtension: "different" } } };
    const large = source.entry(8, "future.entry", { data: { body: "x".repeat(1_000_000) } });
    const original = input([...source.records, large]);
    const conflicting = input([changed]);
    if (original.collection?.status !== "collected" || conflicting.collection?.status !== "collected") throw new Error("missing snapshot");
    const before = JSON.stringify(original.collection.snapshot);
    const compact = await compactResourceSnapshot(original.collection.snapshot);
    const other = await compactResourceSnapshot(conflicting.collection.snapshot);
    expect(JSON.stringify(compact).length).toBeLessThan(15_000);
    expect(compact.telemetryEvents.every((record) => record.format === undefined && record.metricProjection !== undefined)).toBe(true);
    expect(await statistics([input([], compact), input([], other)])).toEqual(await statistics([original, conflicting]));
    const result = await statistics([original, input([], other)]);
    expect(result.diagnostics.some((item) => item.kind === "conflicting-identity")).toBe(true);
    expect(result.modelRequests.count.coverage).not.toBe("complete");
    expect(JSON.stringify(original.collection.snapshot)).toBe(before);
    await expect(compactResourceSnapshot({ ...compact, telemetryEvents: [
      { metricProjection: { version: 3, fingerprint: "old" } },
    ] })).rejects.toThrow(/version/i);
  });

  it("distinguishes a complete empty native stream from missing records and duration", async () => {
    const absentSource = await statistics([input([])]);
    expect(absentSource.modelRequests.count).toEqual({ value: null, coverage: "unavailable" });
    expect(absentSource.costs.chargedUnits).toEqual({ value: null, coverage: "unavailable" });
    const empty = stream().records.filter((record) => [1, 2, 7].includes(record.record.value.id as number));
    expect((await statistics([input(empty)])).modelRequests.count).toEqual({ value: 0, coverage: "complete" });
    const missing = await statistics([input([], { coverage: {
      usageEvents: "complete", telemetryEvents: "partial", billingSettlements: "complete",
    } })]);
    expect(missing.modelRequests.count).toEqual({ value: null, coverage: "unavailable" });
    expect(missing.tokens.total).toEqual({ value: null, coverage: "unavailable" });
    const source = stream();
    const withoutDuration = source.entry(6, "pi.toolResult", { model: [{
      role: "toolResult", toolCallId: "call", toolName: "delegate", content: [], timestamp: 20, isError: false,
    }] });
    const result = await statistics([input([...source.records.filter((record) => record !== source.records[5]), withoutDuration])]);
    expect(result.trajectory.byTool[0]?.durationMs).toMatchObject({ total: null, missing: 1 });
  });

  it("counts dispatched work on discarded forks, but not undispatched requests", async () => {
    const source = stream();
    const request = (requestId: string, taskId: number, dispatched: boolean) => ({
      type: "request", requestId, taskId, cutoff: 2, attempt: 1, purpose: "generation", method: "streamSimple",
      inputs: [], dispatched, startedAt: 5,
      model: { provider: "openrouter", modelId: "model", api: "openai-completions" },
    });
    const result = await statistics([input([
      ...source.records.slice(0, -1),
      source.record("conversation", { id: 11, parent: { conversationId: 1, at: 2 } }),
      source.entry(12, "springbrand.trajectory", { conversationId: 11, data: request("branch", 30, true) }),
      source.entry(13, "pi.assistant", { conversationId: 11, byTaskId: 30, model: [{
        role: "assistant", provider: "openrouter", api: "openai-completions", model: "model", stopReason: "stop",
        timestamp: 5, content: [{ type: "text", text: "branch response" }], usage,
      }] }),
      source.entry(14, "springbrand.trajectory", { conversationId: 11, data: {
        type: "request_end", requestId: "branch", taskId: 30, endedAt: 15, result: { type: "entry", entryId: 13 },
      } }),
      source.fact(15, request("not-dispatched", 40, false)),
      source.fact(20, { type: "host_turn", phase: "terminal", status: "completed", submissionId: "submission",
        childRegistrationClosed: true, recordedAt: 30 }),
    ])]);
    expect(result.modelRequests.count).toEqual({ value: 2, coverage: "complete" });
    expect(result.tokens.total).toEqual({ value: 12, coverage: "complete" });
    expect(result.trajectory.requestRetries.generation.value).toBe(0);
  });

  it("does not turn sanitized native bodies into complete negative markers or known lengths", async () => {
    const source = stream();
    const assistant = source.entry(4, "pi.assistant", { byTaskId: 10, model: [{
      role: "assistant", provider: "openrouter", api: "openai-completions", model: "model", stopReason: "toolUse",
      timestamp: 10, content: [{ type: "text", text: "[CONTENT OMITTED]" },
        { type: "toolCall", id: "call", name: "delegate", arguments: { input: "[REDACTED]" } }], usage,
    }] });
    const tool = source.entry(6, "pi.toolResult", { model: [{
      role: "toolResult", toolCallId: "call", toolName: "delegate", content: [], details: { redacted: true },
      timestamp: 20, durationMs: 4, isError: false,
    }] });
    const snapshot = input(source.records.map((entry, index) => index === 3 ? assistant : index === 5 ? tool : entry));
    const result = await statistics([snapshot]);
    expect(result.trajectory.thinkingSteps).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.byTool[0]?.inputLength).toMatchObject({ total: null, missing: 1, coverage: "unavailable" });
    expect(result.trajectory.byTool[0]?.outputLength).toMatchObject({ total: null, missing: 1, coverage: "unavailable" });
    if (snapshot.collection?.status !== "collected") throw new Error("missing snapshot");
    const compact = await compactResourceSnapshot(snapshot.collection.snapshot);
    expect(await statistics([{ ...snapshot, collection: { ...snapshot.collection, snapshot: compact } }])).toEqual(result);
  });

  it("retains nested native tool facts without borrowing the enclosing duration or output", async () => {
    const source = stream();
    const tool = source.entry(6, "pi.toolResult", { model: [{
      role: "toolResult", toolCallId: "call", toolName: "delegate", content: [], timestamp: 20, durationMs: 4, isError: false,
      nestedCalls: { complete: false, calls: [
        { id: "nested-1", name: "shell", status: "error", arguments: { command: "ls" }, durationMs: 3 },
        { id: "nested-2", name: "write_file", status: "unfinished" },
      ] },
    }] });
    const result = await statistics([input(source.records.map((entry, index) => index === 5 ? tool : entry))]);
    expect(result.trajectory.tools.count).toEqual({ value: 3, coverage: "partial" });
    expect(result.trajectory.tools.failed).toBe(1);
    expect(result.trajectory.tools.unknown).toBe(1);
    expect(result.trajectory.byTool.find((tool) => tool.toolName === "shell")?.durationMs.total).toBe(3);
    expect(result.trajectory.byTool.find((tool) => tool.toolName === "write_file")?.durationMs).toMatchObject({ total: null, missing: 1 });
    expect(result.trajectory.byTool.find((tool) => tool.toolName === "shell")?.outputLength).toMatchObject({ total: null, missing: 1 });
    expect(result.diagnostics.some((item) => /nested tool calls are incomplete/.test(item.message))).toBe(true);
  });

  it("keeps invocations, deferred polls, retries and native task identities separate", async () => {
    const source = stream();
    const result = await statistics([input([
      ...source.records.slice(0, -1),
      source.fact(8, { type: "request", requestId: "poll", taskId: 10, cutoff: 6, attempt: 2,
        purpose: "generation", method: "fetchDeferred", deferred: { id: "job" }, dispatched: true, inputs: [], startedAt: 25,
        model: { provider: "openrouter", modelId: "model", api: "openai-completions" } }),
      source.fact(9, { type: "request_end", requestId: "poll", taskId: 10, endedAt: 26,
        result: { type: "response", message: { role: "assistant", provider: "openrouter", api: "openai-completions",
          model: "model", stopReason: "stop", timestamp: 26, usage,
          content: [{ type: "thinking", thinking: "not another generation step" }, { type: "text", text: "poll result" }] } } }),
      source.fact(10, { type: "host_turn", phase: "terminal", status: "completed", submissionId: "submission",
        childRegistrationClosed: true, recordedAt: 30 }),
    ])]);
    expect(result.modelRequests.count).toEqual({ value: 2, coverage: "complete" });
    expect(result.trajectory.modelInvocations.count.value).toBe(1);
    expect(result.trajectory.deferredPolls.count.value).toBe(1);
    expect(result.trajectory.generationTasks).toEqual({ value: 1, coverage: "complete" });
    expect(result.trajectory.requestRetries.generation.value).toBe(0);
    expect(result.trajectory.thinkingSteps.value).toBe(1);
    expect(result.tokens.total).toEqual({ value: 12, coverage: "complete" });
  });

  it("does not make interrupted or missing-response usage free", async () => {
    const source = stream();
    const interrupted = source.records.filter((record) => ![4, 5, 6].includes(record.record.value.id as number));
    interrupted.push(source.fact(5, { type: "request_end", requestId: "request", taskId: 10, endedAt: 20,
      result: { type: "interrupted", outcome: "unknown" } }));
    const result = await statistics([input(interrupted)]);
    expect(result.modelRequests.unknown).toBe(1);
    expect(result.tokens.total).toEqual({ value: null, coverage: "unavailable" });
    const missing = await statistics([input(source.records.filter((record) => record.record.value.id !== 4))]);
    expect(missing.tokens.total.value).toBeNull();
    expect(missing.modelRequests.count.coverage).not.toBe("complete");
    expect(missing.diagnostics.some((item) => /assistant entry/.test(item.message))).toBe(true);
  });

  it("accounts for positive measured unbound inline usage without a canonical assistant entry or model-price estimate", async () => {
    const source = stream();
    const records = [
      ...source.records.slice(0, 2),
      source.fact(3, { type: "request", requestId: "unbound", taskId: 10, cutoff: null, attempt: 1,
        purpose: "generation", method: "completeSimple", inputs: [], dispatched: true, startedAt: 5,
        model: { provider: "openrouter", modelId: "model", api: "openai-completions",
          definition: { cost: { input: 1000, output: 2000, cacheRead: 500, cacheWrite: 1000 } } } }),
      source.fact(4, { type: "request_end", requestId: "unbound", taskId: 10, endedAt: 20,
        result: { type: "response", message: { role: "assistant", provider: "openrouter", api: "openai-completions",
          model: "model", stopReason: "stop", timestamp: 20, content: [{ type: "text", text: "Independent result" }], usage } } }),
      source.fact(5, { type: "host_turn", phase: "terminal", status: "completed", submissionId: "submission",
        childRegistrationClosed: true, recordedAt: 30 }),
    ];
    const bytes = JSON.stringify(records);
    const result = await statistics([input(records)]);
    expect(result.modelRequests.count).toEqual({ value: 1, coverage: "complete" });
    expect(result.modelRequests.completed).toBe(1);
    expect(result.trajectory.modelInvocations.count).toEqual({ value: 1, coverage: "complete" });
    expect(result.tokens.total).toEqual({ value: usage.totalTokens, coverage: "complete" });
    expect(result.costs.providerUsd).toEqual({ value: usage.cost.total, coverage: "complete" });
    expect(JSON.stringify(records)).toBe(bytes);
  });

  it.each(["interrupted", "missing"])("counts an unbound invocation with %s settlement without inventing usage", async (outcome) => {
    const source = stream();
    const records = [
      ...source.records.slice(0, 2),
      source.fact(3, { type: "request", requestId: "unbound", taskId: 10, cutoff: null, attempt: 1,
        purpose: "generation", method: "completeSimple", inputs: [], dispatched: true, startedAt: 5,
        model: { provider: "openrouter", modelId: "model", api: "openai-completions" } }),
      ...(outcome === "interrupted" ? [source.fact(4, { type: "request_end", requestId: "unbound", taskId: 10, endedAt: 20,
        result: { type: "interrupted", outcome: "unknown" } })] : []),
      source.fact(5, { type: "host_turn", phase: "terminal", status: "completed", submissionId: "submission",
        childRegistrationClosed: true, recordedAt: 30 }),
    ];
    const bytes = JSON.stringify(records);
    const result = await statistics([input(records)]);
    expect(result.modelRequests.count).toEqual({ value: 1, coverage: "complete" });
    expect(result.modelRequests.unknown).toBe(1);
    expect(result.trajectory.modelInvocations.count).toEqual({ value: 1, coverage: "complete" });
    expect(result.tokens.total).toEqual({ value: null, coverage: "unavailable" });
    expect(result.costs.providerUsd).toEqual({ value: null, coverage: "unavailable" });
    expect(JSON.stringify(records)).toBe(bytes);
  });

  it("accepts a live preparation without inventing a dispatched invocation", async () => {
    const source = stream();
    const prepared = [
      ...source.records.slice(0, 2),
      source.fact(3, { type: "request_start", requestId: "preflight", taskId: 10, cutoff: 2, attempt: 1,
        startedAt: 5, binding: { method: "streamSimple", model: { provider: "openrouter", modelId: "model" } } }),
      source.fact(4, { type: "request_end", requestId: "preflight", taskId: 10, endedAt: 6,
        result: { type: "interrupted", outcome: "not_dispatched" } }),
      source.fact(5, { type: "host_turn", phase: "terminal", status: "error", submissionId: "submission",
        childRegistrationClosed: true, recordedAt: 7 }),
    ];
    const result = await statistics([input(prepared)]);
    expect(result.modelRequests.count).toEqual({ value: 0, coverage: "complete" });
    expect(result.tokens.total).toEqual({ value: 0, coverage: "complete" });
    expect(result.trajectory.thinkingSteps).toEqual({ value: 0, coverage: "complete" });
  });
});
