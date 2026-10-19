import type {
  EvaluationOutputSchema,
  EvaluationPlan,
  EvaluationRecord,
  ExecutionPlan,
  RetryPolicy,
  SamplingStageState,
} from "@eval-platform/eval-contracts";
import { DEFAULT_EVIDENCE_LIMITS, isPendingSamplingStatus } from "@eval-platform/eval-contracts";
import { createId } from "@eval-platform/eval-contracts";
import type { Harness } from "../harness/model.js";
import { errorMessage, reportError, withContext, type StageDependencies } from "./agent-lifecycle.js";
import { isStageDue, summarizeStages } from "./recovery.js";
import { RuntimeEntityNotFoundError, RuntimeRunStoppedError } from "./errors.js";
import { evaluateSampling } from "./evaluation.js";
import { executeSampling } from "./execution.js";
import type { EvalRunResumer, EvalRunResumerDependencies, RunStopReporter } from "./model.js";
import { safeLog, type RuntimeContext, type RuntimeLog } from "./log.js";
import { RunRecords, type RunStagePlans } from "./records.js";
import { createRetryController, loggedRetryController, type RetryController } from "./retry.js";
import { createAgentScheduler, createAgentTaskQueue } from "./scheduler.js";
import { finishStoppedRun, interruptRun, type StopContext } from "./stop.js";
import { isRunStopPending, persistRuntimeRecord, type RuntimeRunRecord, type RuntimeStore, type SamplingState } from "./store.js";

export class RunResumer implements EvalRunResumer {
  readonly #store: RuntimeStore;
  readonly #records: RunRecords;
  readonly #harness: Harness;
  readonly #plans: EvalRunResumerDependencies["plans"];
  readonly #createRetryController: (policy?: RetryPolicy) => RetryController;
  readonly #onError: (error: Error, context?: RuntimeContext) => void;
  readonly #log: RuntimeLog;
  readonly #stage: StageDependencies;

  constructor(dependencies: EvalRunResumerDependencies) {
    this.#store = dependencies.store;
    this.#records = new RunRecords(dependencies.store, dependencies.plans);
    this.#harness = dependencies.harness;
    this.#plans = dependencies.plans;
    this.#createRetryController = dependencies.createRetryController ?? createRetryController;
    this.#onError = dependencies.onError;
    this.#log = safeLog(dependencies.log);
    this.#stage = {
      harness: dependencies.harness,
      store: dependencies.store,
      evidence: dependencies.evidence,
      evidenceLimits: dependencies.evidenceLimits ?? DEFAULT_EVIDENCE_LIMITS,
      idFactory: dependencies.idFactory ?? createId,
      now: dependencies.now ?? (() => new Date().toISOString()),
      sleep: dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
      onError: this.#onError,
      log: this.#log,
      createRetryController: (policy, log) => loggedRetryController(this.#createRetryController(policy), log),
      ...(dependencies.scores === undefined ? {} : { scores: dependencies.scores }),
      ...(dependencies.results === undefined ? {} : { results: dependencies.results }),
    };
  }

  #stopContext(runId: string): StopContext {
    return {
      store: this.#store,
      records: this.#records,
      harness: this.#harness,
      now: this.#stage.now,
      sleep: this.#stage.sleep,
      stageDependencies: { ...this.#stageDependencies({ runId }, this.#harness, () => false), finalizingStop: true },
      outputSchema: (projectId) => this.#outputSchema(projectId),
    };
  }

  async resume(runId: string, stopSignal?: AbortSignal): Promise<void> {
    if (stopSignal?.aborted) return;
    const run = await this.#requireRun(runId);
    if (isRunStopPending(run) || stopSignal?.aborted) return;
    const plans = await this.#records.plan(run);
    const started = Date.now();
    try {
      await this.#resumePass(run, plans, stopSignal);
    } finally {
      await this.#logPassSummary(run, plans.operation, started);
    }
  }

