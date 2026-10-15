import { IDENTIFIER_RULE, isIdentifier, type EvaluationRecord } from "@eval-platform/eval-contracts";
import type { DatasetSnapshot } from "@eval-platform/eval-dataset";
import type { SamplingSnapshot } from "@eval-platform/eval-runtime";
import { aggregateMetrics } from "../aggregation/index.js";
import { aggregateResources } from "../aggregation/resources.js";
import { readEvaluationMetrics } from "../evaluators/index.js";
import type { DatasetMetricRow, Metrics, MetricsFacts, MetricsQuery, MetricsSource, OverviewCounts } from "./model.js";

export class MetricsQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricsQueryError";
  }
}

/** A Metrics query named a Project, Run, Dataset, Sample or Sampling outside the caller's scope. */
export class MetricsEntityNotFoundError extends Error {
  constructor(readonly entity: "project" | "run" | "dataset" | "sample" | "sampling", readonly id: string) {
    super(`Unknown ${entity} ${id}`);
    this.name = "MetricsEntityNotFoundError";
  }
}

export class MetricsSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricsSourceError";
  }
}

function identifier(value: unknown, name: string): string {
  if (!isIdentifier(value)) throw new MetricsQueryError(`${name} ${IDENTIFIER_RULE}`);
  return value;
}

function validateQuery(input: MetricsQuery, target?: "datasetId" | "sampleId" | "samplingId"): MetricsQuery {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MetricsQueryError("Metric query must be an object");
  const projectId = identifier(input.projectId, "projectId");
  let runIds: readonly string[] | undefined;
  if (input.runIds !== undefined) {
    if (!Array.isArray(input.runIds) || input.runIds.length === 0) throw new MetricsQueryError("runIds must be a non-empty array");
    runIds = input.runIds.map((runId) => identifier(runId, "runId"));
    if (new Set(runIds).size !== runIds.length) throw new MetricsQueryError("runIds must not contain duplicates");
  }
  return {
    projectId,
    ...(runIds === undefined ? {} : { runIds: [...runIds] }),
    ...(target === undefined ? {} : { [target]: identifier(input[target], target) }),
  };
}

function indexBy<Value>(values: readonly Value[], key: (value: Value) => string, label: string): Map<string, Value> {
  const indexed = new Map<string, Value>();
  for (const value of values) {
    const id = key(value);
    if (indexed.has(id)) throw new MetricsSourceError(`Duplicate ${label} identity: ${id}`);
    indexed.set(id, value);
  }
  return indexed;
}

function groupBy<Value>(values: readonly Value[], key: (value: Value) => string): Map<string, readonly Value[]> {
  const groups = new Map<string, Value[]>();
  for (const value of values) {
    const id = key(value);
    const group = groups.get(id) ?? [];
    group.push(value);
    groups.set(id, group);
  }
  return groups;
}

