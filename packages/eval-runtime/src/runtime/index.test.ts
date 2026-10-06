import { describe, expect, it, vi } from "vitest";
import type {
  AgentHandle,
  AgentSubmission,
  Harness,
} from "../harness/index.js";
import type { RuntimeCatalog, Sample } from "./model.js";
import type {
  RuntimeRunRecord,
  RuntimeSamplingRecord,
  RuntimeStore,
} from "./store.js";
import type { RetryController, RetryOperation } from "./retry.js";
import { createEvalRuntime } from "./index.js";

const SUBJECT = { ownerUserId: "user-1", userAgentId: "subject-agent" };
const EVALUATOR = { ownerUserId: "user-1", userAgentId: "evaluator-agent" };

function makeSample(sampleId: string): Sample {
  return {
    sampleId,
    dataId: "data-1",
    json: { task: sampleId },
    initialContext: "initial context",
    initialMaterials: { kind: "file-bundle", bundleId: "materials-1" },
    metadata: { source: "test" },
  };
}

function makeCatalog(samples: readonly Sample[] = [makeSample("sample-1")]): RuntimeCatalog {
  return {
    listProjects: async () => [],
    listAgents: async () => [],
    listDatasets: async () => [],
    listData: async () => [{ dataId: "data-1", json: { task: "data" } }],
    listSamples: async () => samples,
  };
}

