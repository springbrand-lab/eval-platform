import type { OperationStatistics, ResourceStatistics } from "./model.js";
import { identity, record, text, type FactEntry, type FactStream, type ResourceDiagnostics } from "./resource-facts.js";
import { summarizeNumbers } from "./statistics.js";

type OperationKind = "generation" | "turn" | "tool";
type OperationStatus = "completed" | "failed" | "cancelled" | "inProgress" | "unknown";

const OPERATION_TYPES = new Set([
  "generation.started", "generation.finished",
  "turn.admitted", "turn.started", "turn.steered", "turn.recovering", "turn.cancelled", "turn.finished",
  "tool.started", "tool.finished",
]);

interface OperationEvents {
  readonly kind: OperationKind;
  readonly events: FactEntry[];
}

interface ObservedOperation {
  readonly kind: OperationKind;
  readonly status: OperationStatus;
  readonly duration: number | null;
  readonly toolName: string | null;
  /** False when the events contradict each other. */
  readonly consistent: boolean;
}

/** Model request, Turn and Tool operation counts, outcomes and durations from telemetry events. */
export function aggregateTelemetry(
  stream: FactStream,
  diagnostics: ResourceDiagnostics,
): Pick<ResourceStatistics, "modelRequests" | "turns" | "tools" | "byTool"> {
  const grouped = groupOperations(stream.entries, diagnostics);
  const observed = grouped.operations.map((operation) => inspectOperation(operation, diagnostics));
  const complete = stream.complete && grouped.complete && observed.every((operation) => operation.consistent);
  const ofKind = (kind: OperationKind) => observed.filter((operation) => operation.kind === kind);
  const tools = ofKind("tool");
  const toolGroups = new Map<string | null, ObservedOperation[]>();
  for (const operation of tools) toolGroups.set(operation.toolName, [...toolGroups.get(operation.toolName) ?? [], operation]);
  return {
    modelRequests: operationStatistics(ofKind("generation"), complete),
    turns: operationStatistics(ofKind("turn"), complete),
    tools: operationStatistics(tools, complete),
    byTool: [...toolGroups.entries()]
      .map(([toolName, operations]) => ({ toolName, ...operationStatistics(operations, complete) }))
      .sort((left, right) => (left.toolName ?? "").localeCompare(right.toolName ?? "")),
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
    const operation = existing ?? { kind, events: [] };
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
  const toolNames = new Set(events.map((entry) => text(record(entry.fact.payload)?.toolName)).filter((name) => name !== undefined));
  const [firstEvent] = events;
  if (toolNames.size > 1 && firstEvent) {
    consistent = false;
    diagnostics.report("conflicting-identity", "telemetryEvents", firstEvent, "An operation has contradictory tool names");
  }
  return {
    kind: operation.kind,
    status,
    duration: outcomes.size > 1 ? null : duration,
    toolName: toolNames.size === 1 ? [...toolNames][0] ?? null : null,
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
