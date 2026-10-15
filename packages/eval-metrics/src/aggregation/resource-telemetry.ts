import type { JsonValue } from "@eval-platform/eval-contracts";
import { canonicalJsonBytes } from "@springbrand/utils";
import type {
  CoveredNumericSummary,
  MetricNumber,
  OperationStatistics,
  ResourceStatistics,
  ToolMetric,
  TrajectorySummary,
} from "./model.js";
import { identity, record, text, type FactEntry, type FactStream, type ResourceDiagnostics } from "./resource-facts.js";
import { summarizeNumbers } from "./statistics.js";

type OperationKind = "generation" | "turn" | "tool";
type OperationStatus = "completed" | "failed" | "cancelled" | "inProgress" | "unknown";

const OPERATION_TYPES = new Set([
  "generation.started", "generation.finished",
  "turn.admitted", "turn.started", "turn.steered", "turn.recovering", "turn.cancelled", "turn.finished",
  "tool.started", "tool.finished",
]);
/** Whole-body placeholders SP's telemetry sanitizer writes instead of content. */
const OMITTED_BODIES = new Set(["[CONTENT OMITTED]", "[REDACTED]"]);

interface OperationEvents {
  readonly kind: OperationKind;
  readonly key: string;
  readonly sessionId: string;
  readonly events: FactEntry[];
}

interface ObservedOperation {
  readonly kind: OperationKind;
  readonly key: string;
  readonly status: OperationStatus;
  readonly duration: number | null;
  readonly toolName: string | null;
  /** Session-scoped key of the parent operation; null when absent or contradictory. */
  readonly parentKey: string | null;
  readonly first: FactEntry;
  readonly start: FactEntry | undefined;
  readonly terminal: FactEntry | undefined;
  /** False when the events contradict each other. */
  readonly consistent: boolean;
}

/** Model requests and trajectory metrics from telemetry events merged across Attempts and pages. */
export function aggregateTelemetry(
  stream: FactStream,
  diagnostics: ResourceDiagnostics,
): Pick<ResourceStatistics, "modelRequests"> & { readonly trajectory: Omit<TrajectorySummary, "diagnostics"> } {
  const grouped = groupOperations(stream.entries, diagnostics);
  const observed = grouped.operations.map((operation) => inspectOperation(operation, diagnostics));
  const complete = stream.complete && grouped.complete && observed.every((operation) => operation.consistent);
  const ofKind = (kind: OperationKind) => observed.filter((operation) => operation.kind === kind);
  const tools = ofKind("tool");
  const toolGroups = new Map<string | null, ObservedOperation[]>();
  for (const operation of tools) toolGroups.set(operation.toolName, [...toolGroups.get(operation.toolName) ?? [], operation]);
  return {
    modelRequests: operationStatistics(ofKind("generation"), complete),
    trajectory: {
      coverage: complete ? "complete" : observed.length > 0 ? "partial" : "unavailable",
      turns: operationStatistics(ofKind("turn"), complete),
      tools: operationStatistics(tools, complete),
      byTool: [...toolGroups.entries()]
        .map(([toolName, operations]) => toolMetric(toolName, operations, complete))
        .sort((left, right) => (left.toolName ?? "").localeCompare(right.toolName ?? "")),
      ...nonToolTurns(observed, complete, diagnostics),
    },
  };
}

function operationKind(type: string): OperationKind | undefined {
  if (type.startsWith("generation.")) return "generation";
  if (type.startsWith("turn.")) return "turn";
  if (type.startsWith("tool.")) return "tool";
  return undefined;
}

function groupOperations(
  entries: readonly FactEntry[],
  diagnostics: ResourceDiagnostics,
): { readonly operations: readonly OperationEvents[]; readonly complete: boolean } {
  let complete = true;
  const operations = new Map<string, OperationEvents>();
  const conflicting = new Set<string>();
  for (const entry of entries) {
    const type = text(entry.fact.type);
    const kind = type === undefined ? undefined : operationKind(type);
    if (!type || (kind && !OPERATION_TYPES.has(type))) {
      complete = false;
      diagnostics.report("unsupported-record", "telemetryEvents", entry, "Unsupported telemetry event type");
      continue;
    }
    if (!kind) continue;
    const operationId = text(entry.fact.operationId);
    const sessionId = text(record(entry.fact.resource)?.sessionId);
    if (!operationId || !sessionId) {
      complete = false;
      diagnostics.report("missing-identity", "telemetryEvents", entry, "Telemetry record has no operation identity");
      continue;
    }
    const key = identity(sessionId, operationId);
    if (conflicting.has(key)) continue;
    const existing = operations.get(key);
    if (existing && existing.kind !== kind) {
      complete = false;
      diagnostics.report("conflicting-identity", "telemetryEvents", entry, "An operation identity has different operation kinds");
      conflicting.add(key);
      operations.delete(key);
      continue;
    }
    const operation = existing ?? { kind, key, sessionId, events: [] };
    operation.events.push(entry);
    operations.set(key, operation);
  }
  return { operations: [...operations.values()], complete };
}

