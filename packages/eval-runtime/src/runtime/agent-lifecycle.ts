import type {
  AgentRole,
  AgentResourceCollection,
  AgentResourceScope,
  AgentStatus,
  EvidenceLimits,
  HarnessConfig,
  RetryPolicy,
  Sampling,
  SamplingStatus,
} from "@eval-platform/eval-contracts";
import { isTerminalAgentStatus } from "@eval-platform/eval-contracts";

import type {
  AgentFailureKind,
  AgentHandle,
  AgentSubmission,
  EnsureAgentInput,
  EvidenceStore,
  Harness,
  HarnessRuntimeOptions,
} from "../harness/model.js";
import { AGENT_FAILURE_KINDS } from "../harness/model.js";
import type {
  RetryController,
  RetryOperation,
} from "./retry.js";
import { validateResourceSnapshot } from "./resources.js";
import type { RuntimeStore } from "./store.js";
import { RuntimeRecordPersistenceError, RuntimeRunStoppedError } from "./errors.js";
import type { EvaluationScorePort } from "./scores.js";
import type { EvaluationResultPort } from "./results.js";

export type AgentLifecycleStage = "execution" | "evaluation";

export function agentOperationKey(
  stage: AgentLifecycleStage,
  samplingId: string,
  attemptNumber: number,
): string {
  return attemptNumber === 1
    ? `${stage}:${samplingId}`
    : `${stage}:${samplingId}:restart:${attemptNumber}`;
}

export interface AgentAttemptRecord {
  readonly attemptNumber: number;
  readonly submissionId?: string;
  readonly status: AgentStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
  readonly resources?: AgentResourceCollection;
}

export interface AttemptPatch {
  readonly submissionId?: string;
  readonly status?: AgentStatus;
  readonly completedAt?: string;
  readonly error?: string;
  readonly resources?: AgentResourceCollection;
}

export interface AgentLifecycleDependencies {
  readonly harness: Harness;
  readonly idFactory: () => string;
  readonly now: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly onError: (error: Error) => void;
}

/** Report a failure that must not interrupt the Run; a reporter that throws is the last resort for stderr. */
export function reportError(onError: (error: Error) => void, error: Error): void {
  try {
    onError(error);
  } catch (reportingError) {
    console.error(error, reportingError);
  }
}

/** Everything an execution or evaluation stage needs to drive and persist one record. */
export interface StageDependencies extends AgentLifecycleDependencies {
  readonly store: RuntimeStore;
  readonly evidence: EvidenceStore;
  readonly evidenceLimits: EvidenceLimits;
  readonly createRetryController: (policy?: RetryPolicy) => RetryController;
  readonly scores?: EvaluationScorePort;
  /** Result submission and checking; without it an Evaluator's output is stored unchecked. */
  readonly results?: EvaluationResultPort;
}

export interface AgentLifecycleOptions<TAttempt extends AgentAttemptRecord, TOutput> {
  readonly stage: AgentLifecycleStage;
  readonly role: AgentRole;
  readonly projectId: string;
  readonly samplingId: string;
  readonly chatId: string;
  /** Required for, and only for, an Evaluator. */
  readonly evaluationId?: string;
  readonly harnessConfig: HarnessConfig;
  readonly prompt: string;
  readonly retryController: RetryController;
  readonly attempts: readonly TAttempt[];
  readonly createAttempt: (input: {
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly startedAt: string;
  }) => TAttempt;
  readonly appendAttempt: (attempt: TAttempt) => Promise<void>;
  readonly updateAttempt: (attempt: TAttempt, patch: AttemptPatch) => Promise<TAttempt>;
  readonly setSamplingStatus: (status: SamplingStatus, lastError?: string) => Promise<void>;
  readonly prepare: (handle: AgentHandle) => Promise<void>;
  readonly collectOutput: (handle: AgentHandle) => Promise<TOutput>;
  readonly isSuccessfulOutput: (output: TOutput) => boolean;
  readonly outputFailure: (output: TOutput) => AgentOperationError;
  /** The caller atomically persists the final stage state with required evidence. */
  readonly deferFailureStatus?: boolean;
}

