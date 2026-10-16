import type {
  CurrentRun,
  ProjectRunState,
  RuntimeRecoveryStore,
  RuntimeRunAdmission,
  RuntimeRunAdmissionCommand,
  RuntimeRunRecord,
  RuntimeStore,
  SamplingState,
} from "@eval-platform/eval-runtime";
import {
  RuntimeAdmissionConflictError,
  RuntimeEntityNotFoundError,
  RuntimeInputError,
  RuntimeProjectBusyError,
  RuntimeRecordConflictError,
  RuntimeRunIdentityConflictError,
  RuntimeRunStoppedError,
} from "@eval-platform/eval-runtime";
import { and, desc, eq, gt, inArray, max } from "drizzle-orm";
import { addToGroup, selectByIds, sqlBatches } from "./batch.js";
import type { RunQueue } from "../run-worker-queue.js";
import { constraintViolation, READ_SNAPSHOT, type EvalDb } from "./client.js";
import { ProjectRunStopConflictError } from "./errors.js";
import { requireOwnerUserId } from "./owner.js";
import { visibleProject } from "./project-plans.js";
import { requireEvalSpRelease, type EvalSpRelease } from "./release.js";
import {
  evaluationFacts,
  listSamplingEvaluations,
  projectHasRun,
  readEvaluations,
  readRunRecords,
  readSamplings,
  runActive,
  runFinished,
  samplingFacts,
  samplingFromRow,
  samplingSucceeded,
  type RecordReader,
  type RunRecordScope,
} from "./run-records.js";
import {
  evaluations,
  projectEvaluationPlans,
  projectExecutionPlans,
  projects,
  runEvaluations,
  runs,
  runSamplings,
  samplings,
} from "./schema.js";

type RuntimeStoreScope =
  | { readonly kind: "worker" }
  | { readonly kind: "user"; readonly ownerUserId: string; readonly release: EvalSpRelease };

type AdmissionWriter = Parameters<Parameters<EvalDb["transaction"]>[0]>[0];

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  const set = new Set(left);
  return set.size === new Set(right).size && right.every((id) => set.has(id));
}

/** Checks the submitted facts against each other; PostgreSQL constraints guard everything they can express. */
function validateAdmission({ run, samplings: records, evaluations: newEvaluations, replacedSamplingIds }: RuntimeRunAdmissionCommand): void {
  if (run.stopRequested || run.stopFinalized) {
    throw new RuntimeInputError("New Run cannot be stopped at admission", "stopRequested");
  }
  if (run.samplingIds.length === 0) throw new RuntimeAdmissionConflictError("empty-targets", "Run selects no Samplings");
  const evaluates = run.operation !== "execution";
  if ((run.planDigests.evaluation !== undefined) !== evaluates) {
    throw new RuntimeInputError("Run must record an evaluation plan digest exactly when it evaluates", "planDigests");
  }
  if (run.operation === "evaluation") {
    if (records.length > 0 || replacedSamplingIds.length > 0 || run.targets.projectSampleIds.length > 0
      || !sameIds(run.samplingIds, run.targets.samplingIds)) {
      throw new RuntimeInputError("Evaluation Runs reuse exactly their target Samplings", "samplingIds");
    }
  } else {
    if (!sameIds(run.samplingIds, records.map((record) => record.samplingId))) {
      throw new RuntimeInputError("Run Sampling scope must match the submitted records", "samplingIds");
    }
    if (records.some((record) => record.projectId !== run.projectId)) {
      throw new RuntimeInputError("Run contains Samplings outside its Project", "projectId");
    }
  }
  if (!sameIds(run.evaluationIds, newEvaluations.map((evaluation) => evaluation.evaluationId))) {
    throw new RuntimeInputError("Run Evaluation scope must match the submitted records", "evaluationIds");
  }
  if (evaluates ? !sameIds(newEvaluations.map((evaluation) => evaluation.samplingId), run.samplingIds) : newEvaluations.length > 0) {
    throw new RuntimeInputError("Run must evaluate each Sampling exactly when it includes evaluation", "evaluationIds");
  }
}

