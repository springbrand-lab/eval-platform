import type { EvaluationRecord, RunOperation, RunSnapshot, Sampling } from "@eval-platform/eval-contracts";
import { toRunSnapshot } from "@eval-platform/eval-runtime";
import { and, count, desc, eq, inArray, lt } from "drizzle-orm";
import { READ_SNAPSHOT, type EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { projectExists } from "./project-plans.js";
import { readEvaluations, readRunRecords, readSamplingProgress, requireMembers, type RecordReader } from "./run-records.js";
import { runEvaluations, runSamplings, runs } from "./schema.js";

const RUN_HISTORY_PAGE_SIZE = 20;

export interface ProjectRunHistoryPage {
  readonly runs: readonly {
    readonly runId: string;
    readonly sequence: number;
    readonly operation: RunOperation;
    readonly retainedSamplingCount: number;
    readonly retainedEvaluationCount: number;
  }[];
  readonly nextBeforeSequence: number | null;
}

export interface ProjectRunView {
  readonly run: RunSnapshot;
  readonly samplings: readonly Pick<Sampling, "samplingId" | "execution">[];
  readonly evaluations: readonly EvaluationRecord[];
}

export type RunViewScope =
  | { readonly kind: "owner"; readonly ownerUserId: string }
  | { readonly kind: "project"; readonly ownerUserId: string; readonly projectId: string };

/**
 * Reads one owned Run of a non-deleted Project and its current member records in bounded SQL
 * batches; call inside one read-only snapshot.
 */
export async function readRunView(reader: RecordReader, runId: string, scope: RunViewScope): Promise<ProjectRunView | null> {
  const [record] = await readRunRecords(reader, [runId], scope);
  if (!record || !await projectExists(reader, record.projectId, scope.ownerUserId)) return null;
  const samplingRows = await readSamplingProgress(reader, record.samplingIds, scope.ownerUserId);
  const evaluationRows = await readEvaluations(reader, record.evaluationIds, scope.ownerUserId);
  const missing = (kind: string) => (id: string) => new Error(`Run ${runId} is missing ${kind} ${id}`);
  const members = requireMembers(samplingRows, record.samplingIds, missing("Sampling"));
  const evaluationRecords = requireMembers(evaluationRows, record.evaluationIds, missing("Evaluation"));
  return { run: toRunSnapshot(record, members, evaluationRecords), samplings: members, evaluations: evaluationRecords };
}

export function createPostgresProjectRunReader(db: EvalDb, ownerUserId: string) {
  const owner = requireOwnerUserId(ownerUserId);
  return (projectId: string, runId: string): Promise<ProjectRunView | null> => db.transaction(
    (transaction) => readRunView(transaction, runId, { kind: "project", ownerUserId: owner, projectId }),
    READ_SNAPSHOT,
  );
}

/** Run rows survive replacement; Metrics' current-member runIds cannot serve as a history index. */
export function createPostgresProjectRunHistoryReader(db: EvalDb, ownerUserId: string) {
  const owner = requireOwnerUserId(ownerUserId);
  return (projectId: string, beforeSequence?: number): Promise<ProjectRunHistoryPage | null> => db.transaction(async (transaction) => {
    if (!await projectExists(transaction, projectId, owner)) return null;
    const rows = await transaction.select({
      runId: runs.runId, sequence: runs.sequence, operation: runs.operation,
    }).from(runs).where(and(
      eq(runs.ownerUserId, owner), eq(runs.projectId, projectId),
      beforeSequence === undefined ? undefined : lt(runs.sequence, beforeSequence),
    )).orderBy(desc(runs.sequence)).limit(RUN_HISTORY_PAGE_SIZE + 1);
    const page = rows.slice(0, RUN_HISTORY_PAGE_SIZE);
    if (page.length === 0) return { runs: [], nextBeforeSequence: null };
    const ids = page.map((row) => row.runId);
    const samplingCounts = await transaction.select({ runId: runSamplings.runId, total: count() })
      .from(runSamplings).where(and(eq(runSamplings.ownerUserId, owner), inArray(runSamplings.runId, ids)))
      .groupBy(runSamplings.runId);
    const evaluationCounts = await transaction.select({ runId: runEvaluations.runId, total: count() })
      .from(runEvaluations).where(and(eq(runEvaluations.ownerUserId, owner), inArray(runEvaluations.runId, ids)))
      .groupBy(runEvaluations.runId);
    const byRun = (counts: readonly { runId: string; total: number }[]) => new Map(counts.map(({ runId, total }) => [runId, total]));
    const samplingsByRun = byRun(samplingCounts);
    const evaluationsByRun = byRun(evaluationCounts);
    return {
      runs: page.map((row) => ({
        ...row, retainedSamplingCount: samplingsByRun.get(row.runId) ?? 0,
        retainedEvaluationCount: evaluationsByRun.get(row.runId) ?? 0,
      })),
      nextBeforeSequence: rows.length > RUN_HISTORY_PAGE_SIZE ? page.at(-1)!.sequence : null,
    };
  }, READ_SNAPSHOT);
}
