import path from "node:path";
import type { EvaluationRecord, Sampling } from "@eval-platform/eval-contracts";
import { createDatasetService, DataInUseError, DatasetEntityNotFoundError, DatasetIdentityConflictError } from "@eval-platform/eval-dataset";
import { createMetrics, MetricsQueryError } from "@eval-platform/eval-metrics";
import { createConfigResolver, RuntimeEvaluationSelectionError, RuntimeProjectBusyError, RuntimeRecordConflictError, RuntimeRunIdentityConflictError, type RuntimeRunRecord } from "@eval-platform/eval-runtime";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigEntityNotFoundError, ConfigReferenceError, createEvalDb, createPostgresCatalog, createPostgresConfigReader, createPostgresConfigStore, createPostgresDatasetStore, createPostgresIndependentEvaluationApi, createPostgresMetricsSource, createPostgresRunNotifications, createPostgresRuntimeStore, createPostgresWorkerRuntimeStore, DatasetInUseError, EvalSpApiError, startEvalRunWorker } from "../index.js";
import { isForeignKeyFailure } from "./client.js";
import { createPostgresProjectRunReader } from "./run-view.js";
import { readRunRecords } from "./runtime.js";

const connection = process.env.DATABASE_URL;
const subjectAgent = { ownerUserId: "owner", userAgentId: "subject" };
const evaluator = { ownerUserId: "owner", userAgentId: "evaluator" };
const release = { sourceBranch: "release-2.0.0", sourceCommit: "a".repeat(40) };
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
    sourceCommit: release.sourceCommit,
    samplingIds: [record.samplingId], evaluationIds: [],
    phases: ["execution"], config: executionConfig(datasetId),
    requestIdentity: { idempotencyKey: crypto.randomUUID(), requestFingerprint: "facts-1" },
    ...overrides,
  };
}

function makeEvaluation(samplingId: string, evaluationId: string = crypto.randomUUID()): EvaluationRecord {
  return { evaluationId, samplingId, evaluator, status: { status: "queued" }, attempts: [] };
}

