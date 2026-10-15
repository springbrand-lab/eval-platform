import { createDatasetService, DatasetEntityNotFoundError, type Data } from "@eval-platform/eval-dataset";
import { createMetrics, MetricsEntityNotFoundError } from "@eval-platform/eval-metrics";
import {
  digestExecutionPlan,
  RuntimeEntityNotFoundError,
  RuntimeProjectBusyError,
  type EvalRunAdmission,
} from "@eval-platform/eval-runtime";
import { count, eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgentConfigService } from "../agent-configs.js";
import { createOwnerServices } from "../owner-services.js";
import { createProjectService } from "../projects/service.js";
import { createRunQueue, openRunBoss, RUN_QUEUE, type RunQueue } from "../run-worker-queue.js";
import type { BundleDirectory } from "../sp/bundle-directory.js";
import { authorized, jsonRequest, requestApp, WEB_ORIGIN } from "../test-support.js";
import type { PgBoss } from "pg-boss";
import { createPostgresDatasetStore } from "./dataset.js";
import {
  AgentConfigFrozenError,
  OutputSchemaNotFoundError,
  ProjectEvaluationPlanLockedError,
  ProjectIdempotencyConflictError,
  ProjectInputError,
} from "./errors.js";
import { createPostgresMetricsSource } from "./metrics.js";
import { createPostgresObservationReader } from "./observation.js";
import { createOutputSchemaCatalog } from "./output-schemas.js";
import { createPostgresProjectPlanReader } from "./project-plans.js";
import { EvalSpApiError } from "../sp/client.js";
import { createPostgresProjectStore } from "./project-store.js";
import { createPostgresProjectRunReader } from "./run-view.js";
import { createPostgresProjectRunControl, createPostgresRuntimeStore, createPostgresWorkerRuntimeStore } from "./runtime.js";
import { createPostgresRuntimeQueries } from "./runtime-queries.js";
import {
  projectAgentConfigs,
  projectDatasets,
  projectEvaluationPlans,
  projectExecutionPlans,
  projects,
  projectSampleDatasets,
  projectSamples,
  runs,
} from "./schema.js";
import { createTestDatabase } from "./test-database.js";
import { buildCommand, createStubSp, makeData, release, seedProject, settle } from "./test-fixtures.js";

const connection = process.env.DATABASE_URL;
const silent = pino({ level: "silent" });
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const scoreSchema = JSON.stringify({ type: "object", properties: { score: { type: "number" } } });

