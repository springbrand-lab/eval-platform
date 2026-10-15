import type {
  EvaluationAttempt,
  EvaluationOutputSchema,
  EvaluationPlan,
  EvaluationRecord,
  ExecutionAttempt,
  ExecutionPlan,
  HarnessConfig,
  RetryPolicy,
  SamplingStatus,
} from "@eval-platform/eval-contracts";
import { isPendingSamplingStatus, isTerminalAgentStatus } from "@eval-platform/eval-contracts";
import { AgentHandleNotFoundError } from "../harness/index.js";
import type { AgentHandle, AgentSubmission, Harness } from "../harness/model.js";
import {
  agentOperationKey,
  errorMessage,
  type AgentAttemptRecord,
  type AgentLifecycleStage,
  type StageDependencies,
} from "./agent-lifecycle.js";
import { RuntimeEntityNotFoundError } from "./errors.js";
import { evaluateSampling } from "./evaluation.js";
import { executeSampling } from "./execution.js";
import type { RunRecords, RunStagePlans } from "./records.js";
import type { RetryController } from "./retry.js";
import { createAgentScheduler } from "./scheduler.js";
import { persistRuntimeRecord, type RuntimeRunRecord, type RuntimeStore, type SamplingState } from "./store.js";

const STOP_IO_CONCURRENCY = 16;

export interface StopContext {
  readonly store: RuntimeStore;
  readonly records: RunRecords;
  readonly harness: Harness;
  readonly now: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly createRetryController: (policy?: RetryPolicy) => RetryController;
  /** Finishes already-observed Agent work but never restarts an Agent. */
  readonly stageDependencies: StageDependencies;
  readonly outputSchema: (projectId: string) => Promise<EvaluationOutputSchema>;
}

type StageRecord = SamplingState | EvaluationRecord;
type Persist<TRecord> = (record: TRecord, expected: TRecord) => Promise<void>;

/** The stage-specific facts of one stopped execution or evaluation record. */
interface StoppedStage<TRecord extends StageRecord, TAttempt extends AgentAttemptRecord> {
  readonly initial: TRecord;
  readonly stage: AgentLifecycleStage;
  readonly retryPolicy: RetryPolicy;
  status(record: TRecord): SamplingStatus;
  attempts(record: TRecord): readonly TAttempt[];
  handle(record: TRecord): AgentHandle | undefined;
  write: Persist<TRecord>;
  read(record: TRecord): Promise<TRecord | null>;
  /** Let the stage persist an observed terminal Submission without restarting; returns the saved record. */
  resumeObserved(record: TRecord): Promise<TRecord>;
  /** Save evidence of an interrupted Agent; null leaves the record recoverable. */
  collectEvidence(record: TRecord, operationFound: boolean, persist: Persist<TRecord>): Promise<TRecord | null>;
  cancelled(record: TRecord, attempts: readonly TAttempt[]): TRecord;
}

function subjectHandle(sampling: SamplingState, harness: HarnessConfig): AgentHandle | undefined {
  if (!sampling.subjectChatId) return undefined;
  return {
    role: "subject",
    framework: harness.framework,
    ownerUserId: sampling.subjectAgent.ownerUserId,
    chatId: sampling.subjectChatId,
    samplingId: sampling.samplingId,
  };
}

function evaluatorHandle(
  evaluation: EvaluationRecord,
  harness: HarnessConfig,
  sampling: SamplingState,
): AgentHandle | undefined {
  if (!evaluation.chatId) return undefined;
  return {
    role: "evaluator",
    framework: harness.framework,
    ownerUserId: evaluation.evaluator.ownerUserId,
    chatId: evaluation.chatId,
    samplingId: evaluation.samplingId,
    ...(sampling.subjectChatId ? { evaluationWorkspace: {
      subject: { userId: sampling.subjectAgent.ownerUserId, chatId: sampling.subjectChatId },
      evaluationId: evaluation.evaluationId,
    } } : {}),
  };
}

/** Interrupt every SP Submission of a stop-requested Run that may still be active. */
export async function interruptRun(context: StopContext, run: RuntimeRunRecord, plans: RunStagePlans): Promise<void> {
  const samplings = await context.records.samplings(run.samplingIds);
  const handles: AgentHandle[] = [];
  if (plans.operation !== "evaluation") {
    for (const sampling of samplings) {
      const handle = subjectHandle(sampling, plans.execution.harness);
      if (handle && isPendingSamplingStatus(sampling.execution.status)) handles.push(handle);
    }
  }
  if (plans.operation !== "execution") {
    const samplingById = new Map(samplings.map((sampling) => [sampling.samplingId, sampling]));
    for (const evaluation of await context.records.evaluations(run.evaluationIds)) {
      const sampling = samplingById.get(evaluation.samplingId);
      if (!sampling) throw new Error(`Run ${run.runId} is missing Sampling ${evaluation.samplingId}`);
      const handle = evaluatorHandle(evaluation, plans.evaluation.evaluationHarness, sampling);
      if (handle && isPendingSamplingStatus(evaluation.status.status)) handles.push(handle);
    }
  }
  await settleAll(
    handles.map((handle) => () => context.harness.stopAgent({ handle })),
    `Could not interrupt Run ${run.runId}`,
  );
}

