import type { EvaluationRecord, Sampling } from "@eval-platform/eval-contracts";
import { PENDING_SAMPLING_STATUSES } from "@eval-platform/eval-contracts";
import type { RuntimeRunRecord } from "@eval-platform/eval-runtime";
import { and, eq, exists, inArray, notExists, or, sql, type SQL } from "drizzle-orm";
import { selectByIds } from "./batch.js";
import type { EvalDb } from "./client.js";
import { evaluations, runEvaluations, runs, runSamplings, samplings } from "./schema.js";

export type RecordReader = Pick<EvalDb, "select">;

/** `worker` reads every owner; it is never reachable from user requests. */
export type RunRecordScope =
  | { readonly kind: "worker" }
  | { readonly kind: "owner"; readonly ownerUserId: string }
  | { readonly kind: "project"; readonly ownerUserId: string; readonly projectId: string };

const samplingStatus = sql<string>`${samplings.facts}->'execution'->>'status'`;
const evaluationStatus = sql<string>`${evaluations.facts}->'status'->>'status'`;

/** The single definition of a Sampling that may be evaluated on its own. */
export function samplingSucceeded(): SQL {
  return eq(samplingStatus, "succeeded");
}

const samplingStage = sql`${samplings.facts}->'execution'`;
const evaluationStage = sql`${evaluations.facts}->'status'`;

/**
 * With a pending status, the SQL form of `isStageRecoveryPending`: a finished stage still waiting
 * for its resource snapshot. `observationPending` only exists on a pending status.
 */
function resourcesPending(stage: SQL): SQL {
  return sql`jsonb_typeof(${stage}->'resourcesPending') = 'object'`;
}

/** Epoch milliseconds of the earliest due readiness check; one never scheduled is due at once, as in `isStageDue`. */
function earliestResourceCheck(stage: SQL): SQL {
  return sql`min(coalesce(extract(epoch from (${stage}->'resourcesPending'->>'nextAttemptAt')::timestamptz)::float8 * 1000, '-infinity'::float8))`;
}

/** Correlated member subqueries of the outer `runs` row, selecting `value(stage)` when given. */
function memberships(reader: RecordReader, sampling: SQL | undefined, evaluation: SQL | undefined, value?: (stage: SQL) => SQL) {
  return [
    reader.select({ value: value?.(samplingStage) ?? sql`1` }).from(runSamplings)
      .innerJoin(samplings, eq(runSamplings.samplingId, samplings.samplingId))
      .where(and(eq(runSamplings.runId, runs.runId), sampling)),
    reader.select({ value: value?.(evaluationStage) ?? sql`1` }).from(runEvaluations)
      .innerJoin(evaluations, eq(runEvaluations.evaluationId, evaluations.evaluationId))
      .where(and(eq(runEvaluations.runId, runs.runId), evaluation)),
  ] as const;
}

/** Members whose status is pending; the only test for a Run's finished stages and stop finalization. */
function pendingMemberships(reader: RecordReader) {
  return memberships(reader, inArray(samplingStatus, PENDING_SAMPLING_STATUSES), inArray(evaluationStatus, PENDING_SAMPLING_STATUSES));
}

/**
 * Members of a non-stopped Run still waiting for a resource snapshot. A Sampling's execution stage belongs to
 * the execution/pipeline Run that created it, never to an evaluation Run that reuses it. A stop
 * request ignores these flags, so they can never hold a stopped Run open.
 */
function recoveringMemberships(reader: RecordReader, value?: (stage: SQL) => SQL) {
  const running = eq(runs.stopRequested, false);
  return memberships(reader,
    and(running, inArray(runs.operation, ["execution", "pipeline"]), resourcesPending(samplingStage)),
    and(running, resourcesPending(evaluationStage)), value);
}

