import { describe, expect, it, vi } from "vitest";
import type { AgentFramework, AgentResourceSnapshot, EvaluationRecord } from "@eval-platform/eval-contracts";
import { createConfigResolver } from "../config/index.js";
import type {
  ConfigResolver,
  ConfigStore,
  EvaluationConfig,
  ExecutionConfig,
  PipelineConfig,
} from "../config/index.js";
import type {
  AgentHandle,
  AgentSubmission,
  CollectAgentResourcesInput,
  Harness,
} from "../harness/index.js";
import type { RuntimeCatalog, Sample } from "./model.js";
import type {
  RuntimeRunAdmission,
  RuntimeRunRecord,
  SamplingState,
  RuntimeStore,
} from "./store.js";
import { RuntimeRunIdentityConflictError } from "./store.js";
import type { RetryController, RetryOperation } from "./retry.js";
import {
  createEvalRuntime as createRuntime,
  type EvalRuntimeDependencies,
} from "./index.js";

const SUBJECT = { ownerUserId: "user-1", userAgentId: "subject-agent" };
const EVALUATOR = { ownerUserId: "user-1", userAgentId: "evaluator-agent" };
const EXECUTION_CONFIG_ID = "execution-config-1";
const EXECUTION_CONFIG_TWO_SAMPLES_ID = "execution-config-two-samples";
const EXECUTION_CONFIG_TWO_CONCURRENT_ID = "execution-config-two-concurrent";
const EXECUTION_CONFIG_THREE_CONCURRENT_ID = "execution-config-three-concurrent";
const EXECUTION_CONFIG_RETRY_ONE_ID = "execution-config-retry-one";
const EXECUTION_CONFIG_RETRY_TWO_ID = "execution-config-retry-two";
const EXECUTION_CONFIG_RUNTIME_ID = "execution-config-runtime";
const EVALUATION_CONFIG_ID = "evaluation-config-1";
const EVALUATION_CONFIG_TWO_CONCURRENT_ID = "evaluation-config-two-concurrent";
const EVALUATION_CONFIG_RETRY_ONE_ID = "evaluation-config-retry-one";
const EVALUATION_CONFIG_RUNTIME_ID = "evaluation-config-runtime";
const PIPELINE_CONFIG_ID = "pipeline-config-1";
const PIPELINE_CONFIG_CONCURRENT_ID = "pipeline-config-concurrent";

const NO_RETRY = { maxRestarts: 0, initialBackoffMs: 0, maxBackoffMs: 0 } as const;
const EXECUTION_RUNTIME = { workspaceMode: "shared-readonly", timeoutMs: 1_234 } as const;
const EVALUATION_RUNTIME = { workspaceMode: "isolated", timeoutMs: 5_678 } as const;

function makeExecutionConfig(
  configId: string,
  overrides: Partial<ExecutionConfig> = {},
): ExecutionConfig {
  return {
    configId,
    datasetId: "dataset-1",
    samplingCount: 1,
    executionConcurrency: 1,
    harness: { kind: "sp", framework: "sp", agentConfig: SUBJECT },
    retryPolicy: NO_RETRY,
    ...overrides,
  };
}

function makeEvaluationConfig(
  configId: string,
  overrides: Partial<EvaluationConfig> = {},
): EvaluationConfig {
  return {
    configId,
    evaluationHarness: { kind: "sp", framework: "sp", agentConfig: EVALUATOR },
    evaluationConcurrency: 1,
    retryPolicy: NO_RETRY,
    ...overrides,
  };
}

function makeConfigResolver(framework: AgentFramework = "sp"): ConfigResolver {
  const executionConfigs = new Map<string, ExecutionConfig>([
    [EXECUTION_CONFIG_ID, makeExecutionConfig(EXECUTION_CONFIG_ID, {
      harness: { kind: "sp", framework, agentConfig: SUBJECT },
    })],
    [
      EXECUTION_CONFIG_TWO_SAMPLES_ID,
      makeExecutionConfig(EXECUTION_CONFIG_TWO_SAMPLES_ID, { samplingCount: 2 }),
    ],
    [
      EXECUTION_CONFIG_TWO_CONCURRENT_ID,
      makeExecutionConfig(EXECUTION_CONFIG_TWO_CONCURRENT_ID, { samplingCount: 2, executionConcurrency: 2 }),
    ],
    [
      EXECUTION_CONFIG_THREE_CONCURRENT_ID,
      makeExecutionConfig(EXECUTION_CONFIG_THREE_CONCURRENT_ID, { executionConcurrency: 3 }),
    ],
    [
      EXECUTION_CONFIG_RETRY_ONE_ID,
      makeExecutionConfig(EXECUTION_CONFIG_RETRY_ONE_ID, {
        retryPolicy: { maxRestarts: 1, initialBackoffMs: 0, maxBackoffMs: 0 },
      }),
    ],
    [
      EXECUTION_CONFIG_RETRY_TWO_ID,
      makeExecutionConfig(EXECUTION_CONFIG_RETRY_TWO_ID, {
        retryPolicy: { maxRestarts: 2, initialBackoffMs: 0, maxBackoffMs: 0 },
      }),
    ],
    [
      EXECUTION_CONFIG_RUNTIME_ID,
      makeExecutionConfig(EXECUTION_CONFIG_RUNTIME_ID, {
        harness: { kind: "sp", framework: "sp", agentConfig: SUBJECT, runtime: EXECUTION_RUNTIME },
      }),
    ],
  ]);
  const evaluationConfigs = new Map<string, EvaluationConfig>([
    [EVALUATION_CONFIG_ID, makeEvaluationConfig(EVALUATION_CONFIG_ID)],
    [
      EVALUATION_CONFIG_TWO_CONCURRENT_ID,
      makeEvaluationConfig(EVALUATION_CONFIG_TWO_CONCURRENT_ID, { evaluationConcurrency: 2 }),
    ],
    [
      EVALUATION_CONFIG_RETRY_ONE_ID,
      makeEvaluationConfig(EVALUATION_CONFIG_RETRY_ONE_ID, {
        retryPolicy: { maxRestarts: 1, initialBackoffMs: 0, maxBackoffMs: 0 },
      }),
    ],
    [
      EVALUATION_CONFIG_RUNTIME_ID,
      makeEvaluationConfig(EVALUATION_CONFIG_RUNTIME_ID, {
        evaluationHarness: { kind: "sp", framework: "sp", agentConfig: EVALUATOR, runtime: EVALUATION_RUNTIME },
      }),
    ],
  ]);
  const pipelineConfigs = new Map<string, PipelineConfig>([
    [
      PIPELINE_CONFIG_ID,
      {
        configId: PIPELINE_CONFIG_ID,
        executionConfigId: EXECUTION_CONFIG_ID,
        evaluationConfigId: EVALUATION_CONFIG_ID,
      },
    ],
    [
      PIPELINE_CONFIG_CONCURRENT_ID,
      {
        configId: PIPELINE_CONFIG_CONCURRENT_ID,
        executionConfigId: EXECUTION_CONFIG_THREE_CONCURRENT_ID,
        evaluationConfigId: EVALUATION_CONFIG_TWO_CONCURRENT_ID,
      },
    ],
  ]);
  const store: ConfigStore = {
    async getExecutionConfig(configId) {
      return executionConfigs.get(configId) ?? null;
    },
    async getEvaluationConfig(configId) {
      return evaluationConfigs.get(configId) ?? null;
    },
    async getPipelineConfig(configId) {
      return pipelineConfigs.get(configId) ?? null;
    },
  };
  return createConfigResolver(store);
}

type RuntimeTestDependencies = Omit<EvalRuntimeDependencies, "configResolver"> & {
  readonly configResolver?: ConfigResolver;
};

function createEvalRuntime(dependencies: RuntimeTestDependencies) {
  return createRuntime({
    ...dependencies,
    configResolver: dependencies.configResolver ?? makeConfigResolver(),
  });
}

function startRequest(
  requestId: string,
  executionConfigId: string = EXECUTION_CONFIG_ID,
  idempotencyKey?: string,
) {
  return {
    requestId,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    projectId: "project-1",
    executionConfigId,
  };
}

function evaluateRequest(
  samplingIds: readonly string[],
  evaluationConfigId: string = EVALUATION_CONFIG_ID,
) {
  return {
    projectId: "project-1",
    samplingIds,
    evaluationConfigId,
  };
}

function pipelineRequest(
  requestId: string,
  pipelineConfigId: string = PIPELINE_CONFIG_ID,
  idempotencyKey?: string,
) {
  return {
    requestId,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    projectId: "project-1",
    pipelineConfigId,
  };
}

function makeSample(sampleId: string): Sample {
  return {
    sampleId,
    data: {
      dataId: "data-1",
      userPrompt: `Execute ${sampleId}`,
      json: { task: sampleId },
      initialSession: { bundleId: "sessions-bundle", sessionId: "session-seed" },
      initialMaterials: { bundleId: "materials-bundle", materialId: "materials-1" },
      metadata: { source: "test" },
    },
  };
}

function makeCatalog(samples: readonly Sample[] = [makeSample("sample-1")]): RuntimeCatalog {
  return {
    listProjects: async () => [],
    listAgents: async () => [],
    listDatasets: async () => [],
    listData: async () => [{ dataId: "data-1", userPrompt: "Execute data", json: { task: "data" } }],
    listSamples: async () => samples,
    getSample: async (sampleId) => samples.find((sample) => sample.sampleId === sampleId) ?? null,
  };
}

interface StoreOptions {
  readonly beforeRunCommit?: (run: RuntimeRunRecord) => void;
}

function makeStore(options: StoreOptions = {}): RuntimeStore {
  const runs = new Map<string, RuntimeRunRecord>();
  const samplings = new Map<string, SamplingState>();
  const evaluations = new Map<string, EvaluationRecord>();
  return {
    async getRun(runId) {
      return runs.get(runId) ?? null;
    },
    async findRunByRequestId(requestId) {
      return [...runs.values()].find(
        (run) => run.requestIdentity?.requestId === requestId,
      ) ?? null;
    },
    async findRunByIdempotencyKey(idempotencyKey) {
      return [...runs.values()].find(
        (run) => run.requestIdentity?.idempotencyKey === idempotencyKey,
      ) ?? null;
    },
    async createRunWithSamplings(run, records, evaluationRecords) {
      const byRequestId = run.requestIdentity?.requestId === undefined
        ? null
        : [...runs.values()].find(
            (existingRun) => existingRun.requestIdentity?.requestId === run.requestIdentity?.requestId,
          ) ?? null;
      const byIdempotencyKey = run.requestIdentity?.idempotencyKey === undefined
        ? null
        : [...runs.values()].find(
            (existingRun) => existingRun.requestIdentity?.idempotencyKey === run.requestIdentity?.idempotencyKey,
          ) ?? null;
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
      if (existingRun) {
        if (
          existingRun.requestIdentity?.requestFingerprint
          !== run.requestIdentity?.requestFingerprint
        ) {
          throw new RuntimeRunIdentityConflictError(
            "request identity is already bound to different evaluation run facts",
          );
        }
        return { run: existingRun, created: false } satisfies RuntimeRunAdmission;
      }

      const nextRuns = new Map(runs);
      const nextSamplings = new Map(samplings);
      const nextEvaluations = new Map(evaluations);
      nextRuns.set(run.runId, run);
      for (const record of records) {
        nextSamplings.set(record.samplingId, record);
      }
      for (const evaluation of evaluationRecords) {
        nextEvaluations.set(evaluation.evaluationId, evaluation);
      }
      options.beforeRunCommit?.(run);
      runs.clear();
      samplings.clear();
      evaluations.clear();
      for (const [runId, record] of nextRuns) runs.set(runId, record);
      for (const [samplingId, record] of nextSamplings) samplings.set(samplingId, record);
      for (const [evaluationId, record] of nextEvaluations) {
        evaluations.set(evaluationId, record);
      }
      return { run, created: true } satisfies RuntimeRunAdmission;
    },
    async updateEvaluation(record) {
      evaluations.set(record.evaluationId, record);
    },
    async getEvaluation(evaluationId) {
      return evaluations.get(evaluationId) ?? null;
    },
    async listEvaluations(samplingId) {
      return [...evaluations.values()].filter((evaluation) => evaluation.samplingId === samplingId);
    },
    async updateSampling(state) {
      samplings.set(state.samplingId, state);
    },
    async getSampling(samplingId) {
      return samplings.get(samplingId) ?? null;
    },
  };
}

function makeSubmission(status: AgentSubmission["status"] = "completed"): AgentSubmission {
  return {
    status,
    accepted: true,
    normalizedStatus: status === "completed" ? "completed" : "failed",
    retryable: false,
  };
}

function makeHarness(): Harness {
  return {
    ensureAgent: vi.fn(async ({ role, framework, samplingId, submissionId }): Promise<AgentHandle> => ({
      role,
      framework,
      samplingId,
      submissionId,
    })),
    materializeInitialData: vi.fn(async () => ({
      bundleId: "bundle-1",
      manifestHash: "manifest-1",
      target: "workspace" as const,
      rootPath: "/eval/input",
    })),
    submitAgent: vi.fn(async () => makeSubmission()),
    restartAgent: vi.fn(async () => makeSubmission()),
    waitForSubmission: vi.fn(async () => makeSubmission()),
    inspectAgentOperation: vi.fn(async () => makeSubmission()),
    collectExecution: vi.fn(async ({ handle }) => ({
      samplingId: handle.samplingId,
      status: "succeeded" as const,
      artifacts: [{ artifactId: "artifact-1", kind: "project", path: "/eval/output" }],
      trajectory: { trajectoryId: "trajectory-1", source: "subject" as const, path: "/eval/trajectory.jsonl" },
    })),
    collectEvaluation: vi.fn(async () => ({
      status: "succeeded" as const,
      artifacts: [{ artifactId: "evaluation-artifact-1", kind: "evaluation", path: "/eval/result" }],
      score: 0.9,
      trajectory: { trajectoryId: "trajectory-2", source: "evaluator" as const, path: "/eval/evaluation.jsonl" },
    })),
    collectAgentResources: vi.fn(async ({ handle, idempotencyKey }) => ({
      scope: { submissionId: handle.submissionId, idempotencyKey },
      observedAt: "2026-10-08T00:00:00.000Z",
      finalized: true,
      coverage: {
        usageEvents: "complete" as const,
        telemetryEvents: "complete" as const,
        billingSettlements: "complete" as const,
      },
      usageEvents: [],
      telemetryEvents: [],
      billingSettlements: [],
    })),
    materializeEvaluationInput: vi.fn(async () => undefined),
  };
}

