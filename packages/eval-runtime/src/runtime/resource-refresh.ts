import {
  RESOURCE_CHECK_INTERVAL_MS,
  type AgentResourceScope,
  type AgentResourceSnapshot,
  type HarnessConfig,
  type SamplingStageState,
} from "@eval-platform/eval-contracts";

import type { AgentHandle } from "../harness/model.js";
import {
  ConfirmedSubmissionFailure,
  agentOperationKey,
  applyAttemptPatch,
  errorMessage,
  inspectUncertainOperation,
  isSuccessfulSubmission,
  isTerminal,
  reportError,
  type AgentAttemptRecord,
  type AgentLifecycleDependencies,
  type AgentLifecycleStage,
} from "./agent-lifecycle.js";
import { RuntimeRecordPersistenceError, RuntimeRunStoppedError } from "./errors.js";
import { attemptOwesResources } from "./recovery.js";
import {
  STOPPED_RESOURCES_ERROR,
  awaitResourceFinalization,
  collectResources,
  resourceScopeMatches,
  storedResourceScope,
} from "./resources.js";
import type { RetryController } from "./retry.js";

export interface FinishedStageRefresh<TAttempt extends AgentAttemptRecord> {
  readonly stage: AgentLifecycleStage;
  readonly samplingId: string;
  /** Built from the persisted Chat, absent without one; the Agent is never ensured, initialized or submitted. */
  readonly handle: AgentHandle | undefined;
  readonly harnessConfig: HarnessConfig;
  readonly retryController: RetryController;
  readonly attempts: readonly TAttempt[];
  readonly state: SamplingStageState;
  readonly agentEnded: (attempt: TAttempt) => boolean;
  /** Stores an Attempt's raw resource snapshot outside its stage record. */
  readonly saveResourceSnapshot: (attempt: TAttempt, snapshot: AgentResourceSnapshot) => Promise<void>;
  /** Writes exactly these Attempts and stage state; status, output and evidence stay unchanged. */
  readonly persist: (attempts: readonly TAttempt[], state: SamplingStageState) => Promise<void>;
}

/**
 * One due pass of a finished stage waiting for its resources: a readiness check per owed Attempt,
 * then the single download once SP finalized the snapshot. Past the deadline the current snapshot
 * is downloaded once and kept as it is, the wait ends and the shortfall is reported once; a pass
 * that fails past the deadline also ends it. An Attempt whose download budget is spent is no longer
 * owed. Finalizing a stop never reads SP: each owed Attempt without a collected snapshot is recorded
 * failed with {@link STOPPED_RESOURCES_ERROR} and the wait ends.
 */
export async function refreshFinishedStage<TAttempt extends AgentAttemptRecord>(
  dependencies: AgentLifecycleDependencies,
  refresh: FinishedStageRefresh<TAttempt>,
): Promise<void> {
  const { stage, samplingId, handle } = refresh;
  const { resourcesPending: pending, ...finished } = refresh.state;
  if (pending === undefined) return;
  const now = dependencies.now();
  if (dependencies.finalizingStop) {
    await refresh.persist(refresh.attempts.map((attempt) => withResourceFailure(attempt, refresh.agentEnded, now, STOPPED_RESOURCES_ERROR)), finished);
    return;
  }
  if (handle === undefined) {
    reportError(dependencies.onError, new Error(`${stage} resources for sampling ${samplingId} were not read: no Chat`));
    await refresh.persist(refresh.attempts, finished);
    return;
  }
  const expired = Date.parse(now) >= Date.parse(pending.deadline);
  // Saved after every counted download, so a later failure never discards the count.
  const attempts = [...refresh.attempts];
  try {
    const errors: string[] = [];
    for (const [index, original] of refresh.attempts.entries()) {
      if (!attemptOwesResources(original, refresh.agentEnded)) continue;
      const save = async (attempt: TAttempt) => {
        attempts[index] = attempt;
        await refresh.persist(attempts, refresh.state);
      };
      const { attempt, error } = await refreshAttempt(dependencies, refresh, handle, original, expired, save);
      attempts[index] = attempt;
      if (error !== undefined) errors.push(`Attempt ${attempt.attemptNumber}: ${error}`);
    }
    const lastError = errors.join("; ");
    if (errors.length > 0 && expired) {
      reportError(dependencies.onError, new Error(
        `${stage} resources for sampling ${samplingId}, Chat ${handle.chatId} were not finalized by ${pending.deadline}; kept the current snapshot: ${lastError}`,
      ));
    }
    const nextAttemptAt = new Date(Math.min(Date.parse(now) + RESOURCE_CHECK_INTERVAL_MS, Date.parse(pending.deadline))).toISOString();
    await refresh.persist(attempts, errors.length === 0 || expired
      ? finished
      : { ...finished, resourcesPending: { deadline: pending.deadline, nextAttemptAt, lastError } });
  } catch (error) {
    if (error instanceof RuntimeRecordPersistenceError || error instanceof RuntimeRunStoppedError) throw error;
    const message = errorMessage(error);
    reportError(dependencies.onError, new Error(
      `${stage} resource refresh failed for sampling ${samplingId}: ${message}`, { cause: error },
    ));
    if (expired) {
      await refresh.persist(attempts, finished);
      return;
    }
    // Keep the wait but back off one interval, so the stage is not due again immediately.
    const nextAttemptAt = new Date(Math.min(Date.parse(now) + RESOURCE_CHECK_INTERVAL_MS, Date.parse(pending.deadline))).toISOString();
    await refresh.persist(attempts, { ...finished, resourcesPending: { deadline: pending.deadline, nextAttemptAt, lastError: message } });
  }
}