/** True for a Run whose Sampling or Evaluation work is pending; correlated with the outer `runs` row. */
function runUnfinished(reader: RecordReader): SQL | undefined {
  const [samplingWork, evaluationWork] = pendingMemberships(reader);
  const [samplingRecovery, evaluationRecovery] = recoveringMemberships(reader);
  return or(exists(samplingWork), exists(evaluationWork), exists(samplingRecovery), exists(evaluationRecovery));
}

/** No member status is pending; recovery flags do not delay stop finalization. */
export function runFinished(reader: RecordReader): SQL | undefined {
  const [samplingWork, evaluationWork] = pendingMemberships(reader);
  return and(notExists(samplingWork), notExists(evaluationWork));
}

/** The SQL form of the Runtime's `isRunStopPending`: a stop request not yet finalized. */
export function runStopPending(): SQL<boolean> {
  return sql<boolean>`${and(eq(runs.stopRequested, true), eq(runs.stopFinalized, false))}`;
}

/** An active Run still has pending work, owed recovery while not stopped, or an unfinalized stop request. */
export function runActive(reader: RecordReader): SQL<boolean> {
  return sql<boolean>`${or(runUnfinished(reader), runStopPending())}`;
}

/**
 * Epoch milliseconds of the earliest due resource readiness check of a Run that waits for nothing
 * else: no pending member and no stop request. Null for any other Run.
 */
export async function nextResourceCheckAt(reader: RecordReader, runId: string): Promise<number | null> {
  const [sampling, evaluation] = recoveringMemberships(reader, earliestResourceCheck);
  const [row] = await reader.select({ at: sql<number | string | null>`least((${sampling}), (${evaluation}))` }).from(runs)
    .where(and(eq(runs.runId, runId), runFinished(reader)));
  return row?.at == null ? null : Number(row.at);
}

/** The single definition of "this Project has a Run", shared by creation replay, admission and compensation. */
export async function projectHasRun(reader: RecordReader, projectId: string): Promise<boolean> {
  const [run] = await reader.select({ runId: runs.runId }).from(runs).where(eq(runs.projectId, projectId)).limit(1);
  return run !== undefined;
}

export function samplingFromRow(row: Pick<typeof samplings.$inferSelect, "facts" | "samplingId" | "projectId" | "projectSampleId">): Sampling {
  return { ...row.facts, samplingId: row.samplingId, projectId: row.projectId, projectSampleId: row.projectSampleId };
}

export function evaluationFromRow(row: Pick<typeof evaluations.$inferSelect, "facts" | "evaluationId" | "samplingId">): EvaluationRecord {
  return { ...row.facts, evaluationId: row.evaluationId, samplingId: row.samplingId };
}

export function samplingFacts(record: Sampling): typeof samplings.$inferInsert.facts {
  const { samplingId: _samplingId, projectId: _projectId, projectSampleId: _projectSampleId, ...facts } = record;
  return facts;
}

export function evaluationFacts(record: EvaluationRecord): typeof evaluations.$inferInsert.facts {
  const { evaluationId: _evaluationId, samplingId: _samplingId, ...facts } = record;
  return facts;
}

/** One Sampling or null per requested ID, in request order. Omit the owner only for the Worker. */
export async function readSamplings(
  reader: RecordReader, samplingIds: readonly string[], ownerUserId?: string,
): Promise<(Sampling | null)[]> {
  const rows = await selectByIds(samplingIds, (batch) => reader.select().from(samplings).where(and(
    inArray(samplings.samplingId, batch),
    ownerUserId === undefined ? undefined : eq(samplings.ownerUserId, ownerUserId),
  )), (row) => row.samplingId);
  return rows.map((row) => row && samplingFromRow(row));
}

/** One EvaluationRecord or null per requested ID, in request order. Omit the owner only for the Worker. */
export async function readEvaluations(
  reader: RecordReader, evaluationIds: readonly string[], ownerUserId?: string,
): Promise<(EvaluationRecord | null)[]> {
  const rows = await selectByIds(evaluationIds, (batch) => reader.select().from(evaluations).where(and(
    inArray(evaluations.evaluationId, batch),
    ownerUserId === undefined ? undefined : eq(evaluations.ownerUserId, ownerUserId),
  )), (row) => row.evaluationId);
  return rows.map((row) => row && evaluationFromRow(row));
}

