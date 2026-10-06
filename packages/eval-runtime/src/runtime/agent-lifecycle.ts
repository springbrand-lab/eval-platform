import type {
  AgentConfigRef,
  AgentRole,
  AgentStatus,
  HarnessConfig,
  RetryPolicy,
  Sampling,
  SamplingStageState,
  SamplingStatus,
} from "@eval-platform/eval-contracts";

import type {
  AgentHandle,
  AgentSubmission,
  Harness,
} from "../harness/index.js";
import {
  DEFAULT_RETRY_POLICY,
  createRetryController,
  type RetryController,
  type RetryOperation,
  type RetryableFailureKind,
} from "./retry.js";

export type AgentLifecycleStage = "execution" | "evaluation";

export interface AgentAttemptRecord {
  readonly samplingId: string;
  readonly attemptNumber: number;
  readonly submissionId?: string;
  readonly status: AgentStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface AttemptPatch {
  readonly submissionId?: string;
  readonly status?: AgentStatus;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface AgentLifecycleDependencies {
  readonly harness: Harness;
  readonly idFactory: () => string;
  readonly now: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly createRetryController: (policy?: RetryPolicy) => RetryController;
}

export interface AgentLifecycleOptions<TAttempt extends AgentAttemptRecord, TOutput> {
  readonly stage: AgentLifecycleStage;
  readonly role: AgentRole;
  readonly projectId: string;
  readonly samplingId: string;
  readonly agentConfig: AgentConfigRef;
  readonly prompt: string;
  readonly retryPolicy: RetryPolicy | undefined;
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
}

export interface AgentLifecycleResult<TOutput> {
  readonly handle: AgentHandle;
  readonly output: TOutput;
}

export class AgentOperationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly failureKind: RetryableFailureKind,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentOperationError";
  }
}

class OutputCollectionError extends AgentOperationError {
  constructor(
    stage: AgentLifecycleStage,
    details: ReturnType<typeof describeAgentError>,
    cause: unknown,
  ) {
    super(
      `${stage} output collection failed: ${details.message}`,
      false,
      details.failureKind,
      cause,
    );
    this.name = "OutputCollectionError";
  }
}

class SubmissionStatusError extends AgentOperationError {
  constructor(
    stage: AgentLifecycleStage,
    details: ReturnType<typeof describeAgentError>,
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

class ConfirmedSubmissionFailure extends AgentOperationError {
  constructor(stage: AgentLifecycleStage, submission: AgentSubmission) {
    super(
      submission.error ?? `${stage} submission ended with ${submissionStatus(submission) ?? submission.status}`,
      submission.retryable === true,
      normalizeFailureKind(submission.failureKind),
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
  } as TAttempt;
}

export function requireSpAgent(harness: HarnessConfig, role: AgentRole): AgentConfigRef {
  if (harness.kind !== "sp") {
    throw new Error(`${role} harness kind ${harness.kind} is not implemented`);
  }
  return harness.agentConfig;
}

export function withSamplingStatus(
  sampling: Sampling,
  stage: AgentLifecycleStage,
  status: SamplingStatus,
  lastError?: string,
): Sampling {
  const nextState: SamplingStageState = lastError === undefined
    ? { status }
    : { status, lastError };
  return stage === "execution"
    ? { ...sampling, execution: nextState }
    : { ...sampling, evaluation: nextState };
}

export function describeAgentError(error: unknown): {
  readonly message: string;
  readonly retryable: boolean;
  readonly failureKind: RetryableFailureKind;
} {
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
      failureKind: normalizeFailureKind(candidate.failureKind),
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
  const retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const retryController = dependencies.createRetryController(retryPolicy);
  let handle: AgentHandle | undefined;
  let prepared = false;
  let restartRequested = false;

  for (let attemptNumber = 1; ; attemptNumber += 1) {
    let attempt = options.createAttempt({
      attemptId: dependencies.idFactory(),
      attemptNumber,
      startedAt: dependencies.now(),
    });

    await options.appendAttempt(attempt);
    await options.setSamplingStatus(attemptNumber === 1 ? "starting" : "retrying");
    let submissionCompleted = false;
    const collectCompletedOutput = async (submissionHandle: AgentHandle): Promise<TOutput> => {
      submissionCompleted = true;
      attempt = await options.updateAttempt(attempt, {
        status: "completed",
        completedAt: dependencies.now(),
      });
      await options.setSamplingStatus("running");
      const output = await collectOutputWithRetry(
        dependencies,
        options,
        submissionHandle,
        retryController,
      );
      if (!options.isSuccessfulOutput(output)) {
        const failure = options.outputFailure(output);
        const details = describeAgentError(failure);
        throw new OutputCollectionError(options.stage, details, failure);
      }
      return output;
    };

    try {
      if (!handle) {
        handle = await dependencies.harness.startAgent({
          role: options.role,
          samplingId: options.samplingId,
          agentConfig: options.agentConfig,
          projectId: options.projectId,
        });
      }

      attempt = await options.updateAttempt(attempt, {
        submissionId: handle.submissionId,
      });

      if (!prepared) {
        await options.prepare(handle);
        prepared = true;
      }

      const idempotencyKey = restartRequested
        ? `${options.stage}:${options.samplingId}:restart:${attemptNumber}`
        : `${options.stage}:${options.samplingId}`;
      const submission = await submitWithReconciliation(
        dependencies,
        options,
        handle,
        idempotencyKey,
        restartRequested ? "restart" : "submission",
        retryController,
      );
      restartRequested = false;

      const terminal = isTerminal(submission)
        ? submission
        : await waitForTerminalWithRetry(
            dependencies,
            options,
            handle,
            idempotencyKey,
            retryController,
          );
      if (!isSuccessfulSubmission(terminal)) {
        throw submissionFailure(options.stage, terminal);
      }

      const output = await collectCompletedOutput(handle);

      return { handle, output };
    } catch (error) {
      const details = describeAgentError(error);
      if (submissionCompleted) {
        await options.updateAttempt(attempt, {
          ...(handle ? { submissionId: handle.submissionId } : {}),
          error: details.message,
        });
      } else {
        await options.updateAttempt(attempt, {
          status: "failed",
          completedAt: dependencies.now(),
          ...(handle ? { submissionId: handle.submissionId } : {}),
          error: details.message,
        });
      }

      if (!(error instanceof ConfirmedSubmissionFailure)) {
        await options.setSamplingStatus("failed", details.message);
        throw error;
      }

      if (!details.retryable) {
        await options.setSamplingStatus("failed", details.message);
        throw error;
      }

      const decision = await retryController.decide({
        operation: "restart",
        failureKind: details.failureKind,
        attemptNumber,
      });
      if (!decision.shouldRetry) {
        await options.setSamplingStatus("failed", details.message);
        throw error;
      }

      restartRequested = true;
      await options.setSamplingStatus("retrying", details.message);
      await dependencies.sleep(decision.backoffMs ?? 0);
    }
  }
}

async function submitWithReconciliation<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
  handle: AgentHandle,
  idempotencyKey: string,
  operation: Extract<RetryOperation, "submission" | "restart">,
  retryController: RetryController,
): Promise<AgentSubmission> {
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      const input = {
        handle,
        idempotencyKey,
        prompt: options.prompt,
      };
      return operation === "restart"
        ? await dependencies.harness.restartAgent(input)
        : await dependencies.harness.submitAgent(input);
    } catch (error) {
      const reconciliation = await inspectUncertainOperation(
        dependencies.harness,
        handle,
        idempotencyKey,
      );
      if (reconciliation) return reconciliation;

      const details = describeAgentError(error);
      if (!details.retryable) throw error;

      const decision = await retryController.decide({
        operation,
        failureKind: details.failureKind,
        attemptNumber,
      });
      if (!decision.shouldRetry) throw error;

      await options.setSamplingStatus("retrying", details.message);
      await dependencies.sleep(decision.backoffMs ?? 0);
    }
  }
}

