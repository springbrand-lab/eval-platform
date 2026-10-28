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

/** Native request/hook, Pi message and Tool-result observations share a stable operation ID.
 * A missing ID or contradictory phase never turns into a successful zero-valued operation. */
function groupOperations(stream: FactStream, diagnostics: ResourceDiagnostics): {
  readonly operations: readonly Operation[];
  readonly complete: boolean;
} {
  const operations = new Map<string, Operation>();
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
          turnId: null, toolName: null, status: "unknown", hasTerminal: false, consistent: true,
          startMs: null, endMs: null, durationMs: null, inputLength: null, outputLength: null,
          thinking: null, content: null, inputTokens: null, outputTokens: null, totalTokens: null,
        };
        operations.set(key, operation);
      }
      operation.facts.push(entry);
      if (fact.contentComplete === false) {
        complete = false;
        diagnostics.report("unsupported-record", "nativeRecords", entry, "Native Pi message content is missing or redacted");
      }
      const turnId = text(fact.turnId);
      if (turnId) {
        if (operation.turnId && operation.turnId !== turnId) {
          operation.consistent = false;
          complete = false;
          diagnostics.report("conflicting-identity", "nativeRecords", entry, "Contradictory owning Turn for one native operation");
          operation.turnId = null;
        } else {
          operation.turnId = turnId;
        }
      }
      const toolName = text(fact.toolName);
      if (toolName) {
        if (operation.toolName && operation.toolName !== toolName) {
          operation.consistent = false;
          complete = false;
          diagnostics.report("conflicting-identity", "nativeRecords", entry, "Contradictory Tool names for one Tool ID");
          operation.toolName = null;
        } else {
          operation.toolName = toolName;
        }
      }
      const phase = text(fact.phase);
      const timestamp = factNumber(entry, "timestamp", diagnostics);
      if (phase === "start") {
        if (timestamp !== null) operation.startMs = operation.startMs === null ? timestamp : Math.min(operation.startMs, timestamp);
      } else if (phase === "end" || phase === "message" || phase === "result") {
        if (timestamp !== null) operation.endMs = operation.endMs === null ? timestamp : Math.max(operation.endMs, timestamp);
        operation.hasTerminal = true;
        const status = fact.status;
        if (status === "completed" || status === "failed" || status === "cancelled") {
          if (operation.status !== "unknown" && operation.status !== status) {
            operation.consistent = false;
            complete = false;
            diagnostics.report("conflicting-identity", "nativeRecords", entry, "Contradictory native operation outcomes");
            operation.status = "unknown";
          } else {
            operation.status = status;
          }
        }
      }
      if (kind === "model" && phase === "message") {
        // Only complete Pi assistant message blocks prove marker *absence*.
        for (const category of ["thinking", "content"] as const) {
          const value = fact[category];
          if (value === true || value === false) {
            operation[category] = value === true || operation[category] === true;
          } else if (operation[category] !== true) {
            operation[category] = null;
          }
        }
      }
      for (const field of ["inputLength", "outputLength", "durationMs", "inputTokens", "outputTokens", "totalTokens"] as const) {
        combineNumber(operation, field, factNumber(entry, field, diagnostics,
          field === "inputTokens" || field === "outputTokens" || field === "totalTokens"),
        entry, diagnostics);
      }
    }
  }
  for (const operation of operations.values()) {
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

/** Model Step = one native request ID. No step comes from a legacy `generation.finished`
 * payload and no input/output/cost is derived from an invented model prompt. */
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
  return {
    modelRequests: operationStatistics(models, grouped.complete),
    trajectory: {
      coverage: coverage(grouped.complete, grouped.operations.length > 0),
      turns: operationStatistics(turns, grouped.complete),
      tools: operationStatistics(tools, grouped.complete),
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