async function expectForeignKeyFailure(operation: Promise<unknown>): Promise<void> {
  const error = await operation.then(() => null, (reason: unknown) => reason);
  expect(isForeignKeyFailure(error)).toBe(true);
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
    await database.db.execute(sql`TRUNCATE TABLE eval_projects, eval_datasets, eval_data,
      eval_execution_configs, eval_evaluation_configs, eval_pipeline_configs RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    if (database) await database.destroy();
  }, 30_000);

  function stores() {
    const db = database.db;
    return {
      catalog: createPostgresCatalog(db, "user-A", { async listAgents() { return []; } }, release),
      datasetService: createDatasetService(createPostgresDatasetStore(db, "user-A")),
      runtime: createPostgresWorkerRuntimeStore(db),
      source: createPostgresMetricsSource(db, "user-A"),
    };
  }

  function configStore(ownerUserId: "user-A" | "user-B") {
    return createPostgresConfigStore(database.db, ownerUserId, {
      async getAgentConfig(token, id) {
        if (id === "missing-agent") throw new EvalSpApiError(404, null);
        return { id, user_id: id === "foreign-agent" ? "user-B" : token, name: id };
      },
    }, ownerUserId);
  }

  async function setup() {
    const services = stores();
    const project = await services.catalog.createProject({ name: "my project" });
    const dataset = await services.datasetService.createDataset({ name: "shared tasks" });
    const data = await services.datasetService.createData({
      userPrompt: "build a page", evalPrompt: "Judge the result",
      sampleId: "business-id", extra: { original: true, nullable: null },
      initialSession: { bundleId: "sessions", sessionId: "seed" },
      initialMaterials: { bundleId: "materials", materialId: "workspace" },
    });
    await services.datasetService.attachData(dataset.datasetId, [data.dataId]);
    const sample = await services.catalog.createSample(data.dataId);
    return { ...services, project, dataset, data, sample };
  }

  it("fixes the first execution choice atomically and keeps later evaluation in the same Project", async () => {
    const { catalog, project, dataset, sample } = await setup();
    const runtime = createPostgresRuntimeStore(database.db, "user-A", release);
    expect(await catalog.getProject(project.projectId)).toEqual(project);
    const missing = makeSampling(project.projectId, "missing-sample");
    await expect(runtime.createRunWithSamplings(
      makeRun(project.projectId, missing, dataset.datasetId), [missing], [],
    )).rejects.toThrow("Sample outside its Project owner scope");
    expect(await catalog.getProject(project.projectId)).toEqual(project);

    const phantom = { ...makeSampling(project.projectId, sample.sampleId), execution: { status: "succeeded" as const } };
    const phantomJudge = makeEvaluation(phantom.samplingId);
    const evaluationOnly = makeRun(project.projectId, phantom, dataset.datasetId, {
      phases: ["evaluation"], evaluationIds: [phantomJudge.evaluationId], config: evaluationConfig,
    });
    await expect(runtime.createRunWithSamplings(evaluationOnly, [phantom], [phantomJudge]))
      .rejects.toThrow("An empty Project cannot start with evaluation-only");
    expect(await catalog.getProject(project.projectId)).toEqual(project);

    const sampling = makeSampling(project.projectId, sample.sampleId);
    const execution = makeRun(project.projectId, sampling, dataset.datasetId);
    await runtime.createRunWithSamplings(execution, [sampling], []);
    const selected = { operation: "execution", configId: "execution-config" };
    expect(await catalog.getProject(project.projectId)).toEqual({ ...project, initialLaunch: selected });
    expect(await catalog.listProjects()).toContainEqual({ ...project, initialLaunch: selected });
    expect((await runtime.getRun(execution.runId))?.sourceCommit).toBe(release.sourceCommit);

    const succeeded = { ...sampling, execution: { status: "succeeded" as const } };
    await runtime.updateSampling(succeeded, sampling);
    const judge = makeEvaluation(sampling.samplingId);
    const evaluation = makeRun(project.projectId, succeeded, dataset.datasetId, {
      phases: ["evaluation"], evaluationIds: [judge.evaluationId], config: evaluationConfig,
    });
    await runtime.createRunWithSamplings(evaluation, [succeeded], [judge]);
    expect(await catalog.getProject(project.projectId)).toEqual({ ...project, initialLaunch: selected });
    expect((await runtime.getRun(evaluation.runId))?.sourceCommit).toBe(release.sourceCommit);
    await runtime.updateEvaluation({ ...judge, status: { status: "succeeded" } }, judge);

    const changedSampling = makeSampling(project.projectId, sample.sampleId);
    const changedConfig = makeRun(project.projectId, changedSampling, dataset.datasetId, {
      config: { operation: "execution", execution: {
        ...executionConfig(dataset.datasetId).execution, configId: "another-execution-config",
      } },
    });
    await expect(runtime.createRunWithSamplings(changedConfig, [changedSampling], []))
      .rejects.toThrow("Project launch selection cannot change");
    const changedOperation = makeRun(project.projectId, changedSampling, dataset.datasetId, {
      phases: ["execution", "evaluation"], evaluationIds: [crypto.randomUUID()],
      config: { operation: "pipeline", pipeline: {
        configId: "pipeline-config", executionConfigId: "execution-config", evaluationConfigId: "evaluation-config",
      }, execution: executionConfig(dataset.datasetId).execution, evaluation: evaluationConfig.evaluation },
    });
    const changedJudge = makeEvaluation(changedSampling.samplingId, changedOperation.evaluationIds[0]!);
    await expect(runtime.createRunWithSamplings(changedOperation, [changedSampling], [changedJudge]))
      .rejects.toThrow("Project launch selection cannot change");
    expect(await runtime.getRun(changedConfig.runId)).toBeNull();
    expect(await runtime.getRun(changedOperation.runId)).toBeNull();
    expect(await catalog.getProject(project.projectId)).toEqual({ ...project, initialLaunch: selected });
  });

  it("keeps Project on its source branch while recording each Run's deployed commit", async () => {
    const { catalog, project, dataset, sample } = await setup();
    const originalStore = createPostgresRuntimeStore(database.db, "user-A", release);
    const firstSampling = makeSampling(project.projectId, sample.sampleId);
    const first = makeRun(project.projectId, firstSampling, dataset.datasetId);
    await originalStore.createRunWithSamplings(first, [firstSampling], []);
    await originalStore.updateSampling({ ...firstSampling, execution: { status: "succeeded" } }, firstSampling);

    const nextRelease = { ...release, sourceCommit: "b".repeat(40) };
    const nextStore = createPostgresRuntimeStore(database.db, "user-A", nextRelease);
    const nextSampling = makeSampling(project.projectId, sample.sampleId);
    const next = makeRun(project.projectId, nextSampling, dataset.datasetId, { sourceCommit: nextRelease.sourceCommit });
    await nextStore.createRunWithSamplings(next, [nextSampling], []);
    await nextStore.updateSampling({ ...nextSampling, execution: { status: "succeeded" } }, nextSampling);
    expect((await nextStore.getRun(first.runId))?.sourceCommit).toBe(release.sourceCommit);
    expect((await nextStore.getRun(next.runId))?.sourceCommit).toBe(nextRelease.sourceCommit);
    expect(await catalog.getProject(project.projectId)).toMatchObject({
      sourceBranch: release.sourceBranch, initialLaunch: { operation: "execution", configId: "execution-config" },
    });

    const wrongBranch = createPostgresRuntimeStore(database.db, "user-A", {
      ...nextRelease, sourceBranch: "another-release",
    });
    expect((await wrongBranch.createRunWithSamplings(first, [firstSampling], [])).created).toBe(false);
    const rejectedSampling = makeSampling(project.projectId, sample.sampleId);
    const rejected = makeRun(project.projectId, rejectedSampling, dataset.datasetId, {
      sourceCommit: nextRelease.sourceCommit,
    });
    await expect(wrongBranch.createRunWithSamplings(rejected, [rejectedSampling], []))
      .rejects.toThrow("differs from the active Eval SP release");
    await expect(nextStore.createRunWithSamplings(
      { ...rejected, sourceCommit: release.sourceCommit }, [rejectedSampling], [],
    )).rejects.toThrow("differs from the active Eval SP release");
    expect(await nextStore.getRun(rejected.runId)).toBeNull();
  });

  it("allows only one first Project launch selection under concurrent submissions", async () => {
    const { catalog, project, dataset, sample } = await setup();
    const runtime = createPostgresRuntimeStore(database.db, "user-A", release);
    const firstSampling = makeSampling(project.projectId, sample.sampleId);
    const secondSampling = makeSampling(project.projectId, sample.sampleId);
    const first = makeRun(project.projectId, firstSampling, dataset.datasetId);
    const second = makeRun(project.projectId, secondSampling, dataset.datasetId, {
      config: { operation: "execution", execution: {
        ...executionConfig(dataset.datasetId).execution, configId: "alternative-config",
      } },
    });
    const results = await Promise.allSettled([
      runtime.createRunWithSamplings(first, [firstSampling], []),
      runtime.createRunWithSamplings(second, [secondSampling], []),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason)
      .toBeInstanceOf(RuntimeProjectBusyError);
    const admitted = results[0]?.status === "fulfilled" ? first : second;
    expect(await catalog.getProject(project.projectId)).toMatchObject({
      initialLaunch: { operation: "execution", configId: admitted === first ? "execution-config" : "alternative-config" },
    });
    expect(await runtime.getRun(admitted.runId)).toEqual(admitted);
    expect(await runtime.getRun(admitted === first ? second.runId : first.runId)).toBeNull();
  });

  it("saves, lists, edits and resolves owner-scoped Execution, Evaluation and Pipeline configs", async () => {
    const { datasetService, dataset, sample } = await setup();
    const store = configStore("user-A");
    const executionInput = {
      datasetId: dataset.datasetId, sampleIds: [sample.sampleId], samplingCount: 1, executionConcurrency: 2,
      harness: { kind: "sp" as const, framework: "sp" as const,
        agentConfig: { ownerUserId: "user-A", userAgentId: "subject" } },
    };
    const evaluationInput = {
      evaluationConcurrency: 1,
      evaluationHarness: { kind: "sp" as const, framework: "sp" as const,
        agentConfig: { ownerUserId: "user-A", userAgentId: "evaluator" } },
    };
    const execution = await store.createExecutionConfig(executionInput);
    const evaluation = await store.createEvaluationConfig(evaluationInput);
    const pipeline = await store.createPipelineConfig({
      executionConfigId: execution.configId, evaluationConfigId: evaluation.configId,
    });
    expect(await store.listExecutionConfigs()).toEqual([execution]);
    expect(await store.listEvaluationConfigs()).toEqual([evaluation]);
    expect(await store.listPipelineConfigs()).toEqual([pipeline]);
    await expect(datasetService.deleteDataset(dataset.datasetId)).rejects.toBeInstanceOf(DatasetInUseError);
    expect(await datasetService.getDataset(dataset.datasetId)).toEqual(dataset);
    const resolver = createConfigResolver(store);
    const original = await resolver.resolvePipelineConfig(pipeline.configId);
    expect(original).toMatchObject({ pipeline, execution, evaluation });

    const editedInput = {
      ...executionInput, configId: "body-controlled", samplingCount: 3,
    };
    const edited = await store.updateExecutionConfig(execution.configId, editedInput);
    expect(edited.configId).toBe(execution.configId);
    expect(await store.getExecutionConfig(execution.configId)).toEqual(edited);
    expect((await resolver.resolvePipelineConfig(pipeline.configId)).execution.samplingCount).toBe(3);
    expect(original.execution.samplingCount).toBe(1);
    const editedEvaluation = await store.updateEvaluationConfig(evaluation.configId, {
      ...evaluationInput, evaluationConcurrency: 4,
    });
    expect(await store.getEvaluationConfig(evaluation.configId)).toEqual(editedEvaluation);
    const editedPipeline = await store.updatePipelineConfig(pipeline.configId, {
      executionConfigId: execution.configId, evaluationConfigId: editedEvaluation.configId,
    });
    expect(await store.getPipelineConfig(pipeline.configId)).toEqual(editedPipeline);
  });

  it("rejects foreign config references and hides another user's configs", async () => {
    const { catalog, datasetService, dataset, sample } = await setup();
    const owned = configStore("user-A");
    const foreign = configStore("user-B");
    const foreignService = createDatasetService(createPostgresDatasetStore(database.db, "user-B"));
    const foreignCatalog = createPostgresCatalog(database.db, "user-B", { async listAgents() { return []; } }, release);
    const foreignDataset = await foreignService.createDataset({ name: "foreign" });
    const foreignData = await foreignService.createData({ userPrompt: "foreign task" });
    const foreignSample = await foreignCatalog.createSample(foreignData.dataId);
    const executionInput = {
      datasetId: dataset.datasetId, sampleIds: [sample.sampleId], samplingCount: 1, executionConcurrency: 1,
      harness: { kind: "sp" as const, framework: "sp" as const,
        agentConfig: { ownerUserId: "user-A", userAgentId: "subject" } },
    };
    const evaluationInput = {
      evaluationConcurrency: 1,
      evaluationHarness: { kind: "sp" as const, framework: "sp" as const,
        agentConfig: { ownerUserId: "user-A", userAgentId: "evaluator" } },
    };
    const execution = await owned.createExecutionConfig(executionInput);
    const evaluation = await owned.createEvaluationConfig(evaluationInput);
    const pipeline = await owned.createPipelineConfig({
      executionConfigId: execution.configId, evaluationConfigId: evaluation.configId,
    });
    const foreignEvaluation = await foreign.createEvaluationConfig({
      ...evaluationInput,
      evaluationHarness: { ...evaluationInput.evaluationHarness,
        agentConfig: { ownerUserId: "user-B", userAgentId: "evaluator" } },
    });
    expect(await foreign.getExecutionConfig(execution.configId)).toBeNull();
    expect(await foreign.getEvaluationConfig(evaluation.configId)).toBeNull();
    expect(await foreign.getPipelineConfig(pipeline.configId)).toBeNull();
    expect(await foreign.listExecutionConfigs()).toEqual([]);
    expect(await foreign.listPipelineConfigs()).toEqual([]);
    const { sampleIds: _sampleIds, ...foreignExecutionInput } = executionInput;
    await expect(foreign.updateExecutionConfig(execution.configId, {
      ...foreignExecutionInput, datasetId: foreignDataset.datasetId,
      harness: { ...executionInput.harness,
        agentConfig: { ownerUserId: "user-B", userAgentId: "subject" } },
    })).rejects.toBeInstanceOf(ConfigEntityNotFoundError);
    await expect(owned.createExecutionConfig({ ...executionInput, datasetId: foreignDataset.datasetId }))
      .rejects.toBeInstanceOf(ConfigReferenceError);
    await expect(owned.createExecutionConfig({ ...executionInput, sampleIds: [foreignSample.sampleId] }))
      .rejects.toBeInstanceOf(ConfigReferenceError);
    const unlinkedData = await datasetService.createData({ userPrompt: "not in selected dataset" });
    const unlinkedSample = await catalog.createSample(unlinkedData.dataId);
    await expect(owned.createExecutionConfig({ ...executionInput, sampleIds: [unlinkedSample.sampleId] }))
      .rejects.toBeInstanceOf(ConfigReferenceError);
    await expect(owned.createEvaluationConfig({
      ...evaluationInput,
      evaluationHarness: { ...evaluationInput.evaluationHarness,
        agentConfig: { ownerUserId: "user-B", userAgentId: "evaluator" } },
    })).rejects.toBeInstanceOf(ConfigReferenceError);
    for (const userAgentId of ["foreign-agent", "missing-agent"]) {
      await expect(owned.createEvaluationConfig({
        ...evaluationInput,
        evaluationHarness: { ...evaluationInput.evaluationHarness,
          agentConfig: { ownerUserId: "user-A", userAgentId } },
      })).rejects.toBeInstanceOf(ConfigReferenceError);
    }
    await expect(foreign.createPipelineConfig({
      executionConfigId: execution.configId, evaluationConfigId: evaluation.configId,
    })).rejects.toBeInstanceOf(ConfigReferenceError);
    await expectForeignKeyFailure(database.db.execute(sql`
      INSERT INTO eval_execution_configs (config_id, owner_user_id, dataset_id, settings)
      VALUES (${crypto.randomUUID()}, ${"user-A"}, ${foreignDataset.datasetId}, '{}'::jsonb)
    `));
    await expectForeignKeyFailure(database.db.execute(sql`
      INSERT INTO eval_pipeline_configs (config_id, owner_user_id, execution_config_id, evaluation_config_id)
      VALUES (${crypto.randomUUID()}, ${"user-A"}, ${execution.configId}, ${foreignEvaluation.configId})
    `));
    await expect(owned.updatePipelineConfig("missing", {
      executionConfigId: execution.configId, evaluationConfigId: evaluation.configId,
    })).rejects.toBeInstanceOf(ConfigEntityNotFoundError);
  });

  it("shares Data within one user and rejects cross-user Dataset, Data and Sample access", async () => {
    const { catalog, datasetService, project, data, sample } = await setup();
    const anotherDataset = await datasetService.createDataset({ name: "another shared set" });
    await datasetService.attachData(anotherDataset.datasetId, [data.dataId, data.dataId]);
    await datasetService.updateData(data.dataId, {
      userPrompt: "updated", evalPrompt: "  judge the result  ", sampleId: "business-id", extra: { nullable: null },
    });
    expect((await datasetService.listData(anotherDataset.datasetId))[0]).toEqual(await datasetService.getData(data.dataId));
    expect((await catalog.getSample(sample.sampleId))?.data).toEqual(await datasetService.getData(data.dataId));
    expect((await catalog.getSample(sample.sampleId))?.data.evalPrompt).toBe("  judge the result  ");
    const otherCatalog = createPostgresCatalog(database.db, "user-B", { async listAgents() { return []; } }, release);
    const otherService = createDatasetService(createPostgresDatasetStore(database.db, "user-B"));
    const otherProject = await otherCatalog.createProject({ name: "second" });
    const otherDataset = await otherService.createDataset({ name: "other user's set" });
    expect(await catalog.listProjects()).toEqual([project]);
    expect(await otherCatalog.listProjects()).toEqual([otherProject]);
    expect(await otherService.getDataset(anotherDataset.datasetId)).toBeNull();
    expect(await otherService.getData(data.dataId)).toBeNull();
    expect(await otherCatalog.getSample(sample.sampleId)).toBeNull();
    await expect(otherCatalog.createSample(data.dataId)).rejects.toBeInstanceOf(DatasetEntityNotFoundError);
    await expect(otherService.attachData(otherDataset.datasetId, [data.dataId]))
      .rejects.toBeInstanceOf(DatasetEntityNotFoundError);
    await expect(otherService.importDataset(await datasetService.exportDataset(anotherDataset.datasetId, "json"), "json"))
      .rejects.toBeInstanceOf(DatasetIdentityConflictError);
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

  it.each(["datasetId", "dataId"] as const)("imports a new Dataset with an uppercase %s and returns canonical identities", async (uppercaseField) => {
    const { datasetService } = stores();
    const datasetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const dataId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const document = {
      dataset: { datasetId: uppercaseField === "datasetId" ? datasetId.toUpperCase() : datasetId, name: "import" },
      data: [{ dataId: uppercaseField === "dataId" ? dataId.toUpperCase() : dataId, userPrompt: "task" }],
    };
    const imported = await datasetService.importDataset(JSON.stringify(document), "json");
    expect(imported).toEqual({ dataset: { datasetId, name: "import" }, data: [{ dataId, userPrompt: "task" }] });
    await expect(datasetService.importDataset(JSON.stringify(document), "json")).resolves.toEqual(imported);
    await expect(datasetService.getDataset(datasetId.toUpperCase())).resolves.toEqual(imported.dataset);
    await expect(datasetService.getData(dataId.toUpperCase())).resolves.toEqual(imported.data[0]);
    expect(JSON.parse(await datasetService.exportDataset(datasetId.toUpperCase(), "json"))).toEqual(imported);
    await expect(datasetService.importDataset(JSON.stringify({
      ...document, data: [{ ...document.data[0], userPrompt: "different" }],
    }), "json")).rejects.toBeInstanceOf(DatasetIdentityConflictError);
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
    const competing = makeRun(project.projectId, second, dataset.datasetId, { requestIdentity: run.requestIdentity });
    const admissions = await Promise.all([
      runtime.createRunWithSamplings(run, [first], []),
      createPostgresWorkerRuntimeStore(database.db).createRunWithSamplings(competing, [second], []),
    ]);
    expect(admissions.filter((result) => result.created)).toHaveLength(1);
    expect(admissions[0]!.run).toEqual(admissions[1]!.run);
    expect(await runtime.getSampling(admissions[0]!.run.samplingIds[0]!)).not.toBeNull();
    expect(await runtime.getSampling(admissions[0]!.run.samplingIds[0] === first.samplingId ? second.samplingId : first.samplingId)).toBeNull();
    expect(await runtime.findRunByIdempotencyKey(project.projectId, run.requestIdentity.idempotencyKey))
      .toEqual(admissions[0]!.run);
    const conflict = makeRun(project.projectId, makeSampling(project.projectId, sample.sampleId), dataset.datasetId, {
      requestIdentity: { ...run.requestIdentity, requestFingerprint: "other facts" },
    });
    await expect(runtime.createRunWithSamplings(conflict, [makeSampling(project.projectId, sample.sampleId, conflict.samplingIds[0]!)], []))
      .rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);

    const admittedSampling = (await runtime.getSampling(admissions[0]!.run.samplingIds[0]!))!;
    await runtime.updateSampling({ ...admittedSampling, execution: { status: "succeeded" } }, admittedSampling);

    const good = makeSampling(project.projectId, sample.sampleId);
    const bad = makeSampling(project.projectId, "missing-sample");
    const invalid = makeRun(project.projectId, good, dataset.datasetId, {
      samplingIds: [good.samplingId, bad.samplingId],
      requestIdentity: { idempotencyKey: crypto.randomUUID(), requestFingerprint: "invalid scope" },
    });
    await expect(runtime.createRunWithSamplings(invalid, [good, bad], [])).rejects.toThrow();
    expect(await runtime.getRun(invalid.runId)).toBeNull();
    expect(await runtime.getSampling(good.samplingId)).toBeNull();
    expect(await runtime.getSampling(bad.samplingId)).toBeNull();
    expect(await catalog.getSample(sample.sampleId)).not.toBeNull();
  });

  it("allows only one unfinished Run per Project across execution and evaluation", async () => {
    const { runtime, project, dataset, sample } = await setup();
    const first = makeSampling(project.projectId, sample.sampleId);
    const second = makeSampling(project.projectId, sample.sampleId);
    const execution = makeRun(project.projectId, first, dataset.datasetId, {
      samplingIds: [first.samplingId, second.samplingId],
      config: { operation: "execution", execution: {
        ...executionConfig(dataset.datasetId).execution, samplingCount: 2,
      } },
    });
    await runtime.createRunWithSamplings(execution, [first, second], []);
    const succeeded = { ...first, execution: { status: "succeeded" as const } };
    await runtime.updateSampling(succeeded, first);

    const replay = makeRun(project.projectId, first, dataset.datasetId, {
      samplingIds: execution.samplingIds,
      requestIdentity: execution.requestIdentity,
      config: { operation: "execution", execution: {
        ...executionConfig(dataset.datasetId).execution, samplingCount: 2, executionConcurrency: 9,
      } },
    });
    expect(await runtime.createRunWithSamplings(replay, [first, second], []))
      .toEqual({ run: execution, created: false });

    const another = makeSampling(project.projectId, sample.sampleId);
    const anotherRun = makeRun(project.projectId, another, dataset.datasetId);
    await expect(runtime.createRunWithSamplings(anotherRun, [another], []))
      .rejects.toMatchObject({ projectId: project.projectId, activeRunId: execution.runId });
    expect(await runtime.getRun(anotherRun.runId)).toBeNull();
    expect(await runtime.getSampling(another.samplingId)).toBeNull();

    const judge = makeEvaluation(first.samplingId);
    const evaluation = makeRun(project.projectId, succeeded, dataset.datasetId, {
      phases: ["evaluation"], config: evaluationConfig, evaluationIds: [judge.evaluationId],
    });
    await expect(runtime.createRunWithSamplings(evaluation, [succeeded], [judge]))
      .rejects.toBeInstanceOf(RuntimeProjectBusyError);
    expect(await runtime.getRun(evaluation.runId)).toBeNull();
    expect(await runtime.listEvaluations(first.samplingId)).toEqual([]);

    await runtime.updateSampling({ ...second, execution: { status: "failed" } }, second);
    await runtime.createRunWithSamplings(evaluation, [succeeded], [judge]);
    expect(await runtime.createRunWithSamplings(replay, [first, second], []))
      .toEqual({ run: execution, created: false });
    await expect(runtime.createRunWithSamplings(anotherRun, [another], []))
      .rejects.toMatchObject({ activeRunId: evaluation.runId });
    await runtime.updateEvaluation({ ...judge, status: { status: "cancelled" } }, judge);
    await runtime.createRunWithSamplings(anotherRun, [another], []);
    expect(await runtime.getRun(anotherRun.runId)).toEqual(anotherRun);
  });

  it("lists and selects every successful Sampling in the owned Project with stable order", async () => {
    const { catalog, runtime, project, dataset, data, sample } = await setup();
    const otherSample = await catalog.createSample(data.dataId);
    const records = [
      makeSampling(project.projectId, sample.sampleId, "sampling-a"),
      makeSampling(project.projectId, otherSample.sampleId, "sampling-b"),
      makeSampling(project.projectId, sample.sampleId, "sampling-c"),
    ];
    for (const [index, record] of records.entries()) {
      await runtime.createRunWithSamplings(makeRun(project.projectId, record, dataset.datasetId), [record], []);
      await runtime.updateSampling({ ...record, execution: { status: index < 2 ? "succeeded" : "failed" } }, record);
    }

    expect(await catalog.listSuccessfulSamplings(project.projectId, { limit: 1 })).toEqual({
      samplings: [{ samplingId: "sampling-a", sampleId: sample.sampleId }],
      nextCursor: "sampling-a",
    });
    expect(await catalog.listSuccessfulSamplings(project.projectId, {
      afterSamplingId: "sampling-a",
      limit: 1,
    })).toEqual({
      samplings: [{ samplingId: "sampling-b", sampleId: otherSample.sampleId }],
      nextCursor: null,
    });
    expect(await catalog.selectAllSuccessfulSamplingIds(project.projectId)).toEqual([
      "sampling-a", "sampling-b",
    ]);
    expect(await catalog.selectAllSuccessfulSamplingIds(project.projectId, {
      sampleId: otherSample.sampleId,
    })).toEqual(["sampling-b"]);
    const foreignCatalog = createPostgresCatalog(database.db, "user-B", {
      async listAgents() { return []; },
    }, release);
    expect(await foreignCatalog.listSuccessfulSamplings(project.projectId)).toEqual({
      samplings: [], nextCursor: null,
    });
    expect(await foreignCatalog.selectAllSuccessfulSamplingIds(project.projectId)).toEqual([]);
  });

  it("serves owner-scoped independent evaluation selection, idempotent admission and results over HTTP", async () => {
    const { project, dataset, sample, runtime } = await setup();
    const sampling = makeSampling(project.projectId, sample.sampleId, "sampling-api-a");
    const secondSampling = makeSampling(project.projectId, sample.sampleId, "sampling-api-b");
    await runtime.createRunWithSamplings(makeRun(project.projectId, sampling, dataset.datasetId), [sampling], []);
    const failed = { ...sampling, execution: { status: "failed" as const } };
    await runtime.updateSampling(failed, sampling);
    await runtime.createRunWithSamplings(makeRun(project.projectId, secondSampling, dataset.datasetId), [secondSampling], []);
    await runtime.updateSampling({ ...secondSampling, execution: { status: "succeeded" } }, secondSampling);
    const staleSelection = { ...sampling, execution: { status: "succeeded" as const } };
    const rejectedEvaluation = makeEvaluation(sampling.samplingId);
    const rejectedRun = makeRun(project.projectId, staleSelection, dataset.datasetId, {
      phases: ["evaluation"], config: evaluationConfig, evaluationIds: [rejectedEvaluation.evaluationId],
      requestIdentity: { idempotencyKey: "stale-selection", requestFingerprint: "stale-selection" },
    });
    await expect(runtime.createRunWithSamplings(rejectedRun, [staleSelection], [rejectedEvaluation]))
      .rejects.toBeInstanceOf(RuntimeEvaluationSelectionError);
    expect(await runtime.getRun(rejectedRun.runId)).toBeNull();
    await runtime.updateSampling({ ...sampling, execution: { status: "succeeded" } }, failed);

    const configs = configStore("user-A");
    const config = await configs.createEvaluationConfig({
      evaluationHarness: {
        kind: "sp", framework: "sp", agentConfig: { ownerUserId: "user-A", userAgentId: "judge" },
      },
      evaluationConcurrency: 1,
    });
    expect(await createPostgresConfigReader(database.db, "user-B").getEvaluationConfig(config.configId)).toBeNull();
    const api = createPostgresIndependentEvaluationApi({
      db: database.db,
      release,
      spClient: {
        async verifySession(token) {
          if (token === "alice-token") return { id: "user-A", role: "user" };
          if (token === "bob-token") return { id: "user-B", role: "user" };
          return null;
        },
      },
    });
    const path = `/api/projects/${project.projectId}`;
    const send = (token: string, suffix: string, init: RequestInit = {}) => api.handle(new Request(`http://eval-api.test${path}${suffix}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    }));
    const selected = await send("alice-token", "/samplings/successful/ids");
    expect(selected.status).toBe(200);
    expect(await selected.json()).toEqual({ samplingIds: [sampling.samplingId, secondSampling.samplingId] });
    expect((await send("bob-token", "/samplings/successful/ids")).status).toBe(404);

    const submitBody = JSON.stringify({
      evaluationConfigId: config.configId,
      samplingIds: [sampling.samplingId, secondSampling.samplingId], idempotencyKey: "first-click",
    });
    const submit = () => send("alice-token", "/evaluations", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: submitBody,
    });
    const [first, parallel] = await Promise.all([submit(), submit()]);
    expect(first.status).toBe(202);
    expect(parallel.status).toBe(202);
    const handle = await first.json() as { runId: string; samplingIds: readonly string[] };
    expect(await parallel.json()).toEqual(handle);
    await configs.updateEvaluationConfig(config.configId, {
      evaluationHarness: config.evaluationHarness, evaluationConcurrency: 2,
    });
    expect(await (await submit()).json()).toEqual(handle);
    const storedRun = await runtime.getRun(handle.runId);
    expect(storedRun?.config.operation).toBe("evaluation");
    expect(storedRun?.config.operation === "evaluation" ? storedRun.config.evaluation.evaluationConcurrency : null).toBe(1);
    expect(storedRun?.evaluationIds).toHaveLength(2);
    const status = await send("alice-token", `/runs/${handle.runId}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ run: expect.objectContaining({
      runId: handle.runId, projectId: project.projectId,
      samplingIds: [sampling.samplingId, secondSampling.samplingId],
      evaluationIds: storedRun!.evaluationIds, phase: "evaluation", status: "queued",
    }) });
    const result = await send("alice-token", `/runs/${handle.runId}/evaluations`);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ evaluations: [
      expect.objectContaining({
        evaluationId: storedRun!.evaluationIds[0], samplingId: sampling.samplingId,
        status: { status: "queued" },
      }),
      expect.objectContaining({
        evaluationId: storedRun!.evaluationIds[1], samplingId: secondSampling.samplingId,
        status: { status: "queued" },
      }),
    ] });
    expect((await send("bob-token", `/runs/${handle.runId}/evaluations`)).status).toBe(404);
    expect((await send("alice-token", "/runs/missing")).status).toBe(404);
    expect((await send("alice-token", "/evaluations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        evaluationConfigId: config.configId, samplingIds: ["missing-sampling"], idempotencyKey: "bad-selection",
      }),
    })).status).toBe(409);
    expect((await send("alice-token", "/evaluations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        evaluationConfigId: "missing", samplingIds: [sampling.samplingId], idempotencyKey: "missing-config",
      }),
    })).status).toBe(404);
    expect((await runtime.listEvaluations(sampling.samplingId))).toHaveLength(1);
    expect((await runtime.listEvaluations(secondSampling.samplingId))).toHaveLength(1);
  });

  it("admits and reads an all-selected Evaluation across SQL batches", async () => {
    const { project, dataset, sample, runtime } = await setup();
    const records = Array.from({ length: 1_001 }, (_, index) => (
      makeSampling(project.projectId, sample.sampleId, `batch-sampling-${index}`)
    ));
    const executionRun = makeRun(project.projectId, records[0]!, dataset.datasetId, {
      samplingIds: records.map((record) => record.samplingId),
    });
    await runtime.createRunWithSamplings(executionRun, records, []);
    await database.db.execute(sql`UPDATE eval_samplings
      SET facts = jsonb_set(facts, '{execution,status}', '"succeeded"'::jsonb)
      WHERE project_id = ${project.projectId}`);
    const config = await configStore("user-A").createEvaluationConfig({
      evaluationHarness: {
        kind: "sp", framework: "sp", agentConfig: { ownerUserId: "user-A", userAgentId: "judge" },
      },
      evaluationConcurrency: 1,
    });
    const api = createPostgresIndependentEvaluationApi({
      db: database.db, release,
      spClient: { async verifySession() { return { id: "user-A", role: "user" }; } },
    });
    const path = `http://eval-api.test/api/projects/${project.projectId}`;
    const headers = { Authorization: "Bearer session" };
    const selection = await api.handle(new Request(`${path}/samplings/successful/ids`, { headers }));
    expect(selection.status).toBe(200);
    const selectedIds = (await selection.json() as { samplingIds: string[] }).samplingIds;
    expect(selectedIds).toHaveLength(records.length);
    const response = await api.handle(new Request(`${path}/evaluations`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        evaluationConfigId: config.configId, samplingIds: selectedIds, idempotencyKey: "batch-evaluation",
      }),
    }));
    expect(response.status).toBe(202);
    const handle = await response.json() as { runId: string; samplingIds: string[] };
    expect(handle.samplingIds).toEqual(selectedIds);
    const view = await createPostgresProjectRunReader(database.db, "user-A")(
      project.projectId, handle.runId,
    );
    expect(view?.run.samplingIds).toEqual(selectedIds);
    expect(view?.run.evaluationIds).toHaveLength(selectedIds.length);
    expect(view?.evaluations).toHaveLength(selectedIds.length);
    expect(view?.evaluations.map((evaluation) => evaluation.samplingId)).toEqual(selectedIds);
  }, 30_000);

  it("rejects an oversized Project all-selection without returning a partial ID list", async () => {
    const { project, sample } = await setup();
    await database.db.execute(sql`INSERT INTO eval_samplings
      (sampling_id, owner_user_id, project_id, sample_id, facts)
      SELECT 'limit-sampling-' || n, 'user-A', ${project.projectId}, ${sample.sampleId},
        '{"execution":{"status":"succeeded"},"subjectAgent":{"ownerUserId":"owner","userAgentId":"subject"},"executionAttempts":[]}'::jsonb
      FROM generate_series(1, 10001) AS n`);
    const api = createPostgresIndependentEvaluationApi({
      db: database.db, release,
      spClient: { async verifySession() { return { id: "user-A", role: "user" }; } },
    });
    const response = await api.handle(new Request(
      `http://eval-api.test/api/projects/${project.projectId}/samplings/successful/ids`,
      { headers: { Authorization: "Bearer session" } },
    ));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: expect.objectContaining({ code: "SELECTION_TOO_LARGE" }) });
  }, 30_000);

  it("admits one independent EvaluationRecord for concurrent requests with the same key", async () => {
    const { runtime, project, dataset, sample } = await setup();
    const sampling = makeSampling(project.projectId, sample.sampleId);
    await runtime.createRunWithSamplings(makeRun(project.projectId, sampling, dataset.datasetId), [sampling], []);
    const succeeded = { ...sampling, execution: { status: "succeeded" as const } };
    await runtime.updateSampling(succeeded, sampling);

    const key = crypto.randomUUID();
    const firstJudge = makeEvaluation(sampling.samplingId);
    const secondJudge = makeEvaluation(sampling.samplingId);
    const evaluationRun = (judge: EvaluationRecord) => makeRun(project.projectId, succeeded, dataset.datasetId, {
      phases: ["evaluation"],
      config: evaluationConfig,
      evaluationIds: [judge.evaluationId],
      requestIdentity: { idempotencyKey: key, requestFingerprint: "same evaluation facts" },
    });
    const [first, concurrent] = await Promise.all([
      runtime.createRunWithSamplings(evaluationRun(firstJudge), [succeeded], [firstJudge]),
      runtime.createRunWithSamplings(evaluationRun(secondJudge), [succeeded], [secondJudge]),
    ]);
    expect(first.run).toEqual(concurrent.run);
    expect([first.created, concurrent.created].filter(Boolean)).toHaveLength(1);
    expect(await runtime.listEvaluations(sampling.samplingId)).toHaveLength(1);

    const changedJudge = makeEvaluation(sampling.samplingId);
    const changed = evaluationRun(changedJudge);
    await expect(runtime.createRunWithSamplings({
      ...changed,
      requestIdentity: { idempotencyKey: key, requestFingerprint: "changed evaluation facts" },
    }, [succeeded], [changedJudge])).rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);
    expect(await runtime.listEvaluations(sampling.samplingId)).toHaveLength(1);

    const deliberateJudge = makeEvaluation(sampling.samplingId);
    const deliberate = evaluationRun(deliberateJudge);
    await expect(runtime.createRunWithSamplings({
      ...deliberate,
      requestIdentity: { idempotencyKey: crypto.randomUUID(), requestFingerprint: "same evaluation facts" },
    }, [succeeded], [deliberateJudge])).rejects.toBeInstanceOf(RuntimeProjectBusyError);
    await runtime.updateEvaluation({ ...firstJudge, status: { status: "succeeded" } }, firstJudge);
    await runtime.createRunWithSamplings({
      ...deliberate,
      requestIdentity: { idempotencyKey: crypto.randomUUID(), requestFingerprint: "same evaluation facts" },
    }, [succeeded], [deliberateJudge]);
    expect(await runtime.listEvaluations(sampling.samplingId)).toHaveLength(2);
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
      const secondProject = await catalog.createProject({ name: "concurrent project" });
      const second = makeSampling(secondProject.projectId, sample.sampleId);
      const firstRun = makeRun(project.projectId, first, dataset.datasetId);
      const secondRun = makeRun(secondProject.projectId, second, dataset.datasetId);
      await runtime.createRunWithSamplings(firstRun, [first], []);
      await runtime.createRunWithSamplings(secondRun, [second], []);
      await vi.waitFor(() => expect(observed).toEqual(expect.arrayContaining([firstRun.runId, secondRun.runId])));

      const ids = [firstRun.runId, secondRun.runId].sort();
      expect(await runtime.listRecoverableRunIds()).toEqual(ids);
      expect(await runtime.listRecoverableRunIds(undefined, 1)).toEqual(ids.slice(0, 1));
      expect(await runtime.listRecoverableRunIds(ids[0], 1)).toEqual(ids.slice(1));

      const succeeded = { ...first, execution: { status: "succeeded" as const } };
      await runtime.updateSampling(succeeded, first);
      const judge = makeEvaluation(first.samplingId);
      const evaluationRun: RuntimeRunRecord = {
        runId: crypto.randomUUID(), projectId: project.projectId,
        sourceCommit: release.sourceCommit,
        samplingIds: [first.samplingId], evaluationIds: [judge.evaluationId],
        phases: ["evaluation"], config: evaluationConfig,
        requestIdentity: { idempotencyKey: crypto.randomUUID(), requestFingerprint: "evaluation facts" },
      };
      await runtime.createRunWithSamplings(evaluationRun, [succeeded], [judge]);
      expect(await runtime.listRecoverableRunIds()).toEqual([secondRun.runId, evaluationRun.runId].sort());

      await runtime.updateSampling({ ...second, execution: { status: "failed" } }, second);
      await runtime.updateEvaluation({ ...judge, status: { status: "succeeded" } }, judge);
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
        await runtime.updateSampling({ ...sampling, execution: { status: "succeeded" } }, sampling);
      }
    });
    const worker = await startEvalRunWorker({
      runtime: { resume }, store: runtime,
      notifications: createPostgresRunNotifications(database.connectionString),
      scanIntervalMs: 60_000,
    });
    try {
      await vi.waitFor(() => expect(resume).toHaveBeenCalledWith(firstRun.runId));
      await vi.waitFor(async () => expect((await runtime.getSampling(first.samplingId))?.execution.status).toBe("succeeded"));
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

  it("rejects stale Sampling and Evaluation replacements after newer facts commit", async () => {
    const { runtime, project, dataset, sample } = await setup();
    const initial = makeSampling(project.projectId, sample.sampleId);
    const judge = makeEvaluation(initial.samplingId);
    const pipeline = makeRun(project.projectId, initial, dataset.datasetId, {
      phases: ["execution", "evaluation"], evaluationIds: [judge.evaluationId],
      config: {
        operation: "pipeline",
        pipeline: { configId: "pipeline-config", executionConfigId: "execution-config", evaluationConfigId: "evaluation-config" },
        execution: executionConfig(dataset.datasetId).execution,
        evaluation: evaluationConfig.evaluation,
      },
    });
    await runtime.createRunWithSamplings(pipeline, [initial], [judge]);

    const completedAttempt: Sampling = {
      ...initial,
      subjectChatId: "subject-chat",
      execution: { status: "running" },
      executionAttempts: [{
        executionAttemptId: "subject-attempt", samplingId: initial.samplingId,
        attemptNumber: 1, submissionId: "subject-submission", status: "completed", completedAt: "2026-10-10T00:00:00.000Z",
        resources: { status: "collected", snapshot: {
          scope: { chatId: "subject-chat", submissionId: "subject-submission", idempotencyKey: "execution:one" },
          observedAt: "2026-10-10T00:00:01.000Z", finalized: false,
          coverage: { usageEvents: "partial", telemetryEvents: "partial", billingSettlements: "partial" },
          usageEvents: [{ eventId: "saved" }], telemetryEvents: [], billingSettlements: [],
        } },
      }],
    };
    await runtime.updateSampling(completedAttempt, initial);
    await expect(runtime.updateSampling({ ...initial, execution: { status: "failed" } }, initial))
      .rejects.toBeInstanceOf(RuntimeRecordConflictError);
    await expect(runtime.updateSampling(completedAttempt, { ...completedAttempt, samplingId: "wrong-sampling" }))
      .rejects.toBeInstanceOf(RuntimeRecordConflictError);
    expect(await runtime.getSampling(initial.samplingId)).toEqual(completedAttempt);

    const completedEvaluation: EvaluationRecord = {
      ...judge, chatId: "judge-chat", status: { status: "running" },
      attempts: [{
        evaluationAttemptId: "judge-attempt", evaluationId: judge.evaluationId,
        attemptNumber: 1, status: "completed", completedAt: "2026-10-10T00:00:00.000Z",
      }],
    };
    await runtime.updateEvaluation(completedEvaluation, judge);
    await expect(runtime.updateEvaluation({ ...judge, status: { status: "failed" } }, judge))
      .rejects.toBeInstanceOf(RuntimeRecordConflictError);
    await expect(runtime.updateEvaluation(completedEvaluation, { ...completedEvaluation, evaluationId: "wrong-evaluation" }))
      .rejects.toBeInstanceOf(RuntimeRecordConflictError);
    expect(await runtime.getEvaluation(judge.evaluationId)).toEqual(completedEvaluation);
  });

  it("retains raw execution and every independent re-evaluation across store instances", async () => {
    const { runtime, source, project, dataset, data, sample } = await setup();
    const original = makeSampling(project.projectId, sample.sampleId);
    const executionRun = makeRun(project.projectId, original, dataset.datasetId);
    await runtime.createRunWithSamplings(executionRun, [original], []);
    const snapshot = {
      scope: { chatId: "subject-chat", submissionId: "subject-submission", idempotencyKey: "execute:1" },
      observedAt: "2026-10-09T01:00:00.000Z", finalized: true,
      coverage: { usageEvents: "complete", telemetryEvents: "complete", billingSettlements: "complete" } as const,
      usageEvents: [{ eventId: "one", value: { source: null } }, { eventId: "one", value: { source: null } }],
      telemetryEvents: [], billingSettlements: [],
    };
    const finished: Sampling = {
      ...original, execution: { status: "succeeded" }, subjectChatId: "subject-chat",
      executionAttempts: [{ executionAttemptId: "subject-attempt", samplingId: original.samplingId,
        attemptNumber: 1, submissionId: "subject-submission", status: "completed",
        resources: { status: "collected", snapshot } }],
      artifacts: [{ artifactId: "page", kind: "file", path: "/workspace/page.html" }],
      trajectory: { trajectoryId: "full", source: "subject", path: "/workspace/trajectory.json" },
    };
    await runtime.updateSampling(finished, original);
    const firstJudge = makeEvaluation(original.samplingId);
    const firstRun = makeRun(project.projectId, finished, dataset.datasetId, {
      phases: ["evaluation"], evaluationIds: [firstJudge.evaluationId], config: evaluationConfig,
    });
    await runtime.createRunWithSamplings(firstRun, [finished], [firstJudge]);
    const completed = {
      ...firstJudge, status: { status: "succeeded" as const },
      attempts: [{ evaluationAttemptId: "judge-attempt", evaluationId: firstJudge.evaluationId,
        attemptNumber: 1, status: "completed" as const }],
      output: { status: "succeeded" as const, score: 92, reason: "good", artifacts: [],
        trajectory: { trajectoryId: "judge-trace", source: "evaluator" as const, path: "/judge/trace.json" } },
    };
    await runtime.updateEvaluation(completed, firstJudge);
    const secondJudge = makeEvaluation(original.samplingId);
    const secondRun = makeRun(project.projectId, original, dataset.datasetId, {
      phases: ["evaluation"], evaluationIds: [secondJudge.evaluationId], config: evaluationConfig,
    });
    await runtime.createRunWithSamplings(secondRun, [original], [secondJudge]);
    const restored = createPostgresWorkerRuntimeStore(database.db);
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
    const { catalog, runtime, source, project, dataset, sample } = await setup();
    const record = makeSampling(project.projectId, sample.sampleId);
    const judge = makeEvaluation(record.samplingId);
    const pipeline = makeRun(project.projectId, record, dataset.datasetId, {
      phases: ["execution", "evaluation"], evaluationIds: [judge.evaluationId],
      config: { operation: "pipeline", pipeline: {
        configId: "pipeline-config", executionConfigId: "execution-config", evaluationConfigId: "evaluation-config",
      }, execution: executionConfig(dataset.datasetId).execution, evaluation: evaluationConfig.evaluation },
    });
    await runtime.createRunWithSamplings(pipeline, [record], [judge]);
    expect(await catalog.getProject(project.projectId)).toMatchObject({
      initialLaunch: { operation: "pipeline", configId: "pipeline-config" },
    });
    expect((await source.read({ projectId: project.projectId })).runs[0]?.sourceCommit).toBe(release.sourceCommit);
    expect((await source.read({ projectId: project.projectId })).runs[0]).toMatchObject({ phase: "execution", status: "queued" });
    await runtime.updateSampling({ ...record, execution: { status: "running" } }, record);
    expect((await source.read({ projectId: project.projectId })).runs[0]).toMatchObject({ phase: "execution", status: "running" });
    await runtime.updateSampling({ ...record, execution: { status: "succeeded" } }, (await runtime.getSampling(record.samplingId))!);
    expect((await source.read({ projectId: project.projectId })).runs[0]).toMatchObject({ phase: "evaluation", status: "running" });
    await runtime.updateEvaluation({ ...judge, status: { status: "succeeded" } }, judge);
    expect((await source.read({ projectId: project.projectId })).runs[0]).toMatchObject({ phase: "evaluation", status: "succeeded" });
  });

  it("keeps Project and selected Run boundaries across user-owned Datasets", async () => {
    const { runtime, catalog, source, project, dataset, sample } = await setup();
    const otherCatalog = createPostgresCatalog(database.db, "user-B", { async listAgents() { return []; } }, release);
    const otherService = createDatasetService(createPostgresDatasetStore(database.db, "user-B"));
    const other = await otherCatalog.createProject({ name: "other" });
    const otherDataset = await otherService.createDataset({ name: "other data" });
    const otherData = await otherService.createData({ userPrompt: "other task" });
    await otherService.attachData(otherDataset.datasetId, [otherData.dataId]);
    const otherSample = await otherCatalog.createSample(otherData.dataId);
    const foreignSampling = makeSampling(other.projectId, sample.sampleId);
    await expect(runtime.createRunWithSamplings(
      makeRun(other.projectId, foreignSampling, otherDataset.datasetId), [foreignSampling], [],
    )).rejects.toThrow("outside its Project owner scope");
    const samplingA = makeSampling(project.projectId, sample.sampleId);
    const samplingB = makeSampling(other.projectId, otherSample.sampleId);
    const runA = makeRun(project.projectId, samplingA, dataset.datasetId);
    const runB = makeRun(other.projectId, samplingB, otherDataset.datasetId);
    await runtime.createRunWithSamplings(runA, [samplingA], []);
    await runtime.createRunWithSamplings(runB, [samplingB], []);
    await expectForeignKeyFailure(database.db.execute(sql`
      INSERT INTO eval_samplings (sampling_id, owner_user_id, project_id, sample_id, facts)
      VALUES (${crypto.randomUUID()}, ${"user-A"}, ${project.projectId}, ${otherSample.sampleId}, '{}'::jsonb)
    `));
    await expectForeignKeyFailure(database.db.execute(sql`
      INSERT INTO eval_runs (run_id, owner_user_id, project_id, source_commit, phases, config, idempotency_key, request_fingerprint)
      VALUES (${crypto.randomUUID()}, ${"user-A"}, ${other.projectId}, ${release.sourceCommit}, '["execution"]'::jsonb, '{}'::jsonb,
        ${crypto.randomUUID()}, ${"foreign project"})
    `));
    await expectForeignKeyFailure(database.db.execute(sql`
      INSERT INTO eval_run_samplings (owner_user_id, run_id, sampling_id, position)
      VALUES (${"user-A"}, ${runA.runId}, ${samplingB.samplingId}, ${1})
    `));
    const userRuntime = createPostgresRuntimeStore(database.db, "user-A", release);
    const otherRuntime = createPostgresRuntimeStore(database.db, "user-B", release);
    expect("listRecoverableRunIds" in userRuntime).toBe(false);
    expect(await userRuntime.getRun(runA.runId)).toEqual(runA);
    expect(await userRuntime.getRun(runB.runId)).toBeNull();
    expect(await userRuntime.getSampling(samplingB.samplingId)).toBeNull();
    expect(await userRuntime.getSamplings([samplingB.samplingId, samplingA.samplingId, "missing"])).toEqual([
      null, samplingA, null,
    ]);
    expect(await catalog.getSamples([otherSample.sampleId, sample.sampleId, "missing"])).toEqual([
      null, sample, null,
    ]);
    expect(await userRuntime.findRunByIdempotencyKey(other.projectId, runB.requestIdentity.idempotencyKey)).toBeNull();
    expect(await otherRuntime.getRun(runB.runId)).toEqual(runB);
    await expect(userRuntime.updateSampling(samplingB, samplingB)).rejects.toBeInstanceOf(RuntimeRecordConflictError);
    await expect(userRuntime.createRunWithSamplings(runB, [samplingB], [])).rejects.toThrow("Unknown Project");
    await runtime.updateSampling({ ...samplingA, execution: { status: "succeeded" } }, samplingA);
    const collisionSampling = makeSampling(project.projectId, sample.sampleId);
    const collision = makeRun(project.projectId, collisionSampling, dataset.datasetId, {
      requestIdentity: runB.requestIdentity,
    });
    await expect(userRuntime.createRunWithSamplings(collision, [collisionSampling], []))
      .resolves.toEqual({ run: collision, created: true });
    expect(await userRuntime.findRunByIdempotencyKey(project.projectId, runB.requestIdentity.idempotencyKey))
      .toEqual(collision);
    expect(await otherRuntime.findRunByIdempotencyKey(other.projectId, runB.requestIdentity.idempotencyKey))
      .toEqual(runB);
    expect(await runtime.listRecoverableRunIds()).toContain(runB.runId);
    const siblingProject = await catalog.createProject({ name: "same owner's other project" });
    const siblingSampling = makeSampling(siblingProject.projectId, sample.sampleId);
    const siblingRun = makeRun(siblingProject.projectId, siblingSampling, dataset.datasetId, {
      requestIdentity: runA.requestIdentity,
    });
    await expect(userRuntime.createRunWithSamplings(siblingRun, [siblingSampling], []))
      .resolves.toEqual({ run: siblingRun, created: true });
    expect(await readRunRecords(database.db, [siblingRun.runId], {
      kind: "project", ownerUserId: "user-A", projectId: project.projectId,
    })).toEqual([]);
    expect(await readRunRecords(database.db, [siblingRun.runId], {
      kind: "project", ownerUserId: "user-A", projectId: siblingProject.projectId,
    })).toEqual([siblingRun]);
    await expect(source.read({ projectId: other.projectId })).rejects.toBeInstanceOf(MetricsQueryError);
    const facts = await source.read({ projectId: project.projectId, runIds: [runA.runId] });
    expect(facts.samplings.map((record) => record.samplingId)).toEqual([samplingA.samplingId]);
    expect(facts.runs.map((run) => run.runId)).toEqual([runA.runId]);
    await expect(source.read({ projectId: project.projectId, runIds: [runB.runId] }))
      .rejects.toBeInstanceOf(MetricsQueryError);
    await expect(source.read({ projectId: project.projectId, runIds: [siblingRun.runId] }))
      .rejects.toBeInstanceOf(MetricsQueryError);
  });

  it("scopes Evaluation reads and updates to the owning user", async () => {
    const { runtime, project, dataset, sample } = await setup();
    const record = makeSampling(project.projectId, sample.sampleId);
    const judge = makeEvaluation(record.samplingId);
    const pipeline = makeRun(project.projectId, record, dataset.datasetId, {
      phases: ["execution", "evaluation"], evaluationIds: [judge.evaluationId],
      config: { operation: "pipeline", pipeline: {
        configId: "pipeline-config", executionConfigId: "execution-config", evaluationConfigId: "evaluation-config",
      }, execution: executionConfig(dataset.datasetId).execution, evaluation: evaluationConfig.evaluation },
    });
    await runtime.createRunWithSamplings(pipeline, [record], [judge]);
    const userRuntime = createPostgresRuntimeStore(database.db, "user-A", release);
    const foreignRuntime = createPostgresRuntimeStore(database.db, "user-B", release);
    expect(await userRuntime.getEvaluation(judge.evaluationId)).toEqual(judge);
    expect(await userRuntime.getEvaluations(["missing", judge.evaluationId])).toEqual([null, judge]);
    expect(await userRuntime.listEvaluations(record.samplingId)).toEqual([judge]);
    expect(await foreignRuntime.getEvaluation(judge.evaluationId)).toBeNull();
    expect(await foreignRuntime.getEvaluations([judge.evaluationId])).toEqual([null]);
    expect(await foreignRuntime.listEvaluations(record.samplingId)).toEqual([]);
    await expect(foreignRuntime.updateEvaluation(judge, judge)).rejects.toBeInstanceOf(RuntimeRecordConflictError);
  });
});
