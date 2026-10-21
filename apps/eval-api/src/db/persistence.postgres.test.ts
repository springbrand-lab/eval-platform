import { createHash } from "node:crypto";
import { isStageRecoveryPending, RESOURCE_WAIT_MS, startResourceWait, type Sampling, type SamplingStageState } from "@eval-platform/eval-contracts";
import { createDatasetService, DataInUseError, DatasetEntityNotFoundError, DatasetIdentityConflictError, DatasetInputError } from "@eval-platform/eval-dataset";
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
import { createRunQueue, openRunBoss, RUN_QUEUE, RUN_QUEUE_OPTIONS, type RunJob, type RunQueue, type RunWorkerQueue } from "../run-worker-queue.js";
import { createRunJobHandler, RunStillActiveError, startEvalRunWorker } from "../worker.js";
import { createPostgresDatasetStore } from "./dataset.js";
import { ProjectRunStopConflictError } from "./errors.js";
import { createPostgresProjectPlanReader, createPostgresWorkerProjectPlanReader } from "./project-plans.js";
import { createPostgresProjectRunReader } from "./run-view.js";
import { nextResourceCheckAt } from "./run-records.js";
import { createPostgresProjectRunControl, createPostgresRuntimeStore, createPostgresWorkerRuntimeStore, readProjectRunState } from "./runtime.js";
import { data as dataTable, datasets as datasetsTable, evaluations, projectEvaluationPlans, projects, runs, samplings } from "./schema.js";
import { createTestDatabase } from "./test-database.js";
import { createPostgresEvaluationSubmissions } from "./evaluation-submissions.js";
import { buildCommand, makeData, release, seedProject, settle } from "./test-fixtures.js";

const connection = process.env.DATABASE_URL;
const silent = pino({ level: "silent" });
const OWNER = "user-A";

