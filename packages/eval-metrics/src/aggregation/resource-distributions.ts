import type {
  AggregatedResourceStatistics, CoveredNumericSummary, MetricNumber, NumericDistributions,
  OperationDistributions, OperationStatistics, ResourceDistribution, ResourceStatistics,
} from "./model.js";
import { aggregateResources, type ResourceInput } from "./resources.js";
import { coverage, summarizeNumbers } from "./statistics.js";

const OUTCOMES = ["completed", "failed", "cancelled", "inProgress", "unknown"] as const;
type OperationCounts = Pick<OperationStatistics, "count" | (typeof OUTCOMES)[number]>;

function distribution(values: readonly MetricNumber[]): CoveredNumericSummary {
  const summary = summarizeNumbers(values.map((item) => item.value));
  return { ...summary, coverage: coverage(values.length > 0 && values.every((item) => item.coverage === "complete"), summary.count > 0) };
}

function fields<T extends { readonly [K in keyof T]: MetricNumber }>(template: T, values: readonly T[]): NumericDistributions<T> {
  return Object.fromEntries((Object.keys(template) as (keyof T)[]).map((key) => [key, distribution(values.map((item) => item[key]))])) as NumericDistributions<T>;
}

function operations(values: readonly OperationCounts[]): OperationDistributions {
  return {
    count: distribution(values.map((item) => item.count)),
    ...Object.fromEntries(OUTCOMES.map((key) => [key, distribution(values.map((item) => ({
      value: item.count.value === null ? null : item[key], coverage: item.count.coverage,
    })))])) as Omit<OperationDistributions, "count">,
  };
}

function resourceDistribution(totals: ResourceStatistics, agents: readonly ResourceStatistics[]): ResourceDistribution {
  return {
    unit: "agent", records: agents.length,
    tokens: fields(totals.tokens, agents.map((item) => item.tokens)),
    costs: fields(totals.costs, agents.map((item) => item.costs)),
    modelRequests: operations(agents.map((item) => item.modelRequests)),
    trajectory: {
      turns: operations(agents.map((item) => item.trajectory.turns)),
      tools: operations(agents.map((item) => item.trajectory.tools)),
      thinkingTurns: distribution(agents.map((item) => item.trajectory.thinkingTurns)),
      thinkingTurnOperations: operations(agents.map((item) => item.trajectory.thinkingTurnOperations)),
      contentTurns: distribution(agents.map((item) => item.trajectory.contentTurns)),
      contentTurnOperations: operations(agents.map((item) => item.trajectory.contentTurnOperations)),
      thinkingTurnTokens: fields(totals.trajectory.thinkingTurnTokens, agents.map((item) => item.trajectory.thinkingTurnTokens)),
      contentTurnTokens: fields(totals.trajectory.contentTurnTokens, agents.map((item) => item.trajectory.contentTurnTokens)),
      byTool: totals.trajectory.byTool.map(({ toolName }) => ({
        toolName,
        operations: operations(agents.map((item) => item.trajectory.byTool.find((tool) => tool.toolName === toolName)!)),
      })),
    },
    byModel: totals.byModel.map(({ provider, model, tokens }) => {
      const models = agents.map((item) => item.byModel.find((entry) => entry.provider === provider && entry.model === model)!);
      return {
        provider, model,
        tokens: fields(tokens, models.map((item) => item.tokens)),
        providerUsd: distribution(models.map((item) => item.providerUsd)),
      };
    }),
  };
}

/** Interpret each Agent's original Attempts once for observations; scope totals independently deduplicate all raw facts. */
export function aggregateAgentResources(groups: readonly (readonly ResourceInput[])[]): AggregatedResourceStatistics {
  const totals = aggregateResources(groups.flat());
  const domains = { models: totals.byModel, tools: totals.trajectory.byTool.map((tool) => tool.toolName) };
  const agents = groups.map((group) => aggregateResources(group, domains));
  return { ...totals, distribution: resourceDistribution(totals, agents) };
}
