import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, createModels, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  CompactionTask, GenerationTask, Harness, MemoryStorage, createRegistry, defineExtension, defineTask, defineTool, hook,
  type ConversationId, type EntryId, type TaskId,
} from "@earendil-works/pi-durable";
import {
  createTrajectoryEntry, createTrajectoryRecord, projectTrajectoryForExport, readTrajectoryBookkeeping,
  type NativeTrajectoryWrite, type TrajectoryBookkeepingData, type TrajectoryExportPolicy, type TrajectoryRecord,
} from "@springbrand/eval-harness";
import { jsonObjectArrayInPlaceSchema, type AgentResourceSnapshot, type AgentTrajectoryDeliveryState } from "@eval-platform/eval-contracts";
import { openNativeExecution, readNativeFinalReply, readNativeRecordDetail } from "@eval-platform/eval-runtime/harness";
import { compactResourceSnapshot } from "../index.js";
import { aggregateResources } from "./resources.js";
import { resourceInput } from "../test-support.js";

const context = BACKGROUND_CONTEXT;
const resource = { agentId: "real-pi", sessionId: "chat" };
const scope = { resource, submissionId: "current" };
const policy: TrajectoryExportPolicy = {
  id: "ep-real-pi", version: 1, actionTools: { names: [], prefixes: [] }, allowedDetailsPaths: [], secrets: "redact",
};

