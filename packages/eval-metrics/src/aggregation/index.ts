import type { AgentConfigRef, EvaluationRecord, ExecutionAttempt, EvaluationAttempt, SamplingStatus } from "@eval-platform/eval-contracts";
import { readEvaluationMetrics } from "../evaluators/index.js";
import type { EvaluatorScoreStatistics, MetricInput, MetricSummary, ResourceInput, StageStatistics } from "./model.js";
import { aggregateResources } from "./resources.js";
import { summarizeNumbers } from "./statistics.js";

export type * from "./model.js";
export { aggregateResources } from "./resources.js";
export { summarizeNumbers } from "./statistics.js";

interface StageRecord {
  readonly status: SamplingStatus;
  readonly attempts: readonly (ExecutionAttempt | EvaluationAttempt)[];
}

function stageStatistics(records: readonly StageRecord[]): StageStatistics {
  const statuses: Record<SamplingStatus, number> = { queued: 0, starting: 0, running: 0, retrying: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const item of records) statuses[item.status] += 1;
  const terminalRecords = statuses.succeeded + statuses.failed + statuses.cancelled;
  const attempts = records.flatMap((item) => item.attempts);
  const durations = records.map((item) => {
    if (item.status !== "succeeded" && item.status !== "failed" && item.status !== "cancelled") return null;
    if (item.attempts.length === 0) return null;
    const starts = item.attempts.map((attempt) => attempt.startedAt === undefined ? NaN : Date.parse(attempt.startedAt));
    const ends = item.attempts.map((attempt) => attempt.completedAt === undefined ? NaN : Date.parse(attempt.completedAt));
    if (starts.some((value, index) => !Number.isFinite(value) || !Number.isFinite(ends[index]) || ends[index]! < value)) return null;
    const start = starts.reduce((earliest, value) => Math.min(earliest, value), Infinity);
    const end = ends.reduce((latest, value) => Math.max(latest, value), -Infinity);
    return end >= start ? end - start : null;
  });
  return {
    records: records.length, statuses, terminalRecords,
    successRate: terminalRecords === 0 ? null : statuses.succeeded / terminalRecords,
    attempts: attempts.length,
    restarts: records.reduce((total, item) => total + Math.max(0, item.attempts.length - 1), 0),
    completedAttempts: attempts.filter((attempt) => attempt.status === "completed").length,
    failedAttempts: attempts.filter((attempt) => attempt.status === "failed").length,
    interruptedAttempts: attempts.filter((attempt) => attempt.status === "interrupted").length,
    cancelledAttempts: attempts.filter((attempt) => attempt.status === "cancelled").length,
    agentDurationMs: summarizeNumbers(durations),
  };
}

function scoreStatistics(evaluations: readonly EvaluationRecord[]): readonly EvaluatorScoreStatistics[] {
  const groups = new Map<string, { readonly evaluator: AgentConfigRef; readonly evaluations: EvaluationRecord[] }>();
  for (const evaluation of evaluations) {
    const key = JSON.stringify([evaluation.evaluator.ownerUserId, evaluation.evaluator.userAgentId]);
    const group = groups.get(key) ?? { evaluator: evaluation.evaluator, evaluations: [] };
    group.evaluations.push(evaluation);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const results = group.evaluations.map(readEvaluationMetrics);
    return {
      evaluator: structuredClone(group.evaluator), evaluations: results.length,
      unavailable: results.filter((result) => result.score.status === "unavailable").length,
      invalid: results.filter((result) => result.score.status === "invalid").length,
      scores: summarizeNumbers(results.map((result) => result.score.value)),
    };
  }).sort((left, right) => JSON.stringify([left.evaluator.ownerUserId, left.evaluator.userAgentId])
    .localeCompare(JSON.stringify([right.evaluator.ownerUserId, right.evaluator.userAgentId])));
}

export function aggregateMetrics(input: MetricInput): MetricSummary {
  const samplings = new Map(input.samplings.map((sampling) => [sampling.samplingId, sampling]));
  if (samplings.size !== input.samplings.length) throw new Error("Duplicate Sampling identity in metric input");
  const evaluationIds = new Set(input.evaluations.map((evaluation) => evaluation.evaluationId));
  if (evaluationIds.size !== input.evaluations.length) throw new Error("Duplicate Evaluation identity in metric input");
  if (input.evaluations.some((evaluation) => !samplings.has(evaluation.samplingId))) throw new Error("Evaluation does not belong to the metric Sampling scope");
  const executionResources: ResourceInput[] = input.samplings.flatMap((sampling) => sampling.executionAttempts.map((attempt) => ({
    ownerUserId: sampling.subjectAgent.ownerUserId, collection: attempt.resources,
  })));
  const evaluationResources: ResourceInput[] = input.evaluations.flatMap((evaluation) => evaluation.attempts.map((attempt) => ({
    ownerUserId: evaluation.evaluator.ownerUserId, collection: attempt.resources,
  })));
  return {
    samplingCount: input.samplings.length, evaluationCount: input.evaluations.length,
    execution: stageStatistics(input.samplings.map((sampling) => ({ status: sampling.execution.status, attempts: sampling.executionAttempts }))),
    evaluation: stageStatistics(input.evaluations.map((evaluation) => ({ status: evaluation.status.status, attempts: evaluation.attempts }))),
    scores: scoreStatistics(input.evaluations),
    resources: {
      execution: aggregateResources(executionResources), evaluation: aggregateResources(evaluationResources),
      total: aggregateResources([...executionResources, ...evaluationResources]),
    },
  };
}