function makeResources(input: CollectAgentResourcesInput): AgentResourceSnapshot {
  const { handle, idempotencyKey } = input;
  const eventId = `${handle.submissionId}:${idempotencyKey}:usage`;
  const usage = {
    eventId,
    runId: idempotencyKey,
    kind: "assistant_model",
    outcome: "billable",
    metrics: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 30, reasoningTokens: 2 },
    providerMetadata: { provider: "source-provider", model: `${handle.role}-model` },
    providerCostUsd: { input: 0.1, output: 0.02, cacheRead: 0.01, cacheWrite: 0, total: 0.13 },
    sourceExtension: { retained: [true, null, "original"] },
  };
  const event = (type: string, operationId: string, occurredAt: number, payload: Record<string, string | number>) => ({
    eventId: `${handle.submissionId}:${idempotencyKey}:${type}`,
    operationId,
    type,
    occurredAt,
    resource: { sessionId: handle.submissionId },
    payload,
  });
  return {
    scope: { submissionId: handle.submissionId, idempotencyKey },
    observedAt: "2026-10-08T00:00:00.000Z",
    finalized: true,
    coverage: { usageEvents: "complete", telemetryEvents: "complete", billingSettlements: "complete" },
    usageEvents: [usage],
    telemetryEvents: [
      event("turn.started", `${idempotencyKey}:turn`, 100, {}),
      event("generation.finished", `${idempotencyKey}:model`, 200, { model: `${handle.role}-model`, totalTokens: 110 }),
      event("tool.started", `${idempotencyKey}:tool`, 200, { toolName: "bash" }),
      event("tool.finished", `${idempotencyKey}:tool`, 250, { toolName: "bash", durationMs: 50 }),
      event("turn.finished", `${idempotencyKey}:turn`, 300, { outcome: "completed", durationMs: 200 }),
    ],
    billingSettlements: [{
      eventId,
      usage,
      accountId: "user-1",
      status: "settled",
      ratedUnits: 30,
      debitedUnits: 20,
      shortfallUnits: 10,
      platformOwned: { units: 10, reason: "insufficient_balance" },
      settledAtMs: 300,
    }, {
      execution_id: `${eventId}:action`,
      charged_credits: 5,
      service_id: "paid-tool",
      status: "succeeded",
    }],
  };
}

function makeRetryControllerFactory(
  retryCounts: Partial<Record<RetryOperation, number>>,
): () => RetryController {
  return () => {
    const remaining = new Map<RetryOperation, number>(
      Object.entries(retryCounts) as [RetryOperation, number][],
    );
    return {
      async decide({ operation, failureKind }) {
        const count = remaining.get(operation) ?? 0;
        if (count === 0) return { shouldRetry: false, reason: failureKind };
        remaining.set(operation, count - 1);
        return { shouldRetry: true, reason: failureKind, backoffMs: 0 };
      },
    };
  };
}

async function waitForTerminal(runtime: ReturnType<typeof createEvalRuntime>, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await runtime.getRun(runId);
    if (snapshot.status === "succeeded" || snapshot.status === "failed") return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("runtime did not reach a terminal state");
}

