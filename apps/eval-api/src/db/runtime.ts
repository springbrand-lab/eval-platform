import type { EvaluationRecord, ProjectInitialLaunch, Sampling } from "@eval-platform/eval-contracts";
import { DatasetEntityNotFoundError } from "@eval-platform/eval-dataset";
import type { RuntimeRecoveryStore, RuntimeRunAdmission, RuntimeRunRecord, RuntimeStore } from "@eval-platform/eval-runtime";
import {
  RuntimeAdmissionConflictError,
  RuntimeEntityNotFoundError,
  RuntimeInputError,
  RuntimeProjectBusyError,
  RuntimeRecordConflictError,
  RuntimeRunIdentityConflictError,
  RuntimeRunStoppedError,
} from "@eval-platform/eval-runtime";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { isPageSize, MAX_PAGE_SIZE, selectByIds, sqlBatches } from "./batch.js";
import type { RunQueue } from "../run-worker-queue.js";
import { constraintViolation, type EvalDb } from "./client.js";
import { ProjectRunStopConflictError } from "./errors.js";
import { requireOwnerUserId } from "./owner.js";
import { requireEvalSpRelease, type EvalSpRelease } from "./release.js";
import {
  evaluationFacts,
  listSamplingEvaluations,
  readEvaluations,
  readRunRecords,
  readSamplings,
  runActive,
  runFinished,
  samplingFacts,
  samplingSucceeded,
  type RecordReader,
  type RunRecordScope,
} from "./run-records.js";
import { datasets, evaluations, projects, runEvaluations, runRequestKeys, runs, runSamplings, samplings } from "./schema.js";

type RuntimeStoreScope =
  | { readonly kind: "worker" }
  | { readonly kind: "user"; readonly ownerUserId: string; readonly release: EvalSpRelease };

type AdmissionWriter = Parameters<Parameters<EvalDb["transaction"]>[0]>[0];

function launchFor(run: RuntimeRunRecord): ProjectInitialLaunch | null {
  switch (run.config.operation) {
    case "execution": return { operation: "execution", configId: run.config.execution.configId };
    case "pipeline": return { operation: "pipeline", configId: run.config.pipeline.configId };
    case "evaluation": return null;
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Checks the submitted facts against each other; PostgreSQL constraints guard everything they can express. */
function validateAdmission(run: RuntimeRunRecord, records: readonly Sampling[], judges: readonly EvaluationRecord[]): void {
  if (run.stopRequested || run.stopFinalized) {
    throw new RuntimeInputError("New Run cannot be stopped at admission", "stopRequested");
  }
  if (records.length === 0) throw new RuntimeInputError("Run must contain Samplings", "samplingIds");
  if (!sameIds(run.samplingIds, records.map((record) => record.samplingId))) {
    throw new RuntimeInputError("Run Sampling scope must match the submitted records", "samplingIds");
  }
  if (!sameIds(run.evaluationIds, judges.map((judge) => judge.evaluationId))) {
    throw new RuntimeInputError("Run Evaluation scope must match the submitted records", "evaluationIds");
  }
  if (records.some((record) => record.projectId !== run.projectId)) {
    throw new RuntimeInputError("Run contains Samplings outside its Project", "projectId");
  }
  if (judges.length !== (run.config.operation === "execution" ? 0 : records.length)) {
    throw new RuntimeInputError("Run must evaluate each Sampling exactly when it includes evaluation", "evaluationIds");
  }
}

async function findRunByKey(
  reader: RecordReader,
  projectId: string,
  idempotencyKey: string,
  ownerUserId: string | undefined,
): Promise<RuntimeRunRecord | null> {
  const [row] = await reader.select({ runId: runs.runId, ownerUserId: runs.ownerUserId }).from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.idempotencyKey, idempotencyKey),
      ownerUserId === undefined ? undefined : eq(runs.ownerUserId, ownerUserId)));
  if (row) {
    const [record] = await readRunRecords(reader, [row.runId], {
      kind: "project", ownerUserId: row.ownerUserId, projectId,
    });
    return record ?? null;
  }
  const [retired] = await reader.select({ idempotencyKey: runRequestKeys.idempotencyKey }).from(runRequestKeys)
    .where(and(eq(runRequestKeys.projectId, projectId), eq(runRequestKeys.idempotencyKey, idempotencyKey),
      ownerUserId === undefined ? undefined : eq(runRequestKeys.ownerUserId, ownerUserId)));
  if (retired) throw new RuntimeRunIdentityConflictError("idempotency key belongs to a superseded Run");
  return null;
}