function makeStore(): RuntimeStore {
  const runs = new Map<string, RuntimeRunRecord>();
  const samplings = new Map<string, RuntimeSamplingRecord>();
  return {
    async createRun(record) {
      runs.set(record.runId, record);
    },
    async updateRun(record) {
      runs.set(record.runId, record);
    },
    async getRun(runId) {
      return runs.get(runId) ?? null;
    },
    async createSampling(record) {
      samplings.set(record.sampling.samplingId, record);
    },
    async updateSampling(record) {
      samplings.set(record.sampling.samplingId, record);
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
    startAgent: vi.fn(async ({ role, samplingId }): Promise<AgentHandle> => ({
      role,
      samplingId,
      submissionId: `${role}-${samplingId}`,
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
    materializeEvaluationInput: vi.fn(async () => undefined),
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

    const run = await runtime.start({
      projectId: "project-1",
      datasetId: "dataset-1",
      samplingCount: 2,
      executionConcurrency: 1,
      harness: { kind: "sp", agentConfig: SUBJECT },
      retryPolicy: { maxRestarts: 0, initialBackoffMs: 0, maxBackoffMs: 0 },
    });
    const snapshot = await waitForTerminal(runtime, run.runId);

    expect(snapshot.status).toBe("succeeded");
    expect(run.samplingIds).toHaveLength(2);
    expect(harness.startAgent).toHaveBeenCalledTimes(2);
    expect(harness.materializeInitialData).toHaveBeenCalledTimes(2);
    expect(harness.collectExecution).toHaveBeenCalledTimes(2);
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

    const run = await runtime.start({
      projectId: "project-1",
      datasetId: "dataset-1",
      samplingCount: 1,
      executionConcurrency: 1,
      harness: { kind: "sp", agentConfig: SUBJECT },
      retryPolicy: {
        maxRestarts: 0,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
      },
    });

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

    const run = await runtime.start({
      projectId: "project-1",
      datasetId: "dataset-1",
      samplingCount: 1,
      executionConcurrency: 1,
      harness: { kind: "sp", agentConfig: SUBJECT },
      retryPolicy: {
        maxRestarts: 2,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
      },
    });

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

    const run = await runtime.start({
      projectId: "project-1",
      datasetId: "dataset-1",
      samplingCount: 1,
      executionConcurrency: 1,
      harness: { kind: "sp", agentConfig: SUBJECT },
      retryPolicy: { maxRestarts: 2, initialBackoffMs: 0, maxBackoffMs: 0 },
    });

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

    const run = await runtime.start({
      projectId: "project-1",
      datasetId: "dataset-1",
      samplingCount: 1,
      executionConcurrency: 1,
      harness: { kind: "sp", agentConfig: SUBJECT },
      retryPolicy: { maxRestarts: 2, initialBackoffMs: 0, maxBackoffMs: 0 },
    });

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

    const run = await runtime.start({
      projectId: "project-1",
      datasetId: "dataset-1",
      samplingCount: 1,
      executionConcurrency: 1,
      harness: { kind: "sp", agentConfig: SUBJECT },
      retryPolicy: { maxRestarts: 1, initialBackoffMs: 0, maxBackoffMs: 0 },
    });

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.restartAgent).toHaveBeenCalledTimes(1);
  });

  it("evaluates completed executions in new evaluator submissions", async () => {
    const harness = makeHarness();
    const runtime = createEvalRuntime({
      catalog: makeCatalog(),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const execution = await runtime.start({
      projectId: "project-1",
      datasetId: "dataset-1",
      samplingCount: 1,
      executionConcurrency: 1,
      harness: { kind: "sp", agentConfig: SUBJECT },
      retryPolicy: { maxRestarts: 0, initialBackoffMs: 0, maxBackoffMs: 0 },
    });
    await waitForTerminal(runtime, execution.runId);

    const evaluation = await runtime.evaluate({
      projectId: "project-1",
      samplingIds: execution.samplingIds,
      evaluationHarness: { kind: "sp", agentConfig: EVALUATOR },
      evaluationConcurrency: 1,
      retryPolicy: { maxRestarts: 0, initialBackoffMs: 0, maxBackoffMs: 0 },
    });
    const snapshot = await waitForTerminal(runtime, evaluation.runId);

    expect(snapshot.status).toBe("succeeded");
    expect(harness.collectEvaluation).toHaveBeenCalledTimes(1);
    expect(harness.materializeInitialData).toHaveBeenCalledTimes(2);
    expect(harness.materializeEvaluationInput).toHaveBeenCalledWith(expect.objectContaining({
      subjectSubmissionId: `subject-${execution.samplingIds[0]}`,
      evaluationSubmissionId: `evaluator-${execution.samplingIds[0]}`,
      artifacts: [{ artifactId: "artifact-1", kind: "project", path: "/eval/output" }],
      trajectory: {
        trajectoryId: "trajectory-1",
        source: "subject",
        path: "/eval/trajectory.jsonl",
      },
    }));
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
    const execution = await runtime.start({
      projectId: "project-1",
      datasetId: "dataset-1",
      samplingCount: 1,
      executionConcurrency: 1,
      harness: { kind: "sp", agentConfig: SUBJECT },
      retryPolicy: { maxRestarts: 0, initialBackoffMs: 0, maxBackoffMs: 0 },
    });
    await waitForTerminal(runtime, execution.runId);

    vi.mocked(harness.collectEvaluation)
      .mockRejectedValueOnce(new Error("temporary evaluation artifact fetch failure"));
    const evaluation = await runtime.evaluate({
      projectId: "project-1",
      samplingIds: execution.samplingIds,
      evaluationHarness: { kind: "sp", agentConfig: EVALUATOR },
      evaluationConcurrency: 1,
      retryPolicy: {
        maxRestarts: 0,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
      },
    });

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

    const run = await runtime.start({
      projectId: "project-1",
      datasetId: "dataset-1",
      samplingCount: 1,
      executionConcurrency: 1,
      harness: { kind: "sp", agentConfig: SUBJECT },
      retryPolicy: { maxRestarts: 0, initialBackoffMs: 0, maxBackoffMs: 0 },
    });
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
      sampling: {
        status: "succeeded",
        subjectSubmissionId: `subject-${run.samplingIds[0]}`,
      },
      execution: { status: "succeeded" },
    });
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
    const execution = await runtime.start({
      projectId: "project-1",
      datasetId: "dataset-1",
      samplingCount: 1,
      executionConcurrency: 1,
      harness: { kind: "sp", agentConfig: SUBJECT },
      retryPolicy: { maxRestarts: 0, initialBackoffMs: 0, maxBackoffMs: 0 },
    });
    await waitForTerminal(runtime, execution.runId);

    const evaluation = await runtime.evaluate({
      projectId: "project-1",
      samplingIds: execution.samplingIds,
      evaluationHarness: { kind: "sp", agentConfig: EVALUATOR },
      evaluationConcurrency: 1,
      retryPolicy: { maxRestarts: 1, initialBackoffMs: 0, maxBackoffMs: 0 },
    });
    await expect(waitForTerminal(runtime, evaluation.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.startAgent).toHaveBeenCalledTimes(2);
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

    const run = await runtime.start({
      projectId: "project-1",
      datasetId: "dataset-1",
      samplingCount: 1,
      executionConcurrency: 1,
      harness: { kind: "sp", agentConfig: SUBJECT },
      retryPolicy: { maxRestarts: 1, initialBackoffMs: 0, maxBackoffMs: 0 },
    });
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

    const run = await runtime.start({
      projectId: "project-1",
      datasetId: "dataset-1",
      samplingCount: 1,
      executionConcurrency: 1,
      harness: { kind: "sp", agentConfig: SUBJECT },
      retryPolicy: { maxRestarts: 1, initialBackoffMs: 0, maxBackoffMs: 0 },
    });

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

    const run = await runtime.start({
      projectId: "project-1",
      datasetId: "dataset-1",
      samplingCount: 1,
      executionConcurrency: 1,
      harness: { kind: "sp", agentConfig: SUBJECT },
      retryPolicy: { maxRestarts: 2, initialBackoffMs: 0, maxBackoffMs: 0 },
    });

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

    const run = await runtime.start({
      projectId: "project-1",
      datasetId: "dataset-1",
      samplingCount: 1,
      executionConcurrency: 1,
      harness: { kind: "sp", agentConfig: SUBJECT },
      retryPolicy: {
        maxRestarts: 1,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
      },
    });
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

    const run = await runtime.pipeline({
      projectId: "project-1",
      datasetId: "dataset-1",
      samplingCount: 1,
      executionConcurrency: 1,
      harness: { kind: "sp", agentConfig: SUBJECT },
      evaluationHarness: { kind: "sp", agentConfig: EVALUATOR },
      evaluationConcurrency: 1,
      retryPolicy: { maxRestarts: 0, initialBackoffMs: 0, maxBackoffMs: 0 },
    });
    const snapshot = await waitForTerminal(runtime, run.runId);

    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.phase).toBe("pipeline");
    expect(harness.startAgent).toHaveBeenCalledTimes(2);
    expect(harness.collectExecution).toHaveBeenCalledTimes(1);
    expect(harness.collectEvaluation).toHaveBeenCalledTimes(1);
  });
});