describe.skipIf(!connection)("PostgreSQL Dataset, Run admission and Worker persistence", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let jobs: PgBoss;
  let runQueue: RunWorkerQueue;

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

  async function observationFailedEvaluation() {
    const seeded = await project({ datasets: [{ data: [makeData()] }], evaluation: true });
    const { command } = await seeded.admit({ operation: "pipeline" });
    const { worker } = stores();
    const sampling = (await worker.getSampling(command.run.samplingIds[0]!))!;
    await worker.updateSampling({ ...sampling, execution: { status: "succeeded" } }, sampling);
    const evaluationId = command.run.evaluationIds[0]!;
    const original = (await worker.getEvaluation(evaluationId))!;
    await worker.updateEvaluation({
      ...original, chatId: "evaluating-chat",
      status: { status: "failed", lastError: "status observation disconnected" },
      attempts: [{
        evaluationAttemptId: "evaluating-attempt", evaluationId, attemptNumber: 1,
        status: "running", startedAt: "2026-10-21T07:44:59.634Z", submissionId: "evaluating-submission",
        resources: { status: "pending", scope: { chatId: "evaluating-chat", idempotencyKey: `evaluation:${sampling.samplingId}` } },
      }],
    }, original);
    return { worker, runId: command.run.runId, evaluationId };
  }

  it("queues collection atomically, deduplicates requests and discovers an older recovered Run", async () => {
    const seeded = await project({ datasets: [{ data: [makeData(), makeData()] }] });
    const { store, worker, control } = stores();
    const first = await seeded.admit({ operation: "execution", projectSampleIds: [seeded.samples[0]!.projectSampleId] });
    const id = first.command.run.samplingIds[0]!;
    const original = (await store.getSampling(id))!;
    // An exhausted evidence export keeps its progress, so the recollection resumes instead of restarting it.
    const evidenceExport = { submissionId: "submission", passes: 5, lastError: "evidence export failed: R2 unavailable", progress: {
      exportedAt: "2026-10-16T00:00:02.000Z", artifacts: [{ path: "/a.txt", size: 1, mediaType: "text/plain", sha256: "a".repeat(64) }],
      subjectInputs: [], omitted: [], trajectory: { afterSeq: 200, parts: [{ sha256: "b".repeat(64), size: 10, events: 200 }] },
    } };
    const completed = { ...original, subjectChatId: "chat", execution: { status: "failed" as const, lastError: "output unavailable" }, evidenceExport, executionAttempts: [{ executionAttemptId: "attempt", samplingId: id, attemptNumber: 1, status: "completed" as const, submissionId: "submission", startedAt: "2026-10-16T00:00:00Z", completedAt: "2026-10-16T00:00:01Z" }] };
    await worker.updateSampling(completed, original);
    const second = await seeded.admit({ operation: "execution", projectSampleIds: [seeded.samples[1]!.projectSampleId] });
    await expect(control.recollect(seeded.projectId, "execution", id)).rejects.toBeInstanceOf(RuntimeProjectBusyError);
    await settle(worker, second.command.run.samplingIds, "succeeded");
    await expect(stores("other-owner").control.recollect(seeded.projectId, "execution", id)).rejects.toBeInstanceOf(RuntimeEntityNotFoundError);
    const requests = await Promise.all([control.recollect(seeded.projectId, "execution", id), control.recollect(seeded.projectId, "execution", id)]);
    expect(requests).toEqual([{ runId: first.command.run.runId, queued: true }, { runId: first.command.run.runId, queued: true }]);
    expect(await readProjectRunState(database.db, OWNER, seeded.projectId)).toEqual({ runSequence: 2, currentRun: { runId: first.command.run.runId } });
    const pending = (await store.getSampling(id))!;
    expect(pending.execution).toEqual({ status: "retrying", collectionPending: true });
    expect(pending.executionAttempts).toEqual(completed.executionAttempts);
    expect(pending.evidenceExport).toEqual(evidenceExport);
    expect(await jobs.findJobs(RUN_QUEUE, { key: `collection:${first.command.run.runId}` })).toHaveLength(1);
    await worker.updateSampling({ ...pending, execution: { status: "succeeded" } }, pending);
    expect(await control.recollect(seeded.projectId, "execution", id)).toEqual({ runId: first.command.run.runId, queued: false });
    expect(await control.getCurrentRun(seeded.projectId)).toBeNull();
  });

  it("atomically accepts the first MCP result and idempotently replays it", async () => {
    const seeded = await project({ datasets: [{ data: [makeData()] }], evaluation: true });
    const { admission, command } = await seeded.admit({ operation: "pipeline" });
    expect(admission.created).toBe(true);
    const evaluationId = command.run.evaluationIds[0]!;
    const submissions = createPostgresEvaluationSubmissions(database.db, runQueue);
    expect(await submissions.read(evaluationId)).toBeUndefined();
    expect(await submissions.target("missing")).toBeNull();
    expect(await submissions.target(evaluationId)).toEqual({
      ownerUserId: OWNER, status: "queued", schema: { type: "object", properties: { score: { type: "number" } } },
    });
    const { worker } = stores();
    const sampling = (await worker.getSampling(command.run.samplingIds[0]!))!;
    await worker.updateSampling({ ...sampling, execution: { status: "succeeded" } }, sampling);
    const original = (await worker.getEvaluation(evaluationId))!;
    const observing = { ...original, chatId: "evaluating-chat", status: { status: "failed" as const, lastError: "status observation disconnected" } };
    await worker.updateEvaluation(observing, original);
    const input = { evaluationId, ownerUserId: OWNER, content: '{"score":1}', submittedAt: new Date() };
    expect((await Promise.all([submissions.save(input), submissions.save(input)])).sort()).toEqual(["accepted", "replayed"]);
    expect(await submissions.save({ ...input, content: '{ "score": 1 }' })).toBe("replayed");
    expect(await submissions.save({ ...input, content: '{"score":2}' })).toBe("conflict");
    expect(await submissions.read(evaluationId)).toEqual({
      path: "mcp:submit_evaluation", content: '{"score":1}',
      contentHash: "sha256:" + createHash("sha256").update('{"score":1}').digest("hex"),
    });
    const accepted = (await worker.getEvaluation(evaluationId))!;
    expect(accepted).toMatchObject({ status: { status: "succeeded" }, output: {
      status: "succeeded", structuredOutput: { source: "submission", content: '{"score":1}' },
      trajectory: { source: "evaluator", path: "/api/chats/evaluating-chat/trajectory" },
    } });
    expect(accepted.status.lastError).toBeUndefined();
    expect(accepted.attempts).toEqual(observing.attempts);
    // The accepted result is a write like any other: it bumps the revision a stale Worker write must match.
    expect(accepted.revision).toBe(original.revision + 2);
    await expect(worker.updateEvaluation({ ...observing, status: { status: "failed" } }, observing)).rejects.toBeInstanceOf(RuntimeRecordConflictError);
    expect(await worker.isRunActive(command.run.runId)).toBe(false);
    expect(await jobs.findJobs(RUN_QUEUE, { key: `collection:${command.run.runId}` })).toHaveLength(0);
  });

  it.each(["new", "existing"] as const)("keeps MCP-accepted resources recoverable after a Worker crash (%s wait)", async (wait) => {
    const seeded = await project({ datasets: [{ data: [makeData()] }], evaluation: true });
    const { command } = await seeded.admit({ operation: "pipeline" });
    const { worker } = stores();
    const sampling = (await worker.getSampling(command.run.samplingIds[0]!))!;
    await worker.updateSampling({ ...sampling, execution: { status: "succeeded" } }, sampling);
    const evaluationId = command.run.evaluationIds[0]!;
    const original = (await worker.getEvaluation(evaluationId))!;
    const submittedAt = new Date("2026-10-21T07:50:59.975Z");
    const resourcesPending = startResourceWait(wait === "existing" ? "2026-10-21T07:49:59.975Z" : submittedAt.toISOString());
    const observing = {
      ...original, chatId: "evaluating-chat",
      status: { status: "running" as const, ...(wait === "existing" ? { resourcesPending } : {}) },
      attempts: [{
        evaluationAttemptId: "evaluating-attempt", evaluationId, attemptNumber: 1,
        status: "running" as const, startedAt: "2026-10-21T07:44:59.634Z", submissionId: "evaluating-submission",
        resources: { status: "pending" as const, scope: { chatId: "evaluating-chat", idempotencyKey: `evaluation:${sampling.samplingId}` } },
      }],
    };
    await worker.updateEvaluation(observing, original);
    expect(await worker.isRunActive(command.run.runId)).toBe(true);

    const submissions = createPostgresEvaluationSubmissions(database.db, runQueue);
    const input = { evaluationId, ownerUserId: OWNER, content: '{"score":1}', submittedAt };
    expect(await submissions.save(input)).toBe("accepted");

    const accepted = (await worker.getEvaluation(evaluationId))!;
    expect(accepted.status).toEqual({ status: "succeeded", resourcesPending });
    expect(accepted.attempts).toEqual(observing.attempts);
    expect(await worker.isRunActive(command.run.runId)).toBe(true);
    expect(await jobs.findJobs(RUN_QUEUE, { key: `collection:${command.run.runId}` })).toHaveLength(0);
    expect(await submissions.save({ ...input, submittedAt: new Date(submittedAt.getTime() + 60_000) })).toBe("replayed");
    expect(await worker.getEvaluation(evaluationId)).toEqual(accepted);
    expect(await jobs.findJobs(RUN_QUEUE, { key: `collection:${command.run.runId}` })).toHaveLength(0);
  });

  it.each([
    { previousJob: "completed", otherMemberPending: false },
    { previousJob: "settling", otherMemberPending: false },
    { previousJob: "settling", otherMemberPending: true },
  ] as const)("durably schedules late MCP resource recovery ($previousJob previous job; other member pending: $otherMemberPending)", async ({ previousJob, otherMemberPending }) => {
    const seeded = await project({ datasets: [{ data: otherMemberPending ? [makeData(), makeData()] : [makeData()] }], evaluation: true });
    const { command } = await seeded.admit({ operation: "pipeline" });
    const runId = command.run.runId;
    const { worker } = stores();
    const sampling = (await worker.getSampling(command.run.samplingIds[0]!))!;
    await worker.updateSampling({ ...sampling, execution: { status: "succeeded" } }, sampling);
    const evaluationId = command.run.evaluationIds[0]!;
    const original = (await worker.getEvaluation(evaluationId))!;
    const observing = {
      ...original, chatId: "evaluating-chat",
      status: { status: "failed" as const, lastError: "status observation disconnected" },
      attempts: [{
        evaluationAttemptId: "evaluating-attempt", evaluationId, attemptNumber: 1,
        status: "running" as const, startedAt: "2026-10-21T07:44:59.634Z", submissionId: "evaluating-submission",
        resources: { status: "pending" as const, scope: { chatId: "evaluating-chat", idempotencyKey: `evaluation:${sampling.samplingId}` } },
      }],
    };
    await worker.updateEvaluation(observing, original);
    expect(isStageRecoveryPending(observing.status)).toBe(false);
    expect(await worker.isRunActive(runId)).toBe(otherMemberPending);
    const [oldJob] = await jobs.fetch<RunJob>(RUN_QUEUE);
    expect(oldJob?.data).toEqual({ runId });
    if (previousJob === "completed") await jobs.complete(RUN_QUEUE, oldJob!.id);
    expect(await runJobStates(runId)).toEqual([previousJob === "completed" ? "completed" : "active"]);

    const acceptanceQueue: RunQueue = {
      async enqueue(...args) {
        await runQueue.enqueue(...args);
        if (otherMemberPending) {
          // Acceptance is still uncommitted while the Worker finishes the other member and its old job.
          await settle(worker, [command.run.samplingIds[1]!], "succeeded");
          expect((await worker.getEvaluation(evaluationId))!.status).toEqual(observing.status);
          expect(await worker.isRunActive(runId)).toBe(false);
          await jobs.complete(RUN_QUEUE, oldJob!.id);
        }
      },
    };
    const submissions = createPostgresEvaluationSubmissions(database.db, acceptanceQueue);
    const submittedAt = new Date("2026-10-21T07:50:59.975Z");
    const input = { evaluationId, ownerUserId: OWNER, content: '{"score":1}', submittedAt };
    const beforeAcceptance = (await worker.getEvaluation(evaluationId))!;
    const rollback: RunQueue = {
      async enqueue(...args) {
        await runQueue.enqueue(...args);
        throw new Error("commit aborted");
      },
    };
    await expect(createPostgresEvaluationSubmissions(database.db, rollback).save(input)).rejects.toThrow("commit aborted");
    expect(await submissions.read(evaluationId)).toBeUndefined();
    expect(await worker.getEvaluation(evaluationId)).toEqual(beforeAcceptance);
    expect(await worker.isRunActive(runId)).toBe(otherMemberPending);
    expect(await jobs.findJobs(RUN_QUEUE, { key: `collection:${runId}` })).toHaveLength(0);
    expect(await submissions.save(input)).toBe("accepted");

    const accepted = (await worker.getEvaluation(evaluationId))!;
    expect(accepted.status).toEqual({ status: "succeeded", resourcesPending: startResourceWait(submittedAt.toISOString()) });
    expect(accepted.attempts).toEqual(observing.attempts);
    expect(accepted.output).toMatchObject({ status: "succeeded", structuredOutput: { source: "submission", content: input.content } });
    expect(accepted.revision).toBe(beforeAcceptance.revision + 1);
    expect(await worker.isRunActive(runId)).toBe(true);
    expect(await runJobStates(runId)).toEqual([previousJob === "completed" || otherMemberPending ? "completed" : "active"]);
    const wakeups = await jobs.findJobs<RunJob>(RUN_QUEUE, { key: `collection:${runId}` });
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({ state: "created", data: { runId } });
    expect(await submissions.save({ ...input, submittedAt: new Date(submittedAt.getTime() + 60_000) })).toBe("replayed");
    expect(await worker.getEvaluation(evaluationId)).toEqual(accepted);
    expect((await jobs.findJobs(RUN_QUEUE, { key: `collection:${runId}` })).map((job) => job.id)).toEqual(wakeups.map((job) => job.id));
  });

  it.each(["ordinary", "collection", "resources"] as const)("hands late accepted work to recovery while an old %s job is settling", async (origin) => {
    const { worker, runId, evaluationId } = await observationFailedEvaluation();
    let [oldJob] = await jobs.fetch<RunJob>(RUN_QUEUE);
    if (origin === "collection") {
      await jobs.complete(RUN_QUEUE, oldJob!.id);
      await database.db.transaction((tx) => runQueue.enqueue(tx, runId, "collection"));
      [oldJob] = await jobs.fetch<RunJob>(RUN_QUEUE);
    } else if (origin === "resources") {
      await database.db.transaction((tx) => runQueue.defer(tx, runId, oldJob!.id, new Date(Date.now() - 60_000)));
      [oldJob] = await jobs.fetch<RunJob>(RUN_QUEUE);
    }
    const submissions = createPostgresEvaluationSubmissions(database.db, runQueue);
    let accepted = false;
    const handler = createRunJobHandler({
      runtime: { resume: vi.fn(async () => undefined), interrupt: vi.fn(), stop: vi.fn() } as unknown as EvalRunResumer,
      store: {
        ...worker,
        async isRunActive(id) {
          const active = await worker.isRunActive(id);
          if (!active && !accepted) {
            accepted = true;
            await expect(submissions.save({
              evaluationId, ownerUserId: OWNER, content: '{"score":1}', submittedAt: new Date(),
            })).resolves.toBe("accepted");
          }
          return active;
        },
      },
      logger: silent,
    });
    try {
      await handler(runId, { jobId: oldJob!.id, retryCount: 0, retryLimit: 100 });
      await jobs.complete(RUN_QUEUE, oldJob!.id);
    } catch (error) {
      if (!(error instanceof RunStillActiveError)) throw error;
      await jobs.fail(RUN_QUEUE, oldJob!.id, { message: error.message });
    }
    expect(accepted).toBe(true);
    expect(await worker.isRunActive(runId)).toBe(true);
    const pending = (await jobs.findJobs<RunJob>(RUN_QUEUE)).filter((job) =>
      job.data.runId === runId && ["created", "retry", "active"].includes(job.state));
    expect(pending.length, "accepted resources need a durable job after the old handler settles").toBeGreaterThan(0);
    await makeJobDue(pending[0]!.id);
    const [recovery] = await jobs.fetch<RunJob>(RUN_QUEUE);
    expect(recovery?.data).toEqual({ runId });
  });

  it("rolls back an idle acknowledgement and preserves a later wake-up after completion", async () => {
    const { worker, runId, evaluationId } = await observationFailedEvaluation();
    const [oldJob] = await jobs.fetch<RunJob>(RUN_QUEUE);
    const aborted = createPostgresWorkerRuntimeStore(database.db, {
      ...runQueue,
      async complete(...args) {
        await runQueue.complete(...args);
        throw new Error("settlement aborted");
      },
    });
    await expect(aborted.settleRunJob(runId, oldJob!.id)).rejects.toThrow("settlement aborted");
    expect(await runJobStates(runId)).toEqual(["active"]);
    expect(await worker.settleRunJob(runId, oldJob!.id)).toEqual({ kind: "completed" });
    expect(await runJobStates(runId)).toEqual(["completed"]);

    const submissions = createPostgresEvaluationSubmissions(database.db, runQueue);
    expect(await submissions.save({
      evaluationId, ownerUserId: OWNER, content: '{"score":1}', submittedAt: new Date(),
    })).toBe("accepted");
    // pg-boss's duplicate auto-ack of the old ID must not consume the new job.
    await jobs.complete(RUN_QUEUE, oldJob!.id);
    const [recovery] = await jobs.fetch<RunJob>(RUN_QUEUE);
    expect(recovery?.data).toEqual({ runId });
    expect(await worker.isRunActive(runId)).toBe(true);
  });

  it("serializes acceptance arriving during an idle settlement with its acknowledgement", async () => {
    const { runId, evaluationId } = await observationFailedEvaluation();
    const [oldJob] = await jobs.fetch<RunJob>(RUN_QUEUE);
    await jobs.complete(RUN_QUEUE, oldJob!.id);
    await database.db.transaction((tx) => runQueue.enqueue(tx, runId, "collection"));
    const [collecting] = await jobs.fetch<RunJob>(RUN_QUEUE);
    let reached!: () => void;
    const completing = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const allowed = new Promise<void>((resolve) => { release = resolve; });
    const worker = createPostgresWorkerRuntimeStore(database.db, {
      ...runQueue,
      async complete(...args) {
        reached();
        await allowed;
        await runQueue.complete(...args);
      },
    });
    const settlement = worker.settleRunJob(runId, collecting!.id);
    await completing;
    const accepting = createPostgresEvaluationSubmissions(database.db, runQueue).save({
      evaluationId, ownerUserId: OWNER, content: '{"score":1}', submittedAt: new Date(),
    });
    try {
      // Wait for the real acceptance transaction to reach the shared Project lock.
      await vi.waitFor(async () => {
        const { rows } = await database.db.execute<{ waiting: number }>(sql`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND lower(query) LIKE '%for update%' AND pid <> pg_backend_pid()
        `);
        expect(rows[0]!.waiting).toBeGreaterThan(0);
      }, { timeout: 2_000 });
    } finally {
      release();
      await Promise.all([settlement, accepting]);
    }
    expect(await settlement).toEqual({ kind: "completed" });
    expect(await accepting).toBe("accepted");
    await jobs.complete(RUN_QUEUE, collecting!.id);
    const [recovery] = await jobs.fetch<RunJob>(RUN_QUEUE);
    expect(recovery?.data).toEqual({ runId });
    expect(await worker.isRunActive(runId)).toBe(true);
  });

  it.each(["stopped", "cancelled", "replaced", "wrong-owner", "deleted"] as const)("rejects MCP acceptance for %s work", async (reason) => {
    const seeded = await project({ datasets: [{ data: [makeData()] }], evaluation: true });
    const { command } = await seeded.admit({ operation: "pipeline" });
    const { worker } = stores();
    const sampling = (await worker.getSampling(command.run.samplingIds[0]!))!;
    await worker.updateSampling({ ...sampling, execution: { status: "succeeded" } }, sampling);
    const evaluationId = command.run.evaluationIds[0]!;
    const original = (await worker.getEvaluation(evaluationId))!;
    await worker.updateEvaluation({ ...original, chatId: "chat", status: { status: reason === "cancelled" ? "cancelled" : "failed" } }, original);
    if (reason === "stopped") await database.db.update(runs).set({ stopRequested: true }).where(eq(runs.runId, command.run.runId));
    if (reason === "replaced") await seeded.admit({ operation: "evaluation" });
    if (reason === "deleted") await database.db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.projectId, seeded.projectId));
    const submissions = createPostgresEvaluationSubmissions(database.db, runQueue);
    expect(await submissions.save({ evaluationId, ownerUserId: reason === "wrong-owner" ? "other" : OWNER,
      content: '{"score":1}', submittedAt: new Date() })).toBe("closed");
    expect(await submissions.read(evaluationId)).toBeUndefined();
    expect((await worker.getEvaluation(evaluationId))?.status.status).not.toBe("succeeded");
  });

  it("queues only the selected completed evaluation and leaves its sampling untouched", async () => {
    const seeded = await project({ datasets: [{ data: [makeData()] }], evaluation: true });
    const { store, worker, control } = stores();
    const first = await seeded.admit({ operation: "pipeline" });
    const id = first.command.run.samplingIds[0]!;
    await settle(worker, [id], "failed");
    const sampling = (await store.getSampling(id))!;
    const ready = { ...sampling, execution: { status: "succeeded" as const }, evidence: { evidenceId: "evidence", manifestSha256: "a".repeat(64), exportedAt: "2026-10-16T00:00:00Z" } };
    await worker.updateSampling(ready, sampling);
    const evaluation = (await store.getEvaluation(first.command.run.evaluationIds[0]!))!;
    const completed = { ...evaluation, chatId: "evaluator-chat", attempts: [{ evaluationAttemptId: "eval-attempt", evaluationId: evaluation.evaluationId, attemptNumber: 1, status: "completed" as const, submissionId: "eval-submission", startedAt: "2026-10-16T00:00:00Z", completedAt: "2026-10-16T00:00:01Z" }] };
    await worker.updateEvaluation(completed, evaluation);
    expect(await control.recollect(seeded.projectId, "evaluation", evaluation.evaluationId)).toEqual({ runId: first.command.run.runId, queued: true });
    expect((await store.getEvaluation(evaluation.evaluationId))!.status).toEqual({ status: "retrying", collectionPending: true });
    expect(await store.getSampling(id)).toEqual({ ...ready, revision: sampling.revision + 1 });
    const foreignProject = await project();
    await expect(control.recollect(foreignProject.projectId, "evaluation", evaluation.evaluationId)).rejects.toBeInstanceOf(RuntimeEntityNotFoundError);
  });

  it("rejects collection of an unfinished Agent or a pending stop, and recollects output after a finalized stop", async () => {
    const seeded = await project(); const { store, worker, control } = stores();
    const first = await seeded.admit({ operation: "execution" }); const id = first.command.run.samplingIds[0]!;
    const runId = first.command.run.runId;
    await settle(worker, [id], "failed");
    await expect(control.recollect(seeded.projectId, "execution", id)).rejects.toMatchObject({ name: "ResultCollectionConflictError" });
    const row = (await store.getSampling(id))!;
    await worker.updateSampling({ ...row, subjectChatId: "chat", executionAttempts: [{ executionAttemptId: "attempt", samplingId: id, attemptNumber: 1, status: "completed", submissionId: "submission", startedAt: "2026-10-16T00:00:00Z", completedAt: "2026-10-16T00:00:01Z" }] }, row);
    await database.db.update(runs).set({ stopRequested: true }).where(eq(runs.runId, runId));
    await expect(control.recollect(seeded.projectId, "execution", id)).rejects.toMatchObject({ name: "ResultCollectionConflictError" });
    expect(await worker.markRunStopFinalized(runId)).toBe(true);
    // No ended Attempt owes resources, so a resource recollection is a no-op.
    expect(await control.recollect(seeded.projectId, "execution", id, "resources")).toEqual({ runId, queued: false });

    expect(await control.recollect(seeded.projectId, "execution", id)).toEqual({ runId, queued: true });
    expect(await worker.isRunActive(runId)).toBe(true);
    expect(await worker.isRunStopPending(runId)).toBe(false);
    expect(await control.getCurrentRun(seeded.projectId)).toEqual({ runId });
    // Stopping the recollection reopens the stop, so the Worker finalizes it again.
    expect(await control.stopRun(seeded.projectId, runId)).toEqual({ runId, stopRequested: true });
    expect(await worker.isRunStopPending(runId)).toBe(true);
    expect(await control.getCurrentRun(seeded.projectId)).toEqual({ runId, stopRequested: true });
  });

  const completedAttempt = (samplingId: string, resources?: NonNullable<Sampling["executionAttempts"][number]["resources"]>) => ({
    executionAttemptId: "attempt", samplingId, attemptNumber: 1, status: "completed" as const, submissionId: "submission",
    startedAt: "2026-10-16T00:00:00Z", completedAt: "2026-10-16T00:00:01Z", ...(resources === undefined ? {} : { resources }),
  });
  const snapshot = (finalized: boolean) => ({
    status: "collected" as const,
    summary: {
      scope: { chatId: "chat", idempotencyKey: "execution", submissionId: "submission" }, observedAt: "2026-10-16T00:00:02Z", finalized,
      coverage: { usageEvents: "complete" as const, telemetryEvents: "partial" as const, billingSettlements: "complete" as const },
      counts: { usageEvents: 0, telemetryEvents: 0, billingSettlements: 0 },
    },
  });

  it("keeps a non-stopped Run active exactly while a member stage owes recovery work", async () => {
    const seeded = await project({ datasets: [{ data: [makeData()] }], evaluation: true });
    const { worker, control } = stores();
    const pipeline = await seeded.admit({ operation: "pipeline" });
    const samplingId = pipeline.command.run.samplingIds[0]!;
    await settle(worker, [samplingId], "succeeded");
    expect(await worker.isRunActive(pipeline.command.run.runId)).toBe(false);
    const finished = (await worker.getSampling(samplingId))!;
    const deadline = "2026-10-16T00:10:00.000Z";
    const stages: readonly SamplingStageState[] = [
      { status: "succeeded" },
      { status: "failed", lastError: "x" },
      { status: "succeeded", resourcesPending: { deadline, lastError: "not finalized" } },
      { status: "failed", resourcesPending: { deadline } },
      { status: "running", observationPending: { passes: 2 } },
      { status: "retrying", collectionPending: true },
    ];
    const stored = async () => (await worker.getSampling(samplingId))!;
    for (const execution of stages) {
      await worker.updateSampling({ ...finished, execution }, await stored());
      expect(await worker.isRunActive(pipeline.command.run.runId), JSON.stringify(execution)).toBe(isStageRecoveryPending(execution));
    }
    const refreshing = { ...finished, execution: { status: "succeeded" as const, resourcesPending: { deadline } } };
    await worker.updateSampling(refreshing, await stored());
    expect(await control.getCurrentRun(seeded.projectId)).toEqual({ runId: pipeline.command.run.runId });
    await worker.updateSampling(finished, await stored());
    expect(await worker.isRunActive(pipeline.command.run.runId)).toBe(false);

    const evaluation = (await worker.getEvaluation(pipeline.command.run.evaluationIds[0]!))!;
    const evaluationRefreshing = { ...evaluation, status: { status: "failed" as const, resourcesPending: { deadline } } };
    await worker.updateEvaluation(evaluationRefreshing, evaluation);
    expect(await worker.isRunActive(pipeline.command.run.runId)).toBe(true);
    await worker.updateEvaluation(evaluation, (await worker.getEvaluation(evaluation.evaluationId))!);

    // An evaluation-only Run that reuses the Sampling does not inherit the execution stage's refresh.
    const evaluating = await seeded.admit({ operation: "evaluation" });
    for (const id of evaluating.command.run.evaluationIds) {
      const record = (await worker.getEvaluation(id))!;
      await worker.updateEvaluation({ ...record, status: { status: "succeeded" } }, record);
    }
    expect(await worker.isRunActive(evaluating.command.run.runId)).toBe(false);
    await worker.updateSampling(refreshing, await stored());
    expect(await worker.isRunActive(pipeline.command.run.runId)).toBe(true);
    expect(await worker.isRunActive(evaluating.command.run.runId)).toBe(false);

    // A pending stop is never held open by a refresh: its flags are ignored until the stop is finalized.
    await worker.requestRunStop(pipeline.command.run.runId);
    expect(await worker.markRunStopFinalized(pipeline.command.run.runId)).toBe(true);
    // Finalizing clears every flag; one set afterwards is a manual resource recollection that reactivates the Run.
    expect(await worker.isRunActive(pipeline.command.run.runId)).toBe(true);
    await worker.updateSampling(finished, await stored());
    expect(await worker.isRunActive(pipeline.command.run.runId)).toBe(false);
    expect(await control.getCurrentRun(seeded.projectId)).toBeNull();
  });

  it("queues a resource-only recollection of a finished stage without changing its status", async () => {
    const seeded = await project({ datasets: [{ data: [makeData()] }] });
    const { store, worker, control } = stores();
    const first = await seeded.admit({ operation: "execution" });
    const runId = first.command.run.runId;
    const id = first.command.run.samplingIds[0]!;
    await expect(control.recollect(seeded.projectId, "execution", id, "resources")).rejects.toMatchObject({ name: "ResultCollectionConflictError" });
    await settle(worker, [id], "succeeded");
    const settled = (await store.getSampling(id))!;
    await expect(control.recollect(seeded.projectId, "execution", id, "resources")).rejects.toMatchObject({ name: "ResultCollectionConflictError" });
    const unfinalized = { ...settled, subjectChatId: "chat", executionAttempts: [completedAttempt(id, snapshot(false))] };
    await worker.updateSampling(unfinalized, settled);
    const requests = await Promise.all([
      control.recollect(seeded.projectId, "execution", id, "resources"),
      control.recollect(seeded.projectId, "execution", id, "resources"),
    ]);
    expect(requests).toEqual([{ runId, queued: true }, { runId, queued: true }]);
    const pending = (await store.getSampling(id))!;
    expect(pending.execution).toEqual({ status: "succeeded", resourcesPending: { deadline: expect.any(String), nextAttemptAt: expect.any(String) } });
    expect(Date.parse(pending.execution.resourcesPending!.nextAttemptAt!)).toBeLessThanOrEqual(Date.now());
    expect(pending.executionAttempts).toEqual(unfinalized.executionAttempts);
    expect(await jobs.findJobs(RUN_QUEUE, { key: `collection:${runId}` })).toHaveLength(1);
    expect(await worker.isRunActive(runId)).toBe(true);
    // Output recollection stays a no-op for a succeeded stage.
    expect(await control.recollect(seeded.projectId, "execution", id)).toEqual({ runId, queued: false });

    const finalized = { ...pending, execution: { status: "succeeded" as const }, executionAttempts: [completedAttempt(id, snapshot(true))] };
    await worker.updateSampling(finalized, pending);
    expect(await control.recollect(seeded.projectId, "execution", id, "resources")).toEqual({ runId, queued: false });
    expect((await store.getSampling(id))!.execution).toEqual({ status: "succeeded" });

    const failed = { ...finalized, execution: { status: "failed" as const, lastError: "resources failed" },
      executionAttempts: [completedAttempt(id, { status: "failed", scope: { chatId: "chat", idempotencyKey: "execution" }, collectedAt: "2026-10-16T00:00:02Z", error: "x" })] };
    await worker.updateSampling(failed, (await store.getSampling(id))!);
    expect(await control.recollect(seeded.projectId, "execution", id, "resources")).toEqual({ runId, queued: true });
    expect((await store.getSampling(id))!.execution).toEqual({ status: "failed", lastError: "resources failed", resourcesPending: { deadline: expect.any(String), nextAttemptAt: expect.any(String) } });

    // Resources Runtime gave up on are owed again by a manual recollection, with a fresh download budget.
    const exhausted = (await store.getSampling(id))!;
    const givenUp = { status: "failed" as const, scope: { chatId: "chat", idempotencyKey: "execution" }, collectedAt: "2026-10-16T00:00:03Z", error: "x", downloads: 11, exhausted: true as const };
    await worker.updateSampling({ ...exhausted, execution: { status: "failed", lastError: "resources failed" }, executionAttempts: [completedAttempt(id, givenUp)] }, exhausted);
    expect(await control.recollect(seeded.projectId, "execution", id, "resources")).toEqual({ runId, queued: true });
    const { downloads: _downloads, exhausted: _exhausted, ...fresh } = givenUp;
    expect((await store.getSampling(id))!.executionAttempts[0]!.resources).toEqual(fresh);

    // A finalized stop records owed resources as failed; recollecting them reactivates the Run without reopening the stop.
    await database.db.update(runs).set({ stopRequested: true, stopFinalized: true }).where(eq(runs.runId, runId));
    const stopped = (await store.getSampling(id))!;
    await worker.updateSampling({ ...stopped, execution: { status: "failed", lastError: "resources failed" } }, stopped);
    expect(await worker.isRunActive(runId)).toBe(false);
    expect(await control.recollect(seeded.projectId, "execution", id, "resources")).toEqual({ runId, queued: true });
    expect(await worker.isRunActive(runId)).toBe(true);
    expect(await worker.isRunStopPending(runId)).toBe(false);
    await database.db.update(runs).set({ stopFinalized: false }).where(eq(runs.runId, runId));
    await expect(control.recollect(seeded.projectId, "execution", id, "resources")).rejects.toMatchObject({ name: "ResultCollectionConflictError" });
  });

  it("queues a resource-only recollection of a finished Evaluation", async () => {
    const seeded = await project({ datasets: [{ data: [makeData()] }], evaluation: true });
    const { store, worker, control } = stores();
    const first = await seeded.admit({ operation: "pipeline" });
    await settle(worker, first.command.run.samplingIds, "succeeded");
    const evaluation = (await store.getEvaluation(first.command.run.evaluationIds[0]!))!;
    const completed = { ...evaluation, chatId: "evaluator-chat", attempts: [{ evaluationAttemptId: "eval-attempt", evaluationId: evaluation.evaluationId,
      attemptNumber: 1, status: "completed" as const, submissionId: "eval-submission", startedAt: "2026-10-16T00:00:00Z", completedAt: "2026-10-16T00:00:01Z",
      resources: snapshot(false) }] };
    await worker.updateEvaluation(completed, evaluation);
    expect(await control.recollect(seeded.projectId, "evaluation", evaluation.evaluationId, "resources"))
      .toEqual({ runId: first.command.run.runId, queued: true });
    expect((await store.getEvaluation(evaluation.evaluationId))!.status).toEqual({ status: "succeeded", resourcesPending: { deadline: expect.any(String), nextAttemptAt: expect.any(String) } });
  });

  it("queues a resource recollection exactly when an ended Attempt still owes resources, as Runtime refreshes it", async () => {
    const seeded = await project({ datasets: [{ data: [makeData()] }] });
    const { store, worker, control } = stores();
    const { command } = await seeded.admit({ operation: "execution" });
    const runId = command.run.runId;
    const id = command.run.samplingIds[0]!;
    await settle(worker, [id], "failed");
    const settled = (await store.getSampling(id))!;
    const failedAgent = { ...settled, subjectChatId: "chat", executionAttempts: [{
      ...completedAttempt(id, snapshot(false)), status: "failed" as const, error: "Agent failed",
    }] };
    await worker.updateSampling(failedAgent, settled);
    const before = Date.now();
    expect(await control.recollect(seeded.projectId, "execution", id, "resources")).toEqual({ runId, queued: true });
    const deadline = Date.parse((await store.getSampling(id))!.execution.resourcesPending!.deadline);
    expect(deadline - before).toBeGreaterThanOrEqual(RESOURCE_WAIT_MS);
    expect(deadline - Date.now()).toBeLessThanOrEqual(RESOURCE_WAIT_MS);

    const pending = (await store.getSampling(id))!;
    const earlierOwes = { ...pending, execution: { status: "failed" as const }, executionAttempts: [
      { ...completedAttempt(id, snapshot(false)), status: "failed" as const },
      { ...completedAttempt(id, snapshot(true)), executionAttemptId: "attempt-2", attemptNumber: 2 },
    ] };
    await worker.updateSampling(earlierOwes, pending);
    expect(await control.recollect(seeded.projectId, "execution", id, "resources")).toEqual({ runId, queued: true });

    const owesNothing = (await store.getSampling(id))!;
    const settledAll = { ...owesNothing, execution: { status: "failed" as const }, executionAttempts: [
      { ...completedAttempt(id, snapshot(true)), status: "failed" as const },
      { executionAttemptId: "attempt-2", samplingId: id, attemptNumber: 2, status: "running" as const, submissionId: "submission-2",
        startedAt: "2026-10-16T00:00:02Z", resources: snapshot(false) },
    ] };
    await worker.updateSampling(settledAll, owesNothing);
    expect(await control.recollect(seeded.projectId, "execution", id, "resources")).toEqual({ runId, queued: false });
  });

  it("schedules the next pass of a Run waiting only for resources at its earliest due check", async () => {
    const seeded = await project({ datasets: [{ data: [makeData()] }], evaluation: true });
    const { worker } = stores();
    const { command } = await seeded.admit({ operation: "pipeline" });
    const runId = command.run.runId;
    const samplingId = command.run.samplingIds[0]!;
    const deadline = new Date(Date.now() + RESOURCE_WAIT_MS).toISOString();
    const soon = new Date(Date.now() + 30_000).toISOString();
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(await nextResourceCheckAt(database.db, runId)).toBeNull();
    await settle(worker, [samplingId], "succeeded");
    const sampling = (await worker.getSampling(samplingId))!;
    const waiting = { ...sampling, execution: { status: "succeeded" as const, resourcesPending: { deadline, nextAttemptAt: later } } };
    await worker.updateSampling(waiting, sampling);
    expect(await nextResourceCheckAt(database.db, runId)).toBe(Date.parse(later));
    const evaluation = (await worker.getEvaluation(command.run.evaluationIds[0]!))!;
    const evaluationWaiting = { ...evaluation, status: { status: "failed" as const, resourcesPending: { deadline, nextAttemptAt: soon } } };
    await worker.updateEvaluation(evaluationWaiting, evaluation);
    expect(await nextResourceCheckAt(database.db, runId)).toBe(Date.parse(soon));

    // An admitted job is the active one while its handler runs; the deferral completes it and wakes the Run later.
    const [job] = await jobs.fetch<RunJob>(RUN_QUEUE);
    expect(job?.data.runId).toBe(runId);
    expect(await worker.settleRunJob(runId, job!.id)).toEqual({ kind: "deferred", startAfter: soon });
    expect(await runJobStates(runId)).toEqual(["completed"]);
    const [wake] = await jobs.findJobs<RunJob>(RUN_QUEUE, { key: `resources:${runId}` });
    expect(wake).toMatchObject({ state: "created", data: { runId }, retryCount: 0, policy: RUN_QUEUE_OPTIONS.policy, retryLimit: RUN_QUEUE_OPTIONS.retryLimit });
    expect(wake!.startAfter.toISOString()).toBe(soon);

    // A later deferral moves the queued wake-up instead of keeping a stale one, and frees the Run's own key.
    await database.db.transaction((transaction) => runQueue.enqueue(transaction, runId));
    const [next] = await jobs.fetch<RunJob>(RUN_QUEUE, { includeMetadata: true });
    expect(next?.singletonKey).toBe(runId);
    await worker.updateEvaluation({ ...evaluationWaiting, status: { status: "failed" } }, (await worker.getEvaluation(evaluation.evaluationId))!);
    expect(await worker.settleRunJob(runId, next!.id)).toEqual({ kind: "deferred", startAfter: later });
    const wakes = await jobs.findJobs<RunJob>(RUN_QUEUE, { key: `resources:${runId}` });
    expect(wakes.map((item) => [item.state, item.startAfter.toISOString()])).toEqual([["created", later]]);
    await database.db.transaction((transaction) => runQueue.enqueue(transaction, runId));
    expect(await runJobStates(runId)).toEqual(expect.arrayContaining(["created"]));

    // Overdue, never scheduled, pending or stopped work is not an idle wait: the job retries with backoff instead.
    const current = (await worker.getSampling(samplingId))!;
    const overdue = { ...current, execution: { status: "succeeded" as const, resourcesPending: { deadline } } };
    await worker.updateSampling(overdue, current);
    expect(await nextResourceCheckAt(database.db, runId)).toBe(-Infinity);
    expect(await worker.settleRunJob(runId, crypto.randomUUID())).toEqual({ kind: "active" });
    await worker.updateSampling({ ...overdue, execution: { status: "retrying" } }, (await worker.getSampling(samplingId))!);
    expect(await nextResourceCheckAt(database.db, runId)).toBeNull();
    await worker.updateSampling(waiting, (await worker.getSampling(samplingId))!);
    await worker.requestRunStop(runId);
    expect(await nextResourceCheckAt(database.db, runId)).toBeNull();
  });

  describe("Dataset catalog", () => {
    it("appends cases atomically and rejects invalid references and foreign targets without partial writes", async () => {
      const { datasetService } = stores();
      const target = await datasetService.createDataset({ name: "batch" });
      const original = await datasetService.createData({ userPrompt: "original" }, { datasetId: target.datasetId });
      const foreign = await stores("user-B").datasetService.createDataset({ name: "foreign" });
      await expect(datasetService.addData(foreign.datasetId, [{ userPrompt: "blocked" }])).rejects.toBeInstanceOf(DatasetEntityNotFoundError);
      await expect(datasetService.addData(target.datasetId, [
        { userPrompt: "valid" },
        { userPrompt: "invalid resource", initialMaterials: [{ bundleId: crypto.randomUUID(), materialId: crypto.randomUUID() }] },
      ])).rejects.toThrow();
      expect(await datasetService.listData()).toEqual([original]);
      const added = await datasetService.addData(target.datasetId, [{ userPrompt: "one" }, { userPrompt: "two" }]);
      expect(await datasetService.listData(target.datasetId)).toHaveLength(3);
      expect(added).toHaveLength(2);
    });
    it("creates and attaches one Data atomically, rejecting foreign, deleted and invalid Prompt targets", async () => {
      const { datasetService } = stores();
      const target = await datasetService.createDataset({ name: "tasks" });
      const created = await datasetService.createData({ userPrompt: "task", custom: { retained: true } }, { datasetId: target.datasetId });
      expect(await datasetService.listData(target.datasetId)).toEqual([created]);
      const foreign = await stores("user-B").datasetService.createDataset({ name: "foreign" });
      const deleted = await datasetService.createDataset({ name: "deleted" });
      await datasetService.deleteDataset(deleted.datasetId);
      for (const datasetId of [foreign.datasetId, deleted.datasetId]) {
        await expect(datasetService.createData({ userPrompt: "rejected" }, { datasetId }))
          .rejects.toBeInstanceOf(DatasetEntityNotFoundError);
      }
      const prompt = await datasetService.importPromptDataset({
        name: "Prompt", description: "description", format: "jsonl",
        content: JSON.stringify({ name: "sample", description: "description", userPrompt: "execute", evalPrompt: "judge" }),
      });
      await expect(datasetService.createData({ userPrompt: "missing fields" }, { datasetId: prompt.dataset.datasetId }))
        .rejects.toBeInstanceOf(DatasetInputError);
      expect(await datasetService.listData()).toHaveLength(2);
    });

    it("rolls back the Data insert when its Dataset membership cannot commit", async () => {
      const { datasetService } = stores();
      const target = await datasetService.createDataset({ name: "tasks" });
      // Fail the second write after Data was inserted, rather than only testing pre-write validation.
      await database.db.execute(sql`ALTER TABLE eval_dataset_data ADD CONSTRAINT test_membership_failure CHECK (false)`);
      try {
        await expect(datasetService.createData({ userPrompt: "task" }, { datasetId: target.datasetId })).rejects.toThrow();
        expect(await datasetService.listData()).toEqual([]);
        expect(await datasetService.listData(target.datasetId)).toEqual([]);
      } finally {
        await database.db.execute(sql`ALTER TABLE eval_dataset_data DROP CONSTRAINT test_membership_failure`);
      }
    });

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
      await expect(datasetService.updateDataset(imported.dataset.datasetId, { name: "Renamed" })).rejects.toBeInstanceOf(DatasetInputError);
      await expect(datasetService.updateData(row.dataId, { name: "First", description: "Case one", userPrompt: "Start" })).rejects.toBeInstanceOf(DatasetInputError);
      const edited = { name: "Edited", description: "Edited description", userPrompt: "  New task\n", evalPrompt: "  New review\n", custom: [true, null, 3] };
      await datasetService.updateData(row.dataId, edited);
      expect(await datasetService.getData(row.dataId)).toEqual({ dataId: row.dataId, ...edited });
      for (const field of ["name", "description", "userPrompt", "evalPrompt"] as const) {
        await expect(datasetService.updateData(row.dataId, { ...edited, [field]: " " })).rejects.toBeInstanceOf(DatasetInputError);
      }
      expect(await datasetService.getData(row.dataId)).toEqual({ dataId: row.dataId, ...edited });
      const general = await datasetService.createData({ userPrompt: "Execution only" });
      await expect(datasetService.attachData(imported.dataset.datasetId, [general.dataId])).rejects.toBeInstanceOf(DatasetInputError);
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
      // An unknown target ProjectSample is rejected by the Sampling → ProjectSample foreign key as invalid input.
      const unknown = base.samplings.map((sampling) => ({ ...sampling, projectSampleId: "missing" }));
      await expect(store.admitRun({
        ...base, samplings: unknown, replacedSamplingIds: [],
        run: { ...base.run, targets: { projectSampleIds: ["missing"], samplingIds: [] } },
      })).rejects.toMatchObject({ name: "RuntimeInputError", message: expect.stringContaining("eval_samplings_project_sample_fk") });
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
        .toEqual(keptEvaluations.map((evaluation) => ({ ...evaluation, revision: 1, status: { status: "succeeded" } })));
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
      const initial = { ...command.samplings[0]!, revision: 0 };
      const evaluation = { ...command.evaluations[0]!, revision: 0 };
      const running = { ...initial, subjectChatId: "subject-chat", execution: { status: "running" as const } };
      await store.updateSampling(running, initial);
      await expect(store.updateSampling({ ...initial, execution: { status: "failed" } }, initial)).rejects.toBeInstanceOf(RuntimeRecordConflictError);
      await expect(store.updateSampling(running, { ...running, projectSampleId: "other" })).rejects.toBeInstanceOf(RuntimeRecordConflictError);
      expect(await store.getSampling(initial.samplingId)).toEqual({ ...running, revision: 1 });
      const updated = { ...evaluation, chatId: "evaluator-chat", status: { status: "running" as const } };
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
      expect(await worker.isRunStopPending(command.run.runId)).toBe(true);
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
      const rollback = {
        ...runQueue,
        async enqueue(transaction: Parameters<RunQueue["enqueue"]>[0], runId: string) {
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
        expect(resumer.stop).toHaveBeenCalledExactlyOnceWith(command.run.runId, expect.any(Object));
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
