import type { MetricSummary, StageStatistics } from "@eval-platform/eval-metrics";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppBindings } from "../lib/types.js";
import { pageOf, short } from "./common.js";
import type { getMetricsSchema } from "./schemas.js";

function stage(value: StageStatistics) {
  return {
    records: value.records, statuses: value.statuses, successRate: value.successRate,
    attempts: value.attempts, restarts: value.restarts, agentDurationMs: value.agentDurationMs,
  };
}

/** Project Metrics calculates every statistic. This only drops bulky, model-visible payloads. */
export function metricSummary(value: MetricSummary, page: number, pageSize: number) {
  const fieldPage = pageOf(value.evaluationOutputs.fields, page, pageSize);
  const fields = fieldPage.items.map((field) => ({
    jsonPointer: short(field.jsonPointer), title: short(field.title),
    kinds: field.kinds, observationCount: field.observationCount,
    contributingEvaluationCount: field.contributingEvaluationCount,
    missingEvaluationCount: field.missingEvaluationCount, numeric: field.numeric,
    distributionCount: field.distribution.length,
    distribution: field.distribution.slice(0, 10).map(({ value: entry, count, share }) => ({
      value: typeof entry === "string" ? short(entry, 80) : entry, count, share,
    })),
    coverage: field.coverage,
  }));
  const resources = (item: MetricSummary["executionAgent"]) => ({
    coverage: item.coverage, collections: item.collections, tokens: item.tokens,
    costs: item.costs, cacheHitRate: item.cacheHitRate,
  });
  return {
    counts: value.counts,
    execution: stage(value.execution), evaluation: stage(value.evaluation),
    executionAgent: resources(value.executionAgent), evaluationAgents: resources(value.evaluationAgents),
    evaluationOutputs: {
      evaluations: value.evaluationOutputs.evaluations,
      validation: value.evaluationOutputs.validation,
      fields: { ...fieldPage, items: fields },
    },
  };
}

type Query = z.output<typeof getMetricsSchema>;

export async function getMetrics(c: Context<AppBindings>, input: Query) {
  const { projectId, runId, scope, page, pageSize } = input;
  // Metrics' owner-scoped source validates both Project and selected Run in one read-only snapshot;
  // do not materialize the entire Run view (and its Evaluation bodies) a second time here.
  const query = { projectId, runIds: [runId] };
  const metrics = c.var.services.metrics;
  const project = (value: { projectId: string; name: string }) => ({
    projectId: value.projectId, name: short(value.name),
  });
  const sample = (value: { projectSampleId: string; dataId: string; datasetIds: readonly string[]; samplingCount: number }) => ({
    projectSampleId: value.projectSampleId, dataId: value.dataId, samplingCount: value.samplingCount,
    datasetIds: value.datasetIds.slice(0, 10), datasetCount: value.datasetIds.length,
  });
  if (scope === "project") {
    const view = await metrics.getProjectOverview(query);
    const datasetPage = pageOf(view.datasets, page, pageSize);
    const samplePage = pageOf(view.projectSamples, page, pageSize);
    return { scope, project: project(view.project), runId, summary: metricSummary(view.summary, page, pageSize),
      datasets: { ...datasetPage, items: datasetPage.items.map(({ dataset, summary }) => ({
        datasetId: dataset.datasetId, name: short(dataset.name), counts: summary.counts,
      })) },
      projectSamples: { ...samplePage, items: samplePage.items.map((item) => ({
        ...sample(item), currentSamplingCount: item.samplingIds.length,
      })) },
    };
  }
  if (scope === "dataset") {
    const view = await metrics.getDatasetOverview({ ...query, datasetId: input.datasetId! });
    const samplePage = pageOf(view.projectSamples, page, pageSize);
    return { scope, project: project(view.project), runId,
      dataset: { datasetId: view.dataset.datasetId, name: short(view.dataset.name) },
      summary: metricSummary(view.summary, page, pageSize),
      projectSamples: { ...samplePage, items: samplePage.items.map(sample) } };
  }
  if (scope === "sample") {
    const view = await metrics.getSampleOverview({ ...query, projectSampleId: input.projectSampleId! });
    const samplingPage = pageOf(view.samplings, page, pageSize);
    return { scope, project: project(view.project), runId, projectSample: sample(view.projectSample),
      summary: metricSummary(view.summary, page, pageSize),
      samplings: { ...samplingPage, items: samplingPage.items.map((item) => ({
        samplingId: item.samplingId, status: item.execution.status,
        counts: item.summary.counts, artifactCount: item.artifactCount, hasTrajectory: item.hasTrajectory,
      })) } };
  }
  const view = await metrics.getSamplingDetail({ ...query, samplingId: input.samplingId! });
  const evaluationPage = pageOf(view.evaluations, page, pageSize);
  return { scope, project: project(view.project), runId, projectSample: sample(view.projectSample),
    sampling: { samplingId: view.sampling.samplingId, status: view.sampling.execution.status },
    summary: metricSummary(view.summary, page, pageSize),
    evaluations: { ...evaluationPage, items: evaluationPage.items.map(({ record, output }) => ({
      evaluationId: record.evaluationId, status: record.status.status,
      validation: { status: output.validation.status, reason: output.validation.reason },
    })) } };
}