function prepareFacts(facts: MetricsFacts, query: MetricsQuery) {
  if (facts.project.projectId !== query.projectId) throw new MetricsSourceError("Source returned the wrong Project");
  if (facts.samplings.some((sampling) => sampling.projectId !== query.projectId)
    || facts.runs.some((run) => run.projectId !== query.projectId)) {
    throw new MetricsSourceError("Source returned Runtime facts outside the Project scope");
  }
  const sampleById = indexBy(facts.samples, (sample) => sample.sampleId, "Sample");
  const datasetById = indexBy(facts.datasets, (snapshot) => snapshot.dataset.datasetId, "Dataset");
  const samplingById = indexBy(facts.samplings, (sampling) => sampling.samplingId, "Sampling");
  const evaluationById = indexBy(facts.evaluations, (evaluation) => evaluation.evaluationId, "Evaluation");
  const runById = indexBy(facts.runs, (run) => run.runId, "Run");
  for (const sampling of facts.samplings) {
    if (!sampleById.has(sampling.sampleId)) throw new MetricsSourceError(`Missing Sample for Sampling ${sampling.samplingId}`);
  }
  for (const evaluation of facts.evaluations) {
    if (!samplingById.has(evaluation.samplingId)) throw new MetricsSourceError(`Missing Sampling for Evaluation ${evaluation.evaluationId}`);
  }
  for (const snapshot of facts.datasets) {
    if (new Set(snapshot.data.map((data) => data.dataId)).size !== snapshot.data.length) {
      throw new MetricsSourceError(`Duplicate Data in Dataset ${snapshot.dataset.datasetId}`);
    }
  }
  const selectedRuns = query.runIds?.map((runId) => {
    const run = runById.get(runId);
    if (!run) throw new MetricsEntityNotFoundError("run", runId);
    return run;
  });
  const samplingIds = selectedRuns === undefined ? undefined : new Set(selectedRuns.flatMap((run) => run.samplingIds));
  const evaluationIds = selectedRuns === undefined ? undefined : new Set(selectedRuns.flatMap((run) => run.evaluationIds));
  if (selectedRuns) {
    for (const run of selectedRuns) {
      if (new Set(run.samplingIds).size !== run.samplingIds.length || new Set(run.evaluationIds).size !== run.evaluationIds.length) {
        throw new MetricsSourceError(`Run ${run.runId} has duplicate scope identities`);
      }
      for (const evaluationId of run.evaluationIds) {
        const evaluation = evaluationById.get(evaluationId);
        if (evaluation && !run.samplingIds.includes(evaluation.samplingId)) {
          throw new MetricsSourceError(`Evaluation ${evaluationId} is outside Run ${run.runId}`);
        }
      }
      if (query.datasetId === undefined && query.sampleId === undefined && query.samplingId === undefined) {
        if (run.samplingIds.some((id) => !samplingById.has(id)) || run.evaluationIds.some((id) => !evaluationById.has(id))) {
          throw new MetricsSourceError(`Source omitted required facts for Run ${run.runId}`);
        }
      }
    }
  }
  const samplings = facts.samplings.filter((sampling) => samplingIds === undefined || samplingIds.has(sampling.samplingId));
  const inScopeSamplingIds = new Set(samplings.map((sampling) => sampling.samplingId));
  const evaluations = facts.evaluations.filter((evaluation) => inScopeSamplingIds.has(evaluation.samplingId)
    && (evaluationIds === undefined || evaluationIds.has(evaluation.evaluationId)));
  const bySample = groupBy(samplings, (sampling) => sampling.sampleId);
  const bySampling = groupBy(evaluations, (evaluation) => evaluation.samplingId);
  const evaluationsFor = (records: readonly SamplingSnapshot[]): readonly EvaluationRecord[] => records.flatMap((sampling) => bySampling.get(sampling.samplingId) ?? []);
  const summaryFor = (records: readonly SamplingSnapshot[]) => aggregateMetrics({ samplings: records, evaluations: evaluationsFor(records) });
  const datasetIdsFor = (dataId: string): readonly string[] => facts.datasets.filter((snapshot) => snapshot.data.some((data) => data.dataId === dataId))
    .map((snapshot) => snapshot.dataset.datasetId).sort();
  const runsFor = (records: readonly SamplingSnapshot[]): readonly string[] => {
    if (selectedRuns) return selectedRuns.map((run) => run.runId).sort();
    const ids = new Set(records.map((sampling) => sampling.samplingId));
    return facts.runs.filter((run) => run.samplingIds.some((id) => ids.has(id))).map((run) => run.runId).sort();
  };
  const countsFor = (records: readonly SamplingSnapshot[], dataIds: readonly string[], datasets: number): OverviewCounts => ({
    datasets, data: new Set(dataIds).size, samples: new Set(records.map((sampling) => sampling.sampleId)).size,
    samplings: records.length, evaluations: evaluationsFor(records).length,
  });
  const recordsForDataset = (snapshot: DatasetSnapshot): readonly SamplingSnapshot[] => {
    const dataIds = new Set(snapshot.data.map((data) => data.dataId));
    return samplings.filter((sampling) => dataIds.has(sampleById.get(sampling.sampleId)!.data.dataId));
  };
  const datasetRow = (snapshot: DatasetSnapshot): DatasetMetricRow => {
    const records = recordsForDataset(snapshot);
    return { dataset: snapshot.dataset, counts: countsFor(records, snapshot.data.map((data) => data.dataId), 1), summary: summaryFor(records) };
  };
  return { facts, sampleById, datasetById, samplingById, samplings, evaluations, bySample, bySampling, summaryFor,
    countsFor, datasetIdsFor, runsFor, recordsForDataset, datasetRow };
}