export interface AgentLifecycleResult<TOutput> {
  readonly handle: AgentHandle;
  readonly output: TOutput;
}

export class AgentOperationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly failureKind: AgentFailureKind,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentOperationError";
  }
}

class OutputCollectionError extends AgentOperationError {
  constructor(
    stage: AgentLifecycleStage,
    details: AgentErrorDetails,
    cause: unknown,
    retryable = details.retryable,
  ) {
    super(
      `${stage} output collection failed: ${details.message}`,
      retryable,
      details.failureKind,
      cause,
    );
    this.name = "OutputCollectionError";
  }
}

class SubmissionStatusError extends AgentOperationError {
  constructor(
    stage: AgentLifecycleStage,
    details: AgentErrorDetails,
    cause: unknown,
  ) {
    super(
      `${stage} submission status could not be confirmed: ${details.message}`,
      details.retryable,
      "submission-timeout",
      cause,
    );
    this.name = "SubmissionStatusError";
  }
}

export class ConfirmedSubmissionFailure extends AgentOperationError {
  constructor(stage: AgentLifecycleStage, submission: AgentSubmission) {
    super(
      submission.error ?? `${stage} submission ended with ${submission.status}`,
      submission.retryable === true,
      submission.failureKind ?? "network",
    );
    this.name = "ConfirmedSubmissionFailure";
  }
}

export function applyAttemptPatch<TAttempt extends AgentAttemptRecord>(
  attempt: TAttempt,
  patch: AttemptPatch,
): TAttempt {
  return {
    ...attempt,
    ...(patch.submissionId === undefined ? {} : { submissionId: patch.submissionId }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.completedAt === undefined ? {} : { completedAt: patch.completedAt }),
    ...(patch.error === undefined ? {} : { error: patch.error }),
    ...(patch.resources === undefined ? {} : { resources: patch.resources }),
  } as TAttempt;
}

export function withExecutionStatus(
  sampling: Sampling,
  status: SamplingStatus,
  lastError?: string,
): Sampling {
  return {
    ...sampling,
    execution: lastError === undefined ? { status } : { status, lastError },
  };
}

interface AgentErrorDetails {
  readonly message: string;
  readonly retryable: boolean;
  readonly failureKind: AgentFailureKind;
}

export function describeAgentError(error: unknown): AgentErrorDetails {
  if (error instanceof AgentOperationError) {
    return {
      message: error.message,
      retryable: error.retryable,
      failureKind: error.failureKind,
    };
  }

  if (error instanceof Error) {
    const candidate = error as Error & {
      readonly retryable?: unknown;
      readonly failureKind?: unknown;
    };
    return {
      message: error.message,
      retryable: typeof candidate.retryable === "boolean" ? candidate.retryable : true,
      failureKind: AGENT_FAILURE_KINDS.find((kind) => kind === candidate.failureKind) ?? "network",
    };
  }

  return {
    message: String(error),
    retryable: true,
    failureKind: "network",
  };
}

export function errorMessage(error: unknown): string {
  return describeAgentError(error).message;
}