async function realPi(options: {
  fork?: boolean; laterPreparation?: boolean; truncateAnswer?: boolean; preMintSeal?: boolean; failedAfterAnswer?: boolean;
  auxiliary?: "afterResponse" | "afterTools" | "custom-task";
  auxiliaryPresentation?: boolean;
} = {}) {
  const storage = new MemoryStorage();
  const baseModels = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{
    id: "ep-faux", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 }, contextWindow: 100_000, maxTokens: 1024,
  }] });
  baseModels.setProvider(faux.provider);
  const model = faux.getModel();
  const raw: TrajectoryRecord[] = [];
  const seen: { submissionId: string; purpose: "generation" | "compaction"; taskId: TaskId;
    auxiliary?: boolean; message: AssistantMessage }[] = [];
  const dispatches = new Map<TaskId, string>();
  const ends: { conversationId: ConversationId; data: TrajectoryBookkeepingData }[] = [];
  let submissionId = "old";
  let clock = 1;
  let toolExecutions = 0;
  let compactionTask: TaskId | undefined;
  let harness: Harness;
  const entryId = (value: number) => {
    const record = raw.find((record) => record.record.type === "entry" && record.record.value.id === value);
    if (record?.record.type !== "entry") throw new Error(`Missing actual Pi entry ${value}`);
    return record.record.value.id;
  };
  const append = (conversationId: ConversationId, data: TrajectoryBookkeepingData, taskId?: TaskId) =>
    harness.commit((tx) => tx.appendEntry(conversationId, {
      ...createTrajectoryEntry(data), ...(taskId === undefined ? {} : { byTaskId: taskId }),
    }), context);
  const checkpoint = async (taskId: TaskId) => {
    const task = await harness.getTask(taskId, context);
    if (task?.state.status !== "running") throw new Error("Expected an actual running Pi task");
    const value = task.state.checkpoint;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a native checkpoint");
    return { task, value };
  };
  const invokeAuxiliary = async (api: { taskId: TaskId; conversationId: ConversationId; models: Models }) => {
    const requestId = `auxiliary-${clock++}`;
    const startedAt = clock++;
    await append(api.conversationId, { type: "request_start", requestId, taskId: api.taskId, cutoff: null,
      attempt: 1, startedAt, binding: { method: "streamSimple", model: { provider: model.provider, modelId: model.id } } }, api.taskId);
    await append(api.conversationId, { type: "request", requestId, taskId: api.taskId, cutoff: null,
      attempt: 1, purpose: "generation", method: "streamSimple", inputs: [], dispatched: true, startedAt,
      model: { provider: model.provider, modelId: model.id, api: model.api }, options: { maxTokens: 32 } }, api.taskId);
    // Real HookApi/TaskRuntime Models, without a cancellation signal or canonical input recipe.
    const response = await api.models.streamSimple(model, {
      messages: [{ role: "user", content: "Independent auxiliary input, not canonical conversation.", timestamp: clock++ }],
    }, { maxTokens: 32 }).result();
    seen.push({ submissionId, purpose: "generation", taskId: api.taskId, auxiliary: true, message: structuredClone(response) });
    await append(api.conversationId, { type: "request_end", requestId, taskId: api.taskId, endedAt: clock++,
      result: { type: "response", message: response } }, api.taskId);
    return response;
  };
  const customTask = defineTask<null, { phase: "invoke" }, string>({
    name: "ep-independent-models", version: 1, initial: () => ({ phase: "invoke" }),
    phases: { invoke: async (_task, runtime, callContext) => {
      const response = await invokeAuxiliary(runtime);
      await runtime.commit(async (tx) => {
        if (options.auxiliaryPresentation) await tx.appendEntry(runtime.conversationId, {
          kind: "ep.auxiliary-reply", model: [response],
        });
        return { status: "terminal", outcome: { status: "completed", result: "done" } };
      }, callContext);
    } },
    abort: async (_task, runtime, callContext) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext);
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({
    name: "ep-real-pi",
    tasks: [customTask],
    tools: [defineTool({
      name: "probe", description: "Execute the deterministic verification probe.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        toolExecutions += 1;
        return { content: [{ type: "text", text: "probe really executed" }] };
      },
    })],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api) => {
          const { value } = await checkpoint(api.taskId);
          if (value.phase !== "request" || typeof value.cutoff !== "number" || typeof value.attempt !== "number") {
            throw new Error("Expected Pi's generation request checkpoint");
          }
          const requestId = `generation-${clock++}`;
          const startedAt = clock++;
          dispatches.set(api.taskId, requestId);
          const cutoff = entryId(value.cutoff);
          await append(api.conversationId, { type: "request_start", requestId, taskId: api.taskId, cutoff,
            attempt: value.attempt, startedAt, binding: { method: "streamSimple", model: { provider: model.provider, modelId: model.id } } }, api.taskId);
          await append(api.conversationId, { type: "hook", requestId, taskId: api.taskId, hook: "beforeRequest",
            extension: "ep-real-pi", startedAt: clock++, endedAt: clock++, result: { type: "none" } }, api.taskId);
          await append(api.conversationId, { type: "request", requestId, taskId: api.taskId, cutoff,
            attempt: value.attempt, purpose: "generation", method: "streamSimple", inputs: [], dispatched: true,
            startedAt, model: { provider: model.provider, modelId: model.id, api: model.api } }, api.taskId);
        },
        afterResponse: async (message, api) => {
          seen.push({ submissionId, purpose: "generation", taskId: api.taskId, message: structuredClone(message) });
          if (submissionId === scope.submissionId && options.auxiliary === "afterResponse" && message.stopReason === "stop") {
            await invokeAuxiliary(api);
          }
        },
        afterTools: async (_assistant, _results, api) => {
          if (submissionId === scope.submissionId && options.auxiliary === "afterTools") await invokeAuxiliary(api);
        },
      }),
      hook(CompactionTask, { beforeCompact: (_selection, api) => { compactionTask = api.taskId; } }),
    ],
  }));
  const models: Models = new Proxy(baseModels, {
    get(target, key) {
      if (key !== "completeSimple") {
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (async (requestModel, input, options) => {
        if (compactionTask === undefined) throw new Error("Expected a real compaction task");
        const { task, value } = await checkpoint(compactionTask);
        if (value.phase !== "summarize" || typeof value.tail !== "number" || typeof value.firstKept !== "number") {
          throw new Error("Expected Pi's compaction summarize checkpoint");
        }
        const cutoff = entryId(value.tail);
        const requestId = `compaction-${clock++}`;
        await append(task.conversationId, { type: "request", requestId, taskId: task.id, cutoff, attempt: 1,
          purpose: "compaction", method: "completeSimple", inputs: [], dispatched: true, startedAt: clock++,
          compaction: { firstKept: entryId(value.firstKept), reason: "manual" },
          model: { provider: requestModel.provider, modelId: requestModel.id, api: requestModel.api } }, task.id);
        const response = await target.completeSimple(requestModel, input, options);
        seen.push({ submissionId, purpose: "compaction", taskId: task.id, message: structuredClone(response) });
        await append(task.conversationId, { type: "request_end", requestId, taskId: task.id,
          endedAt: clock++, result: { type: "response", message: response } }, task.id);
        return response;
      }) satisfies Models["completeSimple"];
    },
  });
  harness = await Harness.open(storage, {
    models, registry, settings: { compaction: {
      enabled: false, keepRecentTokens: options.failedAfterAnswer ? 32 : 1, reserveTokens: 256,
    }, retry: { enabled: false } },
  }, context);
  harness.subscribeCommits(({ changes }) => {
    for (const change of changes) {
      if (change.type !== "conversation" && change.type !== "entry") continue;
      raw.push(createTrajectoryRecord({ resource, submissionId }, change));
      if (change.type !== "entry" || change.value.byTaskId === undefined ||
        !change.value.model?.some((message) => message.role === "assistant")) continue;
      const requestId = dispatches.get(change.value.byTaskId);
      if (requestId) ends.push({ conversationId: change.value.conversationId, data: {
        type: "request_end", requestId, taskId: change.value.byTaskId, endedAt: clock++,
        result: { type: "entry", entryId: change.value.id },
      } });
    }
  });
  const flush = async () => {
    for (const end of ends.splice(0)) await append(end.conversationId, end.data);
  };
  try {
    const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
    const submit = async (text: string, target = conversation) => {
      const input = await target.submit({ type: "input", content: text }, context);
      await input.wait(context);
      await target.waitForIdle(context);
      await flush();
    };
    faux.setResponses([fauxAssistantMessage("Old scope answer")]);
    await submit("Old scope prompt");
    submissionId = scope.submissionId;
    const sealId = options.preMintSeal ? await storage.mintId<EntryId>() : undefined;
    await append(conversation.id, { type: "host_turn", phase: "admitted", submissionId, requestId: "host", recordedAt: clock++ });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("probe", {}, { id: "actual-probe" }), { stopReason: "toolUse" }),
      ...(options.auxiliary === "afterTools" ? [fauxAssistantMessage("Auxiliary afterTools response must not become the root reply.")] : []),
      fauxAssistantMessage("The canonical final answer survives compaction."),
      ...(options.auxiliary === "afterResponse" ? [fauxAssistantMessage("Auxiliary afterResponse response must not become the root reply.")] : []),
    ]);
    await submit("Use the probe, then answer.");
    if (options.auxiliary === "custom-task") {
      faux.setResponses([fauxAssistantMessage("Independent custom task response must not become the root reply.")]);
      const taskId = await conversation.commit((tx) => tx.createTask(customTask, null, { ownership: { kind: "conversation" } }), context);
      expect((await harness.waitForTask(taskId, context)).state.outcome).toEqual({ status: "completed", result: "done" });
      await conversation.waitForIdle(context);
    }
    const answer = raw.findLast((record) => record.record.type === "entry" && record.record.value.model?.some(
      (message) => message.role === "assistant" && message.stopReason === "stop"));
    if (answer?.record.type !== "entry") throw new Error("Expected actual generation answer");
    if (options.fork) {
      const fork = await conversation.fork(answer.record.value.id, { ownership: { kind: "ownerless" } }, context);
      faux.setResponses([fauxAssistantMessage("Executed off-branch; never the root final answer.")]);
      await submit("Execute this fork too.", fork);
    }
    if (options.failedAfterAnswer) {
      faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Actual faux failure" })]);
      await submit("This real invocation fails.");
      expect(runGenerationResponses().at(-1)?.message.stopReason).toBe("error");
    }
    if (options.laterPreparation) {
      const request = raw.findLast((record) => record.record.type === "entry" && readTrajectoryBookkeeping(record.record.value)?.type === "request");
      const data = request?.record.type === "entry" ? readTrajectoryBookkeeping(request.record.value) : undefined;
      const taskId = data?.type === "request" ? data.taskId : undefined;
      if (taskId === undefined) throw new Error("Missing actual generation task");
      await append(conversation.id, { type: "request_start", requestId: "later-unsealed", taskId,
        cutoff: answer.record.value.id, attempt: 2, startedAt: clock++,
        binding: { method: "streamSimple", model: { provider: model.provider, modelId: model.id } } }, taskId);
    }
    const prefix = structuredClone(raw);
    let firstKept = answer.record.value.id;
    if (options.truncateAnswer) firstKept = (await conversation.commit((tx) => tx.appendEntry(conversation.id, {
      kind: "pi.user", model: [{ role: "user", content: "Keep this recent passive entry.", timestamp: clock++ }],
    }), context)).id;
    faux.setResponses([fauxAssistantMessage("The real Pi summary.")]);
    const compact = await conversation.compact("Summarize the old prefix.", context);
    expect((await harness.waitForTask(compact, context)).state.outcome).toEqual(expect.objectContaining({ status: "completed" }));
    await conversation.waitForIdle(context);
    const terminal: TrajectoryBookkeepingData = { type: "host_turn", phase: "terminal", submissionId, status: "completed",
      childRegistrationClosed: true, recordedAt: clock++ };
    if (sealId === undefined) await append(conversation.id, terminal);
    else {
      const write: NativeTrajectoryWrite = { type: "entry", value: {
        ...createTrajectoryEntry(terminal), id: sealId, conversationId: conversation.id,
      } };
      await storage.commit([write], context);
      raw.push(createTrajectoryRecord({ resource, submissionId }, write));
    }
    const actualContext = await conversation.context(context);
    expect(actualContext.head?.kind).toBe("pi.compaction");
    if (options.failedAfterAnswer) expect(actualContext.entries.some((entry) => entry.id === answer.record.value.id)).toBe(true);
    else expect(actualContext.head?.head).toBe(firstKept);
    expect(faux.state.callCount).toBe(seen.length);
    return {
      prefix: await projectTrajectoryForExport(prefix, policy),
      records: await projectTrajectoryForExport(raw, policy), actualContext, seen, toolExecutions,
    };
  } finally { await harness.close(context); }

  function runGenerationResponses() {
    return seen.filter((call) => call.submissionId === scope.submissionId && call.purpose === "generation");
  }
}