export function createMetrics(dependencies: { readonly source: MetricsSource }): Metrics {
  const load = async (query: MetricsQuery) => prepareFacts(structuredClone(await dependencies.source.read(structuredClone(query))), query);
  return {
    async getProjectOverview(input) {
      const query = validateQuery(input);
      const view = await load(query);
      const dataIds = [...new Set(view.samplings.map((sampling) => view.sampleById.get(sampling.sampleId)!.data.dataId))];
      const datasets = view.facts.datasets.filter((snapshot) => snapshot.data.some((data) => dataIds.includes(data.dataId)))
        .toSorted((left, right) => left.dataset.datasetId.localeCompare(right.dataset.datasetId));
      return {
        project: view.facts.project, runIds: view.runsFor(view.samplings),
        counts: view.countsFor(view.samplings, dataIds, datasets.length), summary: view.summaryFor(view.samplings),
        datasets: datasets.map(view.datasetRow),
      };
    },
    async getDatasetOverview(input) {
      const query = validateQuery(input, "datasetId");
      const view = await load(query);
      const snapshot = view.datasetById.get(query.datasetId!);
      if (!snapshot) throw new MetricsEntityNotFoundError("dataset", query.datasetId!);
      const samplings = view.recordsForDataset(snapshot);
      const sampleIds = [...new Set(samplings.map((sampling) => sampling.sampleId))].sort();
      return {
        project: view.facts.project, runIds: view.runsFor(samplings), ...view.datasetRow(snapshot),
        dataIds: snapshot.data.map((data) => data.dataId).sort(),
        samples: sampleIds.map((sampleId) => ({
          sampleId,
          dataId: view.sampleById.get(sampleId)!.data.dataId,
          summary: view.summaryFor(view.bySample.get(sampleId) ?? []),
        })),
      };
    },
    async getSampleOverview(input) {
      const query = validateQuery(input, "sampleId");
      const view = await load(query);
      const sample = view.sampleById.get(query.sampleId!);
      if (!sample) throw new MetricsEntityNotFoundError("sample", query.sampleId!);
      const samplings = view.bySample.get(sample.sampleId) ?? [];
      const datasetIds = view.datasetIdsFor(sample.data.dataId);
      return {
        project: view.facts.project, runIds: view.runsFor(samplings), sample, datasetIds,
        counts: { ...view.countsFor(samplings, [sample.data.dataId], datasetIds.length), samples: 1 },
        summary: view.summaryFor(samplings),
        samplings: samplings.toSorted((left, right) => left.samplingId.localeCompare(right.samplingId)).map((sampling) => ({
          samplingId: sampling.samplingId, summary: view.summaryFor([sampling]),
          artifactCount: sampling.artifacts?.length ?? 0, hasTrajectory: sampling.trajectory !== undefined,
        })),
      };
    },
    async getSamplingDetail(input) {
      const query = validateQuery(input, "samplingId");
      const view = await load(query);
      const sampling = view.samplings.find((item) => item.samplingId === query.samplingId);
      if (!sampling) throw new MetricsEntityNotFoundError("sampling", query.samplingId!);
      const sample = view.sampleById.get(sampling.sampleId)!;
      return {
        project: view.facts.project, runIds: view.runsFor([sampling]), sample, datasetIds: view.datasetIdsFor(sample.data.dataId),
        sampling, summary: view.summaryFor([sampling]),
        evaluations: [...view.bySampling.get(sampling.samplingId) ?? []]
          .sort((left, right) => left.evaluationId.localeCompare(right.evaluationId)).map((evaluation) => ({
            record: evaluation, result: readEvaluationMetrics(evaluation),
            resources: aggregateResources(evaluation.attempts.map((attempt) => ({ ownerUserId: evaluation.evaluator.ownerUserId, collection: attempt.resources }))),
          })),
      };
    },
  };
}