export async function runAgentLifecycle<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
): Promise<AgentLifecycleResult<TOutput>> {
  const retryController = options.retryController;
  let handle: AgentHandle | undefined;
  let attempt = options.attempts.at(-1);

  for (let attemptNumber = attempt?.attemptNumber ?? 1; ; attemptNumber += 1) {
    const resuming = attempt !== undefined;
    if (!attempt) {
      attempt = options.createAttempt({
        attemptId: dependencies.idFactory(),
        attemptNumber,
        startedAt: dependencies.now(),
      });
      await options.appendAttempt(attempt);
      await options.setSamplingStatus(attemptNumber === 1 ? "starting" : "retrying");
    }
    let terminalPatch: AttemptPatch | undefined = attempt.completedAt === undefined
      ? undefined
      : { status: attempt.status, completedAt: attempt.completedAt };
    let dispatchBlocked = false;

    try {
      if (attempt.completedAt && !attempt.resources) {
        throw new AgentOperationError(attempt.error ?? "Agent failed before submission", false, "network");
      }
      if (!handle) {
        handle = await ensureAgentWithRetry(dependencies, options);
      }

      if (attemptNumber === 1 && !attempt.resources) {
        await prepareAgentWithRetry(dependencies, options, handle);
      }

      const idempotencyKey = agentOperationKey(options.stage, options.samplingId, attemptNumber);
      let resourceScope: AgentResourceScope = {
        chatId: handle.chatId,
        idempotencyKey,
        ...(attempt.submissionId === undefined ? {} : { submissionId: attempt.submissionId }),
      };
      const storedScope = attempt.resources?.status === "collected"
        ? attempt.resources.snapshot.scope
        : attempt.resources?.scope;
      if (storedScope && (storedScope.chatId !== resourceScope.chatId
        || storedScope.idempotencyKey !== resourceScope.idempotencyKey
        || (storedScope.submissionId !== undefined && resourceScope.submissionId !== undefined
          && storedScope.submissionId !== resourceScope.submissionId))) {
        throw new AgentOperationError("Attempt resource scope does not match the submitted operation", false, "network");
      }
      if (!attempt.resources) {
        attempt = await options.updateAttempt(attempt, {
          resources: { status: "pending", scope: resourceScope },
        });
      }
      let terminal: AgentSubmission | undefined;
      try {
        if (attempt.completedAt) {
          if (attempt.status === "completed") {
            if (!attempt.submissionId) {
              throw new AgentOperationError("Completed attempt has no Submission ID", false, "network");
            }
            terminal = { submissionId: attempt.submissionId, status: "completed" };
          } else {
            const inspection = await inspectPersistedTerminalWithRetry(dependencies, options, handle, idempotencyKey);
            if (attempt.submissionId && attempt.submissionId !== inspection.submissionId) {
              throw new AgentOperationError("Persisted terminal belongs to a different Submission", false, "network");
            }
            if (!attempt.submissionId) {
              attempt = await options.updateAttempt(attempt, { submissionId: inspection.submissionId });
            }
            resourceScope = { ...resourceScope, submissionId: inspection.submissionId };
            if (inspection.status !== attempt.status) {
              throw new AgentOperationError("Agent operation disagrees with the persisted terminal status", false, "network");
            }
            terminal = inspection;
          }
        } else {
          const inspected = resuming
            ? await inspectUncertainOperation(dependencies.harness, handle, idempotencyKey, options.harnessConfig.runtime)
            : undefined;
          const submission = inspected ?? await submitWithReconciliation(
              dependencies,
              options,
              handle,
              idempotencyKey,
              attemptNumber === 1 ? "submission" : "restart",
            ).catch((error: unknown) => {
              if (error instanceof RuntimeRunStoppedError) dispatchBlocked = true;
              throw error;
            });
          if (attempt.submissionId && attempt.submissionId !== submission.submissionId) {
            throw new AgentOperationError("Attempt belongs to a different Submission", false, "network");
          }
          if (!attempt.submissionId) {
            attempt = await options.updateAttempt(attempt, { submissionId: submission.submissionId });
          }
          resourceScope = { ...resourceScope, submissionId: submission.submissionId };
          terminal = isTerminal(submission)
            ? submission
            : await waitForTerminalWithRetry(dependencies, options, handle, idempotencyKey);
          if (terminal.submissionId !== attempt.submissionId) {
            throw new AgentOperationError("Terminal status belongs to a different Submission", false, "network");
          }
          terminalPatch = {
            status: terminal.status,
            completedAt: dependencies.now(),
            ...(isSuccessfulSubmission(terminal) ? {} : { error: new ConfirmedSubmissionFailure(options.stage, terminal).message }),
          };
          attempt = await options.updateAttempt(attempt, terminalPatch);
        }
      } finally {
        const terminalSaved = terminalPatch === undefined || attempt.completedAt !== undefined;
        const needsResources = !dispatchBlocked && (attempt.resources?.status === "pending"
          || (attempt.resources?.status === "collected" && terminal !== undefined
            && !attempt.resources.snapshot.finalized));
        if (terminalSaved && needsResources) {
          const resources = await collectResourcesWithRetry(dependencies, options, handle, resourceScope);
          if (resources.status === "collected" && attempt.submissionId
            && resources.snapshot.scope.submissionId !== attempt.submissionId) {
            throw new AgentOperationError("Resources belong to a different Submission", false, "network");
          }
          if (attempt.resources?.status === "collected" && resources.status === "failed") {
            const reported = new Error(
              options.stage + " resource refresh failed for sampling " + options.samplingId
              + " and Chat " + resourceScope.chatId + ": " + resources.error,
            );
            reportError(dependencies.onError, reported);
          } else {
            attempt = await options.updateAttempt(attempt, {
              ...terminalPatch,
              ...(resources.status === "collected" && !attempt.submissionId
                ? { submissionId: resources.snapshot.scope.submissionId }
                : {}),
              resources,
            });
          }
        }
      }
      if (!terminal) throw new Error(`${options.stage} submission has no confirmed status`);
      if (!isSuccessfulSubmission(terminal)) {
        throw new ConfirmedSubmissionFailure(options.stage, terminal);
      }

      await options.setSamplingStatus("running");
      const outputHandle = handle;
      const output = await collectOutputWithRetry({
        stage: options.stage,
        collect: () => options.collectOutput(outputHandle),
        retryController,
        sleep: dependencies.sleep,
        onRetry: (message) => options.setSamplingStatus("retrying", message),
      });
      if (!options.isSuccessfulOutput(output)) {
        const failure = options.outputFailure(output);
        throw new OutputCollectionError(options.stage, describeAgentError(failure), failure, false);
      }

      return { handle, output };
    } catch (error) {
      if (error instanceof RuntimeRecordPersistenceError || error instanceof RuntimeRunStoppedError) throw error;
      const details = describeAgentError(error);
      if (terminalPatch === undefined && attempt.resources === undefined) {
        await options.updateAttempt(attempt, {
          status: "failed",
          completedAt: dependencies.now(),
          error: details.message,
        });
      }

      if (!(error instanceof ConfirmedSubmissionFailure)) {
        if (!options.deferFailureStatus) await options.setSamplingStatus("failed", details.message);
        throw error;
      }

      if (!details.retryable) {
        if (!options.deferFailureStatus) await options.setSamplingStatus("failed", details.message);
        throw error;
      }

      const decision = await retryController.decide({
        operation: "restart",
        failureKind: details.failureKind,
        attemptNumber,
      });
      if (!decision.shouldRetry) {
        if (!options.deferFailureStatus) await options.setSamplingStatus("failed", details.message);
        throw error;
      }

      await options.setSamplingStatus("retrying", details.message);
      await dependencies.sleep(decision.backoffMs ?? 0);
      attempt = undefined;
    }
  }
}