/** Cancel, or collect the evidence of, every stage interrupted by a persisted stop. */
export async function finishStoppedRun(context: StopContext, run: RuntimeRunRecord, plans: RunStagePlans): Promise<void> {
  const samplings = await context.records.samplings(run.samplingIds);
  const tasks: (() => Promise<void>)[] = [];
  if (plans.operation !== "evaluation") {
    tasks.push(...samplings.map((sampling) => () => finishStoppedStage(
      context, stoppedExecution(context, run.projectId, plans.execution, sampling),
    )));
  }
  if (plans.operation !== "execution") {
    const evaluationPlan = plans.evaluation;
    const samplingById = new Map(samplings.map((sampling) => [sampling.samplingId, sampling]));
    const evaluations = await context.records.evaluations(run.evaluationIds);
    tasks.push(...evaluations.map((evaluation) => async () => {
      const sampling = samplingById.get(evaluation.samplingId);
      if (!sampling) throw new Error(`Run ${run.runId} is missing Sampling ${evaluation.samplingId}`);
      await finishStoppedStage(context, stoppedEvaluation(context, run.projectId, evaluationPlan, sampling, evaluation));
    }));
  }
  await settleAll(tasks, `Could not finalize stopped Run ${run.runId}`);
}

async function settleAll(tasks: readonly (() => Promise<void>)[], message: string): Promise<void> {
  const errors: unknown[] = [];
  await createAgentScheduler({ maxConcurrentDos: STOP_IO_CONCURRENCY }).run(tasks.map((task) => async () => {
    try {
      await task();
    } catch (error) {
      errors.push(error);
    }
  }));
  if (errors.length > 0) throw new AggregateError(errors, message);
}

function stoppedExecution(
  context: StopContext,
  projectId: string,
  config: ExecutionPlan,
  initial: SamplingState,
): StoppedStage<SamplingState, ExecutionAttempt> {
  return {
    initial,
    stage: "execution",
    retryPolicy: config.retryPolicy,
    status: (record) => record.execution.status,
    attempts: (record) => record.executionAttempts,
    handle: (record) => subjectHandle(record, config.harness),
    write: (record, expected) => context.store.updateSampling(record, expected),
    read: (record) => context.store.getSampling(record.samplingId),
    async resumeObserved(record) {
      const sampleFor = await context.records.samples([record], projectId);
      await executeSampling(context.stageDependencies, {
        context: { state: record, sample: sampleFor(record) },
        harnessConfig: config.harness,
        retryPolicy: config.retryPolicy,
      });
      return requireRecord(await context.store.getSampling(record.samplingId), "sampling", record.samplingId);
    },
    async collectEvidence(record, _operationFound, persist) {
      if (record.execution.evidencePending) return null;
      const handle = subjectHandle(record, config.harness);
      if (!handle || !wasInterrupted(record.executionAttempts) || (record.artifacts && record.trajectory)) return record;
      let output;
      try {
        output = await context.harness.collectExecution({ handle });
      } catch (error) {
        await persist({
          ...record,
          execution: { status: "retrying", evidencePending: true, lastError: errorMessage(error) },
        }, record);
        return null;
      }
      const next = { ...record, artifacts: output.artifacts, trajectory: output.trajectory };
      await persist(next, record);
      return next;
    },
    cancelled: (record, executionAttempts) => ({
      ...record,
      executionAttempts,
      execution: { status: "cancelled", lastError: "Run stopped" },
    }),
  };
}

