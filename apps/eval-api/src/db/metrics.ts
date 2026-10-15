import type { EvaluationRecord, Sampling } from "@eval-platform/eval-contracts";
import { MetricsEntityNotFoundError, MetricsSourceError } from "@eval-platform/eval-metrics";
import type { MetricsFacts, MetricsQuery, MetricsSource } from "@eval-platform/eval-metrics";
import { planProjectSampleIds, toRunSnapshot, toSamplingSnapshot, type ProjectSample } from "@eval-platform/eval-runtime";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import {
  READ_SNAPSHOT,
  readAllProjectSamples,
  readEvaluationOutputSchema,
  readProjectPlan,
  readProjectSamples,
} from "./project-plans.js";
import {
  evaluationFromRow,
  readEvaluations,
  readRunRecords,
  readSamplings,
  requireMembers,
  samplingFromRow,
} from "./run-records.js";
import { evaluations, projectSampleDatasets, runEvaluations, runSamplings, samplings } from "./schema.js";

function byId<T>(records: readonly (T | null)[], idOf: (record: T) => string): Map<string, T> {
  return new Map(records.flatMap((record) => record === null ? [] : [[idOf(record), record] as const]));
}

/**
 * Reads one Project's MetricsFacts in a single repeatable-read snapshot. The hierarchy comes only
 * from the Project's fixed plan tables; live Dataset membership is never consulted. Unknown
 * Datasets, ProjectSamples and Samplings yield an empty scope that Metrics reports as missing.
 */
export function createPostgresMetricsSource(db: EvalDb, ownerUserId: string): MetricsSource {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    read(query: MetricsQuery): Promise<MetricsFacts> {
      return db.transaction(async (transaction) => {
        const { projectId } = query;
        const plan = await readProjectPlan(transaction, projectId, owner);
        if (!plan) throw new MetricsEntityNotFoundError("project", projectId);
        const evaluationOutputSchema = plan.evaluation === null
          ? null : await readEvaluationOutputSchema(transaction, projectId, owner);

        let projectSamples: ProjectSample[];
        let sampleScope: SQL | undefined;
        if (query.datasetId !== undefined) {
          const dataset = plan.datasets.find((item) => item.datasetId === query.datasetId);
          projectSamples = dataset === undefined ? []
            : (await readProjectSamples(transaction, projectId, dataset.projectSampleIds)).filter((sample) => sample !== null);
          sampleScope = inArray(samplings.projectSampleId, transaction.select({ id: projectSampleDatasets.projectSampleId })
            .from(projectSampleDatasets)
            .where(and(eq(projectSampleDatasets.projectId, projectId), eq(projectSampleDatasets.datasetId, query.datasetId))));
        } else if (query.projectSampleId !== undefined || query.samplingId !== undefined) {
          let projectSampleId = query.projectSampleId;
          if (projectSampleId === undefined) {
            const [row] = await transaction.select({ projectSampleId: samplings.projectSampleId }).from(samplings)
              .where(and(eq(samplings.ownerUserId, owner), eq(samplings.projectId, projectId), eq(samplings.samplingId, query.samplingId!)));
            projectSampleId = row?.projectSampleId;
          }
          const bound = projectSampleId !== undefined && planProjectSampleIds(plan).includes(projectSampleId);
          projectSamples = bound
            ? (await readProjectSamples(transaction, projectId, [projectSampleId!])).filter((sample) => sample !== null) : [];
          sampleScope = bound ? eq(samplings.projectSampleId, projectSampleId!) : sql`false`;
        } else {
          projectSamples = await readAllProjectSamples(transaction, plan);
        }

        const runIds = query.runIds;
        const scope = and(
          eq(samplings.ownerUserId, owner),
          eq(samplings.projectId, projectId),
          sampleScope,
          runIds === undefined ? undefined : inArray(samplings.samplingId, transaction
            .select({ id: runSamplings.samplingId }).from(runSamplings).where(inArray(runSamplings.runId, [...runIds]))),
        );
        const [samplingRows, evaluationRows, runRows] = await Promise.all([
          transaction.select().from(samplings).where(scope).orderBy(samplings.samplingId),
          transaction.select({ evaluation: evaluations }).from(evaluations)
            .innerJoin(samplings, and(eq(samplings.ownerUserId, evaluations.ownerUserId), eq(samplings.samplingId, evaluations.samplingId)))
            .where(and(scope, runIds === undefined ? undefined : inArray(evaluations.evaluationId, transaction
              .select({ id: runEvaluations.evaluationId }).from(runEvaluations).where(inArray(runEvaluations.runId, [...runIds])))))
            .orderBy(evaluations.evaluationId),
          runIds === undefined
            ? transaction.selectDistinct({ runId: runSamplings.runId }).from(runSamplings)
              .innerJoin(samplings, eq(samplings.samplingId, runSamplings.samplingId)).where(scope)
            : Promise.resolve(runIds.map((runId) => ({ runId }))),
        ]);

        const runRecords = await readRunRecords(transaction, runRows.map((row) => row.runId),
          { kind: "project", ownerUserId: owner, projectId });
        const [memberSamplings, memberEvaluations] = await Promise.all([
          readSamplings(transaction, runRecords.flatMap((run) => run.samplingIds), owner),
          readEvaluations(transaction, runRecords.flatMap((run) => run.evaluationIds), owner),
        ]);
        const samplingById = byId<Sampling>(memberSamplings, (record) => record.samplingId);
        const evaluationById = byId<EvaluationRecord>(memberEvaluations, (record) => record.evaluationId);
        const runs = runRecords.map((run) => {
          const missing = (kind: string) => (id: string) => new MetricsSourceError(`Run ${run.runId} is missing ${kind} ${id}`);
          return toRunSnapshot(
            run,
            requireMembers(run.samplingIds.map((id) => samplingById.get(id) ?? null), run.samplingIds, missing("Sampling")),
            requireMembers(run.evaluationIds.map((id) => evaluationById.get(id) ?? null), run.evaluationIds, missing("Evaluation")),
          );
        });

        return {
          plan,
          evaluationOutputSchema,
          projectSamples,
          samplings: samplingRows.map((row) => toSamplingSnapshot(samplingFromRow(row))),
          evaluations: evaluationRows.map((row) => evaluationFromRow(row.evaluation)),
          runs,
        };
      }, READ_SNAPSHOT);
    },
  };
}