/** The Run bound to a Project-scoped key; a key whose Run a later admission superseded may not replay. */
async function findRunByKey(
  reader: RecordReader,
  projectId: string,
  idempotencyKey: string,
  ownerUserId: string | undefined,
): Promise<RuntimeRunRecord | null> {
  const [row] = await reader.select({ runId: runs.runId, ownerUserId: runs.ownerUserId, sequence: runs.sequence }).from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.idempotencyKey, idempotencyKey),
      ownerUserId === undefined ? undefined : eq(runs.ownerUserId, ownerUserId)));
  if (!row) return null;
  const [later] = await reader.select({ runId: runs.runId }).from(runs)
    .where(and(eq(runs.projectId, projectId), gt(runs.sequence, row.sequence))).limit(1);
  if (later) throw new RuntimeRunIdentityConflictError("idempotency key belongs to a superseded Run");
  const [record] = await readRunRecords(reader, [row.runId], { kind: "project", ownerUserId: row.ownerUserId, projectId });
  return record ?? null;
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

/** Locks and returns the current Samplings of execution targets, keyed by Sampling ID with their ProjectSample. */
async function lockExecutionTargets(
  transaction: AdmissionWriter, owner: string, run: RuntimeRunRecord,
): Promise<Map<string, string>> {
  const current = new Map<string, string>();
  const fields = { samplingId: samplings.samplingId, projectSampleId: samplings.projectSampleId };
  const scoped = and(eq(samplings.ownerUserId, owner), eq(samplings.projectId, run.projectId));
  for (const batch of sqlBatches(run.targets.projectSampleIds)) {
    for (const row of await transaction.select(fields).from(samplings)
      .where(and(scoped, inArray(samplings.projectSampleId, batch))).for("update")) current.set(row.samplingId, row.projectSampleId);
  }
  for (const batch of sqlBatches(run.targets.samplingIds)) {
    for (const row of await transaction.select(fields).from(samplings)
      .where(and(scoped, inArray(samplings.samplingId, batch))).for("update")) current.set(row.samplingId, row.projectSampleId);
  }
  return current;
}

/**
 * Locks the Project row and resolves the request identity: a replay returns the existing Run, the
 * creation key is refused once the Project has any Run, and a new key needs an idle Project on the
 * active release. Returns the owner for the remaining steps.
 */
async function lockForAdmission(
  transaction: AdmissionWriter, scope: RuntimeStoreScope, run: RuntimeRunRecord,
): Promise<{ readonly owner: string; readonly executionPlanDigest: string; readonly existing: RuntimeRunRecord | null }> {
  // Every Project row is written with its execution plan in the creation transaction.
  const [project] = await transaction.select({
    ownerUserId: projects.ownerUserId, sourceBranch: projects.sourceBranch, creationKey: projects.creationKey,
    executionPlanDigest: projectExecutionPlans.digest,
  })
    .from(projects)
    .innerJoin(projectExecutionPlans, eq(projectExecutionPlans.projectId, projects.projectId))
    .where(visibleProject(run.projectId, scope.kind === "user" ? scope.ownerUserId : undefined))
    .for("update", { of: projects });
  if (!project) throw new RuntimeEntityNotFoundError("project", run.projectId);
  const owner = project.ownerUserId;
  const { executionPlanDigest } = project;
  const existing = await findByIdentity(transaction, owner, run.projectId, run.requestIdentity);
  if (existing) return { owner, executionPlanDigest, existing };
  // A creation key admits only the Project's very first Run; once any Run exists the creation was superseded.
  if (run.requestIdentity.idempotencyKey === project.creationKey && await projectHasRun(transaction, run.projectId)) {
    throw new RuntimeAdmissionConflictError("creation-superseded",
      `Project ${run.projectId} already has Runs; its creation no longer admits a first Run`);
  }
  const [active] = await transaction.select({ runId: runs.runId }).from(runs)
    .where(and(eq(runs.ownerUserId, owner), eq(runs.projectId, run.projectId), runActive(transaction)))
    .limit(1);
  if (active) throw new RuntimeProjectBusyError(run.projectId, active.runId);
  if (scope.kind === "user" && (project.sourceBranch !== scope.release.sourceBranch
    || run.sourceCommit !== scope.release.sourceCommit)) {
    throw new RuntimeAdmissionConflictError("source-branch",
      "Project source branch or Run source commit differs from the active Eval SP release");
  }
  return { owner, executionPlanDigest, existing: null };
}