async function findByIdentity(
  reader: RecordReader,
  ownerUserId: string,
  projectId: string,
  identity: RuntimeRunRecord["requestIdentity"],
): Promise<RuntimeRunRecord | null> {
  const record = await findRunByKey(reader, projectId, identity.idempotencyKey, ownerUserId);
  if (record && record.requestIdentity.requestFingerprint !== identity.requestFingerprint) {
    throw new RuntimeRunIdentityConflictError("idempotency key is already bound to different Run facts");
  }
  return record;
}

/** Replaces the Project's prior Runs and evaluations, then inserts the new Run in one transaction. */
async function admitRun(
  transaction: AdmissionWriter,
  scope: RuntimeStoreScope,
  runQueue: RunQueue,
  run: RuntimeRunRecord,
  records: readonly Sampling[],
  judges: readonly EvaluationRecord[],
): Promise<RuntimeRunAdmission> {
  const [project] = await transaction.select({
    ownerUserId: projects.ownerUserId,
    sourceBranch: projects.sourceBranch,
    evaluationOutputSchemaId: projects.evaluationOutputSchemaId,
    evaluationOutputSchemaLocked: projects.evaluationOutputSchemaLocked,
    initialLaunch: projects.initialLaunch,
  })
    .from(projects)
    .where(and(eq(projects.projectId, run.projectId),
      scope.kind === "user" ? eq(projects.ownerUserId, scope.ownerUserId) : undefined))
    .for("update");
  if (!project) throw new RuntimeEntityNotFoundError("project", run.projectId);
  const owner = project.ownerUserId;
  const existing = await findByIdentity(transaction, owner, run.projectId, run.requestIdentity);
  if (existing) return { run: existing, created: false };
  const [active] = await transaction.select({ runId: runs.runId }).from(runs)
    .where(and(eq(runs.ownerUserId, owner), eq(runs.projectId, run.projectId), runActive(transaction)))
    .limit(1);
  if (active) throw new RuntimeProjectBusyError(run.projectId, active.runId);
  if (scope.kind === "user" && (project.sourceBranch !== scope.release.sourceBranch
    || run.sourceCommit !== scope.release.sourceCommit)) {
    throw new RuntimeAdmissionConflictError("source-branch",
      "Project source branch or Run source commit differs from the active Eval SP release");
  }
  if (run.config.operation !== "execution" && project.evaluationOutputSchemaId === null) {
    throw new RuntimeAdmissionConflictError("output-schema",
      "Project evaluation output JSON Schema must be bound before evaluation admission");
  }
  const launch = launchFor(run);
  if (project.initialLaunch === null && launch === null) {
    throw new RuntimeAdmissionConflictError("empty-project",
      "An empty Project cannot start with evaluation-only; select successful Samplings in an existing Project");
  }
  if (project.initialLaunch !== null && launch !== null
    && (project.initialLaunch.operation !== launch.operation || project.initialLaunch.configId !== launch.configId)) {
    throw new RuntimeAdmissionConflictError("launch-selection", "Project launch selection cannot change after its first Run");
  }
  if (run.config.operation !== "evaluation") {
    const { datasetId } = run.config.execution;
    const [dataset] = await transaction.select({ datasetId: datasets.datasetId }).from(datasets)
      .where(and(eq(datasets.ownerUserId, owner), eq(datasets.datasetId, datasetId), isNull(datasets.deletedAt)))
      .for("share");
    if (!dataset) throw new DatasetEntityNotFoundError("dataset", datasetId);
  }

  const projectSamplingIds = transaction.select({ samplingId: samplings.samplingId }).from(samplings)
    .where(and(eq(samplings.ownerUserId, owner), eq(samplings.projectId, run.projectId)));
  await transaction.delete(runs).where(and(eq(runs.ownerUserId, owner), eq(runs.projectId, run.projectId)));
  await transaction.delete(evaluations)
    .where(and(eq(evaluations.ownerUserId, owner), inArray(evaluations.samplingId, projectSamplingIds)));
  if (run.config.operation !== "evaluation") {
    await transaction.delete(samplings).where(and(eq(samplings.ownerUserId, owner), eq(samplings.projectId, run.projectId)));
  }
  await transaction.insert(runRequestKeys).values({
    ownerUserId: owner, projectId: run.projectId, idempotencyKey: run.requestIdentity.idempotencyKey,
  });
  const [inserted] = await transaction.insert(runs).values({
    runId: run.runId,
    ownerUserId: owner,
    projectId: run.projectId,
    sourceCommit: run.sourceCommit,
    phases: run.phases,
    config: run.config,
    idempotencyKey: run.requestIdentity.idempotencyKey,
    requestFingerprint: run.requestIdentity.requestFingerprint,
  }).onConflictDoNothing().returning({ runId: runs.runId });
  if (!inserted) throw new RuntimeRunIdentityConflictError(`Run identity already exists: ${run.runId}`);

  if (run.config.operation === "evaluation") {
    const available = await selectByIds(run.samplingIds, (batch) => transaction.select({ samplingId: samplings.samplingId })
      .from(samplings).where(and(eq(samplings.ownerUserId, owner), eq(samplings.projectId, run.projectId),
        inArray(samplings.samplingId, batch), samplingSucceeded())).for("share"), (row) => row.samplingId);
    const unavailable = run.samplingIds.find((_samplingId, index) => available[index] === null);
    if (unavailable !== undefined) {
      throw new RuntimeAdmissionConflictError("sampling-unavailable",
        `Sampling ${unavailable} has no successful execution in Project ${run.projectId}`);
    }
  } else {
    for (const batch of sqlBatches(records)) {
      await transaction.insert(samplings).values(batch.map((record) => ({
        samplingId: record.samplingId, ownerUserId: owner, projectId: record.projectId,
        sampleId: record.sampleId, facts: samplingFacts(record),
      })));
    }
  }
  const memberships = run.samplingIds.map((samplingId, position) => ({
    ownerUserId: owner, runId: run.runId, samplingId, position,
  }));
  for (const batch of sqlBatches(memberships)) await transaction.insert(runSamplings).values(batch);
  for (const batch of sqlBatches(judges)) {
    await transaction.insert(evaluations).values(batch.map((judge) => ({
      evaluationId: judge.evaluationId, ownerUserId: owner, samplingId: judge.samplingId, facts: evaluationFacts(judge),
    })));
  }
  const evaluationMemberships = judges.map((judge, position) => ({
    ownerUserId: owner, runId: run.runId, evaluationId: judge.evaluationId, samplingId: judge.samplingId, position,
  }));
  for (const batch of sqlBatches(evaluationMemberships)) await transaction.insert(runEvaluations).values(batch);
  if ((project.initialLaunch === null && launch !== null) ||
    (run.config.operation !== "execution" && !project.evaluationOutputSchemaLocked)) {
    await transaction.update(projects).set({
      ...(project.initialLaunch === null && launch !== null ? { initialLaunch: launch } : {}),
      ...(run.config.operation !== "execution" ? { evaluationOutputSchemaLocked: true } : {}),
    })
      .where(eq(projects.projectId, run.projectId));
  }
  await runQueue.enqueue(transaction, run.runId);
  return { run: structuredClone(run), created: true };
}

