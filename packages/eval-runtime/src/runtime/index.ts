import type {
  AgentConfigRef,
  AgentRole,
  EvaluationRecord,
  EvaluateRequest,
  PipelineRequest,
  Project,
  RetryPolicy,
  RunHandle,
  RunPhase,
  RunPhases,
  RunSnapshot,
  Sampling,
  SamplingStatus,
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
import { RuntimeRunIdentityConflictError } from "./store.js";
import {
  errorMessage,
  requireSpHarness,
  withExecutionStatus,
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

class RuntimeCoordinator implements EvalRuntime {
  readonly #catalog: RuntimeCatalog;
  readonly #configResolver: EvalRuntimeDependencies["configResolver"];
  readonly #store: EvalRuntimeDependencies["store"];
  readonly #stageDependencies: RuntimeStageDependencies;
  readonly #idFactory: () => string;
  readonly #now: () => string;
  readonly #createRetryController: (policy?: RetryPolicy) => RetryController;

  constructor(dependencies: EvalRuntimeDependencies) {
    this.#catalog = dependencies.catalog;
    this.#configResolver = dependencies.configResolver;
    this.#store = dependencies.store;
    this.#idFactory = dependencies.idFactory ?? defaultIdFactory;
    this.#now = dependencies.now ?? defaultNow;
    this.#createRetryController = dependencies.createRetryController ?? createRetryController;
    this.#stageDependencies = {
      harness: dependencies.harness,
      store: dependencies.store,
      idFactory: this.#idFactory,
      now: this.#now,
      sleep: dependencies.sleep ?? defaultSleep,
      createRetryController: this.#createRetryController,
    };
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
    if (!admission.created) return this.runHandle(admission.run);

    void this.runExecutionPhase(contexts, config).catch((error: unknown) => {
      void this.failRun(admission.run, error).catch(() => undefined);
    });
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
    const evaluationContexts = contexts.map((context, index) => ({
      sampling: context.state,
      evaluation: evaluations[index]!,
      sample: context.sample,
    }));

    const run = this.createRun(
      request.projectId,
      records.map(({ samplingId }) => samplingId),
      ["evaluation"],
      evaluations.map(({ evaluationId }) => evaluationId),
      { operation: "evaluation", evaluation: config },
    );
    const admission = await this.#store.createRunWithSamplings(run, records, evaluations);
    if (!admission.created) return this.runHandle(admission.run);

    void this.runEvaluationPhase(evaluationContexts, config).catch((error: unknown) => {
      void this.failRun(admission.run, error).catch(() => undefined);
    });
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
    if (!admission.created) return this.runHandle(admission.run);

    void this.runPipeline(contexts, evaluations, config).catch((error: unknown) => {
      void this.failRun(admission.run, error).catch(() => undefined);
    });
    return this.runHandle(admission.run);
  }

  async getRun(runId: string): Promise<RunSnapshot> {
    const run = await this.#store.getRun(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    const records = await this.loadSamplingRecords(run.samplingIds);
    const evaluations = await this.loadEvaluationRecords(run.evaluationIds);
    return toRunSnapshot(run, records, evaluations);
  }

  async getSampling(samplingId: string): Promise<SamplingSnapshot> {
    const state = await this.#store.getSampling(samplingId);
    if (!state) throw new Error(`Unknown sampling ${samplingId}`);
    return toSamplingSnapshot(state);
  }

  async getEvaluation(evaluationId: string): Promise<EvaluationRecord> {
    const evaluation = await this.#store.getEvaluation(evaluationId);
    if (!evaluation) throw new Error(`Unknown evaluation ${evaluationId}`);
    return structuredClone(evaluation);
  }

  async listEvaluations(samplingId: string): Promise<readonly EvaluationRecord[]> {
    return structuredClone(await this.#store.listEvaluations(samplingId));
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

  private async loadSamplingRecords(
    samplingIds: readonly string[],
  ): Promise<readonly SamplingState[]> {
    return Promise.all(samplingIds.map(async (samplingId) => {
      const record = await this.#store.getSampling(samplingId);
      if (!record) throw new Error(`Unknown sampling ${samplingId}`);
      return record;
    }));
  }

  private async loadEvaluationRecords(
    evaluationIds: readonly string[],
  ): Promise<readonly EvaluationRecord[]> {
    return Promise.all(evaluationIds.map(async (evaluationId) => {
      const evaluation = await this.#store.getEvaluation(evaluationId);
      if (!evaluation) throw new Error(`Unknown evaluation ${evaluationId}`);
      return evaluation;
    }));
  }

  private async loadSamplingContexts(
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
        samplePromise = this.#catalog.getSample(sampleId);
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

  private createSamplingContext(
    projectId: string,
    sample: Sample,
    subjectAgent: AgentConfigRef,
  ): RuntimeSamplingContext {
    const sampling: Sampling = {
      samplingId: this.#idFactory(),
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
      evaluationId: this.#idFactory(),
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
      runId: this.#idFactory(),
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
    return this.#store.createRunWithSamplings(run, records, evaluations);
  }

  private async findExistingRun(
    requestIdentity: RuntimeRunRequestIdentity,
  ): Promise<RuntimeRunRecord | null> {
    const byRequestId = await this.#store.findRunByRequestId(requestIdentity.requestId);
    const byIdempotencyKey = requestIdentity.idempotencyKey === undefined
      ? null
      : await this.#store.findRunByIdempotencyKey(requestIdentity.idempotencyKey);

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

  private async runExecutionPhase(
    contexts: readonly RuntimeSamplingContext[],
    config: ResolvedExecutionConfig,
  ): Promise<readonly RuntimeSamplingContext[]> {
    const scheduler = this.scheduler(config.executionConcurrency);
    const results = await scheduler.run(contexts.map((context) => async () => {
      try {
        return await executeSampling(this.#stageDependencies, {
          context,
          harnessConfig: config.harness,
          retryPolicy: config.retryPolicy,
        });
      } catch (error) {
        return {
          ...context,
          state: await this.markSamplingFailed(context.state.samplingId, error),
        };
      }
    }));
    return results;
  }

  private async runEvaluationPhase(
    contexts: readonly RuntimeEvaluationContext[],
    config: ResolvedEvaluationConfig,
  ): Promise<readonly RuntimeEvaluationContext[]> {
    const scheduler = this.scheduler(config.evaluationConcurrency);
    const results = await scheduler.run(contexts.map((context) => async () => {
      try {
        return await evaluateSampling(this.#stageDependencies, {
          context,
          harnessConfig: config.evaluationHarness,
          retryPolicy: config.retryPolicy,
        });
      } catch (error) {
        return {
          ...context,
          evaluation: await this.markEvaluationFailed(context.evaluation, error),
        };
      }
    }));
    return results;
  }

  private async runPipeline(
    contexts: readonly RuntimeSamplingContext[],
    evaluations: readonly EvaluationRecord[],
    config: ResolvedPipelineConfig,
  ): Promise<void> {
    const executedContexts = await this.runExecutionPhase(contexts, config.execution);
    const evaluationBySamplingId = new Map(
      evaluations.map((evaluation) => [evaluation.samplingId, evaluation]),
    );
    await Promise.all(executedContexts
      .filter(({ state }) => state.execution.status !== "succeeded")
      .map(async ({ state }) => {
        const evaluation = evaluationBySamplingId.get(state.samplingId);
        if (!evaluation) throw new Error(`Missing evaluation for sampling ${state.samplingId}`);
        await this.#store.updateEvaluation({
          ...evaluation,
          status: { status: "cancelled", lastError: "execution did not succeed" },
        });
      }));

    const evaluableContexts = executedContexts.filter(
      ({ state }) => state.execution.status === "succeeded",
    );
    if (evaluableContexts.length === 0) return;

    const evaluationContexts = evaluableContexts.map((context) => {
      const evaluation = evaluationBySamplingId.get(context.state.samplingId);
      if (!evaluation) {
        throw new Error(`Missing evaluation for sampling ${context.state.samplingId}`);
      }
      return {
        sampling: context.state,
        evaluation,
        sample: context.sample,
      };
    });
    await this.runEvaluationPhase(evaluationContexts, config.evaluation);
  }

  private scheduler(maxConcurrentDos: number): AgentScheduler {
    return createAgentScheduler({ maxConcurrentDos });
  }

  private async markSamplingFailed(
    samplingId: string,
    error: unknown,
  ): Promise<SamplingState> {
    const current = await this.#store.getSampling(samplingId);
    if (!current) throw new Error(`Unknown sampling ${samplingId}`);
    const failed = withExecutionStatus(current, "failed", errorMessage(error));
    await this.#store.updateSampling(failed);
    return failed;
  }

  private async failRun(run: RuntimeRunRecord, error: unknown): Promise<void> {
    const records = await this.loadSamplingRecords(run.samplingIds);
    const phase = currentRunPhase(records, run.phases);
    if (phase === "execution") {
      await Promise.all(records.map(async (state) => {
        if (state.execution.status === "succeeded") return;
        await this.#store.updateSampling(
          withExecutionStatus(state, "failed", errorMessage(error)),
        );
      }));
      return;
    }

    const evaluations = await this.loadEvaluationRecords(run.evaluationIds);
    const samplingById = new Map(
      records.map((state) => [state.samplingId, state]),
    );
    await Promise.all(evaluations.map(async (evaluation) => {
      const sampling = samplingById.get(evaluation.samplingId);
      if (!sampling || sampling.execution.status !== "succeeded") return;
      if (evaluation.status.status === "succeeded") return;
      await this.#store.updateEvaluation({
        ...evaluation,
        status: { status: "failed", lastError: errorMessage(error) },
      });
    }));
  }

  private async markEvaluationFailed(
    evaluation: EvaluationRecord,
    error: unknown,
  ): Promise<EvaluationRecord> {
    const current = await this.#store.getEvaluation(evaluation.evaluationId);
    if (!current) throw new Error(`Unknown evaluation ${evaluation.evaluationId}`);
    const failed = {
      ...current,
      status: { status: "failed", lastError: errorMessage(error) },
    } satisfies EvaluationRecord;
    await this.#store.updateEvaluation(failed);
    return failed;
  }
}