describe("eval runtime orchestration", () => {
  it("runs independent samplings and collects initial data, artifacts and trajectory", async () => {
    const harness = makeHarness();
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const run = await runtime.start(
      startRequest("test-request", EXECUTION_CONFIG_TWO_SAMPLES_ID),
    );
    const snapshot = await waitForTerminal(runtime, run.runId);

    expect(snapshot.status).toBe("succeeded");
    expect(run.samplingIds).toHaveLength(2);
    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
    expect(harness.materializeInitialData).toHaveBeenCalledTimes(2);
    expect(harness.collectExecution).toHaveBeenCalledTimes(2);
    const preparationInputs = vi.mocked(harness.materializeInitialData).mock.calls.map(([input]) => input);
    expect(new Set(preparationInputs.map((input) => input.handle.submissionId)).size).toBe(2);
    expect(new Set(preparationInputs.map((input) => input.idempotencyKey)).size).toBe(2);
    for (const input of preparationInputs) {
      expect(input.idempotencyKey).toBe(`initial-data:${input.handle.submissionId}`);
      expect(input.data.initialSession).toEqual({ bundleId: "sessions-bundle", sessionId: "session-seed" });
      expect(input.data.initialMaterials).toEqual({ bundleId: "materials-bundle", materialId: "materials-1" });
      expect(input.data).not.toHaveProperty("sampleId");
      expect(input.data).not.toHaveProperty("dataId");
    }
  });

  describe.each(["pipeline", "independent"] as const)("%s business-field preservation", (operation) => {
    it.each(["source-sample-42", 42, { source: "external", id: 42 }, ["first", "second"]])(
      "keeps platform Sample identity separate from business sampleId %j for both Agents",
      async (businessSampleId) => {
        const sample: Sample = {
          sampleId: "sample-1",
          data: {
            ...makeSample("sample-1").data,
            sampleId: businessSampleId,
            data: { sampleId: "nested-business-id" },
            expectedOutput: { passed: true },
          },
        };
        const harness = makeHarness();
        const store = makeStore();
        const runtime = createEvalRuntime({ catalog: makeCatalog([sample]), harness, store });
        const execution = operation === "pipeline"
          ? await runtime.pipeline(pipelineRequest("business-sample-id-pipeline"))
          : await runtime.start(startRequest("business-sample-id-execution"));
        await expect(waitForTerminal(runtime, execution.runId)).resolves.toMatchObject({ status: "succeeded" });
        if (operation === "independent") {
          const evaluation = await runtime.evaluate(evaluateRequest(execution.samplingIds));
          await expect(waitForTerminal(runtime, evaluation.runId)).resolves.toMatchObject({ status: "succeeded" });
        }

        const preparations = vi.mocked(harness.materializeInitialData).mock.calls.map(([input]) => input);
        expect(preparations).toHaveLength(2);
        const subject = preparations.find((input) => input.handle.role === "subject")!;
        const evaluator = preparations.find((input) => input.handle.role === "evaluator")!;
        const { dataId: _dataId, ...expectedSubject } = sample.data;
        const { initialSession: _initialSession, ...expectedEvaluator } = expectedSubject;
        expect(subject.data).toEqual(expectedSubject);
        expect(evaluator.data).toEqual(expectedEvaluator);
        expect(subject.data.sampleId).toEqual(businessSampleId);
        expect(evaluator.data.sampleId).toEqual(businessSampleId);
        expect(subject.data).not.toHaveProperty("dataId");
        expect(evaluator.data).not.toHaveProperty("dataId");
        await expect(runtime.listSamples(sample.data.dataId)).resolves.toEqual([sample]);
        await expect(runtime.getSampling(execution.samplingIds[0]!)).resolves.toMatchObject({ sampleId: "sample-1" });
        const state = await store.getSampling(execution.samplingIds[0]!);
        expect(state?.sampleId).toBe(sample.sampleId);
        expect(state).not.toHaveProperty("data");
        expect(state).not.toHaveProperty("sample");
      },
    );
  });

  it("rejects the former flattened Sample shape rather than silently stripping business identity", async () => {
    const sample = { sampleId: "sample-1", ...makeSample("sample-1").data } as unknown as Sample;
    const harness = makeHarness();
    const runtime = createEvalRuntime({ catalog: makeCatalog([sample]), harness, store: makeStore() });
    const run = await runtime.start(startRequest("flattened-sample"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });
    expect(harness.ensureAgent).not.toHaveBeenCalled();
    expect(harness.materializeInitialData).not.toHaveBeenCalled();
    expect(harness.submitAgent).not.toHaveBeenCalled();
  });

  it("rejects unsafe integer business fields before creating an execution Agent", async () => {
    const sample: Sample = {
      sampleId: "sample-1",
      data: { ...makeSample("sample-1").data, externalDataId: Number.MAX_SAFE_INTEGER + 1 },
    };
    const harness = makeHarness();
    const runtime = createEvalRuntime({ catalog: makeCatalog([sample]), harness, store: makeStore() });
    const run = await runtime.start(startRequest("unsafe-sample-number"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });
    expect(harness.ensureAgent).not.toHaveBeenCalled();
    expect(harness.materializeInitialData).not.toHaveBeenCalled();
    expect(harness.submitAgent).not.toHaveBeenCalled();
  });

  it("submits the required prompt unchanged and materializes every extra field without optional resources", async () => {
    const sample: Sample = {
      sampleId: "sample-1",
      data: {
        dataId: "data-1",
        userPrompt: "  Build the homepage\nKeep the current style.  ",
        requirements: ["responsive", "accessible"],
        expectedOutput: { pages: 3 },
        referenceText: "design notes",
        customFlag: false,
      },
    };
    const harness = makeHarness();
    const runtime = createEvalRuntime({ catalog: makeCatalog([sample]), harness, store: makeStore() });
    const run = await runtime.start(startRequest("standalone-prompt"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });
    const preparation = vi.mocked(harness.materializeInitialData).mock.calls[0]![0];
    expect(preparation.data).toEqual({
      userPrompt: sample.data.userPrompt,
      requirements: sample.data.requirements,
      expectedOutput: sample.data.expectedOutput,
      referenceText: sample.data.referenceText,
      customFlag: sample.data.customFlag,
    });
    expect(preparation.data).not.toHaveProperty("initialSession");
    expect(preparation.data).not.toHaveProperty("initialMaterials");
    expect(harness.submitAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      prompt: sample.data.userPrompt,
    }));
  });

  it("waits for Session restoration and material preparation before submitting a new task", async () => {
    const harness = makeHarness();
    let preparationStarted!: () => void;
    const started = new Promise<void>((resolve) => { preparationStarted = resolve; });
    let finishPreparation!: () => void;
    const pending = new Promise<void>((resolve) => { finishPreparation = resolve; });
    vi.mocked(harness.materializeInitialData).mockImplementation(async () => {
      preparationStarted();
      await pending;
      return { bundleId: "prepared-input", manifestHash: "hash", target: "workspace", rootPath: "/eval/input" };
    });
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store: makeStore() });
    const run = await runtime.start(startRequest("wait-for-session"));
    await started;
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.collectExecution).not.toHaveBeenCalled();
    finishPreparation();
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });
    expect(harness.submitAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: "Execute sample-1" }));
  });

  it.each([undefined, "", " \n\t", 123, ["task"]])(
    "rejects invalid current prompt %j before creating an Agent",
    async (userPrompt) => {
      const sample = { sampleId: "sample-1", data: { ...makeSample("sample-1").data, userPrompt } } as unknown as Sample;
      const harness = makeHarness();
      const runtime = createEvalRuntime({ catalog: makeCatalog([sample]), harness, store: makeStore() });
      const run = await runtime.start(startRequest("invalid-prompt"));
      await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });
      expect(harness.ensureAgent).not.toHaveBeenCalled();
      expect(harness.materializeInitialData).not.toHaveBeenCalled();
      expect(harness.submitAgent).not.toHaveBeenCalled();
    },
  );

  it.each(["initialSession", "initialMaterials"] as const)(
    "rejects an incomplete %s reference without generating a replacement",
    async (field) => {
      const sample = {
        sampleId: "sample-1",
        data: { ...makeSample("sample-1").data, [field]: { bundleId: "bundle-only" } },
      } as unknown as Sample;
      const harness = makeHarness();
      const runtime = createEvalRuntime({ catalog: makeCatalog([sample]), harness, store: makeStore() });
      const run = await runtime.start(startRequest("incomplete-reference"));
      await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });
      expect(harness.ensureAgent).not.toHaveBeenCalled();
      expect(harness.materializeInitialData).not.toHaveBeenCalled();
      expect(harness.submitAgent).not.toHaveBeenCalled();
    },
  );

  it("does not fall back to a fresh Session when SP initialization fails", async () => {
    const harness = makeHarness();
    vi.mocked(harness.materializeInitialData).mockRejectedValueOnce(new Error("initial Session is unavailable"));
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store: makeStore() });
    const run = await runtime.start(startRequest("missing-session"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.waitForSubmission).not.toHaveBeenCalled();
    expect(harness.collectExecution).not.toHaveBeenCalled();
  });

  it.each(["sp", "codex", "cc"] as const)(
    "retries %s initialization with the same Agent, inputs and key when its response is lost",
    async (framework) => {
      const harness = makeHarness();
      const committedKeys = new Set<string>();
      vi.mocked(harness.materializeInitialData).mockImplementation(async ({ idempotencyKey }) => {
        if (!committedKeys.has(idempotencyKey)) {
          committedKeys.add(idempotencyKey);
          throw new Error("connection lost after initialization committed");
        }
        return { bundleId: "bundle-1", manifestHash: "manifest-1", target: "workspace", rootPath: "/eval/input" };
      });
      const decide = vi.fn<RetryController["decide"]>()
        .mockResolvedValueOnce({ shouldRetry: true, backoffMs: 25 })
        .mockResolvedValue({ shouldRetry: false });
      const sleep = vi.fn(async () => {
        expect(harness.submitAgent).not.toHaveBeenCalled();
        expect(harness.restartAgent).not.toHaveBeenCalled();
      });
      const runtime = createEvalRuntime({
        catalog: makeCatalog(),
        configResolver: makeConfigResolver(framework),
        harness,
        store: makeStore(),
        sleep,
        createRetryController: () => ({ decide }),
      });

      const run = await runtime.start(startRequest(`initialization-response-lost-${framework}`));
      await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

      expect(committedKeys.size).toBe(1);
      expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
      expect(harness.materializeInitialData).toHaveBeenCalledTimes(2);
      const [first, second] = vi.mocked(harness.materializeInitialData).mock.calls;
      expect(second![0]).toEqual(first![0]);
      expect(first![0]).toMatchObject({
        handle: { framework },
        idempotencyKey: `initial-data:${first![0].handle.submissionId}`,
        data: {
          userPrompt: "Execute sample-1",
          initialSession: { bundleId: "sessions-bundle", sessionId: "session-seed" },
          initialMaterials: { bundleId: "materials-bundle", materialId: "materials-1" },
        },
      });
      expect(decide).toHaveBeenCalledExactlyOnceWith({
        operation: "initialization",
        failureKind: "network",
        attemptNumber: 1,
      });
      expect(sleep).toHaveBeenCalledExactlyOnceWith(25);
      expect(harness.submitAgent).toHaveBeenCalledTimes(1);
      expect(harness.restartAgent).not.toHaveBeenCalled();
      expect(harness.inspectAgentOperation).not.toHaveBeenCalled();
      const sampling = await runtime.getSampling(run.samplingIds[0]!);
      expect(sampling.subjectSubmissionId).toBe(first![0].handle.submissionId);
      expect(sampling.executionAttempts).toHaveLength(1);
    },
  );

  it("fails without submission or Agent restart when initialization retries are exhausted", async () => {
    const harness = makeHarness();
    vi.mocked(harness.materializeInitialData).mockRejectedValue(new Error("initialization connection failed"));
    const decide = vi.fn<RetryController["decide"]>()
      .mockResolvedValueOnce({ shouldRetry: true, backoffMs: 5 })
      .mockResolvedValueOnce({ shouldRetry: true, backoffMs: 10 })
      .mockResolvedValue({ shouldRetry: false });
    const sleep = vi.fn(async () => undefined);
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep,
      createRetryController: () => ({ decide }),
    });

    const run = await runtime.start(startRequest("initialization-exhausted", EXECUTION_CONFIG_RETRY_TWO_ID));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });

    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
    expect(harness.materializeInitialData).toHaveBeenCalledTimes(3);
    const inputs = vi.mocked(harness.materializeInitialData).mock.calls.map(([input]) => input);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[2]).toEqual(inputs[0]);
    expect(decide.mock.calls.map(([input]) => input)).toEqual([1, 2, 3].map((attemptNumber) => ({
      operation: "initialization",
      failureKind: "network",
      attemptNumber,
    })));
    expect(sleep.mock.calls).toEqual([[5], [10]]);
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.inspectAgentOperation).not.toHaveBeenCalled();
    expect(harness.collectExecution).not.toHaveBeenCalled();
    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.execution).toEqual({ status: "failed", lastError: "initialization connection failed" });
    expect(sampling.executionAttempts).toHaveLength(1);
    expect(sampling.executionAttempts[0]?.status).toBe("failed");
  });

  it("does not retry an unretryable initialization conflict even when its controller allows retries", async () => {
    const harness = makeHarness();
    vi.mocked(harness.materializeInitialData).mockRejectedValue(Object.assign(
      new Error("initialization identity is bound to different input"),
      { retryable: false },
    ));
    const decide = vi.fn<RetryController["decide"]>().mockResolvedValue({ shouldRetry: true, backoffMs: 0 });
    const sleep = vi.fn(async () => undefined);
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep,
      createRetryController: () => ({ decide }),
    });

    const run = await runtime.start(startRequest("initialization-conflict"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });

    expect(harness.materializeInitialData).toHaveBeenCalledTimes(1);
    expect(decide).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.inspectAgentOperation).not.toHaveBeenCalled();
  });

  it("counts creation, initialization and Agent restarts independently without reapplying the seed", async () => {
    const harness = makeHarness();
    vi.mocked(harness.ensureAgent).mockRejectedValueOnce(new Error("connection lost after agent ensure"));
    vi.mocked(harness.materializeInitialData).mockRejectedValueOnce(new Error("temporary initialization failure"));
    vi.mocked(harness.submitAgent).mockResolvedValueOnce({
      status: "failed",
      normalizedStatus: "failed",
      retryable: true,
    });
    const decide = vi.fn<RetryController["decide"]>()
      .mockResolvedValueOnce({ shouldRetry: true, backoffMs: 0 })
      .mockResolvedValueOnce({ shouldRetry: true, backoffMs: 0 })
      .mockResolvedValueOnce({ shouldRetry: true, backoffMs: 0 })
      .mockResolvedValue({ shouldRetry: false });
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: () => ({ decide }),
    });

    const run = await runtime.start(startRequest("initialization-then-restart", EXECUTION_CONFIG_RETRY_ONE_ID));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

    expect(decide.mock.calls.map(([input]) => input)).toEqual([
      { operation: "creation", failureKind: "network", attemptNumber: 1 },
      { operation: "initialization", failureKind: "network", attemptNumber: 1 },
      { operation: "restart", failureKind: "network", attemptNumber: 1 },
    ]);
    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
    const [firstEnsure, secondEnsure] = vi.mocked(harness.ensureAgent).mock.calls;
    expect(secondEnsure![0]).toEqual(firstEnsure![0]);
    expect(harness.materializeInitialData).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(harness.materializeInitialData).mock.calls;
    expect(second![0]).toEqual(first![0]);
    expect(harness.restartAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      handle: first![0].handle,
    }));
    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.executionAttempts).toHaveLength(2);
  });

  it("keeps the Subject seed out of the evaluator Session while preserving task evidence and extra fields", async () => {
    const sample: Sample = {
      sampleId: "sample-1",
      data: { ...makeSample("sample-1").data, expectedOutput: { pages: 3 }, labels: ["web"] },
    };
    const harness = makeHarness();
    const runtime = createEvalRuntime({ catalog: makeCatalog([sample]), harness, store: makeStore() });
    const run = await runtime.pipeline(pipelineRequest("independent-evaluator-session"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });
    const inputs = vi.mocked(harness.materializeInitialData).mock.calls.map(([input]) => input);
    const subject = inputs.find((input) => input.handle.role === "subject")!;
    const evaluator = inputs.find((input) => input.handle.role === "evaluator")!;
    expect(subject.data.initialSession).toEqual(sample.data.initialSession);
    expect(evaluator.data).not.toHaveProperty("initialSession");
    expect(evaluator.data).toMatchObject({
      userPrompt: sample.data.userPrompt,
      initialMaterials: sample.data.initialMaterials,
      expectedOutput: sample.data.expectedOutput,
      labels: sample.data.labels,
    });
    expect(evaluator.idempotencyKey).toBe(`initial-data:${evaluator.handle.submissionId}`);
    expect(evaluator.handle.submissionId).not.toBe(subject.handle.submissionId);
    const evaluationSubmitIndex = vi.mocked(harness.submitAgent).mock.calls.findIndex(
      ([input]) => input.handle.role === "evaluator",
    );
    expect(vi.mocked(harness.materializeEvaluationInput).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(harness.submitAgent).mock.invocationCallOrder[evaluationSubmitIndex]!);
  });

  it("continues the Agent Session after a restart without reapplying its seed", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValueOnce({
      status: "failed",
      normalizedStatus: "failed",
      retryable: true,
    });
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store: makeStore(), sleep: async () => undefined });
    const run = await runtime.start(startRequest("keep-restored-session", EXECUTION_CONFIG_RETRY_ONE_ID));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });
    expect(harness.materializeInitialData).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: "Execute sample-1" }));
    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
  });

  it.each(["sp", "codex", "cc"] as const)(
    "runs the selected %s framework through the same hosted lifecycle",
    async (framework) => {
      const harness = makeHarness();
      const store = makeStore();
      vi.mocked(harness.submitAgent).mockResolvedValueOnce({
        status: "queued",
        normalizedStatus: "queued",
      });
      const runtime = createEvalRuntime({
        catalog: makeCatalog(),
        configResolver: makeConfigResolver(framework),
        harness,
        store,
        sleep: async () => undefined,
      });

      const run = await runtime.start(startRequest(`framework-${framework}`));
      await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
        status: "succeeded",
      });

      expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
      expect(harness.ensureAgent).toHaveBeenCalledWith(expect.objectContaining({
        role: "subject",
        framework,
        agentConfig: SUBJECT,
      }));
      const expectedHandle = expect.objectContaining({
        role: "subject",
        framework,
        samplingId: run.samplingIds[0],
      });
      expect(harness.materializeInitialData).toHaveBeenCalledWith(expect.objectContaining({
        handle: expectedHandle,
      }));
      expect(harness.submitAgent).toHaveBeenCalledWith(expect.objectContaining({
        handle: expectedHandle,
      }));
      expect(harness.waitForSubmission).toHaveBeenCalledWith(expect.objectContaining({
        handle: expectedHandle,
      }));
      expect(harness.collectExecution).toHaveBeenCalledWith(expect.objectContaining({
        handle: expectedHandle,
      }));
      await expect(store.getRun(run.runId)).resolves.toMatchObject({
        config: { execution: { harness: { kind: "sp", framework } } },
      });
    },
  );

  it.each(["codex", "cc"] as const)(
    "evaluates %s execution with a separate SP evaluator in the pipeline",
    async (framework) => {
      const harness = makeHarness();
      const store = makeStore();
      const runtime = createEvalRuntime({
        catalog: makeCatalog(),
        configResolver: makeConfigResolver(framework),
        harness,
        store,
        sleep: async () => undefined,
      });

      const run = await runtime.pipeline(pipelineRequest(`pipeline-${framework}`));
      await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
        status: "succeeded",
      });

      expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
      expect(harness.ensureAgent).toHaveBeenNthCalledWith(1, expect.objectContaining({
        role: "subject",
        framework,
        agentConfig: SUBJECT,
      }));
      expect(harness.ensureAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({
        role: "evaluator",
        framework: "sp",
        agentConfig: EVALUATOR,
      }));
      expect(harness.materializeEvaluationInput).toHaveBeenCalledWith(expect.objectContaining({
        artifacts: [{ artifactId: "artifact-1", kind: "project", path: "/eval/output" }],
        trajectory: { trajectoryId: "trajectory-1", source: "subject", path: "/eval/trajectory.jsonl" },
      }));
      await expect(store.getRun(run.runId)).resolves.toMatchObject({
        config: {
          execution: { harness: { framework } },
          evaluation: { evaluationHarness: { framework: "sp" } },
        },
      });
    },
  );

  it("rejects an Agent handle provisioned with a different framework", async () => {
    const harness = makeHarness();
    vi.mocked(harness.ensureAgent).mockImplementation(async (input) => ({
      role: input.role,
      framework: "sp",
      samplingId: input.samplingId,
      submissionId: input.submissionId,
    }));
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      configResolver: makeConfigResolver("codex"),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ creation: 1 }),
    });

    const run = await runtime.start(startRequest("wrong-framework"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });
    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
    expect(harness.materializeInitialData).not.toHaveBeenCalled();
    expect(harness.submitAgent).not.toHaveBeenCalled();
  });

  it.each(["codex", "cc"] as const)(
    "retains %s creation facts and handle when ensuring and restarting an Agent",
    async (framework) => {
      const harness = makeHarness();
      vi.mocked(harness.ensureAgent).mockRejectedValueOnce(new Error("ensure response lost"));
      vi.mocked(harness.submitAgent).mockResolvedValueOnce({
        status: "failed",
        normalizedStatus: "failed",
        retryable: true,
      });
      const runtime = createEvalRuntime({
        catalog: makeCatalog(),
        configResolver: makeConfigResolver(framework),
        harness,
        store: makeStore(),
        sleep: async () => undefined,
        createRetryController: makeRetryControllerFactory({ creation: 1, restart: 1 }),
      });

      const run = await runtime.start(startRequest(`retry-${framework}`));
      await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

      const ensureCalls = vi.mocked(harness.ensureAgent).mock.calls;
      expect(ensureCalls).toHaveLength(2);
      expect(ensureCalls[0]?.[0]).toMatchObject({ framework });
      expect(ensureCalls[1]?.[0]).toEqual(ensureCalls[0]?.[0]);
      expect(harness.restartAgent).toHaveBeenCalledTimes(1);
      const submitInput = vi.mocked(harness.submitAgent).mock.calls[0]![0];
      const restartInput = vi.mocked(harness.restartAgent).mock.calls[0]![0];
      expect(restartInput.handle).toEqual(submitInput.handle);
      expect(restartInput.handle.framework).toBe(framework);
    },
  );

  it("rejects a reused run identity when the selected framework changes", async () => {
    const harness = makeHarness();
    const configResolver = makeConfigResolver("codex");
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      configResolver,
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const run = await runtime.start(startRequest("framework-request", EXECUTION_CONFIG_ID, "framework-key"));
    await waitForTerminal(runtime, run.runId);

    const config = await configResolver.resolveExecutionConfig(EXECUTION_CONFIG_ID);
    vi.spyOn(configResolver, "resolveExecutionConfig").mockResolvedValue({
      ...config,
      harness: { kind: "sp", framework: "cc", agentConfig: SUBJECT },
    });

    await expect(runtime.start(
      startRequest("another-framework-request", EXECUTION_CONFIG_ID, "framework-key"),
    )).rejects.toThrow(RuntimeRunIdentityConflictError);
    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
  });

  it("passes execution harness runtime options through the subject lifecycle", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValueOnce({
      status: "queued",
      normalizedStatus: "queued",
      accepted: true,
      retryable: false,
    });
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const run = await runtime.start(startRequest("execution-runtime-options", EXECUTION_CONFIG_RUNTIME_ID));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "succeeded",
    });

    expect(harness.ensureAgent).toHaveBeenCalledWith(expect.objectContaining({
      runtime: EXECUTION_RUNTIME,
    }));
    expect(harness.materializeInitialData).toHaveBeenCalledWith(expect.objectContaining({
      runtime: EXECUTION_RUNTIME,
    }));
    expect(harness.submitAgent).toHaveBeenCalledWith(expect.objectContaining({
      runtime: EXECUTION_RUNTIME,
    }));
    expect(harness.waitForSubmission).toHaveBeenCalledWith(expect.objectContaining({
      runtime: EXECUTION_RUNTIME,
    }));
    expect(harness.collectExecution).toHaveBeenCalledWith(expect.objectContaining({
      runtime: EXECUTION_RUNTIME,
    }));
    expect(harness.collectAgentResources).toHaveBeenCalledWith(expect.objectContaining({
      runtime: EXECUTION_RUNTIME,
    }));
  });

  it("passes evaluation harness runtime options through the evaluator lifecycle", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle }) => (
      handle.role === "evaluator"
        ? {
            status: "queued",
            normalizedStatus: "queued",
            accepted: true,
            retryable: false,
          }
        : makeSubmission()
    ));
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const execution = await runtime.start(startRequest("evaluation-runtime-execution"));
    await waitForTerminal(runtime, execution.runId);
    const evaluation = await runtime.evaluate(
      evaluateRequest(execution.samplingIds, EVALUATION_CONFIG_RUNTIME_ID),
    );
    await expect(waitForTerminal(runtime, evaluation.runId)).resolves.toMatchObject({
      status: "succeeded",
    });

    expect(harness.ensureAgent).toHaveBeenCalledWith(expect.objectContaining({
      role: "evaluator",
      runtime: EVALUATION_RUNTIME,
    }));
    expect(harness.materializeInitialData).toHaveBeenCalledWith(expect.objectContaining({
      handle: expect.objectContaining({ role: "evaluator" }),
      runtime: EVALUATION_RUNTIME,
    }));
    expect(harness.materializeEvaluationInput).toHaveBeenCalledWith(expect.objectContaining({
      runtime: EVALUATION_RUNTIME,
    }));
    expect(harness.submitAgent).toHaveBeenCalledWith(expect.objectContaining({
      handle: expect.objectContaining({ role: "evaluator" }),
      runtime: EVALUATION_RUNTIME,
    }));
    expect(harness.waitForSubmission).toHaveBeenCalledWith(expect.objectContaining({
      handle: expect.objectContaining({ role: "evaluator" }),
      runtime: EVALUATION_RUNTIME,
    }));
    expect(harness.collectEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      runtime: EVALUATION_RUNTIME,
    }));
    expect(harness.collectAgentResources).toHaveBeenCalledWith(expect.objectContaining({
      handle: expect.objectContaining({ role: "evaluator" }),
      runtime: EVALUATION_RUNTIME,
    }));
  });

  it("persists the effective config snapshot for every run operation", async () => {
    const store = makeStore();
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness: makeHarness(),
      store,
      sleep: async () => undefined,
    });

    const execution = await runtime.start(startRequest("config-snapshot-execution"));
    const executionRecord = await store.getRun(execution.runId);
    expect(executionRecord?.config).toMatchObject({
      operation: "execution",
      execution: {
        configId: EXECUTION_CONFIG_ID,
        datasetId: "dataset-1",
        samplingCount: 1,
        executionConcurrency: 1,
        retryPolicy: NO_RETRY,
      },
    });

    await waitForTerminal(runtime, execution.runId);
    const evaluation = await runtime.evaluate(evaluateRequest(execution.samplingIds));
    const evaluationRecord = await store.getRun(evaluation.runId);
    expect(evaluationRecord?.config).toMatchObject({
      operation: "evaluation",
      evaluation: {
        configId: EVALUATION_CONFIG_ID,
        evaluationConcurrency: 1,
        retryPolicy: NO_RETRY,
      },
    });

    const pipeline = await runtime.pipeline(pipelineRequest("config-snapshot-pipeline"));
    const pipelineRecord = await store.getRun(pipeline.runId);
    expect(pipelineRecord?.config).toMatchObject({
      operation: "pipeline",
      pipeline: {
        configId: PIPELINE_CONFIG_ID,
      },
      execution: { configId: EXECUTION_CONFIG_ID },
      evaluation: { configId: EVALUATION_CONFIG_ID },
    });
  });

  it("keeps static sample input out of persisted sampling records", async () => {
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness: makeHarness(),
      store: makeStore(),
      sleep: async () => undefined,
    });
    const run = await runtime.start(
      startRequest("sample-record-request", EXECUTION_CONFIG_TWO_SAMPLES_ID),
    );
    await waitForTerminal(runtime, run.runId);

    const records = await Promise.all(
      run.samplingIds.map((samplingId) => runtime.getSampling(samplingId)),
    );
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.sampleId === "sample-1")).toBe(true);
    expect(records.every((record) => !Object.prototype.hasOwnProperty.call(record, "sample"))).toBe(true);
  });

  it("returns the original run when the same request is retried", async () => {
    const harness = makeHarness();
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const request = startRequest("request-1");

    const firstRun = await runtime.start(request);
    const retriedRun = await runtime.start(request);

    expect(retriedRun).toEqual(firstRun);
    await expect(waitForTerminal(runtime, firstRun.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
  });

  it("returns the original run when a retry uses the same idempotency key", async () => {
    const harness = makeHarness();
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const firstRun = await runtime.start(startRequest("request-1", EXECUTION_CONFIG_ID, "run-key-1"));
    const retriedRun = await runtime.start(startRequest("request-2", EXECUTION_CONFIG_ID, "run-key-1"));

    expect(retriedRun).toEqual(firstRun);
    await expect(waitForTerminal(runtime, firstRun.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
  });

  it("rejects a request and key that are already bound to different runs", async () => {
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness: makeHarness(),
      store: makeStore(),
      sleep: async () => undefined,
    });
    await runtime.start(startRequest("request-1", EXECUTION_CONFIG_ID, "run-key-1"));
    await runtime.start(startRequest("request-2", EXECUTION_CONFIG_ID, "run-key-2"));

    await expect(
      runtime.start(startRequest("request-1", EXECUTION_CONFIG_ID, "run-key-2")),
    ).rejects.toThrow(RuntimeRunIdentityConflictError);
  });

  it("rejects a reused idempotency key when request facts change", async () => {
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness: makeHarness(),
      store: makeStore(),
      sleep: async () => undefined,
    });
    await runtime.start(startRequest("request-1", EXECUTION_CONFIG_ID, "run-key-1"));

    await expect(
      runtime.start(startRequest("request-2", EXECUTION_CONFIG_TWO_SAMPLES_ID, "run-key-1")),
    ).rejects.toThrow(RuntimeRunIdentityConflictError);
  });

  it("admits one run when identical requests race before sample resolution", async () => {
    const harness = makeHarness();
    let releaseSamples!: () => void;
    const samplesReady = new Promise<void>((resolve) => {
      releaseSamples = resolve;
    });
    const baseCatalog = makeCatalog();
    const runtime = createEvalRuntime({
      catalog: {
        ...baseCatalog,
        async listData(datasetId) {
          await samplesReady;
          return baseCatalog.listData(datasetId);
        },
      },
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const request = startRequest("request-1", EXECUTION_CONFIG_ID, "run-key-1");

    const firstAdmission = runtime.start(request);
    const secondAdmission = runtime.start(request);
    releaseSamples();
    const [firstRun, secondRun] = await Promise.all([firstAdmission, secondAdmission]);

    expect(secondRun).toEqual(firstRun);
    await expect(waitForTerminal(runtime, firstRun.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
  });

  it("returns the original pipeline run when the request is retried", async () => {
    const harness = makeHarness();
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const request = pipelineRequest("pipeline-request-1", PIPELINE_CONFIG_ID, "pipeline-key-1");

    const firstRun = await runtime.pipeline(request);
    const retriedRun = await runtime.pipeline(request);

    expect(retriedRun).toEqual(firstRun);
    await expect(waitForTerminal(runtime, firstRun.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
  });

  it("keeps evaluation state absent when only execution is requested", async () => {
    const harness = makeHarness();
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const run = await runtime.start(startRequest("test-request"));
    await waitForTerminal(runtime, run.runId);

    await expect(runtime.getSampling(run.samplingIds[0]!)).resolves.toMatchObject({
      execution: { status: "succeeded" },
    });
    await expect(runtime.getSampling(run.samplingIds[0]!)).resolves.not.toHaveProperty("sample");
    await expect(runtime.getSampling(run.samplingIds[0]!)).resolves.not.toHaveProperty("evaluation");
  });

  it("retries execution output collection without restarting a completed agent", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectExecution)
      .mockRejectedValueOnce(new Error("temporary artifact fetch failure"));
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ collection: 1 }),
    });

    const run = await runtime.start(startRequest("test-request"));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.submitAgent).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.collectExecution).toHaveBeenCalledTimes(2);
  });

  it("does not restart an agent when output collection retries are exhausted", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectExecution).mockRejectedValue(
      new Error("artifact storage unavailable"),
    );
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ collection: 1 }),
    });

    const run = await runtime.start(startRequest("test-request", EXECUTION_CONFIG_RETRY_TWO_ID));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "failed",
    });
    expect(harness.submitAgent).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.collectExecution).toHaveBeenCalledTimes(2);
  });

  it("does not restart an agent when output collection returns a failed result", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectExecution).mockResolvedValue({
      samplingId: "sample-1",
      status: "failed",
      artifacts: [],
      trajectory: {
        trajectoryId: "trajectory-1",
        source: "subject",
        path: "/eval/trajectory.jsonl",
      },
      error: "artifact collection failed",
    });
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const run = await runtime.start(startRequest("test-request", EXECUTION_CONFIG_RETRY_TWO_ID));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "failed",
    });
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("does not restart an agent when submission status cannot be confirmed", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValue({
      status: "queued",
      normalizedStatus: "queued",
      retryable: true,
    });
    vi.mocked(harness.waitForSubmission).mockRejectedValue(new Error("status service unavailable"));
    vi.mocked(harness.inspectAgentOperation).mockRejectedValue(new Error("inspection service unavailable"));
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const run = await runtime.start(startRequest("test-request", EXECUTION_CONFIG_RETRY_TWO_ID));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "failed",
    });
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.collectExecution).not.toHaveBeenCalled();
  });

  it("restarts only after status observation confirms a failed submission", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValue({
      status: "queued",
      normalizedStatus: "queued",
      retryable: true,
    });
    vi.mocked(harness.waitForSubmission).mockResolvedValue({
      status: "failed",
      normalizedStatus: "failed",
      retryable: true,
      error: "temporary agent failure",
    });
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const run = await runtime.start(startRequest("test-request", EXECUTION_CONFIG_RETRY_ONE_ID));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.restartAgent).toHaveBeenCalledTimes(1);
  });

  it("evaluates completed executions in new evaluator submissions", async () => {
    const harness = makeHarness();
    const catalog = makeCatalog();
    const getSample = vi.spyOn(catalog, "getSample");
    const runtime = createEvalRuntime({
      catalog,
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const execution = await runtime.start(startRequest("test-request"));
    await waitForTerminal(runtime, execution.runId);

    const evaluation = await runtime.evaluate(evaluateRequest(execution.samplingIds));
    const snapshot = await waitForTerminal(runtime, evaluation.runId);
    const evaluationRecord = await runtime.getEvaluation(snapshot.evaluationIds[0]!);

    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.evaluationIds).toHaveLength(1);
    expect(evaluationRecord.samplingId).toBe(execution.samplingIds[0]);
    expect(evaluationRecord.evaluator).toEqual(EVALUATOR);
    expect(evaluationRecord.status).toEqual({ status: "succeeded" });
    expect(harness.collectEvaluation).toHaveBeenCalledTimes(1);
    expect(getSample).toHaveBeenCalledWith("sample-1");
    expect(harness.materializeInitialData).toHaveBeenCalledTimes(2);
    expect(harness.materializeEvaluationInput).toHaveBeenCalledWith(expect.objectContaining({
      subjectSubmissionId: expect.any(String),
      evaluationSubmissionId: expect.any(String),
      artifacts: [{ artifactId: "artifact-1", kind: "project", path: "/eval/output" }],
      trajectory: {
        trajectoryId: "trajectory-1",
        source: "subject",
        path: "/eval/trajectory.jsonl",
      },
    }));
    const sampling = await runtime.getSampling(execution.samplingIds[0]!);
    expect(sampling.subjectSubmissionId).toEqual(expect.any(String));
    expect(evaluationRecord.submissionId).toEqual(expect.any(String));
    expect(evaluationRecord.submissionId).not.toBe(sampling.subjectSubmissionId);
    const evaluationInput = vi.mocked(harness.materializeEvaluationInput).mock.calls[0]?.[0];
    expect(evaluationInput?.subjectSubmissionId).toBe(sampling.subjectSubmissionId);
    expect(evaluationInput?.evaluationSubmissionId).toBe(evaluationRecord.submissionId);
    expect(sampling).toMatchObject({
      execution: { status: "succeeded" },
    });
    expect(sampling).not.toHaveProperty("evaluation");
  });

  it("keeps independent evaluation records for repeated evaluations", async () => {
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness: makeHarness(),
      store: makeStore(),
      sleep: async () => undefined,
    });
    const execution = await runtime.start(startRequest("repeated-evaluation-execution"));
    await waitForTerminal(runtime, execution.runId);

    const firstEvaluation = await runtime.evaluate(evaluateRequest(execution.samplingIds));
    const firstSnapshot = await waitForTerminal(runtime, firstEvaluation.runId);

    const secondEvaluation = await runtime.evaluate(evaluateRequest(execution.samplingIds));
    const secondSnapshot = await waitForTerminal(runtime, secondEvaluation.runId);
    const evaluations = await runtime.listEvaluations(execution.samplingIds[0]!);

    expect(firstSnapshot.evaluationIds).not.toEqual(secondSnapshot.evaluationIds);
    expect(evaluations.map(({ evaluationId }) => evaluationId)).toEqual([
      firstSnapshot.evaluationIds[0],
      secondSnapshot.evaluationIds[0],
    ]);
    await expect(runtime.getSampling(execution.samplingIds[0]!)).resolves.not.toHaveProperty(
      "evaluation",
    );
  });

  it("resolves a shared sample once for multiple evaluation samplings", async () => {
    const harness = makeHarness();
    const catalog = makeCatalog();
    const getSample = vi.spyOn(catalog, "getSample");
    const runtime = createEvalRuntime({
      catalog,
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const execution = await runtime.start(
      startRequest("shared-sample-execution", EXECUTION_CONFIG_TWO_CONCURRENT_ID),
    );
    await waitForTerminal(runtime, execution.runId);

    const evaluation = await runtime.evaluate(
      evaluateRequest(execution.samplingIds, EVALUATION_CONFIG_TWO_CONCURRENT_ID),
    );
    await waitForTerminal(runtime, evaluation.runId);

    expect(getSample).toHaveBeenCalledTimes(1);
    expect(getSample).toHaveBeenCalledWith("sample-1");
  });

  it("keeps the previous evaluation when atomic evaluation preparation fails", async () => {
    let failEvaluationRun = false;
    const store = makeStore({
      beforeRunCommit: (run) => {
        if (failEvaluationRun && run.phases[0] === "evaluation") {
          throw new Error("evaluation run preparation failed");
        }
      },
    });
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness: makeHarness(),
      store,
      sleep: async () => undefined,
    });
    const execution = await runtime.start(startRequest("test-request"));
    await waitForTerminal(runtime, execution.runId);

    const firstEvaluation = await runtime.evaluate(evaluateRequest(execution.samplingIds));
    await waitForTerminal(runtime, firstEvaluation.runId);
    const before = await runtime.getSampling(execution.samplingIds[0]!);

    failEvaluationRun = true;
    await expect(runtime.evaluate(evaluateRequest(execution.samplingIds)))
      .rejects.toThrow("evaluation run preparation failed");

    await expect(runtime.getSampling(execution.samplingIds[0]!)).resolves.toEqual(before);
  });

  it("reuses the same agent identity when the ensure response is lost", async () => {
    const harness = makeHarness();
    vi.mocked(harness.ensureAgent).mockRejectedValueOnce(
      new Error("connection lost after agent ensure"),
    );
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ creation: 1 }),
    });

    const run = await runtime.start(startRequest("test-request"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "succeeded",
    });

    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
    const firstInput = vi.mocked(harness.ensureAgent).mock.calls[0]?.[0];
    const secondInput = vi.mocked(harness.ensureAgent).mock.calls[1]?.[0];
    expect(secondInput).toEqual(firstInput);
    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.subjectSubmissionId).toBe(firstInput?.submissionId);
    expect(sampling.execution.status).toBe("succeeded");
    expect(sampling.executionAttempts).toHaveLength(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("retries evaluator initial data with the same identity, runtime options and initialization key", async () => {
    const harness = makeHarness();
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ initialization: 1 }),
    });
    const execution = await runtime.start(startRequest("evaluator-initialization-execution"));
    await waitForTerminal(runtime, execution.runId);
    vi.mocked(harness.materializeInitialData).mockRejectedValueOnce(new Error("evaluator initialization response lost"));

    const evaluation = await runtime.evaluate(evaluateRequest(execution.samplingIds, EVALUATION_CONFIG_RUNTIME_ID));
    const snapshot = await waitForTerminal(runtime, evaluation.runId);
    expect(snapshot.status).toBe("succeeded");

    const inputs = vi.mocked(harness.materializeInitialData).mock.calls
      .map(([input]) => input)
      .filter((input) => input.handle.role === "evaluator");
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[0]).toMatchObject({
      runtime: EVALUATION_RUNTIME,
      idempotencyKey: `initial-data:${inputs[0]!.handle.submissionId}`,
    });
    expect(inputs[0]!.data).not.toHaveProperty("initialSession");
    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
    expect(harness.materializeEvaluationInput).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.inspectAgentOperation).not.toHaveBeenCalled();
    const record = await runtime.getEvaluation(snapshot.evaluationIds[0]!);
    expect(record.attempts).toHaveLength(1);
    expect(record.submissionId).toBe(inputs[0]!.handle.submissionId);
  });

  it("retries completed evidence copying with the same key and waits for all evaluator preparation", async () => {
    const harness = makeHarness();
    const committedKeys = new Set<string>();
    let copyRetryStarted!: () => void;
    const started = new Promise<void>((resolve) => { copyRetryStarted = resolve; });
    let finishCopy!: () => void;
    const pending = new Promise<void>((resolve) => { finishCopy = resolve; });
    vi.mocked(harness.materializeEvaluationInput).mockImplementation(async ({ idempotencyKey }) => {
      if (!committedKeys.has(idempotencyKey)) {
        committedKeys.add(idempotencyKey);
        throw new Error("evidence copy response lost after commit");
      }
      copyRetryStarted();
      await pending;
    });
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ initialization: 1 }),
    });

    const run = await runtime.pipeline(pipelineRequest("evidence-copy-response-lost"));
    await started;
    const evaluatorSubmissions = () => vi.mocked(harness.submitAgent).mock.calls
      .filter(([input]) => input.handle.role === "evaluator");
    expect(evaluatorSubmissions()).toHaveLength(0);
    expect(harness.collectEvaluation).not.toHaveBeenCalled();
    await expect(runtime.getRun(run.runId)).resolves.toMatchObject({ phase: "evaluation", status: "retrying" });
    finishCopy();
    const snapshot = await waitForTerminal(runtime, run.runId);
    expect(snapshot.status).toBe("succeeded");

    expect(committedKeys.size).toBe(1);
    const [first, second] = vi.mocked(harness.materializeEvaluationInput).mock.calls;
    expect(second![0]).toEqual(first![0]);
    expect(first![0].idempotencyKey).toBe(`evaluation-input:${first![0].evaluationSubmissionId}`);
    expect(first![0]).toMatchObject({
      artifacts: [{ artifactId: "artifact-1", kind: "project", path: "/eval/output" }],
      trajectory: { trajectoryId: "trajectory-1", source: "subject", path: "/eval/trajectory.jsonl" },
    });
    const inputs = vi.mocked(harness.materializeInitialData).mock.calls
      .map(([input]) => input)
      .filter((input) => input.handle.role === "evaluator");
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[0]!.idempotencyKey).not.toBe(first![0].idempotencyKey);
    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
    expect(evaluatorSubmissions()).toHaveLength(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.inspectAgentOperation).not.toHaveBeenCalled();
    const record = await runtime.getEvaluation(snapshot.evaluationIds[0]!);
    expect(record.attempts).toHaveLength(1);
  });

  it.each([true, false])(
    "does not submit or restart the evaluator after evidence initialization fails (retryable: %s)",
    async (retryable) => {
      const harness = makeHarness();
      vi.mocked(harness.materializeEvaluationInput).mockRejectedValue(Object.assign(
        new Error("evidence initialization failed"),
        { retryable },
      ));
      const decide = vi.fn<RetryController["decide"]>()
        .mockResolvedValueOnce({ shouldRetry: true, backoffMs: 0 })
        .mockResolvedValue({ shouldRetry: false });
      const sleep = vi.fn(async () => undefined);
      const runtime = createEvalRuntime({
        catalog: makeCatalog(),
        harness,
        store: makeStore(),
        sleep,
        createRetryController: () => ({ decide }),
      });
      const execution = await runtime.start(startRequest(`evidence-failure-execution-${retryable}`));
      await waitForTerminal(runtime, execution.runId);

      const evaluation = await runtime.evaluate(evaluateRequest(execution.samplingIds, EVALUATION_CONFIG_RETRY_ONE_ID));
      const snapshot = await waitForTerminal(runtime, evaluation.runId);
      expect(snapshot.status).toBe("failed");

      expect(harness.materializeEvaluationInput).toHaveBeenCalledTimes(retryable ? 2 : 1);
      expect(decide.mock.calls.map(([input]) => input)).toEqual(retryable ? [
        { operation: "initialization", failureKind: "network", attemptNumber: 1 },
        { operation: "initialization", failureKind: "network", attemptNumber: 2 },
      ] : []);
      expect(sleep).toHaveBeenCalledTimes(retryable ? 1 : 0);
      expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
      expect(harness.submitAgent).toHaveBeenCalledTimes(1);
      expect(harness.restartAgent).not.toHaveBeenCalled();
      expect(harness.inspectAgentOperation).not.toHaveBeenCalled();
      expect(harness.collectEvaluation).not.toHaveBeenCalled();
      const record = await runtime.getEvaluation(snapshot.evaluationIds[0]!);
      expect(record.status).toEqual({ status: "failed", lastError: "evidence initialization failed" });
      expect(record.attempts).toHaveLength(1);
      await expect(runtime.getSampling(execution.samplingIds[0]!)).resolves.toMatchObject({
        execution: { status: "succeeded" },
      });
    },
  );

  it("keeps execution success when evaluation fails", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectEvaluation).mockResolvedValue({
      status: "failed",
      artifacts: [],
      trajectory: {
        trajectoryId: "trajectory-2",
        source: "evaluator",
        path: "/eval/evaluation.jsonl",
      },
      error: "evaluation output failed",
    });
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const execution = await runtime.start(startRequest("test-request"));
    await waitForTerminal(runtime, execution.runId);

    const evaluation = await runtime.evaluate(evaluateRequest(execution.samplingIds));
    const evaluationSnapshot = await waitForTerminal(runtime, evaluation.runId);
    await expect(evaluationSnapshot).toMatchObject({
      status: "failed",
    });
    await expect(runtime.getEvaluation(evaluationSnapshot.evaluationIds[0]!)).resolves.toMatchObject({
      status: {
        status: "failed",
        lastError: "evaluation output collection failed: evaluation output failed",
      },
    });

    await expect(runtime.getSampling(execution.samplingIds[0]!)).resolves.toMatchObject({
      execution: { status: "succeeded" },
    });
    await expect(runtime.getSampling(execution.samplingIds[0]!)).resolves.not.toHaveProperty("sample");
  });

  it("retries evaluation output collection without restarting the evaluator", async () => {
    const harness = makeHarness();
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ collection: 1 }),
    });
    const execution = await runtime.start(startRequest("test-request"));
    await waitForTerminal(runtime, execution.runId);

    vi.mocked(harness.collectEvaluation)
      .mockRejectedValueOnce(new Error("temporary evaluation artifact fetch failure"));
    const evaluation = await runtime.evaluate(evaluateRequest(execution.samplingIds));

    await expect(waitForTerminal(runtime, evaluation.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.collectEvaluation).toHaveBeenCalledTimes(2);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("persists run and sampling records for another runtime instance", async () => {
    const harness = makeHarness();
    const store = makeStore();
    const catalog = makeCatalog();
    const runtime = createEvalRuntime({
      catalog,
      harness,
      store,
      sleep: async () => undefined,
    });

    const run = await runtime.start(startRequest("test-request"));
    await waitForTerminal(runtime, run.runId);

    const restoredRuntime = createEvalRuntime({
      catalog,
      harness,
      store,
      sleep: async () => undefined,
    });
    await expect(restoredRuntime.getRun(run.runId)).resolves.toMatchObject({
      runId: run.runId,
      phase: "execution",
      status: "succeeded",
    });
    await expect(restoredRuntime.getSampling(run.samplingIds[0]!)).resolves.toMatchObject({
      execution: { status: "succeeded" },
      subjectSubmissionId: expect.any(String),
    });
    await expect(restoredRuntime.getSampling(run.samplingIds[0]!)).resolves.not.toHaveProperty("sample");
  });

  it("restarts an evaluator submission without creating another evaluator agent", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValueOnce(makeSubmission()).mockResolvedValueOnce({
      status: "failed",
      normalizedStatus: "failed",
      retryable: true,
      error: "temporary evaluator failure",
    });
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const execution = await runtime.start(startRequest("test-request"));
    await waitForTerminal(runtime, execution.runId);

    const evaluation = await runtime.evaluate(
      evaluateRequest(execution.samplingIds, EVALUATION_CONFIG_RETRY_ONE_ID),
    );
    await expect(waitForTerminal(runtime, evaluation.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
    expect(harness.restartAgent).toHaveBeenCalledTimes(1);
  });

  it("automatically restarts a retryable submission without creating a new sampling", async () => {
    const harness = makeHarness();
    const submitAgent = vi.mocked(harness.submitAgent);
    submitAgent
      .mockResolvedValueOnce({
        status: "failed",
        normalizedStatus: "failed",
        retryable: true,
        error: "temporary upstream failure",
      })
      .mockResolvedValueOnce(makeSubmission());
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const run = await runtime.start(startRequest("test-request", EXECUTION_CONFIG_RETRY_ONE_ID));
    const snapshot = await waitForTerminal(runtime, run.runId);

    expect(snapshot.status).toBe("succeeded");
    expect(run.samplingIds).toHaveLength(1);
    expect(harness.restartAgent).toHaveBeenCalledTimes(1);
  });

  it("reuses the restart idempotency key when the restart response is lost", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValueOnce({
      status: "failed",
      normalizedStatus: "failed",
      retryable: true,
      error: "temporary upstream failure",
    });
    vi.mocked(harness.restartAgent)
      .mockRejectedValueOnce(new Error("connection lost after restart"))
      .mockResolvedValueOnce(makeSubmission());
    vi.mocked(harness.inspectAgentOperation).mockResolvedValueOnce(null);
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const run = await runtime.start(startRequest("test-request", EXECUTION_CONFIG_RETRY_ONE_ID));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.restartAgent).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(harness.restartAgent).mock.calls[0]?.[0];
    const secondCall = vi.mocked(harness.restartAgent).mock.calls[1]?.[0];
    expect(firstCall?.idempotencyKey).toBe(secondCall?.idempotencyKey);
    expect(harness.inspectAgentOperation).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: firstCall?.idempotencyKey,
    }));
  });

  it("creates a new restart key only after the previous key is confirmed failed", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValueOnce({
      status: "failed",
      normalizedStatus: "failed",
      retryable: true,
      error: "temporary upstream failure",
    });
    vi.mocked(harness.restartAgent)
      .mockRejectedValueOnce(new Error("connection lost after restart"))
      .mockResolvedValueOnce(makeSubmission());
    vi.mocked(harness.inspectAgentOperation).mockResolvedValueOnce({
      status: "failed",
      normalizedStatus: "failed",
      retryable: true,
      error: "restart was rejected by the agent",
    });
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const run = await runtime.start(startRequest("test-request", EXECUTION_CONFIG_RETRY_TWO_ID));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.restartAgent).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(harness.restartAgent).mock.calls[0]?.[0];
    const secondCall = vi.mocked(harness.restartAgent).mock.calls[1]?.[0];
    expect(firstCall?.idempotencyKey).not.toBe(secondCall?.idempotencyKey);
  });

  it("reconciles an uncertain submission before retrying", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockRejectedValueOnce(new Error("connection lost after submit"));
    vi.mocked(harness.collectExecution)
      .mockRejectedValueOnce(new Error("temporary artifact fetch failure"));
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ collection: 1 }),
    });

    const run = await runtime.start(startRequest("test-request", EXECUTION_CONFIG_RETRY_ONE_ID));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.submitAgent).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.inspectAgentOperation).toHaveBeenCalledTimes(1);
    expect(harness.collectExecution).toHaveBeenCalledTimes(2);
  });

  it("chains execution and evaluation with separate harness stages", async () => {
    const harness = makeHarness();
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const run = await runtime.pipeline(pipelineRequest("test-request"));
    await expect(runtime.getRun(run.runId)).resolves.toMatchObject({ status: "queued" });
    const snapshot = await waitForTerminal(runtime, run.runId);

    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.phases).toEqual(["execution", "evaluation"]);
    expect(snapshot.phase).toBe("evaluation");
    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
    expect(harness.collectExecution).toHaveBeenCalledTimes(1);
    expect(harness.collectEvaluation).toHaveBeenCalledTimes(1);
  });

  it("evaluates successful pipeline samplings when another execution fails", async () => {
    const harness = makeHarness();
    let subjectSubmissionCount = 0;
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle }) => {
      if (handle.role === "subject" && subjectSubmissionCount++ === 0) {
        return {
          status: "failed",
          normalizedStatus: "failed",
          retryable: false,
          error: "subject execution failed",
        };
      }
      return makeSubmission();
    });

    let releaseEvaluation!: () => void;
    let markEvaluationStarted!: () => void;
    const evaluationStarted = new Promise<void>((resolve) => {
      markEvaluationStarted = resolve;
    });
    const evaluationGate = new Promise<void>((resolve) => {
      releaseEvaluation = resolve;
    });
    vi.mocked(harness.collectEvaluation).mockImplementation(async () => {
      markEvaluationStarted();
      await evaluationGate;
      return {
        status: "succeeded",
        artifacts: [{ artifactId: "evaluation-artifact-1", kind: "evaluation", path: "/eval/result" }],
        score: 0.9,
        trajectory: {
          trajectoryId: "trajectory-2",
          source: "evaluator",
          path: "/eval/evaluation.jsonl",
        },
      };
    });

    const runtime = createEvalRuntime({
      catalog: makeCatalog([
        makeSample("sample-1"),
        makeSample("sample-2"),
        makeSample("sample-3"),
      ]),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const run = await runtime.pipeline(
      pipelineRequest("test-request", PIPELINE_CONFIG_CONCURRENT_ID),
    );

    await evaluationStarted;
    await expect(runtime.getRun(run.runId)).resolves.toMatchObject({ status: "running" });
    releaseEvaluation();

    const snapshot = await waitForTerminal(runtime, run.runId);
    expect(snapshot).toMatchObject({
      status: "failed",
    });
    const records = await Promise.all(
      run.samplingIds.map((samplingId) => runtime.getSampling(samplingId)),
    );
    const failedExecutionRecords = records.filter(
      (sampling) => sampling.execution.status === "failed",
    );
    const successfulExecutionRecords = records.filter(
      (sampling) => sampling.execution.status === "succeeded",
    );
    const evaluations = await Promise.all(
      snapshot.evaluationIds.map((evaluationId) => runtime.getEvaluation(evaluationId)),
    );
    const evaluationBySamplingId = new Map(
      evaluations.map((evaluation) => [evaluation.samplingId, evaluation]),
    );

    expect(failedExecutionRecords).toHaveLength(1);
    expect(successfulExecutionRecords).toHaveLength(2);
    expect(harness.collectEvaluation).toHaveBeenCalledTimes(2);
    expect(evaluationBySamplingId.get(failedExecutionRecords[0]!.samplingId)?.status)
      .toEqual({ status: "cancelled", lastError: "execution did not succeed" });
    expect(successfulExecutionRecords.every(
      (sampling) => evaluationBySamplingId.get(sampling.samplingId)?.status.status === "succeeded",
    )).toBe(true);
  });
});