/** Rechecks the plan digests the Run was prepared against; returns whether the evaluation plan still needs locking. */
async function checkPlanDigests(
  transaction: AdmissionWriter, run: RuntimeRunRecord, executionPlanDigest: string,
): Promise<{ readonly lockEvaluationPlan: boolean }> {
  const evaluates = run.operation !== "execution";
  const [evaluationPlan] = await transaction.select({ digest: projectEvaluationPlans.digest, lockedAt: projectEvaluationPlans.lockedAt })
    .from(projectEvaluationPlans).where(eq(projectEvaluationPlans.projectId, run.projectId));
  if (evaluates && !evaluationPlan) {
    throw new RuntimeAdmissionConflictError("evaluation-plan-required", "Project has no evaluation plan");
  }
  if (executionPlanDigest !== run.planDigests.execution
    || (evaluates && evaluationPlan?.digest !== run.planDigests.evaluation)) {
    throw new RuntimeAdmissionConflictError("plan-changed", "Project plan changed after the Run was prepared");
  }
  return { lockEvaluationPlan: evaluates && evaluationPlan?.lockedAt === null };
}

/**
 * Locks the target records and rechecks them against the current Project state. Target ProjectSamples
 * need no separate pass: the unchanged execution digest covers them, and the Sampling → ProjectSample
 * foreign key rejects a new Sampling of an unknown one.
 */
async function lockTargets(transaction: AdmissionWriter, owner: string, command: RuntimeRunAdmissionCommand): Promise<void> {
  const { run, replacedSamplingIds, samplings: newSamplings } = command;

  if (run.operation === "evaluation") {
    const available = await selectByIds(run.samplingIds, (batch) => transaction.select({ samplingId: samplings.samplingId })
      .from(samplings).where(and(eq(samplings.ownerUserId, owner), eq(samplings.projectId, run.projectId),
        inArray(samplings.samplingId, batch), samplingSucceeded())).for("update"), (row) => row.samplingId);
    const unavailable = run.samplingIds.find((_samplingId, index) => available[index] === null);
    if (unavailable !== undefined) {
      throw new RuntimeAdmissionConflictError("sampling-unavailable",
        `Sampling ${unavailable} has no successful execution in Project ${run.projectId}`);
    }
    return;
  }
  const current = await lockExecutionTargets(transaction, owner, run);
  if (run.targets.samplingIds.some((samplingId) => !current.has(samplingId))
    || !sameIdSet([...current.keys()], replacedSamplingIds)) {
    throw new RuntimeAdmissionConflictError("stale-targets", "Run targets no longer match the Project's current Samplings");
  }
  const allowed = new Set([...run.targets.projectSampleIds, ...current.values()]);
  if (newSamplings.some((record) => !allowed.has(record.projectSampleId))) {
    throw new RuntimeInputError("New Samplings must belong to the Run targets", "samplings");
  }
}

/** Deletes only the selected records: replaced Samplings with their Evaluations and memberships, or for evaluation the targets' Evaluations. */
async function clearSelected(transaction: AdmissionWriter, owner: string, command: RuntimeRunAdmissionCommand): Promise<void> {
  const { run } = command;
  const cleared = run.operation === "evaluation" ? run.samplingIds : command.replacedSamplingIds;
  for (const batch of sqlBatches(cleared)) {
    await transaction.delete(runEvaluations).where(and(eq(runEvaluations.ownerUserId, owner), inArray(runEvaluations.samplingId, batch)));
    await transaction.delete(evaluations).where(and(eq(evaluations.ownerUserId, owner), inArray(evaluations.samplingId, batch)));
    if (run.operation === "evaluation") continue;
    await transaction.delete(runSamplings).where(and(eq(runSamplings.ownerUserId, owner), inArray(runSamplings.samplingId, batch)));
    await transaction.delete(samplings).where(and(eq(samplings.ownerUserId, owner), inArray(samplings.samplingId, batch)));
  }
}