function isPendingStatus(status: SamplingStatus): boolean {
  return status === "queued"
    || status === "starting"
    || status === "running"
    || status === "retrying";
}

function aggregateRunProgress(
  records: readonly SamplingState[],
  evaluations: readonly EvaluationRecord[],
  phases: RunPhases,
): Pick<RunSnapshot, "phase" | "status"> {
  const phase = currentRunPhase(records, phases);
  const evaluationBySamplingId = new Map(
    evaluations.map((evaluation) => [evaluation.samplingId, evaluation]),
  );
  const phaseRecords = phase === "evaluation"
    ? records.filter((state) => state.execution.status === "succeeded")
    : records;
  const statuses = phaseRecords.map((state) => (
    phase === "execution"
      ? state.execution.status
      : evaluationBySamplingId.get(state.samplingId)?.status.status ?? "queued"
  ));
  const pending = statuses.filter(isPendingStatus);
  const hasExecutionFailure = phases.length === 2
    && records.some((state) => (
      state.execution.status === "failed" || state.execution.status === "cancelled"
    ));

  let status: SamplingStatus;
  if (records.length === 0 || phaseRecords.length === 0) {
    status = "failed";
  } else if (pending.some((item) => item === "retrying")) {
    status = "retrying";
  } else if (pending.some((item) => item === "starting" || item === "running")) {
    status = "running";
  } else if (pending.length > 0) {
    status = phase === "evaluation" && phases.length === 2 ? "running" : "queued";
  } else if (
    hasExecutionFailure
    || statuses.some((item) => item === "failed" || item === "cancelled")
  ) {
    status = "failed";
  } else {
    status = "succeeded";
  }
  return { phase, status };
}

