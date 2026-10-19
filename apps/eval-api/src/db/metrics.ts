import type { EvaluationRecord, Sampling } from "@eval-platform/eval-contracts";
import { MetricsEntityNotFoundError, MetricsSourceError } from "@eval-platform/eval-metrics";
import type { MetricsEvaluation, MetricsFacts, MetricsQuery, MetricsSampling, MetricsSource } from "@eval-platform/eval-metrics";
import { planProjectSampleIds, toRunSnapshot, type ProjectSample } from "@eval-platform/eval-runtime";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { READ_SNAPSHOT, type EvalDb } from "./client.js";
import { readMetricEvaluation, readMetricSampling } from "./attempt-resources.js";
import { requireOwnerUserId } from "./owner.js";
import {
  readAllProjectSamples,
  readEvaluationOutputSchema,
  readProjectPlan,
  readProjectSamples,
} from "./project-plans.js";
import {
  readRunRecords,
  readSamplingProgress,
  readEvaluationProgress,
  evaluationFromRow,
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
          query.samplingId === undefined ? undefined : eq(samplings.samplingId, query.samplingId),
          runIds === undefined ? undefined : inArray(samplings.samplingId, transaction
            .select({ id: runSamplings.samplingId }).from(runSamplings).where(inArray(runSamplings.runId, [...runIds]))),
        );
        const samplingRows = await transaction.select().from(samplings).where(scope).orderBy(samplings.samplingId);
        const evaluationRows = await transaction.select({ evaluation: evaluations }).from(evaluations)
          .innerJoin(samplings, and(eq(samplings.ownerUserId, evaluations.ownerUserId), eq(samplings.samplingId, evaluations.samplingId)))
          .where(and(scope, runIds === undefined ? undefined : inArray(evaluations.evaluationId, transaction
            .select({ id: runEvaluations.evaluationId }).from(runEvaluations).where(inArray(runEvaluations.runId, [...runIds])))))
          .orderBy(evaluations.evaluationId);
        const runRows = runIds === undefined
          ? await transaction.selectDistinct({ runId: runSamplings.runId }).from(runSamplings)
            .innerJoin(samplings, eq(samplings.samplingId, runSamplings.samplingId)).where(scope)
          : runIds.map((runId) => ({ runId }));

        const runRecords = await readRunRecords(transaction, runRows.map((row) => row.runId),
          { kind: "project", ownerUserId: owner, projectId });
        // Snapshots are read one record at a time, as the Metrics projection stored beside each raw snapshot.
        const metricSamplings: MetricsSampling[] = [];
        const metricEvaluations: MetricsEvaluation[] = [];
        for (const row of samplingRows) metricSamplings.push(await readMetricSampling(transaction, owner, samplingFromRow(row)));
        for (const { evaluation } of evaluationRows) metricEvaluations.push(await readMetricEvaluation(transaction, owner, evaluationFromRow(evaluation)));
        const samplingById = byId<Pick<Sampling, "samplingId" | "execution">>(metricSamplings, (record) => record.samplingId);
        const evaluationById = byId<Pick<EvaluationRecord, "evaluationId" | "samplingId" | "status">>(metricEvaluations, (record) => record.evaluationId);
        // Dataset/sample scopes may omit other Run members. Reuse loaded members, read only the remainder.
        for (const record of await readSamplingProgress(transaction,
          [...new Set(runRecords.flatMap((run) => run.samplingIds))].filter((id) => !samplingById.has(id)), owner)) {
          if (record) samplingById.set(record.samplingId, record);
        }
        for (const record of await readEvaluationProgress(transaction,
          [...new Set(runRecords.flatMap((run) => run.evaluationIds))].filter((id) => !evaluationById.has(id)), owner)) {
          if (record) evaluationById.set(record.evaluationId, record);
        }
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
          samplings: metricSamplings,
          evaluations: metricEvaluations,
          runs,
        };
      }, READ_SNAPSHOT);
    },
  };
}