interface RetryLoop<TResult> {
  readonly operation: RetryOperation;
  readonly retryController: RetryController;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly run: () => Promise<TResult>;
  /** Resolves a failed attempt from the Harness before any retry decision. */
  readonly reconcile?: () => Promise<TResult | undefined>;
  /** Reports a retry before its backoff. */
  readonly onRetry?: (message: string) => Promise<void>;
  /** The error thrown when the failure is unretryable or retries are exhausted. */
  readonly fail?: (error: unknown, details: AgentErrorDetails) => unknown;
}

/** Repeats one idempotent Agent operation while its failures are retryable and the controller allows it. */
async function retryAgentOperation<TResult>(loop: RetryLoop<TResult>): Promise<TResult> {
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await loop.run();
    } catch (error) {
      if (error instanceof RuntimeRunStoppedError) throw error;
      const reconciled = await loop.reconcile?.();
      if (reconciled !== undefined) return reconciled;
      const details = describeAgentError(error);
      const decision = details.retryable
        ? await loop.retryController.decide({
          operation: loop.operation,
          failureKind: details.failureKind,
          attemptNumber,
        })
        : undefined;
      if (!decision?.shouldRetry) throw loop.fail?.(error, details) ?? error;
      await loop.onRetry?.(details.message);
      await loop.sleep(decision.backoffMs ?? 0);
    }
  }
}