function currentRunPhase(
  records: readonly SamplingState[],
  phases: RunPhases,
): RunPhase {
  const firstPhase = phases[0];
  if (firstPhase === "execution" && phases.length === 2) {
    const executionInProgress = records.some((state) => (
      isPendingStatus(state.execution.status)
    ));
    if (executionInProgress) return "execution";
    if (records.some((state) => state.execution.status === "succeeded")) {
      return "evaluation";
    }
  }
  return firstPhase;
}

function toRunSnapshot(
  run: RuntimeRunRecord,
  records: readonly SamplingState[],
  evaluations: readonly EvaluationRecord[],
): RunSnapshot {
  return {
    runId: run.runId,
    samplingIds: [...run.samplingIds],
    projectId: run.projectId,
    phases: run.phases,
    evaluationIds: [...run.evaluationIds],
    ...aggregateRunProgress(records, evaluations, run.phases),
  };
}

function toSamplingSnapshot(state: SamplingState): SamplingSnapshot {
  return {
    samplingId: state.samplingId,
    projectId: state.projectId,
    sampleId: state.sampleId,
    execution: { ...state.execution },
    subjectAgent: { ...state.subjectAgent },
    ...(state.subjectSubmissionId === undefined
      ? {}
      : { subjectSubmissionId: state.subjectSubmissionId }),
    executionAttempts: structuredClone(state.executionAttempts),
    ...(state.artifacts === undefined
      ? {}
      : { artifacts: state.artifacts.map((artifact) => ({ ...artifact })) }),
    ...(state.trajectory === undefined
      ? {}
      : { trajectory: { ...state.trajectory } }),
  };
}

export type {
  AgentOption,
  EvalRuntime,
  EvalRuntimeDependencies,
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
  SamplingState,
  RuntimeStore,
} from "./store.js";
export { RuntimeRunIdentityConflictError } from "./store.js";
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