export async function listSamplingEvaluations(
  reader: RecordReader, samplingId: string, ownerUserId?: string,
): Promise<EvaluationRecord[]> {
  const rows = await reader.select().from(evaluations)
    .where(and(eq(evaluations.samplingId, samplingId),
      ownerUserId === undefined ? undefined : eq(evaluations.ownerUserId, ownerUserId)))
    .orderBy(evaluations.evaluationId);
  return rows.map(evaluationFromRow);
}

/** Run memberships are protected by foreign keys; a gap means the stored state is corrupt. */
export function requireMembers<T>(rows: readonly (T | null)[], ids: readonly string[], missing: (id: string) => Error): T[] {
  return ids.map((id, index) => {
    const row = rows[index];
    if (row === undefined || row === null) throw missing(id);
    return row;
  });
}

function groupIds<T extends { readonly runId: string }>(rows: readonly T[], idOf: (row: T) => string) {
  const byRun = new Map<string, string[]>();
  for (const row of rows) {
    const entries = byRun.get(row.runId) ?? [];
    entries.push(idOf(row));
    byRun.set(row.runId, entries);
  }
  return byRun;
}

export async function readRunRecords(
  reader: RecordReader,
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
  const memberships = await reader.select().from(runSamplings).where(inArray(runSamplings.runId, ids))
    .orderBy(runSamplings.runId, runSamplings.position);
  const evaluationMemberships = await reader.select().from(runEvaluations).where(inArray(runEvaluations.runId, ids))
    .orderBy(runEvaluations.runId, runEvaluations.position);
  const samplingIdsByRun = groupIds(memberships, (member) => member.samplingId);
  const evaluationIdsByRun = groupIds(evaluationMemberships, (member) => member.evaluationId);
  return selected.map((row) => ({
    runId: row.runId,
    projectId: row.projectId,
    sourceCommit: row.sourceCommit,
    operation: row.operation,
    phases: row.phases,
    selector: row.selector,
    targets: row.targets,
    samplingIds: samplingIdsByRun.get(row.runId) ?? [],
    evaluationIds: evaluationIdsByRun.get(row.runId) ?? [],
    planDigests: {
      execution: row.executionPlanDigest,
      ...(row.evaluationPlanDigest === null ? {} : { evaluation: row.evaluationPlanDigest }),
    },
    requestIdentity: {
      idempotencyKey: row.idempotencyKey,
      requestFingerprint: row.requestFingerprint,
    },
    ...(row.stopRequested ? { stopRequested: true as const } : {}),
    ...(row.stopFinalized ? { stopFinalized: true as const } : {}),
  }));
}

/** Run progress depends on stages only, never raw resource snapshots or evaluation outputs. */
export async function readSamplingProgress(reader: RecordReader, ids: readonly string[], owner: string) {
  return selectByIds(ids, (batch) => reader.select({ samplingId: samplings.samplingId,
    execution: sql<Sampling["execution"]>`${samplings.facts}->'execution'`,
  }).from(samplings).where(and(inArray(samplings.samplingId, batch), eq(samplings.ownerUserId, owner))), (row) => row.samplingId);
}

export async function readEvaluationProgress(reader: RecordReader, ids: readonly string[], owner: string) {
  return selectByIds(ids, (batch) => reader.select({ evaluationId: evaluations.evaluationId, samplingId: evaluations.samplingId,
    status: sql<EvaluationRecord["status"]>`${evaluations.facts}->'status'`,
  }).from(evaluations).where(and(inArray(evaluations.evaluationId, batch), eq(evaluations.ownerUserId, owner))), (row) => row.evaluationId);
}
