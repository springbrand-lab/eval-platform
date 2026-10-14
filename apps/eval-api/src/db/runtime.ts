import type { EvaluationRecord, ProjectInitialLaunch, Sampling } from "@eval-platform/eval-contracts";
import type { RuntimeRecoveryStore, RuntimeRunRecord, RuntimeStore } from "@eval-platform/eval-runtime";
import { RuntimeEvaluationSelectionError, RuntimeRecordConflictError, RuntimeRunIdentityConflictError } from "@eval-platform/eval-runtime";
import { and, eq, exists, gt, inArray, or, sql } from "drizzle-orm";
import { sqlBatches } from "./batch.js";
import type { EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { requireEvalSpRelease, type EvalSpRelease } from "./release.js";
import { datasets, evaluations, projects, runEvaluations, runs, runSamplings, samples, samplings } from "./schema.js";

export type RuntimeReader = Pick<EvalDb, "select">;

type RuntimeStoreScope =
  | { readonly kind: "worker" }
  | { readonly kind: "user"; readonly ownerUserId: string; readonly release: EvalSpRelease };

export type RunRecordScope = RuntimeStoreScope
  | { readonly kind: "project"; readonly ownerUserId: string; readonly projectId: string };

export function samplingFromRow(row: typeof samplings.$inferSelect): Sampling {
  return { ...row.facts, samplingId: row.samplingId, projectId: row.projectId, sampleId: row.sampleId };
}

export function evaluationFromRow(row: typeof evaluations.$inferSelect): EvaluationRecord {
  return { ...row.facts, evaluationId: row.evaluationId, samplingId: row.samplingId };
}

function samplingFacts(record: Sampling): typeof samplings.$inferInsert.facts {
  const { samplingId: _samplingId, projectId: _projectId, sampleId: _sampleId, ...facts } = record;
  return facts;
}

function evaluationFacts(record: EvaluationRecord): typeof evaluations.$inferInsert.facts {
  const { evaluationId: _evaluationId, samplingId: _samplingId, ...facts } = record;
  return facts;
}

function launchFor(run: RuntimeRunRecord): ProjectInitialLaunch | null {
  switch (run.config.operation) {
    case "execution": return { operation: "execution", configId: run.config.execution.configId };
    case "pipeline": return { operation: "pipeline", configId: run.config.pipeline.configId };
    case "evaluation": return null;
  }
}

export async function readRunRecords(
  reader: RuntimeReader,
  runIds: readonly string[],
  scope: RunRecordScope,
): Promise<readonly RuntimeRunRecord[]> {
  if (runIds.length === 0) return [];
  const selected = await reader.select().from(runs)
    .where(and(
      inArray(runs.runId, runIds),
      scope.kind === "worker" ? undefined : eq(runs.ownerUserId, scope.ownerUserId),
      scope.kind === "project" ? eq(runs.projectId, scope.projectId) : undefined,
    ))
    .orderBy(runs.runId);
  if (selected.length === 0) return [];
  const ids = selected.map((row) => row.runId);
  const [memberships, judges] = await Promise.all([
    reader.select().from(runSamplings).where(inArray(runSamplings.runId, ids))
      .orderBy(runSamplings.runId, runSamplings.position),
    reader.select().from(runEvaluations).where(inArray(runEvaluations.runId, ids))
      .orderBy(runEvaluations.runId, runEvaluations.position),
  ]);
  const samplingIdsByRun = new Map<string, string[]>();
  const evaluationIdsByRun = new Map<string, string[]>();
  for (const member of memberships) {
    const entries = samplingIdsByRun.get(member.runId) ?? [];
    entries.push(member.samplingId);
    samplingIdsByRun.set(member.runId, entries);
  }
  for (const judge of judges) {
    const entries = evaluationIdsByRun.get(judge.runId) ?? [];
    entries.push(judge.evaluationId);
    evaluationIdsByRun.set(judge.runId, entries);
  }
  return selected.map((row) => ({
    runId: row.runId,
    projectId: row.projectId,
    sourceCommit: row.sourceCommit,
    phases: row.phases,
    config: row.config,
    samplingIds: samplingIdsByRun.get(row.runId) ?? [],
    evaluationIds: evaluationIdsByRun.get(row.runId) ?? [],
    requestIdentity: {
      idempotencyKey: row.idempotencyKey,
      requestFingerprint: row.requestFingerprint,
    },
  }));
}

function requireDistinct(ids: readonly string[], field: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${field} must not contain duplicates`);
}

function validateAdmission(
  run: RuntimeRunRecord,
  records: readonly Sampling[],
  judges: readonly EvaluationRecord[],
): void {
  if (run.samplingIds.length === 0) throw new Error("Run must contain Samplings");
  if (run.samplingIds.length !== records.length || run.samplingIds.some((id, index) => id !== records[index]?.samplingId)) {
    throw new Error("Run Sampling scope must match the submitted records");
  }
  if (run.evaluationIds.length !== judges.length || run.evaluationIds.some((id, index) => id !== judges[index]?.evaluationId)) {
    throw new Error("Run Evaluation scope must match the submitted records");
  }
  requireDistinct(run.samplingIds, "samplingIds");
  requireDistinct(run.evaluationIds, "evaluationIds");
  requireDistinct(judges.map((judge) => judge.samplingId), "evaluation samplingIds");
  if (records.some((record) => record.projectId !== run.projectId)
    || judges.some((judge) => !run.samplingIds.includes(judge.samplingId))) {
    throw new Error("Run contains records outside its Project or Sampling scope");
  }
  if (run.phases.length === 1 && run.phases[0] === "execution") {
    if (run.config.operation !== "execution" || judges.length !== 0) {
      throw new Error("Invalid execution Run scope");
    }
  } else if (run.phases.length === 1 && run.phases[0] === "evaluation") {
    if (run.config.operation !== "evaluation" || judges.length !== records.length) {
      throw new Error("Invalid evaluation Run scope");
    }
  } else if (run.phases.length === 2 && run.phases[0] === "execution" && run.phases[1] === "evaluation") {
    if (run.config.operation !== "pipeline" || judges.length !== records.length) {
      throw new Error("Invalid pipeline Run scope");
    }
  } else {
    throw new Error("Invalid Run phases");
  }
  if (!run.requestIdentity.idempotencyKey || !run.requestIdentity.requestFingerprint) {
    throw new Error("Incomplete Run request identity");
  }
}

function createRuntimeStore(db: EvalDb, scope: RuntimeStoreScope): RuntimeStore {
  const ownerScope = scope.kind === "user" ? {
    project: eq(projects.ownerUserId, scope.ownerUserId),
    run: eq(runs.ownerUserId, scope.ownerUserId),
    sampling: eq(samplings.ownerUserId, scope.ownerUserId),
    evaluation: exists(db.select({ samplingId: samplings.samplingId }).from(samplings).where(and(
      eq(samplings.samplingId, evaluations.samplingId),
      eq(samplings.ownerUserId, scope.ownerUserId),
    ))),
  } : {
    project: undefined,
    run: undefined,
    sampling: undefined,
    evaluation: undefined,
  };
  const findByIdentity = async (
    reader: RuntimeReader,
    identityOwner: string,
    projectId: string,
    identity: RuntimeRunRecord["requestIdentity"],
  ): Promise<RuntimeRunRecord | null> => {
    const [matched] = await reader.select({ runId: runs.runId }).from(runs)
      .where(and(eq(runs.ownerUserId, identityOwner), eq(runs.projectId, projectId),
        eq(runs.idempotencyKey, identity.idempotencyKey)));
    if (!matched) return null;
    const [record] = await readRunRecords(reader, [matched.runId], {
      kind: "project", ownerUserId: identityOwner, projectId,
    });
    if (record?.requestIdentity.requestFingerprint !== identity.requestFingerprint) {
      throw new RuntimeRunIdentityConflictError("idempotency key is already bound to different Run facts");
    }
    return record ?? null;
  };

  return {
    async getRun(runId) {
      return db.transaction(async (transaction) => (
        await readRunRecords(transaction, [runId], scope)
      )[0] ?? null, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
    async findRunByIdempotencyKey(projectId, idempotencyKey) {
      return db.transaction(async (transaction) => {
        const [row] = await transaction.select({ runId: runs.runId, ownerUserId: runs.ownerUserId }).from(runs)
          .where(and(eq(runs.projectId, projectId), eq(runs.idempotencyKey, idempotencyKey), ownerScope.run));
        return row ? (await readRunRecords(transaction, [row.runId], {
          kind: "project", ownerUserId: row.ownerUserId, projectId,
        }))[0] ?? null : null;
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
    async createRunWithSamplings(run, records, judges) {
      validateAdmission(run, records, judges);
      return db.transaction(async (transaction) => {
        const [project] = await transaction.select({
          ownerUserId: projects.ownerUserId,
          sourceBranch: projects.sourceBranch,
          initialLaunch: projects.initialLaunch,
        })
          .from(projects)
          .where(and(eq(projects.projectId, run.projectId), ownerScope.project))
          .for("update");
        if (!project) throw new Error(`Unknown Project ${run.projectId}`);
        const identity = run.requestIdentity;
        const existing = await findByIdentity(transaction, project.ownerUserId, run.projectId, identity);
        if (existing) return { run: existing, created: false };
        if (scope.kind === "user" && (project.sourceBranch !== scope.release.sourceBranch
          || run.sourceCommit !== scope.release.sourceCommit)) {
          throw new Error("Project source branch or Run source commit differs from the active Eval SP release");
        }
        const launch = launchFor(run);
        if (project.initialLaunch === null && launch === null) {
          throw new Error("An empty Project cannot start with evaluation-only; select successful Samplings in an existing Project");
        }
        if (project.initialLaunch !== null && launch !== null
          && (project.initialLaunch.operation !== launch.operation || project.initialLaunch.configId !== launch.configId)) {
          throw new Error("Project launch selection cannot change after its first Run");
        }
        const sampleOwner = new Map<string, string>();
        for (const batch of sqlBatches([...new Set(records.map((record) => record.sampleId))])) {
          const selectedSamples = await transaction.select({
            sampleId: samples.sampleId,
            ownerUserId: samples.ownerUserId,
          }).from(samples).where(and(
            eq(samples.ownerUserId, project.ownerUserId),
            inArray(samples.sampleId, batch),
          ));
          for (const sample of selectedSamples) sampleOwner.set(sample.sampleId, sample.ownerUserId);
        }
        if (records.some((record) => sampleOwner.get(record.sampleId) !== project.ownerUserId)) {
          throw new Error("Run contains a Sample outside its Project owner scope");
        }
        if (run.config.operation !== "evaluation") {
          const [dataset] = await transaction.select({ ownerUserId: datasets.ownerUserId })
            .from(datasets).where(and(
              eq(datasets.ownerUserId, project.ownerUserId),
              eq(datasets.datasetId, run.config.execution.datasetId),
            )).for("share");
          if (dataset?.ownerUserId !== project.ownerUserId) {
            throw new Error("Run uses a Dataset outside its Project owner scope");
          }
        }
        const [inserted] = await transaction.insert(runs).values({
          runId: run.runId,
          ownerUserId: project.ownerUserId,
          projectId: run.projectId,
          sourceCommit: run.sourceCommit,
          phases: run.phases,
          config: run.config,
          idempotencyKey: identity.idempotencyKey,
          requestFingerprint: identity.requestFingerprint,
        }).onConflictDoNothing().returning({ runId: runs.runId });
        if (!inserted) {
          const existing = await findByIdentity(transaction, project.ownerUserId, run.projectId, identity);
          if (existing) return { run: existing, created: false };
          throw new RuntimeRunIdentityConflictError(`Run identity already exists: ${run.runId}`);
        }

        if (run.phases[0] === "evaluation") {
          const byId = new Map<string, typeof samplings.$inferSelect>();
          for (const batch of sqlBatches(run.samplingIds)) {
            const existingRecords = await transaction.select().from(samplings)
              .where(and(eq(samplings.ownerUserId, project.ownerUserId),
                inArray(samplings.samplingId, batch))).for("share");
            for (const row of existingRecords) byId.set(row.samplingId, row);
          }
          for (const record of records) {
            const stored = byId.get(record.samplingId);
            if (!stored || stored.projectId !== run.projectId || stored.sampleId !== record.sampleId
              || stored.facts.execution.status !== "succeeded") {
              throw new RuntimeEvaluationSelectionError(
                `Sampling ${record.samplingId} has no successful execution in Project ${run.projectId}`,
              );
            }
          }
        } else {
          for (const batch of sqlBatches(records)) {
            await transaction.insert(samplings).values(batch.map((record) => ({
              samplingId: record.samplingId, ownerUserId: project.ownerUserId, projectId: record.projectId,
              sampleId: record.sampleId, facts: samplingFacts(record),
            })));
          }
        }
        const runMemberships = run.samplingIds.map((samplingId, position) => ({
          ownerUserId: project.ownerUserId, runId: run.runId, samplingId, position,
        }));
        for (const batch of sqlBatches(runMemberships)) await transaction.insert(runSamplings).values(batch);
        if (judges.length > 0) {
          const evaluationRows = judges.map((judge) => ({
            evaluationId: judge.evaluationId, samplingId: judge.samplingId, facts: evaluationFacts(judge),
          }));
          for (const batch of sqlBatches(evaluationRows)) await transaction.insert(evaluations).values(batch);
          const evaluationMemberships = judges.map((judge, position) => ({
            runId: run.runId, evaluationId: judge.evaluationId, samplingId: judge.samplingId, position,
          }));
          for (const batch of sqlBatches(evaluationMemberships)) {
            await transaction.insert(runEvaluations).values(batch);
          }
        }
        if (project.initialLaunch === null && launch !== null) {
          await transaction.update(projects).set({ initialLaunch: launch })
            .where(eq(projects.projectId, run.projectId));
        }
        await transaction.execute(sql`select pg_notify('eval_run_created', ${run.runId})`);
        return { run: structuredClone(run), created: true };
      });
    },
    async updateSampling(record, expected) {
      if (record.samplingId !== expected.samplingId
        || record.projectId !== expected.projectId || record.sampleId !== expected.sampleId) {
        throw new RuntimeRecordConflictError("Sampling identity changed before update");
      }
      const updated = await db.update(samplings).set({ facts: samplingFacts(record) })
        .where(and(eq(samplings.samplingId, record.samplingId), eq(samplings.projectId, record.projectId),
          eq(samplings.sampleId, record.sampleId),
          ownerScope.sampling,
          eq(samplings.facts, samplingFacts(expected))))
        .returning({ samplingId: samplings.samplingId });
      if (updated.length === 0) {
        throw new RuntimeRecordConflictError(`Sampling changed before update: ${record.samplingId}`);
      }
    },
    async getSampling(samplingId) {
      const [row] = await db.select().from(samplings).where(and(
        eq(samplings.samplingId, samplingId),
        ownerScope.sampling,
      ));
      return row ? samplingFromRow(row) : null;
    },
    async updateEvaluation(record, expected) {
      if (record.evaluationId !== expected.evaluationId || record.samplingId !== expected.samplingId) {
        throw new RuntimeRecordConflictError("Evaluation identity changed before update");
      }
      const updated = await db.update(evaluations).set({ facts: evaluationFacts(record) })
        .where(and(eq(evaluations.evaluationId, record.evaluationId), eq(evaluations.samplingId, record.samplingId),
          ownerScope.evaluation,
          eq(evaluations.facts, evaluationFacts(expected))))
        .returning({ evaluationId: evaluations.evaluationId });
      if (updated.length === 0) {
        throw new RuntimeRecordConflictError(`Evaluation changed before update: ${record.evaluationId}`);
      }
    },
    async getEvaluation(evaluationId) {
      const [row] = await db.select({
        evaluationId: evaluations.evaluationId, samplingId: evaluations.samplingId, facts: evaluations.facts,
      }).from(evaluations).innerJoin(samplings, eq(evaluations.samplingId, samplings.samplingId))
        .where(and(eq(evaluations.evaluationId, evaluationId),
          ownerScope.sampling));
      return row ? evaluationFromRow(row) : null;
    },
    async listEvaluations(samplingId) {
      const rows = await db.select({
        evaluationId: evaluations.evaluationId, samplingId: evaluations.samplingId, facts: evaluations.facts,
      }).from(evaluations).innerJoin(samplings, eq(evaluations.samplingId, samplings.samplingId))
        .where(and(eq(evaluations.samplingId, samplingId),
          ownerScope.sampling))
        .orderBy(evaluations.evaluationId);
      return rows.map(evaluationFromRow);
    },
  };
}

export function createPostgresWorkerRuntimeStore(db: EvalDb): RuntimeStore & RuntimeRecoveryStore {
  return {
    ...createRuntimeStore(db, { kind: "worker" }),
    async listRecoverableRunIds(afterRunId, limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("Recovery page size must be between 1 and 1000");
      }
      const unfinished = ["queued", "starting", "running", "retrying"];
      const executionPending = exists(db.select({ samplingId: runSamplings.samplingId })
        .from(runSamplings)
        .innerJoin(samplings, eq(runSamplings.samplingId, samplings.samplingId))
        .where(and(
          eq(runSamplings.runId, runs.runId),
          inArray(sql<string>`${samplings.facts}->'execution'->>'status'`, unfinished),
        )));
      const evaluationPending = exists(db.select({ evaluationId: runEvaluations.evaluationId })
        .from(runEvaluations)
        .innerJoin(evaluations, eq(runEvaluations.evaluationId, evaluations.evaluationId))
        .where(and(
          eq(runEvaluations.runId, runs.runId),
          inArray(sql<string>`${evaluations.facts}->'status'->>'status'`, unfinished),
        )));
      const rows = await db.select({ runId: runs.runId }).from(runs)
        .where(and(afterRunId === undefined ? undefined : gt(runs.runId, afterRunId), or(executionPending, evaluationPending)))
        .orderBy(runs.runId).limit(limit);
      return rows.map(({ runId }) => runId);
    },
  };
}

export function createPostgresRuntimeStore(db: EvalDb, ownerUserId: string, release: EvalSpRelease): RuntimeStore {
  return createRuntimeStore(db, {
    kind: "user", ownerUserId: requireOwnerUserId(ownerUserId), release: requireEvalSpRelease(release),
  });
}