function snapshot(records: readonly TrajectoryRecord[], finalized = true): AgentResourceSnapshot {
  const trajectory: AgentTrajectoryDeliveryState = { ...scope, status: finalized ? "delivered" : "pending", requiredClosed: finalized,
    pendingRecords: 0, children: [] };
  return {
    scope: { chatId: resource.sessionId, submissionId: scope.submissionId, idempotencyKey: "key" },
    observedAt: "2026-10-22T00:00:00Z", finalized, trajectoryFormat: "pi-trajectory/v1",
    coverage: { usageEvents: finalized ? "complete" : "partial", telemetryEvents: finalized ? "complete" : "partial",
      billingSettlements: finalized ? "complete" : "partial" },
    usageEvents: [], billingSettlements: [], telemetryEvents: jsonObjectArrayInPlaceSchema.parse(records),
    readiness: { receiptTerminal: finalized, stateUnreadable: false, pendingTelemetryEvents: 0, pendingRuntimeEvents: 0,
      trajectory: { ...trajectory, status: finalized ? "delivered" : "pending" },
      runtimeBusiness: { actor: { resource, path: [] }, submissionId: scope.submissionId,
        status: finalized ? "delivered" : "pending", pendingRuntimeEvents: 0, quarantinedRuntimeEvents: 0, children: [] },
      actionCharges: { complete: finalized, unsettledExecutions: 0, missingExecutionIds: 0 } },
  };
}

