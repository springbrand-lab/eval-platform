import {
  isTerminalAgentStatus,
  type EvaluationAttempt,
  type ExecutionAttempt,
} from "@eval-platform/eval-contracts";
import type { AgentMetricView, AttemptMetric, MetricsEvaluation, MetricsSampling, WithResourceSnapshot } from "./model.js";
import { aggregateResources, type ResourceInput } from "./resources.js";

type Attempt = WithResourceSnapshot<ExecutionAttempt> | WithResourceSnapshot<EvaluationAttempt>;

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
  return attempts.map((attempt) => ({
    ownerUserId,
    collection: attempt.resources,
    submitted: attempt.submissionId !== undefined,
    canEmitTelemetry: !isTerminalAgentStatus(attempt.status),
  }));
}

/** First valid start to last terminal completion; null while the latest Attempt is not terminal. */
export function agentSpan(attempts: readonly Attempt[]): Pick<AgentMetricView, "firstStartedAt" | "lastCompletedAt" | "agentDurationMs"> {
  const chronological = (values: readonly (string | undefined)[]) => values
    .filter((value): value is string => Number.isFinite(time(value)))
    .toSorted((left, right) => time(left) - time(right));
  const latest = attempts.toSorted((left, right) => left.attemptNumber - right.attemptNumber).at(-1);
  const firstStartedAt = chronological(attempts.map((attempt) => attempt.startedAt))[0] ?? null;
  const lastCompletedAt = latest && isTerminalAgentStatus(latest.status)
    ? chronological(attempts.filter((attempt) => isTerminalAgentStatus(attempt.status)).map((attempt) => attempt.completedAt)).at(-1) ?? null
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

function agentView<Item extends Attempt>(
  base: Pick<AgentMetricView, "role" | "agentConfigRef" | "chatId" | "samplingId" | "evaluationId" | "stage" | "artifacts" | "trajectory">,
  attempts: readonly Item[],
  attemptId: (attempt: Item) => string,
): AgentMetricView {
  return {
    ...base,
    attempts: {
      count: attempts.length, restarts: Math.max(0, attempts.length - 1),
      items: attempts.map((attempt) => attemptMetric(attemptId(attempt), attempt)),
    },
    ...agentSpan(attempts),
    resources: aggregateResources(attemptResources(base.agentConfigRef.ownerUserId, attempts)),
  };
}

export function subjectAgent(sampling: MetricsSampling): AgentMetricView {
  return agentView({
    role: "subject", agentConfigRef: sampling.subjectAgent, chatId: sampling.subjectChatId ?? null,
    samplingId: sampling.samplingId, evaluationId: null, stage: sampling.execution,
    artifacts: sampling.artifacts ?? [], trajectory: sampling.trajectory ?? null,
  }, sampling.executionAttempts, (attempt) => attempt.executionAttemptId);
}

export function evaluatorAgent(record: MetricsEvaluation): AgentMetricView {
  return agentView({
    role: "evaluator", agentConfigRef: record.evaluator, chatId: record.chatId ?? null,
    samplingId: record.samplingId, evaluationId: record.evaluationId, stage: record.status,
    artifacts: record.output?.artifacts ?? [], trajectory: record.output?.trajectory ?? null,
  }, record.attempts, (attempt) => attempt.evaluationAttemptId);
}

/** The stage record as stored, without the snapshots loaded for Metrics. */
export function withoutSnapshots<T extends MetricsSampling | MetricsEvaluation>(record: T): T {
  const strip = <A extends Attempt>(attempt: A): A => {
    if (attempt.resources?.status !== "collected") return attempt;
    const { snapshot: _snapshot, ...resources } = attempt.resources;
    return { ...attempt, resources };
  };
  return "executionAttempts" in record
    ? { ...record, executionAttempts: record.executionAttempts.map(strip) }
    : { ...record, attempts: record.attempts.map(strip) };
}