describe("raw resource persistence", () => {
  it("persists scopes before dispatch and saves unchanged subject/evaluator records before output collection", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const captured: AgentResourceSnapshot[] = [];
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle, idempotencyKey }) => {
      const attempts = handle.role === "subject"
        ? (await store.getSampling(handle.samplingId))!.executionAttempts
        : (await store.listEvaluations(handle.samplingId))[0]!.attempts;
      expect(attempts[0]!.resources).toEqual({
        status: "pending",
        scope: { submissionId: handle.submissionId, idempotencyKey },
      });
      return makeSubmission();
    });
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      const resources = makeResources(input);
      captured.push(resources);
      return resources;
    });
    const collectExecution = harness.collectExecution;
    vi.mocked(harness.collectExecution).mockImplementation(async (input) => {
      const sampling = await store.getSampling(input.handle.samplingId);
      expect(sampling!.executionAttempts[0]!.resources).toEqual({ status: "collected", snapshot: captured[0] });
      return {
        samplingId: input.handle.samplingId,
        status: "succeeded",
        artifacts: [],
        trajectory: { trajectoryId: "subject-trace", source: "subject", path: "/eval/trace" },
      };
    });
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store });
    const run = await runtime.pipeline(pipelineRequest("raw-pipeline"));
    const completed = await waitForTerminal(runtime, run.runId);

    expect(completed.status).toBe("succeeded");
    expect(captured).toHaveLength(2);
    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    const evaluation = await runtime.getEvaluation(completed.evaluationIds[0]!);
    expect(sampling.executionAttempts[0]!.resources).toEqual({ status: "collected", snapshot: captured[0] });
    expect(evaluation.attempts[0]!.resources).toEqual({ status: "collected", snapshot: captured[1] });
    expect(captured[0]!.scope.submissionId).toBe(sampling.subjectSubmissionId);
    expect(captured[1]!.scope.submissionId).toBe(evaluation.submissionId);
    expect(captured[1]!.scope.submissionId).not.toBe(captured[0]!.scope.submissionId);
    expect(vi.mocked(harness.collectAgentResources).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(collectExecution).mock.invocationCallOrder[0]!);
    expect(vi.mocked(harness.collectAgentResources).mock.invocationCallOrder[1]!)
      .toBeLessThan(vi.mocked(harness.collectEvaluation).mock.invocationCallOrder[0]!);
  });

  it("reads saved raw data from a new Runtime and isolates query results from persistence", async () => {
    const store = makeStore();
    const harness = makeHarness();
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store });
    const run = await runtime.pipeline(pipelineRequest("cold-raw-query"));
    const completed = await waitForTerminal(runtime, run.runId);
    const originalSampling = await store.getSampling(run.samplingIds[0]!);
    const originalEvaluation = await store.getEvaluation(completed.evaluationIds[0]!);
    const coldHarness = makeHarness();
    const cold = createEvalRuntime({ catalog: makeCatalog(), harness: coldHarness, store });

    const sampling = await cold.getSampling(run.samplingIds[0]!);
    const evaluation = await cold.getEvaluation(completed.evaluationIds[0]!);
    const evaluations = await cold.listEvaluations(run.samplingIds[0]!);
    expect(sampling.executionAttempts).toEqual(originalSampling!.executionAttempts);
    expect(evaluation).toEqual(originalEvaluation);
    expect(evaluations).toEqual([originalEvaluation]);
    const collections = [sampling.executionAttempts[0]!.resources, evaluation.attempts[0]!.resources, evaluations[0]!.attempts[0]!.resources];
    for (const resources of collections) {
      if (resources?.status !== "collected") throw new Error("missing raw resources");
      Reflect.set(resources.snapshot.usageEvents[0]!, "changedByConsumer", true);
    }
    expect(await cold.getSampling(run.samplingIds[0]!)).toEqual(await runtime.getSampling(run.samplingIds[0]!));
    expect(await cold.getEvaluation(completed.evaluationIds[0]!)).toEqual(originalEvaluation);
    expect(await cold.listEvaluations(run.samplingIds[0]!)).toEqual([originalEvaluation]);
    expect(originalSampling!.executionAttempts[0]!.resources).not.toHaveProperty("snapshot.usageEvents.0.changedByConsumer");
    expect(coldHarness.ensureAgent).not.toHaveBeenCalled();
    expect(coldHarness.collectAgentResources).not.toHaveBeenCalled();
  });

  it.each(["failed", "interrupted", "cancelled"] as const)("retains %s subject resource records and the original error", async (status) => {
    const harness = makeHarness();
    const captured: AgentResourceSnapshot[] = [];
    vi.mocked(harness.submitAgent).mockResolvedValue({
      status, normalizedStatus: status, retryable: false, error: `subject ${status}`,
    });
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      const resources = makeResources(input);
      captured.push(resources);
      return resources;
    });
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store: makeStore() });
    const run = await runtime.start(startRequest(`raw-subject-${status}`));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.execution.lastError).toBe(`subject ${status}`);
    expect(sampling.executionAttempts[0]!.resources).toEqual({ status: "collected", snapshot: captured[0] });
    expect(harness.collectExecution).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it.each(["failed", "interrupted", "cancelled"] as const)("retains %s evaluator records without changing the subject", async (status) => {
    const harness = makeHarness();
    const captured: AgentResourceSnapshot[] = [];
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle }) => (
      handle.role === "subject" ? makeSubmission() : {
        status, normalizedStatus: status, retryable: false, error: `evaluator ${status}`,
      }
    ));
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      const resources = makeResources(input);
      captured.push(resources);
      return resources;
    });
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store: makeStore() });
    const run = await runtime.pipeline(pipelineRequest(`raw-evaluator-${status}`));
    const completed = await waitForTerminal(runtime, run.runId);

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    const evaluation = await runtime.getEvaluation(completed.evaluationIds[0]!);
    expect(sampling.execution.status).toBe("succeeded");
    expect(sampling.executionAttempts[0]!.resources).toEqual({ status: "collected", snapshot: captured[0] });
    expect(evaluation.status).toEqual({ status: "failed", lastError: `evaluator ${status}` });
    expect(evaluation.attempts[0]!.resources).toEqual({ status: "collected", snapshot: captured[1] });
    expect(harness.collectEvaluation).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it.each(["subject", "evaluator"] as const)("saves the previous %s attempt's raw data before restarting", async (role) => {
    const store = makeStore();
    const harness = makeHarness();
    const captured: AgentResourceSnapshot[] = [];
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle }) => (
      handle.role !== role ? makeSubmission() : {
        status: "failed", normalizedStatus: "failed", retryable: true, error: "temporary LLM failure", failureKind: "llm",
      }
    ));
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      const resources = makeResources(input);
      captured.push(resources);
      return resources;
    });
    vi.mocked(harness.restartAgent).mockImplementation(async ({ handle }) => {
      const attempts = role === "subject"
        ? (await store.getSampling(handle.samplingId))!.executionAttempts
        : (await store.listEvaluations(handle.samplingId))[0]!.attempts;
      expect(attempts[0]!.resources?.status).toBe("collected");
      return makeSubmission();
    });
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store, sleep: async () => undefined });
    const execution = await runtime.start(startRequest("raw-before-restart", role === "subject" ? EXECUTION_CONFIG_RETRY_ONE_ID : EXECUTION_CONFIG_ID));
    await waitForTerminal(runtime, execution.runId);
    const run = role === "subject" ? execution : await runtime.evaluate(evaluateRequest(execution.samplingIds, EVALUATION_CONFIG_RETRY_ONE_ID));
    const completed = await waitForTerminal(runtime, run.runId);
    const attempts = role === "subject"
      ? (await runtime.getSampling(run.samplingIds[0]!)).executionAttempts
      : (await runtime.getEvaluation(completed.evaluationIds[0]!)).attempts;
    const stageResources = role === "subject" ? captured : captured.slice(1);

    expect(completed.status).toBe("succeeded");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.resources).toEqual({ status: "collected", snapshot: stageResources[0] });
    expect(attempts[1]!.resources).toEqual({ status: "collected", snapshot: stageResources[1] });
    expect(stageResources[1]!.scope.submissionId).toBe(stageResources[0]!.scope.submissionId);
    expect(stageResources[1]!.scope.idempotencyKey).toBe(`${role === "subject" ? "execution" : "evaluation"}:${run.samplingIds[0]}:restart:2`);
    expect(harness.restartAgent).toHaveBeenCalledTimes(1);
  });

  it("gives raw-resource reads and output reads separate retry budgets without rerunning the Agent", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectAgentResources)
      .mockRejectedValueOnce(new Error("temporary resource read failure"))
      .mockImplementation(async (input) => makeResources(input));
    vi.mocked(harness.collectExecution).mockRejectedValueOnce(new Error("temporary artifact read failure"));
    const store = makeStore();
    const update = store.updateSampling.bind(store);
    let failResourceSave = true;
    vi.spyOn(store, "updateSampling").mockImplementation(async (record) => {
      if (failResourceSave && record.executionAttempts[0]?.resources?.status === "collected") {
        failResourceSave = false;
        throw new Error("temporary resource persistence failure");
      }
      await update(record);
    });
    const runtime = createEvalRuntime({
      catalog: makeCatalog(), harness, store, sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ resources: 1, collection: 1, persistence: 1 }),
    });
    const run = await runtime.start(startRequest("independent-resource-retry"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

    const reads = vi.mocked(harness.collectAgentResources).mock.calls;
    expect(reads).toHaveLength(2);
    expect(reads[1]![0]).toEqual(reads[0]![0]);
    expect(harness.collectExecution).toHaveBeenCalledTimes(2);
    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
    expect(harness.submitAgent).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect((await runtime.getSampling(run.samplingIds[0]!)).executionAttempts[0]!.resources?.status).toBe("collected");
  });

  it("does not turn successful execution/evaluation into failure when resource reads are exhausted", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectAgentResources).mockRejectedValue(new Error("resource source unavailable"));
    const runtime = createEvalRuntime({
      catalog: makeCatalog(), harness, store: makeStore(), sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ resources: 1 }),
    });
    const run = await runtime.pipeline(pipelineRequest("missing-resources-pipeline"));
    const completed = await waitForTerminal(runtime, run.runId);
    expect(completed.status).toBe("succeeded");
    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    const evaluation = await runtime.getEvaluation(completed.evaluationIds[0]!);
    for (const resources of [sampling.executionAttempts[0]!.resources, evaluation.attempts[0]!.resources]) {
      expect(resources).toMatchObject({
        status: "failed", error: "resource source unavailable", collectedAt: expect.any(String),
      });
      expect(resources).not.toHaveProperty("snapshot");
    }
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(4);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.collectExecution).toHaveBeenCalledTimes(1);
    expect(harness.collectEvaluation).toHaveBeenCalledTimes(1);
  });

  it("preserves the original Agent failure when its resource read also fails", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValue({
      status: "failed", normalizedStatus: "failed", retryable: false, error: "original agent failure",
    });
    vi.mocked(harness.collectAgentResources).mockRejectedValue(new Error("resource source unavailable"));
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store: makeStore() });
    const run = await runtime.start(startRequest("agent-and-resources-failed"));
    await waitForTerminal(runtime, run.runId);
    const sampling = await runtime.getSampling(run.samplingIds[0]!);

    expect(sampling.execution.lastError).toBe("original agent failure");
    expect(sampling.executionAttempts[0]!.error).toBe("original agent failure");
    expect(sampling.executionAttempts[0]!.resources).toMatchObject({ status: "failed", error: "resource source unavailable" });
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("does not retry invalid source attribution or publish those records as this Agent's facts", async () => {
    const harness = makeHarness();
    const decide = vi.fn(async () => ({ shouldRetry: true, backoffMs: 0 }));
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => ({
      ...makeResources(input), scope: { submissionId: "different-agent", idempotencyKey: input.idempotencyKey },
    }));
    const runtime = createEvalRuntime({
      catalog: makeCatalog(), harness, store: makeStore(), createRetryController: () => ({ decide }),
    });
    const run = await runtime.start(startRequest("wrong-resource-scope"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

    const resources = (await runtime.getSampling(run.samplingIds[0]!)).executionAttempts[0]!.resources;
    expect(resources).toMatchObject({ status: "failed", error: "Resource snapshot does not match the requested operation scope" });
    expect(resources).not.toHaveProperty("snapshot");
    expect(decide).not.toHaveBeenCalled();
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(1);
  });

  it.each(["creation", "initialization"] as const)("does not collect or invent usage before a failed %s", async (operation) => {
    const harness = makeHarness();
    if (operation === "creation") {
      vi.mocked(harness.ensureAgent).mockRejectedValue(new Error("creation failed"));
    } else {
      vi.mocked(harness.materializeInitialData).mockRejectedValue(new Error("initialization failed"));
    }
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store: makeStore() });
    const run = await runtime.start(startRequest(`no-resources-before-${operation}`));
    await waitForTerminal(runtime, run.runId);

    expect(harness.collectAgentResources).not.toHaveBeenCalled();
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect((await runtime.getSampling(run.samplingIds[0]!)).executionAttempts[0]).not.toHaveProperty("resources");
  });

  it("exposes pending collection while awaiting a pushed terminal state", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValue({ status: "running", normalizedStatus: "running" });
    let release!: (submission: AgentSubmission) => void;
    let reachedWait!: () => void;
    const waiting = new Promise<void>((resolve) => { reachedWait = resolve; });
    const terminal = new Promise<AgentSubmission>((resolve) => { release = resolve; });
    vi.mocked(harness.waitForSubmission).mockImplementation(async () => {
      reachedWait();
      return terminal;
    });
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store: makeStore() });
    const run = await runtime.start(startRequest("pending-resources"));
    await waiting;

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.executionAttempts[0]!.resources).toEqual({
      status: "pending",
      scope: { submissionId: sampling.subjectSubmissionId, idempotencyKey: `execution:${sampling.samplingId}` },
    });
    expect(harness.collectAgentResources).not.toHaveBeenCalled();
    release(makeSubmission());
    await waitForTerminal(runtime, run.runId);
    expect((await runtime.getSampling(run.samplingIds[0]!)).executionAttempts[0]!.resources?.status).toBe("collected");
  });

  it.each(["submission", "status"] as const)("saves available raw data after uncertain %s without interpreting source completeness", async (operation) => {
    const harness = makeHarness();
    if (operation === "submission") {
      vi.mocked(harness.submitAgent).mockRejectedValue(new Error("submission response lost"));
      vi.mocked(harness.inspectAgentOperation).mockResolvedValue(null);
    } else {
      vi.mocked(harness.submitAgent).mockResolvedValue({ status: "running", normalizedStatus: "running" });
      vi.mocked(harness.waitForSubmission).mockRejectedValue(new Error("status source unavailable"));
      vi.mocked(harness.inspectAgentOperation).mockResolvedValue({ status: "running", normalizedStatus: "running" });
    }
    let captured!: AgentResourceSnapshot;
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      captured = {
        ...makeResources(input), finalized: false,
        coverage: { usageEvents: "partial", telemetryEvents: "partial", billingSettlements: "unavailable" },
        billingSettlements: [],
      };
      return captured;
    });
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store: makeStore() });
    const run = await runtime.start(startRequest(`uncertain-${operation}-raw-data`));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.executionAttempts[0]!.resources).toEqual({ status: "collected", snapshot: captured });
    expect(sampling.execution.lastError).toContain(operation === "submission" ? "submission response lost" : "status source unavailable");
    expect(harness.collectExecution).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("keeps deliberate re-evaluations and execution raw records separate", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store: makeStore() });
    const execution = await runtime.start(startRequest("raw-execution-for-reevaluation"));
    await waitForTerminal(runtime, execution.runId);
    const subjectBefore = await runtime.getSampling(execution.samplingIds[0]!);
    const first = await runtime.evaluate(evaluateRequest(execution.samplingIds));
    const firstRun = await waitForTerminal(runtime, first.runId);
    const firstBefore = await runtime.getEvaluation(firstRun.evaluationIds[0]!);
    const second = await runtime.evaluate(evaluateRequest(execution.samplingIds));
    const secondRun = await waitForTerminal(runtime, second.runId);
    const secondEvaluation = await runtime.getEvaluation(secondRun.evaluationIds[0]!);

    expect(await runtime.getSampling(execution.samplingIds[0]!)).toEqual(subjectBefore);
    expect(await runtime.getEvaluation(firstBefore.evaluationId)).toEqual(firstBefore);
    expect(await runtime.listEvaluations(execution.samplingIds[0]!)).toEqual([firstBefore, secondEvaluation]);
    expect(secondEvaluation.submissionId).not.toBe(firstBefore.submissionId);
    expect(firstBefore.attempts[0]!.resources).toMatchObject({ snapshot: { scope: { submissionId: firstBefore.submissionId } } });
    expect(secondEvaluation.attempts[0]!.resources).toMatchObject({ snapshot: { scope: { submissionId: secondEvaluation.submissionId } } });
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(3);
  });

  it("preserves saved raw facts when terminal Evaluation writes fail and the coordinator handles the error", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));
    const store = makeStore();
    const update = store.updateEvaluation.bind(store);
    let remainingFailures = 2;
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record) => {
      if ((record.status.status === "succeeded" || record.status.status === "failed") && remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("terminal persistence failed");
      }
      await update(record);
    });
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store });
    const run = await runtime.pipeline(pipelineRequest("retain-raw-on-store-error"));
    const completed = await waitForTerminal(runtime, run.runId);
    const evaluation = await runtime.getEvaluation(completed.evaluationIds[0]!);

    expect(completed.status).toBe("failed");
    expect(evaluation.status.lastError).toBe("terminal persistence failed");
    expect(evaluation.attempts).toHaveLength(1);
    expect(evaluation.attempts[0]!.resources?.status).toBe("collected");
    expect(evaluation.attempts[0]!.resources).toHaveProperty("snapshot.usageEvents.0.sourceExtension");
  });

  it("does not publish success or restart when the raw snapshot cannot be committed", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));
    const store = makeStore();
    const update = store.updateSampling.bind(store);
    vi.spyOn(store, "updateSampling").mockImplementation(async (state) => {
      if (state.executionAttempts.some((attempt) => attempt.resources?.status === "collected")) {
        throw new Error("raw resource persistence failed");
      }
      await update(state);
    });
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store });
    const run = await runtime.start(startRequest("raw-store-failed", EXECUTION_CONFIG_RETRY_ONE_ID));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.execution.lastError).toBe("raw resource persistence failed");
    expect(sampling.executionAttempts[0]!.status).toBe("completed");
    expect(sampling.executionAttempts[0]).not.toHaveProperty("error");
    expect(sampling.executionAttempts[0]!.resources?.status).toBe("pending");
    expect(harness.collectExecution).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("retains raw data when completed Agent output collection fails", async () => {
    const harness = makeHarness();
    let captured!: AgentResourceSnapshot;
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      captured = makeResources(input);
      return captured;
    });
    vi.mocked(harness.collectExecution).mockRejectedValue(new Error("artifact read unavailable"));
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store: makeStore() });
    const run = await runtime.start(startRequest("raw-before-output-failure", EXECUTION_CONFIG_RETRY_ONE_ID));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.executionAttempts[0]!.status).toBe("completed");
    expect(sampling.executionAttempts[0]).not.toHaveProperty("error");
    expect(sampling.executionAttempts[0]!.resources).toEqual({ status: "collected", snapshot: captured });
    expect(sampling.execution.lastError).toContain("artifact read unavailable");
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("preserves repeated source records across restart snapshots for Metric to interpret", async () => {
    const harness = makeHarness();
    const repeatedUsage = { eventId: "original-source-id", metrics: { inputTokens: 10 }, providerSpecificField: null };
    const repeatedSettlement = { accountId: "user-1", eventId: "original-source-id", debitedUnits: 1 };
    vi.mocked(harness.submitAgent).mockResolvedValue({
      status: "failed", normalizedStatus: "failed", retryable: true, error: "agent request failed",
    });
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => ({
      ...makeResources(input), usageEvents: [repeatedUsage], billingSettlements: [repeatedSettlement],
    }));
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store: makeStore(), sleep: async () => undefined });
    const run = await runtime.start(startRequest("raw-source-repeats", EXECUTION_CONFIG_RETRY_ONE_ID));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.executionAttempts).toHaveLength(2);
    for (const attempt of sampling.executionAttempts) {
      expect(attempt.resources).toMatchObject({
        status: "collected", snapshot: { usageEvents: [repeatedUsage], billingSettlements: [repeatedSettlement] },
      });
    }
  });

  it.each(["subject", "evaluator"] as const)("retains committed %s raw records after a lost Store response", async (role) => {
    const harness = makeHarness();
    let captured!: AgentResourceSnapshot;
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      const resources = makeResources(input);
      if (input.handle.role === role) captured = resources;
      return resources;
    });
    const store = makeStore();
    let loseResponse = true;
    if (role === "subject") {
      const update = store.updateSampling.bind(store);
      vi.spyOn(store, "updateSampling").mockImplementation(async (state) => {
        await update(state);
        if (loseResponse && state.executionAttempts.some((attempt) => attempt.resources?.status === "collected")) {
          loseResponse = false;
          throw new Error("raw write response lost");
        }
      });
    } else {
      const update = store.updateEvaluation.bind(store);
      vi.spyOn(store, "updateEvaluation").mockImplementation(async (record) => {
        await update(record);
        if (loseResponse && record.attempts.some((attempt) => attempt.resources?.status === "collected")) {
          loseResponse = false;
          throw new Error("raw write response lost");
        }
      });
    }
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store });
    const execution = await runtime.start(startRequest(`lost-${role}-raw-store-response`));
    await waitForTerminal(runtime, execution.runId);
    const run = role === "subject" ? execution : await runtime.evaluate(evaluateRequest(execution.samplingIds));
    const completed = await waitForTerminal(runtime, run.runId);
    const attempts = role === "subject"
      ? (await runtime.getSampling(run.samplingIds[0]!)).executionAttempts
      : (await runtime.getEvaluation(completed.evaluationIds[0]!)).attempts;

    expect(completed.status).toBe("succeeded");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("completed");
    expect(attempts[0]).not.toHaveProperty("error");
    expect(attempts[0]!.resources).toEqual({ status: "collected", snapshot: captured });
    expect(role === "subject" ? harness.collectExecution : harness.collectEvaluation).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });
});

