import type { EvaluationRecord, Sampling } from "@eval-platform/eval-contracts";
import type { DatasetSnapshot } from "@eval-platform/eval-dataset";
import { MetricsEntityNotFoundError, MetricsQueryError, MetricsSourceError } from "@eval-platform/eval-metrics";
import type { MetricsFacts, MetricsQuery, MetricsSource } from "@eval-platform/eval-metrics";
import { toRunSnapshot, toSamplingSnapshot } from "@eval-platform/eval-runtime";
import { and, eq, inArray } from "drizzle-orm";
import type { EvalDb } from "./client.js";
import { projectFromRow, readSamples } from "./catalog.js";
import { readDatasetSnapshots } from "./dataset.js";
import { requireOwnerUserId } from "./owner.js";
import {
  evaluationFromRow,
  readEvaluations,
  readRunRecords,
  readSamplings,
  requireMembers,
  samplingFromRow,
  type RecordReader,
} from "./run-records.js";
import { datasetData, evaluations, projects, runSamplings, samples, samplings } from "./schema.js";

function byId<T>(records: readonly (T | null)[], idOf: (record: T) => string): Map<string, T> {
  return new Map(records.flatMap((record) => record === null ? [] : [[idOf(record), record] as const]));
}

async function readEligibleSampleIds(
  reader: RecordReader, ownerUserId: string, dataset: DatasetSnapshot | undefined, sampleId: string | undefined,
): Promise<string[] | undefined> {
  if (dataset === undefined) return sampleId === undefined ? undefined : [sampleId];
  const dataIds = dataset.data.map((record) => record.dataId);
  if (dataIds.length === 0) return [];
  const rows = await reader.select({ sampleId: samples.sampleId }).from(samples)
    .where(and(eq(samples.ownerUserId, ownerUserId), inArray(samples.dataId, dataIds),
      sampleId === undefined ? undefined : eq(samples.sampleId, sampleId)));
  return rows.map((row) => row.sampleId);
}

export function createPostgresMetricsSource(db: EvalDb, ownerUserId: string): MetricsSource {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    async read(query: MetricsQuery): Promise<MetricsFacts> {
      return db.transaction(async (transaction) => {
        const [project] = await transaction.select().from(projects)
          .where(and(eq(projects.projectId, query.projectId), eq(projects.ownerUserId, owner)));
        if (!project) throw new MetricsEntityNotFoundError("project", query.projectId);
        const projectScope = { kind: "project" as const, ownerUserId: owner, projectId: project.projectId };

        const selectedRuns = query.runIds === undefined
          ? undefined : await readRunRecords(transaction, query.runIds, projectScope);
        if (query.runIds !== undefined && selectedRuns !== undefined) {
          const found = new Set(selectedRuns.map((run) => run.runId));
          const missing = query.runIds.find((runId) => !found.has(runId));
          if (missing !== undefined) throw new MetricsQueryError(`Unknown Run ${missing} in Project scope`);
        }
        const runSamplingIds = selectedRuns?.flatMap((run) => run.samplingIds);

        const requestedDataset = query.datasetId === undefined
          ? undefined : (await readDatasetSnapshots(transaction, owner, [query.datasetId]))[0];
        if (query.datasetId !== undefined && requestedDataset === undefined) {
          throw new MetricsEntityNotFoundError("dataset", query.datasetId);
        }
        const eligibleSampleIds = await readEligibleSampleIds(transaction, owner, requestedDataset, query.sampleId);

        const selectedSamplings = eligibleSampleIds?.length === 0 || runSamplingIds?.length === 0
          ? [] : await transaction.select().from(samplings).where(and(
            eq(samplings.ownerUserId, owner),
            eq(samplings.projectId, project.projectId),
            query.samplingId === undefined ? undefined : eq(samplings.samplingId, query.samplingId),
            eligibleSampleIds === undefined ? undefined : inArray(samplings.sampleId, eligibleSampleIds),
            runSamplingIds === undefined ? undefined : inArray(samplings.samplingId, runSamplingIds),
          )).orderBy(samplings.samplingId);
        const selectedSamplingIds = selectedSamplings.map((row) => row.samplingId);
        const sampleIds = [...new Set([
          ...selectedSamplings.map((row) => row.sampleId),
          ...(query.sampleId === undefined ? [] : [query.sampleId]),
        ])].sort();
        const samplesInScope = (await readSamples(transaction, sampleIds, owner))
          .filter((sample) => sample !== null);

        let datasetsInScope: readonly DatasetSnapshot[];
        if (requestedDataset) {
          datasetsInScope = [requestedDataset];
        } else {
          const dataIds = samplesInScope.map((sample) => sample.data.dataId);
          const memberships = dataIds.length === 0 ? [] : await transaction
            .selectDistinct({ datasetId: datasetData.datasetId }).from(datasetData)
            .where(and(eq(datasetData.ownerUserId, owner), inArray(datasetData.dataId, dataIds)));
          datasetsInScope = await readDatasetSnapshots(transaction, owner, memberships.map((row) => row.datasetId));
        }

        let runRecords = selectedRuns;
        if (runRecords === undefined) {
          const memberships = selectedSamplingIds.length === 0 ? [] : await transaction
            .selectDistinct({ runId: runSamplings.runId }).from(runSamplings)
            .where(and(eq(runSamplings.ownerUserId, owner), inArray(runSamplings.samplingId, selectedSamplingIds)));
          runRecords = await readRunRecords(transaction, memberships.map((row) => row.runId), projectScope);
        }

        const allowedEvaluationIds = selectedRuns?.flatMap((run) => run.evaluationIds);
        const selectedEvaluations = selectedSamplingIds.length === 0 || allowedEvaluationIds?.length === 0
          ? [] : await transaction.select().from(evaluations).where(and(
            eq(evaluations.ownerUserId, owner),
            inArray(evaluations.samplingId, selectedSamplingIds),
            allowedEvaluationIds === undefined ? undefined : inArray(evaluations.evaluationId, allowedEvaluationIds),
          )).orderBy(evaluations.evaluationId);

        const [memberSamplings, memberEvaluations] = await Promise.all([
          readSamplings(transaction, runRecords.flatMap((run) => run.samplingIds), owner),
          readEvaluations(transaction, runRecords.flatMap((run) => run.evaluationIds), owner),
        ]);
        const samplingById = byId<Sampling>(memberSamplings, (record) => record.samplingId);
        const evaluationById = byId<EvaluationRecord>(memberEvaluations, (record) => record.evaluationId);
        const runSnapshots = runRecords.map((run) => {
          const missing = (kind: string) => (id: string) => new MetricsSourceError(`Run ${run.runId} is missing ${kind} ${id}`);
          return toRunSnapshot(
            run,
            requireMembers(run.samplingIds.map((id) => samplingById.get(id) ?? null), run.samplingIds, missing("Sampling")),
            requireMembers(run.evaluationIds.map((id) => evaluationById.get(id) ?? null), run.evaluationIds, missing("Evaluation")),
          );
        });

        return {
          project: projectFromRow(project),
          datasets: datasetsInScope,
          samples: samplesInScope,
          samplings: selectedSamplings.map((row) => toSamplingSnapshot(samplingFromRow(row))),
          evaluations: selectedEvaluations.map(evaluationFromRow),
          runs: runSnapshots,
        };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}
