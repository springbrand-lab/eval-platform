import path from "node:path";
import type { EvaluationRecord, Sampling } from "@eval-platform/eval-contracts";
import { createDatasetService, DataInUseError, DatasetEntityNotFoundError, DatasetIdentityConflictError } from "@eval-platform/eval-dataset";
import { createMetrics, MetricsQueryError } from "@eval-platform/eval-metrics";
import { RuntimeRunIdentityConflictError, type RuntimeRunRecord } from "@eval-platform/eval-runtime";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvalDb, createPostgresCatalog, createPostgresDatasetStore, createPostgresMetricsSource, createPostgresRunNotifications, createPostgresRuntimeStore, startEvalRunWorker } from "../index.js";

const connection = process.env.DATABASE_URL;
const subjectAgent = { ownerUserId: "owner", userAgentId: "subject" };
const evaluator = { ownerUserId: "owner", userAgentId: "evaluator" };
function executionConfig(datasetId: string) {
  return {
    operation: "execution" as const,
    execution: {
      configId: "execution-config", datasetId, samplingCount: 1,
      executionConcurrency: 1, retryPolicy: { maxRestarts: 1, initialBackoffMs: 0, maxBackoffMs: 0 },
      harness: { kind: "sp" as const, framework: "codex" as const, agentConfig: subjectAgent },
    },
  };
}
const evaluationConfig = {
  operation: "evaluation" as const,
  evaluation: {
    configId: "evaluation-config", evaluationConcurrency: 1,
    retryPolicy: { maxRestarts: 1, initialBackoffMs: 0, maxBackoffMs: 0 },
    evaluationHarness: { kind: "sp" as const, framework: "sp" as const, agentConfig: evaluator },
  },
};

function makeSampling(projectId: string, sampleId: string, samplingId: string = crypto.randomUUID()): Sampling {
  return {
    samplingId, projectId, sampleId,
    execution: { status: "queued" }, subjectAgent, executionAttempts: [],
  };
}

function makeRun(projectId: string, record: Sampling, datasetId: string, overrides: Partial<RuntimeRunRecord> = {}): RuntimeRunRecord {
  return {
    runId: crypto.randomUUID(), projectId,
    samplingIds: [record.samplingId], evaluationIds: [],
    phases: ["execution"], config: executionConfig(datasetId),
    ...(overrides.phases?.[0] === "evaluation" ? {} : {
      requestIdentity: { requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), requestFingerprint: "facts-1" },
    }),
    ...overrides,
  };
}

function makeEvaluation(samplingId: string, evaluationId = crypto.randomUUID()): EvaluationRecord {
  return { evaluationId, samplingId, evaluator, status: { status: "queued" }, attempts: [] };
}