function stoppedEvaluation(
  context: StopContext,
  projectId: string,
  config: EvaluationPlan,
  sampling: SamplingState,
  initial: EvaluationRecord,
): StoppedStage<EvaluationRecord, EvaluationAttempt> {
  return {
    initial,
    stage: "evaluation",
    retryPolicy: config.retryPolicy,
    status: (record) => record.status.status,
    attempts: (record) => record.attempts,
    handle: (record) => evaluatorHandle(record, config.evaluationHarness, sampling),
    write: (record, expected) => context.store.updateEvaluation(record, expected),
    read: (record) => context.store.getEvaluation(record.evaluationId),
    async resumeObserved(record) {
      const sampleFor = await context.records.samples([sampling], projectId);
      const evaluationOutputSchema = await context.outputSchema(projectId);
      await evaluateSampling(context.stageDependencies, {
        context: { sampling, evaluation: record, sample: sampleFor(sampling) },
        harnessConfig: config.evaluationHarness,
        retryPolicy: config.retryPolicy,
        evaluationOutputSchema,
      });
      return requireRecord(await context.store.getEvaluation(record.evaluationId), "evaluation", record.evaluationId);
    },
    async collectEvidence(record, operationFound, persist) {
      const handle = evaluatorHandle(record, config.evaluationHarness, sampling);
      if (!handle || !operationFound || !wasInterrupted(record.attempts) || record.output) return record;
      let output;
      try {
        output = await context.harness.collectEvaluation({ handle });
      } catch (error) {
        await persist({ ...record, status: { status: "retrying", lastError: errorMessage(error) } }, record);
        return null;
      }
      const next = { ...record, output };
      await persist(next, record);
      return next;
    },
    cancelled: (record, attempts) => ({ ...record, attempts, status: { status: "cancelled", lastError: "Run stopped" } }),
  };
}

async function finishStoppedStage<TRecord extends StageRecord, TAttempt extends AgentAttemptRecord>(
  context: StopContext,
  stage: StoppedStage<TRecord, TAttempt>,
): Promise<void> {
  const retryController = context.createRetryController(stage.retryPolicy);
  const persist: Persist<TRecord> = (record, expected) => persistRuntimeRecord({
    record,
    expected,
    write: stage.write,
    read: () => stage.read(record),
    retryController,
    sleep: context.sleep,
  });
  const initialStatus = stage.status(stage.initial);
  const initialAttempts = stage.attempts(stage.initial);
  const wasPending = isPendingSamplingStatus(initialStatus);
  if (!wasPending && !(initialStatus === "failed"
    && (wasInterrupted(initialAttempts) || isUnsubmitted(initialAttempts)))) return;

  let current = stage.initial;
  let operationFound = false;
  const attempt = initialAttempts.at(-1);
  const handle = attempt && (attempt.resources || attempt.submissionId || attempt.completedAt)
    ? stage.handle(current) : undefined;
  if (attempt && handle) {
    const receipt = await inspectStoppedOperation(
      context.harness, handle, agentOperationKey(stage.stage, current.samplingId, attempt.attemptNumber),
      attempt.submissionId,
    );
    operationFound = receipt !== null;
    if (!receipt && attempt.submissionId) {
      throw new Error(`Stopped ${handle.role} Submission ${attempt.submissionId} disappeared`);
    }
    if (receipt && !isTerminalAgentStatus(receipt.status)) {
      throw new Error(`Stopped ${handle.role} Submission ${receipt.submissionId} is still active`);
    }
    if (receipt && isPendingSamplingStatus(stage.status(current))) current = await stage.resumeObserved(current);
  }

  const finalized = await stage.collectEvidence(current, operationFound, persist);
  if (!finalized) return;
  current = finalized;
  const status = stage.status(current);
  const attempts = stage.attempts(current);
  if (!isPendingSamplingStatus(status) && !(status === "failed"
    && (wasPending || wasInterrupted(attempts) || (isUnsubmitted(attempts) && !operationFound)))) return;
  const last = attempts.at(-1);
  await persist(stage.cancelled(current, last && !last.submissionId && !operationFound
    ? [...attempts.slice(0, -1), stoppedAttempt(last, context.now())]
    : attempts), current);
}

async function inspectStoppedOperation(
  harness: Harness, handle: AgentHandle, idempotencyKey: string, submissionId: string | undefined,
): Promise<AgentSubmission | null> {
  try {
    return await harness.inspectAgentOperation({ handle, idempotencyKey });
  } catch (error) {
    if (error instanceof AgentHandleNotFoundError && !submissionId) return null;
    throw error;
  }
}

function requireRecord<T>(record: T | null, entity: "sampling" | "evaluation", id: string): T {
  if (!record) throw new RuntimeEntityNotFoundError(entity, id);
  return record;
}

function wasInterrupted(attempts: readonly AgentAttemptRecord[]): boolean {
  const status = attempts.at(-1)?.status;
  return status === "interrupted" || status === "cancelled";
}

function isUnsubmitted(attempts: readonly AgentAttemptRecord[]): boolean {
  const attempt = attempts.at(-1);
  return !!attempt && !attempt.submissionId && attempt.status !== "completed";
}

function stoppedAttempt<T extends AgentAttemptRecord>(attempt: T, completedAt: string): T {
  const { resources: _resources, ...facts } = attempt;
  return { ...facts, status: "cancelled", completedAt, error: "Run stopped" } as T;
}