function occurredAt(entry: FactEntry): number {
  return typeof entry.fact.occurredAt === "number" ? entry.fact.occurredAt : 0;
}

function isTerminalEvent(entry: FactEntry): boolean {
  const type = text(entry.fact.type);
  return type?.endsWith(".finished") === true || type?.endsWith(".cancelled") === true;
}

function inspectOperation(operation: OperationEvents, diagnostics: ResourceDiagnostics): ObservedOperation {
  const events = operation.events.toSorted((left, right) => occurredAt(left) - occurredAt(right));
  const first = events[0]!;
  const start = events.find((entry) => text(entry.fact.type)?.endsWith(".started"));
  const terminals = events.filter(isTerminalEvent);
  const terminal = terminals.at(-1);
  const outcomes = new Set(terminals.map((entry) => (
    entry.fact.type === "turn.cancelled" ? "cancelled" : text(record(entry.fact.payload)?.outcome)
  )));
  let consistent = outcomes.size <= 1;
  if (!consistent && terminal) {
    diagnostics.report("conflicting-identity", "telemetryEvents", terminal, "An operation has contradictory terminal outcomes");
  }
  const outcome = outcomes.size === 1 ? [...outcomes][0] : undefined;
  const status: OperationStatus = !terminal
    ? "inProgress"
    : outcome === "completed" || outcome === "failed" || outcome === "cancelled" ? outcome : "unknown";
  const duration = operationDuration(start, terminal, diagnostics);
  const distinct = (read: (entry: FactEntry) => string | undefined) => new Set(events.map(read).filter((value) => value !== undefined));
  const toolNames = distinct((entry) => text(record(entry.fact.payload)?.toolName));
  if (toolNames.size > 1) {
    consistent = false;
    diagnostics.report("conflicting-identity", "telemetryEvents", first, "An operation has contradictory tool names");
  }
  const parents = distinct((entry) => text(entry.fact.parentOperationId));
  if (parents.size > 1) {
    consistent = false;
    diagnostics.report("conflicting-identity", "telemetryEvents", first, "An operation has contradictory parent operations");
  }
  return {
    kind: operation.kind,
    key: operation.key,
    status,
    duration: outcomes.size > 1 ? null : duration,
    toolName: toolNames.size === 1 ? [...toolNames][0] ?? null : null,
    parentKey: parents.size === 1 ? identity(operation.sessionId, [...parents][0]!) : null,
    first,
    start,
    terminal,
    consistent,
  };
}

function operationDuration(
  start: FactEntry | undefined,
  terminal: FactEntry | undefined,
  diagnostics: ResourceDiagnostics,
): number | null {
  if (!terminal) return null;
  const durationMs = record(terminal.fact.payload)?.durationMs;
  if (durationMs !== undefined && durationMs !== null) {
    return diagnostics.number(terminal, "telemetryEvents", durationMs, "durationMs", false);
  }
  if (!start) return null;
  const startTime = diagnostics.number(start, "telemetryEvents", start.fact.occurredAt, "occurredAt", false);
  const endTime = diagnostics.number(terminal, "telemetryEvents", terminal.fact.occurredAt, "occurredAt", false);
  if (startTime === null || endTime === null) return null;
  if (endTime >= startTime) return endTime - startTime;
  diagnostics.report("invalid-value", "telemetryEvents", terminal, "Operation ended before it started");
  return null;
}

function operationStatistics(observed: readonly ObservedOperation[], complete: boolean): OperationStatistics {
  const count = (status: OperationStatus): number => observed.filter((item) => item.status === status).length;
  return {
    count: {
      value: observed.length > 0 || complete ? observed.length : null,
      coverage: complete ? "complete" : observed.length > 0 ? "partial" : "unavailable",
    },
    completed: count("completed"),
    failed: count("failed"),
    cancelled: count("cancelled"),
    inProgress: count("inProgress"),
    unknown: count("unknown"),
    durationMs: summarizeNumbers(observed.map((item) => item.duration)),
  };
}

