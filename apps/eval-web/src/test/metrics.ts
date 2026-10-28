import type { AgentMetricView, AggregatedResourceStatistics, CoveredNumericSummary, MetricNumber, MetricSummary, OperationDistributions, OperationStatistics, ResourceStatistics, StageStatistics } from "@/api-sdk/types";

const complete = (value: number) => ({ value, coverage: "complete" as const });
const numeric = { count: 0, missing: 0, total: null, min: null, max: null, mean: null, variance: null, median: null };
const operation = { count: complete(0), completed: 0, failed: 0, cancelled: 0, inProgress: 0, unknown: 0, durationMs: numeric };

export function resourceStatistics(patch: Partial<ResourceStatistics> = {}): ResourceStatistics {
  return {
    coverage: "complete",
    collections: { collected: 1, pending: 0, failed: 0, uncollected: 0, unsubmitted: 0, finalized: 1 },
    duplicateRecords: { usageEvents: 0, nativeRecords: 0, billingSettlements: 0 },
    overlappingUsageRecords: 0,
    tokens: { input: complete(100), output: complete(20), cacheRead: complete(70), cacheWrite: complete(10), reasoning: complete(5), total: complete(200) },
    cacheHitRate: complete(70 / 170),
    costs: { providerUsd: complete(0), modelDebitedUnits: complete(0), actionChargedUnits: complete(0), chargedUnits: complete(0), ratedUnits: complete(0), shortfallUnits: complete(0), platformOwnedUnits: complete(0) },
    modelRequests: operation,
    trajectory: { coverage: "complete", turns: operation, tools: operation, toolSuccessRate: { value: null, coverage: "complete" }, byTool: [], thinkingSteps: complete(0), thinkingStepOperations: operation, contentSteps: complete(0), contentStepOperations: operation, thinkingStepTokens: { input: complete(0), output: complete(0), total: complete(0) }, contentStepTokens: { input: complete(0), output: complete(0), total: complete(0) }, unlinkedOperations: { tools: 0, generations: 0 }, diagnostics: [] },
    byModel: [], diagnostics: [], ...patch,
  };
}

const stage: StageStatistics = {
  records: 1, statuses: { queued: 0, starting: 0, running: 0, retrying: 0, succeeded: 1, failed: 0, cancelled: 0 },
  terminalRecords: 1, successRate: 1, attempts: 1, restarts: 0, completedAttempts: 1, failedAttempts: 0, interruptedAttempts: 0, cancelledAttempts: 0,
  agentDurationMs: numeric, attemptDurationMs: numeric,
};

function observation(metric: MetricNumber): CoveredNumericSummary {
  const value = metric.value;
  return { count: value === null ? 0 : 1, missing: value === null ? 1 : 0, total: value, min: value, max: value, mean: value, variance: value === null ? null : 0, median: value, coverage: metric.coverage };
}
function observations<T extends { readonly [K in keyof T]: MetricNumber }>(metrics: T): { readonly [K in keyof T]: CoveredNumericSummary } {
  return Object.fromEntries(Object.entries(metrics).map(([key, metric]) => [key, observation(metric as MetricNumber)])) as { readonly [K in keyof T]: CoveredNumericSummary };
}
function operationObservations(value: OperationStatistics): OperationDistributions {
  return {
    count: observation(value.count),
    ...Object.fromEntries((["completed", "failed", "cancelled", "inProgress", "unknown"] as const).map((key) => [key, observation({ value: value.count.value === null ? null : value[key], coverage: value.count.coverage })])) as Omit<OperationDistributions, "count">,
  };
}

export function aggregatedResourceStatistics(resources: ResourceStatistics): AggregatedResourceStatistics {
  return { ...resources, distribution: {
    unit: "agent", records: 1, tokens: observations(resources.tokens), costs: observations(resources.costs),
    modelRequests: operationObservations(resources.modelRequests),
    trajectory: {
      turns: operationObservations(resources.trajectory.turns), tools: operationObservations(resources.trajectory.tools),
      thinkingSteps: observation(resources.trajectory.thinkingSteps),
      thinkingStepOperations: operationObservations(resources.trajectory.thinkingStepOperations),
      contentSteps: observation(resources.trajectory.contentSteps),
      contentStepOperations: operationObservations(resources.trajectory.contentStepOperations),
      thinkingStepTokens: observations(resources.trajectory.thinkingStepTokens), contentStepTokens: observations(resources.trajectory.contentStepTokens),
      byTool: resources.trajectory.byTool.map((tool) => ({ toolName: tool.toolName, operations: operationObservations(tool) })),
    },
    byModel: resources.byModel.map((model) => ({ provider: model.provider, model: model.model, tokens: observations(model.tokens), providerUsd: observation(model.providerUsd) })),
  } };
}

export function metricSummary(executionAgent: ResourceStatistics, evaluationAgents: ResourceStatistics): MetricSummary {
  return {
    counts: { datasets: 1, data: 1, projectSamples: 1, samplings: 1, evaluations: 1 },
    execution: stage, evaluation: stage, executionAgent: aggregatedResourceStatistics(executionAgent), evaluationAgents: aggregatedResourceStatistics(evaluationAgents),
    evaluationOutputs: { schema: null, coverage: "unavailable", evaluations: 1, validation: { valid: 0, invalid: 0, unavailable: 1 }, fields: [] },
  };
}

export function agentMetric(resources: ResourceStatistics): AgentMetricView {
  return {
    role: "subject", agentConfigRef: { ownerUserId: "owner", userAgentId: "agent" }, chatId: null, samplingId: "sampling", evaluationId: null,
    stage: { status: "succeeded" }, attempts: { count: 0, restarts: 0, items: [] }, firstStartedAt: null, lastCompletedAt: null,
    agentDurationMs: null, resources, artifacts: [], trajectory: null,
  };
}
