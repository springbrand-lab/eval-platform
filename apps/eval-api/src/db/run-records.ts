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

function pendingMemberships(reader: RecordReader) {
  return [
    reader.select({ samplingId: runSamplings.samplingId }).from(runSamplings)
      .innerJoin(samplings, eq(runSamplings.samplingId, samplings.samplingId))
      .where(and(eq(runSamplings.runId, runs.runId), inArray(samplingStatus, PENDING_SAMPLING_STATUSES))),
    reader.select({ evaluationId: runEvaluations.evaluationId }).from(runEvaluations)
      .innerJoin(evaluations, eq(runEvaluations.evaluationId, evaluations.evaluationId))
      .where(and(eq(runEvaluations.runId, runs.runId), inArray(evaluationStatus, PENDING_SAMPLING_STATUSES))),
  ] as const;
}

/** True for a Run whose Sampling or Evaluation work is pending; correlated with the outer `runs` row. */
function runUnfinished(reader: RecordReader): SQL | undefined {
  const [samplingWork, evaluationWork] = pendingMemberships(reader);
  return or(exists(samplingWork), exists(evaluationWork));
}

export function runFinished(reader: RecordReader): SQL | undefined {
  const [samplingWork, evaluationWork] = pendingMemberships(reader);
  return and(notExists(samplingWork), notExists(evaluationWork));
}

/** An active Run still has pending work or an unfinalized stop request. */
export function runActive(reader: RecordReader): SQL | undefined {
  return or(runUnfinished(reader), and(eq(runs.stopRequested, true), eq(runs.stopFinalized, false)));
}

/** The single definition of "this Project has a Run", shared by creation replay, admission and compensation. */
export async function projectHasRun(reader: RecordReader, projectId: string): Promise<boolean> {
  const [run] = await reader.select({ runId: runs.runId }).from(runs).where(eq(runs.projectId, projectId)).limit(1);
  return run !== undefined;
}

export function samplingFromRow(row: typeof samplings.$inferSelect): Sampling {
  return { ...row.facts, samplingId: row.samplingId, projectId: row.projectId, projectSampleId: row.projectSampleId };
}

export function evaluationFromRow(row: typeof evaluations.$inferSelect): EvaluationRecord {
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
