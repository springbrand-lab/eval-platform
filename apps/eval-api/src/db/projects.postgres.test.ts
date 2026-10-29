import { createDatasetService, DatasetEntityNotFoundError, type Data } from "@eval-platform/eval-dataset";
import { createMetrics, MetricsEntityNotFoundError } from "@eval-platform/eval-metrics";
import {
  createEvalRunAdmission,
  RuntimeAdmissionConflictError,
  RuntimeInputError,
  digestExecutionPlan,
  digestJson,
  RuntimeEntityNotFoundError,
  RuntimeProjectBusyError,
  RuntimeRunIdentityConflictError,
  type EvalRunAdmission,
} from "@eval-platform/eval-runtime";
import { count, eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgentConfigService } from "../agent-configs.js";
import { createDashboardService } from "../dashboards/service.js";
import { createOwnerServices } from "../owner-services.js";
import { apiError } from "../lib/api-errors.js";
import { createProjectService } from "../projects/service.js";
import { createRunQueue, openRunBoss, RUN_QUEUE, type RunWorkerQueue } from "../run-worker-queue.js";
import type { BundleDirectory } from "../sp/bundle-directory.js";
import { authorized, jsonRequest, requestApp, WEB_ORIGIN } from "../test-support.js";
import type { PgBoss } from "pg-boss";
import { createPostgresDatasetStore } from "./dataset.js";
import { createPostgresDashboardStore } from "./dashboards.js";
import { createPostgresAgentPurposeStore } from "./agent-purposes.js";
import {
  AgentConfigFrozenError,
  OutputSchemaNotFoundError,
  ProjectEvaluationPlanLockedError,
  ProjectIdempotencyConflictError,
} from "./errors.js";
import { createPostgresMetricsSource } from "./metrics.js";
import { createPostgresObservationReader } from "./observation.js";
import { createOutputSchemaCatalog } from "./output-schemas.js";
import { createPostgresProjectPlanReader } from "./project-plans.js";
import { EvalSpApiError } from "../sp/http.js";
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
  let runQueue: RunWorkerQueue;
  let stub: ReturnType<typeof createStubSp>;

  beforeAll(async () => {
    database = await createTestDatabase(connection!);
    jobs = await openRunBoss(database.connectionString, silent, { supervise: false });
    runQueue = createRunQueue(jobs);
  }, 30_000);

  beforeEach(async () => {
    await database.db.execute(sql`TRUNCATE TABLE eval_dashboards, eval_projects, eval_evaluation_output_schemas, eval_datasets, eval_data RESTART IDENTITY CASCADE`);
    await jobs.deleteAllJobs(RUN_QUEUE);
    stub = createStubSp();
  });

  afterAll(async () => {
    await jobs?.stop();
    if (database) await database.destroy();
  }, 30_000);

  /** Exercise the same public Runtime admission used by ProjectService and HTTP. */
  function planAdmission(owner: string): Pick<EvalRunAdmission, "preview" | "submit"> {
    const plans = createPostgresProjectPlanReader(database.db, owner);
    const store = createPostgresRuntimeStore(database.db, owner, release, runQueue);
    return createEvalRunAdmission({ sourceCommit: release.sourceCommit, plans, store });
  }

  function services(owner = OWNER, admission: Pick<EvalRunAdmission, "preview" | "submit"> = planAdmission(owner)) {
    const db = database.db;
    const store = createPostgresProjectStore(db, owner);
    const outputSchemas = createOutputSchemaCatalog(db, owner);
    const agentConfigs = createAgentConfigService({ ownerUserId: owner, sessionToken: owner, sp: stub.sp, projects: store, purposes: createPostgresAgentPurposeStore(db, owner) });
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
    const data = await Promise.all([1, 2, 3].map((index) => datasets.createData({ userPrompt: `task ${index}`, evalPrompt: "evaluation" })));
    const [d1, d2, d3] = data.sort((left, right) => left.dataId.localeCompare(right.dataId)) as [Data, Data, Data];
    const first = await datasets.createDataset({ name: "First", description: "first set" });
    const second = await datasets.createDataset({ name: "Second" });
    await datasets.attachData(first.datasetId, [d1.dataId, d2.dataId]);
    await datasets.attachData(second.datasetId, [d2.dataId, d3.dataId]);
    const schema = await outputSchemas.create({ name: "Score", description: "Score", content: scoreSchema });
    return {
      d1, d2, d3, first, second, schema,
      subject: stub.seed(owner, "Subject"),
      evaluator: stub.seed(owner, "Evaluator", { model: "Evaluator", mcpServers: [{ serverId: "eval-results" }] }),
    };
  }

  async function projectRowCounts(projectId: string): Promise<number[]> {
    return Promise.all([projects, projectDatasets, projectSamples, projectSampleDatasets, projectExecutionPlans,
      projectEvaluationPlans, projectAgentConfigs].map(async (table) => (
      await database.db.select({ n: count() }).from(table).where(eq(table.projectId, projectId))
    )[0]!.n));
  }

  it("reconciles and persists Agent purposes from source-scoped MCP catalogs before enforcing frozen-copy roles", async () => {
    const { subject, evaluator } = await catalog();
    const { agentConfigs } = services();
    await expect(agentConfigs.listAgents("subject", "execution")).resolves.toEqual([{
      agentConfig: { ownerUserId: OWNER, userAgentId: subject }, name: "Subject", role: "subject", purpose: "execution",
    }]);
    await expect(agentConfigs.listAgents("evaluator", "evaluation")).resolves.toEqual([{
      agentConfig: { ownerUserId: OWNER, userAgentId: evaluator }, name: "Evaluator", role: "evaluator", purpose: "evaluation",
    }]);
    expect(stub.sp.listMcpServers.mock.calls).toEqual([[OWNER, "user"], [OWNER, "platform"]]);
    const purposes = createPostgresAgentPurposeStore(database.db, OWNER);
    await expect(purposes.get(subject)).resolves.toEqual({
      userAgentId: subject, purpose: "execution", evaluationMcpServerId: null,
    });
    await expect(purposes.get(evaluator)).resolves.toEqual({
      userAgentId: evaluator, purpose: "evaluation", evaluationMcpServerId: "eval-results",
    });

    stub.sp.listMcpServers.mockRejectedValue(new Error("catalog offline"));
    const reloaded = services().agentConfigs;
    await expect(reloaded.listAgents()).resolves.toHaveLength(4);
    expect(stub.sp.listMcpServers).toHaveBeenCalledTimes(2);
    await expect(reloaded.freeze(subject, "evaluation")).rejects.toMatchObject({
      name: "AgentConfigPurposeMismatchError", expected: "evaluation", actual: "execution",
    });
    await expect(reloaded.freeze(evaluator, "execution")).rejects.toMatchObject({
      name: "AgentConfigPurposeMismatchError", expected: "execution", actual: "evaluation",
    });
    expect(stub.sp.createAgentConfig).not.toHaveBeenCalled();
  });

  it("snapshots Datasets, shared Data and frozen Agent Configs, unaffected by later catalog edits and soft deletes", async () => {
    const { d1, d2, d3, first, second, subject } = await catalog();
    const { projects: service, datasets } = services();
    const body = {
      name: "Snapshot", description: "fixed",
      datasets: [{ datasetId: first.datasetId }, { datasetId: second.datasetId, dataIds: [d2.dataId] }],
      samplingCount: 1, samplingCounts: { [d2.dataId]: 3 },
      execution: { userAgentId: subject, framework: "sp" as const, executionConcurrency: 2, timeoutMs: 60_000 },
      idempotencyKey: "create", run: { operation: "execution" as const },
    };
    const { project, run } = await service.create(body);
    expect(run!.samplingIds).toHaveLength(4);
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
    expect(view.currentRun).toEqual({ runId: run!.runId });

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
    expect(await service.reconcile(body)).toEqual({ project, run }); // shared Data is still one first-Run target

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

  it("keeps Project Schema reads and Run sequence authoritative after source deletion and short Runs", async () => {
    const { first, subject, evaluator, schema } = await catalog();
    const { projects: service, outputSchemas, worker, runtime, plans } = services();
    const { project, run } = await service.create({
      name: "Schema read", datasets: [{ datasetId: first.datasetId }], samplingCount: 1,
      execution: { userAgentId: subject, framework: "sp", executionConcurrency: 1 },
      evaluation: { userAgentId: evaluator, evaluationConcurrency: 1, outputSchemaId: schema.outputSchemaId },
      idempotencyKey: "schema-read", run: { operation: "execution" },
    });
    expect((await service.get(project.projectId))!.runSequence).toBe(1);
    const document = await service.getEvaluationOutputSchema(project.projectId);
    expect(document).toEqual({ reference: (await service.get(project.projectId))!.evaluation!.plan.outputSchema, content: JSON.parse(scoreSchema) });
    await outputSchemas.delete(schema.outputSchemaId);
    expect(await outputSchemas.get(schema.outputSchemaId)).toBeNull();
    expect(await service.getEvaluationOutputSchema(project.projectId)).toEqual(document);
    await expect(services(OTHER).projects.getEvaluationOutputSchema(project.projectId)).rejects.toBeInstanceOf(RuntimeEntityNotFoundError);
    await settle(worker, run!.samplingIds, "succeeded");
    expect(await service.get(project.projectId)).toMatchObject({ runSequence: 1, currentRun: null });
    const next = await buildCommand(plans, runtime, { projectId: project.projectId, operation: "execution", idempotencyKey: "second" });
    await runtime.admitRun(next);
    await settle(worker, next.run.samplingIds, "succeeded");
    expect(await service.get(project.projectId)).toMatchObject({ runSequence: 2, currentRun: null });
    await service.delete(project.projectId);
    await expect(service.getEvaluationOutputSchema(project.projectId)).rejects.toBeInstanceOf(RuntimeEntityNotFoundError);
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
      .rejects.toMatchObject({ name: "RuntimeInputError", field: "datasets.0.dataIds" });
    await expect(service.create({ ...body, samplingCounts: { [d3.dataId]: 2 } })).rejects.toBeInstanceOf(RuntimeInputError);
    await expect(service.create({ ...body, idempotencyKey: "k", run: { operation: "pipeline" } })).rejects.toBeInstanceOf(RuntimeInputError);
    const empty = await datasets.createDataset({ name: "Empty" });
    await expect(service.create({ ...body, datasets: [{ datasetId: empty.datasetId }] })).rejects.toBeInstanceOf(RuntimeInputError);
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
      .rejects.toBeInstanceOf(RuntimeInputError);
  });

  it("compensates a failed creation: no Project rows remain and SP copies are deleted", async () => {
    const { first, subject, evaluator, schema } = await catalog();
    const failing: Pick<EvalRunAdmission, "preview" | "submit"> = {
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

  it.each(["create", "update"])("rejects a Dashboard %s during first-Run admission without blocking compensation or same-key Project retry", async (operation) => {
    const { first, subject, evaluator, schema } = await catalog();
    const s = services();
    const body = {
      name: "Pending", datasets: [{ datasetId: first.datasetId }], samplingCount: 1,
      execution: { userAgentId: subject, framework: "sp" as const, executionConcurrency: 1 },
      evaluation: { userAgentId: evaluator, evaluationConcurrency: 1, outputSchemaId: schema.outputSchemaId },
      idempotencyKey: "pending-project", run: { operation: "pipeline" as const },
    };
    const stable = await Promise.all(["first", "second"].map((key) => s.projects.create({ ...body, idempotencyKey: key })));
    const dashboards = createDashboardService(createPostgresDashboardStore(database.db, OWNER));
    const saved = await dashboards.create({
      name: "Saved", projectIds: stable.map(({ project }) => project.projectId), idempotencyKey: "saved-dashboard",
    });
    const failure = new Error("first Run admission failed");
    let pendingId = "";
    let visible = false;
    let copies: string[] = [];
    let outcome: PromiseSettledResult<unknown> | undefined;
    const failing = services(OWNER, {
      preview: planAdmission(OWNER).preview,
      async submit({ projectId }) {
        pendingId = projectId;
        visible = await s.store.exists(projectId);
        copies = (await database.db.select({ userAgentId: projectAgentConfigs.userAgentId }).from(projectAgentConfigs)
          .where(eq(projectAgentConfigs.projectId, projectId))).map((copy) => copy.userAgentId);
        const command = { name: "Pending reference", projectIds: [stable[0]!.project.projectId, projectId] };
        [outcome] = await Promise.allSettled([
          operation === "create"
            ? dashboards.create({ ...command, idempotencyKey: "pending-dashboard" })
            : dashboards.update(saved.dashboardId, { ...command, revision: saved.revision }),
        ]);
        throw failure;
      },
    });
    await expect(failing.projects.create(body)).rejects.toBe(failure);
    expect(visible).toBe(true);
    expect(outcome).toMatchObject({ status: "rejected", reason: { name: "DashboardProjectNotFoundError", projectId: pendingId } });
    expect(copies).toHaveLength(2);
    expect([...stub.calls.deleted].sort()).toEqual([...copies].sort());
    expect(await projectRowCounts(pendingId)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(await s.store.findCreation(body.idempotencyKey)).toBeNull();
    expect(await dashboards.list()).toEqual([saved]);
    expect(await dashboards.get(saved.dashboardId)).toEqual(saved);

    const retried = await s.projects.create(body);
    expect(retried.project.projectId).not.toBe(pendingId);
    expect(retried.run).not.toBeNull();
    const copyCount = stub.calls.created.length;
    expect(await s.projects.create(body)).toEqual(retried);
    expect(stub.calls.created).toHaveLength(copyCount);
    const command = { name: "Admitted reference", projectIds: [stable[0]!.project.projectId, retried.project.projectId] };
    const bound = operation === "create"
      ? await dashboards.create({ ...command, idempotencyKey: "pending-dashboard" })
      : await dashboards.update(saved.dashboardId, { ...command, revision: saved.revision });
    expect(bound.projectIds).toEqual(command.projectIds);
    expect(await s.store.deleteUnrun(retried.project.projectId)).toEqual([]);
    expect(await dashboards.get(bound.dashboardId)).toEqual(bound);
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
      await expect(service.create({ ...body, run: { operation: "pipeline" } })).rejects.toBeInstanceOf(RuntimeInputError);
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
      const crashingStore = { ...crashed.store, deleteUnrun: async (): Promise<string[]> => [] };
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
      expect(run!.samplingIds).toHaveLength(2);
      expect(stub.sp.createAgentConfig).toHaveBeenCalledTimes(1);
      expect(await services().projects.create(body)).toEqual({ project, run });
    });

    it("reserves a committed Project's creation key before any Run, but admits its proven first Run exactly once", async () => {
      const original = await creationBody();
      const { evaluator, schema } = await catalog();
      const body = { ...original, evaluation: { userAgentId: evaluator, evaluationConcurrency: 1, outputSchemaId: schema.outputSchemaId } };
      let entered!: () => void;
      let resume!: () => void;
      const persisted = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { resume = resolve; });
      const real = planAdmission(OWNER);
      const creating = services(OWNER, {
        async preview(request) {
          entered(); // store.create has already committed; no first Run has been admitted
          await gate;
          return real.preview(request);
        },
        submit: real.submit,
      }).projects.create(body);
      await persisted;
      let projectId = "";
      try {
        const [project] = await database.db.select().from(projects).where(eq(projects.creationKey, body.idempotencyKey));
        projectId = project!.projectId;
        expect(project!.creationFingerprint).toMatch(/^[0-9a-f]{64}$/u);
        expect((await database.db.select().from(runs)).length).toBe(0);
        const ordinary = planAdmission(OWNER);
        for (const request of [
          { operation: "execution" as const, selector: { all: true as const } }, // even identical ordinary intent cannot claim it
          { operation: "pipeline" as const, selector: { all: true as const } },
          { operation: "execution" as const, selector: { projectSampleIds: [(await services().plans.getProjectPlan(projectId))!.datasets[0]!.projectSampleIds[0]!] } },
        ]) {
          const preview = await ordinary.preview({ projectId, ...request });
          await expect(ordinary.submit({
            idempotencyKey: body.idempotencyKey, projectId, ...request, targets: preview.targets,
            expectedPlanDigests: preview.operation === "execution" ? { execution: preview.executionPlanDigest }
              : { execution: preview.executionPlanDigest, evaluation: preview.evaluationPlanDigest! },
          })).rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);
        }
        const command = await buildCommand(services().plans, services().runtime, {
          projectId, operation: "execution", idempotencyKey: body.idempotencyKey,
        });
        await expect(services().runtime.admitRun(command)).rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);
        await expect(services().runtime.admitRun({ ...command, firstRun: { creationFingerprint: "wrong" } }))
          .rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);
        expect((await database.db.select().from(runs)).length).toBe(0);
        expect(await jobs.findJobs(RUN_QUEUE)).toHaveLength(0);
      } finally {
        resume();
      }
      const created = await creating;
      expect(created.project.projectId).toBe(projectId);
      expect(created.run?.samplingIds).toHaveLength(2);
      expect(await jobs.findJobs(RUN_QUEUE, { key: created.run!.runId })).toHaveLength(1);
      expect(await services().projects.create(body)).toEqual(created);
      await settle(services().worker, created.run!.samplingIds, "succeeded");
      const later = await buildCommand(services().plans, services().runtime, { projectId, operation: "execution", idempotencyKey: "other-run" });
      await services().runtime.admitRun(later);
      expect(await services().projects.reconcile(body)).toEqual({
        project: created.project, run: { runId: created.run!.runId, samplingIds: [] },
      });
      expect(await services().projects.create(body)).toEqual({
        project: created.project, run: { runId: created.run!.runId, samplingIds: [] },
      });
      expect((await database.db.select().from(runs)).length).toBe(2);
      expect(await jobs.findJobs(RUN_QUEUE, { key: created.run!.runId })).toHaveLength(1);
    });

    it("does not reconcile a historic wrong-operation Run stored under the creation key", async () => {
      const original = await creationBody();
      const { evaluator, schema } = await catalog();
      const body = { ...original, evaluation: { userAgentId: evaluator, evaluationConcurrency: 1, outputSchemaId: schema.outputSchemaId } };
      const s = services();
      const stalled = createProjectService({
        ownerUserId: OWNER, sourceBranch: release.sourceBranch,
        store: { ...s.store, deleteUnrun: async (): Promise<string[]> => [] },
        outputSchemas: s.outputSchemas, agentConfigs: s.agentConfigs,
        admission: { preview: planAdmission(OWNER).preview, async submit() { throw new Error("creator crashed"); } },
      });
      await expect(stalled.create(body)).rejects.toThrow("creator crashed");
      const [project] = await s.store.list();
      const preview = await s.plans.getProjectPlan(project!.projectId);
      const request = await planAdmission(OWNER).preview({ projectId: project!.projectId, operation: "pipeline", selector: { all: true } });
      const planDigests = { execution: request.executionPlanDigest, evaluation: request.evaluationPlanDigest! };
      const wrongRunId = crypto.randomUUID();
      // Simulates an admission committed before the creation-key proof existed; not a permitted write today.
      await database.db.insert(runs).values({
        runId: wrongRunId, ownerUserId: OWNER, projectId: project!.projectId, sequence: 1,
        sourceCommit: release.sourceCommit, operation: "pipeline", phases: ["execution", "evaluation"],
        selector: { all: true }, targets: request.targets,
        executionPlanDigest: planDigests.execution, evaluationPlanDigest: planDigests.evaluation,
        idempotencyKey: body.idempotencyKey,
        requestFingerprint: await digestJson({
          projectId: project!.projectId, operation: "pipeline", selector: { all: true },
          targets: request.targets, planDigests,
        }),
      });
      expect(preview?.datasets[0]?.projectSampleIds).toHaveLength(2);
      expect((await s.store.findCreation(body.idempotencyKey))?.run?.runId).toBe(wrongRunId);
      await expect(s.projects.reconcile(body)).rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);
      await expect(s.projects.create(body)).rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);
      expect((await database.db.select().from(runs)).length).toBe(1);
      expect(await jobs.findJobs(RUN_QUEUE)).toHaveLength(0);
    });

    it("never lets a replaying request compensate a Project another request committed", async () => {
      const body = await creationBody();
      const committed = services();
      // Request A commits the creation transaction but has not admitted its first Run yet.
      const pending = createProjectService({
        ownerUserId: OWNER, sourceBranch: release.sourceBranch, store: { ...committed.store, deleteUnrun: async (): Promise<string[]> => [] },
        outputSchemas: committed.outputSchemas, agentConfigs: committed.agentConfigs,
        admission: { preview: planAdmission(OWNER).preview, async submit() { throw new Error("A is still admitting"); } },
      });
      await expect(pending.create(body)).rejects.toThrow("A is still admitting");
      const [project] = await services().projects.list();
      const copies = (await database.db.select().from(projectAgentConfigs)).map((row) => row.userAgentId);
      expect(copies).toHaveLength(1);

      // Request B replays the same key; its admission fails, but it must not remove A's Project or copies.
      const replaying = services(OWNER, {
        preview: planAdmission(OWNER).preview,
        async submit() { throw new RuntimeAdmissionConflictError("source-branch", "release changed"); },
      });
      await expect(replaying.projects.create(body)).rejects.toMatchObject({ reason: "source-branch" });
      expect(await services().projects.list()).toEqual([project]);
      expect((await database.db.select().from(projectAgentConfigs)).map((row) => row.userAgentId)).toEqual(copies);
      expect(stub.calls.deleted).toEqual([]);
      expect(stub.configs.has(copies[0]!)).toBe(true);

      const finished = await services().projects.create(body);
      expect(finished.project).toEqual(project);
      expect(await services().projects.create(body)).toEqual(finished);
      expect(stub.sp.createAgentConfig).toHaveBeenCalledTimes(1);
    });

    it("replays the creation's own first Run after later Runs and never submits it once other Runs exist", async () => {
      const body = await creationBody();
      const s = services();
      const created = await s.projects.create(body);
      await settle(s.worker, created.run!.samplingIds, "succeeded");
      const later = await buildCommand(s.plans, s.runtime, { projectId: created.project.projectId, operation: "execution", idempotencyKey: "later" });
      await s.runtime.admitRun(later);
      const replayed = await s.projects.create(body);
      expect(replayed.project).toEqual(created.project);
      expect(replayed.run?.runId).toBe(created.run!.runId);

      // The creator committed a second Project but crashed before admission; the user then started a Run.
      const crashed = { ...body, idempotencyKey: "crashed-create" };
      const creator = createProjectService({
        ownerUserId: OWNER, sourceBranch: release.sourceBranch, store: { ...s.store, deleteUnrun: async (): Promise<string[]> => [] },
        outputSchemas: s.outputSchemas, agentConfigs: s.agentConfigs,
        admission: { preview: planAdmission(OWNER).preview, async submit() { throw new Error("process crashed"); } },
      });
      await expect(creator.create(crashed)).rejects.toThrow("process crashed");
      const orphan = (await s.projects.list()).find((project) => project.projectId !== created.project.projectId)!;
      await s.runtime.admitRun(await buildCommand(s.plans, s.runtime, { projectId: orphan.projectId, operation: "execution", idempotencyKey: "user-run" }));
      const runsBefore = (await database.db.select({ n: count() }).from(runs))[0]!.n;
      expect(await s.projects.create(crashed)).toEqual({ project: orphan, run: null });
      expect((await database.db.select({ n: count() }).from(runs))[0]!.n).toBe(runsBefore);
    });

    /** The Runtime admission, so a vanished Project surfaces as RuntimeEntityNotFoundError like in production. */
    function runtimeAdmission(): EvalRunAdmission {
      const s = services();
      return createEvalRunAdmission({ sourceCommit: release.sourceCommit, plans: s.plans, store: s.runtime });
    }

    it.each(["compensated", "soft-deleted"] as const)("handles a replay whose winning creation was %s before the replay admitted", async (fate) => {
      const body = await creationBody();
      const s = services();
      const winner = createProjectService({
        ownerUserId: OWNER, sourceBranch: release.sourceBranch, store: { ...s.store, deleteUnrun: async (): Promise<string[]> => [] },
        outputSchemas: s.outputSchemas, agentConfigs: s.agentConfigs,
        admission: { preview: runtimeAdmission().preview, async submit() { throw new Error("winner still admitting"); } },
      });
      await expect(winner.create(body)).rejects.toThrow("winner still admitting");
      const [first] = await s.projects.list();
      const real = runtimeAdmission();
      let removed = false;
      const replaying = createProjectService({
        ownerUserId: OWNER, sourceBranch: release.sourceBranch, store: s.store,
        outputSchemas: s.outputSchemas, agentConfigs: s.agentConfigs,
        admission: {
          async preview(request) {
            if (!removed) {
              removed = true;
              if (fate === "compensated") expect(await s.store.deleteUnrun(first!.projectId)).toEqual(expect.any(Array));
              else await s.projects.delete(first!.projectId);
            }
            return real.preview(request);
          },
          submit: real.submit,
        },
      });
      if (fate === "soft-deleted") {
        await expect(replaying.create(body)).rejects.toMatchObject({ name: "RuntimeEntityNotFoundError", entity: "project" });
        return;
      }
      const created = await replaying.create(body);
      expect(created.project.projectId).not.toBe(first!.projectId);
      expect(created.run?.samplingIds).toHaveLength(2);
      expect((await s.projects.list()).map((project) => project.projectId)).toEqual([created.project.projectId]);
    });

    it("re-previews the creator's first Run when an evaluation-plan replacement changed the plan first", async () => {
      const body = await creationBody();
      const { evaluator, schema } = await catalog();
      const s = services();
      const real = runtimeAdmission();
      let previews = 0;
      let raced = false;
      const service = createProjectService({
        ownerUserId: OWNER, sourceBranch: release.sourceBranch, store: s.store,
        outputSchemas: s.outputSchemas, agentConfigs: s.agentConfigs,
        admission: {
          async preview(request) {
            previews += 1;
            return real.preview(request);
          },
          async submit(request, firstRun) {
            if (!raced) {
              raced = true;
              await s.projects.replaceEvaluationPlan(request.projectId, {
                userAgentId: evaluator, evaluationConcurrency: 1, outputSchemaId: schema.outputSchemaId,
              });
              throw new RuntimeAdmissionConflictError("plan-changed", "Project plan changed after the Run was prepared");
            }
            return real.submit(request, firstRun);
          },
        },
      });
      const { project, run } = await service.create(body);
      expect(run).not.toBeNull();
      expect(previews).toBe(2);
      const view = (await s.projects.get(project.projectId))!;
      expect(view.evaluation).not.toBeNull();
      expect(view.currentRun).toEqual({ runId: run!.runId });
    });

    it("never undoes a user soft-delete that lands before the creator's first Run", async () => {
      const body = await creationBody();
      const s = services();
      const real = runtimeAdmission();
      const creator = createProjectService({
        ownerUserId: OWNER, sourceBranch: release.sourceBranch, store: s.store,
        outputSchemas: s.outputSchemas, agentConfigs: s.agentConfigs,
        admission: {
          async preview(request) {
            await s.projects.delete(request.projectId);
            return real.preview(request);
          },
          submit: real.submit,
        },
      });
      await expect(creator.create(body)).rejects.toMatchObject({ name: "RuntimeEntityNotFoundError", entity: "project" });
      const [row] = await database.db.select().from(projects);
      expect(row?.deletedAt).toBeInstanceOf(Date);
      expect((await database.db.select().from(projectAgentConfigs)).map((config) => config.userAgentId)).toEqual(await copyIds());
      expect(stub.calls.deleted).toEqual([]);
      await expect(services().projects.create(body)).rejects.toMatchObject({ name: "RuntimeEntityNotFoundError", entity: "project" });
      expect((await database.db.select({ n: count() }).from(projects))[0]!.n).toBe(1);
    });

    it("returns the creation's own Run when it was admitted and superseded after the replay's lookup", async () => {
      const body = await creationBody();
      const s = services();
      const crashed = createProjectService({
        ownerUserId: OWNER, sourceBranch: release.sourceBranch, store: { ...s.store, deleteUnrun: async (): Promise<string[]> => [] },
        outputSchemas: s.outputSchemas, agentConfigs: s.agentConfigs,
        admission: { preview: runtimeAdmission().preview, async submit() { throw new Error("creator stalled"); } },
      });
      await expect(crashed.create(body)).rejects.toThrow("creator stalled");
      const [project] = await s.projects.list();
      const real = runtimeAdmission();
      let creationRunId = "";
      const replaying = createProjectService({
        ownerUserId: OWNER, sourceBranch: release.sourceBranch, store: s.store,
        outputSchemas: s.outputSchemas, agentConfigs: s.agentConfigs,
        admission: {
          async preview(request) {
            if (creationRunId === "") {
              // The stalled creator finishes its first Run, then the user starts and finishes another one.
              const approved = await real.preview(request);
              const creationRun = await real.submit({ ...request, idempotencyKey: body.idempotencyKey, targets: approved.targets,
                expectedPlanDigests: approved.operation === "execution" ? { execution: approved.executionPlanDigest }
                  : { execution: approved.executionPlanDigest, evaluation: approved.evaluationPlanDigest! } },
              { creationFingerprint: (await s.store.findCreation(body.idempotencyKey))!.fingerprint });
              creationRunId = creationRun.runId;
              await settle(s.worker, creationRun.samplingIds, "succeeded");
              const fresh = await real.preview(request);
              const userRun = await real.submit({ ...request, idempotencyKey: "user", targets: fresh.targets,
                expectedPlanDigests: fresh.operation === "execution" ? { execution: fresh.executionPlanDigest }
                  : { execution: fresh.executionPlanDigest, evaluation: fresh.evaluationPlanDigest! } });
              await settle(s.worker, userRun.samplingIds, "succeeded");
            }
            return real.preview(request);
          },
          submit: real.submit,
        },
      });
      const replayed = await replaying.create(body);
      expect(replayed.project).toEqual(project);
      expect(replayed.run?.runId).toBe(creationRunId);
      expect((await database.db.select({ n: count() }).from(runs))[0]!.n).toBe(2);
    });

    it("returns the creation's own Run to a stalled creator after a replay admitted it and a user Run superseded it", async () => {
      const body = await creationBody();
      const s = services();
      const real = runtimeAdmission();
      let creationRunId = "";
      const creator = createProjectService({
        ownerUserId: OWNER, sourceBranch: release.sourceBranch, store: s.store,
        outputSchemas: s.outputSchemas, agentConfigs: s.agentConfigs,
        admission: {
          async preview(request) {
            if (creationRunId === "") {
              // The creator stalls after its commit: a same-key replay admits the creation Run, then the user starts another one.
              const replayed = await services(OWNER, runtimeAdmission()).projects.create(body);
              creationRunId = replayed.run!.runId;
              await settle(s.worker, replayed.run!.samplingIds, "succeeded");
              const fresh = await real.preview(request);
              const userRun = await real.submit({ ...request, idempotencyKey: "user", targets: fresh.targets,
                expectedPlanDigests: fresh.operation === "execution" ? { execution: fresh.executionPlanDigest }
                  : { execution: fresh.executionPlanDigest, evaluation: fresh.evaluationPlanDigest! } });
              await settle(s.worker, userRun.samplingIds, "succeeded");
            }
            return real.preview(request);
          },
          submit: real.submit,
        },
      });
      const created = await creator.create(body);
      expect(created.run?.runId).toBe(creationRunId);
      expect(await s.projects.list()).toEqual([created.project]);
      expect((await database.db.select({ n: count() }).from(runs))[0]!.n).toBe(2);
      expect(stub.calls.deleted).toEqual([]);
      expect(stub.sp.createAgentConfig).toHaveBeenCalledTimes(1);
    });

    it("keeps a Project whose first Run kept meeting plan changes and finishes it on replay", async () => {
      const body = await creationBody();
      const s = services();
      const changing = createProjectService({
        ownerUserId: OWNER, sourceBranch: release.sourceBranch, store: s.store,
        outputSchemas: s.outputSchemas, agentConfigs: s.agentConfigs,
        admission: {
          preview: runtimeAdmission().preview,
          async submit() { throw new RuntimeAdmissionConflictError("plan-changed", "Project plan changed after the Run was prepared"); },
        },
      });
      const failure = await changing.create(body).then(() => null, (error: unknown) => error);
      expect(failure).toMatchObject({ reason: "plan-changed" });
      expect(apiError(failure as Error).code).toBe("PROJECT_PLAN_CHANGED");
      const [project] = await s.projects.list();
      expect(project).toBeDefined();
      expect(stub.calls.deleted).toEqual([]);
      const replayed = await services(OWNER, runtimeAdmission()).projects.create(body);
      expect(replayed.project).toEqual(project);
      expect(replayed.run?.samplingIds).toHaveLength(2);
    });

    it.each(["active", "finished"] as const)("returns run: null when a %s user Run commits between the replay's lookup and its admission", async (state) => {
      const body = await creationBody();
      const s = services();
      const creator = createProjectService({
        ownerUserId: OWNER, sourceBranch: release.sourceBranch, store: { ...s.store, deleteUnrun: async (): Promise<string[]> => [] },
        outputSchemas: s.outputSchemas, agentConfigs: s.agentConfigs,
        admission: { preview: planAdmission(OWNER).preview, async submit() { throw new Error("process crashed"); } },
      });
      await expect(creator.create(body)).rejects.toThrow("process crashed");
      const [project] = await s.projects.list();
      // The replay has already seen "no Run"; a user Run commits before its admission takes the lock.
      let userRun: string[] = [];
      const racing = planAdmission(OWNER);
      const replaying = createProjectService({
        ownerUserId: OWNER, sourceBranch: release.sourceBranch, store: s.store,
        outputSchemas: s.outputSchemas, agentConfigs: s.agentConfigs,
        admission: {
          async preview(request) {
            const user = await buildCommand(s.plans, s.runtime, { projectId: project!.projectId, operation: "execution", idempotencyKey: "user" });
            await s.runtime.admitRun(user);
            userRun = [...user.run.samplingIds];
            if (state === "finished") await settle(s.worker, userRun, "succeeded");
            return racing.preview(request);
          },
          submit: racing.submit,
        },
      });
      expect(await replaying.create(body)).toEqual({ project, run: null });
      expect((await database.db.select({ n: count() }).from(runs))[0]!.n).toBe(1);
      const kept = await s.runtime.getSamplings(userRun);
      expect(kept.every((sampling) => sampling !== null)).toBe(true);
      expect(kept.map((sampling) => sampling!.execution.status))
        .toEqual(userRun.map(() => state === "finished" ? "succeeded" : "queued"));
    });

    it("reports a failed compensation together with the admission failure", async () => {
      const body = await creationBody();
      const s = services();
      const service = createProjectService({
        ownerUserId: OWNER, sourceBranch: release.sourceBranch,
        store: { ...s.store, deleteUnrun: async () => { throw new Error("database unavailable"); } },
        outputSchemas: s.outputSchemas, agentConfigs: s.agentConfigs,
        admission: { preview: planAdmission(OWNER).preview, async submit() { throw new RuntimeProjectBusyError("p", "r"); } },
      });
      const failure = await service.create(body).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors.map((error: Error) => error.message))
        .toEqual([expect.stringContaining("unfinished Run"), "database unavailable"]);
      expect(stub.calls.deleted).toEqual([]);
    });

    it("never resurrects a deleted creation and starts afresh after a compensated failure", async () => {
      const body = await creationBody();
      const failing = services(OWNER, { preview: planAdmission(OWNER).preview, async submit() { throw new RuntimeProjectBusyError("p", "r"); } });
      await expect(failing.projects.create(body)).rejects.toBeInstanceOf(RuntimeProjectBusyError);
      expect(await services().projects.list()).toEqual([]);
      const { projects: service, worker } = services();
      const { project, run } = await service.create(body);
      await settle(worker, run!.samplingIds, "succeeded");
      await service.delete(project.projectId);
      await expect(service.create(body)).rejects.toMatchObject({ name: "RuntimeEntityNotFoundError", entity: "project" });
      await expect(service.create({ ...body, name: "Other" })).rejects.toMatchObject({ name: "RuntimeEntityNotFoundError", entity: "project" });
      const other = await services(OTHER).projects.create({ ...body, datasets: [{ datasetId: (await catalog(OTHER)).first.datasetId }],
        execution: { ...body.execution, userAgentId: stub.seed(OTHER, "Other subject") } });
      expect(other.project.projectId).not.toBe(project.projectId);
    });
  });

  it("treats an orphan frozen-slug copy without a Project row as frozen everywhere", async () => {
    const { first } = await catalog();
    const orphan = crypto.randomUUID();
    stub.configs.set(orphan, {
      id: orphan, user_id: OWNER, slug: `eval-frozen-${crypto.randomUUID()}`, name: "Lost (frozen)", description: null,
      revision: 1, setting: { model: "lost" }, is_default: false,
    });
    const { agentConfigs, projects: service } = services();
    expect((await agentConfigs.list()).map((config) => config.id)).not.toContain(orphan);
    expect((await agentConfigs.listAgents()).map((agent) => agent.agentConfig.userAgentId)).not.toContain(orphan);
    await expect(agentConfigs.update(orphan, { name: "edit" })).rejects.toBeInstanceOf(AgentConfigFrozenError);
    await expect(agentConfigs.remove(orphan)).rejects.toBeInstanceOf(AgentConfigFrozenError);
    await expect(service.create({
      idempotencyKey: "orphan", name: "From orphan", datasets: [{ datasetId: first.datasetId }], samplingCount: 1,
      execution: { userAgentId: orphan, framework: "sp", executionConcurrency: 1 }, run: { operation: "execution" },
    })).rejects.toBeInstanceOf(AgentConfigFrozenError);
    expect(stub.sp.createAgentConfig).not.toHaveBeenCalled();
    expect((await agentConfigs.get(orphan)).id).toBe(orphan);
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
    const firstCopy = firstView.evaluation!.plan.evaluationHarness.agentConfig.userAgentId;
    expect(firstView.evaluation).toMatchObject({
      plan: {
        evaluatorAgentConfig: { sourceUserAgentId: evaluator, name: "Evaluator" },
        outputSchema: { outputSchemaId: schema.outputSchemaId, digest: expect.stringMatching(/^[0-9a-f]{64}$/u) },
        evaluationConcurrency: 2,
      },
      digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(firstView.evaluation!.lockedAt).toBeNull();
    const secondView = await service.replaceEvaluationPlan(project.projectId, { ...plan, evaluationConcurrency: 3 });
    const secondCopy = secondView.evaluation!.plan.evaluationHarness.agentConfig.userAgentId;
    expect(secondCopy).not.toBe(firstCopy);
    expect(secondView.evaluation!.digest).not.toBe(firstView.evaluation!.digest);
    expect(stub.calls.deleted).toEqual([firstCopy]);
    const rows = await database.db.select().from(projectAgentConfigs).where(eq(projectAgentConfigs.projectId, project.projectId));
    expect(rows.find((row) => row.userAgentId === firstCopy)?.retiredAt).toBeInstanceOf(Date);
    expect(rows.find((row) => row.userAgentId === secondCopy)?.retiredAt).toBeNull();

    const subjectCopy = firstView.execution.harness.agentConfig.userAgentId;
    expect((await agentConfigs.list()).map((config) => config.id).sort()).toEqual([subject, evaluator].sort());
    expect((await agentConfigs.listAgents("evaluator", "evaluation")).map((agent) => agent.agentConfig.userAgentId).sort()).toEqual([evaluator]);
    await expect(agentConfigs.update(subjectCopy, { name: "edit" })).rejects.toBeInstanceOf(AgentConfigFrozenError);
    await expect(agentConfigs.remove(secondCopy)).rejects.toBeInstanceOf(AgentConfigFrozenError);
    await expect(agentConfigs.remove(firstCopy)).rejects.toBeInstanceOf(AgentConfigFrozenError);
    await expect(service.create({
      name: "From copy", datasets: [{ datasetId: first.datasetId }], samplingCount: 1,
      execution: { userAgentId: subjectCopy, framework: "sp", executionConcurrency: 1 },
      idempotencyKey: "copy", run: { operation: "execution" },
    })).rejects.toBeInstanceOf(AgentConfigFrozenError);
    expect((await agentConfigs.get(subjectCopy)).id).toBe(subjectCopy);

    await settle(worker, run!.samplingIds, "succeeded");
    const evaluation = await buildCommand(plans, runtime, { projectId: project.projectId, operation: "evaluation" });
    await runtime.admitRun(evaluation);
    expect((await service.get(project.projectId))!.evaluation!.lockedAt).toEqual(expect.any(String));
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
      agentConfigs: createAgentConfigService({ ownerUserId: OWNER, sessionToken: OWNER, sp: stub.sp, projects: store, purposes: createPostgresAgentPurposeStore(database.db, OWNER) }),
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
    const sampling = { ...pipeline.samplings[0]!, revision: 0 };
    const evaluation = { ...pipeline.evaluations[0]!, revision: 0 };
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
    const updated = { ...evaluation, chatId: crypto.randomUUID(), status: { status: "failed" as const } };
    await s.runtime.updateEvaluation(updated, evaluation);
    expect(await s.observations.evaluator(seeded.projectId, evaluation.evaluationId)).toEqual({
      role: "evaluator", projectId: seeded.projectId, samplingId: sampling.samplingId, evaluationId: evaluation.evaluationId,
      ownerUserId: evaluation.evaluator.ownerUserId, chatId: updated.chatId, state: "not-started",
    });
    const other = await seedProject(database.db, OWNER, { datasets: [{ data: [makeData()] }] });
    await expect(s.observations.subject(other.projectId, sampling.samplingId)).rejects.toMatchObject({ entity: "sampling" });
    await expect(services(OTHER).observations.subject(seeded.projectId, sampling.samplingId)).rejects.toMatchObject({ entity: "project" });

    await s.runtime.admitRun(await buildCommand(s.plans, s.runtime, { projectId: seeded.projectId, operation: "execution", samplingIds: [sampling.samplingId] }));
    await expect(s.observations.subject(seeded.projectId, sampling.samplingId)).rejects.toMatchObject({ entity: "sampling" });
    await expect(s.observations.evaluator(seeded.projectId, evaluation.evaluationId)).rejects.toMatchObject({ entity: "evaluation" });
  });

  it("creates a Project and runs it through the HTTP control plane with the Runtime admission", async () => {
    const { first, second, subject, evaluator, schema } = await catalog();
    const ownerServices = createOwnerServices({ db: database.db, sp: stub.sp, bundles: {} as BundleDirectory, release, runQueue });
    const send = requestApp({
      webOrigin: WEB_ORIGIN, sp: stub.sp, ownerServices, spAdminToken: "admin-token", observation: {} as never,
      serviceAccount: { user: { id: OWNER, role: "user" }, email: "owner@test", sessionToken: OWNER },
    });
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
    const view = (await (await send(path, authorized(OWNER))).json() as { msg: { evaluation: { lockedAt: string | null }; currentRun: unknown } }).msg;
    expect(view.evaluation.lockedAt).toEqual(expect.any(String));
    expect(view.currentRun).toEqual({ runId: run.runId });
    expect(await (await send(`${path}/evaluation-plan`, jsonRequest("PUT", {
      userAgentId: evaluator, evaluationConcurrency: 1, outputSchemaId: schema.outputSchemaId,
    }, OWNER))).json()).toMatchObject({ code: "PROJECT_EVALUATION_PLAN_LOCKED" });
    expect((await send(path, authorized(OWNER, { method: "DELETE" }))).status).toBe(409);
    await settle(createPostgresWorkerRuntimeStore(database.db, runQueue), run.samplingIds, "succeeded");
    const preview = (await (await send(`${path}/runs/preview`, jsonRequest("POST", {
      operation: "evaluation", selector: { all: true },
    }, OWNER))).json() as { msg: {
      targets: { projectSampleIds: string[]; samplingIds: string[] };
      executionPlanDigest: string; evaluationPlanDigest: string;
    } }).msg;
    expect(preview.targets.samplingIds.sort()).toEqual([...run.samplingIds].sort());
    const submitted = await send(`${path}/runs`, jsonRequest("POST", {
      idempotencyKey: "evaluate", operation: "evaluation", selector: { all: true }, targets: preview.targets,
      expectedPlanDigests: { execution: preview.executionPlanDigest, evaluation: preview.evaluationPlanDigest },
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
