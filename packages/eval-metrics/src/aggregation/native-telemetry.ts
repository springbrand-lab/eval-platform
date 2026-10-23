import { jsonObjectInPlaceSchema } from "@eval-platform/eval-contracts";
import { identity, type FactEntry, type FactStream, type ResourceDiagnostics } from "./resource-facts.js";
import type { NativeAssistantMetric, NativeMetricRecord } from "./native-facts.js";
import type { ObservedOperation } from "./resource-telemetry.js";

type NativeEntry = FactEntry & { readonly native: NativeMetricRecord };
const scopeKey = (source: Pick<NativeMetricRecord, "resource" | "submissionId">) =>
  identity(source.resource.agentId, source.resource.sessionId, source.submissionId);
const turnKey = (source: Pick<NativeMetricRecord, "resource" | "submissionId">) => identity("native-turn", scopeKey(source));
const entryKey = (source: NativeMetricRecord, id: number) =>
  identity(source.resource.agentId, source.resource.sessionId, "entry", String(id));
const toolKey = (source: Pick<NativeMetricRecord, "resource" | "submissionId" | "conversationId">, id: string) =>
  identity("native-tool", scopeKey(source), String(source.conversationId ?? ""), id);

export function inspectNativeTelemetry(entries: readonly FactEntry[], diagnostics: ResourceDiagnostics): {
  readonly operations: readonly ObservedOperation[];
  readonly usage: FactStream;
  readonly complete: boolean;
} {
  const native = entries.filter((entry): entry is NativeEntry => entry.native !== undefined
    && entry.native.selected && entry.native.submissionId !== null);
  const byId = new Map(native.map((entry) => [entryKey(entry.native, entry.native.id), entry]));
  const operations: ObservedOperation[] = [];
  const usage: FactEntry[] = [];
  let complete = true;
  let usageComplete = true;
  const problem = (entry: FactEntry, message: string) => {
    complete = false;
    diagnostics.report("conflicting-identity", "telemetryEvents", entry, message);
  };
  const empty = (kind: ObservedOperation["kind"], key: string, first: FactEntry): ObservedOperation => ({
    kind, key, first, start: undefined, terminal: undefined, status: first.canEmitTelemetry ? "inProgress" : "unknown",
    duration: null, toolName: null, parentKey: null, hasThinking: false, hasContent: false,
    thinkingKnown: false, contentKnown: false, consistent: true,
  });
  const groups = <T>(items: readonly T[], key: (item: T) => string) => {
    const result = new Map<string, T[]>();
    for (const item of items) result.set(key(item), [...result.get(key(item)) ?? [], item]);
    return result;
  };
  const turns = groups(native.filter((entry) => entry.native.bookkeeping?.type === "host_turn"), (entry) => turnKey(entry.native));
  for (const [key, facts] of turns) {
    const starts = facts.filter((entry) => entry.native.bookkeeping?.type === "host_turn" && entry.native.bookkeeping.phase === "admitted");
    const terminals = facts.filter((entry) => entry.native.bookkeeping?.type === "host_turn" && entry.native.bookkeeping.phase === "terminal");
    const start = starts[0];
    const terminal = terminals[0];
    const end = terminal?.native.bookkeeping;
    const begin = start?.native.bookkeeping;
    const consistent = starts.length <= 1 && terminals.length <= 1;
    if (!consistent) problem(facts[0]!, "A native Host Turn has contradictory admissions or terminals");
    let duration: number | null = null;
    if (begin?.type === "host_turn" && end?.type === "host_turn") {
      if (end.recordedAt >= begin.recordedAt) duration = end.recordedAt - begin.recordedAt;
      else problem(terminal!, "A native Host Turn ended before admission");
    }
    const status = !consistent ? "unknown" : end?.type === "host_turn"
      ? end.status === "completed" ? "completed" : end.status === "aborted" ? "cancelled" : "failed"
      : facts.some((entry) => entry.canEmitTelemetry) ? "inProgress" : "unknown";
    operations.push({ ...empty("turn", key, facts[0]!), start, terminal, status, duration: consistent ? duration : null, consistent });
  }
  const parentTurn = (source: NativeMetricRecord): string | null => {
    const own = turnKey(source);
    if (turns.has(own)) return own;
    return source.parent ? turnKey(source.parent) : null;
  };
  const childGroup = (source: Pick<NativeMetricRecord, "resource" | "submissionId">, call: string) =>
    identity("native-child-usage", scopeKey(source), call);
  const runKey = (source: NativeMetricRecord) => source.parent?.toolCallId
    ? childGroup(source.parent, source.parent.toolCallId) : scopeKey(source);
  const addUsage = (entry: NativeEntry, message: NativeAssistantMetric, kind: "assistant_model" | "compaction", id: string) => {
    usage.push({ ...entry, fact: jsonObjectInPlaceSchema.parse({
      eventId: id, kind, runId: runKey(entry.native),
      providerMetadata: { provider: message.provider, model: message.model },
      metrics: {
        inputTokens: message.usage.input, outputTokens: message.usage.output,
        cacheReadTokens: message.usage.cacheRead, cacheWriteTokens: message.usage.cacheWrite,
        ...(message.usage.reasoning === undefined ? {} : { reasoningTokens: message.usage.reasoning }),
        totalTokens: message.usage.totalTokens,
      },
      providerCostUsd: message.usage.cost,
    }) });
  };
  const requests = groups(native.filter((entry) => {
    const data = entry.native.bookkeeping;
    return data?.type === "request_start" || data?.type === "request" || data?.type === "request_end";
  }), (entry) => {
    const data = entry.native.bookkeeping;
    return identity(scopeKey(entry.native), data && "requestId" in data ? data.requestId : null);
  });
  const usedResponses = new Set<string>();
  for (const [key, facts] of requests) {
    const starts = facts.filter((entry) => entry.native.bookkeeping?.type === "request");
    const ends = facts.filter((entry) => entry.native.bookkeeping?.type === "request_end");
    const first = starts[0] ?? facts[0]!;
    const data = first.native.bookkeeping;
    if (data?.type !== "request") {
      const end = ends[0]?.native.bookkeeping;
      if (end?.type !== "request_end" || end.result !== "interrupted" || end.outcome !== "not_dispatched") {
        problem(first, "A native preparation or end has no sealed dispatch decision");
        usageComplete = false;
      }
      continue;
    }
    const terminal = ends[0];
    const end = terminal?.native.bookkeeping;
    if (!data.dispatched) {
      if (end?.type === "request_end" && end.entryId !== undefined) {
        const entry = byId.get(entryKey(first.native, end.entryId));
        if (entry) usedResponses.add(entry.native.sourceIdentity);
      }
      continue;
    }
    let consistent = starts.length === 1 && ends.length <= 1;
    if (!consistent) problem(first, "A native request has contradictory dispatch or end facts");
    let response: NativeAssistantMetric | undefined;
    let responseEntry: NativeEntry | undefined;
    if (end?.type === "request_end") {
      if (end.taskId !== data.taskId) consistent = false;
      if (end.result === "entry" && end.entryId !== undefined) {
        responseEntry = byId.get(entryKey(first.native, end.entryId));
        if (responseEntry?.native.taskId !== undefined && responseEntry.native.taskId !== data.taskId) consistent = false;
        if (responseEntry && scopeKey(responseEntry.native) !== scopeKey(first.native)) consistent = false;
        response = responseEntry?.native.messages.find((message): message is NativeAssistantMetric => message.role === "assistant");
        if (!response) {
          problem(first, "A native request has no referenced assistant response");
          consistent = false;
        }
      } else response = end.response;
    }
    if (!consistent) problem(first, "A native request has inconsistent task or response attribution");
    const status = !consistent ? "unknown" : end?.type !== "request_end"
      ? facts.some((entry) => entry.canEmitTelemetry) ? "inProgress" : "unknown"
      : end.result === "interrupted" ? "unknown"
        : end.result === "aborted" || response?.stopReason === "aborted" ? "cancelled"
        : end.result === "error" || response?.stopReason === "error" ? "failed"
          : response && ["stop", "length", "toolUse"].includes(response.stopReason) ? "completed" : "unknown";
    let duration: number | null = null;
    if (end?.type === "request_end") {
      if (end.endedAt >= data.startedAt) duration = end.endedAt - data.startedAt;
      else { problem(first, "A native request ended before dispatch"); consistent = false; }
    }
    operations.push({
      ...empty(data.purpose === "compaction" ? "compaction" : data.method === "fetchDeferred" ? "poll" : "generation", identity("native-request", key), first),
      start: first, terminal, status, duration: consistent ? duration : null, consistent, parentKey: parentTurn(first.native),
      hasThinking: response?.hasThinking ?? false, hasContent: response?.hasContent ?? false,
      thinkingKnown: response?.thinkingKnown ?? false, contentKnown: response?.contentKnown ?? false,
      nativeDetails: { attempt: data.attempt, taskId: data.taskId, inputLength: null, outputLength: null,
        tokens: response ? { inputTokens: response.usage.input, outputTokens: response.usage.output, totalTokens: response.usage.totalTokens } : {} },
    });
    if (response && consistent) {
      const responseIdentity = responseEntry?.native.sourceIdentity ?? terminal!.native.sourceIdentity;
      if (usedResponses.has(responseIdentity)) { problem(first, "Multiple native requests claim the same assistant response"); usageComplete = false; }
      else {
        usedResponses.add(responseIdentity);
        addUsage(responseEntry ?? terminal!, response, data.purpose === "compaction" ? "compaction" : "assistant_model", responseIdentity);
      }
    } else usageComplete = false;
  }
  const calls = native.flatMap((entry) => entry.native.messages.flatMap((message) => message.role === "assistant"
    ? message.calls.map((call) => ({ entry, call })) : []));
  const results = native.flatMap((entry) => entry.native.messages.flatMap((message) => message.role === "toolResult"
    ? [{ entry, message }] : []));
  const callGroups = groups(calls, ({ entry, call }) => toolKey(entry.native, call.id));
  const resultGroups = groups(results, ({ entry, message }) => toolKey(entry.native, message.toolCallId));
  for (const key of new Set([...callGroups.keys(), ...resultGroups.keys()])) {
    const requested = callGroups.get(key) ?? [];
    const returned = resultGroups.get(key) ?? [];
    const first = requested[0]?.entry ?? returned[0]!.entry;
    const result = returned[0];
    const names = new Set([...requested.map(({ call }) => call.name), ...returned.map(({ message }) => message.toolName)]);
    if (requested.length > 1 || returned.length > 1) {
      problem(first, "Native tool-call IDs are ambiguous within one conversation; results are not paired by arrival order");
      usageComplete = false;
      const facts = requested.length > 0 ? requested.map(({ entry, call }) => ({ entry, inputLength: call.inputLength }))
        : returned.map(({ entry }) => ({ entry, inputLength: null }));
      facts.forEach(({ entry, inputLength }, index) => operations.push({
        ...empty("tool", identity(key, entry.native.sourceIdentity, String(index)), entry),
        status: "unknown", consistent: false, toolName: names.size === 1 ? [...names][0]! : null, parentKey: parentTurn(entry.native),
        nativeDetails: { inputLength, outputLength: null, tokens: {} },
      }));
      continue;
    }
    const consistent = requested.length <= 1 && returned.length <= 1 && names.size === 1;
    if (!consistent) problem(first, "A native tool call has ambiguous call identity, result or tool name");
    if (!requested.length) { problem(first, "A native tool result has no execution call"); }
    const status = !consistent ? "unknown" : result ? result.message.isError ? "failed" : "completed"
      : first.canEmitTelemetry ? "inProgress" : "unknown";
    operations.push({
      ...empty("tool", key, first), start: requested[0]?.entry, terminal: result?.entry,
      status, consistent, duration: consistent ? result?.message.durationMs ?? null : null,
      toolName: names.size === 1 ? [...names][0]! : null, parentKey: parentTurn(first.native),
      nativeDetails: { inputLength: requested[0]?.call.inputLength ?? null, outputLength: result?.message.outputLength ?? null, tokens: {} },
    });
    if (result) {
      if (!result.message.nestedComplete) {
        complete = false;
        diagnostics.report("missing-identity", "telemetryEvents", result.entry, "Native nested tool calls are incomplete");
      }
      for (const nested of result.message.nestedCalls) operations.push({
        ...empty("tool", identity(key, nested.id), result.entry), start: result.entry,
        terminal: nested.status === "unfinished" ? undefined : result.entry, parentKey: key, toolName: nested.name,
        status: nested.status === "ok" ? "completed" : nested.status === "error" ? "failed" : "unknown",
        duration: nested.durationMs,
        nativeDetails: { inputLength: nested.inputLength, outputLength: null, tokens: {} },
      });
      if (result.message.usage) {
        const unattributedChildren = native.some(({ native: source }) => source.messages.some((message) => message.role === "assistant")
          && source.parent && scopeKey(source.parent) === scopeKey(result.entry.native) && source.parent.toolCallId === undefined);
        if (unattributedChildren) {
          usageComplete = false;
          diagnostics.report("missing-identity", "usageEvents", result.entry, "A native child has no parent tool-call association; its unverifiable usage summary is omitted");
          continue;
        }
        const own = result.message.usage;
        usage.push({ ...result.entry, fact: jsonObjectInPlaceSchema.parse({
          eventId: `${result.entry.native.sourceIdentity}:tool-usage`, kind: "subagent",
          runId: runKey(result.entry.native), parentRunId: runKey(result.entry.native),
          subagentRunId: childGroup(result.entry.native, result.message.toolCallId),
          metrics: { inputTokens: own.input, outputTokens: own.output, cacheReadTokens: own.cacheRead, cacheWriteTokens: own.cacheWrite,
            totalTokens: own.totalTokens, ...(own.reasoning === undefined ? {} : { reasoningTokens: own.reasoning }) },
          providerCostUsd: own.cost,
        }) });
      }
    }
  }
  // Canonical presentation can contain assistant messages without another Models invocation.
  // Missing dispatches and outcomes are diagnosed from request facts, not message roles.
  return { operations, usage: { entries: usage, complete: usageComplete, duplicates: 0 }, complete };
}
