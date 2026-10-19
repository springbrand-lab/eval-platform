import type { EvaluationRecord, RecoveryPasses, SamplingStageState } from "@eval-platform/eval-contracts";
import {
  OBSERVATION_MAX_PASSES,
  isPendingSamplingStatus,
  isStageRecoveryPending,
  startResourceWait,
} from "@eval-platform/eval-contracts";

import type { AgentAttemptRecord, AgentLifecycleDependencies, AgentLifecycleStage } from "./agent-lifecycle.js";

export function failedPass(
  previous: RecoveryPasses | undefined,
  lastError: string,
  maxPasses: number,
): { readonly next: RecoveryPasses; readonly exhausted: boolean } {
  const next = { passes: (previous?.passes ?? 0) + 1, lastError };
  return { next, exhausted: next.passes >= maxPasses };
}

/** Unknown terminal status is not an Agent failure: retry the same Submission next pass until the budget is spent. */
export function unconfirmedObservation(
  stage: AgentLifecycleStage,
  state: SamplingStageState,
  message: string,
): SamplingStageState {
  const { next, exhausted } = failedPass(state.observationPending, message, OBSERVATION_MAX_PASSES);
  return exhausted
    ? { status: "failed", lastError: `${stage} submission status could not be confirmed after ${next.passes} observation passes; last: ${message}` }
    : { status: "retrying", lastError: message, observationPending: next };
}

/** A Subject Attempt has ended once it records a terminal. */
export function executionAgentEnded(attempt: AgentAttemptRecord): boolean {
  return attempt.completedAt !== undefined;
}

/** An Evaluator result accepted through the result submission. */
export function isAcceptedEvaluation(record: EvaluationRecord): boolean {
  return record.status.status === "succeeded" && record.output?.structuredOutput?.source === "submission";
}

/** An accepted result ends the Evaluator's work even when its terminal receipt was never observed. */
export function evaluationAgentEnded(record: EvaluationRecord): (attempt: AgentAttemptRecord) => boolean {
  return (attempt) => executionAgentEnded(attempt) || (isAcceptedEvaluation(record) && attempt.submissionId !== undefined);
}

/** The single definition of an ended, dispatched Attempt whose resource snapshot is failed or not yet finalized. */
export function attemptOwesResources<T extends AgentAttemptRecord>(attempt: T, agentEnded: (attempt: T) => boolean): boolean {
  const resources = attempt.resources;
  return agentEnded(attempt) && resources !== undefined && !(resources.status === "collected" && resources.snapshot.finalized);
}

export function stageOwesResources<T extends AgentAttemptRecord>(attempts: readonly T[], agentEnded: (attempt: T) => boolean): boolean {
  return attempts.some((attempt) => attemptOwesResources(attempt, agentEnded));
}

/**
 * Derives a stage's recovery flags from the Attempts written with it, so they commit atomically
 * with those facts. `resourcesPending` starts its wait when an ended Agent first owes its snapshot,
 * unless the Run's stop is finalized; `observationPending` survives only while the stage is pending and the last Attempt has no terminal.
 */
export function withRecoveryBookkeeping(
  next: SamplingStageState,
  previous: SamplingStageState,
  attempts: readonly AgentAttemptRecord[],
  agentEnded: (attempt: AgentAttemptRecord) => boolean,
  dependencies: Pick<AgentLifecycleDependencies, "now" | "runStopped">,
): SamplingStageState {
  const { resourcesPending: nextResources, observationPending: nextObservation, ...state } = next;
  const resourcesPending = stageOwesResources(attempts, agentEnded)
    ? nextResources ?? previous.resourcesPending ?? (dependencies.runStopped ? undefined : startResourceWait(dependencies.now()))
    : undefined;
  const last = attempts.at(-1);
  const observationPending = isPendingSamplingStatus(state.status) && last !== undefined && last.completedAt === undefined
    ? nextObservation ?? previous.observationPending
    : undefined;
  return {
    ...state,
    ...(resourcesPending === undefined ? {} : { resourcesPending }),
    ...(observationPending === undefined ? {} : { observationPending }),
  };
}

export const RECOVERY_FLAGS = ["evidencePending", "collectionPending", "observationPending", "resourcesPending"] as const;

/** Stage states by status, recovery flag counts and the earliest scheduled resource check. */
export function summarizeStages(states: readonly SamplingStageState[]): {
  readonly statuses: Readonly<Record<string, number>>;
  readonly flags: Readonly<Record<(typeof RECOVERY_FLAGS)[number], number>>;
  readonly nextDueAt?: string;
} {
  const statuses: Record<string, number> = {};
  const flags = { evidencePending: 0, collectionPending: 0, observationPending: 0, resourcesPending: 0 };
  let nextDueAt: string | undefined;
  for (const state of states) {
    statuses[state.status] = (statuses[state.status] ?? 0) + 1;
    for (const flag of RECOVERY_FLAGS) if (state[flag] !== undefined && state[flag] !== false) flags[flag] += 1;
    const next = state.resourcesPending?.nextAttemptAt;
    if (next !== undefined && (nextDueAt === undefined || Date.parse(next) < Date.parse(nextDueAt))) nextDueAt = next;
  }
  return { statuses, flags, ...(nextDueAt === undefined ? {} : { nextDueAt }) };
}

/** Whether this pass runs the stage: it is pending, or its next resource readiness check is due. */
export function isStageDue(state: SamplingStageState, now: string): boolean {
  if (!isStageRecoveryPending(state)) return false;
  const nextAttemptAt = state.resourcesPending?.nextAttemptAt;
  return isPendingSamplingStatus(state.status) || nextAttemptAt === undefined || Date.parse(nextAttemptAt) <= Date.parse(now);
}
