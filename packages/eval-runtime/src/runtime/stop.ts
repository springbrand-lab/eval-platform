import type {
  EvaluationAttempt,
  EvaluationOutputSchema,
  EvaluationPlan,
  EvaluationRecord,
  ExecutionAttempt,
  ExecutionPlan,
  HarnessConfig,
  RetryPolicy,
  SamplingStageState,
  SamplingStatus,
} from "@eval-platform/eval-contracts";
import { isPendingSamplingStatus, isTerminalAgentStatus } from "@eval-platform/eval-contracts";
import { AgentHandleNotFoundError } from "../harness/index.js";
import type { AgentHandle, AgentSubmission, Harness } from "../harness/model.js";
import {
  agentOperationKey,
  collectOutputWithRetry,
  errorMessage,
  retryAgentOperation,
  withContext,
  type AgentAttemptRecord,
  type AgentLifecycleStage,
  type StageDependencies,
} from "./agent-lifecycle.js";
import { RuntimeEntityNotFoundError } from "./errors.js";
import { evaluateSampling } from "./evaluation.js";
import { executeSampling } from "./execution.js";
import type { RunStopReporter, StageStopReason, StoppedStageReport } from "./model.js";
import type { RunRecords, RunStagePlans } from "./records.js";
import { evaluationAgentEnded, executionAgentEnded, RECOVERY_FLAGS } from "./recovery.js";
import { refreshFinishedStage } from "./resource-refresh.js";
import type { RetryController } from "./retry.js";
import { createAgentScheduler } from "./scheduler.js";
import { persistRuntimeRecord, type EvaluationState, type RuntimeRunRecord, type RuntimeStore, type SamplingState } from "./store.js";

const STOP_IO_CONCURRENCY = 16;

export interface StopContext {
  readonly store: RuntimeStore;
  readonly records: RunRecords;
  readonly harness: Harness;
  readonly now: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Records already-observed Agent work in `finalizingStop` mode; never restarts an Agent. */
  readonly stageDependencies: StageDependencies;
  readonly outputSchema: (projectId: string) => Promise<EvaluationOutputSchema>;
}

type StageRecord = SamplingState | EvaluationState;
/** Writes `record` over `expected` and returns it as stored. */
type Persist<TRecord> = (record: TRecord, expected: TRecord) => Promise<TRecord>;

/** The stage-specific facts of one stopped execution or evaluation record. */
interface StoppedStage<TRecord extends StageRecord, TAttempt extends AgentAttemptRecord> {
  readonly initial: TRecord;
  readonly stage: AgentLifecycleStage;
  readonly identity: Pick<StoppedStageReport, "stage" | "samplingId" | "evaluationId">;
  readonly retryPolicy: RetryPolicy;
  readonly harnessConfig: HarnessConfig;
  state(record: TRecord): SamplingStageState;
  attempts(record: TRecord): readonly TAttempt[];
  agentEnded(record: TRecord): (attempt: TAttempt) => boolean;
  handle(record: TRecord): AgentHandle | undefined;
  write(record: TRecord, expected: TRecord): Promise<void>;
  read(record: TRecord): Promise<TRecord | null>;
  /** Let the stage persist an observed terminal Submission without restarting; returns the saved record. */
  resumeObserved(record: TRecord): Promise<TRecord>;
  /** Save, once and best-effort, the output of an ended Agent; a failure is returned, not thrown. */
  collectOutput(record: TRecord, operationFound: boolean, persist: Persist<TRecord>, retryController: RetryController): Promise<Collected<TRecord>>;
  withState(record: TRecord, state: SamplingStageState, attempts: readonly TAttempt[]): TRecord;
}

