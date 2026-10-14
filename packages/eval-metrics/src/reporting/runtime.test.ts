import { describe, expect, it, vi } from "vitest";
import type { AgentResourceSnapshot, EvaluationRecord, RunHandle } from "@eval-platform/eval-contracts";
import { datasetSnapshotSchema } from "@eval-platform/eval-dataset";
import { createConfigResolver, createEvalRuntime } from "@eval-platform/eval-runtime";
import type {
  ConfigStore,
  Harness,
  RuntimeCatalog,
  RuntimeRunRecord,
  RuntimeStore,
  SamplingState,
} from "@eval-platform/eval-runtime";
import { DATA, DATASET, EVALUATOR, PROJECT, SAMPLE, SUBJECT, settlement, telemetry, usage } from "../test-support.js";
import { createMetrics } from "./index.js";
import type { MetricsSource } from "./model.js";

function runtimeFixture() {
  const runs = new Map<string, RuntimeRunRecord>();
  const samplings = new Map<string, SamplingState>();
  const evaluations = new Map<string, EvaluationRecord>();
  const store: RuntimeStore = {
    async getRun(id) { return structuredClone(runs.get(id) ?? null); },
    async findRunByRequestId(id) { return structuredClone([...runs.values()].find((run) => run.requestIdentity?.requestId === id) ?? null); },
    async findRunByIdempotencyKey(key) { return structuredClone([...runs.values()].find((run) => run.requestIdentity?.idempotencyKey === key) ?? null); },
    async createRunWithSamplings(run, records, judges) {
      runs.set(run.runId, structuredClone(run));
      for (const record of records) samplings.set(record.samplingId, structuredClone(record));
      for (const judge of judges) evaluations.set(judge.evaluationId, structuredClone(judge));
      return { run: structuredClone(run), created: true };
    },
    async updateSampling(record) { samplings.set(record.samplingId, structuredClone(record)); },
    async getSampling(id) { return structuredClone(samplings.get(id) ?? null); },
    async updateEvaluation(record) { evaluations.set(record.evaluationId, structuredClone(record)); },
    async getEvaluation(id) { return structuredClone(evaluations.get(id) ?? null); },
    async listEvaluations(id) { return structuredClone([...evaluations.values()].filter((judge) => judge.samplingId === id)); },
  };
  const catalog: RuntimeCatalog = {
    async listProjects() { return [PROJECT]; },
    async listAgents() { return [{ agentConfig: SUBJECT, name: "Subject", role: "subject" }, { agentConfig: EVALUATOR, name: "Judge", role: "evaluator" }]; },
    async listDatasets() { return [DATASET]; },
    async listData() { return [DATA]; },
    async listSamples() { return [SAMPLE]; },
    async getSample(id) { return id === SAMPLE.sampleId ? SAMPLE : null; },
  };
  const configs: ConfigStore = {
    async getExecutionConfig(configId) {
      return { configId, datasetId: DATASET.datasetId, samplingCount: 5, executionConcurrency: 2,
        harness: { kind: "sp", framework: "codex", agentConfig: SUBJECT } };
    },
    async getEvaluationConfig(configId) {
      return { configId, evaluationConcurrency: 2, evaluationHarness: { kind: "sp", framework: "sp", agentConfig: EVALUATOR } };
    },
    async getPipelineConfig(configId) { return { configId, executionConfigId: "execution-config", evaluationConfigId: "evaluation-config" }; },
  };
  const initialized = vi.fn<Harness["materializeInitialData"]>(async () => ({
    bundleId: "input-bundle", manifestHash: "manifest", target: "workspace", rootPath: "/workspace",
  }));
  const materializedTrajectory = vi.fn<Harness["materializeSubjectTrajectory"]>(async () => undefined);
  const harness: Harness = {
    async ensureAgent(input) {
      return {
        samplingId: input.samplingId,
        chatId: input.chatId,
        role: input.role,
        framework: input.framework,
        ...(input.evaluationWorkspace === undefined ? {} : { evaluationWorkspace: input.evaluationWorkspace }),
      };
    },
    materializeInitialData: initialized,
    materializeSubjectTrajectory: materializedTrajectory,
    async submitAgent({ idempotencyKey }) { return { submissionId: idempotencyKey, status: "completed", accepted: true, normalizedStatus: "completed" }; },
    async restartAgent() { throw new Error("Successful agent must not restart"); },
    async inspectAgentOperation({ idempotencyKey }) { return { submissionId: idempotencyKey, status: "completed", accepted: true, normalizedStatus: "completed" }; },
    async waitForSubmission({ idempotencyKey }) { return { submissionId: idempotencyKey, status: "completed", accepted: true, normalizedStatus: "completed" }; },
    async collectExecution({ handle }) {
      return {
        samplingId: handle.samplingId, status: "succeeded", artifacts: [{ artifactId: `${handle.chatId}:page`, kind: "file", path: "/workspace/page.html" }],
        trajectory: { trajectoryId: handle.chatId, source: "subject", path: "/trajectory.json" },
      };
    },
    async collectEvaluation({ handle }) {
      return {
        status: "succeeded", score: 90, reason: "The produced page passes the checks.", artifacts: [{ artifactId: handle.chatId, kind: "report", path: "/evaluation.json" }],
        evidenceRefs: [{ kind: "artifact", ref: "/workspace/page.html" }],
        trajectory: { trajectoryId: handle.chatId, source: "evaluator", path: "/trajectory.json" },
      };
    },
    async collectAgentResources({ handle, idempotencyKey, submissionId }): Promise<AgentResourceSnapshot> {
      const isExecution = handle.role === "subject";
      const event = usage(`${handle.chatId}:usage`, {
        runId: idempotencyKey,
        metrics: isExecution
          ? { inputTokens: 20, outputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 4 }
          : { inputTokens: 5, outputTokens: 10, cacheReadTokens: 1, cacheWriteTokens: 0, reasoningTokens: 4 },
        providerCostUsd: { total: isExecution ? 0.5 : 0.1 },
      });
      return {
        scope: { chatId: handle.chatId, submissionId: submissionId ?? idempotencyKey, idempotencyKey }, observedAt: "2026-10-08T00:01:00.000Z",
        finalized: true, coverage: { usageEvents: "complete", telemetryEvents: "complete", billingSettlements: "complete" },
        usageEvents: [event, event],
        telemetryEvents: [
          telemetry("turn-start", "turn.started", "turn-1", {}, 0, handle.chatId),
          telemetry("turn-end", "turn.finished", "turn-1", { outcome: "completed" }, 1_000, handle.chatId),
          telemetry("request-start", "generation.started", "request-1", {}, 100, handle.chatId),
          telemetry("request-end", "generation.finished", "request-1", { outcome: "completed" }, 200, handle.chatId),
          telemetry("tool-start", "tool.started", "tool-1", { toolName: isExecution ? "browser" : "test" }, 300, handle.chatId),
          telemetry("tool-end", "tool.finished", "tool-1", { toolName: isExecution ? "browser" : "test", outcome: "completed" }, 400, handle.chatId),
        ],
        billingSettlements: [settlement(event.eventId as string, { debitedUnits: isExecution ? 10 : 3 })],
      };
    },
  };
  const onError = vi.fn();
  let nextId = 0;
  let clock = 0;
  const runtime = createEvalRuntime({
    store, catalog, configResolver: createConfigResolver(configs), harness, onError,
    idFactory: () => `runtime-id-${++nextId}`,
    now: () => new Date(Date.UTC(2026, 9, 8) + ++clock).toISOString(),
  });
  const handles: RunHandle[] = [];
  const source: MetricsSource = {
    async read() {
      const samplingIds = [...new Set(handles.flatMap((handle) => handle.samplingIds))];
      const [subjects, judges, snapshots] = await Promise.all([
        Promise.all(samplingIds.map((id) => runtime.getSampling(id))),
        Promise.all(samplingIds.map((id) => runtime.listEvaluations(id))),
        Promise.all(handles.map((handle) => runtime.getRun(handle.runId))),
      ]);
      return {
        project: PROJECT, datasets: [datasetSnapshotSchema.parse({ dataset: DATASET, data: [DATA] })], samples: [SAMPLE],
        samplings: subjects, evaluations: judges.flat(), runs: snapshots,
      };
    },
  };
  return { runtime, metrics: createMetrics({ source }), handles, onError, initialized, materializedTrajectory };
}

