import type { EvaluationRecord, Sampling } from "@eval-platform/eval-contracts";
import { createDatasetService, DataInUseError, DatasetEntityNotFoundError, DatasetIdentityConflictError } from "@eval-platform/eval-dataset";
import {
  RuntimeEntityNotFoundError,
  RuntimeInputError,
  RuntimeProjectBusyError,
  RuntimeRecordConflictError,
  RuntimeRunIdentityConflictError,
  RuntimeRunStoppedError,
  type EvalRunResumer,
  type RuntimeRunAdmissionCommand,
} from "@eval-platform/eval-runtime";
import { count, eq, sql } from "drizzle-orm";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunQueue, openRunBoss, RUN_QUEUE, RUN_QUEUE_OPTIONS, type RunJob, type RunQueue } from "../run-worker-queue.js";
import { startEvalRunWorker } from "../worker.js";
import { createPostgresDatasetStore } from "./dataset.js";
import { ProjectRunStopConflictError } from "./errors.js";
import { createPostgresProjectPlanReader, createPostgresWorkerProjectPlanReader } from "./project-plans.js";
import { createPostgresProjectRunReader } from "./run-view.js";
import { createPostgresProjectRunControl, createPostgresRuntimeStore, createPostgresWorkerRuntimeStore } from "./runtime.js";
import { data as dataTable, datasets as datasetsTable, evaluations, projectEvaluationPlans, runs, samplings } from "./schema.js";
import { createTestDatabase } from "./test-database.js";
import { buildCommand, makeData, release, seedProject, settle } from "./test-fixtures.js";

const connection = process.env.DATABASE_URL;
const silent = pino({ level: "silent" });
const OWNER = "user-A";