describe.each(["subject", "evaluator"] as const)("%s finalization", (role) => {
  it.each((["terminal", "resources", "output"] as const).flatMap((step) => (
    (["before", "after"] as const).map((failure) => ({ step, failure }))
  )))("recovers $step save errors $failure commit without rerunning or recollecting", async ({ step, failure }) => {
    const harness = makeHarness();
    const store = makeStore();
    let failedRecord: SamplingState | EvaluationRecord | undefined;
    let retriedRecord: SamplingState | EvaluationRecord | undefined;
    const save = async <TRecord extends SamplingState | EvaluationRecord>(
      record: TRecord,
      update: (record: TRecord) => Promise<void>,
    ): Promise<void> => {
      const attempts = "executionAttempts" in record ? record.executionAttempts : record.attempts;
      const status = "execution" in record ? record.execution.status : record.status.status;
      const shouldFail = step === "terminal"
        ? attempts[0]?.status === "completed" && attempts[0]?.resources?.status === "pending"
        : step === "resources"
          ? attempts[0]?.resources?.status === "collected"
          : status === "succeeded";
      if (shouldFail && !failedRecord) {
        failedRecord = structuredClone(record);
        if (failure === "after") await update(record);
        throw new Error(`${step} write unavailable`);
      }
      if (failedRecord && !retriedRecord) retriedRecord = structuredClone(record);
      await update(record);
    };
    if (role === "subject") {
      const update = store.updateSampling.bind(store);
      vi.spyOn(store, "updateSampling").mockImplementation((record) => save(record, update));
    } else {
      const update = store.updateEvaluation.bind(store);
      vi.spyOn(store, "updateEvaluation").mockImplementation((record) => save(record, update));
    }
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      const attempts = input.handle.role === "subject"
        ? (await store.getSampling(input.handle.samplingId))!.executionAttempts
        : (await store.listEvaluations(input.handle.samplingId))[0]!.attempts;
      expect(attempts[0]!.status).toBe("completed");
      return makeResources(input);
    });
    const decide = vi.fn<RetryController["decide"]>(async ({ operation }) => ({ shouldRetry: operation === "persistence", backoffMs: 37 }));
    const sleep = vi.fn(async () => undefined);
    let tick = 0;
    const runtime = createEvalRuntime({
      catalog: makeCatalog(), harness, store, sleep,
      now: () => new Date(Date.UTC(2026, 9, 8, 0, 0, tick++)).toISOString(),
      createRetryController: () => ({ decide }),
    });
    const run = role === "subject"
      ? await runtime.start(startRequest(`retry-${role}-${step}`))
      : await runtime.pipeline(pipelineRequest(`retry-${role}-${step}`));
    const completed = await waitForTerminal(runtime, run.runId);
    const attempts = role === "subject"
      ? (await runtime.getSampling(run.samplingIds[0]!)).executionAttempts
      : (await runtime.getEvaluation(completed.evaluationIds[0]!)).attempts;

    expect(completed.status).toBe("succeeded");
    expect(failedRecord).toBeDefined();
    if (failure === "before") expect(retriedRecord).toEqual(failedRecord);
    const failedAttempts = "executionAttempts" in failedRecord! ? failedRecord.executionAttempts : failedRecord!.attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: "completed", resources: { status: "collected" } });
    expect(attempts[0]!.completedAt).toBe(failedAttempts[0]!.completedAt);
    expect(attempts[0]).not.toHaveProperty("error");
    if (failure === "before") {
      expect(decide).toHaveBeenCalledExactlyOnceWith({ operation: "persistence", failureKind: "network", attemptNumber: 1 });
      expect(sleep).toHaveBeenCalledExactlyOnceWith(37);
    } else {
      expect(decide).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    }
    expect(harness.ensureAgent).toHaveBeenCalledTimes(role === "subject" ? 1 : 2);
    expect(harness.submitAgent).toHaveBeenCalledTimes(role === "subject" ? 1 : 2);
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(role === "subject" ? 1 : 2);
    expect(role === "subject" ? harness.collectExecution : harness.collectEvaluation).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("keeps completion when resource persistence retries are exhausted", async () => {
    const harness = makeHarness();
    const store = makeStore();
    if (role === "subject") {
      const update = store.updateSampling.bind(store);
      vi.spyOn(store, "updateSampling").mockImplementation(async (record) => {
        if (record.executionAttempts.some((attempt) => attempt.resources?.status === "collected")) {
          throw new Error("resource store unavailable");
        }
        await update(record);
      });
    } else {
      const update = store.updateEvaluation.bind(store);
      vi.spyOn(store, "updateEvaluation").mockImplementation(async (record) => {
        if (record.attempts.some((attempt) => attempt.resources?.status === "collected")) {
          throw new Error("resource store unavailable");
        }
        await update(record);
      });
    }
    const runtime = createEvalRuntime({
      catalog: makeCatalog(), harness, store, sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ persistence: 1, restart: 1 }),
    });
    const run = role === "subject"
      ? await runtime.start(startRequest(`exhausted-${role}-persistence`))
      : await runtime.pipeline(pipelineRequest(`exhausted-${role}-persistence`));
    const completed = await waitForTerminal(runtime, run.runId);
    const record = role === "subject"
      ? await runtime.getSampling(run.samplingIds[0]!)
      : await runtime.getEvaluation(completed.evaluationIds[0]!);
    const attempts = "executionAttempts" in record ? record.executionAttempts : record.attempts;
    const stage = "execution" in record ? record.execution : record.status;

    expect(stage).toEqual({ status: "failed", lastError: "resource store unavailable" });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: "completed", completedAt: expect.any(String), resources: { status: "pending" } });
    expect(attempts[0]).not.toHaveProperty("error");
    expect(role === "subject" ? harness.collectExecution : harness.collectEvaluation).not.toHaveBeenCalled();
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(role === "subject" ? 1 : 2);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("keeps the original failed Agent facts when resource saving fails", async () => {
    const harness = makeHarness();
    const store = makeStore();
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle }) => handle.role === role ? {
      status: "interrupted", normalizedStatus: "interrupted", error: "original Agent interruption", retryable: false,
    } : makeSubmission());
    if (role === "subject") {
      const update = store.updateSampling.bind(store);
      vi.spyOn(store, "updateSampling").mockImplementation(async (record) => {
        if (record.executionAttempts[0]?.resources?.status === "collected") throw new Error("resource store unavailable");
        await update(record);
      });
    } else {
      const update = store.updateEvaluation.bind(store);
      vi.spyOn(store, "updateEvaluation").mockImplementation(async (record) => {
        if (record.attempts[0]?.resources?.status === "collected") throw new Error("resource store unavailable");
        await update(record);
      });
    }
    const runtime = createEvalRuntime({ catalog: makeCatalog(), harness, store });
    const run = role === "subject"
      ? await runtime.start(startRequest(`failed-${role}-resource-persistence`))
      : await runtime.pipeline(pipelineRequest(`failed-${role}-resource-persistence`));
    const completed = await waitForTerminal(runtime, run.runId);
    const attempts = role === "subject"
      ? (await runtime.getSampling(run.samplingIds[0]!)).executionAttempts
      : (await runtime.getEvaluation(completed.evaluationIds[0]!)).attempts;

    expect(completed.status).toBe("failed");
    expect(attempts[0]).toMatchObject({ status: "interrupted", error: "original Agent interruption", completedAt: expect.any(String) });
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });
});

