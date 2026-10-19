import type { AgentResourceSnapshot, AgentResourceState, EvaluationRecord, Sampling } from "@eval-platform/eval-contracts";
import {
  compactResourceSnapshot,
  MetricsSourceError,
  type MetricsEvaluation,
  type MetricsSampling,
  type WithResourceSnapshot,
} from "@eval-platform/eval-metrics";
import { RuntimeEntityNotFoundError, type ResourceSnapshotTarget } from "@eval-platform/eval-runtime";
import { and, eq, sql } from "drizzle-orm";
import type { EvalDb } from "./client.js";
import type { RecordReader } from "./run-records.js";
import { attemptResources, samplings } from "./schema.js";

/**
 * Stores one Attempt's raw snapshot unchanged, replacing an earlier one, with the Metrics projection
 * derived from it. The owner comes from the Sampling; omit `ownerUserId` only for the Worker.
 */
export async function saveAttemptResources(
  db: EvalDb, target: ResourceSnapshotTarget, snapshot: AgentResourceSnapshot, ownerUserId?: string,
): Promise<void> {
  const metricSnapshot = await compactResourceSnapshot(snapshot);
  const [sampling] = await db.select({ ownerUserId: samplings.ownerUserId }).from(samplings).where(and(
    eq(samplings.samplingId, target.samplingId),
    ownerUserId === undefined ? undefined : eq(samplings.ownerUserId, ownerUserId),
  ));
  if (!sampling) throw new RuntimeEntityNotFoundError("sampling", target.samplingId);
  const evaluation = target.evaluationId;
  await db.insert(attemptResources).values({
    stage: evaluation === undefined ? "execution" : "evaluation",
    recordId: evaluation ?? target.samplingId,
    attemptId: target.attemptId,
    ownerUserId: sampling.ownerUserId,
    samplingId: target.samplingId,
    evaluationId: evaluation ?? null,
    snapshot,
    metricSnapshot,
  }).onConflictDoUpdate({
    target: [attemptResources.stage, attemptResources.recordId, attemptResources.attemptId],
    // Refer to the inserted row so the snapshot is serialized only once.
    set: { snapshot: sql`excluded.snapshot`, metricSnapshot: sql`excluded.metric_snapshot` },
  });
}

/** The Metrics projections of one record's Attempts, by Attempt ID. */
async function metricSnapshots(
  reader: RecordReader, ownerUserId: string, stage: "execution" | "evaluation", recordId: string,
): Promise<ReadonlyMap<string, AgentResourceSnapshot>> {
  const rows = await reader.select({ attemptId: attemptResources.attemptId, snapshot: attemptResources.metricSnapshot })
    .from(attemptResources).where(and(eq(attemptResources.ownerUserId, ownerUserId),
      eq(attemptResources.stage, stage), eq(attemptResources.recordId, recordId)));
  return new Map(rows.map((row) => [row.attemptId, row.snapshot]));
}

function withSnapshot<T extends { readonly resources?: AgentResourceState }>(
  attempt: T, attemptId: string, snapshots: ReadonlyMap<string, AgentResourceSnapshot>,
): WithResourceSnapshot<T> {
  // Pending and failed resources carry no snapshot.
  if (attempt.resources?.status !== "collected") return attempt as WithResourceSnapshot<T>;
  const snapshot = snapshots.get(attemptId);
  if (!snapshot) throw new MetricsSourceError(`Attempt ${attemptId} has no stored resource snapshot`);
  return { ...attempt, resources: { ...attempt.resources, snapshot } };
}

/** One Sampling with the Metrics projection of each collected Attempt's snapshot. */
export async function readMetricSampling(reader: RecordReader, ownerUserId: string, sampling: Sampling): Promise<MetricsSampling> {
  const snapshots = await metricSnapshots(reader, ownerUserId, "execution", sampling.samplingId);
  return {
    ...sampling,
    executionAttempts: sampling.executionAttempts.map((attempt) => withSnapshot(attempt, attempt.executionAttemptId, snapshots)),
  };
}

/** One EvaluationRecord with the Metrics projection of each collected Attempt's snapshot. */
export async function readMetricEvaluation(reader: RecordReader, ownerUserId: string, evaluation: EvaluationRecord): Promise<MetricsEvaluation> {
  const snapshots = await metricSnapshots(reader, ownerUserId, "evaluation", evaluation.evaluationId);
  return {
    ...evaluation,
    attempts: evaluation.attempts.map((attempt) => withSnapshot(attempt, attempt.evaluationAttemptId, snapshots)),
  };
}
