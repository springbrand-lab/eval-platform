import {
  RESOURCE_CHECK_INTERVAL_MS,
  type AgentResourceScope,
  type CollectedResourceSnapshot,
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
  type AgentAttemptRecord,
  type AgentLifecycleDependencies,
  type AgentLifecycleStage,
} from "./agent-lifecycle.js";
import { RuntimeRecordPersistenceError, RuntimeRunStoppedError } from "./errors.js";
import { reportError } from "./log.js";
import { attemptOwesResources, stageOwesResources } from "./recovery.js";
import {
  STOPPED_RESOURCES_ERROR,
  collectResources,
  failedResources,
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
  /**
   * Writes exactly these Attempts and stage state; status, output and evidence stay unchanged. A
   * downloaded raw snapshot of `collected.attempt` is stored in the same write.
   */
  readonly persist: (attempts: readonly TAttempt[], state: SamplingStageState, collected?: CollectedResources<TAttempt>) => Promise<void>;
}

export interface CollectedResources<TAttempt> {
  readonly attempt: TAttempt;
  readonly snapshot: CollectedResourceSnapshot;
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
      if (!refresh.agentEnded(original) || original.resources === undefined || original.resources.exhausted) continue;
      const save = async (attempt: TAttempt, snapshot?: CollectedResourceSnapshot) => {
        attempts[index] = attempt;
        await refresh.persist(attempts, stageOwesResources(attempts, refresh.agentEnded) ? refresh.state : finished,
          snapshot && { attempt: original, snapshot });
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
  const resources = attempt.resources;
  if (!attemptOwesResources(attempt, agentEnded) || resources === undefined || resources.status === "collected") return attempt;
  return applyAttemptPatch(attempt, { resources: failedResources(resources, resources.scope, collectedAt, error) });
}

async function refreshAttempt<TAttempt extends AgentAttemptRecord>(
  dependencies: AgentLifecycleDependencies,
  refresh: FinishedStageRefresh<TAttempt>,
  handle: AgentHandle,
  original: TAttempt,
  expired: boolean,
  save: (attempt: TAttempt, snapshot?: CollectedResourceSnapshot) => Promise<void>,
): Promise<{ readonly attempt: TAttempt; readonly error?: string }> {
  const { stage, samplingId } = refresh;
  let attempt = original;
  const idempotencyKey = agentOperationKey(stage, samplingId, attempt.attemptNumber);
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
    sleep: dependencies.sleep, now: dependencies.now, log: dependencies.log, onError: dependencies.onError,
    ...(refresh.harnessConfig.runtime === undefined ? {} : { runtime: refresh.harnessConfig.runtime }),
    ...(dependencies.resourceStop === undefined ? {} : { stop: dependencies.resourceStop }),
  };
  const { pending } = await collectResources({
    source,
    current: attempt.resources!,
    exclusively: dependencies.resourceDownloads,
    readinessDelays: [0],
    allowUnfinalized: expired,
    prepare: async () => {
      if (attempt.completedAt !== undefined || attempt.submissionId === undefined) return;
      const inspection = await inspectUncertainOperation(dependencies, { stage, samplingId, harnessConfig: refresh.harnessConfig }, handle, idempotencyKey);
      const observed = inspection.submission;
      if (observed && isTerminal(observed) && observed.submissionId === attempt.submissionId) {
        attempt = applyAttemptPatch(attempt, {
          status: observed.status,
          completedAt: dependencies.now(),
          ...(isSuccessfulSubmission(observed) ? {} : { error: new ConfirmedSubmissionFailure(stage, observed).message }),
        });
        await save(attempt);
      }
    },
    save: async (next, snapshot) => {
      attempt = applyAttemptPatch(attempt, {
        resources: next,
        ...(next.status === "collected" && attempt.submissionId === undefined ? { submissionId: next.summary.scope.submissionId } : {}),
      });
      await save(attempt, snapshot);
    },
  });
  return pending === undefined ? { attempt } : { attempt, error: pending };
}
