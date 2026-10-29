import { IDENTIFIER_RULE, isIdentifier, type ProjectDatasetSnapshot } from "@eval-platform/eval-contracts";
import type { ProjectSample } from "@eval-platform/eval-runtime";
import { evaluatorAgent, subjectAgent, withoutSnapshots } from "../aggregation/agents.js";
import type { MetricsEvaluation, MetricsSampling } from "../aggregation/model.js";
import { aggregateMetrics, type MetricInput } from "../aggregation/index.js";
import { createEvaluationOutputReader } from "../evaluators/index.js";
import type { DatasetMetricRow, Metrics, MetricsFacts, MetricsQuery, MetricsSource } from "./model.js";

export class MetricsQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricsQueryError";
  }
}

/** A Metrics query named a Project, Run, Dataset, ProjectSample or Sampling outside the caller's scope. */
export class MetricsEntityNotFoundError extends Error {
  constructor(readonly entity: "project" | "run" | "dataset" | "project-sample" | "sampling", readonly id: string) {
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

type Target = "datasetId" | "projectSampleId" | "samplingId";

export function identifier(value: unknown, name: string): string {
  if (!isIdentifier(value)) throw new MetricsQueryError(`${name} ${IDENTIFIER_RULE}`);
  return value;
}

function validateQuery(input: MetricsQuery, target?: Target): MetricsQuery {
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

export function indexBy<Value>(values: readonly Value[], key: (value: Value) => string, label: string): Map<string, Value> {
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
  for (const value of values) groups.set(key(value), [...groups.get(key(value)) ?? [], value]);
  return groups;
}

/** Fixed Dataset bindings of every bound ProjectSample, in plan order. */
function readBindings(facts: MetricsFacts): Map<string, string[]> {
  const bindings = new Map<string, string[]>();
  for (const dataset of facts.plan.datasets) {
    if (new Set(dataset.projectSampleIds).size !== dataset.projectSampleIds.length) {
      throw new MetricsSourceError(`Duplicate ProjectSample in Dataset ${dataset.datasetId}`);
    }
    for (const id of dataset.projectSampleIds) bindings.set(id, [...bindings.get(id) ?? [], dataset.datasetId]);
  }
  return bindings;
}

function expectedSamples(query: MetricsQuery, facts: MetricsFacts, bindings: ReadonlyMap<string, readonly string[]>): readonly string[] | undefined {
  if (query.datasetId !== undefined) {
    const dataset = facts.plan.datasets.find((item) => item.datasetId === query.datasetId);
    if (!dataset) throw new MetricsEntityNotFoundError("dataset", query.datasetId);
    return dataset.projectSampleIds;
  }
  if (query.projectSampleId !== undefined) {
    if (!bindings.has(query.projectSampleId)) throw new MetricsEntityNotFoundError("project-sample", query.projectSampleId);
    return [query.projectSampleId];
  }
  return query.samplingId === undefined ? [...bindings.keys()] : undefined;
}

/** Rejects source facts that contradict the plan, the query scope or each other. */
function validateFacts(facts: MetricsFacts, query: MetricsQuery) {
  const { plan } = facts;
  const projectId = query.projectId;
  if (plan.project.projectId !== projectId) throw new MetricsSourceError("Source returned the wrong Project");
  if ((plan.evaluation === null) !== (facts.evaluationOutputSchema === null)) {
    throw new MetricsSourceError("Source returned an evaluation output Schema that does not match the evaluation plan");
  }
  indexBy(plan.datasets, (dataset) => dataset.datasetId, "Dataset");
  const bindings = readBindings(facts);
  const sampleById = indexBy(facts.projectSamples, (sample) => sample.projectSampleId, "ProjectSample");
  indexBy(facts.projectSamples, (sample) => sample.dataId, "Project Data");
  for (const sample of facts.projectSamples) {
    const datasetIds = bindings.get(sample.projectSampleId);
    if (sample.projectId !== projectId || !datasetIds) {
      throw new MetricsSourceError(`ProjectSample ${sample.projectSampleId} is not bound to the Project`);
    }
    if (sample.dataId !== sample.data.dataId) {
      throw new MetricsSourceError(`ProjectSample ${sample.projectSampleId} disagrees with its Data identity`);
    }
    if (datasetIds.length !== sample.datasetIds.length || datasetIds.some((id, index) => sample.datasetIds[index] !== id)) {
      throw new MetricsSourceError(`ProjectSample ${sample.projectSampleId} disagrees with the plan's Dataset bindings`);
    }
  }
  const expected = expectedSamples(query, facts, bindings);
  if (expected && (expected.length !== facts.projectSamples.length || expected.some((id) => !sampleById.has(id)))) {
    throw new MetricsSourceError("Source did not return exactly the bound ProjectSamples in scope");
  }
  if (facts.samplings.some((sampling) => sampling.projectId !== projectId) || facts.runs.some((run) => run.projectId !== projectId)) {
    throw new MetricsSourceError("Source returned Runtime facts outside the Project scope");
  }
  const samplingById = indexBy(facts.samplings, (sampling) => sampling.samplingId, "Sampling");
  indexBy(facts.evaluations, (evaluation) => evaluation.evaluationId, "Evaluation");
  const runById = indexBy(facts.runs, (run) => run.runId, "Run");
  for (const sampling of facts.samplings) {
    if (!sampleById.has(sampling.projectSampleId)) {
      throw new MetricsSourceError(`Sampling ${sampling.samplingId} is outside the ProjectSamples in scope`);
    }
  }
  for (const evaluation of facts.evaluations) {
    if (!samplingById.has(evaluation.samplingId)) throw new MetricsSourceError(`Missing Sampling for Evaluation ${evaluation.evaluationId}`);
  }
  return { sampleById, runById };
}

export function prepareFacts(facts: MetricsFacts, query: MetricsQuery) {
  const { plan } = facts;
  const { sampleById, runById } = validateFacts(facts, query);
  const selectedRuns = query.runIds?.map((runId) => {
    const run = runById.get(runId);
    if (!run) throw new MetricsEntityNotFoundError("run", runId);
    return run;
  });
  const runSamplings = selectedRuns && new Set(selectedRuns.flatMap((run) => run.samplingIds));
  const runEvaluations = selectedRuns && new Set(selectedRuns.flatMap((run) => run.evaluationIds));
  const samplings = facts.samplings.filter((sampling) => !runSamplings || runSamplings.has(sampling.samplingId));
  const inScope = new Set(samplings.map((sampling) => sampling.samplingId));
  const evaluations = facts.evaluations.filter((evaluation) => inScope.has(evaluation.samplingId)
    && (!runEvaluations || runEvaluations.has(evaluation.evaluationId)));
  const bySample = groupBy(samplings, (sampling) => sampling.projectSampleId);
  const bySampling = groupBy(evaluations, (evaluation) => evaluation.samplingId);
  const outputs = createEvaluationOutputReader(plan.evaluation?.plan.outputSchema ?? null, facts.evaluationOutputSchema);
  const samplingsOf = (samples: readonly ProjectSample[]): readonly MetricsSampling[] => samples
    .flatMap((sample) => [...bySample.get(sample.projectSampleId) ?? []].sort((left, right) => left.samplingId.localeCompare(right.samplingId)));
  const evaluationsOf = (records: readonly MetricsSampling[]): readonly MetricsEvaluation[] => records
    .flatMap((sampling) => [...bySampling.get(sampling.samplingId) ?? []].sort((left, right) => left.evaluationId.localeCompare(right.evaluationId)));
  const summarize = (bindings: MetricInput["bindings"], records: readonly MetricsSampling[]) => aggregateMetrics({
    bindings, samplings: records, evaluations: evaluationsOf(records), outputs,
  });
  const summarizeSamples = (samples: readonly ProjectSample[], datasets: number) => summarize({
    datasets, data: new Set(samples.map((sample) => sample.dataId)).size, projectSamples: samples.length,
  }, samplingsOf(samples));
  const runIdsOf = (records: readonly MetricsSampling[]): readonly string[] => {
    if (selectedRuns) return selectedRuns.map((run) => run.runId).sort();
    const ids = new Set(records.map((sampling) => sampling.samplingId));
    return facts.runs.filter((run) => run.samplingIds.some((id) => ids.has(id))).map((run) => run.runId).sort();
  };
  const samplesOf = (dataset: ProjectDatasetSnapshot) => dataset.projectSampleIds.map((id) => sampleById.get(id)!);
  const datasetRow = (dataset: ProjectDatasetSnapshot): DatasetMetricRow => ({ dataset, summary: summarizeSamples(samplesOf(dataset), 1) });
  return {
    project: plan.project, plan, sampleById, samplings, outputs,
    samplingsOf, evaluationsOf, summarize, summarizeSamples, runIdsOf, samplesOf, datasetRow,
  };
}

export function createMetrics(dependencies: { readonly source: MetricsSource }): Metrics {
  const load = async (query: MetricsQuery) => prepareFacts(structuredClone(await dependencies.source.read(structuredClone(query))), query);
  const sampleBindings = (sample: ProjectSample) => ({ datasets: sample.datasetIds.length, data: 1, projectSamples: 1 });
  return {
    async getProjectOverview(input) {
      const view = await load(validateQuery(input));
      const samples = [...view.sampleById.values()];
      return {
        project: view.project, runIds: view.runIdsOf(view.samplings),
        summary: view.summarizeSamples(samples, view.plan.datasets.length),
        datasets: view.plan.datasets.map(view.datasetRow),
        projectSamples: samples.map((sample) => ({
          projectSampleId: sample.projectSampleId, dataId: sample.dataId, datasetIds: sample.datasetIds,
          samplingCount: sample.samplingCount, samplingIds: view.samplingsOf([sample]).map((item) => item.samplingId),
          summary: view.summarizeSamples([sample], sample.datasetIds.length),
        })),
      };
    },
    async getDatasetOverview(input) {
      const query = validateQuery(input, "datasetId");
      const view = await load(query);
      const dataset = view.plan.datasets.find((item) => item.datasetId === query.datasetId)!;
      const samples = view.samplesOf(dataset);
      return {
        project: view.project, runIds: view.runIdsOf(view.samplingsOf(samples)), ...view.datasetRow(dataset),
        projectSamples: samples.map((sample) => ({
          projectSampleId: sample.projectSampleId, dataId: sample.dataId, datasetIds: sample.datasetIds,
          samplingCount: sample.samplingCount, summary: view.summarizeSamples([sample], sample.datasetIds.length),
        })),
      };
    },
    async getSampleOverview(input) {
      const query = validateQuery(input, "projectSampleId");
      const view = await load(query);
      const projectSample = view.sampleById.get(query.projectSampleId!)!;
      const samplings = view.samplingsOf([projectSample]);
      return {
        project: view.project, runIds: view.runIdsOf(samplings), projectSample,
        summary: view.summarize(sampleBindings(projectSample), samplings),
        samplings: samplings.map((sampling) => ({
          samplingId: sampling.samplingId, execution: sampling.execution,
          summary: view.summarize(sampleBindings(projectSample), [sampling]),
          artifactCount: sampling.artifacts?.length ?? 0, hasTrajectory: sampling.trajectory !== undefined,
        })),
      };
    },
    async getSamplingDetail(input) {
      const query = validateQuery(input, "samplingId");
      const view = await load(query);
      const sampling = view.samplings.find((item) => item.samplingId === query.samplingId);
      if (!sampling) throw new MetricsEntityNotFoundError("sampling", query.samplingId!);
      const projectSample = view.sampleById.get(sampling.projectSampleId)!;
      return {
        project: view.project, runIds: view.runIdsOf([sampling]), projectSample, sampling: withoutSnapshots(sampling),
        summary: view.summarize(sampleBindings(projectSample), [sampling]),
        subject: subjectAgent(sampling),
        evaluations: view.evaluationsOf([sampling]).map((record) => ({
          record: withoutSnapshots(record), agent: evaluatorAgent(record), output: view.outputs.read(record).view,
        })),
      };
    },
  };
}