describe.skipIf(!connection)("PostgreSQL Project snapshots, evaluation plans, Metrics and observation", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let jobs: PgBoss;
  let runQueue: RunQueue;
  let stub: ReturnType<typeof createStubSp>;

  beforeAll(async () => {
    database = await createTestDatabase(connection!);
    jobs = await openRunBoss(database.connectionString, silent, { supervise: false });
    runQueue = createRunQueue(jobs);
  }, 30_000);

  beforeEach(async () => {
    await database.db.execute(sql`TRUNCATE TABLE eval_projects, eval_evaluation_output_schemas, eval_datasets, eval_data RESTART IDENTITY CASCADE`);
    await jobs.deleteAllJobs(RUN_QUEUE);
    stub = createStubSp();
  });

  afterAll(async () => {
    await jobs?.stop();
    if (database) await database.destroy();
  }, 30_000);

  /** Store-level admission built from the persisted plan, independent of the Runtime package. */
  function planAdmission(owner: string): EvalRunAdmission {
    const plans = createPostgresProjectPlanReader(database.db, owner);
    const store = createPostgresRuntimeStore(database.db, owner, release, runQueue);
    return {
      async preview({ projectId, operation, selector }) {
        const command = await buildCommand(plans, store, { projectId, operation });
        return {
          projectId, operation, selector, targets: command.run.targets,
          replacedSamplingCount: command.replacedSamplingIds.length, newSamplingCount: command.samplings.length,
          evaluationCount: command.evaluations.length, executionPlanDigest: command.run.planDigests.execution,
          evaluationPlanDigest: command.run.planDigests.evaluation ?? null,
        };
      },
      async submit({ projectId, operation, targets, idempotencyKey, selector }) {
        const command = await buildCommand(plans, store, {
          projectId, operation, projectSampleIds: targets.projectSampleIds, samplingIds: targets.samplingIds, idempotencyKey, selector,
        });
        const { run } = await store.admitRun(command);
        return { runId: run.runId, samplingIds: [...run.samplingIds] };
      },
    };
  }

  function services(owner = OWNER, admission: EvalRunAdmission = planAdmission(owner)) {
    const db = database.db;
    const store = createPostgresProjectStore(db, owner);
    const outputSchemas = createOutputSchemaCatalog(db, owner);
    const agentConfigs = createAgentConfigService({ ownerUserId: owner, sessionToken: owner, sp: stub.sp, projects: store });
    return {
      store, outputSchemas, agentConfigs,
      projects: createProjectService({ ownerUserId: owner, sourceBranch: release.sourceBranch, store, outputSchemas, agentConfigs, admission }),
      datasets: createDatasetService(createPostgresDatasetStore(db, owner)),
      plans: createPostgresProjectPlanReader(db, owner),
      runtime: createPostgresRuntimeStore(db, owner, release, runQueue),
      worker: createPostgresWorkerRuntimeStore(db, runQueue),
      source: createPostgresMetricsSource(db, owner),
      observations: createPostgresObservationReader(db, owner),
      results: createPostgresRuntimeQueries(db, owner),
      control: createPostgresProjectRunControl(db, owner, runQueue),
      runReader: createPostgresProjectRunReader(db, owner),
    };
  }

  async function catalog(owner = OWNER) {
    const { datasets, outputSchemas } = services(owner);
    const data = await Promise.all([1, 2, 3].map((index) => datasets.createData({ userPrompt: `task ${index}`, evalPrompt: "judge" })));
    const [d1, d2, d3] = data.sort((left, right) => left.dataId.localeCompare(right.dataId)) as [Data, Data, Data];
    const first = await datasets.createDataset({ name: "First", description: "first set" });
    const second = await datasets.createDataset({ name: "Second" });
    await datasets.attachData(first.datasetId, [d1.dataId, d2.dataId]);
    await datasets.attachData(second.datasetId, [d2.dataId, d3.dataId]);
    const schema = await outputSchemas.create({ name: "Score", description: "Score", content: scoreSchema });
    return {
      d1, d2, d3, first, second, schema,
      subject: stub.seed(owner, "Subject"),
      evaluator: stub.seed(owner, "Evaluator"),
    };
  }

  async function projectRowCounts(projectId: string): Promise<number[]> {
    return Promise.all([projects, projectDatasets, projectSamples, projectSampleDatasets, projectExecutionPlans,
      projectEvaluationPlans, projectAgentConfigs].map(async (table) => (
      await database.db.select({ n: count() }).from(table).where(eq(table.projectId, projectId))
    )[0]!.n));
  }

  it("snapshots Datasets, shared Data and frozen Agent Configs, unaffected by later catalog edits and soft deletes", async () => {
    const { d1, d2, d3, first, second, subject } = await catalog();
    const { projects: service, datasets } = services();
    const { project, run } = await service.create({
      name: "Snapshot", description: "fixed",
      datasets: [{ datasetId: first.datasetId }, { datasetId: second.datasetId, dataIds: [d2.dataId] }],
      samplingCount: 1, samplingCounts: { [d2.dataId]: 3 },
      execution: { userAgentId: subject, framework: "sp", executionConcurrency: 2, timeoutMs: 60_000 },
      idempotencyKey: "create", run: { operation: "execution" },
    });
    expect(run.samplingIds).toHaveLength(4);
    const view = (await service.get(project.projectId))!;
    expect(view.project).toEqual(project);
    const [ps1, ps2] = view.projectSamples;
    expect(view.projectSamples).toHaveLength(2);
    expect(ps1).toMatchObject({ dataId: d1.dataId, datasetIds: [first.datasetId], samplingCount: 1, data: d1 });
    expect(ps2).toMatchObject({ dataId: d2.dataId, datasetIds: [first.datasetId, second.datasetId], samplingCount: 3, data: d2 });
    expect(view.datasets).toEqual([
      { datasetId: first.datasetId, name: "First", description: "first set", kind: "general", projectSampleIds: [ps1!.projectSampleId, ps2!.projectSampleId] },
      { datasetId: second.datasetId, name: "Second", kind: "general", projectSampleIds: [ps2!.projectSampleId] },
    ]);
    expect(view.evaluation).toBeNull();
    expect(view.currentRun).toEqual({ runId: run.runId });

    const [copyBody] = stub.calls.created;
    expect(copyBody).toEqual({
      slug: expect.stringMatching(/^eval-frozen-[0-9a-f-]{36}$/u), name: "Subject (frozen)",
      description: "Subject description", setting: { model: "Subject" },
    });
    const copyId = view.execution.harness.agentConfig.userAgentId;
    expect(copyId).not.toBe(subject);
    expect(view.execution).toMatchObject({
      harness: { kind: "sp", framework: "sp", agentConfig: { ownerUserId: OWNER, userAgentId: copyId }, runtime: { timeoutMs: 60_000 } },
      executionConcurrency: 2,
      subjectAgentConfig: { sourceUserAgentId: subject, name: "Subject", body: { id: subject, setting: { model: "Subject" } } },
    });
    expect(view.executionPlanDigest).toBe(await digestExecutionPlan({
      execution: view.execution, datasets: view.datasets, samples: view.projectSamples,
    }));

    await datasets.updateData(d1.dataId, { userPrompt: "changed" });
    await datasets.updateDataset(first.datasetId, { name: "Renamed" });
    await datasets.detachData(second.datasetId, [d2.dataId]);
    await stub.sp.updateAgentConfig(OWNER, subject, { setting: { model: "changed" } });
    await datasets.deleteDataset(first.datasetId);
    await datasets.deleteDataset(second.datasetId);
    for (const record of [d1, d2, d3]) await datasets.deleteData(record.dataId);
    const after = (await service.get(project.projectId))!;
    expect({ ...after, currentRun: null }).toEqual({ ...view, currentRun: null });
    expect(stub.configs.get(copyId)?.setting).toEqual({ model: "Subject" });
  });

  it("rejects invalid selections before any SP copy is made", async () => {
    const { d1, d3, first, second, subject, schema } = await catalog();
    const { projects: service, datasets, outputSchemas } = services();
    const body = {
      name: "Invalid", datasets: [{ datasetId: first.datasetId }], samplingCount: 1,
      execution: { userAgentId: subject, framework: "sp" as const, executionConcurrency: 1 },
      idempotencyKey: "k", run: { operation: "execution" as const },
    };
    await expect(service.create({ ...body, datasets: [{ datasetId: first.datasetId, dataIds: [d3.dataId] }] }))
      .rejects.toMatchObject({ name: "ProjectInputError", field: "datasets.0.dataIds" });
    await expect(service.create({ ...body, samplingCounts: { [d3.dataId]: 2 } })).rejects.toBeInstanceOf(ProjectInputError);
    await expect(service.create({ ...body, idempotencyKey: "k", run: { operation: "pipeline" } })).rejects.toBeInstanceOf(ProjectInputError);
    const empty = await datasets.createDataset({ name: "Empty" });
    await expect(service.create({ ...body, datasets: [{ datasetId: empty.datasetId }] })).rejects.toBeInstanceOf(ProjectInputError);
    await expect(services(OTHER).projects.create(body)).rejects.toBeInstanceOf(DatasetEntityNotFoundError);
    await datasets.deleteDataset(second.datasetId);
    await expect(service.create({ ...body, datasets: [{ datasetId: second.datasetId }] })).rejects.toBeInstanceOf(DatasetEntityNotFoundError);
    await outputSchemas.delete(schema.outputSchemaId);
    await expect(service.create({
      ...body, evaluation: { userAgentId: subject, evaluationConcurrency: 1, outputSchemaId: schema.outputSchemaId },
    })).rejects.toBeInstanceOf(OutputSchemaNotFoundError);
    expect(stub.sp.createAgentConfig).not.toHaveBeenCalled();
    expect(await service.list()).toEqual([]);
    await expect(service.create({ ...body, datasets: [{ datasetId: first.datasetId, dataIds: [d1.dataId, d1.dataId.toUpperCase()] }] }))
      .rejects.toBeInstanceOf(ProjectInputError);
  });

  it("compensates a failed creation: no Project rows remain and SP copies are deleted", async () => {
    const { first, subject, evaluator, schema } = await catalog();
    const failing: EvalRunAdmission = {
      preview: planAdmission(OWNER).preview,
      async submit() { throw new RuntimeProjectBusyError("p", "r"); },
    };
    const { projects: service, agentConfigs } = services(OWNER, failing);
    const body = {
      name: "Doomed", datasets: [{ datasetId: first.datasetId }], samplingCount: 1,
      execution: { userAgentId: subject, framework: "sp" as const, executionConcurrency: 1 },
      evaluation: { userAgentId: evaluator, evaluationConcurrency: 1, outputSchemaId: schema.outputSchemaId },
      idempotencyKey: "k", run: { operation: "pipeline" as const },
    };
    await expect(service.create(body)).rejects.toBeInstanceOf(RuntimeProjectBusyError);
    const copies = await Promise.all(stub.sp.createAgentConfig.mock.results.map(async (result) => (await result.value).id));
    expect(copies).toHaveLength(2);
    expect([...stub.calls.deleted].sort()).toEqual([...copies].sort());
    expect((await database.db.select({ n: count() }).from(projects))[0]!.n).toBe(0);
    expect((await database.db.select({ n: count() }).from(projectAgentConfigs))[0]!.n).toBe(0);
    expect((await agentConfigs.list()).map((config) => config.id).sort()).toEqual([subject, evaluator].sort());

    stub.sp.getAgentConfig.mockImplementation(async (_token: string, id: string) => {
      if (id === evaluator) throw new EvalSpApiError(404, null);
      return structuredClone(stub.configs.get(id)!);
    });
    await expect(services().projects.create(body)).rejects.toBeInstanceOf(EvalSpApiError);
    expect(stub.calls.created).toHaveLength(3);
    expect(stub.calls.deleted).toHaveLength(3);
    expect(await services().projects.list()).toEqual([]);
  });

  describe("idempotent creation", () => {
    async function creationBody() {
      const { first, subject } = await catalog();
      return {
        idempotencyKey: "create-once", name: "Once", datasets: [{ datasetId: first.datasetId }], samplingCount: 1,
        execution: { userAgentId: subject, framework: "sp" as const, executionConcurrency: 1 },
        run: { operation: "execution" as const },
      };
    }
    const copyIds = async () => Promise.all(stub.sp.createAgentConfig.mock.results.map(async (result) => (await result.value).id as string));

    it("replays the same body without new SP copies and rejects a different body under the key", async () => {
      const body = await creationBody();
      const { projects: service } = services();
      const created = await service.create(body);
      const replayed = await service.create(body);
      expect(replayed).toEqual(created);
      expect(stub.sp.createAgentConfig).toHaveBeenCalledTimes(1);
      await expect(service.create({ ...body, samplingCount: 2 })).rejects.toBeInstanceOf(ProjectIdempotencyConflictError);
      await expect(service.create({ ...body, run: { operation: "pipeline" } })).rejects.toBeInstanceOf(ProjectInputError);
      expect(await service.list()).toHaveLength(1);
      expect((await database.db.select({ n: count() }).from(runs))[0]!.n).toBe(1);
    });

    it("keeps one Project, one first Run and one set of copies when identical requests race", async () => {
      const body = await creationBody();
      let arrived = 0;
      let open!: () => void;
      const barrier = new Promise<void>((resolve) => { open = resolve; });
      const create = stub.sp.createAgentConfig.getMockImplementation()!;
      stub.sp.createAgentConfig.mockImplementation(async (token: string, input: unknown) => {
        arrived += 1;
        if (arrived === 2) open();
        await barrier;
        return create(token, input);
      });
      const [left, right] = await Promise.all([services().projects.create(body), services().projects.create(body)]);
      expect(left).toEqual(right);
      expect((await database.db.select({ n: count() }).from(projects))[0]!.n).toBe(1);
      expect((await database.db.select({ n: count() }).from(runs))[0]!.n).toBe(1);
      const copies = await copyIds();
      expect(copies).toHaveLength(2);
      const kept = (await database.db.select().from(projectAgentConfigs)).map((row) => row.userAgentId);
      expect(kept).toHaveLength(1);
      expect(stub.calls.deleted).toEqual(copies.filter((id) => !kept.includes(id)));
      expect(stub.configs.has(kept[0]!)).toBe(true);
    });

    it("finishes the first Run on replay after a crash between the creation transaction and admission", async () => {
      const body = await creationBody();
      const crashed = services(OWNER, { preview: planAdmission(OWNER).preview, async submit() { throw new Error("process crashed"); } });
      const crashingStore = { ...crashed.store, deleteUnrun: async () => null };
      const service = createProjectService({
        ownerUserId: OWNER, sourceBranch: release.sourceBranch, store: crashingStore,
        outputSchemas: crashed.outputSchemas, agentConfigs: crashed.agentConfigs,
        admission: { preview: planAdmission(OWNER).preview, async submit() { throw new Error("process crashed"); } },
      });
      await expect(service.create(body)).rejects.toThrow("process crashed");
      const [orphan] = await services().projects.list();
      expect(orphan).toBeDefined();
      const { project, run } = await services().projects.create(body);
      expect(project).toEqual(orphan);
      expect(run.samplingIds).toHaveLength(2);
      expect(stub.sp.createAgentConfig).toHaveBeenCalledTimes(1);
      expect(await services().projects.create(body)).toEqual({ project, run });
    });

    it("never resurrects a deleted creation and starts afresh after a compensated failure", async () => {
      const body = await creationBody();
      const failing = services(OWNER, { preview: planAdmission(OWNER).preview, async submit() { throw new RuntimeProjectBusyError("p", "r"); } });
      await expect(failing.projects.create(body)).rejects.toBeInstanceOf(RuntimeProjectBusyError);
      expect(await services().projects.list()).toEqual([]);
      const { projects: service, worker } = services();
      const { project, run } = await service.create(body);
      await settle(worker, run.samplingIds, "succeeded");
      await service.delete(project.projectId);
      await expect(service.create(body)).rejects.toMatchObject({ name: "RuntimeEntityNotFoundError", entity: "project" });
      await expect(service.create({ ...body, name: "Other" })).rejects.toBeInstanceOf(ProjectIdempotencyConflictError);
      const other = await services(OTHER).projects.create({ ...body, datasets: [{ datasetId: (await catalog(OTHER)).first.datasetId }],
        execution: { ...body.execution, userAgentId: stub.seed(OTHER, "Other subject") } });
      expect(other.project.projectId).not.toBe(project.projectId);
    });
  });

  it("replaces the evaluation plan until the first evaluating Run locks it, retiring and hiding old copies", async () => {
    const { first, subject, evaluator, schema } = await catalog();
    const { projects: service, agentConfigs, worker, runtime, plans } = services();
    const { project, run } = await service.create({
      name: "Later evaluation", datasets: [{ datasetId: first.datasetId }], samplingCount: 1,
      execution: { userAgentId: subject, framework: "sp", executionConcurrency: 1 },
      idempotencyKey: "create", run: { operation: "execution" },
    });
    const plan = { userAgentId: evaluator, evaluationConcurrency: 2, outputSchemaId: schema.outputSchemaId };
    const firstView = await service.replaceEvaluationPlan(project.projectId, plan);
    const firstCopy = firstView.evaluation!.evaluationHarness.agentConfig.userAgentId;
    expect(firstView.evaluation).toMatchObject({
      evaluatorAgentConfig: { sourceUserAgentId: evaluator, name: "Evaluator" },
      outputSchema: { outputSchemaId: schema.outputSchemaId, digest: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      evaluationConcurrency: 2,
    });
    expect(firstView.evaluationPlanLockedAt).toBeNull();
    const secondView = await service.replaceEvaluationPlan(project.projectId, { ...plan, evaluationConcurrency: 3 });
    const secondCopy = secondView.evaluation!.evaluationHarness.agentConfig.userAgentId;
    expect(secondCopy).not.toBe(firstCopy);
    expect(secondView.evaluationPlanDigest).not.toBe(firstView.evaluationPlanDigest);
    expect(stub.calls.deleted).toEqual([firstCopy]);
    const rows = await database.db.select().from(projectAgentConfigs).where(eq(projectAgentConfigs.projectId, project.projectId));
    expect(rows.find((row) => row.userAgentId === firstCopy)?.retiredAt).toBeInstanceOf(Date);
    expect(rows.find((row) => row.userAgentId === secondCopy)?.retiredAt).toBeNull();

    const subjectCopy = firstView.execution.harness.agentConfig.userAgentId;
    expect((await agentConfigs.list()).map((config) => config.id).sort()).toEqual([subject, evaluator].sort());
    expect((await agentConfigs.listAgents("evaluator")).map((agent) => agent.agentConfig.userAgentId).sort()).toEqual([subject, evaluator].sort());
    await expect(agentConfigs.update(subjectCopy, { name: "edit" })).rejects.toBeInstanceOf(AgentConfigFrozenError);
    await expect(agentConfigs.remove(secondCopy)).rejects.toBeInstanceOf(AgentConfigFrozenError);
    await expect(agentConfigs.remove(firstCopy)).rejects.toBeInstanceOf(AgentConfigFrozenError);
    await expect(service.create({
      name: "From copy", datasets: [{ datasetId: first.datasetId }], samplingCount: 1,
      execution: { userAgentId: subjectCopy, framework: "sp", executionConcurrency: 1 },
      idempotencyKey: "copy", run: { operation: "execution" },
    })).rejects.toBeInstanceOf(AgentConfigFrozenError);
    expect((await agentConfigs.get(subjectCopy)).id).toBe(subjectCopy);

    await settle(worker, run.samplingIds, "succeeded");
    const evaluation = await buildCommand(plans, runtime, { projectId: project.projectId, operation: "evaluation" });
    await runtime.admitRun(evaluation);
    expect((await service.get(project.projectId))!.evaluationPlanLockedAt).toEqual(expect.any(String));
    const created = stub.calls.created.length;
    await expect(service.replaceEvaluationPlan(project.projectId, plan)).rejects.toBeInstanceOf(ProjectEvaluationPlanLockedError);
    expect(stub.calls.created).toHaveLength(created);
  });

  it("deletes the new Evaluator copy when a concurrent admission locked the plan first", async () => {
    const seeded = await seedProject(database.db, OWNER, { datasets: [{ data: [makeData()] }], evaluation: true });
    const { evaluator, schema } = await catalog();
    const { store } = services();
    const racing = { ...store, requireEvaluationPlanEditable: async () => undefined };
    const service = createProjectService({
      ownerUserId: OWNER, sourceBranch: release.sourceBranch, store: racing,
      outputSchemas: createOutputSchemaCatalog(database.db, OWNER),
      agentConfigs: createAgentConfigService({ ownerUserId: OWNER, sessionToken: OWNER, sp: stub.sp, projects: store }),
      admission: planAdmission(OWNER),
    });
    await database.db.update(projectEvaluationPlans).set({ lockedAt: new Date() }).where(eq(projectEvaluationPlans.projectId, seeded.projectId));
    await expect(service.replaceEvaluationPlan(seeded.projectId, { userAgentId: evaluator, evaluationConcurrency: 1, outputSchemaId: schema.outputSchemaId }))
      .rejects.toBeInstanceOf(ProjectEvaluationPlanLockedError);
    const [copy] = await Promise.all(stub.sp.createAgentConfig.mock.results.map(async (result) => (await result.value).id));
    expect(stub.calls.deleted).toEqual([copy]);
    expect((await database.db.select().from(projectAgentConfigs).where(eq(projectAgentConfigs.projectId, seeded.projectId)))
      .map((row) => row.userAgentId)).not.toContain(copy);
  });

  it("soft-deletes only Projects without an active Run, then hides them everywhere", async () => {
    const seeded = await seedProject(database.db, OWNER, { datasets: [{ data: [makeData()] }], evaluation: true });
    const s = services();
    const { run } = await s.runtime.admitRun(await buildCommand(s.plans, s.runtime, { projectId: seeded.projectId, operation: "pipeline" }));
    await expect(s.projects.delete(seeded.projectId)).rejects.toBeInstanceOf(RuntimeProjectBusyError);
    await settle(s.worker, run.samplingIds, "succeeded");
    const later = await buildCommand(s.plans, s.runtime, { projectId: seeded.projectId, operation: "execution" });
    await expect(services(OTHER).projects.delete(seeded.projectId)).rejects.toBeInstanceOf(RuntimeEntityNotFoundError);
    await s.projects.delete(seeded.projectId);
    const [samplingId] = run.samplingIds;
    expect(await s.projects.get(seeded.projectId)).toBeNull();
    expect(await s.projects.exists(seeded.projectId)).toBe(false);
    expect(await s.projects.list()).toEqual([]);
    expect(await s.plans.getProjectPlan(seeded.projectId)).toBeNull();
    expect(await s.plans.getProjectSamples(seeded.projectId, [seeded.samples[0]!.projectSampleId])).toEqual([null]);
    expect(await s.runReader(seeded.projectId, run.runId)).toBeNull();
    expect(await s.control.stopRun(seeded.projectId, run.runId)).toBeNull();
    await expect(s.results.getRun(run.runId)).rejects.toBeInstanceOf(RuntimeEntityNotFoundError);
    await expect(s.results.getSampling(samplingId!)).rejects.toBeInstanceOf(RuntimeEntityNotFoundError);
    await expect(s.results.getEvaluation(run.evaluationIds[0]!)).rejects.toBeInstanceOf(RuntimeEntityNotFoundError);
    await expect(s.source.read({ projectId: seeded.projectId })).rejects.toBeInstanceOf(MetricsEntityNotFoundError);
    await expect(s.observations.subject(seeded.projectId, samplingId!)).rejects.toMatchObject({ entity: "project" });
    await expect(s.projects.delete(seeded.projectId)).rejects.toBeInstanceOf(RuntimeEntityNotFoundError);
    await expect(s.runtime.admitRun(later)).rejects.toMatchObject({ name: "RuntimeEntityNotFoundError", entity: "project" });
    expect(await projectRowCounts(seeded.projectId)).toEqual([1, 1, 1, 1, 1, 1, 2]);
  });

  it("reads MetricsFacts from the fixed hierarchy for every scope and Run filter", async () => {
    const [a, b, c] = [makeData("a"), makeData("b"), makeData("c")];
    const seeded = await seedProject(database.db, OWNER, { datasets: [{ data: [a, b] }, { data: [b, c] }], evaluation: true });
    const [ps1, ps2, ps3] = seeded.samples as [typeof seeded.samples[0], typeof seeded.samples[0], typeof seeded.samples[0]];
    const [datasetA, datasetB] = seeded.datasets;
    const s = services();
    const pipeline = await buildCommand(s.plans, s.runtime, {
      projectId: seeded.projectId, operation: "pipeline", projectSampleIds: [ps1.projectSampleId, ps2.projectSampleId],
    });
    await s.runtime.admitRun(pipeline);
    await settle(s.worker, pipeline.run.samplingIds, "succeeded");
    const [sampling1, sampling2] = pipeline.samplings;
    const evaluation = await buildCommand(s.plans, s.runtime, { projectId: seeded.projectId, operation: "evaluation", samplingIds: [sampling1!.samplingId] });
    await s.runtime.admitRun(evaluation);
    const ids = <T extends Record<K, string>, K extends keyof T>(items: readonly T[], key: K) => items.map((item) => item[key]);

    const all = await s.source.read({ projectId: seeded.projectId });
    expect(all.plan.datasets).toEqual(seeded.datasets);
    expect(all.evaluationOutputSchema).toMatchObject({ type: "object" });
    expect(ids(all.projectSamples, "projectSampleId")).toEqual([ps1.projectSampleId, ps2.projectSampleId, ps3.projectSampleId]);
    expect(all.projectSamples[1]!.datasetIds).toEqual([datasetA!.datasetId, datasetB!.datasetId]);
    expect(ids(all.samplings, "samplingId").sort()).toEqual([sampling1!.samplingId, sampling2!.samplingId].sort());
    expect(ids(all.evaluations, "evaluationId").sort()).toEqual([evaluation.evaluations[0]!.evaluationId, pipeline.evaluations[1]!.evaluationId].sort());
    expect(ids(all.runs, "runId").sort()).toEqual([pipeline.run.runId, evaluation.run.runId].sort());

    const dataset = await s.source.read({ projectId: seeded.projectId, datasetId: datasetB!.datasetId });
    expect(ids(dataset.projectSamples, "projectSampleId")).toEqual([ps2.projectSampleId, ps3.projectSampleId]);
    expect(ids(dataset.samplings, "samplingId")).toEqual([sampling2!.samplingId]);
    expect(ids(dataset.evaluations, "evaluationId")).toEqual([pipeline.evaluations[1]!.evaluationId]);
    expect(ids(dataset.runs, "runId")).toEqual([pipeline.run.runId]);

    const neverRun = await s.source.read({ projectId: seeded.projectId, projectSampleId: ps3.projectSampleId });
    expect(neverRun).toMatchObject({ projectSamples: [{ projectSampleId: ps3.projectSampleId }], samplings: [], evaluations: [], runs: [] });

    const single = await s.source.read({ projectId: seeded.projectId, samplingId: sampling1!.samplingId });
    expect(ids(single.projectSamples, "projectSampleId")).toEqual([ps1.projectSampleId]);
    expect(ids(single.evaluations, "evaluationId")).toEqual([evaluation.evaluations[0]!.evaluationId]);

    const firstBatch = await s.source.read({ projectId: seeded.projectId, runIds: [pipeline.run.runId] });
    expect(firstBatch.projectSamples).toHaveLength(3);
    expect(ids(firstBatch.samplings, "samplingId").sort()).toEqual([sampling1!.samplingId, sampling2!.samplingId].sort());
    expect(ids(firstBatch.evaluations, "evaluationId")).toEqual([pipeline.evaluations[1]!.evaluationId]);
    expect(ids(firstBatch.runs, "runId")).toEqual([pipeline.run.runId]);
    const secondBatch = await s.source.read({ projectId: seeded.projectId, runIds: [evaluation.run.runId] });
    expect(ids(secondBatch.samplings, "samplingId")).toEqual([sampling1!.samplingId]);
    expect(ids(secondBatch.evaluations, "evaluationId")).toEqual([evaluation.evaluations[0]!.evaluationId]);

    expect((await s.source.read({ projectId: seeded.projectId, datasetId: crypto.randomUUID() })).projectSamples).toEqual([]);
    expect((await s.source.read({ projectId: seeded.projectId, runIds: ["foreign-run"] })).runs).toEqual([]);
    await expect(services(OTHER).source.read({ projectId: seeded.projectId })).rejects.toBeInstanceOf(MetricsEntityNotFoundError);
    await expect(createMetrics({ source: s.source }).getProjectOverview({ projectId: seeded.projectId }))
      .resolves.toMatchObject({ project: { projectId: seeded.projectId } });
  });

  it("resolves read-only observation targets only for current records", async () => {
    const seeded = await seedProject(database.db, OWNER, { datasets: [{ data: [makeData()] }], evaluation: true });
    const s = services();
    const pipeline = await buildCommand(s.plans, s.runtime, { projectId: seeded.projectId, operation: "pipeline" });
    await s.runtime.admitRun(pipeline);
    const sampling = pipeline.samplings[0]!;
    const judge = pipeline.evaluations[0]!;
    expect(await s.observations.subject(seeded.projectId, sampling.samplingId)).toEqual({
      role: "subject", projectId: seeded.projectId, samplingId: sampling.samplingId, ownerUserId: OWNER, state: "not-started",
    });
    const started = {
      ...sampling, subjectChatId: crypto.randomUUID(), execution: { status: "succeeded" as const },
      executionAttempts: [{ executionAttemptId: "a1", samplingId: sampling.samplingId, attemptNumber: 1, status: "completed" as const }],
    };
    await s.runtime.updateSampling(started, sampling);
    expect(await s.observations.subject(seeded.projectId, sampling.samplingId)).toMatchObject({
      chatId: started.subjectChatId, state: "available", ownerUserId: sampling.subjectAgent.ownerUserId,
    });
    const judged = { ...judge, chatId: crypto.randomUUID(), status: { status: "failed" as const } };
    await s.runtime.updateEvaluation(judged, judge);
    expect(await s.observations.evaluator(seeded.projectId, judge.evaluationId)).toEqual({
      role: "evaluator", projectId: seeded.projectId, samplingId: sampling.samplingId, evaluationId: judge.evaluationId,
      ownerUserId: judge.evaluator.ownerUserId, chatId: judged.chatId, state: "not-started",
    });
    const other = await seedProject(database.db, OWNER, { datasets: [{ data: [makeData()] }] });
    await expect(s.observations.subject(other.projectId, sampling.samplingId)).rejects.toMatchObject({ entity: "sampling" });
    await expect(services(OTHER).observations.subject(seeded.projectId, sampling.samplingId)).rejects.toMatchObject({ entity: "project" });

    await s.runtime.admitRun(await buildCommand(s.plans, s.runtime, { projectId: seeded.projectId, operation: "execution", samplingIds: [sampling.samplingId] }));
    await expect(s.observations.subject(seeded.projectId, sampling.samplingId)).rejects.toMatchObject({ entity: "sampling" });
    await expect(s.observations.evaluator(seeded.projectId, judge.evaluationId)).rejects.toMatchObject({ entity: "evaluation" });
  });

  it("creates a Project and runs it through the HTTP control plane with the Runtime admission", async () => {
    const { first, second, subject, evaluator, schema } = await catalog();
    const ownerServices = createOwnerServices({ db: database.db, sp: stub.sp, bundles: {} as BundleDirectory, release, runQueue });
    const send = requestApp({ webOrigin: WEB_ORIGIN, sp: stub.sp, ownerServices });
    const created = await send("/api/projects", jsonRequest("POST", {
      name: "HTTP", datasets: [{ datasetId: first.datasetId }, { datasetId: second.datasetId }], samplingCount: 1,
      execution: { userAgentId: subject, framework: "sp", executionConcurrency: 1 },
      evaluation: { userAgentId: evaluator, evaluationConcurrency: 1, outputSchemaId: schema.outputSchemaId },
      idempotencyKey: "create", run: { operation: "pipeline" },
    }, OWNER));
    expect(created.status).toBe(201);
    const { project, run } = (await created.json() as { msg: { project: { projectId: string }; run: { runId: string; samplingIds: string[] } } }).msg;
    expect(run.samplingIds).toHaveLength(3);
    const path = `/api/projects/${project.projectId}`;
    const view = (await (await send(path, authorized(OWNER))).json() as { msg: { evaluationPlanLockedAt: string | null; currentRun: unknown } }).msg;
    expect(view.evaluationPlanLockedAt).toEqual(expect.any(String));
    expect(view.currentRun).toEqual({ runId: run.runId });
    expect(await (await send(`${path}/evaluation-plan`, jsonRequest("PUT", {
      userAgentId: evaluator, evaluationConcurrency: 1, outputSchemaId: schema.outputSchemaId,
    }, OWNER))).json()).toMatchObject({ code: "PROJECT_EVALUATION_PLAN_LOCKED" });
    expect((await send(path, authorized(OWNER, { method: "DELETE" }))).status).toBe(409);
    await settle(createPostgresWorkerRuntimeStore(database.db, runQueue), run.samplingIds, "succeeded");
    const preview = (await (await send(`${path}/runs/preview`, jsonRequest("POST", {
      operation: "evaluation", selector: { all: true },
    }, OWNER))).json() as { msg: { targets: { projectSampleIds: string[]; samplingIds: string[] } } }).msg;
    expect(preview.targets.samplingIds.sort()).toEqual([...run.samplingIds].sort());
    const submitted = await send(`${path}/runs`, jsonRequest("POST", {
      idempotencyKey: "evaluate", operation: "evaluation", selector: { all: true }, targets: preview.targets,
    }, OWNER));
    expect(submitted.status).toBe(202);
    const sampling = run.samplingIds[0]!;
    expect(await (await send(`${path}/samplings/${sampling}/observation`, authorized(OWNER))).json())
      .toMatchObject({ msg: { role: "subject", samplingId: sampling, state: "not-started" } });
    const listed = (await (await send("/api/agent-configs", authorized(OWNER))).json() as { msg: Array<{ id: string }> }).msg;
    expect(listed.map((config) => config.id).sort()).toEqual([subject, evaluator].sort());
    expect((await send(`/api/metrics/projects/${project.projectId}`, authorized(OWNER))).status).toBe(200);
  });
});