describe("pipeline cancellation isolation", () => {
  function cancellationHarness(store: RuntimeStore): Harness {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle }) => {
      const sampling = await store.getSampling(handle.samplingId);
      return handle.role === "subject" && sampling?.sampleId !== "sample-a"
        ? { status: "failed", normalizedStatus: "failed", retryable: false, error: "subject failed" }
        : makeSubmission();
    });
    return harness;
  }

  it.each(["before", "after"] as const)("evaluates A despite B's cancellation write failing %s commit", async (failure) => {
    const store = makeStore();
    const harness = cancellationHarness(store);
    const update = store.updateEvaluation.bind(store);
    let firstCancellation = true;
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record) => {
      if (record.status.status === "cancelled" && firstCancellation) {
        firstCancellation = false;
        if (failure === "after") await update(record);
        throw new Error("B cancellation write unavailable");
      }
      await update(record);
    });
    const onError = vi.fn();
    const runtime = createEvalRuntime({
      catalog: makeCatalog([makeSample("sample-a"), makeSample("sample-b")]),
      harness, store, onError, sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ persistence: 1 }),
    });
    const run = await runtime.pipeline(pipelineRequest(`cancel-${failure}`, PIPELINE_CONFIG_CONCURRENT_ID));
    const completed = await waitForTerminal(runtime, run.runId);
    const [evaluationA] = await runtime.listEvaluations(run.samplingIds[0]!);
    await expect.poll(async () => (await runtime.listEvaluations(run.samplingIds[1]!))[0]!.status.status).toBe("cancelled");
    const [evaluationB] = await runtime.listEvaluations(run.samplingIds[1]!);

    expect(completed.status).toBe("failed");
    expect(evaluationA!.status).toEqual({ status: "succeeded" });
    expect(evaluationA!.attempts).toHaveLength(1);
    expect(evaluationB!.status).toEqual({ status: "cancelled", lastError: "execution did not succeed" });
    expect(evaluationB!.attempts).toHaveLength(0);
    expect(vi.mocked(harness.ensureAgent).mock.calls.filter(([input]) => input.role === "evaluator")).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not make A wait for B's cancellation retry", async () => {
    const store = makeStore();
    const harness = cancellationHarness(store);
    const update = store.updateEvaluation.bind(store);
    let firstCancellation = true;
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record) => {
      if (record.status.status === "cancelled" && firstCancellation) {
        firstCancellation = false;
        throw new Error("B cancellation write unavailable");
      }
      await update(record);
    });
    let releaseRetry!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const sleep = vi.fn(async () => gate);
    const runtime = createEvalRuntime({
      catalog: makeCatalog([makeSample("sample-a"), makeSample("sample-b")]), harness, store, sleep,
      createRetryController: makeRetryControllerFactory({ persistence: 1 }),
    });
    const run = await runtime.pipeline(pipelineRequest("cancel-retry-gate", PIPELINE_CONFIG_CONCURRENT_ID));
    try {
      await expect.poll(async () => (await runtime.listEvaluations(run.samplingIds[0]!))[0]!.status.status).toBe("succeeded");
      expect(sleep).toHaveBeenCalledTimes(1);
      expect((await runtime.listEvaluations(run.samplingIds[1]!))[0]!.status.status).toBe("queued");
    } finally {
      releaseRetry();
    }
    await expect.poll(async () => (await runtime.listEvaluations(run.samplingIds[1]!))[0]!.status.status).toBe("cancelled");
  });

  it.each([true, false])("records cancellation failure only on B (retryable: %s)", async (retryable) => {
    const store = makeStore();
    const harness = cancellationHarness(store);
    const update = store.updateEvaluation.bind(store);
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record) => {
      if (record.status.status === "cancelled") {
        throw Object.assign(new Error("B cancellation unavailable"), { retryable });
      }
      await update(record);
    });
    const onError = vi.fn();
    const runtime = createEvalRuntime({
      catalog: makeCatalog([makeSample("sample-a"), makeSample("sample-b")]), harness, store, onError,
      sleep: async () => undefined, createRetryController: makeRetryControllerFactory({ persistence: 1 }),
    });
    const run = await runtime.pipeline(pipelineRequest(`cancel-exhausted-${retryable}`, PIPELINE_CONFIG_CONCURRENT_ID));
    await waitForTerminal(runtime, run.runId);
    await expect.poll(async () => (await runtime.listEvaluations(run.samplingIds[1]!))[0]!.status.status).toBe("failed");
    const [evaluationA] = await runtime.listEvaluations(run.samplingIds[0]!);
    const [evaluationB] = await runtime.listEvaluations(run.samplingIds[1]!);

    expect(evaluationA!.status).toEqual({ status: "succeeded" });
    expect(evaluationA!.attempts).toHaveLength(1);
    expect(evaluationB!.status).toEqual({ status: "failed", lastError: "evaluation cancellation persistence failed: B cancellation unavailable" });
    expect(evaluationB!.attempts).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports B's error when neither cancellation nor its error record can be saved", async () => {
    const store = makeStore();
    const harness = cancellationHarness(store);
    const update = store.updateEvaluation.bind(store);
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record) => {
      if (record.status.status === "cancelled" || record.status.lastError?.startsWith("evaluation cancellation persistence failed:")) {
        throw new Error("B storage unavailable");
      }
      await update(record);
    });
    const onError = vi.fn();
    const runtime = createEvalRuntime({
      catalog: makeCatalog([makeSample("sample-a"), makeSample("sample-b")]), harness, store, onError,
    });
    const run = await runtime.pipeline(pipelineRequest("cancel-report", PIPELINE_CONFIG_CONCURRENT_ID));
    await waitForTerminal(runtime, run.runId);
    await expect.poll(() => onError.mock.calls.length).toBe(1);
    const [evaluationA] = await runtime.listEvaluations(run.samplingIds[0]!);
    const [evaluationB] = await runtime.listEvaluations(run.samplingIds[1]!);
    const reported = onError.mock.calls[0]![0] as AggregateError;

    expect(evaluationA!.status).toEqual({ status: "succeeded" });
    expect(evaluationA!.attempts).toHaveLength(1);
    expect(evaluationB!.status.status).toBe("queued");
    expect(evaluationB!.attempts).toHaveLength(0);
    expect(reported).toBeInstanceOf(AggregateError);
    expect(reported.message).toContain(evaluationB!.evaluationId);
    expect(reported.message).toContain(evaluationB!.samplingId);
    expect(reported.errors).toHaveLength(2);
  });

  it("does not downgrade committed cancellation when reconciliation temporarily fails", async () => {
    const store = makeStore();
    const harness = cancellationHarness(store);
    const update = store.updateEvaluation.bind(store);
    const read = store.getEvaluation.bind(store);
    let uncertainEvaluationId: string | undefined;
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record) => {
      await update(record);
      if (record.status.status === "cancelled" && !uncertainEvaluationId) {
        uncertainEvaluationId = record.evaluationId;
        throw new Error("cancellation response lost");
      }
    });
    let firstRead = true;
    vi.spyOn(store, "getEvaluation").mockImplementation(async (evaluationId) => {
      if (evaluationId === uncertainEvaluationId && firstRead) {
        firstRead = false;
        throw new Error("reconciliation unavailable");
      }
      return read(evaluationId);
    });
    const onError = vi.fn();
    const runtime = createEvalRuntime({
      catalog: makeCatalog([makeSample("sample-a"), makeSample("sample-b")]), harness, store, onError,
    });
    const run = await runtime.pipeline(pipelineRequest("cancel-read-failed", PIPELINE_CONFIG_CONCURRENT_ID));
    await waitForTerminal(runtime, run.runId);
    expect((await runtime.listEvaluations(run.samplingIds[0]!))[0]!.status.status).toBe("succeeded");
    expect((await runtime.listEvaluations(run.samplingIds[1]!))[0]!.status.status).toBe("cancelled");
    expect(onError).not.toHaveBeenCalled();
    expect(vi.mocked(store.updateEvaluation).mock.calls.some(([record]) => record.status.status === "failed")).toBe(false);
  });

  it("isolates failed cancellation records even when no sampling is evaluable", async () => {
    const store = makeStore();
    const harness = cancellationHarness(store);
    const update = store.updateEvaluation.bind(store);
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record) => {
      const sampling = await store.getSampling(record.samplingId);
      if (record.status.status === "cancelled" && sampling!.sampleId === "sample-b") {
        throw new Error("B cancellation unavailable");
      }
      await update(record);
    });
    const runtime = createEvalRuntime({
      catalog: makeCatalog([makeSample("sample-b"), makeSample("sample-c")]), harness, store,
    });
    const run = await runtime.pipeline(pipelineRequest("all-executions-failed", PIPELINE_CONFIG_CONCURRENT_ID));
    await waitForTerminal(runtime, run.runId);
    await expect.poll(async () => (await runtime.listEvaluations(run.samplingIds[0]!))[0]!.status.status).toBe("failed");
    await expect.poll(async () => (await runtime.listEvaluations(run.samplingIds[1]!))[0]!.status.status).toBe("cancelled");
    expect((await runtime.listEvaluations(run.samplingIds[0]!))[0]!.status.lastError).toContain("B cancellation unavailable");
    expect(vi.mocked(harness.ensureAgent).mock.calls.every(([input]) => input.role === "subject")).toBe(true);
    expect(harness.collectEvaluation).not.toHaveBeenCalled();
  });

  it.each(["default", "throwing"] as const)("keeps A independent when using the %s error reporter", async (reporter) => {
    const store = makeStore();
    const harness = cancellationHarness(store);
    const update = store.updateEvaluation.bind(store);
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record) => {
      if (record.status.status === "cancelled" || record.status.lastError?.startsWith("evaluation cancellation persistence failed:")) {
        throw new Error("B storage unavailable");
      }
      await update(record);
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const runtime = createEvalRuntime({
        catalog: makeCatalog([makeSample("sample-a"), makeSample("sample-b")]), harness, store,
        ...(reporter === "throwing" ? { onError: () => { throw new Error("reporter unavailable"); } } : {}),
      });
      const run = await runtime.pipeline(pipelineRequest(`cancel-reporter-${reporter}`, PIPELINE_CONFIG_CONCURRENT_ID));
      await waitForTerminal(runtime, run.runId);
      await expect.poll(() => logged.mock.calls.length).toBe(1);
      expect((await runtime.listEvaluations(run.samplingIds[0]!))[0]!.status.status).toBe("succeeded");
      expect((await runtime.listEvaluations(run.samplingIds[1]!))[0]!.status.status).toBe("queued");
    } finally {
      logged.mockRestore();
    }
  });
});