describe("Runtime public-query integration", () => {
  it("reports five independently executed/evaluated Agents from persisted raw facts, then retains an independent re-evaluation", async () => {
    const fixture = runtimeFixture();
    const pipeline = await fixture.runtime.pipeline({ requestId: "request-1", projectId: PROJECT.projectId, pipelineConfigId: "pipeline-config" });
    fixture.handles.push(pipeline);
    await fixture.runtime.resume(pipeline.runId);
    expect((await fixture.runtime.getRun(pipeline.runId)).status).toBe("succeeded");

    const project = await fixture.metrics.getProjectOverview({ projectId: PROJECT.projectId });
    expect(project.counts).toEqual({ datasets: 1, data: 1, samples: 1, samplings: 5, evaluations: 5 });
    expect(project.summary.execution.statuses.succeeded).toBe(5);
    expect(project.summary.evaluation.statuses.succeeded).toBe(5);
    expect(project.summary.resources.execution.tokens.total.value).toBe(175);
    expect(project.summary.resources.evaluation.tokens.total.value).toBe(80);
    expect(project.summary.resources.total.tokens.total.value).toBe(255);
    expect(project.summary.resources.execution.costs.chargedUnits.value).toBe(50);
    expect(project.summary.resources.evaluation.costs.chargedUnits.value).toBe(15);
    expect(project.summary.resources.total.costs.chargedUnits.value).toBe(65);
    expect(project.summary.resources.total.costs.providerUsd.value).toBeCloseTo(3);
    expect(project.summary.resources.total.modelRequests.count.value).toBe(10);
    expect(project.summary.resources.total.turns.count.value).toBe(10);
    expect(project.summary.resources.total.tools.count.value).toBe(10);
    expect(project.summary.resources.total.byTool.map((tool) => tool.toolName)).toEqual(["browser", "test"]);
    expect(project.summary.resources.total.duplicateRecords.usageEvents).toBe(10);
    expect(project.summary.resources.total.diagnostics).toEqual([]);

    const stored = await fixture.runtime.getSampling(pipeline.samplingIds[0]!);
    const rawCollection = stored.executionAttempts[0]!.resources!;
    expect(rawCollection.status).toBe("collected");
    if (rawCollection.status !== "collected") throw new Error("Expected persisted collection");
    expect(rawCollection.snapshot.usageEvents).toHaveLength(2);
    expect(rawCollection.snapshot.usageEvents[0]!.metrics).not.toHaveProperty("totalTokens");
    expect(rawCollection.snapshot).not.toHaveProperty("totalCost");
    expect(fixture.initialized).toHaveBeenCalledTimes(10);
    expect(fixture.materializedTrajectory).toHaveBeenCalledTimes(5);

    const rerun = await fixture.runtime.evaluate({ projectId: PROJECT.projectId, samplingIds: [stored.samplingId], evaluationConfigId: "evaluation-config" });
    fixture.handles.push(rerun);
    await fixture.runtime.resume(rerun.runId);
    expect((await fixture.runtime.getRun(rerun.runId)).status).toBe("succeeded");
    const all = await fixture.metrics.getSamplingDetail({ projectId: PROJECT.projectId, samplingId: stored.samplingId });
    expect(all.evaluations).toHaveLength(2);
    expect(all.summary.execution.attempts).toBe(1);
    expect(all.summary.evaluation.attempts).toBe(2);
    expect(all.summary.resources.total.tokens.total.value).toBe(67);
    expect(all.summary.resources.total.costs.chargedUnits.value).toBe(16);

    const original = await fixture.metrics.getSamplingDetail({ projectId: PROJECT.projectId, samplingId: stored.samplingId, runIds: [pipeline.runId] });
    expect(original.evaluations).toHaveLength(1);
    expect(original.summary.resources.total.costs.chargedUnits.value).toBe(13);
    const dataset = await fixture.metrics.getDatasetOverview({ projectId: PROJECT.projectId, datasetId: DATASET.datasetId });
    expect(dataset.summary).toMatchObject({ samplingCount: 5, evaluationCount: 6 });
    const sample = await fixture.metrics.getSampleOverview({ projectId: PROJECT.projectId, sampleId: SAMPLE.sampleId });
    expect(sample.samplings).toHaveLength(5);
    expect(sample.sample.data).toEqual(DATA);
    expect(fixture.onError).not.toHaveBeenCalled();
  });
});