/** Retry settings shared by operations that report retries on the Sampling status. */
function samplingRetry<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
): Pick<RetryLoop<never>, "retryController" | "sleep" | "onRetry"> {
  return {
    retryController: options.retryController,
    sleep: dependencies.sleep,
    onRetry: (message) => options.setSamplingStatus("retrying", message),
  };
}

function runtimeOption(runtime: HarnessRuntimeOptions | undefined): { readonly runtime?: HarnessRuntimeOptions } {
  return runtime === undefined ? {} : { runtime };
}

async function ensureAgentWithRetry<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
): Promise<AgentHandle> {
  if ((options.role === "evaluator") !== (options.evaluationId !== undefined)) {
    throw new AgentOperationError("Evaluation ID does not match Agent role", false, "network");
  }
  const input: EnsureAgentInput = {
    chatId: options.chatId,
    role: options.role,
    samplingId: options.samplingId,
    framework: options.harnessConfig.framework,
    agentConfig: options.harnessConfig.agentConfig,
    projectId: options.projectId,
    ...(options.evaluationId === undefined ? {} : { evaluationId: options.evaluationId }),
    ...runtimeOption(options.harnessConfig.runtime),
  };
  return retryAgentOperation({
    ...samplingRetry(dependencies, options),
    operation: "creation",
    run: async () => {
      const handle = await dependencies.harness.ensureAgent(input);
      if (
        handle.chatId !== input.chatId
        || handle.ownerUserId !== input.agentConfig.ownerUserId
        || handle.role !== input.role
        || handle.framework !== input.framework
        || handle.samplingId !== input.samplingId
        || handle.evaluationId !== input.evaluationId
      ) {
        throw new AgentOperationError(
          `${options.stage} agent handle does not match the requested identity`,
          false,
          "network",
        );
      }
      return handle;
    },
  });
}

async function prepareAgentWithRetry<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
  handle: AgentHandle,
): Promise<void> {
  await retryAgentOperation({
    ...samplingRetry(dependencies, options),
    operation: "initialization",
    run: () => options.prepare(handle),
  });
}

async function submitWithReconciliation<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
  handle: AgentHandle,
  idempotencyKey: string,
  operation: Extract<RetryOperation, "submission" | "restart">,
): Promise<AgentSubmission> {
  const input = {
    handle,
    idempotencyKey,
    prompt: options.prompt,
    ...runtimeOption(options.harnessConfig.runtime),
  };
  return retryAgentOperation({
    ...samplingRetry(dependencies, options),
    operation,
    run: () => operation === "restart"
      ? dependencies.harness.restartAgent(input)
      : dependencies.harness.submitAgent(input),
    reconcile: () => inspectUncertainOperation(dependencies.harness, handle, idempotencyKey, options.harnessConfig.runtime),
  });
}

function waitForTerminalWithRetry<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
  handle: AgentHandle,
  idempotencyKey: string,
): Promise<AgentSubmission> {
  return retryAgentOperation({
    ...samplingRetry(dependencies, options),
    operation: "status",
    run: () => waitForTerminal(dependencies.harness, handle, idempotencyKey, options.stage, options.harnessConfig.runtime),
  });
}

