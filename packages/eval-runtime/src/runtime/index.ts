import type {
  AgentConfigRef,
  AgentRole,
  EvaluationOutputSchema,
  EvaluationRecord,
  EvaluateRequest,
  PipelineRequest,
  Project,
  RetryPolicy,
  RunHandle,
  RunPhases,
  RunSnapshot,
  Sampling,
  StartRunRequest,
} from "@eval-platform/eval-contracts";
import { isPendingSamplingStatus } from "@eval-platform/eval-contracts";
import type {
  ResolvedEvaluationConfig,
  ResolvedExecutionConfig,
  RunConfigSnapshot,
} from "../config/index.js";
import { AgentHandleNotFoundError, type AgentHandle, type AgentSubmission, type Harness } from "../harness/index.js";

import type {
  EvalRuntime,
  EvalRuntimeDependencies,
  EvalRunAdmission,
  EvalRunAdmissionDependencies,
  EvalRunResumer,
  EvalRunResumerDependencies,
  RuntimeAdmissionCatalog,
  RuntimeCatalog,
  RuntimeEvaluationContext,
  Sample,
  SamplingSnapshot,
  RuntimeSamplingContext,
} from "./model.js";
import type {
  RuntimeRunAdmission,
  RuntimeRunRequestIdentity,
  RuntimeRunRecord,
  SamplingState,
} from "./store.js";
import { persistRuntimeRecord, RuntimeRunIdentityConflictError, RuntimeRunStoppedError } from "./store.js";
import {
  type AgentAttemptRecord,
  agentOperationKey,
  errorMessage,
  requireSpHarness,
} from "./agent-lifecycle.js";
import {
  executeSampling,
  type ExecutionStageDependencies,
} from "./execution.js";
import {
  evaluateSampling,
  requireEvaluationPrompt,
  type EvaluationStageDependencies,
} from "./evaluation.js";
import {
  createRetryController,
  type RetryController,
} from "./retry.js";
import { createAgentScheduler, type AgentScheduler } from "./scheduler.js";
import { toRunSnapshot, toSamplingSnapshot } from "./projection.js";

type RuntimeStageDependencies = ExecutionStageDependencies & EvaluationStageDependencies;
const STOP_IO_CONCURRENCY = 16;

/** The chosen Sampling set cannot be admitted as an independent evaluation. */
export class RuntimeEvaluationSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeEvaluationSelectionError";
  }
}

export class RuntimeRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Unknown run ${runId}`);
    this.name = "RuntimeRunNotFoundError";
  }
}

function defaultIdFactory(): string {
  return crypto.randomUUID();
}

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stoppedAttempt<T extends AgentAttemptRecord>(attempt: T, completedAt: string): T {
  const { resources: _resources, ...facts } = attempt;
  return { ...facts, status: "cancelled", completedAt, error: "Run stopped" } as T;
}

export function requireSourceCommit(sourceCommit: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommit)) {
    throw new TypeError("sourceCommit must be a full lowercase Git commit hash");
  }
  return sourceCommit;
}

function requireDistinctIds(ids: readonly string[], field: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${field} must not contain duplicate ids`);
  }
}

class RunReader {
  protected readonly store: EvalRunResumerDependencies["store"];
  protected readonly idFactory: () => string;
  readonly #getSamples: EvalRunResumerDependencies["getSamples"];

  constructor(dependencies: Pick<EvalRunResumerDependencies, "store" | "idFactory" | "getSamples">) {
    this.store = dependencies.store;
    this.idFactory = dependencies.idFactory ?? defaultIdFactory;
    this.#getSamples = dependencies.getSamples;
  }

  protected async loadSamplingRecords(
    samplingIds: readonly string[],
  ): Promise<readonly SamplingState[]> {
    const records = await this.store.getSamplings(samplingIds);
    if (records.length !== samplingIds.length) throw new Error("Store returned an incomplete Sampling batch");
    return records.map((record, index) => {
      const samplingId = samplingIds[index]!;
      if (!record) throw new Error(`Unknown sampling ${samplingId}`);
      if (record.samplingId !== samplingId) throw new Error(`Store returned Sampling ${record.samplingId} for ${samplingId}`);
      return record;
    });
  }

  protected async loadEvaluationRecords(
    evaluationIds: readonly string[],
  ): Promise<readonly EvaluationRecord[]> {
    const records = await this.store.getEvaluations(evaluationIds);
    if (records.length !== evaluationIds.length) throw new Error("Store returned an incomplete Evaluation batch");
    return records.map((evaluation, index) => {
      const evaluationId = evaluationIds[index]!;
      if (!evaluation) throw new Error(`Unknown evaluation ${evaluationId}`);
      if (evaluation.evaluationId !== evaluationId) {
        throw new Error(`Store returned Evaluation ${evaluation.evaluationId} for ${evaluationId}`);
      }
      return evaluation;
    });
  }

  protected async loadSamplingContexts(
    records: readonly SamplingState[],
    projectId: string,
  ): Promise<readonly RuntimeSamplingContext[]> {
    for (const record of records) {
      if (record.projectId !== projectId) {
        throw new Error(`Sampling ${record.samplingId} does not belong to project ${projectId}`);
      }
    }
    const sampleIds = [...new Set(records.map((record) => record.sampleId))];
    const samples = await this.#getSamples(sampleIds);
    if (samples.length !== sampleIds.length) throw new Error("Catalog returned an incomplete Sample batch");
    const byId = new Map<string, Sample>();
    for (let index = 0; index < sampleIds.length; index += 1) {
      const sampleId = sampleIds[index]!;
      const sample = samples[index];
      if (!sample) throw new Error(`Unknown sample ${sampleId}`);
      if (sample.sampleId !== sampleId) {
        throw new Error(`Catalog returned sample ${sample.sampleId} for ${sampleId}`);
      }
      byId.set(sampleId, sample);
    }
    return records.map((record) => ({ state: record, sample: byId.get(record.sampleId)! }));
  }
}

