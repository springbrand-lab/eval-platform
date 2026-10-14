import { MetricsQueryError, MetricsSourceError } from "@eval-platform/eval-metrics";
import type { MetricsFacts, MetricsQuery, MetricsSource } from "@eval-platform/eval-metrics";
import { toRunSnapshot, toSamplingSnapshot } from "@eval-platform/eval-runtime";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { EvalDb } from "./client.js";
import { readSamples } from "./catalog.js";
import { readDatasetSnapshots } from "./dataset.js";
import { requireOwnerUserId } from "./owner.js";
import { evaluationFromRow, readRunRecords, samplingFromRow } from "./runtime.js";
import { datasetData, evaluations, projects, runs, runSamplings, samples, samplings } from "./schema.js";

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export function createPostgresMetricsSource(db: EvalDb, ownerUserId: string): MetricsSource {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    async read(query: MetricsQuery): Promise<MetricsFacts> {
      return db.transaction(async (transaction) => {
        const [project] = await transaction.select().from(projects)
          .where(and(eq(projects.projectId, query.projectId), eq(projects.ownerUserId, owner)));
        if (!project) throw new MetricsQueryError(`Unknown Project ${query.projectId}`);
        const projectScope = { kind: "project" as const, ownerUserId: project.ownerUserId, projectId: project.projectId };

        const requestedRunIds = query.runIds;
        const selectedRuns = requestedRunIds === undefined
          ? undefined : await readRunRecords(transaction, requestedRunIds, projectScope);
        if (selectedRuns && selectedRuns.length !== requestedRunIds?.length) {
          throw new MetricsQueryError("Unknown Run in Project scope");
        }
        const runSamplingIds = selectedRuns === undefined
          ? undefined : unique(selectedRuns.flatMap((run) => run.samplingIds));

        const requestedDataset = query.datasetId === undefined
          ? undefined : (await readDatasetSnapshots(transaction, project.ownerUserId, [query.datasetId]))[0];
        let eligibleSampleIds: string[] | undefined;
        if (query.datasetId !== undefined) {
          if (!requestedDataset) throw new MetricsQueryError(`Unknown Dataset ${query.datasetId}`);
          const dataIds = requestedDataset.data.map((record) => record.dataId);
          const associatedSamples = dataIds.length === 0 ? [] : await transaction
            .select({ sampleId: samples.sampleId }).from(samples)
            .where(and(eq(samples.ownerUserId, project.ownerUserId), inArray(samples.dataId, dataIds)));
          eligibleSampleIds = associatedSamples.map((row) => row.sampleId);
        } else if (query.sampleId !== undefined) {
          eligibleSampleIds = [query.sampleId];
        }

        const conditions: SQL[] = [eq(samplings.ownerUserId, project.ownerUserId), eq(samplings.projectId, project.projectId)];
        if (query.samplingId !== undefined) conditions.push(eq(samplings.samplingId, query.samplingId));
        if (eligibleSampleIds !== undefined && eligibleSampleIds.length > 0) {
          conditions.push(inArray(samplings.sampleId, eligibleSampleIds));
        }
        if (runSamplingIds !== undefined && runSamplingIds.length > 0) {
          conditions.push(inArray(samplings.samplingId, runSamplingIds));
        }
        const selectedSamplings = (eligibleSampleIds?.length === 0 || runSamplingIds?.length === 0)
          ? [] : await transaction.select().from(samplings)
            .where(and(...conditions)).orderBy(samplings.samplingId);
        const selectedSamplingIds = selectedSamplings.map((row) => row.samplingId);
        const samplesInScope = await readSamples(transaction, project.ownerUserId, unique([
          ...selectedSamplings.map((row) => row.sampleId),
          ...(query.sampleId === undefined ? [] : [query.sampleId]),
        ]));

        let datasetsInScope;
        if (requestedDataset) {
          datasetsInScope = [requestedDataset];
        } else {
          const dataIds = unique(samplesInScope.map((sample) => sample.data.dataId));
          const memberships = dataIds.length === 0 ? [] : await transaction
            .selectDistinct({ datasetId: datasetData.datasetId }).from(datasetData)
            .where(and(eq(datasetData.ownerUserId, project.ownerUserId), inArray(datasetData.dataId, dataIds)));
          datasetsInScope = await readDatasetSnapshots(transaction, project.ownerUserId, memberships.map((row) => row.datasetId));
        }

        let runRecords = selectedRuns;
        if (runRecords === undefined) {
          const memberships = selectedSamplingIds.length === 0 ? [] : await transaction
            .selectDistinct({ runId: runSamplings.runId }).from(runSamplings)
            .innerJoin(runs, eq(runSamplings.runId, runs.runId))
            .where(and(eq(runs.ownerUserId, project.ownerUserId), eq(runs.projectId, project.projectId),
              inArray(runSamplings.samplingId, selectedSamplingIds)));
          runRecords = await readRunRecords(transaction, memberships.map((row) => row.runId), projectScope);
        }

        const allowedEvaluationIds = selectedRuns === undefined
          ? undefined : unique(selectedRuns.flatMap((run) => run.evaluationIds));
        const selectedEvaluations = selectedSamplingIds.length === 0 || allowedEvaluationIds?.length === 0
          ? [] : await transaction.select({
            evaluationId: evaluations.evaluationId, samplingId: evaluations.samplingId, facts: evaluations.facts,
          }).from(evaluations).innerJoin(samplings, eq(evaluations.samplingId, samplings.samplingId)).where(and(
            eq(samplings.ownerUserId, project.ownerUserId), eq(samplings.projectId, project.projectId),
            inArray(evaluations.samplingId, selectedSamplingIds),
            ...(allowedEvaluationIds === undefined ? [] : [inArray(evaluations.evaluationId, allowedEvaluationIds)]),
          )).orderBy(evaluations.evaluationId);

        const fullSamplingIds = unique(runRecords.flatMap((run) => run.samplingIds));
        const fullEvaluationIds = unique(runRecords.flatMap((run) => run.evaluationIds));
        const [fullSamplingRows, fullEvaluationRows] = await Promise.all([
          fullSamplingIds.length === 0 ? [] : transaction.select().from(samplings)
            .where(and(eq(samplings.ownerUserId, project.ownerUserId), eq(samplings.projectId, project.projectId),
              inArray(samplings.samplingId, fullSamplingIds))),
          fullEvaluationIds.length === 0 ? [] : transaction.select({
            evaluationId: evaluations.evaluationId, samplingId: evaluations.samplingId, facts: evaluations.facts,
          }).from(evaluations).innerJoin(samplings, eq(evaluations.samplingId, samplings.samplingId))
            .where(and(eq(samplings.ownerUserId, project.ownerUserId), eq(samplings.projectId, project.projectId),
              inArray(evaluations.evaluationId, fullEvaluationIds))),
        ]);
        const samplingById = new Map(fullSamplingRows.map((row) => [row.samplingId, samplingFromRow(row)]));
        const evaluationById = new Map(fullEvaluationRows.map((row) => [row.evaluationId, evaluationFromRow(row)]));
        const runSnapshots = runRecords.map((run) => {
          const members = run.samplingIds.map((id) => {
            const member = samplingById.get(id);
            if (!member) throw new MetricsSourceError(`Run ${run.runId} is missing Sampling ${id}`);
            return member;
          });
          const judges = run.evaluationIds.map((id) => {
            const judge = evaluationById.get(id);
            if (!judge) throw new MetricsSourceError(`Run ${run.runId} is missing Evaluation ${id}`);
            return judge;
          });
          return toRunSnapshot(run, members, judges);
        });

        return {
          project,
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
