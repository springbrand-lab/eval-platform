import type {
  EvaluationOutputSchema,
  EvaluationPlan,
  EvaluationRecord,
  ExecutionPlan,
  RetryPolicy,
} from "@eval-platform/eval-contracts";
import { DEFAULT_EVIDENCE_LIMITS, isPendingSamplingStatus } from "@eval-platform/eval-contracts";
import { createId } from "@eval-platform/eval-contracts";
import type { Harness } from "../harness/model.js";
import { errorMessage, reportError, type StageDependencies } from "./agent-lifecycle.js";
import { RuntimeEntityNotFoundError, RuntimeRunStoppedError } from "./errors.js";
import { evaluateSampling } from "./evaluation.js";
import { executeSampling } from "./execution.js";
import type { EvalRunResumer, EvalRunResumerDependencies } from "./model.js";
import { RunRecords } from "./records.js";
import { createRetryController, type RetryController } from "./retry.js";
import { createAgentScheduler } from "./scheduler.js";
import { finishStoppedRun, interruptRun, type StopContext } from "./stop.js";
import { persistRuntimeRecord, type RuntimeRunRecord, type RuntimeStore, type SamplingState } from "./store.js";

export class RunResumer implements EvalRunResumer {
  readonly #store: RuntimeStore;
  readonly #records: RunRecords;
  readonly #harness: Harness;
  readonly #plans: EvalRunResumerDependencies["plans"];
  readonly #createRetryController: (policy?: RetryPolicy) => RetryController;
  readonly #onError: (error: Error) => void;
  readonly #stage: StageDependencies;
  readonly #stop: StopContext;

  constructor(dependencies: EvalRunResumerDependencies) {
    this.#store = dependencies.store;
    this.#records = new RunRecords(dependencies.store, dependencies.plans);
    this.#harness = dependencies.harness;
    this.#plans = dependencies.plans;
    this.#createRetryController = dependencies.createRetryController ?? createRetryController;
    this.#onError = dependencies.onError;
    this.#stage = {
      harness: dependencies.harness,
      store: dependencies.store,
      evidence: dependencies.evidence,
      evidenceLimits: dependencies.evidenceLimits ?? DEFAULT_EVIDENCE_LIMITS,
      idFactory: dependencies.idFactory ?? createId,
      now: dependencies.now ?? (() => new Date().toISOString()),
      sleep: dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
      onError: this.#onError,
      createRetryController: this.#createRetryController,
      ...(dependencies.scores === undefined ? {} : { scores: dependencies.scores }),
    };
    this.#stop = {
      store: this.#store,
      records: this.#records,
      harness: this.#harness,
      now: this.#stage.now,
      sleep: this.#stage.sleep,
      createRetryController: this.#createRetryController,
      stageDependencies: this.#stageDependencies(this.#harness, () => false),
      outputSchema: (projectId) => this.#outputSchema(projectId),
    };
  }

  async resume(runId: string, stopSignal?: AbortSignal): Promise<void> {
    if (stopSignal?.aborted) return;
    const run = await this.#requireRun(runId);
    if (run.stopRequested || stopSignal?.aborted) return;
    const plans = await this.#records.plan(run);

    let samplings = await this.#records.samplings(run.samplingIds);
    if (plans.operation !== "evaluation") {
      const unfinished = samplings.filter(({ execution }) => isPendingSamplingStatus(execution.status));
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
      .filter((evaluation) => isPendingSamplingStatus(evaluation.status.status));
    const toEvaluate = pending.flatMap((evaluation) => {
      const sampling = samplingById.get(evaluation.samplingId);
      return sampling?.execution.status === "succeeded" ? [{ sampling, evaluation }] : [];
    });
    const toCancel = plans.operation === "pipeline"
      ? pending.filter((evaluation) => samplingById.get(evaluation.samplingId)?.execution.status !== "succeeded")
      : [];
    const settlements = await Promise.allSettled([
      this.#evaluate(run, config, toEvaluate, stopSignal),
      ...toCancel.map((evaluation) => this.#cancelEvaluation(evaluation, config)),
    ]);
    const errors = settlements.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, "Evaluation phase could not persist its progress");
  }

  async interrupt(runId: string): Promise<void> {
    const run = await this.#requireRun(runId);
    if (run.stopRequested) await interruptRun(this.#stop, run, await this.#records.plan(run));
  }

  async stop(runId: string): Promise<void> {
    const run = await this.#requireRun(runId);
    if (!run.stopRequested) return;
    const plans = await this.#records.plan(run);
    await interruptRun(this.#stop, run, plans);
    await finishStoppedRun(this.#stop, run, plans);
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
      run.runId,
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
      run.runId,
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
    runId: string,
    stopSignal: AbortSignal | undefined,
    concurrency: number,
    contexts: readonly TContext[],
    run: (dependencies: StageDependencies, context: TContext) => Promise<unknown>,
    failure: string,
  ): Promise<void> {
    const dependencies = this.#stageDependencies(this.#guardedHarness(runId, stopSignal), () => !stopSignal?.aborted);
    const errors: unknown[] = [];
    await createAgentScheduler({ maxConcurrentDos: concurrency }).run(contexts.map((context) => async () => {
      if (stopSignal?.aborted) return;
      try {
        await run(dependencies, context);
      } catch (error) {
        if (!(error instanceof RuntimeRunStoppedError)) errors.push(error);
      }
    }));
    if (errors.length > 0) throw new AggregateError(errors, failure);
  }

  #stageDependencies(harness: Harness, restartAllowed: () => boolean): StageDependencies {
    return {
      ...this.#stage,
      harness,
      createRetryController: (policy) => {
        const delegate = this.#createRetryController(policy);
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
      collectAgentResources: (input) => observe(harness.collectAgentResources(input)),
      exportEvidence: (input) => observe(harness.exportEvidence(input)),
    };
  }

  /** Pipeline evaluations of failed executions are cancelled independently of the evaluation scheduler. */
  async #cancelEvaluation(evaluation: EvaluationRecord, config: EvaluationPlan): Promise<void> {
    const retryController = this.#createRetryController(config.retryPolicy);
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
        reportError(this.#onError, reported);
      }
    }
  }
}