function withResourceFailure<TAttempt extends AgentAttemptRecord>(
  attempt: TAttempt, agentEnded: (attempt: TAttempt) => boolean, collectedAt: string, error: string,
): TAttempt {
  const scope = storedResourceScope(attempt.resources);
  if (!attemptOwesResources(attempt, agentEnded) || attempt.resources?.status === "collected" || scope === undefined) return attempt;
  return applyAttemptPatch(attempt, { resources: { status: "failed", scope, collectedAt, error } });
}

async function refreshAttempt<TAttempt extends AgentAttemptRecord>(
  dependencies: AgentLifecycleDependencies,
  refresh: FinishedStageRefresh<TAttempt>,
  handle: AgentHandle,
  original: TAttempt,
  expired: boolean,
  save: (attempt: TAttempt) => Promise<void>,
): Promise<{ readonly attempt: TAttempt; readonly error?: string }> {
  const { stage, samplingId } = refresh;
  let attempt = original;
  const idempotencyKey = agentOperationKey(stage, samplingId, attempt.attemptNumber);
  if (attempt.completedAt === undefined && attempt.submissionId !== undefined) {
    // An accepted Evaluation whose receipt was never observed: record its terminal once SP confirms it.
    const inspection = await inspectUncertainOperation(dependencies, { stage, samplingId, harnessConfig: refresh.harnessConfig }, handle, idempotencyKey);
    const observed = inspection.submission;
    if (observed && isTerminal(observed) && observed.submissionId === attempt.submissionId) {
      attempt = applyAttemptPatch(attempt, {
        status: observed.status,
        completedAt: dependencies.now(),
        ...(isSuccessfulSubmission(observed) ? {} : { error: new ConfirmedSubmissionFailure(stage, observed).message }),
      });
    }
  }
  const scope: AgentResourceScope = {
    chatId: handle.chatId,
    idempotencyKey,
    ...(attempt.submissionId === undefined ? {} : { submissionId: attempt.submissionId }),
  };
  const stored = storedResourceScope(attempt.resources);
  if (stored && !resourceScopeMatches(stored, scope)) {
    return { attempt, error: "resource scope does not match the submitted operation" };
  }
  const source = {
    harness: dependencies.harness, handle, scope, retryController: refresh.retryController,
    sleep: dependencies.sleep, now: dependencies.now, log: dependencies.log,
    ...(refresh.harnessConfig.runtime === undefined ? {} : { runtime: refresh.harnessConfig.runtime }),
  };
  const owed = await awaitResourceFinalization(source, [0]);
  if (owed !== undefined && !expired) return { attempt, error: owed };
  const resources = await collectResources({
    source,
    current: attempt.resources!,
    saveSnapshot: (snapshot) => refresh.saveResourceSnapshot(original, snapshot),
    save: async (next) => {
      attempt = applyAttemptPatch(attempt, {
        resources: next,
        ...(next.status === "collected" && attempt.submissionId === undefined ? { submissionId: next.summary.scope.submissionId } : {}),
      });
      await save(attempt);
    },
  });
  if (resources.status !== "pending" && resources.exhausted) {
    const error = resources.status === "failed" ? resources.error : "resource snapshot is not finalized";
    reportError(dependencies.onError, new Error(
      `${stage} resources for sampling ${samplingId}, Chat ${handle.chatId}, Attempt ${attempt.attemptNumber} were given up after ${resources.downloads} downloads: ${error}`,
    ));
    return { attempt };
  }
  return resources.status === "collected" && resources.summary.finalized
    ? { attempt }
    : { attempt, error: owed ?? "resource snapshot is not finalized" };
}
