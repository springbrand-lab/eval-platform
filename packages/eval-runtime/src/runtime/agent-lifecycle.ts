import type {
  AgentRole,
  AgentResourceCollection,
  AgentResourceScope,
  AgentStatus,
  HarnessConfig,
  RetryPolicy,
  Sampling,
  SamplingStatus,
  SpHarnessConfig,
} from "@eval-platform/eval-contracts";

import type {
  AgentHandle,
  AgentSubmission,
  EnsureAgentInput,
  Harness,
  HarnessRuntimeOptions,
} from "../harness/index.js";
import type {
  RetryController,
  RetryOperation,
  RetryableFailureKind,
} from "./retry.js";
import { validateResourceSnapshot } from "./resources.js";

export type AgentLifecycleStage = "execution" | "evaluation";

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
  readonly createRetryController: (policy?: RetryPolicy) => RetryController;
}

export interface AgentLifecycleOptions<TAttempt extends AgentAttemptRecord, TOutput> {
  readonly stage: AgentLifecycleStage;
  readonly role: AgentRole;
  readonly projectId: string;
  readonly samplingId: string;
  readonly submissionId: string;
  readonly harnessConfig: SpHarnessConfig;
  readonly prompt: string;
  readonly retryPolicy: RetryPolicy;
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
    ...(patch.resources === undefined ? {} : { resources: patch.resources }),
  } as TAttempt;
}

export function requireSpHarness(harness: HarnessConfig, role: AgentRole): SpHarnessConfig {
  if (harness.kind !== "sp") {
    throw new Error(`${role} harness kind ${harness.kind} is not implemented`);
  }
  return harness;
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
  const retryController = dependencies.createRetryController(options.retryPolicy);
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
        handle = await ensureAgentWithRetry(dependencies, options, retryController);
      }

      attempt = await options.updateAttempt(attempt, {
        submissionId: handle.submissionId,
      });

      if (!prepared) {
        await prepareAgentWithRetry(dependencies, options, handle, retryController);
        prepared = true;
      }

      const idempotencyKey = restartRequested
        ? `${options.stage}:${options.samplingId}:restart:${attemptNumber}`
        : `${options.stage}:${options.samplingId}`;
      const resourceScope = { submissionId: handle.submissionId, idempotencyKey };
      attempt = await options.updateAttempt(attempt, {
        resources: { status: "pending", scope: resourceScope },
      });
      let terminal: AgentSubmission;
      try {
        const submission = await submitWithReconciliation(
          dependencies,
          options,
          handle,
          idempotencyKey,
          restartRequested ? "restart" : "submission",
          retryController,
        );
        restartRequested = false;

        terminal = isTerminal(submission)
          ? submission
          : await waitForTerminalWithRetry(
              dependencies,
              options,
              handle,
              idempotencyKey,
              retryController,
            );
      } finally {
        const resources = await collectResourcesWithRetry(
          dependencies,
          options,
          handle,
          resourceScope,
          retryController,
        );
        attempt = await options.updateAttempt(attempt, { resources });
      }
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

async function ensureAgentWithRetry<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
  retryController: RetryController,
): Promise<AgentHandle> {
  const input: EnsureAgentInput = {
    submissionId: options.submissionId,
    role: options.role,
    samplingId: options.samplingId,
    framework: options.harnessConfig.framework,
    agentConfig: options.harnessConfig.agentConfig,
    projectId: options.projectId,
    ...(options.harnessConfig.runtime === undefined ? {} : { runtime: options.harnessConfig.runtime }),
  };

  for (let creationAttemptNumber = 1; ; creationAttemptNumber += 1) {
    try {
      const handle = await dependencies.harness.ensureAgent(input);
      if (
        handle.submissionId !== input.submissionId
        || handle.role !== input.role
        || handle.framework !== input.framework
        || handle.samplingId !== input.samplingId
      ) {
        throw new AgentOperationError(
          `${options.stage} agent handle does not match the requested identity`,
          false,
          "network",
        );
      }
      return handle;
    } catch (error) {
      const details = describeAgentError(error);
      if (!details.retryable) throw error;

      const decision = await retryController.decide({
        operation: "creation",
        failureKind: details.failureKind,
        attemptNumber: creationAttemptNumber,
      });
      if (!decision.shouldRetry) throw error;

      await options.setSamplingStatus("retrying", details.message);
      await dependencies.sleep(decision.backoffMs ?? 0);
    }
  }
}

async function prepareAgentWithRetry<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
  handle: AgentHandle,
  retryController: RetryController,
): Promise<void> {
  for (let initializationAttemptNumber = 1; ; initializationAttemptNumber += 1) {
    try {
      await options.prepare(handle);
      return;
    } catch (error) {
      const details = describeAgentError(error);
      if (!details.retryable) throw error;

      const decision = await retryController.decide({
        operation: "initialization",
        failureKind: details.failureKind,
        attemptNumber: initializationAttemptNumber,
      });
      if (!decision.shouldRetry) throw error;

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
        ...(options.harnessConfig.runtime === undefined ? {} : { runtime: options.harnessConfig.runtime }),
      };
      return operation === "restart"
        ? await dependencies.harness.restartAgent(input)
        : await dependencies.harness.submitAgent(input);
    } catch (error) {
      const reconciliation = await inspectUncertainOperation(
        dependencies.harness,
        handle,
        idempotencyKey,
        options.harnessConfig.runtime,
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
        options.harnessConfig.runtime,
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

async function collectResourcesWithRetry<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
  handle: AgentHandle,
  scope: AgentResourceScope,
  retryController: RetryController,
): Promise<AgentResourceCollection> {
  try {
    for (let attemptNumber = 1; ; attemptNumber += 1) {
      try {
        const snapshot = await dependencies.harness.collectAgentResources({
          handle,
          idempotencyKey: scope.idempotencyKey,
          ...(options.harnessConfig.runtime === undefined ? {} : { runtime: options.harnessConfig.runtime }),
        });
        return { status: "collected", snapshot: validateResourceSnapshot(snapshot, scope) };
      } catch (error) {
        const details = describeAgentError(error);
        if (!details.retryable) throw error;
        const decision = await retryController.decide({
          operation: "resources",
          failureKind: details.failureKind,
          attemptNumber,
        });
        if (!decision.shouldRetry) throw error;
        await dependencies.sleep(decision.backoffMs ?? 0);
      }
    }
  } catch (error) {
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
    return (await harness.inspectAgentOperation({
      handle,
      idempotencyKey,
      ...(runtime === undefined ? {} : { runtime }),
    })) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function waitForTerminal(
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