function createRuntimeStore(db: EvalDb, scope: RuntimeStoreScope, runQueue: RunQueue): RuntimeStore {
  const owner = scope.kind === "user" ? scope.ownerUserId : undefined;
  const recordScope: RunRecordScope = owner === undefined ? { kind: "worker" } : { kind: "owner", ownerUserId: owner };
  const ownedRun = owner === undefined ? undefined : eq(runs.ownerUserId, owner);

  return {
    async withRunDispatchGate(runId, dispatch) {
      const started = await db.transaction(async (transaction) => {
        const [run] = await transaction.select({ runId: runs.runId, stopRequested: runs.stopRequested })
          .from(runs).where(and(eq(runs.runId, runId), ownedRun)).for("update");
        if (!run) throw new RuntimeEntityNotFoundError("run", runId);
        if (run.stopRequested) throw new RuntimeRunStoppedError(runId);
        // Start the remote call before releasing the lock. Its response can be
        // arbitrarily slow, so do not hold the transaction while awaiting it.
        const outcome = dispatch().then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        return { outcome };
      });
      const outcome = await started.outcome;
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
    async getRun(runId) {
      return db.transaction(async (transaction) => (
        await readRunRecords(transaction, [runId], recordScope)
      )[0] ?? null, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
    async findRunByIdempotencyKey(projectId, idempotencyKey) {
      return db.transaction(
        (transaction) => findRunByKey(transaction, projectId, idempotencyKey, owner),
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
    async createRunWithSamplings(run, records, judges) {
      validateAdmission(run, records, judges);
      try {
        return await db.transaction((transaction) => admitRun(transaction, scope, runQueue, run, records, judges));
      } catch (error) {
        const violation = constraintViolation(error);
        if (violation === null) throw error;
        throw new RuntimeInputError(`Run facts violate ${violation.constraint}`);
      }
    },
    async updateSampling(record, expected) {
      if (record.samplingId !== expected.samplingId
        || record.projectId !== expected.projectId || record.sampleId !== expected.sampleId) {
        throw new RuntimeRecordConflictError("Sampling identity changed before update");
      }
      const updated = await db.update(samplings).set({ facts: samplingFacts(record) })
        .where(and(eq(samplings.samplingId, record.samplingId), eq(samplings.projectId, record.projectId),
          eq(samplings.sampleId, record.sampleId),
          owner === undefined ? undefined : eq(samplings.ownerUserId, owner),
          eq(samplings.facts, samplingFacts(expected))))
        .returning({ samplingId: samplings.samplingId });
      if (updated.length === 0) {
        throw new RuntimeRecordConflictError(`Sampling changed before update: ${record.samplingId}`);
      }
    },
    async getSampling(samplingId) {
      return (await readSamplings(db, [samplingId], owner))[0] ?? null;
    },
    getSamplings(samplingIds) {
      return readSamplings(db, samplingIds, owner);
    },
    async updateEvaluation(record, expected) {
      if (record.evaluationId !== expected.evaluationId || record.samplingId !== expected.samplingId) {
        throw new RuntimeRecordConflictError("Evaluation identity changed before update");
      }
      const updated = await db.update(evaluations).set({ facts: evaluationFacts(record) })
        .where(and(eq(evaluations.evaluationId, record.evaluationId), eq(evaluations.samplingId, record.samplingId),
          owner === undefined ? undefined : eq(evaluations.ownerUserId, owner),
          eq(evaluations.facts, evaluationFacts(expected))))
        .returning({ evaluationId: evaluations.evaluationId });
      if (updated.length === 0) {
        throw new RuntimeRecordConflictError(`Evaluation changed before update: ${record.evaluationId}`);
      }
    },
    async getEvaluation(evaluationId) {
      return (await readEvaluations(db, [evaluationId], owner))[0] ?? null;
    },
    getEvaluations(evaluationIds) {
      return readEvaluations(db, evaluationIds, owner);
    },
    listEvaluations(samplingId) {
      return listSamplingEvaluations(db, samplingId, owner);
    },
  };
}

export function createPostgresWorkerRuntimeStore(
  db: EvalDb,
  runQueue: RunQueue,
): RuntimeStore & RuntimeRecoveryStore {
  return {
    ...createRuntimeStore(db, { kind: "worker" }, runQueue),
    async isRunActive(runId) {
      const [row] = await db.select({ runId: runs.runId }).from(runs)
        .where(and(eq(runs.runId, runId), runActive(db)));
      return row !== undefined;
    },
    async isRunStopRequested(runId) {
      const [row] = await db.select({ stopRequested: runs.stopRequested }).from(runs)
        .where(eq(runs.runId, runId));
      return row?.stopRequested ?? false;
    },
    async markRunStopFinalized(runId) {
      const [updated] = await db.update(runs).set({ stopFinalized: true })
        .where(and(eq(runs.runId, runId), eq(runs.stopRequested, true), runFinished(db)))
        .returning({ runId: runs.runId });
      return updated !== undefined;
    },
  };
}

export function createPostgresRuntimeStore(
  db: EvalDb,
  ownerUserId: string,
  release: EvalSpRelease,
  runQueue: RunQueue,
): RuntimeStore {
  return createRuntimeStore(db, {
    kind: "user", ownerUserId: requireOwnerUserId(ownerUserId), release: requireEvalSpRelease(release),
  }, runQueue);
}

/** Stop intent is serialized with Run admission through the owned Project row. */
export function createPostgresProjectRunControl(db: EvalDb, ownerUserId: string, runQueue: RunQueue) {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    async getCurrentRun(projectId: string): Promise<{ runId: string; stopRequested?: true } | null> {
      const [active] = await db.select({ runId: runs.runId, stopRequested: runs.stopRequested })
        .from(runs).where(and(eq(runs.ownerUserId, owner), eq(runs.projectId, projectId),
          runActive(db))).limit(1);
      return active ? { runId: active.runId,
        ...(active.stopRequested ? { stopRequested: true as const } : {}) } : null;
    },
    async stopRun(projectId: string, runId: string): Promise<{ runId: string; stopRequested: true } | null> {
      return db.transaction(async (transaction) => {
        const [project] = await transaction.select({ projectId: projects.projectId }).from(projects)
          .where(and(eq(projects.projectId, projectId), eq(projects.ownerUserId, owner)))
          .for("update");
        if (!project) return null;
        const [target] = await transaction.select({ runId: runs.runId, stopRequested: runs.stopRequested })
          .from(runs).where(and(eq(runs.ownerUserId, owner), eq(runs.projectId, projectId),
            eq(runs.runId, runId)));
        if (!target) return null;
        if (target.stopRequested) return { runId, stopRequested: true };
        const [active] = await transaction.select({ runId: runs.runId, stopRequested: runs.stopRequested })
          .from(runs)
          .where(and(eq(runs.ownerUserId, owner), eq(runs.projectId, projectId),
            runActive(transaction)))
          .limit(1);
        if (!active) throw new ProjectRunStopConflictError();
        await transaction.update(runs).set({ stopRequested: true }).where(eq(runs.runId, runId));
        await runQueue.enqueue(transaction, runId);
        return { runId, stopRequested: true };
      });
    },
  };
}