class RunResumer extends RunReader implements EvalRunResumer {
  readonly #harness: Harness;
  readonly #stageDependencies: RuntimeStageDependencies;
  readonly #getProject: EvalRunResumerDependencies["getProject"];
  readonly #createRetryController: (policy?: RetryPolicy) => RetryController;
  readonly #onError: (error: Error) => void;

  constructor(dependencies: EvalRunResumerDependencies) {
    super(dependencies);
    this.#harness = dependencies.harness;
    this.#getProject = dependencies.getProject;
    this.#createRetryController = dependencies.createRetryController ?? createRetryController;
    this.#onError = dependencies.onError ?? ((error) => console.error(error));
    this.#stageDependencies = {
      harness: dependencies.harness,
      store: dependencies.store,
      idFactory: this.idFactory,
      now: dependencies.now ?? defaultNow,
      sleep: dependencies.sleep ?? defaultSleep,
      onError: this.#onError,
      createRetryController: this.#createRetryController,
    };
  }

  async resume(runId: string, stopSignal?: AbortSignal): Promise<void> {
    if (stopSignal?.aborted) return;
    const run = await this.store.getRun(runId);
    if (!run) throw new RuntimeRunNotFoundError(runId);
    if (run.stopRequested || stopSignal?.aborted) return;

    let samplings = await this.loadSamplingRecords(run.samplingIds);
    if (run.config.operation !== "evaluation") {
      const unfinished = samplings.filter(({ execution }) => isPendingSamplingStatus(execution.status));
      if (unfinished.length > 0) {
        const contexts = await this.loadSamplingContexts(unfinished, run.projectId);
        await this.runExecutionPhase(contexts, run.config.execution, runId, stopSignal);
        samplings = await this.loadSamplingRecords(run.samplingIds);
      }
      if (samplings.some(({ execution }) => isPendingSamplingStatus(execution.status))) return;
    }

    if (stopSignal?.aborted) return;
    if (run.config.operation === "execution") return;

    const evaluationConfig = run.config.evaluation;
    const evaluations = await this.loadEvaluationRecords(run.evaluationIds);
    const samplingById = new Map(samplings.map((sampling) => [sampling.samplingId, sampling]));
    const toEvaluate = evaluations.filter((evaluation) => (
      isPendingSamplingStatus(evaluation.status.status)
      && samplingById.get(evaluation.samplingId)?.execution.status === "succeeded"
    ));
    const toCancel = run.config.operation === "pipeline"
      ? evaluations.filter((evaluation) => (
          isPendingSamplingStatus(evaluation.status.status)
          && samplingById.get(evaluation.samplingId)?.execution.status !== "succeeded"
        ))
      : [];
    const contexts = await this.loadSamplingContexts(
      toEvaluate.map((evaluation) => samplingById.get(evaluation.samplingId)!),
      run.projectId,
    );
    const evaluationContexts = contexts.map((context, index) => ({
      sampling: context.state,
      evaluation: toEvaluate[index]!,
      sample: context.sample,
    }));

    const project = toEvaluate.length > 0 ? await this.#getProject(run.projectId) : null;
    if (toEvaluate.length > 0 && !project?.evaluationOutputSchema) {
      throw new Error(`Project ${run.projectId} has no evaluation output JSON Schema`);
    }
    const settlements = await Promise.allSettled([
      this.runEvaluationPhase(evaluationContexts, evaluationConfig, project?.evaluationOutputSchema, runId, stopSignal),
      ...toCancel.map((evaluation) => this.cancelEvaluation(evaluation, evaluationConfig)),
    ]);
    const errors = settlements.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, "Evaluation phase could not persist its progress");
  }

  private async runExecutionPhase(
    contexts: readonly RuntimeSamplingContext[],
    config: ResolvedExecutionConfig,
    runId: string,
    stopSignal?: AbortSignal,
  ): Promise<void> {
    const scheduler = this.scheduler(config.executionConcurrency);
    const dependencies = this.stageDependenciesFor(runId, stopSignal);
    const errors: unknown[] = [];
    await scheduler.run(contexts.map((context) => async () => {
      if (stopSignal?.aborted) return;
      try {
        await executeSampling(dependencies, {
          context,
          harnessConfig: config.harness,
          retryPolicy: config.retryPolicy,
        });
      } catch (error) {
        if (!(error instanceof RuntimeRunStoppedError)) errors.push(error);
      }
    }));
    if (errors.length > 0) throw new AggregateError(errors, "Execution phase could not persist its progress");
  }

  private async runEvaluationPhase(
    contexts: readonly RuntimeEvaluationContext[],
    config: ResolvedEvaluationConfig,
    evaluationOutputSchema: EvaluationOutputSchema | undefined,
    runId: string,
    stopSignal?: AbortSignal,
  ): Promise<void> {
    if (contexts.length > 0 && !evaluationOutputSchema) throw new Error("Evaluation output JSON Schema is required");
    const scheduler = this.scheduler(config.evaluationConcurrency);
    const dependencies = this.stageDependenciesFor(runId, stopSignal);
    const errors: unknown[] = [];
    await scheduler.run(contexts.map((context) => async () => {
      if (stopSignal?.aborted) return;
      try {
        await evaluateSampling(dependencies, {
          context,
          harnessConfig: config.evaluationHarness,
          retryPolicy: config.retryPolicy,
          evaluationOutputSchema: evaluationOutputSchema!,
        });
      } catch (error) {
        if (!(error instanceof RuntimeRunStoppedError)) errors.push(error);
      }
    }));
    if (errors.length > 0) throw new AggregateError(errors, "Evaluation phase could not persist its progress");
  }

  async interrupt(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    if (!run.stopRequested) return;
    const samplings = await this.loadSamplingRecords(run.samplingIds);
    const handles: AgentHandle[] = [];
    if (run.config.operation !== "evaluation") {
      for (const sampling of samplings) {
        if (!sampling.subjectChatId || !isPendingSamplingStatus(sampling.execution.status)) continue;
        handles.push({
          role: "subject", framework: requireSpHarness(run.config.execution.harness, "subject").framework,
          ownerUserId: sampling.subjectAgent.ownerUserId,
          chatId: sampling.subjectChatId, samplingId: sampling.samplingId,
        });
      }
    }
    if (run.config.operation !== "execution") {
      const evaluations = await this.loadEvaluationRecords(run.evaluationIds);
      for (const evaluation of evaluations) {
        if (!evaluation.chatId || !isPendingSamplingStatus(evaluation.status.status)) continue;
        handles.push({
          role: "evaluator", framework: run.config.evaluation.evaluationHarness.framework,
          ownerUserId: evaluation.evaluator.ownerUserId,
          chatId: evaluation.chatId, samplingId: evaluation.samplingId,
        });
      }
    }
    const errors: unknown[] = [];
    await this.scheduler(STOP_IO_CONCURRENCY).run(handles.map((handle) => async () => {
      try { await this.#harness.stopAgent({ handle }); }
      catch (error) { errors.push(error); }
    }));
    if (errors.length > 0) throw new AggregateError(errors, `Could not interrupt Run ${runId}`);
  }

  async stop(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    if (!run.stopRequested) return;
    await this.interrupt(runId);
    const samplings = await this.loadSamplingRecords(run.samplingIds);
    const errors: unknown[] = [];
    if (run.config.operation !== "evaluation") {
      await this.scheduler(STOP_IO_CONCURRENCY).run(samplings.map((sampling) => async () => {
        try { await this.finishStoppedExecution(run, sampling); }
        catch (error) { errors.push(error); }
      }));
    }
    if (run.config.operation !== "execution") {
      const evaluations = await this.loadEvaluationRecords(run.evaluationIds);
      const samplingById = new Map(samplings.map((sampling) => [sampling.samplingId, sampling]));
      await this.scheduler(STOP_IO_CONCURRENCY).run(evaluations.map((evaluation) => async () => {
        const sampling = samplingById.get(evaluation.samplingId);
        try {
          if (!sampling) throw new Error(`Run ${runId} is missing Sampling ${evaluation.samplingId}`);
          await this.finishStoppedEvaluation(run, sampling, evaluation);
        } catch (error) { errors.push(error); }
      }));
    }
    if (errors.length > 0) throw new AggregateError(errors, `Could not finalize stopped Run ${runId}`);
  }

  private stopStageDependencies(): RuntimeStageDependencies {
    return {
      ...this.#stageDependencies,
      createRetryController: (policy) => {
        const delegate = this.#createRetryController(policy);
        return {
          decide: (input) => input.operation === "restart"
            ? Promise.resolve({ shouldRetry: false }) : delegate.decide(input),
        };
      },
    };
  }

  private guardedHarness(runId: string, stopSignal?: AbortSignal): Harness {
    const harness = this.#harness;
    const observe = <T>(pending: Promise<T>): Promise<T> => {
      if (!stopSignal) return pending;
      return new Promise<T>((resolve, reject) => {
        const onStop = () => reject(new RuntimeRunStoppedError(runId));
        stopSignal.addEventListener("abort", onStop, { once: true });
        pending.then(
          (value) => { stopSignal.removeEventListener("abort", onStop); resolve(value); },
          (error: unknown) => { stopSignal.removeEventListener("abort", onStop); reject(error); },
        );
        if (stopSignal.aborted) onStop();
      });
    };
    const gate = <T>(dispatch: () => Promise<T>): Promise<T> =>
      observe(this.store.withRunDispatchGate(runId, dispatch));
    return {
      ensureAgent: (input) => gate(() => harness.ensureAgent(input)),
      materializeInitialData: (input) => gate(() => harness.materializeInitialData(input)),
      materializeSubjectTrajectory: (input) => gate(() => harness.materializeSubjectTrajectory(input)),
      submitAgent: (input) => gate(() => harness.submitAgent(input)),
      restartAgent: (input) => gate(() => harness.restartAgent(input)),
      waitForSubmission: (input) => observe(harness.waitForSubmission(input)),
      inspectAgentOperation: (input) => observe(harness.inspectAgentOperation(input)),
      stopAgent: (input) => observe(harness.stopAgent(input)),
      collectExecution: (input) => observe(harness.collectExecution(input)),
      collectEvaluation: (input) => observe(harness.collectEvaluation(input)),
      collectAgentResources: (input) => observe(harness.collectAgentResources(input)),
    };
  }

  private stageDependenciesFor(runId: string, stopSignal?: AbortSignal): RuntimeStageDependencies {
    const harness = this.guardedHarness(runId, stopSignal);
    if (!stopSignal) return { ...this.#stageDependencies, harness };
    return {
      ...this.#stageDependencies,
      harness,
      createRetryController: (policy) => {
        const delegate = this.#createRetryController(policy);
        return {
          decide: (input) => input.operation === "restart" && stopSignal.aborted
            ? Promise.resolve({ shouldRetry: false }) : delegate.decide(input),
        };
      },
    };
  }

  private async inspectStoppedOperation(
    handle: AgentHandle, idempotencyKey: string, submissionId?: string,
  ): Promise<AgentSubmission | null> {
    try {
      return await this.#harness.inspectAgentOperation({ handle, idempotencyKey });
    } catch (error) {
      if (error instanceof AgentHandleNotFoundError && !submissionId) return null;
      throw error;
    }
  }

  private async finishStoppedExecution(run: RuntimeRunRecord, initial: SamplingState): Promise<void> {
    if (run.config.operation === "evaluation") throw new Error("Evaluation Run has no execution phase");
    const executionConfig = run.config.execution;
    const retryController = this.#createRetryController(executionConfig.retryPolicy);
    const persist = (record: SamplingState, expected: SamplingState): Promise<void> => persistRuntimeRecord({
      record, expected,
      write: (next, previous) => this.store.updateSampling(next, previous),
      read: () => this.store.getSampling(record.samplingId),
      retryController,
      sleep: this.#stageDependencies.sleep,
    });
    const interrupted = (sampling: SamplingState) => {
      const status = sampling.executionAttempts.at(-1)?.status;
      return status === "interrupted" || status === "cancelled";
    };
    const unsubmitted = (sampling: SamplingState) => {
      const attempt = sampling.executionAttempts.at(-1);
      return !!attempt && !attempt.submissionId && attempt.status !== "completed";
    };
    const wasPending = isPendingSamplingStatus(initial.execution.status);
    if (!wasPending
      && !(initial.execution.status === "failed" && (interrupted(initial) || unsubmitted(initial)))) return;
    let current = initial;
    const attempt = current.executionAttempts.at(-1);
    const hasOperation = !!(current.subjectChatId && attempt
      && (attempt.resources || attempt.submissionId || attempt.completedAt));
    let operationFound = false;
    if (hasOperation) {
      const handle: AgentHandle = {
        role: "subject", framework: requireSpHarness(executionConfig.harness, "subject").framework,
        ownerUserId: current.subjectAgent.ownerUserId,
        chatId: current.subjectChatId!, samplingId: current.samplingId,
      };
      const receipt = await this.inspectStoppedOperation(
        handle, agentOperationKey("execution", current.samplingId, attempt!.attemptNumber),
        attempt?.submissionId,
      );
      operationFound = receipt !== null;
      if (!receipt && attempt?.submissionId) throw new Error(`Subject Submission ${attempt.submissionId} disappeared`);
      if (receipt && (receipt.status === "queued" || receipt.status === "running")) {
        throw new Error(`Stopped Subject Submission ${receipt.submissionId} is still active`);
      }
      if (receipt && isPendingSamplingStatus(current.execution.status)) {
        const [context] = await this.loadSamplingContexts([current], run.projectId);
        await executeSampling(this.stopStageDependencies(), {
          context: context!, harnessConfig: executionConfig.harness,
          retryPolicy: executionConfig.retryPolicy,
        });
        current = (await this.store.getSampling(current.samplingId))!;
      }
    }
    if (current.execution.evidencePending) return;
    if (interrupted(current) && (!current.artifacts || !current.trajectory) && current.subjectChatId) {
      const handle: AgentHandle = {
        role: "subject", framework: requireSpHarness(executionConfig.harness, "subject").framework,
        ownerUserId: current.subjectAgent.ownerUserId,
        chatId: current.subjectChatId, samplingId: current.samplingId,
      };
      let output;
      try {
        output = await this.#harness.collectExecution({ handle });
      } catch (error) {
        await persist({
          ...current,
          execution: { status: "retrying", evidencePending: true, lastError: errorMessage(error) },
        }, current);
        return;
      }
      const next = { ...current, artifacts: output.artifacts, trajectory: output.trajectory };
      await persist(next, current);
      current = next;
    }
    if (!isPendingSamplingStatus(current.execution.status)
      && !(current.execution.status === "failed"
        && (wasPending || interrupted(current) || (unsubmitted(current) && !operationFound)))) return;
    const last = current.executionAttempts.at(-1);
    const attempts = last && !last.submissionId && !operationFound
      ? [...current.executionAttempts.slice(0, -1), stoppedAttempt(last, this.#stageDependencies.now())]
      : current.executionAttempts;
    await persist({
      ...current,
      executionAttempts: attempts,
      execution: { status: "cancelled", lastError: "Run stopped" },
    }, current);
  }

  private async finishStoppedEvaluation(
    run: RuntimeRunRecord, sampling: SamplingState, initial: EvaluationRecord,
  ): Promise<void> {
    if (run.config.operation === "execution") throw new Error("Execution Run has no evaluation phase");
    const evaluationConfig = run.config.evaluation;
    const retryController = this.#createRetryController(evaluationConfig.retryPolicy);
    const persist = (record: EvaluationRecord, expected: EvaluationRecord): Promise<void> => persistRuntimeRecord({
      record, expected,
      write: (next, previous) => this.store.updateEvaluation(next, previous),
      read: () => this.store.getEvaluation(record.evaluationId),
      retryController,
      sleep: this.#stageDependencies.sleep,
    });
    const interrupted = (evaluation: EvaluationRecord) => {
      const status = evaluation.attempts.at(-1)?.status;
      return status === "interrupted" || status === "cancelled";
    };
    const unsubmitted = (evaluation: EvaluationRecord) => {
      const attempt = evaluation.attempts.at(-1);
      return !!attempt && !attempt.submissionId && attempt.status !== "completed";
    };
    const wasPending = isPendingSamplingStatus(initial.status.status);
    if (!wasPending
      && !(initial.status.status === "failed" && (interrupted(initial) || unsubmitted(initial)))) return;
    let current = initial;
    const attempt = current.attempts.at(-1);
    const hasOperation = !!(current.chatId && attempt
      && (attempt.resources || attempt.submissionId || attempt.completedAt));
    let operationFound = false;
    if (hasOperation) {
      const handle: AgentHandle = {
        role: "evaluator", framework: evaluationConfig.evaluationHarness.framework,
        ownerUserId: current.evaluator.ownerUserId,
        chatId: current.chatId!, samplingId: current.samplingId,
        ...(sampling.subjectChatId ? { evaluationWorkspace: {
          subject: { userId: sampling.subjectAgent.ownerUserId, chatId: sampling.subjectChatId },
          evaluationId: current.evaluationId,
        } } : {}),
      };
      const receipt = await this.inspectStoppedOperation(
        handle, agentOperationKey("evaluation", current.samplingId, attempt!.attemptNumber),
        attempt?.submissionId,
      );
      operationFound = receipt !== null;
      if (!receipt && attempt?.submissionId) throw new Error(`Evaluator Submission ${attempt.submissionId} disappeared`);
      if (receipt && (receipt.status === "queued" || receipt.status === "running")) {
        throw new Error(`Stopped Evaluator Submission ${receipt.submissionId} is still active`);
      }
      if (receipt && isPendingSamplingStatus(current.status.status)) {
        const [context] = await this.loadSamplingContexts([sampling], run.projectId);
        const project = await this.#getProject(run.projectId);
        if (!project?.evaluationOutputSchema) {
          throw new Error(`Project ${run.projectId} has no evaluation output JSON Schema`);
        }
        await evaluateSampling(this.stopStageDependencies(), {
          context: { sampling, evaluation: current, sample: context!.sample },
          harnessConfig: evaluationConfig.evaluationHarness,
          retryPolicy: evaluationConfig.retryPolicy,
          evaluationOutputSchema: project.evaluationOutputSchema,
        });
        current = (await this.store.getEvaluation(current.evaluationId))!;
      }
      if (receipt && interrupted(current) && !current.output) {
        let output;
        try {
          output = await this.#harness.collectEvaluation({ handle });
        } catch (error) {
          await persist({
            ...current, status: { status: "retrying", lastError: errorMessage(error) },
          }, current);
          return;
        }
        const next = { ...current, output };
        await persist(next, current);
        current = next;
      }
    }
    if (!isPendingSamplingStatus(current.status.status)
      && !(current.status.status === "failed"
        && (wasPending || interrupted(current) || (unsubmitted(current) && !operationFound)))) return;
    const last = current.attempts.at(-1);
    const attempts = last && !last.submissionId && !operationFound
      ? [...current.attempts.slice(0, -1), stoppedAttempt(last, this.#stageDependencies.now())]
      : current.attempts;
    await persist({
      ...current, attempts, status: { status: "cancelled", lastError: "Run stopped" },
    }, current);
  }

  private async cancelEvaluation(
    evaluation: EvaluationRecord,
    config: ResolvedEvaluationConfig,
  ): Promise<void> {
    const retryController = this.#createRetryController(config.retryPolicy);
    const persist = (record: EvaluationRecord, expected: EvaluationRecord): Promise<void> => persistRuntimeRecord({
      record,
      expected,
      write: (next, expected) => this.store.updateEvaluation(next, expected),
      read: () => this.store.getEvaluation(evaluation.evaluationId),
      retryController,
      sleep: this.#stageDependencies.sleep,
    });

    try {
      await persist({
        ...evaluation,
        status: { status: "cancelled", lastError: "execution did not succeed" },
      }, evaluation);
    } catch (error) {
      try {
        const current = await this.store.getEvaluation(evaluation.evaluationId);
        if (!current) throw new Error(`Unknown evaluation ${evaluation.evaluationId}`);
        if (current.status.status === "cancelled") return;
        await persist({
          ...current,
          status: {
            status: "failed",
            lastError: `evaluation cancellation persistence failed: ${errorMessage(error)}`,
          },
        }, current);
      } catch (finalizationError) {
        const reported = new AggregateError(
          [error, finalizationError],
          `Could not finalize evaluation ${evaluation.evaluationId} for sampling ${evaluation.samplingId}`,
        );
        try {
          this.#onError(reported);
        } catch (reportingError) {
          console.error(reported, reportingError);
        }
      }
    }
  }

  private scheduler(maxConcurrentDos: number): AgentScheduler {
    return createAgentScheduler({ maxConcurrentDos });
  }

}

class RuntimeCoordinator extends RunReader implements EvalRunAdmission {
  readonly #sourceCommit: string;
  readonly #catalog: RuntimeAdmissionCatalog;
  readonly #configResolver: EvalRuntimeDependencies["configResolver"];
  readonly #pendingAdmissions = new Map<string, {
    readonly requestFacts: string;
    readonly promise: Promise<RunHandle>;
  }>();

  constructor(dependencies: EvalRunAdmissionDependencies) {
    super({ ...dependencies, getSamples: dependencies.catalog.getSamples.bind(dependencies.catalog) });
    this.#sourceCommit = requireSourceCommit(dependencies.sourceCommit);
    this.#catalog = dependencies.catalog;
    this.#configResolver = dependencies.configResolver;
  }

  async start(request: StartRunRequest): Promise<RunHandle> {
    this.validateStartRequest(request);
    const admissionRequest = { ...request };
    return this.withPendingAdmission("start", admissionRequest, () => this.admitStart(admissionRequest));
  }

  private async admitStart(request: StartRunRequest): Promise<RunHandle> {
    const existingRun = await this.findExistingRun("start", request);
    if (existingRun) return this.runHandle(existingRun);

    const config = await this.#configResolver.resolveExecutionConfig(request.executionConfigId);
    const subjectAgent = requireSpHarness(config.harness, "subject").agentConfig;
    const runConfig = { operation: "execution", execution: config } as const;
    const requestIdentity = await createRunRequestIdentity("start", request, runConfig);

    const samples = await this.resolveSamples(config.datasetId, config.sampleIds);
    const contexts = samples.flatMap((sample) => Array.from(
      { length: config.samplingCount },
      () => this.createSamplingContext(request.projectId, sample, subjectAgent),
    ));
    const records = contexts.map(({ state }) => state);
    const run = this.createRun(
      request.projectId,
      records.map(({ samplingId }) => samplingId),
      ["execution"],
      [],
      runConfig,
      requestIdentity,
    );

    const admission = await this.persistNewRun(run, records, []);
    return this.runHandle(admission.run);
  }

  async evaluate(request: EvaluateRequest): Promise<RunHandle> {
    this.validateEvaluateRequest(request);
    const admissionRequest = { ...request, samplingIds: [...request.samplingIds] };
    return this.withPendingAdmission("evaluate", admissionRequest, () => this.admitEvaluation(admissionRequest));
  }

  private async admitEvaluation(request: EvaluateRequest): Promise<RunHandle> {
    const existingRun = await this.findExistingRun("evaluate", request);
    if (existingRun) return this.runHandle(existingRun);

    const config = await this.#configResolver.resolveEvaluationConfig(request.evaluationConfigId);
    const evaluationAgent = requireSpHarness(config.evaluationHarness, "evaluator").agentConfig;
    const selected = await this.store.getSamplings(request.samplingIds);
    if (selected.length !== request.samplingIds.length) throw new Error("Store returned an incomplete Sampling batch");
    const records = selected.map((record, index) => {
      const samplingId = request.samplingIds[index]!;
      if (!record || record.samplingId !== samplingId
        || record.projectId !== request.projectId || record.execution.status !== "succeeded") {
        throw new RuntimeEvaluationSelectionError(
          `Sampling ${samplingId} has no successful execution in Project ${request.projectId}`,
        );
      }
      return record;
    });
    const contexts = await this.loadSamplingContexts(records, request.projectId);
    for (const { sample } of contexts) requireEvaluationPrompt(sample);
    const evaluations = contexts.map(({ state }) => (
      this.createEvaluationRecord(state.samplingId, evaluationAgent)
    ));
    const runConfig = { operation: "evaluation", evaluation: config } as const;
    const requestIdentity = await createRunRequestIdentity("evaluate", request, runConfig);
    const run = this.createRun(
      request.projectId,
      records.map(({ samplingId }) => samplingId),
      ["evaluation"],
      evaluations.map(({ evaluationId }) => evaluationId),
      runConfig,
      requestIdentity,
    );
    const admission = await this.store.createRunWithSamplings(run, records, evaluations);
    return this.runHandle(admission.run);
  }

  async pipeline(request: PipelineRequest): Promise<RunHandle> {
    this.validatePipelineRequest(request);
    const admissionRequest = { ...request };
    return this.withPendingAdmission("pipeline", admissionRequest, () => this.admitPipeline(admissionRequest));
  }

  private async admitPipeline(request: PipelineRequest): Promise<RunHandle> {
    const existingRun = await this.findExistingRun("pipeline", request);
    if (existingRun) return this.runHandle(existingRun);

    const config = await this.#configResolver.resolvePipelineConfig(request.pipelineConfigId);
    const subjectAgent = requireSpHarness(config.execution.harness, "subject").agentConfig;
    const evaluationAgent = requireSpHarness(
      config.evaluation.evaluationHarness,
      "evaluator",
    ).agentConfig;
    const runConfig = {
      operation: "pipeline",
      pipeline: config.pipeline,
      execution: config.execution,
      evaluation: config.evaluation,
    } as const;
    const requestIdentity = await createRunRequestIdentity("pipeline", request, runConfig);

    const samples = await this.resolveSamples(config.execution.datasetId, config.execution.sampleIds);
    for (const sample of samples) requireEvaluationPrompt(sample);
    const contexts = samples.flatMap((sample) => Array.from(
      { length: config.execution.samplingCount },
      () => this.createSamplingContext(request.projectId, sample, subjectAgent),
    ));
    const records = contexts.map(({ state }) => state);
    const evaluations = contexts.map(({ state }) => (
      this.createEvaluationRecord(state.samplingId, evaluationAgent)
    ));
    const run = this.createRun(
      request.projectId,
      records.map(({ samplingId }) => samplingId),
      ["execution", "evaluation"],
      evaluations.map(({ evaluationId }) => evaluationId),
      runConfig,
      requestIdentity,
    );

    const admission = await this.persistNewRun(run, records, evaluations);
    return this.runHandle(admission.run);
  }

  async getRun(runId: string): Promise<RunSnapshot> {
    const run = await this.store.getRun(runId);
    if (!run) throw new RuntimeRunNotFoundError(runId);
    const records = await this.loadSamplingRecords(run.samplingIds);
    const evaluations = await this.loadEvaluationRecords(run.evaluationIds);
    return toRunSnapshot(run, records, evaluations);
  }

  async getSampling(samplingId: string): Promise<SamplingSnapshot> {
    const state = await this.store.getSampling(samplingId);
    if (!state) throw new Error(`Unknown sampling ${samplingId}`);
    return toSamplingSnapshot(state);
  }

  async getEvaluation(evaluationId: string): Promise<EvaluationRecord> {
    const evaluation = await this.store.getEvaluation(evaluationId);
    if (!evaluation) throw new Error(`Unknown evaluation ${evaluationId}`);
    return structuredClone(evaluation);
  }

  async listEvaluations(samplingId: string): Promise<readonly EvaluationRecord[]> {
    return structuredClone(await this.store.listEvaluations(samplingId));
  }

  private validateStartRequest(request: StartRunRequest): void {
    requireIdempotencyKey(request.idempotencyKey);
    if (!request.projectId) throw new Error("projectId is required");
    if (!request.executionConfigId) throw new Error("executionConfigId is required");
  }

  private validateEvaluateRequest(request: EvaluateRequest): void {
    requireIdempotencyKey(request.idempotencyKey);
    if (!request.projectId) throw new Error("projectId is required");
    if (request.samplingIds.length === 0) throw new Error("samplingIds must not be empty");
    requireDistinctIds(request.samplingIds, "samplingIds");
    if (!request.evaluationConfigId) throw new Error("evaluationConfigId is required");
  }

  private validatePipelineRequest(request: PipelineRequest): void {
    requireIdempotencyKey(request.idempotencyKey);
    if (!request.projectId) throw new Error("projectId is required");
    if (!request.pipelineConfigId) throw new Error("pipelineConfigId is required");
  }

  private async resolveSamples(
    datasetId: string,
    sampleIds?: readonly string[],
  ): Promise<readonly Sample[]> {
    const data = await this.#catalog.listData(datasetId);
    const samples: Sample[] = [];
    for (const item of data) {
      samples.push(...await this.#catalog.listSamples(item.dataId));
    }
    const selected = sampleIds === undefined
      ? samples
      : samples.filter((sample) => sampleIds.includes(sample.sampleId));
    if (selected.length === 0) throw new Error(`No samples found for dataset ${datasetId}`);
    if (sampleIds && selected.length !== sampleIds.length) {
      const selectedIds = new Set(selected.map((sample) => sample.sampleId));
      const missing = sampleIds.find((sampleId) => !selectedIds.has(sampleId));
      throw new Error(`Sample ${missing} does not belong to dataset ${datasetId}`);
    }
    return selected;
  }

  private createSamplingContext(
    projectId: string,
    sample: Sample,
    subjectAgent: AgentConfigRef,
  ): RuntimeSamplingContext {
    const sampling: Sampling = {
      samplingId: this.idFactory(),
      projectId,
      sampleId: sample.sampleId,
      execution: { status: "queued" },
      subjectAgent,
      executionAttempts: [],
    };
    return { state: sampling, sample };
  }

  private createEvaluationRecord(
    samplingId: string,
    evaluator: AgentConfigRef,
  ): EvaluationRecord {
    return {
      evaluationId: this.idFactory(),
      samplingId,
      evaluator,
      status: { status: "queued" },
      attempts: [],
    };
  }

  private createRun(
    projectId: string,
    samplingIds: readonly string[],
    phases: RunPhases,
    evaluationIds: readonly string[],
    config: RunConfigSnapshot,
    requestIdentity: RuntimeRunRequestIdentity,
  ): RuntimeRunRecord {
    return {
      runId: this.idFactory(),
      samplingIds: [...samplingIds],
      projectId,
      sourceCommit: this.#sourceCommit,
      phases,
      evaluationIds: [...evaluationIds],
      config,
      requestIdentity,
    };
  }

  private async persistNewRun(
    run: RuntimeRunRecord,
    records: readonly SamplingState[],
    evaluations: readonly EvaluationRecord[],
  ): Promise<RuntimeRunAdmission> {
    return this.store.createRunWithSamplings(run, records, evaluations);
  }

  private withPendingAdmission(
    operation: RunRequestOperation,
    request: RunRequest,
    admit: () => Promise<RunHandle>,
  ): Promise<RunHandle> {
    const key = JSON.stringify([request.projectId, request.idempotencyKey]);
    const requestFacts = JSON.stringify(sortObjectKeys({
      operation,
      projectId: request.projectId,
      selector: requestSelector(operation, request),
    }));
    const pending = this.#pendingAdmissions.get(key);
    if (pending) {
      if (pending.requestFacts !== requestFacts) {
        throw new RuntimeRunIdentityConflictError("idempotency key is already bound to different Run facts");
      }
      return pending.promise.then((handle) => ({ runId: handle.runId, samplingIds: [...handle.samplingIds] }));
    }

    const promise = Promise.resolve().then(admit);
    this.#pendingAdmissions.set(key, { requestFacts, promise });
    const clear = () => {
      if (this.#pendingAdmissions.get(key)?.promise === promise) this.#pendingAdmissions.delete(key);
    };
    void promise.then(clear, clear);
    return promise;
  }

  private async findExistingRun(
    operation: RunRequestOperation,
    request: RunRequest,
  ): Promise<RuntimeRunRecord | null> {
    const existingRun = await this.store.findRunByIdempotencyKey(
      request.projectId,
      request.idempotencyKey,
    );
    if (!existingRun) return null;
    const requestIdentity = await createRunRequestIdentity(operation, request, existingRun.config);
    assertRequestIdentity(existingRun, requestIdentity);
    return existingRun;
  }

  private runHandle(run: RuntimeRunRecord): RunHandle {
    return { runId: run.runId, samplingIds: [...run.samplingIds] };
  }


}

class FullRuntime extends RuntimeCoordinator implements EvalRuntime {
  readonly #catalog: RuntimeCatalog;
  readonly #resumer: RunResumer;

  constructor(dependencies: EvalRuntimeDependencies) {
    super(dependencies);
    this.#catalog = dependencies.catalog;
    this.#resumer = new RunResumer({
      store: dependencies.store,
      getSamples: dependencies.catalog.getSamples.bind(dependencies.catalog),
      getProject: dependencies.catalog.getProject.bind(dependencies.catalog),
      harness: dependencies.harness,
      ...(dependencies.idFactory === undefined ? {} : { idFactory: dependencies.idFactory }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
      ...(dependencies.onError === undefined ? {} : { onError: dependencies.onError }),
      ...(dependencies.createRetryController === undefined
        ? {} : { createRetryController: dependencies.createRetryController }),
    });
  }

  listProjects(): Promise<readonly Project[]> { return this.#catalog.listProjects(); }
  listAgents(role?: AgentRole) { return this.#catalog.listAgents(role); }
  listDatasets() { return this.#catalog.listDatasets(); }
  listData(datasetId: string) { return this.#catalog.listData(datasetId); }
  listSamples(dataId: string) { return this.#catalog.listSamples(dataId); }
  resume(runId: string): Promise<void> { return this.#resumer.resume(runId); }
}

export type {
  AgentOption,
  EvalRuntime,
  EvalRuntimeDependencies,
  EvalRunAdmission,
  EvalRunAdmissionDependencies,
  EvalRunResumer,
  EvalRunResumerDependencies,
  RuntimeAdmissionCatalog,
  RuntimeCatalog,
  RuntimeEvaluationContext,
  Sample,
  SamplingSnapshot,
  RuntimeSamplingContext,
} from "./model.js";
export type {
  RuntimeRunAdmission,
  RuntimeRunRequestIdentity,
  RuntimeRunRecord,
  RuntimeRecoveryStore,
  SamplingState,
  RuntimeStore,
} from "./store.js";
export { RuntimeProjectBusyError, RuntimeRunStoppedError, RuntimeRunIdentityConflictError, RuntimeRecordConflictError, RuntimeRecordPersistenceError } from "./store.js";
export { toRunSnapshot, toSamplingSnapshot } from "./projection.js";
export {
  RuntimeAdmissionConflictError,
  RuntimeEntityNotFoundError,
  RuntimeInputError,
  type RuntimeAdmissionConflictReason,
  type RuntimeEntity,
} from "./errors.js";
export {
  DEFAULT_RETRY_POLICY,
  createRetryController,
  type RetryController,
  type RetryDecision,
  type RetryOperation,
  type RetryableFailureKind,
} from "./retry.js";
export {
  createAgentScheduler,
  type AgentScheduler,
  type AgentSchedulerOptions,
} from "./scheduler.js";

export function createEvalRuntime(
  dependencies: EvalRuntimeDependencies,
): EvalRuntime {
  return new FullRuntime(dependencies);
}

export function createEvalRunAdmission(
  dependencies: EvalRunAdmissionDependencies,
): EvalRunAdmission {
  const runtime = new RuntimeCoordinator(dependencies);
  return {
    start: (request) => runtime.start(request),
    evaluate: (request) => runtime.evaluate(request),
    pipeline: (request) => runtime.pipeline(request),
  };
}

export function createEvalRunResumer(
  dependencies: EvalRunResumerDependencies,
): EvalRunResumer {
  return new RunResumer(dependencies);
}

type RunRequestOperation = "start" | "evaluate" | "pipeline";
type RunRequest = StartRunRequest | EvaluateRequest | PipelineRequest;

function requireIdempotencyKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0 || key.trim() !== key) {
    throw new Error("idempotencyKey must be a non-empty key without surrounding whitespace");
  }
}

function requestSelector(operation: RunRequestOperation, request: RunRequest): unknown {
  switch (operation) {
    case "start":
      return { executionConfigId: (request as StartRunRequest).executionConfigId };
    case "evaluate": {
      const evaluation = request as EvaluateRequest;
      return {
        evaluationConfigId: evaluation.evaluationConfigId,
        samplingIds: evaluation.samplingIds,
      };
    }
    case "pipeline":
      return { pipelineConfigId: (request as PipelineRequest).pipelineConfigId };
  }
}

async function createRunRequestIdentity(
  operation: RunRequestOperation,
  request: RunRequest,
  config: RunConfigSnapshot,
): Promise<RuntimeRunRequestIdentity> {
  const requestFingerprint = await fingerprintRequest({
    operation,
    projectId: request.projectId,
    selector: requestSelector(operation, request),
    config,
  });

  return {
    idempotencyKey: request.idempotencyKey,
    requestFingerprint,
  };
}

function assertRequestIdentity(
  existingRun: RuntimeRunRecord,
  requestIdentity: RuntimeRunRequestIdentity,
): void {
  if (
    existingRun.requestIdentity.requestFingerprint !== requestIdentity.requestFingerprint
  ) {
    throw new RuntimeRunIdentityConflictError(
      "idempotency key is already bound to different Run facts",
    );
  }
}

async function fingerprintRequest(value: unknown): Promise<string> {
  const serialized = JSON.stringify(sortObjectKeys(value));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serialized),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entryValue]) => [key, sortObjectKeys(entryValue)]),
  );
}