describe.skipIf(!connection)("PostgreSQL Dataset, Run admission and Worker persistence", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let jobs: PgBoss;
  let runQueue: RunQueue;

  beforeAll(async () => {
    database = await createTestDatabase(connection!);
    jobs = await openRunBoss(database.connectionString, silent, { supervise: false });
    runQueue = createRunQueue(jobs);
  }, 30_000);

  beforeEach(async () => {
    await database.db.execute(sql`TRUNCATE TABLE eval_projects, eval_evaluation_output_schemas, eval_datasets, eval_data RESTART IDENTITY CASCADE`);
    await jobs.deleteAllJobs(RUN_QUEUE);
  });

  afterAll(async () => {
    await jobs?.stop();
    if (database) await database.destroy();
  }, 30_000);

  function stores(owner = OWNER) {
    return {
      plans: createPostgresProjectPlanReader(database.db, owner),
      store: createPostgresRuntimeStore(database.db, owner, release, runQueue),
      worker: createPostgresWorkerRuntimeStore(database.db, runQueue),
      control: createPostgresProjectRunControl(database.db, owner, runQueue),
      datasetService: createDatasetService(createPostgresDatasetStore(database.db, owner)),
    };
  }

  async function project(options: Parameters<typeof seedProject>[2] = { datasets: [{ data: [makeData()] }] }) {
    const seeded = await seedProject(database.db, OWNER, options);
    const { plans, store } = stores();
    const admit = async (input: Omit<Parameters<typeof buildCommand>[2], "projectId">) => {
      const command = await buildCommand(plans, store, { projectId: seeded.projectId, ...input });
      return { command, admission: await store.admitRun(command) };
    };
    return { ...seeded, admit };
  }

  async function runJobs(runId: string): Promise<JobWithMetadata<RunJob>[]> {
    return jobs.findJobs<RunJob>(RUN_QUEUE, { key: runId });
  }

  /**
   * Makes a retrying job due now. `startAfter: new Date()` uses the Node clock, which can run a few
   * milliseconds ahead of PostgreSQL's `now()`; a worker fetching immediately would then skip the job and,
   * with LISTEN/NOTIFY active, not poll again for 30 seconds. A start time in the past is due on any clock.
   */
  async function makeJobDue(jobId: string): Promise<void> {
    await jobs.update(RUN_QUEUE, undefined, { id: jobId, startAfter: new Date(Date.now() - 60_000) });
  }

  async function runJobStates(runId: string): Promise<string[]> {
    return (await runJobs(runId)).map((job) => job.state);
  }

  describe("Dataset catalog", () => {
    it("shares Data within one user and rejects cross-user Dataset and Data access", async () => {
      const { datasetService } = stores();
      const other = stores("user-B").datasetService;
      const dataset = await datasetService.createDataset({ name: "shared tasks" });
      const record = await datasetService.createData({ userPrompt: "build a page", evalPrompt: "evaluation", extra: { nullable: null } });
      const another = await datasetService.createDataset({ name: "another shared set" });
      await datasetService.attachData(dataset.datasetId, [record.dataId]);
      await datasetService.attachData(another.datasetId, [record.dataId, record.dataId]);
      await datasetService.updateData(record.dataId, { userPrompt: "updated", evalPrompt: "  evaluation the result  " });
      expect((await datasetService.listData(another.datasetId))[0]).toEqual(await datasetService.getData(record.dataId));
      const foreignDataset = await other.createDataset({ name: "other user's set" });
      expect(await other.getDataset(another.datasetId)).toBeNull();
      expect(await other.getData(record.dataId)).toBeNull();
      await expect(other.attachData(foreignDataset.datasetId, [record.dataId])).rejects.toBeInstanceOf(DatasetEntityNotFoundError);
      await expect(other.importDataset(await datasetService.exportDataset(another.datasetId, "json"), "json"))
        .rejects.toBeInstanceOf(DatasetIdentityConflictError);
      await expect(datasetService.deleteData(record.dataId)).rejects.toBeInstanceOf(DataInUseError);
      await datasetService.deleteDataset(another.datasetId);
      await datasetService.deleteDataset(dataset.datasetId);
      await datasetService.deleteData(record.dataId);
      expect(await datasetService.getData(record.dataId)).toBeNull();
    });

    it("soft-deletes Dataset and Data even when a Project snapshot copied them", async () => {
      const { datasetService } = stores();
      const dataset = await datasetService.createDataset({ name: "Temporary" });
      const record = await datasetService.createData({ userPrompt: "Temporary task" });
      await datasetService.attachData(dataset.datasetId, [record.dataId]);
      const seeded = await project({ datasets: [{ datasetId: dataset.datasetId, data: [record] }] });
      await datasetService.deleteDataset(dataset.datasetId);
      await datasetService.deleteData(record.dataId);
      expect(await datasetService.getData(record.dataId)).toBeNull();
      expect(await datasetService.listDatasets()).toEqual([]);
      expect((await database.db.select().from(dataTable).where(eq(dataTable.dataId, record.dataId)))[0]?.deletedAt).toBeInstanceOf(Date);
      expect((await database.db.select().from(datasetsTable).where(eq(datasetsTable.datasetId, dataset.datasetId)))[0]?.deletedAt)
        .toBeInstanceOf(Date);
      const [sample] = await stores().plans.getProjectSamples(seeded.projectId, [seeded.samples[0]!.projectSampleId]);
      expect(sample?.data).toEqual(record);
      await expect(datasetService.importDataset(JSON.stringify({ dataset, data: [] }), "json"))
        .rejects.toBeInstanceOf(DatasetIdentityConflictError);
    });

    it("keeps Prompt Dataset labels and both prompts required after import", async () => {
      const { datasetService } = stores();
      const imported = await datasetService.importPromptDataset({
        name: "Prompt cases", description: "Review tasks", format: "jsonl",
        content: '{"name":"First","description":"Case one","userPrompt":"Start","evalPrompt":"Judge"}',
      });
      const row = imported.data[0]!;
      await expect(datasetService.updateDataset(imported.dataset.datasetId, { name: "Renamed" })).rejects.toThrow();
      await expect(datasetService.updateData(row.dataId, { name: "First", description: "Case one", userPrompt: "Start" })).rejects.toThrow();
      const general = await datasetService.createData({ userPrompt: "Execution only" });
      await expect(datasetService.attachData(imported.dataset.datasetId, [general.dataId])).rejects.toThrow();
      expect(await datasetService.listData(imported.dataset.datasetId)).toHaveLength(1);
    });

    it("imports a whole Dataset atomically and admits simultaneous identical imports", async () => {
      const { datasetService } = stores();
      const existing = await datasetService.createData({ userPrompt: "existing" });
      const datasetId = crypto.randomUUID();
      const newDataId = crypto.randomUUID();
      await expect(datasetService.importDataset(JSON.stringify({
        dataset: { datasetId, name: "import" },
        data: [{ dataId: newDataId, userPrompt: "new" }, { dataId: existing.dataId, userPrompt: "changed" }],
      }), "json")).rejects.toBeInstanceOf(DatasetIdentityConflictError);
      expect(await datasetService.getDataset(datasetId)).toBeNull();
      expect(await datasetService.getData(newDataId)).toBeNull();
      const document = JSON.stringify({ dataset: { datasetId, name: "import" }, data: [{ dataId: newDataId, userPrompt: "new" }, existing] });
      const [first, second] = await Promise.all([
        datasetService.importDataset(document, "json"), datasetService.importDataset(document, "json"),
      ]);
      expect(first).toEqual(second);
      expect((await datasetService.listData(datasetId)).map((entry) => entry.dataId).sort()).toEqual([existing.dataId, newDataId].sort());
    });

    it("rolls back a missing Data attachment", async () => {
      const { datasetService } = stores();
      const collection = await datasetService.createDataset({ name: "tasks" });
      const record = await datasetService.createData({ userPrompt: "task" });
      await expect(datasetService.attachData(collection.datasetId, [record.dataId, crypto.randomUUID()]))
        .rejects.toBeInstanceOf(DatasetEntityNotFoundError);
      expect(await datasetService.listData(collection.datasetId)).toEqual([]);
    });
  });

  describe("Run admission", () => {
    it("replays a matching key, rejects other facts, busy Projects and superseded keys", async () => {
      const { admit, projectId } = await project();
      const { store, worker } = stores();
      const { command, admission } = await admit({ operation: "execution", idempotencyKey: "first" });
      expect(admission).toEqual({ run: command.run, created: true });
      const replay = await buildCommand(stores().plans, store, { projectId, operation: "execution", idempotencyKey: "first" });
      expect(await store.admitRun(replay)).toEqual({ run: command.run, created: false });
      await expect(store.admitRun({ ...replay, run: { ...replay.run, requestIdentity: { idempotencyKey: "first", requestFingerprint: "other" } } }))
        .rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);
      await expect(admit({ operation: "execution", idempotencyKey: "second" })).rejects.toMatchObject({
        name: "RuntimeProjectBusyError", activeRunId: command.run.runId,
      });
      expect(await store.findRunByIdempotencyKey(projectId, "first")).toEqual(command.run);

      await settle(worker, command.run.samplingIds, "succeeded");
      const second = await admit({ operation: "execution", idempotencyKey: "second" });
      expect(second.admission.created).toBe(true);
      expect([...second.command.replacedSamplingIds].sort()).toEqual([...command.run.samplingIds].sort());
      await expect(store.findRunByIdempotencyKey(projectId, "first")).rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);
      await expect(store.admitRun(replay)).rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);
      // Runs are never deleted; the replaced Run simply has no current members.
      expect(await store.getRun(command.run.runId)).toMatchObject({ runId: command.run.runId, samplingIds: [] });
    });

    it("admits one Run for concurrent same-key requests across Stores", async () => {
      const { projectId } = await project();
      const { plans, store, worker } = stores();
      const first = await buildCommand(plans, store, { projectId, operation: "execution", idempotencyKey: "same" });
      const second = await buildCommand(plans, store, { projectId, operation: "execution", idempotencyKey: "same" });
      const results = await Promise.all([store.admitRun(first), worker.admitRun(second)]);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(results[0]!.run).toEqual(results[1]!.run);
      expect((await database.db.select({ n: count() }).from(samplings))[0]!.n).toBe(1);
    });

    it("rechecks plan digests, the evaluation plan, targets and successful Samplings inside the transaction", async () => {
      const { admit, projectId, samples } = await project({ datasets: [{ data: [makeData(), makeData()] }], samplingCount: 2 });
      const { plans, store, worker } = stores();
      const base = await buildCommand(plans, store, { projectId, operation: "execution" });
      await expect(store.admitRun({ ...base, run: { ...base.run, planDigests: { execution: "stale" } } }))
        .rejects.toMatchObject({ name: "RuntimeAdmissionConflictError", reason: "plan-changed" });
      const pipeline = await buildCommand(plans, store, { projectId, operation: "pipeline" });
      await expect(store.admitRun({ ...pipeline, run: { ...pipeline.run, planDigests: { ...pipeline.run.planDigests, evaluation: "none" } } }))
        .rejects.toMatchObject({ reason: "evaluation-plan-required" });
      await expect(store.admitRun({ ...base, run: { ...base.run, samplingIds: [] }, samplings: [] }))
        .rejects.toMatchObject({ reason: "empty-targets" });
      await expect(store.admitRun({ ...base, run: { ...base.run, targets: { projectSampleIds: ["missing"], samplingIds: [] } } }))
        .rejects.toMatchObject({ name: "RuntimeEntityNotFoundError", entity: "project-sample" });
      await expect(store.admitRun({ ...base, run: { ...base.run, phases: ["evaluation"] } }))
        .rejects.toMatchObject({ name: "RuntimeInputError", message: expect.stringContaining("eval_runs_phases_ck") });

      const { command: first } = await admit({ operation: "execution" });
      await settle(worker, first.run.samplingIds.slice(0, 2), "succeeded");
      await settle(worker, first.run.samplingIds.slice(2), "failed");
      // A preview taken now, then outdated by another admission, must not replace the newer Samplings.
      const stale = await buildCommand(plans, store, { projectId, operation: "execution", projectSampleIds: [samples[0]!.projectSampleId] });
      const { command: newer } = await admit({ operation: "execution", samplingIds: [first.run.samplingIds[0]!] });
      await settle(worker, newer.run.samplingIds, "succeeded");
      await expect(store.admitRun(stale)).rejects.toMatchObject({ reason: "stale-targets" });
      const goneTarget = await buildCommand(plans, store, { projectId, operation: "execution", samplingIds: [first.run.samplingIds[1]!] });
      await expect(store.admitRun({ ...goneTarget, run: { ...goneTarget.run, targets: { projectSampleIds: [], samplingIds: [first.run.samplingIds[0]!] } } }))
        .rejects.toMatchObject({ reason: "stale-targets" });

      const evaluation = await seedProject(database.db, OWNER, { datasets: [{ data: [makeData()] }], evaluation: true });
      const evaluated = await buildCommand(plans, store, { projectId: evaluation.projectId, operation: "execution" });
      await store.admitRun(evaluated);
      await settle(worker, evaluated.run.samplingIds, "failed");
      await expect(admitEvaluationOf(evaluation.projectId, [...evaluated.run.samplingIds]))
        .rejects.toMatchObject({ reason: "sampling-unavailable" });
      await expect(admitEvaluationOf(evaluation.projectId, [first.run.samplingIds[1]!]))
        .rejects.toMatchObject({ reason: "sampling-unavailable" });
    });

    async function admitEvaluationOf(projectId: string, samplingIds: string[]) {
      const { plans, store } = stores();
      return store.admitRun(await buildCommand(plans, store, { projectId, operation: "evaluation", samplingIds }));
    }

    it("locks the evaluation plan with the first evaluating Run and keeps it locked after a stop", async () => {
      const { admit, projectId } = await project({ datasets: [{ data: [makeData()] }], evaluation: true });
      const { worker, control } = stores();
      const lockedAt = async () => (await database.db.select({ lockedAt: projectEvaluationPlans.lockedAt })
        .from(projectEvaluationPlans).where(eq(projectEvaluationPlans.projectId, projectId)))[0]?.lockedAt;
      const { command: execution } = await admit({ operation: "execution" });
      expect(await lockedAt()).toBeNull();
      await settle(worker, execution.run.samplingIds, "succeeded");
      const { command: evaluation } = await admit({ operation: "evaluation" });
      expect(await lockedAt()).toBeInstanceOf(Date);
      await control.stopRun(projectId, evaluation.run.runId);
      await settle(worker, execution.run.samplingIds, "cancelled");
      expect(await worker.markRunStopFinalized(evaluation.run.runId)).toBe(true);
      expect(await lockedAt()).toBeInstanceOf(Date);
    });

    it("partially replaces selected Samplings and keeps unselected results and their Run memberships", async () => {
      const { admit, samples } = await project({ datasets: [{ data: [makeData(), makeData()] }], samplingCount: 2, evaluation: true });
      const { store, worker } = stores();
      const { command: pipeline } = await admit({ operation: "pipeline" });
      await settle(worker, pipeline.run.samplingIds, "succeeded");
      const [replacedId, ...keptIds] = pipeline.run.samplingIds as [string, ...string[]];
      const keptEvaluations = pipeline.evaluations.filter((evaluation) => evaluation.samplingId !== replacedId);

      const { command: single } = await admit({ operation: "execution", samplingIds: [replacedId] });
      expect(single.replacedSamplingIds).toEqual([replacedId]);
      expect(single.samplings).toHaveLength(1);
      expect(await store.getSampling(replacedId)).toBeNull();
      expect(await store.listEvaluations(replacedId)).toEqual([]);
      expect((await store.getSamplings(keptIds)).every((sampling) => sampling?.execution.status === "succeeded")).toBe(true);
      expect(await store.getEvaluations(keptEvaluations.map((evaluation) => evaluation.evaluationId)))
        .toEqual(keptEvaluations.map((evaluation) => ({ ...evaluation, status: { status: "succeeded" } })));
      const original = await store.getRun(pipeline.run.runId);
      expect(original?.samplingIds).toEqual(keptIds);
      expect(original?.evaluationIds).toEqual(keptEvaluations.map((evaluation) => evaluation.evaluationId));

      await settle(worker, single.run.samplingIds, "succeeded");
      const { command: sample } = await admit({ operation: "execution", projectSampleIds: [samples[1]!.projectSampleId] });
      const secondSample = pipeline.samplings.filter((sampling) => sampling.projectSampleId === samples[1]!.projectSampleId)
        .map((sampling) => sampling.samplingId);
      expect([...sample.replacedSamplingIds].sort()).toEqual(secondSample.sort());
      expect(sample.samplings).toHaveLength(2);
      expect((await store.getRun(pipeline.run.runId))?.samplingIds).toHaveLength(1);
    });

    it("evaluation-only deletes only the target Evaluations and never touches Sampling facts", async () => {
      const { admit } = await project({ datasets: [{ data: [makeData()] }], samplingCount: 2, evaluation: true });
      const { store, worker } = stores();
      const { command: pipeline } = await admit({ operation: "pipeline" });
      await settle(worker, pipeline.run.samplingIds, "succeeded");
      const [target, other] = pipeline.run.samplingIds as [string, string];
      const before = await store.getSamplings([target, other]);
      const { command: evaluation } = await admit({ operation: "evaluation", samplingIds: [target] });
      expect(evaluation.replacedSamplingIds).toEqual([]);
      expect(await store.getSamplings([target, other])).toEqual(before);
      expect((await store.listEvaluations(target)).map((record) => record.evaluationId)).toEqual(evaluation.run.evaluationIds);
      expect(await store.listEvaluations(other)).toHaveLength(1);
      const original = await store.getRun(pipeline.run.runId);
      expect(original?.samplingIds).toEqual([target, other]);
      expect(original?.evaluationIds).toEqual([pipeline.evaluations[1]!.evaluationId]);
      expect((await store.getRun(evaluation.run.runId))?.samplingIds).toEqual([target]);
      const view = await createPostgresProjectRunReader(database.db, OWNER)(evaluation.run.projectId, evaluation.run.runId);
      expect(view?.evaluations.map((record) => record.samplingId)).toEqual([target]);
    });

    it("admits, replaces and evaluates batches beyond one SQL statement's parameter limit", async () => {
      const data = Array.from({ length: 1_200 }, () => makeData());
      const { admit } = await project({ datasets: [{ data }], samplingCount: 12, evaluation: true });
      const { store, worker } = stores();
      const { command: execution } = await admit({ operation: "execution" });
      expect(execution.run.samplingIds).toHaveLength(14_400);
      await database.db.execute(sql`UPDATE eval_samplings SET facts = jsonb_set(facts, '{execution,status}', '"succeeded"'::jsonb)`);
      const { command: evaluation } = await admit({ operation: "evaluation" });
      expect((await database.db.select({ n: count() }).from(evaluations))[0]!.n).toBe(14_400);
      expect((await store.getRun(evaluation.run.runId))?.evaluationIds).toHaveLength(14_400);
      await database.db.execute(sql`UPDATE eval_evaluations SET facts = jsonb_set(facts, '{status,status}', '"succeeded"'::jsonb)`);
      const { command: replacement } = await admit({ operation: "execution" });
      expect(replacement.replacedSamplingIds).toHaveLength(14_400);
      expect((await database.db.select({ n: count() }).from(evaluations))[0]!.n).toBe(0);
      expect((await database.db.select({ n: count() }).from(samplings))[0]!.n).toBe(14_400);
      expect(await worker.getRun(execution.run.runId)).toMatchObject({ samplingIds: [], evaluationIds: [] });
    }, 120_000);

    it("rejects a Run on a Project from another source release or owner", async () => {
      const { projectId } = await project();
      const { plans } = stores();
      const otherRelease = createPostgresRuntimeStore(database.db, OWNER, { ...release, sourceBranch: "release-3.0.0" }, runQueue);
      const command = await buildCommand(plans, otherRelease, { projectId, operation: "execution" });
      await expect(otherRelease.admitRun(command)).rejects.toMatchObject({ reason: "source-branch" });
      const foreign = createPostgresRuntimeStore(database.db, "user-B", release, runQueue);
      await expect(foreign.admitRun(command)).rejects.toBeInstanceOf(RuntimeEntityNotFoundError);
      expect(await createPostgresProjectPlanReader(database.db, "user-B").getProjectPlan(projectId)).toBeNull();
      expect(await createPostgresWorkerProjectPlanReader(database.db).getProjectPlan(projectId)).not.toBeNull();
    });

    it("lists current Samplings grouped by ProjectSample in input order", async () => {
      const { admit, projectId, samples } = await project({ datasets: [{ data: [makeData(), makeData()] }], samplingCount: 2 });
      const { store } = stores();
      const { command } = await admit({ operation: "execution" });
      const ids = [samples[1]!.projectSampleId, samples[0]!.projectSampleId];
      const listed = await store.listProjectSamplings(projectId, ids);
      expect(listed.map((sampling) => sampling.projectSampleId)).toEqual([ids[0], ids[0], ids[1], ids[1]]);
      expect(listed.slice(0, 2).map((sampling) => sampling.samplingId))
        .toEqual(command.samplings.filter((sampling) => sampling.projectSampleId === ids[0]).map((sampling) => sampling.samplingId).sort());
      expect(await stores("user-B").store.listProjectSamplings(projectId, ids)).toEqual([]);
    });

    it("rejects stale Sampling and Evaluation replacements after newer facts commit and scopes them by owner", async () => {
      const { admit } = await project({ datasets: [{ data: [makeData()] }], evaluation: true });
      const { store } = stores();
      const { command } = await admit({ operation: "pipeline" });
      const initial = command.samplings[0]!;
      const evaluation = command.evaluations[0]!;
      const running: Sampling = { ...initial, subjectChatId: "subject-chat", execution: { status: "running" } };
      await store.updateSampling(running, initial);
      await expect(store.updateSampling({ ...initial, execution: { status: "failed" } }, initial)).rejects.toBeInstanceOf(RuntimeRecordConflictError);
      await expect(store.updateSampling(running, { ...running, projectSampleId: "other" })).rejects.toBeInstanceOf(RuntimeRecordConflictError);
      expect(await store.getSampling(initial.samplingId)).toEqual(running);
      const updated: EvaluationRecord = { ...evaluation, chatId: "evaluator-chat", status: { status: "running" } };
      await store.updateEvaluation(updated, evaluation);
      await expect(store.updateEvaluation({ ...evaluation, status: { status: "failed" } }, evaluation)).rejects.toBeInstanceOf(RuntimeRecordConflictError);
      const foreign = stores("user-B").store;
      expect(await foreign.getEvaluation(evaluation.evaluationId)).toBeNull();
      expect(await foreign.listEvaluations(initial.samplingId)).toEqual([]);
      await expect(foreign.updateEvaluation(updated, updated)).rejects.toBeInstanceOf(RuntimeRecordConflictError);
    });
  });

  describe("Run stop and Worker scheduling", () => {
    it("persists an idempotent stop under the admission lock and reopens admission after cleanup", async () => {
      const { admit, projectId } = await project();
      const { worker, control } = stores();
      const foreign = stores("user-B").control;
      expect(await control.getCurrentRun(projectId)).toBeNull();
      expect(await control.stopRun(projectId, "missing")).toBeNull();
      const { command: prior } = await admit({ operation: "execution" });
      await settle(worker, prior.run.samplingIds, "succeeded");
      await expect(control.stopRun(projectId, prior.run.runId)).rejects.toBeInstanceOf(ProjectRunStopConflictError);
      const { command } = await admit({ operation: "execution" });
      expect(await control.getCurrentRun(projectId)).toEqual({ runId: command.run.runId });
      expect(await foreign.stopRun(projectId, command.run.runId)).toBeNull();
      expect(await control.stopRun(projectId, command.run.runId)).toEqual({ runId: command.run.runId, stopRequested: true });
      expect(await control.stopRun(projectId, command.run.runId)).toEqual({ runId: command.run.runId, stopRequested: true });
      expect(await worker.isRunStopRequested(command.run.runId)).toBe(true);
      expect(await worker.markRunStopFinalized(command.run.runId)).toBe(false);
      await settle(worker, command.run.samplingIds, "cancelled");
      expect(await control.getCurrentRun(projectId)).toEqual({ runId: command.run.runId, stopRequested: true });
      await expect(admit({ operation: "execution" })).rejects.toBeInstanceOf(RuntimeProjectBusyError);
      expect(await worker.markRunStopFinalized(command.run.runId)).toBe(true);
      expect(await control.getCurrentRun(projectId)).toBeNull();
      const { command: next } = await admit({ operation: "execution" });
      expect((await worker.getRun(next.run.runId))?.stopRequested).toBeUndefined();
    });

    it("commits a stop without waiting for SP and blocks later stage dispatch", async () => {
      const { admit, projectId } = await project();
      const { worker, control } = stores();
      const { command } = await admit({ operation: "execution" });
      let entered!: () => void;
      let release!: () => void;
      const dispatchEntered = new Promise<void>((resolve) => { entered = resolve; });
      const dispatchHold = new Promise<void>((resolve) => { release = resolve; });
      const dispatch = worker.withRunDispatchGate(command.run.runId, async () => {
        entered();
        await dispatchHold;
        return "submitted";
      });
      await dispatchEntered;
      try {
        await expect(control.stopRun(projectId, command.run.runId)).resolves.toEqual({ runId: command.run.runId, stopRequested: true });
        const late = vi.fn(async () => "late");
        await expect(worker.withRunDispatchGate(command.run.runId, late)).rejects.toBeInstanceOf(RuntimeRunStoppedError);
        expect(late).not.toHaveBeenCalled();
      } finally {
        release();
      }
      await expect(dispatch).resolves.toBe("submitted");
    });

    it("enqueues one Run job inside admission and stop transactions, never for a rolled-back write", async () => {
      const { projectId } = await project();
      const { plans, store } = stores();
      const command = await buildCommand(plans, store, { projectId, operation: "execution" });
      const rollback: RunQueue = {
        async enqueue(transaction, runId) {
          await runQueue.enqueue(transaction, runId);
          throw new Error("commit aborted");
        },
      };
      await expect(createPostgresWorkerRuntimeStore(database.db, rollback).admitRun(command)).rejects.toThrow("commit aborted");
      expect(await store.getRun(command.run.runId)).toBeNull();
      expect(await runJobs(command.run.runId)).toEqual([]);
      expect(await store.admitRun(command)).toEqual({ run: command.run, created: true });
      expect(await store.admitRun(command)).toEqual({ run: command.run, created: false });
      const [job, ...duplicates] = await runJobs(command.run.runId);
      expect(duplicates).toEqual([]);
      expect(job).toMatchObject({
        state: "created", data: { runId: command.run.runId }, singletonKey: command.run.runId, policy: RUN_QUEUE_OPTIONS.policy,
      });
      await jobs.deleteJob(RUN_QUEUE, job!.id);
      await expect(createPostgresProjectRunControl(database.db, OWNER, rollback).stopRun(projectId, command.run.runId))
        .rejects.toThrow("commit aborted");
      expect((await store.getRun(command.run.runId))?.stopRequested).toBeUndefined();
      expect(await stores().control.stopRun(projectId, command.run.runId)).toEqual({ runId: command.run.runId, stopRequested: true });
      expect(await runJobStates(command.run.runId)).toEqual(["created"]);
    });

    it("derives whether a Run is active from unfinished stages and pending stop cleanup", async () => {
      const { admit } = await project({ datasets: [{ data: [makeData()] }], evaluation: true });
      const { worker } = stores();
      const { command: execution } = await admit({ operation: "execution" });
      expect(await worker.isRunActive(execution.run.runId)).toBe(true);
      expect(await worker.isRunActive(crypto.randomUUID())).toBe(false);
      await settle(worker, execution.run.samplingIds, "succeeded");
      expect(await worker.isRunActive(execution.run.runId)).toBe(false);
      const { command: evaluation } = await admit({ operation: "evaluation" });
      expect(await worker.isRunActive(evaluation.run.runId)).toBe(true);
      const [record] = await worker.getEvaluations(evaluation.run.evaluationIds);
      await worker.updateEvaluation({ ...record!, status: { status: "succeeded" } }, record!);
      expect(await worker.isRunActive(evaluation.run.runId)).toBe(false);
    });

    async function startWorker(runtime: EvalRunResumer, concurrency = 2) {
      const boss = await openRunBoss(database.connectionString, silent, { useListenNotify: true });
      const store = createPostgresWorkerRuntimeStore(database.db, createRunQueue(boss));
      const worker = await startEvalRunWorker({ boss, runtime, store, logger: silent, concurrency });
      return {
        async close() {
          await worker.close();
          await boss.stop();
        },
      };
    }

    function heldRuntime(heldRunId?: string) {
      const { worker } = stores();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const runtime = {
        resume: vi.fn(async (runId: string, _signal?: AbortSignal) => {
          if (runId === heldRunId) await held;
          const run = await worker.getRun(runId);
          await settle(worker, run?.samplingIds ?? [], "succeeded");
        }),
        interrupt: vi.fn(async (_runId: string) => undefined),
        stop: vi.fn(async (_runId: string) => undefined),
      };
      return { runtime, release };
    }

    it("executes admitted Runs from durable jobs, holding each Run on one worker at a time", async () => {
      const first = await project();
      const second = await project();
      const { command: firstRun } = await first.admit({ operation: "execution" });
      const { runtime, release } = heldRuntime(firstRun.run.runId);
      const workers = [await startWorker(runtime), await startWorker(runtime)];
      try {
        await vi.waitFor(() => expect(runtime.resume).toHaveBeenCalledWith(firstRun.run.runId, expect.any(AbortSignal)));
        await database.db.transaction((transaction) => runQueue.enqueue(transaction, firstRun.run.runId));
        expect(await runJobStates(firstRun.run.runId)).toEqual(["active"]);
        const { command: secondRun } = await second.admit({ operation: "execution" });
        await vi.waitFor(async () => expect(await runJobStates(secondRun.run.runId)).toEqual(["completed"]), { timeout: 10_000 });
        expect(await runJobStates(firstRun.run.runId)).toEqual(["active"]);
        release();
        await vi.waitFor(async () => expect(await runJobStates(firstRun.run.runId)).toEqual(["completed"]), { timeout: 10_000 });
      } finally {
        release();
        await Promise.all(workers.map((worker) => worker.close()));
      }
    }, 20_000);

    it("retries a Run that is still active after a pass", async () => {
      const { admit } = await project();
      const { command } = await admit({ operation: "execution" });
      const { runtime } = heldRuntime();
      runtime.resume.mockImplementationOnce(async () => undefined);
      const worker = await startWorker(runtime);
      try {
        await vi.waitFor(async () => expect(await runJobStates(command.run.runId)).toEqual(["retry"]), { timeout: 10_000 });
        const [job] = await runJobs(command.run.runId);
        expect(job?.output).toMatchObject({ name: "RunStillActiveError" });
        await makeJobDue(job!.id);
        // With LISTEN/NOTIFY active, pg-boss falls back to a 30-second poll for jobs that become due without a notification.
        await vi.waitFor(async () => expect(await runJobStates(command.run.runId)).toEqual(["completed"]), { timeout: 40_000 });
        expect(runtime.resume).toHaveBeenCalledTimes(2);
      } finally {
        await worker.close();
      }
    }, 60_000);

    it("redelivers a Run whose worker stopped heartbeating", async () => {
      const { admit } = await project();
      const { command } = await admit({ operation: "execution" });
      const crashedRuntime = heldRuntime(command.run.runId);
      const crashed = await startWorker(crashedRuntime.runtime, 1);
      const monitor = new PgBoss({ connectionString: database.connectionString, supervise: false, schedule: false, monitorIntervalSeconds: 1 });
      const monitorErrors = vi.fn();
      monitor.on("error", monitorErrors);
      await monitor.start();
      try {
        await vi.waitFor(() => expect(crashedRuntime.runtime.resume).toHaveBeenCalledOnce());
        const [job] = await runJobs(command.run.runId);
        await database.db.execute(sql`UPDATE pgboss.job SET heartbeat_on = now() - interval '1 hour' WHERE id = ${job!.id}`);
        await vi.waitFor(async () => {
          await monitor.supervise(RUN_QUEUE);
          expect(await runJobStates(command.run.runId)).toEqual(["retry"]);
        }, { timeout: 10_000, interval: 250 });
        await makeJobDue(job!.id);
        const { runtime: recoveredRuntime } = heldRuntime();
        const recovered = await startWorker(recoveredRuntime);
        try {
          await vi.waitFor(async () => expect(await runJobStates(command.run.runId)).toEqual(["completed"]), { timeout: 10_000 });
          expect(recoveredRuntime.resume).toHaveBeenCalledExactlyOnceWith(command.run.runId, expect.any(AbortSignal));
        } finally {
          await recovered.close();
        }
        expect(monitorErrors).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
        crashedRuntime.release();
        await crashed.close();
      }
    }, 30_000);

    it("wakes the worker holding a Run on a persisted stop and finalizes the stop", async () => {
      const { admit, projectId } = await project();
      const { worker: store, control } = stores();
      const { command } = await admit({ operation: "execution" });
      const resumer = {
        resume: vi.fn((_runId: string, signal?: AbortSignal) => new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        })),
        interrupt: vi.fn(async (_runId: string) => undefined),
        stop: vi.fn((runId: string) => store.getRun(runId).then((run) => settle(store, run?.samplingIds ?? [], "cancelled"))),
      };
      const worker = await startWorker(resumer);
      try {
        await vi.waitFor(() => expect(resumer.resume).toHaveBeenCalledOnce());
        await control.stopRun(projectId, command.run.runId);
        await vi.waitFor(async () => expect(await runJobStates(command.run.runId)).toEqual(["completed"]), { timeout: 10_000 });
        expect(resumer.interrupt).toHaveBeenCalledWith(command.run.runId);
        expect(resumer.stop).toHaveBeenCalledExactlyOnceWith(command.run.runId);
        expect((await store.getRun(command.run.runId))?.stopFinalized).toBe(true);
      } finally {
        await worker.close();
      }
    }, 20_000);
  });

  it("enforces Run identity and plan columns in the baseline", async () => {
    const { admit } = await project();
    const { command } = await admit({ operation: "execution" });
    const [row] = await database.db.select().from(runs).where(eq(runs.runId, command.run.runId));
    expect(row).toMatchObject({ operation: "execution", sequence: 1, evaluationPlanDigest: null, targets: command.run.targets });
    await expect(database.db.update(runs).set({ evaluationPlanDigest: "x" })
      .where(eq(runs.runId, command.run.runId))).rejects.toThrow();
    const invalid: RuntimeRunAdmissionCommand = { ...command, run: { ...command.run, stopRequested: true } };
    await expect(stores().store.admitRun(invalid)).rejects.toBeInstanceOf(RuntimeInputError);
  });
});