async function statistics(records: readonly TrajectoryRecord[], finalized = true) {
  return aggregateResources([resourceInput(await compactResourceSnapshot(snapshot(records, finalized)))]);
}

describe("real Pi compaction at the EP public consumer seam", () => {
  it("counts an auxiliary invocation once when its actual reply also enters canonical presentation", async () => {
    const run = await realPi({ auxiliary: "custom-task", auxiliaryPresentation: true });
    const actual = run.seen.filter((call) => call.submissionId === scope.submissionId);
    const independent = actual.filter((call) => call.auxiliary);
    expect(independent).toHaveLength(1);
    expect(run.records.some((record) => record.record.type === "entry" &&
      record.record.value.kind === "ep.auxiliary-reply")).toBe(true);
    const bytes = JSON.stringify(run.records);
    const result = await statistics(run.records);
    expect(result.modelRequests.count).toEqual({ value: 3, coverage: "complete" });
    expect(result.trajectory.modelInvocations.count).toEqual({ value: actual.length, coverage: "complete" });
    expect(result.tokens.total).toEqual({
      value: actual.reduce((sum, call) => sum + call.message.usage.totalTokens, 0), coverage: "complete",
    });
    expect(result.costs.providerUsd.coverage).toBe("complete");
    await expect(readNativeFinalReply(run.records, scope)).resolves.toBeUndefined();
    expect(JSON.stringify(run.records)).toBe(bytes);
  });

  it.each(["afterResponse", "afterTools", "custom-task"] as const)(
    "counts real unbound %s invocations and measured usage without replacing the primary reply", async (auxiliary) => {
      const run = await realPi({ auxiliary });
      const bytes = JSON.stringify(run.records);
      const actual = run.seen.filter((call) => call.submissionId === scope.submissionId);
      const generations = actual.filter((call) => call.purpose === "generation");
      const independent = generations.filter((call) => call.auxiliary);
      expect(independent).toHaveLength(1);
      expect(independent[0]!.message.usage.totalTokens).toBeGreaterThan(0);
      // Faux reports zero USD even with priced model definitions; never infer a charge from those rates.
      expect(independent[0]!.message.usage.cost.total).toBe(0);
      expect(generations).toHaveLength(3);
      const request = run.records.find((record) => {
        const data = record.record.type === "entry" ? readTrajectoryBookkeeping(record.record.value) : undefined;
        return data?.type === "request" && data.cutoff === null;
      });
      if (!request) throw new Error("Expected actual auxiliary invocation");
      const detail = await readNativeRecordDetail(run.records, request);
      expect(detail).toMatchObject({ request: { cutoff: null, taskId: independent[0]!.taskId },
        canonicalContext: null, steps: [], end: { result: { type: "response" } }, response: independent[0]!.message });
      for (const field of ["inputs", "messages", "before", "after"]) expect(detail).not.toHaveProperty(field);
      const result = await statistics(run.records);
      expect(result.modelRequests.count).toEqual({ value: generations.length, coverage: "complete" });
      expect(result.modelRequests.completed).toBe(generations.length);
      expect(result.trajectory.modelInvocations.count).toEqual({ value: actual.length, coverage: "complete" });
      expect(result.trajectory.generationTasks).toEqual({ value: new Set(generations.map((call) => call.taskId)).size, coverage: "complete" });
      expect(result.trajectory.compactions.count).toEqual({ value: 1, coverage: "complete" });
      expect(result.trajectory.tools.count).toEqual({ value: run.toolExecutions, coverage: "complete" });
      expect(result.tokens.total).toEqual({ value: actual.reduce((sum, call) => sum + call.message.usage.totalTokens, 0), coverage: "complete" });
      expect(result.costs.providerUsd.coverage).toBe("complete");
      expect(result.costs.providerUsd.value).toBeCloseTo(actual.reduce((sum, call) => sum + call.message.usage.cost.total, 0), 12);
      await expect(readNativeFinalReply(run.records.toReversed(), scope)).resolves.toBe("The canonical final answer survives compaction.");
      expect(JSON.stringify(run.records)).toBe(bytes);
    },
  );

  it("counts all same-execution work and actual compaction without any compaction input recipe", async () => {
    const run = await realPi({ truncateAnswer: true });
    expect(run.toolExecutions).toBe(1);
    expect(run.seen.filter((call) => call.submissionId === scope.submissionId && call.purpose === "generation")).toHaveLength(2);
    expect(run.records.some((record) => {
      const data = record.record.type === "entry" ? readTrajectoryBookkeeping(record.record.value) : undefined;
      return data?.type === "input";
    })).toBe(false);
    const compact = run.records.find((record) => {
      const data = record.record.type === "entry" ? readTrajectoryBookkeeping(record.record.value) : undefined;
      return data?.type === "request" && data.purpose === "compaction";
    });
    if (!compact) throw new Error("Expected the observed real compaction request");
    const detail = await readNativeRecordDetail(run.records, compact);
    expect(detail).toMatchObject({
      request: { purpose: "compaction", method: "completeSimple", inputs: [] },
      steps: [],
      response: run.seen.find((call) => call.purpose === "compaction")!.message,
    });
    for (const field of ["inputs", "messages", "before", "after"]) expect(detail).not.toHaveProperty(field);
    const result = await statistics(run.records);
    const actual = run.seen.filter((invocation) => invocation.submissionId === scope.submissionId);
    expect.soft(result.modelRequests.count, JSON.stringify(result.diagnostics)).toEqual({
      value: actual.filter((call) => call.purpose === "generation").length, coverage: "complete",
    });
    expect.soft(result.trajectory.compactions.count).toEqual({ value: 1, coverage: "complete" });
    expect.soft(result.trajectory.tools.count).toEqual({ value: run.toolExecutions, coverage: "complete" });
    expect.soft(result.tokens.total).toEqual({ value: actual.reduce((sum, call) => sum + call.message.usage.totalTokens, 0), coverage: "complete" });
    expect.soft(result.costs.providerUsd.coverage).toBe("complete");
    expect.soft(result.costs.providerUsd.value).toBeCloseTo(actual.reduce((sum, call) => sum + call.message.usage.cost.total, 0));
    const prefix = await statistics(run.prefix, false);
    expect.soft(prefix.modelRequests.count).toEqual({ value: 2, coverage: "partial" });
    expect.soft(prefix.trajectory.tools.count).toEqual({ value: run.toolExecutions, coverage: "partial" });
  });

  it("selects the canonical final assistant even when real compaction hid its request metadata", async () => {
    const run = await realPi();
    expect(run.actualContext.entries.some((entry) => {
      const data = readTrajectoryBookkeeping(entry);
      return data?.type === "request" && data.purpose === "generation";
    })).toBe(false);
    await expect(readNativeFinalReply(run.records, scope)).resolves.toBe("The canonical final answer survives compaction.");
  });

  it("keeps observed work in an unsealed live prefix without claiming complete coverage", async () => {
    const run = await realPi();
    const view = await openNativeExecution(run.prefix, [scope]);
    try {
      expect(view.complete).toBe(false);
      expect(view.selected.size).toBeGreaterThan(0);
    } finally { await view.close(); }
    const result = await statistics(run.prefix, false);
    expect(result.modelRequests.count).toEqual({ value: 2, coverage: "partial" });
    expect(result.tokens.total).toEqual({ value: run.seen.filter((call) => call.submissionId === scope.submissionId &&
      call.purpose === "generation").reduce((sum, call) => sum + call.message.usage.totalTokens, 0), coverage: "partial" });
  });

  it("counts an actually executed off-branch conversation, but never selects its final reply", async () => {
    const run = await realPi({ fork: true });
    const result = await statistics(run.records);
    expect(run.seen.filter((call) => call.submissionId === scope.submissionId && call.purpose === "generation")).toHaveLength(3);
    expect(result.modelRequests.count).toEqual({ value: 3, coverage: "complete" });
    await expect(readNativeFinalReply(run.records, scope)).resolves.toBe("The canonical final answer survives compaction.");
  });

  it("does not fall back across a later preparation after compaction", async () => {
    const run = await realPi({ laterPreparation: true });
    await expect(readNativeFinalReply(run.records, scope)).resolves.toBeUndefined();
  });

  it("does not use a pre-minted seal's numeric ID as an accounting cutoff", async () => {
    const run = await realPi({ preMintSeal: true });
    const result = await statistics(run.records);
    expect(result.modelRequests.count).toEqual({ value: 2, coverage: "complete" });
    expect(result.trajectory.compactions.count).toEqual({ value: 1, coverage: "complete" });
    expect(result.trajectory.tools.count).toEqual({ value: run.toolExecutions, coverage: "complete" });
    expect(result.tokens.total).toEqual({ value: run.seen.filter((call) => call.submissionId === scope.submissionId)
      .reduce((sum, call) => sum + call.message.usage.totalTokens, 0), coverage: "complete" });
  });

  it("does not fall back across a real failed invocation followed by compaction", async () => {
    const run = await realPi({ failedAfterAnswer: true });
    await expect(readNativeFinalReply(run.records, scope)).resolves.toBeUndefined();
  });
});