interface Collected<TRecord> {
  readonly record: TRecord;
  readonly error?: string;
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

function evaluatorHandle(evaluation: EvaluationRecord, harness: HarnessConfig): AgentHandle | undefined {
  if (!evaluation.chatId) return undefined;
  return {
    role: "evaluator",
    framework: harness.framework,
    ownerUserId: evaluation.evaluator.ownerUserId,
    chatId: evaluation.chatId,
    samplingId: evaluation.samplingId,
    evaluationId: evaluation.evaluationId,
  };
}

/** Interrupt every SP Submission of a stop-requested Run that may still be active. */
export async function interruptRun(context: StopContext, run: RuntimeRunRecord, plans: RunStagePlans): Promise<void> {
  const samplings = await context.records.samplings(run.samplingIds);
  const handles: { readonly handle: AgentHandle; readonly retryPolicy: RetryPolicy }[] = [];
  const mayBeActive = (status: SamplingStatus, attempts: readonly AgentAttemptRecord[]) => (
    isPendingSamplingStatus(status) && !agentEnded(attempts)
  );
  if (plans.operation !== "evaluation") {
    for (const sampling of samplings) {
      const handle = subjectHandle(sampling, plans.execution.harness);
      if (handle && mayBeActive(sampling.execution.status, sampling.executionAttempts)) {
        handles.push({ handle, retryPolicy: plans.execution.retryPolicy });
      }
    }
  }
  if (plans.operation !== "execution") {
    for (const evaluation of await context.records.evaluations(run.evaluationIds)) {
      const handle = evaluatorHandle(evaluation, plans.evaluation.evaluationHarness);
      if (handle && mayBeActive(evaluation.status.status, evaluation.attempts)) {
        handles.push({ handle, retryPolicy: plans.evaluation.retryPolicy });
      }
    }
  }
  const dependencies = context.stageDependencies;
  await settleAll(
    handles.map(({ handle, retryPolicy }) => () => retryAgentOperation({
      operation: "stop",
      retryController: dependencies.createRetryController(retryPolicy, withContext(dependencies, {
        stage: handle.role === "subject" ? "execution" : "evaluation",
        samplingId: handle.samplingId,
        ...(handle.evaluationId === undefined ? {} : { evaluationId: handle.evaluationId }),
      }).log),
      sleep: context.sleep,
      run: () => context.harness.stopAgent({ handle }),
    })),
    `Could not interrupt Run ${run.runId}`,
  );
}

/** Drive every pending stage of a persisted stop to a terminal status, keeping its saved facts. */
export async function finishStoppedRun(
  context: StopContext, run: RuntimeRunRecord, plans: RunStagePlans, reporter: RunStopReporter | undefined,
): Promise<void> {
  const samplings = await context.records.samplings(run.samplingIds);
  const stages: StoppedStage<SamplingState, ExecutionAttempt>[] = [];
  const evaluationStages: StoppedStage<EvaluationState, EvaluationAttempt>[] = [];
  if (plans.operation !== "evaluation") {
    stages.push(...samplings.map((sampling) => stoppedExecution(context, run.projectId, plans.execution, sampling)));
  }
  if (plans.operation !== "execution") {
    const samplingById = new Map(samplings.map((sampling) => [sampling.samplingId, sampling]));
    for (const evaluation of await context.records.evaluations(run.evaluationIds)) {
      const sampling = samplingById.get(evaluation.samplingId);
      if (!sampling) throw new Error(`Run ${run.runId} is missing Sampling ${evaluation.samplingId}`);
      evaluationStages.push(stoppedEvaluation(context, run.projectId, plans.evaluation, sampling, evaluation));
    }
  }
  const states: Record<string, number> = {};
  for (const key of [
    ...stages.map((stage) => stopStateKey("execution", stage.initial.execution)),
    ...evaluationStages.map((stage) => stopStateKey("evaluation", stage.initial.status)),
  ]) states[key] = (states[key] ?? 0) + 1;
  reporter?.finalizing(states);
  await settleAll([
    ...stages.map((stage) => () => finishStoppedStage(context, stage, reporter)),
    ...evaluationStages.map((stage) => () => finishStoppedStage(context, stage, reporter)),
  ], `Could not finalize stopped Run ${run.runId}`);
}

function stopStateKey(stage: AgentLifecycleStage, state: SamplingStageState): string {
  const flag = RECOVERY_FLAGS.find((name) => state[name] !== undefined && state[name] !== false);
  return [stage, state.status, ...(flag === undefined ? [] : [flag])].join(".");
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

/** Collects once with the fixed idempotent retry budget; only persisting the output may throw. */
async function collectStoppedOutput<TOutput, TRecord>(input: {
  readonly record: TRecord;
  readonly stage: AgentLifecycleStage;
  readonly collect: () => Promise<TOutput>;
  readonly retryController: RetryController;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly save: (output: TOutput) => Promise<TRecord>;
}): Promise<Collected<TRecord>> {
  let output: TOutput;
  try {
    output = await collectOutputWithRetry({
      stage: input.stage,
      collect: input.collect,
      retryController: input.retryController,
      sleep: input.sleep,
    });
  } catch (error) {
    return { record: input.record, error: errorMessage(error) };
  }
  return { record: await input.save(output) };
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
    identity: { stage: "execution", samplingId: initial.samplingId },
    retryPolicy: config.retryPolicy,
    harnessConfig: config.harness,
    state: (record) => record.execution,
    attempts: (record) => record.executionAttempts,
    agentEnded: () => executionAgentEnded,
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
    async collectOutput(record, _operationFound, persist, retryController) {
      const handle = subjectHandle(record, config.harness);
      if (!handle || !agentEnded(record.executionAttempts) || (record.artifacts && record.trajectory)) return { record };
      return collectStoppedOutput({
        record,
        stage: "execution",
        collect: () => context.harness.collectExecution({ handle }),
        retryController,
        sleep: context.sleep,
        save: (output) => persist({ ...record, artifacts: output.artifacts, trajectory: output.trajectory }, record),
      });
    },
    withState: (record, execution, executionAttempts) => ({ ...record, executionAttempts, execution }),
  };
}

function stoppedEvaluation(
  context: StopContext,
  projectId: string,
  config: EvaluationPlan,
  sampling: SamplingState,
  initial: EvaluationState,
): StoppedStage<EvaluationState, EvaluationAttempt> {
  return {
    initial,
    stage: "evaluation",
    identity: { stage: "evaluation", samplingId: initial.samplingId, evaluationId: initial.evaluationId },
    retryPolicy: config.retryPolicy,
    harnessConfig: config.evaluationHarness,
    state: (record) => record.status,
    attempts: (record) => record.attempts,
    agentEnded: evaluationAgentEnded,
    handle: (record) => evaluatorHandle(record, config.evaluationHarness),
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
    async collectOutput(record, operationFound, persist, retryController) {
      const handle = evaluatorHandle(record, config.evaluationHarness);
      if (!handle || !operationFound || !agentEnded(record.attempts) || record.output) return { record };
      return collectStoppedOutput({
        record,
        stage: "evaluation",
        collect: () => context.harness.collectEvaluation({ handle }),
        retryController,
        sleep: context.sleep,
        save: (output) => persist({ ...record, output }, record),
      });
    },
    withState: (record, status, attempts) => ({ ...record, attempts, status }),
  };
}

/**
 * Ends one stage of a pending stop. An Agent observed to have completed keeps its outcome, or fails
 * with the pending work named so a manual recollection can resume it; any other pending stage is
 * cancelled. Saved Attempts, resources, output and export progress are never discarded; resources
 * still owed are recorded failed without reading SP.
 */
async function finishStoppedStage<TRecord extends StageRecord, TAttempt extends AgentAttemptRecord>(
  context: StopContext,
  stage: StoppedStage<TRecord, TAttempt>,
  reporter: RunStopReporter | undefined,
): Promise<void> {
  const dependencies = withContext(context.stageDependencies, stage.identity);
  const retryController = dependencies.createRetryController(stage.retryPolicy, dependencies.log);
  const persist: Persist<TRecord> = (record, expected) => persistRuntimeRecord({
    record,
    expected,
    write: stage.write,
    read: () => stage.read(record),
    retryController,
    sleep: context.sleep,
  });
  const initialStatus = stage.state(stage.initial).status;
  const initialAttempts = stage.attempts(stage.initial);
  const wasPending = isPendingSamplingStatus(initialStatus);
  const collectOwedResources = async (record: TRecord): Promise<TRecord> => {
    let settled = record;
    await refreshFinishedStage(dependencies, {
      stage: stage.stage,
      samplingId: record.samplingId,
      handle: stage.handle(record),
      harnessConfig: stage.harnessConfig,
      retryController,
      attempts: stage.attempts(record),
      state: stage.state(record),
      agentEnded: stage.agentEnded(record),
      persist: async (attempts, state, collected) => {
        if (collected) throw new Error("A stopping Run never reads resources");
        settled = await persist(stage.withState(settled, state, attempts), settled);
      },
    });
    return settled;
  };
  if (!wasPending && !(initialStatus === "failed"
    && (wasInterrupted(initialAttempts) || isUnsubmitted(initialAttempts)))) {
    await collectOwedResources(stage.initial);
    return;
  }

  let current = stage.initial;
  let operationFound = agentEnded(initialAttempts);
  let unconfirmed: string | undefined;
  const attempt = initialAttempts.at(-1);
  const handle = attempt && !operationFound && (attempt.resources || attempt.submissionId || attempt.completedAt)
    ? stage.handle(current) : undefined;
  if (attempt && handle) {
    let receipt: AgentSubmission | null = null;
    try {
      receipt = await inspectStoppedOperation(
        context.harness, handle, agentOperationKey(stage.stage, current.samplingId, attempt.attemptNumber),
        attempt.submissionId, retryController, context.sleep,
      );
    } catch (error) {
      if (error instanceof AgentHandleNotFoundError) throw error;
      unconfirmed = errorMessage(error);
    }
    if (unconfirmed === undefined) {
      operationFound = receipt !== null;
      if (!receipt && attempt.submissionId) {
        throw new Error(`Stopped ${handle.role} Submission ${attempt.submissionId} disappeared`);
      }
      if (receipt && !isTerminalAgentStatus(receipt.status)) {
        throw new Error(`Stopped ${handle.role} Submission ${receipt.submissionId} is still active`);
      }
      if (receipt && isPendingSamplingStatus(stage.state(current).status)) current = await stage.resumeObserved(current);
    }
  }

  const collected = await stage.collectOutput(current, operationFound, persist, retryController);
  current = await collectOwedResources(collected.record);
  const state = stage.state(current);
  const attempts = stage.attempts(current);
  const last = attempts.at(-1);
  const finish = async (status: StoppedStageReport["status"], reason: StageStopReason, lastError: string, nextAttempts = attempts) => {
    await persist(stage.withState(current, { status, lastError }, nextAttempts), current);
    reporter?.stageStopped({ ...stage.identity, status, reason });
  };
  if (last?.status === "completed") {
    if (!isPendingSamplingStatus(state.status)) return;
    const reason = state.evidencePending ? "evidence-export" : "output-collection";
    const cause = collected.error ?? state.lastError;
    await finish("failed", reason, `Run stopped before ${reason === "evidence-export" ? "evidence export" : "output collection"} finished${
      cause === undefined ? "" : `; last: ${cause}`}`);
    return;
  }
  if (!isPendingSamplingStatus(state.status) && !(state.status === "failed"
    && (wasPending || wasInterrupted(attempts) || (isUnsubmitted(attempts) && !operationFound)))) return;
  if (unconfirmed !== undefined) {
    await finish("cancelled", "status-unconfirmed", `Run stopped before its status was confirmed: ${unconfirmed}`);
    return;
  }
  const unsubmitted = last !== undefined && !last.submissionId && !operationFound;
  await finish(
    "cancelled", last === undefined || unsubmitted ? "not-started" : "agent-stopped", "Run stopped",
    unsubmitted ? [...attempts.slice(0, -1), stoppedAttempt(last, context.now())] : attempts,
  );
}

async function inspectStoppedOperation(
  harness: Harness,
  handle: AgentHandle,
  idempotencyKey: string,
  submissionId: string | undefined,
  retryController: RetryController,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<AgentSubmission | null> {
  return retryAgentOperation({
    operation: "status",
    retryController,
    sleep,
    run: async () => {
      try {
        return await harness.inspectAgentOperation({ handle, idempotencyKey });
      } catch (error) {
        if (error instanceof AgentHandleNotFoundError && !submissionId) return null;
        throw error;
      }
    },
  });
}

function requireRecord<T>(record: T | null, entity: "sampling" | "evaluation", id: string): T {
  if (!record) throw new RuntimeEntityNotFoundError(entity, id);
  return record;
}

/** The last Attempt's Submission has a saved terminal, so its Agent no longer runs. */
function agentEnded(attempts: readonly AgentAttemptRecord[]): boolean {
  const attempt = attempts.at(-1);
  return attempt?.submissionId !== undefined && executionAgentEnded(attempt);
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
