import { describe, expect, it } from "vitest";
import { createTrajectoryDelta } from "@springbrand/eval-harness";
import {
  describeTrajectoryRecord,
  parseTrajectoryRecord,
  readArchivedFinalReply,
  readNativeFinalReply,
  readNativeRecordDetail,
  storedTrajectoryFormat,
  trajectoryRecordIdentity,
  openNativeExecution,
  nativeExecutionMembers,
  openTrajectory,
  readNativeTrajectoryPage,
} from "./index.js";

const resource = { agentId: "root", sessionId: "chat" };
const message = (text: string, stopReason = "stop") => ({
  role: "assistant", content: [{ type: "text", text }], provider: "openrouter", api: "openai-completions",
  model: "model", stopReason, timestamp: 10,
  usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const native = <Value extends object>(type: string, value: Value, metadata: object = {}) => ({
  format: "pi-trajectory/v1", resource, submissionId: "submission",
  projection: { kind: "safe", policyId: "fixture", policyVersion: 1 }, ...metadata, record: { type, value },
});
const entry = (id: number, kind: string, fields: object = {}, metadata: object = {}) =>
  native("entry", { id, conversationId: 1, kind, ...fields }, metadata);
const bookkeeping = (id: number, data: object, fields: object = {}, metadata: object = {}) =>
  entry(id, "springbrand.trajectory", { data, ...fields }, metadata);
const request = (id: number, requestId: string, fields: object = {}, metadata: object = {}) => bookkeeping(id, {
  type: "request", requestId, taskId: 20, cutoff: 2, attempt: 1, purpose: "generation",
  method: "streamSimple", inputs: [], dispatched: true, startedAt: 10,
  model: { provider: "openrouter", modelId: "model", api: "openai-completions" },
}, fields, metadata);

function trajectory() {
  return [
    native("conversation", { id: 1 }),
    entry(2, "pi.user", { model: [{ role: "user", content: "Original task", timestamp: 0 }] }),
    bookkeeping(3, { type: "host_turn", phase: "admitted", requestId: "host", submissionId: "submission", recordedAt: 1 }),
    request(4, "request"),
    entry(5, "pi.assistant", { byTaskId: 20, model: [message("final answer")] }),
    bookkeeping(6, { type: "request_end", requestId: "request", taskId: 20, endedAt: 30, result: { type: "entry", entryId: 5 } }),
    bookkeeping(7, { type: "host_turn", phase: "terminal", status: "completed", submissionId: "submission", childRegistrationClosed: true, recordedAt: 40 }),
  ];
}

describe("public native trajectory seam", () => {
  it.each([
    { decision: "allow_once", status: "approved" },
    { decision: "deny", status: "rejected", reason: "User declined" },
  ])("reads native $decision approval as unchanged evidence, never a model invocation or reply", async (decision) => {
    const data = {
      type: "approval_decision", submissionId: "submission", requestId: "request",
      executionId: "approval-execution", toolCallId: "call", toolName: "action_send",
      decidedAt: 35, recordedAt: 35, ...decision,
    };
    const approval = bookkeeping(7, data);
    const records = [...trajectory().slice(0, -1), approval, bookkeeping(8, {
      type: "host_turn", phase: "terminal", status: "completed", submissionId: "submission",
      childRegistrationClosed: true, recordedAt: 40,
    })];
    const bytes = JSON.stringify(records);
    const parsed = parseTrajectoryRecord(approval);
    const page = readNativeTrajectoryPage({
      format: "pi-trajectory/v1", events: records.map((event, index) => ({ ingestSeq: index + 1, event })),
      beforeSeq: null, hasOlder: false,
    });
    expect(page.events.at(-2)?.event).toEqual(parsed);
    // The Host request ID may equal a Models request ID; it must not trigger request inspection.
    await expect(readNativeRecordDetail(records, parsed)).resolves.toEqual({ approval: data });
    expect(describeTrajectoryRecord(parsed)).toMatchObject({
      category: "approval", type: "approval_decision", occurredAt: 35, models: [], tools: [],
    });
    await expect(readNativeFinalReply(records, { resource, submissionId: "submission" })).resolves.toBe("final answer");
    await expect(readNativeFinalReply([native("conversation", { id: 1 }), approval], {
      resource, submissionId: "submission",
    })).resolves.toBeUndefined();
    expect(JSON.stringify(records)).toBe(bytes);
  });

  it("requires valid, non-repeated execution scopes before interpreting native records", async () => {
    for (const scopes of [[], [{ resource: {}, submissionId: "submission" }], [
      { resource, submissionId: "submission" }, { resource, submissionId: "submission" },
    ]]) await expect(openNativeExecution(trajectory(), scopes as { resource: typeof resource; submissionId: string }[])).rejects.toThrow();
  });

  it("does not fall back to an earlier reply after an unsealed final preparation", async () => {
    const records = [
      ...trajectory().slice(0, -1),
      bookkeeping(8, { type: "request_start", requestId: "preflight", taskId: 30, cutoff: 5, attempt: 1,
        startedAt: 50, binding: { method: "streamSimple", model: { provider: "openrouter", modelId: "model" } } }),
      bookkeeping(9, { type: "request_end", requestId: "preflight", taskId: 30, endedAt: 55,
        result: { type: "interrupted", outcome: "not_dispatched" } }),
      bookkeeping(10, { type: "host_turn", phase: "terminal", status: "completed", submissionId: "submission",
        childRegistrationClosed: true, recordedAt: 60 }),
    ];
    await expect(readNativeFinalReply(records, { resource, submissionId: "submission" })).resolves.toBeUndefined();
  });

  it.each(["prepared", "inline", "error", "interrupted"])("keeps the primary reply after a later unbound %s call", async (outcome) => {
    const preparation = bookkeeping(8, { type: "request_start", requestId: "auxiliary", taskId: 20, cutoff: null,
      attempt: 1, startedAt: 50, binding: { method: "completeSimple", model: { provider: "openrouter", modelId: "model" } } });
    const invocation = bookkeeping(9, { type: "request", requestId: "auxiliary", taskId: 20, cutoff: null,
      attempt: 1, purpose: "generation", method: "completeSimple", inputs: [], dispatched: true, startedAt: 50,
      model: { provider: "openrouter", modelId: "model", api: "openai-completions" } });
    const result = outcome === "inline" ? { type: "response", message: message("Auxiliary must never win") }
      : outcome === "error" ? { type: "error", error: { message: "Auxiliary failed" } }
        : { type: "interrupted", outcome: "unknown" };
    const records = [
      ...trajectory().slice(0, -1), preparation,
      ...(outcome === "prepared" ? [] : [invocation, bookkeeping(10, {
        type: "request_end", requestId: "auxiliary", taskId: 20, endedAt: 55, result,
      })]),
      bookkeeping(11, { type: "host_turn", phase: "terminal", status: "completed", submissionId: "submission",
        childRegistrationClosed: true, recordedAt: 60 }),
    ];
    const bytes = JSON.stringify(records);
    await expect(readNativeFinalReply(records.toReversed(), { resource, submissionId: "submission" })).resolves.toBe("final answer");
    expect(JSON.stringify(records)).toBe(bytes);
  });

  it("never promotes an unbound inline response without a visible root primary response", async () => {
    const records = [
      ...trajectory().slice(0, 3),
      bookkeeping(8, { type: "request", requestId: "auxiliary", taskId: 20, cutoff: null, attempt: 1,
        purpose: "generation", method: "completeSimple", inputs: [], dispatched: true, startedAt: 50,
        model: { provider: "openrouter", modelId: "model", api: "openai-completions" } }),
      bookkeeping(9, { type: "request_end", requestId: "auxiliary", taskId: 20, endedAt: 55,
        result: { type: "response", message: message("Not a canonical root reply") } }),
      bookkeeping(10, { type: "host_turn", phase: "terminal", status: "completed", submissionId: "submission",
        childRegistrationClosed: true, recordedAt: 60 }),
    ];
    await expect(readNativeFinalReply(records, { resource, submissionId: "submission" })).resolves.toBeUndefined();
  });

  it("does not let an unbound tail hide a later failed primary generation", async () => {
    const records = [
      ...trajectory().slice(0, -1),
      bookkeeping(8, { type: "request", requestId: "failed-primary", taskId: 30, cutoff: 5, attempt: 1,
        purpose: "generation", method: "streamSimple", inputs: [], dispatched: true, startedAt: 50,
        model: { provider: "openrouter", modelId: "model", api: "openai-completions" } }),
      bookkeeping(9, { type: "request_end", requestId: "failed-primary", taskId: 30, endedAt: 55,
        result: { type: "error", error: { message: "Primary failed" } } }),
      bookkeeping(10, { type: "request", requestId: "auxiliary", taskId: 30, cutoff: null, attempt: 1,
        purpose: "generation", method: "completeSimple", inputs: [], dispatched: true, startedAt: 60,
        model: { provider: "openrouter", modelId: "model", api: "openai-completions" } }),
      bookkeeping(11, { type: "request_end", requestId: "auxiliary", taskId: 30, endedAt: 65,
        result: { type: "response", message: message("Still not the root reply") } }),
      bookkeeping(12, { type: "host_turn", phase: "terminal", status: "completed", submissionId: "submission",
        childRegistrationClosed: true, recordedAt: 70 }),
    ];
    await expect(readNativeFinalReply(records, { resource, submissionId: "submission" })).resolves.toBeUndefined();
  });
  it("uses typed response anchors and inverse hook deltas through the SDK", async () => {
    const hook = bookkeeping(6, { type: "hook", extension: "fixture", hook: "afterResponse", taskId: 20,
      requestId: "request", startedAt: 30, endedAt: 31,
      result: { type: "change", anchor: { type: "response", requestId: "request" }, direction: "inverse",
        delta: createTrajectoryDelta(message("final answer"), message("provider answer")) } });
    const records = [...trajectory().slice(0, 5), hook, bookkeeping(7, {
      type: "request_end", requestId: "request", taskId: 20, endedAt: 35, result: { type: "entry", entryId: 5 },
    })];
    await expect(readNativeRecordDetail(records, parseTrajectoryRecord(hook))).resolves.toMatchObject({
      before: message("provider answer"), after: message("final answer"), base: message("final answer"),
    });
  });

  it.each(["input", "hook"])("inspects a safe %s change without full before/after model-input snapshots", async (kind) => {
    const transforms = [{ type: "delta", delta: createTrajectoryDelta(
      [{ role: "user", content: "Original task", timestamp: 0 }],
      [{ role: "user", content: "Original task with request-only guidance", timestamp: 0 }],
    ) }];
    const change = kind === "input"
      ? { type: "input", requestId: "request", taskId: 20, source: "model-guidance", recordedAt: 2, transforms }
      : { type: "hook", requestId: "request", taskId: 20, extension: "fixture", hook: "beforeRequest",
        startedAt: 2, endedAt: 3, result: { type: "input", transforms } };
    const records = trajectory();
    records[2] = bookkeeping(3, change);
    records[3] = bookkeeping(4, { type: "request", requestId: "request", taskId: 20, cutoff: 2, attempt: 1,
      purpose: "generation", method: "streamSimple", inputs: [3], dispatched: true, startedAt: 10,
      model: { provider: "openrouter", modelId: "model", api: "openai-completions" } });
    const bytes = JSON.stringify(records);
    const target = parseTrajectoryRecord(records[2]);
    const detail = await readNativeRecordDetail(records, target);
    expect(detail).toEqual({ change });
    for (const field of ["inputs", "messages", "before", "after"]) expect(detail).not.toHaveProperty(field);
    await expect(readNativeRecordDetail(records, parseTrajectoryRecord(records[3]))).resolves.toMatchObject({
      canonicalContext: { messages: [{ role: "user", content: "Original task" }] },
      steps: [target],
    });
    expect(JSON.stringify(records)).toBe(bytes);
  });

  it("retains a hook decision and extension identity without inventing a request input", async () => {
    const data = { type: "hook", extension: "guard", hook: "beforeTool", taskId: 20, startedAt: 2, endedAt: 3,
      subject: { toolCallId: "call" }, result: { type: "decision", value: { approved: true } } };
    const records = [...trajectory(), bookkeeping(8, data)];
    await expect(readNativeRecordDetail(records, parseTrajectoryRecord(records.at(-1)))).resolves.toEqual({ hook: data });
  });

  it.each([false, true])("keeps unbound preparation context null with later canonical messages (invoked=%s)", async (invoked) => {
    const preparation = bookkeeping(8, { type: "request_start", requestId: "auxiliary", taskId: 20, cutoff: null,
      attempt: 1, startedAt: 50, binding: { method: "completeSimple", model: { provider: "openrouter", modelId: "model" } } });
    const invocation = bookkeeping(9, { type: "request", requestId: "auxiliary", taskId: 20, cutoff: null,
      attempt: 1, purpose: "generation", method: "completeSimple", inputs: [], dispatched: true, startedAt: 50,
      model: { provider: "openrouter", modelId: "model", api: "openai-completions" },
      options: { maxTokens: 32 } });
    const end = bookkeeping(10, { type: "request_end", requestId: "auxiliary", taskId: 20, endedAt: 52,
      result: { type: "response", message: message("Auxiliary inline result") } });
    const later = entry(11, "pi.user", { model: [{ role: "user", content: "Later canonical message", timestamp: 60 }] });
    const records = [...trajectory(), preparation, ...(invoked ? [invocation, end] : []), later];
    const bytes = JSON.stringify(records);
    const parsedLater = parseTrajectoryRecord(later);
    if (parsedLater.record.type !== "entry") throw new Error("Expected a native entry");
    const reader = await openTrajectory(records.map(parseTrajectoryRecord));
    try {
      expect((await reader.context({ resource, conversationId: parsedLater.record.value.conversationId })).messages)
        .toContainEqual({ role: "user", content: "Later canonical message", timestamp: 60 });
    } finally {
      await reader.close();
    }
    for (const target of invoked ? [preparation, invocation, end] : [preparation]) {
      const detail = await readNativeRecordDetail(records, parseTrajectoryRecord(target));
      expect(detail).toMatchObject({ canonicalContext: null });
      expect(detail).toMatchObject(invoked
        ? { request: { cutoff: null, options: { maxTokens: 32 } }, response: message("Auxiliary inline result"), steps: [] }
        : { preparation: { requestId: "auxiliary", cutoff: null } });
      for (const field of ["inputs", "messages", "before", "after"]) expect(detail).not.toHaveProperty(field);
    }
    expect(JSON.stringify(records)).toBe(bytes);
  });

  it("inspects compaction metadata, measured usage and summary without an exact-input recipe", async () => {
    const compact = bookkeeping(4, { type: "request", requestId: "compact", taskId: 20, cutoff: 2, attempt: 1,
      purpose: "compaction", method: "completeSimple", compaction: { firstKept: 2, reason: "manual", instructions: "Summarize." },
      inputs: [], dispatched: true, startedAt: 2, options: { maxTokens: 256 },
      model: { provider: "openrouter", modelId: "model", api: "openai-completions", definition: { name: "Summary model" } } });
    const summary = message("Native summary.");
    const end = bookkeeping(5, { type: "request_end", requestId: "compact", taskId: 20, endedAt: 20,
      result: { type: "response", message: summary } });
    const records = [...trajectory().slice(0, 2), compact, end];
    const bytes = JSON.stringify(records);
    const detail = await readNativeRecordDetail(records, parseTrajectoryRecord(compact));
    expect(detail).toMatchObject({
      request: { purpose: "compaction", method: "completeSimple", options: { maxTokens: 256 },
        compaction: { firstKept: 2, reason: "manual" }, model: { definition: { name: "Summary model" } } },
      canonicalContext: { messages: [{ role: "user", content: "Original task" }] },
      steps: [],
      end: { result: { type: "response", message: summary } },
      response: summary,
    });
    for (const field of ["inputs", "messages", "before", "after"]) expect(detail).not.toHaveProperty(field);
    expect(JSON.stringify(records)).toBe(bytes);
  });

  it("inspects canonical conversation and request parameters without claiming replayed model inputs", async () => {
    const records = trajectory();
    const parameters = {
      type: "request", requestId: "request", taskId: 20, cutoff: 2, attempt: 1, purpose: "generation",
      method: "streamSimple", inputs: [], dispatched: true, startedAt: 10,
      model: { provider: "openrouter", modelId: "model", api: "openai-completions",
        definition: { name: "Model definition", contextWindow: 128_000, maxTokens: 4096 } },
      options: { maxTokens: 512, temperature: 0.2, reasoning: "high", samplingParams: { top_p: 0.9 } },
    };
    records[3] = bookkeeping(4, parameters);
    const bytes = JSON.stringify(records);
    const target = parseTrajectoryRecord(records[3]);
    const detail = await readNativeRecordDetail(records, target);
    expect(detail).toMatchObject({
      request: parameters,
      canonicalContext: { messages: [{ role: "user", content: "Original task" }], entries: [{ id: 2 }] },
      steps: [],
      end: { result: { type: "entry", entryId: 5 } },
      response: message("final answer"),
    });
    for (const field of ["inputs", "messages", "before", "after"]) expect(detail).not.toHaveProperty(field);
    expect(JSON.stringify(records)).toBe(bytes);
    await expect(readNativeRecordDetail([target], target)).rejects.toThrow();
  });

  it("keeps native extensions and actor/type identity separate from receiving-store order", () => {
    const raw = entry(5, "future.entry", { future: { unchanged: [null, true] } });
    const parsed = parseTrajectoryRecord(raw);
    expect(parsed).toEqual(raw);
    expect(trajectoryRecordIdentity(parsed)).not.toBe(trajectoryRecordIdentity(parseTrajectoryRecord({
      ...raw, resource: { ...resource, agentId: "child" },
    })));
    expect(trajectoryRecordIdentity(parsed)).not.toBe(trajectoryRecordIdentity(parseTrajectoryRecord(native("conversation", { id: 5 }))));
    expect(trajectoryRecordIdentity(parsed)).toBe(trajectoryRecordIdentity(parseTrajectoryRecord({ ...raw, ingestSeq: 100 })));
    expect(storedTrajectoryFormat(undefined)).toBe("sp-trajectory/v1");
    expect(() => storedTrajectoryFormat("future-trajectory/v2")).toThrow(/format/i);
    expect(() => parseTrajectoryRecord({ type: "turn.finished" })).toThrow();
  });

  it("describes native requests, hooks and tool results without treating hooks as model requests", () => {
    expect(describeTrajectoryRecord(parseTrajectoryRecord(request(4, "r")))).toMatchObject({
      category: "generation", type: "request", models: ["model"], occurredAt: 10,
    });
    expect(describeTrajectoryRecord(parseTrajectoryRecord(request(4, "r", {}, { origin: "context", submissionId: null }))))
      .toMatchObject({ category: "context", type: "request" });
    const otherSubmission = parseTrajectoryRecord(bookkeeping(20, {
      type: "request", requestId: "r", taskId: 20, cutoff: 2, attempt: 1,
      purpose: "compaction", method: "completeSimple", compaction: { firstKept: 2, reason: "manual" },
      inputs: [], dispatched: true, startedAt: 10, model: { provider: "openrouter", modelId: "other-model", api: "openai-completions" },
    }, {}, { submissionId: "other-submission" }));
    const ended = parseTrajectoryRecord(bookkeeping(5, {
      type: "request_end", requestId: "r", taskId: 20, endedAt: 20, result: { type: "aborted" },
    }));
    expect(describeTrajectoryRecord(ended, [otherSubmission, parseTrajectoryRecord(request(4, "r"))]))
      .toMatchObject({ category: "generation", models: ["model"] });
    expect(describeTrajectoryRecord(parseTrajectoryRecord(bookkeeping(8, {
      type: "hook", hook: "beforeTool", extension: "extension", taskId: 20, startedAt: 11, endedAt: 12,
      subject: { toolCallId: "call" }, result: { type: "none" },
    })))).toMatchObject({ category: "other", type: "hook.beforeTool" });
    const tool = entry(9, "pi.toolResult", { model: [{
      role: "toolResult", toolCallId: "call", toolName: "write_file", content: [{ type: "text", text: "saved" }],
      isError: true, timestamp: 25, durationMs: 4,
    }] });
    expect(describeTrajectoryRecord(parseTrajectoryRecord(tool))).toMatchObject({
      category: "tool", tools: ["write_file"], failed: true, occurredAt: 25,
    });
  });

  it("selects only the completed root Submission's visible generation assistant", async () => {
    const records = trajectory();
    const child = records.map((record) => ({
      ...record, resource: { ...resource, agentId: "child" }, parent: { resource, submissionId: "submission" },
      record: record.record.type === "entry" && record.record.value.id === 5
        ? { ...record.record, value: { ...record.record.value, model: [message("child must not win")] } } : record.record,
    }));
    const fork = [
      native("conversation", { id: 11, parent: { conversationId: 1, at: 2 } }),
      request(12, "fork", { conversationId: 11 }),
      entry(13, "pi.assistant", { conversationId: 11, byTaskId: 20, model: [message("unselected branch")] }),
      bookkeeping(14, { type: "request_end", requestId: "fork", taskId: 20, endedAt: 50, result: { type: "entry", entryId: 13 } }, { conversationId: 11 }),
    ];
    const context = entry(15, "pi.assistant", { model: [message("imported history")] }, { submissionId: null, origin: "context" });
    await expect(readNativeFinalReply([...records, ...child, ...fork, context], { resource, submissionId: "submission" }))
      .resolves.toBe("final answer");
    await expect(readNativeFinalReply(records, { resource, submissionId: "another" })).resolves.toBeUndefined();
    await expect(readNativeFinalReply(records.slice(0, -1), { resource, submissionId: "submission" })).resolves.toBeUndefined();
  });

  it("does not substitute an earlier tool-use response or an aborted terminal for a final answer", async () => {
    const records = trajectory();
    records[4] = entry(5, "pi.assistant", { byTaskId: 20, model: [message("intermediate", "toolUse")] });
    await expect(readNativeFinalReply(records, { resource, submissionId: "submission" })).resolves.toBeUndefined();
    records[6] = bookkeeping(7, { type: "host_turn", phase: "terminal", status: "aborted", submissionId: "submission", childRegistrationClosed: true, recordedAt: 40 });
    await expect(readNativeFinalReply(records, { resource, submissionId: "submission" })).resolves.toBeUndefined();
  });

  it("keeps the immutable historical reply reader explicit", () => {
    const archive = [{ ingestSeq: 1, event: { type: "turn.finished", payload: {
      output: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "old reply" }] },
    } } }];
    expect(readArchivedFinalReply("sp-trajectory/v1", archive)).toBe("old reply");
    expect(() => readArchivedFinalReply("pi-trajectory/v1", archive)).toThrow(/historical/i);
  });

  it("never promotes a compaction response or falls back past a failed final generation", async () => {
    const records = trajectory().slice(0, -1);
    const terminal = bookkeeping(11, { type: "host_turn", phase: "terminal", status: "completed",
      submissionId: "submission", childRegistrationClosed: true, recordedAt: 100 });
    const compact = bookkeeping(8, { type: "request", requestId: "compact", taskId: 30, cutoff: 5, attempt: 1,
      purpose: "compaction", method: "completeSimple", inputs: [], dispatched: true, startedAt: 50,
      compaction: { firstKept: 2, reason: "manual" },
      model: { provider: "openrouter", modelId: "model", api: "openai-completions" } });
    const response = entry(9, "pi.assistant", { byTaskId: 30, model: [message("compaction must not win")] });
    const end = bookkeeping(10, { type: "request_end", requestId: "compact", taskId: 30, endedAt: 60,
      result: { type: "entry", entryId: 9 } });
    await expect(readNativeFinalReply([...records, compact, response, end, terminal], { resource, submissionId: "submission" }))
      .resolves.toBe("final answer");
    const failed = bookkeeping(8, { type: "request", requestId: "failed", taskId: 30, cutoff: 5, attempt: 1,
      purpose: "generation", method: "streamSimple", inputs: [], dispatched: true, startedAt: 50,
      model: { provider: "openrouter", modelId: "model", api: "openai-completions" } });
    const error = bookkeeping(10, { type: "request_end", requestId: "failed", taskId: 30, endedAt: 60,
      result: { type: "error", error: { message: "failed" } } });
    await expect(readNativeFinalReply([...records, failed, error, terminal], { resource, submissionId: "submission" }))
      .resolves.toBeUndefined();
  });

  it("uses exact execution membership, not original origin or parent presence, for historical dependencies", async () => {
    const old = trajectory().map((record) => ({
      ...record, submissionId: "old",
      record: record.record.type === "entry" && "data" in record.record.value &&
        (record.record.value.data as { type?: string }).type === "host_turn"
        ? { ...record.record, value: { ...record.record.value, data: { ...record.record.value.data as object, submissionId: "old" } } }
        : record.record,
    }));
    const current = [
      native("conversation", { id: 11, parent: { conversationId: 1, at: 7 } }),
      bookkeeping(12, { type: "host_turn", phase: "admitted", submissionId: "submission", requestId: "current-host", recordedAt: 50 }, { conversationId: 11 }),
      bookkeeping(13, { type: "request", requestId: "current", taskId: 20, cutoff: 7, attempt: 1,
        purpose: "generation", method: "streamSimple", inputs: [], dispatched: true, startedAt: 50,
        model: { provider: "openrouter", modelId: "model", api: "openai-completions" } }, { conversationId: 11 }),
      entry(14, "pi.assistant", { conversationId: 11, byTaskId: 20, model: [message("current root only")] }),
      bookkeeping(15, { type: "request_end", requestId: "current", taskId: 20, endedAt: 60, result: { type: "entry", entryId: 14 } }, { conversationId: 11 }),
      bookkeeping(16, { type: "host_turn", phase: "terminal", status: "completed", submissionId: "submission",
        childRegistrationClosed: true, recordedAt: 70 }, { conversationId: 11 }),
    ];
    const childResource = { agentId: "child", sessionId: "chat" };
    const child = [...old, ...current].map((record) => ({ ...record, resource: childResource,
      parent: { resource, submissionId: "submission" } }));
    const membership = { resource, submissionId: "submission", status: "delivered" as const,
      requiredClosed: true, pendingRecords: 0, children: [{
        resource: childResource, submissionId: "submission", status: "delivered" as const,
        requiredClosed: true, pendingRecords: 0, children: [],
      }] };
    const values = [...old, ...current, ...child].toReversed();
    const before = JSON.stringify(values);
    const view = await openNativeExecution(values, nativeExecutionMembers(membership));
    try {
      expect(view.complete).toBe(true);
      expect(new Set([...view.selected].map((identity) => JSON.parse(identity)))).toEqual(new Set([
        ["root", "chat", "entry", 12], ["root", "chat", "entry", 13], ["root", "chat", "entry", 14],
        ["root", "chat", "entry", 15], ["root", "chat", "entry", 16],
        ["child", "chat", "entry", 12], ["child", "chat", "entry", 13], ["child", "chat", "entry", 14],
        ["child", "chat", "entry", 15], ["child", "chat", "entry", 16],
      ]));
      const request = await view.reader.request({ resource, requestId: "current" });
      if (request.context === null) throw new Error("Expected the root generation's bound canonical context");
      expect(request.context.messages.at(-1)?.role).toBe("assistant");
      expect(request.context.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "final answer" }] });
      expect(request).not.toHaveProperty("messages");
    } finally { await view.close(); }
    await expect(readNativeFinalReply(values, { resource, submissionId: "submission" })).resolves.toBe("current root only");
    expect(JSON.stringify(values)).toBe(before);
  });

  it("refuses unsafe native input and never makes an interrupted final dispatch an earlier success", async () => {
    const records = trajectory();
    const { projection: _projection, ...unsafe } = records[0]!;
    await expect(readNativeFinalReply([unsafe, ...records.slice(1)], { resource, submissionId: "submission" }))
      .rejects.toThrow(/safe public projection/);
    const interrupted = [
      ...records.slice(0, -1), request(8, "interrupted"),
      bookkeeping(9, { type: "request_end", requestId: "interrupted", taskId: 20, endedAt: 60,
        result: { type: "interrupted", outcome: "unknown" } }),
      bookkeeping(10, { type: "host_turn", phase: "terminal", status: "completed", submissionId: "submission",
        childRegistrationClosed: true, recordedAt: 70 }),
    ];
    await expect(readNativeFinalReply(interrupted, { resource, submissionId: "submission" })).resolves.toBeUndefined();
  });
});