  /** `run_pass_summary`: stage statuses and recovery flags after one resume pass. */
  async #logPassSummary(run: RuntimeRunRecord, operation: RunStagePlans["operation"], started: number): Promise<void> {
    try {
      const executions = operation === "evaluation"
        ? [] : (await this.#records.samplings(run.samplingIds)).map(({ execution }) => execution);
      const evaluations = operation === "execution"
        ? [] : (await this.#records.evaluations(run.evaluationIds)).map(({ status }) => status);
      const execution = summarizeStages(executions);
      const evaluation = summarizeStages(evaluations);
      const all = summarizeStages([...executions, ...evaluations]);
      this.#log({
        name: "run_pass_summary", runId: run.runId, operation,
        execution: execution.statuses, evaluation: evaluation.statuses, ...all.flags,
        ...(all.nextDueAt === undefined ? {} : { nextDueAt: all.nextDueAt }),
        durationMs: Date.now() - started,
      });
    } catch (error) {
      reportError((reported) => this.#onError(reported, { runId: run.runId }), new Error(`Run ${run.runId} pass summary failed: ${errorMessage(error)}`, { cause: error }));
    }
  }

  async #resumePass(run: RuntimeRunRecord, plans: RunStagePlans, stopSignal: AbortSignal | undefined): Promise<void> {
    let samplings = await this.#records.samplings(run.samplingIds);
    const now = this.#stage.now();
    const owesWork = (state: SamplingStageState) => isStageDue(state, now);
    if (plans.operation === "pipeline") {
      await this.#runPipeline(run, plans.execution, plans.evaluation, samplings, stopSignal, owesWork);
      return;
    }
    if (plans.operation !== "evaluation") {
      const unfinished = samplings.filter(({ execution }) => owesWork(execution));
      if (unfinished.length > 0) {
        await this.#execute(run, plans.execution, unfinished, stopSignal);
        samplings = await this.#records.samplings(run.samplingIds);
      }
      if (samplings.some(({ execution }) => isPendingSamplingStatus(execution.status))) return;
    }
    if (stopSignal?.aborted || plans.operation === "execution") return;