async function testDatabase(url: string) {
  const databaseName = `eval_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const target = new URL(url);
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = new Pool({ connectionString: adminUrl.toString() });
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  target.pathname = `/${databaseName}`;
  const pool = new Pool({ connectionString: target.toString() });
  const db = createEvalDb(pool);
  const dropDatabase = async () => {
    const cleanup = new Pool({ connectionString: adminUrl.toString() });
    try {
      await cleanup.query(`DROP DATABASE "${databaseName}"`);
    } finally {
      await cleanup.end();
    }
  };
  try {
    await migrate(db, { migrationsFolder: path.resolve("migrations-postgres") });
  } catch (error) {
    await pool.end();
    await dropDatabase();
    throw error;
  }
  return {
    db,
    connectionString: target.toString(),
    async destroy() {
      await pool.end();
      await dropDatabase();
    },
  };
}

describe.skipIf(!connection)("PostgreSQL evaluation persistence", () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;

  beforeAll(async () => {
    database = await testDatabase(connection!);
  }, 30_000);

  beforeEach(async () => {
    await database.db.execute(sql`TRUNCATE TABLE eval_projects, eval_datasets, eval_data RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    if (database) await database.destroy();
  }, 30_000);

  function stores() {
    const db = database.db;
    return {
      catalog: createPostgresCatalog(db, { async listAgents() { return []; } }),
      datasetService: createDatasetService(createPostgresDatasetStore(db)),
      runtime: createPostgresRuntimeStore(db),
      source: createPostgresMetricsSource(db),
    };
  }

  async function setup() {
    const services = stores();
    const project = await services.catalog.createProject({ ownerUserId: "user-A", name: "my project" });
    const dataset = await services.datasetService.createDataset({ name: "shared tasks" });
    const data = await services.datasetService.createData({
      userPrompt: "build a page", sampleId: "business-id", extra: { original: true, nullable: null },
      initialSession: { bundleId: "sessions", sessionId: "seed" },
      initialMaterials: { bundleId: "materials", materialId: "workspace" },
    });
    await services.datasetService.attachData(dataset.datasetId, [data.dataId]);
    const sample = await services.catalog.createSample(data.dataId);
    return { ...services, project, dataset, data, sample };
  }

  it("shares global Data across user-owned Projects and Datasets, preserving complete references", async () => {
    const { catalog, datasetService, project, data, sample } = await setup();
    const anotherProject = await catalog.createProject({ ownerUserId: "user-B", name: "second" });
    const anotherDataset = await datasetService.createDataset({ name: "another shared set" });
    await datasetService.attachData(anotherDataset.datasetId, [data.dataId, data.dataId]);
    await datasetService.updateData(data.dataId, { userPrompt: "updated", sampleId: "business-id", extra: { nullable: null } });
    expect((await datasetService.listData(anotherDataset.datasetId))[0]).toEqual(await datasetService.getData(data.dataId));
    expect((await catalog.getSample(sample.sampleId))?.data).toEqual(await datasetService.getData(data.dataId));
    expect((await catalog.listProjectsByOwner("user-A")).map((entry) => entry.projectId)).toEqual([project.projectId]);
    expect((await catalog.listProjectsByOwner("user-B")).map((entry) => entry.projectId)).toEqual([anotherProject.projectId]);
    await expect(datasetService.deleteData(data.dataId)).rejects.toBeInstanceOf(DataInUseError);
    await datasetService.deleteDataset(anotherDataset.datasetId);
    expect(await datasetService.getData(data.dataId)).not.toBeNull();
  });

  it("imports a whole Dataset atomically, rejects conflicting reuse and admits simultaneous identical imports", async () => {
    const { datasetService } = stores();
    const existing = await datasetService.createData({ userPrompt: "existing" });
    const datasetId = crypto.randomUUID();
    const newDataId = crypto.randomUUID();
    const conflicting = JSON.stringify({
      dataset: { datasetId, name: "import" },
      data: [
        { dataId: newDataId, userPrompt: "new" },
        { dataId: existing.dataId, userPrompt: "changed" },
      ],
    });
    await expect(datasetService.importDataset(conflicting, "json")).rejects.toBeInstanceOf(DatasetIdentityConflictError);
    expect(await datasetService.getDataset(datasetId)).toBeNull();
    expect(await datasetService.getData(newDataId)).toBeNull();

    const document = JSON.stringify({
      dataset: { datasetId, name: "import" },
      data: [{ dataId: newDataId, userPrompt: "new", nested: { first: 1, second: 2 } }, existing],
    });
    const [first, second] = await Promise.all([
      datasetService.importDataset(document, "json"), datasetService.importDataset(document, "json"),
    ]);
    expect(first).toEqual(second);
    expect((await datasetService.listData(datasetId)).map((entry) => entry.dataId).sort())
      .toEqual([existing.dataId, newDataId].sort());
    await expect(datasetService.importDataset(JSON.stringify({
      dataset: { datasetId, name: "changed" }, data: first.data,
    }), "json")).rejects.toBeInstanceOf(DatasetIdentityConflictError);
    expect(await datasetService.getDataset(datasetId)).toEqual(first.dataset);
    expect(JSON.parse(await datasetService.exportDataset(datasetId, "json"))).toEqual({
      dataset: first.dataset, data: first.data.toSorted((left, right) => left.dataId.localeCompare(right.dataId)),
    });
    const reordered = { dataset: first.dataset, data: first.data.map((entry) => (
      entry.dataId === newDataId
        ? { dataId: entry.dataId, nested: { second: 2, first: 1 }, userPrompt: "new" }
        : entry
    )) };
    await expect(datasetService.importDataset(JSON.stringify(reordered), "json"))
      .resolves.toEqual(reordered);
  });

  it("rolls back a missing Data attachment and protects Data referenced by a Sample", async () => {
    const { datasetService, catalog } = stores();
    const collection = await datasetService.createDataset({ name: "tasks" });
    const record = await datasetService.createData({ userPrompt: "task" });
    await expect(datasetService.attachData(collection.datasetId, [record.dataId, crypto.randomUUID()]))
      .rejects.toBeInstanceOf(DatasetEntityNotFoundError);
    expect(await datasetService.listData(collection.datasetId)).toEqual([]);
    await catalog.createSample(record.dataId);
    await expect(datasetService.deleteData(record.dataId)).rejects.toBeInstanceOf(DataInUseError);
    expect(await datasetService.getData(record.dataId)).toEqual(record);
  });

  it("atomically admits concurrent Run requests, rejecting conflicting identities and half-created batches", async () => {
    const { catalog, runtime, project, dataset, sample } = await setup();
    const first = makeSampling(project.projectId, sample.sampleId);
    const second = makeSampling(project.projectId, sample.sampleId);
    const run = makeRun(project.projectId, first, dataset.datasetId);
    const competing = makeRun(project.projectId, second, dataset.datasetId, { requestIdentity: run.requestIdentity! });
    const admissions = await Promise.all([
      runtime.createRunWithSamplings(run, [first], []),
      createPostgresRuntimeStore(database.db).createRunWithSamplings(competing, [second], []),
    ]);
    expect(admissions.filter((result) => result.created)).toHaveLength(1);
    expect(admissions[0]!.run).toEqual(admissions[1]!.run);
    expect(await runtime.getSampling(admissions[0]!.run.samplingIds[0]!)).not.toBeNull();
    expect(await runtime.getSampling(admissions[0]!.run.samplingIds[0] === first.samplingId ? second.samplingId : first.samplingId)).toBeNull();
    expect(await runtime.findRunByRequestId(run.requestIdentity!.requestId)).toEqual(admissions[0]!.run);
    expect(await runtime.findRunByIdempotencyKey(run.requestIdentity!.idempotencyKey!)).toEqual(admissions[0]!.run);
    const conflict = makeRun(project.projectId, makeSampling(project.projectId, sample.sampleId), dataset.datasetId, {
      requestIdentity: { ...run.requestIdentity!, requestFingerprint: "other facts" },
    });
    await expect(runtime.createRunWithSamplings(conflict, [makeSampling(project.projectId, sample.sampleId, conflict.samplingIds[0]!)], []))
      .rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);

    const unrelatedSampling = makeSampling(project.projectId, sample.sampleId);
    const unrelated = makeRun(project.projectId, unrelatedSampling, dataset.datasetId);
    await runtime.createRunWithSamplings(unrelated, [unrelatedSampling], []);
    const ambiguousSampling = makeSampling(project.projectId, sample.sampleId);
    const ambiguous = makeRun(project.projectId, ambiguousSampling, dataset.datasetId, {
      requestIdentity: {
        requestId: run.requestIdentity!.requestId,
        idempotencyKey: unrelated.requestIdentity!.idempotencyKey!,
        requestFingerprint: run.requestIdentity!.requestFingerprint,
      },
    });
    await expect(runtime.createRunWithSamplings(ambiguous, [ambiguousSampling], []))
      .rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);
    expect(await runtime.getRun(ambiguous.runId)).toBeNull();

    const good = makeSampling(project.projectId, sample.sampleId);
    const bad = makeSampling(project.projectId, "missing-sample");
    const invalid = makeRun(project.projectId, good, dataset.datasetId, {
      samplingIds: [good.samplingId, bad.samplingId], requestIdentity: {
        requestId: crypto.randomUUID(), requestFingerprint: "invalid scope",
      },
    });
    await expect(runtime.createRunWithSamplings(invalid, [good, bad], [])).rejects.toThrow();
    expect(await runtime.getRun(invalid.runId)).toBeNull();
    expect(await runtime.getSampling(good.samplingId)).toBeNull();
    expect(await runtime.getSampling(bad.samplingId)).toBeNull();
    expect(await catalog.getSample(sample.sampleId)).not.toBeNull();
  });

  it("notifies committed Runs and finds unfinished execution and evaluation without a Run status column", async () => {
    const { catalog, runtime, project, dataset, sample } = await setup();
    const listener = await database.db.$client.connect();
    const observed: string[] = [];
    const onNotification = (message: { channel: string; payload?: string | undefined }) => {
      if (message.channel === "eval_run_created" && message.payload) observed.push(message.payload);
    };
    listener.on("notification", onNotification);
    try {
      await listener.query("LISTEN eval_run_created");
      const first = makeSampling(project.projectId, sample.sampleId);
      const second = makeSampling(project.projectId, sample.sampleId);
      const firstRun = makeRun(project.projectId, first, dataset.datasetId);
      const secondRun = makeRun(project.projectId, second, dataset.datasetId);
      await runtime.createRunWithSamplings(firstRun, [first], []);
      await runtime.createRunWithSamplings(secondRun, [second], []);
      await vi.waitFor(() => expect(observed).toEqual(expect.arrayContaining([firstRun.runId, secondRun.runId])));

      const ids = [firstRun.runId, secondRun.runId].sort();
      expect(await runtime.listRecoverableRunIds()).toEqual(ids);
      expect(await runtime.listRecoverableRunIds(undefined, 1)).toEqual(ids.slice(0, 1));
      expect(await runtime.listRecoverableRunIds(ids[0], 1)).toEqual(ids.slice(1));

      const succeeded = { ...first, execution: { status: "succeeded" as const } };
      await runtime.updateSampling(succeeded);
      const judge = makeEvaluation(first.samplingId);
      const evaluationRun: RuntimeRunRecord = {
        runId: crypto.randomUUID(), projectId: project.projectId,
        samplingIds: [first.samplingId], evaluationIds: [judge.evaluationId],
        phases: ["evaluation"], config: evaluationConfig,
      };
      await runtime.createRunWithSamplings(evaluationRun, [succeeded], [judge]);
      expect(await runtime.listRecoverableRunIds()).toEqual([secondRun.runId, evaluationRun.runId].sort());

      await runtime.updateSampling({ ...second, execution: { status: "failed" } });
      await runtime.updateEvaluation({ ...judge, status: { status: "succeeded" } });
      expect(await runtime.listRecoverableRunIds()).toEqual([]);
    } finally {
      listener.removeListener("notification", onNotification);
      await listener.query("UNLISTEN eval_run_created");
      listener.release();
    }
  });

  it("delivers Run notifications to the application worker subscription", async () => {
    const { project, dataset, sample, runtime } = await setup();
    const received: string[] = [];
    const onError = vi.fn();
    const onConnected = vi.fn();
    const subscription = await createPostgresRunNotifications(database.connectionString).subscribe({
      onRunId: (runId) => received.push(runId), onConnected, onError,
    });
    try {
      const sampling = makeSampling(project.projectId, sample.sampleId);
      const run = makeRun(project.projectId, sampling, dataset.datasetId);
      await runtime.createRunWithSamplings(run, [sampling], []);
      await vi.waitFor(() => expect(received).toEqual([run.runId]));
      expect(onConnected).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await subscription.close();
    }
  });

  it("reconnects the Run listener after its PostgreSQL session is terminated", async () => {
    const { project, dataset, sample, runtime } = await setup();
    const received: string[] = [];
    const onConnected = vi.fn();
    const onError = vi.fn();
    const listenerName = `eval_run_listener_${crypto.randomUUID()}`;
    const listenerUrl = new URL(database.connectionString);
    listenerUrl.searchParams.set("application_name", listenerName);
    const subscription = await createPostgresRunNotifications(listenerUrl.toString()).subscribe({
      onRunId: (runId) => received.push(runId), onConnected, onError,
    });
    try {
      const result = await database.db.$client.query<{ stopped: boolean }>(
        "SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE application_name = $1",
        [listenerName],
      );
      expect(result.rows).toEqual([{ stopped: true }]);
      await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(2), { timeout: 5_000 });

      const sampling = makeSampling(project.projectId, sample.sampleId);
      const run = makeRun(project.projectId, sampling, dataset.datasetId);
      await runtime.createRunWithSamplings(run, [sampling], []);
      await vi.waitFor(() => expect(received).toEqual([run.runId]));
    } finally {
      await subscription.close();
    }
  });

  it("recovers an admitted Run on startup and executes the next Run from its notification", async () => {
    const { project, dataset, sample, runtime } = await setup();
    const first = makeSampling(project.projectId, sample.sampleId);
    const firstRun = makeRun(project.projectId, first, dataset.datasetId);
    await runtime.createRunWithSamplings(firstRun, [first], []);

    const resume = vi.fn(async (runId: string) => {
      const run = await runtime.getRun(runId);
      if (!run) throw new Error(`Unknown Run ${runId}`);
      for (const samplingId of run.samplingIds) {
        const sampling = await runtime.getSampling(samplingId);
        if (!sampling) throw new Error(`Unknown Sampling ${samplingId}`);
        await runtime.updateSampling({ ...sampling, execution: { status: "succeeded" } });
      }
    });
    const worker = await startEvalRunWorker({
      runtime: { resume }, store: runtime,
      notifications: createPostgresRunNotifications(database.connectionString),
      scanIntervalMs: 60_000,
    });
    try {
      await vi.waitFor(() => expect(resume).toHaveBeenCalledWith(firstRun.runId));
      const second = makeSampling(project.projectId, sample.sampleId);
      const secondRun = makeRun(project.projectId, second, dataset.datasetId);
      await runtime.createRunWithSamplings(secondRun, [second], []);
      await vi.waitFor(() => expect(resume).toHaveBeenCalledWith(secondRun.runId));
      await vi.waitFor(async () => expect(await runtime.listRecoverableRunIds()).toEqual([]));
      expect(resume).toHaveBeenCalledTimes(2);
    } finally {
      await worker.close();
    }
  });

  it("retains raw execution and every independent re-evaluation across store instances", async () => {
    const { runtime, source, project, dataset, data, sample } = await setup();
    const original = makeSampling(project.projectId, sample.sampleId);
    const executionRun = makeRun(project.projectId, original, dataset.datasetId);
    await runtime.createRunWithSamplings(executionRun, [original], []);
    const snapshot = {
      scope: { submissionId: "subject-submission", idempotencyKey: "execute:1" },
      observedAt: "2026-10-09T01:00:00.000Z", finalized: true,
      coverage: { usageEvents: "complete", telemetryEvents: "complete", billingSettlements: "complete" } as const,
      usageEvents: [{ eventId: "one", value: { source: null } }, { eventId: "one", value: { source: null } }],
      telemetryEvents: [], billingSettlements: [],
    };
    const finished: Sampling = {
      ...original, execution: { status: "succeeded" }, subjectSubmissionId: "subject-submission",
      executionAttempts: [{ executionAttemptId: "subject-attempt", samplingId: original.samplingId,
        attemptNumber: 1, submissionId: "subject-submission", status: "completed",
        resources: { status: "collected", snapshot } }],
      artifacts: [{ artifactId: "page", kind: "file", path: "/workspace/page.html" }],
      trajectory: { trajectoryId: "full", source: "subject", path: "/workspace/trajectory.json" },
    };
    await runtime.updateSampling(finished);
    const firstJudge = makeEvaluation(original.samplingId);
    const firstRun = makeRun(project.projectId, finished, dataset.datasetId, {
      phases: ["evaluation"], evaluationIds: [firstJudge.evaluationId], config: evaluationConfig,
    });
    await runtime.createRunWithSamplings(firstRun, [finished], [firstJudge]);
    const secondJudge = makeEvaluation(original.samplingId);
    const secondRun = makeRun(project.projectId, original, dataset.datasetId, {
      phases: ["evaluation"], evaluationIds: [secondJudge.evaluationId], config: evaluationConfig,
    });
    await runtime.createRunWithSamplings(secondRun, [original], [secondJudge]);
    const completed = {
      ...firstJudge, status: { status: "succeeded" as const },
      attempts: [{ evaluationAttemptId: "judge-attempt", evaluationId: firstJudge.evaluationId,
        attemptNumber: 1, status: "completed" as const }],
      output: { status: "succeeded" as const, score: 92, reason: "good", artifacts: [],
        trajectory: { trajectoryId: "judge-trace", source: "evaluator" as const, path: "/judge/trace.json" } },
    };
    await runtime.updateEvaluation(completed);
    const restored = createPostgresRuntimeStore(database.db);
    expect(await restored.getSampling(original.samplingId)).toEqual(finished);
    expect(await restored.listEvaluations(original.samplingId)).toEqual(
      [completed, secondJudge].sort((left, right) => left.evaluationId.localeCompare(right.evaluationId)),
    );
    expect((await restored.getSampling(original.samplingId))?.executionAttempts[0]?.resources)
      .toEqual({ status: "collected", snapshot });

    const metrics = createMetrics({ source });
    const detail = await metrics.getSamplingDetail({ projectId: project.projectId, samplingId: original.samplingId });
    expect(detail.sample.data).toEqual(data);
    expect(detail.evaluations).toHaveLength(2);
    expect(detail.sampling.artifacts).toEqual(finished.artifacts);
    expect(detail.sampling.trajectory).toEqual(finished.trajectory);
    expect(detail.runIds).toEqual([executionRun.runId, firstRun.runId, secondRun.runId].sort());
    const firstOnly = await metrics.getSamplingDetail({ projectId: project.projectId,
      samplingId: original.samplingId, runIds: [firstRun.runId] });
    expect(firstOnly.evaluations.map((entry) => entry.record.evaluationId)).toEqual([firstJudge.evaluationId]);
    const subjectOnly = await metrics.getSamplingDetail({ projectId: project.projectId,
      samplingId: original.samplingId, runIds: [executionRun.runId] });
    expect(subjectOnly.evaluations).toEqual([]);
    expect((await metrics.getDatasetOverview({ projectId: project.projectId, datasetId: dataset.datasetId })).dataIds)
      .toEqual([data.dataId]);
    expect((await metrics.getSampleOverview({ projectId: project.projectId, sampleId: sample.sampleId })).summary)
      .toMatchObject({ samplingCount: 1, evaluationCount: 2 });
    expect((await metrics.getProjectOverview({ projectId: project.projectId })).counts)
      .toEqual({ datasets: 1, data: 1, samples: 1, samplings: 1, evaluations: 2 });
    await expect(metrics.getProjectOverview({ projectId: "not-a-project" })).rejects.toBeInstanceOf(MetricsQueryError);
  });

  it("derives queued, running and successful Pipeline progress from raw records instead of a saved Run status", async () => {
    const { runtime, source, project, dataset, sample } = await setup();
    const record = makeSampling(project.projectId, sample.sampleId);
    const judge = makeEvaluation(record.samplingId);
    const pipeline = makeRun(project.projectId, record, dataset.datasetId, {
      phases: ["execution", "evaluation"], evaluationIds: [judge.evaluationId],
      config: { operation: "pipeline", pipeline: {
        configId: "pipeline-config", executionConfigId: "execution-config", evaluationConfigId: "evaluation-config",
      }, execution: executionConfig(dataset.datasetId).execution, evaluation: evaluationConfig.evaluation },
    });
    await runtime.createRunWithSamplings(pipeline, [record], [judge]);
    expect((await source.read({ projectId: project.projectId })).runs[0]).toMatchObject({ phase: "execution", status: "queued" });
    await runtime.updateSampling({ ...record, execution: { status: "running" } });
    expect((await source.read({ projectId: project.projectId })).runs[0]).toMatchObject({ phase: "execution", status: "running" });
    await runtime.updateSampling({ ...record, execution: { status: "succeeded" } });
    expect((await source.read({ projectId: project.projectId })).runs[0]).toMatchObject({ phase: "evaluation", status: "running" });
    await runtime.updateEvaluation({ ...judge, status: { status: "succeeded" } });
    expect((await source.read({ projectId: project.projectId })).runs[0]).toMatchObject({ phase: "evaluation", status: "succeeded" });
  });

  it("keeps Project and selected Run boundaries even when another user shares a Dataset", async () => {
    const { runtime, catalog, source, project, dataset, sample } = await setup();
    const other = await catalog.createProject({ ownerUserId: "user-B", name: "other" });
    const samplingA = makeSampling(project.projectId, sample.sampleId);
    const samplingB = makeSampling(other.projectId, sample.sampleId);
    const runA = makeRun(project.projectId, samplingA, dataset.datasetId);
    const runB = makeRun(other.projectId, samplingB, dataset.datasetId);
    await runtime.createRunWithSamplings(runA, [samplingA], []);
    await runtime.createRunWithSamplings(runB, [samplingB], []);
    const facts = await source.read({ projectId: project.projectId, runIds: [runA.runId] });
    expect(facts.samplings.map((record) => record.samplingId)).toEqual([samplingA.samplingId]);
    expect(facts.runs.map((run) => run.runId)).toEqual([runA.runId]);
    await expect(source.read({ projectId: project.projectId, runIds: [runB.runId] }))
      .rejects.toBeInstanceOf(MetricsQueryError);
  });
});
