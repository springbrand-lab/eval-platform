import type { EvaluationRecord, RunSnapshot } from "@eval-platform/eval-contracts";
import { toRunSnapshot } from "@eval-platform/eval-runtime";
import { and, eq, inArray } from "drizzle-orm";
import type { EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { evaluationFromRow, readRunRecords, samplingFromRow } from "./runtime.js";
import { evaluations, runEvaluations, runs, samplings } from "./schema.js";

export interface ProjectRunView {
  readonly run: RunSnapshot;
  readonly evaluations: readonly EvaluationRecord[];
}

/** Reads one owner/Project Run and all status facts with a fixed number of SQL statements. */
export function createPostgresProjectRunReader(db: EvalDb, ownerUserId: string) {
  const owner = requireOwnerUserId(ownerUserId);
  return async (projectId: string, runId: string): Promise<ProjectRunView | null> => db.transaction(async (transaction) => {
    const [record] = await readRunRecords(transaction, [runId], {
      kind: "project", ownerUserId: owner, projectId,
    });
    if (!record) return null;

    const [samplingRows, evaluationRows] = await Promise.all([
      transaction.select().from(samplings).where(and(
        eq(samplings.ownerUserId, owner),
        eq(samplings.projectId, projectId),
        inArray(samplings.samplingId, record.samplingIds),
      )),
      transaction.select({
        evaluationId: evaluations.evaluationId,
        samplingId: evaluations.samplingId,
        facts: evaluations.facts,
      }).from(runEvaluations)
        .innerJoin(runs, eq(runEvaluations.runId, runs.runId))
        .innerJoin(evaluations, eq(runEvaluations.evaluationId, evaluations.evaluationId))
        .where(and(
          eq(runs.ownerUserId, owner),
          eq(runs.projectId, projectId),
          eq(runs.runId, runId),
        ))
        .orderBy(runEvaluations.position),
    ]);
    const samplingById = new Map(samplingRows.map((row) => [row.samplingId, samplingFromRow(row)]));
    const orderedSamplings = record.samplingIds.map((id) => {
      const sampling = samplingById.get(id);
      if (!sampling) throw new Error(`Run ${runId} is missing Sampling ${id}`);
      return sampling;
    });
    const evaluationRecords = evaluationRows.map(evaluationFromRow);
    if (evaluationRecords.length !== record.evaluationIds.length
      || evaluationRecords.some((evaluation, index) => evaluation.evaluationId !== record.evaluationIds[index])) {
      throw new Error(`Run ${runId} Evaluation records do not match its saved scope`);
    }
    return {
      run: toRunSnapshot(record, orderedSamplings, evaluationRecords),
      evaluations: evaluationRecords,
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
