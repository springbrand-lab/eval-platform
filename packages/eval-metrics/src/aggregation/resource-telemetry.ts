import { TELEMETRY_PROJECTION_VERSION, telemetryBodyLength, telemetryContentFlags } from "./compact-resources.js";
import { record, text } from "../json.js";
import type {
  CoveredNumericSummary,
  ThinkingTurnTokens,
  MetricNumber,
  OperationStatistics,
  ResourceStatistics,
  ToolMetric,
  TrajectorySummary,
} from "./model.js";
import { identity, type FactEntry, type FactStream, type ResourceDiagnostics } from "./resource-facts.js";
import { coverage, summarizeNumbers } from "./statistics.js";

type OperationKind = "generation" | "turn" | "tool";
type OperationStatus = "completed" | "failed" | "cancelled" | "inProgress" | "unknown";

const OPERATION_TYPES = new Set([
  "generation.started", "generation.finished",
  "turn.admitted", "turn.started", "turn.steered", "turn.recovering", "turn.cancelled", "turn.finished",
  "tool.started", "tool.finished",
]);

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
  readonly hasThinking: boolean;
  readonly hasContent: boolean;
  /** False when the output body or compact marker projection cannot prove marker absence. */
  readonly markerKnown: boolean;
  readonly first: FactEntry;
  readonly start: FactEntry | undefined;
  readonly terminal: FactEntry | undefined;
  /** False when the events contradict each other. */
  readonly consistent: boolean;
}

/** Operations are identified within their session; parentOperationId uses the same scope. */
function operationKey(sessionId: string, operationId: string): string {
  return identity(sessionId, operationId);
}

