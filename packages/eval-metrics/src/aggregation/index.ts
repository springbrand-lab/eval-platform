import type { EvaluationAttempt, EvaluationRecord, ExecutionAttempt, SamplingStatus } from "@eval-platform/eval-contracts";
import { SAMPLING_STATUSES } from "@eval-platform/eval-contracts";
import type { SamplingSnapshot } from "@eval-platform/eval-runtime";
import type { EvaluationOutputReader } from "../evaluators/index.js";
import { agentSpan, attemptDuration, attemptResources } from "./agents.js";
import type { MetricCounts, MetricSummary, StageStatistics } from "./model.js";
import { summarizeNumericOutputs } from "./numeric-outputs.js";
import { aggregateResources } from "./resources.js";
import { summarizeNumbers } from "./statistics.js";

export interface MetricInput {
  /** Fixed bindings of the level being summarized. */
  readonly bindings: Pick<MetricCounts, "datasets" | "data" | "projectSamples">;
  readonly samplings: readonly SamplingSnapshot[];
  readonly evaluations: readonly EvaluationRecord[];
  readonly outputs: EvaluationOutputReader;
}

interface StageRecord {
  readonly status: SamplingStatus;
  readonly attempts: readonly (ExecutionAttempt | EvaluationAttempt)[];
}

function stageStatistics(records: readonly StageRecord[]): StageStatistics {
  const statuses = Object.fromEntries(SAMPLING_STATUSES.map((status) => [status, 0])) as Record<SamplingStatus, number>;
  for (const item of records) statuses[item.status] += 1;
  const terminalRecords = statuses.succeeded + statuses.failed + statuses.cancelled;
  const attempts = records.flatMap((item) => item.attempts);
  const attemptsWith = (status: string) => attempts.filter((attempt) => attempt.status === status).length;
  return {
    records: records.length, statuses, terminalRecords,
    successRate: terminalRecords === 0 ? null : statuses.succeeded / terminalRecords,
    attempts: attempts.length,
    restarts: records.reduce((total, item) => total + Math.max(0, item.attempts.length - 1), 0),
    completedAttempts: attemptsWith("completed"),
    failedAttempts: attemptsWith("failed"),
    interruptedAttempts: attemptsWith("interrupted"),
    cancelledAttempts: attemptsWith("cancelled"),
    agentDurationMs: summarizeNumbers(records.map((item) => agentSpan(item.attempts).agentDurationMs)),
    attemptDurationMs: summarizeNumbers(attempts.map(attemptDuration)),
  };
}

/** Summarizes one level directly from its raw Samplings, EvaluationRecords and Attempt resources. */
export function aggregateMetrics(input: MetricInput): MetricSummary {
  return {
    counts: { ...input.bindings, samplings: input.samplings.length, evaluations: input.evaluations.length },
    execution: stageStatistics(input.samplings.map((sampling) => ({ status: sampling.execution.status, attempts: sampling.executionAttempts }))),
    evaluation: stageStatistics(input.evaluations.map((evaluation) => ({ status: evaluation.status.status, attempts: evaluation.attempts }))),
    executionAgent: aggregateResources(input.samplings.flatMap((sampling) => attemptResources(sampling.subjectAgent.ownerUserId, sampling.executionAttempts))),
    evaluationAgents: aggregateResources(input.evaluations.flatMap((evaluation) => attemptResources(evaluation.evaluator.ownerUserId, evaluation.attempts))),
    numericOutputs: summarizeNumericOutputs(input.outputs, input.evaluations),
  };
}