/** Inserts the Run with the next Project sequence, its new records and memberships, in SQL batches. */
async function insertRun(transaction: AdmissionWriter, owner: string, command: RuntimeRunAdmissionCommand): Promise<void> {
  const { run, samplings: newSamplings, evaluations: newEvaluations } = command;
  const [{ latest } = { latest: null }] = await transaction.select({ latest: max(runs.sequence) }).from(runs)
    .where(eq(runs.projectId, run.projectId));
  const [inserted] = await transaction.insert(runs).values({
    runId: run.runId,
    ownerUserId: owner,
    projectId: run.projectId,
    sequence: (latest ?? 0) + 1,
    sourceCommit: run.sourceCommit,
    operation: run.operation,
    phases: run.phases,
    selector: run.selector,
    targets: run.targets,
    executionPlanDigest: run.planDigests.execution,
    evaluationPlanDigest: run.planDigests.evaluation ?? null,
    idempotencyKey: run.requestIdentity.idempotencyKey,
    requestFingerprint: run.requestIdentity.requestFingerprint,
  }).onConflictDoNothing().returning({ runId: runs.runId });
  if (!inserted) throw new RuntimeRunIdentityConflictError(`Run identity already exists: ${run.runId}`);

  for (const batch of sqlBatches(newSamplings)) {
    await transaction.insert(samplings).values(batch.map((record) => ({
      samplingId: record.samplingId, ownerUserId: owner, projectId: record.projectId,
      projectSampleId: record.projectSampleId, facts: samplingFacts(record),
    })));
  }
  const memberships = run.samplingIds.map((samplingId, position) => ({
    ownerUserId: owner, runId: run.runId, samplingId, position,
  }));
  for (const batch of sqlBatches(memberships)) await transaction.insert(runSamplings).values(batch);
  for (const batch of sqlBatches(newEvaluations)) {
    await transaction.insert(evaluations).values(batch.map((evaluation) => ({
      evaluationId: evaluation.evaluationId, ownerUserId: owner, samplingId: evaluation.samplingId, facts: evaluationFacts(evaluation),
    })));
  }
  const evaluationMemberships = newEvaluations.map((evaluation, position) => ({
    ownerUserId: owner, runId: run.runId, evaluationId: evaluation.evaluationId, samplingId: evaluation.samplingId, position,
  }));
  for (const batch of sqlBatches(evaluationMemberships)) await transaction.insert(runEvaluations).values(batch);
}

/** Replaces only the selected records and inserts the new Run in one transaction under the Project row lock. */
async function admitRun(
  transaction: AdmissionWriter,
  scope: RuntimeStoreScope,
  runQueue: RunQueue,
  command: RuntimeRunAdmissionCommand,
): Promise<RuntimeRunAdmission> {
  const { run } = command;
  const { owner, executionPlanDigest, existing } = await lockForAdmission(transaction, scope, run);
  if (existing) return { run: existing, created: false };
  const { lockEvaluationPlan } = await checkPlanDigests(transaction, run, executionPlanDigest);
  await lockTargets(transaction, owner, command);
  await clearSelected(transaction, owner, command);
  await insertRun(transaction, owner, command);
  if (lockEvaluationPlan) {
    await transaction.update(projectEvaluationPlans).set({ lockedAt: new Date() })
      .where(eq(projectEvaluationPlans.projectId, run.projectId));
  }
  await runQueue.enqueue(transaction, run.runId);
  return { run: structuredClone(run), created: true };
}

