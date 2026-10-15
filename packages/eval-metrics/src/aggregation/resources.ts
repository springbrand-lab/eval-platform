import type { AgentResourceScope, AgentResourceSnapshot, JsonValue } from "@eval-platform/eval-contracts";
import { equalJson } from "@springbrand/utils";
import type {
  MetricNumber,
  ModelStatistics,
  OperationStatistics,
  ResourceDiagnostic,
  ResourceInput,
  ResourceStatistics,
  TokenStatistics,
} from "./model.js";
import { summarizeNumbers } from "./statistics.js";

type Stream = ResourceDiagnostic["stream"];
type JsonRecord = Readonly<Record<string, JsonValue>>;

interface FactEntry {
  readonly fact: JsonRecord;
  readonly ownerUserId: string;
  readonly scope: AgentResourceScope;
}

interface FactStream {
  readonly entries: readonly FactEntry[];
  readonly complete: boolean;
  readonly duplicates: number;
}

interface ObservedOperation {
  readonly events: FactEntry[];
}

function record(value: JsonValue | undefined): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function identity(...values: readonly string[]): string {
  return JSON.stringify(values);
}

export function aggregateResources(inputs: readonly ResourceInput[]): ResourceStatistics {
  const diagnostics: ResourceDiagnostic[] = [];
  const collections = { collected: 0, pending: 0, failed: 0, unsubmitted: 0, finalized: 0 };
  const snapshots: { readonly ownerUserId: string; readonly snapshot: AgentResourceSnapshot }[] = [];
  for (const input of inputs) {
    const collection = input.collection;
    if (!collection) {
      collections.unsubmitted += 1;
    } else if (collection.status === "collected") {
      collections.collected += 1;
      if (collection.snapshot.finalized) collections.finalized += 1;
      snapshots.push({ ownerUserId: input.ownerUserId, snapshot: collection.snapshot });
    } else {
      collections[collection.status] += 1;
    }
  }

  const diagnose = (kind: ResourceDiagnostic["kind"], stream: Stream, entry: FactEntry, message: string): void => {
    const eventId = text(entry.fact.eventId);
    diagnostics.push({ kind, stream, scope: { ...entry.scope }, message, ...(eventId === undefined ? {} : { eventId }) });
  };

  const readStream = (stream: Stream): FactStream => {
    let complete = snapshots.length > 0 && collections.pending === 0 && collections.failed === 0;
    let duplicates = 0;
    const byIdentity = new Map<string, FactEntry | null>();
    for (const { ownerUserId, snapshot } of snapshots) {
      if (!snapshot.finalized || snapshot.coverage[stream] !== "complete") complete = false;
      for (const rawFact of snapshot[stream]) {
        const fact = stream === "telemetryEvents" ? record(rawFact.event) ?? rawFact : rawFact;
        const entry = { fact, ownerUserId, scope: snapshot.scope };
        const eventId = text(fact.eventId);
        const sessionId = text(record(fact.resource)?.sessionId);
        const accountId = text(fact.accountId);
        const executionId = text(fact.executionId);
        const key = stream === "usageEvents"
          ? eventId ? identity(ownerUserId, eventId) : undefined
          : stream === "telemetryEvents"
            ? eventId && sessionId ? identity(sessionId, eventId) : undefined
            : executionId ? identity("action", executionId)
              : accountId && eventId ? identity("model", accountId, eventId) : undefined;
        if (key === undefined) {
          complete = false;
          diagnose("missing-identity", stream, entry, `Cannot identify ${stream} record`);
          continue;
        }
        const existing = byIdentity.get(key);
        if (existing !== undefined) {
          duplicates += 1;
          if (existing && !equalJson(existing.fact, fact)) {
            complete = false;
            diagnose("conflicting-identity", stream, entry, "The same source identity has contradictory facts");
            byIdentity.set(key, null);
          }
          continue;
        }
        byIdentity.set(key, entry);
      }
    }
    return { entries: [...byIdentity.values()].filter((entry) => entry !== null), complete, duplicates };
  };

  const numeric = (entry: FactEntry, stream: Stream, value: JsonValue | undefined, field: string, integer: boolean): number | null => {
    if (value === undefined || value === null) return null;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER && (!integer || Number.isSafeInteger(value))) return value;
    diagnose("invalid-value", stream, entry, `Invalid ${field}`);
    return null;
  };
  const sum = (entries: readonly FactEntry[], complete: boolean, stream: Stream, field: string, integer: boolean,
    read: (entry: FactEntry) => number | null): MetricNumber => {
    if (entries.length === 0) return { value: complete ? 0 : null, coverage: complete ? "complete" : "unavailable" };
    const values = entries.map(read);
    const available = values.filter((value): value is number => value !== null);
    if (available.length === 0) return { value: null, coverage: "unavailable" };
    const total = available.reduce((previous, value) => previous + value, 0);
    if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(total))) {
      diagnose("invalid-value", stream, entries[0]!, `${field} aggregate exceeds the safe number range`);
      return { value: null, coverage: "unavailable" };
    }
    return { value: total, coverage: complete && available.length === values.length ? "complete" : "partial" };
  };

  const usage = readStream("usageEvents");
  const telemetry = readStream("telemetryEvents");
  const billing = readStream("billingSettlements");
  let usageComplete = usage.complete;
  const knownUsage = usage.entries.filter((entry) => {
    const kind = text(entry.fact.kind);
    if (kind && ["assistant_model", "compaction", "subagent", "chat_title"].includes(kind)) {
      if (!text(entry.fact.runId)) {
        usageComplete = false;
        diagnose("missing-identity", "usageEvents", entry, "Usage has no run identity");
        return false;
      }
      if (kind === "subagent" && (!text(entry.fact.subagentRunId) || !text(entry.fact.parentRunId))) {
        usageComplete = false;
        diagnose("missing-identity", "usageEvents", entry, "Subagent usage has no complete child/parent identity");
        return false;
      }
      return true;
    }
    usageComplete = false;
    diagnose("unsupported-record", "usageEvents", entry, "Unsupported usage kind");
    return false;
  });
  const summaryGroups = new Map<string, FactEntry[]>();
  for (const entry of knownUsage.filter((item) => item.fact.kind === "subagent")) {
    const key = identity(entry.ownerUserId, text(entry.fact.subagentRunId)!);
    const group = summaryGroups.get(key) ?? [];
    group.push(entry);
    summaryGroups.set(key, group);
  }
  const ambiguousSummaries = new Set<FactEntry>();
  const parentByRun = new Map<string, string>();
  for (const [key, entries] of summaryGroups) {
    const parents = new Set(entries.map((entry) => text(entry.fact.parentRunId)!));
    if (parents.size === 1) parentByRun.set(key, entries[0]!.fact.parentRunId as string);
    if (entries.length > 1) {
      usageComplete = false;
      for (const entry of entries) {
        ambiguousSummaries.add(entry);
        diagnose("conflicting-identity", "usageEvents", entry, "A child run has multiple distinct usage summaries");
      }
    }
  }
  for (const [key, entries] of summaryGroups) {
    const seen = new Set<string>();
    let current: string | undefined = key;
    while (current && !seen.has(current)) {
      seen.add(current);
      const parent = parentByRun.get(current);
      current = parent ? identity(entries[0]!.ownerUserId, parent) : undefined;
    }
    if (current) {
      usageComplete = false;
      for (const entry of entries) {
        ambiguousSummaries.add(entry);
        diagnose("conflicting-identity", "usageEvents", entry, "Subagent parent relationships contain a cycle");
      }
    }
  }
  type UsageMetric = "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens" | "totalTokens" | "providerUsd";
  const valueCache = new Map<FactEntry, Map<UsageMetric, number | null>>();
  const readUsageMetric = (entry: FactEntry, metric: UsageMetric): number | null => {
    const cached = valueCache.get(entry)?.get(metric);
    if (cached !== undefined) return cached;
    let value: number | null;
    if (metric === "providerUsd") {
      value = numeric(entry, "usageEvents", record(entry.fact.providerCostUsd)?.total, "providerCostUsd.total", false);
    } else if (metric !== "totalTokens") {
      value = numeric(entry, "usageEvents", record(entry.fact.metrics)?.[metric], metric, true);
    } else {
      const metrics = record(entry.fact.metrics);
      if (metrics?.totalTokens !== undefined) {
        value = numeric(entry, "usageEvents", metrics.totalTokens, "totalTokens", true);
      } else {
        const buckets = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]
          .map((field) => numeric(entry, "usageEvents", metrics?.[field], field, true));
        if (buckets.some((item) => item === null)) {
          value = null;
        } else {
          const total = buckets.reduce<number>((previous, item) => previous + item!, 0);
          if (!Number.isSafeInteger(total)) {
            diagnose("invalid-value", "usageEvents", entry, "Total token buckets exceed the safe integer range");
            value = null;
          } else {
            value = total;
          }
        }
      }
    }
    const values = valueCache.get(entry) ?? new Map<UsageMetric, number | null>();
    values.set(metric, value);
    valueCache.set(entry, values);
    return value;
  };
  const summaryCovers = (ownerUserId: string, runId: string, metric: UsageMetric): boolean => {
    const summaries = summaryGroups.get(identity(ownerUserId, runId));
    return summaries !== undefined
      && summaries.length === 1
      && !ambiguousSummaries.has(summaries[0]!)
      && readUsageMetric(summaries[0]!, metric) !== null;
  };
  const metricEntries = (metric: UsageMetric): readonly FactEntry[] => knownUsage.filter((entry) => {
    if (ambiguousSummaries.has(entry)) return false;
    const isSummary = entry.fact.kind === "subagent";
    const seen = new Set<string>();
    let current = text(isSummary ? entry.fact.parentRunId : entry.fact.runId);
    while (current && !seen.has(current)) {
      const key = identity(entry.ownerUserId, current);
      if (summaryCovers(entry.ownerUserId, current, metric)) return false;
      seen.add(current);
      current = parentByRun.get(key);
    }
    return true;
  });
  const selectedTotalUsage = metricEntries("totalTokens");
  const selectedTotalUsageSet = new Set(selectedTotalUsage);
  const tokenStatistics = (entriesForGroup?: readonly FactEntry[]): TokenStatistics => {
    const group = entriesForGroup === undefined ? undefined : new Set(entriesForGroup);
    const entriesFor = (metric: UsageMetric): readonly FactEntry[] => metricEntries(metric)
      .filter((entry) => group === undefined || group.has(entry));
    const metric = (field: UsageMetric): MetricNumber => sum(entriesFor(field), usageComplete, "usageEvents", field, true,
      (entry) => readUsageMetric(entry, field));
    return {
      input: metric("inputTokens"), output: metric("outputTokens"), cacheRead: metric("cacheReadTokens"),
      cacheWrite: metric("cacheWriteTokens"), reasoning: metric("reasoningTokens"),
      total: sum(entriesFor("totalTokens"), usageComplete, "usageEvents", "totalTokens", true,
        (entry) => readUsageMetric(entry, "totalTokens")),
    };
  };
  const providerCost = (entriesForGroup?: readonly FactEntry[]): MetricNumber => {
    const group = entriesForGroup === undefined ? undefined : new Set(entriesForGroup);
    return sum(metricEntries("providerUsd").filter((entry) => group === undefined || group.has(entry)), usageComplete,
      "usageEvents", "providerUsd", false, (entry) => readUsageMetric(entry, "providerUsd"));
  };
  const selectedUsage = [...new Set([
    ...metricEntries("inputTokens"), ...metricEntries("outputTokens"), ...metricEntries("cacheReadTokens"),
    ...metricEntries("cacheWriteTokens"), ...metricEntries("reasoningTokens"), ...metricEntries("totalTokens"),
    ...metricEntries("providerUsd"),
  ])];
  const modelGroups = new Map<string, { provider: string | null; model: string | null; entries: FactEntry[] }>();
  for (const entry of selectedUsage) {
    const metadata = record(entry.fact.providerMetadata);
    const provider = text(metadata?.provider) ?? null;
    const model = text(metadata?.model) ?? null;
    const key = JSON.stringify([provider, model]);
    const group = modelGroups.get(key) ?? { provider, model, entries: [] };
    group.entries.push(entry);
    modelGroups.set(key, group);
  }
  const byModel: ModelStatistics[] = [...modelGroups.values()].map((group) => ({
    provider: group.provider,
    model: group.model,
    usageRecords: group.entries.filter((entry) => selectedTotalUsageSet.has(entry)).length,
    tokens: tokenStatistics(group.entries), providerUsd: providerCost(group.entries),
  })).sort((left, right) => JSON.stringify([left.provider, left.model]).localeCompare(JSON.stringify([right.provider, right.model])));

  const modelBills: FactEntry[] = [];
  const actionBills: FactEntry[] = [];
  let billingComplete = billing.complete;
  for (const entry of billing.entries) {
    if (text(entry.fact.executionId)) {
      if (entry.fact.status === "running") {
        billingComplete = false;
      } else if (["succeeded", "failed", "outcome_unknown"].includes(text(entry.fact.status) ?? "")) {
        actionBills.push(entry);
      } else {
        billingComplete = false;
        diagnose("unsupported-record", "billingSettlements", entry, "Unsupported Action settlement status");
      }
    } else if (["settled", "platform_owned", "anomaly"].includes(text(entry.fact.status) ?? "")) {
      modelBills.push(entry);
    } else {
      billingComplete = false;
      diagnose("unsupported-record", "billingSettlements", entry, "Unsupported settlement record");
    }
  }
  const billingField = (entries: readonly FactEntry[], field: string,
    read: (entry: FactEntry) => JsonValue | undefined): MetricNumber => sum(entries, billingComplete, "billingSettlements", field, true,
    (entry) => numeric(entry, "billingSettlements", read(entry), field, true));
  const modelDebitedUnits = billingField(modelBills, "debitedUnits", (entry) => entry.fact.debitedUnits);
  const actionChargedUnits = billingField(actionBills, "chargedCredits", (entry) => entry.fact.chargedCredits);
  const chargedUnits = sum([...modelBills, ...actionBills], billingComplete, "billingSettlements", "chargedUnits", true, (entry) => numeric(
    entry, "billingSettlements", text(entry.fact.executionId) ? entry.fact.chargedCredits : entry.fact.debitedUnits,
    "chargedUnits", true,
  ));

  let telemetryComplete = telemetry.complete;
  const operations = new Map<string, ObservedOperation & { kind: "generation" | "turn" | "tool" }>();
  const conflictingOperations = new Set<string>();
  const operationTypes = new Set([
    "generation.started", "generation.finished",
    "turn.admitted", "turn.started", "turn.steered", "turn.recovering", "turn.cancelled", "turn.finished",
    "tool.started", "tool.finished",
  ]);
  for (const entry of telemetry.entries) {
    const type = text(entry.fact.type);
    const kind = type?.startsWith("generation.") ? "generation" : type?.startsWith("turn.") ? "turn" : type?.startsWith("tool.") ? "tool" : undefined;
    if (!type || (kind && !operationTypes.has(type))) {
      telemetryComplete = false;
      diagnose("unsupported-record", "telemetryEvents", entry, "Unsupported telemetry event type");
      continue;
    }
    if (!kind) continue;
    const operationId = text(entry.fact.operationId);
    const sessionId = text(record(entry.fact.resource)?.sessionId);
    if (!operationId || !sessionId) {
      telemetryComplete = false;
      diagnose("missing-identity", "telemetryEvents", entry, "Telemetry record has no operation identity");
      continue;
    }
    const key = identity(sessionId, operationId);
    if (conflictingOperations.has(key)) continue;
    const existing = operations.get(key);
    if (existing && existing.kind !== kind) {
      telemetryComplete = false;
      diagnose("conflicting-identity", "telemetryEvents", entry, "An operation identity has different operation kinds");
      conflictingOperations.add(key);
      operations.delete(key);
      continue;
    }
    const group = existing ?? { kind, events: [] as FactEntry[] };
    group.events.push(entry);
    operations.set(key, group);
  }

  const inspectOperation = (operation: ObservedOperation) => {
    const events = operation.events.toSorted((left, right) => {
      const leftTime = typeof left.fact.occurredAt === "number" ? left.fact.occurredAt : 0;
      const rightTime = typeof right.fact.occurredAt === "number" ? right.fact.occurredAt : 0;
      return leftTime - rightTime;
    });
    const start = events.find((entry) => text(entry.fact.type)?.endsWith(".started"));
    const terminals = events.filter((entry) => {
      const type = text(entry.fact.type);
      return type?.endsWith(".finished") || type?.endsWith(".cancelled");
    });
    const terminal = terminals.at(-1);
    const payload = record(terminal?.fact.payload);
    const outcomes = new Set(terminals.map((entry) => entry.fact.type === "turn.cancelled" ? "cancelled" : text(record(entry.fact.payload)?.outcome)));
    const outcome = outcomes.size === 1 ? [...outcomes][0] : undefined;
    if (outcomes.size > 1) {
      telemetryComplete = false;
      diagnose("conflicting-identity", "telemetryEvents", terminal!, "An operation has contradictory terminal outcomes");
    }
    const status = !terminal ? "inProgress" : outcome === "completed" || outcome === "failed" || outcome === "cancelled" ? outcome : "unknown";
    let duration: number | null = null;
    if (terminal && payload?.durationMs !== undefined && payload.durationMs !== null) {
      duration = numeric(terminal, "telemetryEvents", payload.durationMs, "durationMs", false);
    } else if (start && terminal) {
      const startTime = numeric(start, "telemetryEvents", start.fact.occurredAt, "occurredAt", false);
      const endTime = numeric(terminal, "telemetryEvents", terminal.fact.occurredAt, "occurredAt", false);
      if (startTime !== null && endTime !== null) {
        if (endTime >= startTime) duration = endTime - startTime;
        else diagnose("invalid-value", "telemetryEvents", terminal, "Operation ended before it started");
      }
    }
    const toolNames = new Set(events.map((entry) => text(record(entry.fact.payload)?.toolName)).filter((name) => name !== undefined));
    if (toolNames.size > 1) {
      telemetryComplete = false;
      diagnose("conflicting-identity", "telemetryEvents", events[0]!, "An operation has contradictory tool names");
    }
    const toolName = toolNames.size === 1 ? [...toolNames][0]! : null;
    return { status, duration: outcomes.size > 1 ? null : duration, toolName };
  };
  const observedOperations = [...operations.values()].map((operation) => ({ kind: operation.kind, ...inspectOperation(operation) }));
  const operationStatistics = (observed: readonly ReturnType<typeof inspectOperation>[]): OperationStatistics => {
    return {
      count: {
        value: observed.length > 0 || telemetryComplete ? observed.length : null,
        coverage: telemetryComplete ? "complete" : observed.length > 0 ? "partial" : "unavailable",
      },
      completed: observed.filter((item) => item.status === "completed").length,
      failed: observed.filter((item) => item.status === "failed").length,
      cancelled: observed.filter((item) => item.status === "cancelled").length,
      inProgress: observed.filter((item) => item.status === "inProgress").length,
      unknown: observed.filter((item) => item.status === "unknown").length,
      durationMs: summarizeNumbers(observed.map((item) => item.duration)),
    };
  };
  const toolOperations = observedOperations.filter((operation) => operation.kind === "tool");
  const toolGroups = new Map<string | null, ReturnType<typeof inspectOperation>[]>();
  for (const operation of toolOperations) {
    const group = toolGroups.get(operation.toolName) ?? [];
    group.push(operation);
    toolGroups.set(operation.toolName, group);
  }
  return {
    collections,
    duplicateRecords: { usageEvents: usage.duplicates, telemetryEvents: telemetry.duplicates, billingSettlements: billing.duplicates },
    overlappingUsageRecords: knownUsage.length - selectedTotalUsage.length - ambiguousSummaries.size,
    tokens: tokenStatistics(),
    costs: {
      providerUsd: providerCost(selectedUsage), modelDebitedUnits, actionChargedUnits, chargedUnits,
      ratedUnits: billingField(modelBills, "ratedUnits", (entry) => entry.fact.ratedUnits),
      shortfallUnits: billingField(modelBills, "shortfallUnits", (entry) => entry.fact.shortfallUnits),
      platformOwnedUnits: billingField(modelBills, "platformOwnedUnits", (entry) => record(entry.fact.platformOwned)?.units),
    },
    modelRequests: operationStatistics(observedOperations.filter((operation) => operation.kind === "generation")),
    turns: operationStatistics(observedOperations.filter((operation) => operation.kind === "turn")),
    tools: operationStatistics(toolOperations),
    byTool: [...toolGroups.entries()].map(([toolName, groups]) => ({ toolName, ...operationStatistics(groups) }))
      .sort((left, right) => (left.toolName ?? "").localeCompare(right.toolName ?? "")),
    byModel,
    diagnostics: [...new Map(diagnostics.map((diagnostic) => [JSON.stringify(diagnostic), diagnostic])).values()],
  };
}