export function collectOutputWithRetry<TOutput>(input: {
  readonly stage: AgentLifecycleStage;
  readonly collect: () => Promise<TOutput>;
  readonly retryController: RetryController;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly onRetry?: (message: string) => Promise<void>;
}): Promise<TOutput> {
  return retryAgentOperation({
    operation: "collection",
    retryController: input.retryController,
    sleep: input.sleep,
    run: input.collect,
    ...(input.onRetry === undefined ? {} : { onRetry: input.onRetry }),
    fail: (error, details) => new OutputCollectionError(input.stage, details, error),
  });
}

async function collectResourcesWithRetry<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
  handle: AgentHandle,
  scope: AgentResourceScope,
): Promise<AgentResourceCollection> {
  try {
    return await retryAgentOperation<AgentResourceCollection>({
      operation: "resources",
      retryController: options.retryController,
      sleep: dependencies.sleep,
      run: async () => {
        const snapshot = await dependencies.harness.collectAgentResources({
          handle,
          idempotencyKey: scope.idempotencyKey,
          ...(scope.submissionId === undefined ? {} : { submissionId: scope.submissionId }),
          ...runtimeOption(options.harnessConfig.runtime),
        });
        return { status: "collected", snapshot: validateResourceSnapshot(snapshot, scope) };
      },
    });
  } catch (error) {
    if (error instanceof RuntimeRunStoppedError) throw error;
    return {
      status: "failed",
      scope,
      collectedAt: dependencies.now(),
      error: errorMessage(error),
    };
  }
}

async function inspectUncertainOperation(
  harness: Harness,
  handle: AgentHandle,
  idempotencyKey: string,
  runtime?: HarnessRuntimeOptions,
): Promise<AgentSubmission | undefined> {
  try {
    return (await harness.inspectAgentOperation({ handle, idempotencyKey, ...runtimeOption(runtime) })) ?? undefined;
  } catch {
    return undefined;
  }
}

function inspectPersistedTerminalWithRetry<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
  handle: AgentHandle,
  idempotencyKey: string,
): Promise<AgentSubmission> {
  return retryAgentOperation({
    ...samplingRetry(dependencies, options),
    operation: "status",
    run: async () => {
      const inspection = await dependencies.harness.inspectAgentOperation({
        handle,
        idempotencyKey,
        ...runtimeOption(options.harnessConfig.runtime),
      });
      if (inspection && isTerminal(inspection)) return inspection;
      throw new AgentOperationError("Persisted Agent failure could not be confirmed", true, "submission-timeout");
    },
    fail: (error, details) => details.retryable ? new SubmissionStatusError(options.stage, details, undefined) : error,
  });
}

async function waitForTerminal(
  harness: Harness,
  handle: AgentHandle,
  idempotencyKey: string,
  stage: AgentLifecycleStage,
  runtime?: HarnessRuntimeOptions,
): Promise<AgentSubmission> {
  try {
    const submission = await harness.waitForSubmission({
      handle,
      idempotencyKey,
      ...(runtime === undefined ? {} : { runtime }),
    });
    if (isTerminal(submission)) return submission;

    const inspection = await inspectUncertainOperation(
      harness,
      handle,
      idempotencyKey,
      runtime,
    );
    if (inspection && isTerminal(inspection)) return inspection;
    throw new SubmissionStatusError(
      stage,
      {
        message: `${stage} submission did not reach a terminal state`,
        retryable: inspection?.retryable !== false,
        failureKind: "submission-timeout",
      },
      undefined,
    );
  } catch (error) {
    if (error instanceof SubmissionStatusError) throw error;

    const reconciliation = await inspectUncertainOperation(
      harness,
      handle,
      idempotencyKey,
      runtime,
    );
    if (reconciliation && isTerminal(reconciliation)) return reconciliation;

    const details = describeAgentError(error);
    throw new SubmissionStatusError(
      stage,
      {
        message: details.message,
        retryable: details.retryable,
        failureKind: "submission-timeout",
      },
      error,
    );
  }
}

function isTerminal(submission: AgentSubmission): boolean {
  return isTerminalAgentStatus(submission.status);
}

function isSuccessfulSubmission(submission: AgentSubmission): boolean {
  return submission.status === "completed";
}
