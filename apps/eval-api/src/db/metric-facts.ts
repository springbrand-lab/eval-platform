import type { AgentResourceCollection, EvaluationRecord, Sampling } from "@eval-platform/eval-contracts";
import { compactResourceCollection } from "@eval-platform/eval-metrics";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { EvalDb } from "./client.js";
import { evaluations, samplings } from "./schema.js";
import { selectByIds } from "./batch.js";
import type { RecordReader } from "./run-records.js";

type SamplingFacts = typeof samplings.$inferSelect.facts;
type EvaluationFacts = typeof evaluations.$inferSelect.facts;

async function compactAttempts<T extends { readonly resources?: AgentResourceCollection }>(attempts: readonly T[]): Promise<T[]> {
  const result: T[] = [];
  for (const attempt of attempts) result.push(attempt.resources
    ? { ...attempt, resources: await compactResourceCollection(attempt.resources) } : attempt);
  return result;
}

export async function samplingMetricFacts(facts: SamplingFacts): Promise<SamplingFacts> {
  return { ...facts, executionAttempts: await compactAttempts(facts.executionAttempts) };
}

export async function evaluationMetricFacts(facts: EvaluationFacts): Promise<EvaluationFacts> {
  return { ...facts, attempts: await compactAttempts(facts.attempts) };
}

/** Old writers invalidate projections during rolling upgrades. Never load all missing raw rows together. */
export async function readMetricSampling(reader: RecordReader, row: Pick<typeof samplings.$inferSelect,
  "samplingId" | "projectId" | "projectSampleId" | "ownerUserId" | "metricFacts">): Promise<Sampling> {
  let facts = row.metricFacts;
  if (facts === null) {
    const [raw] = await reader.select({ facts: samplings.facts }).from(samplings)
      .where(and(eq(samplings.samplingId, row.samplingId), eq(samplings.ownerUserId, row.ownerUserId)));
    if (!raw) throw new Error(`Missing Sampling ${row.samplingId}`);
    facts = await samplingMetricFacts(raw.facts);
  }
  return { ...facts, samplingId: row.samplingId, projectId: row.projectId, projectSampleId: row.projectSampleId };
}

export async function readMetricEvaluation(reader: RecordReader, row: Pick<typeof evaluations.$inferSelect,
  "evaluationId" | "samplingId" | "ownerUserId" | "metricFacts">): Promise<EvaluationRecord> {
  let facts = row.metricFacts;
  if (facts === null) {
    const [raw] = await reader.select({ facts: evaluations.facts }).from(evaluations)
      .where(and(eq(evaluations.evaluationId, row.evaluationId), eq(evaluations.ownerUserId, row.ownerUserId)));
    if (!raw) throw new Error(`Missing Evaluation ${row.evaluationId}`);
    facts = await evaluationMetricFacts(raw.facts);
  }
  return { ...facts, evaluationId: row.evaluationId, samplingId: row.samplingId };
}

/** Resumable additive backfill: one locked record per transaction, raw facts are never changed. */
export async function backfillMetricFacts(db: EvalDb): Promise<void> {
  for (const kind of ["sampling", "evaluation"] as const) {
    let after: string | undefined;
    for (;;) {
      const next = await db.transaction(async (tx) => {
        if (kind === "sampling") {
          const [row] = await tx.select({ id: samplings.samplingId, facts: samplings.facts }).from(samplings)
            .where(and(isNull(samplings.metricFacts), after === undefined ? undefined : gt(samplings.samplingId, after)))
            .orderBy(samplings.samplingId).limit(1).for("update");
          if (!row) return undefined;
          await tx.update(samplings).set({ metricFacts: await samplingMetricFacts(row.facts) }).where(eq(samplings.samplingId, row.id));
          return row.id;
        }
        const [row] = await tx.select({ id: evaluations.evaluationId, facts: evaluations.facts }).from(evaluations)
          .where(and(isNull(evaluations.metricFacts), after === undefined ? undefined : gt(evaluations.evaluationId, after)))
          .orderBy(evaluations.evaluationId).limit(1).for("update");
        if (!row) return undefined;
        await tx.update(evaluations).set({ metricFacts: await evaluationMetricFacts(row.facts) }).where(eq(evaluations.evaluationId, row.id));
        return row.id;
      });
      if (next === undefined) break;
      after = next;
    }
  }
}

export const metricSamplingColumns = {
  samplingId: samplings.samplingId, projectId: samplings.projectId, projectSampleId: samplings.projectSampleId,
  ownerUserId: samplings.ownerUserId, metricFacts: samplings.metricFacts,
};
export const metricEvaluationColumns = {
  evaluationId: evaluations.evaluationId, samplingId: evaluations.samplingId,
  ownerUserId: evaluations.ownerUserId, metricFacts: evaluations.metricFacts,
};

export async function readMetricEvaluations(reader: RecordReader, ids: readonly string[], owner: string): Promise<(EvaluationRecord | null)[]> {
  const rows = await selectByIds(ids, (batch) => reader.select(metricEvaluationColumns).from(evaluations)
    .where(and(inArray(evaluations.evaluationId, batch), eq(evaluations.ownerUserId, owner))), (row) => row.evaluationId);
  const result: (EvaluationRecord | null)[] = [];
  for (const row of rows) result.push(row ? await readMetricEvaluation(reader, row) : null);
  return result;
}
