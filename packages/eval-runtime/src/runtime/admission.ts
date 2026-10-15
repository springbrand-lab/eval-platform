import type {
  AgentConfigRef,
  EvaluateRequest,
  EvaluationRecord,
  PipelineRequest,
  RunHandle,
  RunPhases,
  StartRunRequest,
} from "@eval-platform/eval-contracts";
import { canonicalJsonBytes, createId, equalJson, sha256Hex } from "@springbrand/utils";
import type { ConfigResolver, ResolvedExecutionConfig, RunConfigSnapshot } from "../config/model.js";
import { requireSpHarness } from "./agent-lifecycle.js";
import {
  RuntimeAdmissionConflictError,
  RuntimeInputError,
  RuntimeRunIdentityConflictError,
} from "./errors.js";
import { requireEvaluationPrompt } from "./evaluation.js";
import { requireDistinctIds, requireNonEmpty } from "./input.js";
import type { EvalRunAdmission, EvalRunAdmissionDependencies, RuntimeAdmissionCatalog, Sample } from "./model.js";
import { RunRecords } from "./records.js";
import type { RuntimeRunRecord, RuntimeRunRequestIdentity, RuntimeStore, SamplingState } from "./store.js";

type RunOperation = "start" | "evaluate" | "pipeline";
type RunRequest = StartRunRequest | EvaluateRequest | PipelineRequest;

/** The immutable caller intent bound to one idempotency key. */
interface RunRequestFacts {
  readonly operation: RunOperation;
  readonly projectId: string;
  readonly selector: Readonly<Record<string, unknown>>;
}

/** Everything a new Run persists in its admission transaction. */
interface RunPlan {
  readonly config: RunConfigSnapshot;
  readonly phases: RunPhases;
  readonly samplings: readonly SamplingState[];
  readonly evaluations: readonly EvaluationRecord[];
}

const IDENTITY_CONFLICT = "idempotency key is already bound to different Run facts";

export function requireSourceCommit(sourceCommit: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommit)) {
    throw new TypeError("sourceCommit must be a full lowercase Git commit hash");
  }
  return sourceCommit;
}

export class RunAdmission implements EvalRunAdmission {
  readonly #sourceCommit: string;
  readonly #catalog: RuntimeAdmissionCatalog;
  readonly #configResolver: ConfigResolver;
  readonly #store: RuntimeStore;
  readonly #idFactory: () => string;
  readonly #records: RunRecords;
  readonly #pending = new Map<string, { readonly facts: RunRequestFacts; readonly promise: Promise<RunHandle> }>();

  constructor(dependencies: EvalRunAdmissionDependencies) {
    this.#sourceCommit = requireSourceCommit(dependencies.sourceCommit);
    this.#catalog = dependencies.catalog;
    this.#configResolver = dependencies.configResolver;
    this.#store = dependencies.store;
    this.#idFactory = dependencies.idFactory ?? createId;
    this.#records = new RunRecords(dependencies.store, dependencies.catalog.getSamples.bind(dependencies.catalog));
  }