/** Model requests and trajectory metrics from telemetry events merged across Attempts and pages. */
export function aggregateTelemetry(
  stream: FactStream,
  diagnostics: ResourceDiagnostics,
  requestedTools: readonly (string | null)[] = [],
): Pick<ResourceStatistics, "modelRequests"> & { readonly trajectory: Omit<TrajectorySummary, "diagnostics"> } {
  const grouped = groupOperations(stream.entries, diagnostics);
  const observed = grouped.operations.map((operation) => inspectOperation(operation, diagnostics));
  const complete = stream.complete && grouped.complete && observed.every((operation) => operation.consistent);
  const ofKind = (kind: OperationKind) => observed.filter((operation) => operation.kind === kind);
  const tools = ofKind("tool");
  const toolNamesKnown = tools.every((operation) => operation.toolName !== null);
  const toolGroups = new Map<string | null, ObservedOperation[]>();
  for (const operation of tools) toolGroups.set(operation.toolName, [...toolGroups.get(operation.toolName) ?? [], operation]);
  for (const toolName of requestedTools) if (!toolGroups.has(toolName)) toolGroups.set(toolName, []);
  return {
    modelRequests: operationStatistics(ofKind("generation"), complete),
    trajectory: {
      coverage: coverage(complete, observed.length > 0),
      turns: operationStatistics(ofKind("turn"), complete),
      tools: operationStatistics(tools, complete),
      byTool: [...toolGroups.entries()]
        .map(([toolName, operations]) => toolMetric(toolName, operations, complete && (toolName === null || toolNamesKnown)))
        .sort((left, right) => (left.toolName ?? "").localeCompare(right.toolName ?? "")),
      ...trajectoryTurnMetrics(observed, complete, diagnostics),
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
    const key = operationKey(sessionId, operationId);
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
  const contentFlags = events.reduce((flags, entry) => {
    const projection = entry.metricProjection;
    const projected = projection?.version === TELEMETRY_PROJECTION_VERSION && typeof projection.markersKnown === "boolean";
    const detected = projected ? {
      thinking: projection?.hasThinking === true,
      content: projection?.hasContent === true,
      known: projection?.markersKnown === true,
    } : projection ? {
      thinking: false,
      content: false,
      known: false,
    } : telemetryContentFlags(entry.fact);
    return {
      thinking: flags.thinking || detected.thinking,
      content: flags.content || detected.content,
      known: flags.known && detected.known,
    };
  }, { thinking: false, content: false, known: true });
  const markerKnown = operation.kind === "tool" || contentFlags.known;
  return {
    kind: operation.kind,
    key: operation.key,
    status,
    duration: outcomes.size > 1 ? null : duration,
    toolName: toolNames.size === 1 ? [...toolNames][0] ?? null : null,
    parentKey: parents.size === 1 ? operationKey(operation.sessionId, [...parents][0]!) : null,
    hasThinking: contentFlags.thinking,
    hasContent: contentFlags.content,
    markerKnown,
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
    count: { value: observed.length > 0 || complete ? observed.length : null, coverage: coverage(complete, observed.length > 0) },
    completed: count("completed"),
    failed: count("failed"),
    cancelled: count("cancelled"),
    inProgress: count("inProgress"),
    unknown: count("unknown"),
    durationMs: summarizeNumbers(observed.map((item) => item.duration)),
  };
}

/** Marked Turn counts stay partial or unavailable while a generation cannot be assigned to a Turn. */
function markedTurnStatistics(
  turns: readonly ObservedOperation[],
  marked: ReadonlySet<string>,
  complete: boolean,
  generationLinksComplete: boolean,
  markerKnowledgeComplete: boolean,
): OperationStatistics {
  const statistics = operationStatistics(turns.filter((turn) => marked.has(turn.key)), complete && generationLinksComplete && markerKnowledgeComplete);
  if (!generationLinksComplete || !markerKnowledgeComplete) return statistics;
  if (statistics.count.value !== null || turns.length === 0) return statistics;
  return { ...statistics, count: { value: 0, coverage: "partial" } };
}

function bodyLength(entry: FactEntry | undefined, kind: "input" | "output"): number | null {
  if (entry?.metricProjection) {
    const value = entry.metricProjection[`${kind}Length`];
    return typeof value === "number" ? value : null;
  }
  const payload = record(entry?.fact.payload);
  return kind === "input" ? telemetryBodyLength(payload?.input)
    : telemetryBodyLength(payload?.output) ?? telemetryBodyLength(payload?.response);
}

function lengthSummary(values: readonly (number | null)[], complete: boolean): CoveredNumericSummary {
  const summary = summarizeNumbers(values);
  return { ...summary, coverage: coverage(complete && summary.missing === 0, summary.count > 0) };
}

function toolMetric(toolName: string | null, operations: readonly ObservedOperation[], complete: boolean): ToolMetric {
  return {
    toolName,
    ...operationStatistics(operations, complete),
    inputLength: lengthSummary(operations.map((operation) => bodyLength(operation.start, "input")), complete),
    outputLength: lengthSummary(operations.map((operation) => bodyLength(operation.terminal, "output")), complete),
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

/** Operations of one kind with the Turn each resolves to, and how many resolve to none. */
function linkToTurns(observed: readonly ObservedOperation[], kind: "tool" | "generation") {
  const byKey = new Map(observed.map((operation) => [operation.key, operation]));
  const linked = new Map<ObservedOperation, string>();
  let unlinked = 0;
  for (const operation of observed) {
    if (operation.kind !== kind) continue;
    const turn = owningTurn(operation, byKey);
    if (turn === null) unlinked += 1;
    else linked.set(operation, turn);
  }
  return { linked, unlinked };
}

function trajectoryTurnMetrics(
  observed: readonly ObservedOperation[],
  complete: boolean,
  diagnostics: ResourceDiagnostics,
): Pick<TrajectorySummary, "thinkingTurns" | "thinkingTurnOperations" | "contentTurns" | "contentTurnOperations" | "thinkingTurnTokens" | "contentTurnTokens" | "unlinkedOperations"> {
  const turns = observed.filter((operation) => operation.kind === "turn");
  const tools = linkToTurns(observed, "tool");
  const generations = linkToTurns(observed, "generation");
  const turnFlags = new Map(turns.map((turn) => [turn.key, { thinking: turn.hasThinking, content: turn.hasContent, known: turn.markerKnown }]));
  for (const [generation, turn] of generations.linked) {
    const flags = turnFlags.get(turn);
    if (!flags) continue;
    flags.thinking ||= generation.hasThinking;
    flags.content ||= generation.hasContent;
    flags.known &&= generation.markerKnown;
  }
  const thinking = new Set([...turnFlags].filter(([, flags]) => flags.thinking).map(([key]) => key));
  const content = new Set([...turnFlags].filter(([, flags]) => flags.content).map(([key]) => key));
  const generationLinksComplete = generations.unlinked === 0;
  const generationMarkersComplete = generationLinksComplete && [...generations.linked.keys()].every((generation) => generation.markerKnown);
  const markerKnowledgeComplete = turns.every((turn) => turnFlags.get(turn.key)?.known === true) && generationMarkersComplete;
  const thinkingTurnOperations = markedTurnStatistics(turns, thinking, complete, generationLinksComplete, markerKnowledgeComplete);
  const contentTurnOperations = markedTurnStatistics(turns, content, complete, generationLinksComplete, markerKnowledgeComplete);
  const thinkingCount = thinkingTurnOperations.count;
  const contentCount = contentTurnOperations.count;
  const turnTokens = (marked: ReadonlySet<string>, markedCount: MetricNumber): ThinkingTurnTokens => {
    const markedGenerations = [...generations.linked].filter(([, turn]) => marked.has(turn)).map(([operation]) => operation);
    const tokensComplete = markedCount.coverage === "complete" && generationMarkersComplete;
    const tokens = (field: "inputTokens" | "outputTokens" | "totalTokens"): MetricNumber => markedCount.value === null
      ? { value: null, coverage: "unavailable" }
      : diagnostics.sum(markedGenerations.map((operation) => operation.terminal ?? operation.first), tokensComplete, "telemetryEvents", field, true, (entry) => (
        entry.fact.type === "generation.finished"
          ? diagnostics.number(entry, "telemetryEvents", record(entry.fact.payload)?.[field], field, true)
          : null
      ));
    return { input: tokens("inputTokens"), output: tokens("outputTokens"), total: tokens("totalTokens") };
  };
  return {
    thinkingTurns: thinkingCount,
    thinkingTurnOperations,
    contentTurns: contentCount,
    contentTurnOperations,
    thinkingTurnTokens: turnTokens(thinking, thinkingCount),
    contentTurnTokens: turnTokens(content, contentCount),
    unlinkedOperations: { tools: tools.unlinked, generations: generations.unlinked },
  };
}