/** Admission serializes Runs, so only the latest one can still be active. */
export async function readProjectRunState(reader: RecordReader, ownerUserId: string, projectId: string): Promise<ProjectRunState> {
  const [latest] = await reader.select({ runId: runs.runId, sequence: runs.sequence, stopRequested: runs.stopRequested, active: runActive(reader) })
    .from(runs).where(and(eq(runs.ownerUserId, ownerUserId), eq(runs.projectId, projectId))).orderBy(desc(runs.sequence)).limit(1);
  return {
    runSequence: latest?.sequence ?? 0,
    currentRun: latest?.active ? { runId: latest.runId, ...(latest.stopRequested ? { stopRequested: true as const } : {}) } : null,
  };
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
      )[0] ?? null, READ_SNAPSHOT);
    },
    async findRunByIdempotencyKey(projectId, idempotencyKey) {
      return db.transaction(
        (transaction) => findRunByKey(transaction, projectId, idempotencyKey, owner),
        READ_SNAPSHOT,
      );
    },
    async listProjectSamplings(projectId, projectSampleIds) {
      const byProjectSample = new Map<string, SamplingState[]>();
      for (const batch of sqlBatches([...new Set(projectSampleIds)])) {
        const rows = await db.select().from(samplings).where(and(eq(samplings.projectId, projectId),
          inArray(samplings.projectSampleId, batch), owner === undefined ? undefined : eq(samplings.ownerUserId, owner)))
          .orderBy(samplings.samplingId);
        for (const row of rows) {
          addToGroup(byProjectSample, row.projectSampleId, samplingFromRow(row));
        }
      }
      return [...new Set(projectSampleIds)].flatMap((id) => byProjectSample.get(id) ?? []);
    },
    async admitRun(command) {
      validateAdmission(command);
      try {
        return await db.transaction((transaction) => admitRun(transaction, scope, runQueue, command));
      } catch (error) {
        const violation = constraintViolation(error);
        if (violation === null) throw error;
        throw new RuntimeInputError(`Run facts violate ${violation.constraint}`);
      }
    },
    async updateSampling(record, expected) {
      if (record.samplingId !== expected.samplingId
        || record.projectId !== expected.projectId || record.projectSampleId !== expected.projectSampleId) {
        throw new RuntimeRecordConflictError("Sampling identity changed before update");
      }
      const updated = await db.update(samplings).set({ facts: samplingFacts(record) })
        .where(and(eq(samplings.samplingId, record.samplingId), eq(samplings.projectId, record.projectId),
          eq(samplings.projectSampleId, record.projectSampleId),
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
    async requestRunStop(runId) {
      await db.update(runs).set({ stopRequested: true }).where(and(eq(runs.runId, runId), runActive(db)));
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
    async getCurrentRun(projectId: string): Promise<CurrentRun | null> {
      return (await readProjectRunState(db, owner, projectId)).currentRun;
    },
    async stopRun(projectId: string, runId: string): Promise<{ runId: string; stopRequested: true } | null> {
      return db.transaction(async (transaction) => {
        const [project] = await transaction.select({ projectId: projects.projectId }).from(projects)
          .where(visibleProject(projectId, owner)).for("update");
        if (!project) return null;
        const [target] = await transaction.select({ stopRequested: runs.stopRequested })
          .from(runs).where(and(eq(runs.ownerUserId, owner), eq(runs.projectId, projectId),
            eq(runs.runId, runId)));
        if (!target) return null;
        const [active] = await transaction.select({ runId: runs.runId }).from(runs)
          .where(and(eq(runs.runId, runId), runActive(transaction)));
        if (!active) {
          if (target.stopRequested) return { runId, stopRequested: true };
          throw new ProjectRunStopConflictError();
        }
        if (!target.stopRequested) await transaction.update(runs).set({ stopRequested: true }).where(eq(runs.runId, runId));
        // A stop whose cleanup has not finalized gets its job back, e.g. after an exhausted retry budget.
        await runQueue.enqueue(transaction, runId);
        return { runId, stopRequested: true };
      });
    },
  };
}
