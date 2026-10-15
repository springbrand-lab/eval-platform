import {
  isTerminalAgentStatus,
  type EvaluationAttempt,
  type EvaluationRecord,
  type ExecutionAttempt,
} from "@eval-platform/eval-contracts";
import type { SamplingSnapshot } from "@eval-platform/eval-runtime";
import type { AgentMetricView, AttemptMetric, ResourceInput } from "./model.js";
import { aggregateResources } from "./resources.js";

type Attempt = ExecutionAttempt | EvaluationAttempt;

function time(value: string | undefined): number {
  return value === undefined ? NaN : Date.parse(value);
}

export function attemptDuration(attempt: Attempt): number | null {
  const start = time(attempt.startedAt);
  const end = time(attempt.completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

/** Raw resource inputs of one Agent's Attempts; a submitted Attempt without collection is a gap. */
export function attemptResources(ownerUserId: string, attempts: readonly Attempt[]): readonly ResourceInput[] {
  return attempts.map((attempt) => ({ ownerUserId, collection: attempt.resources, submitted: attempt.submissionId !== undefined }));
}

/** First valid start to last terminal completion; null while the latest Attempt is not terminal. */
export function agentSpan(attempts: readonly Attempt[]): Pick<AgentMetricView, "firstStartedAt" | "lastCompletedAt" | "agentDurationMs"> {
  const ordered = attempts.toSorted((left, right) => left.attemptNumber - right.attemptNumber);
  const extreme = (values: readonly (string | undefined)[], pick: (left: number, right: number) => boolean) => values
    .filter((value): value is string => Number.isFinite(time(value)))
    .reduce<string | null>((chosen, value) => chosen === null || pick(time(value), time(chosen)) ? value : chosen, null);
  const firstStartedAt = extreme(ordered.map((attempt) => attempt.startedAt), (left, right) => left < right);
  const latest = ordered.at(-1);
  const lastCompletedAt = latest && isTerminalAgentStatus(latest.status)
    ? extreme(ordered.filter((attempt) => isTerminalAgentStatus(attempt.status)).map((attempt) => attempt.completedAt), (left, right) => left > right)
    : null;
  const duration = firstStartedAt === null || lastCompletedAt === null ? null : time(lastCompletedAt) - time(firstStartedAt);
  return { firstStartedAt, lastCompletedAt, agentDurationMs: duration !== null && duration >= 0 ? duration : null };
}

function attemptMetric(attemptId: string, attempt: Attempt): AttemptMetric {
  const collection = attempt.resources;
  return {
    attemptId, attemptNumber: attempt.attemptNumber, status: attempt.status,
    submissionId: attempt.submissionId ?? null, startedAt: attempt.startedAt ?? null, completedAt: attempt.completedAt ?? null,
    durationMs: attemptDuration(attempt), error: attempt.error ?? null,
    resourceCollection: collection ? collection.status : attempt.submissionId === undefined ? "unsubmitted" : "uncollected",
  };
}

function agentView(
  base: Pick<AgentMetricView, "role" | "agentConfigRef" | "chatId" | "samplingId" | "evaluationId" | "stage" | "artifacts" | "trajectory">,
  attempts: readonly AttemptMetric[],
  raw: readonly Attempt[],
): AgentMetricView {
  return {
    ...base,
    attempts: { count: attempts.length, restarts: Math.max(0, attempts.length - 1), items: attempts },
    ...agentSpan(raw),
    resources: aggregateResources(attemptResources(base.agentConfigRef.ownerUserId, raw)),
  };
}

export function subjectAgent(sampling: SamplingSnapshot): AgentMetricView {
  return agentView({
    role: "subject", agentConfigRef: sampling.subjectAgent, chatId: sampling.subjectChatId ?? null,
    samplingId: sampling.samplingId, evaluationId: null, stage: sampling.execution,
    artifacts: sampling.artifacts ?? [], trajectory: sampling.trajectory ?? null,
  }, sampling.executionAttempts.map((attempt) => attemptMetric(attempt.executionAttemptId, attempt)), sampling.executionAttempts);
}

export function evaluatorAgent(record: EvaluationRecord): AgentMetricView {
  return agentView({
    role: "evaluator", agentConfigRef: record.evaluator, chatId: record.chatId ?? null,
    samplingId: record.samplingId, evaluationId: record.evaluationId, stage: record.status,
    artifacts: record.output?.artifacts ?? [], trajectory: record.output?.trajectory ?? null,
  }, record.attempts.map((attempt) => attemptMetric(attempt.evaluationAttemptId, attempt)), record.attempts);
}
