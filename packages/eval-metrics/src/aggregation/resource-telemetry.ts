import { text, type JsonRecord } from "../json.js";
import type {
  CoveredNumericSummary, MetricNumber, OperationStatistics, ResourceStatistics,
  StepTokens, ToolMetric, TrajectorySummary,
} from "./model.js";
import { NATIVE_PROJECTION_VERSION } from "./compact-resources.js";
import { nativeRecordFacts } from "./native-record-facts.js";
import { identity, type FactEntry, type FactStream, type ResourceDiagnostics } from "./resource-facts.js";
import { coverage, summarizeNumbers } from "./statistics.js";

type Kind = "turn" | "model" | "tool";
type Status = "completed" | "failed" | "cancelled" | "inProgress" | "unknown";

interface Operation {
  readonly key: string;
  readonly kind: Kind;
  readonly first: FactEntry;
  readonly facts: FactEntry[];
  readonly canEmit: boolean;
  readonly conflictingFields: Set<string>;
  scopeKey: string | null;
  assistantTimestamp: number | null;
  hasEvent: boolean;
  hasPiCall: boolean;
  hasPiResult: boolean;
  hasToolTerminalEvent: boolean;
  turnId: string | null;
  toolName: string | null;
  status: Status;
  hasTerminal: boolean;
  consistent: boolean;
  startMs: number | null;
  endMs: number | null;
  durationMs: number | null;
  inputLength: number | null;
  outputLength: number | null;
  thinking: boolean | null;
  content: boolean | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

function operationKey(entry: FactEntry, kind: Kind, id: string): string {
  return identity(entry.ownerUserId, entry.scope.chatId, kind, id);
}

function factNumber(entry: FactEntry, field: string, diagnostics: ResourceDiagnostics, integer = false): number | null {
  return diagnostics.number(entry, "nativeRecords", entry.fact[field], field, integer);
}

function combineNumber(operation: Operation, field: "inputLength" | "outputLength" | "inputTokens" | "outputTokens" | "totalTokens" | "durationMs",
  value: number | null, entry: FactEntry, diagnostics: ResourceDiagnostics): void {
  if (value === null || operation.conflictingFields.has(field)) return;
  const before = operation[field];
  if (before !== null && before !== value) {
    operation.consistent = false;
    diagnostics.report("conflicting-identity", "nativeRecords", entry, `Contradictory ${field} for one native operation`);
    operation.conflictingFields.add(field);
    operation[field] = null;
  } else {
    operation[field] = value;
  }
}

/** Native bookkeeping events own operation status; Pi messages own content. Request
 * and hook facts are auxiliary evidence, never fabricated generation/Tool results. */
function groupOperations(stream: FactStream, diagnostics: ResourceDiagnostics): {
  readonly operations: readonly Operation[];
  readonly complete: boolean;
} {
  const operations = new Map<string, Operation>();
  const assistants: FactEntry[] = [];
  const requests: FactEntry[] = [];
  const hooks: FactEntry[] = [];
  let complete = stream.complete;
  for (const source of stream.entries) {
    const projection = source.metricProjection;
    const compact = projection?.version === NATIVE_PROJECTION_VERSION;
    const facts = compact
      ? projection?.supported === true ? (projection.facts as readonly JsonRecord[]) : undefined
      : nativeRecordFacts(source.fact);
    if (facts === undefined) {

      complete = false;
      diagnostics.report("unsupported-record", "nativeRecords", source, "Unsupported native Pi record or safe projection");
      continue;
    }
    for (const fact of facts) {
      const entry: FactEntry = { ...source, fact };
      const kind = text(fact.type);
      if (kind === "assistant") { assistants.push(entry); continue; }
      if (kind === "request") { requests.push(entry); continue; }
      if (kind === "hook") { hooks.push(entry); continue; }
      if (kind !== "turn" && kind !== "model" && kind !== "tool") {
        complete = false;
        diagnostics.report("unsupported-record", "nativeRecords", entry, "Unsupported native metric fact");
        continue;
      }
      const id = text(fact.id);
      if (!id) {
        complete = false;
        diagnostics.report("missing-identity", "nativeRecords", entry, `Native ${kind} record has no operation identity`);
        continue;
      }
      const key = operationKey(entry, kind, id);
      let operation = operations.get(key);
      if (!operation) {
        operation = {
          key, kind, first: entry, facts: [], canEmit: entry.canEmitNativeRecords, conflictingFields: new Set(),
          scopeKey: text(fact.scopeKey) ?? null, assistantTimestamp: null,
          hasEvent: false, hasPiCall: false, hasPiResult: false, hasToolTerminalEvent: false,
          turnId: null, toolName: null, status: "unknown", hasTerminal: false, consistent: true,
          startMs: null, endMs: null, durationMs: null, inputLength: null, outputLength: null,
          thinking: null, content: null, inputTokens: null, outputTokens: null, totalTokens: null,
        };
        operations.set(key, operation);
      }
      operation.facts.push(entry);
      if (operation.scopeKey !== text(fact.scopeKey)) {
        operation.consistent = false;
        complete = false;
        diagnostics.report("conflicting-identity", "nativeRecords", entry, "Native operation spans unrelated agent scopes");
      }
      operation.hasEvent ||= fact.fromEvent === true;
      operation.hasPiCall ||= fact.fromPiCall === true;
      operation.hasPiResult ||= fact.fromPiResult === true;
      operation.hasToolTerminalEvent ||= kind === "tool" && fact.fromEvent === true && fact.phase === "end";
      const assistantTimestamp = factNumber(entry, "assistantTimestamp", diagnostics);
      if (assistantTimestamp !== null && !operation.conflictingFields.has("assistantTimestamp")) {
        if (operation.assistantTimestamp !== null && operation.assistantTimestamp !== assistantTimestamp) {
          operation.consistent = false;
          complete = false;
          diagnostics.report("conflicting-identity", "nativeRecords", entry, "Generation has contradictory Pi assistant refs");
          operation.conflictingFields.add("assistantTimestamp");
          operation.assistantTimestamp = null;
        } else {
          operation.assistantTimestamp = assistantTimestamp;
        }
      }
      const turnId = text(fact.turnId);
      if (turnId && !operation.conflictingFields.has("turnId")) {
        if (operation.turnId && operation.turnId !== turnId) {
          operation.consistent = false;
          complete = false;
          diagnostics.report("conflicting-identity", "nativeRecords", entry, "Contradictory owning Turn for one native operation");
          operation.conflictingFields.add("turnId");
          operation.turnId = null;
        } else {
          operation.turnId = turnId;
        }
      }
      const toolName = text(fact.toolName);
      if (toolName && !operation.conflictingFields.has("toolName")) {
        if (operation.toolName && operation.toolName !== toolName) {
          operation.consistent = false;
          complete = false;
          diagnostics.report("conflicting-identity", "nativeRecords", entry, "Contradictory Tool names for one Tool ID");
          operation.conflictingFields.add("toolName");
          operation.toolName = null;
        } else {
          operation.toolName = toolName;
        }
      }
      const phase = text(fact.phase);
      const timestamp = factNumber(entry, "timestamp", diagnostics);
      if (phase === "start") {
        // A Pi Tool Call is written with the assistant message, before execution.
        // Only tool.started marks the actual start of its measured duration.
        if (timestamp !== null && !(kind === "tool" && fact.fromPiCall === true)) {
          operation.startMs = operation.startMs === null ? timestamp : Math.min(operation.startMs, timestamp);
        }
      } else if (phase === "end" || phase === "message" || phase === "result") {
        if (timestamp !== null) operation.endMs = operation.endMs === null ? timestamp : Math.max(operation.endMs, timestamp);
        operation.hasTerminal = true;
        const status = fact.status;
        if ((status === "completed" || status === "failed" || status === "cancelled")
          && !operation.conflictingFields.has("status")) {
          if (operation.status !== "unknown" && operation.status !== status) {
            operation.consistent = false;
            complete = false;
            diagnostics.report("conflicting-identity", "nativeRecords", entry, "Contradictory native operation outcomes");
            operation.conflictingFields.add("status");
            operation.status = "unknown";
          } else {
            operation.status = status;
          }
        } else if (status !== "completed" && status !== "failed" && status !== "cancelled") {
          complete = false;
          diagnostics.report("unsupported-record", "nativeRecords", entry, "Native terminal operation has no supported outcome");
        }
      }
      for (const field of ["inputLength", "outputLength", "durationMs", "inputTokens", "outputTokens", "totalTokens"] as const) {
        combineNumber(operation, field, factNumber(entry, field, diagnostics,
          field === "inputTokens" || field === "outputTokens" || field === "totalTokens"),
        entry, diagnostics);
      }
    }
  }
  const assistantKey = (entry: FactEntry, timestamp: number) =>
    identity(entry.ownerUserId, text(entry.fact.scopeKey) ?? null, String(timestamp));
  const byAssistant = new Map<string, FactEntry[]>();
  for (const entry of assistants) {
    const timestamp = factNumber(entry, "timestamp", diagnostics);
    if (timestamp === null) {
      complete = false;
      continue;
    }
    const key = assistantKey(entry, timestamp);
    byAssistant.set(key, [...byAssistant.get(key) ?? [], entry]);
  }
  const requestsByTask = new Map<string, FactEntry[]>();
  const requestKey = (entry: FactEntry, id: string) =>
    identity(entry.ownerUserId, text(entry.fact.scopeKey) ?? null, id);
  const assistantsByTask = new Map<string, FactEntry[]>();
  for (const assistant of assistants) {
    const id = text(assistant.fact.taskId);
    if (!id) continue;
    const key = requestKey(assistant, id);
    assistantsByTask.set(key, [...assistantsByTask.get(key) ?? [], assistant]);
  }
  for (const request of requests) {
    if (request.fact.purpose !== "generation") continue;
    const id = text(request.fact.id);
    if (!id) { complete = false; continue; }
    const key = requestKey(request, id);
    requestsByTask.set(key, [...requestsByTask.get(key) ?? [], request]);
  }
  const matchedAssistants = new Set<FactEntry>();
  const matchedRequests = new Set<FactEntry>();
  const references = new Map<string, number>();
  for (const operation of operations.values()) {
    if (operation.kind !== "model" || operation.assistantTimestamp === null) continue;
    const key = assistantKey(operation.first, operation.assistantTimestamp);
    references.set(key, (references.get(key) ?? 0) + 1);
  }
  for (const operation of operations.values()) {
    if (operation.kind !== "model") continue;
    if (operation.assistantTimestamp === null) {
      // A completed generation with no ref might lack its Pi result; it cannot
      // prove that a thinking/content Step was absent.
      if (operation.status === "completed") complete = false;
      continue;
    }
    const key = assistantKey(operation.first, operation.assistantTimestamp);
    const matches = byAssistant.get(key) ?? [];
    if (matches.length !== 1 || references.get(key) !== 1 || operation.conflictingFields.has("assistantTimestamp")) {
      complete = false;
      diagnostics.report(matches.length === 0 ? "missing-identity" : "conflicting-identity",
        "nativeRecords", operation.first, "Generation assistant reference has no unique Pi message");
      continue;
    }
    const assistant = matches[0]!;
    matchedAssistants.add(assistant);
    const taskId = text(assistant.fact.taskId);
    const taskKey = taskId ? requestKey(assistant, taskId) : undefined;
    const matchingRequests = taskKey ? requestsByTask.get(taskKey) ?? [] : [];
    if (matchingRequests.length !== 1 || (taskKey && assistantsByTask.get(taskKey)?.length !== 1)) {
      complete = false;
      diagnostics.report(matchingRequests.length === 0 ? "missing-identity" : "conflicting-identity",
        "nativeRecords", assistant, "Pi assistant has no unique generation request task");
      continue;
    }
    matchedRequests.add(matchingRequests[0]!);
    operation.thinking = typeof assistant.fact.thinking === "boolean" ? assistant.fact.thinking : null;
    operation.content = typeof assistant.fact.content === "boolean" ? assistant.fact.content : null;
    for (const field of ["inputTokens", "outputTokens", "totalTokens"] as const) {
      combineNumber(operation, field, factNumber(assistant, field, diagnostics, true), assistant, diagnostics);
    }
  }
  for (const assistant of assistants) {
    if (matchedAssistants.has(assistant)) continue;
    complete = false;
    diagnostics.report("missing-identity", "nativeRecords", assistant, "Pi assistant has no unique generation reference");
  }
  for (const request of requests) {
    if (request.fact.purpose !== "generation" || matchedRequests.has(request)) continue;
    complete = false;
    diagnostics.report("missing-identity", "nativeRecords", request, "Generation request task has no linked Pi assistant and event");
  }
  const toolsByScope = new Map<string, Set<string>>();
  for (const item of operations.values()) {
    if (item.scopeKey === null) continue;
    if (item.kind === "tool") {
      const ids = toolsByScope.get(item.scopeKey) ?? new Set<string>();
      for (const fact of item.facts) {
        const id = text(fact.fact.id);
        if (id) ids.add(id);
      }
      toolsByScope.set(item.scopeKey, ids);
    }
  }
  for (const hook of hooks) {
    if (hook.fact.hook !== "beforeTool" && hook.fact.hook !== "afterTool") continue;
    const toolId = text(hook.fact.toolCallId);
    const key = text(hook.fact.scopeKey);
    if (toolId && key && toolsByScope.get(key)?.has(toolId)) continue;
    complete = false;
    diagnostics.report("missing-identity", "nativeRecords", hook, "Tool hook has no corresponding Tool Call");
  }
  for (const operation of operations.values()) {
    if (operation.kind === "tool" && operation.hasPiCall && !operation.hasEvent) {
      complete = false;
      diagnostics.report("missing-identity", "nativeRecords", operation.first, "Pi Tool Call has no execution event");
    }
    if (operation.kind === "tool" && operation.hasPiResult && !operation.hasToolTerminalEvent) {
      complete = false;
      diagnostics.report("missing-identity", "nativeRecords", operation.first, "Pi Tool Result has no terminal Tool event");
    }
    if (operation.kind === "tool" && operation.hasEvent && !operation.hasPiCall) {
      complete = false;
      diagnostics.report("missing-identity", "nativeRecords", operation.first, "Tool event has no Pi Tool Call arguments");
    }
    if (!operation.hasTerminal) operation.status = operation.canEmit ? "inProgress" : "unknown";
    if (operation.durationMs === null && operation.startMs !== null && operation.endMs !== null) {
      if (operation.endMs < operation.startMs) {
        complete = false;
        diagnostics.report("invalid-value", "nativeRecords", operation.first, "Native operation ended before it started");
      } else {
        operation.durationMs = operation.endMs - operation.startMs;
      }
    }
    if (!operation.consistent) complete = false;
  }
  return { operations: [...operations.values()], complete };
}

function operationStatistics(observed: readonly Operation[], complete: boolean): OperationStatistics {
  const count = (status: Status) => observed.filter((item) => item.status === status).length;
  return {
    count: { value: observed.length > 0 || complete ? observed.length : null, coverage: coverage(complete, observed.length > 0) },
    completed: count("completed"), failed: count("failed"), cancelled: count("cancelled"),
    inProgress: count("inProgress"), unknown: count("unknown"),
    durationMs: summarizeNumbers(observed.map((item) => item.durationMs)),
  };
}

function lengthSummary(operations: readonly Operation[], field: "inputLength" | "outputLength", complete: boolean): CoveredNumericSummary {
  const summary = summarizeNumbers(operations.map((operation) => operation[field]));
  return { ...summary, coverage: coverage(complete && summary.missing === 0, summary.count > 0) };
}

function toolMetric(name: string | null, operations: readonly Operation[], complete: boolean): ToolMetric {
  return {
    toolName: name, ...operationStatistics(operations, complete),
    inputLength: lengthSummary(operations, "inputLength", complete),
    outputLength: lengthSummary(operations, "outputLength", complete),
  };
}

function stepCount(steps: readonly Operation[], category: "thinking" | "content", complete: boolean,
  linked: boolean, noTurns: boolean): OperationStatistics {
  const marked = steps.filter((step) => step[category] === true);
  const known = steps.every((step) => step[category] !== null);
  const hasProof = steps.length > 0 ? known || marked.length > 0 : complete && noTurns;
  const full = complete && linked && known && (steps.length > 0 || noTurns);
  const stats = operationStatistics(marked, full);
  return { ...stats, count: {
    value: hasProof ? marked.length : null,
    coverage: coverage(full, hasProof),
  } };
}

function stepTokens(steps: readonly Operation[], category: "thinking" | "content",
  count: MetricNumber, diagnostics: ResourceDiagnostics): StepTokens {
  const marked = steps.filter((step) => step[category] === true);
  const tokens = (field: "inputTokens" | "outputTokens" | "totalTokens"): MetricNumber => {
    if (count.value === null) return { value: null, coverage: "unavailable" };
    return diagnostics.sum(marked.map((step) => step.first), count.coverage === "complete", "nativeRecords",
      field, true, (entry) => marked.find((step) => step.first === entry)?.[field] ?? null);
  };
  return { input: tokens("inputTokens"), output: tokens("outputTokens"), total: tokens("totalTokens") };
}

/** Model Step = one native generation operation ID. Request task IDs only
 * establish Pi assistant linkage; no input or cost is rebuilt from a prompt. */
export function aggregateTelemetry(
  stream: FactStream, diagnostics: ResourceDiagnostics, requestedTools: readonly (string | null)[] = [],
): Pick<ResourceStatistics, "modelRequests"> & { readonly trajectory: Omit<TrajectorySummary, "diagnostics"> } {
  const grouped = groupOperations(stream, diagnostics);
  const ofKind = (kind: Kind) => grouped.operations.filter((item) => item.kind === kind);
  const turns = ofKind("turn");
  const models = ofKind("model");
  const tools = ofKind("tool");
  const turnIds = new Set(turns.map((turn) => turn.key));
  const linked = (operation: Operation) => operation.turnId !== null
    && turnIds.has(identity(operation.first.ownerUserId, operation.first.scope.chatId, "turn", operation.turnId));
  const unlinkedTools = tools.filter((tool) => !linked(tool)).length;
  const unlinkedModels = models.filter((model) => !linked(model)).length;
  const toolNamesKnown = tools.every((tool) => tool.toolName !== null);
  const groups = new Map<string | null, Operation[]>();
  for (const tool of tools) groups.set(tool.toolName, [...groups.get(tool.toolName) ?? [], tool]);
  for (const name of requestedTools) if (!groups.has(name)) groups.set(name, []);
  const thinking = stepCount(models, "thinking", grouped.complete, unlinkedModels === 0, turns.length === 0);
  const content = stepCount(models, "content", grouped.complete, unlinkedModels === 0, turns.length === 0);
  const toolStatistics = operationStatistics(tools, grouped.complete);
  const terminalTools = toolStatistics.completed + toolStatistics.failed + toolStatistics.cancelled;
  return {
    modelRequests: operationStatistics(models, grouped.complete),
    trajectory: {
      coverage: coverage(grouped.complete, grouped.operations.length > 0),
      turns: operationStatistics(turns, grouped.complete),
      tools: toolStatistics,
      toolSuccessRate: {
        value: terminalTools === 0 ? null : toolStatistics.completed / terminalTools,
        coverage: toolStatistics.count.coverage,
      },
      byTool: [...groups.entries()].map(([name, operations]) =>
        toolMetric(name, operations, grouped.complete && (name === null || toolNamesKnown)))
        .sort((left, right) => (left.toolName ?? "").localeCompare(right.toolName ?? "")),
      thinkingSteps: thinking.count, thinkingStepOperations: thinking,
      contentSteps: content.count, contentStepOperations: content,
      thinkingStepTokens: stepTokens(models, "thinking", thinking.count, diagnostics),
      contentStepTokens: stepTokens(models, "content", content.count, diagnostics),
      unlinkedOperations: { tools: unlinkedTools, generations: unlinkedModels },
    },
  };
}