    const config = plans.evaluation;
    const samplingById = new Map(samplings.map((sampling) => [sampling.samplingId, sampling]));
    const pending = (await this.#records.evaluations(run.evaluationIds))
      .filter((evaluation) => owesWork(evaluation.status));
    const toEvaluate = pending.flatMap((evaluation) => {
      const sampling = samplingById.get(evaluation.samplingId);
      return sampling && (sampling.execution.status === "succeeded" || !isPendingSamplingStatus(evaluation.status.status))
        ? [{ sampling, evaluation }] : [];
    });
    const settlements = await Promise.allSettled([
      this.#evaluate(run, config, toEvaluate, stopSignal),
    ]);
    const errors = settlements.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, "Evaluation phase could not persist its progress");
  }

  async interrupt(runId: string): Promise<void> {
    const run = await this.#requireRun(runId);
    if (isRunStopPending(run)) await interruptRun(this.#stopContext(runId), run, await this.#records.plan(run));
  }

  async stop(runId: string, reporter?: RunStopReporter): Promise<void> {
    const run = await this.#requireRun(runId);
    if (!isRunStopPending(run)) return;
    const plans = await this.#records.plan(run);
    const context = this.#stopContext(runId);
    await interruptRun(context, run, plans);
    await finishStoppedRun(context, run, plans, reporter);
  }

  async #requireRun(runId: string): Promise<RuntimeRunRecord> {
    const run = await this.#store.getRun(runId);
    if (!run) throw new RuntimeEntityNotFoundError("run", runId);
    return run;
  }

  async #outputSchema(projectId: string): Promise<EvaluationOutputSchema> {
    const schema = await this.#plans.getEvaluationOutputSchema(projectId);
    if (!schema) throw new Error(`Project ${projectId} has no evaluation output JSON Schema`);
    return schema;
  }

  async #execute(
    run: RuntimeRunRecord,
    config: ExecutionPlan,
    samplings: readonly SamplingState[],
    stopSignal: AbortSignal | undefined,
  ): Promise<void> {
    const sampleFor = await this.#records.samples(samplings, run.projectId);
    await this.#runStage(
      run,
      stopSignal,
      config.executionConcurrency,
      samplings.map((state) => ({ state, sample: sampleFor(state) })),
      (dependencies, context) => executeSampling(dependencies, {
        context,
        harnessConfig: config.harness,
        retryPolicy: config.retryPolicy,
      }),
      "Execution phase could not persist its progress",
    );
  }

  /**
   * Run execution and evaluation as two independent bounded queues. Evaluation
   * work is admitted as soon as its Sampling has persisted successful execution
   * and evidence, while other Subject Samplings keep using execution capacity.
   */
  async #runPipeline(
    run: RuntimeRunRecord,
    executionConfig: ExecutionPlan,
    evaluationConfig: EvaluationPlan,
    samplings: readonly SamplingState[],
    stopSignal: AbortSignal | undefined,
    owesWork: (state: SamplingStageState) => boolean,
  ): Promise<void> {
    const evaluations = await this.#records.evaluations(run.evaluationIds);
    const samplingById = new Map(samplings.map((sampling) => [sampling.samplingId, sampling]));
    const evaluationBySamplingId = new Map(evaluations.map((evaluation) => [evaluation.samplingId, evaluation]));
    const sampleFor = await this.#records.samples(samplings, run.projectId);
    const sampleBySamplingId = new Map(samplings.map((sampling) => [sampling.samplingId, sampleFor(sampling)]));
    const executionQueue = createAgentTaskQueue({ maxConcurrentDos: executionConfig.executionConcurrency });
    const evaluationQueue = createAgentTaskQueue({ maxConcurrentDos: evaluationConfig.evaluationConcurrency });
    const executionErrors: unknown[] = [];
    const evaluationErrors: unknown[] = [];
    const cancellationTasks: Promise<void>[] = [];
    const cancelledEvaluationIds = new Set<string>();
    const scheduledEvaluationIds = new Set<string>();
    let evaluationOutputSchema: Promise<EvaluationOutputSchema> | undefined;

    const getEvaluationOutputSchema = (): Promise<EvaluationOutputSchema> => {
      evaluationOutputSchema ??= this.#outputSchema(run.projectId);
      return evaluationOutputSchema;
    };
    const cancelEvaluation = (evaluation: EvaluationRecord): void => {
      if (cancelledEvaluationIds.has(evaluation.evaluationId)) return;
      cancelledEvaluationIds.add(evaluation.evaluationId);
      cancellationTasks.push(this.#cancelEvaluation(run.runId, evaluation, evaluationConfig));
    };
    const guardedHarness = this.#guardedHarness(run.runId, stopSignal);
    const executionDependencies = this.#stageDependencies(run, guardedHarness, () => !stopSignal?.aborted);
    const evaluationDependencies = this.#stageDependencies(run, guardedHarness, () => !stopSignal?.aborted);
    const scheduleEvaluation = (sampling: SamplingState, evaluation: EvaluationRecord): void => {
      if (scheduledEvaluationIds.has(evaluation.evaluationId) || !owesWork(evaluation.status)) return;
      scheduledEvaluationIds.add(evaluation.evaluationId);
      evaluationQueue.enqueue(() => this.#runQueuedStageTask(stopSignal, evaluationErrors, async () => {
        await evaluateSampling(evaluationDependencies, {
          context: {
            sampling,
            evaluation,
            sample: sampleBySamplingId.get(sampling.samplingId)!,
          },
          harnessConfig: evaluationConfig.evaluationHarness,
          retryPolicy: evaluationConfig.retryPolicy,
          evaluationOutputSchema: await getEvaluationOutputSchema(),
        });
      }));
    };

    // Recover already successful executions immediately. Evaluations paired with
    // a still-running execution remain pending until that execution settles.
    for (const evaluation of evaluations) {
      const sampling = samplingById.get(evaluation.samplingId);
      if (!isPendingSamplingStatus(evaluation.status.status)) {
        if (sampling && owesWork(evaluation.status)) scheduleEvaluation(sampling, evaluation);
        continue;
      }
      if (sampling?.execution.status === "succeeded") {
        scheduleEvaluation(sampling, evaluation);
      } else if (!sampling || !isPendingSamplingStatus(sampling.execution.status)) {
        cancelEvaluation(evaluation);
      }
    }

    for (const state of samplings.filter(({ execution }) => owesWork(execution))) {
      executionQueue.enqueue(() => this.#runQueuedStageTask(stopSignal, executionErrors, async () => {
        await executeSampling(executionDependencies, {
          context: { state, sample: sampleBySamplingId.get(state.samplingId)! },
          harnessConfig: executionConfig.harness,
          retryPolicy: executionConfig.retryPolicy,
        });
        const latest = await this.#store.getSampling(state.samplingId);
        if (!latest) throw new RuntimeEntityNotFoundError("sampling", state.samplingId);
        samplingById.set(latest.samplingId, latest);
        const evaluation = evaluationBySamplingId.get(latest.samplingId);
        if (!evaluation || !isPendingSamplingStatus(evaluation.status.status)) return;
        if (latest.execution.status === "succeeded") {
          scheduleEvaluation(latest, evaluation);
        } else if (!isPendingSamplingStatus(latest.execution.status)) {
          cancelEvaluation(evaluation);
        }
      }));
    }

    try {
      await executionQueue.close();
    } catch (error) {
      executionErrors.push(error);
    }
    try {
      await evaluationQueue.close();
    } catch (error) {
      evaluationErrors.push(error);
    }
    // Cancellation deliberately runs outside the evaluation queue: it is a
    // record-only cleanup and must never consume an Evaluator concurrency slot.
    await Promise.allSettled(cancellationTasks);

    if (executionErrors.length > 0 && evaluationErrors.length > 0) {
      throw new AggregateError(
        [...executionErrors, ...evaluationErrors],
        "Pipeline could not persist its progress",
      );
    }
    if (executionErrors.length > 0) {
      throw new AggregateError(executionErrors, "Execution phase could not persist its progress");
    }
    if (evaluationErrors.length > 0) {
      throw new AggregateError(evaluationErrors, "Evaluation phase could not persist its progress");
    }
  }

  async #runQueuedStageTask(
    stopSignal: AbortSignal | undefined,
    errors: unknown[],
    task: () => Promise<void>,
  ): Promise<void> {
    if (stopSignal?.aborted) return;
    try {
      await task();
    } catch (error) {
      if (!(error instanceof RuntimeRunStoppedError)) errors.push(error);
    }
  }

  async #evaluate(
    run: RuntimeRunRecord,
    config: EvaluationPlan,
    targets: readonly { readonly sampling: SamplingState; readonly evaluation: EvaluationRecord }[],
    stopSignal: AbortSignal | undefined,
  ): Promise<void> {
    if (targets.length === 0) return;
    const sampleFor = await this.#records.samples(targets.map(({ sampling }) => sampling), run.projectId);
    const evaluationOutputSchema = await this.#outputSchema(run.projectId);
    await this.#runStage(
      run,
      stopSignal,
      config.evaluationConcurrency,
      targets.map(({ sampling, evaluation }) => ({ sampling, evaluation, sample: sampleFor(sampling) })),
      (dependencies, context) => evaluateSampling(dependencies, {
        context,
        harnessConfig: config.evaluationHarness,
        retryPolicy: config.retryPolicy,
        evaluationOutputSchema,
      }),
      "Evaluation phase could not persist its progress",
    );
  }

  async #runStage<TContext>(
    run: RuntimeRunRecord,
    stopSignal: AbortSignal | undefined,
    concurrency: number,
    contexts: readonly TContext[],
    runContext: (dependencies: StageDependencies, context: TContext) => Promise<unknown>,
    failure: string,
  ): Promise<void> {
    const dependencies = this.#stageDependencies(run, this.#guardedHarness(run.runId, stopSignal), () => !stopSignal?.aborted);
    const errors: unknown[] = [];
    await createAgentScheduler({ maxConcurrentDos: concurrency }).run(contexts.map((context) => async () => {
      if (stopSignal?.aborted) return;
      try {
        await runContext(dependencies, context);
      } catch (error) {
        if (!(error instanceof RuntimeRunStoppedError)) errors.push(error);
      }
    }));
    if (errors.length > 0) throw new AggregateError(errors, failure);
  }

  #stageDependencies(
    { runId, stopFinalized }: Pick<RuntimeRunRecord, "runId" | "stopFinalized">, harness: Harness, restartAllowed: () => boolean,
  ): StageDependencies {
    return {
      ...withContext(this.#stage, { runId }),
      ...(stopFinalized === undefined ? {} : { runStopped: stopFinalized }),
      harness,
      createRetryController: (policy, log) => {
        const delegate = this.#stage.createRetryController(policy, log);
        return {
          decide: (input) => input.operation === "restart" && !restartAllowed()
            ? Promise.resolve({ shouldRetry: false }) : delegate.decide(input),
        };
      },
    };
  }

  /** Serialize SP mutations with a persisted stop and abandon observations once the Run stops. */
  #guardedHarness(runId: string, stopSignal: AbortSignal | undefined): Harness {
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
      observe(this.#store.withRunDispatchGate(runId, dispatch));
    return {
      ensureAgent: (input) => gate(() => harness.ensureAgent(input)),
      materializeInitialData: (input) => gate(() => harness.materializeInitialData(input)),
      importEvidence: (input) => gate(() => harness.importEvidence(input)),
      submitAgent: (input) => gate(() => harness.submitAgent(input)),
      restartAgent: (input) => gate(() => harness.restartAgent(input)),
      waitForSubmission: (input) => observe(harness.waitForSubmission(input)),
      inspectAgentOperation: (input) => observe(harness.inspectAgentOperation(input)),
      stopAgent: (input) => observe(harness.stopAgent(input)),
      collectExecution: (input) => observe(harness.collectExecution(input)),
      collectEvaluation: (input) => observe(harness.collectEvaluation(input)),
      readFinalReply: (input) => observe(harness.readFinalReply(input)),
      inspectAgentResources: (input) => observe(harness.inspectAgentResources(input)),
      collectAgentResources: (input) => observe(harness.collectAgentResources(input)),
      exportEvidence: (input) => observe(harness.exportEvidence(input)),
    };
  }

  /** Pipeline evaluations of failed executions are cancelled independently of the evaluation scheduler. */
  async #cancelEvaluation(runId: string, evaluation: EvaluationRecord, config: EvaluationPlan): Promise<void> {
    const { samplingId, evaluationId } = evaluation;
    const context = { runId, stage: "evaluation", samplingId, evaluationId } as const;
    const retryController = this.#stage.createRetryController(config.retryPolicy, withContext(this.#stage, context).log);
    const persist = (record: EvaluationRecord, expected: EvaluationRecord): Promise<void> => persistRuntimeRecord({
      record,
      expected,
      write: (next, previous) => this.#store.updateEvaluation(next, previous),
      read: () => this.#store.getEvaluation(evaluation.evaluationId),
      retryController,
      sleep: this.#stage.sleep,
    });

    try {
      await persist({
        ...evaluation,
        status: { status: "cancelled", lastError: "execution did not succeed" },
      }, evaluation);
    } catch (error) {
      try {
        const current = await this.#store.getEvaluation(evaluation.evaluationId);
        if (!current) throw new RuntimeEntityNotFoundError("evaluation", evaluation.evaluationId);
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
        reportError((error) => this.#onError(error, context), reported);
      }
    }
  }
}