  async start(request: StartRunRequest): Promise<RunHandle> {
    const admitted = { ...request };
    requireRunRequest(admitted);
    requireNonEmpty(admitted.executionConfigId, "executionConfigId");
    return this.#admit(admitted, {
      operation: "start",
      projectId: admitted.projectId,
      selector: { executionConfigId: admitted.executionConfigId },
    }, () => this.#planExecution(admitted));
  }

  async evaluate(request: EvaluateRequest): Promise<RunHandle> {
    const admitted = { ...request, samplingIds: [...request.samplingIds] };
    requireRunRequest(admitted);
    if (admitted.samplingIds.length === 0) throw new RuntimeInputError("samplingIds must not be empty", "samplingIds");
    requireDistinctIds(admitted.samplingIds, "samplingIds");
    requireNonEmpty(admitted.evaluationConfigId, "evaluationConfigId");
    return this.#admit(admitted, {
      operation: "evaluate",
      projectId: admitted.projectId,
      selector: { evaluationConfigId: admitted.evaluationConfigId, samplingIds: admitted.samplingIds },
    }, () => this.#planEvaluation(admitted));
  }

  async pipeline(request: PipelineRequest): Promise<RunHandle> {
    const admitted = { ...request };
    requireRunRequest(admitted);
    requireNonEmpty(admitted.pipelineConfigId, "pipelineConfigId");
    return this.#admit(admitted, {
      operation: "pipeline",
      projectId: admitted.projectId,
      selector: { pipelineConfigId: admitted.pipelineConfigId },
    }, () => this.#planPipeline(admitted));
  }

  /** Coalesce concurrent same-key requests, then replay an existing Run or persist a new plan. */
  #admit(request: RunRequest, facts: RunRequestFacts, plan: () => Promise<RunPlan>): Promise<RunHandle> {
    const key = JSON.stringify([request.projectId, request.idempotencyKey]);
    const pending = this.#pending.get(key);
    if (pending) {
      if (!equalJson(pending.facts, facts)) throw new RuntimeRunIdentityConflictError(IDENTITY_CONFLICT);
      return pending.promise.then(copyHandle);
    }
    const promise = Promise.resolve().then(() => this.#persist(request.idempotencyKey, facts, plan));
    this.#pending.set(key, { facts, promise });
    const clear = () => {
      if (this.#pending.get(key)?.promise === promise) this.#pending.delete(key);
    };
    void promise.then(clear, clear);
    return promise;
  }

  async #persist(idempotencyKey: string, facts: RunRequestFacts, plan: () => Promise<RunPlan>): Promise<RunHandle> {
    const existing = await this.#store.findRunByIdempotencyKey(facts.projectId, idempotencyKey);
    if (existing) {
      const identity = await requestIdentity(idempotencyKey, facts, existing.config);
      if (existing.requestIdentity.requestFingerprint !== identity.requestFingerprint) {
        throw new RuntimeRunIdentityConflictError(IDENTITY_CONFLICT);
      }
      return copyHandle(existing);
    }

    const { config, phases, samplings, evaluations } = await plan();
    const run: RuntimeRunRecord = {
      runId: this.#idFactory(),
      samplingIds: samplings.map(({ samplingId }) => samplingId),
      projectId: facts.projectId,
      sourceCommit: this.#sourceCommit,
      phases,
      evaluationIds: evaluations.map(({ evaluationId }) => evaluationId),
      config,
      requestIdentity: await requestIdentity(idempotencyKey, facts, config),
    };
    const admission = await this.#store.createRunWithSamplings(run, samplings, evaluations);
    return copyHandle(admission.run);
  }

  async #planExecution(request: StartRunRequest): Promise<RunPlan> {
    const execution = await this.#configResolver.resolveExecutionConfig(request.executionConfigId);
    const subject = requireSpHarness(execution.harness, "subject").agentConfig;
    const samples = await this.#resolveSamples(execution);
    return {
      config: { operation: "execution", execution },
      phases: ["execution"],
      samplings: this.#createSamplings(request.projectId, samples, execution.samplingCount, subject),
      evaluations: [],
    };
  }

  async #planEvaluation(request: EvaluateRequest): Promise<RunPlan> {
    const evaluation = await this.#configResolver.resolveEvaluationConfig(request.evaluationConfigId);
    const evaluator = requireSpHarness(evaluation.evaluationHarness, "evaluator").agentConfig;
    const samplings = await this.#successfulSamplings(request);
    const sampleFor = await this.#records.samples(samplings, request.projectId);
    for (const sampling of samplings) requireEvaluationPrompt(sampleFor(sampling));
    return {
      config: { operation: "evaluation", evaluation },
      phases: ["evaluation"],
      samplings,
      evaluations: samplings.map(({ samplingId }) => this.#createEvaluation(samplingId, evaluator)),
    };
  }

  async #planPipeline(request: PipelineRequest): Promise<RunPlan> {
    const { pipeline, execution, evaluation } = await this.#configResolver.resolvePipelineConfig(request.pipelineConfigId);
    const subject = requireSpHarness(execution.harness, "subject").agentConfig;
    const evaluator = requireSpHarness(evaluation.evaluationHarness, "evaluator").agentConfig;
    const samples = await this.#resolveSamples(execution);
    for (const sample of samples) requireEvaluationPrompt(sample);
    const samplings = this.#createSamplings(request.projectId, samples, execution.samplingCount, subject);
    return {
      config: { operation: "pipeline", pipeline, execution, evaluation },
      phases: ["execution", "evaluation"],
      samplings,
      evaluations: samplings.map(({ samplingId }) => this.#createEvaluation(samplingId, evaluator)),
    };
  }

  async #successfulSamplings(request: EvaluateRequest): Promise<readonly SamplingState[]> {
    const records = await this.#store.getSamplings(request.samplingIds);
    if (records.length !== request.samplingIds.length) throw new Error("Store returned an incomplete Sampling batch");
    return request.samplingIds.map((samplingId, index) => {
      const record = records[index];
      if (record && record.samplingId !== samplingId) {
        throw new Error(`Store returned Sampling ${record.samplingId} for ${samplingId}`);
      }
      if (!record || record.projectId !== request.projectId || record.execution.status !== "succeeded") {
        throw new RuntimeAdmissionConflictError(
          "sampling-unavailable",
          `Sampling ${samplingId} has no successful execution in Project ${request.projectId}`,
        );
      }
      return record;
    });
  }

  async #resolveSamples({ datasetId, sampleIds }: ResolvedExecutionConfig): Promise<readonly Sample[]> {
    const samples: Sample[] = [];
    for (const item of await this.#catalog.listData(datasetId)) {
      samples.push(...await this.#catalog.listSamples(item.dataId));
    }
    if (sampleIds === undefined) {
      if (samples.length === 0) throw new RuntimeInputError(`No samples found for dataset ${datasetId}`, "datasetId");
      return samples;
    }
    const available = new Set(samples.map(({ sampleId }) => sampleId));
    const missing = sampleIds.find((sampleId) => !available.has(sampleId));
    if (missing !== undefined) {
      throw new RuntimeInputError(`Sample ${missing} does not belong to dataset ${datasetId}`, "sampleIds");
    }
    return samples.filter(({ sampleId }) => sampleIds.includes(sampleId));
  }

  #createSamplings(
    projectId: string,
    samples: readonly Sample[],
    samplingCount: number,
    subjectAgent: AgentConfigRef,
  ): readonly SamplingState[] {
    return samples.flatMap((sample) => Array.from({ length: samplingCount }, () => ({
      samplingId: this.#idFactory(),
      projectId,
      sampleId: sample.sampleId,
      execution: { status: "queued" as const },
      subjectAgent,
      executionAttempts: [],
    })));
  }

  #createEvaluation(samplingId: string, evaluator: AgentConfigRef): EvaluationRecord {
    return {
      evaluationId: this.#idFactory(),
      samplingId,
      evaluator,
      status: { status: "queued" },
      attempts: [],
    };
  }
}

function requireRunRequest(request: RunRequest): void {
  const key: unknown = request.idempotencyKey;
  if (typeof key !== "string" || key.length === 0 || key.trim() !== key) {
    throw new RuntimeInputError(
      "idempotencyKey must be a non-empty key without surrounding whitespace",
      "idempotencyKey",
    );
  }
  requireNonEmpty(request.projectId, "projectId");
}

async function requestIdentity(
  idempotencyKey: string,
  facts: RunRequestFacts,
  config: RunConfigSnapshot,
): Promise<RuntimeRunRequestIdentity> {
  return { idempotencyKey, requestFingerprint: await sha256Hex(canonicalJsonBytes({ ...facts, config })) };
}

function copyHandle(run: RunHandle): RunHandle {
  return { runId: run.runId, samplingIds: [...run.samplingIds] };
}
