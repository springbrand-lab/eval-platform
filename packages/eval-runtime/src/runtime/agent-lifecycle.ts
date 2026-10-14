import type {
  AgentRole,
  AgentResourceCollection,
  AgentResourceScope,
  AgentStatus,
  HarnessConfig,
  Sampling,
  SamplingStatus,
  SpHarnessConfig,
} from "@eval-platform/eval-contracts";

import type {
  AgentHandle,
  AgentSubmission,
  EnsureAgentInput,
  EvaluationWorkspaceBinding,
  Harness,
  HarnessRuntimeOptions,
} from "../harness/index.js";
import type {
  RetryController,
  RetryOperation,
  RetryableFailureKind,
} from "./retry.js";
import { validateResourceSnapshot } from "./resources.js";
import { RuntimeRecordPersistenceError } from "./record-errors.js";

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
  readonly onError?: (error: Error) => void;
}

export interface AgentLifecycleOptions<TAttempt extends AgentAttemptRecord, TOutput> {
  readonly stage: AgentLifecycleStage;
  readonly role: AgentRole;
  readonly projectId: string;
  readonly samplingId: string;
  readonly chatId: string;
  readonly evaluationWorkspace?: EvaluationWorkspaceBinding;
  readonly harnessConfig: SpHarnessConfig;
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

export class ConfirmedSubmissionFailure extends AgentOperationError {
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
  if (harness.runtime && "workspaceMode" in harness.runtime) {
    throw new Error(`${role} harness runtime.workspaceMode is no longer supported`);
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

    try {
      if (attempt.completedAt && !attempt.resources) {
        throw new AgentOperationError(attempt.error ?? "Agent failed before submission", false, "network");
      }
      if (!handle) {
        handle = await ensureAgentWithRetry(dependencies, options, retryController);
      }

      if (attemptNumber === 1 && !attempt.resources) {
        await prepareAgentWithRetry(dependencies, options, handle, retryController);
      }

      const idempotencyKey = attemptNumber === 1
        ? `${options.stage}:${options.samplingId}`
        : `${options.stage}:${options.samplingId}:restart:${attemptNumber}`;
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
            terminal = { submissionId: attempt.submissionId, status: "completed", normalizedStatus: "completed" };
          } else {
            const inspection = await inspectPersistedTerminalWithRetry(
              dependencies, options, handle, idempotencyKey, retryController,
            );
            requireSubmissionId(inspection);
            if (attempt.submissionId && attempt.submissionId !== inspection.submissionId) {
              throw new AgentOperationError("Persisted terminal belongs to a different Submission", false, "network");
            }
            if (!attempt.submissionId) {
              attempt = await options.updateAttempt(attempt, { submissionId: inspection.submissionId });
            }
            resourceScope = { ...resourceScope, submissionId: inspection.submissionId };
            if (submissionStatus(inspection) !== attempt.status) {
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
              retryController,
            );
          requireSubmissionId(submission);
          if (attempt.submissionId && attempt.submissionId !== submission.submissionId) {
            throw new AgentOperationError("Attempt belongs to a different Submission", false, "network");
          }
          if (!attempt.submissionId) {
            attempt = await options.updateAttempt(attempt, { submissionId: submission.submissionId });
          }
          resourceScope = { ...resourceScope, submissionId: submission.submissionId };
          terminal = isTerminal(submission)
            ? submission
            : await waitForTerminalWithRetry(
                dependencies, options, handle, idempotencyKey, retryController,
              );
          if (terminal.submissionId !== attempt.submissionId) {
            throw new AgentOperationError("Terminal status belongs to a different Submission", false, "network");
          }
          const status = submissionStatus(terminal);
          if (status === undefined) throw new Error(`${options.stage} submission has no terminal status`);
          terminalPatch = {
            status,
            completedAt: dependencies.now(),
            ...(isSuccessfulSubmission(terminal) ? {} : { error: submissionFailure(options.stage, terminal).message }),
          };
          attempt = await options.updateAttempt(attempt, terminalPatch);
        }
      } finally {
        const terminalSaved = terminalPatch === undefined || attempt.completedAt !== undefined;
        const needsResources = attempt.resources?.status === "pending"
          || (attempt.resources?.status === "collected" && terminal !== undefined
            && !attempt.resources.snapshot.finalized);
        if (terminalSaved && needsResources) {
          const resources = await collectResourcesWithRetry(
            dependencies, options, handle, resourceScope, retryController,
          );
          if (resources.status === "collected" && attempt.submissionId
            && resources.snapshot.scope.submissionId !== attempt.submissionId) {
            throw new AgentOperationError("Resources belong to a different Submission", false, "network");
          }
          if (attempt.resources?.status === "collected" && resources.status === "failed") {
            const reported = new Error(
              options.stage + " resource refresh failed for sampling " + options.samplingId
              + " and Chat " + resourceScope.chatId + ": " + resources.error,
            );
            try {
              (dependencies.onError ?? console.error)(reported);
            } catch (reportingError) {
              console.error(reported, reportingError);
            }
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
        throw submissionFailure(options.stage, terminal);
      }

      await options.setSamplingStatus("running");
      const output = await collectOutputWithRetry({
        stage: options.stage,
        collect: () => options.collectOutput(handle!),
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
      if (error instanceof RuntimeRecordPersistenceError) throw error;
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

async function ensureAgentWithRetry<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
  retryController: RetryController,
): Promise<AgentHandle> {
  if ((options.role === "evaluator") !== (options.evaluationWorkspace !== undefined)) {
    throw new AgentOperationError("Evaluator Workspace binding does not match Agent role", false, "network");
  }
  const input: EnsureAgentInput = {
    chatId: options.chatId,
    role: options.role,
    samplingId: options.samplingId,
    framework: options.harnessConfig.framework,
    agentConfig: options.harnessConfig.agentConfig,
    projectId: options.projectId,
    ...(options.evaluationWorkspace === undefined ? {} : { evaluationWorkspace: options.evaluationWorkspace }),
    ...(options.harnessConfig.runtime === undefined ? {} : { runtime: options.harnessConfig.runtime }),
  };

  for (let creationAttemptNumber = 1; ; creationAttemptNumber += 1) {
    try {
      const handle = await dependencies.harness.ensureAgent(input);
      if (
        handle.chatId !== input.chatId
        || handle.role !== input.role
        || handle.framework !== input.framework
        || handle.samplingId !== input.samplingId
        || !sameEvaluationWorkspace(handle.evaluationWorkspace, input.evaluationWorkspace)
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

function sameEvaluationWorkspace(
  actual: EvaluationWorkspaceBinding | undefined,
  expected: EvaluationWorkspaceBinding | undefined,
): boolean {
  if (expected === undefined) return actual === undefined;
  return actual?.evaluationId === expected.evaluationId
    && actual?.subject?.userId === expected.subject.userId
    && actual?.subject?.chatId === expected.subject.chatId;
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

export async function collectOutputWithRetry<TOutput>(input: {
  readonly stage: AgentLifecycleStage;
  readonly collect: () => Promise<TOutput>;
  readonly retryController: RetryController;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly onRetry?: (message: string) => Promise<void>;
},
): Promise<TOutput> {
  for (let collectionAttemptNumber = 1; ; collectionAttemptNumber += 1) {
    try {
      return await input.collect();
    } catch (error) {
      const details = describeAgentError(error);
      if (!details.retryable) {
        throw new OutputCollectionError(input.stage, details, error);
      }

      const decision = await input.retryController.decide({
        operation: "collection",
        failureKind: details.failureKind,
        attemptNumber: collectionAttemptNumber,
      });
      if (!decision.shouldRetry) {
        throw new OutputCollectionError(input.stage, details, error);
      }

      await input.onRetry?.(details.message);
      await input.sleep(decision.backoffMs ?? 0);
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
          ...(scope.submissionId === undefined ? {} : { submissionId: scope.submissionId }),
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

async function inspectPersistedTerminalWithRetry<TAttempt extends AgentAttemptRecord, TOutput>(
  dependencies: AgentLifecycleDependencies,
  options: AgentLifecycleOptions<TAttempt, TOutput>,
  handle: AgentHandle,
  idempotencyKey: string,
  retryController: RetryController,
): Promise<AgentSubmission> {
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    let details: ReturnType<typeof describeAgentError> = {
      message: "Persisted Agent failure could not be confirmed",
      retryable: true,
      failureKind: "submission-timeout",
    };
    try {
      const inspection = await dependencies.harness.inspectAgentOperation({
        handle,
        idempotencyKey,
        ...(options.harnessConfig.runtime === undefined ? {} : { runtime: options.harnessConfig.runtime }),
      });
      if (inspection && isTerminal(inspection)) return inspection;
    } catch (error) {
      details = describeAgentError(error);
      if (!details.retryable) throw error;
    }

    const decision = await retryController.decide({
      operation: "status",
      failureKind: details.failureKind,
      attemptNumber,
    });
    if (!decision.shouldRetry) throw new SubmissionStatusError(options.stage, details, undefined);
    await options.setSamplingStatus("retrying", details.message);
    await dependencies.sleep(decision.backoffMs ?? 0);
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

function requireSubmissionId(submission: AgentSubmission): void {
  if (typeof submission.submissionId !== "string" || submission.submissionId.trim().length === 0) {
    throw new AgentOperationError("SP Submission receipt has no Submission ID", false, "network");
  }
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