/** Bytes of a present body; absent and sanitizer-omitted bodies are missing, never zero. */
function bodyLength(value: JsonValue | undefined): number | null {
  if (value === undefined || (typeof value === "string" && OMITTED_BODIES.has(value))) return null;
  return canonicalJsonBytes(value).byteLength;
}

function lengthSummary(values: readonly (number | null)[], complete: boolean): CoveredNumericSummary {
  const summary = summarizeNumbers(values);
  const coverage = complete && summary.missing === 0 ? "complete" : summary.count > 0 ? "partial" : "unavailable";
  return { ...summary, coverage };
}

function toolMetric(toolName: string | null, operations: readonly ObservedOperation[], complete: boolean): ToolMetric {
  const payload = (entry: FactEntry | undefined) => record(entry?.fact.payload);
  return {
    toolName,
    ...operationStatistics(operations, complete),
    inputLength: lengthSummary(operations.map((operation) => (
      operation.start?.fact.type === "tool.started" ? bodyLength(payload(operation.start)?.input) : null
    )), complete),
    outputLength: lengthSummary(operations.map((operation) => {
      const finished = operation.terminal?.fact.type === "tool.finished" ? payload(operation.terminal) : undefined;
      return bodyLength(finished?.output) ?? bodyLength(finished?.response);
    }), complete),
  };
}

/** Follows parentOperationId through nested tool operations to the owning Turn. */
function owningTurn(operation: ObservedOperation, byKey: ReadonlyMap<string, ObservedOperation>): string | null {
  const seen = new Set<string>();
  let current = operation;
  while (current.parentKey !== null && !seen.has(current.parentKey)) {
    seen.add(current.parentKey);
    const parent = byKey.get(current.parentKey);
    if (parent?.kind === "turn") return parent.key;
    if (parent?.kind !== "tool") return null;
    current = parent;
  }
  return null;
}

function nonToolTurns(
  observed: readonly ObservedOperation[],
  complete: boolean,
  diagnostics: ResourceDiagnostics,
): Pick<TrajectorySummary, "nonToolTurns" | "nonToolTurnTokens" | "unlinkedOperations"> {
  const byKey = new Map(observed.map((operation) => [operation.key, operation]));
  const turns = observed.filter((operation) => operation.kind === "turn");
  const toolTurns = new Set<string>();
  let unlinkedTools = 0;
  let toolCount = 0;
  for (const operation of observed) {
    if (operation.kind !== "tool") continue;
    toolCount += 1;
    const turn = owningTurn(operation, byKey);
    if (turn === null) unlinkedTools += 1;
    else toolTurns.add(turn);
  }
  const nonTool = new Set(turns.filter((turn) => !toolTurns.has(turn.key)).map((turn) => turn.key));
  const count: MetricNumber = turns.length === 0
    ? { value: complete ? 0 : null, coverage: complete ? "complete" : "unavailable" }
    : toolCount > 0 && unlinkedTools === toolCount
      ? { value: null, coverage: "unavailable" }
      : { value: nonTool.size, coverage: complete && unlinkedTools === 0 ? "complete" : "partial" };
  const generations: FactEntry[] = [];
  let unlinkedGenerations = 0;
  for (const operation of observed) {
    if (operation.kind !== "generation") continue;
    const turn = owningTurn(operation, byKey);
    if (turn === null) unlinkedGenerations += 1;
    else if (nonTool.has(turn)) generations.push(operation.terminal ?? operation.first);
  }
  const tokensComplete = count.coverage === "complete" && unlinkedGenerations === 0;
  const tokens = (field: "inputTokens" | "outputTokens" | "totalTokens"): MetricNumber => count.value === null
    ? { value: null, coverage: "unavailable" }
    : diagnostics.sum(generations, tokensComplete, "telemetryEvents", field, true, (entry) => (
      entry.fact.type === "generation.finished"
        ? diagnostics.number(entry, "telemetryEvents", record(entry.fact.payload)?.[field], field, true)
        : null
    ));
  return {
    nonToolTurns: count,
    nonToolTurnTokens: { input: tokens("inputTokens"), output: tokens("outputTokens"), total: tokens("totalTokens") },
    unlinkedOperations: { tools: unlinkedTools, generations: unlinkedGenerations },
  };
}
