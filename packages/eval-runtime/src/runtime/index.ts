import type {
  AgentConfigRef,
  AgentRole,
  EvaluateRequest,
  HarnessConfig,
  PipelineRequest,
  Project,
  RetryPolicy,
  RunHandle,
  RunSnapshot,
  Sampling,
  SamplingStatus,
  StartRunRequest,
} from "@eval-platform/eval-contracts";

import type {
  EvalRuntime,
  EvalRuntimeDependencies,
  RuntimeCatalog,
  Sample,
} from "./model.js";
import type {
  RuntimePhase,
  RuntimeRunRecord,
  RuntimeSamplingRecord,
} from "./store.js";
import {
  errorMessage,
  requireSpAgent,
  withSamplingStatus,
  type AgentLifecycleStage,
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
type EvaluationPhaseRequest = Pick<
  EvaluateRequest,
  "evaluationHarness" | "evaluationConcurrency" | "retryPolicy"
>;

function defaultIdFactory(): string {
  return crypto.randomUUID();
}

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function requireDistinctIds(ids: readonly string[], field: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${field} must not contain duplicate ids`);
  }
}

class RuntimeCoordinator implements EvalRuntime {
  readonly #catalog: RuntimeCatalog;
  readonly #store: EvalRuntimeDependencies["store"];
  readonly #stageDependencies: RuntimeStageDependencies;
  readonly #idFactory: () => string;
  readonly #now: () => string;
  readonly #createRetryController: (policy?: RetryPolicy) => RetryController;

  constructor(dependencies: EvalRuntimeDependencies) {
    this.#catalog = dependencies.catalog;
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
    const samples = await this.resolveSamples(request.datasetId, request.sampleIds);
    const subjectAgent = requireSpAgent(request.harness, "subject");
    const records = samples.flatMap((sample) => Array.from(
      { length: request.samplingCount },
      () => this.createSamplingRecord(request.projectId, sample, subjectAgent),
    ));
    const run = this.createRun(
      request.projectId,
      records.map(({ sampling }) => sampling.samplingId),
      "execution",
    );

    await this.persistNewRun(run, records);
    void this.runExecutionPhase(records, request).catch((error: unknown) => {
      void this.failRun(run, error).catch(() => undefined);
    });
    return this.runHandle(run);
  }

  async evaluate(request: EvaluateRequest): Promise<RunHandle> {
    this.validateEvaluateRequest(request);
    const evaluationAgent = requireSpAgent(request.evaluationHarness, "evaluator");
    const records = await this.loadSamplingRecords(request.samplingIds);
    const preparedRecords = records.map((record) => {
      if (record.sampling.projectId !== request.projectId) {
        throw new Error(`Sampling ${record.sampling.samplingId} does not belong to project ${request.projectId}`);
      }
      if (!record.execution || record.execution.status !== "succeeded") {
        throw new Error(`Sampling ${record.sampling.samplingId} has no successful execution output`);
      }
      return resetEvaluation(record, evaluationAgent);
    });

    const run = this.createRun(
      request.projectId,
      preparedRecords.map(({ sampling }) => sampling.samplingId),
      "evaluation",
    );
    await this.#store.createRunWithSamplings(run, preparedRecords);
    void this.runEvaluationPhase(preparedRecords, request).catch((error: unknown) => {
      void this.failRun(run, error).catch(() => undefined);
    });
    return this.runHandle(run);
  }

  async pipeline(request: PipelineRequest): Promise<RunHandle> {
    this.validatePipelineRequest(request);
    const samples = await this.resolveSamples(request.datasetId, request.sampleIds);
    const subjectAgent = requireSpAgent(request.harness, "subject");
    const evaluationAgent = requireSpAgent(request.evaluationHarness, "evaluator");
    const records = samples.flatMap((sample) => Array.from(
      { length: request.samplingCount },
      () => this.createSamplingRecord(request.projectId, sample, subjectAgent, evaluationAgent),
    ));
    const run = this.createRun(
      request.projectId,
      records.map(({ sampling }) => sampling.samplingId),
      "pipeline",
    );

    await this.persistNewRun(run, records);
    void this.runPipeline(records, request).catch((error: unknown) => {
      void this.failRun(run, error).catch(() => undefined);
    });
    return this.runHandle(run);
  }

  async getRun(runId: string): Promise<RunSnapshot> {
    const run = await this.#store.getRun(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    const records = await this.loadSamplingRecords(run.samplingIds);
    return toRunSnapshot(run, records);
  }

  async getSampling(samplingId: string): Promise<RuntimeSamplingRecord> {
    const record = await this.#store.getSampling(samplingId);
    if (!record) throw new Error(`Unknown sampling ${samplingId}`);
    return record;
  }

  private validateStartRequest(request: StartRunRequest): void {
    if (!request.projectId) throw new Error("projectId is required");
    if (!request.datasetId) throw new Error("datasetId is required");
    requirePositiveInteger(request.samplingCount, "samplingCount");
    requirePositiveInteger(request.executionConcurrency, "executionConcurrency");
    if (request.sampleIds) requireDistinctIds(request.sampleIds, "sampleIds");
    if (request.retryPolicy) this.#createRetryController(request.retryPolicy);
  }

  private validateEvaluateRequest(request: EvaluateRequest): void {
    if (!request.projectId) throw new Error("projectId is required");
    if (request.samplingIds.length === 0) throw new Error("samplingIds must not be empty");
    requireDistinctIds(request.samplingIds, "samplingIds");
    requirePositiveInteger(request.evaluationConcurrency, "evaluationConcurrency");
    if (request.retryPolicy) this.#createRetryController(request.retryPolicy);
  }

  private validatePipelineRequest(request: PipelineRequest): void {
    this.validateStartRequest(request);
    requirePositiveInteger(request.evaluationConcurrency, "evaluationConcurrency");
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
  ): Promise<readonly RuntimeSamplingRecord[]> {
    return Promise.all(samplingIds.map(async (samplingId) => {
      const record = await this.#store.getSampling(samplingId);
      if (!record) throw new Error(`Unknown sampling ${samplingId}`);
      return record;
    }));
  }

  private createSamplingRecord(
    projectId: string,
    sample: Sample,
    subjectAgent: AgentConfigRef,
    evaluationAgent?: AgentConfigRef,
  ): RuntimeSamplingRecord {
    const sampling: Sampling = {
      samplingId: this.#idFactory(),
      projectId,
      sampleId: sample.sampleId,
      execution: { status: "queued" },
      subjectAgent,
      ...(evaluationAgent ? { evaluationAgent } : {}),
      executionAttempts: [],
      evaluationAttempts: [],
    };
    return { sampling, sample };
  }

  private createRun(
    projectId: string,
    samplingIds: readonly string[],
    phase: RuntimePhase,
  ): RuntimeRunRecord {
    return {
      runId: this.#idFactory(),
      samplingIds: [...samplingIds],
      projectId,
      phase,
    };
  }

  private async persistNewRun(
    run: RuntimeRunRecord,
    records: readonly RuntimeSamplingRecord[],
  ): Promise<void> {
    await this.#store.createRunWithSamplings(run, records);
  }

  private runHandle(run: RuntimeRunRecord): RunHandle {
    return { runId: run.runId, samplingIds: [...run.samplingIds] };
  }

  private async runExecutionPhase(
    records: readonly RuntimeSamplingRecord[],
    request: StartRunRequest,
  ): Promise<readonly RuntimeSamplingRecord[]> {
    const scheduler = this.scheduler(request.executionConcurrency);
    const results = await scheduler.run(records.map((record) => async () => {
      try {
        return await executeSampling(this.#stageDependencies, {
          record,
          harnessConfig: request.harness,
          retryPolicy: request.retryPolicy,
        });
      } catch (error) {
        return this.markSamplingFailed(record.sampling.samplingId, "execution", error);
      }
    }));
    return results;
  }

  private async runEvaluationPhase(
    records: readonly RuntimeSamplingRecord[],
    request: EvaluationPhaseRequest,
  ): Promise<readonly RuntimeSamplingRecord[]> {
    const scheduler = this.scheduler(request.evaluationConcurrency);
    const results = await scheduler.run(records.map((record) => async () => {
      try {
        return await evaluateSampling(this.#stageDependencies, {
          record,
          harnessConfig: request.evaluationHarness,
          retryPolicy: request.retryPolicy,
        });
      } catch (error) {
        return this.markSamplingFailed(record.sampling.samplingId, "evaluation", error);
      }
    }));
    return results;
  }

  private async runPipeline(
    records: readonly RuntimeSamplingRecord[],
    request: PipelineRequest,
  ): Promise<void> {
    const executedRecords = await this.runExecutionPhase(records, request);
    const evaluableRecords = executedRecords.filter(
      ({ sampling }) => sampling.execution.status === "succeeded",
    );
    if (evaluableRecords.length === 0) return;

    const evaluationRecords = evaluableRecords.map((record) => {
      if (!record.sampling.evaluationAgent) {
        throw new Error(`Sampling ${record.sampling.samplingId} has no evaluation agent`);
      }
      return resetEvaluation(record, record.sampling.evaluationAgent);
    });
    await this.#store.prepareEvaluationSamplings(evaluationRecords);
    await this.runEvaluationPhase(evaluationRecords, request);
  }

  private scheduler(maxConcurrentDos: number): AgentScheduler {
    return createAgentScheduler({ maxConcurrentDos });
  }

  private async markSamplingFailed(
    samplingId: string,
    stage: AgentLifecycleStage,
    error: unknown,
  ): Promise<RuntimeSamplingRecord> {
    const current = await this.#store.getSampling(samplingId);
    if (!current) throw new Error(`Unknown sampling ${samplingId}`);
    const failed = {
      ...current,
      sampling: withSamplingStatus(
        current.sampling,
        stage,
        "failed",
        errorMessage(error),
      ),
    };
    await this.#store.updateSampling(failed);
    return failed;
  }

  private async failRun(run: RuntimeRunRecord, error: unknown): Promise<void> {
    const records = await this.loadSamplingRecords(run.samplingIds);
    await Promise.all(records.map(async (record) => {
      const stage = failureStage(record, run.phase);
      const shouldFail = stage === "execution"
        ? record.sampling.execution.status !== "succeeded"
        : record.sampling.evaluation?.status !== "succeeded";
      if (!shouldFail) return;
      await this.#store.updateSampling({
        ...record,
        sampling: withSamplingStatus(
          record.sampling,
          stage,
          "failed",
          errorMessage(error),
        ),
      });
    }));
  }
}

function resetEvaluation(
  record: RuntimeSamplingRecord,
  evaluationAgent: AgentConfigRef,
): RuntimeSamplingRecord {
  const { evaluation: _evaluation, ...withoutEvaluation } = record;
  const {
    evaluation: _evaluationState,
    evaluationSubmissionId: _evaluationSubmissionId,
    ...withoutEvaluationState
  } = withoutEvaluation.sampling;
  return {
    ...withoutEvaluation,
    sampling: {
      ...withoutEvaluationState,
      evaluation: { status: "queued" },
      evaluationAgent,
      evaluationAttempts: [],
    },
  };
}

function aggregateRunStatus(
  records: readonly RuntimeSamplingRecord[],
  phase: RuntimePhase,
): SamplingStatus {
  if (records.length === 0) return "failed";
  const statuses = records.map(({ sampling }) => statusForPhase(sampling, phase));
  const resolvedStatuses = statuses.filter(
    (status): status is SamplingStatus => status !== undefined,
  );
  const hasPendingStatus = statuses.some((status) => status === undefined)
    || resolvedStatuses.some((status) => (
      status === "queued"
      || status === "starting"
      || status === "running"
      || status === "retrying"
    ));
  if (hasPendingStatus) {
    if (resolvedStatuses.some((status) => status === "retrying")) {
      return "retrying";
    }
    if (resolvedStatuses.some((status) => status === "starting" || status === "running")) {
      return "running";
    }
    if (phase === "pipeline") {
      const allExecutionQueued = records.every(
        ({ sampling }) => sampling.execution.status === "queued",
      );
      const allExecutionSucceeded = records.every(
        ({ sampling }) => sampling.execution.status === "succeeded",
      );
      return allExecutionQueued || !allExecutionSucceeded ? "queued" : "running";
    }
    return "queued";
  }
  if (resolvedStatuses.some((status) => status === "failed" || status === "cancelled")) {
    return "failed";
  }
  if (resolvedStatuses.every((status) => status === "succeeded")) {
    return "succeeded";
  }
  return "queued";
}

function statusForPhase(
  sampling: Sampling,
  phase: RuntimePhase,
): SamplingStatus | undefined {
  if (phase === "execution") return sampling.execution.status;
  if (phase === "evaluation") return sampling.evaluation?.status;
  if (sampling.execution.status !== "succeeded") return sampling.execution.status;
  return sampling.evaluation?.status;
}

function failureStage(
  record: RuntimeSamplingRecord,
  phase: RuntimePhase,
): AgentLifecycleStage {
  if (phase === "execution") return "execution";
  if (phase === "evaluation") return "evaluation";
  return record.sampling.execution.status === "succeeded"
    ? "evaluation"
    : "execution";
}

function toRunSnapshot(
  run: RuntimeRunRecord,
  records: readonly RuntimeSamplingRecord[],
): RunSnapshot {
  return {
    runId: run.runId,
    samplingIds: [...run.samplingIds],
    projectId: run.projectId,
    phase: run.phase,
    status: aggregateRunStatus(records, run.phase),
  };
}

export type {
  AgentOption,
  EvalRuntime,
  EvalRuntimeDependencies,
  RuntimeCatalog,
  Sample,
} from "./model.js";
export type {
  RuntimePhase,
  RuntimeRunRecord,
  RuntimeSamplingRecord,
  RuntimeStore,
} from "./store.js";
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
