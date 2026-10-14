import type {
  AgentConfigRef,
  AgentRole,
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
import type {
  ExecutionConfig,
  ResolvedEvaluationConfig,
  ResolvedExecutionConfig,
  ResolvedPipelineConfig,
  RunConfigSnapshot,
} from "../config/index.js";

import type {
  EvalRuntime,
  EvalRuntimeDependencies,
  EvalRunResumer,
  EvalRunResumerDependencies,
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
import { persistRuntimeRecord, RuntimeRunIdentityConflictError } from "./store.js";
import {
  errorMessage,
  requireSpHarness,
} from "./agent-lifecycle.js";
import {
  executeSampling,
  type ExecutionStageDependencies,
} from "./execution.js";
import {
  evaluateSampling,
  type EvaluationStageDependencies,
} from "./evaluation.js";
import {
  createRetryController,
  type RetryController,
} from "./retry.js";
import { createAgentScheduler, type AgentScheduler } from "./scheduler.js";
import { isPendingStatus, toRunSnapshot, toSamplingSnapshot } from "./projection.js";

type RuntimeStageDependencies = ExecutionStageDependencies & EvaluationStageDependencies;

function defaultIdFactory(): string {
  return crypto.randomUUID();
}

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireDistinctIds(ids: readonly string[], field: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${field} must not contain duplicate ids`);
  }
}

class RunResumer implements EvalRunResumer {
  protected readonly store: EvalRunResumerDependencies["store"];
  protected readonly idFactory: () => string;
  readonly #getSample: EvalRunResumerDependencies["getSample"];
  readonly #stageDependencies: RuntimeStageDependencies;
  readonly #createRetryController: (policy?: RetryPolicy) => RetryController;
  readonly #onError: (error: Error) => void;

  constructor(dependencies: EvalRunResumerDependencies) {
    this.store = dependencies.store;
    this.idFactory = dependencies.idFactory ?? defaultIdFactory;
    this.#getSample = dependencies.getSample;
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

  async resume(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);

    let samplings = await this.loadSamplingRecords(run.samplingIds);
    if (run.config.operation !== "evaluation") {
      const unfinished = samplings.filter(({ execution }) => isPendingStatus(execution.status));
      if (unfinished.length > 0) {
        const contexts = await this.loadSamplingContexts(unfinished, run.projectId);
        await this.runExecutionPhase(contexts, run.config.execution);
        samplings = await this.loadSamplingRecords(run.samplingIds);
      }
      if (samplings.some(({ execution }) => isPendingStatus(execution.status))) return;
    }

    if (run.config.operation === "execution") return;

    const evaluationConfig = run.config.evaluation;
    const evaluations = await this.loadEvaluationRecords(run.evaluationIds);
    const samplingById = new Map(samplings.map((sampling) => [sampling.samplingId, sampling]));
    const toEvaluate = evaluations.filter((evaluation) => (
      isPendingStatus(evaluation.status.status)
      && samplingById.get(evaluation.samplingId)?.execution.status === "succeeded"
    ));
    const toCancel = run.config.operation === "pipeline"
      ? evaluations.filter((evaluation) => (
          isPendingStatus(evaluation.status.status)
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

    const settlements = await Promise.allSettled([
      this.runEvaluationPhase(evaluationContexts, evaluationConfig),
      ...toCancel.map((evaluation) => this.cancelEvaluation(evaluation, evaluationConfig)),
    ]);
    const errors = settlements.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, "Evaluation phase could not persist its progress");
  }

  protected async loadSamplingRecords(
    samplingIds: readonly string[],
  ): Promise<readonly SamplingState[]> {
    return Promise.all(samplingIds.map(async (samplingId) => {
      const record = await this.store.getSampling(samplingId);
      if (!record) throw new Error(`Unknown sampling ${samplingId}`);
      return record;
    }));
  }

  protected async loadEvaluationRecords(
    evaluationIds: readonly string[],
  ): Promise<readonly EvaluationRecord[]> {
    return Promise.all(evaluationIds.map(async (evaluationId) => {
      const evaluation = await this.store.getEvaluation(evaluationId);
      if (!evaluation) throw new Error(`Unknown evaluation ${evaluationId}`);
      return evaluation;
    }));
  }

  protected async loadSamplingContexts(
    records: readonly SamplingState[],
    projectId: string,
  ): Promise<readonly RuntimeSamplingContext[]> {
    const samplePromises = new Map<string, Promise<Sample | null>>();
    return Promise.all(records.map(async (record) => {
      if (record.projectId !== projectId) {
        throw new Error(`Sampling ${record.samplingId} does not belong to project ${projectId}`);
      }
      const sampleId = record.sampleId;
      let samplePromise = samplePromises.get(sampleId);
      if (!samplePromise) {
        samplePromise = this.#getSample(sampleId);
        samplePromises.set(sampleId, samplePromise);
      }
      const sample = await samplePromise;
      if (!sample) throw new Error(`Unknown sample ${sampleId}`);
      if (sample.sampleId !== sampleId) {
        throw new Error(`Catalog returned sample ${sample.sampleId} for ${sampleId}`);
      }
      return { state: record, sample };
    }));
  }

  private async runExecutionPhase(
    contexts: readonly RuntimeSamplingContext[],
    config: ResolvedExecutionConfig,
  ): Promise<void> {
    const scheduler = this.scheduler(config.executionConcurrency);
    const errors: unknown[] = [];
    await scheduler.run(contexts.map((context) => async () => {
      try {
        await executeSampling(this.#stageDependencies, {
          context,
          harnessConfig: config.harness,
          retryPolicy: config.retryPolicy,
        });
      } catch (error) {
        errors.push(error);
      }
    }));
    if (errors.length > 0) throw new AggregateError(errors, "Execution phase could not persist its progress");
  }

  private async runEvaluationPhase(
    contexts: readonly RuntimeEvaluationContext[],
    config: ResolvedEvaluationConfig,
  ): Promise<void> {
    const scheduler = this.scheduler(config.evaluationConcurrency);
    const errors: unknown[] = [];
    await scheduler.run(contexts.map((context) => async () => {
      try {
        await evaluateSampling(this.#stageDependencies, {
          context,
          harnessConfig: config.evaluationHarness,
          retryPolicy: config.retryPolicy,
        });
      } catch (error) {
        errors.push(error);
      }
    }));
    if (errors.length > 0) throw new AggregateError(errors, "Evaluation phase could not persist its progress");
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

class RuntimeCoordinator extends RunResumer implements EvalRuntime {
  readonly #catalog: RuntimeCatalog;
  readonly #configResolver: EvalRuntimeDependencies["configResolver"];

  constructor(dependencies: EvalRuntimeDependencies) {
    super({ ...dependencies, getSample: dependencies.catalog.getSample.bind(dependencies.catalog) });
    this.#catalog = dependencies.catalog;
    this.#configResolver = dependencies.configResolver;
  }

  listProjects(): Promise<readonly Project[]> {
    return this.#catalog.listProjects();
  }

  listAgents(role?: AgentRole) {
    return this.#catalog.listAgents(role);
  }

  listDatasets() {
    return this.#catalog.listDatasets();
  }

  listData(datasetId: string) {
    return this.#catalog.listData(datasetId);
  }

  listSamples(dataId: string) {
    return this.#catalog.listSamples(dataId);
  }

  async start(request: StartRunRequest): Promise<RunHandle> {
    this.validateStartRequest(request);
    const config = await this.#configResolver.resolveExecutionConfig(request.executionConfigId);
    const subjectAgent = requireSpHarness(config.harness, "subject").agentConfig;
    const requestIdentity = await createRunRequestIdentity("start", request, config);
    const existingRun = await this.findExistingRun(requestIdentity);
    if (existingRun) return this.runHandle(existingRun);

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
      { operation: "execution", execution: config },
      requestIdentity,
    );

    const admission = await this.persistNewRun(run, records, []);
    return this.runHandle(admission.run);
  }

  async evaluate(request: EvaluateRequest): Promise<RunHandle> {
    this.validateEvaluateRequest(request);
    const config = await this.#configResolver.resolveEvaluationConfig(request.evaluationConfigId);
    const evaluationAgent = requireSpHarness(config.evaluationHarness, "evaluator").agentConfig;
    const records = await this.loadSamplingRecords(request.samplingIds);
    for (const record of records) {
      if (record.projectId !== request.projectId) {
        throw new Error(`Sampling ${record.samplingId} does not belong to project ${request.projectId}`);
      }
      if (record.execution.status !== "succeeded") {
        throw new Error(`Sampling ${record.samplingId} has no successful execution output`);
      }
    }
    const contexts = await this.loadSamplingContexts(records, request.projectId);
    const evaluations = contexts.map(({ state }) => (
      this.createEvaluationRecord(state.samplingId, evaluationAgent)
    ));
    const run = this.createRun(
      request.projectId,
      records.map(({ samplingId }) => samplingId),
      ["evaluation"],
      evaluations.map(({ evaluationId }) => evaluationId),
      { operation: "evaluation", evaluation: config },
    );
    const admission = await this.store.createRunWithSamplings(run, records, evaluations);
    return this.runHandle(admission.run);
  }

  async pipeline(request: PipelineRequest): Promise<RunHandle> {
    this.validatePipelineRequest(request);
    const config = await this.#configResolver.resolvePipelineConfig(request.pipelineConfigId);
    const subjectAgent = requireSpHarness(config.execution.harness, "subject").agentConfig;
    const evaluationAgent = requireSpHarness(
      config.evaluation.evaluationHarness,
      "evaluator",
    ).agentConfig;
    const requestIdentity = await createRunRequestIdentity("pipeline", request, config);
    const existingRun = await this.findExistingRun(requestIdentity);
    if (existingRun) return this.runHandle(existingRun);

    const samples = await this.resolveSamples(config.execution.datasetId, config.execution.sampleIds);
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
      {
        operation: "pipeline",
        pipeline: config.pipeline,
        execution: config.execution,
        evaluation: config.evaluation,
      },
      requestIdentity,
    );

    const admission = await this.persistNewRun(run, records, evaluations);
    return this.runHandle(admission.run);
  }

  async getRun(runId: string): Promise<RunSnapshot> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
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
    if (!request.requestId) throw new Error("requestId is required");
    if (request.idempotencyKey !== undefined && !request.idempotencyKey) {
      throw new Error("idempotencyKey must not be empty");
    }
    if (!request.projectId) throw new Error("projectId is required");
    if (!request.executionConfigId) throw new Error("executionConfigId is required");
  }

  private validateEvaluateRequest(request: EvaluateRequest): void {
    if (!request.projectId) throw new Error("projectId is required");
    if (request.samplingIds.length === 0) throw new Error("samplingIds must not be empty");
    requireDistinctIds(request.samplingIds, "samplingIds");
    if (!request.evaluationConfigId) throw new Error("evaluationConfigId is required");
  }

  private validatePipelineRequest(request: PipelineRequest): void {
    if (!request.requestId) throw new Error("requestId is required");
    if (request.idempotencyKey !== undefined && !request.idempotencyKey) {
      throw new Error("idempotencyKey must not be empty");
    }
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
    requestIdentity?: RuntimeRunRequestIdentity,
  ): RuntimeRunRecord {
    return {
      runId: this.idFactory(),
      samplingIds: [...samplingIds],
      projectId,
      phases,
      evaluationIds: [...evaluationIds],
      config,
      ...(requestIdentity ? { requestIdentity } : {}),
    };
  }

  private async persistNewRun(
    run: RuntimeRunRecord,
    records: readonly SamplingState[],
    evaluations: readonly EvaluationRecord[],
  ): Promise<RuntimeRunAdmission> {
    return this.store.createRunWithSamplings(run, records, evaluations);
  }

  private async findExistingRun(
    requestIdentity: RuntimeRunRequestIdentity,
  ): Promise<RuntimeRunRecord | null> {
    const byRequestId = await this.store.findRunByRequestId(requestIdentity.requestId);
    const byIdempotencyKey = requestIdentity.idempotencyKey === undefined
      ? null
      : await this.store.findRunByIdempotencyKey(requestIdentity.idempotencyKey);

    if (
      byRequestId &&
      byIdempotencyKey &&
      byRequestId.runId !== byIdempotencyKey.runId
    ) {
      throw new RuntimeRunIdentityConflictError(
        "requestId and idempotencyKey refer to different evaluation runs",
      );
    }

    const existingRun = byIdempotencyKey ?? byRequestId;
    if (!existingRun) return null;
    assertRequestIdentity(existingRun, requestIdentity);
    return existingRun;
  }

  private runHandle(run: RuntimeRunRecord): RunHandle {
    return { runId: run.runId, samplingIds: [...run.samplingIds] };
  }


}

export type {
  AgentOption,
  EvalRuntime,
  EvalRuntimeDependencies,
  EvalRunResumer,
  EvalRunResumerDependencies,
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
export { RuntimeRunIdentityConflictError, RuntimeRecordConflictError, RuntimeRecordPersistenceError } from "./store.js";
export { toRunSnapshot, toSamplingSnapshot } from "./projection.js";
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
  return new RuntimeCoordinator(dependencies);
}

export function createEvalRunResumer(
  dependencies: EvalRunResumerDependencies,
): EvalRunResumer {
  return new RunResumer(dependencies);
}

type RunRequestOperation = "start" | "pipeline";

async function createRunRequestIdentity(
  operation: RunRequestOperation,
  request: StartRunRequest | PipelineRequest,
  config: ExecutionConfig | ResolvedPipelineConfig,
): Promise<RuntimeRunRequestIdentity> {
  const requestFingerprint = await fingerprintRequest({
    operation,
    projectId: request.projectId,
    config,
  });

  return {
    requestId: request.requestId,
    ...(request.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: request.idempotencyKey }),
    requestFingerprint,
  };
}

function assertRequestIdentity(
  existingRun: RuntimeRunRecord,
  requestIdentity: RuntimeRunRequestIdentity,
): void {
  if (
    existingRun.requestIdentity?.requestFingerprint !== requestIdentity.requestFingerprint
  ) {
    throw new RuntimeRunIdentityConflictError(
      "request identity is already bound to different evaluation run facts",
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