async function waitForTerminalWithRetry<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
  handle: AgentHandle,
  idempotencyKey: string,
  retryController: RetryController,
): Promise<AgentSubmission> {
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await waitForTerminal(
        dependencies.harness,
        handle,
        idempotencyKey,
        options.stage,
      );
    } catch (error) {
      const details = describeAgentError(error);
      if (!details.retryable) throw error;

      const decision = await retryController.decide({
        operation: "status",
        failureKind: details.failureKind,
        attemptNumber,
      });
      if (!decision.shouldRetry) throw error;

      await options.setSamplingStatus("retrying", details.message);
      await dependencies.sleep(decision.backoffMs ?? 0);
    }
  }
}

async function collectOutputWithRetry<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
  handle: AgentHandle,
  retryController: RetryController,
): Promise<TOutput> {
  for (let collectionAttemptNumber = 1; ; collectionAttemptNumber += 1) {
    try {
      return await options.collectOutput(handle);
    } catch (error) {
      const details = describeAgentError(error);
      if (!details.retryable) {
        throw new OutputCollectionError(options.stage, details, error);
      }

      const decision = await retryController.decide({
        operation: "collection",
        failureKind: details.failureKind,
        attemptNumber: collectionAttemptNumber,
      });
      if (!decision.shouldRetry) {
        throw new OutputCollectionError(options.stage, details, error);
      }

      await options.setSamplingStatus("retrying", details.message);
      await dependencies.sleep(decision.backoffMs ?? 0);
    }
  }
}

async function inspectUncertainOperation(
  harness: Harness,
  handle: AgentHandle,
  idempotencyKey: string,
): Promise<AgentSubmission | undefined> {
  try {
    return (await harness.inspectAgentOperation({ handle, idempotencyKey })) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function waitForTerminal(
  harness: Harness,
  handle: AgentHandle,
  idempotencyKey: string,
  stage: AgentLifecycleStage,
): Promise<AgentSubmission> {
  try {
    const submission = await harness.waitForSubmission({ handle, idempotencyKey });
    if (isTerminal(submission)) return submission;

    const inspection = await inspectUncertainOperation(
      harness,
      handle,
      idempotencyKey,
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

function normalizeFailureKind(value: unknown): RetryableFailureKind {
  if (value === "llm" || value === "website" || value === "submission-timeout") {
    return value;
  }
  return "network";
}

function submissionStatus(submission: AgentSubmission): AgentStatus | undefined {
  if (submission.normalizedStatus) return submission.normalizedStatus;
  switch (submission.status) {
    case "queued":
      return "queued";
    case "starting":
    case "running":
      return "running";
    case "completed":
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

function isTerminal(submission: AgentSubmission): boolean {
  const status = submissionStatus(submission);
  return status === "completed"
    || status === "failed"
    || status === "interrupted"
    || status === "cancelled";
}

function isSuccessfulSubmission(submission: AgentSubmission): boolean {
  return submissionStatus(submission) === "completed";
}

function submissionFailure(stage: AgentLifecycleStage, submission: AgentSubmission): AgentOperationError {
  return new ConfirmedSubmissionFailure(stage, submission);
}
